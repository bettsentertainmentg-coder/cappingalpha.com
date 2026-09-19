// src/capper_v2.js — THE V2 CAPPER DATABASE materialization
// (docs/V2_DATABASE_PLAN.md sections 3 and 5b).
//
// recomputeCapperV2(): one pass over capper_history, the section 3c exclusions,
// then counts per (capper, scope, window) plus streaks, sample tiers, season
// marks, the "meets the bar today" flag, the ranks among live cappers, the
// ONE-WAY DOOR pass (capper_qualifications, insert-only) and the naming pass
// (slug / alias / primary source on capper_registry). Writes in one transaction.
//
// Triggers: 5:20am with the nightly ratings job, startup, after every grade
// pass that changed a row, and the admin Recompute button. NEVER at request time.
//
// Money is net dollars at a flat $10 stake at the price stored on the row
// (no price = -110 sides / -115 totals, tracked as priced share). ROI = units /
// (10 x graded). Record = W-L-P, win% = W / (W + L).

const db = require('./db');
const { buildResolver, isLiveRow, effOdds } = require('./capper_ratings');
const { implausibleLine } = require('./audit');
const pub = require('./capper_public');

const STAKE = 10;
const WINDOWS = [['all', null], ['30d', 30], ['7d', 7]];
const TIER_LARGE = 50, TIER_MEDIUM = 20;
const SEASON_MONEY_FLOOR = 10;   // season picks before a money badge can apply (assumption, see plan 7b)
const SEASON_RECORD_FLOOR = 30;  // Jack: 30-pick floor for the win% badge
const SEASON_TOP_SHARE = 0.05;

// Season start (month, day) per sport scope; the current season began at the
// latest such date at or before today. One place to edit.
const SEASON_START = {
  MLB: [3, 15], NFL: [8, 25], NCAAF: [8, 20], NBA: [10, 1], CBB: [11, 1], NHL: [10, 1],
  WNBA: [5, 1], Tennis: [1, 1], Soccer: [7, 15], Golf: [1, 1],
};

function seasonStartISO(sport, now = new Date()) {
  const [m, d] = SEASON_START[sport] || [1, 1];
  const y = now.getUTCFullYear();
  let s = new Date(Date.UTC(y, m - 1, d));
  if (s > now) s = new Date(Date.UTC(y - 1, m - 1, d));
  return s.toISOString().slice(0, 10);
}

// Tennis is one scope (ATP + WTA together, settled 2026-09-15).
function sportScope(sport) {
  const s = String(sport || '').trim();
  if (s === 'ATP' || s === 'WTA') return 'Tennis';
  return s || 'Other';
}

function typeKey(pt) {
  pt = String(pt || '').toLowerCase();
  if (pt === 'over' || pt === 'under') return 'total';
  if (pt === 'spread') return 'spread';
  if (pt === 'ml') return 'ml';
  return pt || 'other';
}

function corruptPrice(o) {
  if (o == null) return false;
  const n = Number(o);
  if (!Number.isFinite(n)) return true;
  return Math.abs(n) < 100 || n < -2000 || n > 1500;
}

function isBackfill(row) {
  if (!row.espn_game_id) return true;
  if (!row.sources_json) return false;
  try {
    const a = JSON.parse(row.sources_json);
    return Array.isArray(a) && a.some((s) => s && (s.backfill === true || (s.meta && s.meta.backfill === true)));
  } catch (_) { return false; }
}

function unitReturn(row) {
  const r = String(row.result || '').toLowerCase();
  if (r === 'push') return 0;
  if (r === 'loss') return -STAKE;
  if (r !== 'win') return 0;
  const o = effOdds(row);
  return o > 0 ? STAKE * o / 100 : STAKE * 100 / Math.abs(o);
}

function tierFor(graded) {
  if (graded >= TIER_LARGE) return 'large';
  if (graded >= TIER_MEDIUM) return 'medium';
  return 'small';
}

function barSettings() {
  return {
    minPicks: parseInt(db.getSetting('v2_min_picks', '30'), 10) || 30,
    kind: db.getSetting('v2_bar_kind', 'units') === 'roi' ? 'roi' : 'units',
    value: parseFloat(db.getSetting('v2_bar_value', '100')) || 0,
    streakMin: parseInt(db.getSetting('v2_streak_min', '5'), 10) || 5,
  };
}

