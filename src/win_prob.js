// src/win_prob.js
// Pure, dependency-free live win-probability model for MLB (v1 of the live tracker).
//
// Closed-form ANCHORED LOGISTIC: a generic game-state win prob (score + inning +
// base/out state) blended in log-odds toward the PRE-GAME market prob, with the
// prior fading as the game resolves. No paid data, no DB, no external calls.
//
// The scoreDiff / sqrt(time-left) term is the heart of every closed-form win-prob
// model. The base/out state adds a small "who is threatening now" nudge via RE24.
// Constants at the top are intentionally tunable; calibrate against real games on
// localhost before trusting magnitudes anywhere user-facing.

const B0 = 0.08;   // slight generic home-field baseline (log-odds)
const B1 = 1.10;   // run-differential sensitivity
const B2 = 0.15;   // small bottom-inning (home batting) nudge

// Run expectancy by base state (bitmask 1=1st, 2=2nd, 4=3rd) and outs (0,1,2).
// League-average-ish RE24 (expected runs remaining this inning). Used only as a
// small adjustment, not a precise simulator.
const RE24 = {
  0: [0.50, 0.27, 0.10], // empty
  1: [0.86, 0.52, 0.22], // 1st
  2: [1.10, 0.66, 0.32], // 2nd
  3: [1.44, 0.88, 0.42], // 1st+2nd
  4: [1.35, 0.95, 0.37], // 3rd
  5: [1.78, 1.14, 0.48], // 1st+3rd
  6: [1.96, 1.36, 0.58], // 2nd+3rd
  7: [2.29, 1.54, 0.75], // loaded
};

const clamp   = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit   = (p) => { const q = clamp(p, 1e-4, 1 - 1e-4); return Math.log(q / (1 - q)); };

function normHalf(half) {
  const h = String(half || '').toLowerCase();
  return (h.startsWith('b') || h.includes('bot')) ? 'bot' : 'top';
}

// Fraction of regulation elapsed, clamped to [0, 0.98] so extras keep a sliver of
// prior weight and (1 - gp) ^ k stays real.
function gameProgress(st) {
  const inning = Math.max(1, parseInt(st.inning, 10) || 1);
  const half   = normHalf(st.half);
  const outs   = clamp(parseInt(st.outs, 10) || 0, 0, 3);
  const outsElapsed = (inning - 1) * 6 + (half === 'bot' ? 3 : 0) + outs;
  return clamp(outsElapsed / 54, 0, 0.98);
}

// Generic (no team-strength) home win prob from the current game state alone.
function tableHomeWP(st) {
  const half      = normHalf(st.half);
  const inning    = Math.max(1, parseInt(st.inning, 10) || 1);
  const outs      = clamp(parseInt(st.outs, 10) || 0, 0, 2);
  const bases     = clamp(parseInt(st.bases, 10) || 0, 0, 7);
  const scoreDiff = clamp((parseInt(st.homeScore, 10) || 0) - (parseInt(st.awayScore, 10) || 0), -11, 11);
  const re         = (RE24[bases] || RE24[0])[outs] || 0;
  const inningEdge = half === 'bot' ? re : -re;          // batting team gets the RE nudge
  const halvesLeft = Math.max(0.5, 18 - ((inning - 1) * 2 + (half === 'bot' ? 1 : 0)));
  const z = B0 + B1 * (scoreDiff + inningEdge) / Math.sqrt(halvesLeft) + B2 * (half === 'bot' ? 1 : 0);
  return sigmoid(z);
}

// Anchored home win prob: blend the generic table WP toward the pre-game prob in
// log-odds, with the prior fading as the game resolves. At first pitch this is
// ~= pregameHomeProb; by the final out the scoreboard dominates.
function liveHomeWinProb(st, pregameHomeProb) {
  const table = tableHomeWP(st);
  const preRaw = Number(pregameHomeProb);
  if (preRaw == null || isNaN(preRaw)) return table;       // no prior -> generic model
  const pre = clamp(preRaw, 0.02, 0.98);
  const weight = Math.pow(1 - gameProgress(st), 1.5);
  return sigmoid(logit(table) + weight * (logit(pre) - logit(0.5)));
}

// Win prob oriented to a side ('home' | 'away').
function liveWinProb(st, pregameHomeProb, side = 'home') {
  const home = liveHomeWinProb(st, pregameHomeProb);
  return side === 'away' ? 1 - home : home;
}

// Live P(over) for a totals pick: trust the posted line early (little info), trust
// the run-scoring pace late. A crude but honest live read, not a precise model.
// totalRuns = runs scored so far, line = the O/U number, gp = gameProgress (0..1).
function liveOverProb(totalRuns, line, gp) {
  const L = Number(line);
  if (!L || isNaN(L)) return null;
  const prog = clamp(Number(gp) || 0, 0, 1);
  if (prog < 0.12) return 0.5;                        // too early to read pace
  const t = clamp(Number(totalRuns) || 0, 0, 60);
  const projected = t / prog;                         // pace projection of the final total
  const blended = (1 - prog) * L + prog * projected;  // line-anchored early, pace-driven late
  return sigmoid(0.5 * (blended - L));
}

module.exports = { liveWinProb, liveHomeWinProb, liveOverProb, tableHomeWP, gameProgress, RE24, sigmoid, logit, clamp };
