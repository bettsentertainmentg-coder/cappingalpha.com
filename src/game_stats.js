// src/game_stats.js
// On-demand ESPN event summary + OpenMeteo weather for the game detail popup.
// Do not import or modify espn_live.js.

const axios = require('axios');

// ── Sport → ESPN league path ──────────────────────────────────────────────────
const LEAGUE_PATH = {
  MLB:   'baseball/mlb',
  NBA:   'basketball/nba',
  NHL:   'hockey/nhl',
  NFL:   'americanfootball/nfl',
  NCAAF: 'americanfootball/college-football',
  CBB:   'basketball/mens-college-basketball',
  WCBB:  'basketball/womens-college-basketball',
  ATP:   'tennis/atp',
  WTA:   'tennis/wta',
};

// Outdoor sports that warrant weather data
const OUTDOOR_SPORTS = new Set(['MLB', 'NFL', 'NCAAF']);

// ── Static stadium coordinates (home_team full name → {lat, lng}) ─────────────
const STADIUM_COORDS = {
  // MLB
  'New York Yankees':      { lat: 40.8296,  lng: -73.9262 },
  'Boston Red Sox':        { lat: 42.3467,  lng: -71.0972 },
  'Los Angeles Dodgers':   { lat: 34.0739,  lng: -118.2400 },
  'San Francisco Giants':  { lat: 37.7786,  lng: -122.3893 },
  'Chicago Cubs':          { lat: 41.9484,  lng: -87.6553 },
  'Chicago White Sox':     { lat: 41.8300,  lng: -87.6338 },
  'Houston Astros':        { lat: 29.7573,  lng: -95.3555 },
  'Atlanta Braves':        { lat: 33.8908,  lng: -84.4678 },
  'Philadelphia Phillies': { lat: 39.9056,  lng: -75.1665 },
  'New York Mets':         { lat: 40.7571,  lng: -73.8458 },
  'St. Louis Cardinals':   { lat: 38.6226,  lng: -90.1928 },
  'Milwaukee Brewers':     { lat: 43.0280,  lng: -87.9712 },
  'Cincinnati Reds':       { lat: 39.0979,  lng: -84.5082 },
  'Pittsburgh Pirates':    { lat: 40.4469,  lng: -80.0057 },
  'Cleveland Guardians':   { lat: 41.4962,  lng: -81.6852 },
  'Detroit Tigers':        { lat: 42.3390,  lng: -83.0485 },
  'Minnesota Twins':       { lat: 44.9817,  lng: -93.2776 },
  'Kansas City Royals':    { lat: 39.0517,  lng: -94.4803 },
  'Texas Rangers':         { lat: 32.7473,  lng: -97.0830 },
  'Seattle Mariners':      { lat: 47.5914,  lng: -122.3326 },
  'Oakland Athletics':     { lat: 37.7516,  lng: -122.2005 },
  'Los Angeles Angels':    { lat: 33.8003,  lng: -117.8827 },
  'San Diego Padres':      { lat: 32.7076,  lng: -117.1570 },
  'Colorado Rockies':      { lat: 39.7559,  lng: -104.9942 },
  'Arizona Diamondbacks':  { lat: 33.4453,  lng: -112.0667 },
  'Miami Marlins':         { lat: 25.7781,  lng: -80.2197 },
  'Tampa Bay Rays':        { lat: 27.7682,  lng: -82.6534 },
  'Baltimore Orioles':     { lat: 39.2838,  lng: -76.6218 },
  'Washington Nationals':  { lat: 38.8730,  lng: -77.0074 },
  'Toronto Blue Jays':     { lat: 43.6414,  lng: -79.3894 },
  // NFL
  'Kansas City Chiefs':    { lat: 39.0489,  lng: -94.4839 },
  'Buffalo Bills':         { lat: 42.7738,  lng: -78.7870 },
  'New England Patriots':  { lat: 42.0909,  lng: -71.2643 },
  'Miami Dolphins':        { lat: 25.9580,  lng: -80.2389 },
  'New York Jets':         { lat: 40.8135,  lng: -74.0745 },
  'New York Giants':       { lat: 40.8135,  lng: -74.0745 },
  'Philadelphia Eagles':   { lat: 39.9007,  lng: -75.1675 },
  'Dallas Cowboys':        { lat: 32.7473,  lng: -97.0930 },
  'Washington Commanders': { lat: 38.9078,  lng: -76.8644 },
  'Chicago Bears':         { lat: 41.8623,  lng: -87.6167 },
  'Green Bay Packers':     { lat: 44.5013,  lng: -88.0622 },
  'Minnesota Vikings':     { lat: 44.9736,  lng: -93.2575 },
  'Detroit Lions':         { lat: 42.3400,  lng: -83.0456 },
  'Seattle Seahawks':      { lat: 47.5952,  lng: -122.3316 },
  'San Francisco 49ers':   { lat: 37.4033,  lng: -121.9694 },
  'Los Angeles Rams':      { lat: 33.9535,  lng: -118.3392 },
  'Los Angeles Chargers':  { lat: 33.9535,  lng: -118.3392 },
  'Arizona Cardinals':     { lat: 33.5277,  lng: -112.2626 },
  'Denver Broncos':        { lat: 39.7439,  lng: -105.0201 },
  'Las Vegas Raiders':     { lat: 36.0909,  lng: -115.1833 },
  'Atlanta Falcons':       { lat: 33.7554,  lng: -84.4010 },
  'Carolina Panthers':     { lat: 35.2258,  lng: -80.8528 },
  'New Orleans Saints':    { lat: 29.9511,  lng: -90.0812 },
  'Tampa Bay Buccaneers':  { lat: 27.9759,  lng: -82.5033 },
  'Baltimore Ravens':      { lat: 39.2780,  lng: -76.6227 },
  'Cleveland Browns':      { lat: 41.5061,  lng: -81.6995 },
  'Pittsburgh Steelers':   { lat: 40.4468,  lng: -80.0158 },
  'Cincinnati Bengals':    { lat: 39.0955,  lng: -84.5161 },
  'Indianapolis Colts':    { lat: 39.7601,  lng: -86.1639 },
  'Jacksonville Jaguars':  { lat: 30.3239,  lng: -81.6373 },
  'Tennessee Titans':      { lat: 36.1665,  lng: -86.7713 },
  'Houston Texans':        { lat: 29.6847,  lng: -95.4107 },
};

