// src/scoring_v3.js
// THE WILSON PERCENTILE SCORER (Jack 2026-07-09; supersedes the resume engine —
// see docs/CA_ALGORITHM_V3.md v4 section). A pick's score is who backs it:
//
//   best backer's ladder points (their percentile position in the all-capper
//   Wilson ranking, slid within band, volume-capped — capper_ratings.pts)
//   + each additional ranked backer's stack_add (half their band peak, capped)
//   + in-sport bonus (+20 best backer is the sport's #1/top 5%, +10 top 25%)
//   + market signals 0-8 + side lean 0-5 + sport bonus 5
//   + fade points 0-8 (from the OPPOSITE slot's fade-active cappers) + offset.
//
// DEAD: the flat base, the resume formula, join-consensus, source-entity
// advocacy (@src:* rows are ops display only), and the earned-scale ratchet
// (settings v3_scale/v3_scale_anchor sit dormant). A pick whose capper can't
// be tracked gets a flat UNRANKED_PTS. Points are still never subtracted.
//
// THE REVEAL PLAN (Jack 2026-07-16, replaces the chunked leak ramp): the public
// display score and the conviction curve are now 100% REAL on timing — backer
// points, fade points, and the conflict offset all surface at the exact moment
// they actually happened (mention timestamps, net deltas). The ONLY obfuscation
// left is on the four formula-shaped components (in-sport rank bonus, market
// signals, side lean, sport bonus): each surfaces at its own seeded-random
// moment, always at least REVEAL_LEAD_MS before game start, so its timing can
// never be correlated with the market event that produced it. Best-backer
// arrivals self-obfuscate: the curve shows the NET step (new best + old best
// halved into the stack), so no one can read a single capper's worth off a join.
// Only engages when scoring_version === 'v3'.

const db = require('./db');
const ratingsLib = require('./capper_ratings');

const UNRANKED_PTS = ratingsLib.UNRANKED_PTS; // no trackable capper / zero decisions
const STACK_MIN_DECISIONS = 12; // graded decisions required to chip in on another pick (Jack 2026-07-09: 20 -> 12; Indian Cowboy at 11-3 was chipping 0)
const MARKET_CAP = 8;
const FADE_CAP = 8;
const NO_VENUE_SPORTS = new Set(['ATP', 'WTA', 'GOLF']);

// ── Small odds helpers ─────────────────────────────────────────────────────────
function impliedProb(american) {
  const o = parseFloat(american);
  if (!Number.isFinite(o) || o === 0) return null;
  return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
}
function devig2(oddsSide, oddsOther) {
  const a = impliedProb(oddsSide), b = impliedProb(oddsOther);
  if (a == null || b == null || a + b <= 0) return null;
  return a / (a + b);
}

// ── Ratings lookups (materialized; O(1) per pick) ─────────────────────────────
function sportRow(name, sport) {
  try { return db.prepare(`SELECT * FROM capper_ratings WHERE canonical_name = ? AND scope = ?`).get(name, `sport:${sport}`) || null; } catch (_) { return null; }
}
function overallRow(name) {
  try { return db.prepare(`SELECT * FROM capper_ratings WHERE canonical_name = ? AND scope = 'overall'`).get(name) || null; } catch (_) { return null; }
}
function typeRow(name, sport, pickType) {
  try { return db.prepare(`SELECT * FROM capper_ratings WHERE canonical_name = ? AND scope = ?`).get(name, `type:${sport}/${(pickType || '?').toLowerCase()}`) || null; } catch (_) { return null; }
}

// ── Mentions: per-mention capper + channel (attribution from Phase 1) ─────────
function mentionsFor(pickId) {
  try {
    return db.prepare(`SELECT capper_name, channel FROM raw_messages WHERE pick_id = ? ORDER BY id ASC`).all(pickId);
  } catch (_) { return []; }
}

