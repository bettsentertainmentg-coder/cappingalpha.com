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
const SKILL_CAP   = 0.20; // ROI credit tops out at +20%
const TRUST_MIN   = 0.30;
const TRUST_MAX   = 1.30;
const TRUST_MID   = 0.10; // overallBlend that earns trust = 1.0

// ── THE WILSON PERCENTILE ENGINE (Jack 2026-07-09) ────────────────────────────
// Capper credibility = the LOWER BOUND of the 99% Wilson score interval on their
// graded decisions (wins+losses; pushes sit out). The worst-case win rate the
// data still supports: perfect-but-thin records rank below big proven volume
// (MidwestMike at 85-49 beats a 7-0). Every capper with at least one decision
// goes into ONE pool, is ranked, and their percentile position maps to the
// points their picks earn through the band ladder below. This retires the
// earned-scale ratchet, the base points, and the resume formula as scoring
// inputs (resume_points is still computed for legacy display).
const WILSON_Z = 2.576; // 99% confidence

// The ladder: points slide linearly inside each band from peak (top of band)
// down to floor (bottom of band). Floors sit one point above the next peak so
// the whole curve is continuous and strictly rank-ordered.
const LADDER = [
  { lo: 0.00, hi: 0.01,  peak: 95, floor: 76, key: 'top1'     },
  { lo: 0.01, hi: 0.05,  peak: 75, floor: 66, key: '1-5'      },
  { lo: 0.05, hi: 0.15,  peak: 65, floor: 51, key: '5-15'     },
  { lo: 0.15, hi: 0.25,  peak: 50, floor: 41, key: '15-25'    },
  { lo: 0.25, hi: 0.35,  peak: 40, floor: 31, key: '25-35'    },
  { lo: 0.35, hi: 0.45,  peak: 30, floor: 21, key: '35-45'    },
  { lo: 0.45, hi: 0.75,  peak: 20, floor: 11, key: '45-75'    },
  { lo: 0.75, hi: 1.001, peak: 0,  floor: 0,  key: 'bottom25' },
];
const UNRANKED_PTS = 10; // zero decisions, or a pick with no trackable capper

// Volume caps: a thin record ranks wherever Wilson puts it, but what its picks
// can COLLECT is capped until the sample earns trust. Overall ladder only —
// the in-sport bonus is exempt by design (a 5-0 sport specialist gets it all).
const capForDecisions = (n) => (n >= 30 ? Infinity : n >= 10 ? 70 : 50);

// Fade (bottom-band cappers with genuinely losing records, not just thin ones):
//   WATCH  = bottom 25% AND win% <= 45 AND 5+ decisions  -> picks contribute 0
//   ACTIVE = bottom 25% AND win% <= 40 AND 15+ decisions -> opposite slot gets fade points
const FADE_WATCH_WIN  = 45, FADE_WATCH_N  = 5;
const FADE_ACTIVE_WIN = 40, FADE_ACTIVE_N = 15;

// ── THE BREAK-EVEN GATE (Jack 2026-07-09 evening) ─────────────────────────────
// The Wilson bound never compares anyone to the coin flip, and for a fixed win%
// it RISES with volume — so in a pool where most records are thin, a losing
// capper with 60+ decisions floats into the top bands and mints golds (Breaking
// Bank, 31-33 and -$78 lifetime, ranked top 9% and handed out 60 points a pick).
// Ranking is evidence you exist; collectible points also require evidence you
// WIN. A capper's shrunk win% (empirical Bayes toward the coin flip, GATE_K
// pseudo-decisions) must clear 50% to hand out more than the unknown-capper
// flat 10; full points return at 53% (~break-even at standard juice), tapering
// linearly between so there is no cliff to game. Below the gate: ladder points
// pin at UNRANKED_PTS, chip-ins add 0, and the in-sport rank bonus (gated on
// the SPORT pool's own record) pays 0. Rank/band/percentile are untouched — the
// leaderboard still shows where volume put them; the gate only controls what
// their backing is worth. Applied at materialization so the scorer reads gated
// numbers with no changes.
const GATE_K = 25, GATE_LO = 0.50, GATE_HI = 0.53;
function gateT(w, decisions) {
  const shrunk = (w + GATE_K / 2) / (decisions + GATE_K);
  return Math.max(0, Math.min(1, (shrunk - GATE_LO) / (GATE_HI - GATE_LO)));
}

// In-sport bonus (applies to the pick's BEST backer, no volume cap):
//   +20 = #1 of the sport pool or top 5% | +10 = top 25%
const SPORT_TOP_PTS = 20, SPORT_GOOD_PTS = 10;

function wilsonLower(w, n, z = WILSON_Z) {
  if (!n) return 0;
  const p = w / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}
const bandFor = (pctile) => LADDER.find((b) => pctile <= b.hi) || LADDER[LADDER.length - 1];
function ladderPts(pctile) {
  const b = bandFor(pctile);
  const t = (pctile - b.lo) / (b.hi - b.lo);
  return b.peak - t * (b.peak - b.floor);
}

