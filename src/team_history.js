// src/team_history.js
// Per-team recent-game history for the game detail page "History" section.
// One free ESPN call per team (the team schedule) gives the last 20 results,
// per-game scores, and inline top performers. The heavier per-player box-score
// work lives in player_form.js + the /api/game-players popup endpoint.
// Do not import or modify espn_live.js.

const axios = require('axios');

const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports';

// Sport label → ESPN league path. Mirrors game_stats.js LEAGUE_PATH but only the
// team sports that get the History treatment (tennis/golf handled elsewhere).
const LEAGUE_PATH = {
  NBA:   'basketball/nba',
  WNBA:  'basketball/wnba',
  NHL:   'hockey/nhl',
  MLB:   'baseball/mlb',
  NFL:   'americanfootball/nfl',
  NCAAF: 'americanfootball/college-football',
  CBB:   'basketball/mens-college-basketball',
};
const TEAM_SPORTS = new Set(Object.keys(LEAGUE_PATH));

// In-memory cache: `${sport}:${teamId}` → { ts, data }. Recent results don't
// change intra-day, so a 15-min TTL keeps repeat detail-page opens free.
const _cache = new Map();
const TTL_MS = 15 * 60 * 1000;

// ESPN scores arrive as a string ("100") or an object ({value, displayValue}).
function num(score) {
  if (score == null) return null;
  if (typeof score === 'object') {
    const v = score.value != null ? score.value : parseFloat(score.displayValue);
    return Number.isFinite(v) ? v : null;
  }
  const v = parseFloat(score);
  return Number.isFinite(v) ? v : null;
}

function teamShort(team) {
  return team?.shortDisplayName || team?.nickname ||
    (team?.displayName ? team.displayName.trim().split(' ').pop() : null) ||
    team?.abbreviation || null;
}

async function fetchSchedule(teamId, leaguePath) {
  const res = await axios.get(
    `${ESPN_SITE}/${leaguePath}/teams/${teamId}/schedule`,
    { params: { limit: 20 }, timeout: 8000 }
  );
  return res.data?.events || [];
}

// Parse one schedule event from the team's perspective.
function parseScheduleGame(e, teamId) {
  const comp = e.competitions?.[0];
  if (!comp) return null;
  const completed = comp.status?.type?.completed === true;
  const cs = comp.competitors || [];
  const mine = cs.find(c => String(c.team?.id) === String(teamId));
  const opp  = cs.find(c => String(c.team?.id) !== String(teamId));
  if (!mine || !opp) return null;

  const pf = num(mine.score);
  const pa = num(opp.score);
  const result = mine.winner === true ? 'W'
               : mine.winner === false ? 'L'
               : (pf != null && pa != null ? (pf > pa ? 'W' : pa > pf ? 'L' : 'T') : null);

  // Closing line for this game, when ESPN ships it. `spread` is home-relative
  // (negative = home favored); `overUnder` is the total. Used for the team's
  // ATS / over-under trend. Often absent on older rows — handled as best-effort.
  const oddsObj = comp.odds?.[0] || null;
  const spread     = oddsObj && oddsObj.spread != null     ? num(oddsObj.spread)     : null;
  const overUnder  = oddsObj && oddsObj.overUnder != null  ? num(oddsObj.overUnder)  : null;

  // Venue location (for the travel/time-zone load factor). State is enough.
  const vAddr = comp.venue?.address || {};

  // Inline per-game leaders (top scorer/rebounder/etc.) — free, no box-score call.
  const leaders = (mine.leaders || []).map(cat => {
    const top = (cat.leaders || [])[0];
    if (!top || top.displayValue == null) return null;
    return {
      cat:     cat.shortDisplayName || cat.displayName || cat.name || '',
      value:   top.displayValue,
      athlete: top.athlete?.shortName || top.athlete?.displayName || null,
    };
  }).filter(Boolean);

  return {
    eventId:  e.id || comp.id || null,
    date:     e.date || comp.date || null,
    completed,
    oppId:    opp.team?.id || null,
    oppAbbr:  opp.team?.abbreviation || null,
    oppName:  teamShort(opp.team),
    oppLogo:  opp.team?.logos?.[0]?.href || opp.team?.logo || null,
    homeAway: mine.homeAway || null,
    pf, pa,
    margin:   (pf != null && pa != null) ? pf - pa : null,
    result,
    spread,
    overUnder,
    venueCity:  vAddr.city  || null,
    venueState: vAddr.state || null,
    leaders,
  };
}

function buildSummary(games) {
  const done = games.filter(g => g.completed && g.pf != null && g.pa != null);
  const gp = done.length;
  const w  = done.filter(g => g.result === 'W').length;
  const l  = done.filter(g => g.result === 'L').length;
  const totalPF = done.reduce((s, g) => s + g.pf, 0);
  const totalPA = done.reduce((s, g) => s + g.pa, 0);
  return {
    gamesPlayed:  gp,
    record:       `${w}-${l}`,
    wins:         w,
    losses:       l,
    totalPoints:  totalPF,
    ppg:          gp ? +(totalPF / gp).toFixed(1) : null,
    oppPpg:       gp ? +(totalPA / gp).toFixed(1) : null,
    avgMargin:    gp ? +((totalPF - totalPA) / gp).toFixed(1) : null,
    lastFiveForm: done.slice(0, 5).map(g => g.result),
  };
}

