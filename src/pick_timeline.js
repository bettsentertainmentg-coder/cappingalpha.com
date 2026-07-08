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

  // Ordered, positive-only component steps. Base is the opening level; everything
  // else stacks on in the order the score is built.
  const base = bd?.base ?? 45;
  const steps = [{ label: 'Base', pts: base }];
  if (bd) {
    if (bd.resume > 0)          steps.push({ label: bd.advocate ? `Resume · ${bd.advocate}` : 'Resume', pts: bd.resume });
    if (bd.consensus > 0)       steps.push({ label: 'Consensus', pts: bd.consensus });
    if ((bd.market?.pts ?? 0) > 0) steps.push({ label: 'Market', pts: bd.market.pts });
    if ((bd.lean?.pts ?? 0) > 0)   steps.push({ label: 'Side lean', pts: bd.lean.pts });
    if ((bd.sport_bonus ?? 0) > 0) steps.push({ label: 'Sport', pts: bd.sport_bonus });
    if ((bd.fade_in?.pts ?? 0) > 0) steps.push({ label: 'Fade', pts: bd.fade_in.pts });
    if ((bd.conflict_offset ?? 0) > 0) steps.push({ label: 'Offset', pts: bd.conflict_offset });
  }
  const trueTotal = steps.reduce((s, e) => s + e.pts, 0);

  // No breakdown yet, or a degenerate scale (leaking pick whose display is at/below
  // base): a clean two-point rise to the display score so the chart still draws.
  if (!bd || trueTotal <= base || displayScore <= base) {
    const lo = Math.max(0, Math.min(base, Math.round(displayScore * 0.6)));
    return [
      { ts: new Date(firstMs).toISOString(), delta: lo, label: `+${lo}`, step: 'Base', score: lo },
      { ts: new Date(firstMs + span).toISOString(), delta: displayScore - lo, label: `+${displayScore - lo}`, step: 'Aggregate', score: displayScore },
    ];
  }

  // Scale the ABOVE-BASE portion so the curve ends exactly on the display score
  // (a mid-ramp pick shows less than its true total; the true total never ships).
  const scale = (displayScore - base) / (trueTotal - base);
  const n = steps.length;
  const events = [];
  let cumTrue = 0, prevDisp = 0;
  steps.forEach((st, i) => {
    cumTrue += st.pts;
    const dispCum = i === 0 ? base : Math.round(base + (cumTrue - base) * scale);
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

module.exports = { getPickTimeline };
