// src/user_bets.js — personal bet tracking (Phase B).
//
// The MANUAL counterpart to game_votes. Bets here are personal-tracking only and
// are excluded from ranked leaderboards by construction (leaderboard.js reads
// game_votes, never this table). A bet can be game-linked (espn_game_id set -> the
// cron auto-grades it with the exact same evaluateVote logic as votes) or purely
// manual (no game id -> the user self-settles via POST /api/bets/:id/settle).

const db = require('./db');
const { settledProfit, parlayAmericanOdds } = require('./odds_math');
const { evaluateVote, fetchGameResult } = require('./results');

const BET_TYPES = new Set(['ml', 'spread', 'over', 'under', 'prop', 'parlay', 'future']);

// P/L for a settled bet. A free bet's loss costs nothing (payout 0); a win pays normally.
function betProfit(result, odds, stake, freeBet) {
  if (freeBet && result === 'loss') return 0;
  return settledProfit(result, odds, stake);
}
const GRADABLE  = new Set(['ml', 'spread', 'over', 'under']);

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

function getUnitSize(userId) {
  const r = db.prepare(`SELECT unit_size FROM user_preferences WHERE user_id = ?`).get(userId);
  return r && r.unit_size != null ? r.unit_size : 20;
}

function getBet(userId, id) {
  const bet = db.prepare(`SELECT * FROM user_bets WHERE id = ? AND user_id = ?`).get(id, userId);
  if (bet && bet.bet_type === 'parlay') bet.legs = getLegs(id);
  return bet;
}
function getLegs(betId) {
  return db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ? ORDER BY leg_index, id`).all(betId);
}

// ml/spread map to a vote slot via side; over/under are their own slot.
function betToSlot(bet) {
  if (bet.bet_type === 'over')   return 'over';
  if (bet.bet_type === 'under')  return 'under';
  if (bet.bet_type === 'ml')     return bet.side === 'home' ? 'home_ml'     : bet.side === 'away' ? 'away_ml'     : null;
  if (bet.bet_type === 'spread') return bet.side === 'home' ? 'home_spread' : bet.side === 'away' ? 'away_spread' : null;
  return null; // prop/parlay/future — not auto-gradable
}

// The parent parlay's result from its legs: any decided leg loses => loss; any
// leg still pending => pending; all decided with at least one win => win; all
// push/void => void (stake back). Push/void legs drop out and re-price.
function parlayResultFromLegs(legs) {
  if (!legs.length) return 'pending';
  if (legs.some(l => (l.result || '').toLowerCase() === 'loss')) return 'loss';
  if (legs.some(l => (l.result || 'pending').toLowerCase() === 'pending')) return 'pending';
  return legs.some(l => (l.result || '').toLowerCase() === 'win') ? 'win' : 'void';
}

// ── Create a parlay from legs (Phase 5) ───────────────────────────────────────
function createParlay(userId, body) {
  const rawLegs = Array.isArray(body.legs) ? body.legs : [];
  if (rawLegs.length < 2) throw httpErr(400, 'A parlay needs at least two legs.');
  if (rawLegs.length > 12) throw httpErr(400, 'Too many legs.');

  let stake = Number(body.stake);
  if (!Number.isFinite(stake) || stake < 0) stake = 0;
  const freeBet = body.free_bet ? 1 : 0;

  // Every leg must be auto-gradable, so a parlay can never get stuck pending: a
  // game-linked ml/spread with a real side, or over/under, on a game we know.
  // Props and side-less legs are rejected (the board builder never produces them).
  const legs = [];
  for (const raw of rawLegs) {
    const lt = String(raw.bet_type || '').toLowerCase();
    if (!GRADABLE.has(lt)) throw httpErr(400, 'Each parlay leg must be a moneyline, spread, or total.');
    const legOdds = Number(raw.odds);
    if (!Number.isFinite(legOdds) || legOdds === 0) throw httpErr(400, 'Each leg needs valid odds.');
    // Selection is display-only; strip markup so it can never inject when rendered.
    const sel = String(raw.selection || '').replace(/[<>]/g, '').trim();
    if (!sel) throw httpErr(400, 'Each leg needs a selection.');

    let side = raw.side ? String(raw.side).toLowerCase() : null;
    if (lt === 'over') side = 'over';
    if (lt === 'under') side = 'under';
    if ((lt === 'ml' || lt === 'spread') && side !== 'home' && side !== 'away') {
      throw httpErr(400, 'A moneyline or spread leg needs a side.');
    }

    let line = (raw.line === '' || raw.line == null) ? null : Number(raw.line);
    if (!Number.isFinite(line)) line = null;

    const egid = raw.espn_game_id ? String(raw.espn_game_id) : null;
    if (!egid) throw httpErr(400, 'Each leg must be tied to a game.');
    const g = db.prepare(`SELECT sport, spread_home, spread_away, over_under FROM today_games WHERE espn_game_id = ?`).get(egid);
    if (!g) throw httpErr(400, 'A leg references a game we no longer have.');
    let sport = raw.sport ? String(raw.sport).toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 20) || null : null;
    if (!sport) sport = (g.sport || '').toUpperCase();
    if (line == null) {
      if (lt === 'spread') line = side === 'home' ? g.spread_home : g.spread_away;
      else if (lt === 'over' || lt === 'under') line = g.over_under;
    }
    legs.push({ selection: sel.slice(0, 120), bet_type: lt, side, line, odds: legOdds, sport, espn_game_id: egid });
  }

  // No leg may contradict another on the SAME game. Two sides that can't both win
  // (both moneylines, both spreads, over+under) make the parlay unwinnable; an exact
  // duplicate slot is just noise. Client blocks these, but re-check here since the API
  // is reachable directly.
  const OPPOSITE = {
    home_ml: 'away_ml', away_ml: 'home_ml',
    home_spread: 'away_spread', away_spread: 'home_spread',
    over: 'under', under: 'over',
  };
  const seen = new Set();
  for (const l of legs) {
    const slot = betToSlot(l);
    if (!slot) continue;
    const key = `${l.espn_game_id}|${slot}`;
    if (seen.has(key)) throw httpErr(400, 'That pick is already in the parlay.');
    const opp = OPPOSITE[slot];
    if (opp && seen.has(`${l.espn_game_id}|${opp}`)) {
      throw httpErr(400, 'A parlay cannot include both sides of the same game.');
    }
    seen.add(key);
  }

  const combined = parlayAmericanOdds(legs); // all pending at creation -> full product
  if (combined == null) throw httpErr(400, 'Could not price this parlay.');

  const unit  = getUnitSize(userId) || 20;
  const units = unit > 0 ? +(stake / unit).toFixed(4) : null;
  const sports = [...new Set(legs.map(l => l.sport).filter(Boolean))];
  const oneGame = new Set(legs.map(l => l.espn_game_id).filter(Boolean)).size === 1 && legs.every(l => l.espn_game_id);
  const selection = `${legs.length}-leg ${oneGame ? 'same game parlay' : 'parlay'}`;

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO user_bets
        (user_id, bet_type, sport, selection, side, line, odds, stake, units,
         espn_game_id, game_date, result, payout, settled_at, verified, source, home_team, away_team, book, notes, free_bet)
      VALUES (?, 'parlay', ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, 'pending', NULL, NULL, 0, 'manual', NULL, NULL, ?, ?, ?)
    `).run(
      userId, sports.length === 1 ? sports[0] : (sports.length ? 'MULTI' : null),
      selection, combined, stake, units,
      body.book ? String(body.book).slice(0, 40) : null,
      body.notes ? String(body.notes).slice(0, 500) : null,
      freeBet,
    );
    const betId = info.lastInsertRowid;
    const insLeg = db.prepare(`
      INSERT INTO bet_legs (bet_id, user_id, espn_game_id, sport, selection, bet_type, side, line, odds, result, leg_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `);
    legs.forEach((l, i) => insLeg.run(betId, userId, l.espn_game_id, l.sport, l.selection, l.bet_type, l.side, l.line, l.odds, i));
    return betId;
  });
  return getBet(userId, tx());
}

