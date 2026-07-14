// src/win_prob_tennis.js
// Pure live win-probability pieces for tennis (ATP/WTA) — the score-ladder
// counterpart to win_prob.js (MLB) and win_prob_generic.js (clock sports).
// Tennis has no clock, so everything derives from the set/game ladder:
//
//   pre-game match prob  ->  per-set strength s (invert the best-of formula)
//                        ->  per-game serve/return edge d (invert the set tree)
//   games already played ->  bounded skill update on d (a heavy favorite who
//                            keeps getting broken is not just unlucky)
//   live state           ->  P(win current set) from the exact game tree
//                        ->  P(win match) from the best-of set recursion
//
// Same philosophy as the other models: closed-form-ish, tunable constants,
// anchored to the pre-game market so the model opens AT the market and drifts
// with what actually happens on court. Tested in test/win_prob_tennis.test.js.

const { sigmoid, logit, clamp } = require('./win_prob');

// Average service-hold rate by tour — sets the serve/return asymmetry of the
// game tree. WTA breaks far more often, so a break there means less.
const HOLD_BASE = { ATP: 0.76, WTA: 0.64 };
const HOLD_DEFAULT = 0.70;

// Tiebreak edge per point of per-game skill shift d: a TB is close to a coin
// flip, tilted by the better player's edge.
const TB_EDGE = 1.15;

// ── Small solvers ──────────────────────────────────────────────────────────────
// f is monotone increasing on [lo, hi]; find x with f(x) = target.
function bisect(f, target, lo, hi, iters = 30) {
  let a = lo, b = hi;
  for (let i = 0; i < iters; i++) {
    const m = (a + b) / 2;
    if (f(m) < target) a = m; else b = m;
  }
  return (a + b) / 2;
}

// ── Best-of set recursion ──────────────────────────────────────────────────────
// P(home wins the match) needing i sets while away needs j, per-set prob s.
function matchFromSets(i, j, s) {
  if (i <= 0) return 1;
  if (j <= 0) return 0;
  return s * matchFromSets(i - 1, j, s) + (1 - s) * matchFromSets(i, j - 1, s);
}

// Expected number of sets still to be played from (i, j) sets needed.
function expSetsLeft(i, j, s) {
  if (i <= 0 || j <= 0) return 0;
  return 1 + s * expSetsLeft(i - 1, j, s) + (1 - s) * expSetsLeft(i, j - 1, s);
}

// Per-set prob s from a pre-game MATCH prob (invert matchFromSets from scratch).
function perSetProb(matchProb, bestOf) {
  const N = bestOf === 5 ? 3 : 2;
  const M = clamp(Number(matchProb) || 0.5, 0.03, 0.97);
  return bisect((s) => matchFromSets(N, N, s), M, 0.02, 0.98);
}

// ── Set game tree ──────────────────────────────────────────────────────────────
// Exact set-win prob from (games home, games away, server) given the per-game
// serve/return probs. Terminals: 6+ with a 2-game lead, 7 (won the tiebreak),
// 6-6 collapses to the TB coin. Live super-tiebreak "sets" (10-8 style) are
// clamped into the 0..7 ladder — a rough read is fine for that rare display.
function setTree(gh, ga, srvHome, pServe, pReturn, pTB) {
  const h = clamp(Math.round(gh) || 0, 0, 7), a = clamp(Math.round(ga) || 0, 0, 7);
  if (h >= 6 && h - a >= 2) return 1;
  if (a >= 6 && a - h >= 2) return 0;
  if (h === 7) return 1;
  if (a === 7) return 0;
  if (h === 6 && a === 6) return pTB;
  const pGame = srvHome ? pServe : pReturn;
  return pGame * setTree(h + 1, a, !srvHome, pServe, pReturn, pTB)
    + (1 - pGame) * setTree(h, a + 1, !srvHome, pServe, pReturn, pTB);
}

