// src/ledger_sanity.js
// THE FULL-GAME MARKET GATE for source picks + the ledger restatement that
// voids what slipped through before it existed (Jack, 2026-09-15).
//
// WHY (the Felix317 profile): a BettingPros bettor showed 6-3 / +29.2u on NFL
// overs whose picks read "over 5 +800", "over 1 +550", "over 40". None of them
// was a game total. BettingPros serves game props, quarter/inning markets, team
// totals and drive-result bets under the SAME line.type values ("over",
// "spread", "moneyline") as the full-game markets, and the ingest only refused
// player props and parlays. Action Network's F5 totals (period != 'game') and
// team totals (competitor_id set), Polymarket's tennis SET markets ("Total Sets
// O/U 2.5", "Set Handicap -1.5"), and Covers' pre-September cross-sport matches
// (an NCAAF -31.5 filed under MLB) all landed in capper_history the same way:
// as full-game bets, graded against a full-game final. 7,950 flagged rows
// across 926 cappers in the 2026-09-15 export.
//
// Every one of those rows fed capper_ratings, the Wilson ladder that prices
// every pick on the board. So this is not a display bug.
//
// THE RULE: a pick joins the ledger only if its number is one this sport's
// full-game market could carry (absolute band), agrees with the game's own
// market when we hold one (tolerance per sport), and its price is one that
// market could quote. Anything else is refused and logged to source_skips. A
// dropped pick costs one data point; a wrong one poisons a rating pool.
//
// Pure helpers up top (no db) so audit.js can share the bands; the restatement
// at the bottom is the only thing that writes.

// ── Absolute bands: what a FULL-GAME line can be, per sport ─────────────────
// Deliberately generous at the edges (Coors totals, FAMU @ Miami -56.5) but
// tight enough that a team total, a period total, or another sport's number
// can never pass. Tennis totals are GAMES (best-of-5 runs long).
const TOTAL_BAND = {
  MLB: [5.5, 16], NHL: [4.5, 9], NBA: [180, 280], WNBA: [130, 200],
  CBB: [100, 190], WCBB: [90, 180], NFL: [30, 68], NCAAF: [28, 95],
  SOCCER: [1, 6], ATP: [15, 60], WTA: [15, 50], TENNIS: [15, 60],
};
const SPREAD_MAX = {
  MLB: 2.5, NHL: 2.5, NBA: 25, WNBA: 25, CBB: 38, WCBB: 38, NFL: 24,
  NCAAF: 65, SOCCER: 3.5, ATP: 9.5, WTA: 9.5, TENNIS: 9.5,
};
// How far a pick's number may sit from the game's market before it is a
// different market (alt line, team total, period line). Football lines move
// all week; a run line does not.
const TOTAL_TOL  = { MLB: 2, NHL: 1.5, NBA: 7, WNBA: 7, CBB: 7, WCBB: 7, NFL: 5, NCAAF: 7, SOCCER: 1.5, ATP: 5, WTA: 5, TENNIS: 5 };
const SPREAD_TOL = { MLB: 1.5, NHL: 1.5, NBA: 5, WNBA: 5, CBB: 6, WCBB: 6, NFL: 4.5, NCAAF: 7, SOCCER: 1.5, ATP: 3.5, WTA: 3.5, TENNIS: 3.5 };

// Prices. A spread or total is juice, not a payout: past +-300 it is an alt
// line or a typo. A moneyline can be long, but nothing a book quotes pregame is
// past +-2500 and nothing under +-100 is American odds at all.
const SIDE_PRICE_MAX = 300;
const SIDE_PRICE_IMPOSSIBLE = 1000;   // restatement bar for rows already graded
const ML_PRICE_MAX = 2500;
// Jack, 2026-09-15: "if someone's placing a bet like -2000, ignore it." A
// pregame moneyline at that price is not a read on the game; it is a free
// win in a win-rate ladder (407 Polymarket rows at -2400 and beyond). Set at
// -1000 on 2026-09-16: BettingPros shows college favorites at -1900, -1567 and
// -1329 (the sjoe36758 profile, 19-1 on them), the same free wins one notch
// under the first cut.
const HEAVY_ML_REFUSE = 1000;
const ML_IMPLIED_TOL = 0.10;          // recorded vs market, in implied probability

