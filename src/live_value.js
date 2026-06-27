// src/live_value.js
// Pure live "value pulse" for a held CA pick. Honest buy-low read, computed
// server-side so the model + CA weighting never ship to non-paid clients.
//
// Signal (non-circular): our anchored live win prob (win_prob.js) still rates the
// pick highly WHILE the scoreboard has knocked it down from where it locked, with
// game left. Peaks when a believed-in pick is down but alive; ~0 when cruising
// (nothing to recover) or hopeless (no resilience) or late (no game left).
//
//   trailing   = max(0, pickWP_pre - pickWP_now)   // how far the scoreboard knocked us
//   resilience = pickWP_now                        // still believable?
//   buyLow     = trailing * resilience
//   value      = buyLow * convictionWeight * progressDamp   (then scaled + EMA-smoothed)
//
// CA conviction is a SMALL, deliberately un-surfaced nudge. No market-vs-line leg
// in v1 (free in-game odds are too stale to trust). Constants are tunable on
// localhost before any magnitude goes user-facing.

const SCALE     = 3.5;    // map raw buy-low (~0..0.3) onto a 0..1 bar
const EMA_ALPHA  = 0.4;   // smoothing across ~12s polls (3-4 samples settle)
const DEAD_BAND  = 0.10;  // below this reads as "steady"
const STRONG     = 0.30;  // strong band threshold
const TREND_EPS  = 0.012; // min change to call it rising/falling vs holding
const CA_K       = 0.25;  // small hidden conviction nudge

const COLORS = { gold: '#FFD700', slate: '#8892a4', blue: '#3b82f6' };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round3 = (x) => Math.round(x * 1000) / 1000;

// inputs:
//  pickWP_now   live win prob for the picked side (0..1)
//  pickWP_pre   pre-game win prob for the picked side (0..1; falls back to now)
//  caScore      pick's CA score (small hidden weight)
//  gameProgress 0..1 fraction of regulation elapsed
//  prevMagnitude previous EMA magnitude (for smoothing + trend); null on first sample
//  mvpThreshold CA MVP threshold (default 50)
function computeValuePulse({ pickWP_now, pickWP_pre, caScore = 0, gameProgress = 0, prevMagnitude = null, mvpThreshold = 50 } = {}) {
  const now = clamp(Number(pickWP_now) || 0, 0, 1);
  const preN = Number(pickWP_pre);
  const pre = clamp((preN == null || isNaN(preN)) ? now : preN, 0, 1);
  const gp  = clamp(Number(gameProgress) || 0, 0, 1);

  const trailing   = Math.max(0, pre - now);
  const resilience = now;
  const buyLow     = trailing * resilience;                 // 0 when cruising or hopeless
  const Cw          = clamp(1 + CA_K * ((Number(caScore) || 0) / (mvpThreshold || 50) - 1), 0.85, 1.25);
  const progressDamp = Math.pow(1 - gp, 0.75);              // less game left = less opportunity
  const target = clamp(buyLow * Cw * progressDamp * SCALE, 0, 1);

  const prevN = Number(prevMagnitude);
  const prev = (prevMagnitude == null || isNaN(prevN)) ? target : clamp(prevN, 0, 1);
  const magnitude = prev + EMA_ALPHA * (target - prev);
  const trend = magnitude - prev;

  let band, sign, color, label;
  if (magnitude < DEAD_BAND) {
    band = 'steady'; sign = 0; color = COLORS.slate; label = 'Steady';
  } else if (trend < -TREND_EPS) {
    band = magnitude >= STRONG ? 'fading-strong' : 'fading'; sign = -1; color = COLORS.blue;
    label = 'Value fading';
  } else if (trend > TREND_EPS) {
    band = magnitude >= STRONG ? 'building-strong' : 'building'; sign = 1; color = COLORS.gold;
    label = magnitude >= STRONG ? 'Strong comeback value' : 'Comeback value building';
  } else {
    band = 'holding'; sign = 1; color = COLORS.gold; label = 'Value holding';
  }

  return { magnitude: round3(magnitude), target: round3(target), trend: round3(trend), band, sign, color, label };
}

module.exports = { computeValuePulse, COLORS };