// ── Weather condition from WMO code ──────────────────────────────────────────
function wmoCondition(code) {
  if (code === 0)                     return 'Clear';
  if (code <= 3)                      return 'Partly Cloudy';
  if (code <= 9)                      return 'Foggy';
  if (code <= 19)                     return 'Drizzle';
  if (code <= 29)                     return 'Rain';
  if (code <= 39)                     return 'Snow';
  if (code <= 49)                     return 'Freezing';
  if (code <= 59)                     return 'Drizzle';
  if (code <= 69)                     return 'Rain';
  if (code <= 79)                     return 'Snow';
  if (code <= 99)                     return 'Thunderstorm';
  return 'Unknown';
}

// ── Fetch weather for outdoor stadiums ───────────────────────────────────────
async function getWeather(lat, lng) {
  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude:             lat,
        longitude:            lng,
        current:              'temperature_2m,windspeed_10m,precipitation,weathercode',
        temperature_unit:     'fahrenheit',
        windspeed_unit:       'mph',
        precipitation_unit:   'inch',
        forecast_days:        1,
      },
      timeout: 8000,
    });
    const c = res.data?.current;
    if (!c) return null;
    return {
      temp_f:    Math.round(c.temperature_2m),
      wind_mph:  Math.round(c.windspeed_10m),
      precip_in: c.precipitation,
      condition: wmoCondition(c.weathercode),
    };
  } catch (err) {
    console.warn('[game_stats] getWeather error:', err.message);
    return null;
  }
}

