// src/source_ingest.js
// Shared ingestion pipeline for wave-1 structured-data sources (Action Network,
// Polymarket wallets, Covers contests). Picks land in capper_history as
// result='pending' rows, graded later by results.js exactly like Discord picks.
// Under v3 (scoring_version='v3' + source_board_points='1') a PREGAME pick also
// lands on the board as a mention — same flat base + advocate resume + consensus
// mechanics as a Discord pick, with channel = the source name so the
// '@src:<source>' entity earns advocate points through its own graded record.
// No fiat baseline: a source's weight is exactly what its resume has earned.
//
// Rules enforced here (docs/CA_ALGORITHM_V3.md):
//  - Pregame timestamp: a pick counts only when the SOURCE's own timestamp is
//    before game start; anything in-game is recorded with live=1 provenance and
//    stays capper-record-only forever (never a board mention).
//  - Cross-source dedup (HARD RULE): the same canonical capper on the same slot
//    on the same day is ONE row. A duplicate arriving from a second system only
//    appends provenance to sources_json (and never a second board mention).

const db = require('./db');
const { resolveCapperName, ensureRegistered, savePick } = require('./storage');
const { hasGameStarted } = require('./pick_cutoff');
const { checkSourcePick } = require('./ledger_sanity');

// ── Multi-match resolver ──────────────────────────────────────────────────────
// FIRST: when the source knows WHEN its game is (a BettingPros event time, an
// Action Network starts_at, a Covers date table, an article's own date), that
// alone decides, started or not. See THE SERIES GUARD below for why.
//
// Otherwise a team-name match can return several games:
//   (a) the SAME two teams more than once: a doubleheader, or a series (the
//       board carries several days of games). The nearest unstarted game wins
//       ONLY when no earlier game of that matchup started recently; see the
//       series guard.
//   (b) DIFFERENT team pairs sharing a name fragment. This is the college case
//       ("Texas" hits Texas, Texas A&M, Texas State and Texas Tech on one
//       Saturday; "Tigers" hits five schools plus Detroit) and the cross-sport
//       city case (Toronto/Miami/Dallas exist in three leagues at once).
//       The old rule took the earliest kickoff, which is a coin flip that lands
//       a graded row in the wrong capper pool. The rule now (Jack, 2026-09-07):
//         1. the caller's sport constraint has already narrowed the pool;
//         2. if the pick carries a line, keep the candidates whose market is
//            within LINE_TOL of it (spread against the picked side's spread,
//            total against over_under, moneyline against the side's price);
//         3. if exactly one survives, take it; otherwise REFUSE and log the
//            candidates to source_skips so the case is visible and recoverable.
//       A dropped pick costs one data point. A misgraded one poisons a rating
//       pool and is very hard to unwind.
const LINE_TOL = 4;      // points, spreads and totals (college lines move all week)
const ML_TOL   = 60;     // American-odds distance for a moneyline confirmation

// How far a source's own start time may sit from the board's. ESPN lists the
// scheduled first pitch and sources agree to the minute, but split
// doubleheaders run 3h+ apart, so the nearest game inside this window is the
// one the source meant.
const SOURCE_START_TOL_MS = 3 * 3600e3;

// THE SERIES GUARD (Jack, 2026-09-16). forward_games.js keeps several days of
// games on the board, so an MLB or WNBA series puts the same two teams on it
// two to four times. Every source keeps listing a pick as pending while its
// game is being played, and this resolver used to drop the started game and
// hand the pick to the NEXT game of the series. The dedup key includes the
// game, so the copy was inserted as a new row and graded against a game the
// capper never bet: 15,198 ledger rows (13,980 graded, 787 cappers) on the
// 2026-09-16 export, 97% of them saved within 30 minutes of the real game's
// first pitch. A source that knows its game's date passes it and is matched
// exactly. One that does not is refused while an earlier game of the same
// matchup started less than this long ago; polls repeat, so a real pick on
// the later game still lands once the window closes.
const SERIES_GUARD_MS = 8 * 3600e3;

function _etDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}

function _recentlyStarted(g, now) {
  if (String(g.status || '').toLowerCase() === 'in') return true;
  const s = gameStartMs(g);
  return s != null && s <= now && now - s < SERIES_GUARD_MS;
}

function _pairKey(g) {
  return [String(g.home_team || '').toLowerCase(), String(g.away_team || '').toLowerCase()].sort().join('|');
}