// Public: one game's player box score for a single team, normalized into blocks.
// NBA/NHL ship one block; MLB ships batting + pitching; NFL passing/rushing/etc.
// Each block carries display `labels` and rows with stats aligned to those labels
// (kept as a raw array for display) plus a label-keyed object for derived metrics.
async function getEventTeamPlayers(eventId, sport, teamId) {
  sport = (sport || '').toUpperCase();
  const leaguePath = LEAGUE_PATH[sport];
  if (!leaguePath || !eventId || !teamId) return null;

  let summary;
  try {
    const res = await axios.get(`${ESPN_SITE}/${leaguePath}/summary`, { params: { event: eventId }, timeout: 9000 });
    summary = res.data;
  } catch (err) {
    console.warn(`[team_history] boxscore error (${sport} ${eventId}):`, err.message);
    return null;
  }

  const entry = (summary?.boxscore?.players || []).find(p => String(p.team?.id) === String(teamId));
  if (!entry) return null;

  const blocks = (entry.statistics || []).map(blk => {
    const labels = blk.labels || blk.names || [];
    const type   = (blk.type || blk.name || '').toString();
    const rows = (blk.athletes || []).map(a => {
      const ath = a.athlete || {};
      const stats = {};
      (a.stats || []).forEach((v, i) => { if (labels[i]) stats[labels[i]] = v; });
      return {
        athleteId: ath.id || null,
        name:      ath.displayName || ath.shortName || ath.fullName || '?',
        shortName: ath.shortName || null,
        pos:       ath.position?.abbreviation || a.position || null,
        starter:   a.starter === true,
        batOrder:  a.batOrder ?? null,
        dnp:       a.didNotPlay === true,
        statsArr:  a.stats || [],
        stats,
      };
    });
    return { type, role: /pitch/i.test(type) ? 'pitcher' : 'batter', labels, rows };
  }).filter(b => b.rows.length);

  return {
    teamId: String(teamId),
    team: { abbr: entry.team?.abbreviation || null, name: teamShort(entry.team) },
    blocks,
  };
}

// Public: tonight's pre-game intel for one team, from the game summary —
// the announced starter (probable pitcher, available days ahead) and the
// CONFIRMED batting order once the lineup is posted (~1-3h before MLB first
// pitch; empty until then). One ESPN call. Returns { starter, lineup }, where
// lineup is the 9 hitters with their real batOrder, or null if not posted yet.
async function getEventPregame(eventId, sport, teamId) {
  sport = (sport || '').toUpperCase();
  const leaguePath = LEAGUE_PATH[sport];
  const out = { starter: null, lineup: null };
  if (!leaguePath || !eventId || !teamId) return out;

  let summary;
  try {
    const res = await axios.get(`${ESPN_SITE}/${leaguePath}/summary`, { params: { event: eventId }, timeout: 9000 });
    summary = res.data;
  } catch (_) { return out; }

  const comps = summary?.header?.competitions?.[0]?.competitors || [];
  const comp  = comps.find(c => String(c.team?.id) === String(teamId));
  const ath   = comp?.probables?.[0]?.athlete;
  if (ath && ath.id) {
    out.starter = {
      athleteId: String(ath.id),
      name:      ath.displayName || ath.fullName || ath.shortName || '?',
      shortName: ath.shortName || null,
      pos:       ath.position?.abbreviation || 'SP',
    };
  }

  const rEntry  = (summary?.rosters || []).find(r => String(r.team?.id) === String(teamId));
  const batters = (rEntry?.roster || [])
    .filter(p => p.starter && p.batOrder && !/^(P|SP|RP)$/i.test(p.position?.abbreviation || ''))
    .map(p => {
      const a = p.athlete || {};
      return {
        athleteId: a.id ? String(a.id) : null,
        name:      a.displayName || a.shortName || a.fullName || '?',
        shortName: a.shortName || null,
        pos:       p.position?.abbreviation || a.position?.abbreviation || null,
        batOrder:  p.batOrder,
      };
    })
    .filter(p => p.athleteId)
    .sort((a, b) => a.batOrder - b.batOrder);
  if (batters.length) out.lineup = batters;

  return out;
}

// Public: last-20 (most-recent-first) + last-5 + summary for one team.
async function getTeamHistory(teamId, sport) {
  sport = (sport || '').toUpperCase();
  const leaguePath = LEAGUE_PATH[sport];
  if (!leaguePath || !teamId) return null;

  const key = `${sport}:${teamId}`;
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  let events;
  try {
    events = await fetchSchedule(teamId, leaguePath);
  } catch (err) {
    console.warn(`[team_history] schedule error (${sport} ${teamId}):`, err.message);
    return null;
  }

  // ESPN returns events oldest→newest; reverse completed games to recent-first.
  const completed = events
    .map(e => parseScheduleGame(e, teamId))
    .filter(g => g && g.completed)
    .reverse();

  const last20 = completed.slice(0, 20);
  const last5  = last20.slice(0, 5);

  // Next (tonight's) game venue — for the travel/time-zone load factor.
  const upcoming = events.find(e => !(e.competitions?.[0]?.status?.type?.completed) && e.competitions?.[0]?.venue);
  const nv = upcoming?.competitions?.[0]?.venue?.address || null;
  const nextVenue = nv ? { city: nv.city || null, state: nv.state || null } : null;

  const data = { sport, teamId: String(teamId), summary: buildSummary(last20), last20, last5, nextVenue };

  _cache.set(key, { ts: Date.now(), data });
  return data;
}

module.exports = { getTeamHistory, getEventTeamPlayers, getEventPregame, TEAM_SPORTS, LEAGUE_PATH };
