// src/player_form.js
// Per-player "form" (Hot/Cold) and "freshness" (Player Load) engines for the
// History tab player drill-down popup. Data source: the free ESPN athlete
// gamelog endpoint (one call per player gives their full game-by-game series).
//
// Both engines are research-backed but deliberately humble:
//  - Hot/Cold is a form/trend badge (recent slice vs the player's own trailing
//    baseline, z-scored), NOT a prediction. The hot-hand effect is real but small.
//  - Freshness is a box-score approximation of Acute:Chronic Workload Ratio plus
//    rest + schedule density. It reflects "how taxed coming in," NOT injury risk.
//
// Stat keys: the gamelog stores each value under BOTH its machine name
// ("points","minutes","timeOnIce") and its display label ("PTS","MIN") so the
// lookups below can use whichever ESPN provides per sport.

const axios = require('axios');
const { LEAGUE_PATH } = require('./team_history');

const ESPN_COMMON = 'https://site.api.espn.com/apis/common/v3/sports';

// ── gamelog cache (per athlete, refreshed a few times a day) ──────────────────
const _glCache = new Map();
const GL_TTL_MS = 6 * 60 * 60 * 1000;

// ── numeric helpers ───────────────────────────────────────────────────────────
function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s === '--') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function pick(stats, ...keys) {
  for (const k of keys) {
    if (stats[k] != null) {
      const n = toNum(stats[k]);
      if (n != null) return n;
    }
  }
  return null;
}
// "3-7" → attempted = 7
function attemptedOf(v) {
  if (v == null) return null;
  const parts = String(v).split('-');
  return parts.length === 2 ? toNum(parts[1]) : null;
}
// "21:30" → 1290 seconds; bare "27" → 27 minutes → 1620 seconds
function toiSeconds(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s.includes(':')) {
    const [mm, ss] = s.split(':').map(x => parseInt(x, 10));
    return (Number.isFinite(mm) && Number.isFinite(ss)) ? mm * 60 + ss : null;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * 60 : null;
}
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null; }
function sd(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1));
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function daysBetween(a, b) { return Math.floor(Math.abs(new Date(a) - new Date(b)) / 86400000); }

// ── gamelog fetch + flatten ───────────────────────────────────────────────────
async function getPlayerGamelog(athleteId, sport) {
  sport = (sport || '').toUpperCase();
  const leaguePath = LEAGUE_PATH[sport];
  if (!leaguePath || !athleteId) return null;

  const key = `${sport}:${athleteId}`;
  const cached = _glCache.get(key);
  if (cached && Date.now() - cached.ts < GL_TTL_MS) return cached.data;

  let d;
  try {
    const res = await axios.get(`${ESPN_COMMON}/${leaguePath}/athletes/${athleteId}/gamelog`, { timeout: 8000 });
    d = res.data;
  } catch (_) { return null; }

  const names  = d?.names  || [];
  const labels = d?.labels || [];
  const evMeta = d?.events || {};

  const series = [];
  const seen = new Set();
  for (const st of (d?.seasonTypes || [])) {
    for (const cat of (st?.categories || [])) {
      for (const ev of (cat?.events || [])) {
        if (!ev.eventId || seen.has(ev.eventId)) continue;
        seen.add(ev.eventId);
        const meta = evMeta[ev.eventId] || {};
        const stats = {};
        (ev.stats || []).forEach((v, i) => {
          if (names[i])  stats[names[i]]  = v;
          if (labels[i]) stats[labels[i]] = v;
        });
        series.push({ eventId: ev.eventId, date: meta.gameDate || meta.date || null, atVs: meta.atVs || null, stats });
      }
    }
  }
  series.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)); // recent-first

  const data = { athleteId: String(athleteId), sport, series };
  _glCache.set(key, { ts: Date.now(), data });
  return data;
}

// ── primary "form" stat per sport (read by label or machine name) ─────────────
const PRIMARY_LABEL = { NBA: 'PRA', WNBA: 'PRA', CBB: 'PRA', NHL: 'SOG', MLB: 'TB', NFL: 'YDS', NCAAF: 'YDS' };

function mlbTotalBases(s) {
  const h = pick(s, 'H', 'hits');
  if (h == null) return null;
  const dbl = pick(s, '2B', 'doubles');
  const tpl = pick(s, '3B', 'triples');
  const hr  = pick(s, 'HR', 'homeRuns');
  if (dbl != null || tpl != null) {
    const d = dbl || 0, t = tpl || 0, r = hr || 0;
    return Math.max(0, h - d - t - r) + 2 * d + 3 * t + 4 * r;
  }
  // 2B/3B not in this feed → approximate (non-HR hits counted as singles)
  const r = hr || 0;
  return (h - r) + 4 * r;
}

