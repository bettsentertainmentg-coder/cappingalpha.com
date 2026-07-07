// src/replay_live.js
// LOCAL-DEV ONLY archived-game replay: replays a FINISHED real ESPN game through
// the real tracker UI at compressed speed, so football/NHL renderers can be
// eyeballed before their seasons start.
//
// SAFETY: gated the same way as mock_live (UI_ONLY, never set on Railway; disable
// with MOCK_LIVE=0). Replays are route-installed only (GET /dev/replay) and live
// in memory; nothing auto-installs at startup, and a restart drops them (the
// today_games row persists harmlessly until the daily wipe or ?clear=1).

const { getSummaryRaw, getFeed, LEAGUE_PATH } = require('./espn_summary');
const { SPORT_FAMILY } = require('./live_state');

const REPLAY_PREFIX = 'replay_';
const REAL_GAME_MS  = 3 * 60 * 60 * 1000;   // baseline ~3h game, same as mock_live

// replayId -> { realId, sport, family, frames, cycleMs, homeAbbr, awayAbbr }
const _replays = new Map();

function replayActive() {
  return !!process.env.UI_ONLY && process.env.MOCK_LIVE !== '0';
}
function isReplayId(id) {
  return replayActive() && String(id ?? '').startsWith(REPLAY_PREFIX);
}
function replaySourceId(id) {
  const entry = _replays.get(String(id));
  return entry ? { eventId: entry.realId, sport: entry.sport } : null;
}

// ── Summary helpers (mirror espn_summary's internal shapes) ────────────────────
const periodOf = (p) => (typeof p?.period === 'object' ? p.period?.number : p?.period) ?? null;
const clockOf  = (p) => (typeof p?.clock === 'object' ? p.clock?.displayValue : p?.clock) ?? null;

function headerCompetitors(summary) {
  const comps = summary?.header?.competitions?.[0]?.competitors || [];
  return {
    home: comps.find(c => c.homeAway === 'home') || null,
    away: comps.find(c => c.homeAway === 'away') || null,
  };
}

// ── Frame builders ─────────────────────────────────────────────────────────────
// One frame per play: { period, clock, homeScore, awayScore, lastPlay } plus the
// football situation (down/distance/possession) from the play's start block.
// Scores carry forward when a play omits them.

function footballFrames(summary, sideOf) {
  const drives = [...(summary?.drives?.previous || [])];
  if (summary?.drives?.current) drives.push(summary.drives.current);
  const frames = [];
  let h = 0, a = 0;
  for (const d of drives) {
    for (const p of (d.plays || [])) {
      if (typeof p.homeScore === 'number') h = p.homeScore;
      if (typeof p.awayScore === 'number') a = p.awayScore;
      const start = p.start || {};
      frames.push({
        period: periodOf(p), clock: clockOf(p), homeScore: h, awayScore: a,
        lastPlay: p.text || p.shortDescription || p.type?.text || null,
        down:             (typeof start.down === 'number' && start.down > 0) ? start.down : null,
        distance:         (typeof start.distance === 'number') ? start.distance : null,
        downDistanceText: start.shortDownDistanceText || start.downDistanceText || null,
        yardLineText:     start.possessionText || null,
        possession:       sideOf(start.team?.id ?? d.team?.id),
        isRedZone:        (typeof start.yardsToEndzone === 'number') ? start.yardsToEndzone <= 20 : false,
      });
    }
  }
  return frames;
}

function flatFrames(summary) {
  let h = 0, a = 0;
  return (summary?.plays || []).map(p => {
    if (typeof p.homeScore === 'number') h = p.homeScore;
    if (typeof p.awayScore === 'number') a = p.awayScore;
    return {
      period: periodOf(p), clock: clockOf(p), homeScore: h, awayScore: a,
      lastPlay: p.text || p.shortDescription || p.type?.text || null,
    };
  });
}

