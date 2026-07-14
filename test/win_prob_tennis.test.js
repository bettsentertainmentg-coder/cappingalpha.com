// test/win_prob_tennis.test.js — run: node test/win_prob_tennis.test.js
// Sanity + shape tests for the tennis live win-prob model. The model is
// anchored to the pre-game market and must behave monotonically along every
// axis (sets, games, serve, prior). Magnitude spot checks are loose bands —
// calibration constants may move them, the ordering must not.
const assert = require('node:assert');
const {
  tennisMatchWP, tennisProgress, tennisOverProb, tennisGamesPlayed, tennisTrailing,
  perSetProb, matchFromSets, setWinProb, gameProbsFor, bestOfFor,
} = require('../src/win_prob_tennis');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const st = (sets, status = 'in', serving = null) => {
  let h = 0, a = 0;
  for (const s of sets) { if (s.winner === 'home') h++; else if (s.winner === 'away') a++; }
  return { status, sets, homeScore: h, awayScore: a, serving };
};

// ── Per-set strength from the match prior ─────────────────────────────────────
ok(Math.abs(perSetProb(0.5, 3) - 0.5) < 0.001, 'even match -> even sets');
const s70 = perSetProb(0.7, 3);
ok(s70 > 0.6 && s70 < 0.67, '70% match favorite -> ~63% per set');
ok(perSetProb(0.7, 5) < s70, 'best-of-5 needs less per-set edge for the same match prob');
ok(Math.abs(matchFromSets(2, 2, s70) - 0.7) < 0.005, 'inversion round-trips');

// ── Set tree ───────────────────────────────────────────────────────────────────
const even = gameProbsFor(0.5, 'ATP');
ok(Math.abs(setWinProb(0, 0, null, even.pServe, even.pReturn, even.pTB) - 0.5) < 0.005, 'even set from scratch is a coin');
const up31 = setWinProb(3, 1, null, even.pServe, even.pReturn, even.pTB);
ok(up31 > 0.72 && up31 < 0.95, 'a break up mid-set is a strong set lead');
ok(setWinProb(5, 1, null, even.pServe, even.pReturn, even.pTB) > up31, 'deeper lead, higher set prob');
ok(setWinProb(3, 1, 'home', even.pServe, even.pReturn, even.pTB) >
   setWinProb(3, 1, 'away', even.pServe, even.pReturn, even.pTB), 'serving next helps');
ok(setWinProb(6, 4, null, even.pServe, even.pReturn, even.pTB) === 1, 'completed set is terminal');
const atp = gameProbsFor(0.5, 'ATP'), wta = gameProbsFor(0.5, 'WTA');
ok(atp.pServe > wta.pServe, 'ATP holds serve more often than WTA');

// ── Match WP ───────────────────────────────────────────────────────────────────
const s0 = st([{ home: 0, away: 0, winner: null }]);
ok(Math.abs(tennisMatchWP(s0, 0.5, 'ATP') - 0.5) < 0.005, 'even match opens at 50%');
ok(Math.abs(tennisMatchWP(s0, 0.7, 'ATP') - 0.7) < 0.01, 'model opens at the market prior');

const oneSetUp = st([{ home: 6, away: 4, winner: 'home' }, { home: 0, away: 0, winner: null }]);
const w1 = tennisMatchWP(oneSetUp, 0.5, 'ATP');
ok(w1 > 0.72 && w1 < 0.86, 'a set up in an even bo3 is ~75-85% (ladder + games evidence)');

// A just-finished set with no new set row must not double count.
const justFinished = st([{ home: 6, away: 4, winner: 'home' }]);
ok(Math.abs(tennisMatchWP(justFinished, 0.5, 'ATP') - w1) < 0.005, 'set-break state equals fresh-set state');

const upBreak = st([{ home: 4, away: 2, winner: null }]);
const wUp = tennisMatchWP(upBreak, 0.5, 'ATP');
ok(wUp > 0.55 && wUp < 0.80, 'a break up in set one lifts the match prob');
ok(tennisMatchWP(upBreak, 0.7, 'ATP') > wUp, 'prior still counts mid-match');

const downBad = st([{ home: 1, away: 6, winner: 'away' }, { home: 1, away: 5, winner: null }]);
ok(tennisMatchWP(downBad, 0.5, 'ATP') < 0.06, 'set and double break down is near dead');

ok(tennisMatchWP(st([{ home: 6, away: 3, winner: 'home' }, { home: 6, away: 4, winner: 'home' }], 'post'), 0.5, 'ATP') === 1, 'won match pins at 1');
ok(tennisMatchWP(st([{ home: 3, away: 6, winner: 'away' }], 'post'), 0.5, 'ATP') === null, 'retirement mid-match has no read');

// ── Best-of detection ──────────────────────────────────────────────────────────
ok(bestOfFor(s0) === 3, 'default is best-of-3');
ok(bestOfFor(st([
  { home: 6, away: 4, winner: 'home' }, { home: 6, away: 4, winner: 'home' }, { home: 2, away: 3, winner: null },
])) === 5, 'two sets up and still live must be best-of-5');
ok(bestOfFor(st([
  { home: 6, away: 4, winner: 'home' }, { home: 4, away: 6, winner: 'away' },
  { home: 6, away: 4, winner: 'home' }, { home: 1, away: 1, winner: null },
])) === 5, 'a fourth set means best-of-5');

