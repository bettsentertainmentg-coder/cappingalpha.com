// src/ledger_regrade.js
// Restatement pass for capper ledger grades minted at the wrong line.
//
// THE BUG (found 2026-09-10 by Jack, on the NE/SEA game of 2026-09-09):
// results.evaluatePick resolved a pick's line as
//   line_snapshots.original_spread ?? captured_* ?? live_* ?? the row's own
// and the snapshot lookup only needs an espn_game_id + team, which a
// capper_history row has. So every source capper's spread and total was graded
// at the CA's OWN locked line instead of the number that capper actually
// quoted. Seattle beat New England by exactly 3, the CA line was 3, and all
// 146 spread rows on the game came back PUSH: the +4.5 and +3.5 bettors (real
// winners), the -3.5 and -2.5 bettors (a real loser and a real winner), all of
// them. Totals were the same story against the game's 44.5, which is how a
// 21.5 "under" on a 23-point game graded as a WIN.
//
// 1,687 grades across 473 cappers were wrong at the time of the fix, 813 of
// them outright win/loss flips. capper_ratings (the Wilson ladder that decides
// what every pick is worth) is materialized from exactly these rows, so this
// is not a display repair.
//
// The fix is the ownLine flag in results.evaluatePick. This module restates the
// history the old path wrote. It supplies inputs only: no grading logic lives
// here, every verdict comes back through evaluatePick with ownLine set, so the
// postponed / phantom-final / tennis guards all still apply.
//
// Idempotent: it writes only rows whose correct result differs from the stored
// one, so a second run over the same window reports zero changes.
// ML rows are deliberately untouched — a moneyline carries no line, so this bug
// could never have reached one, and anything wrong there is a different repair.

const db = require('./db');
const { evaluatePick, fetchGameResult } = require('./results');
const { implausibleLine } = require('./audit');

const LINE_MARKETS = ['spread', 'over', 'under', 'set_spread'];
// markets:'all' adds moneylines. A moneyline carries no line, so the wrong-line
// bug could never reach one — but a grade written before a guard existed can
// still be wrong, and 7 tennis matches held rows graded win AND loss on the
// same side, with impossible pushes among them (2026-09-17).
const ALL_MARKETS = [...LINE_MARKETS, 'ml', 'set_ml'];

// Every game holding at least one settled ledger row that carries a line.
function candidateGames({ since, until, sports, markets = 'lines' }) {
  const mk = markets === 'all' ? ALL_MARKETS : LINE_MARKETS;
  const params = [since, until];
  let sportFilter = '';
  if (Array.isArray(sports) && sports.length) {
    sportFilter = ` AND UPPER(COALESCE(sport,'')) IN (${sports.map(() => '?').join(',')})`;
    params.push(...sports.map(s => String(s).toUpperCase()));
  }
  return db.prepare(`
    SELECT espn_game_id, MAX(sport) AS sport, MIN(game_date) AS game_date, COUNT(*) AS rows_n
    FROM capper_history
    WHERE result IN ('win','loss','push')
      AND espn_game_id IS NOT NULL
      ${markets === 'all' ? '' : 'AND spread IS NOT NULL'}
      AND game_date >= ? AND game_date <= ?
      AND LOWER(COALESCE(pick_type,'')) IN (${mk.map(() => '?').join(',')})
      ${sportFilter}
    GROUP BY espn_game_id
    ORDER BY game_date DESC, espn_game_id DESC
  `).all(...params.slice(0, 2), ...mk, ...params.slice(2));
}

