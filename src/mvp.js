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

// Resolve conflicting MVP picks for the same game, per betting DIMENSION.
// Two dimensions decide a game: the final MARGIN (moneyline + spread share this)
// and the final TOTAL (over vs under). Picks in different dimensions never
// conflict — a side bet and a total can both hit. Within a dimension two picks
// conflict only when NO final score lets both win:
//   • Knicks Win vs Spurs -5.5 → conflict (Knicks can't win while Spurs win by 6+)
//   • Yankees Win vs Blue Jays +1.5 → NO conflict (Yankees by 1 cashes both)
//   • Over 5.5 vs Under 7.5 → NO conflict (a 6 or 7 total is a legit middle)
// On a real conflict: keep the highest-scored pick, void the lower. Equal scores →
// void both ("rare push"). Same-call duplicates (two cappers, same side) collapse
// to the highest-scored first.
//
// Operates on resolved picks too (not just pending) so already-final games are
// corrected retroactively. The kept pick keeps its result; voided picks get
// result='void' + annotation. results.js never overwrites a voided pick.
// Safe to call on cron — idempotent, no-ops when nothing to resolve.
const NOTE_LESS = '*had less points — not counted';
const NOTE_TIE  = '*rare push — both picks scored equal (so wild)';

const _type = p => (p.pick_type || '').toLowerCase();
const _line = p => Number(p.spread ?? 0) || 0;

// Is there an achievable integer strictly inside the open interval (lo, hi)?
// This answers "does any final score let both picks win?" — if not, they conflict.
function _hasIntegerBetween(lo, hi) {
  return (Math.floor(lo) + 1) <= (Math.ceil(hi) - 1);
}

// Margin-dimension conflict (ML + spread). Let m = picked-team-A's margin.
// A wins when m > -lineA; the OTHER team B wins when m < lineB. ML line = 0; a
// favorite spread is negative (-5.5), an underdog positive (+1.5). Two picks on
// the SAME team never conflict (both ride that team). The check is symmetric.
function _marginConflict(a, b) {
  const ta = (a.team || '').toLowerCase(), tb = (b.team || '').toLowerCase();
  if (ta && tb && ta === tb) return false;
  const lineA = _type(a) === 'ml' ? 0 : _line(a);
  const lineB = _type(b) === 'ml' ? 0 : _line(b);
  return !_hasIntegerBetween(-lineA, lineB);
}

// Total-dimension conflict (over vs under). over X wins when T > X; under Y wins
// when T < Y. Same side (over+over) never conflicts. Over 5.5 / Under 7.5 is a
// legit middle, so it does NOT conflict.
function _totalConflict(a, b) {
  if (_type(a) === _type(b)) return false;
  const over  = _type(a) === 'over'  ? a : b;
  const under = _type(a) === 'under' ? a : b;
  return !_hasIntegerBetween(_line(over), _line(under));
}

const DIMENSIONS = [
  {
    name: 'margin',
    match: p => _type(p) === 'ml' || _type(p) === 'spread',
    // Same team within the same market (two "Knicks -3" posts, or Knicks -3 and
    // Knicks -5) is the same opinion — collapse to the highest-scored.
    dedupKey: p => `${_type(p) === 'ml' ? 'ml' : 'spread'}|${(p.team || '').toLowerCase()}`,
    conflict: _marginConflict,
  },
  {
    name: 'total',
    match: p => _type(p) === 'over' || _type(p) === 'under',
    dedupKey: p => _type(p),
    conflict: _totalConflict,
  },
];

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
  const _void = (note, p) => { voidStmt.run(note, p.id); p.result = 'void'; resolved++; };

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
      SELECT id, score, team, pick_type, spread, result FROM mvp_picks
      WHERE espn_game_id = ? AND result != 'void'
    `).all(espn_game_id);

    for (const dim of DIMENSIONS) {
      const picks = allPicks.filter(dim.match);
      if (picks.length < 2) continue;

      // Phase A — collapse same-call duplicates to the highest-scored survivor.
      const byKey = new Map();
      for (const p of picks) {
        const k = dim.dedupKey(p);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(p);
      }
      const survivors = [];
      for (const group of byKey.values()) {
        group.sort((a, b) => b.score - a.score || a.id - b.id);
        survivors.push(group[0]);
        for (const dup of group.slice(1)) _void(NOTE_LESS, dup);
      }
      if (survivors.length < 2) continue;

      // Phase B — resolve mutual exclusivity. Highest score is the anchor; any pick
      // that can't co-win with a higher kept pick is voided. Equal-score conflicts
      // have no winner — void both ("rare push").
      survivors.sort((a, b) => b.score - a.score || a.id - b.id);
      const kept = [];
      for (const p of survivors) {
        if (p.result === 'void') continue;
        const clash = kept.find(k => k.result !== 'void' && dim.conflict(k, p));
        if (!clash) { kept.push(p); continue; }
        if (clash.score === p.score) {
          _void(NOTE_TIE, clash);
          _void(NOTE_TIE, p);
          const i = kept.indexOf(clash); if (i >= 0) kept.splice(i, 1);
          console.log(`[mvp] Opposing tie game ${espn_game_id} (${dim.name}): voided ${clash.id} + ${p.id}`);
        } else {
          _void(NOTE_LESS, p);
          console.log(`[mvp] Conflict game ${espn_game_id} (${dim.name}): kept ${clash.id} (${clash.score}pts), voided ${p.id} (${p.score}pts)`);
        }
      }
    }
  }

  return resolved;
}

module.exports = { getRecentMvpPicks, getAllTimeRecord, setMvpResult, resolveConflictingMvpPicks };