function meetsBar(agg, bar) {
  if (agg.graded < bar.minPicks) return false;
  if (bar.kind === 'roi') return agg.graded > 0 && (agg.units / (STAKE * agg.graded)) * 100 >= bar.value;
  return agg.units >= bar.value;
}

// Polymarket: only wallets that PASSED the straight-bettor screen are ever in
// pm_wallets (refused wallets are never inserted; the 2026-08-26 purge removed
// the traders). A polymarket capper counts only when one of their wallets is
// still there.
function pmScreenedCanonicals(resolve) {
  const ok = new Set();
  try {
    const wallets = new Set(db.prepare(`SELECT wallet FROM pm_wallets`).all().map((w) => String(w.wallet).toLowerCase()));
    for (const h of db.prepare(`SELECT handle, canonical_name FROM capper_source_handles WHERE source = 'polymarket'`).all()) {
      if (wallets.has(String(h.handle).toLowerCase())) ok.add(resolve(h.canonical_name, 'polymarket'));
    }
  } catch (_) {}
  return ok;
}

// The rows every V2 reader agrees on. Returns [{...row, canonical, scope, tkey}].
// exclusions counted for the log line.
function eligibleRows(rows, resolve, pmOk, counts) {
  const out = [];
  for (const r of rows) {
    if (!r.capper_name) continue;
    if (isLiveRow(r)) { counts.live++; continue; }
    if (isBackfill(r)) { counts.backfill++; continue; }
    if (corruptPrice(r.odds)) { counts.corrupt_price++; continue; }
    try { if (implausibleLine(r)) { counts.implausible++; continue; } } catch (_) {}
    if (r.source === 'bettingpros') { counts.blocked_source = (counts.blocked_source || 0) + 1; continue; }
    const canonical = resolve(r.capper_name, r.source);
    if (r.source === 'polymarket' && !pmOk.has(canonical)) { counts.pm_screen++; continue; }
    out.push(Object.assign(r, { canonical, scope: sportScope(r.sport), tkey: typeKey(r.pick_type) }));
  }
  return out;
}

function newAgg() {
  return { graded: 0, wins: 0, losses: 0, pushes: 0, units: 0, priced: 0, oddsSum: 0, oddsN: 0,
           first: null, last: null, streakLen: 0, streakKind: null };
}

function addRow(agg, r, net) {
  const res = String(r.result).toLowerCase();
  agg.graded++;
  if (res === 'win') agg.wins++; else if (res === 'loss') agg.losses++; else agg.pushes++;
  agg.units += net;
  if (r.odds != null) { agg.priced++; agg.oddsSum += Number(r.odds); agg.oddsN++; }
  if (!agg.first || r.game_date < agg.first) agg.first = r.game_date;
  if (!agg.last || r.game_date > agg.last) agg.last = r.game_date;
  // rows arrive in date order, so the streak is a running tail
  if (res === 'push') return;
  const kind = res === 'win' ? 'W' : 'L';
  if (agg.streakKind === kind) agg.streakLen++;
  else { agg.streakKind = kind; agg.streakLen = 1; }
}

