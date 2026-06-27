// src/game_form.js
// Forward-looking "Team Form" tab for the game detail page. Where the History
// tab answers "how did everyone do in a past game," this answers "what shape is
// each player in GOING INTO tonight's game."
//
// It reuses the existing engines:
//  - who plays  → the team's most recent completed box score (team_history)
//  - form/load  → computeHotCold + computeFreshness, evaluated AS OF tonight
//  - extras     → usage trend, home/away + vs-opponent splits, return-from-absence
//  - team trend → ATS / over-under run from the schedule's closing lines
//
// One ESPN schedule call + one box-score call per team, plus cached player
// gamelogs (6h). The whole assembled result is cached 30 min per team per date.
// Do not import or modify espn_live.js.

const { getTeamHistory, getEventTeamPlayers, getEventPregame, TEAM_SPORTS } = require('./team_history');
const {
  getPlayerGamelog, computeHotCold, computeFreshness, computeUsageTrend, computeSplits,
  computeBatterNote, computePitcherRecent, bandFor,
} = require('./player_form');

const _cache = new Map();
const TTL_MS = 30 * 60 * 1000;

function dayKey(iso) { return (iso || '').slice(0, 10); }

// State → standard UTC offset (hours). Only the delta matters, so DST is ignored.
const STATE_TZ = {
  Connecticut:-5, Delaware:-5, Florida:-5, Georgia:-5, Indiana:-5, Kentucky:-5, Maine:-5,
  Maryland:-5, Massachusetts:-5, Michigan:-5, 'New Hampshire':-5, 'New Jersey':-5, 'New York':-5,
  'North Carolina':-5, Ohio:-5, Pennsylvania:-5, 'Rhode Island':-5, 'South Carolina':-5,
  Vermont:-5, Virginia:-5, 'West Virginia':-5, 'District of Columbia':-5, Ontario:-5, Quebec:-5,
  Alabama:-6, Arkansas:-6, Illinois:-6, Iowa:-6, Kansas:-6, Louisiana:-6, Minnesota:-6,
  Mississippi:-6, Missouri:-6, Nebraska:-6, 'North Dakota':-6, Oklahoma:-6, 'South Dakota':-6,
  Tennessee:-6, Texas:-6, Wisconsin:-6, Manitoba:-6,
  Arizona:-7, Colorado:-7, Idaho:-7, Montana:-7, 'New Mexico':-7, Utah:-7, Wyoming:-7, Alberta:-7,
  California:-8, Nevada:-8, Oregon:-8, Washington:-8, 'British Columbia':-8,
};

// Time-zone shift from the team's last game to tonight → a small, capped load
// bump. Cross-country travel compounds fatigue (research-backed but modest).
function travelBump(fromState, toState) {
  const a = STATE_TZ[fromState], b = STATE_TZ[toState];
  if (a == null || b == null) return { bump: 0, note: null };
  const tz = Math.abs(a - b);
  if (tz <= 0) return { bump: 0, note: null };
  return { bump: Math.min(12, tz * 4), note: tz >= 3 ? 'Cross-country trip' : `${tz} time zone${tz > 1 ? 's' : ''} traveled` };
}

// "Coming off an injury?" — compare the player's own game dates against the
// team's recent schedule. If the team played games the player sat out, surface
// how many they missed and how long since they last appeared. Players who are
// currently OUT won't be in the last box score (the Injuries tab covers them);
// this catches returnees who are back in the lineup after a layoff.
//
// Sport/role aware: a baseball starter pitches ~every 5th game, so "missed
// games" by team cadence is meaningless for them — flag only a real layoff.
// Position players rest often, so MLB needs a higher missed-game threshold than
// the every-other-day sports.
function absenceInfo(gamelog, teamDates, gameDate, sport, ctx) {
  const pd = (gamelog.series || []).map(g => dayKey(g.date)).filter(Boolean);
  if (!pd.length) return null;
  const lastPlayed = pd[0]; // series is recent-first
  const daysSince  = lastPlayed ? Math.floor((new Date(gameDate) - new Date(lastPlayed)) / 86400000) : null;

  if (sport === 'MLB' && ctx && ctx.role === 'pitcher') {
    return (daysSince != null && daysSince >= 14) ? { layoff: true, daysSince } : null;
  }

  const played = new Set(pd);
  const gKey = dayKey(gameDate);
  const recentTeam = teamDates.map(dayKey).filter(d => d && d < gKey).slice(0, 10);
  if (!recentTeam.length) return null;
  const missed = recentTeam.filter(d => !played.has(d)).length;
  const threshold = sport === 'MLB' ? 3 : 1; // MLB rests position players routinely
  if (missed < threshold) return null;
  return { missed, daysSince, playedLast: played.has(recentTeam[0]) };
}

