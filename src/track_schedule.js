// src/track_schedule.js — Bet-tracking's OWN upcoming/past-games schedule.
//
// Deliberately SEPARATE from the capper game pipeline (espn_live.js / today_games /
// forward_games.js). It does not read or write today_games, touches no scoring, MVP,
// or leaderboard code, and uses zero Odds API credits. Its only job: let the
// "Track a Bet -> From a game" betslip show games on any day (a week back to a week
// ahead) and across MORE sports than the capper tracks, so a user can log a bet on
// them. Games we have a real line for are verifiable; the rest are custom-only.
//
// Mounted in index.js: app.use('/api/track', require('./src/track_schedule')).

const axios   = require('axios');
const express = require('express');
const router  = express.Router();

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// All the ESPN free scoreboards we can offer in the betslip. Each entry maps an ESPN
// league path to the sport LABEL we show. Several soccer leagues roll up to "Soccer".
// (Boxing has no public ESPN scoreboard; Tennis/Golf are per-player/field and handled
// by the existing today feed, so they're left out of this multi-sport pull.)
const SPORT_FEEDS = [
  { sport: 'MLB',    path: 'baseball/mlb' },
  { sport: 'NBA',    path: 'basketball/nba' },
  { sport: 'WNBA',   path: 'basketball/wnba' },
  { sport: 'NHL',    path: 'hockey/nhl' },
  { sport: 'NFL',    path: 'americanfootball/nfl' },
  { sport: 'NCAAF',  path: 'americanfootball/college-football' },
  { sport: 'CBB',    path: 'basketball/mens-college-basketball' },
  { sport: 'WCBB',   path: 'basketball/womens-college-basketball' },
  { sport: 'UFC',    path: 'mma/ufc' },
  { sport: 'Soccer', path: 'soccer/eng.1' },          // Premier League
  { sport: 'Soccer', path: 'soccer/usa.1' },          // MLS
  { sport: 'Soccer', path: 'soccer/uefa.champions' }, // Champions League
  { sport: 'Soccer', path: 'soccer/esp.1' },          // La Liga
  { sport: 'Soccer', path: 'soccer/ita.1' },          // Serie A
  { sport: 'Soccer', path: 'soccer/ger.1' },          // Bundesliga
  { sport: 'Soccer', path: 'soccer/eng.fa' },         // FA Cup
];

const TTL_MS = 10 * 60 * 1000;
const _cache = new Map(); // `${path}:${yyyymmdd}` -> { ts, games }

function competitorName(c) {
  return c?.athlete?.displayName || c?.team?.displayName || c?.team?.shortDisplayName || c?.team?.name || 'TBD';
}

// One competition -> one trackable game. Handles team/soccer (home/away) AND combat
// sports / matchups with no homeAway flag (just two competitors).
function compToGame(comp, ev, sport) {
  const cs = comp?.competitors || [];
  if (cs.length < 2) return null;
  let home = cs.find(c => c.homeAway === 'home');
  let away = cs.find(c => c.homeAway === 'away');
  if (!home || !away) { away = cs[0]; home = cs[1]; } // combat/matchup: order as listed
  return {
    espn_game_id: String(comp?.id || ev?.id),
    sport,
    home_team: competitorName(home),
    away_team: competitorName(away),
    start_time: comp?.date || ev?.date || null,
    status: comp?.status?.type?.state || ev?.status?.type?.state || 'pre',
  };
}

// An ESPN event is usually one game, but a fight card (MMA) is one event with many
// fights (competitions) -> expand each into its own row.
function eventToGames(ev, sport) {
  return (ev?.competitions || []).map(c => compToGame(c, ev, sport)).filter(Boolean);
}

async function fetchFeedDate(feed, yyyymmdd) {
  const key = `${feed.path}:${yyyymmdd}`;
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.ts) < TTL_MS) return hit.games;
  let games = [];
  try {
    const res = await axios.get(`${ESPN_BASE}/${feed.path}/scoreboard?dates=${yyyymmdd}`, { timeout: 9000 });
    games = (res.data?.events || []).flatMap(ev => eventToGames(ev, feed.sport));
  } catch (_) { games = []; }
  _cache.set(key, { ts: Date.now(), games });
  return games;
}

// GET /api/track/schedule?date=YYYYMMDD -> { date, games:[...] } across all sports.
// Finished games are kept too (past days are for logging custom bets on games that
// already happened). De-duped by espn_game_id in case a soccer match appears in two
// competitions.
router.get('/schedule', async (req, res) => {
  const raw = String(req.query.date || '').replace(/[^0-9]/g, '');
  if (!/^\d{8}$/.test(raw)) return res.status(400).json({ error: 'Provide ?date=YYYYMMDD.' });
  try {
    const per = await Promise.all(SPORT_FEEDS.map(f => fetchFeedDate(f, raw)));
    const seen = new Set();
    const games = per.flat()
      .filter(g => { if (seen.has(g.espn_game_id)) return false; seen.add(g.espn_game_id); return true; })
      .sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));
    res.json({ date: raw, games });
  } catch (_) {
    res.status(500).json({ error: 'Could not load the schedule.' });
  }
});

module.exports = router;