function sportKey(sport) {
  const s = String(sport || '').toUpperCase().trim();
  return s === 'SOCCER' ? 'SOCCER' : s;
}
const isTotalType = (pt) => pt === 'over' || pt === 'under';

function implied(o) {
  const n = Number(o);
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? Math.abs(n) / (Math.abs(n) + 100) : 100 / (n + 100);
}

// The game's own number for this market, or null when the board has none yet.
function marketLine(game, pt, side) {
  if (!game) return null;
  if (isTotalType(pt)) return game.over_under != null ? Number(game.over_under) : null;
  if (pt === 'spread') {
    const v = side === 'home' ? game.spread_home : side === 'away' ? game.spread_away : null;
    return v != null ? Number(v) : null;
  }
  return null;
}
function marketPrice(game, pt, side) {
  if (!game) return null;
  let v = null;
  if (pt === 'ml') v = side === 'home' ? game.ml_home : side === 'away' ? game.ml_away : null;
  else if (pt === 'spread') v = side === 'home' ? game.spread_home_odds : side === 'away' ? game.spread_away_odds : null;
  else if (pt === 'over') v = game.ou_over_odds;
  else if (pt === 'under') v = game.ou_under_odds;
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) && n !== 0 ? n : null;
}

// Band-only verdict on a stored row (no market context). Shared by audit R14
// and the restatement. Returns a reason string or null.
function implausibleLedgerRow(row) {
  const sp = sportKey(row.sport);
  const pt = String(row.pick_type || '').toLowerCase();
  const line = row.spread != null ? Number(row.spread) : null;
  const odds = row.odds != null ? Number(row.odds) : null;
  if (isTotalType(pt)) {
    if (line == null || !Number.isFinite(line)) return 'total_no_line';
    const b = TOTAL_BAND[sp];
    if (b && line < b[0]) return 'total_below_band';   // team total / period / prop
    if (b && line > b[1]) return 'total_above_band';   // another sport's number
    if (odds != null && Math.abs(odds) >= SIDE_PRICE_IMPOSSIBLE) return 'side_price_impossible';
    return null;
  }
  if (pt === 'spread') {
    if (line == null || !Number.isFinite(line)) return 'spread_no_line';
    const max = SPREAD_MAX[sp];
    if (max != null && Math.abs(line) > max) return 'spread_out_of_band';
    if (odds != null && Math.abs(odds) >= SIDE_PRICE_IMPOSSIBLE) return 'side_price_impossible';
    return null;
  }
  if (pt === 'ml') {
    // A moneyline with no price used to be graded at the -110 default, so a
    // -2000 favorite's win paid +0.91 units (sjoe36758: six unpriced college
    // favorites). No price, no grade.
    if (odds == null || odds === 0) return 'ml_no_price';
    if (odds <= -HEAVY_ML_REFUSE) return 'heavy_price';
    return null;
  }
  return null;
}

// Provenance-only verdict: the source told us what market this was and it was
// never a full-game one. Polymarket keeps the market question in meta.
const OTHER_MARKET_Q = /(total sets|set handicap|sets? o\/u|games? handicap|1st set|first set|team spoon|team coop|all[- ]star)/i;
function otherMarketFromProvenance(row) {
  if (!row.sources_json) return null;
  let arr;
  try { arr = JSON.parse(row.sources_json); } catch (_) { return null; }
  if (!Array.isArray(arr)) return null;
  for (const s of arr) {
    const q = s && s.meta && (s.meta.question || s.meta.market || s.meta.sub_label);
    if (q && OTHER_MARKET_Q.test(String(q))) return 'other_market';
  }
  return null;
}