// One backer's ladder standing from the materialized ratings. Fade cappers
// contribute 0 (their negativity routes to the opposite slot instead). A capper
// with no row or no decisions is 'unranked': worth the flat UNRANKED_PTS as the
// best backer, nothing as a joiner.
function backerLadder(name) {
  const o = overallRow(name);
  if (!o || o.band === 'entity') return { name, pts: UNRANKED_PTS, decisions: 0, band: 'untracked', rank: null, pctile: null, fade: null };
  if (o.fade) return { name, pts: 0, decisions: o.decisions ?? 0, band: o.band, rank: o.wilson_rank, pctile: o.percentile, fade: o.fade };
  return {
    name,
    pts: o.pts != null ? o.pts : UNRANKED_PTS,
    decisions: o.decisions ?? 0,
    band: o.band ?? 'new',
    rank: o.wilson_rank ?? null,
    pctile: o.percentile ?? null,
    fade: null,
  };
}

// ── Opposite slot (fade target) ───────────────────────────────────────────────
function oppositeSlot(pick) {
  const pt = (pick.pick_type || '').toLowerCase();
  try {
    if (pt === 'over' || pt === 'under') {
      return db.prepare(`SELECT * FROM picks WHERE espn_game_id = ? AND LOWER(pick_type) = ? LIMIT 1`)
        .get(pick.espn_game_id, pt === 'over' ? 'under' : 'over');
    }
    if (pt === 'ml' || pt === 'spread') {
      return db.prepare(`SELECT * FROM picks WHERE espn_game_id = ? AND LOWER(pick_type) = ? AND LOWER(team) != LOWER(?) LIMIT 1`)
        .get(pick.espn_game_id, pt, pick.team || '');
    }
  } catch (_) {}
  return null;
}

// Fade points a slot RECEIVES from fade-active cappers on its opposite slot.
// SPORT-VOLUME SCALED (Jack, 2026-07-07): a fade capper's 0-2 in NBA is nearly
// zero evidence about NBA, so fade points scale by their graded volume in the
// pick's sport (n/(n+10)). Breaking-Bank-style: full-ish fade in his 31-pick
// MLB, essentially nothing in his 2-pick NBA.
//
// Split in two so the conviction-curve replay can run the SAME math over a
// partial capper list: fadeFromCappers is the pure aggregation (ordered capper
// names from the SOURCE slot + that slot's pick_type), fadePointsInto is the
// full-slot wrapper computeV3 uses.
function fadeFromCappers(cappers, sourcePickType, sport) {
  const seen = new Set();
  let pts = 0; const from = [];
  for (const name of cappers || []) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const o = overallRow(name);
    if (!o || o.fade !== 'active') continue;
    const s = sportRow(name, sport);
    const t = typeRow(name, sport, sourcePickType);
    const worst = Math.min(s?.blend ?? 0, t?.blend ?? 0, o.blend ?? 0);
    if (worst >= 0) continue; // sport/type being faded must itself be negative
    const raw = Math.max(3, Math.min(8, Math.round(-100 * worst)));
    const sportN = s?.picks ?? 0;
    const scaled = Math.round(raw * (sportN / (sportN + 10)));
    if (scaled < 2) continue; // not enough sport evidence to act on
    pts += scaled; from.push({ capper: name, pts: scaled, sport_picks: sportN });
  }
  return { pts: Math.min(FADE_CAP, pts), from };
}

function fadePointsInto(pick, sport) {
  const opp = oppositeSlot(pick);
  if (!opp) return { pts: 0, from: [] };
  return fadeFromCappers(mentionsFor(opp.id).map(m => m.capper_name), opp.pick_type, sport);
}

