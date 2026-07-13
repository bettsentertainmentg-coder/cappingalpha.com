// src/wipe.js
// Per-game rolling retention + daily operational reset.
//
// Instead of a single 4:58am wholesale delete, games (and their picks + tied
// rows) are pruned individually by pruneStaleGames(): each game lingers on the
// live board until the daily cycle clear the morning after its game day (default
// 4:58am ET, settings key `cycle_clear_hour`), plus a grace tail past its actual
// end (default 4h, settings key `post_game_grace_hours`) so late West Coast games
// aren't guillotined. Unfinished/forward games always survive (bounded to 3 days).
// pruneStaleGames() runs hourly; runDailyWipe() also runs it at 4:58am alongside
// the operational-table reset.
//
// pick_history is written live from storage.js (not here). Permanent tables
// (mvp_picks, pick_history, capper_history, golf_*, users, ...) are never touched.

const db = require('./db');
const { cycleDateForInstant, cycleClearCutoff } = require('./cycle');

// Tables with no carryover semantics — always cleared at 4:58am, re-synced at 5am.
// (skipped_messages is intentionally NOT here — it's the pending-attribution queue,
//  age-pruned to 3 days inside pruneStaleGames so forward skips survive to re-match.)
const FULL_WIPE_TABLES = [
  'live_games',
  'scanner_state',
  'live_lines',
  'line_history',
  'polymarket_cache',
  'kalshi_cache',
];

const GRACE_DAYS = 3;

// Parse a today_games timestamp (start_time is ISO; actual_end_at is sqlite
// 'YYYY-MM-DD HH:MM:SS' UTC) into epoch ms.
function toMs(s) {
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

// ── Per-game prune: remove games past their retention, with FK-safe child cleanup ─
function pruneStaleGames() {
  const clearHour  = db.getSetting('cycle_clear_hour', '04:58');
  const graceHours = parseFloat(db.getSetting('post_game_grace_hours', '4')) || 4;
  const now        = Date.now();
  const graceMs    = graceHours * 3600 * 1000;
  const minStartMs = now - GRACE_DAYS * 24 * 3600 * 1000;

  const games = db.prepare(`SELECT espn_game_id, status, start_time, actual_end_at FROM today_games`).all();

  const keep = [];
  for (const g of games) {
    const startMs = toMs(g.start_time);

    if (g.status !== 'post') {
      // Upcoming / live / postponed — keep while within the 3-day bound (or if we
      // don't know its start time yet). Truly-dead old non-final games age out.
      if (startMs == null || startMs >= minStartMs) keep.push(g.espn_game_id);
      continue;
    }

    // Finished — keep until the cycle clear the morning after its game day...
    const gd = g.start_time ? cycleDateForInstant(g.start_time) : null;
    if (gd && now < cycleClearCutoff(gd, clearHour)) { keep.push(g.espn_game_id); continue; }

    // ...or within the grace tail past its actual end (fallback start+6h if the
    // game finalized while the app was down and actual_end_at was never stamped).
    const endMs = toMs(g.actual_end_at) ?? (startMs != null ? startMs + 6 * 3600 * 1000 : null);
    if (endMs != null && now < endMs + graceMs) keep.push(g.espn_game_id);
  }

  const ph = keep.map(() => '?').join(',');

  // Picks to delete: tied to a dropped game, OR stale unmatched picks (no game id,
  // game_date older than the 3-day grace). Recent unmatched picks ride along so a
  // forward pick whose game isn't fetched yet isn't lost before its game appears.
  const gameTiedDrop = keep.length
    ? `(espn_game_id IS NOT NULL AND espn_game_id NOT IN (${ph}))`
    : `(espn_game_id IS NOT NULL)`;
  const delPicksWhere =
    `${gameTiedDrop} OR (espn_game_id IS NULL AND (game_date IS NULL OR game_date < date('now','-${GRACE_DAYS} days')))`;

  const delGamesWhere = keep.length ? `espn_game_id NOT IN (${ph})` : `1`;
  const delSnapWhere  = keep.length ? `game_id NOT IN (${ph})`      : `1`;

  let deleted = { picks: 0, games: 0 };
  const tx = db.transaction(() => {
    // FK children first — anything tied to a pick we're about to delete.
    db.prepare(`DELETE FROM score_breakdown WHERE pick_id IN (SELECT id FROM picks WHERE ${delPicksWhere})`).run(...keep);
    db.prepare(`DELETE FROM raw_messages   WHERE pick_id IN (SELECT id FROM picks WHERE ${delPicksWhere})`).run(...keep);
    deleted.picks = db.prepare(`DELETE FROM picks WHERE ${delPicksWhere}`).run(...keep).changes;
    deleted.games = db.prepare(`DELETE FROM today_games WHERE ${delGamesWhere}`).run(...keep).changes;
    db.prepare(`DELETE FROM line_snapshots WHERE ${delSnapWhere}`).run(...keep);
    // Age-prune the pending-attribution queue.
    db.prepare(`DELETE FROM skipped_messages WHERE skipped_at < datetime('now','-${GRACE_DAYS} days')`).run();
    // Props are day-of data at ~50k rows/day full-scale; no long-term read
    // path once games grade, so age them out with the same grace window.
    try {
      db.prepare(`DELETE FROM book_props WHERE (game_date IS NULL AND updated_at < datetime('now','-${GRACE_DAYS} days')) OR game_date < date('now','-${GRACE_DAYS} days')`).run();
    } catch (_) {}
  });

  try {
    tx();
    if (deleted.picks || deleted.games) {
      console.log(`[prune] kept ${keep.length} game(s); removed ${deleted.games} game(s), ${deleted.picks} pick(s)`);
    }
  } catch (err) {
    console.error('[prune] pruneStaleGames error:', err.message);
  }
  return deleted;
}

// ── 4:58am daily reset: operational tables + a per-game prune pass ────────────
async function runDailyWipe() {
  console.log('[wipe] Starting daily reset...');

  // Per-game prune owns picks / today_games / score_breakdown / raw_messages /
  // line_snapshots — finished games linger until their cycle clear (+ grace tail).
  pruneStaleGames();

  // Operational tables with no carryover — always cleared, re-synced at 5am.
  for (const table of FULL_WIPE_TABLES) {
    const { changes } = db.prepare(`DELETE FROM ${table}`).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
    console.log(`[wipe] ${table}: ${changes} rows deleted`);
  }

  console.log('[wipe] Daily reset complete');
}

module.exports = { runDailyWipe, pruneStaleGames };