// In-match skill update: a heavy pre-game underdog who has hung dead level for
// two sets is no longer a heavy underdog. Without the update, the fixed prior
// re-priced this near zero for the decider.
const decider = st([
  { home: 6, away: 4, winner: 'home' }, { home: 4, away: 6, winner: 'away' }, { home: 0, away: 0, winner: null },
]);
const dogWP = tennisMatchWP(decider, 0.08, 'ATP');
ok(dogWP > 0.12 && dogWP < 0.45, 'level-through-two heavy dog rehabilitates meaningfully');
ok(dogWP < tennisMatchWP(decider, 0.5, 'ATP'), 'the prior still matters after the update');
const cruise = st([{ home: 6, away: 1, winner: 'home' }, { home: 2, away: 0, winner: null }]);
ok(tennisMatchWP(cruise, 0.5, 'ATP') > 0.85, 'dominant games flow lifts the leader beyond the raw ladder');

// The replay-step trap: a reconstructed "after set 3" step of a FINISHED bo3
// carries 2 banked sets with status 'in', which the ladder heuristic reads as a
// live bo5. The bestOf override must pin it back to the real format.
const replayStep = st([
  { home: 4, away: 6, winner: 'away' }, { home: 6, away: 3, winner: 'home' }, { home: 6, away: 4, winner: 'home' },
]);
ok(tennisMatchWP(replayStep, 0.7, 'ATP') < 1, 'without the override the heuristic reads bo5');
ok(tennisMatchWP(replayStep, 0.7, 'ATP', 3) === 1, 'bestOf override pins the finished bo3 at 1');

// ── Progress / games / trailing ────────────────────────────────────────────────
ok(tennisProgress(s0) < 0.05, 'match start is ~0 progress');
ok(tennisProgress(oneSetUp) > 0.3 && tennisProgress(oneSetUp) < 0.6, 'a set banked is mid progress');
ok(tennisProgress(st([], 'post')) === 1, 'finished match is full progress');
ok(tennisGamesPlayed(st([{ home: 7, away: 6, winner: 'home' }, { home: 3, away: 2, winner: null }])) === 18, 'tiebreak set counts 13 games');
ok(tennisTrailing(st([{ home: 1, away: 6, winner: 'away' }, { home: 3, away: 3, winner: null }]), true) === true, 'a set down trails');
ok(tennisTrailing(st([{ home: 2, away: 4, winner: null }]), true) === true, 'games down in a level-set match trails');
ok(tennisTrailing(st([{ home: 2, away: 4, winner: null }]), false) === false, 'the side ahead never trails');
ok(tennisTrailing(s0, true) === false, 'level match trails nobody');

// ── Over prob ──────────────────────────────────────────────────────────────────
const line = 22.5;
ok(Math.abs(tennisOverProb(s0, line, 0.5, 'ATP', 0.5) - 0.5) < 0.01, 'over prob opens at the market prior');
ok(Math.abs(tennisOverProb(s0, line, 0.5, 'ATP', 0.58) - 0.58) < 0.01, 'juice lean carries through at the open');
const sweep = st([{ home: 6, away: 1, winner: 'home' }, { home: 5, away: 0, winner: null }], 'in');
ok(tennisOverProb(sweep, line, 0.5, 'ATP', 0.5) < 0.3, 'a fast sweep points under');
const grind = st([{ home: 7, away: 6, winner: 'home' }, { home: 5, away: 6, winner: null }], 'in');
ok(tennisOverProb(grind, line, 0.5, 'ATP', 0.5) > 0.75, 'two long sets point over');
// The bimodal spot: a set banked, level in the 2nd — the over needs a 3rd set,
// so this must read close to a coin, never expectation-hot.
const split = st([{ home: 6, away: 4, winner: 'home' }, { home: 2, away: 2, winner: null }], 'in');
const splitOP = tennisOverProb(split, line, 0.5, 'ATP', 0.5);
ok(splitOP > 0.40 && splitOP < 0.68, 'set-and-level spot reads near the third-set coin');
ok(tennisOverProb(st([{ home: 6, away: 4, winner: 'home' }, { home: 6, away: 4, winner: 'home' }], 'post'), 22.5, 0.5, 'ATP') === 0.01, 'finished under is ~0');
ok(tennisOverProb(st([{ home: 7, away: 6, winner: 'home' }, { home: 6, away: 7, winner: 'away' }, { home: 6, away: 4, winner: 'home' }], 'post'), 22.5, 0.5, 'ATP') === 0.99, 'finished over is ~1');
ok(tennisOverProb(s0, null, 0.5, 'ATP') === null, 'no line, no read');

// A lopsided prior expects a shorter match -> same live state leans under more.
const evenOP = tennisOverProb(oneSetUp, line, 0.5, 'ATP', 0.5);
const favOP  = tennisOverProb(oneSetUp, line, 0.85, 'ATP', 0.5);
ok(favOP < evenOP, 'heavy favorite cruising points under vs an even match');

// Bounds.
for (const v of [w1, wUp, evenOP, favOP]) ok(v > 0 && v < 1, 'probs stay inside (0, 1)');

console.log(`win_prob_tennis.test.js: ${n} assertions passed`);