// ── Create ────────────────────────────────────────────────────────────────────
function createBet(userId, body = {}) {
  const bet_type = String(body.bet_type || '').toLowerCase();
  if (!BET_TYPES.has(bet_type)) throw httpErr(400, 'Invalid bet type.');

  // Parlay with legs (Phase 5 builder). A legless parlay falls through to the
  // single-row manual path below (unchanged: user self-settles it).
  if (bet_type === 'parlay' && Array.isArray(body.legs) && body.legs.length) {
    return createParlay(userId, body);
  }

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

  // Sport is rendered into HTML in several places — strip anything that isn't a
  // plain label character so a hand-crafted API call can't store markup.
  let sport = body.sport ? String(body.sport).toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 20) || null : null;
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
  const freeBet = body.free_bet ? 1 : 0;
  const r0 = String(body.result || '').toLowerCase();
  const initResult = (!espn_game_id && ['win', 'loss', 'push', 'void'].includes(r0)) ? r0 : 'pending';
  const initPayout  = initResult !== 'pending' ? betProfit(initResult, odds, stake, freeBet) : null;
  const initSettled = initResult !== 'pending' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;

  const info = db.prepare(`
    INSERT INTO user_bets
      (user_id, bet_type, sport, selection, side, line, odds, stake, units,
       espn_game_id, game_date, result, payout, settled_at, verified, source, home_team, away_team, book, notes, free_bet)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, bet_type, sport, selection, side, line, odds, stake, units,
    espn_game_id, game_date, initResult, initPayout, initSettled, verified, source, home_team, away_team,
    body.book  ? String(body.book).slice(0, 40)   : null,
    body.notes ? String(body.notes).slice(0, 500) : null,
    freeBet,
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
  // Attach legs to parlays in one query (avoids N+1 on the history list).
  const parlayIds = bets.filter(b => b.bet_type === 'parlay').map(b => b.id);
  if (parlayIds.length) {
    const rows = db.prepare(`SELECT * FROM bet_legs WHERE bet_id IN (${parlayIds.map(() => '?').join(',')}) ORDER BY leg_index, id`).all(...parlayIds);
    const byBet = new Map();
    for (const r of rows) { if (!byBet.has(r.bet_id)) byBet.set(r.bet_id, []); byBet.get(r.bet_id).push(r); }
    for (const b of bets) if (b.bet_type === 'parlay') b.legs = byBet.get(b.id) || [];
  }
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
  db.prepare(`DELETE FROM bet_legs WHERE bet_id = ? AND user_id = ?`).run(id, userId); // cascade legs
  return { ok: true };
}

// ── Settle (manual bets only) ─────────────────────────────────────────────────
function settleBet(userId, id, result) {
  const bet = getBet(userId, id);
  if (!bet) throw httpErr(404, 'Bet not found.');
  if (bet.espn_game_id) throw httpErr(409, 'Game-linked bets are graded automatically.');
  // A parlay with any game-linked leg grades from its legs, not by hand.
  if (bet.bet_type === 'parlay' && (bet.legs || []).some(l => l.espn_game_id)) {
    throw httpErr(409, 'This parlay grades automatically from its legs.');
  }
  const r = String(result || '').toLowerCase();
  if (!['win', 'loss', 'push', 'void'].includes(r)) throw httpErr(400, 'Invalid result.');
  const payout = betProfit(r, bet.odds, bet.stake, bet.free_bet);
  db.prepare(`UPDATE user_bets SET result = ?, payout = ?, settled_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(r, payout, id, userId);
  return getBet(userId, id);
}

