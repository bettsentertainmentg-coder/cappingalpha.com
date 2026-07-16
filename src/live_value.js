// src/live_value.js
// Pure live "value pulse" for any pick slot. Computed server-side so the model +
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
//            pick's swings are amplified; a slot with no CA pick still shows the market
//            read, just dampened (never zeroed — a trailing pre-game favorite is a
//            buy-low spot whether or not CA is on it).
//
// LABELS tell the right story per band, and the story has three axes:
//   LEVEL      mild (12-40) / strong (40-70) / deep (70+)
//   DIRECTION  building (trend up) / holding steady (flat) / cooling (down)
//   SITUATION  positive splits on `trailing` (comeback wording only when the
//              pick's side is actually behind); negative splits on where the
//              pick trades versus its lock, which covers totals too
// So a spot that climbed and then leveled off reads "Strong value, holding
// steady", not the same text as one still climbing. Negative side:
//   at/above lock  -> priced up now / pricing up fast / fully priced in
//   below lock     -> value fading (fast) / creeping back / little value left
// Near zero -> fairly priced. Constants tunable on localhost.

const SETTLE_GP   = 0.10;  // the resting baseline fades IN over the first ~10% of the game:
                           // at the start the bet could still be placed at ~its locked price,
                           // so value is even by definition and the pulse opens at ~0
const EMA_ALPHA   = 0.6;   // light smoothing — stays reactive per play
const EMA_FAST    = 0.85;  // catch-up smoothing when the target jumps hard
const EMA_JUMP    = 25;    // |target - prev| beyond this switches to EMA_FAST
const ALIVE_LO    = 0.04;  // at/below this live WP the pick is ~hopeless
const ALIVE_HI    = 0.22;  // at/above this live WP the pick is fully "alive" — a mid-game
                           // deficit (WP ~0.25-0.40) is a buy-low spot, not a dying one
const HOPELESS    = 1.10;  // how hard a hopeless spot pulls the swing negative
const SWING_SCALE = 23;    // how strongly the live buy-low movement moves the value
const DEAD        = 0.08;  // win prob at which the pick is considered dead
const VIABLE_FULL = 0.35;  // win prob at/above which the conviction baseline is fully present
const NEUTRAL     = 12;    // |value| below this reads as "fairly priced"
const STRONG      = 40;    // |value| above this is the strong band
const DEEP        = 70;    // |value| above this is the deep band (rare, big-swing spots)
const TREND_FLAT  = 3;     // |trend| under this reads as steady between polls

// Conviction baseline: a pick's RESTING value from CA score (primary) + pre-game
// favorite-ness + public lean. Positive for strong/favored picks, near zero for weak
// underdogs. This is what a tied/neutral favorite shows, and it breaks the two sides'
// mirror symmetry. Range ~ -4 .. +16.
const BASE_LO = -4, BASE_SPAN = 20;
const W_CA = 0.78, W_FAV = 0.12, W_PUB = 0.10;
// Swing multiplier range: no-conviction slots run ~0.40x, a gold favorite the public
// likes runs ~1.50x. This is the "x CONVICTION" half of the formula above.
const CONV_LO = 0.40, CONV_SPAN = 1.10;

const COLORS = { gold: '#FFD700', slate: '#8892a4', blue: '#3b82f6' };
const clamp  = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const logit  = (p) => { const q = clamp(p, 1e-3, 1 - 1e-3); return Math.log(q / (1 - q)); };
const round1 = (x) => Math.round(x * 10) / 10;

// Conviction score (0..1) from CA (primary) + favorite-ness + public lean.
// CA ramps linearly from 0 (no pick) to full at mvpThreshold+5, so every point of
// display score buys conviction — pass the version-aware tier line (v2: 50, v3: 100
// gold) and the DISPLAY-scale score, never the raw v2 column.
function convScoreOf(caScore, pre, publicPct, mvpThreshold) {
  const caNorm  = clamp((Number(caScore) || 0) / (((mvpThreshold || 50)) + 5), 0, 1);
  const favNorm = clamp(Number(pre) || 0.5, 0, 1);
  const pubNorm = (publicPct == null || isNaN(Number(publicPct))) ? 0.5 : clamp(Number(publicPct), 0, 1);
  return W_CA * caNorm + W_FAV * favNorm + W_PUB * pubNorm;
}

