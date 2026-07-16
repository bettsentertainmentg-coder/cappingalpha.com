// src/live_tracker.js
// Near-real-time per-game live STATE for the detail page, plus the EMA store the
// value pulse needs across polls. Fetches ESPN's free per-sport scoreboard and
// caches it ~10s per sport (one fetch serves every live game of that sport), with
// an in-flight guard so concurrent viewers collapse to ~1 ESPN call per window.
//
// No DB writes (ephemeral — keeps clear of the do-not-touch espn_live.js upserts).
// The win-prob math + value pulse live in win_prob.js / win_prob_generic.js /
// live_value.js (pure); the per-sport state SHAPE lives in live_state.js. This
// module owns the ESPN fetch/cache, event lookup (incl. soccer's per-league
// scoreboards and tennis's tournament nesting), and per-pick EMA continuity.

const axios = require('axios');
const db = require('./db');
const { parseLiveState } = require('./live_state');

const SB_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// ESPN free scoreboard per sport. College scoreboards default to ranked teams
// only, so NCAAF/CBB/WCBB carry groups (80 = FBS, 50 = all D1) + a high limit.
// Soccer is per-competition (resolved from today_games.league_path below).
const SCOREBOARD = {
  MLB:   `${SB_BASE}/baseball/mlb/scoreboard`,
  NBA:   `${SB_BASE}/basketball/nba/scoreboard`,
  WNBA:  `${SB_BASE}/basketball/wnba/scoreboard`,
  NHL:   `${SB_BASE}/hockey/nhl/scoreboard`,
  NFL:   `${SB_BASE}/football/nfl/scoreboard`,
  NCAAF: `${SB_BASE}/football/college-football/scoreboard?groups=80&limit=400`,
  CBB:   `${SB_BASE}/basketball/mens-college-basketball/scoreboard?groups=50&limit=400`,
  WCBB:  `${SB_BASE}/basketball/womens-college-basketball/scoreboard?groups=50&limit=400`,
  ATP:   `${SB_BASE}/tennis/atp/scoreboard`,
  WTA:   `${SB_BASE}/tennis/wta/scoreboard`,
};

const SB_TTL    = 10_000;        // per-scoreboard cache window
const EMA_TTL   = 30 * 60_000;   // forget a pick's pulse state after 30 min idle
const WP_TTL    = 6 * 60 * 60_000; // model win-prob series lives for the game's day

const _sb       = new Map();     // cache key -> { ts, events }
const _inflight = new Map();     // cache key -> Promise (collapse concurrent fetches)
const _ema      = new Map();     // `${gameId}:${pickId}` -> { m, ts }
const _hist     = new Map();     // `${gameId}:${pickId}` -> [{v, p}, ...] (value over the game)
const _wpHist   = new Map();     // gameId -> { ts, pts: [{x, home}] } (model-sport win prob series)
const _soccerPath = new Map();   // gameId -> league path (probe cache)
const HIST_MAX    = 80;
const WP_HIST_MAX = 200;