// ── Market signals (all free cached data; small caps, full values logged) ─────
function marketSignals(pick, game) {
  const out = { edge_pct: null, edge_pts: 0, steam_pts: 0, steam: null, contrarian_pts: 0, tickets_against: null, price_bucket: null, price_pts: 0 };
  const pt = (pick.pick_type || '').toLowerCase();
  const isHome = !!pick.is_home_team;

  // Price bucket (logged only, 0 points at launch)
  if (pt === 'ml' && game) {
    const o = isHome ? game.ml_home : game.ml_away;
    const v = parseFloat(o);
    if (Number.isFinite(v)) {
      out.price_bucket = v > 0 ? 'dog' : v >= -150 ? '-101..-150' : v >= -200 ? '-151..-200' : '<-200';
    }
  }

  // Edge vs prediction markets (ML only at launch)
  if (pt === 'ml' && game) {
    let marketProb = null;
    try {
      const pm = db.prepare(`SELECT markets_json FROM polymarket_cache WHERE espn_game_id = ?`).get(pick.espn_game_id);
      const mj = pm ? JSON.parse(pm.markets_json || '{}') : null;
      if (mj?.moneyline?.home_prob != null) marketProb = isHome ? mj.moneyline.home_prob : (mj.moneyline.away_prob ?? (1 - mj.moneyline.home_prob));
    } catch (_) {}
    if (marketProb == null) {
      try {
        const ka = db.prepare(`SELECT markets_json FROM kalshi_cache WHERE espn_game_id = ?`).get(pick.espn_game_id);
        const kj = ka ? JSON.parse(ka.markets_json || '{}') : null;
        if (kj?.moneyline?.home_prob != null) marketProb = isHome ? kj.moneyline.home_prob : (kj.moneyline.away_prob ?? (1 - kj.moneyline.home_prob));
      } catch (_) {}
    }
    const fair = devig2(isHome ? game.ml_home : game.ml_away, isHome ? game.ml_away : game.ml_home);
    if (marketProb != null && fair != null) {
      const edge = (marketProb - fair) * 100; // market thinks pick side is MORE likely than the book price implies
      out.edge_pct = +edge.toFixed(2);
      out.edge_pts = Math.max(0, Math.min(5, Math.round(edge * 0.5)));
    }
  }

  // Steam: line moved toward the pick since first snapshot (line_history)
  try {
    const rows = db.prepare(`
      SELECT * FROM line_history WHERE espn_game_id = ? ORDER BY recorded_at ASC
    `).all(pick.espn_game_id);
    if (rows.length >= 2) {
      const first = rows[0], last = rows[rows.length - 1];
      if (pt === 'ml') {
        const f = impliedProb(isHome ? first.ml_home : first.ml_away);
        const l = impliedProb(isHome ? last.ml_home : last.ml_away);
        if (f != null && l != null) {
          out.steam = +((l - f) * 100).toFixed(2);
          if (l - f >= 0.02) out.steam_pts = 2;
        }
      } else if (pt === 'spread' && first.spread_home != null && last.spread_home != null) {
        const move = last.spread_home - first.spread_home; // negative = home side steamed
        out.steam = move;
        if ((isHome && move <= -0.5) || (!isHome && move >= 0.5)) out.steam_pts = 2;
      } else if ((pt === 'over' || pt === 'under') && first.over_under != null && last.over_under != null) {
        const move = last.over_under - first.over_under;
        out.steam = move;
        if ((pt === 'over' && move >= 0.5) || (pt === 'under' && move <= -0.5)) out.steam_pts = 2;
      }
    }
  } catch (_) {}

  // Contrarian: 65%+ of tickets on the other side (public_betting)
  try {
    const pb = db.prepare(`SELECT * FROM public_betting WHERE espn_game_id = ?`).get(pick.espn_game_id);
    if (pb) {
      let against = null;
      if (pt === 'ml')          against = isHome ? pb.away_ml_pct : pb.home_ml_pct;
      else if (pt === 'spread') against = isHome ? pb.away_spread_pct : pb.home_spread_pct;
      else if (pt === 'over')   against = pb.under_pct;
      else if (pt === 'under')  against = pb.over_pct;
      if (against != null) {
        out.tickets_against = against;
        if (against >= 65) out.contrarian_pts = 1;
      }
    }
  } catch (_) {}

  return out;
}