// Rank a pool (array of {w, n} carriers). Ties on (wilson, win%, decisions)
// share the better rank so identical records never map to different points.
function rankPool(members) {
  const sorted = [...members].sort((a, b) =>
    b.wilson - a.wilson || b.winPct - a.winPct || b.decisions - a.decisions ||
    String(a.key).localeCompare(String(b.key)));
  let prevRank = 0;
  sorted.forEach((m, i) => {
    const prev = sorted[i - 1];
    m.rank = (prev && prev.wilson === m.wilson && prev.winPct === m.winPct && prev.decisions === m.decisions)
      ? prevRank : i + 1;
    prevRank = m.rank;
    m.pctile = m.rank / sorted.length;
  });
  return sorted;
}

// Legacy resume constants — frozen at launch values. The ratchet (v3.2) is
// retired; settings v3_scale / v3_scale_anchor stay in the DB, dormant.
const LAUNCH = { BASE: 45, VOL_K: 10, MULT: 360, CAP_BASE: 25, CAP_SLOPE: 30, HARD_CAP: 55, CON_CAP: 30 };
const SCALE = { ...LAUNCH };

// Tier bars (display continuity; fade now lives in the wilson engine above)
const TIER_RATED_N     = 25;
const TIER_PROVEN_N    = 50;

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

// Resume points for a capper in a sport (doc formula, on the CURRENT scale)
function resumePoints(sBlend, sportN, oBlend) {
  const skill  = Math.min(Math.max(sBlend, 0), SKILL_CAP);
  const volume = sportN / (sportN + SCALE.VOL_K);
  const trust  = Math.max(TRUST_MIN, Math.min(TRUST_MAX, oBlend / TRUST_MID));
  const raw    = Math.round(SCALE.MULT * skill * volume * trust);
  const cap    = Math.min(SCALE.HARD_CAP, SCALE.CAP_BASE + Math.round(SCALE.CAP_SLOPE * volume));
  return Math.max(0, Math.min(raw, cap));
}

