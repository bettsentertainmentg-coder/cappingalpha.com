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
// the curve stays strictly rank-ordered — EXCEPT the deliberate cliff below
// the top band (70 -> 67, Jack 2026-07-09: top1 trimmed 95-76 -> 80-70 late
// night): full influence is a top-1% privilege, but even the #1 capper alone
// no longer clears gold without real company.
const LADDER = [
  { lo: 0.00, hi: 0.01,  peak: 80, floor: 70, key: 'top1'     },
  { lo: 0.01, hi: 0.05,  peak: 67, floor: 61, key: '1-5'      },
  { lo: 0.05, hi: 0.15,  peak: 60, floor: 51, key: '5-15'     },
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

// ── THE MONEY GATE (Jack 2026-07-13) ──────────────────────────────────────────
// Win% ignores price. A favorite-heavy capper can hit 61% and still bleed
// units flat-staked (swisstony, 101-65 and about -$150 at $10/pick, held full
// top-band value) — the win% gate can't see it, because at heavy juice a
// losing ledger and a winning percentage coexist. Ranking is evidence you
// exist; the win% gate is evidence you win; this gate is evidence the MONEY
// agrees. Smoothed flat-stake ROI (units / (decisions + GATE_K), same
// stabilizer as the win% gate) must be non-negative for full value; the value
// slides linearly below breakeven and pins to the unknown-capper flat 10 at
// -5% and beyond — deep enough that a $40 hole over 200 picks (normal
// variance, -1.8%) keeps most of its value while a swisstony-sized hole
// (-10%) pins hard. Applies to ladder points, chip-ins, AND the in-sport
// bonus (the OVERALL ledger governs: down bad = flat 10, full stop). Releases
// on its own — ratings recompute after every grading pass, so the first
// profitable stretch starts restoring value. Rank/band stay untouched, fade
// rules stay win%-based.
const MONEY_LO = -0.05, MONEY_HI = 0;
function moneyGateT(units, decisions) {
  const shrunkRoi = (units || 0) / (decisions + GATE_K);
  return Math.max(0, Math.min(1, (shrunkRoi - MONEY_LO) / (MONEY_HI - MONEY_LO)));
}

// THE HARD ZERO (Jack 2026-07-09, night): a capper whose RAW win% is 49 or
// below adds NOTHING to a pick — not the flat 10, no chip-in, no in-sport
// bonus even where their sport rank is high. A demonstrated loser is worth
// less than an unknown name (an anonymous pick still gets the flat 10; a pick
// backed only by a sub-49% record scores 0 from that backer). Cappers with no
// decisions have no win% and stay at the flat 10.
const HARD_ZERO_WIN = 49;

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

// ── PRICE-BEATEN EDGE (Jack 2026-07-28) ──────────────────────────────────────
// Win% ignores what the odds REQUIRED. Every graded decision carries its own
// bar: the break-even probability its price implied (-1000 needs 90.9%, +150
// needs 40%). edgeContrib credits a win by how much it beat that bar and
// debits a loss by the full bar, so a capper's summed edge is positive exactly
// when they win more often than their prices demanded. Backtested 2026-07-28
// (17k decisions, adversarially audited): NOT strong enough to replace the
// ladder sort or the win%/money gates wholesale — but decisive for the two
// uses below: (1) the reduce-only PRICE GATE on proven price-bleeders, and
// (2) the heavy-bracket unlock that lets a proven heavy-favorite specialist
// re-open tracking past the ML odds gate (storage.heavyBracketUnlocked).
function impliedProb(row) {
  const o = effOdds(row);
  return o < 0 ? Math.abs(o) / (Math.abs(o) + 100) : 100 / (o + 100);
}
function edgeContrib(row) {
  const r = (row.result || '').toLowerCase();
  if (r === 'win')  return 1 - impliedProb(row);
  if (r === 'loss') return -impliedProb(row);
  return 0; // pushes stay out, same as everywhere else
}

// The reduce-only price gate: applied ONLY where the evidence is overwhelming —
// 100+ decisions AND shrunk edge clearly negative. Thin records are untouched
// (the +25-decision shrink keeps them near zero, which is not "clearly
// negative"), so no capper is ever punished for a small sample. Reduce-only by
// construction: it can pin a proven price-bleeder to the flat UNRANKED_PTS, it
// never boosts anyone (the full edge gate stays shadow-logged until forward
// data earns it — see edge_shrunk on every ratings row).
const PRICE_GATE_MIN_N = 100, PRICE_GATE_EDGE = -0.02;

// Heavy-favorite bracket: decisions whose implied break-even is at or past the
// tracked-bet ML odds gate (settings heavy_ml_gate, default -300 = 75%). A
// capper with HEAVY_UNLOCK_N+ heavy decisions and positive shrunk heavy edge
// has EARNED tracking at prices the gate otherwise blocks.
const HEAVY_UNLOCK_N = 30;
function heavyGateOdds() {
  const v = parseFloat(db.getSetting('heavy_ml_gate', '-300'));
  return Number.isFinite(v) && v < 0 ? v : -300;
}
const heavyImpliedFloor = () => { const g = Math.abs(heavyGateOdds()); return g / (g + 100); };

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
  // NORM-IDENTICAL VARIANTS: 'Picks4Dayzzz' and 'Picks 4 Dayzzz' normalize to
  // the same key but aggregate as two different cappers as raw strings. The
  // admin merge endpoint can alias such pairs, but until someone does, this
  // safety net still applies: map every KNOWN canonical's norm to its exact
  // string so spacing/punctuation variants of a canonical collapse onto it.
  const canonByNorm = new Map();
  for (const c of aliasMap.values()) canonByNorm.set(norm(c), c);
  for (const c of handleMap.values()) canonByNorm.set(norm(c), c);
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
    return canonByNorm.get(norm(cur)) || cur;
  };
}

