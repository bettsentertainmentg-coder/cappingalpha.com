// src/user_bets.js — personal bet tracking (Phase B).
//
// The MANUAL counterpart to game_votes. Bets here are personal-tracking only and
// are excluded from ranked leaderboards by construction (leaderboard.js reads
// game_votes, never this table). A bet can be game-linked (espn_game_id set -> the
// cron auto-grades it with the exact same evaluateVote logic as votes) or purely
// manual (no game id -> the user self-settles via POST /api/bets/:id/settle).

const db = require('./db');
const { settledProfit } = require('./odds_math');
const { evaluateVote, fetchGameResult } = require('./results');

const BET_TYPES = new Set(['ml', 'spread', 'over', 'under', 'prop', 'parlay', 'future']);
const GRADABLE  = new Set(['ml', 'spread', 'over', 'under']);

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

function getUnitSize(userId) {
  const r = db.prepare(`SELECT unit_size FROM user_preferences WHERE user_id = ?`).get(userId);
  return r && r.unit_size != null ? r.unit_size : 20;
}

function getBet(userId, id) {
  return db.prepare(`SELECT * FROM user_bets WHERE id = ? AND user_id = ?`).get(id, userId);
}

// ml/spread map to a vote slot via side; over/under are their own slot.
function betToSlot(bet) {
  if (bet.bet_type === 'over')   return 'over';
  if (bet.bet_type === 'under')  return 'under';
  if (bet.bet_type === 'ml')     return bet.side === 'home' ? 'home_ml'     : bet.side === 'away' ? 'away_ml'     : null;
  if (bet.bet_type === 'spread') return bet.side === 'home' ? 'home_spread' : bet.side === 'away' ? 'away_spread' : null;
  return null; // prop/parlay/future — not auto-gradable
}

// ── Create ────────────────────────────────────────────────────────────────────
function createBet(userId, body = {}) {
  const bet_type = String(body.bet_type || '').toLowerCase();
  if (!BET_TYPES.has(bet_type)) throw httpErr(400, 'Invalid bet type.');

  const selection = String(body.selection || '').trim();
  if (!selection) throw httpErr(400, 'A selection is required.');

  const odds = Number(body.odds);
  if (!Number.isFinite(odds) || odds === 0) throw httpErr(400, 'Enter valid American odds (e.g. -110 or +145).');

  let stake = Number(body.stake);
  if (!Number.isFinite(stake) || stake < 0) stake = 0;

  let side = body.side ? String(body.side).toLowerCase() : null;
  if (bet_type === 'over')  side = 'over';
  if (bet_type === 'under') side = 'under';
  if ((bet_type === 'ml' || bet_type === 'spread') && side !== 'home' && side !== 'away') side = null;

  let line = (body.line === '' || body.line == null) ? null : Number(body.line);
  if (!Number.isFinite(line)) line = null;

  let sport = body.sport ? String(body.sport).toUpperCase() : null;
  let espn_game_id = body.espn_game_id ? String(body.espn_game_id) : null;
  let home_team = null, away_team = null, game_date = body.game_date || null;

  // Game-linked: snapshot teams/sport/date from today_games; fill a missing line
  // from the game's slot line so auto-grading has what it needs.
  if (espn_game_id) {
    const g = db.prepare(`
      SELECT sport, home_team, away_team, start_time, spread_home, spread_away, over_under
      FROM today_games WHERE espn_game_id = ?
    `).get(espn_game_id);
    if (g) {
      home_team = g.home_team; away_team = g.away_team;
      if (!sport) sport = (g.sport || '').toUpperCase();
      if (!game_date && g.start_time) game_date = String(g.start_time).slice(0, 10);
      if (line == null) {
        if (bet_type === 'spread') line = side === 'home' ? g.spread_home : g.spread_away;
        else if (bet_type === 'over' || bet_type === 'under') line = g.over_under;
      }
    } else {
      espn_game_id = null; // unknown game id -> treat as a pure manual bet
    }
  }

  const unit  = getUnitSize(userId) || 20;
  const units = unit > 0 ? +(stake / unit).toFixed(4) : null;

  // Trust is server-assigned, never client-supplied. Manual entry is always
  // unverified / personal-only.
  const source = 'manual', verified = 0;

  // Optional initial result (logging an already-settled bet) — settle atomically on
  // create for non-game-linked bets, so there's no fire-and-forget settle race.
  const r0 = String(body.result || '').toLowerCase();
  const initResult = (!espn_game_id && ['win', 'loss', 'push', 'void'].includes(r0)) ? r0 : 'pending';
  const initPayout  = initResult !== 'pending' ? settledProfit(initResult, odds, stake) : null;
  const initSettled = initResult !== 'pending' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;

  const info = db.prepare(`
    INSERT INTO user_bets
      (user_id, bet_type, sport, selection, side, line, odds, stake, units,
       espn_game_id, game_date, result, payout, settled_at, verified, source, home_team, away_team, book, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, bet_type, sport, selection, side, line, odds, stake, units,
    espn_game_id, game_date, initResult, initPayout, initSettled, verified, source, home_team, away_team,
    body.book  ? String(body.book).slice(0, 40)   : null,
    body.notes ? String(body.notes).slice(0, 500) : null,
  );
  return getBet(userId, info.lastInsertRowid);
}

// ── List ──────────────────────────────────────────────────────────────────────
function listBets(userId, { status = 'all', sport, limit = 200, offset = 0 } = {}) {
  const where = ['user_id = ?']; const args = [userId];
  if (status === 'pending')      where.push(`result = 'pending'`);
  else if (status === 'settled') where.push(`result != 'pending'`);
  if (sport) { where.push('sport = ?'); args.push(String(sport).toUpperCase()); }
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM user_bets WHERE ${w}`).get(...args).n;
  const lim = Math.min(500, Math.max(1, parseInt(limit) || 200));
  const off = Math.max(0, parseInt(offset) || 0);
  const bets = db.prepare(`SELECT * FROM user_bets WHERE ${w} ORDER BY placed_at DESC LIMIT ? OFFSET ?`).all(...args, lim, off);
  return { bets, total };
}

