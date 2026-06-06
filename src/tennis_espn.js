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

// ── Country flag from an ESPN athlete object ──────────────────────────────────
// athlete.flag = { href: '.../countries/500/chn.png', alt: 'China', rel: [...] }
// Returns { href, code } where code is the 3-letter country code parsed from the URL
// (e.g. 'chn'), used to color the gauges by country.
function flagInfo(athlete) {
  const href = athlete?.flag?.href || null;
  if (!href) return { href: null, code: null };
  const m = href.match(/\/([a-z]{2,3})\.(?:png|svg)(?:\?|$)/i);
  return { href, code: m ? m[1].toLowerCase() : null };
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

  // Skip future-round bracket slots whose players are not yet determined — ESPN
  // returns these as "TBD". They would otherwise flood today_games with empty
  // "TBD vs TBD" rows and crowd out the real matches on the home/schedule views.
  const _isTbd = (n) => n.trim().toUpperCase() === 'TBD';
  if (_isTbd(homeDisplay) || _isTbd(awayDisplay)) return;

  // Status gate: only treat a match as 'post' (gradeable) when ESPN flags it truly
  // completed. Postponed / suspended / canceled / delayed matches can carry state='post'
  // with zero or partial games — those must NOT enter the grading query. Downgrade them
  // so results.js never grades an unplayed match (see Jodar vs Zverev postponement).
  const stType    = comp.status?.type || {};
  const rawState  = stType.state || 'pre';
  const completed = stType.completed === true;
  const statusNm  = (stType.name || stType.description || '').toLowerCase();
  const notFinal  = /postpone|suspend|cancel|delay|rain|abandon/.test(statusNm);
  let state;
  if (rawState === 'post') {
    // 'post' only stands when ESPN confirms completion and it isn't a postponed marker
    state = (completed && !notFinal) ? 'post' : (notFinal ? 'pre' : 'in');
  } else {
    state = rawState;
  }
  const homeLinescores = homeComp.linescores || [];
  const awayLinescores = awayComp.linescores || [];

  // Sets won = count of sets where this player won more games
  const numSets = Math.max(homeLinescores.length, awayLinescores.length);
  let homeSetsWon = 0, awaySetsWon = 0;
  const setDetails = [];
  for (let i = 0; i < numSets; i++) {
    const h = Number(homeLinescores[i]?.value) || 0;
    const a = Number(awayLinescores[i]?.value) || 0;
    setDetails.push({ set: i + 1, home: h, away: a });
    if (h > a) homeSetsWon++;
    else if (a > h) awaySetsWon++;
  }

  // Total games for spread/O-U grading
  const homeGames = homeLinescores.reduce((s, l) => s + (Number(l.value) || 0), 0);
  const awayGames = awayLinescores.reduce((s, l) => s + (Number(l.value) || 0), 0);

  // Score detail string e.g. "7-5, 6-4" (home perspective)
  const scoreDetailJson = numSets > 0 ? JSON.stringify(setDetails) : null;

  // Country flags (for avatars + gauge colors)
  const homeFlag = flagInfo(homeAth);
  const awayFlag = flagInfo(awayAth);

  db.prepare(`
    INSERT INTO today_games (
      espn_game_id, sport, status, period, clock, start_time,
      home_score, away_score,
      home_team, home_short, home_name, home_abbr,
      away_team, away_short, away_name, away_abbr,
      tennis_home_games, tennis_away_games, tennis_score_detail,
      home_flag, away_flag, home_country, away_country,
      fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(espn_game_id) DO UPDATE SET
      status               = excluded.status,
      period               = excluded.period,
      clock                = excluded.clock,
      -- Tennis start times shift all day (matches are "not before" / follow the
      -- previous match on court). ESPN firms them up over time, so always take the
      -- freshest value. COALESCE guards against a rare null wiping a good time.
      start_time           = COALESCE(excluded.start_time, today_games.start_time),
      home_team            = excluded.home_team,
      home_short           = excluded.home_short,
      home_name            = excluded.home_name,
      home_abbr            = excluded.home_abbr,
      away_team            = excluded.away_team,
      away_short           = excluded.away_short,
      away_name            = excluded.away_name,
      away_abbr            = excluded.away_abbr,
      home_score           = excluded.home_score,
      away_score           = excluded.away_score,
      tennis_home_games    = excluded.tennis_home_games,
      tennis_away_games    = excluded.tennis_away_games,
      tennis_score_detail  = excluded.tennis_score_detail,
      home_flag            = COALESCE(excluded.home_flag, today_games.home_flag),
      away_flag            = COALESCE(excluded.away_flag, today_games.away_flag),
      home_country         = COALESCE(excluded.home_country, today_games.home_country),
      away_country         = COALESCE(excluded.away_country, today_games.away_country),
      fetched_at           = excluded.fetched_at
  `).run(
    comp.id,
    sportLabel,
    state,
    comp.status?.period                                   || null,
    comp.status?.type?.shortDetail || comp.status?.displayClock || null,
    comp.date || comp.startDate                           || null,
    homeSetsWon,
    awaySetsWon,
    homeDisplay,
    playerShortName(homeDisplay),
    playerShortName(homeDisplay),
    playerAbbr(homeDisplay),
    awayDisplay,
    playerShortName(awayDisplay),
    playerShortName(awayDisplay),
    playerAbbr(awayDisplay),
    homeGames || null,
    awayGames || null,
    scoreDetailJson,
    homeFlag.href,
    awayFlag.href,
    homeFlag.code,
    awayFlag.code
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
  const todayET = getCycleDate();              // YYYY-MM-DD
  const dateStr = todayET.replace(/-/g, '');   // YYYYMMDD

  let total = 0;
  for (const { path, label } of TENNIS_SPORTS) {
    try {
      // ESPN returns the ENTIRE tournament draw (every round, every date) for a
      // Grand Slam regardless of the dates= param, so filter down to matches that
      // are still relevant today: drop earlier rounds that already finished on a
      // prior day. Keep today's matches and anything not yet completed (which
      // includes carried-over postponed matches that haven't been graded).
      const events = await fetchScoreboardForDate(path, dateStr);
      let count = 0;
      for (const tournament of events) {
        for (const comp of extractMatches(tournament)) {
          const compDate  = (comp.date || '').slice(0, 10);
          const completed = comp.status?.type?.completed === true;
          if (completed && compDate && compDate < todayET) continue;
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

// ── Refresh start times for ALL of today's tennis matches ────────────────────
// Tennis start times are the least stable field we store: matches are scheduled
// "not before X" or "follows previous match on court", so the time captured at
// 5am (often a 00:00 placeholder that renders as 12:00 AM) goes stale fast.
// updateTennisLiveScores() only touches matches that already have a pick, so the
// rest of the schedule never gets corrected. This re-pulls the ATP + WTA
// scoreboards and upserts every today/uncompleted singles match, refreshing
// start_time (plus status/clock/scores) for the whole schedule, picked or not.
// Free (ESPN), no Odds API credits. Run on a short cron so times stay accurate.
async function refreshTennisStartTimes() {
  const todayET = getCycleDate();
  const dateStr = todayET.replace(/-/g, '');

  let refreshed = 0;
  for (const { path, label } of TENNIS_SPORTS) {
    try {
      const events = await fetchScoreboardForDate(path, dateStr);
      for (const tournament of events) {
        for (const comp of extractMatches(tournament)) {
          const compDate  = (comp.date || '').slice(0, 10);
          const completed = comp.status?.type?.completed === true;
          // Skip matches already finished on a prior day — nothing to refresh.
          if (completed && compDate && compDate < todayET) continue;
          upsertTennisMatch(comp, label);
          refreshed++;
        }
      }
    } catch (err) {
      console.warn(`[tennis_espn] refreshTennisStartTimes(${label}) error:`, err.message);
    }
  }
  if (refreshed > 0) console.log(`[tennis_espn] refreshTennisStartTimes: ${refreshed} matches refreshed`);
  return refreshed;
}

// ── Update live scores for in-progress tennis matches ────────────────────────
// Called every 5 min alongside espn_live.updateLiveScores().
// Only refreshes games that have picks today — same pattern as espn_live.
async function updateTennisLiveScores() {
  // Find tennis game IDs that still have an ungraded pick. Includes carried-over
  // (postponed) picks from a prior cycle so they update the day they actually play,
  // not just at the next 5am full fetch.
  const topGames = db.prepare(`
    SELECT DISTINCT p.espn_game_id
    FROM picks p
    INNER JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
    WHERE p.espn_game_id IS NOT NULL
      AND p.mention_count > 0
      AND p.result = 'pending'
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

module.exports = { fetchTodaysTennisMatches, updateTennisLiveScores, refreshTennisStartTimes };
