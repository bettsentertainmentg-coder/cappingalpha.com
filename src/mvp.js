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
  db.prepare(`UPDATE mvp_picks SET result = ?, resolved_at = COALESCE(resolved_at, datetime('now')) WHERE id = ?`).run(result, id);
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
const _type = p => (p.pick_type || '').toLowerCase();
const _line = p => Number(p.spread ?? 0) || 0;

// Void notes name the exact pick that won the points battle and stamp both
// scores as they stood at decision time, so the reason stays true even if a
// displayed score moves later. Every note contains 'not counted' (the record
// queries and the frontend void styling both key on that phrase).
const _label = p => {
  const t = _type(p);
  if (t === 'over' || t === 'under') return `${t === 'over' ? 'Over' : 'Under'} ${p.spread ?? ''}`.trim();
  if (t === 'ml') return `${p.team} ML`;
  const n = _line(p);
  return `${p.team} ${n > 0 ? '+' : ''}${n}`;
};
const noteLess = (winner, loser) => `*not counted: ${_label(winner)} had more points (${winner.score} vs ${loser.score})`;
const noteDup  = (kept, dup)     => `*not counted: same call as ${_label(kept)}, which had more points (${kept.score} vs ${dup.score})`;
const noteTie  = (other, p)      => `*rare push: tied with ${_label(other)} at ${p.score} points, both not counted (so wild)`;

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
  // ── Pregame demotion sweep (Wilson era) ─────────────────────────────────────
  // Ranks and stacks can move all day (new grades, merges, new backers), so a
  // pick tracked at gold can fall back under the line BEFORE its game starts.
  // A gold that never made it to first pitch was never locked: remove the row.
  // Started and graded rows are NEVER touched — membership locks at game start.
  try {
    if (db.getSetting('scoring_version', 'v2') === 'v3') {
      const pendingRows = db.prepare(`
        SELECT m.id, m.espn_game_id, m.team, m.pick_type, m.score, m.spread FROM mvp_picks m
        JOIN today_games tg ON tg.espn_game_id = m.espn_game_id
        WHERE tg.status = 'pre'
          AND (m.result IS NULL OR m.result NOT IN ('win','loss','push','void'))
      `).all();
      const curStmt = db.prepare(`
        SELECT sb.v3_total, sb.v3_json, p.spread AS board_spread FROM picks p
        JOIN score_breakdown sb ON sb.pick_id = p.id
        WHERE p.espn_game_id = ? AND LOWER(p.team) = LOWER(?) AND LOWER(p.pick_type) = LOWER(?)
      `);
      const delStmt  = db.prepare(`DELETE FROM mvp_picks WHERE id = ?`);
      const syncStmt = db.prepare(`UPDATE mvp_picks SET score = ? WHERE id = ?`);
      const lineStmt = db.prepare(`UPDATE mvp_picks SET spread = ? WHERE id = ?`);
      let demoted = 0, synced = 0, linesSynced = 0;
      for (const m of pendingRows) {
        const cur = curStmt.get(m.espn_game_id, m.team || '', m.pick_type || '');
        if (!cur) continue; // board pick gone — leave the tracked row alone
        let isGold = (cur.v3_total ?? 0) >= 100;
        try {
          const j = JSON.parse(cur.v3_json || '{}');
          if (typeof j.gold === 'boolean') isGold = j.gold; // includes the totals gate
        } catch (_) {}
        if (!isGold) { delStmt.run(m.id); demoted++; continue; }
        // Score sync: board-wide rescores (nightly re-rank, new grades, merges)
        // move a pick's true total WITHOUT a new mention, and saveMvpPick only
        // refreshes score on the mention path — so the tracked score drifts.
        // The conflict resolver below compares mvp_picks.score, so drift can
        // void the pick the board shows as HIGHER with a backwards note (the
        // Jul 14 Tsitsipas/Buse tennis void). Track the true total for as long
        // as ESPN still lists the game pregame (the JOIN above). Deliberately
        // NOT clock-gated: tennis start times are "not before" estimates that
        // list EARLY, and the board legitimately moves until the real first
        // serve. The freeze is the status flip to live — the game then leaves
        // this sweep and the last pregame value locks.
        if (cur.v3_total != null && cur.v3_total !== m.score) {
          syncStmt.run(cur.v3_total, m.id);
          synced++;
        }
        // Line sync: the tracked row's display line must mirror the board's —
        // it drifts the same way the score did (stamped once at gold-cross,
        // never refreshed; the T-60 lock used to skip it too). Drifted lines
        // are worse than cosmetic: the conflict/flip passes below compare
        // spreads, and a stale total reads as a legit middle — Jul 15 tracked
        // Over 165.5 AND Under 169.5 on one game exactly this way. Board
        // picks.spread is canonical (seeded 5am, market-refreshed, locked at
        // T-60), one convention on both tables: side handicap for spreads,
        // total line for over/under, odds for ML.
        if (cur.board_spread != null && cur.board_spread !== m.spread) {
          lineStmt.run(cur.board_spread, m.id);
          linesSynced++;
        }
      }
      if (demoted) console.log(`[mvp] pregame demotion sweep removed ${demoted} no-longer-gold row(s)`);
      if (synced)  console.log(`[mvp] pregame score sync refreshed ${synced} tracked row(s)`);
      if (linesSynced) console.log(`[mvp] pregame line sync refreshed ${linesSynced} tracked row(s)`);

      // pick_history rows drift identically (spread stamped at the 50-cross) —
      // keep the pregame archive rows on the board line too, so the public
      // 50+ archive always shows the same number the rankings do.
      try {
        db.prepare(`
          UPDATE pick_history
          SET spread = COALESCE((SELECT p.spread FROM picks p WHERE p.id = pick_history.pick_id), spread)
          WHERE result = 'pending' AND pick_id IS NOT NULL
            AND espn_game_id IN (SELECT espn_game_id FROM today_games WHERE status = 'pre')
        `).run();
      } catch (_) {}

      // ── Promotion sweep: the mirror image ─────────────────────────────────
      // A pick can cross gold through a board-wide rescore (nightly re-rank,
      // merges, engine changes) that never touches storage.savePick — the July
      // 9 tennis golds went untracked exactly this way. Any pregame pick whose
      // CURRENT score is gold and has no mvp_picks row gets tracked here.
      const goldPicks = db.prepare(`
        SELECT p.*, sb.v3_total, sb.v3_json FROM picks p
        JOIN score_breakdown sb ON sb.pick_id = p.id
        JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
        WHERE tg.status = 'pre' AND sb.v3_total >= 100
      `).all();
      let promoted = 0;
      const pendingOnGame = db.prepare(`
        SELECT id, score, team, pick_type, spread FROM mvp_picks
        WHERE espn_game_id = ? AND (result IS NULL OR result NOT IN ('win','loss','push','void'))
      `);
      for (const p of goldPicks) {
        let isGold = true;
        try {
          const j = JSON.parse(p.v3_json || '{}');
          if (typeof j.gold === 'boolean') isGold = j.gold; // totals gate applies
        } catch (_) {}
        if (!isGold) continue;
        const exists = db.prepare(`SELECT id FROM mvp_picks WHERE team = ? AND game_date = ? AND pick_type = ?`)
          .get(p.team, p.game_date, p.pick_type ?? null);
        if (exists) continue;
        // Flip guard: never track a side that is already BEATEN — a conflicting
        // pending row with a strictly higher score owns this game's bet right
        // now. Without this, the flip pass below would delete the row and this
        // sweep would re-insert it every 5 minutes.
        const dim = DIMENSIONS.find(d => d.match(p));
        if (dim && pendingOnGame.all(p.espn_game_id)
            .some(o => dim.match(o) && dim.conflict(o, p) && o.score > (p.v3_total ?? 0))) continue;
        try {
          const { saveMvpPick } = require('./storage'); // lazy: avoids any load-order cycle
          saveMvpPick({
            team: p.team, sport: p.sport, pick_type: p.pick_type, spread: p.spread,
            game_date: p.game_date, espn_game_id: p.espn_game_id, score: p.v3_total,
            cap: p.line_captured_at ? { ml: p.captured_ml, spread: p.captured_spread, total: p.captured_total, ou_odds: p.captured_ou_odds, at: p.line_captured_at } : null,
            scale: 'v3',
          });
          promoted++;
        } catch (err) {
          console.warn('[mvp] promotion insert failed for', p.team, p.pick_type, err.message);
        }
      }
      if (promoted) console.log(`[mvp] promotion sweep tracked ${promoted} rescore-minted gold(s)`);

      // ── Pregame flip (Jack 2026-07-14): the bet follows the leader ────────
      // One tracked bet per game per dimension. If a shift puts the OTHER side
      // strictly ahead while the game is still pregame, the bet flips: the old
      // hypothetical bet is REMOVED from the record (pending pregame rows are
      // never public, /api/mvp hides them) and the new leader rides as its own
      // flat-unit bet — already inserted by the promotion sweep above, priced
      // at the game's T-60 locked line by saveMvpPick. Dead ties ride to the
      // start backstop below (both voided, the existing "rare push"). After
      // the true start nothing moves; the resolver below is the final word.
      const flipRows = db.prepare(`
        SELECT m.id, m.espn_game_id, m.team, m.pick_type, m.spread, m.score FROM mvp_picks m
        JOIN today_games tg ON tg.espn_game_id = m.espn_game_id
        WHERE tg.status = 'pre'
          AND (m.result IS NULL OR m.result NOT IN ('win','loss','push','void'))
      `).all();
      const byGame = new Map();
      for (const r of flipRows) {
        if (!byGame.has(r.espn_game_id)) byGame.set(r.espn_game_id, []);
        byGame.get(r.espn_game_id).push(r);
      }
      let flipped = 0;
      for (const [gid, rows] of byGame) {
        for (const dim of DIMENSIONS) {
          const inDim = rows.filter(dim.match);
          if (inDim.length < 2) continue;
          // Same-call duplicates: keep the oldest row (the original bet stamp).
          const byKey = new Map();
          for (const r of inDim) {
            const k = dim.dedupKey(r);
            const cur = byKey.get(k);
            if (!cur) { byKey.set(k, r); continue; }
            const drop = r.id < cur.id ? cur : r;
            if (r.id < cur.id) byKey.set(k, r);
            delStmt.run(drop.id); flipped++;
          }
          // Conflicts: a strictly higher score owns the bet; beaten sides are
          // removed. Sorted so the leader is kept first.
          const survivors = [...byKey.values()].sort((a, b) => b.score - a.score || a.id - b.id);
          const kept = [];
          for (const r of survivors) {
            const beat = kept.find(k => dim.conflict(k, r) && k.score > r.score);
            if (beat) {
              delStmt.run(r.id); flipped++;
              console.log(`[mvp] pregame flip on ${gid} (${dim.name}): ${beat.team} ${beat.pick_type} (${beat.score}) replaces ${r.team} ${r.pick_type} (${r.score})`);
            } else {
              kept.push(r);
            }
          }
        }
      }
      if (flipped) console.log(`[mvp] pregame flip removed ${flipped} beaten row(s)`);
    }
  } catch (err) {
    console.warn('[mvp] demotion sweep failed:', err.message);
  }

  // Games with more than one non-void MVP pick — necessary condition for a conflict.
  const games = db.prepare(`
    SELECT espn_game_id FROM mvp_picks
    WHERE espn_game_id IS NOT NULL AND result != 'void'
    GROUP BY espn_game_id HAVING COUNT(*) > 1
  `).all();

  if (!games.length) return 0;

  const voidStmt = db.prepare(`UPDATE mvp_picks SET result = 'void', annotation = ?, resolved_at = COALESCE(resolved_at, datetime('now')) WHERE id = ?`);
  let resolved = 0;
  const _void = (note, p) => { voidStmt.run(note, p.id); p.result = 'void'; resolved++; };

  for (const { espn_game_id } of games) {
    const game = db.prepare(`
      SELECT status FROM today_games WHERE espn_game_id = ?
    `).get(espn_game_id);

    // Timing gate: resolve only once ESPN says the game is actually LIVE (or
    // final). Scores move all the way to the true start (late backers keep
    // arriving), so deciding early voids on stale numbers — the Jul 12 Aces ML
    // was voided as the lower pick, then climbed past the kept one before tip.
    // The clock is NOT trusted here: tennis start times are "not before"
    // estimates that list EARLY, so a clock gate fired while the match hadn't
    // begun and the board was still moving (Jul 14 Tsitsipas/Buse — the kept
    // pick's note stamped 147, then the score legitimately reached 175 before
    // first serve). Status flips within one 5-min score cron of the real
    // start. Historical games (no today_games row after the daily wipe) always
    // pass; /api/mvp hides pending pregame rows, so nothing user-visible waits.
    if (game && game.status === 'pre') continue;

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
        for (const dup of group.slice(1)) _void(noteDup(group[0], dup), dup);
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
          _void(noteTie(p, clash), clash);
          _void(noteTie(clash, p), p);
          const i = kept.indexOf(clash); if (i >= 0) kept.splice(i, 1);
          console.log(`[mvp] Opposing tie game ${espn_game_id} (${dim.name}): voided ${clash.id} + ${p.id}`);
        } else {
          _void(noteLess(clash, p), p);
          console.log(`[mvp] Conflict game ${espn_game_id} (${dim.name}): kept ${clash.id} (${clash.score}pts), voided ${p.id} (${p.score}pts)`);
        }
      }
    }
  }

  return resolved;
}

module.exports = { getRecentMvpPicks, getAllTimeRecord, setMvpResult, resolveConflictingMvpPicks };
