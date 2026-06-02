// src/game_start_tracker.js
// Stamps today_games.actual_start_at the first time ESPN reports a game live.
// Runs as a sibling helper after updateLiveScores() — never touches espn_live.js.

const db = require('./db');

function stampActualStarts() {
  try {
    const r = db.prepare(`
      UPDATE today_games
      SET actual_start_at = datetime('now')
      WHERE status = 'in' AND actual_start_at IS NULL
    `).run();
    if (r.changes > 0) {
      console.log(`[gameStartTracker] stamped actual_start_at on ${r.changes} game(s)`);
    }
    return r.changes;
  } catch (err) {
    console.warn('[gameStartTracker] stampActualStarts error:', err.message);
    return 0;
  }
}

// Stamps today_games.actual_end_at the first time a game reports final ('post').
// Powers the per-game prune's grace tail (keep a finished game for N hours past end).
function stampActualEnds() {
  try {
    const r = db.prepare(`
      UPDATE today_games
      SET actual_end_at = datetime('now')
      WHERE status = 'post' AND actual_end_at IS NULL
    `).run();
    if (r.changes > 0) {
      console.log(`[gameStartTracker] stamped actual_end_at on ${r.changes} game(s)`);
    }
    return r.changes;
  } catch (err) {
    console.warn('[gameStartTracker] stampActualEnds error:', err.message);
    return 0;
  }
}

module.exports = { stampActualStarts, stampActualEnds };