// ── PREGAME-ONLY RATINGS (Jack 2026-07-29) ────────────────────────────────────
// The site scores PREGAME picks only (source_ingest's board gate), but this
// recompute used to rank cappers on their FULL history — including in-play
// entries, which source_ingest records with live=true provenance and never
// places on the board. In-play rows are short-price heavy (win% inflated ~6pts
// at worse ROI — buying a side already ahead), and the ladder ranks on the
// Wilson bound of win%, exactly the number in-play betting inflates. At the
// time of the fix, 61 of 640 ranked cappers had ZERO pregame decisions and 9
// of the top-5% band ranked purely on bets we would never score. A capper is
// judged on what we judge the site on: pregame picks. Live rows stay in
// capper_history untouched (provenance + future live-lines work); they are
// simply no longer evidence here. Rows with no provenance (Discord era) are
// pregame by construction.
function isLiveRow(row) {
  if (!row.sources_json) return false;
  try {
    const arr = JSON.parse(row.sources_json);
    return Array.isArray(arr) && arr.some((s) => s && (s.live === true || (s.meta && s.meta.is_live === true)));
  } catch (_) { return false; }
}

// ── Recompute everything ──────────────────────────────────────────────────────
function recomputeCapperRatings() {
  const rows = db.prepare(`
    SELECT capper_name, sport, pick_type, result, odds, source, sources_json
    FROM capper_history
    WHERE result IN ('win', 'loss', 'push') AND capper_name IS NOT NULL
  `).all();

  const resolve = buildResolver();
  const cappers = new Map(); // canonical -> { n,w,l,p,u, sources:Set, sports:Map, types:Map }
  const heavyFloor = heavyImpliedFloor();

  let liveSkipped = 0;
  for (const row of rows) {
    if (isLiveRow(row)) { liveSkipped++; continue; } // pregame picks only
    const name = resolve(row.capper_name, row.source);
    if (!cappers.has(name)) {
      cappers.set(name, { n: 0, w: 0, l: 0, p: 0, u: 0, e: 0, imp: 0, impN: 0, hn: 0, he: 0, sources: new Set(), sports: new Map(), types: new Map() });
    }
    const c = cappers.get(name);
    const u = profit(row);
    const res = (row.result || '').toLowerCase();
    c.n++; c.u += u;
    if (res === 'win') c.w++; else if (res === 'loss') c.l++; else c.p++;
    c.sources.add(row.source || 'discord');
    // Price-beaten edge: decided rows only (pushes contribute 0 and are not a
    // decision anywhere else either).
    if (res === 'win' || res === 'loss') {
      const q = impliedProb(row);
      c.e += edgeContrib(row); c.imp += q; c.impN++;
      if (q >= heavyFloor) { c.hn++; c.he += edgeContrib(row); }
    }

    const sport = row.sport || 'Unknown';
    if (!c.sports.has(sport)) c.sports.set(sport, { n: 0, w: 0, l: 0, p: 0, u: 0, e: 0, imp: 0, impN: 0 });
    const s = c.sports.get(sport);
    s.n++; s.u += u;
    if (res === 'win') s.w++; else if (res === 'loss') s.l++; else s.p++;
    if (res === 'win' || res === 'loss') { s.e += edgeContrib(row); s.imp += impliedProb(row); s.impN++; }

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
      overallPool.push({ key: name, wilson: wilsonLower(c.w, decisions), winPct: (100 * c.w) / decisions, decisions, w: c.w, u: c.u, e: c.e });
    }
  }
  rankPool(overallPool);
  const winfo = new Map();    // canonical -> the overall wilson record
  const hardZero = new Set(); // cappers whose raw win% <= HARD_ZERO_WIN: contribute NOTHING
  const moneyT = new Map();   // canonical -> overall money-gate factor (in-sport bonus reads it too)
  for (const m of overallPool) {
    const band = bandFor(m.pctile);
    const cap = capForDecisions(m.decisions);
    const slid = band.key === 'bottom25' ? 0 : ladderPts(m.pctile);
    const fade = band.key === 'bottom25' && m.decisions >= FADE_ACTIVE_N && m.winPct <= FADE_ACTIVE_WIN ? 'active'
               : band.key === 'bottom25' && m.decisions >= FADE_WATCH_N  && m.winPct <= FADE_WATCH_WIN  ? 'watch'
               : null;
    const zero = m.winPct <= HARD_ZERO_WIN;
    if (zero) hardZero.add(m.key);
    // Both gates must pass in full for full value — the stricter one binds.
    const mt = moneyGateT(m.u, m.decisions);
    // THE PRICE GATE (Jack 2026-07-28, reduce-only): a capper whose 100+
    // decision record shows a clearly negative price-beaten edge (wins less
    // often than their own odds required, shrunk edge <= -2%) hands out the
    // flat UNRANKED_PTS no matter where win-rate volume ranked them — the
    // .Sisyphus. failure (90.5% win rate, NEGATIVE units at .998 avg implied)
    // is exactly what win% gates cannot see. Folded into the stored moneyT so
    // the in-sport bonus and sport ladders inherit it (down bad on price
    // overall = nothing extra anywhere, same rule as the money gate).
    const edgeShrunk = m.e / (m.decisions + GATE_K);
    const priceGated = m.decisions >= PRICE_GATE_MIN_N && edgeShrunk <= PRICE_GATE_EDGE;
    moneyT.set(m.key, Math.min(mt, priceGated ? 0 : 1));
    const t = Math.min(gateT(m.w, m.decisions), mt, priceGated ? 0 : 1); // win% x money x price
    winfo.set(m.key, {
      wilson: +m.wilson.toFixed(4), rank: m.rank, pctile: +m.pctile.toFixed(4), band: band.key,
      pts: (zero || fade || band.key === 'bottom25') ? 0
         : +(UNRANKED_PTS + t * (Math.min(slid, cap) - UNRANKED_PTS)).toFixed(1),
      stackAdd: (zero || fade || band.key === 'bottom25') ? 0 : +(t * Math.min(band.peak, cap) / 2).toFixed(1),
      decisions: m.decisions, winPct: +m.winPct.toFixed(1), fade,
      edgeShrunk: +edgeShrunk.toFixed(4), priceGated,
    });
  }

  // Per-sport pools: same ranking inside each sport; feeds the in-sport bonus
  // (+20 for the sport's #1 or top 5%, +10 for top 25%; needs at least one win).
  //
  // IN-SPORT LADDERS (Jack 2026-07-23, the MLB rework): every sport pool now
  // also materializes the FULL ladder — band, pts, stack_add — computed exactly
  // like the overall ladder but on the sport record alone (sport percentile,
  // sport volume cap, win%+money gates on the sport ledger, sport hard zero).
  // Two readers: the scorer (sports listed in v3_insport_sports collect ladder
  // points from THEIR SPORT'S pool, not the overall one — MLB first: overall
  // rank transferred at 55% inside MLB vs 62% elsewhere while real MLB records
  // hit 60.5%) and the admin Cappers tab's per-sport ladder view.
  const sportPools = new Map();
  for (const [name, c] of cappers) {
    for (const [sport, s] of c.sports) {
      const dec = s.w + s.l;
      if (dec < 1) continue;
      if (!sportPools.has(sport)) sportPools.set(sport, []);
      sportPools.get(sport).push({ key: name, wilson: wilsonLower(s.w, dec), winPct: (100 * s.w) / dec, decisions: dec, w: s.w, u: s.u });
    }
  }
  // THE ABSOLUTE QUALITY CAP (Jack 2026-07-28, in-sport sports only): pool
  // percentile is RELATIVE — in a weak pool, a 55% volume grinder ranks top-1%
  // and prices like an elite. For sports scored in-sport (v3_insport_sports),
  // a capper's ladder points are additionally capped by what their own shrunk
  // win% supports in absolute terms: 10 + (shrunk - 0.50) * 875, clamped to
  // [10, 80]. Break-even (~52.4%) caps near 31, 55% near 54, and only a
  // genuinely proven 58%+ shrunk record reaches the full 80. Points must be
  // earned against the coin flip, not against the pool.
  const INSPORT_QC_BASE = 10, INSPORT_QC_SLOPE = 875;
  const insportQualityCap = (w, dec) => {
    const shrunk = (w + GATE_K / 2) / (dec + GATE_K);
    return Math.max(UNRANKED_PTS, Math.min(80, INSPORT_QC_BASE + (shrunk - 0.50) * INSPORT_QC_SLOPE));
  };
  let insportSet = new Set(['MLB']);
  try {
    const arr = JSON.parse(db.getSetting('v3_insport_sports', '["MLB"]'));
    insportSet = new Set((Array.isArray(arr) ? arr : []).map(s => String(s).toUpperCase()));
  } catch (_) {}

  const sinfo = new Map(); // `${canonical}|${sport}` -> the sport wilson record
  for (const [sport, poolArr] of sportPools) {
    rankPool(poolArr);
    for (const m of poolArr) {
      // Break-even gate on the SPORT record: a losing in-sport résumé earns no
      // in-sport bonus no matter where volume ranked it in the pool. The hard
      // zero goes further: an overall win% at or below 49 earns no in-sport
      // bonus even where the sport record itself is winning. The MONEY gate
      // rides along on the OVERALL ledger: a capper who is down bad hands out
      // nothing extra anywhere, even in their best sport (Jack 2026-07-13).
      const raw = m.wilson > 0 && (m.rank === 1 || m.pctile <= 0.05) ? SPORT_TOP_PTS
                : m.wilson > 0 && m.pctile <= 0.25 ? SPORT_GOOD_PTS : 0;
      const bonus = hardZero.has(m.key) ? 0
        : Math.round(Math.min(gateT(m.w, m.decisions), moneyT.get(m.key) ?? 1) * raw);
      // The sport-scoped ladder: identical math to the overall pool, every input
      // swapped for the sport record. Sport hard zero (raw sport win% <= 49)
      // and the overall money position both zero it — a capper down bad overall
      // hands out nothing, even inside their best sport.
      const sBand = bandFor(m.pctile);
      const sCap = capForDecisions(m.decisions);
      const sSlid = sBand.key === 'bottom25' ? 0 : ladderPts(m.pctile);
      const sZero = m.winPct <= HARD_ZERO_WIN;
      const sT = Math.min(gateT(m.w, m.decisions), moneyGateT(m.u, m.decisions), moneyT.get(m.key) ?? 1);
      // In-sport sports: the absolute quality cap binds on top of the pool math.
      const qcap = insportSet.has(String(sport).toUpperCase()) ? insportQualityCap(m.w, m.decisions) : Infinity;
      sinfo.set(`${m.key}|${sport}`, {
        wilson: +m.wilson.toFixed(4), rank: m.rank, pctile: +m.pctile.toFixed(4),
        bonus, decisions: m.decisions, winPct: +m.winPct.toFixed(1),
        band: sBand.key,
        pts: (sZero || sBand.key === 'bottom25') ? 0
           : +Math.min(UNRANKED_PTS + sT * (Math.min(sSlid, sCap) - UNRANKED_PTS), qcap).toFixed(1),
        stackAdd: (sZero || sBand.key === 'bottom25') ? 0 : +Math.min(sT * Math.min(sBand.peak, sCap) / 2, qcap / 2).toFixed(1),
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
      SELECT sport, pick_type, result, odds, is_home_team, sources_json FROM capper_history
      WHERE result IN ('win','loss','push') AND is_home_team IS NOT NULL
        AND LOWER(pick_type) IN ('ml','spread')
        AND game_date >= date('now','-120 days')
    `).all()) {
      if (isLiveRow(r)) continue; // pregame picks only — same rule as the pool above
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
          si?.wilson ?? 0, si?.rank ?? null, si?.pctile ?? null, si?.band ?? null,
          si?.pts ?? null, si?.stackAdd ?? null,
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

  // Price-beaten columns (edge display + the price gate flag + the heavy-bracket
  // unlock stats). Written as an UPDATE pass so the positional insert above
  // stays untouched. edge_shrunk on every row IS the edge-gate shadow log:
  // the full gate never scores until forward data earns it, but every nightly
  // recompute records what it would have said.
  const edgeUpd = db.transaction(() => {
    const uo = db.prepare(`
      UPDATE capper_ratings SET needed_pct = ?, edge_shrunk = ?, heavy_n = ?, heavy_edge_shrunk = ?, price_gated = ?
      WHERE canonical_name = ? AND scope = 'overall'
    `);
    const us = db.prepare(`
      UPDATE capper_ratings SET needed_pct = ?, edge_shrunk = ? WHERE canonical_name = ? AND scope = ?
    `);
    for (const [name, c] of cappers) {
      const dec = c.w + c.l;
      const wi = winfo.get(name);
      uo.run(
        c.impN ? +(100 * c.imp / c.impN).toFixed(1) : null,
        dec ? +(c.e / (dec + GATE_K)).toFixed(4) : null,
        c.hn, c.hn ? +(c.he / (c.hn + GATE_K)).toFixed(4) : null,
        wi?.priceGated ? 1 : 0, name,
      );
      for (const [sport, s] of c.sports) {
        const sdec = s.w + s.l;
        us.run(
          s.impN ? +(100 * s.imp / s.impN).toFixed(1) : null,
          sdec ? +(s.e / (sdec + GATE_K)).toFixed(4) : null,
          name, `sport:${sport}`,
        );
      }
    }
  });
  edgeUpd();

  const summary = {
    cappers: cappers.size,
    rated: db.prepare(`SELECT COUNT(*) n FROM capper_ratings WHERE scope='overall' AND tier IN ('rated','proven')`).get().n,
    proven: db.prepare(`SELECT COUNT(*) n FROM capper_ratings WHERE scope='overall' AND tier='proven'`).get().n,
    fadeWatch: db.prepare(`SELECT COUNT(*) n FROM capper_ratings WHERE scope='overall' AND fade='watch'`).get().n,
    fadeActive: db.prepare(`SELECT COUNT(*) n FROM capper_ratings WHERE scope='overall' AND fade='active'`).get().n,
    liveSkipped,
  };
  console.log(`[ratings] recomputed: ${summary.cappers} cappers, ${summary.rated} rated (${summary.proven} proven), fade watch ${summary.fadeWatch} / active ${summary.fadeActive}, ${liveSkipped} in-play rows excluded`);
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
  // ladder internals exported for the no-lookahead replay (scripts/mlb_restate.js)
  // so the restatement runs the REAL math, never a fork
  bandFor, ladderPts, gateT, moneyGateT, capForDecisions, rankPool, HARD_ZERO_WIN,
  impliedProb, edgeContrib, heavyGateOdds, heavyImpliedFloor,
  PRICE_GATE_MIN_N, PRICE_GATE_EDGE, HEAVY_UNLOCK_N, isLiveRow,
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
