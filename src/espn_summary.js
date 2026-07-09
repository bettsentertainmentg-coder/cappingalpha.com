// src/espn_summary.js
// On-demand per-game ESPN summary for the live tracker: play-by-play, ESPN's
// own win-probability series, per-game stat leaders, and team stats. Free
// (site.api.espn.com), fetched only while someone is viewing a game, cached
// short while live / longer once final, in-flight collapsed, LRU capped.
//
// Sports coverage is uneven by design (verified against real games):
//   winprobability: NFL/NCAAF/NBA/WNBA/CBB/MLB. Not NHL/Soccer/Tennis.
//   plays: football = drives, basketball/hockey = flat plays[], baseball =
//     pitch-level (we keep at-bat results), soccer = keyEvents + commentary.
//   leaders: all but MLB (MLB's per-game leaders ride on the scoreboard event).
//   tennis: no summary endpoint at all — callers get null.

const axios = require('axios');
const db = require('./db');
const { fetchScoreboard } = require('./live_tracker');

// League paths for the summary endpoint. sports.core only accepts football/...,
// so new code standardizes on football/... (site API accepts both).
const LEAGUE_PATH = {
  MLB:   'baseball/mlb',
  NBA:   'basketball/nba',
  WNBA:  'basketball/wnba',
  CBB:   'basketball/mens-college-basketball',
  WCBB:  'basketball/womens-college-basketball',
  NHL:   'hockey/nhl',
  NFL:   'football/nfl',
  NCAAF: 'football/college-football',
};

const FAMILY = {
  MLB: 'baseball', NFL: 'football', NCAAF: 'football',
  NBA: 'basketball', WNBA: 'basketball', CBB: 'basketball', WCBB: 'basketball',
  NHL: 'hockey', SOCCER: 'soccer',
};

const TTL_LIVE  = 18_000;
const TTL_FINAL = 5 * 60_000;
const CACHE_MAX = 40;
const PLAYS_MAX = 40;
const WP_MAX    = 120;
const TIMELINE_MAX = 80;   // matches the pulse-history cap (HIST_MAX) in live_tracker

const _cache    = new Map();   // gameId -> { ts, ttl, data }
const _inflight = new Map();   // gameId -> Promise

function leaguePathFor(sport, gameId) {
  const sp = String(sport || '').toUpperCase();
  if (LEAGUE_PATH[sp]) return LEAGUE_PATH[sp];
  if (sp === 'SOCCER') {
    try {
      const row = db.prepare(`SELECT league_path FROM today_games WHERE espn_game_id = ?`).get(String(gameId));
      return row?.league_path || null;
    } catch (_) { return null; }
  }
  return null;   // ATP/WTA/Golf: no summary endpoint
}

