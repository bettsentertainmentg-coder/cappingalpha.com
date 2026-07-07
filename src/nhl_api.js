// src/nhl_api.js
// Free official NHL API (api-web.nhle.com, no auth) — fills the gaps ESPN
// leaves for hockey: shots on goal, power-play state, scoring summary, three
// stars. ESPN's NHL summary has no win probability and unreliable coordinates,
// so the tracker leans on this for the hockey scorebug + feed extras.
//
// ESPN game ids and NHL game ids are unrelated: games are matched by date +
// team abbreviations (with an alias map for the few that differ). All fetches
// are cached + in-flight collapsed; every export is null-safe so the tracker
// renders fine without it.

const axios = require('axios');

const BASE = 'https://api-web.nhle.com/v1';
const LIVE_TTL  = 20_000;        // pbp/landing cache while watching
const DAY_TTL   = 10 * 60_000;   // score-by-date cache (id mapping)

// ESPN abbreviation -> NHL abbreviation, where they differ.
const ABBR_ALIAS = { TB: 'TBL', LA: 'LAK', SJ: 'SJS', NJ: 'NJD', MON: 'MTL', WAS: 'WSH' };
const nhlAbbr = (a) => ABBR_ALIAS[String(a || '').toUpperCase()] || String(a || '').toUpperCase();

const _days   = new Map();   // 'YYYY-MM-DD' -> { ts, games }
const _idMap  = new Map();   // espn_game_id -> nhl game id (resolved once)
const _live   = new Map();   // nhl id -> { ts, data }
const _inflight = new Map();

async function _get(url) {
  const res = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  return res.data;
}

async function _scoresFor(dateYMD) {
  const hit = _days.get(dateYMD);
  if (hit && Date.now() - hit.ts < DAY_TTL) return hit.games;
  try {
    const data = await _get(`${BASE}/score/${dateYMD}`);
    const games = data?.games || [];
    _days.set(dateYMD, { ts: Date.now(), games });
    return games;
  } catch (_) { return hit ? hit.games : []; }
}

function _ymdShift(iso, days) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Resolve the NHL game id for a today_games row (date + abbr match). NHL's
// schedule dates are US-local, so the UTC date and the prior day are both
// checked (a 7pm ET start is next-day UTC).
async function getNhlGameId(game) {
  const key = String(game.espn_game_id);
  if (_idMap.has(key)) return _idMap.get(key);
  const home = nhlAbbr(game.home_abbr), away = nhlAbbr(game.away_abbr);
  if (!home || !away || !game.start_time) return null;
  for (const shift of [0, -1]) {
    const ymd = _ymdShift(game.start_time, shift);
    if (!ymd) continue;
    const games = await _scoresFor(ymd);
    const hit = games.find(g =>
      String(g.homeTeam?.abbrev || '').toUpperCase() === home &&
      String(g.awayTeam?.abbrev || '').toUpperCase() === away);
    if (hit) { _idMap.set(key, hit.id); return hit.id; }
  }
  return null;   // ambiguity / not found: skip quietly (tracker works without)
}

// situationCode digits: [awayGoalie][awaySkaters][homeSkaters][homeGoalie].
// "1551" = even strength; "1451" = home power play; goalie 0 = empty net.
function parseStrength(code) {
  const s = String(code || '');
  if (s.length !== 4) return null;
  const aG = +s[0], aS = +s[1], hS = +s[2], hG = +s[3];
  if (aG === 0 || hG === 0) return 'en';
  if (hS > aS) return 'pp-home';
  if (aS > hS) return 'pp-away';
  return 'ev';
}

const starName = (p) => p?.name?.default || p?.name || null;

// Live hockey extras for one game, or null. Shape:
// { homeSOG, awaySOG, strength, scoring: [{period, time, team, scorer, assists, shotType}],
//   threeStars: [{star, name, team, position, headshot}] }
async function getNhlLive(game) {
  try {
    const nhlId = await getNhlGameId(game);
    if (!nhlId) return null;
    const hit = _live.get(nhlId);
    if (hit && Date.now() - hit.ts < LIVE_TTL) return hit.data;
    if (_inflight.has(nhlId)) return _inflight.get(nhlId);

    const p = (async () => {
      try {
        const [pbp, landing] = await Promise.all([
          _get(`${BASE}/gamecenter/${nhlId}/play-by-play`).catch(() => null),
          _get(`${BASE}/gamecenter/${nhlId}/landing`).catch(() => null),
        ]);
        const plays = pbp?.plays || [];
        let homeSOG = null, awaySOG = null, strength = null;
        for (let i = plays.length - 1; i >= 0; i--) {
          const d = plays[i]?.details;
          if (homeSOG == null && d && typeof d.homeSOG === 'number') { homeSOG = d.homeSOG; awaySOG = d.awaySOG ?? awaySOG; }
          if (strength == null && plays[i]?.situationCode) strength = parseStrength(plays[i].situationCode);
          if (homeSOG != null && strength != null) break;
        }
        const scoring = [];
        for (const per of (landing?.summary?.scoring || [])) {
          for (const g of (per.goals || [])) {
            scoring.push({
              period:  per.periodDescriptor?.number ?? null,
              time:    g.timeInPeriod || null,
              team:    g.teamAbbrev?.default || g.teamAbbrev || null,
              scorer:  starName(g) || [g.firstName?.default, g.lastName?.default].filter(Boolean).join(' ') || null,
              assists: (g.assists || []).map(a => starName(a)).filter(Boolean),
              shotType: g.shotType || null,
            });
          }
        }
        const threeStars = (landing?.summary?.threeStars || []).map(s => ({
          star: s.star, name: starName(s), team: s.teamAbbrev || null,
          position: s.position || null, headshot: s.headshot || null,
        }));
        const data = { homeSOG, awaySOG, strength, scoring: scoring.slice(-12), threeStars };
        _live.set(nhlId, { ts: Date.now(), data });
        return data;
      } catch (_) {
        const stale = _live.get(nhlId);
        return stale ? stale.data : null;
      } finally {
        _inflight.delete(nhlId);
      }
    })();
    _inflight.set(nhlId, p);
    return p;
  } catch (_) { return null; }
}

// Prune (unref so it never holds the process open).
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of _days) if (now - e.ts > 60 * 60_000) _days.delete(k);
  for (const [k, e] of _live) if (now - e.ts > 60 * 60_000) _live.delete(k);
}, 10 * 60_000).unref();

module.exports = { getNhlLive, getNhlGameId, parseStrength };