// Team ATS + over/under run from the schedule's closing lines (best-effort —
// ESPN often only carries odds on a handful of recent rows, so we only return a
// trend when at least 3 games have line data).
function buildBettingTrend(games) {
  let aw = 0, al = 0, ap = 0, ov = 0, un = 0, op = 0, atsN = 0, ouN = 0;
  for (const g of games.slice(0, 10)) {
    if (g.pf == null || g.pa == null) continue;
    if (g.spread != null) {
      const teamSpread = g.homeAway === 'home' ? g.spread : -g.spread; // home-relative → team-relative
      const cover = (g.pf - g.pa) + teamSpread;
      if (Math.abs(cover) < 1e-9) ap++; else if (cover > 0) aw++; else al++;
      atsN++;
    }
    if (g.overUnder != null) {
      const total = g.pf + g.pa;
      if (Math.abs(total - g.overUnder) < 1e-9) op++; else if (total > g.overUnder) ov++; else un++;
      ouN++;
    }
  }
  const out = {};
  if (atsN >= 3) out.ats = { w: aw, l: al, p: ap, n: atsN };
  if (ouN  >= 3) out.ou  = { over: ov, under: un, push: op, n: ouN };
  return Object.keys(out).length ? out : null;
}

// Public: forward-looking player form/load grid for one team in tonight's game.
//  eventId  — tonight's espn game id (cache key only)
//  teamId   — the team whose players we're profiling
//  gameDate — tonight's start_time (the "as of" date for form/load)
//  oppId    — tonight's opponent team id (for the head-to-head split)
async function getGameForm(eventId, sport, teamId, gameDate, oppId) {
  sport = (sport || '').toUpperCase();
  if (!TEAM_SPORTS.has(sport)) return { unsupported: true };
  if (!teamId) return { unavailable: true };

  const gd = gameDate || new Date().toISOString();
  const key = `${sport}:${teamId}:${dayKey(gd)}`;
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  const hist = await getTeamHistory(teamId, sport).catch(() => null);
  const completed = (hist?.last20 || []).filter(g => g.completed && g.eventId);
  const lastEvent = completed[0]?.eventId;
  if (!lastEvent) return { unavailable: true };

  const roster = await getEventTeamPlayers(lastEvent, sport, teamId).catch(() => null);
  if (!roster || !roster.blocks?.length) return { unavailable: true };

  const teamDates = completed.map(g => g.date).filter(Boolean);

  for (const blk of roster.blocks) {
    const meaningful = blk.rows.filter(r => !r.dnp && r.athleteId).slice(0, 14);
    await Promise.all(meaningful.map(async r => {
      const gl  = await getPlayerGamelog(r.athleteId, sport).catch(() => null);
      const ctx = { role: blk.role, position: r.pos };
      r.form    = gl ? computeHotCold(gl, sport, ctx, gd) : null;
      r.load    = gl ? computeFreshness(gl, sport, ctx, gd) : null;
      r.usage   = gl ? computeUsageTrend(gl, sport, ctx, gd) : null;
      r.splits  = gl ? computeSplits(gl, sport, ctx, gd, oppId) : null;
      r.absence = gl ? absenceInfo(gl, teamDates, gd, sport, ctx) : null;
      // MLB pitchers get a recent-ERA column; hitters and other sports have none.
      if (sport === 'MLB' && blk.role === 'pitcher') {
        r.recent = gl ? computePitcherRecent(gl, gd) : null;
      }
    }));
    // Forward view: keep only profiled players, drop the past game's raw line.
    blk.rows = meaningful;
    blk.rows.forEach(r => { delete r.stats; delete r.statsArr; });
    // Batting order (MLB only — other sports use role 'batter' too but have no
    // lineup order). Prefer ESPN's real batOrder; fall back to sequence.
    if (sport === 'MLB' && blk.role === 'batter') {
      let spot = 0;
      for (const r of blk.rows) if (r.starter) r.lineupSpot = r.batOrder || (++spot);
    }
  }

  // MLB: enrich with tonight's posted intel (one ESPN call): the confirmed
  // batting order when it's up, and the announced starting pitcher.
  if (sport === 'MLB') {
    const pre = await getEventPregame(eventId, sport, teamId).catch(() => null);

    // Confirmed batting order (posted ~1-3h before first pitch) replaces the
    // last-game proxy with tonight's actual 1-9.
    if (pre && pre.lineup && pre.lineup.length) {
      const rows = await Promise.all(pre.lineup.map(async p => {
        const gl  = await getPlayerGamelog(p.athleteId, sport).catch(() => null);
        const ctx = { role: 'batter', position: p.pos };
        return {
          athleteId: p.athleteId, name: p.name, shortName: p.shortName, pos: p.pos,
          starter: true, lineupSpot: p.batOrder,
          form:    gl ? computeHotCold(gl, sport, ctx, gd) : null,
          load:    gl ? computeFreshness(gl, sport, ctx, gd) : null,
          splits:  gl ? computeSplits(gl, sport, ctx, gd, oppId) : null,
          absence: gl ? absenceInfo(gl, teamDates, gd, sport, ctx) : null,
        };
      }));
      let bat = roster.blocks.find(b => b.role === 'batter');
      if (!bat) { bat = { type: 'batting', role: 'batter', labels: [] }; roster.blocks.unshift(bat); }
      bat.rows = rows;
      bat.lineupConfirmed = true;
    }

    // Announced starting pitcher (he last pitched days ago, so he isn't in the
    // last box score) — lead the pitching block; drop the last game's starter.
    const sp = pre && pre.starter;
    if (sp) {
      const gl  = await getPlayerGamelog(sp.athleteId, sport).catch(() => null);
      const ctx = { role: 'pitcher', position: sp.pos || 'SP' };
      const row = {
        athleteId: sp.athleteId, name: sp.name, shortName: sp.shortName, pos: sp.pos || 'SP',
        starter: true, gameStarter: true,
        form:    gl ? computeHotCold(gl, sport, ctx, gd) : null,
        load:    gl ? computeFreshness(gl, sport, ctx, gd) : null,
        recent:  gl ? computePitcherRecent(gl, gd) : null,
        splits:  gl ? computeSplits(gl, sport, ctx, gd, oppId) : null,
        absence: gl ? absenceInfo(gl, teamDates, gd, sport, ctx) : null,
      };
      let pitch = roster.blocks.find(b => b.role === 'pitcher');
      if (!pitch) { pitch = { type: 'pitching', role: 'pitcher', labels: [], rows: [] }; roster.blocks.push(pitch); }
      pitch.rows = pitch.rows.filter(r => String(r.athleteId) !== sp.athleteId && !r.starter);
      pitch.rows.unshift(row);
      pitch.hasGameStarter = true;
    }
  }

  // #7 Travel: bump everyone's load by the time-zone shift from their last game
  // venue to tonight's. Applies team-wide (they all travelled together).
  const tv = travelBump(completed[0]?.venueState, hist?.nextVenue?.state);
  if (tv.bump > 0) {
    for (const blk of roster.blocks) {
      for (const r of blk.rows) {
        if (r.load && r.load.score != null) {
          r.load.score = Math.min(100, r.load.score + tv.bump);
          r.load.band  = bandFor(r.load.score);
          if (tv.note && !r.load.note) r.load.note = tv.note;
        }
      }
    }
  }

  const data = {
    sport,
    teamId: String(teamId),
    team: roster.team,
    blocks: roster.blocks.filter(b => b.rows.length),
    betting: buildBettingTrend(completed),
    travel: tv.bump > 0 ? tv.note : null,
    lastEvent,
  };
  _cache.set(key, { ts: Date.now(), data });
  return data;
}

module.exports = { getGameForm };