function primaryStat(sport, s, ctx = {}) {
  switch (sport) {
    case 'NBA': case 'WNBA': case 'CBB': {
      const p = pick(s, 'PTS', 'points');
      const r = pick(s, 'REB', 'rebounds', 'totalRebounds');
      const a = pick(s, 'AST', 'assists');
      if (p == null && r == null && a == null) return null;
      return (p || 0) + (r || 0) + (a || 0);
    }
    case 'NHL':
      return pick(s, 'SOG', 'S', 'shots', 'shotsTotal');
    case 'MLB':
      if (ctx.role === 'pitcher') return pick(s, 'K', 'SO', 'strikeouts');
      return mlbTotalBases(s);
    case 'NFL': case 'NCAAF': {
      const pos = (ctx.position || '').toUpperCase();
      if (pos === 'QB') return pick(s, 'passingYards', 'YDS');
      if (pos === 'RB') return (pick(s, 'rushingYards') || 0) + (pick(s, 'receivingYards') || 0);
      return pick(s, 'receivingYards', 'RECYDS');
    }
    default: return null;
  }
}

// 1-2 extra bettor-loved stats from THIS game's line.
function gameExtras(sport, s, ctx = {}) {
  switch (sport) {
    case 'NBA': case 'WNBA': case 'CBB': {
      const pra = primaryStat(sport, s, ctx);
      const fga = attemptedOf(s.FG ?? s['fieldGoalsMade-fieldGoalsAttempted']);
      const fta = attemptedOf(s.FT ?? s['freeThrowsMade-freeThrowsAttempted']);
      const tov = pick(s, 'TO', 'turnovers');
      const usg = fga != null ? Math.round((fga || 0) + 0.44 * (fta || 0) + (tov || 0)) : null;
      return [
        pra != null ? { label: 'PRA', value: pra } : null,
        usg != null ? { label: 'USG~', value: usg } : null,
      ].filter(Boolean);
    }
    case 'NHL': {
      const sog = pick(s, 'SOG', 'S', 'shots', 'shotsTotal');
      const toi = s.TOI ?? s.timeOnIce ?? s.avgTimeOnIce ?? null;
      return [
        sog != null ? { label: 'SOG', value: sog } : null,
        toi != null ? { label: 'TOI', value: String(toi) } : null,
      ].filter(Boolean);
    }
    case 'MLB': {
      if (ctx.role === 'pitcher') {
        const k  = pick(s, 'K', 'SO', 'strikeouts');
        const bb = pick(s, 'BB', 'walks');
        const h  = pick(s, 'H', 'hits');
        const ip = pick(s, 'IP', 'inningsPitched');
        const whip = (ip && ip > 0 && bb != null && h != null) ? +(((bb + h) / ip).toFixed(2)) : null;
        return [
          k != null ? { label: 'K', value: k } : null,
          whip != null ? { label: 'WHIP', value: whip } : null,
        ].filter(Boolean);
      }
      const tb = mlbTotalBases(s);
      const h  = pick(s, 'H', 'hits');
      return [
        tb != null ? { label: 'TB', value: tb } : null,
        h != null ? { label: 'H', value: h } : null,
      ].filter(Boolean);
    }
    case 'NFL': case 'NCAAF': {
      const pos = (ctx.position || '').toUpperCase();
      if (pos === 'QB') return [
        { label: 'PASS YDS', value: pick(s, 'passingYards', 'YDS') },
        { label: 'ATT', value: pick(s, 'passingAttempts') },
      ].filter(x => x.value != null);
      if (pos === 'RB') {
        const yds = (pick(s, 'rushingYards') || 0) + (pick(s, 'receivingYards') || 0);
        const tch = (pick(s, 'rushingAttempts') || 0) + (pick(s, 'receptions') || 0);
        return [{ label: 'YDS', value: yds }, { label: 'TCH', value: tch }];
      }
      return [
        { label: 'REC YDS', value: pick(s, 'receivingYards') },
        { label: 'TGT', value: pick(s, 'receivingTargets', 'targets') },
      ].filter(x => x.value != null);
    }
    default: return [];
  }
}

