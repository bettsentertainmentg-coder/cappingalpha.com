// src/odds_ingest.js — site-side ingest for the CA Odds Engine (Mac relay).
//
// The engine (scripts/odds_engine.js on the Mac) POSTs normalized rows:
//   { book, sport, home_team, away_team, ml_home, ml_away,
//     spread_home, spread_away, over_under, ou_over_odds, ou_under_odds }
// Rows are matched to today_games by team name and upserted into book_lines,
// the same table the betslip book chips and the game popup already read via
// getLinesForGame(), so a new book shows up in the UI with no frontend work.

const db = require('./db');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const nick = (s) => norm(s).split(' ').pop();
const numOrNull = (v) => (v == null || v === '' || !isFinite(Number(v))) ? null : Number(v);

// Match a row's team pair to a today_games row for its sport. Handles nickname
// vs full-name mismatches ("Yankees" vs "New York Yankees") in either order.
// Wrong odds are worse than no odds, so ambiguity is fatal: if a row could match
// more than one game, or a single game in both orientations (shared city names
// like the two New York teams can do this), the row is dropped instead of guessed.
//
// DATE-AWARE (2026-07-09): the board carries several DAYS of games and books
// list the same series pair on consecutive days, so the pair alone cannot pick
// a day — the old earliest-upcoming rule collapsed a whole series onto one
// game id (and dropped everything else as ambiguous: ~810 unmatched rows per
// cycle). When the engine row carries start_time, the match must be the game
// CLOSEST in time and within 12h — same-day (and doubleheader-leg) precision,
// adjacent-day rejection. Rows without start_time keep the legacy rules.
const DATE_MATCH_MS = 12 * 3600 * 1000;

function matchGame(games, row) {
  const h = norm(row.home_team), a = norm(row.away_team);
  if (!h || !a || h === a) return null;
  const same = (x, y) => x === y || nick(x) === nick(y) || x.includes(y) || y.includes(x);
  const hits = [];
  for (const g of games) {
    const gh = norm(g.home_team), ga = norm(g.away_team);
    if (!gh || !ga) continue;
    const fwd = same(gh, h) && same(ga, a);
    const rev = same(gh, a) && same(ga, h);
    if (fwd && rev) return null;                 // one game, both orientations: ambiguous
    if (fwd) hits.push({ game: g, flipped: false, pair: `${gh}|${ga}` });
    else if (rev) hits.push({ game: g, flipped: true, pair: `${gh}|${ga}` });
  }
  if (hits.length === 0) return null;

  const rowT = row.start_time ? Date.parse(row.start_time) : NaN;
  if (!isNaN(rowT)) {
    let best = null;
    for (const x of hits) {
      const gt = Date.parse(x.game.start_time || '');
      if (isNaN(gt)) continue;
      const d = Math.abs(gt - rowT);
      if (!best || d < best.d) best = { game: x.game, flipped: x.flipped, pair: x.pair, d };
    }
    if (best) {
      // Outside the window = the row is for a day the board doesn't carry
      // (e.g. game 4 of a series): storing it would put the wrong day's line
      // on a real game, so drop it.
      return best.d <= DATE_MATCH_MS ? best : null;
    }
    // No hit had a parseable start_time — fall through to the legacy rules.
  }

  if (hits.length === 1) return hits[0];
  // Multiple games matched. Different team pairs = genuinely ambiguous, drop the
  // row. The SAME pair twice is a doubleheader: books show the upcoming leg's
  // price pre-game, so take the not-yet-final game with the earliest start.
  const firstPair = hits[0].pair;
  if (!hits.every(x => x.pair === firstPair && x.flipped === hits[0].flipped)) return null;
  const upcoming = hits
    .filter(x => x.game.status !== 'post')
    .sort((x, y) => String(x.game.start_time || '').localeCompare(String(y.game.start_time || '')));
  return upcoming[0] || null;
}

const upsert = () => db.prepare(`
  INSERT INTO book_lines
    (espn_game_id, book, ml_home, ml_away, spread_home, spread_away,
     over_under, ou_over_odds, ou_under_odds, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(espn_game_id, book) DO UPDATE SET
    ml_home       = COALESCE(excluded.ml_home, ml_home),
    ml_away       = COALESCE(excluded.ml_away, ml_away),
    spread_home   = COALESCE(excluded.spread_home, spread_home),
    spread_away   = COALESCE(excluded.spread_away, spread_away),
    over_under    = COALESCE(excluded.over_under, over_under),
    ou_over_odds  = COALESCE(excluded.ou_over_odds, ou_over_odds),
    ou_under_odds = COALESCE(excluded.ou_under_odds, ou_under_odds),
    updated_at    = datetime('now')
`);

