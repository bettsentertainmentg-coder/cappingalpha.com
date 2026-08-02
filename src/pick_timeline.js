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
//    only synthetic placement: the general bonuses (in-sport rank, market, side
//    lean, sport bonus) are withheld and land as ONE tallied step at T-60, one
//    hour before the scheduled start — the same moment ca_line.js locks the CA
//    official line. Capper points add the instant they happen; the spot prices
//    in once, when the price does. See scoring_v3.bonusRevealEvents.
//    The curve ENDS on the exact display score the picks list shows (both are
//    the same reveal-aware function), so the curve and the big number never
//    disagree, and future reveal moments never draw early.
//  - v2 (legacy): the old channel-points replay (kept so nothing breaks if a
//    deploy ever runs on v2).
//
// THE FREEZE, ON THE CURVE TOO (Jack 2026-07-31): "make sure all picks can be
// tracked and watched accurately — show the exact tallying and timing of all
// points added before and after start time." Two things were wrong:
//
//  1. Only the ENDPOINT was frozen. Every interior point came from replaySubtotal
//     against LIVE capper_ratings, and results.js recomputes those on every
//     5-minute pass, so the same finished pick drew a different shape on every
//     page load. Now the whole series is snapshotted into picks.timeline_frozen
//     at first pitch (game_start_tracker) and served verbatim from then on.
//  2. Drift between the replay and the displayed score was silently folded into
//     the last pregame step, so a score that MOVED after the game started was
//     drawn as if those points had arrived hours earlier. Now any such gap is
//     emitted as its own point, stamped at the real moment, flagged postStart.
//
// Every point carries { ts, delta, label, score, kind, cause, postStart }. `kind`
// and `cause` stay deliberately neutral: they name WHO moved a pick (a backer),
// never WHY in formula terms. Naming a scoring component to a member would break
// the no-reveal rule, so the four formula-shaped components all surface as
// kind 'model' with no cause text.

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
    ? db.prepare(`SELECT sport, start_time, actual_start_at FROM today_games WHERE espn_game_id = ?`).get(pick.espn_game_id)
    : null;
  const sport = pick.sport || game?.sport || 'Unknown';
  // First pitch, as precisely as we know it. The stamped actual start wins; the
  // schedule is the fallback until the start watcher catches the flip.
  const startMs = parseDbTs(game?.actual_start_at) ?? parseDbTs(game?.start_time);
  const afterStart = (ms) => startMs != null && ms >= startMs;

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
      { ts: new Date(firstMs).toISOString(), delta: lo, label: `+${lo}`, score: lo,
        kind: 'backer', cause: null, postStart: afterStart(firstMs) },
      { ts: new Date(endMs).toISOString(), delta: displayScore - lo, label: `+${displayScore - lo}`, score: displayScore,
        kind: 'model', cause: null, postStart: afterStart(endMs) },
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
    // `kind` is what the client renders. It names WHO moved the pick, never the
    // formula: 'backer' (someone came in on this side), 'counter' (someone came
    // in on the other side), 'model' (one of the four formula-shaped components
    // surfacing at its reveal moment — deliberately unnamed).
    let kind = 'backer';
    let cause = null;
    if (ev.kind === 'own') {
      if (ev.capper && !ownSeen.includes(ev.capper)) ownSeen.push(ev.capper);
      opened = !started;
      started = true;
      cause = ev.capper || null;
    } else if (ev.kind === 'opp') {
      if (!ev.capper || oppSeen.includes(ev.capper)) continue;
      oppSeen.push(ev.capper);
      if (!started) continue; // pre-birth counter-action folds into the opening step
      kind = 'counter';
      cause = ev.capper || null;
    } else {
      bonusCum += ev.pts;
      if (!started) continue; // reveal moments never precede the first mention
      kind = 'model';
    }
    const score = Math.round(replaySubtotal(pick, sport, ownSeen, oppSeen, opp?.pick_type).pts) + bonusCum;
    const delta = score - prevScore;
    if (delta === 0 && !opened) continue;
    // `cause` carries a capper name, which is paid-only — sanitizeTimeline strips
    // it (with delta and label) for free viewers.
    events.push({
      ts: new Date(ev.ms).toISOString(),
      delta,
      label: `${delta >= 0 ? '+' : ''}${delta}`,
      score,
      kind,
      cause,
      postStart: afterStart(ev.ms),
    });
    prevScore = score;
  }

  if (!events.length) {
    return [{ ts: new Date(firstMs).toISOString(), delta: displayScore, label: `+${displayScore}`, score: displayScore,
              kind: 'backer', cause: null, postStart: afterStart(firstMs) }];
  }

  // Land exactly on the display score the picks list shows right now — the curve
  // and the big number are one story or they are both untrustworthy.
  //
  // MOST of any gap is NOT a score change. The replay re-derives every interior
  // point from capper_ratings as they stand at request time, and results.js
  // re-ranks that table on every graded pass, so the replayed total drifts away
  // from the stored one all day with nobody posting anything. Folding that drift
  // into the last step is the honest close: it is one number's worth of "the
  // pool moved", not a step anyone took.
  //
  // A REAL post-start move is a different thing, and we can tell them apart
  // exactly. picks.score_at_start is stamped once at first pitch, so if the
  // stored total no longer matches it, the score genuinely moved after the game
  // began, which the rules forbid. Only that case earns the red flagged point.
  // Drawing red on mere replay drift would cry wolf on every live pick, every
  // five minutes, which is worse than not drawing it at all.
  const last = events[events.length - 1];
  const atStart = pick.score_at_start != null ? Math.round(pick.score_at_start) : null;
  const movedAfterStart = atStart != null && atStart !== displayScore;
  if (movedAfterStart) {
    // Close the replay drift against where the pick REALLY stood at first pitch,
    // then show the illegal move as its own step.
    if (last.score !== atStart) {
      last.delta += (atStart - last.score);
      last.score = atStart;
      last.label = `${last.delta >= 0 ? '+' : ''}${last.delta}`;
    }
    const move = displayScore - atStart;
    const lastMs = new Date(last.ts).getTime();
    const ms = Math.max(startMs ?? lastMs, lastMs) + 1000;
    events.push({
      ts: new Date(ms).toISOString(),
      delta: move,
      label: `${move >= 0 ? '+' : ''}${move}`,
      score: displayScore,
      kind: 'adjust',
      cause: null,
      postStart: true,
    });
  } else if (last.score !== displayScore) {
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
    ? db.prepare(`SELECT start_time, actual_start_at FROM today_games WHERE espn_game_id = ?`).get(pick.espn_game_id)
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
    events.push({ ts: new Date(ms).toISOString(), delta, label: `+${delta}`, kind: 'backer', cause: null });
  }
  if (hasHome)  events.push({ ts: new Date(homeAnchor).toISOString(),  delta: 5, label: '+5', kind: 'model', cause: null });
  if (hasSport) events.push({ ts: new Date(sportAnchor).toISOString(), delta: 5, label: '+5', kind: 'model', cause: null });

  events.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  let running = 0;
  const startedMs = parseDbTs(game?.actual_start_at) ?? scheduledMs;
  for (const e of events) {
    running += e.delta;
    e.score = running;
    e.postStart = startedMs != null && new Date(e.ts).getTime() >= startedMs;
  }
  return events;
}

