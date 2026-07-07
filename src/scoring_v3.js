// src/scoring_v3.js
// CA Algorithm v3 scorer (docs/CA_ALGORITHM_V3.md). Runs ALONGSIDE v2 behind the
// scoring_version setting: every scored pick gets its v3 component vector logged
// into score_breakdown (v3_total, v3_json) from day one; the public site keeps
// showing v2 until the Phase-5 calibration flips scoring_version to 'v3'.
//
// Components (all additive, never subtract from a pick):
//   base 40 (flat, source-blind) + advocate resume 0-55 (best capper OR source
//   entity) + consensus 0-12 (quality-weighted, steep diminish) + market signals
//   0-8 at launch (full values logged) + side lean 0-5 (nightly, data-driven) +
//   sport bonus 5 + price context 0 (logged) + fade points 0-8 (from the
//   OPPOSITE slot's fade-active cappers) + conflict offset.
//
// The leak rule (display score ramps, 20-50 min, finished before game start)
// is implemented here but only ENGAGES when scoring_version === 'v3'.

const db = require('./db');
const ratingsLib = require('./capper_ratings');

// ── Constants (starting values; Phase-5 backtest fits the final numbers) ──────
const BASE = 40;
const CONSENSUS_CAP = 12;
const MARKET_CAP = 8;
const FADE_CAP = 8;
const SPORT_BONUS = 5;
const SPORT_BONUS_SPORTS = new Set(['NBA', 'CBB', 'MLB', 'NFL', 'NCAAF', 'NHL', 'ATP', 'WTA', 'GOLF', 'SOCCER']);
const NO_VENUE_SPORTS = new Set(['ATP', 'WTA', 'GOLF']);
const LEAK_STEP = 25;          // jumps larger than this ramp in
const LEAK_MIN_MIN = 20, LEAK_MAX_MIN = 50;

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

