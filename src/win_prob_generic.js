// src/win_prob_generic.js
// Pure, dependency-free live win-probability pieces for the CLOCK sports
// (football / basketball / hockey / soccer). win_prob.js stays the MLB model;
// this module is the generic counterpart used when ESPN's own win probability
// is unavailable (NHL, Soccer) or as a universal fallback.
//
// Same closed-form shape as the MLB model: a scoreDiff / sqrt(time-left)
// logistic, blended in log-odds toward the pre-game market prob with the prior
// fading as the game resolves. Constants are intentionally tunable; calibrate
// against real games (side-by-side with ESPN's graph) before trusting
// magnitudes anywhere user-facing.

const { RE24, sigmoid, logit, clamp } = require('./win_prob');

// Regulation structure per sport. dir 'down' = clock counts toward 0:00 each
// period; 'up' = soccer's cumulative match clock ("45'+2'").
const SPORT_CLOCK = {
  NFL:    { periods: 4, periodSec: 900,  dir: 'down' },
  NCAAF:  { periods: 4, periodSec: 900,  dir: 'down' },   // OT is untimed -> pins at 0.98
  NBA:    { periods: 4, periodSec: 720,  dir: 'down' },
  WNBA:   { periods: 4, periodSec: 600,  dir: 'down' },
  CBB:    { periods: 2, periodSec: 1200, dir: 'down' },
  WCBB:   { periods: 4, periodSec: 600,  dir: 'down' },
  NHL:    { periods: 3, periodSec: 1200, dir: 'down' },   // OT/SO pins at 0.98
  SOCCER: { periods: 2, periodSec: 2700, dir: 'up' },
};

// Homegrown table-WP constants per sport family: z = H + K * scoreDiff / sqrt(tRem).
// H = generic home-edge baseline (log-odds); K = per-point (or per-goal) sensitivity.
const WP_CONST = {
  hockey:     { H: 0.05, K: 0.55 },
  basketball: { H: 0.10, K: 0.13 },
  football:   { H: 0.07, K: 0.09 },
  soccer:     { H: 0.08, K: 0.85 },
};

// Soccer draw model: pDraw = D0 * exp(-D1 * |goalDiff|) * (0.55 + 0.45 * progress).
// Draws get MORE likely as a level match runs out of clock, and collapse fast
// once one side leads by 2+.
const SOCCER_D0 = 0.30;
const SOCCER_D1 = 1.10;

// Per-sport scale for the pace-based over prob (log-odds per point of blended
// total above/below the line). High-scoring sports need a smaller per-point scale.
const OVER_SCALE = {
  baseball: 0.5, hockey: 0.5, soccer: 0.9, basketball: 0.06, football: 0.10,
};

// ── Clock parsing ──────────────────────────────────────────────────────────────
// Defensive: ESPN displayClock arrives as "7:42", "24.7" (sub-minute tenths),
// "0.0", "45'", "45'+2'", "90'+4'", or junk like "Halftime". Returns SECONDS,
// or null when unparseable (callers treat null as "period boundary").
function parseClockSec(clock) {
  const s = String(clock ?? '').trim();
  if (!s) return null;
  // Soccer style: "45'" or "45'+2'" (cumulative match minutes + stoppage)
  const soc = s.match(/^(\d{1,3})'(?:\s*\+\s*(\d{1,2})'?)?$/);
  if (soc) return parseInt(soc[1], 10) * 60 + (soc[2] ? parseInt(soc[2], 10) * 60 : 0);
  // "MM:SS"
  const ms = s.match(/^(\d{1,3}):(\d{2})(?:\.\d+)?$/);
  if (ms) return parseInt(ms[1], 10) * 60 + parseInt(ms[2], 10);
  // "24.7" — under a minute, tenths shown
  const frac = s.match(/^(\d{1,3})(?:\.\d+)?$/);
  if (frac) return parseInt(frac[1], 10);
  return null;
}

// ── Game progress for clock sports ─────────────────────────────────────────────
// Fraction of regulation elapsed, clamped to [0, 0.98] so OT keeps a sliver of
// prior weight (mirrors the MLB extras behavior). Unknown clock inside a period
// reads as "period over" — the safe direction for the anchor fade.
function genericProgress(sport, period, clock) {
  const cfg = SPORT_CLOCK[String(sport || '').toUpperCase()];
  if (!cfg) return 0;
  const total = cfg.periods * cfg.periodSec;
  const p = Math.max(1, parseInt(period, 10) || 1);
  if (p > cfg.periods) return 0.98;                       // OT / SO / extra time period
  const sec = parseClockSec(clock);
  let elapsed;
  if (cfg.dir === 'up') {
    // Soccer: cumulative clock. Stoppage pushes past the nominal period end;
    // clamp so 45'+4' doesn't read as second-half progress.
    elapsed = (sec == null)
      ? p * cfg.periodSec
      : Math.min(clamp(sec, 0, total), p * cfg.periodSec);
  } else {
    const remaining = (sec == null) ? 0 : clamp(sec, 0, cfg.periodSec);
    elapsed = (p - 1) * cfg.periodSec + (cfg.periodSec - remaining);
  }
  return clamp(elapsed / total, 0, 0.98);
}

