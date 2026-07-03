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
  { sport: 'Soccer', path: 'soccer/fifa.world' },     // World Cup
  { sport: 'Soccer', path: 'soccer/eng.1' },          // Premier League
  { sport: 'Soccer', path: 'soccer/usa.1' },          // MLS
  { sport: 'Soccer', path: 'soccer/uefa.champions' }, // Champions League
  { sport: 'Soccer', path: 'soccer/uefa.europa' },    // Europa League
  { sport: 'Soccer', path: 'soccer/esp.1' },          // La Liga
  { sport: 'Soccer', path: 'soccer/ita.1' },          // Serie A
  { sport: 'Soccer', path: 'soccer/ger.1' },          // Bundesliga
  { sport: 'Soccer', path: 'soccer/fra.1' },          // Ligue 1
  { sport: 'Soccer', path: 'soccer/mex.1' },          // Liga MX
  { sport: 'Soccer', path: 'soccer/ned.1' },          // Eredivisie
  { sport: 'Soccer', path: 'soccer/por.1' },          // Primeira Liga
  { sport: 'Soccer', path: 'soccer/conmebol.america' }, // Copa America
  { sport: 'Soccer', path: 'soccer/eng.fa' },         // FA Cup
  // Racing is event-style (a field of drivers, not two sides) -> one row per race,
  // custom-only in the betslip.
  { sport: 'F1',      path: 'racing/f1',             event: true },
  { sport: 'NASCAR',  path: 'racing/nascar-premier', event: true },
  { sport: 'Rugby',   path: 'rugby/267979' },        // English Premiership
  { sport: 'Rugby',   path: 'rugby/242041' },        // Super Rugby
  { sport: 'Cricket', path: 'cricket/8039' },        // international slate
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

// Racing: the "competitors" are a whole field of drivers, so the trackable unit is
// the race itself. One row per event; away_team stays empty and the frontend shows
// just the race name.
function eventToRaceRow(ev, sport) {
  if (!ev) return null;
  return {
    espn_game_id: String(ev.id),
    sport,
    home_team: ev.shortName || ev.name || 'Race',
    away_team: '',
    start_time: ev.date || null,
    status: ev.status?.type?.state || 'pre',
  };
}

async function fetchFeedDate(feed, yyyymmdd) {
  const key = `${feed.path}:${yyyymmdd}`;
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.ts) < TTL_MS) return hit.games;
  let games = [];
  try {
    const res = await axios.get(`${ESPN_BASE}/${feed.path}/scoreboard?dates=${yyyymmdd}`, { timeout: 9000 });
    games = feed.event
      ? (res.data?.events || []).map(ev => eventToRaceRow(ev, feed.sport)).filter(Boolean)
      : (res.data?.events || []).flatMap(ev => eventToGames(ev, feed.sport));
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
      .concat(engineEventsFor(raw))
      .sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));
    res.json({ date: raw, games });
  } catch (_) {
    res.status(500).json({ error: 'Could not load the schedule.' });
  }
});

// Boxing + non-UFC MMA cards relayed by the odds engine (no ESPN scoreboard exists
// for them). Custom-only rows with synthetic ids so nothing collides with ESPN's.
function engineEventsFor(yyyymmdd) {
  const dayIso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  try {
    const db = require('./db');
    // The user picks an ET day; start_time is stored as UTC ISO. A 11:30pm ET
    // fight is the NEXT UTC date, so match on the ET day's UTC window instead of
    // the UTC date substring (ET_OFFSET_MS handles DST).
    const { ET_OFFSET_MS } = require('./cycle');
    const startUtc = new Date(Date.parse(`${dayIso}T00:00:00Z`) + ET_OFFSET_MS).toISOString();
    const endUtc   = new Date(Date.parse(`${dayIso}T00:00:00Z`) + ET_OFFSET_MS + 24 * 3600 * 1000).toISOString();
    return db.prepare(
      `SELECT id, sport, home_team, away_team, start_time FROM engine_events
       WHERE start_time >= ? AND start_time < ?`
    ).all(startUtc, endUtc).map(e => ({
      espn_game_id: `eng-${e.id}`,
      sport: e.sport,
      home_team: e.home_team,
      away_team: e.away_team,
      start_time: e.start_time,
      status: 'pre',
    }));
  } catch (_) { return []; }
}

module.exports = router;
