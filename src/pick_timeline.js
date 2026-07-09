// src/pick_timeline.js
// Builds the stock-chart-style score-over-time series behind the "conviction
// curve" on the game detail page.
//
// TWO ERAS, keyed off the scoring_version setting:
//  - v3 (live): the curve is the v3 aggregation stepping up over time — base,
//    advocate resume, consensus, market, sport bonus, fade — and it ENDS on the
//    exact leak-aware display score the picks list shows, so the curve and the
//    big number never disagree. The true v3 total is never revealed: a pick mid
//    leak-ramp is scaled down to its display score.
//  - v2 (legacy): the old channel-points replay (kept so nothing breaks if a
//    deploy ever runs on v2).

const db = require('./db');
const { CHANNEL_POINTS } = require('./scoring');

const SPORT_BONUS_SPORTS  = new Set(['NBA', 'CBB', 'MLB', 'NFL', 'NCAAF', 'NHL', 'ATP', 'WTA', 'GOLF']);
const NO_HOME_BONUS_SPORTS = new Set(['ATP', 'WTA', 'GOLF']);

function parseDbTs(s) {
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// ── v3: replay the real aggregation, end on the display score ──────────────────
function buildV3Timeline(pick) {
  const { v3DisplayScore } = require('./scoring_v3');
  const sb = db.prepare(`SELECT v3_total, v3_json FROM score_breakdown WHERE pick_id = ?`).get(pick.id) || {};
  const displayScore = v3DisplayScore({ ...pick, v3_total: sb.v3_total });
  if (!displayScore || displayScore <= 0) return [];

  const mentions = db.prepare(`
    SELECT message_timestamp FROM raw_messages WHERE pick_id = ? ORDER BY message_timestamp ASC, id ASC
  `).all(pick.id);
  const firstMs = parseDbTs(mentions[0]?.message_timestamp) ?? parseDbTs(pick.parsed_at) ?? Date.now();

  // Window end = 3 min before game start (leak rule finishes there), else +30 min.
  const game = pick.espn_game_id
    ? db.prepare(`SELECT start_time FROM today_games WHERE espn_game_id = ?`).get(pick.espn_game_id)
    : null;
  const startMs = parseDbTs(game?.start_time);
  const endMs = (startMs && startMs > firstMs) ? startMs - 3 * 60 * 1000 : firstMs + 30 * 60 * 1000;
  const span = Math.max(60 * 1000, endMs - firstMs);

  let bd = null;
  try { bd = sb.v3_json ? JSON.parse(sb.v3_json) : null; } catch (_) {}

  // Ordered, positive-only component steps in the order the score is built.
  // Wilson era: the best backer's ladder points open the curve (base is 0 and
  // omitted); pre-rescore rows may still carry a positive base and keep it.
  const base = bd?.base ?? 0;
  const steps = [];
  if (base > 0) steps.push({ label: 'Base', pts: base });
  if (bd) {
    if (bd.resume > 0)          steps.push({ label: bd.advocate ? `Backer · ${bd.advocate}` : 'Backer', pts: bd.resume });
    if (bd.consensus > 0)       steps.push({ label: 'Backer stack', pts: bd.consensus });
    if ((bd.sport_pct?.pts ?? 0) > 0) steps.push({ label: 'Sport rank', pts: bd.sport_pct.pts });
    if ((bd.market?.pts ?? 0) > 0) steps.push({ label: 'Market', pts: bd.market.pts });
    if ((bd.lean?.pts ?? 0) > 0)   steps.push({ label: 'Side lean', pts: bd.lean.pts });
    if ((bd.sport_bonus ?? 0) > 0) steps.push({ label: 'Sport', pts: bd.sport_bonus });
    if ((bd.fade_in?.pts ?? 0) > 0) steps.push({ label: 'Fade', pts: bd.fade_in.pts });
    if ((bd.conflict_offset ?? 0) > 0) steps.push({ label: 'Offset', pts: bd.conflict_offset });
  }
  const trueTotal = steps.reduce((s, e) => s + e.pts, 0);
  const opening = steps[0]?.pts ?? 0; // the pre-ramp level: Base (legacy) or the best backer

  // THE SAME REVEAL PATH THE BIG NUMBER WALKED (Jack 2026-07-08): when the pick
  // has ramp state, replay the seeded chunk schedule — identical times and sizes
  // to what effectiveDisplayScore showed members — so the curve and the number
  // are one story. Each chunk is labeled by the component whose cumulative range
  // covers it (Resume, Consensus, ...), keeping the paid annotations meaningful.
  // This runs BEFORE the degenerate guard: early in a ramp the display sits at or
  // below the true base, and that is exactly when the replay matters most.
  const rampStartMs = parseDbTs(pick.leak_started_at);
  if (pick.leak_target != null && rampStartMs && pick.leak_window_sec) {
    const { leakSchedule } = require('./scoring_v3');
    const shownBase = pick.display_score ?? 0;
    const sched = leakSchedule(pick);
    if (sched.length) {
      // Component boundaries in cumulative-points space (above the true base),
      // scaled onto the ramp's gap so labels track the chunk that reveals them.
      const gap = pick.leak_target - shownBase;
      const compScale = gap / Math.max(1, trueTotal - opening);
      let cumComp = 0;
      const bounds = steps.slice(1).map(st => {
        cumComp += st.pts;
        return { upto: cumComp * compScale, label: st.label };
      });
      const labelFor = (cum) => (bounds.find(b => cum <= b.upto + 0.5) || bounds[bounds.length - 1] || { label: 'Aggregate' }).label;
      const events = [{ ts: new Date(Math.min(firstMs, rampStartMs)).toISOString(), delta: shownBase, label: `+${shownBase}`, step: 'Base', score: shownBase }];
      const nowMs = Date.now();
      let prev = 0;
      for (const step of sched) {
        const ts = rampStartMs + Math.round(step.frac * pick.leak_window_sec * 1000);
        if (ts > nowMs) break; // future chunks stay hidden — the curve never front-runs the number
        const delta = step.cum - prev;
        prev = step.cum;
        events.push({ ts: new Date(ts).toISOString(), delta, label: `+${delta}`, step: labelFor(step.cum), score: shownBase + step.cum });
      }
      // Land exactly on today's display score (mid-ramp: partial; done: full).
      const last = events[events.length - 1];
      if (last.score !== displayScore) {
        const d = displayScore - last.score;
        if (events.length > 1) { last.delta += d; last.score = displayScore; last.label = `+${last.delta}`; }
        else events.push({ ts: new Date(nowMs).toISOString(), delta: d, label: `+${d}`, step: 'Aggregate', score: displayScore });
      }
      return events;
    }
  }

  // No breakdown yet, or a degenerate scale (nothing above the opening step):
  // a clean two-point rise so the chart still draws.
  if (!bd || trueTotal <= opening || steps.length < 2) {
    const lo = Math.max(0, Math.min(opening || displayScore, Math.round(displayScore * 0.6)));
    return [
      { ts: new Date(firstMs).toISOString(), delta: lo, label: `+${lo}`, step: steps[0]?.label ?? 'Backer', score: lo },
      { ts: new Date(firstMs + span).toISOString(), delta: displayScore - lo, label: `+${displayScore - lo}`, step: 'Aggregate', score: displayScore },
    ];
  }

  // No ramp state (small-step picks): the component steps spread over the window.
  // Everything scales proportionally onto the display score, opening step first.
  const scale = displayScore / Math.max(1, trueTotal);
  const n = steps.length;
  const events = [];
  let cumTrue = 0, prevDisp = 0;
  steps.forEach((st, i) => {
    cumTrue += st.pts;
    const dispCum = Math.round(cumTrue * scale);
    const delta = dispCum - prevDisp;
    prevDisp = dispCum;
    const ts = i === 0 ? firstMs : firstMs + Math.round(span * (i / Math.max(1, n - 1)));
    events.push({ ts: new Date(ts).toISOString(), delta, label: `+${delta}`, step: st.label, score: dispCum });
  });
  // Land the last point exactly on the display score (rounding guard).
  const last = events[events.length - 1];
  if (last.score !== displayScore) {
    last.delta += (displayScore - last.score);
    last.score = displayScore;
    last.label = `+${last.delta}`;
  }
  return events;
}

// ── v2: the legacy channel-points replay ───────────────────────────────────────
function buildV2Timeline(pick) {
  const mentions = db.prepare(`
    SELECT message_timestamp, channel
    FROM raw_messages
    WHERE pick_id = ?
    ORDER BY message_timestamp ASC, id ASC
  `).all(pick.id);
  if (mentions.length === 0) return [];

  const firstMentionMs = parseDbTs(mentions[0].message_timestamp)
    ?? parseDbTs(pick.parsed_at)
    ?? Date.now();

  const game = pick.espn_game_id
    ? db.prepare(`SELECT start_time FROM today_games WHERE espn_game_id = ?`).get(pick.espn_game_id)
    : null;
  const scheduledMs = parseDbTs(game?.start_time);

  const sportUpper  = (pick.sport || '').toUpperCase();
  const hasSport    = SPORT_BONUS_SPORTS.has(sportUpper);
  const hasHome     = !!pick.is_home_team && !NO_HOME_BONUS_SPORTS.has(sportUpper);

  const SEC          = 1000;
  const FIVE_MIN_MS  = 5 * 60 * 1000;
  const TEN_MIN_MS   = 10 * 60 * 1000;
  const TIGHT_WINDOW = 15 * 60 * 1000;
  const msUntilTip   = (scheduledMs && scheduledMs > firstMentionMs)
    ? scheduledMs - firstMentionMs
    : Infinity;
  const tight = msUntilTip < TIGHT_WINDOW;
  const hash = ((pick.id * 2654435761) >>> 0);
  const rng1 = ((hash >>> 16) ^ (hash & 0xffff)) / 0x10000;
  const rng2 = (((hash * 16807) >>> 0) & 0xffff) / 0x10000;
  const homeOffset = tight
    ? SEC + Math.floor(rng1 * SEC)
    : FIVE_MIN_MS + Math.floor(rng1 * (TEN_MIN_MS - FIVE_MIN_MS));
  const sportOffset = tight
    ? SEC + Math.floor(rng2 * SEC)
    : FIVE_MIN_MS + Math.floor(rng2 * (TEN_MIN_MS - FIVE_MIN_MS));
  const homeAnchor  = firstMentionMs + homeOffset;
  const sportAnchor = homeAnchor + sportOffset;

  const events = [];
  for (const m of mentions) {
    const ms = parseDbTs(m.message_timestamp) ?? firstMentionMs;
    const delta = CHANNEL_POINTS[m.channel] ?? 0;
    if (delta === 0) continue;
    events.push({ ts: new Date(ms).toISOString(), delta, label: `+${delta}` });
  }
  if (hasHome)  events.push({ ts: new Date(homeAnchor).toISOString(),  delta: 5, label: '+5' });
  if (hasSport) events.push({ ts: new Date(sportAnchor).toISOString(), delta: 5, label: '+5' });

  events.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  let running = 0;
  for (const e of events) { running += e.delta; e.score = running; }
  return events;
}

function getPickTimeline(pickId) {
  const pick = db.prepare(`SELECT * FROM picks WHERE id = ?`).get(pickId);
  if (!pick) return [];
  try {
    if (db.getSetting('scoring_version', 'v2') === 'v3') return buildV3Timeline(pick);
  } catch (_) { /* fall through to v2 on any error */ }
  return buildV2Timeline(pick);
}

// Non-paid sanitizer. The annotated timeline is proprietary twice over: step
// labels name the advocate capper ("Resume · <name>" — capper_name is paid-only)
// and each event's delta/label prices a scoring component (Base/Resume/Consensus/
// Market...). Free viewers keep only the curve SHAPE — timestamp + running
// display score — with every annotation stripped. Paid viewers get the full
// timeline. Passes null/non-arrays through untouched (locked picks stay null).
function sanitizeTimeline(events) {
  if (!Array.isArray(events)) return events;
  return events.map(e => ({ ts: e.ts, score: e.score }));
}

module.exports = { getPickTimeline, sanitizeTimeline };