// ── Hot/Cold engine ────────────────────────────────────────────────────────────
const HOTCOLD = {
  NBA:         { short: 5,  baseline: 15, minGames: 4, minMin: 10 },
  WNBA:        { short: 5,  baseline: 12, minGames: 4, minMin: 10 },
  CBB:         { short: 5,  baseline: 13, minGames: 4, minMin: 10 },
  NHL:         { short: 10, baseline: 25, minGames: 6, minToi: 300 },
  MLB:         { short: 10, baseline: 30, minGames: 6 },
  MLB_PITCHER: { short: 3,  baseline: 9,  minGames: 2 },
  NFL:         { short: 3,  baseline: 7,  minGames: 2 },
  NCAAF:       { short: 3,  baseline: 6,  minGames: 2 },
};

function hotColdCfg(sport, ctx) {
  if (sport === 'MLB' && ctx.role === 'pitcher') return HOTCOLD.MLB_PITCHER;
  return HOTCOLD[sport];
}

function bucketFromZ(z) {
  return z >= 1.0 ? 'hot' : z >= 0.4 ? 'warm' : z > -0.4 ? 'neutral' : z > -1.0 ? 'cool' : 'cold';
}
function bucketFromRatio(r) {
  return r >= 1.25 ? 'hot' : r >= 1.10 ? 'warm' : r >= 0.90 ? 'neutral' : r >= 0.75 ? 'cool' : 'cold';
}

function computeHotCold(gamelog, sport, ctx = {}, beforeDate = null) {
  const cfg = hotColdCfg(sport, ctx);
  if (!gamelog || !gamelog.series || !cfg) return null;

  const played = gamelog.series.filter(g => {
    if (beforeDate && g.date && new Date(g.date) >= new Date(beforeDate)) return false;
    if (cfg.minMin != null) { const m = pick(g.stats, 'minutes', 'MIN'); if (m != null && m < cfg.minMin) return false; }
    if (cfg.minToi != null) { const t = toiSeconds(g.stats.timeOnIce ?? g.stats.TOI ?? g.stats.avgTimeOnIce); if (t != null && t < cfg.minToi) return false; }
    return primaryStat(sport, g.stats, ctx) != null;
  });

  const primaryName = (sport === 'MLB' && ctx.role === 'pitcher') ? 'K' : (PRIMARY_LABEL[sport] || 'form');
  if (played.length < cfg.minGames) {
    return { bucket: 'na', z: null, recent: null, baseline: null, n: played.length, primaryName };
  }

  const vals      = played.map(g => primaryStat(sport, g.stats, ctx));
  const baseVals  = vals.slice(0, cfg.baseline);
  const shortVals = vals.slice(0, cfg.short);
  const bMean = mean(baseVals), bSd = sd(baseVals), rMean = mean(shortVals);

  let bucket, z = null;
  if (bSd == null || bSd < 1e-6) {
    bucket = bucketFromRatio(bMean ? rMean / bMean : 1);
  } else {
    z = clamp((rMean - bMean) / bSd, -3, 3);
    if (shortVals.length < cfg.short) z *= shortVals.length / cfg.short; // shrink thin samples
    bucket = bucketFromZ(z);
  }
  return {
    bucket,
    z: z != null ? +z.toFixed(2) : null,
    recent: rMean != null ? +rMean.toFixed(1) : null,
    baseline: bMean != null ? +bMean.toFixed(1) : null,
    n: played.length,
    primaryName,
  };
}

// ── Freshness / Player Load engine (box-score ACWR + rest + density) ──────────
const REST_CURVE = { 0: 1.00, 1: 0.65, 2: 0.35, 3: 0.15 };
function restFactor(days) { return days >= 4 ? 0 : (REST_CURVE[days] ?? 0); }

const LOAD = {
  NBA:   { acuteN: 3, chronicN: 10, w: { acute: 0.48, rest: 0.32, density: 0.20 }, kind: 'minutes' },
  WNBA:  { acuteN: 3, chronicN: 10, w: { acute: 0.48, rest: 0.32, density: 0.20 }, kind: 'minutes' },
  CBB:   { acuteN: 2, chronicN: 6,  w: { acute: 0.50, rest: 0.35, density: 0.15 }, kind: 'minutes' },
  NHL:   { acuteN: 3, chronicN: 12, w: { acute: 0.42, rest: 0.33, density: 0.25 }, kind: 'toi' },
  NFL:   { acuteN: 2, chronicN: 4,  w: { acute: 0.50, rest: 0.30, density: 0.20 }, kind: 'touches' },
  NCAAF: { acuteN: 2, chronicN: 4,  w: { acute: 0.50, rest: 0.30, density: 0.20 }, kind: 'touches' },
};