// ── Backer aggregation (shared by computeV3 AND the conviction-curve replay) ──
// Every distinct backer through the Wilson ladder, best first. Source entities
// never advocate — an anonymous pick (no attributed capper at all) is worth the
// flat UNRANKED_PTS, exactly like an untracked name.
//
// Stack (Jack 2026-07-09, refined live): each ADDITIONAL backer chips in half
// of THEIR OWN WORTH (their capped solo ladder points), tapering by PAIRS
// WITHIN THEIR BAND — a band's 1st-2nd joiners add 1/2, its 3rd-4th add 1/4,
// and so on. CHIP-IN FLOOR: a backer needs 12+ graded decisions before they
// can boost someone else's pick at all (their own picks score regardless) —
// without it, piles of thin 5-1 wallets minted 200-point crowd golds.
// Unranked, bottom-band, and fade backers never stack.
function backerAggregate(cappers) {
  const backers = (cappers || []).filter(Boolean).map(backerLadder).sort((a, b) => b.pts - a.pts);
  const best = backers[0] ?? null;
  const advocate = best ? { name: best.name, pts: best.pts } : { name: null, pts: UNRANKED_PTS };

  let consensus = 0;
  const joinLog = [];
  const bandSeen = {};
  for (const b of backers.slice(1)) {
    if (b.fade || b.pts <= 0 || ['untracked', 'new', 'bottom25'].includes(b.band)) continue;
    if (b.decisions < STACK_MIN_DECISIONS) {
      joinLog.push({ name: b.name, pts: b.pts, applied: 0, floored: true });
      continue;
    }
    const k = bandSeen[b.band] || 0;
    const add = b.pts / Math.pow(2, Math.floor(k / 2) + 1);
    bandSeen[b.band] = k + 1;
    consensus += add;
    joinLog.push({ name: b.name, pts: b.pts, applied: +add.toFixed(1) });
  }
  return { backers, best, advocate, resume: advocate.pts, consensus: Math.round(consensus), joiners: joinLog };
}

// Conflict offset (shared): if THIS slot has a fade-active mention (it generated
// fade onto the opposite) AND a positive-resume capper is also here, this side
// gets min(generated fade, that capper's join points) back. Never subtracts.
function conflictOffset(pick, sport, backers, ownCappers) {
  const ownFadeActive = backers.some(b => b.fade === 'active');
  if (!ownFadeActive) return 0;
  const proven = backers.find(b => !b.fade && b.pts > 0 && b.decisions >= STACK_MIN_DECISIONS);
  if (!proven) return 0;
  const opp = oppositeSlot(pick);
  // what this slot's fade-active capper sent to the opposite side
  const sentPts = opp ? fadeFromCappers(ownCappers, pick.pick_type, sport).pts : 0;
  return Math.round(Math.min(sentPts, proven.pts / 2));
}

// One replayed moment of a pick's backer-side score: best backer + stack +
// fade-in + conflict offset, given the cappers seen SO FAR on each side. The
// conviction curve steps through mentions with this, so the curve's math is
// computeV3's math by construction — same helpers, never a fork.
function replaySubtotal(pick, sport, ownCappers, oppCappers, oppPickType) {
  const agg = backerAggregate(ownCappers);
  const fadeIn = fadeFromCappers(oppCappers, oppPickType, sport);
  const offset = conflictOffset(pick, sport, agg.backers, ownCappers);
  return { pts: agg.resume + agg.consensus + fadeIn.pts + offset, agg, fadeIn, offset };
}

