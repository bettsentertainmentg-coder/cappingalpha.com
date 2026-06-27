// src/live_tracker.js
// Near-real-time per-game live STATE for the detail page, plus the EMA store the
// value pulse needs across polls. Fetches ESPN's free per-sport scoreboard and
// caches it ~10s per sport (one fetch serves every live game of that sport), with
// an in-flight guard so concurrent viewers collapse to ~1 ESPN call per window.
//
// No DB writes (ephemeral — keeps clear of the do-not-touch espn_live.js upserts).
// The win-prob math + value pulse live in win_prob.js / live_value.js (pure); this
// module only owns the ESPN fetch/cache and the per-pick EMA continuity.

const axios = require('axios');

// ESPN free scoreboard per sport. MLB is the v1 template (rich situation); the
// others are wired for fresh score/period only until their live models land.
const SCOREBOARD = {
  MLB:   'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
  NBA:   'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  WNBA:  'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard',
  NHL:   'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  NFL:   'https://site.api.espn.com/apis/site/v2/sports/americanfootball/nfl/scoreboard',
};

const SB_TTL    = 10_000;        // per-sport scoreboard cache window
const EMA_TTL   = 30 * 60_000;   // forget a pick's pulse state after 30 min idle

const _sb       = new Map();     // sport -> { ts, events }
const _inflight = new Map();     // sport -> Promise (collapse concurrent fetches)
const _ema      = new Map();     // `${gameId}:${pickId}` -> { m, ts }

async function fetchScoreboard(sport) {
  const url = SCOREBOARD[sport];
  if (!url) return null;
  const cached = _sb.get(sport);
  if (cached && Date.now() - cached.ts < SB_TTL) return cached.events;
  if (_inflight.has(sport)) return _inflight.get(sport);
  const p = (async () => {
    try {
      const res = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const events = res.data?.events || [];
      _sb.set(sport, { ts: Date.now(), events });
      return events;
    } catch (e) {
      const stale = _sb.get(sport);   // serve stale on a transient error
      return stale ? stale.events : null;
    } finally {
      _inflight.delete(sport);
    }
  })();
  _inflight.set(sport, p);
  return p;
}

function athleteName(o) { return o?.athlete?.shortName || o?.athlete?.displayName || null; }

// Fresh live state for one game from the cached scoreboard, or null if not found.
async function getLiveState(sport, espnGameId) {
  const sp = String(sport || '').toUpperCase();
  const events = await fetchScoreboard(sp);
  if (!events) return null;
  const ev = events.find(e => String(e.id) === String(espnGameId));
  if (!ev) return null;
  const comp = (ev.competitions || [])[0];
  if (!comp) return null;

  const stType = comp.status?.type || {};
  const competitors = comp.competitors || [];
  const homeC = competitors.find(c => c.homeAway === 'home');
  const awayC = competitors.find(c => c.homeAway === 'away');
  const detail = stType.shortDetail || stType.detail || null;

  const out = {
    status:    stType.state || null,        // 'pre' | 'in' | 'post'
    detail,
    period:    comp.status?.period ?? null,
    clock:     comp.status?.displayClock ?? null,
    homeScore: homeC ? (parseInt(homeC.score, 10) || 0) : null,
    awayScore: awayC ? (parseInt(awayC.score, 10) || 0) : null,
  };

  if (sp === 'MLB') {
    const sit = comp.situation || {};
    out.inning     = comp.status?.period ?? null;
    out.half       = /bot/i.test(detail || '') ? 'bot' : (/top/i.test(detail || '') ? 'top' : null);
    out.outs       = (typeof sit.outs === 'number') ? sit.outs : null;
    out.bases      = (sit.onFirst ? 1 : 0) | (sit.onSecond ? 2 : 0) | (sit.onThird ? 4 : 0);
    out.balls      = (typeof sit.balls === 'number') ? sit.balls : null;
    out.strikes    = (typeof sit.strikes === 'number') ? sit.strikes : null;
    out.batter     = athleteName(sit.batter);
    out.batterLine = sit.batter?.summary || null;
    out.pitcher    = athleteName(sit.pitcher);
    out.pitcherLine = sit.pitcher?.summary || null;
    out.dueUp      = Array.isArray(sit.dueUp) ? sit.dueUp.map(athleteName).filter(Boolean).slice(0, 3) : [];
    out.lastPlay   = sit.lastPlay?.text || null;
  }
  return out;
}

// EMA continuity store for the value pulse (per game+pick).
function prevPulseMag(key) {
  const e = _ema.get(key);
  return (e && Date.now() - e.ts < EMA_TTL) ? e.m : null;
}
function savePulseMag(key, m) { _ema.set(key, { m, ts: Date.now() }); }

// Periodic prune (unref so it never holds the process open).
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of _ema) if (now - e.ts > EMA_TTL) _ema.delete(k);
  for (const [k, e] of _sb)  if (now - e.ts > 60 * 60_000) _sb.delete(k);
}, EMA_TTL).unref();

module.exports = { getLiveState, prevPulseMag, savePulseMag, SCOREBOARD };