// ── Fetch ESPN event summary ──────────────────────────────────────────────────
async function getGameStats(espn_game_id, sport) {
  const leaguePath = LEAGUE_PATH[sport];
  const EMPTY_INJURIES = { home: { abbr: null, shortName: null, players: [] }, away: { abbr: null, shortName: null, players: [] } };
  if (!leaguePath) return { pitchers: [], injuries: EMPTY_INJURIES, venue: null };

  let summary;
  try {
    const res = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/${leaguePath}/summary`,
      { params: { event: espn_game_id }, timeout: 10000 }
    );
    summary = res.data;
  } catch (err) {
    console.warn(`[game_stats] ESPN summary fetch error (${espn_game_id}):`, err.message);
    return { pitchers: [], injuries: EMPTY_INJURIES, venue: null };
  }

  const result = { pitchers: [], injuries: EMPTY_INJURIES, venue: null };

  // Extract competitors once — used for pitchers, injuries, records, team IDs
  const headerComp = summary?.header?.competitions?.[0];
  const homeComp   = (headerComp?.competitors || []).find(c => c.homeAway === 'home');
  const awayComp   = (headerComp?.competitors || []).find(c => c.homeAway === 'away');

  // Team season records + ESPN team IDs (used by getFullGameContext for form fetch)
  const findRecord = comp => (comp?.record || [])
    .find(r => r.type === 'total' || r.name === 'overall')?.displayValue || null;
  result.homeRecord = findRecord(homeComp);
  result.awayRecord = findRecord(awayComp);
  result.homeTeamId = homeComp?.team?.id || null;
  result.awayTeamId = awayComp?.team?.id || null;

  // Venue
  const venue = summary?.gameInfo?.venue;
  if (venue) {
    result.venue = {
      name: venue.fullName || venue.shortName || null,
      city: venue.address?.city || null,
      lat:  venue.address?.latitude  ?? null,
      lng:  venue.address?.longitude ?? null,
    };
  }

  // Tennis — extract tournament name and surface
  if (sport === 'ATP' || sport === 'WTA') {
    const tournamentName =
      headerComp?.tournament?.displayName ||
      summary?.gameInfo?.tournament?.displayName ||
      null;
    const surface =
      summary?.gameInfo?.venue?.surface?.displayName ||
      summary?.gameInfo?.surface?.displayName ||
      null;
    if (tournamentName) result.tournament = tournamentName;
    if (surface)        result.surface    = surface;
  }

  // MLB starting pitchers
  if (sport === 'MLB') {
    for (const competitor of [homeComp, awayComp].filter(Boolean)) {
      const probable = competitor.probables?.[0];
      if (!probable?.athlete) continue;
      const cats   = probable.statistics?.splits?.categories || [];
      const wins   = cats.find(c => c.name === 'wins')?.displayValue;
      const losses = cats.find(c => c.name === 'losses')?.displayValue;
      const era    = cats.find(c => c.name === 'ERA')?.displayValue;
      const whip   = cats.find(c => c.name === 'WHIP')?.displayValue;
      result.pitchers.push({
        team:     competitor.team?.displayName || null,
        homeAway: competitor.homeAway || null,
        name:     probable.athlete.displayName || probable.athlete.fullName || null,
        record:   (wins != null && losses != null) ? `${wins}-${losses}` : null,
        era:      era || null,
        whip:     whip || null,
      });
    }
  }

  // Injuries (all sports) — map to {home, away} using competitor team IDs
  // homeComp / awayComp already defined above

  const makeMeta = comp => {
    if (!comp) return { abbr: null, shortName: null, id: null };
    const t = comp.team || {};
    const abbr = t.abbreviation || t.shortDisplayName || null;
    // shortDisplayName may be absent; fall back to last word of displayName ("Detroit Pistons" → "Pistons")
    const shortName = t.shortDisplayName || t.nickname ||
      (t.displayName ? t.displayName.trim().split(' ').pop() : null) || null;
    return { abbr, shortName, id: t.id || null };
  };

  const homeMeta = makeMeta(homeComp);
  const awayMeta = makeMeta(awayComp);

  const homePlayers = [];
  const awayPlayers = [];

  for (const teamEntry of summary?.injuries || []) {
    const tid = String(teamEntry.team?.id || '');
    const isHome = tid && homeMeta.id && tid === String(homeMeta.id);
    const isAway = tid && awayMeta.id && tid === String(awayMeta.id);
    if (!isHome && !isAway) continue;
    const bucket = isHome ? homePlayers : awayPlayers;

    for (const item of teamEntry.injuries || []) {
      const athlete = item.athlete || {};
      const fullName = athlete.displayName || athlete.fullName || '';
      if (!fullName) continue;
      // Build "F. Lastname" short form if ESPN doesn't provide it
      let shortName = athlete.shortName || (() => {
        const parts = fullName.trim().split(' ');
        return parts.length < 2 ? fullName : parts[0][0] + '. ' + parts.slice(1).join(' ');
      })();
      const status = item.status || item.type || null;
      const detail = item.details?.displayName || item.shortComment || null;
      bucket.push({ player: fullName, shortName, status, detail });
    }
  }

  result.injuries = {
    home: { abbr: homeMeta.abbr, shortName: homeMeta.shortName, players: homePlayers },
    away: { abbr: awayMeta.abbr, shortName: awayMeta.shortName, players: awayPlayers },
  };

  return result;
}

// ── Fetch last-N game results for a team (W/L form) ──────────────────────────
async function getTeamForm(teamId, leaguePath, n = 5) {
  if (!teamId || !leaguePath) return null;
  try {
    const res = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/${leaguePath}/teams/${teamId}/schedule`,
      { params: { limit: 20 }, timeout: 6000 }
    );
    const events = (res.data?.events || [])
      .filter(e => e.competitions?.[0]?.status?.type?.completed);
    // Take last n
    const recent = events.slice(-n);
    return recent.map(e => {
      const comp = e.competitions[0];
      const mine = (comp.competitors || []).find(c => String(c.team?.id) === String(teamId));
      if (mine?.winner === true)  return 'W';
      if (mine?.winner === false) return 'L';
      return null;
    }).filter(Boolean);
  } catch (_) {
    return null;
  }
}

// ── Main export: stats + optional weather + team form ─────────────────────────
async function getFullGameContext(espn_game_id, sport, homeTeamName) {
  const stats = await getGameStats(espn_game_id, sport);

  const leaguePath = LEAGUE_PATH[sport];
  const isTeamSport = leaguePath && sport !== 'ATP' && sport !== 'WTA';

  // Build weather promise
  let weatherP = Promise.resolve(null);
  if (OUTDOOR_SPORTS.has(sport)) {
    let coords = null;
    if (stats.venue?.lat && stats.venue?.lng) {
      coords = { lat: stats.venue.lat, lng: stats.venue.lng };
    } else if (homeTeamName) {
      coords = STADIUM_COORDS[homeTeamName] || null;
    }
    if (coords) weatherP = getWeather(coords.lat, coords.lng);
  }

  // Fetch weather + team form in parallel
  const [weather, homeForm, awayForm] = await Promise.all([
    weatherP,
    isTeamSport ? getTeamForm(stats.homeTeamId, leaguePath) : Promise.resolve(null),
    isTeamSport ? getTeamForm(stats.awayTeamId, leaguePath) : Promise.resolve(null),
  ]);

  return { ...stats, weather, homeForm, awayForm };
}

module.exports = { getFullGameContext };
