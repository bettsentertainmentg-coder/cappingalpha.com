// src/pick_timeline.js
// Builds the stock-chart-style score-over-time series behind the "conviction
// curve" on the game detail page.
//
// TWO ERAS, keyed off the scoring_version setting:
//  - v3 (live, Jack 2026-07-16): the curve is 100% REAL on timing. Every backer
//    mention steps the score at its actual message timestamp with the actual net
//    delta (a new best backer shows the netted step: their points plus the old
//    best halved into the stack, minus what was already showing). Fade points
//    from the opposite slot land at the opposing mention's real timestamp. The
//    only synthetic placement: the four formula-shaped components (sport rank,
//    market, side lean, sport bonus) surface at their seeded reveal moments from
//    scoring_v3.bonusRevealEvents — random, at least 3h before game start — so
//    their timing can't be correlated with the market events that produced them.
//    The curve ENDS on the exact display score the picks list shows (both are
//    the same reveal-aware function), so the curve and the big number never
//    disagree, and future reveal moments never draw early.
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

// ── v3: replay the REAL accumulation, end on the display score ────────────────
function buildV3Timeline(pick) {
  const {
    v3DisplayScore, replaySubtotal, oppositeSlot, bonusRevealEvents, revealContext,
  } = require('./scoring_v3');

  const ctx = revealContext(pick.id);
  const displayScore = v3DisplayScore(pick);
  if (!displayScore || displayScore <= 0) return [];
  const bd = ctx?.bd ?? null;
  const nowMs = Date.now();

  const game = pick.espn_game_id
    ? db.prepare(`SELECT sport, start_time FROM today_games WHERE espn_game_id = ?`).get(pick.espn_game_id)
    : null;
  const sport = pick.sport || game?.sport || 'Unknown';

  // Real events: this slot's mentions and the opposite slot's (fade sources),
  // each at its true message timestamp.
  const mentionStmt = db.prepare(`
    SELECT capper_name, message_timestamp FROM raw_messages WHERE pick_id = ? ORDER BY message_timestamp ASC, id ASC
  `);
  const own = mentionStmt.all(pick.id);
  const opp = oppositeSlot(pick);
  const oppMentions = opp ? mentionStmt.all(opp.id) : [];

  const firstMs = parseDbTs(own[0]?.message_timestamp) ?? parseDbTs(pick.parsed_at) ?? nowMs;

  // Degenerate fallback: no breakdown logged yet — a clean two-point rise so the
  // chart still draws something honest-shaped.
  if (!bd || !own.length) {
    const startMs = parseDbTs(game?.start_time);
    let endMs = (startMs && startMs > firstMs) ? startMs - 3 * 60 * 1000 : firstMs + 30 * 60 * 1000;
    endMs = Math.max(firstMs + 60 * 1000, Math.min(endMs, nowMs));
    const lo = Math.max(0, Math.round(displayScore * 0.6));
    return [
      { ts: new Date(firstMs).toISOString(), delta: lo, label: `+${lo}`, step: 'Backer', score: lo },
      { ts: new Date(endMs).toISOString(), delta: displayScore - lo, label: `+${displayScore - lo}`, step: 'Aggregate', score: displayScore },
    ];
  }

  // Merge the three event streams in time order. At equal timestamps: own
  // mentions first (the pick must exist before anything else can land on it),
  // then opposite-slot fades, then bonus reveals.
  const KIND_ORDER = { own: 0, opp: 1, bonus: 2 };
  const stream = [];
  for (const m of own) {
    const ms = parseDbTs(m.message_timestamp) ?? firstMs;
    stream.push({ ms, kind: 'own', capper: m.capper_name || null });
  }
  for (const m of oppMentions) {
    const ms = parseDbTs(m.message_timestamp);
    if (ms == null) continue;
    stream.push({ ms, kind: 'opp', capper: m.capper_name || null });
  }
  for (const ev of bonusRevealEvents(pick.id, ctx)) {
    if (ev.ts > nowMs) continue; // future reveal moments never draw early
    stream.push({ ms: ev.ts, kind: 'bonus', label: ev.label, pts: ev.pts });
  }
  stream.sort((a, b) => (a.ms - b.ms) || (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));

  // Replay. The curve opens at the first own mention; opposite-slot activity
  // before that folds into the opening level. Every step's running score is the
  // real aggregation over the cappers seen so far (same helpers as computeV3)
  // plus the bonus components revealed so far.
  const ownSeen = [], oppSeen = [];
  let started = false;
  let bonusCum = 0;
  let prevScore = 0;
  const events = [];
  for (const ev of stream) {
    let opened = false;
    let step = 'Backer';
    if (ev.kind === 'own') {
      if (ev.capper && !ownSeen.includes(ev.capper)) ownSeen.push(ev.capper);
      opened = !started;
      started = true;
      step = ev.capper ? `Backer · ${ev.capper}` : 'Backer';
    } else if (ev.kind === 'opp') {
      if (!ev.capper || oppSeen.includes(ev.capper)) continue;
      oppSeen.push(ev.capper);
      if (!started) continue; // pre-birth fade folds into the opening step
      step = 'Fade';
    } else {
      bonusCum += ev.pts;
      if (!started) continue; // reveal moments never precede the first mention
      step = ev.label;
    }
    const score = Math.round(replaySubtotal(pick, sport, ownSeen, oppSeen, opp?.pick_type).pts) + bonusCum;
    const delta = score - prevScore;
    if (delta === 0 && !opened) continue;
    // `step` names the advocate capper and the scoring component (fade, market,
    // side lean, sport). No client renders it and the no-reveal rule bars it from
    // reaching any non-admin reader, so it never leaves the server.
    events.push({
      ts: new Date(ev.ms).toISOString(),
      delta,
      label: `${delta >= 0 ? '+' : ''}${delta}`,
      score,
    });
    prevScore = score;
  }

  if (!events.length) {
    return [{ ts: new Date(firstMs).toISOString(), delta: displayScore, label: `+${displayScore}`, score: displayScore }];
  }

  // Land exactly on the display score the picks list shows right now. Any drift
  // (a nightly ratings re-rank since the last recalc) settles into the final
  // step so the curve and the big number stay one story.
  const last = events[events.length - 1];
  if (last.score !== displayScore) {
    last.delta += (displayScore - last.score);
    last.score = displayScore;
    last.label = `${last.delta >= 0 ? '+' : ''}${last.delta}`;
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