// ── The ingest gate ─────────────────────────────────────────────────────────
// { game (today_games row or null), sport, pickType, side, line, odds }
// -> { ok, reason, line, odds, notes }
// notes carry what changed (a replaced price) so the caller can log it.
// trustPrice (default true): a plausible moneyline price is the capper's own
// number and stays even when it disagrees with the board (a Polymarket wallet
// really did get +150 on a side the book had at -110). A source whose prices
// are typed in by hand (BettingPros) passes false and a price that disagrees
// with the market by more than ML_IMPLIED_TOL is replaced by the market's.
function checkSourcePick({ game, sport, pickType, side, line, odds, trustPrice = true }) {
  const pt = String(pickType || '').toLowerCase();
  const sp = sportKey((game && game.sport) || sport);
  const notes = [];
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  let L = num(line), O = num(odds);
  if (O === 0) O = null;

  if (isTotalType(pt) || pt === 'spread') {
    if (L == null) return { ok: false, reason: pt === 'spread' ? 'spread_no_line' : 'total_no_line', line: L, odds: O, notes };
    // 1. absolute band
    if (isTotalType(pt)) {
      const b = TOTAL_BAND[sp];
      if (b && L < b[0]) return { ok: false, reason: 'total_below_band', line: L, odds: O, notes };
      if (b && L > b[1]) return { ok: false, reason: 'total_above_band', line: L, odds: O, notes };
    } else {
      const max = SPREAD_MAX[sp];
      if (max != null && Math.abs(L) > max) return { ok: false, reason: 'spread_out_of_band', line: L, odds: O, notes };
    }
    // 2. agreement with the game's own market, when we hold one
    const mkt = marketLine(game, pt, side);
    if (mkt != null) {
      const tol = (isTotalType(pt) ? TOTAL_TOL : SPREAD_TOL)[sp] ?? 5;
      if (Math.abs(L - mkt) > tol) return { ok: false, reason: 'line_off_market', line: L, odds: O, notes, market: mkt };
    }
    // 3. price: juice, or the market's juice, or standard
    if (O != null && (Math.abs(O) < 100 || Math.abs(O) > SIDE_PRICE_MAX)) {
      const mp = marketPrice(game, pt, side);
      notes.push({ price_replaced: { from: O, to: mp } });
      O = mp; // null = standard juice downstream
    }
    return { ok: true, reason: null, line: L, odds: O, notes };
  }

  if (pt === 'ml') {
    const mp = marketPrice(game, pt, side);
    const plausible = O != null && Math.abs(O) >= 100 && Math.abs(O) <= ML_PRICE_MAX;
    if (plausible && mp != null && !trustPrice) {
      const d = Math.abs(implied(O) - implied(mp));
      if (d > ML_IMPLIED_TOL) { notes.push({ price_replaced: { from: O, to: mp } }); O = mp; }
    } else if (!plausible && mp != null) {
      notes.push({ price_replaced: { from: O, to: mp } }); O = mp;
    } else if (!plausible && O != null) {
      return { ok: false, reason: 'ml_price_implausible', line: null, odds: O, notes };
    }
    if (O == null) {
      // No price from the capper or the board. A deep favorite with no posted
      // price is priced like one (storage.impliedHeavyMl, GRADING_RULES R12) and
      // refused just below; anything else cannot be graded for money honestly,
      // so it is not graded at all (never the -110 default).
      const sp = side === 'home' ? (game && game.spread_home) : side === 'away' ? (game && game.spread_away) : null;
      const priced = require('./storage').impliedHeavyMl(null, sp);
      if (priced == null) return { ok: false, reason: 'ml_no_price', line: null, odds: null, notes };
      notes.push({ price_from_spread: { spread: Number(sp), odds: priced } });
      O = priced;
    }
    if (O <= -HEAVY_ML_REFUSE) return { ok: false, reason: 'heavy_price', line: null, odds: O, notes };
    return { ok: true, reason: null, line: null, odds: O, notes };
  }
  return { ok: false, reason: 'unsupported_type', line: L, odds: O, notes };
}

