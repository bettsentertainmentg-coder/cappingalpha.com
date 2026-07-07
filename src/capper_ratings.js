// src/capper_ratings.js
// Materializes capper ratings from capper_history into the capper_ratings table.
// The v3 scorer and the admin leaderboard read THIS table, never raw history, so
// scoring stays O(1) per pick. Recomputed nightly + on demand from the admin panel.
//
// All math follows docs/CA_ALGORITHM_V3.md ("Capper resume" section). Every
// constant here is a STARTING VALUE; the Phase-5 backtest fits the final numbers.

const db = require('./db');

// ── Formula constants (doc: starting values, calibration tunes) ───────────────
const K_OVERALL   = 25;   // pseudo-picks shrinking overall ROI toward breakeven
const K_SPORT     = 15;   // pseudo-picks shrinking sport ROI toward overall
const K_TYPE      = 10;   // pseudo-picks shrinking type ROI toward sport
const K_VOLUME    = 10;   // volume factor: n / (n + K_VOLUME)
const MULTIPLIER  = 360;  // calibrated 2026-07-07 (backtest grid: base 45 x mult 360)
const SKILL_CAP   = 0.20; // ROI credit tops out at +20%
const TRUST_MIN   = 0.30;
const TRUST_MAX   = 1.30;
const TRUST_MID   = 0.10; // overallBlend that earns trust = 1.0
const CAP_BASE    = 25;   // volume-scaled cap: CAP_BASE + CAP_SLOPE * volume
const CAP_SLOPE   = 30;
const HARD_CAP    = 55;

// Tier + fade bars (doc: multiplicity-aware, expecting impostors)
const TIER_RATED_N     = 25;
const TIER_PROVEN_N    = 50;
const FADE_WATCH_N     = 25;
const FADE_WATCH_ROI   = -0.08;
const FADE_ACTIVE_N    = 40;
const FADE_ACTIVE_ROI  = -0.10;

// ── Helpers ───────────────────────────────────────────────────────────────────
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function effOdds(row) {
  const o = row.odds != null ? parseFloat(row.odds) : NaN;
  if (!isNaN(o) && o !== 0) return o;
  const pt = (row.pick_type || '').toLowerCase();
  return (pt === 'over' || pt === 'under') ? -115 : -110;
}

function profit(row) {
  const r = (row.result || '').toLowerCase();
  if (r === 'push') return 0;
  if (r === 'loss') return -1;
  if (r !== 'win')  return 0;
  const o = effOdds(row);
  return o > 0 ? o / 100 : 100 / Math.abs(o);
}

const overallBlend = (units, n) => units / (n + K_OVERALL);
const sportBlend   = (u, n, oBlend) => (u + K_SPORT * oBlend) / (n + K_SPORT);
const typeBlend    = (u, n, sBlend) => (u + K_TYPE * sBlend) / (n + K_TYPE);

// Resume points for a capper in a sport (doc formula, verbatim)
function resumePoints(sBlend, sportN, oBlend) {
  const skill  = Math.min(Math.max(sBlend, 0), SKILL_CAP);
  const volume = sportN / (sportN + K_VOLUME);
  const trust  = Math.max(TRUST_MIN, Math.min(TRUST_MAX, oBlend / TRUST_MID));
  const raw    = Math.round(MULTIPLIER * skill * volume * trust);
  const cap    = Math.min(HARD_CAP, CAP_BASE + Math.round(CAP_SLOPE * volume));
  return Math.max(0, Math.min(raw, cap));
}

// Leaderboard rating: the overall analog of resume points (doc formula)
function overallRating(oBlend, n) {
  return Math.max(0, Math.round(300 * Math.min(Math.max(oBlend, 0), SKILL_CAP) * (n / (n + K_VOLUME))));
}

// ── Canonicalization maps (read-time safety net for pre-registry rows) ────────
function buildResolver() {
  const aliasMap = new Map();
  try {
    for (const a of db.prepare(`SELECT alias, canonical_name FROM capper_aliases`).all()) {
      aliasMap.set(norm(a.alias), a.canonical_name);
    }
  } catch (_) {}
  const handleMap = new Map();
  try {
    for (const h of db.prepare(`SELECT source, handle, canonical_name FROM capper_source_handles`).all()) {
      handleMap.set(`${h.source}|${norm(h.handle)}`, h.canonical_name);
    }
  } catch (_) {}
  return (name, source) =>
    aliasMap.get(norm(name)) ||
    handleMap.get(`${source || 'discord'}|${norm(name)}`) ||
    name;
}

