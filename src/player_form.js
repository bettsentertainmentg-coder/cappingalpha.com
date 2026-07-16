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
        const opp  = meta.opponent || {};
        const stats = {};
        (ev.stats || []).forEach((v, i) => {
          if (names[i])  stats[names[i]]  = v;
          if (labels[i]) stats[labels[i]] = v;
        });
        series.push({
          eventId: ev.eventId,
          date:    meta.gameDate || meta.date || null,
          atVs:    meta.atVs || null,
          oppId:   opp.id || null,
          oppAbbr: opp.abbreviation || null,
          result:  meta.gameResult || null,
          score:   meta.score || null,
          stats,
        });
      }
    }
  }
  series.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)); // recent-first

  const data = { athleteId: String(athleteId), sport, series };
  _glCache.set(key, { ts: Date.now(), data });
  return data;
}

// ── primary "form" stat per sport (read by label or machine name) ─────────────
// MLB hitters use "TB+" = total bases + walks + HBP (on-base-inclusive, so a guy
// who walks and singles isn't graded as cold). Pitchers use K-BB (net strikeouts).
const PRIMARY_LABEL = { NBA: 'PRA', WNBA: 'PRA', CBB: 'PRA', NHL: 'SOG', MLB: 'TB+', NFL: 'YDS', NCAAF: 'YDS' };

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

// On-base-inclusive hitter value: total bases (via hits) plus a base for each
// walk and hit-by-pitch. A simple "bases reached" proxy (not true wOBA) so
// on-base skill counts toward form, matching what the hot-hand research measured.
function mlbBatterValue(s) {
  const tb = mlbTotalBases(s);
  if (tb == null) return null;
  const bb  = pick(s, 'BB', 'walks') || 0;
  const hbp = pick(s, 'HBP', 'hitByPitch') || 0;
  return tb + bb + hbp;
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
      if (ctx.role === 'pitcher') {
        const k = pick(s, 'K', 'SO', 'strikeouts');
        if (k == null) return null;
        return k - (pick(s, 'BB', 'walks') || 0); // net strikeouts (K-BB)
      }
      return mlbBatterValue(s);
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
  MLB:         { short: 7,  baseline: 42, minGames: 6 },
  MLB_PITCHER: { short: 3,  baseline: 9,  minGames: 2 },
  NFL:         { short: 3,  baseline: 7,  minGames: 2 },
  NCAAF:       { short: 3,  baseline: 6,  minGames: 2 },
};

function hotColdCfg(sport, ctx) {
  if (sport === 'MLB' && ctx.role === 'pitcher') return HOTCOLD.MLB_PITCHER;
  return HOTCOLD[sport];
}

// League-relative reference for the Hot/Cold blend: a typical MLB regular's
// per-game total bases (mean + game-to-game SD). selfWeight keeps the player's
// own baseline the bigger factor (the rest is "vs an average regular"). Tunable.
const LEAGUE_FORM = {
  // Metric is TB+ (total bases + walks + HBP): a typical regular ≈ 1.85/game.
  MLB: { mean: 1.85, sd: 1.5, selfWeight: 0.70 },
};

// Exponentially weighted mean of a recent-first list: newest game weight 1, each
// older game ×decay. Recency bias without a hard window cutoff.
function ewma(vals, decay) {
  let vsum = 0, wsum = 0, w = 1;
  for (const v of vals) {
    if (v == null) continue;
    vsum += w * v; wsum += w; w *= decay;
  }
  return wsum ? vsum / wsum : null;
}

function bucketFromZ(z) {
  return z >= 1.0 ? 'hot' : z >= 0.4 ? 'warm' : z > -0.4 ? 'neutral' : z > -1.0 ? 'cool' : 'cold';
}
function bucketFromRatio(r) {
  return r >= 1.25 ? 'hot' : r >= 1.10 ? 'warm' : r >= 0.90 ? 'neutral' : r >= 0.75 ? 'cool' : 'cold';
}

// Plain-English stat names so the "why" never leans on abbreviations.
const PRIMARY_DESC = {
  PRA: 'points, rebounds & assists',
  SOG: 'shots on goal',
  'TB+': 'bases (hits + walks)',
  'K-BB': 'strikeouts vs walks',
  YDS: 'yards',
};

function gamesAgo(i) { return i === 0 ? 'last game' : `${i + 1} games ago`; }