// The final for one game: the live board row while it is still there (free),
// else ESPN. fetchGameResult already refuses anything that is not truly final,
// so a postponed or suspended event returns null and its rows are left alone.
async function truthFor(game, cache) {
  const key = String(game.espn_game_id);
  if (cache.has(key)) return cache.get(key);
  let truth = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ? AND status = 'post'`)
                .get(game.espn_game_id) || null;
  if (!truth) truth = await fetchGameResult(game.espn_game_id, game.sport, game.game_date);
  cache.set(key, truth);
  return truth;
}

async function regradeLedger({
  since = '2026-01-01', until = '2099-12-31', dryRun = true,
  maxGames = 400, sports = null, gameIds = null, markets = 'lines',
} = {}) {
  const started = new Date().toISOString();
  const MARKETS = markets === 'all' ? ALL_MARKETS : LINE_MARKETS;
  let games = candidateGames({ since, until, sports, markets });
  if (Array.isArray(gameIds) && gameIds.length) {
    const want = new Set(gameIds.map(String));
    games = games.filter(g => want.has(String(g.espn_game_id)));
  }
  const candidates = games.length;
  const truncated = candidates > maxGames;
  if (truncated) games = games.slice(0, maxGames);

  const cache = new Map();
  const changes = [];
  let unresolved = 0, undecided = 0, examined = 0, rowsChecked = 0, implausible = 0;
  let oldestExamined = null;

  const rowsFor = db.prepare(`
    SELECT * FROM capper_history
    WHERE espn_game_id = ? AND result IN ('win','loss','push')
      ${markets === 'all' ? '' : 'AND spread IS NOT NULL'}
      AND LOWER(COALESCE(pick_type,'')) IN (${MARKETS.map(() => '?').join(',')})
  `);
  const upd = db.prepare(`UPDATE capper_history SET result = ? WHERE id = ?`);

  for (const g of games) {
    const truth = await truthFor(g, cache);
    if (!truth) { unresolved++; continue; }
    examined++;
    if (!oldestExamined || (g.game_date && g.game_date < oldestExamined)) oldestExamined = g.game_date;

    const game = { ...truth, status: 'post', sport: truth.sport || g.sport };
    for (const row of rowsFor.all(g.espn_game_id, ...MARKETS)) {
      rowsChecked++;
      // A row whose quoted number cannot be a full-game line for its sport is a
      // team total, a prop, or a wrong-game match (R14). Regrading it at that
      // number just relabels bad data, so leave it exactly as it is and let the
      // audit flag carry it to a human.
      if (implausibleLine(row)) { implausible++; continue; }
      const next = evaluatePick(row, { ...game, sport: game.sport || row.sport }, { ownLine: true });
      // 'pending' means the evaluator could not decide and 'void' is a
      // different repair (a replaced tennis player, an unplayed game). Neither
      // is a reason to overwrite a grade that already stands.
      if (!['win', 'loss', 'push'].includes(next)) { undecided++; continue; }
      if (next === row.result) continue;
      changes.push({
        id: row.id, capper: row.capper_name, source: row.source, sport: row.sport,
        game_date: row.game_date, espn_game_id: row.espn_game_id, team: row.team,
        pick_type: row.pick_type, line: row.spread, from: row.result, to: next,
        final: `${truth.away_score}-${truth.home_score}`,
      });
      if (!dryRun) upd.run(next, row.id);
    }
  }

  const byCapper = {};
  const byShape  = {};
  for (const c of changes) {
    byCapper[c.capper] = (byCapper[c.capper] || 0) + 1;
    const k = `${c.from}->${c.to}`;
    byShape[k] = (byShape[k] || 0) + 1;
  }
  const flips = changes.filter(c =>
    (c.from === 'win' && c.to === 'loss') || (c.from === 'loss' && c.to === 'win')).length;

  return {
    started, since, until, dry_run: dryRun, markets,
    games_candidate: candidates,
    games_examined: examined,
    games_unresolved: unresolved,
    oldest_examined: oldestExamined,
    truncated,
    rows_checked: rowsChecked,
    rows_undecided: undecided,
    rows_implausible_skipped: implausible,
    rows_changed: changes.length,
    win_loss_flips: flips,
    cappers_affected: Object.keys(byCapper).length,
    by_shape: byShape,
    top_cappers: Object.entries(byCapper).sort((a, b) => b[1] - a[1]).slice(0, 20),
    changes,
  };
}

module.exports = { regradeLedger };
