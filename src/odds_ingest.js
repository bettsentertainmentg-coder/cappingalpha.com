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
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return null;
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

function storeEngineBookLines(rows) {
  if (!Array.isArray(rows)) return { stored: 0, unmatched: 0 };
  rows = rows.slice(0, 800); // sanity cap per POST
  const bySport = new Map();  // sport -> today_games rows
  const stmt = upsert();
  let stored = 0, unmatched = 0;

  for (const row of rows) {
    const sport = String(row.sport || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
    const book  = String(row.book || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
    if (!sport || !book) { unmatched++; continue; }
    if (!bySport.has(sport)) {
      bySport.set(sport, db.prepare(
        `SELECT espn_game_id, home_team, away_team, start_time, status FROM today_games WHERE sport = ?`
      ).all(sport));
    }
    const hit = matchGame(bySport.get(sport), row);
    if (!hit) { unmatched++; continue; }

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
    stmt.run(
      hit.game.espn_game_id, book, mlH, mlA, spH, spA,
      numOrNull(row.over_under), numOrNull(row.ou_over_odds), numOrNull(row.ou_under_odds)
    );
    stored++;
  }
  return { stored, unmatched };
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

module.exports = { storeEngineBookLines, storeEngineEvents, OFFSHORE_BOOKS };