// Women's leagues — form notes read "her", every other tracked league reads "his".
const WOMENS_SPORTS = new Set(['WNBA', 'WTA']);

// Build a short, plain explanation for the Form reading — the real drivers,
// no formula. It varies the window (3/5/7/10) to whichever best shows the trend
// (so it's not always "last 7"), compares to their own norm + a typical regular,
// and calls out a standout recent game (homers for MLB, a big game otherwise).
// EVEN stays light; hot/cold/sharp/wild get the fuller read. `vals` are the
// recent-first primary-stat values; `played` the matching recent-first games.
function formReasons(sport, ctx, bucket, vals, baseline, primaryName, lf, played) {
  if (!bucket || bucket === 'na' || baseline == null || !vals || !vals.length) return [];
  const label = PRIMARY_DESC[primaryName] || (primaryName || 'production').toLowerCase();
  const her = WOMENS_SPORTS.has(String(sport || '').toUpperCase());
  const pos = her ? 'her' : 'his', Pos = her ? 'Her' : 'His';
  const b = +baseline.toFixed(1);
  const up = bucket === 'hot' || bucket === 'warm';
  const down = bucket === 'cold' || bucket === 'cool';
  const strong = bucket === 'hot' || bucket === 'cold';
  const wMean = w => mean(vals.slice(0, Math.min(w, vals.length)));

  // Pick the window that best shows the trend so the note isn't always "last 7".
  let win = Math.min(7, vals.length);
  if (up || down) {
    const wins = [3, 5, 7, 10].filter(w => vals.length >= w);
    if (wins.length) {
      let best = wins[0];
      for (const w of wins) {
        if (up && wMean(w) > wMean(best)) best = w;
        if (down && wMean(w) < wMean(best)) best = w;
      }
      win = best;
    }
  } else {
    win = Math.min(10, vals.length); // steady → longest stable read
  }
  const r = +wMean(win).toFixed(1);

  const reasons = [];
  if (bucket === 'neutral') {
    reasons.push(`Steady, about ${r} ${label} a game over ${pos} last ${win}.`);
  } else {
    reasons.push(`${Pos} last ${win} games (${r} ${label} a game) are ${strong ? 'well' : 'a bit'} ${up ? 'above' : 'below'} ${pos} season norm (${b}).`);
    if (lf) {
      if (r > lf.mean * 1.05)      reasons.push(`Ahead of a typical hitter (~${lf.mean}).`);
      else if (r < lf.mean * 0.95) reasons.push(`Behind a typical hitter (~${lf.mean}).`);
    }
  }

  // Standout driver: a big single game that's carrying (or punctuating) the read.
  const recentN = Math.min(vals.length, 10);
  if (sport === 'MLB' && ctx.role !== 'pitcher' && played) {
    let hr = 0, hrIdx = -1;
    for (let i = 0; i < Math.min(played.length, 10); i++) {
      const g = pick(played[i].stats, 'HR', 'homeRuns') || 0;
      if (g > hr) { hr = g; hrIdx = i; }
    }
    if (hr >= 2) reasons.push(`${hr} homers ${gamesAgo(hrIdx)}.`);
    else if (hr === 1 && hrIdx <= 1) reasons.push(`Homered ${gamesAgo(hrIdx)}.`);
  } else {
    let hiIdx = 0;
    for (let i = 1; i < recentN; i++) if (vals[i] > vals[hiIdx]) hiIdx = i;
    const hv = +vals[hiIdx].toFixed(1);
    if (hv >= b * 1.5 && hv >= r * 1.25) {
      if (up)                   reasons.push(`A ${hv}-${label} game ${gamesAgo(hiIdx)} has carried it.`);
      else if (bucket === 'neutral') reasons.push(`One ${hv}-${label} game ${gamesAgo(hiIdx)}, otherwise level.`);
    }
  }

  return reasons.slice(0, 3);
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

  const primaryName = (sport === 'MLB' && ctx.role === 'pitcher') ? 'K-BB' : (PRIMARY_LABEL[sport] || 'form');
  if (played.length < cfg.minGames) {
    return { bucket: 'na', z: null, recent: null, baseline: null, n: played.length, primaryName };
  }

  const vals      = played.map(g => primaryStat(sport, g.stats, ctx));
  const baseVals  = vals.slice(0, cfg.baseline);
  const bMean = mean(baseVals), bSd = sd(baseVals);
  // Recent form = exponentially weighted mean (newest games count more), no hard
  // window edge. Half-life = short/2 games → decay 0.82 for MLB hitters, i.e. the
  // 7th-most-recent game ≈ 30% the weight of the latest. Baseline stays a flat,
  // stable long average (their true normal). Tunable via the half-life divisor.
  const decay      = Math.pow(0.5, 1 / Math.max(1, cfg.short / 2));
  const rMean      = ewma(vals.slice(0, cfg.short * 3), decay);
  const shortCount = Math.min(vals.length, cfg.short);

  // League reference (MLB hitters only) — used in both the blend and the "why".
  const lf = (sport === 'MLB' && ctx.role !== 'pitcher') ? LEAGUE_FORM.MLB : null;

  let bucket, z = null;
  if (bSd == null || bSd < 1e-6) {
    bucket = bucketFromRatio(bMean ? rMean / bMean : 1);
  } else {
    let selfZ = clamp((rMean - bMean) / bSd, -3, 3);
    if (shortCount < cfg.short) selfZ *= shortCount / cfg.short; // shrink thin samples
    z = selfZ;
    // Blend in a league-relative read so production well above (or below) a
    // typical regular registers, not just movement vs the player's own bar.
    if (lf) {
      const leagueZ = clamp((rMean - lf.mean) / lf.sd, -3, 3);
      z = lf.selfWeight * selfZ + (1 - lf.selfWeight) * leagueZ;
    }
    bucket = bucketFromZ(z);
  }

  return {
    bucket,
    z: z != null ? +z.toFixed(2) : null,
    recent: rMean != null ? +rMean.toFixed(1) : null,
    baseline: bMean != null ? +bMean.toFixed(1) : null,
    n: played.length,
    primaryName,
    reasons: formReasons(sport, ctx, bucket, vals, bMean, primaryName, lf, played),
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

// Five bands so the dial label tracks the colour: "Heavy" / "Very Heavy" sit in
// the orange-red, while a needle just past the middle reads "Elevated".
function bandFor(score) {
  return score < 28 ? 'fresh'
       : score < 48 ? 'moderate'
       : score < 66 ? 'elevated'
       : score < 84 ? 'heavy'
       : 'overworked';
}

function mlbPitcherFreshness(gamelog, ctx, gameDate) {
  const prior = gamelog.series.filter(g => g.date && new Date(g.date) < new Date(gameDate));
  if (!prior.length) return { score: 10, band: 'fresh', note: 'Season start', n: 0 };

  const restDays = Math.max(0, daysBetween(gameDate, prior[0].date) - 1);
  const apps3    = prior.filter(g => daysBetween(gameDate, g.date) <= 3).length;
  const apps4    = prior.filter(g => daysBetween(gameDate, g.date) <= 4).length;
  const ipLast   = pick(prior[0].stats, 'IP', 'inningsPitched');
  const pos      = (ctx.position || '').toUpperCase();
  // Relievers pitch often in short bursts; starters pitch once then rest days.
  const isReliever = pos === 'RP' || apps4 >= 2 || (pos !== 'SP' && ipLast != null && ipLast <= 3);

  if (isReliever) {
    // Bullpen load is appearance frequency + back-to-back days, not one big start.
    const b2b      = restDays === 0; // pitched yesterday
    const pitches3 = prior.filter(g => daysBetween(gameDate, g.date) <= 3)
      .reduce((s, g) => s + (pick(g.stats, 'pitches', 'pitchesThrown', 'PC')
        ?? (pick(g.stats, 'IP', 'inningsPitched') || 0) * 16), 0);
    const fFreq = clamp((apps3 - 1) / (3 - 1), 0, 1);        // 1 app/3d → 0, 3 → maxed
    const fB2b  = b2b ? 1 : restDays === 1 ? 0.4 : 0;
    const fVol  = clamp((pitches3 - 25) / (70 - 25), 0, 1);  // recent pitch volume
    const score = clamp(100 * (0.45 * fFreq + 0.30 * fB2b + 0.25 * fVol), 0, 100);
    const note  = b2b ? 'Pitched yesterday' : apps3 >= 3 ? 'Heavy recent usage' : restDays >= 4 ? 'Rested' : null;
    return { score: Math.round(score), band: bandFor(score), restDays, note, n: prior.length, role: 'reliever' };
  }

  // Starter: a single outing, then multi-day rest; short rest elevates load.
  const prev    = prior[0];
  const pitches = pick(prev.stats, 'pitches', 'pitchesThrown', 'PC');
  const ip      = pick(prev.stats, 'IP', 'inningsPitched');
  let fPrev = 0;
  if (pitches != null)      fPrev = clamp((pitches - 75) / (115 - 75), 0, 1);
  else if (ip != null)      fPrev = clamp((ip - 4) / (7 - 4), 0, 1);
  const fRest = restDays <= 3 ? 1.0 : restDays === 4 ? 0.6 : restDays === 5 ? 0.2 : 0;
  const score = clamp(100 * (0.55 * fPrev + 0.45 * fRest), 0, 100);
  return { score: Math.round(score), band: bandFor(score), restDays, note: restDays <= 3 ? 'Short rest' : null, n: prior.length, role: 'starter' };
}

// Position players don't carry a pitch count, so their "load" is a rest +
// schedule-density read, not a workload-intensity one. MLB plays nearly daily,
// so normal cadence reads light; a multi-day layoff reads fresh, and a doubleheader
// / congested week nudges up. Honest and low-drama — it's rest, not injury risk.
function mlbBatterFreshness(gamelog, gameDate) {
  const prior = gamelog.series.filter(g => g.date && new Date(g.date) < new Date(gameDate));
  if (!prior.length) return { score: 8, band: 'fresh', note: 'Season start', n: 0 };
  const restDays = Math.max(0, daysBetween(gameDate, prior[0].date) - 1);
  const dates    = prior.map(g => g.date).filter(Boolean);
  const within7  = dates.filter(d => daysBetween(gameDate, d) <= 7).length;
  const fRest    = restDays >= 3 ? 0 : restDays === 2 ? 0.2 : restDays === 1 ? 0.45 : 0.6;
  const fDensity = clamp((within7 - 5) / (8 - 5), 0, 1); // 5/wk normal → 0, 8/wk congested → 1
  const score    = clamp(100 * (0.55 * fRest + 0.35 * fDensity), 0, 100);
  let note = null;
  if (restDays >= 3) note = 'Well rested';
  else if (within7 >= 7) note = 'Daily duty';
  return { score: Math.round(score), band: bandFor(score), restDays, note, n: prior.length };
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
  if (!prior.length) return { score: 8, band: 'fresh', note: 'Season start', n: 0 };

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
  return { score: Math.round(score), band: bandFor(score), restDays, note, n: prior.length };
}

// ── Usage / role trend (is the player's workload climbing or fading?) ─────────
// Reads the same workload stat the Load engine uses (minutes / time-on-ice /
// touches / pitch count) and compares the last few games to the window behind
// them. This is "are they being leaned on more or less lately," not load itself.
function usageStat(sport, s, ctx = {}) {
  switch (sport) {
    case 'NBA': case 'WNBA': case 'CBB': return pick(s, 'minutes', 'MIN');
    case 'NHL': return toiSeconds(s.timeOnIce ?? s.TOI ?? s.avgTimeOnIce);
    case 'NFL': case 'NCAAF': {
      const pos = (ctx.position || '').toUpperCase();
      if (pos === 'QB') return (pick(s, 'passingAttempts') || 0) + (pick(s, 'rushingAttempts') || 0);
      if (pos === 'RB') return (pick(s, 'rushingAttempts') || 0) + (pick(s, 'receptions') || 0);
      return pick(s, 'receivingTargets', 'targets') ?? pick(s, 'receptions');
    }
    case 'MLB':
      if (ctx.role === 'pitcher') return pick(s, 'pitches', 'pitchesThrown', 'PC') ?? pick(s, 'IP', 'inningsPitched');
      return null; // position players carry no usage-intensity signal
    default: return null;
  }
}
const USAGE_UNIT = { NBA: 'MIN', WNBA: 'MIN', CBB: 'MIN', NHL: 'TOI', NFL: 'TCH', NCAAF: 'TCH', MLB: 'PC' };

function computeUsageTrend(gamelog, sport, ctx = {}, beforeDate = null) {
  sport = (sport || '').toUpperCase();
  if (!gamelog || !gamelog.series) return null;
  const prior = gamelog.series.filter(g => !beforeDate || (g.date && new Date(g.date) < new Date(beforeDate)));
  const vals = prior.map(g => usageStat(sport, g.stats, ctx)).filter(v => v != null);
  if (vals.length < 3) return null;
  const recentN = sport === 'NFL' || sport === 'NCAAF' ? 2 : 3;
  const recent = mean(vals.slice(0, recentN));
  const prevSlice = vals.slice(recentN, recentN + Math.max(recentN, 4));
  const before = prevSlice.length ? mean(prevSlice) : null;
  if (recent == null) return null;
  let dir = 'flat';
  if (before != null) {
    if (recent > before * 1.08) dir = 'up';
    else if (recent < before * 0.92) dir = 'down';
  }
  const fmt = v => sport === 'NHL' ? Math.round(v / 60) + "'" : Math.round(v);
  return { unit: USAGE_UNIT[sport] || '', dir, recent: fmt(recent), prior: before != null ? fmt(before) : null };
}

// ── Home/away + head-to-head production splits ────────────────────────────────
// Average of the player's primary stat at home vs on the road, and vs tonight's
// opponent specifically. Small-sample by nature, so n is always returned.
function computeSplits(gamelog, sport, ctx = {}, beforeDate = null, oppId = null) {
  sport = (sport || '').toUpperCase();
  if (!gamelog || !gamelog.series) return null;
  const prior = gamelog.series.filter(g => !beforeDate || (g.date && new Date(g.date) < new Date(beforeDate)));
  const label = (sport === 'MLB' && ctx.role === 'pitcher') ? 'K' : (PRIMARY_LABEL[sport] || 'form');
  const homeVals = [], awayVals = [], oppVals = [];
  const oppRec = { w: 0, l: 0 };
  for (const g of prior) {
    const v = primaryStat(sport, g.stats, ctx);
    if (v == null) continue;
    const at = String(g.atVs || '').trim();
    if (/^(vs|home|h)$/i.test(at)) homeVals.push(v);
    else if (/^(@|away|a)$/i.test(at)) awayVals.push(v);
    if (oppId && g.oppId != null && String(g.oppId) === String(oppId)) {
      oppVals.push(v);
      if (g.result === 'W') oppRec.w++; else if (g.result === 'L') oppRec.l++;
    }
  }
  const avg = a => a.length ? +mean(a).toFixed(1) : null;
  return {
    label,
    home: { avg: avg(homeVals), n: homeVals.length },
    away: { avg: avg(awayVals), n: awayVals.length },
    vsOpp: oppVals.length ? { avg: avg(oppVals), n: oppVals.length, record: `${oppRec.w}-${oppRec.l}` } : null,
  };
}

// ── Recent batting note (MLB hitters) ────────────────────────────────────────
// A short, bettor-friendly read on what a hitter has done lately — power first,
// then on-base streaks, then a plain hit count. Returns { text, tone } or null.
function computeBatterNote(gamelog, beforeDate = null) {
  if (!gamelog || !gamelog.series) return null;
  const prior  = gamelog.series.filter(g => !beforeDate || (g.date && new Date(g.date) < new Date(beforeDate)));
  const played = prior.filter(g => { const ab = pick(g.stats, 'AB', 'atBats'); return ab != null && ab > 0; });
  if (!played.length) return null;

  // Window (last 5) is shown once in the column header, not repeated per cell.
  const last5 = played.slice(0, 5);
  const hr5   = last5.reduce((s, g) => s + (pick(g.stats, 'HR', 'homeRuns') || 0), 0);
  const h5    = last5.reduce((s, g) => s + (pick(g.stats, 'H', 'hits') || 0), 0);
  const multi = last5.filter(g => (pick(g.stats, 'H', 'hits') || 0) >= 2).length;
  let streak = 0;
  for (const g of played) { const h = pick(g.stats, 'H', 'hits'); if (h != null && h >= 1) streak++; else break; }

  if (hr5 >= 1)      return { text: `${hr5} HR`,              tone: hr5 >= 2 ? 'hot' : 'neutral' };
  if (streak >= 3)   return { text: `${streak}-gm hit streak`, tone: streak >= 4 ? 'hot' : 'neutral' };
  if (multi >= 2)    return { text: `${multi} multi-hit`,     tone: 'neutral' };
  if (h5 === 0)      return { text: `0 H`,                    tone: 'cold' };
  return { text: `${h5} H`, tone: 'neutral' };
}

// ESPN innings pitched use baseball notation: "6.1" = 6⅓, "6.2" = 6⅔.
function parseInnings(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '-') return null;
  const [w, f] = s.split('.');
  const whole = parseInt(w, 10);
  if (!Number.isFinite(whole)) return null;
  const frac = f ? parseInt(f[0], 10) : 0;
  return whole + (Number.isFinite(frac) ? frac / 3 : 0);
}

// Recent ERA over the last several outings (accumulate to ~15 IP so it's stable
// for starters and relievers alike). This is the RESULTS axis — distinct from Form
// (K-BB peripherals = command) and Load (fatigue). Returns { text, tone }.
function computePitcherRecent(gamelog, beforeDate = null) {
  if (!gamelog || !gamelog.series) return null;
  const prior = gamelog.series.filter(g => !beforeDate || (g.date && new Date(g.date) < new Date(beforeDate)));
  let er = 0, ip = 0, n = 0;
  for (const g of prior) {
    const gIp = parseInnings(pick(g.stats, 'IP', 'inningsPitched'));
    if (gIp == null) continue;
    er += (pick(g.stats, 'ER', 'earnedRuns') || 0);
    ip += gIp; n++;
    if (ip >= 15 || n >= 10) break;
  }
  if (ip <= 0 || n === 0) return null;
  const era = (er / ip) * 9;
  const tone = era <= 3.00 ? 'good' : era >= 4.75 ? 'bad' : 'neutral';
  return { text: `${era.toFixed(2)} ERA`, tone, n, ip: +ip.toFixed(1) };
}

// Batting-average string: ".285", "1.000".
function avgStr(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return x >= 1 ? x.toFixed(3) : '.' + Math.round(x * 1000).toString().padStart(3, '0');
}

// One or two recognizable SEASON averages to show under a player's name (clear
// labels, no internal abbreviations). MLB hitters: bases/game + batting average;
// pitchers: ERA + WHIP; other sports: the primary stat per game.
function computeKeyAverages(gamelog, sport, ctx = {}, beforeDate = null) {
  if (!gamelog || !gamelog.series) return [];
  sport = (sport || '').toUpperCase();
  const games = gamelog.series.filter(g => !beforeDate || (g.date && new Date(g.date) < new Date(beforeDate)));
  if (!games.length) return [];
  const out = [];

  if (sport === 'MLB' && ctx.role !== 'pitcher') {
    let h = 0, ab = 0, bases = 0, n = 0;
    for (const g of games.slice(0, 42)) {
      const a = pick(g.stats, 'AB', 'atBats');
      if (a == null) continue;
      h += pick(g.stats, 'H', 'hits') || 0; ab += a;
      const bv = mlbBatterValue(g.stats); if (bv != null) { bases += bv; n++; }
    }
    if (n)  out.push({ label: 'bases/gm', val: (bases / n).toFixed(1) });
    if (ab) out.push({ label: 'AVG', val: avgStr(h / ab) });
  } else if (sport === 'MLB') {
    let er = 0, ip = 0, bb = 0, h = 0;
    for (const g of games.slice(0, 12)) {
      const gip = parseInnings(pick(g.stats, 'IP', 'inningsPitched'));
      if (gip == null) continue;
      er += pick(g.stats, 'ER', 'earnedRuns') || 0; ip += gip;
      bb += pick(g.stats, 'BB', 'walks') || 0; h += pick(g.stats, 'H', 'hits') || 0;
    }
    if (ip > 0) { out.push({ label: 'ERA', val: ((er / ip) * 9).toFixed(2) }); out.push({ label: 'WHIP', val: ((bb + h) / ip).toFixed(2) }); }
  } else {
    let s = 0, c = 0;
    for (const g of games.slice(0, 20)) { const v = primaryStat(sport, g.stats, ctx); if (v != null) { s += v; c++; } }
    if (c) out.push({ label: (PRIMARY_LABEL[sport] || 'avg') + '/gm', val: (s / c).toFixed(1) });
  }
  return out;
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
  computeUsageTrend,
  computeSplits,
  computeBatterNote,
  computePitcherRecent,
  computeKeyAverages,
  bandFor,
  buildPlayerForm,
  primaryStat,
  gameExtras,
  PRIMARY_LABEL,
};