// ── The restatement ─────────────────────────────────────────────────────────
// Walks capper_history and voids every row the gate would have refused on its
// number alone (bands + impossible side prices) or that its own provenance
// says was another market. Graded rows keep their prior result in
// result_before_void, so the pass is reversible per reason. A PENDING row on a
// game that has not started is withdrawn outright (ledger row + its board
// mention), the same path a Polymarket flip already uses: pending pregame rows
// are not public and the ingest would never have minted them now.
// Dry run by default. Idempotent: rows already void are skipped.
// Two modes. Rule mode (default) judges every row by its number and
// provenance. List mode ({ ids, reason }) voids an explicit set under one
// reason slug: the path for rows only the source's own market label can
// expose (a BettingPros "5th Inning Moneyline" carries a perfectly ordinary
// price and no line, so no band can see it; the cross-check that reads their
// market ids per event produces the list).
function sanitizeLedger({ dryRun = true, since = '2026-01-01', until = '2099-12-31', limitChanges = 5000, ids = null, reason: listReason = null } = {}) {
  const db = require('./db');
  const { hasGameStarted } = require('./pick_cutoff');
  const { removeSourceEntry } = require('./source_ingest');
  let rows;
  if (Array.isArray(ids)) {
    if (!listReason) throw new Error('list mode needs a reason slug');
    rows = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      rows.push(...db.prepare(`
        SELECT * FROM capper_history
        WHERE id IN (${chunk.map(() => '?').join(',')}) AND result IN ('win','loss','push','pending')
      `).all(...chunk));
    }
  } else {
    rows = db.prepare(`
      SELECT * FROM capper_history
      WHERE result IN ('win','loss','push','pending')
        AND COALESCE(game_date, substr(saved_at,1,10)) >= ? AND COALESCE(game_date, substr(saved_at,1,10)) <= ?
    `).all(since, until);
  }

  const upd = db.prepare(`UPDATE capper_history SET result_before_void = result, result = 'void', void_reason = ? WHERE id = ?`);
  const gameRow = db.prepare(`SELECT status, start_time, actual_start_at, sport, home_score, away_score FROM today_games WHERE espn_game_id = ?`);
  const setOdds = db.prepare(`UPDATE capper_history SET odds = ?, odds_source = ? WHERE id = ?`);

  const changes = [];
  const bySource = {}, byReason = {}, bySport = {}, byCapper = {};
  const backfill = { closing: 0, closing_spread: 0, board: 0, board_spread: 0 };
  let scanned = 0, withdrawn = 0, voided = 0;
  for (const r of rows) {
    scanned++;
    // An unpriced moneyline gets the closing price for its side first (the
    // median across the archived books, else a deep favorite priced from its
    // spread), and is judged on that. Only one with no price anywhere voids.
    let judged = r;
    if (!Array.isArray(ids) && String(r.pick_type || '').toLowerCase() === 'ml' && (r.odds == null || Number(r.odds) === 0)) {
      const p = archivedMlPrice(db, r);
      if (p) {
        backfill[p.source] = (backfill[p.source] || 0) + 1;
        judged = { ...r, odds: p.odds };
        if (!dryRun) setOdds.run(p.odds, p.source, r.id);
      }
    }
    const reason = Array.isArray(ids) ? listReason : (implausibleLedgerRow(judged) || otherMarketFromProvenance(judged));
    if (!reason) continue;
    let action = 'void';
    if (r.result === 'pending' && r.espn_game_id) {
      const g = gameRow.get(r.espn_game_id);
      if (g && !hasGameStarted(g)) action = 'withdraw';
    }
    const c = { id: r.id, capper: r.capper_name, source: r.source || 'discord', sport: r.sport, pick_type: r.pick_type,
                team: r.team, line: r.spread, odds: r.odds, result: r.result, game_date: r.game_date, reason, action };
    changes.push(c);
    const src = c.source;
    bySource[src] = bySource[src] || { rows: 0, graded: 0 }; bySource[src].rows++;
    if (r.result !== 'pending') bySource[src].graded++;
    byReason[reason] = (byReason[reason] || 0) + 1;
    bySport[r.sport || '?'] = (bySport[r.sport || '?'] || 0) + 1;
    byCapper[r.capper_name] = (byCapper[r.capper_name] || 0) + 1;
    if (dryRun || changes.length > limitChanges) continue;
    if (action === 'withdraw') {
      try {
        const out = removeSourceEntry({ canonical: r.capper_name, espn_game_id: r.espn_game_id, pickType: r.pick_type, team: r.team });
        if (out && out.removed) { withdrawn++; continue; }
      } catch (_) {}
      // withdrawal refused (game started under our feet) — fall through to void
      c.action = 'void';
    }
    upd.run(reason, r.id); voided++;
  }
  return {
    started: new Date().toISOString(), dry_run: dryRun, since, until,
    mode: Array.isArray(ids) ? 'list' : 'rules', ids_requested: Array.isArray(ids) ? ids.length : null, list_reason: listReason,
    rows_scanned: scanned, rows_flagged: changes.length,
    rows_voided: voided, rows_withdrawn: withdrawn,
    ml_prices_backfilled: backfill,
    cappers_affected: Object.keys(byCapper).length,
    by_source: bySource, by_reason: byReason, by_sport: bySport,
    top_cappers: Object.entries(byCapper).sort((a, b) => b[1] - a[1]).slice(0, 25),
    sample: changes.slice(0, 300),
  };
}

