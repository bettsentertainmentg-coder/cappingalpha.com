// src/mvp.js
// MVP pick history — reads and updates mvp_picks table.

const db = require('./db');

// Get last 50 MVP picks ordered by saved_at desc, enriched with matchup.
// Includes voided picks so annotations are visible in history.
function getRecentMvpPicks(threshold = 50) {
  // Only JOIN today_games by espn_game_id (safe — unique key).
  // Never use name-based JOIN (tg2): causes duplicates on doubleheader days.
  // New picks have home_team/away_team stored at save time; old ones show p.team.
  return db.prepare(`
    SELECT m.*,
           COALESCE(m.home_team, tg.home_team) AS home_team,
           COALESCE(m.away_team, tg.away_team) AS away_team
    FROM mvp_picks m
    LEFT JOIN today_games tg ON m.home_team IS NULL AND tg.espn_game_id = m.espn_game_id
    WHERE m.score >= ?
    ORDER BY m.saved_at DESC LIMIT 50
  `).all(threshold);
}

// Get all-time record across all MVP picks (void excluded from W/L)
function getAllTimeRecord(threshold = 50) {
  const rows = db.prepare(`
    SELECT result, COUNT(*) as count FROM mvp_picks
    WHERE score >= ? AND (result IS NULL OR result != 'void')
      AND (annotation IS NULL OR annotation NOT LIKE '%not counted%')
    GROUP BY result
  `).all(threshold);

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
// Only picks for the SAME TEAM, SAME PICK TYPE, SAME GAME are true duplicates
// (multiple cappers posting the same call). Opposing-team picks on the same game
// (e.g. Hornets ML vs Magic ML) are independent bets and must never conflict.
// Equal scores → both voided with "rare push" annotation.
// Different scores → lower voided with "had less points" annotation; higher kept.
// Safe to call on cron — no-ops when nothing to resolve.
function resolveConflictingMvpPicks() {
  const conflicts = db.prepare(`
    SELECT espn_game_id, pick_type, LOWER(team) as team_key, COUNT(*) as cnt
    FROM mvp_picks
    WHERE espn_game_id IS NOT NULL AND result = 'pending'
    GROUP BY espn_game_id, pick_type, LOWER(team)
    HAVING cnt > 1
  `).all();

  if (!conflicts.length) return 0;

  let resolved = 0;

  for (const { espn_game_id, pick_type, team_key } of conflicts) {
    const game = db.prepare(`
      SELECT start_time, status FROM today_games WHERE espn_game_id = ?
    `).get(espn_game_id);

    if (!game) continue;

    const minsUntil = (new Date(game.start_time).getTime() - Date.now()) / 60000;
    // Only act within 10 minutes of start or once game is live
    if (minsUntil > 10 && game.status === 'pre') continue;

    const picks = db.prepare(`
      SELECT id, score, team, pick_type FROM mvp_picks
      WHERE espn_game_id = ? AND pick_type = ? AND LOWER(team) = ? AND result = 'pending'
      ORDER BY score DESC
    `).all(espn_game_id, pick_type, team_key);

    if (picks.length < 2) continue;

    const topScore = picks[0].score;
    const allTied  = picks.every(p => p.score === topScore);

    if (allTied) {
      // All picks share the same score — void every one, no winner
      const note = '*rare push — both picks scored equal (so wild)';
      for (const p of picks) {
        db.prepare(`UPDATE mvp_picks SET result = 'void', annotation = ? WHERE id = ?`).run(note, p.id);
      }
      console.log(`[mvp] Tie conflict game ${espn_game_id} (${pick_type} / ${team_key}): voided ${picks.length} picks`);
    } else {
      // Keep highest; void the rest
      const note = '*had less points — not counted';
      for (const p of picks.slice(1)) {
        db.prepare(`UPDATE mvp_picks SET result = 'void', annotation = ? WHERE id = ?`).run(note, p.id);
      }
      console.log(`[mvp] Conflict game ${espn_game_id} (${pick_type} / ${team_key}): kept ${picks[0].id} (${topScore}pts), voided ${picks.length - 1}`);
    }

    resolved++;
  }

  return resolved;
}

module.exports = { getRecentMvpPicks, getAllTimeRecord, setMvpResult, resolveConflictingMvpPicks };