// Does this candidate's market agree with the pick's posted number?
// Returns true / false, or null when the candidate has no line to compare
// against (a forward game the books have not priced yet).
function lineAgrees(g, opts) {
  const pt = String(opts.pickType || '').toLowerCase();
  const line = opts.line != null && Number.isFinite(+opts.line) ? +opts.line : null;
  const odds = opts.odds != null && Number.isFinite(+opts.odds) ? +opts.odds : null;
  // Sources that parse the pick before they know the game pass the picked name
  // instead of a side; resolve it against THIS candidate (it can differ per game).
  if (!opts.side && opts.picked && (pt === 'spread' || pt === 'ml')) {
    opts = { ...opts, side: sideOf(g, opts.picked) };
  }
  if (pt === 'over' || pt === 'under') {
    if (g.over_under == null) return null;
    return line != null && Math.abs(+g.over_under - line) <= LINE_TOL;
  }
  if (pt === 'spread') {
    const mkt = opts.side === 'home' ? g.spread_home : opts.side === 'away' ? g.spread_away : null;
    if (mkt == null) return null;
    return line != null && Math.abs(+mkt - line) <= LINE_TOL;
  }
  if (pt === 'ml') {
    const mkt = opts.side === 'home' ? g.ml_home : opts.side === 'away' ? g.ml_away : null;
    if (mkt == null) return null;
    return odds != null && Math.abs(+mkt - odds) <= ML_TOL;
  }
  return null;
}

