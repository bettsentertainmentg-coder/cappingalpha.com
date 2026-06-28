// src/track_schedule.js — Bet-tracking's OWN upcoming-games schedule.
//
// Deliberately SEPARATE from the capper game pipeline (espn_live.js / today_games /
// forward_games.js). It does not read or write today_games, touches no scoring, MVP,
// or leaderboard code, and uses zero Odds API credits. Its only job: let the
// "Track a Bet -> From a game" betslip show games happening on a FUTURE day so a user
// can log a CUSTOM bet on them. Future-day games have no betting lines (the Odds API
// is today-only), so they are custom-only: no odds board, no verified tracking, no
// leaderboard impact. "Today" is still served by the existing /api/games path.
//
// Mounted in index.js: app.use('/api/track', require('./src/track_schedule')).

const axios   = require('axios');
const express = require('express');
const router  = express.Router();

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// Team sports with a clean home/away scoreboard. Tennis and Golf are intentionally
// excluded from the week-ahead view: their scoreboards are per-player/per-field and
// they are already covered for "today" by the existing pipeline.
const LEAGUE_PATH = {
  MLB:   'baseball/mlb',
  NBA:   'basketball/nba',
  WNBA:  'basketball/wnba',
  NHL:   'hockey/nhl',
  NFL:   'americanfootball/nfl',
  NCAAF: 'americanfootball/college-football',
  CBB:   'basketball/mens-college-basketball',
};

// Per (sport,date) in-memory cache. ESPN schedules barely change, so 10 min is plenty
// and keeps us well clear of any rate concerns even with several users browsing days.
const TTL_MS = 10 * 60 * 1000;
const _cache = new Map(); // `${sport}:${yyyymmdd}` -> { ts, games }

function normalizeEvent(ev, sport) {
  try {
    const comp = (ev.competitions || [])[0];
    if (!comp) return null;
    const cs = comp.competitors || [];
    const home = cs.find(c => c.homeAway === 'home');
    const away = cs.find(c => c.homeAway === 'away');
    if (!home || !away) return null;
    return {
      espn_game_id: String(ev.id),
      sport,
      home_team: home.team?.displayName || home.team?.shortDisplayName || home.team?.name || 'Home',
      away_team: away.team?.displayName || away.team?.shortDisplayName || away.team?.name || 'Away',
      start_time: ev.date || null,
      status: ev.status?.type?.state || 'pre',
    };
  } catch (_) { return null; }
}

async function fetchSportDate(sport, yyyymmdd) {
  const key = `${sport}:${yyyymmdd}`;
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.ts) < TTL_MS) return hit.games;
  let games = [];
  try {
    const res = await axios.get(`${ESPN_BASE}/${LEAGUE_PATH[sport]}/scoreboard?dates=${yyyymmdd}`, { timeout: 9000 });
    games = (res.data?.events || []).map(ev => normalizeEvent(ev, sport)).filter(Boolean);
  } catch (_) { games = []; }
  _cache.set(key, { ts: Date.now(), games });
  return games;
}

// GET /api/track/schedule?date=YYYYMMDD -> { date, games:[...] } for that single date.
router.get('/schedule', async (req, res) => {
  const raw = String(req.query.date || '').replace(/[^0-9]/g, '');
  if (!/^\d{8}$/.test(raw)) return res.status(400).json({ error: 'Provide ?date=YYYYMMDD.' });
  try {
    const per = await Promise.all(Object.keys(LEAGUE_PATH).map(s => fetchSportDate(s, raw)));
    // Keep finished games too: past days are for logging custom bets on games that
    // already happened (the user knows the result and settles it themselves).
    const games = per.flat()
      .sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));
    res.json({ date: raw, games });
  } catch (_) {
    res.status(500).json({ error: 'Could not load the schedule.' });
  }
});

module.exports = router;