function recomputeCapperV2() {
  const t0 = Date.now();
  const bar = barSettings();
  const resolve = buildResolver();
  const pmOk = pmScreenedCanonicals(resolve);
  const counts = { live: 0, backfill: 0, corrupt_price: 0, implausible: 0, pm_screen: 0, blocked_source: 0 };

  const raw = db.prepare(`
    SELECT id, capper_name, sport, pick_type, team, spread, espn_game_id, game_date, result, odds,
           source, sources_json, saved_at
    FROM capper_history
    WHERE result IN ('win', 'loss', 'push') AND capper_name IS NOT NULL
    ORDER BY game_date ASC, saved_at ASC, id ASC
  `).all();
  const rows = eligibleRows(raw, resolve, pmOk, counts);

  const today = new Date().toISOString().slice(0, 10);
  const cutoff = (days) => new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const winStart = { all: null, '30d': cutoff(30), '7d': cutoff(7) };
  const active14 = cutoff(14);
  const seasonStart = {};
  for (const s of Object.keys(SEASON_START)) seasonStart[s] = seasonStartISO(s);

  // agg[canonical][scope][window]
  const agg = new Map();
  const sourcesOf = new Map();   // canonical -> { source: n }
  const seasonAgg = new Map();   // canonical|sport -> agg over this season
  const get = (m, k, mk) => { let v = m.get(k); if (!v) { v = mk(); m.set(k, v); } return v; };

  for (const r of rows) {
    const net = unitReturn(r);
    const byScope = get(agg, r.canonical, () => new Map());
    const src = get(sourcesOf, r.canonical, () => ({}));
    src[r.source || 'discord'] = (src[r.source || 'discord'] || 0) + 1;
    for (const scope of ['overall', `sport:${r.scope}`, `type:${r.scope}/${r.tkey}`]) {
      const byWin = get(byScope, scope, () => new Map());
      for (const [w] of WINDOWS) {
        if (winStart[w] && r.game_date < winStart[w]) continue;
        addRow(get(byWin, w, newAgg), r, net);
      }
    }
    const ss = seasonStart[r.scope] || seasonStart.Tennis;
    if (r.game_date >= ss) addRow(get(seasonAgg, `${r.canonical}|${r.scope}`, newAgg), r, net);
  }

  // Season marks: top 5% of the sport this season by money (10-pick floor) and
  // by win% (30-pick floor).
  const seasonTop = new Map(); // canonical|sport -> { money: 0/1, record: 0/1 }
  const bySport = new Map();
  for (const [k, a] of seasonAgg) {
    const sport = k.split('|')[1];
    get(bySport, sport, () => []).push([k, a]);
  }
  for (const [, list] of bySport) {
    const money = list.filter(([, a]) => a.graded >= SEASON_MONEY_FLOOR).sort((x, y) => y[1].units - x[1].units);
    const nM = Math.max(1, Math.floor(money.length * SEASON_TOP_SHARE));
    money.slice(0, nM).forEach(([k, a]) => { if (a.units > 0) get(seasonTop, k, () => ({})).money = 1; });
    const rec = list.filter(([, a]) => a.graded >= SEASON_RECORD_FLOOR && (a.wins + a.losses) > 0)
      .sort((x, y) => (y[1].wins / (y[1].wins + y[1].losses)) - (x[1].wins / (x[1].wins + x[1].losses)));
    const nR = Math.max(1, Math.floor(rec.length * SEASON_TOP_SHARE));
    rec.slice(0, nR).forEach(([k, a]) => { if (a.wins > a.losses) get(seasonTop, k, () => ({})).record = 1; });
  }

  // Registry + naming pass (slug, primary source, alias) for every capper in the pool.
  const regByName = new Map();
  for (const r of db.prepare(`SELECT * FROM capper_registry`).all()) regByName.set(r.canonical_name, r);
  const usedAliases = new Set([...regByName.values()].map((r) => r.alias_name).filter(Boolean));
  const usedSlugs = new Set([...regByName.values()].map((r) => r.slug).filter(Boolean));
  const qualified = new Set(db.prepare(`SELECT canonical_name FROM capper_qualifications`).all().map((q) => q.canonical_name));

  const insReg = db.prepare(`INSERT OR IGNORE INTO capper_registry (canonical_name) VALUES (?)`);
  const updReg = db.prepare(`UPDATE capper_registry SET slug = ?, primary_source = ?, alias_name = ?, live_at = COALESCE(live_at, ?) WHERE canonical_name = ?`);
  const insQual = db.prepare(`INSERT OR IGNORE INTO capper_qualifications (canonical_name, bar_json) VALUES (?, ?)`);
  const delAll = db.prepare(`DELETE FROM capper_ratings_v2`);
  const insRating = db.prepare(`
    INSERT INTO capper_ratings_v2 (canonical_name, scope, window, graded, wins, losses, pushes, units, roi, win_pct,
      avg_odds, priced, first_pick, last_pick, active_14d, streak_len, streak_kind, sample_tier, meets_bar, rank_money,
      season_graded, season_wins, season_losses, season_pushes, season_units, season_top_money, season_top_record)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let newlyLive = 0, ratingRows = 0;
  const tx = db.transaction(() => {
    delAll.run();
    const pending = []; // [canonical, scope, window, agg, meets]
    for (const [canonical, byScope] of agg) {
      // registry + naming
      if (!regByName.has(canonical)) { insReg.run(canonical); regByName.set(canonical, { canonical_name: canonical, name_mode: 'auto' }); }
      const reg = regByName.get(canonical);
      const srcCounts = sourcesOf.get(canonical) || {};
      const mode = pub.resolveNameMode(reg, srcCounts);
      let alias = reg.alias_name || null;
      if (mode === 'alias' && !alias) alias = pub.pickAlias(usedAliases);
      let slug = reg.slug;
      if (!slug) {
        const base = pub.slugify(mode === 'alias' && alias ? alias : canonical);
        slug = base; let n = 2;
        while (usedSlugs.has(slug)) slug = `${base}-${n++}`;
        usedSlugs.add(slug);
      }
      const overall = byScope.get('overall') && byScope.get('overall').get('all');
      const meets = overall ? meetsBar(overall, bar) : false;
      // the one-way door
      let liveStamp = null;
      if (meets && !qualified.has(canonical)) {
        insQual.run(canonical, JSON.stringify({ min_picks: bar.minPicks, kind: bar.kind, value: bar.value, graded: overall.graded, units: +overall.units.toFixed(2) }));
        qualified.add(canonical); newlyLive++;
      }
      if (qualified.has(canonical)) liveStamp = new Date().toISOString();
      updReg.run(slug, pub.primarySource(srcCounts), alias, liveStamp, canonical);
      Object.assign(reg, { slug, alias_name: alias, primary_source: pub.primarySource(srcCounts), live_at: reg.live_at || liveStamp });

      for (const [scope, byWin] of byScope) {
        for (const [w, a] of byWin) pending.push([canonical, scope, w, a, scope === 'overall' && w === 'all' ? meets : 0]);
      }
    }
    // ranks among LIVE cappers per scope+window: tier first, then money
    const groups = new Map();
    for (const p of pending) if (qualified.has(p[0])) get(groups, `${p[1]}|${p[2]}`, () => []).push(p);
    const tierOrder = { large: 0, medium: 1, small: 2 };
    const rankOf = new Map();
    for (const [k, list] of groups) {
      list.sort((x, y) => (tierOrder[tierFor(x[3].graded)] - tierOrder[tierFor(y[3].graded)]) || (y[3].units - x[3].units)
        || ((y[3].wins / Math.max(1, y[3].wins + y[3].losses)) - (x[3].wins / Math.max(1, x[3].wins + x[3].losses))) || (y[3].graded - x[3].graded));
      list.forEach((p, i) => rankOf.set(`${p[0]}|${k}`, i + 1));
    }
    for (const [canonical, scope, w, a, meets] of pending) {
      const wl = a.wins + a.losses;
      const sportKey = scope.startsWith('sport:') ? `${canonical}|${scope.slice(6)}` : null;
      const sa = sportKey && w === 'all' ? seasonAgg.get(sportKey) : null;
      const st = sportKey && w === 'all' ? (seasonTop.get(sportKey) || {}) : {};
      insRating.run(canonical, scope, w, a.graded, a.wins, a.losses, a.pushes, +a.units.toFixed(2),
        a.graded ? +(a.units / (STAKE * a.graded)).toFixed(4) : null,
        wl ? +(a.wins / wl).toFixed(4) : null,
        a.oddsN ? +(a.oddsSum / a.oddsN).toFixed(1) : null,
        a.priced, a.first, a.last, a.last && a.last >= active14 ? 1 : 0,
        a.streakLen, a.streakKind, tierFor(a.graded), meets ? 1 : 0,
        rankOf.get(`${canonical}|${scope}|${w}`) || null,
        sa ? sa.graded : 0, sa ? sa.wins : 0, sa ? sa.losses : 0, sa ? sa.pushes : 0, sa ? +sa.units.toFixed(2) : 0,
        st.money ? 1 : 0, st.record ? 1 : 0);
      ratingRows++;
    }
    db.setSetting('v2_last_recompute', new Date().toISOString());
    db.setSetting('v2_last_excluded', JSON.stringify(counts));
  });
  tx();

  const summary = {
    ok: true, ms: Date.now() - t0, history_rows: raw.length, eligible_rows: rows.length, excluded: counts,
    cappers: agg.size, rating_rows: ratingRows, live: qualified.size, newly_live: newlyLive, bar,
  };
  console.log(`[capper_v2] recompute: ${rows.length}/${raw.length} rows, ${agg.size} cappers, ${qualified.size} live (+${newlyLive}), ${ratingRows} rating rows, ${summary.ms}ms; excluded ${JSON.stringify(counts)}`);
  return summary;
}

// ── Reads (O(1) table reads) ─────────────────────────────────────────────────
function getRating(canonical, scope = 'overall', window = 'all') {
  try {
    return db.prepare(`SELECT * FROM capper_ratings_v2 WHERE canonical_name = ? AND scope = ? AND window = ?`).get(canonical, scope, window) || null;
  } catch (_) { return null; }
}

function getLiveSet() {
  try { return new Set(db.prepare(`SELECT canonical_name FROM capper_qualifications`).all().map((r) => r.canonical_name)); }
  catch (_) { return new Set(); }
}

// Admin: cappers closest to the bar (not yet live), by picks short then dollars short.
function getNextUp(limit = 20) {
  const bar = barSettings();
  try {
    const rows = db.prepare(`
      SELECT r.canonical_name, r.graded, r.units, r.roi, r.wins, r.losses, r.pushes, g.primary_source
      FROM capper_ratings_v2 r
      LEFT JOIN capper_registry g ON g.canonical_name = r.canonical_name
      WHERE r.scope = 'overall' AND r.window = 'all'
        AND r.canonical_name NOT IN (SELECT canonical_name FROM capper_qualifications)
    `).all();
    for (const r of rows) {
      r.picks_short = Math.max(0, bar.minPicks - r.graded);
      r.dollars_short = bar.kind === 'roi' ? null : Math.max(0, bar.value - r.units);
      r.roi_short = bar.kind === 'roi' ? Math.max(0, bar.value - (r.roi || 0) * 100) : null;
    }
    rows.sort((a, b) => (a.picks_short - b.picks_short) || ((a.dollars_short ?? a.roi_short) - (b.dollars_short ?? b.roi_short)));
    return rows.slice(0, limit);
  } catch (_) { return []; }
}

function getPoolSummary() {
  try {
    const live = db.prepare(`SELECT COUNT(*) c FROM capper_qualifications`).get().c;
    const pool = db.prepare(`SELECT COUNT(*) c FROM capper_ratings_v2 WHERE scope = 'overall' AND window = 'all'`).get().c;
    const meets = db.prepare(`SELECT COUNT(*) c FROM capper_ratings_v2 WHERE scope = 'overall' AND window = 'all' AND meets_bar = 1`).get().c;
    const perSport = db.prepare(`
      SELECT substr(scope, 7) AS sport, COUNT(*) c FROM capper_ratings_v2
      WHERE scope LIKE 'sport:%' AND window = 'all' AND canonical_name IN (SELECT canonical_name FROM capper_qualifications)
      GROUP BY scope ORDER BY c DESC
    `).all();
    return { live, pool, meets_bar_today: meets, per_sport: perSport, last_recompute: db.getSetting('v2_last_recompute', null), bar: barSettings() };
  } catch (err) { return { error: err.message }; }
}


function lastExcluded() {
  try {
    const raw = db.getSetting('v2_last_excluded', '');
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return null;
}

function ledgerDisplay(reg) {
  const primary = (reg && reg.primary_source) || '';
  const aliased = !!(reg && reg.alias_name && (reg.name_mode === 'alias'
    || (reg.name_mode === 'auto' && ['discord', 'bettingpros'].includes(primary))));
  const canonical = (reg && reg.canonical_name) || '';
  return {
    display: aliased ? reg.alias_name : ((reg && reg.display_name) || canonical),
    aliased,
    canonical,
  };
}

function cutoffForWindow(window) {
  if (window === '30d') return new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
  if (window === '7d') return new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  return null;
}

function ledgerCounts() {
  const summary = getPoolSummary();
  let hidden = 0;
  try { hidden = db.prepare(`SELECT COUNT(*) c FROM capper_registry WHERE hidden = 1`).get().c; } catch (_) {}
  let excluded = lastExcluded() || {};
  if (excluded.blocked_source == null) {
    try {
      excluded = Object.assign({}, excluded, {
        blocked_source: db.prepare(`SELECT COUNT(*) c FROM capper_history WHERE source = 'bettingpros' AND result IN ('win','loss','push')`).get().c,
      });
    } catch (_) { excluded.blocked_source = 0; }
  }
  const excluded_total = ['live', 'backfill', 'corrupt_price', 'implausible', 'pm_screen', 'blocked_source']
    .reduce((n, k) => n + (Number(excluded[k]) || 0), 0);
  return {
    pool: summary.pool || 0,
    live: summary.live || 0,
    hidden,
    meets_bar_today: summary.meets_bar_today || 0,
    last_recompute: summary.last_recompute || null,
    excluded,
    excluded_total,
  };
}

function ledgerSports() {
  try {
    return db.prepare(`
      SELECT DISTINCT substr(scope, 7) AS sport FROM capper_ratings_v2
      WHERE scope LIKE 'sport:%' AND window = 'all' ORDER BY sport
    `).all().map((r) => r.sport).filter(Boolean);
  } catch (_) { return []; }
}

function ledgerSources() {
  const out = [];
  const seen = new Set();
  try {
    for (const r of db.prepare(`
      SELECT DISTINCT primary_source AS source FROM capper_registry
      WHERE primary_source IS NOT NULL AND primary_source != ''
      ORDER BY primary_source
    `).all()) {
      if (!seen.has(r.source)) { seen.add(r.source); out.push(r.source); }
    }
  } catch (_) {}
  if (!seen.has('bettingpros')) out.push('bettingpros');
  return out;
}

function blockedLedgerRows({ sport, window, q, sort }) {
  const resolve = buildResolver();
  const start = cutoffForWindow(window);
  const wantSport = sport && sport !== 'all' && sport !== 'overall' ? sportScope(sport) : null;
  let raw = [];
  try {
    raw = db.prepare(`
      SELECT capper_name, sport, pick_type, team, spread, result, odds, game_date, source, sources_json, espn_game_id
      FROM capper_history
      WHERE source = 'bettingpros' AND result IN ('win','loss','push') AND capper_name IS NOT NULL
    `).all();
  } catch (_) { return []; }
  const by = new Map();
  for (const r of raw) {
    if (start && r.game_date < start) continue;
    if (wantSport && sportScope(r.sport) !== wantSport) continue;
    const canonical = resolve(r.capper_name, r.source);
    if (q) {
      const needle = String(q).toLowerCase();
      if (!String(canonical).toLowerCase().includes(needle) && !String(r.capper_name).toLowerCase().includes(needle)) continue;
    }
    let a = by.get(canonical);
    if (!a) {
      a = { canonical_name: canonical, graded: 0, wins: 0, losses: 0, pushes: 0, units: 0, last_pick: null, first_pick: null };
      by.set(canonical, a);
    }
    const res = String(r.result).toLowerCase();
    a.graded++;
    if (res === 'win') a.wins++; else if (res === 'loss') a.losses++; else a.pushes++;
    a.units += unitReturn(r);
    if (!a.first_pick || r.game_date < a.first_pick) a.first_pick = r.game_date;
    if (!a.last_pick || r.game_date > a.last_pick) a.last_pick = r.game_date;
  }
  const rows = [...by.values()].map((a) => {
    let reg = null;
    try { reg = db.prepare(`SELECT * FROM capper_registry WHERE canonical_name = ?`).get(a.canonical_name); } catch (_) {}
    const named = ledgerDisplay(Object.assign({ canonical_name: a.canonical_name, primary_source: 'bettingpros' }, reg || {}));
    return {
      canonical_name: a.canonical_name,
      display: named.display,
      aliased: named.aliased,
      primary_source: (reg && reg.primary_source) || 'bettingpros',
      hidden: !!(reg && reg.hidden),
      live: false,
      blocked: true,
      wins: a.wins,
      losses: a.losses,
      pushes: a.pushes,
      units: Math.round(a.units * 100) / 100,
      roi: a.graded ? a.units / (STAKE * a.graded) : null,
      graded: a.graded,
      last_pick: a.last_pick,
      sample_tier: tierFor(a.graded),
      slug: (reg && reg.slug) || null,
      qualified_at: null,
    };
  });
  const dir = sort === 'name' ? 1 : -1;
  const key = sort === 'roi' ? 'roi' : sort === 'graded' ? 'graded' : sort === 'last_pick' ? 'last_pick' : sort === 'name' ? 'display' : 'units';
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return (b.graded || 0) - (a.graded || 0);
  });
  return rows;
}

function getLedger(opts = {}) {
  const window = ['all', '30d', '7d'].includes(opts.window) ? opts.window : 'all';
  const sort = ['units', 'roi', 'graded', 'last_pick', 'name'].includes(opts.sort) ? opts.sort : 'units';
  const status = ['all', 'live', 'pool', 'hidden'].includes(opts.status) ? opts.status : 'all';
  const source = String(opts.source || '').trim();
  const sport = String(opts.sport || '').trim();
  const q = String(opts.q || '').trim();
  const limit = Math.min(500, Math.max(1, parseInt(opts.limit, 10) || 250));
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  const scope = (!sport || sport === 'all' || sport === 'overall') ? 'overall' : `sport:${sportScope(sport)}`;

  const counts = ledgerCounts();
  const sports = ledgerSports();
  const sources = ledgerSources();

  if (source === 'bettingpros') {
    const all = blockedLedgerRows({ sport, window, q, sort });
    return {
      ok: true, window, sport: sport || 'overall', source, status, sort, scope,
      counts, sports, sources,
      total: all.length, rows: all.slice(offset, offset + limit),
    };
  }

  const orderSql = {
    units: 'r.units DESC, r.graded DESC',
    roi: 'r.roi DESC, r.units DESC',
    graded: 'r.graded DESC, r.units DESC',
    last_pick: 'r.last_pick DESC',
    name: 'r.canonical_name ASC',
  }[sort];

  const where = [`r.scope = ?`, `r.window = ?`];
  const params = [scope, window];
  if (source) { where.push(`g.primary_source = ?`); params.push(source); }
  if (status === 'live') where.push(`q.qualified_at IS NOT NULL`);
  if (status === 'pool') where.push(`q.qualified_at IS NULL`);
  if (status === 'hidden') where.push(`COALESCE(g.hidden, 0) = 1`);
  if (q) {
    where.push(`(r.canonical_name LIKE ? OR IFNULL(g.alias_name,'') LIKE ? OR IFNULL(g.display_name,'') LIKE ?)`);
    const like = `%${q.replace(/%/g, '')}%`;
    params.push(like, like, like);
  }

  let rows = [];
  let total = 0;
  try {
    const from = `
      FROM capper_ratings_v2 r
      LEFT JOIN capper_registry g ON g.canonical_name = r.canonical_name
      LEFT JOIN capper_qualifications q ON q.canonical_name = r.canonical_name
      WHERE ${where.join(' AND ')}`;
    total = db.prepare(`SELECT COUNT(*) c ${from}`).get(...params).c;
    rows = db.prepare(`
      SELECT r.canonical_name, r.graded, r.wins, r.losses, r.pushes, r.units, r.roi, r.sample_tier,
             r.meets_bar, r.rank_money, r.active_14d, r.last_pick, r.first_pick,
             g.slug, g.alias_name, g.name_mode, g.primary_source, g.hidden, g.display_name,
             q.qualified_at
      ${from}
      ORDER BY ${orderSql}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
  } catch (err) {
    return { ok: false, error: err.message, counts, sports, sources, rows: [], total: 0 };
  }

  const out = rows.map((r) => {
    const named = ledgerDisplay(r);
    return {
      canonical_name: r.canonical_name,
      display: named.display,
      aliased: named.aliased,
      primary_source: r.primary_source || '',
      hidden: !!r.hidden,
      live: !!r.qualified_at,
      blocked: false,
      wins: r.wins,
      losses: r.losses,
      pushes: r.pushes,
      units: r.units,
      roi: r.roi,
      graded: r.graded,
      last_pick: r.last_pick,
      sample_tier: r.sample_tier,
      meets_bar: !!r.meets_bar,
      rank_money: r.rank_money,
      slug: r.slug || null,
      qualified_at: r.qualified_at || null,
    };
  });

  return {
    ok: true, window, sport: sport || 'overall', source, status, sort, scope,
    counts, sports, sources, total, rows: out,
  };
}