function baseballFrames(summary) {
  let h = 0, a = 0;
  const results = (summary?.plays || []).filter(p => p?.type?.type === 'play-result');
  return results.map(p => {
    if (typeof p.homeScore === 'number') h = p.homeScore;
    if (typeof p.awayScore === 'number') a = p.awayScore;
    const perType = String(p.period?.type || '');
    return {
      period: periodOf(p), clock: null, homeScore: h, awayScore: a,
      lastPlay: p.text || p.shortDescription || null,
      half: /top/i.test(perType) ? 'top' : (/bot/i.test(perType) ? 'bot' : null),
    };
  });
}

// ── installReplay ──────────────────────────────────────────────────────────────
// Fetches the archived summary, builds frames, registers the in-memory replay,
// and upserts a today_games row so the detail page + tracker routes find it.
// Throws with a short message on bad input (the /dev/replay route responds 400).
async function installReplay(db, espnEventId, sport, speed = 8) {
  if (!replayActive()) throw new Error('replay is dev-only (UI_ONLY)');
  const sp = String(sport || '').toUpperCase();
  const family = SPORT_FAMILY[sp];
  if (!family || !LEAGUE_PATH[sp]) throw new Error(`unsupported sport "${sport}" for replay`);
  const eventId = String(espnEventId || '').trim();
  if (!/^\d{5,}$/.test(eventId)) throw new Error('bad event id (expected a numeric ESPN event id)');

  const summary = await getSummaryRaw(sp, eventId);
  const comp = summary?.header?.competitions?.[0];
  if (!comp) throw new Error(`no ESPN summary for ${sp} event ${eventId}`);

  const { home, away } = headerCompetitors(summary);
  if (!home || !away) throw new Error('summary is missing competitors');
  const homeId = String(home.team?.id ?? '');
  const awayId = String(away.team?.id ?? '');
  const sideOf = (id) => {
    const s = String(id ?? '');
    return s && s === homeId ? 'home' : (s && s === awayId ? 'away' : null);
  };

  let frames;
  if (family === 'football')      frames = footballFrames(summary, sideOf);
  else if (family === 'baseball') frames = baseballFrames(summary);
  else                            frames = flatFrames(summary);   // basketball / hockey
  if (!Array.isArray(frames) || frames.length < 2) {
    throw new Error(`no plays in the ${sp} summary for event ${eventId}, cannot replay`);
  }

  const spd = Math.max(1, Math.min(120, Number(speed) || 8));
  const replayId = REPLAY_PREFIX + eventId;
  _replays.set(replayId, {
    realId: eventId, sport: sp, family, frames,
    cycleMs: Math.max(60_000, Math.round(REAL_GAME_MS / spd)),
    homeAbbr: home.team?.abbreviation || null,
    awayAbbr: away.team?.abbreviation || null,
  });

  const f0 = frames[0];
  db.prepare(`
    INSERT INTO today_games (espn_game_id, sport, status, period, clock, start_time,
      home_score, away_score, home_team, home_short, home_name, home_abbr,
      away_team, away_short, away_name, away_abbr)
    VALUES (@id,@sport,'in',@period,@clock,@start,@home,@away,@hteam,@hshort,@hteam,@habbr,@ateam,@ashort,@ateam,@aabbr)
    ON CONFLICT(espn_game_id) DO UPDATE SET sport=@sport, status='in', period=@period,
      clock=@clock, home_score=@home, away_score=@away, start_time=@start
  `).run({
    id: replayId, sport: sp,
    period: f0.period ?? 1, clock: f0.clock ?? null, start: new Date().toISOString(),
    home: f0.homeScore ?? 0, away: f0.awayScore ?? 0,
    hteam: home.team?.displayName || home.team?.name || 'Home',
    hshort: home.team?.shortDisplayName || home.team?.name || null,
    habbr: home.team?.abbreviation || null,
    ateam: away.team?.displayName || away.team?.name || 'Away',
    ashort: away.team?.shortDisplayName || away.team?.name || null,
    aabbr: away.team?.abbreviation || null,
  });

  return { replayId, frames: frames.length, speed: spd };
}

