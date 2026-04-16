// src/wipe.js
// 4:58am daily reset — clears stale data so the 5am setup can start fresh.

const db = require('./db');

const WIPE_TABLES = [
  'score_breakdown',   // FK → picks, must go first
  'raw_messages',      // FK → picks, must go first
  'picks',
  'today_games',
  'live_games',
  'scanner_state',
  'skipped_messages',  // cycle-scoped — 5am first scan re-fetches from 12:30am anyway
  'line_snapshots',
  'live_lines',
];

async function runDailyWipe() {
  console.log('[wipe] Starting daily wipe...');

  for (const table of WIPE_TABLES) {
    const { changes } = db.prepare(`DELETE FROM ${table}`).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
    console.log(`[wipe] ${table}: ${changes} rows deleted`);
  }

  console.log('[wipe] Daily wipe complete');
}

module.exports = { runDailyWipe };