// inputs:
//  pickWP_now    live win prob for the picked side (0..1)
//  pickWP_pre    locked pre-game win prob for the picked side (0..1; falls back to now)
//  caScore       pick's CA score on the DISPLAY scale (primary conviction driver; 0 = no pick)
//  gameProgress  0..1 fraction of regulation elapsed (ramps the resting baseline in over
//                the opening stretch; the swing itself is never progress-damped).
//                null/omitted = unknown progress -> the baseline is NOT suppressed
//  prevMagnitude previous signed value (for EMA + trend); null on first sample
//  mvpThreshold  CA MVP threshold on the same scale as caScore (v2: 50, v3: 100)
//  trailing      is the pick's side BEHIND on the scoreboard? (gates the "comeback" wording)
//  publicPct     share of public tickets on the pick at game start (0..1; optional)
function computeValuePulse({ pickWP_now, pickWP_pre, caScore = 0, gameProgress = null, prevMagnitude = null, mvpThreshold = 50, trailing = false, publicPct = null } = {}) {
  const now  = clamp(Number(pickWP_now) || 0, 0, 1);
  const preN = Number(pickWP_pre);
  const pre  = clamp((preN == null || isNaN(preN)) ? now : preN, 0, 1);

  // 1) Conviction: one blended score drives both the resting baseline and the
  //    swing multiplier. The baseline fades out as the pick dies so a hopeless
  //    favorite does not keep showing resting value — and fades IN over the
  //    opening stretch (SETTLE_GP) so the pulse starts the game at ~0 instead
  //    of jumping straight to the resting conviction read.
  const convScore = convScoreOf(caScore, pre, publicPct, mvpThreshold);
  const baseline  = BASE_LO + BASE_SPAN * convScore;
  const convMult  = CONV_LO + CONV_SPAN * convScore;
  const viability = clamp((now - DEAD) / Math.max(0.05, VIABLE_FULL - DEAD), 0, 1);
  const gpN = Number(gameProgress);
  const settle = (gameProgress == null || !Number.isFinite(gpN)) ? 1 : clamp(gpN / SETTLE_GP, 0, 1);

  // 2) Live buy-low swing: how far the pick sits below its locked price (log-odds),
  //    gated by how alive it still is; a hopeless spot pulls it negative. The gate
  //    only bites near death (WP under ~0.22) — a normal deficit keeps full signal.
  const dz    = logit(pre) - logit(now);                       // >0 when pick is BELOW its locked price
  const alive = clamp((now - ALIVE_LO) / (ALIVE_HI - ALIVE_LO), 0, 1);
  const swing = dz * alive - (1 - alive) * HOPELESS;

  const target = clamp(baseline * viability * settle + swing * SWING_SCALE * convMult, -100, 100);

  const prevN = Number(prevMagnitude);
  const prev = (prevMagnitude == null || isNaN(prevN)) ? target : clamp(prevN, -100, 100);
  // Adaptive smoothing: a pick-six / three-goal-period swing catches up in one
  // poll instead of three; routine movement stays lightly smoothed.
  const alpha = Math.abs(target - prev) > EMA_JUMP ? EMA_FAST : EMA_ALPHA;
  const value = round1(prev + alpha * (target - prev));
  const trend = round1(value - prev);

  let sign, color, label;
  // Direction between polls: the first sample has no prev, so it reads steady.
  const dir = trend >= TREND_FLAT ? 'up' : trend <= -TREND_FLAT ? 'down' : 'flat';
  if (value > NEUTRAL) {
    sign = 1; color = COLORS.gold;
    const head = (value >= DEEP ? 'Deep ' : value >= STRONG ? 'Strong ' : '')
      + (trailing ? 'comeback value' : 'value');
    let text;
    if (value >= STRONG) {
      // Strong/deep: the level leads, the direction rides behind a comma —
      // "it was building, now it's steady and strong" is its own state.
      text = dir === 'up' ? `${head}, still building`
        : dir === 'down' ? `${head}, cooling`
        : `${head}, holding steady`;
    } else {
      text = dir === 'up' ? `${head} building`
        : dir === 'down' ? `${head} cooling`
        : `${head} holding`;
    }
    label = text.charAt(0).toUpperCase() + text.slice(1);
  } else if (value < -NEUTRAL) {
    sign = -1; color = COLORS.blue;
    // Which negative story is this? Trading at/above the lock = the edge is
    // spent (a cruising winner). Below it = the position is dying. Works for
    // totals too, where the scoreboard `trailing` flag never applies.
    if (now >= pre) {
      label = value <= -STRONG ? 'Fully priced in'
        : dir === 'down' ? 'Pricing up fast'
        : 'Priced up now';
    } else {
      label = value <= -STRONG ? 'Little value left'
        : dir === 'up' ? 'Value creeping back'
        : dir === 'down' ? 'Value fading fast'
        : 'Value fading';
    }
  } else {
    sign = 0; color = COLORS.slate; label = 'Fairly priced';
  }

  // `magnitude` is kept as an alias of the signed value so the EMA + history stores
  // (savePulseMag / pushPulseHistory) and existing callers keep working unchanged.
  return { value, magnitude: value, target: round1(target), trend, sign, color, label };
}

module.exports = { computeValuePulse, convScoreOf, COLORS };
