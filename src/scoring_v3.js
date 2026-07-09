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
// The leak rule (chunked display reveal) is unchanged and only ENGAGES when
// scoring_version === 'v3'.

const db = require('./db');
const ratingsLib = require('./capper_ratings');

const UNRANKED_PTS = ratingsLib.UNRANKED_PTS; // no trackable capper / zero decisions
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

// One backer's ladder standing from the materialized ratings. Fade cappers
// contribute 0 (their negativity routes to the opposite slot instead). A capper
// with no row or no decisions is 'unranked': worth the flat UNRANKED_PTS as the
// best backer, nothing as a joiner.
function backerLadder(name) {
  const o = overallRow(name);
  if (!o || o.band === 'entity') return { name, pts: UNRANKED_PTS, stackAdd: 0, band: 'untracked', rank: null, pctile: null, fade: null };
  if (o.fade) return { name, pts: 0, stackAdd: 0, band: o.band, rank: o.wilson_rank, pctile: o.percentile, fade: o.fade };
  return {
    name,
    pts: o.pts != null ? o.pts : UNRANKED_PTS,
    stackAdd: o.stack_add ?? 0,
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
    const raw = Math.max(3, Math.min(8, Math.round(-100 * worst)));
    const sportN = s?.picks ?? 0;
    const scaled = Math.round(raw * (sportN / (sportN + 10)));
    if (scaled < 2) continue; // not enough sport evidence to act on
    pts += scaled; from.push({ capper: name, pts: scaled, sport_picks: sportN });
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

  // Every distinct backer through the Wilson ladder, best first. Source
  // entities never advocate — an anonymous pick (no attributed capper at all)
  // is worth the flat UNRANKED_PTS, exactly like an untracked name.
  const backers = cappers.map(backerLadder).sort((a, b) => b.pts - a.pts);
  const best = backers[0] ?? null;
  const advocate = best ? { name: best.name, pts: best.pts } : { name: null, pts: UNRANKED_PTS };
  const resumePts = advocate.pts;

  // Stack: each ADDITIONAL ranked backer adds half their own band's peak
  // (volume-capped, precomputed as capper_ratings.stack_add). Unranked and
  // fade backers add nothing — agreement has to come from someone with a rank.
  let consensus = 0;
  const joinLog = [];
  for (const b of backers.slice(1)) {
    if (b.stackAdd > 0) {
      consensus += b.stackAdd;
      joinLog.push({ name: b.name, pts: b.pts, applied: b.stackAdd });
    }
  }
  consensus = Math.round(consensus);

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

  const sportBonus = SPORT_BONUS_SPORTS.has(sportU) ? SPORT_BONUS : 0;

  // Fade points INTO this slot (opposite side fade-active activity) + conflict
  // offset: if THIS slot has a fade-active mention (it generated fade onto the
  // opposite) AND a positive-resume capper is also here, this side gets
  // min(generated fade, that capper's join points) back. Nothing ever subtracts.
  const fadeIn = fadePointsInto(pick, sport);
  let offset = 0;
  const ownFadeActive = backers.some(b => b.fade === 'active');
  if (ownFadeActive) {
    const proven = backers.find(b => !b.fade && b.stackAdd > 0);
    if (proven) {
      // what this slot's fade-active capper sent to the opposite side
      const opp = oppositeSlot(pick);
      const sentPts = opp ? fadePointsInto(opp, sport).pts : 0;
      offset = Math.round(Math.min(sentPts, proven.stackAdd));
    }
  }

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
    try { applyLeak(pickId, scored.total); } catch (_) {}
  }
  return scored;
}

// ── Leak rule (Jack): >25-point jumps never display at once ───────────────────
// True score updates instantly (internal); the DISPLAY score reveals the gap in
// RANDOM CHUNKS at random times (Jack 2026-07-08: "show 25, then 5, then 10"),
// not a smooth line. Window scales with urgency: >3h to start = leisurely 5-30
// min, 1-3h = very fast (90s-5min), <1h = instant — members always get a real
// window to act on the pick. Only engaged when scoring_version === 'v3'.
const LEAK_URGENT_MIN = 60;    // <1h to start: reveal instantly
const LEAK_FAST_MIN   = 180;   // 1-3h: fast window
const LEAK_FAST_SEC   = [90, 300];
const LEAK_SLOW_SEC   = [300, 1800]; // >3h: 5-30 min

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
  // Big jump: start (or retarget) a chunked reveal from current + LEAK_STEP.
  // Window by time-to-start (finish 3 min early in every case).
  let lo = LEAK_SLOW_SEC[0], hi = LEAK_SLOW_SEC[1];
  const game = p.espn_game_id ? db.prepare(`SELECT start_time FROM today_games WHERE espn_game_id = ?`).get(p.espn_game_id) : null;
  if (game?.start_time) {
    const iso = game.start_time.includes('T') ? game.start_time : game.start_time.replace(' ', 'T') + 'Z';
    const startMs = new Date(iso).getTime();
    const untilStartSec = Math.floor((startMs - now) / 1000) - 180;
    if (Number.isFinite(untilStartSec)) {
      if (untilStartSec <= LEAK_URGENT_MIN * 60) {
        // Inside an hour: full value must be visible NOW — the pick window is short
        db.prepare(`UPDATE picks SET display_score = ?, leak_target = NULL, leak_started_at = NULL, leak_window_sec = NULL WHERE id = ?`)
          .run(trueTotal, pickId);
        return;
      }
      if (untilStartSec <= LEAK_FAST_MIN * 60) { lo = LEAK_FAST_SEC[0]; hi = LEAK_FAST_SEC[1]; }
      hi = Math.min(hi, untilStartSec);
      lo = Math.min(lo, hi);
    }
  }
  const windowSec = Math.round(lo + Math.random() * (hi - lo));
  db.prepare(`
    UPDATE picks SET display_score = ?, leak_target = ?, leak_started_at = datetime('now'), leak_window_sec = ? WHERE id = ?
  `).run(Math.min(trueTotal, current + LEAK_STEP), trueTotal, windowSec, pickId);
}