async function _fetchEvents(key, url) {
  const cached = _sb.get(key);
  if (cached && Date.now() - cached.ts < SB_TTL) return cached.events;
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => {
    try {
      const res = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const events = res.data?.events || [];
      _sb.set(key, { ts: Date.now(), events });
      return events;
    } catch (e) {
      const stale = _sb.get(key);   // serve stale on a transient error
      return stale ? stale.events : null;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

async function fetchScoreboard(sport) {
  const sp = String(sport || '').toUpperCase();
  const url = SCOREBOARD[sp];
  if (!url) return null;
  return _fetchEvents(sp, url);
}

// ── Event lookup per sport ─────────────────────────────────────────────────────
// Soccer: the scoreboard is per competition. The league path is stamped on the
// row by soccer_espn.js (today_games.league_path); when missing (older rows) we
// probe the known competition set once and remember the hit.
async function _findSoccerEvent(espnGameId) {
  const id = String(espnGameId);
  let path = _soccerPath.get(id);
  if (!path) {
    try {
      const row = db.prepare(`SELECT league_path FROM today_games WHERE espn_game_id = ?`).get(id);
      if (row?.league_path) path = row.league_path;
    } catch (_) {}
  }
  if (path) {
    const events = await _fetchEvents(`SOCCER:${path}`, `${SB_BASE}/${path}/scoreboard`);
    const ev = (events || []).find(e => String(e.id) === id);
    if (ev) { _soccerPath.set(id, path); return ev; }
  }
  // Probe fallback (league_path unknown): check each competition, cache the hit.
  const { SOCCER_PATHS } = require('./soccer_espn');
  for (const p of SOCCER_PATHS) {
    if (p === path) continue;
    const events = await _fetchEvents(`SOCCER:${p}`, `${SB_BASE}/${p}/scoreboard`);
    const ev = (events || []).find(e => String(e.id) === id);
    if (ev) { _soccerPath.set(id, p); return ev; }
  }
  return null;
}

// Tennis: the scoreboard nests matches under tournament events -> groupings.
// Returns the match competition wrapped like a scoreboard event so the shared
// parser can read it. Doubles are skipped (same rule as tennis_espn.js).
function _findTennisComp(events, espnGameId) {
  const id = String(espnGameId);
  for (const t of (events || [])) {
    for (const g of (t.groupings || [])) {
      if ((g.grouping?.slug || '').toLowerCase().includes('double')) continue;
      for (const comp of (g.competitions || [])) {
        if (String(comp.id) === id) return { competitions: [comp], status: comp.status };
      }
    }
  }
  return null;
}

// Fresh live state for one game from the cached scoreboard, or null if not found.
async function getLiveState(sport, espnGameId) {
  const sp = String(sport || '').toUpperCase();
  let ev = null;
  if (sp === 'SOCCER') {
    ev = await _findSoccerEvent(espnGameId);
  } else if (sp === 'ATP' || sp === 'WTA') {
    ev = _findTennisComp(await fetchScoreboard(sp), espnGameId);
  } else {
    const events = await fetchScoreboard(sp);
    ev = (events || []).find(e => String(e.id) === String(espnGameId)) || null;
  }
  if (!ev) return null;
  return parseLiveState(sp, ev);
}

// EMA continuity store for the value pulse (per game+pick).
function prevPulseMag(key) {
  const e = _ema.get(key);
  return (e && Date.now() - e.ts < EMA_TTL) ? e.m : null;
}
function savePulseMag(key, m) { _ema.set(key, { m, ts: Date.now() }); }

// Value-over-game history (drives the pulse chart). Each sample carries the period
// (inning / quarter) it was taken in, so the client can label the x-axis and have it
// build out as the game advances. Built poll-by-poll for real games; the mock
// synthesizes a full arc itself.
function pushPulseHistory(key, mag, period) {
  let a = _hist.get(key);
  if (!a) { a = []; _hist.set(key, a); }
  let p = (period == null) ? null : (parseInt(period, 10) || null);
  // Periods never run backward in a real game, so when a fresh sample reads LOWER
  // than the trailing samples one side is a feed glitch (ESPN's tennis scoreboard
  // can flash a phantom set). A short trailing run was the glitch — restamp it to
  // the new truth; a long run means THIS sample is the glitch — clamp it up. Keeps
  // the series monotone so the chart's period axis can never fold back on itself.
  if (p != null && a.length) {
    let run = 0;
    for (let i = a.length - 1; i >= 0 && a[i].p != null && a[i].p > p; i--) run++;
    if (run > 0) {
      if (run <= 3) for (let i = a.length - run; i < a.length; i++) a[i].p = p;
      else p = a[a.length - 1].p;
    }
  }
  a.push({ v: Math.round(mag * 1000) / 1000, p });
  if (a.length > HIST_MAX) a.shift();
}
function getPulseHistory(key) { return (_hist.get(key) || []).slice(); }

// One-time whole-game backfill: seed a slot's value series from the ESPN timeline
// so the chart spans the full game the first time it's watched mid-game, rather
// than starting blank and only building from the current inning forward.
function seedPulseHistory(key, points) {
  if (!Array.isArray(points) || !points.length) return;
  const a = points.slice(-HIST_MAX).map(pt => ({
    v: Math.round((Number(pt.v) || 0) * 1000) / 1000,
    p: (pt.p == null) ? null : (parseInt(pt.p, 10) || null),
  }));
  _hist.set(key, a);
}

// Model win-prob series for sports where ESPN publishes none (NHL, Soccer): the
// live endpoint pushes one point per poll so the feed can still draw a chart.
function pushWpHistory(gameId, x, home) {
  const id = String(gameId);
  let e = _wpHist.get(id);
  if (!e) { e = { ts: Date.now(), pts: [] }; _wpHist.set(id, e); }
  e.ts = Date.now();
  const last = e.pts[e.pts.length - 1];
  const xr = Math.round((Number(x) || 0) * 1000) / 1000;
  const hr = Math.round((Number(home) || 0) * 1000) / 10;    // pct, 1 decimal
  if (last && last.x === xr && last.home === hr) return;
  e.pts.push({ x: xr, home: hr });
  if (e.pts.length > WP_HIST_MAX) e.pts.shift();
}
function getWpHistory(gameId) { return (_wpHist.get(String(gameId))?.pts || []).slice(); }

// Periodic prune (unref so it never holds the process open).
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of _ema) if (now - e.ts > EMA_TTL) _ema.delete(k);
  for (const [k, e] of _sb)  if (now - e.ts > 60 * 60_000) _sb.delete(k);
  for (const k of _hist.keys()) if (!_ema.has(k)) _hist.delete(k);
  for (const [k, e] of _wpHist) if (now - e.ts > WP_TTL) _wpHist.delete(k);
}, EMA_TTL).unref();

module.exports = {
  getLiveState, fetchScoreboard, prevPulseMag, savePulseMag,
  pushPulseHistory, getPulseHistory, seedPulseHistory, pushWpHistory, getWpHistory, SCOREBOARD,
};
