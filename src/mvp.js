// src/mvp.js
// MVP pick history — reads and updates mvp_picks table.

const db = require('./db');

// Get last 50 MVP picks ordered by saved_at desc, enriched with matchup.
// Includes voided picks so annotations are visible in history.
function getRecentMvpPicks() {
  return db.prepare(`
    SELECT m.*,
           COALESCE(tg1.home_team, tg2.home_team) AS home_team,
           COALESCE(tg1.away_team, tg2.away_team) AS away_team
    FROM mvp_picks m
    LEFT JOIN today_games tg1 ON tg1.espn_game_id = m.espn_game_id
    LEFT JOIN today_games tg2 ON tg1.espn_game_id IS NULL
                              AND (LOWER(tg2.home_team) = LOWER(m.team) OR LOWER(tg2.away_team) = LOWER(m.team))
    WHERE m.score >= 50
    ORDER BY m.saved_at DESC LIMIT 50
  `).all();
}

// Get all-time record across all MVP picks (score >= 50 only, void excluded from W/L)
function getAllTimeRecord() {
  const rows = db.prepare(`
    SELECT result, COUNT(*) as count FROM mvp_picks
    WHERE score >= 50 AND (result IS NULL OR result != 'void')
      AND (annotation IS NULL OR annotation NOT LIKE '%not counted%')
    GROUP BY result
  `).all();

  const counts = { win: 0, loss: 0, push: 0, pending: 0 };
  for (const row of rows) {
    const key = (row.result || 'pending').toLowerCase();
    if (key in counts) counts[key] = row.count;
  }

  const decided = counts.win + counts.loss;
  const total   = decided + counts.push + counts.pending;
  const win_rate = decided > 0
    ? Math.round((counts.win / decided) * 100) + '%'
    : '0%';

  return {
    wins:     counts.win,
    losses:   counts.loss,
    pushes:   counts.push,
    pending:  counts.pending,
    total,
    win_rate,
  };
}

// Mark a pick result when game finishes
function setMvpResult(id, result) {
  const valid = ['win', 'loss', 'push', 'void'];
  if (!valid.includes(result)) {
    throw new Error(`Invalid result "${result}" — must be one of: ${valid.join(', ')}`);
  }
  db.prepare(`UPDATE mvp_picks SET result = ? WHERE id = ?`).run(result, id);
}

// Resolve conflicting MVP picks for the same game right before game time.
// Equal scores → both voided with "rare push" annotation.
// Different scores → lower voided with "had less points" annotation; higher kept.
// Safe to call on cron — no-ops when nothing to resolve.
function resolveConflictingMvpPicks() {
  const conflicts = db.prepare(`
    SELECT espn_game_id, COUNT(*) as cnt
    FROM mvp_picks
    WHERE espn_game_id IS NOT NULL AND result = 'pending'
    GROUP BY espn_game_id
    HAVING cnt > 1
  `).all();

  if (!conflicts.length) return 0;

  let resolved = 0;

  for (const { espn_game_id } of conflicts) {
    const game = db.prepare(`
      SELECT start_time, status FROM today_games WHERE espn_game_id = ?
    `).get(espn_game_id);

    if (!game) continue;

    const minsUntil = (new Date(game.start_time).getTime() - Date.now()) / 60000;
    // Only act within 10 minutes of start or once game is live
    if (minsUntil > 10 && game.status === 'pre') continue;

    const picks = db.prepare(`
      SELECT id, score, team, pick_type FROM mvp_picks
      WHERE espn_game_id = ? AND result = 'pending'
      ORDER BY score DESC
    `).all(espn_game_id);

    if (picks.length < 2) continue;

    const topScore = picks[0].score;
    const allTied  = picks.every(p => p.score === topScore);

    if (allTied) {
      // All picks share the same score — void every one, no winner
      const note = '*rare push — both picks scored equal (so wild)';
      for (const p of picks) {
        db.prepare(`UPDATE mvp_picks SET result = 'void', annotation = ? WHERE id = ?`).run(note, p.id);
      }
      console.log(`[mvp] Tie conflict game ${espn_game_id}: voided ${picks.length} picks (score=${topScore})`);
    } else {
      // Keep highest; void the rest
      const note = '*had less points — not counted';
      for (const p of picks.slice(1)) {
        db.prepare(`UPDATE mvp_picks SET result = 'void', annotation = ? WHERE id = ?`).run(note, p.id);
      }
      console.log(`[mvp] Conflict game ${espn_game_id}: kept pick ${picks[0].id} (score=${topScore}), voided ${picks.length - 1}`);
    }

    resolved++;
  }

  return resolved;
}

module.exports = { getRecentMvpPicks, getAllTimeRecord, setMvpResult, resolveConflictingMvpPicks };
