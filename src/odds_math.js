// src/odds_math.js — single source of truth for American-odds payout.
//
// There were three near-identical payout functions that disagreed on the missing-
// odds default: leaderboard.js / utils.js defaulted -115; admin.js defaulted -110.
// This unifies the server side. Decision on the conflict:
//   - VOTES keep -115 (their graded history was scored at -115; don't re-grade it).
//     leaderboard.voteReturn passes an explicit odds in, so it keeps its -115 branch.
//   - MANUAL user_bets default -110 (users enter real odds and rarely leave them
//     blank; -110 is the standard convention when one is missing).
// admin.js keeps its own pickProfit on purpose (it has a deliberate over/under -115
// vs spread -110 split for capper P/L that we must not alter).

// Net profit on a 1-unit (or `stake`) WIN at American `odds`. Missing/NaN -> -110.
function americanProfit(odds, stake = 1) {
  const o = (odds == null || isNaN(parseFloat(odds))) ? -110 : parseFloat(odds);
  return o < 0 ? stake * (100 / Math.abs(o)) : stake * (o / 100);
}

// Signed profit for a settled bet: +win profit, -stake on loss, 0 on push/void/pending.
function settledProfit(result, odds, stake = 1) {
  const r = (result || '').toLowerCase();
  if (r === 'win')  return +americanProfit(odds, stake).toFixed(4);
  if (r === 'loss') return -stake;
  return 0; // push | void | pending
}

module.exports = { americanProfit, settledProfit };
