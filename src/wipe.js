// src/wipe.js
// 4:58am daily reset — clears stale data so the 5am setup can start fresh.
// pick_history is written live from storage.js (not here) so no archive step needed.
//
// Carryover: games that are NOT final (postponed / suspended) are preserved along
// with their picks + locked lines, so a match that gets pushed to the next day still
// grades when it actually plays instead of vanishing. Truly-dead games age out after
// CARRYOVER_GRACE_DAYS. See the Jodar vs Zverev postponement.

const db = require('./db');

// Tables with no carryover semantics — always cleared, re-synced at 5am.
const FULL_WIPE_TABLES = [
  'live_games',
  'scanner_state',
  'skipped_messages',  // cycle-scoped — 5am first scan re-fetches from 12:30am anyway
  'live_lines',
  'line_history',
  'polymarket_cache',
  'kalshi_cache',
];

// Pick/game tables that normally clear, but keep rows tied to carried-over games.
const SCOPED_WIPE_TABLES = ['score_breakdown', 'raw_messages', 'picks', 'today_games', 'line_snapshots'];

const CARRYOVER_GRACE_DAYS = 3;

async function runDailyWipe() {
  console.log('[wipe] Starting daily wipe...');

  // ── Find unfinished games to carry forward (postponed / suspended, still recent) ──
  const carry = db.prepare(`
    SELECT espn_game_id FROM today_games
    WHERE status != 'post'
      AND start_time IS NOT NULL
      AND datetime(start_time) >= datetime('now', ?)
  `).all(`-${CARRYOVER_GRACE_DAYS} days`).map(r => r.espn_game_id).filter(Boolean);

  if (carry.length) {
    console.log(`[wipe] Carrying ${carry.length} unfinished game(s) forward: ${carry.join(', ')}`);
    const ph = carry.map(() => '?').join(',');
    const keptPicks = `SELECT id FROM picks WHERE espn_game_id IN (${ph})`;

    // FK children first — drop any tied to picks we're NOT keeping.
    const sb = db.prepare(`DELETE FROM score_breakdown WHERE pick_id NOT IN (${keptPicks})`).run(...carry);
    const rm = db.prepare(`DELETE FROM raw_messages   WHERE pick_id NOT IN (${keptPicks})`).run(...carry);
    const pk = db.prepare(`DELETE FROM picks          WHERE espn_game_id IS NULL OR espn_game_id NOT IN (${ph})`).run(...carry);
    const tg = db.prepare(`DELETE FROM today_games    WHERE espn_game_id NOT IN (${ph})`).run(...carry);
    const ls = db.prepare(`DELETE FROM line_snapshots WHERE game_id NOT IN (${ph})`).run(...carry);
    console.log(`[wipe] score_breakdown: ${sb.changes} | raw_messages: ${rm.changes} | picks: ${pk.changes} | today_games: ${tg.changes} | line_snapshots: ${ls.changes} rows deleted (carryover kept)`);
    // Note: sqlite_sequence is intentionally NOT reset here — carried rows keep their ids.
  } else {
    // Nothing to carry — clear wholesale (original behavior, resets autoincrement).
    for (const table of SCOPED_WIPE_TABLES) {
      const { changes } = db.prepare(`DELETE FROM ${table}`).run();
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
      console.log(`[wipe] ${table}: ${changes} rows deleted`);
    }
  }

  // ── Tables with no carryover semantics — always cleared. ──
  for (const table of FULL_WIPE_TABLES) {
    const { changes } = db.prepare(`DELETE FROM ${table}`).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
    console.log(`[wipe] ${table}: ${changes} rows deleted`);
  }

  console.log('[wipe] Daily wipe complete');
}

module.exports = { runDailyWipe };
