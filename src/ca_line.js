// src/ca_line.js — the CA official line lock.
//
// THE RULE (Jack, 2026-07-14): a game's line locks ONE HOUR BEFORE GAME START.
// That is the moment the hypothetical bet is "placed": whatever the market shows
// at T-60 becomes the official line — the number the CA rankings display and every
// tracked bet is priced at and grades against. We write it EVERYWHERE a reader
// looks (today_games odds, the picks rows the rankings display, line_snapshots
// that grading reads, mvp_picks + pick_history P/L) and set ca_line_locked=1 so no
// later refresh moves it. Before T-60, a pick shows the current (5am-seeded) line
// as a placeholder. A pick that reaches gold inside the final hour simply inherits
// the already-locked line (the old lock-on-gold trigger was retired 2026-07-14 —
// it priced bets hours before the market settled).
//
// Points are separate: scores keep tallying until the game actually goes live, and
// the tracked bet can FLIP to the other side any time pregame (mvp.js flip pass).
// A flipped bet is priced at this same locked line.
//
// Pregame only — there is no live in-game line (ESPN drops odds once a game is
// 'in'). lockCaLinesAtT60() is the 5-min cron (index.js).

const db = require('./db');

const T60_MS = 60 * 60 * 1000;

// Which book's number counts as "the line". Recognizable licensed US books first,
// offshore/sharp last. Each market takes its value from the first book in this order
// that has a non-null number; today_games' own odds are the final fallback so a game
// with thin book coverage still gets a full line.
const BOOK_PRIORITY = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'bet365', 'betrivers', 'hardrock', 'pinnacle', 'bovada'];

// Best current book line for a game, market by market.
function bestBookLineForGame(game) {
  let rows = [];
  try { rows = db.prepare(`SELECT * FROM book_lines WHERE espn_game_id = ?`).all(game.espn_game_id); }
  catch (_) { rows = []; }
  const byBook = new Map(rows.map(r => [r.book, r]));
  const pick = (field) => {
    for (const b of BOOK_PRIORITY) {
      const r = byBook.get(b);
      if (r && r[field] != null) return r[field];
    }
    return null;
  };
  return {
    ml_home:       pick('ml_home')       ?? game.ml_home       ?? null,
    ml_away:       pick('ml_away')       ?? game.ml_away       ?? null,
    spread_home:   pick('spread_home')   ?? game.spread_home   ?? null,
    spread_away:   pick('spread_away')   ?? game.spread_away   ?? null,
    over_under:    pick('over_under')    ?? game.over_under    ?? null,
    ou_over_odds:  pick('ou_over_odds')  ?? game.ou_over_odds  ?? null,
    ou_under_odds: pick('ou_under_odds') ?? game.ou_under_odds ?? null,
    // book_lines carries no spread JUICE — keep today_games' captured juice.
    spread_home_odds: game.spread_home_odds ?? null,
    spread_away_odds: game.spread_away_odds ?? null,
  };
}

// The picked side's numbers from a game-shaped odds object (used for the per-pick
// captured P/L line). Mirrors storage.liveDkForSide.
function sideLine(game, team, pick_type) {
  const isHome = (game.home_team || '').toLowerCase() === (team || '').toLowerCase();
  const t = (pick_type || '').toLowerCase();
  return {
    ml:      t === 'ml'     ? (isHome ? game.ml_home : game.ml_away)     : null,
    spread:  t === 'spread' ? (isHome ? game.spread_home : game.spread_away) : null,
    total:   (t === 'over' || t === 'under') ? game.over_under           : null,
    ou_odds: t === 'over'   ? game.ou_over_odds : t === 'under' ? game.ou_under_odds : null,
  };
}

// The display line for a seeded slot — mirrors src/lines.js seedPickSlots exactly so
// the picks row shows the same shape it always did, now at the T-60 value.
function slotDisplay(pick, line) {
  const t = (pick.pick_type || '').toLowerCase();
  const isHome = pick.is_home_team === 1;
  if (t === 'ml')     return { spread: isHome ? line.ml_home : line.ml_away, original_ml: isHome ? line.ml_home : line.ml_away, original_ou: null };
  if (t === 'spread') return { spread: isHome ? line.spread_home : line.spread_away, original_ml: null, original_ou: null };
  if (t === 'over' || t === 'under') return { spread: line.over_under, original_ml: null, original_ou: line.over_under };
  return { spread: pick.spread, original_ml: pick.original_ml, original_ou: pick.original_ou };
}