function loadValue(sport, s, cfg, ctx) {
  if (cfg.kind === 'minutes') return pick(s, 'minutes', 'MIN');
  if (cfg.kind === 'toi')     return toiSeconds(s.timeOnIce ?? s.TOI ?? s.avgTimeOnIce);
  if (cfg.kind === 'touches') {
    const pos = (ctx.position || '').toUpperCase();
    if (pos === 'QB') return (pick(s, 'passingAttempts') || 0) + (pick(s, 'rushingAttempts') || 0);
    if (pos === 'RB') return (pick(s, 'rushingAttempts') || 0) + (pick(s, 'receptions') || 0);
    return pick(s, 'receivingTargets', 'targets') ?? pick(s, 'receptions');
  }
  return null;
}

function densityFactor(sport, priorDates, gameDate) {
  const all = [gameDate, ...priorDates].filter(Boolean);
  const within = n => all.filter(d => daysBetween(gameDate, d) <= n).length;
  const restToPrior = priorDates[0] ? daysBetween(gameDate, priorDates[0]) : 99;
  const b2b = restToPrior <= 1;
  if (sport === 'NHL') {
    return Math.max(b2b ? 0.7 : 0, within(6) >= 5 ? 1.0 : within(6) >= 4 ? 0.9 : 0);
  }
  if (sport === 'NFL' || sport === 'NCAAF') {
    return restToPrior <= 4 ? 1.0 : 0;
  }
  if (sport === 'CBB') {
    return Math.max(within(4) >= 3 ? 1.0 : 0, within(2) >= 2 ? 0.7 : 0);
  }
  // NBA / WNBA
  return Math.max(b2b ? 0.6 : 0, within(3) >= 3 ? 0.8 : 0, within(5) >= 4 ? 1.0 : 0);
}

function bandFor(score) {
  return score < 30 ? 'fresh' : score < 55 ? 'moderate' : score < 78 ? 'heavy' : 'overworked';
}

function mlbPitcherFreshness(gamelog, ctx, gameDate) {
  const prior = gamelog.series.filter(g => g.date && new Date(g.date) < new Date(gameDate));
  if (!prior.length) return { score: 10, band: 'fresh', note: 'Season start' };
  const prev = prior[0];
  const pitches = pick(prev.stats, 'pitches', 'pitchesThrown', 'PC');
  const ip = pick(prev.stats, 'IP', 'inningsPitched');
  let fPrev = 0;
  if (pitches != null)      fPrev = clamp((pitches - 75) / (115 - 75), 0, 1);
  else if (ip != null)      fPrev = clamp((ip - 4) / (7 - 4), 0, 1);
  const restDays = Math.max(0, daysBetween(gameDate, prev.date) - 1);
  const fRest = restDays <= 3 ? 1.0 : restDays === 4 ? 0.6 : restDays === 5 ? 0.2 : 0;
  const score = clamp(100 * (0.55 * fPrev + 0.45 * fRest), 0, 100);
  return { score: Math.round(score), band: bandFor(score), restDays, note: restDays <= 3 ? 'Short rest' : null };
}

// Position players don't carry a pitch count, so their "load" is a rest +
// schedule-density read, not a workload-intensity one. MLB plays nearly daily,
// so normal cadence reads light; a multi-day layoff reads fresh, and a doubleheader
// / congested week nudges up. Honest and low-drama — it's rest, not injury risk.
function mlbBatterFreshness(gamelog, gameDate) {
  const prior = gamelog.series.filter(g => g.date && new Date(g.date) < new Date(gameDate));
  if (!prior.length) return { score: 8, band: 'fresh', note: 'Season start' };
  const restDays = Math.max(0, daysBetween(gameDate, prior[0].date) - 1);
  const dates    = prior.map(g => g.date).filter(Boolean);
  const within7  = dates.filter(d => daysBetween(gameDate, d) <= 7).length;
  const fRest    = restDays >= 3 ? 0 : restDays === 2 ? 0.2 : restDays === 1 ? 0.45 : 0.6;
  const fDensity = clamp((within7 - 5) / (8 - 5), 0, 1); // 5/wk normal → 0, 8/wk congested → 1
  const score    = clamp(100 * (0.55 * fRest + 0.35 * fDensity), 0, 100);
  let note = null;
  if (restDays >= 3) note = 'Well rested';
  else if (within7 >= 7) note = 'Daily duty';
  return { score: Math.round(score), band: bandFor(score), restDays, note };
}