// ── Homegrown table WP for clock sports ────────────────────────────────────────
// Generic (no team strength) home win prob from score + time alone.
function clockHomeWP(family, homeScore, awayScore, progress) {
  const c = WP_CONST[family] || WP_CONST.basketball;
  const diff = clamp((parseInt(homeScore, 10) || 0) - (parseInt(awayScore, 10) || 0), -50, 50);
  const tRem = Math.max(0.02, 1 - clamp(Number(progress) || 0, 0, 0.98));
  return sigmoid(c.H + c.K * diff / Math.sqrt(tRem));
}

// Anchor a table WP toward the pre-game prob in log-odds, prior fading with
// progress. Identical blend to the MLB model (win_prob.js liveHomeWinProb).
function anchoredWP(tableWP, pregameHomeProb, progress) {
  const preRaw = Number(pregameHomeProb);
  if (pregameHomeProb == null || isNaN(preRaw)) return tableWP;
  const pre = clamp(preRaw, 0.02, 0.98);
  const weight = Math.pow(1 - clamp(Number(progress) || 0, 0, 0.98), 1.5);
  return sigmoid(logit(tableWP) + weight * (logit(pre) - logit(0.5)));
}

// ── Soccer 3-way probabilities ─────────────────────────────────────────────────
// Returns { home, away, draw } summing to ~1. A draw grades ML picks as losses
// on BOTH sides (results.js), so a soccer ML pick's live WP is the outright win
// prob, never 1 - opponent.
// preHome3 = pre-game P(home win) on the 3-way market (may be null).
function soccerProbs({ homeScore, awayScore, progress, preHome3 } = {}) {
  const prog = clamp(Number(progress) || 0, 0, 0.98);
  const gd = clamp((parseInt(homeScore, 10) || 0) - (parseInt(awayScore, 10) || 0), -8, 8);
  const draw = clamp(SOCCER_D0 * Math.exp(-SOCCER_D1 * Math.abs(gd)) * (0.55 + 0.45 * prog), 0.01, 0.60);

  // Two-way share of the non-draw mass, anchored toward the pre-game share.
  const c = WP_CONST.soccer;
  const tRem = Math.max(0.02, 1 - prog);
  const shareNow = sigmoid(c.H + c.K * gd / Math.sqrt(tRem));
  let share = shareNow;
  const pre3 = Number(preHome3);
  if (preHome3 != null && !isNaN(pre3) && pre3 > 0 && pre3 < 1) {
    // Convert the 3-way home prob to a two-way share using the pre-game draw mass.
    const drawPre = clamp(SOCCER_D0 * 0.55, 0.01, 0.60);
    const preShare = clamp(pre3 / (1 - drawPre), 0.02, 0.98);
    share = anchoredWP(shareNow, preShare, prog);
  }
  const home = (1 - draw) * share;
  const away = (1 - draw) * (1 - share);
  return { home, away, draw };
}

// ── Generic pace-based over prob ───────────────────────────────────────────────
// Same shape as the MLB liveOverProb: trust the posted line early, trust the
// scoring pace late. `family` picks the per-point sensitivity.
function genericOverProb(totalPts, line, progress, family) {
  const L = Number(line);
  if (!L || isNaN(L)) return null;
  const prog = clamp(Number(progress) || 0, 0, 1);
  if (prog < 0.12) return 0.5;
  const t = clamp(Number(totalPts) || 0, 0, 400);
  const projected = t / prog;
  const blended = (1 - prog) * L + prog * projected;
  const scale = OVER_SCALE[family] || 0.3;
  return sigmoid(scale * (blended - L));
}

// ── MLB: ESPN win prob + per-pitch count nudge ─────────────────────────────────
// ESPN's MLB win probability updates per plate appearance; the homegrown count
// leverage (same term as win_prob.js B3) is layered on top in log-odds so the
// pulse still twitches per pitch between summary refreshes.
const MLB_B3 = 0.10;
function mlbCountAdjust(homeWP, st) {
  const p = Number(homeWP);
  if (p == null || isNaN(p) || p <= 0 || p >= 1) return homeWP;
  const half = String(st.half || '').toLowerCase().startsWith('b') ? 'bot' : 'top';
  const inning = Math.max(1, parseInt(st.inning, 10) || 1);
  const outs = clamp(parseInt(st.outs, 10) || 0, 0, 2);
  const bases = clamp(parseInt(st.bases, 10) || 0, 0, 7);
  const balls = clamp(parseInt(st.balls, 10) || 0, 0, 3);
  const strikes = clamp(parseInt(st.strikes, 10) || 0, 0, 2);
  const re = (RE24[bases] || RE24[0])[outs] || 0;
  const countBias = (balls / 3) - (strikes / 2);
  const leverage = clamp(re / 1.5, 0.15, 1.2);
  const countEdge = (half === 'bot' ? countBias : -countBias) * leverage;
  const halvesLeft = Math.max(0.5, 18 - ((inning - 1) * 2 + (half === 'bot' ? 1 : 0)));
  return sigmoid(logit(p) + MLB_B3 * countEdge / Math.sqrt(halvesLeft));
}

module.exports = {
  SPORT_CLOCK, WP_CONST, parseClockSec, genericProgress,
  clockHomeWP, anchoredWP, soccerProbs, genericOverProb, mlbCountAdjust,
};