// The price a moneyline row should carry when its source gave none: the median
// closing price for its side across every archived book, else a deep favorite
// priced from its closing spread (R12), else the same two reads off today's
// board for a game still on it. null when nothing is known.
function archivedMlPrice(db, r) {
  if (!r.espn_game_id || r.is_home_team == null) return null;
  const home = Number(r.is_home_team) === 1;
  const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
  const { impliedHeavyMl } = require('./storage');
  const read = (rows, tag) => {
    const mls = rows.map(x => Number(home ? x.ml_home : x.ml_away)).filter(v => Number.isFinite(v) && v !== 0 && Math.abs(v) >= 100);
    if (mls.length) return { odds: median(mls), source: tag };
    const sps = rows.map(x => Number(home ? x.spread_home : x.spread_away)).filter(Number.isFinite);
    if (sps.length) { const o = impliedHeavyMl(null, median(sps)); if (o != null) return { odds: o, source: tag + '_spread' }; }
    return null;
  };
  try {
    const closing = db.prepare(`SELECT ml_home, ml_away, spread_home, spread_away FROM book_lines_closing WHERE espn_game_id = ?`).all(r.espn_game_id);
    const a = closing.length ? read(closing, 'closing') : null;
    if (a) return a;
    const board = db.prepare(`SELECT ml_home, ml_away, spread_home, spread_away FROM today_games WHERE espn_game_id = ?`).all(r.espn_game_id);
    return board.length ? read(board, 'board') : null;
  } catch (_) { return null; }
}

// Reverse one reason's voids (or all of them). Rows withdrawn pregame are gone
// for good, which is why withdrawal is limited to rows that were never public.
// reason 'prices' instead clears every backfilled moneyline price.
function restoreLedger({ reason = null } = {}) {
  const db = require('./db');
  if (reason === 'prices') {
    const p = db.prepare(`UPDATE capper_history SET odds = NULL, odds_source = NULL
                          WHERE odds_source IN ('closing','closing_spread','board','board_spread')`).run();
    return { restored: p.changes, reason };
  }
  const r = reason
    ? db.prepare(`UPDATE capper_history SET result = result_before_void, void_reason = NULL, result_before_void = NULL
                  WHERE result = 'void' AND void_reason = ? AND result_before_void IS NOT NULL`).run(reason)
    : db.prepare(`UPDATE capper_history SET result = result_before_void, void_reason = NULL, result_before_void = NULL
                  WHERE result = 'void' AND void_reason IS NOT NULL AND result_before_void IS NOT NULL`).run();
  return { restored: r.changes, reason };
}

module.exports = {
  TOTAL_BAND, SPREAD_MAX, TOTAL_TOL, SPREAD_TOL, SIDE_PRICE_MAX, SIDE_PRICE_IMPOSSIBLE, ML_PRICE_MAX, HEAVY_ML_REFUSE,
  checkSourcePick, implausibleLedgerRow, otherMarketFromProvenance, marketLine, marketPrice,
  sanitizeLedger, restoreLedger, archivedMlPrice,
};

// CLI: node src/ledger_sanity.js [--apply]
if (require.main === module) {
  const report = sanitizeLedger({ dryRun: !process.argv.includes('--apply') });
  const { sample, ...rest } = report;
  console.log(JSON.stringify(rest, null, 2));
  for (const c of sample.slice(0, 40)) console.log(' ', [c.action, c.source, c.capper, c.sport, c.pick_type, c.team, 'line=' + c.line, 'odds=' + c.odds, c.result, c.game_date, c.reason].join(' | '));
}