// Joint distribution over how a set finishes from (gh, ga, server): a list of
// { g, hw, p } — g additional games played, hw 1/0 home won, prob p. The 6-6
// tiebreak is one more game (a 7-6 set is 13 games). State space is tiny.
function setDist(gh, ga, srvHome, pServe, pReturn, pTB, memo = new Map()) {
  const h = clamp(Math.round(gh) || 0, 0, 7), a = clamp(Math.round(ga) || 0, 0, 7);
  if ((h >= 6 && h - a >= 2) || h === 7) return [{ g: 0, hw: 1, p: 1 }];
  if ((a >= 6 && a - h >= 2) || a === 7) return [{ g: 0, hw: 0, p: 1 }];
  if (h === 6 && a === 6) return [{ g: 1, hw: 1, p: pTB }, { g: 1, hw: 0, p: 1 - pTB }];
  const key = h * 16 + a * 2 + (srvHome ? 1 : 0);
  const hit = memo.get(key);
  if (hit) return hit;
  const pGame = srvHome ? pServe : pReturn;
  const merged = new Map();
  const add = (g, hw, p) => { const k = g * 2 + hw; merged.set(k, (merged.get(k) || 0) + p); };
  for (const o of setDist(h + 1, a, !srvHome, pServe, pReturn, pTB, memo)) add(o.g + 1, o.hw, o.p * pGame);
  for (const o of setDist(h, a + 1, !srvHome, pServe, pReturn, pTB, memo)) add(o.g + 1, o.hw, o.p * (1 - pGame));
  const out = [...merged.entries()].map(([k, p]) => ({ g: k >> 1, hw: k & 1, p }));
  memo.set(key, out);
  return out;
}

// Serve-aware wrappers: serving 'home' | 'away' | null (unknown = average both).
function setDistFrom(gh, ga, serving, pServe, pReturn, pTB) {
  const memo = new Map();
  if (serving === 'home') return setDist(gh, ga, true, pServe, pReturn, pTB, memo);
  if (serving === 'away') return setDist(gh, ga, false, pServe, pReturn, pTB, memo);
  const merged = new Map();
  for (const side of [true, false]) {
    for (const o of setDist(gh, ga, side, pServe, pReturn, pTB, memo)) {
      const k = o.g * 2 + o.hw;
      merged.set(k, (merged.get(k) || 0) + o.p / 2);
    }
  }
  return [...merged.entries()].map(([k, p]) => ({ g: k >> 1, hw: k & 1, p }));
}
function setWinProb(gh, ga, serving, pServe, pReturn, pTB) {
  let s = 0;
  for (const o of setDistFrom(gh, ga, serving, pServe, pReturn, pTB)) if (o.hw) s += o.p;
  return s;
}

// Per-game skill shift d for a target per-set prob s: home wins a service game
// with hold + d and a return game with (1 - hold) + d; solve d so the from-
// scratch set prob (server unknown) lands on s.
function probsAtD(d, tour) {
  const hold = HOLD_BASE[String(tour || '').toUpperCase()] ?? HOLD_DEFAULT;
  return {
    pServe:  clamp(hold + d, 0.05, 0.97),
    pReturn: clamp(1 - hold + d, 0.03, 0.95),
    pTB:     clamp(0.5 + TB_EDGE * d, 0.05, 0.95),
    d,
  };
}
function gameProbsFor(s, tour) {
  const d = bisect((x) => {
    const p = probsAtD(x, tour);
    return setWinProb(0, 0, null, p.pServe, p.pReturn, p.pTB);
  }, clamp(s, 0.03, 0.97), -0.6, 0.6, 26);
  return probsAtD(d, tour);
}

// In-match skill update. A fixed prior thinks a -2000 favorite dropping a set
// merely got unlucky and re-prices the dog near zero; the games already played
// are real evidence about today's skill gap. The per-game edge d equals
// (home game share - 0.5) by construction (serve + return probs average to
// 0.5 + d), so blend the prior d with the observed share, data weighted
// n / (n + N0) — about two and a half sets of prior weight. Returns the game
// probs at the blended edge plus sLive, the per-set prob to run the ladder at.
const SKILL_N0 = 24;
// The update scales with how extreme the prior is: for even-ish matches the
// set ladder alone is already well calibrated (pre-match odds encode skill),
// so the games evidence would double count what the ladder banked; for a
// lopsided prior the fixed-skill assumption is what produces the absurd
// re-pricing, so the evidence gets full weight there.
const SKILL_EXT_LO = 0.25, SKILL_EXT_K = 6.0;
function liveGameProbs(state, sPrior, tour) {
  const prior = gameProbsFor(sPrior, tour);
  const sets = Array.isArray(state?.sets) ? state.sets : [];
  let gH = 0, n = 0;
  for (const st of sets) {
    const h = parseInt(st.home, 10) || 0, a = parseInt(st.away, 10) || 0;
    gH += h; n += h + a;
  }
  if (n < 6) return { ...prior, sLive: clamp(sPrior, 0.03, 0.97) };
  const extremity = clamp(SKILL_EXT_LO + SKILL_EXT_K * Math.abs(prior.d), SKILL_EXT_LO, 1);
  const w = (n / (n + SKILL_N0)) * extremity;
  const dObs = clamp(gH / n, 0.08, 0.92) - 0.5;
  const probs = probsAtD((1 - w) * prior.d + w * dObs, tour);
  const sLive = setWinProb(0, 0, null, probs.pServe, probs.pReturn, probs.pTB);
  return { ...probs, sLive };
}

