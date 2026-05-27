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
    ORDER BY m.saved_at DESC
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

// Resolve conflicting MVP picks for the same game, per mutually-exclusive market.
// Markets: ML (sides = the two teams), spread (sides = the two teams),
// total (sides = over vs under). Within a side, multiple cappers posting the same
// call are duplicates → keep the highest-scored, void the rest. Across opposing
// sides of a market (e.g. Knicks Win vs Cavaliers Win), only one can hit → keep
// the higher-scored side, void the lower. Equal top scores on opposing sides →
// void all ("rare push"). Picks in different markets (e.g. ML vs Over) never conflict.
//
// Operates on resolved picks too (not just pending) so already-final games are
// corrected retroactively. The kept pick keeps its result; voided picks get
// result='void' + annotation. results.js never overwrites a voided pick.
// Safe to call on cron — idempotent, no-ops when nothing to resolve.
const NOTE_LESS = '*had less points — not counted';
const NOTE_TIE  = '*rare push — both picks scored equal (so wild)';

const CONFLICT_MARKETS = {
  ml:     p => (p.pick_type || '').toLowerCase() === 'ml',
  spread: p => (p.pick_type || '').toLowerCase() === 'spread',
  total:  p => ['over', 'under'].includes((p.pick_type || '').toLowerCase()),
};

// A pick's side within a market: team for ML/spread, over/under for totals.
function _sideOf(pick, market) {
  return market === 'total'
    ? (pick.pick_type || '').toLowerCase()
    : (pick.team || '').toLowerCase();
}

function resolveConflictingMvpPicks() {
  // Games with more than one non-void MVP pick — necessary condition for a conflict.
  const games = db.prepare(`
    SELECT espn_game_id FROM mvp_picks
    WHERE espn_game_id IS NOT NULL AND result != 'void'
    GROUP BY espn_game_id HAVING COUNT(*) > 1
  `).all();

  if (!games.length) return 0;

  const voidStmt = db.prepare(`UPDATE mvp_picks SET result = 'void', annotation = ? WHERE id = ?`);
  let resolved = 0;

  for (const { espn_game_id } of games) {
    const game = db.prepare(`
      SELECT start_time, status FROM today_games WHERE espn_game_id = ?
    `).get(espn_game_id);

    // Timing gate applies only to pre-game today's games: wait until ~10 min before
    // start so all cappers' picks are in. Final/live games and historical games
    // (no today_games row after the daily wipe) always pass.
    if (game && game.status === 'pre') {
      const minsUntil = (new Date(game.start_time).getTime() - Date.now()) / 60000;
      if (minsUntil > 10) continue;
    }

    const allPicks = db.prepare(`
      SELECT id, score, team, pick_type, result FROM mvp_picks
      WHERE espn_game_id = ? AND result != 'void'
    `).all(espn_game_id);

    for (const [market, matchFn] of Object.entries(CONFLICT_MARKETS)) {
      const picks = allPicks.filter(matchFn);
      if (picks.length < 2) continue;

      // Phase A — collapse each side to its highest-scored survivor; void same-side dupes.
      const bySide = new Map();
      for (const p of picks) {
        const side = _sideOf(p, market);
        if (!bySide.has(side)) bySide.set(side, []);
        bySide.get(side).push(p);
      }
      const survivors = [];
      for (const group of bySide.values()) {
        group.sort((a, b) => b.score - a.score);
        survivors.push(group[0]);
        for (const dup of group.slice(1)) { voidStmt.run(NOTE_LESS, dup.id); resolved++; }
      }

      // Phase B — resolve across opposing sides (a market has at most two sides).
      if (survivors.length < 2) continue;
      survivors.sort((a, b) => b.score - a.score);
      const top      = survivors[0].score;
      const topCount = survivors.filter(s => s.score === top).length;

      if (topCount > 1) {
        // Equal top scores on opposing sides — no winner, void all survivors.
        for (const s of survivors) { voidStmt.run(NOTE_TIE, s.id); resolved++; }
        console.log(`[mvp] Opposing tie game ${espn_game_id} (${market}): voided ${survivors.length}`);
      } else {
        // Unique higher side wins; void the opposing lower side(s).
        for (const s of survivors.slice(1)) { voidStmt.run(NOTE_LESS, s.id); resolved++; }
        console.log(`[mvp] Opposing conflict game ${espn_game_id} (${market}): kept ${survivors[0].id} (${top}pts), voided ${survivors.length - 1}`);
      }
    }
  }

  return resolved;
}

module.exports = { getRecentMvpPicks, getAllTimeRecord, setMvpResult, resolveConflictingMvpPicks };