function namesForCanonical(canonical) {
  const names = new Set([canonical]);
  try {
    for (const a of db.prepare(`SELECT alias FROM capper_aliases WHERE canonical_name = ?`).all(canonical)) {
      if (a.alias) names.add(a.alias);
    }
  } catch (_) {}
  try {
    for (const h of db.prepare(`SELECT handle FROM capper_source_handles WHERE canonical_name = ?`).all(canonical)) {
      if (h.handle) names.add(h.handle);
    }
  } catch (_) {}
  return [...names];
}

function rowFlags(r) {
  const flags = [];
  if (r.source === 'bettingpros') flags.push('blocked');
  if (isLiveRow(r)) flags.push('in_play');
  if (isBackfill(r)) flags.push('backfill');
  if (corruptPrice(r.odds)) flags.push('corrupt_price');
  try { if (implausibleLine(r)) flags.push('implausible'); } catch (_) {}
  return flags;
}

function getLedgerCapper(canonical, opts = {}) {
  const name = String(canonical || '').trim();
  if (!name) return { ok: false, error: 'missing capper' };
  const limit = Math.min(200, Math.max(1, parseInt(opts.limit, 10) || 50));
  let reg = null;
  try { reg = db.prepare(`SELECT * FROM capper_registry WHERE canonical_name = ?`).get(name); } catch (_) {}
  const named = ledgerDisplay(Object.assign({ canonical_name: name }, reg || {}));
  let qualified_at = null;
  try {
    const q = db.prepare(`SELECT qualified_at FROM capper_qualifications WHERE canonical_name = ?`).get(name);
    qualified_at = q ? q.qualified_at : null;
  } catch (_) {}
  const rating = getRating(name, 'overall', 'all');
  const names = namesForCanonical(name);
  const marks = names.map(() => '?').join(',');
  let raw = [];
  try {
    raw = db.prepare(`
      SELECT id, capper_name, sport, pick_type, team, spread, espn_game_id, game_date, result, odds, source, sources_json, saved_at
      FROM capper_history
      WHERE capper_name IN (${marks}) AND result IN ('win','loss','push')
      ORDER BY game_date DESC, saved_at DESC, id DESC
      LIMIT ?
    `).all(...names, limit);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const picks = raw.map((r) => {
    const flags = rowFlags(r);
    return {
      id: r.id,
      game_date: r.game_date,
      sport: sportScope(r.sport),
      team: r.team,
      pick_type: r.pick_type,
      spread: r.spread,
      odds: r.odds,
      result: String(r.result || '').toLowerCase(),
      units: Math.round(unitReturn(r) * 100) / 100,
      source: r.source || '',
      flags,
    };
  });
  return {
    ok: true,
    canonical_name: name,
    display: named.display,
    aliased: named.aliased,
    primary_source: (reg && reg.primary_source) || '',
    hidden: !!(reg && reg.hidden),
    live: !!qualified_at,
    qualified_at,
    slug: (reg && reg.slug) || null,
    rating,
    picks,
  };
}

module.exports = {
  recomputeCapperV2, getRating, getLiveSet, getNextUp, getPoolSummary, barSettings,
  sportScope, typeKey, unitReturn, corruptPrice, isBackfill, seasonStartISO, pmScreenedCanonicals, STAKE,
  getLedger, getLedgerCapper, lastExcluded,
};

// CLI: node src/capper_v2.js
if (require.main === module) {
  console.log(recomputeCapperV2());
  console.table(db.prepare(`
    SELECT r.canonical_name, g.slug, g.alias_name, g.primary_source, r.graded, r.wins, r.losses, r.units, r.roi, r.sample_tier, r.meets_bar, r.rank_money
    FROM capper_ratings_v2 r LEFT JOIN capper_registry g ON g.canonical_name = r.canonical_name
    WHERE r.scope = 'overall' AND r.window = 'all' ORDER BY (r.rank_money IS NULL), r.rank_money ASC, r.units DESC LIMIT 15
  `).all());
}