function computeFreshness(gamelog, sport, ctx = {}, gameDate = null) {
  if (!gamelog || !gamelog.series || !gameDate) return null;

  if (sport === 'MLB') {
    if (ctx.role === 'pitcher') return mlbPitcherFreshness(gamelog, ctx, gameDate);
    return mlbBatterFreshness(gamelog, gameDate);
  }

  const cfg = LOAD[sport];
  if (!cfg) return null;

  const prior = gamelog.series.filter(g => g.date && new Date(g.date) < new Date(gameDate));
  if (!prior.length) return { score: 8, band: 'fresh', note: 'Season start' };

  const loadOf  = g => loadValue(sport, g.stats, cfg, ctx);
  const acute   = prior.slice(0, cfg.acuteN).map(loadOf).filter(v => v != null);
  const chronic = prior.slice(0, cfg.chronicN).map(loadOf).filter(v => v != null);

  let fAcute = 0;
  if (acute.length && chronic.length) {
    const cMean = mean(chronic);
    const acwr = cMean > 0 ? mean(acute) / cMean : 1;
    fAcute = clamp((acwr - 0.8) / (1.8 - 0.8), 0, 1);
  }
  const restDays  = Math.max(0, daysBetween(gameDate, prior[0].date) - 1);
  const fRest     = restFactor(restDays);
  const fDensity  = densityFactor(sport, prior.map(g => g.date).filter(Boolean), gameDate);
  const w = cfg.w;
  const score = clamp(100 * (w.acute * fAcute + w.rest * fRest + w.density * fDensity), 0, 100);

  let note = null;
  if (restDays === 0) note = 'Back-to-back';
  else if (fDensity >= 0.8) note = 'Congested schedule';
  else if (restDays >= 3) note = 'Well rested';
  return { score: Math.round(score), band: bandFor(score), restDays, note };
}

// ── High-level assembler: everything the popup needs for one player ───────────
// boxStats = THIS game's stat line keyed by label (for display-derived extras if
// the gamelog row is missing). gamelog drives the computed metrics.
function buildPlayerForm(gamelog, sport, ctx = {}, eventId = null, fallbackStats = null) {
  sport = (sport || '').toUpperCase();
  const out = { primary: null, hotCold: null, freshness: null, extras: [] };
  if (!gamelog || !gamelog.series) {
    if (fallbackStats) out.extras = gameExtras(sport, fallbackStats, ctx);
    return out;
  }

  const thisGame = eventId ? gamelog.series.find(g => String(g.eventId) === String(eventId)) : null;
  const stats    = thisGame ? thisGame.stats : (fallbackStats || null);
  const gameDate = thisGame ? thisGame.date : null;

  if (stats) out.extras = gameExtras(sport, stats, ctx);

  if (gameDate) {
    out.hotCold   = computeHotCold(gamelog, sport, ctx, gameDate);
    out.freshness = computeFreshness(gamelog, sport, ctx, gameDate);

    // primary value this game + average + scale within the player's range
    const thisVal = stats ? primaryStat(sport, stats, ctx) : null;
    const prior   = gamelog.series.filter(g => g.date && new Date(g.date) < new Date(gameDate));
    const cfg     = hotColdCfg(sport, ctx);
    const window  = prior.slice(0, cfg ? cfg.baseline : 15).map(g => primaryStat(sport, g.stats, ctx)).filter(v => v != null);
    const shortN  = prior.slice(0, cfg ? cfg.short : 5).map(g => primaryStat(sport, g.stats, ctx)).filter(v => v != null);
    const avg     = mean(shortN);
    if (thisVal != null) {
      const pool = window.concat(thisVal);
      const lo = Math.min(...pool), hi = Math.max(...pool);
      out.primary = {
        label:    PRIMARY_LABEL[sport] || 'form',
        val:      thisVal,
        avg:      avg != null ? +avg.toFixed(1) : null,
        delta:    avg != null ? +(thisVal - avg).toFixed(1) : null,
        scalePct: hi > lo ? Math.round(((thisVal - lo) / (hi - lo)) * 100) : 50,
      };
    }
  }
  return out;
}

module.exports = {
  getPlayerGamelog,
  computeHotCold,
  computeFreshness,
  buildPlayerForm,
  primaryStat,
  gameExtras,
  PRIMARY_LABEL,
};