// Partial-game rows (period 'F5', '1H', ...) land in book_lines_period — the
// full-game table is UNIQUE(espn_game_id, book) and its readers assume one
// full-game row per book, so period rows must never touch it.
const upsertPeriod = () => db.prepare(`
  INSERT INTO book_lines_period
    (espn_game_id, book, period, ml_home, ml_away, spread_home, spread_away,
     spread_home_odds, spread_away_odds, over_under, ou_over_odds, ou_under_odds, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(espn_game_id, book, period) DO UPDATE SET
    ml_home          = COALESCE(excluded.ml_home, ml_home),
    ml_away          = COALESCE(excluded.ml_away, ml_away),
    spread_home      = COALESCE(excluded.spread_home, spread_home),
    spread_away      = COALESCE(excluded.spread_away, spread_away),
    spread_home_odds = COALESCE(excluded.spread_home_odds, spread_home_odds),
    spread_away_odds = COALESCE(excluded.spread_away_odds, spread_away_odds),
    over_under       = COALESCE(excluded.over_under, over_under),
    ou_over_odds     = COALESCE(excluded.ou_over_odds, ou_over_odds),
    ou_under_odds    = COALESCE(excluded.ou_under_odds, ou_under_odds),
    updated_at       = datetime('now')
`);

// LINES LOCK AT GAME START (Jack, 2026-07-09): once a game starts, its book
// rows freeze at the last pregame write — the closing line. Books keep
// publishing in-play prices for live games; storing those would overwrite the
// closing number every surface displays (detail-page lines table, popup,
// Track a Bet) with drifting in-play odds (+920/-2900 style). Status can lag
// the 5-min score cron, so start_time is the authority.
const gameHasStarted = (g) =>
  g.status === 'in' || g.status === 'post' ||
  (g.start_time != null && Date.parse(g.start_time) <= Date.now());