// ── Recompute everything ──────────────────────────────────────────────────────
function recomputeCapperRatings() {
  const rows = db.prepare(`
    SELECT capper_name, sport, pick_type, result, odds, source
    FROM capper_history
    WHERE result IN ('win', 'loss', 'push') AND capper_name IS NOT NULL
  `).all();

  const resolve = buildResolver();
  const cappers = new Map(); // canonical -> { n,w,l,p,u, sources:Set, sports:Map, types:Map }

  for (const row of rows) {
    const name = resolve(row.capper_name, row.source);
    if (!cappers.has(name)) {
      cappers.set(name, { n: 0, w: 0, l: 0, p: 0, u: 0, sources: new Set(), sports: new Map(), types: new Map() });
    }
    const c = cappers.get(name);
    const u = profit(row);
    const res = (row.result || '').toLowerCase();
    c.n++; c.u += u;
    if (res === 'win') c.w++; else if (res === 'loss') c.l++; else c.p++;
    c.sources.add(row.source || 'discord');

    const sport = row.sport || 'Unknown';
    if (!c.sports.has(sport)) c.sports.set(sport, { n: 0, w: 0, l: 0, p: 0, u: 0 });
    const s = c.sports.get(sport);
    s.n++; s.u += u;
    if (res === 'win') s.w++; else if (res === 'loss') s.l++; else s.p++;

    const tKey = `${sport}/${(row.pick_type || '?').toLowerCase()}`;
    if (!c.types.has(tKey)) c.types.set(tKey, { n: 0, w: 0, l: 0, p: 0, u: 0, sport, pick_type: (row.pick_type || '?').toLowerCase() });
    const t = c.types.get(tKey);
    t.n++; t.u += u;
    if (res === 'win') t.w++; else if (res === 'loss') t.l++; else t.p++;
  }

  const insert = db.prepare(`
    INSERT INTO capper_ratings
      (canonical_name, scope, sport, pick_type, picks, wins, losses, pushes, units,
       blend, resume_points, tier, fade, sources, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  // ── SOURCE ENTITIES (doc: channel fiat is dead; sources earn points through
  // the same formula). Discord channel entities aggregate from pick_history so
  // anonymous official picks count; wave-1 entities aggregate from capper_history
  // by source. Entities are pseudo-cappers named '@src:<key>'.
  const entities = new Map(); // '@src:key' -> same shape as cappers
  const entAdd = (key, sport, u, res) => {
    if (!entities.has(key)) entities.set(key, { n: 0, w: 0, l: 0, p: 0, u: 0, sports: new Map() });
    const e = entities.get(key);
    e.n++; e.u += u;
    if (res === 'win') e.w++; else if (res === 'loss') e.l++; else e.p++;
    const s = sport || 'Unknown';
    if (!e.sports.has(s)) e.sports.set(s, { n: 0, w: 0, l: 0, p: 0, u: 0 });
    const sp = e.sports.get(s);
    sp.n++; sp.u += u;
    if (res === 'win') sp.w++; else if (res === 'loss') sp.l++; else sp.p++;
  };
  try {
    for (const r of db.prepare(`
      SELECT channel, sport, pick_type, result, ml_odds, ou_odds FROM pick_history
      WHERE result IN ('win','loss','push') AND channel IS NOT NULL AND channel != ''
    `).all()) {
      const pt = (r.pick_type || '').toLowerCase();
      const odds = pt === 'ml' ? r.ml_odds : (pt === 'over' || pt === 'under') ? r.ou_odds : null;
      entAdd(`@src:${r.channel}`, r.sport, profit({ result: r.result, odds, pick_type: r.pick_type }), (r.result || '').toLowerCase());
    }
  } catch (_) {}
  for (const row of rows) {
    if ((row.source || 'discord') === 'discord') continue;
    entAdd(`@src:${row.source}`, row.sport, profit(row), (row.result || '').toLowerCase());
  }

  // ── SIDE LEAN (replaces the home bonus): rolling 120d, per sport, shrunk ROI
  // diff between away and home side picks. Tennis/golf excluded (listing-order
  // artifact). Stored as a settings JSON the scorer reads.
  const NO_VENUE = new Set(['ATP', 'WTA', 'GOLF']);
  const leanAgg = new Map(); // sport -> { home:{n,u}, away:{n,u} }
  try {
    for (const r of db.prepare(`
      SELECT sport, pick_type, result, odds, is_home_team FROM capper_history
      WHERE result IN ('win','loss','push') AND is_home_team IS NOT NULL
        AND LOWER(pick_type) IN ('ml','spread')
        AND game_date >= date('now','-120 days')
    `).all()) {
      const sport = (r.sport || '').toUpperCase();
      if (!sport || NO_VENUE.has(sport)) continue;
      if (!leanAgg.has(sport)) leanAgg.set(sport, { home: { n: 0, u: 0 }, away: { n: 0, u: 0 } });
      const side = r.is_home_team ? 'home' : 'away';
      const g = leanAgg.get(sport)[side];
      g.n++; g.u += profit(r);
    }
  } catch (_) {}
  const lean = {};
  for (const [sport, g] of leanAgg) {
    if (g.home.n < 100 || g.away.n < 100) continue; // doc: minimum sample per side
    const diff = g.away.u / (g.away.n + 50) - g.home.u / (g.home.n + 50);
    const pts = Math.max(0, Math.min(5, Math.round(Math.abs(diff) * 40)));
    if (pts > 0) lean[sport] = { side: diff > 0 ? 'away' : 'home', pts, samples: { home: g.home.n, away: g.away.n } };
  }
  try { db.setSetting('v3_side_lean', JSON.stringify(lean)); } catch (_) {}

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM capper_ratings`).run();
    for (const [name, c] of entities) {
      const oBlend = overallBlend(c.u, c.n);
      insert.run(
        name, 'overall', null, null, c.n, c.w, c.l, c.p, +c.u.toFixed(3),
        +oBlend.toFixed(4), overallRating(oBlend, c.n), 'entity', null, null,
      );
      for (const [sport, s] of c.sports) {
        const sBlend = sportBlend(s.u, s.n, oBlend);
        insert.run(
          name, `sport:${sport}`, sport, null, s.n, s.w, s.l, s.p, +s.u.toFixed(3),
          +sBlend.toFixed(4), resumePoints(sBlend, s.n, oBlend), null, null, null,
        );
      }
    }
    for (const [name, c] of cappers) {
      const oBlend = overallBlend(c.u, c.n);

      const tier = c.n >= TIER_PROVEN_N && oBlend > 0 ? 'proven'
                 : c.n >= TIER_RATED_N ? 'rated'
                 : c.n >= 10 ? 'building' : 'tracking';
      const fade = (c.n >= FADE_ACTIVE_N && oBlend <= FADE_ACTIVE_ROI) ? 'active'
                 : (c.n >= FADE_WATCH_N && oBlend <= FADE_WATCH_ROI)  ? 'watch'
                 : null;

      insert.run(
        name, 'overall', null, null, c.n, c.w, c.l, c.p, +c.u.toFixed(3),
        +oBlend.toFixed(4), overallRating(oBlend, c.n), tier, fade,
        [...c.sources].sort().join(','),
      );

      for (const [sport, s] of c.sports) {
        const sBlend = sportBlend(s.u, s.n, oBlend);
        insert.run(
          name, `sport:${sport}`, sport, null, s.n, s.w, s.l, s.p, +s.u.toFixed(3),
          +sBlend.toFixed(4), resumePoints(sBlend, s.n, oBlend), null, null, null,
        );
      }
      for (const [, t] of c.types) {
        const sport = t.sport;
        const s = c.sports.get(sport);
        const sBlend = sportBlend(s.u, s.n, oBlend);
        const tBlend = typeBlend(t.u, t.n, sBlend);
        insert.run(
          name, `type:${sport}/${t.pick_type}`, sport, t.pick_type, t.n, t.w, t.l, t.p, +t.u.toFixed(3),
          +tBlend.toFixed(4), null, null, null, null,
        );
      }
    }
  });
  tx();

  const summary = {
    cappers: cappers.size,
    rated: db.prepare(`SELECT COUNT(*) n FROM capper_ratings WHERE scope='overall' AND tier IN ('rated','proven')`).get().n,
    proven: db.prepare(`SELECT COUNT(*) n FROM capper_ratings WHERE scope='overall' AND tier='proven'`).get().n,
    fadeWatch: db.prepare(`SELECT COUNT(*) n FROM capper_ratings WHERE scope='overall' AND fade='watch'`).get().n,
    fadeActive: db.prepare(`SELECT COUNT(*) n FROM capper_ratings WHERE scope='overall' AND fade='active'`).get().n,
  };
  console.log(`[ratings] recomputed: ${summary.cappers} cappers, ${summary.rated} rated (${summary.proven} proven), fade watch ${summary.fadeWatch} / active ${summary.fadeActive}`);
  return summary;
}