// ── The main compute ──────────────────────────────────────────────────────────
function computeV3(pickId) {
  const pick = db.prepare(`SELECT * FROM picks WHERE id = ?`).get(pickId);
  if (!pick) return null;
  const game = pick.espn_game_id
    ? db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(pick.espn_game_id)
    : null;
  const sport = pick.sport || game?.sport || 'Unknown';
  const sportU = (sport || '').toUpperCase();
  const pt = (pick.pick_type || '').toLowerCase();
  const isTotal = pt === 'over' || pt === 'under';

  // Mentions: distinct cappers (attributed) + channels seen
  const mentions = mentionsFor(pickId);
  const cappers = [...new Set(mentions.map(m => m.capper_name).filter(Boolean))];
  const channels = [...new Set(mentions.map(m => m.channel).filter(Boolean))];
  if (!mentions.length && pick.capper_name) cappers.push(pick.capper_name);
  if (!channels.length && pick.channel) channels.push(pick.channel);

  const { backers, best, advocate, resume: resumePts, consensus, joiners: joinLog } = backerAggregate(cappers);

  // In-sport bonus: the best backer's standing inside THIS sport's Wilson pool
  // (+20 for the sport's #1 or top 5%, +10 for top 25%). No volume cap.
  const bestSport = best?.name ? sportRow(best.name, sport) : null;
  const sportPctPts = bestSport?.sport_bonus_pts ?? 0;

  // Market signals
  const mkt = marketSignals(pick, game);
  const marketPts = Math.min(MARKET_CAP, mkt.edge_pts + mkt.steam_pts + mkt.contrarian_pts);

  // Side lean (data-driven home/away, tennis+golf excluded, totals excluded)
  let leanPts = 0, leanSide = null;
  if (!isTotal && !NO_VENUE_SPORTS.has(sportU)) {
    try {
      const lean = JSON.parse(db.getSetting('v3_side_lean', '{}'))[sportU];
      if (lean) {
        leanSide = lean.side;
        const pickSide = pick.is_home_team ? 'home' : 'away';
        if (pickSide === lean.side) leanPts = Math.max(0, Math.min(5, lean.pts));
      }
    } catch (_) {}
  }

  // The flat +5 sport bonus is RETIRED (Jack 2026-07-09 evening): every listed
  // sport got it, so it was 5 free points on essentially every pick — noise,
  // not signal. The in-sport RANK bonus above is the only sport-shaped points.
  const sportBonus = 0;

  // Fade points INTO this slot (opposite side fade-active activity) + conflict
  // offset (see conflictOffset above). Nothing ever subtracts.
  const fadeIn = fadePointsInto(pick, sport);
  const offset = conflictOffset(pick, sport, backers, cappers);

  // Totals gold gate (tough but not hard): the best backer's totals blend must
  // be non-negative, or the pick clears gold on non-capper strength anyway.
  let totalsGateOk = true;
  if (isTotal && advocate.name) {
    const t = typeRow(advocate.name, sport, pt);
    totalsGateOk = !t || (t.blend ?? 0) >= 0;
  }

  const total = Math.round(resumePts + consensus + sportPctPts + marketPts + leanPts + sportBonus + fadeIn.pts + offset);

  return {
    total,
    breakdown: {
      base: 0, // retired — kept so old readers see an explicit zero
      resume: resumePts,
      advocate: advocate.name,
      advocate_band: best?.band ?? 'untracked',
      advocate_rank: best?.rank ?? null,
      advocate_pctile: best?.pctile ?? null,
      consensus,
      joiners: joinLog,
      sport_pct: { pts: sportPctPts, rank: bestSport?.wilson_rank ?? null, pctile: bestSport?.percentile ?? null },
      market: { pts: marketPts, ...mkt },
      lean: { pts: leanPts, side: leanSide },
      sport_bonus: sportBonus,
      fade_in: fadeIn,
      conflict_offset: offset,
      totals_gate_ok: totalsGateOk,
      gold: total >= 100 && totalsGateOk,
      silver: total >= 75 && total < 100,
      scale: 'v4-wilson',
    },
  };
}