// Leaderboard rating: the overall analog of resume points (doc formula)
function overallRating(oBlend, n) {
  return Math.max(0, Math.round(300 * Math.min(Math.max(oBlend, 0), SKILL_CAP) * (n / (n + SCALE.VOL_K))));
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
  // CHAIN-SAFE: merges can arrive in any order ("Docs" -> "Docs Sports" today,
  // "Docs Sports" -> "Docs Empire" next week), leaving alias rows that point at
  // names which are themselves aliases. Follow the chain to the final canonical
  // (bounded, cycle-guarded) or merged cappers silently stay split in the pools.
  return (name, source) => {
    let cur = aliasMap.get(norm(name)) || handleMap.get(`${source || 'discord'}|${norm(name)}`) || name;
    for (let hops = 0; hops < 5; hops++) {
      const next = aliasMap.get(norm(cur));
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  };
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
       blend, resume_points, tier, fade, sources,
       wilson, wilson_rank, percentile, band, pts, stack_add, decisions, win_pct, sport_bonus_pts,
       computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const NO_WILSON = [null, null, null, null, null, null, null, null, null];

  // ── WILSON POOLS ──────────────────────────────────────────────────────────────
  // Overall: every capper with at least one decision (win or loss), one pool.
  // Their percentile position drives the ladder points their picks earn.
  const overallPool = [];
  for (const [name, c] of cappers) {
    const decisions = c.w + c.l;
    if (decisions >= 1) {
      overallPool.push({ key: name, wilson: wilsonLower(c.w, decisions), winPct: (100 * c.w) / decisions, decisions, w: c.w });
    }
  }
  rankPool(overallPool);
  const winfo = new Map(); // canonical -> the overall wilson record
  for (const m of overallPool) {
    const band = bandFor(m.pctile);
    const cap = capForDecisions(m.decisions);
    const slid = band.key === 'bottom25' ? 0 : ladderPts(m.pctile);
    const fade = band.key === 'bottom25' && m.decisions >= FADE_ACTIVE_N && m.winPct <= FADE_ACTIVE_WIN ? 'active'
               : band.key === 'bottom25' && m.decisions >= FADE_WATCH_N  && m.winPct <= FADE_WATCH_WIN  ? 'watch'
               : null;
    const t = gateT(m.w, m.decisions); // break-even gate: 0 below 50% shrunk, 1 at 53%
    winfo.set(m.key, {
      wilson: +m.wilson.toFixed(4), rank: m.rank, pctile: +m.pctile.toFixed(4), band: band.key,
      pts: (fade || band.key === 'bottom25') ? 0
         : +(UNRANKED_PTS + t * (Math.min(slid, cap) - UNRANKED_PTS)).toFixed(1),
      stackAdd: (fade || band.key === 'bottom25') ? 0 : +(t * Math.min(band.peak, cap) / 2).toFixed(1),
      decisions: m.decisions, winPct: +m.winPct.toFixed(1), fade,
    });
  }

  // Per-sport pools: same ranking inside each sport; feeds the in-sport bonus
  // (+20 for the sport's #1 or top 5%, +10 for top 25%; needs at least one win).
  const sportPools = new Map();
  for (const [name, c] of cappers) {
    for (const [sport, s] of c.sports) {
      const dec = s.w + s.l;
      if (dec < 1) continue;
      if (!sportPools.has(sport)) sportPools.set(sport, []);
      sportPools.get(sport).push({ key: name, wilson: wilsonLower(s.w, dec), winPct: (100 * s.w) / dec, decisions: dec, w: s.w });
    }
  }
  const sinfo = new Map(); // `${canonical}|${sport}` -> the sport wilson record
  for (const [sport, poolArr] of sportPools) {
    rankPool(poolArr);
    for (const m of poolArr) {
      // Break-even gate on the SPORT record: a losing in-sport résumé earns no
      // in-sport bonus no matter where volume ranked it in the pool.
      const raw = m.wilson > 0 && (m.rank === 1 || m.pctile <= 0.05) ? SPORT_TOP_PTS
                : m.wilson > 0 && m.pctile <= 0.25 ? SPORT_GOOD_PTS : 0;
      const bonus = Math.round(gateT(m.w, m.decisions) * raw);
      sinfo.set(`${m.key}|${sport}`, {
        wilson: +m.wilson.toFixed(4), rank: m.rank, pctile: +m.pctile.toFixed(4),
        bonus, decisions: m.decisions, winPct: +m.winPct.toFixed(1),
      });
    }
  }

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
      // Entities are ops/display rows ONLY: never in a wilson pool, never an
      // advocate, never stack. band 'entity' marks them unmistakably.
      insert.run(
        name, 'overall', null, null, c.n, c.w, c.l, c.p, +c.u.toFixed(3),
        +oBlend.toFixed(4), overallRating(oBlend, c.n), 'entity', null, null,
        null, null, null, 'entity', null, null, c.w + c.l, (c.w + c.l) ? +((100 * c.w) / (c.w + c.l)).toFixed(1) : null, null,
      );
      for (const [sport, s] of c.sports) {
        const sBlend = sportBlend(s.u, s.n, oBlend);
        insert.run(
          name, `sport:${sport}`, sport, null, s.n, s.w, s.l, s.p, +s.u.toFixed(3),
          +sBlend.toFixed(4), resumePoints(sBlend, s.n, oBlend), null, null, null,
          ...NO_WILSON,
        );
      }
    }
    for (const [name, c] of cappers) {
      const oBlend = overallBlend(c.u, c.n);

      const tier = c.n >= TIER_PROVEN_N && oBlend > 0 ? 'proven'
                 : c.n >= TIER_RATED_N ? 'rated'
                 : c.n >= 10 ? 'building' : 'tracking';
      const wi = winfo.get(name) || null; // null = zero decisions -> flat UNRANKED_PTS
      const fade = wi?.fade ?? null;

      insert.run(
        name, 'overall', null, null, c.n, c.w, c.l, c.p, +c.u.toFixed(3),
        +oBlend.toFixed(4), overallRating(oBlend, c.n), tier, fade,
        [...c.sources].sort().join(','),
        wi?.wilson ?? 0, wi?.rank ?? null, wi?.pctile ?? null, wi?.band ?? 'new',
        wi ? wi.pts : UNRANKED_PTS, wi?.stackAdd ?? 0,
        wi?.decisions ?? 0, wi?.winPct ?? null, null,
      );

      for (const [sport, s] of c.sports) {
        const sBlend = sportBlend(s.u, s.n, oBlend);
        const si = sinfo.get(`${name}|${sport}`) || null;
        insert.run(
          name, `sport:${sport}`, sport, null, s.n, s.w, s.l, s.p, +s.u.toFixed(3),
          +sBlend.toFixed(4), resumePoints(sBlend, s.n, oBlend), null, null, null,
          si?.wilson ?? 0, si?.rank ?? null, si?.pctile ?? null, null, null, null,
          si?.decisions ?? 0, si?.winPct ?? null, si?.bonus ?? 0,
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
          ...NO_WILSON,
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
  wilsonLower, LADDER, UNRANKED_PTS, WILSON_Z,
};

// CLI: node src/capper_ratings.js
if (require.main === module) {
  recomputeCapperRatings();
  const top = db.prepare(`
    SELECT canonical_name, wins, losses, decisions, win_pct, wilson, wilson_rank, band, pts, stack_add, fade
    FROM capper_ratings WHERE scope='overall' AND band NOT IN ('entity')
    ORDER BY (wilson_rank IS NULL), wilson_rank ASC LIMIT 15
  `).all();
  console.table(top);
  console.log('Fade list:', getFadeList());
}