// One line per (source, capper, pick, reason) per day. A pick refused by the
// series guard is refused again on every poll until its game ends, and each
// repeat says nothing new.
const _loggedSkips = new Set();
function logAmbiguous(cands, opts, why) {
  const memo = `${opts.source || ''}|${opts.capper || ''}|${opts.picked || ''}|${opts.pickType || ''}|${why}|${_etDate(Date.now())}`;
  if (_loggedSkips.has(memo)) return;
  if (_loggedSkips.size > 20000) _loggedSkips.clear();
  _loggedSkips.add(memo);
  const names = cands.map(g => `${g.sport} ${g.away_team} @ ${g.home_team} (${g.espn_game_id})`).join(' | ');
  console.warn(`[source_ingest] refused ${opts.source || 'source'} pick "${opts.picked || ''}" (${opts.pickType || '?'} ${opts.line ?? ''}): ${why}: ${names}`);
  try {
    db.prepare(`
      INSERT INTO source_skips (source, capper, sport, picked, pick_type, line, odds, reason, candidates_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(opts.source || null, opts.capper || null, opts.sport || null, opts.picked || null,
           opts.pickType || null, opts.line ?? null, opts.odds ?? null, why,
           JSON.stringify(cands.map(g => ({ id: g.espn_game_id, sport: g.sport, home: g.home_team, away: g.away_team, start: g.start_time,
             spread_home: g.spread_home, over_under: g.over_under, ml_home: g.ml_home, ml_away: g.ml_away }))));
  } catch (_) {}
}

// A pick the market gate refused: say why, and keep it (source_skips is the
// same table the ambiguous-match resolver writes, so one query shows both).
function logRefusal(pick, game, pt, v) {
  const why = v.reason + (v.market != null ? ` (market ${v.market})` : '');
  console.warn(`[source_ingest] refused ${pick.source} pick by ${pick.capperName}: ${game.sport} ${game.away_team} @ ${game.home_team} ${pt}${pick.line != null ? ' ' + pick.line : ''}${pick.odds != null ? ' @' + pick.odds : ''}: ${why}`);
  try {
    db.prepare(`
      INSERT INTO source_skips (source, capper, sport, picked, pick_type, line, odds, reason, candidates_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pick.source || null, pick.capperName || null, game.sport || null,
           `${game.away_team} @ ${game.home_team}${pick.side ? ' [' + pick.side + ']' : ''}`,
           pt, pick.line ?? null, pick.odds ?? null, why,
           JSON.stringify([{ id: game.espn_game_id, sport: game.sport, home: game.home_team, away: game.away_team, start: game.start_time,
             spread_home: game.spread_home, over_under: game.over_under, ml_home: game.ml_home, ml_away: game.ml_away,
             meta: pick.meta || null }]));
  } catch (_) {}
}

// Different matchups left after every other filter: the pick's own number decides.
function _byLine(cands, opts) {
  const verdicts = cands.map(g => lineAgrees(g, opts));
  const agree = cands.filter((_, i) => verdicts[i] === true);
  if (agree.length === 1) return agree[0];
  const why = agree.length > 1 ? 'several games agree with the line'
            : verdicts.some(v => v === true || v === false) ? 'no game agrees with the line'
            : 'ambiguous team match and no line to confirm';
  logAmbiguous(cands, opts, why);
  return null;
}

// opts.startMs      the source's own start time for its game (exact)
// opts.startDate    the source's own ET date for its game (YYYY-MM-DD)
// opts.firstAfterMs when the pick was published: it is for the FIRST game of
//                   the matchup starting after that, never a later one
function resolveGameMatches(rows, opts = {}) {
  if (!rows || rows.length === 0) return null;
  const now = Date.now();
  const num = (v) => (v != null && v !== '' && Number.isFinite(+v) ? +v : null);
  const srcStart = num(opts.startMs);
  const srcDate  = typeof opts.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.startDate) ? opts.startDate : null;
  const after    = num(opts.firstAfterMs);

  // 1. The source says when its game is. That decides, started or not: a
  //    started game is refused downstream as in-play, never re-homed.
  if (srcStart != null || srcDate || after != null) {
    let pool = rows.filter(g => {
      const s = gameStartMs(g);
      if (s == null) return false;
      if (srcStart != null) return Math.abs(s - srcStart) <= SOURCE_START_TOL_MS;
      if (srcDate) return _etDate(s) === srcDate;
      return s > after - 15 * 60e3; // started after the post (15 min of clock slack)
    });
    if (!pool.length) { logAmbiguous(rows, opts, "no board game at the source's own date"); return null; }
    if (srcStart != null) pool.sort((a, b) => Math.abs(gameStartMs(a) - srcStart) - Math.abs(gameStartMs(b) - srcStart));
    else pool.sort((a, b) => gameStartMs(a) - gameStartMs(b));
    if (srcStart == null && !srcDate) {
      // publish time only: the first game of each matchup after it, never a later one
      const first = new Map();
      for (const g of pool) if (!first.has(_pairKey(g))) first.set(_pairKey(g), g);
      pool = [...first.values()];
    }
    if (pool.length === 1) return pool[0];
    if (new Set(pool.map(_pairKey)).size === 1) {
      // The same matchup twice in the window: a doubleheader.
      if (srcStart != null) return pool[0]; // nearest to the source's own time
      if (pool.some(g => hasGameStarted(g))) {
        logAmbiguous(pool, opts, 'doubleheader and the source gives no start time');
        return null;
      }
      return pool[0];
    }
    return _byLine(pool, opts);
  }

  // 2. No date from the source.
  if (rows.length === 1) return rows[0];
  const upcoming = rows
    .filter(g => {
      if (g.status === 'pre') return true;
      const start = gameStartMs(g);
      return start != null && start > now;
    })
    .sort((a, b) => (gameStartMs(a) || Infinity) - (gameStartMs(b) || Infinity));
  if (!upcoming.length) return null;

  // THE SERIES GUARD: never hand a pick to a later game of a matchup whose
  // earlier game is under way or just ended.
  const underway = rows.filter(g => !upcoming.includes(g) && _recentlyStarted(g, now));
  const guarded = upcoming.filter(g => !underway.some(u => _pairKey(u) === _pairKey(g)));
  if (!guarded.length) {
    logAmbiguous(rows, opts, 'an earlier game of this matchup is under way or just ended');
    return null;
  }
  if (guarded.length === 1) return guarded[0];

  // (a) doubleheader: one matchup, several unstarted games. The nearest.
  if (new Set(guarded.map(_pairKey)).size === 1) return guarded[0];

  // (b) different matchups. Let the pick's own number decide.
  return _byLine(guarded, opts);
}