// ── State readers ──────────────────────────────────────────────────────────────
// state = the live_state.js tennis shape: { status, sets: [{home, away, winner}],
// homeScore/awayScore (completed sets won), serving }.
function completedSets(state) {
  return {
    home: parseInt(state?.homeScore, 10) || 0,
    away: parseInt(state?.awayScore, 10) || 0,
  };
}

// The set currently being played: the last set WITHOUT a winner. A just-finished
// set (winner stamped, next set not on the board yet) must not double count —
// it's already in homeScore/awayScore, so the current set is a fresh 0-0.
function currentSet(state) {
  const sets = Array.isArray(state?.sets) ? state.sets : [];
  const last = sets[sets.length - 1];
  if (last && last.winner == null) {
    return { home: parseInt(last.home, 10) || 0, away: parseInt(last.away, 10) || 0 };
  }
  return { home: 0, away: 0 };
}

// Best-of from the live ladder. ESPN's tennis format block reads periods: 5 on
// every match (even WTA), so it can't be trusted — infer from the sets instead:
// only a best-of-5 can show a player with 2 completed sets while still live, or
// a 4th set at all. Early best-of-5 reads as best-of-3 (close enough pre-split).
function bestOfFor(state) {
  const { home, away } = completedSets(state);
  const nSets = (Array.isArray(state?.sets) ? state.sets.length : 0);
  if (nSets >= 4) return 5;
  if (state?.status === 'in' && (home >= 2 || away >= 2)) return 5;
  return 3;
}

// Total games on the board (the total-games O/U counts every game, TB sets = 13).
function tennisGamesPlayed(state) {
  const sets = Array.isArray(state?.sets) ? state.sets : [];
  let t = 0;
  for (const st of sets) t += (parseInt(st.home, 10) || 0) + (parseInt(st.away, 10) || 0);
  return t;
}

// Is the picked side behind? Sets first; games in the current set break a tie.
// Gates the "comeback" wording the same way the scoreboard does elsewhere.
function tennisTrailing(state, pickIsHome) {
  const { home, away } = completedSets(state);
  if (home !== away) return pickIsHome ? home < away : away < home;
  const cur = currentSet(state);
  if (cur.home !== cur.away) return pickIsHome ? cur.home < cur.away : cur.away < cur.home;
  return false;
}

// ── Live match win prob ────────────────────────────────────────────────────────
// P(home wins the match) from the live ladder, anchored to the pre-game match
// prob via the per-set strength (the prior fades naturally as sets bank).
// `bestOfKnown` overrides the ladder inference — replay callers know the real
// format, and a reconstructed mid-match step (2 sets banked, status 'in') would
// otherwise misread a finished best-of-3 as a live best-of-5.
function tennisMatchWP(state, pregameHomeProb, tour, bestOfKnown = null) {
  const bestOf = (bestOfKnown === 3 || bestOfKnown === 5) ? bestOfKnown : bestOfFor(state);
  const need = bestOf === 5 ? 3 : 2;
  const { home, away } = completedSets(state);
  const needH = need - home, needA = need - away;
  if (needH <= 0) return 1;
  if (needA <= 0) return 0;
  if (state?.status === 'post') return null;   // no set majority on a finished match — walkover/retirement; no read

  const sPrior = perSetProb(pregameHomeProb == null ? 0.5 : pregameHomeProb, bestOf);
  const { pServe, pReturn, pTB, sLive } = liveGameProbs(state, sPrior, tour);
  const cur = currentSet(state);
  const pCur = setWinProb(cur.home, cur.away, state?.serving ?? null, pServe, pReturn, pTB);
  return pCur * matchFromSets(needH - 1, needA, sLive)
    + (1 - pCur) * matchFromSets(needH, needA - 1, sLive);
}

