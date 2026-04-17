// src/tennis_espn.js
// Tennis-specific ESPN fetcher for ATP and WTA main-tour matches.
// Writes into today_games exactly like espn_live.js does for team sports.
// Called at 5am (fetchTodaysTennisMatches) and every 5 min (updateTennisLiveScores).
//
// TEMPLATE: Copy this file to add another individual-sport (Golf, MMA, Boxing).
// Change TENNIS_SPORTS paths, update upsertTennisMatch if field names differ.

const axios         = require('axios');
const db            = require('./db');
const { getCycleDate } = require('./cycle');
const { fetchScoreboardForDate } = require('./espn_live');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// ── ATP + WTA main tour paths ─────────────────────────────────────────────────
const TENNIS_SPORTS = [
  { path: 'tennis/atp', label: 'ATP' },
  { path: 'tennis/wta', label: 'WTA' },
];


// ── Build short name + abbreviation from full player name ─────────────────────
// "Novak Djokovic" → short="Djokovic", abbr="DJO"
function playerShortName(displayName) {
  if (!displayName) return null;
  const parts = displayName.trim().split(/\s+/);
  return parts[parts.length - 1];
}

function playerAbbr(displayName) {
  if (!displayName) return null;
  const short = playerShortName(displayName);
  return short ? short.slice(0, 3).toUpperCase() : null;
}

// ── Upsert a single tennis match into today_games ────────────────────────────
// Accepts a competition object from ev.groupings[n].competitions[m].
// Uses athlete.displayName instead of team.displayName (tennis has no teams).
function upsertTennisMatch(comp, sportLabel) {
  const homeComp = comp.competitors?.find(c => c.homeAway === 'home') || comp.competitors?.[0] || {};
  const awayComp = comp.competitors?.find(c => c.homeAway === 'away') || comp.competitors?.[1] || {};

  // Athletes (tennis players)
  const homeAth = homeComp.athlete || {};
  const awayAth = awayComp.athlete || {};

  const homeDisplay = homeAth.displayName || homeAth.fullName || homeComp.team?.displayName || null;
  const awayDisplay = awayAth.displayName || awayAth.fullName || awayComp.team?.displayName || null;

  if (!homeDisplay || !awayDisplay) {
    console.warn(`[tennis_espn] Skipping match ${comp.id} — missing player names`);
    return;
  }

  const state = comp.status?.type?.state || 'pre';
  const scores = comp.competitors?.map(c => {
    const sets = (c.linescores || []).reduce((sum, s) => sum + (Number(s.value) || 0), 0);
    return { homeAway: c.homeAway, sets };
  }) || [];
  const homeScore = scores.find(s => s.homeAway === 'home')?.sets ?? 0;
  const awayScore = scores.find(s => s.homeAway === 'away')?.sets ?? 0;

  db.prepare(`
    INSERT INTO today_games (
      espn_game_id, sport, status, period, clock, start_time,
      home_score, away_score,
      home_team, home_short, home_name, home_abbr,
      away_team, away_short, away_name, away_abbr,
      fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(espn_game_id) DO UPDATE SET
      status     = excluded.status,
      period     = excluded.period,
      clock      = excluded.clock,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      fetched_at = excluded.fetched_at
  `).run(
    comp.id,
    sportLabel,
    state,
    comp.status?.period                                   || null,
    comp.status?.type?.shortDetail || comp.status?.displayClock || null,
    comp.date || comp.startDate                           || null,
    homeScore,
    awayScore,
    homeDisplay,
    playerShortName(homeDisplay),
    playerShortName(homeDisplay),
    playerAbbr(homeDisplay),
    awayDisplay,
    playerShortName(awayDisplay),
    playerShortName(awayDisplay),
    playerAbbr(awayDisplay)
  );
}

// ── Extract individual match competitions from a tournament event ─────────────
// ATP/WTA scoreboard returns tournaments with matches nested in groupings.
// Only singles groupings are returned (skip doubles).
function extractMatches(tournamentEvent) {
  const matches = [];
  for (const g of (tournamentEvent.groupings || [])) {
    const slug = (g.grouping?.slug || '').toLowerCase();
    if (slug.includes('double')) continue; // skip doubles
    for (const comp of (g.competitions || [])) {
      matches.push(comp);
    }
  }
  return matches;
}

// ── Fetch today's ATP + WTA matches, upsert into today_games ─────────────────
async function fetchTodaysTennisMatches() {
  const dateStr = getCycleDate().replace(/-/g, ''); // YYYYMMDD

  let total = 0;
  for (const { path, label } of TENNIS_SPORTS) {
    try {
      const events = await fetchScoreboardForDate(path, dateStr);
      let count = 0;
      for (const tournament of events) {
        for (const comp of extractMatches(tournament)) {
          upsertTennisMatch(comp, label);
          count++;
        }
      }
      if (count > 0) {
        console.log(`[tennis_espn] today_games: ${count} ${label} matches upserted`);
      }
      total += count;
    } catch (err) {
      console.warn(`[tennis_espn] fetchTodaysTennisMatches(${label}) error:`, err.message);
    }
  }
  console.log(`[tennis_espn] fetchTodaysTennisMatches complete: ${total} total matches`);
  return total;
}

// ── Update live scores for in-progress tennis matches ────────────────────────
// Called every 5 min alongside espn_live.updateLiveScores().
// Only refreshes games that have picks today — same pattern as espn_live.
async function updateTennisLiveScores() {
  // Find tennis game IDs that have picks today
  const topGames = db.prepare(`
    SELECT DISTINCT p.espn_game_id
    FROM picks p
    INNER JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
    WHERE p.game_date = (SELECT MAX(game_date) FROM picks)
      AND p.espn_game_id IS NOT NULL
      AND p.mention_count > 0
      AND tg.sport IN ('ATP', 'WTA')
  `).all().map(r => r.espn_game_id);

  if (!topGames.length) return;

  const dateStr = getCycleDate().replace(/-/g, '');

  for (const { path, label } of TENNIS_SPORTS) {
    try {
      const events = await fetchScoreboardForDate(path, dateStr);
      for (const tournament of events) {
        for (const comp of extractMatches(tournament)) {
          if (!topGames.includes(comp.id)) continue;
          upsertTennisMatch(comp, label);
        }
      }
    } catch (err) {
      console.warn(`[tennis_espn] updateTennisLiveScores(${label}) error:`, err.message);
    }
  }
}

module.exports = { fetchTodaysTennisMatches, updateTennisLiveScores };