// ── Wall-clock playback (same scheme as mock_live) ─────────────────────────────
function _frameIndex(entry) {
  const pos = Date.now() % entry.cycleMs;
  return Math.min(entry.frames.length - 1, Math.floor((pos / entry.cycleMs) * entry.frames.length));
}

const _ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

function _detailFor(entry, f) {
  const p = parseInt(f.period, 10) || 1;
  if (entry.family === 'baseball') return `${f.half === 'bot' ? 'Bot' : 'Top'} ${_ord(p)}`;
  const prefix = entry.family === 'hockey' ? 'P' : 'Q';
  return `${prefix}${p}${f.clock ? ' ' + f.clock : ''}`;
}

// Per-period line scores derived by replaying score deltas up to the current
// frame. Returns null when the period is unusable (line score not derivable).
function _lineScores(frames, idx) {
  const nP = parseInt(frames[idx]?.period, 10);
  if (!nP || nP < 1 || nP > 15) return null;
  const home = Array(nP).fill(0), away = Array(nP).fill(0);
  let ph = 0, pa = 0;
  for (let i = 0; i <= idx; i++) {
    const f = frames[i];
    const p = parseInt(f.period, 10);
    const dh = (f.homeScore || 0) - ph, da = (f.awayScore || 0) - pa;
    ph = f.homeScore || 0; pa = f.awayScore || 0;
    if (p >= 1 && p <= nP) {
      if (dh > 0) home[p - 1] += dh;
      if (da > 0) away[p - 1] += da;
    }
  }
  return { home, away };
}

// State at the current wall-clock frame, shaped like live_state.parseLiveState
// output for the sport's family. Returns null when the replay isn't registered
// (e.g. after a restart); callers fall back to the stored today_games row.
function replayLiveState(id) {
  const entry = _replays.get(String(id));
  if (!entry) return null;
  const idx = _frameIndex(entry);
  const f = entry.frames[idx];
  const st = {
    status: 'in',
    detail: _detailFor(entry, f),
    period: f.period ?? null,
    clock:  f.clock ?? null,
    homeScore: f.homeScore ?? 0,
    awayScore: f.awayScore ?? 0,
    homeAbbr: entry.homeAbbr,
    awayAbbr: entry.awayAbbr,
    lastPlay: f.lastPlay ?? null,
  };
  const lines = _lineScores(entry.frames, idx);
  if (lines) { st.homeLine = lines.home; st.awayLine = lines.away; }
  if (entry.family === 'football') {
    st.down             = f.down ?? null;
    st.distance         = f.distance ?? null;
    st.downDistanceText = f.downDistanceText ?? null;
    st.yardLineText     = f.yardLineText ?? null;
    st.possession       = f.possession ?? null;
    st.isRedZone        = f.isRedZone === true;
    st.homeTimeouts     = null;
    st.awayTimeouts     = null;
  }
  if (entry.family === 'baseball') {
    st.inning = f.period ?? null;
    st.half   = f.half ?? null;
  }
  return st;
}

// Tabs data = the REAL game's feed (passthrough), so plays/leaders/win prob show
// real archived content while the header state replays.
async function replayFeed(id) {
  const entry = _replays.get(String(id));
  if (!entry) return null;
  return getFeed(entry.sport, entry.realId);
}

// Drop all replays: clears the in-memory registry and deletes replay rows from
// today_games. Returns the number of deleted rows.
function clearReplays(db) {
  _replays.clear();
  try {
    return db.prepare(`DELETE FROM today_games WHERE espn_game_id LIKE ?`).run(REPLAY_PREFIX + '%').changes;
  } catch (_) {
    return 0;
  }
}

module.exports = { replayActive, isReplayId, installReplay, replayLiveState, replayFeed, replaySourceId, clearReplays };