// Join points for one additional capper (doc formula)
function joinPointsFor(name, sport) {
  const o = overallRow(name);
  if (!o) return 2;
  if (o.fade === 'active' || o.fade === 'watch') return 0;
  if (o.picks < 10) return 2;
  const s = sportRow(name, sport);
  const blend = s ? s.blend : o.blend;
  return Math.max(2, Math.min(8, Math.round(3 + 120 * Math.max(0, blend || 0))));
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
function fadePointsInto(pick, sport) {
  const opp = oppositeSlot(pick);
  if (!opp) return { pts: 0, from: [] };
  const seen = new Set();
  let pts = 0; const from = [];
  for (const m of mentionsFor(opp.id)) {
    const name = m.capper_name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const o = overallRow(name);
    if (!o || o.fade !== 'active') continue;
    const s = sportRow(name, sport);
    const t = typeRow(name, sport, opp.pick_type);
    const worst = Math.min(s?.blend ?? 0, t?.blend ?? 0, o.blend ?? 0);
    if (worst >= 0) continue; // sport/type being faded must itself be negative
    const p = Math.max(3, Math.min(8, Math.round(-100 * worst)));
    pts += p; from.push({ capper: name, pts: p });
  }
  return { pts: Math.min(FADE_CAP, pts), from };
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

  // Advocate resume: best mentioning capper vs best source entity
  const capperCand = cappers
    .map(name => ({ name, pts: sportRow(name, sport)?.resume_points ?? 0 }))
    .sort((a, b) => b.pts - a.pts);
  const entityCand = channels
    .map(ch => ({ name: `@src:${ch}`, pts: sportRow(`@src:${ch}`, sport)?.resume_points ?? 0 }))
    .sort((a, b) => b.pts - a.pts);
  const bestCapper = capperCand[0] || null;
  const bestEntity = entityCand[0] || null;
  const advocate = (bestCapper?.pts ?? 0) >= (bestEntity?.pts ?? 0) ? bestCapper : bestEntity;
  const resumePts = advocate?.pts ?? 0;

  // Consensus: everyone except the strongest capper, quality-weighted + diminish
  const joiners = capperCand.filter(c => c.name !== bestCapper?.name);
  const joinRaw = joiners
    .map(j => ({ name: j.name, pts: joinPointsFor(j.name, sport) }))
    .sort((a, b) => b.pts - a.pts);
  let consensus = 0;
  const joinLog = [];
  joinRaw.forEach((j, i) => {
    const factor = i === 0 ? 1 : i === 1 ? 0.5 : 0.25;
    const p = j.pts * factor;
    consensus += p;
    joinLog.push({ ...j, applied: +p.toFixed(1) });
  });
  consensus = Math.min(CONSENSUS_CAP, Math.round(consensus));

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

  const sportBonus = SPORT_BONUS_SPORTS.has(sportU) ? SPORT_BONUS : 0;

  // Fade points INTO this slot (opposite side fade-active activity) + conflict
  // offset: if THIS slot has a fade-active mention (it generated fade onto the
  // opposite) AND a positive-resume capper is also here, this side gets
  // min(generated fade, that capper's join points) back. Nothing ever subtracts.
  const fadeIn = fadePointsInto(pick, sport);
  let offset = 0;
  const ownFadeActive = cappers.some(n => overallRow(n)?.fade === 'active');
  if (ownFadeActive) {
    const proven = capperCand.find(c => {
      const o = overallRow(c.name);
      return o && (o.blend ?? 0) > 0 && o.picks >= 10 && o.fade == null;
    });
    if (proven) {
      // what this slot's fade-active capper sent to the opposite side
      const opp = oppositeSlot(pick);
      const sentPts = opp ? fadePointsInto(opp, sport).pts : 0;
      offset = Math.min(sentPts, joinPointsFor(proven.name, sport));
    }
  }

  // Totals gold gate (tough but not hard): advocate's totals blend must be
  // non-negative, or the pick clears gold on non-capper strength anyway.
  let totalsGateOk = true;
  if (isTotal && advocate?.name && !advocate.name.startsWith('@src:')) {
    const t = typeRow(advocate.name, sport, pt);
    totalsGateOk = !t || (t.blend ?? 0) >= 0;
  }

  const total = BASE + resumePts + consensus + marketPts + leanPts + sportBonus + fadeIn.pts + offset;

  return {
    total,
    breakdown: {
      base: BASE,
      resume: resumePts,
      advocate: advocate?.name ?? null,
      consensus,
      joiners: joinLog,
      market: { pts: marketPts, ...mkt },
      lean: { pts: leanPts, side: leanSide },
      sport_bonus: sportBonus,
      fade_in: fadeIn,
      conflict_offset: offset,
      totals_gate_ok: totalsGateOk,
      gold: total >= 100 && totalsGateOk,
      silver: total >= 75 && total < 100,
      scale: 'v3-100',
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
  if (db.getSetting('scoring_version', 'v2') === 'v3') {
    try { applyLeak(pickId, scored.total); } catch (_) {}
  }
  return scored;
}

// ── Leak rule (Jack): >25-point jumps never display at once ───────────────────
// True score updates instantly (internal); the DISPLAY score ramps to it over a
// randomized 20-50 minute window that always finishes before game start. Only
// engaged when scoring_version === 'v3'.
function applyLeak(pickId, trueTotal) {
  const p = db.prepare(`SELECT id, espn_game_id, display_score, leak_target, leak_started_at, leak_window_sec FROM picks WHERE id = ?`).get(pickId);
  if (!p) return;
  const now = Date.now();
  const current = effectiveDisplayScore(p, now);
  if (trueTotal <= current + LEAK_STEP) {
    // Small step: show immediately, clear any running leak
    db.prepare(`UPDATE picks SET display_score = ?, leak_target = NULL, leak_started_at = NULL, leak_window_sec = NULL WHERE id = ?`)
      .run(trueTotal, pickId);
    return;
  }
  // Big jump: start (or retarget) a ramp from current + LEAK_STEP
  let windowSec = Math.round((LEAK_MIN_MIN + Math.random() * (LEAK_MAX_MIN - LEAK_MIN_MIN)) * 60);
  const game = p.espn_game_id ? db.prepare(`SELECT start_time FROM today_games WHERE espn_game_id = ?`).get(p.espn_game_id) : null;
  if (game?.start_time) {
    const iso = game.start_time.includes('T') ? game.start_time : game.start_time.replace(' ', 'T') + 'Z';
    const startMs = new Date(iso).getTime();
    const untilStart = Math.floor((startMs - now) / 1000) - 180; // finish 3 min early
    if (Number.isFinite(untilStart)) {
      if (untilStart <= 60) {
        // Game imminent: full value must be visible by start
        db.prepare(`UPDATE picks SET display_score = ?, leak_target = NULL, leak_started_at = NULL, leak_window_sec = NULL WHERE id = ?`)
          .run(trueTotal, pickId);
        return;
      }
      windowSec = Math.min(windowSec, untilStart);
    }
  }
  db.prepare(`
    UPDATE picks SET display_score = ?, leak_target = ?, leak_started_at = datetime('now'), leak_window_sec = ? WHERE id = ?
  `).run(Math.min(trueTotal, current + LEAK_STEP), trueTotal, windowSec, pickId);
}

// Read-side: the score any public surface should show right now.
function effectiveDisplayScore(pickRow, nowMs = Date.now()) {
  const base = pickRow.display_score ?? pickRow.score ?? 0;
  if (pickRow.leak_target == null || !pickRow.leak_started_at || !pickRow.leak_window_sec) return base;
  const startedMs = new Date(pickRow.leak_started_at.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(startedMs)) return base;
  const frac = Math.max(0, Math.min(1, (nowMs - startedMs) / (pickRow.leak_window_sec * 1000)));
  return Math.round(base + (pickRow.leak_target - base) * frac);
}

module.exports = { computeV3, computeAndLogV3, applyLeak, effectiveDisplayScore };

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