// ── The curve freeze ──────────────────────────────────────────────────────────
// A finished pick must draw the SAME shape forever. Without this the interior
// points are replayed against live capper_ratings on every request (see
// replaySubtotal), and results.js re-ranks the whole pool every 5 minutes, so a
// graded pick's history quietly rewrote itself all night. Snapshot once at first
// pitch, serve it verbatim after.
function readFrozenTimeline(pick) {
  if (!pick?.timeline_frozen) return null;
  try {
    const t = JSON.parse(pick.timeline_frozen);
    return Array.isArray(t) && t.length ? t : null;
  } catch (_) { return null; }
}

function writeFrozenTimeline(pickId, events) {
  if (!Array.isArray(events) || !events.length) return false;
  try {
    db.prepare(`UPDATE picks SET timeline_frozen = ? WHERE id = ? AND timeline_frozen IS NULL`)
      .run(JSON.stringify(events), pickId);
    return true;
  } catch (_) { return false; }
}

// Freeze every scored pick on a game the instant it goes live. Called by
// game_start_tracker right where actual_start_at is stamped, so the snapshot is
// taken at first pitch rather than whenever someone happens to open the page.
//
// Also stamps picks.score_at_start — the number the pick was worth when it
// stopped being bettable. Nothing read it before, which is exactly why the
// 2026-07-31 WNBA drop could not be reconstructed: the pregame value of an
// untracked pick existed nowhere once it had been overwritten. It is the
// baseline audit rule R11 compares against.
// Sweep every game that has begun and freeze anything still unfrozen. The stamp
// in game_start_tracker only fires on status 'in' with no actual_start_at, so a
// game we first observe as 'post' (a short outage, a restart, a game that flips
// outside the live tick window) would never get its curve photographed and would
// redraw itself forever. This is the backstop, and it is idempotent.
function freezeStartedCurves() {
  let n = 0;
  try {
    const games = db.prepare(`
      SELECT DISTINCT tg.espn_game_id
      FROM today_games tg JOIN picks p ON p.espn_game_id = tg.espn_game_id
      WHERE tg.status IN ('in', 'post') AND p.mention_count > 0 AND p.timeline_frozen IS NULL
    `).all();
    for (const g of games) n += freezeTimelinesForGame(g.espn_game_id);
  } catch (_) {}
  if (n) console.log(`[pickTimeline] froze ${n} conviction curve(s) on already-started games`);
  return n;
}

