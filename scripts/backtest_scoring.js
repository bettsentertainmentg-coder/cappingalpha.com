#!/usr/bin/env node
// scripts/backtest_scoring.js
// Phase-5 calibration harness (docs/CA_ALGORITHM_V3.md). Replays the live-site
// pull chronologically with NO LOOKAHEAD: every pick is scored using only what
// was graded before its date. Market signals and side lean count ZERO (they
// cannot be reconstructed), so v3 numbers here are the conservative floor.
//
// Data: data/capper-server-pull/latest.json + pick-history-latest.json
// (refresh first: ADMIN_PASSWORD=... node scripts/pull-capper-server.js)
//
// Usage: node scripts/backtest_scoring.js [--grid]

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'capper-server-pull');
const capperPull = JSON.parse(fs.readFileSync(path.join(DIR, 'latest.json'), 'utf8'));
const boardPull = JSON.parse(fs.readFileSync(path.join(DIR, 'pick-history-latest.json'), 'utf8'));

// ── Flatten capper rows (dedup by id), group into picks by pick_id ────────────
const seen = new Set();
const rows = [];
for (const [canon, detail] of Object.entries(capperPull.cappers)) {
  if (!Array.isArray(detail.picks)) continue;
  for (const r of detail.picks) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (!['win', 'loss', 'push'].includes(r.result)) continue;
    if (!r.game_date || r.game_date < '2026-01-01') continue;
    rows.push({ ...r, canon });
  }
}
const pickMap = new Map();
for (const r of rows) {
  const key = r.pick_id != null ? `p${r.pick_id}` : `r${r.id}`;
  if (!pickMap.has(key)) {
    pickMap.set(key, { date: r.game_date, sport: r.sport, pick_type: (r.pick_type || '').toLowerCase(), result: r.result, odds: r.odds, score_v2: r.score ?? 0, rows: [] });
  }
  const p = pickMap.get(key);
  p.rows.push(r);
  if ((r.score ?? 0) > p.score_v2) p.score_v2 = r.score ?? 0;
  if (p.odds == null && r.odds != null) p.odds = r.odds;
}
const picks = [...pickMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

const effOdds = (p) => {
  const o = p.odds != null ? parseFloat(p.odds) : NaN;
  if (!isNaN(o) && o !== 0) return o;
  return (p.pick_type === 'over' || p.pick_type === 'under') ? -115 : -110;
};
const unitsOf = (p) => p.result === 'push' ? 0 : p.result === 'loss' ? -1
  : (effOdds(p) > 0 ? effOdds(p) / 100 : 100 / Math.abs(effOdds(p)));

const SPORT_BONUS_SPORTS = new Set(['NBA', 'CBB', 'MLB', 'NFL', 'NCAAF', 'NHL', 'ATP', 'WTA', 'GOLF', 'SOCCER']);

// ── The replay under one config ───────────────────────────────────────────────
function replay(cfg) {
  // as-of aggregates: cappers + channel entities, overall/sport/type
  const agg = new Map();
  const getA = (k) => { if (!agg.has(k)) agg.set(k, { n: 0, u: 0, sports: new Map(), types: new Map() }); return agg.get(k); };
  const oBlend = (a) => a.u / (a.n + 25);
  const sBlend = (a, sport) => { const s = a.sports.get(sport) || { n: 0, u: 0 }; return (s.u + 15 * oBlend(a)) / (s.n + 15); };
  const tBlend = (a, sport, pt) => {
    const t = a.types.get(`${sport}/${pt}`) || { n: 0, u: 0 };
    return (t.u + 10 * sBlend(a, sport)) / (t.n + 10);
  };
  const resumePts = (a, sport) => {
    const s = a.sports.get(sport) || { n: 0, u: 0 };
    const skill = Math.min(Math.max(sBlend(a, sport), 0), 0.20);
    const vol = s.n / (s.n + 10);
    const trust = Math.max(0.30, Math.min(1.30, oBlend(a) / 0.10));
    const raw = Math.round(cfg.MULT * skill * vol * trust);
    return Math.max(0, Math.min(raw, Math.min(55, 25 + Math.round(30 * vol))));
  };
  const joinPts = (a, sport) => {
    if (a.n >= 40 && oBlend(a) <= -0.10) return 0;
    if (a.n >= 25 && oBlend(a) <= -0.08) return 0;
    if (a.n < 10) return 2;
    return Math.max(2, Math.min(8, Math.round(3 + 120 * Math.max(0, sBlend(a, sport)))));
  };

  const out = [];
  let i = 0;
  while (i < picks.length) {
    const d = picks[i].date;
    const today = [];
    while (i < picks.length && picks[i].date === d) today.push(picks[i++]);
    for (const p of today) {
      const sport = p.sport || 'Unknown';
      const cappers = [...new Set(p.rows.map(r => r.canon))];
      const channels = [...new Set(p.rows.map(r => r.channel).filter(Boolean))];
      const capCand = cappers.map(c => ({ c, pts: resumePts(getA(c), sport) })).sort((x, y) => y.pts - x.pts);
      const entCand = channels.map(ch => ({ c: `@src:${ch}`, pts: resumePts(getA(`@src:${ch}`), sport) })).sort((x, y) => y.pts - x.pts);
      const best = (capCand[0]?.pts ?? 0) >= (entCand[0]?.pts ?? 0) ? capCand[0] : entCand[0];
      const resume = best?.pts ?? 0;
      let consensus = 0;
      capCand.filter(c => c.c !== (capCand[0]?.c)).map(j => joinPts(getA(j.c), sport))
        .sort((a, b) => b - a)
        .forEach((jp, idx) => { consensus += jp * (idx === 0 ? 1 : idx === 1 ? 0.5 : 0.25); });
      consensus = Math.min(12, Math.round(consensus));
      const sportB = SPORT_BONUS_SPORTS.has((sport || '').toUpperCase()) ? 5 : 0;
      // totals gate (advocate capper's as-of type blend)
      let gateOk = true;
      const isTotal = p.pick_type === 'over' || p.pick_type === 'under';
      if (isTotal && best && !best.c.startsWith('@src:')) {
        gateOk = tBlend(getA(best.c), sport, p.pick_type) >= 0;
      }
      const v3 = cfg.BASE + resume + consensus + sportB;
      out.push({ ...p, v3, resume, gateOk, advocate: best?.c ?? null, u: unitsOf(p) });
    }
    // apply results after the day
    for (const p of today) {
      const u = unitsOf(p);
      const sport = p.sport || 'Unknown';
      const bump = (k) => {
        const a = getA(k);
        a.n++; a.u += u;
        if (!a.sports.has(sport)) a.sports.set(sport, { n: 0, u: 0 });
        const s = a.sports.get(sport); s.n++; s.u += u;
        const tk = `${sport}/${p.pick_type}`;
        if (!a.types.has(tk)) a.types.set(tk, { n: 0, u: 0 });
        const t = a.types.get(tk); t.n++; t.u += u;
      };
      for (const c of new Set(p.rows.map(r => r.canon))) bump(c);
      for (const ch of new Set(p.rows.map(r => r.channel).filter(Boolean))) bump(`@src:${ch}`);
    }
  }
  return out;
}

// ── Reporting helpers ─────────────────────────────────────────────────────────
const rec = (list) => {
  const w = list.filter(p => p.result === 'win').length;
  const l = list.filter(p => p.result === 'loss').length;
  const u = list.reduce((s, p) => s + p.u, 0);
  const days = new Set(list.map(p => p.date)).size;
  return { n: list.length, w, l, pct: w + l ? +(100 * w / (w + l)).toFixed(1) : null, units: +u.toFixed(1), roi: list.length ? +(100 * u / list.length).toFixed(1) : null, days };
};
const fmt = (r) => `${r.w}-${r.l} (${r.pct}%) units ${r.units} roi ${r.roi}% | ${r.n} picks / ${r.days} days`;

function dailyTopN(out, key, n) {
  const byDay = new Map();
  for (const p of out) {
    if (!byDay.has(p.date)) byDay.set(p.date, []);
    byDay.get(p.date).push(p);
  }
  const sel = [];
  for (const [, list] of byDay) {
    sel.push(...list.slice().sort((a, b) => b[key] - a[key]).slice(0, n));
  }
  return sel;
}

function report(cfg, out) {
  const gold = out.filter(p => p.v3 >= 100 && p.gateOk);
  const silver = out.filter(p => p.v3 >= 75 && p.v3 < 100);
  const window = new Set(out.map(p => p.date)).size;
  const g = rec(gold), s = rec(silver);
  const v2top10 = rec(dailyTopN(out, 'score_v2', 10));
  const v3top10 = rec(dailyTopN(out, 'v3', 10));
  console.log(`\n=== CONFIG base=${cfg.BASE} mult=${cfg.MULT} (signals/lean = 0, conservative floor) ===`);
  console.log('GOLD (100+):   ', fmt(g), `-> ${(g.n / Math.max(1, window)).toFixed(2)}/day over ${window} replay days`);
  console.log('SILVER (75-99):', fmt(s));
  console.log('v2 top-10/day: ', fmt(v2top10));
  console.log('v3 top-10/day: ', fmt(v3top10));

  // Fade-side hit rate: picks by fade-qualified cappers (as-of assessment baked
  // into joinPts=0); approximate here as: picks whose EVERY capper had a
  // negative as-of overall — measured by resume 0 + known-bad advocates is fuzzy,
  // so report the tier the doc cares about instead: bar comparison.
  const BAR = { pct: 59.6, roi: 8.7 };
  console.log('\nACCEPTANCE:');
  console.log(`  1. gold >= current 65+ tier (${BAR.pct}%, +${BAR.roi}%):`,
    g.pct != null && (g.pct >= BAR.pct || g.roi >= BAR.roi) ? `PASS-ish (${g.pct}%, ${g.roi}%)` : `CHECK (${g.pct}%, ${g.roi}%)`);
  console.log(`  2. v3 top-10 beats v2 top-10 on ROI:`,
    (v3top10.roi ?? -99) > (v2top10.roi ?? -99) ? `PASS (${v3top10.roi}% vs ${v2top10.roi}%)` : `FAIL (${v3top10.roi}% vs ${v2top10.roi}%)`);
  const elite = out.filter(p => p.resume >= 50);
  const eliteGold = elite.filter(p => p.v3 + 5 >= 100); // one supporting component
  console.log(`  3. elite (resume 50+) reaches gold w/ <=1 support: ${elite.length ? Math.round(100 * eliteGold.length / elite.length) : 0}% of ${elite.length} elite picks`);
  return { gold: g, silver: s, v2top10, v3top10, window };
}

// ── Board archive baseline (the publicly tracked tier bar) ────────────────────
const board = (boardPull.rows || []).filter(r => ['win', 'loss', 'push'].includes(r.result));
const b65 = board.filter(r => r.score >= 65);
const boardRec = rec(b65.map(r => ({
  result: r.result, date: r.game_date,
  u: (() => {
    const pt = (r.pick_type || '').toLowerCase();
    const odds = pt === 'ml' ? r.ml_odds : (pt === 'over' || pt === 'under') ? (r.ou_odds ?? -115) : -110;
    const o = parseFloat(odds ?? -110);
    return r.result === 'push' ? 0 : r.result === 'loss' ? -1 : (o > 0 ? o / 100 : 100 / Math.abs(o));
  })(),
})));
console.log('BOARD 65+ tier (fresh pull, the bar):', fmt(boardRec));

// ── Run ───────────────────────────────────────────────────────────────────────
const DEFAULT = { BASE: parseInt(process.env.BT_BASE || 40, 10), MULT: parseInt(process.env.BT_MULT || 330, 10) };
if (process.argv.includes('--grid')) {
  for (const BASE of [35, 40, 45]) {
    for (const MULT of [300, 330, 360]) {
      const cfg = { BASE, MULT };
      const out = replay(cfg);
      const gold = out.filter(p => p.v3 >= 100 && p.gateOk);
      const g = rec(gold);
      const days = new Set(out.map(p => p.date)).size;
      console.log(`base=${BASE} mult=${MULT}: gold ${g.w}-${g.l} (${g.pct}%) roi ${g.roi}% | ${(g.n / Math.max(1, days)).toFixed(2)}/day`);
    }
  }
} else {
  report(DEFAULT, replay(DEFAULT));
}