// ── Persist alongside v2 (dual logging) ───────────────────────────────────────
function computeAndLogV3(pickId) {
  const scored = computeV3(pickId);
  if (!scored) return null;
  try {
    db.prepare(`UPDATE score_breakdown SET v3_total = ?, v3_json = ? WHERE pick_id = ?`)
      .run(scored.total, JSON.stringify(scored.breakdown), pickId);
  } catch (_) {}
  // score_breakdown is wiped daily; pick_history is forever. Mirror the v3 total
  // there so the calibration series survives (row exists once the pick archived).
  try {
    db.prepare(`UPDATE pick_history SET v3_total = ? WHERE pick_id = ?`).run(scored.total, pickId);
  } catch (_) {}
  if (db.getSetting('scoring_version', 'v2') === 'v3') {
    // The chunked leak ramp is RETIRED (Jack 2026-07-16): display_score now just
    // mirrors the true total and the leak_* columns stay NULL. What the public
    // sees is computed at read time by effectiveDisplayScore (true total minus
    // the bonus components whose reveal moment hasn't arrived yet).
    try {
      db.prepare(`UPDATE picks SET display_score = ?, leak_target = NULL, leak_started_at = NULL, leak_window_sec = NULL WHERE id = ?`)
        .run(scored.total, pickId);
    } catch (_) {}
  }
  return scored;
}