function freezeTimelinesForGame(espnGameId) {
  let n = 0;
  try {
    const picks = db.prepare(`
      SELECT p.id, sb.v3_total
      FROM picks p LEFT JOIN score_breakdown sb ON sb.pick_id = p.id
      WHERE p.espn_game_id = ? AND p.mention_count > 0 AND p.timeline_frozen IS NULL
    `).all(espnGameId);
    for (const p of picks) {
      try { if (writeFrozenTimeline(p.id, getPickTimeline(p.id, { skipFrozen: true }))) n++; } catch (_) {}
      try {
        if (p.v3_total != null) {
          db.prepare(`UPDATE picks SET score_at_start = ? WHERE id = ? AND score_at_start IS NULL`)
            .run(p.v3_total, p.id);
        }
      } catch (_) {}
    }
  } catch (_) {}
  return n;
}

function getPickTimeline(pickId, opts = {}) {
  const pick = db.prepare(`SELECT * FROM picks WHERE id = ?`).get(pickId);
  if (!pick) return [];
  if (!opts.skipFrozen) {
    const frozen = readFrozenTimeline(pick);
    if (frozen) return frozen;
  }
  try {
    if (db.getSetting('scoring_version', 'v2') === 'v3') {
      const events = buildV3Timeline(pick);
      // Heavy display cap (Jack 2026-07-29): the curve must end where the list
      // does. A heavy-priced untracked ML shows at most 95 everywhere, so the
      // replayed series plateaus at the cap instead of climbing past it.
      try {
        const cap = require('./scoring_v3').heavyDisplayCapFor(pick);
        if (Number.isFinite(cap) && Array.isArray(events)) {
          // Clamp, then RE-DERIVE the deltas from the clamped series. Rewriting
          // score alone (what this did before) breaks the one invariant a step
          // chart has: score[n] = score[n-1] + delta[n]. Two points both clamped
          // to 95 drew a flat segment labelled "+13", and the last point is
          // always labelled, so the contradiction was guaranteed to be the one
          // a reader looked at.
          let prev = 0;
          return events.map(e => {
            if (!e || typeof e.score !== 'number') return e;
            const score = Math.min(e.score, cap);
            const delta = Math.round(score - prev);
            prev = score;
            return { ...e, score, delta, label: `${delta >= 0 ? '+' : ''}${delta}` };
          });
        }
      } catch (_) {}
      return events;
    }
  } catch (_) { /* fall through to v2 on any error */ }
  return buildV2Timeline(pick);
}

// Non-paid sanitizer. The annotated timeline is proprietary twice over: `cause`
// names the backing capper (capper_name is paid-only) and each event's delta
// prices a step. Free viewers keep the curve SHAPE — timestamp + running display
// score — plus `postStart`, which says nothing about the formula and everything
// about whether a point landed before or after first pitch. Paid viewers get the
// full timeline. Passes null/non-arrays through untouched (locked picks stay null).
function sanitizeTimeline(events) {
  if (!Array.isArray(events)) return events;
  return events.map(e => ({ ts: e.ts, score: e.score, postStart: !!e.postStart }));
}

module.exports = { getPickTimeline, sanitizeTimeline, freezeTimelinesForGame, freezeStartedCurves };
