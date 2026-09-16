// src/game_start_tracker.js
// Stamps today_games.actual_start_at the first time ESPN reports a game live.
// Runs as a sibling helper after updateLiveScores() — never touches espn_live.js.

const db = require('./db');

function stampActualStarts() {
  try {
    // Read the ids BEFORE the update — afterwards they are indistinguishable from
    // games stamped on an earlier pass, and this is the one moment we can freeze
    // their conviction curves at their true first-pitch shape.
    const starting = db.prepare(`
      SELECT espn_game_id FROM today_games WHERE status = 'in' AND actual_start_at IS NULL
    `).all();
    const r = db.prepare(`
      UPDATE today_games
      SET actual_start_at = datetime('now')
      WHERE status = 'in' AND actual_start_at IS NULL
    `).run();
    if (r.changes > 0) {
      console.log(`[gameStartTracker] stamped actual_start_at on ${r.changes} game(s)`);
    }
    // Freeze the curve with the score. A pick's points stop at first pitch, so the
    // record of HOW it got there has to stop at first pitch too (lazy require:
    // pick_timeline pulls in scoring_v3, which must not load at module scope here).
    try {
      const { freezeTimelinesForGame, freezeStartedCurves } = require('./pick_timeline');
      let frozen = 0;
      for (const g of starting) frozen += freezeTimelinesForGame(g.espn_game_id);
      if (frozen) console.log(`[gameStartTracker] froze ${frozen} conviction curve(s) at first pitch`);
      // Backstop for anything that got past the stamp (first seen as 'post',
      // a restart across the flip, a tick window we missed).
      freezeStartedCurves();
    } catch (err) {
      console.warn('[gameStartTracker] curve freeze error:', err.message);
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