// Recompute a parlay parent from its (freshly-graded) legs. Re-prices off the
// legs that still count (push/void dropped). Only writes when the parlay reaches
// a decided result. Returns { changed, result }.
function settleParlayFromLegs(betId) {
  const bet = db.prepare(`SELECT * FROM user_bets WHERE id = ?`).get(betId);
  if (!bet || bet.bet_type !== 'parlay' || bet.result !== 'pending') return { changed: false };
  const legs = getLegs(betId);
  const result = parlayResultFromLegs(legs);
  if (result === 'pending') return { changed: false };
  const combined = parlayAmericanOdds(legs);          // re-priced (winning legs only)
  const payout = betProfit(result, combined, bet.stake, bet.free_bet);
  // Keep the parent odds in sync with the re-priced number so the record is honest.
  const upd = db.prepare(`UPDATE user_bets SET result = ?, payout = ?, odds = COALESCE(?, odds), settled_at = datetime('now') WHERE id = ? AND result = 'pending'`)
    .run(result, payout, combined, betId);
  return { changed: upd.changes > 0, result, bet };
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

// Push payload for a graded custom bet.
function betPushPayload(bet, result) {
  const title = result === 'win' ? 'Your bet won' : result === 'loss' ? 'Your bet lost' : 'Your bet pushed';
  return { title, body: bet.selection || 'Your tracked bet graded', tag: 'bet-grade', url: '/' };
}

// ── Auto-grade game-linked pending bets (called in the 5-min results cron) ─────
async function gradePendingBets() {
  let graded = 0;
  const notify = []; // { user_id, payload } — sent after grading, never blocks it

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
    const payout  = betProfit(result, b.odds, b.stake, b.free_bet);
    const closing = closingForSlot(slot, b);
    const upd = db.prepare(`
      UPDATE user_bets SET result = ?, payout = ?, settled_at = datetime('now'),
        closing_odds = COALESCE(?, closing_odds), closing_line = COALESCE(?, closing_line)
      WHERE id = ? AND result = 'pending'
    `).run(result, payout, closing.odds, closing.line, b.id);
    // changes = 0 means the bet vanished mid-grade (user deleted it); don't ping.
    if (upd.changes > 0) { notify.push({ user_id: b.user_id, payload: betPushPayload(b, result) }); graded++; }
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
    const payout = betProfit(result, b.odds, b.stake, b.free_bet);
    const upd = db.prepare(`UPDATE user_bets SET result = ?, payout = ?, settled_at = datetime('now') WHERE id = ? AND result = 'pending'`)
      .run(result, payout, b.id);
    if (upd.changes > 0) { notify.push({ user_id: b.user_id, payload: betPushPayload(b, result) }); graded++; }
  }

  // ── Pass C: parlay legs (Phase 5) ──────────────────────────────────────────
  // Grade any pending game-linked leg whose game is final, then re-settle its
  // parent parlay if all its legs are now decided.
  const affectedParlays = new Set();

  const liveLegs = db.prepare(`
    SELECT l.*, tg.status AS g_status, tg.home_score AS g_hs, tg.away_score AS g_as,
           tg.sport AS g_sport, tg.tennis_home_games, tg.tennis_away_games
    FROM bet_legs l JOIN today_games tg ON tg.espn_game_id = l.espn_game_id
    WHERE l.result = 'pending' AND l.espn_game_id IS NOT NULL
      AND l.bet_type IN ('ml','spread','over','under') AND tg.status = 'post'
  `).all();
  for (const l of liveLegs) {
    const slot = betToSlot(l);
    if (!slot) continue;
    const game = { status: l.g_status, sport: l.g_sport || l.sport, home_score: l.g_hs, away_score: l.g_as,
      tennis_home_games: l.tennis_home_games, tennis_away_games: l.tennis_away_games };
    const r = evaluateVote(slot, l.line, game);
    if (r === 'pending') continue;
    const upd = db.prepare(`UPDATE bet_legs SET result = ?, settled_at = datetime('now') WHERE id = ? AND result = 'pending'`).run(r, l.id);
    if (upd.changes > 0) affectedParlays.add(l.bet_id);
  }

  const staleLegs = db.prepare(`
    SELECT l.* FROM bet_legs l LEFT JOIN today_games tg ON tg.espn_game_id = l.espn_game_id
    WHERE l.result = 'pending' AND l.espn_game_id IS NOT NULL
      AND l.bet_type IN ('ml','spread','over','under') AND tg.espn_game_id IS NULL
  `).all();
  const legCache = new Map();
  for (const l of staleLegs) {
    if (!l.sport) continue;
    const slot = betToSlot(l);
    if (!slot) continue;
    let game;
    if (legCache.has(l.espn_game_id)) game = legCache.get(l.espn_game_id);
    else { game = await fetchGameResult(l.espn_game_id, l.sport, null); legCache.set(l.espn_game_id, game); }
    if (!game) continue;
    const r = evaluateVote(slot, l.line, game);
    if (r === 'pending') continue;
    const upd = db.prepare(`UPDATE bet_legs SET result = ?, settled_at = datetime('now') WHERE id = ? AND result = 'pending'`).run(r, l.id);
    if (upd.changes > 0) affectedParlays.add(l.bet_id);
  }

  for (const betId of affectedParlays) {
    const out = settleParlayFromLegs(betId);
    if (out.changed) { notify.push({ user_id: out.bet.user_id, payload: betPushPayload({ ...out.bet, selection: out.bet.selection }, out.result) }); graded++; }
  }

  if (notify.length) {
    const { sendToUserTopic } = require('./push');
    for (const n of notify) sendToUserTopic(n.user_id, 'grades', n.payload).catch(() => {});
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
    // A free-bet loss counts in the record but costs nothing (payout 0 via betProfit),
    // so it flows through normally — the W-L stays honest while the P/L stays flat.
    if (r === 'win') wins++; else if (r === 'loss') losses++; else if (r === 'push') pushes++; else if (r === 'pending') pending++;
    if (r === 'win' || r === 'loss') staked += b.stake;
    const p = b.payout != null ? b.payout : betProfit(r, b.odds, b.stake, b.free_bet);
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

module.exports = { createBet, listBets, updateBet, deleteBet, settleBet, gradePendingBets, betSummary, getBet, getLegs };