// Prepared once — the writes that stamp the official line everywhere a reader looks.
const _updGame = db.prepare(`
  UPDATE today_games
  SET ml_home=?, ml_away=?, spread_home=?, spread_away=?,
      spread_home_odds=?, spread_away_odds=?,
      over_under=?, ou_over_odds=?, ou_under_odds=?,
      odds_updated_at=datetime('now'), ca_line_locked=1, ca_line_at=datetime('now')
  WHERE espn_game_id=?
`);
const _upsertSnap = db.prepare(`
  INSERT INTO line_snapshots (game_id, team, original_ml, original_spread, original_ou)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(game_id, team) DO UPDATE SET
    original_ml     = excluded.original_ml,
    original_spread = excluded.original_spread,
    original_ou     = excluded.original_ou
`);
const _updPick = db.prepare(`
  UPDATE picks SET spread=?, original_ml=?, original_ou=?,
    captured_ml=?, captured_spread=?, captured_total=?, captured_ou_odds=?, line_captured_at=datetime('now')
  WHERE id=?
`);
const _updMvp = db.prepare(`UPDATE mvp_picks SET ml_odds=?, ou_odds=?, captured_spread=?, captured_total=?, line_captured_at=datetime('now') WHERE id=?`);
const _updPh  = db.prepare(`UPDATE pick_history SET live_ml=?, live_spread=?, live_total=?, live_ou_odds=?, line_captured_at=datetime('now') WHERE id=?`);

// Snapshot + lock ONE game's official line. Idempotent via ca_line_locked. Atomic.
const _lockGame = db.transaction((game) => {
  const line = bestBookLineForGame(game);
  _updGame.run(
    line.ml_home, line.ml_away, line.spread_home, line.spread_away,
    line.spread_home_odds, line.spread_away_odds,
    line.over_under, line.ou_over_odds, line.ou_under_odds, game.espn_game_id
  );
  const g2 = { ...game, ...line };
  _upsertSnap.run(game.espn_game_id, game.home_team, line.ml_home, line.spread_home, line.over_under);
  _upsertSnap.run(game.espn_game_id, game.away_team, line.ml_away, line.spread_away, line.over_under);
  for (const p of db.prepare(`SELECT * FROM picks WHERE espn_game_id=?`).all(game.espn_game_id)) {
    const d = slotDisplay(p, line);
    const s = sideLine(g2, p.team, p.pick_type);
    _updPick.run(d.spread, d.original_ml, d.original_ou, s.ml, s.spread, s.total, s.ou_odds, p.id);
  }
  for (const m of db.prepare(`SELECT id, team, pick_type FROM mvp_picks WHERE espn_game_id=?`).all(game.espn_game_id)) {
    const s = sideLine(g2, m.team, m.pick_type);
    _updMvp.run(s.ml, s.ou_odds, s.spread, s.total, m.id);
  }
  for (const ph of db.prepare(`SELECT id, team, pick_type FROM pick_history WHERE espn_game_id=? AND result='pending'`).all(game.espn_game_id)) {
    const s = sideLine(g2, ph.team, ph.pick_type);
    _updPh.run(s.ml, s.spread, s.total, s.ou_odds, ph.id);
  }
});

const isLocked = (g) => g && (g.ca_line_locked === 1);

function lockCaLineForGame(game) {
  if (!game || isLocked(game)) return false;
  try { _lockGame(game); return true; }
  catch (e) { console.error(`[ca_line] lock failed for ${game && game.espn_game_id}:`, e.message); return false; }
}

// THE trigger: T-60. Lock every pre-game within 1 hour of start that isn't locked
// yet. Idempotent, cheap, safe to run every 5 min.
function lockCaLinesAtT60() {
  const cutoff = new Date(Date.now() + T60_MS).toISOString();
  let games = [];
  try {
    games = db.prepare(`
      SELECT * FROM today_games
      WHERE status = 'pre' AND COALESCE(ca_line_locked, 0) = 0
        AND start_time IS NOT NULL AND start_time <= ?
    `).all(cutoff);
  } catch (_) { return 0; }
  let locked = 0;
  for (const game of games) if (lockCaLineForGame(game)) locked++;
  if (locked) console.log(`[ca_line] T-60 locked ${locked} game(s)`);
  return locked;
}

module.exports = { lockCaLinesAtT60, lockCaLineForGame, bestBookLineForGame };