// ── The chunk schedule: ONE deterministic reveal path per ramp ────────────────
// Seeded by (pick id, ramp start), so every request — the picks list, the game
// popup, the conviction curve — replays the identical steps without storing a
// schedule. Chunks are random sizes (each <= LEAK_STEP) at random times inside
// the window, monotone, and always finish the full gap by the window end.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns [{frac, cum}] — at window fraction >= frac, cumulative revealed points
// (above the ramp's shown base) are cum. Last entry always covers the full gap.
function leakSchedule(pickRow) {
  const gap = (pickRow.leak_target ?? 0) - (pickRow.display_score ?? 0);
  if (gap <= 0) return [];
  const startedMs = new Date(String(pickRow.leak_started_at || '').replace(' ', 'T') + 'Z').getTime();
  const seed = ((pickRow.id * 2654435761) ^ (Number.isFinite(startedMs) ? Math.floor(startedMs / 1000) : 0)) >>> 0;
  const rnd = mulberry32(seed);
  const k = Math.max(2, Math.min(5, Math.ceil(gap / 15)));
  // Sizes: jittered shares, each capped at LEAK_STEP
  let sizes = Array.from({ length: k }, () => 0.6 + rnd() * 0.9);
  const sum = sizes.reduce((a, b) => a + b, 0);
  sizes = sizes.map(s => Math.min(LEAK_STEP, Math.round((s / sum) * gap)));
  // Times: stratified jitter — one chunk per window slice so reveals SPREAD
  // across the ramp instead of bunching, still random within each slice.
  const fracs = Array.from({ length: k }, (_, i) => {
    const span = 0.86 / k;
    return 0.10 + span * i + rnd() * span;
  });
  fracs[k - 1] = Math.max(fracs[k - 1], 0.80 + rnd() * 0.18);
  fracs.sort((a, b) => a - b);
  const out = [];
  let cum = 0;
  for (let i = 0; i < k; i++) { cum += sizes[i]; out.push({ frac: Math.min(1, fracs[i]), cum }); }
  out[k - 1].cum = gap; // rounding guard: the last chunk always completes the gap
  return out;
}

// Read-side: the score any public surface should show right now.
function effectiveDisplayScore(pickRow, nowMs = Date.now()) {
  const base = pickRow.display_score ?? pickRow.score ?? 0;
  if (pickRow.leak_target == null || !pickRow.leak_started_at || !pickRow.leak_window_sec) return base;
  const startedMs = new Date(pickRow.leak_started_at.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(startedMs)) return base;
  const frac = Math.max(0, Math.min(1, (nowMs - startedMs) / (pickRow.leak_window_sec * 1000)));
  if (frac >= 1) return Math.round(pickRow.leak_target);
  let revealed = 0;
  for (const step of leakSchedule(pickRow)) { if (frac >= step.frac) revealed = step.cum; }
  return Math.round(base + revealed);
}

// The single, canonical "score to show right now" for a pick under v3. EVERY
// public surface (the picks list, the game-detail popup, the standalone detail
// page, the conviction curve) must run its rows through THIS so they all agree.
// A pick mid-leak-ramp uses the interpolated display; otherwise the settled
// display_score, falling back to the logged v3_total, then the raw column. The
// true v3 total is never returned here unless the leak has finished. Expects a
// row carrying display_score/leak_* (from picks) and v3_total (join to
// score_breakdown); tolerates any missing.
function v3DisplayScore(p) {
  return p.leak_target != null
    ? effectiveDisplayScore(p)
    : Math.round(p.display_score ?? p.v3_total ?? p.score ?? 0);
}

module.exports = { computeV3, computeAndLogV3, applyLeak, effectiveDisplayScore, v3DisplayScore, leakSchedule };

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
