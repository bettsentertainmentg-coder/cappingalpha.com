// src/live_value.js
// Pure live "value pulse" for a held CA pick. Computed server-side so the model +
// conviction weighting never ship to non-paid clients.
//
// Output is a SIGNED value in [-100, +100] = (live buy-low SWING) x (CONVICTION):
//
//   swing  = how far the pick now sits BELOW its locked price, in log-odds, gated by
//            how alive it still is. + when the pick is down but alive (a buy-low spot),
//            - when it is priced up (winning) or fading toward hopeless. Full
//            sensitivity (no game-progress damping) — early plays move it as much as late.
//
//   conv   = a per-pick conviction multiplier (~0.40..1.50) that BREAKS the two sides'
//            mirror symmetry: CA score (primary) blended with the pre-game line /
//            favorite status and the public's opinion at game start. A high-conviction
//            pick's swings are amplified; a low-conviction pick's are dampened.
//
// The "comeback" wording is reserved for picks that are ACTUALLY TRAILING on the
// scoreboard (passed in as `trailing`). A tied or leading pick never reads "comeback";
// it shows its line/conviction value as "value holding". Constants tunable on localhost.

const EMA_ALPHA   = 0.6;   // light smoothing — stays reactive per play
const EMA_FAST    = 0.85;  // catch-up smoothing when the target jumps hard
const EMA_JUMP    = 25;    // |target - prev| beyond this switches to EMA_FAST
const ALIVE_LO    = 0.10;  // at/below this live WP the pick is ~hopeless
const ALIVE_HI    = 0.50;  // at/above this live WP the pick is fully "alive"
const HOPELESS    = 1.10;  // how hard a hopeless spot pulls the swing negative
const SWING_SCALE = 23;    // how strongly the live buy-low movement moves the value
const DEAD        = 0.08;  // win prob at which the pick is considered dead
const VIABLE_FULL = 0.35;  // win prob at/above which the conviction baseline is fully present
const NEUTRAL     = 12;    // |value| below this reads as "holding"
const STRONG      = 40;    // |value| above this is the strong band

// Conviction baseline: a pick's RESTING value from CA score (primary) + pre-game
// favorite-ness + public lean. Positive for strong/favored picks, near zero for weak
// underdogs. This is what a tied/neutral favorite shows, and it breaks the two sides'
// mirror symmetry. Range ~ -4 .. +16.
const BASE_LO = -4, BASE_SPAN = 20;
const W_CA = 0.78, W_FAV = 0.12, W_PUB = 0.10;

const COLORS = { gold: '#FFD700', slate: '#8892a4', blue: '#3b82f6' };
const clamp  = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const logit  = (p) => { const q = clamp(p, 1e-3, 1 - 1e-3); return Math.log(q / (1 - q)); };
const round1 = (x) => Math.round(x * 10) / 10;

// Conviction score (0..1) from CA (primary) + favorite-ness + public lean.
function convScoreOf(caScore, pre, publicPct, mvpThreshold) {
  const caNorm  = clamp(((Number(caScore) || 0) - ((mvpThreshold || 50) - 20)) / 25, 0, 1); // CA(mvp-20)->0, CA(mvp+5)->1
  const favNorm = clamp(Number(pre) || 0.5, 0, 1);
  const pubNorm = (publicPct == null || isNaN(Number(publicPct))) ? 0.5 : clamp(Number(publicPct), 0, 1);
  return W_CA * caNorm + W_FAV * favNorm + W_PUB * pubNorm;
}

// inputs:
//  pickWP_now    live win prob for the picked side (0..1)
//  pickWP_pre    locked pre-game win prob for the picked side (0..1; falls back to now)
//  caScore       pick's CA score (primary conviction driver)
//  gameProgress  0..1 fraction of regulation elapsed (kept for callers; not damped now)
//  prevMagnitude previous signed value (for EMA + trend); null on first sample
//  mvpThreshold  CA MVP threshold (default 50)
//  trailing      is the pick's side BEHIND on the scoreboard? (gates the "comeback" wording)
//  publicPct     share of public tickets on the pick at game start (0..1; optional)
function computeValuePulse({ pickWP_now, pickWP_pre, caScore = 0, gameProgress = 0, prevMagnitude = null, mvpThreshold = 50, trailing = false, publicPct = null } = {}) {
  const now  = clamp(Number(pickWP_now) || 0, 0, 1);
  const preN = Number(pickWP_pre);
  const pre  = clamp((preN == null || isNaN(preN)) ? now : preN, 0, 1);

  // 1) Conviction baseline (CA + line + public), faded out as the pick dies so a
  //    hopeless favorite does not keep showing resting value.
  const baseline  = BASE_LO + BASE_SPAN * convScoreOf(caScore, pre, publicPct, mvpThreshold);
  const viability = clamp((now - DEAD) / Math.max(0.05, VIABLE_FULL - DEAD), 0, 1);

  // 2) Live buy-low swing: how far the pick sits below its locked price (log-odds),
  //    gated by how alive it still is; a hopeless spot pulls it negative.
  const dz    = logit(pre) - logit(now);                       // >0 when pick is BELOW its locked price
  const alive = clamp((now - ALIVE_LO) / (ALIVE_HI - ALIVE_LO), 0, 1);
  const swing = dz * alive - (1 - alive) * HOPELESS;

  const target = clamp(baseline * viability + swing * SWING_SCALE, -100, 100);

  const prevN = Number(prevMagnitude);
  const prev = (prevMagnitude == null || isNaN(prevN)) ? target : clamp(prevN, -100, 100);
  // Adaptive smoothing: a pick-six / three-goal-period swing catches up in one
  // poll instead of three; routine movement stays lightly smoothed.
  const alpha = Math.abs(target - prev) > EMA_JUMP ? EMA_FAST : EMA_ALPHA;
  const value = round1(prev + alpha * (target - prev));
  const trend = round1(value - prev);

  let sign, color, label;
  if (value > NEUTRAL) {
    sign = 1; color = COLORS.gold;
    if (trailing) label = value >= STRONG ? 'Strong comeback value' : 'Comeback value building';
    else          label = value >= STRONG ? 'Strong value'         : 'Value holding';
  } else if (value < -NEUTRAL) {
    sign = -1; color = COLORS.blue;
    label = value <= -STRONG ? 'Little value here' : 'Value fading';
  } else {
    sign = 0; color = COLORS.slate; label = 'Value holding';
  }

  // `magnitude` is kept as an alias of the signed value so the EMA + history stores
  // (savePulseMag / pushPulseHistory) and existing callers keep working unchanged.
  return { value, magnitude: value, target: round1(target), trend, sign, color, label };
}

module.exports = { computeValuePulse, convScoreOf, COLORS };