// Fuzzy today_games matcher by two team names (the proven odds_api.js pattern).
// sport (optional) constrains the match to one league — pass it whenever the
// caller knows it ('Tennis' blends ATP+WTA); without it a bare city pair can
// hit the wrong sport's game.
// opts (optional): { pickType, side, line, odds, source, capper, picked } lets
// the resolver confirm an ambiguous match against the pick's own number, and
// { startMs | startDate | firstAfterMs } pins the game to the source's own date.
function findGameByTeams(teamA, teamB, sport, opts) {
  const t1 = (teamA || '').toLowerCase().trim();
  const t2 = (teamB || '').toLowerCase().trim();
  if (!t1 || !t2) return null;
  const n1 = t1.split(' ').pop();
  const n2 = t2.split(' ').pop();
  try {
    let sql = `
      SELECT * FROM today_games
      WHERE (
        LOWER(home_team) LIKE '%' || ? || '%' OR LOWER(away_team) LIKE '%' || ? || '%'
        OR LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?
      ) AND (
        LOWER(home_team) LIKE '%' || ? || '%' OR LOWER(away_team) LIKE '%' || ? || '%'
        OR LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?
      )`;
    if (sport) {
      if (String(sport).toLowerCase() === 'tennis') sql += ` AND UPPER(sport) IN ('ATP','WTA')`;
      else sql += ` AND UPPER(sport) = UPPER(?)`;
    }
    const tail = sport && String(sport).toLowerCase() !== 'tennis' ? [sport] : [];
    const stmt = db.prepare(sql);
    // Pass 1: the FULL strings as substrings. A pro name's last word is its
    // identity ("Yankees"), but a college name's last word is usually "State":
    // "Washington State @ Kansas State" hit 32 games on that word on one
    // Saturday, and "Ohio State @ Texas" hit four. The full strings pick out
    // exactly one game in both cases, before any line check is needed.
    let rows = stmt.all(t1, t1, t1, t1, t2, t2, t2, t2, ...tail);
    // Pass 2: last words, the original rule, for nicknames and short forms.
    if (!rows.length) rows = stmt.all(n1, n1, t1, t1, n2, n2, t2, t2, ...tail);
    return resolveGameMatches(rows, { sport, ...(opts || {}) });
  } catch (_) { return null; }
}

function findGameByAbbrs(abbrA, abbrB, sport, opts) {
  const a = (abbrA || '').toLowerCase(), b = (abbrB || '').toLowerCase();
  if (!a || !b) return null;
  try {
    let sql = `
      SELECT * FROM today_games
      WHERE (LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?)
        AND (LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?)`;
    const params = [a, a, b, b];
    if (sport) {
      if (String(sport).toLowerCase() === 'tennis') sql += ` AND UPPER(sport) IN ('ATP','WTA')`;
      else { sql += ` AND UPPER(sport) = UPPER(?)`; params.push(sport); }
    }
    return resolveGameMatches(db.prepare(sql).all(...params), { sport, ...(opts || {}) });
  } catch (_) { return null; }
}

// Which side of the game a picked name refers to. Returns 'home' | 'away' | null.
// Scores both sides and takes the better one. The old test was home-first and
// one-way, so a name that merely brushed a home variant was filed home ("New
// York" put a Mets pick on the Yankees; "Utah" on a Utah State game went to the
// wrong Utah). An exact hit outranks any containment; between containments the
// longer matched variant wins; a dead tie is null and the caller skips the pick.
function _nameMatchScore(variants, p) {
  let best = 0;
  for (const n of variants) {
    if (n === p) return Infinity;
    if (n.includes(p) || p.includes(n)) best = Math.max(best, Math.min(n.length, p.length));
  }
  return best;
}
function sideOf(game, picked) {
  const p = (picked || '').toLowerCase().trim();
  if (!p) return null;
  const home = [game.home_team, game.home_short, game.home_name, game.home_abbr].filter(Boolean).map(s => s.toLowerCase());
  const away = [game.away_team, game.away_short, game.away_name, game.away_abbr].filter(Boolean).map(s => s.toLowerCase());
  const h = _nameMatchScore(home, p), a = _nameMatchScore(away, p);
  if (!h && !a) return null;
  if (h === a) return null;
  return h > a ? 'home' : 'away';
}