// ── Match progress 0..1 ────────────────────────────────────────────────────────
// Sets banked plus the current set's fraction, over the expected set count for
// the format (a neutral read — used for anchor fades and history labeling, so
// precision beyond "how deep are we" isn't needed).
function tennisProgress(state, bestOfKnown = null) {
  if (state?.status === 'post') return 1;
  const bestOf = (bestOfKnown === 3 || bestOfKnown === 5) ? bestOfKnown : bestOfFor(state);
  const need = bestOf === 5 ? 3 : 2;
  const { home, away } = completedSets(state);
  const expSets = expSetsLeft(need, need, 0.5);
  const cur = currentSet(state);
  const curFrac = Math.min((cur.home + cur.away) / 10, 0.95);
  return clamp((home + away + curFrac) / expSets, 0, 0.98);
}

// ── Total-games over prob ──────────────────────────────────────────────────────
// P(total games finish over `line`), from the exact outcome DISTRIBUTION, not
// an expectation — tennis totals are bimodal (a straight-set match and a
// distance match sit on opposite sides of the line), so a mean + sigmoid
// overcommits. Walk: current set's joint (games, winner) distribution, then
// convolve fresh-set length distributions over every possible remaining set
// count. Anchored to the market's pre-game over prob (juice de-vig) in
// log-odds, prior fading as the match runs out of road.
function tennisOverProb(state, line, pregameHomeProb, tour, preOverProb = null, bestOfKnown = null) {
  const L = Number(line);
  if (!L || isNaN(L)) return null;
  const played = tennisGamesPlayed(state);

  const bestOf = (bestOfKnown === 3 || bestOfKnown === 5) ? bestOfKnown : bestOfFor(state);
  const need = bestOf === 5 ? 3 : 2;
  const { home, away } = completedSets(state);
  const needH = need - home, needA = need - away;
  if (state?.status === 'post' || needH <= 0 || needA <= 0) {
    return played > L ? 0.99 : 0.01;
  }

  const sPrior = perSetProb(pregameHomeProb == null ? 0.5 : pregameHomeProb, bestOf);
  const { pServe, pReturn, pTB, sLive } = liveGameProbs(state, sPrior, tour);
  const s = sLive;
  const cur = currentSet(state);
  const curDist = setDistFrom(cur.home, cur.away, state?.serving ?? null, pServe, pReturn, pTB);

  // Length distribution of a fresh set (marginal over winner), as {games: prob}.
  const fresh = {};
  for (const o of setDistFrom(0, 0, null, pServe, pReturn, pTB)) {
    fresh[o.g] = (fresh[o.g] || 0) + o.p;
  }
  // convPow[k] = games distribution of k fresh sets. Max future sets = need*2 - 2.
  const convPow = [{ 0: 1 }];
  for (let k = 1; k <= need * 2 - 2; k++) {
    const prev = convPow[k - 1], next = {};
    for (const gp in prev) for (const gf in fresh) {
      const g = Number(gp) + Number(gf);
      next[g] = (next[g] || 0) + prev[gp] * fresh[gf];
    }
    convPow.push(next);
  }
  // P(k more sets are played | i, j sets still needed), winners i.i.d. at s.
  function setsCountDist(i, j) {
    if (i <= 0 || j <= 0) return { 0: 1 };
    const out = {};
    for (const [d, w] of [[setsCountDist(i - 1, j), s], [setsCountDist(i, j - 1), 1 - s]]) {
      for (const k in d) out[Number(k) + 1] = (out[Number(k) + 1] || 0) + d[k] * w;
    }
    return out;
  }

  // Total the mass that finishes over the line.
  let pOver = 0;
  for (const o of curDist) {
    const afterCur = played + o.g;
    const counts = o.hw ? setsCountDist(needH - 1, needA) : setsCountDist(needH, needA - 1);
    for (const k in counts) {
      const dist = convPow[Math.min(Number(k), convPow.length - 1)];
      let tail = 0;
      for (const g in dist) if (afterCur + Number(g) > L) tail += dist[g];
      pOver += o.p * counts[k] * tail;
    }
  }
  pOver = clamp(pOver, 0.01, 0.99);

  // Blend toward the market's pre-game over prob in log-odds; the market knows
  // these players' pace better than a generic tree, so it dominates early.
  const preN = Number(preOverProb);
  if (preOverProb != null && !isNaN(preN) && preN > 0 && preN < 1) {
    const w = Math.pow(1 - tennisProgress(state), 1.2);
    return clamp(sigmoid(w * logit(preN) + (1 - w) * logit(pOver)), 0.01, 0.99);
  }
  return pOver;
}

module.exports = {
  tennisMatchWP, tennisProgress, tennisOverProb, tennisGamesPlayed, tennisTrailing,
  // internals exported for tests/calibration
  perSetProb, matchFromSets, expSetsLeft, setWinProb, gameProbsFor, liveGameProbs, bestOfFor,
};