function storeEngineBookLines(rows) {
  if (!Array.isArray(rows)) return { stored: 0, unmatched: 0, locked: 0 };
  rows = rows.slice(0, 800); // sanity cap per POST
  const bySport = new Map();  // sport -> today_games rows
  const stmt = upsert();
  const stmtPeriod = upsertPeriod();
  let stored = 0, unmatched = 0, locked = 0;

  // One transaction per POST: 700 individual WAL commits per chunk stall the
  // event loop; one commit does not.
  const run = db.transaction((batch) => {
  for (const row of batch) {
    const sport = String(row.sport || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
    const book  = String(row.book || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
    const period = row.period && String(row.period).toLowerCase() !== 'game'
      ? String(row.period).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)
      : null;
    if (!sport || !book) { unmatched++; continue; }
    if (!bySport.has(sport)) {
      // Case-insensitive: today_games stores 'Soccer' while adapters send 'SOCCER'.
      bySport.set(sport, db.prepare(
        `SELECT espn_game_id, home_team, away_team, start_time, status FROM today_games WHERE UPPER(sport) = ?`
      ).all(sport));
    }
    const hit = matchGame(bySport.get(sport), row);
    if (!hit) { unmatched++; continue; }
    if (gameHasStarted(hit.game)) { locked++; continue; }

    // If the engine's home/away are swapped vs ESPN's, flip every sided number.
    const f = hit.flipped;
    const mlH = numOrNull(f ? row.ml_away : row.ml_home);
    const mlA = numOrNull(f ? row.ml_home : row.ml_away);
    let spH = numOrNull(f ? row.spread_away : row.spread_home);
    let spA = numOrNull(f ? row.spread_home : row.spread_away);
    // Spread sanity: the two sides must mirror (one +, one -). Same-signed nonzero
    // pairs mean the adapter mis-parsed; drop the spreads, keep ML and total.
    if (spH != null && spA != null && spH !== 0 && spA !== 0 && Math.sign(spH) === Math.sign(spA)) {
      spH = null; spA = null;
    }
    if (period) {
      const spHo = numOrNull(f ? row.spread_away_odds : row.spread_home_odds);
      const spAo = numOrNull(f ? row.spread_home_odds : row.spread_away_odds);
      stmtPeriod.run(
        hit.game.espn_game_id, book, period, mlH, mlA, spH, spA, spHo, spAo,
        numOrNull(row.over_under), numOrNull(row.ou_over_odds), numOrNull(row.ou_under_odds)
      );
    } else {
      stmt.run(
        hit.game.espn_game_id, book, mlH, mlA, spH, spA,
        numOrNull(row.over_under), numOrNull(row.ou_over_odds), numOrNull(row.ou_under_odds)
      );
    }
    stored++;
  }
  });
  run(rows);
  return { stored, unmatched, locked };
}

// ── Player props / team totals / alternate ladders (book_props) ───────────────
// Engine prop rows share the event fields (book, sport, home_team, away_team,
// start_time) plus { entity, market, line, over_odds, under_odds }. Rows are
// grouped per (book, event) so team matching runs ONCE per event, then every
// prop fans out under the matched game — props are 50-200 rows per game and
// per-row matching would burn the ingest thread.
function storeBookProps(rows) {
  if (!Array.isArray(rows)) return { stored: 0, unmatched: 0, locked: 0 };
  rows = rows.slice(0, 5000);
  const bySport = new Map();
  const stmt = db.prepare(`
    INSERT INTO book_props
      (espn_game_id, book, entity, market, line, over_odds, under_odds, game_date, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(espn_game_id, book, entity, market, line) DO UPDATE SET
      over_odds  = COALESCE(excluded.over_odds, over_odds),
      under_odds = COALESCE(excluded.under_odds, under_odds),
      updated_at = datetime('now')
  `);
  let stored = 0, unmatched = 0, locked = 0;

  // Group rows by (book|sport|home|away) — one match per event.
  const groups = new Map();
  for (const row of rows) {
    if (!row) continue;
    const key = `${row.book}|${row.sport}|${row.home_team}|${row.away_team}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const run = db.transaction(() => {
    for (const group of groups.values()) {
      const head = group[0];
      const sport = String(head.sport || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
      const book  = String(head.book || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
      if (!sport || !book) { unmatched += group.length; continue; }
      if (!bySport.has(sport)) {
        bySport.set(sport, db.prepare(
          `SELECT espn_game_id, home_team, away_team, start_time, status FROM today_games WHERE UPPER(sport) = ?`
        ).all(sport));
      }
      const hit = matchGame(bySport.get(sport), head);
      if (!hit) { unmatched += group.length; continue; }
      if (gameHasStarted(hit.game)) { locked += group.length; continue; }
      const gameDate = String(hit.game.start_time || '').slice(0, 10) || null;
      for (const row of group) {
        const entity = String(row.entity ?? '').slice(0, 80);
        const market = String(row.market || '').toLowerCase().replace(/[^a-z0-9_+]/g, '').slice(0, 40);
        if (!market) { unmatched++; continue; }
        // line is part of the UNIQUE key and SQLite treats NULLs as distinct
        // there — a NULL line (yes-price markets) would mint a new row every
        // cycle. Normalize to 0: occurrence markets have no real line anyway.
        const line = numOrNull(row.line) ?? 0;
        stmt.run(
          hit.game.espn_game_id, book, entity, market,
          line, numOrNull(row.over_odds), numOrNull(row.under_odds), gameDate
        );
        stored++;
      }
    }
  });
  run();
  return { stored, unmatched, locked };
}

// ── Non-ESPN sports lane (engine_event_lines keyed to engine_events) ─────────
// Esports/MMA/boxing/table tennis/cricket/darts/golf H2H have no ESPN game
// rows, so their lines live against engine_events instead. Display and
// Track a Bet only — never the CA line, grading, or rankings. The event row
// is upserted from the line row itself (Pinnacle-only events would otherwise
// be orphaned), and started events are locked exactly like book_lines.
function storeEngineEventLines(rows) {
  if (!Array.isArray(rows)) return { stored: 0, locked: 0, dropped: 0 };
  rows = rows.slice(0, 2000);
  const clean = (s) => String(s || '').replace(/[^A-Za-z0-9 .\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const upEvent = db.prepare(`
    INSERT INTO engine_events (sport, home_team, away_team, start_time, league, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(sport, home_team, away_team) DO UPDATE SET
      start_time = COALESCE(excluded.start_time, start_time),
      league     = COALESCE(excluded.league, league),
      updated_at = datetime('now')
  `);
  const upLine = db.prepare(`
    INSERT INTO engine_event_lines
      (sport, home_team, away_team, book, league, start_time,
       ml_home, ml_away, spread_home, spread_away, over_under, ou_over_odds, ou_under_odds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(sport, home_team, away_team, book) DO UPDATE SET
      league        = COALESCE(excluded.league, league),
      start_time    = COALESCE(excluded.start_time, start_time),
      ml_home       = COALESCE(excluded.ml_home, ml_home),
      ml_away       = COALESCE(excluded.ml_away, ml_away),
      spread_home   = COALESCE(excluded.spread_home, spread_home),
      spread_away   = COALESCE(excluded.spread_away, spread_away),
      over_under    = COALESCE(excluded.over_under, over_under),
      ou_over_odds  = COALESCE(excluded.ou_over_odds, ou_over_odds),
      ou_under_odds = COALESCE(excluded.ou_under_odds, ou_under_odds),
      updated_at    = datetime('now')
  `);
  let stored = 0, locked = 0, dropped = 0;
  const run = db.transaction(() => {
    for (const row of rows) {
      if (!row) { dropped++; continue; }
      const sport = String(row.sport || '').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 20);
      const book  = String(row.book || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
      const home = clean(row.home_team), away = clean(row.away_team);
      if (!sport || !book || !home || !away || home === away) { dropped++; continue; }
      const st = row.start_time && !isNaN(Date.parse(row.start_time)) ? new Date(row.start_time).toISOString() : null;
      if (st && Date.parse(st) <= Date.now()) { locked++; continue; }
      const league = row.league ? clean(row.league).slice(0, 40) : null;
      upEvent.run(sport, home, away, st, league);
      upLine.run(
        sport, home, away, book, league, st,
        numOrNull(row.ml_home), numOrNull(row.ml_away),
        numOrNull(row.spread_home), numOrNull(row.spread_away),
        numOrNull(row.over_under), numOrNull(row.ou_over_odds), numOrNull(row.ou_under_odds)
      );
      stored++;
    }
    // Same retention as engine_events: gone from the feed 2 days = settled.
    db.prepare(`DELETE FROM engine_event_lines WHERE updated_at < datetime('now', '-2 days')`).run();
  });
  run();
  return { stored, locked, dropped };
}

// Books whose lines are informational only on the public site (unlicensed in the
// US, so no outbound links and a visible offshore tag wherever they render).
const OFFSHORE_BOOKS = new Set(['bovada', 'betonline', 'mybookie', 'betus', 'thunderpick', 'pinnacle']);

// Fight-card events (Boxing/MMA) from the engine. Upsert current, prune stale.
function storeEngineEvents(events) {
  if (!Array.isArray(events)) return { stored: 0 };
  events = events.slice(0, 300);
  const stmt = db.prepare(`
    INSERT INTO engine_events (sport, home_team, away_team, start_time, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(sport, home_team, away_team) DO UPDATE SET
      start_time = COALESCE(excluded.start_time, start_time), updated_at = datetime('now')
  `);
  let stored = 0;
  for (const ev of events) {
    // Allowlist, not blocklist: these strings end up inside onclick attributes in
    // the betslip's game list, so only plain name characters survive.
    const clean = (s) => String(s || '').replace(/[^A-Za-z0-9 .\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const sport = String(ev.sport || '').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 20);
    const home = clean(ev.home_team);
    const away = clean(ev.away_team);
    if (!sport || !home || !away) continue;
    const st = ev.start_time && !isNaN(Date.parse(ev.start_time)) ? new Date(ev.start_time).toISOString() : null;
    stmt.run(sport, home, away, st);
    stored++;
  }
  // Anything the engine stopped sending for 2 days is a settled or pulled card.
  db.prepare(`DELETE FROM engine_events WHERE updated_at < datetime('now', '-2 days')`).run();
  return { stored };
}

module.exports = { storeEngineBookLines, storeBookProps, storeEngineEventLines, storeEngineEvents, OFFSHORE_BOOKS };