function gameStartMs(game) {
  if (!game || !game.start_time) return null;
  const iso = game.start_time.includes('T') ? game.start_time : game.start_time.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

// ── Main entry ─────────────────────────────────────────────────────────────────
// pick: { source, capperName, handle, game (today_games row), pickType
//         ('ml'|'spread'|'over'|'under'), side ('home'|'away'|null for totals),
//         line (spread/total number), odds (American), postedAtMs, meta }
// Returns 'inserted' | 'duplicate' | 'skipped:<reason>'.
function recordSourcePick(pick) {
  const { source, game } = pick;
  if (!game || !game.espn_game_id) return 'skipped:no-game';
  const pt = (pick.pickType || '').toLowerCase();
  if (!['ml', 'spread', 'over', 'under'].includes(pt)) return 'skipped:unsupported-type';

  const isTotal = pt === 'over' || pt === 'under';
  if (!isTotal && !pick.side) return 'skipped:no-side';

  // Pregame rule: the SOURCE timestamp decides, AND the game itself gets a vote.
  //
  // In-play entries are DROPPED ENTIRELY (Jack 2026-07-31: "NOTHING IS TRACKED
  // PAST THAT EVEN IF A CAPPER POSTS AT ANY POINT AFTER THAT IT IS NOT ADDED TO
  // CAPPER HISTORY OR NOTHING"). They used to be inserted as capper_history
  // rows flagged live in provenance, on the theory that they were record-only.
  // They were not harmless: d3af377 later had to exclude them from the ratings
  // pool after finding 7,787 of ~19k graded rows were in-play, WTA 82% and ATP
  // 62%, which had been quietly shaping every capper's rank. A row we refuse to
  // judge on should not exist.
  //
  // hasGameStarted() is the second half, and a SUSPENDED match is why (2026-08-02).
  // The timestamp test alone trusts start_time to stay put, and it does not:
  // tennis_espn takes ESPN's freshest date on every upsert, so a halted match gets
  // re-dated to its resumption. The moment that lands, a pick posted while the
  // match sat 1-1 in sets reads as PREGAME (posted before the new start) and earns
  // a capper_history row that grades into the Wilson pool. The Discord path never
  // had this hole because savePick gates on hasGameStarted; this one does now too.
  const startMs = gameStartMs(game);
  const live = !!(startMs && pick.postedAtMs && pick.postedAtMs >= startMs)
            || hasGameStarted(game);
  if (live) return 'skipped:in-play';

  // THE FULL-GAME MARKET GATE (Jack 2026-09-15, src/ledger_sanity.js). Every
  // source hands us "over 5 +800" sooner or later: a team total, a quarter
  // line, a drive prop, a set market, another sport's number on a wrong-game
  // match. Graded against the full-game final, each one is a coin flip filed as
  // a decision, and the Wilson ladder is built on those decisions. The number
  // has to be one this sport's full-game market can carry, agree with the
  // game's own line when we hold one, and be priced like that market. A
  // refusal is logged to source_skips so it stays visible; a replaced price is
  // noted in provenance. A missed pick is free. A wrong one is not.
  const verdict = checkSourcePick({
    game, sport: game.sport, pickType: pt, side: pick.side,
    line: pick.line, odds: pick.odds, trustPrice: pick.trustPrice !== false,
  });
  if (!verdict.ok) {
    logRefusal(pick, game, pt, verdict);
    return 'skipped:' + verdict.reason;
  }
  const line = verdict.line;
  const odds = verdict.odds;
  // A pick the gate keeps on the record as the capper said it but voids
  // (a moneyline at -2000 or heavier, R17): stored, visible, never graded,
  // never a board mention.
  const voidReason = verdict.voidReason || null;
  const meta = { ...(pick.meta || {}) };
  for (const n of verdict.notes) Object.assign(meta, n);

  const team = isTotal ? game.home_team : (pick.side === 'home' ? game.home_team : game.away_team);
  const gameDate = (game.start_time || '').slice(0, 10) || null;

  // Canonical identity (registry-aware, source-scoped handles)
  const { name: canonical } = resolveCapperName(pick.capperName, source);
  ensureRegistered(canonical, source, pick.handle || pick.capperName);

  // Cross-source dedup: same canonical capper + same slot + same game = one row.
  try {
    const existing = db.prepare(`
      SELECT id, source, sources_json FROM capper_history
      WHERE capper_name = ? AND espn_game_id = ? AND LOWER(pick_type) = ?
        AND (LOWER(team) = LOWER(?) OR ? = 1)
      LIMIT 1
    `).get(canonical, game.espn_game_id, pt, team, isTotal ? 1 : 0);
    if (existing) {
      let sources = [];
      try { sources = JSON.parse(existing.sources_json || '[]'); } catch (_) {}
      if (!sources.some(s => s.source === source)) {
        sources.push({ source, at: new Date().toISOString(), live });
        db.prepare(`UPDATE capper_history SET sources_json = ? WHERE id = ?`).run(JSON.stringify(sources), existing.id);
      }
      return 'duplicate';
    }
  } catch (_) {}

  const provenance = JSON.stringify([{ source, at: new Date().toISOString(), live, meta: Object.keys(meta).length ? meta : null }]);
  let historyId = null;
  try {
    const r = db.prepare(`
      INSERT INTO capper_history
        (capper_name, sport, pick_type, team, spread, espn_game_id, game_date,
         channel, score, result, pick_id, odds, source, is_home_team, sources_json, void_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)
    `).run(
      canonical,
      game.sport ?? null,
      pt,
      team,
      line,
      game.espn_game_id,
      gameDate,
      source,
      voidReason ? 'void' : 'pending',
      odds,
      source,
      isTotal ? 0 : (pick.side === 'home' ? 1 : 0),
      provenance,
      voidReason
    );
    historyId = r.lastInsertRowid;
  } catch (err) {
    console.warn(`[ingest:${source}] insert failed:`, err.message);
    return 'skipped:insert-error';
  }

  // Board mention (v3 only, pregame only, settings-gated). savePick runs the
  // full pipeline: slot match, mention count, v2+v3 scoring, leak, MVP/archive
  // gates. Dedup is double-walled: the capper_history check above (one push per
  // capper per slot) and updateSlot's message_id / author+channel checks.
  // Gates: source_board_points is the master switch; source_board_<source>
  // (e.g. source_board_polymarket) turns one system off on its own.
  if (!live && !voidReason
      && db.getSetting('scoring_version', 'v2') === 'v3'
      && db.getSetting('source_board_points', '1') === '1'
      && db.getSetting(`source_board_${source}`, '1') === '1') {
    try {
      savePick({
        team,
        // Board slot convention (lines.js): 'ML' uppercase, spread/over/under lowercase
        pick_type: pt === 'ml' ? 'ML' : pt,
        sport: game.sport ?? null,
        spread_value: line,
        capper_name: canonical,
        espn_game_id: game.espn_game_id,
        game_date: gameDate,
        channel: source,
        is_home_team: isTotal ? 0 : (pick.side === 'home' ? 1 : 0),
        source_scope: source,
        raw_message: {
          id: `src:${source}:${historyId}`,
          author: canonical,
          content: `[${source}] ${canonical}: ${team} ${pt}${line != null ? ' ' + line : ''}${odds != null ? ' @' + odds : ''}`,
          createdAt: pick.postedAtMs || Date.now(),
        },
      });
    } catch (err) {
      console.warn(`[ingest:${source}] board mention failed:`, err.message);
    }
  }
  return 'inserted';
}

// ── Withdraw a source capper's entry from one side of a game ─────────────────
// Deletes the PENDING capper_history row and the board mention it minted, then
// rescores the slot from the surviving mentions. Used when a wallet's stance
// resolves to the other side (flip) or to flat (hedge) — a capper can never
// legitimately hold picks on both sides of the same market. Graded rows are
// never touched.
function removeSourceEntry({ canonical, espn_game_id, pickType, team }) {
  const pt = (pickType || '').toLowerCase();
  const isTotal = pt === 'over' || pt === 'under';

  // NOT ONCE THE GAME IS UNDER WAY (Jack 2026-07-31). A wallet hedging or
  // flipping mid-game is trading its own position, not retracting the read it
  // published before first pitch — and the withdrawal used to run anyway, on a
  // live slot, with no start check anywhere in the path. It deleted the pending
  // capper_history row (so the capper lost credit for a call they made in time)
  // and deleted the board mention, then re-scored the slot from the survivors
  // against whatever the ratings pool looked like at that minute. Same rule as
  // the score itself: what a pick is worth at first pitch is what it is worth.
  try {
    const g = db.prepare(`SELECT status, start_time, actual_start_at, sport, home_score, away_score
                          FROM today_games WHERE espn_game_id = ?`).get(espn_game_id);
    if (g && require('./pick_cutoff').hasGameStarted(g)) {
      console.log(`[ingest] withdrawal ignored for ${canonical} on ${espn_game_id} ${pt} — game already started`);
      return { removed: false, reason: 'game_started' };
    }
  } catch (_) { /* unknown game state: fall through to the existing behaviour */ }
  const hist = db.prepare(`
    SELECT id, source FROM capper_history
    WHERE capper_name = ? AND espn_game_id = ? AND LOWER(pick_type) = ?
      AND (LOWER(team) = LOWER(?) OR ? = 1) AND result = 'pending'
    LIMIT 1
  `).get(canonical, espn_game_id, pt, team || '', isTotal ? 1 : 0);
  if (!hist) return { removed: false };

  db.prepare(`DELETE FROM capper_history WHERE id = ?`).run(hist.id);

  // The board mention (if one was minted): author = canonical, channel = source.
  const slot = db.prepare(`
    SELECT id FROM picks
    WHERE espn_game_id = ? AND LOWER(pick_type) = ? AND (LOWER(team) = LOWER(?) OR ? = 1)
    LIMIT 1
  `).get(espn_game_id, pt, team || '', isTotal ? 1 : 0);
  let rescored = null;
  if (slot) {
    const del = db.prepare(
      `DELETE FROM raw_messages WHERE pick_id = ? AND author = ? AND channel = ?`
    ).run(slot.id, canonical, hist.source);
    if (del.changes > 0) {
      const { recomputePickFromMentions } = require('./storage');
      rescored = recomputePickFromMentions(slot.id);
    }
  }
  return { removed: true, historyId: hist.id, pickId: slot ? slot.id : null, rescored };
}

// A capper's PENDING entry on the OPPOSITE side of the same game + market kind.
// ml vs ml / spread vs spread on the other team; over vs under for totals.
function findPendingOpposite({ canonical, espn_game_id, pickType, team }) {
  const pt = (pickType || '').toLowerCase();
  if (pt === 'over' || pt === 'under') {
    const opp = pt === 'over' ? 'under' : 'over';
    return db.prepare(`
      SELECT * FROM capper_history
      WHERE capper_name = ? AND espn_game_id = ? AND LOWER(pick_type) = ? AND result = 'pending'
      LIMIT 1
    `).get(canonical, espn_game_id, opp) || null;
  }
  return db.prepare(`
    SELECT * FROM capper_history
    WHERE capper_name = ? AND espn_game_id = ? AND LOWER(pick_type) = ?
      AND LOWER(team) != LOWER(?) AND result = 'pending'
    LIMIT 1
  `).get(canonical, espn_game_id, pt, team || '') || null;
}

// American odds from a prediction-market price (0..1).
function americanFromPrice(p) {
  const x = parseFloat(p);
  if (!Number.isFinite(x) || x <= 0 || x >= 1) return null;
  return Math.round(x >= 0.5 ? (-100 * x) / (1 - x) : (100 * (1 - x)) / x);
}

// Source league labels -> CappingAlpha sport labels. Unknown leagues return
// null so the caller matches unconstrained (and the resolver still refuses a
// real ambiguity) instead of silently dropping a pick from a league we simply
// have not mapped yet.
const LEAGUE_TO_SPORT = {
  mlb: 'MLB', nfl: 'NFL', nba: 'NBA', nhl: 'NHL', wnba: 'WNBA',
  ncaaf: 'NCAAF', cfb: 'NCAAF', 'college-football': 'NCAAF',
  ncaab: 'CBB', cbb: 'CBB', 'college-basketball': 'CBB', ncaaw: 'WCBB', wcbb: 'WCBB',
  atp: 'Tennis', wta: 'Tennis', tennis: 'Tennis',
  soccer: 'Soccer', mls: 'Soccer', epl: 'Soccer', uefa: 'Soccer', ucl: 'Soccer', laliga: 'Soccer',
  seriea: 'Soccer', bundesliga: 'Soccer', ligue1: 'Soccer', ligamx: 'Soccer',
};
function sportForLeague(name) {
  const k = String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!k) return null;
  if (LEAGUE_TO_SPORT[k]) return LEAGUE_TO_SPORT[k];
  if (/soccer|premier|liga|serie|bundes|ligue|champions|europa|cup|fifa/.test(k)) return 'Soccer';
  return null;
}

module.exports = { recordSourcePick, findGameByTeams, findGameByAbbrs, sideOf, gameStartMs, americanFromPrice, removeSourceEntry, findPendingOpposite, sportForLeague, resolveGameMatches, LINE_TOL, SERIES_GUARD_MS };