// ── Readers (used by the scorer, leaderboard, and fade logic) ─────────────────
function getOverall(name) {
  return db.prepare(`SELECT * FROM capper_ratings WHERE canonical_name = ? AND scope = 'overall'`).get(name) || null;
}
function getSportRating(name, sport) {
  return db.prepare(`SELECT * FROM capper_ratings WHERE canonical_name = ? AND scope = ?`).get(name, `sport:${sport}`) || null;
}
function getTypeRating(name, sport, pickType) {
  return db.prepare(`SELECT * FROM capper_ratings WHERE canonical_name = ? AND scope = ?`)
    .get(name, `type:${sport}/${(pickType || '?').toLowerCase()}`) || null;
}
function getFadeList() {
  return db.prepare(`SELECT canonical_name, fade, picks, units, blend FROM capper_ratings WHERE scope='overall' AND fade IS NOT NULL ORDER BY blend ASC`).all();
}

module.exports = {
  recomputeCapperRatings, getOverall, getSportRating, getTypeRating, getFadeList,
  resumePoints, overallRating, profit, effOdds,
};

// CLI: node src/capper_ratings.js
if (require.main === module) {
  recomputeCapperRatings();
  const top = db.prepare(`
    SELECT canonical_name, picks, wins, losses, units, resume_points, tier, fade, sources
    FROM capper_ratings WHERE scope='overall' AND picks >= 10
    ORDER BY resume_points DESC, units DESC LIMIT 12
  `).all();
  console.table(top);
  console.log('Fade list:', getFadeList());
}