// ── The reveal plan: WHEN each scoring component surfaces publicly ────────────
// Backer/fade/offset points show the moment they happen (the conviction curve
// replays the real mentions). The four formula-shaped components each get ONE
// deterministic seeded-random reveal moment per pick:
//   normal case: uniform inside [first mention, game start - 3h]
//   pick born inside that 3h window: a short trickle within ~20 min of birth
//     (still finishing at least 3 min before start when a start time exists)
//   no start time on file: same short trickle after birth
// Seeded by (pick id, component), so every request — the picks list, the game
// popup, the conviction curve — replays identical moments without storing a
// schedule, and the moment never moves for the life of the pick.
const REVEAL_LEAD_MS = 3 * 60 * 60 * 1000;   // bonuses fully visible 3h before start
const REVEAL_SOFT_MS = 20 * 60 * 1000;       // late-born picks: reveal within ~20 min
const REVEAL_COMPONENTS = [
  { key: 'sport_pct',   salt: 0x9E3779B1, label: 'Sport rank', pts: bd => Math.round(bd?.sport_pct?.pts ?? 0) },
  { key: 'market',      salt: 0x7F4A7C15, label: 'Market',     pts: bd => Math.round(bd?.market?.pts ?? 0) },
  { key: 'lean',        salt: 0x94D049BB, label: 'Side lean',  pts: bd => Math.round(bd?.lean?.pts ?? 0) },
  { key: 'sport_bonus', salt: 0xBF58476D, label: 'Sport',      pts: bd => Math.round(bd?.sport_bonus ?? 0) },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseDbMs(s) {
  if (!s) return null;
  const str = String(s);
  const iso = str.includes('T') ? str : str.replace(' ', 'T') + 'Z';
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Everything the reveal math needs about a pick, fetched by id (all O(1)
// indexed lookups). Tolerates missing rows at every step.
const _stmts = {};
function _ctxStmt(key, sql) {
  if (!_stmts[key]) { try { _stmts[key] = db.prepare(sql); } catch (_) { return null; } }
  return _stmts[key];
}
function revealContext(pickId) {
  if (!pickId) return null;
  const out = { firstMentionMs: null, startMs: null, v3_total: null, bd: null };
  try {
    const m = _ctxStmt('firstMention', `SELECT MIN(message_timestamp) AS ts FROM raw_messages WHERE pick_id = ?`).get(pickId);
    out.firstMentionMs = parseDbMs(m?.ts);
  } catch (_) {}
  try {
    const p = _ctxStmt('pick', `SELECT espn_game_id, parsed_at FROM picks WHERE id = ?`).get(pickId);
    if (out.firstMentionMs == null) out.firstMentionMs = parseDbMs(p?.parsed_at);
    if (p?.espn_game_id) {
      const g = _ctxStmt('game', `SELECT start_time FROM today_games WHERE espn_game_id = ?`).get(p.espn_game_id);
      out.startMs = parseDbMs(g?.start_time);
    }
  } catch (_) {}
  try {
    const sb = _ctxStmt('breakdown', `SELECT v3_total, v3_json FROM score_breakdown WHERE pick_id = ?`).get(pickId);
    out.v3_total = sb?.v3_total ?? null;
    if (sb?.v3_json) { try { out.bd = JSON.parse(sb.v3_json); } catch (_) {} }
  } catch (_) {}
  return out;
}

// The deterministic reveal moments for a pick's bonus components. Only
// components currently worth points appear (values come from the live
// breakdown, so a component that changes value redraws at the same moment).
function bonusRevealEvents(pickId, ctx = null) {
  const c = ctx || revealContext(pickId);
  if (!c || !c.bd) return [];
  const born = c.firstMentionMs ?? Date.now();
  const hardEnd = c.startMs != null ? c.startMs - REVEAL_LEAD_MS : null;
  const out = [];
  for (const comp of REVEAL_COMPONENTS) {
    const pts = comp.pts(c.bd);
    if (!pts || pts <= 0) continue;
    const rnd = mulberry32(((pickId * 2654435761) ^ comp.salt) >>> 0);
    let ts;
    if (hardEnd != null && hardEnd > born) {
      ts = born + rnd() * (hardEnd - born);
    } else {
      // Born inside the 3h window (or no start time): short trickle after birth,
      // never past 3 min before a known start.
      let soft = born + rnd() * REVEAL_SOFT_MS;
      if (c.startMs != null) soft = Math.min(soft, c.startMs - 3 * 60 * 1000);
      ts = Math.max(born, soft);
    }
    out.push({ key: comp.key, label: comp.label, pts, ts: Math.round(ts) });
  }
  return out;
}

// Read-side: the score any public surface should show right now — the true v3
// total minus every bonus component whose reveal moment is still ahead. Backer,
// fade, and offset points are always fully included (they surface in real time).
function effectiveDisplayScore(pickRow, nowMs = Date.now()) {
  const ctx = revealContext(pickRow?.id);
  const trueTotal = Math.round(
    pickRow?.v3_total ?? ctx?.v3_total ?? pickRow?.leak_target ?? pickRow?.display_score ?? pickRow?.score ?? 0
  );
  if (!ctx || !ctx.bd) return trueTotal;
  let pending = 0;
  for (const ev of bonusRevealEvents(pickRow.id, ctx)) if (ev.ts > nowMs) pending += ev.pts;
  return Math.max(0, trueTotal - pending);
}

// The single, canonical "score to show right now" for a pick under v3. EVERY
// public surface (the picks list, the game-detail popup, the standalone detail
// page, the conviction curve) must run its rows through THIS so they all agree.
// The true v3 total ships only once every reveal moment has passed (always
// before game start). Expects a row carrying at least the pick id; v3_total
// (join to score_breakdown) is used when present, fetched otherwise.
function v3DisplayScore(p) {
  return effectiveDisplayScore(p);
}

module.exports = {
  computeV3, computeAndLogV3, effectiveDisplayScore, v3DisplayScore,
  backerAggregate, replaySubtotal, fadeFromCappers, oppositeSlot,
  bonusRevealEvents, revealContext, parseDbMs,
};

// CLI: node src/scoring_v3.js — v2 vs v3 on today's board, top of each
if (require.main === module) {
  const picks = db.prepare(`SELECT id, team, sport, pick_type, score, mention_count FROM picks WHERE mention_count > 0 ORDER BY score DESC`).all();
  const rows = [];
  for (const p of picks) {
    const v3 = computeAndLogV3(p.id);
    if (v3) rows.push({ team: p.team, sport: p.sport, type: p.pick_type, mentions: p.mention_count, v2: p.score, v3: v3.total, advocate: v3.breakdown.advocate, resume: v3.breakdown.resume, gold: v3.breakdown.gold ? 'GOLD' : v3.breakdown.silver ? 'silver' : '' });
  }
  rows.sort((a, b) => b.v3 - a.v3);
  console.table(rows.slice(0, 15));
  console.log(`scored ${rows.length} board picks (v3 logged to score_breakdown)`);
}
