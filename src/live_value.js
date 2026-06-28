// src/live_value.js
// Pure live "value pulse" for a held CA pick. Honest buy-low read, computed
// server-side so the model + CA weighting never ship to non-paid clients.
//
// Output is a SIGNED value in [-100, +100] that twitches with the game:
//   + (toward gold)  = comeback / buy-low value — the pick is BELOW its locked price
//                      but our live model still gives it a real shot.
//   ~0 (slate)       = the pick is roughly where it locked; no edge either way.
//   - (toward blue)  = low value — the pick is priced UP from where it locked (you
//                      missed the value) or it is fading toward hopeless.
//
//   dz    = logit(now) - logit(pre)        // live read vs locked price (log-odds)
//   alive = ramp(now)                      // still believable? kills hopeless spots
//   raw   = (-dz)*alive - (1-alive)*HOPELESS, progress-damped on the positive side
//   value = clamp(raw * SCALE, -100, 100), lightly EMA-smoothed (stays volatile)
//
// CA conviction is a SMALL, deliberately un-surfaced nudge. No market-vs-line leg in
// v1 (free in-game odds are too stale). Constants are tunable on localhost.

const SCALE     = 55;     // map raw signed buy-low onto ~[-100, 100]
const EMA_ALPHA  = 0.6;   // light smoothing — keep it reactive per play
const ALIVE_LO   = 0.10;  // at/below this live WP the pick is ~hopeless
const ALIVE_HI   = 0.50;  // at/above this live WP the pick is fully "alive"
const HOPELESS   = 0.60;  // how negative a hopeless spot reads (pre-scale)
const CA_K       = 0.25;  // small hidden conviction nudge
const NEUTRAL    = 12;    // |value| below this reads as "holding"
const STRONG     = 40;    // |value| above this is the strong band

const COLORS = { gold: '#FFD700', slate: '#8892a4', blue: '#3b82f6' };
const clamp  = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const logit  = (p) => { const q = clamp(p, 1e-3, 1 - 1e-3); return Math.log(q / (1 - q)); };
const round1 = (x) => Math.round(x * 10) / 10;

// inputs:
//  pickWP_now    live win prob for the picked side (0..1)
//  pickWP_pre    locked pre-game win prob for the picked side (0..1; falls back to now)
//  caScore       pick's CA score (small hidden weight)
//  gameProgress  0..1 fraction of regulation elapsed
//  prevMagnitude previous signed value (for EMA + trend); null on first sample
//  mvpThreshold  CA MVP threshold (default 50)
function computeValuePulse({ pickWP_now, pickWP_pre, caScore = 0, gameProgress = 0, prevMagnitude = null, mvpThreshold = 50 } = {}) {
  const now  = clamp(Number(pickWP_now) || 0, 0, 1);
  const preN = Number(pickWP_pre);
  const pre  = clamp((preN == null || isNaN(preN)) ? now : preN, 0, 1);
  const gp   = clamp(Number(gameProgress) || 0, 0, 1);

  const dz    = logit(now) - logit(pre);                       // <0 worse than locked, >0 better
  const alive = clamp((now - ALIVE_LO) / (ALIVE_HI - ALIVE_LO), 0, 1);
  let raw = (-dz) * alive - (1 - alive) * HOPELESS;            // behind+alive -> +, ahead -> -, hopeless -> -
  if (raw > 0) raw *= (0.40 + 0.60 * (1 - gp));               // late comeback value is worth less
  const Cw = clamp(1 + CA_K * ((Number(caScore) || 0) / (mvpThreshold || 50) - 1), 0.85, 1.25);
  raw *= Cw;

  const target = clamp(raw * SCALE, -100, 100);

  const prevN = Number(prevMagnitude);
  const prev = (prevMagnitude == null || isNaN(prevN)) ? target : clamp(prevN, -100, 100);
  const value = round1(prev + EMA_ALPHA * (target - prev));
  const trend = round1(value - prev);

  let sign, color, label;
  if (value > NEUTRAL) {
    sign = 1; color = COLORS.gold;
    label = value >= STRONG ? 'Strong comeback value' : 'Comeback value building';
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

module.exports = { computeValuePulse, COLORS };