// ── Update (pending only) ─────────────────────────────────────────────────────
function updateBet(userId, id, partial = {}) {
  const bet = getBet(userId, id);
  if (!bet) throw httpErr(404, 'Bet not found.');
  if (bet.result !== 'pending') throw httpErr(409, 'Only pending bets can be edited.');

  const fields = {};
  if (partial.odds !== undefined)      { const o = Number(partial.odds);  if (Number.isFinite(o) && o !== 0) fields.odds = o; }
  if (partial.stake !== undefined)     { const s = Number(partial.stake); if (Number.isFinite(s) && s >= 0)  fields.stake = s; }
  if (partial.line !== undefined)      { const l = Number(partial.line);  fields.line = Number.isFinite(l) ? l : null; }
  if (partial.selection !== undefined) fields.selection = String(partial.selection).trim() || bet.selection;
  if (partial.book !== undefined)      fields.book  = partial.book  ? String(partial.book).slice(0, 40)   : null;
  if (partial.notes !== undefined)     fields.notes = partial.notes ? String(partial.notes).slice(0, 500) : null;
  if (fields.stake !== undefined)      { const unit = getUnitSize(userId) || 20; fields.units = unit > 0 ? +(fields.stake / unit).toFixed(4) : null; }

  const keys = Object.keys(fields);
  if (keys.length) {
    db.prepare(`UPDATE user_bets SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...keys.map(k => fields[k]), id, userId);
  }
  return getBet(userId, id);
}

// ── Delete ────────────────────────────────────────────────────────────────────
function deleteBet(userId, id) {
  const info = db.prepare(`DELETE FROM user_bets WHERE id = ? AND user_id = ?`).run(id, userId);
  if (info.changes === 0) throw httpErr(404, 'Bet not found.');
  return { ok: true };
}

// ── Settle (manual bets only) ─────────────────────────────────────────────────
function settleBet(userId, id, result) {
  const bet = getBet(userId, id);
  if (!bet) throw httpErr(404, 'Bet not found.');
  if (bet.espn_game_id) throw httpErr(409, 'Game-linked bets are graded automatically.');
  const r = String(result || '').toLowerCase();
  if (!['win', 'loss', 'push', 'void'].includes(r)) throw httpErr(400, 'Invalid result.');
  const payout = settledProfit(r, bet.odds, bet.stake);
  db.prepare(`UPDATE user_bets SET result = ?, payout = ?, settled_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(r, payout, id, userId);
  return getBet(userId, id);
}

// Snapshot the latest available odds/line as the CLV "closing" reference while the
// game is still fresh in today_games (line_history gets wiped at 4:58am).
function closingForSlot(slot, row) {
  if (slot === 'home_ml')     return { odds: row.ml_home ?? null,       line: null };
  if (slot === 'away_ml')     return { odds: row.ml_away ?? null,       line: null };
  if (slot === 'home_spread') return { odds: -110,                      line: row.spread_home ?? null };
  if (slot === 'away_spread') return { odds: -110,                      line: row.spread_away ?? null };
  if (slot === 'over')        return { odds: row.ou_over_odds ?? null,  line: row.over_under ?? null };
  if (slot === 'under')       return { odds: row.ou_under_odds ?? null, line: row.over_under ?? null };
  return { odds: null, line: null };
}

// ── Auto-grade game-linked pending bets (called in the 5-min results cron) ─────
async function gradePendingBets() {
  let graded = 0;

  // Pass A: game still in today_games (same cycle, pre-wipe).
  const liveBets = db.prepare(`
    SELECT b.*, tg.status AS g_status, tg.home_score AS g_hs, tg.away_score AS g_as,
           tg.sport AS g_sport, tg.tennis_home_games, tg.tennis_away_games,
           tg.spread_home, tg.spread_away, tg.over_under,
           tg.ml_home, tg.ml_away, tg.ou_over_odds, tg.ou_under_odds
    FROM user_bets b
    JOIN today_games tg ON tg.espn_game_id = b.espn_game_id
    WHERE b.result = 'pending' AND b.espn_game_id IS NOT NULL
      AND b.bet_type IN ('ml','spread','over','under') AND tg.status = 'post'
  `).all();

  for (const b of liveBets) {
    const slot = betToSlot(b);
    if (!slot) continue;
    const game = {
      status: b.g_status, sport: b.g_sport || b.sport, home_score: b.g_hs, away_score: b.g_as,
      tennis_home_games: b.tennis_home_games, tennis_away_games: b.tennis_away_games,
    };
    const result = evaluateVote(slot, b.line, game);
    if (result === 'pending') continue;
    const payout  = settledProfit(result, b.odds, b.stake);
    const closing = closingForSlot(slot, b);
    db.prepare(`
      UPDATE user_bets SET result = ?, payout = ?, settled_at = datetime('now'),
        closing_odds = COALESCE(?, closing_odds), closing_line = COALESCE(?, closing_line)
      WHERE id = ? AND result = 'pending'
    `).run(result, payout, closing.odds, closing.line, b.id);
    graded++;
  }

  // Pass B: game wiped from today_games -> fetch final from ESPN.
  const staleBets = db.prepare(`
    SELECT b.* FROM user_bets b
    LEFT JOIN today_games tg ON tg.espn_game_id = b.espn_game_id
    WHERE b.result = 'pending' AND b.espn_game_id IS NOT NULL
      AND b.bet_type IN ('ml','spread','over','under') AND tg.espn_game_id IS NULL
  `).all();

  const cache = new Map();
  for (const b of staleBets) {
    if (!b.sport) continue;
    const slot = betToSlot(b);
    if (!slot) continue;
    let game;
    if (cache.has(b.espn_game_id)) game = cache.get(b.espn_game_id);
    else {
      const gd = (b.game_date || b.placed_at || '').slice(0, 10) || null;
      game = await fetchGameResult(b.espn_game_id, b.sport, gd);
      cache.set(b.espn_game_id, game);
    }
    if (!game) continue;
    const result = evaluateVote(slot, b.line, game);
    if (result === 'pending') continue;
    const payout = settledProfit(result, b.odds, b.stake);
    db.prepare(`UPDATE user_bets SET result = ?, payout = ?, settled_at = datetime('now') WHERE id = ? AND result = 'pending'`)
      .run(result, payout, b.id);
    graded++;
  }

  if (graded > 0) console.log(`[user_bets] graded ${graded} bet(s)`);
  return graded;
}

// ── Summary (feeds the "My Action" profile) ───────────────────────────────────
function betSummary(userId, window = 'all') {
  const clause = window === 'week'  ? `AND placed_at >= datetime('now','-7 days')`
               : window === 'month' ? `AND placed_at >= datetime('now','-30 days')` : '';
  const bets  = db.prepare(`SELECT * FROM user_bets WHERE user_id = ? ${clause}`).all(userId);
  const prefs = db.prepare(`SELECT unit_size, starting_bankroll FROM user_preferences WHERE user_id = ?`).get(userId) || {};
  const unit_size         = prefs.unit_size != null ? prefs.unit_size : 20;
  const starting_bankroll = prefs.starting_bankroll != null ? prefs.starting_bankroll : 0;

  let wins = 0, losses = 0, pushes = 0, pending = 0, profit = 0, staked = 0, units = 0, verifiedUnits = 0;
  let clvGood = 0, clvBad = 0, clvSum = 0, clvN = 0;
  const bySportMap = new Map(), byTypeMap = new Map(), settled = [];
  const impl = o => (o < 0 ? (-o) / (-o + 100) : 100 / (o + 100));

  for (const b of bets) {
    const r = (b.result || '').toLowerCase();
    if (r === 'win') wins++; else if (r === 'loss') losses++; else if (r === 'push') pushes++; else if (r === 'pending') pending++;
    if (r === 'win' || r === 'loss') staked += b.stake;
    const p = b.payout != null ? b.payout : settledProfit(r, b.odds, b.stake);
    const u = unit_size > 0 ? p / unit_size : 0;
    if (r !== 'pending') {
      profit += p; units += u; settled.push(b);
      if (b.verified) verifiedUnits += u;
      const sp = b.sport || 'Other';
      const sm = bySportMap.get(sp) || { sport: sp, units: 0, profit: 0, wins: 0, losses: 0 };
      sm.units += u; sm.profit += p; if (r === 'win') sm.wins++; if (r === 'loss') sm.losses++;
      bySportMap.set(sp, sm);
      const bt = b.bet_type || 'other';
      const tm = byTypeMap.get(bt) || { bet_type: bt, units: 0, profit: 0, wins: 0, losses: 0 };
      tm.units += u; tm.profit += p; if (r === 'win') tm.wins++; if (r === 'loss') tm.losses++;
      byTypeMap.set(bt, tm);
    }
    if (b.closing_odds != null && b.odds != null && ['ml', 'over', 'under'].includes(b.bet_type)) {
      const d = impl(b.closing_odds) - impl(b.odds);
      clvSum += d; clvN++;
      if (d > 0) clvGood++; else if (d < 0) clvBad++;
    }
  }
  const decided = wins + losses;

  settled.sort((a, b) => String(a.settled_at).localeCompare(String(b.settled_at)));
  let run = starting_bankroll;
  const bankrollSeries = [{ t: null, bankroll: +starting_bankroll.toFixed(2) }];
  for (const b of settled) { run += (b.payout || 0); bankrollSeries.push({ t: b.settled_at, bankroll: +run.toFixed(2) }); }

  return {
    window, unit_size, starting_bankroll,
    totals: {
      record: { wins, losses, pushes, pending },
      units: +units.toFixed(2), profit: +profit.toFixed(2),
      roi: staked > 0 ? +(100 * profit / staked).toFixed(1) : null,
      win_pct: decided > 0 ? +(100 * wins / decided).toFixed(1) : null,
      clv: { good: clvGood, bad: clvBad, avg_cents: clvN ? +(100 * clvSum / clvN).toFixed(1) : null },
    },
    bySport:   [...bySportMap.values()].map(s => ({ ...s, units: +s.units.toFixed(2), profit: +s.profit.toFixed(2) })).sort((a, b) => b.units - a.units),
    byBetType: [...byTypeMap.values()].map(s => ({ ...s, units: +s.units.toFixed(2), profit: +s.profit.toFixed(2) })).sort((a, b) => b.units - a.units),
    bankrollSeries,
    verifiedUnits: +verifiedUnits.toFixed(2),
  };
}

module.exports = { createBet, listBets, updateBet, deleteBet, settleBet, gradePendingBets, betSummary, getBet };