async function getSummaryRaw(sport, gameId, opts = {}) {
  const key = String(gameId);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < hit.ttl) {
    _cache.delete(key); _cache.set(key, hit);   // LRU bump
    return hit.data;
  }
  if (_inflight.has(key)) return _inflight.get(key);

  const path = opts.leaguePath || leaguePathFor(sport, gameId);
  if (!path) return null;

  const p = (async () => {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${encodeURIComponent(gameId)}`;
      const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = res.data || null;
      const state = data?.header?.competitions?.[0]?.status?.type?.state || null;
      const ttl = state === 'in' ? TTL_LIVE : TTL_FINAL;
      _cache.set(key, { ts: Date.now(), ttl, data });
      while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
      return data;
    } catch (e) {
      const stale = _cache.get(key);              // serve stale on transient error
      return stale ? stale.data : null;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

// ── Shared helpers ─────────────────────────────────────────────────────────────
const periodOf = (p) => (typeof p?.period === 'object' ? p.period?.number : p?.period) ?? null;
const clockOf  = (p) => (typeof p?.clock === 'object' ? p.clock?.displayValue : p?.clock) ?? null;

function headerTeams(summary) {
  const comps = summary?.header?.competitions?.[0]?.competitors || [];
  const home = comps.find(c => c.homeAway === 'home');
  const away = comps.find(c => c.homeAway === 'away');
  return { homeId: String(home?.team?.id ?? ''), awayId: String(away?.team?.id ?? '') };
}

function teamSideFn(summary) {
  const { homeId, awayId } = headerTeams(summary);
  return (id) => {
    const s = String(id ?? '');
    return s && s === homeId ? 'home' : (s && s === awayId ? 'away' : null);
  };
}

function normPlay(p, side) {
  return {
    id:        String(p.id ?? ''),
    period:    periodOf(p),
    clock:     clockOf(p),
    team:      side(p.team?.id),
    text:      p.text || p.shortDescription || p.type?.text || '',
    scoring:   p.scoringPlay === true,
    scoreValue: p.scoreValue ?? null,
    homeScore: (typeof p.homeScore === 'number') ? p.homeScore : null,
    awayScore: (typeof p.awayScore === 'number') ? p.awayScore : null,
  };
}

// ── ESPN win probability series ────────────────────────────────────────────────
// -> { source:'espn', latestHome (0..1), series:[{x 0..1, home pct}], scoring:[...] } | null
async function getEspnWinProb(sport, gameId, opts = {}) {
  const summary = await getSummaryRaw(sport, gameId, opts);
  const wp = summary?.winprobability;
  if (!Array.isArray(wp) || !wp.length) return null;

  const side = teamSideFn(summary);
  const n = wp.length;
  const idxOf = new Map();
  wp.forEach((e, i) => { if (e?.playId != null) idxOf.set(String(e.playId), i); });

  // Scoring markers: football keeps a dedicated scoringPlays list; other sports
  // flag scoring plays inline.
  const rawScoring = Array.isArray(summary?.scoringPlays) && summary.scoringPlays.length
    ? summary.scoringPlays
    : (Array.isArray(summary?.plays) ? summary.plays.filter(p => p?.scoringPlay === true) : []);
  const keepIdx = new Set([0, n - 1]);
  const scoring = [];
  for (const p of rawScoring) {
    const i = idxOf.get(String(p.id ?? ''));
    if (i == null) continue;
    keepIdx.add(i);
    scoring.push({
      x:      n > 1 ? i / (n - 1) : 1,
      team:   side(p.team?.id),
      text:   (p.text || p.type?.text || '').slice(0, 90),
      period: periodOf(p),
      clock:  clockOf(p),
    });
  }

  // Downsample to <= WP_MAX points, always keeping first/last/scoring points.
  const stride = Math.max(1, Math.ceil(n / WP_MAX));
  const series = [];
  for (let i = 0; i < n; i++) {
    if (i % stride !== 0 && !keepIdx.has(i)) continue;
    const h = wp[i]?.homeWinPercentage;
    if (typeof h !== 'number') continue;
    series.push({ x: n > 1 ? Math.round((i / (n - 1)) * 1000) / 1000 : 1, home: Math.round(h * 1000) / 10 });
  }

  const last = wp[n - 1]?.homeWinPercentage;
  return {
    source: 'espn',
    latestHome: (typeof last === 'number') ? last : null,
    series,
    scoring: scoring.slice(-40),
  };
}

// ── Whole-game timeline (value-pulse backfill) ─────────────────────────────────
// One point per meaningful state change carrying game progress, period, the
// running score, and ESPN's home win prob (null for sports that publish none —
// the caller models those from score + progress). Lets the pulse chart replay
// the FULL game the first time a slot is watched mid-game, rather than starting
// blank from the current inning.
//
// ESPN keeps win prob on a small set of ~75 "significant" plays while `plays`
// runs into the hundreds (per pitch), so we anchor the timeline to the win-prob
// plays (joined to the running score) where they exist, and fall back to
// downsampled plays for sports that publish no win prob (NHL/Soccer).
// -> [{ progress:0..1, period:int|null, homeScore, awayScore, homeWP:0..1|null }] | null
async function getGameTimeline(sport, gameId, opts = {}) {
  const summary = await getSummaryRaw(sport, gameId, opts);
  const plays = Array.isArray(summary?.plays) ? summary.plays : [];
  if (plays.length < 2) return null;
  const N = plays.length;

  // Per-play metadata with the score carried forward (many plays omit the score).
  const meta = new Map();
  let hs = 0, as = 0;
  plays.forEach((p, i) => {
    if (typeof p?.homeScore === 'number') hs = p.homeScore;
    if (typeof p?.awayScore === 'number') as = p.awayScore;
    meta.set(String(p?.id ?? i), { idx: i, period: periodOf(p), hs, as, scoring: p?.scoringPlay === true });
  });

  const wp = Array.isArray(summary?.winprobability) ? summary.winprobability : [];
  let pts = [];
  if (wp.length >= 2) {
    for (const e of wp) {
      const m = meta.get(String(e?.playId ?? ''));
      if (!m || typeof e?.homeWinPercentage !== 'number') continue;
      pts.push({ idx: m.idx, period: m.period, homeScore: m.hs, awayScore: m.as, homeWP: e.homeWinPercentage });
    }
  }
  if (pts.length < 2) {
    // No win prob published: downsample plays; the caller models WP from score.
    const keep = new Set([0, N - 1]);
    let lastPeriod = null;
    plays.forEach((p, i) => {
      const per = periodOf(p);
      if (per !== lastPeriod) { keep.add(i); lastPeriod = per; }
      if (p?.scoringPlay === true) keep.add(i);
    });
    const stride = Math.max(1, Math.ceil(N / TIMELINE_MAX));
    pts = [];
    for (let i = 0; i < N; i++) {
      if (i % stride !== 0 && !keep.has(i)) continue;
      const m = meta.get(String(plays[i]?.id ?? i));
      pts.push({ idx: i, period: m.period, homeScore: m.hs, awayScore: m.as, homeWP: null });
    }
  }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a.idx - b.idx);

  // Even-downsample to TIMELINE_MAX, always keeping the last point (game end).
  if (pts.length > TIMELINE_MAX) {
    const stride = Math.ceil(pts.length / TIMELINE_MAX);
    pts = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
  }
  return pts.map(p => ({
    progress:  N > 1 ? Math.round((p.idx / (N - 1)) * 1000) / 1000 : 1,
    period:    p.period,
    homeScore: p.homeScore,
    awayScore: p.awayScore,
    homeWP:    (typeof p.homeWP === 'number') ? p.homeWP : null,
  }));
}

// ── Per-family play feeds ──────────────────────────────────────────────────────
function footballFeed(summary, side) {
  const drivesPrev = summary?.drives?.previous || [];
  const current = summary?.drives?.current || null;
  const all = [];
  for (const d of drivesPrev) for (const p of (d.plays || [])) all.push(p);
  if (current) for (const p of (current.plays || [])) all.push(p);
  const plays = all.slice(-PLAYS_MAX).map(p => normPlay(p, side));
  const scoringPlays = (summary?.scoringPlays || []).map(p => ({
    ...normPlay(p, side),
    type: p.type?.abbreviation || p.type?.text || null,
  }));
  const drive = current ? {
    team:  side(current.team?.id) || null,
    desc:  current.description || null,
    start: current.start?.text || null,
  } : null;
  return { plays, scoringPlays, drive };
}

function flatFeed(summary, side, withStrength) {
  const raw = Array.isArray(summary?.plays) ? summary.plays : [];
  const plays = raw.slice(-PLAYS_MAX).map(p => {
    const o = normPlay(p, side);
    if (withStrength && p.strength?.text) o.strength = p.strength.text;
    return o;
  });
  const scoringPlays = raw.filter(p => p?.scoringPlay === true).map(p => normPlay(p, side));
  return { plays, scoringPlays, drive: null };
}

function baseballFeed(summary, side) {
  // Pitch-level is too granular for the feed: keep at-bat RESULTS (verified
  // marker: type.type === 'play-result') plus inning boundaries for grouping.
  const raw = Array.isArray(summary?.plays) ? summary.plays : [];
  const results = raw.filter(p => p?.type?.type === 'play-result' || p?.scoringPlay === true);
  const plays = results.slice(-30).map(p => {
    const o = normPlay(p, side);
    const per = p.period || {};
    o.half = /top/i.test(per.type || '') ? 'top' : (/bot/i.test(per.type || '') ? 'bot' : null);
    return o;
  });
  const scoringPlays = results.filter(p => p?.scoringPlay === true).map(p => normPlay(p, side));
  return { plays, scoringPlays, drive: null };
}

function soccerFeed(summary, side) {
  const keyEvents = (summary?.keyEvents || []).map(k => ({
    id:      String(k.id ?? ''),
    min:     clockOf(k),
    type:    k.type?.text || null,
    text:    k.text || '',
    scoring: k.scoringPlay === true,
    team:    side(k.team?.id),
  }));
  const commentary = (summary?.commentary || []).slice(-25).map(c => ({
    min:  c.time?.displayValue || null,
    text: c.text || '',
  }));
  // Scoring plays for the feed = goal key events (keeps the shared shape).
  const scoringPlays = keyEvents.filter(k => k.scoring).map(k => ({
    id: k.id, period: null, clock: k.min, team: k.team, text: k.text,
    scoring: true, scoreValue: null, homeScore: null, awayScore: null,
  }));
  return { plays: [], scoringPlays, drive: null, soccer: { keyEvents, commentary } };
}

// ── Leaders ────────────────────────────────────────────────────────────────────
// Same shape the popup already renders: { home:[{cat,value,name,pos,headshot}], away:[...] }.
function mapLeaderEntry(entry) {
  const out = [];
  for (const cat of entry?.leaders || []) {
    const top = cat?.leaders?.[0];
    const ath = top?.athlete;
    if (!ath || top?.displayValue == null) continue;
    out.push({
      cat:      cat.displayName || cat.shortDisplayName || cat.name || '',
      value:    top.displayValue,
      name:     ath.shortName || ath.displayName || ath.fullName || null,
      pos:      ath.position?.abbreviation || null,
      headshot: ath.headshot?.href || ath.headshot || null,
    });
  }
  return out;
}

async function getLeaders(sport, gameId, summary) {
  const sp = String(sport || '').toUpperCase();
  if (sp === 'MLB') {
    // MLB summary ships no leaders — the scoreboard event carries them.
    const events = await fetchScoreboard('MLB');
    const ev = (events || []).find(e => String(e.id) === String(gameId));
    const comp = ev?.competitions?.[0];
    if (!comp) return null;
    const home = (comp.competitors || []).find(c => c.homeAway === 'home');
    const away = (comp.competitors || []).find(c => c.homeAway === 'away');
    const clean = (c) => mapLeaderEntry({ leaders: (c?.leaders || []).filter(l => l?.name !== 'MLBRating') });
    const h = clean(home), a = clean(away);
    return (h.length || a.length) ? { home: h, away: a } : null;
  }
  if (!Array.isArray(summary?.leaders) || !summary.leaders.length) return null;
  const { homeId, awayId } = headerTeams(summary);
  const home = [], away = [];
  for (const entry of summary.leaders) {
    const tid = String(entry?.team?.id || '');
    if (tid === homeId)      home.push(...mapLeaderEntry(entry));
    else if (tid === awayId) away.push(...mapLeaderEntry(entry));
  }
  return (home.length || away.length) ? { home, away } : null;
}

// ── Team stats ─────────────────────────────────────────────────────────────────
// Trimmed to a curated allowlist per family; falls back to the first rows with a
// displayValue so an unmapped sport still shows something.
const STAT_ALLOW = {
  football:   ['firstDowns', 'totalYards', 'netPassingYards', 'rushingYards', 'thirdDownEff', 'fourthDownEff', 'turnovers', 'possessionTime', 'totalPenaltiesYards', 'sacksYardsLost'],
  basketball: ['fieldGoalPct', 'threePointFieldGoalPct', 'freeThrowPct', 'totalRebounds', 'offensiveRebounds', 'assists', 'steals', 'blocks', 'turnovers', 'pointsInPaint', 'fastBreakPoints', 'largestLead'],
  hockey:     ['shotsTotal', 'shots', 'powerPlayGoals', 'powerPlayOpportunities', 'faceoffsWon', 'faceoffPercent', 'hits', 'blockedShots', 'takeaways', 'giveaways', 'penaltyMinutes', 'saves'],
  soccer:     ['possessionPct', 'totalShots', 'shotsOnTarget', 'wonCorners', 'foulsCommitted', 'offsides', 'yellowCards', 'redCards', 'saves', 'totalPasses', 'passPct'],
  baseball:   ['hits', 'runs', 'homeRuns', 'avg', 'strikeouts', 'walks', 'stolenBases', 'leftOnBase'],
};

function statRows(teamEntry, family) {
  let flat = teamEntry?.statistics || [];
  // MLB nests stats in groups (batting/pitching/fielding) — use the batting group.
  if (flat.length && Array.isArray(flat[0]?.stats)) {
    const grp = flat.find(g => g.name === 'batting') || flat[0];
    flat = grp?.stats || [];
  }
  const allow = STAT_ALLOW[family] || [];
  const label = (s) => s.label || s.shortDisplayName || s.abbreviation || s.displayName || s.name;
  let rows = flat
    .filter(s => allow.includes(s.name) && s.displayValue != null)
    .map(s => ({ label: label(s), value: s.displayValue }));
  if (rows.length < 4) {
    rows = flat.filter(s => s.displayValue != null).slice(0, 8)
      .map(s => ({ label: label(s), value: s.displayValue }));
  }
  return rows;
}

function getTeamStats(summary, family) {
  const teams = summary?.boxscore?.teams || [];
  const home = teams.find(t => t.homeAway === 'home');
  const away = teams.find(t => t.homeAway === 'away');
  if (!home && !away) return null;
  const h = statRows(home, family), a = statRows(away, family);
  return (h.length || a.length) ? { home: h, away: a } : null;
}

// ── getFeed ────────────────────────────────────────────────────────────────────
// The /live/feed payload body (free content). Returns null when the sport has
// no summary endpoint (tennis) or the fetch failed with no stale copy.
async function getFeed(sport, gameId, opts = {}) {
  const sp = String(sport || '').toUpperCase();
  const family = FAMILY[sp];
  if (!family) return null;
  const summary = await getSummaryRaw(sp, gameId, opts);
  if (!summary) return null;

  const side = teamSideFn(summary);
  let body;
  if (family === 'football')        body = footballFeed(summary, side);
  else if (family === 'baseball')   body = baseballFeed(summary, side);
  else if (family === 'soccer')     body = soccerFeed(summary, side);
  else                              body = flatFeed(summary, side, family === 'hockey');

  const [leaders, winprob] = await Promise.all([
    getLeaders(sp, gameId, summary).catch(() => null),
    getEspnWinProb(sp, gameId, opts).catch(() => null),
  ]);

  return {
    sport: sp,
    status: summary?.header?.competitions?.[0]?.status?.type?.state || null,
    winprob,
    plays: body.plays,
    scoringPlays: body.scoringPlays,
    drive: body.drive,
    leaders,
    teamStats: getTeamStats(summary, family),
    ...(body.soccer ? { soccer: body.soccer } : {}),
  };
}

module.exports = { getFeed, getEspnWinProb, getGameTimeline, getSummaryRaw, LEAGUE_PATH };
