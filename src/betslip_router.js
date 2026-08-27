// src/betslip_router.js — /api/betslip/* — the screenshot-to-tracked-bet endpoints.
// Mounted in index.js: app.use('/api/betslip', require('./src/betslip_router')).
//
// THE PRIVACY LINE: the screenshot never arrives here. The phone (Apple Vision /
// ML Kit) and the browser (Tesseract.js) do the OCR locally and post only the
// resulting TEXT. Nothing on this server ever holds a user's betslip image.
//
// THE TRUST LINE, which is Jack's rule verbatim ("as long as it's within range and
// before the game starts, like any other tracked bet, yes have it count"):
//
//   A scanned bet gets NO special trust and NO special penalty. It is put through
//   the exact same two gates as a bet placed by tapping a line in the app:
//     1. isTrackingClosed(game)  — pregame only, suspensions closed  (pick_cutoff.js)
//     2. the odds/line sit inside the range of the books we scrape   (VERIFY_TOL)
//   Clear both and it rides /api/game/:id/vote as a verified tracked bet. Miss
//   either and it lands in user_bets as a personal bet, auto-graded off the game
//   when we know which game it is.
//
// Which means there is deliberately NO verified-write endpoint in this file. A
// verified track is only ever created by the existing vote endpoint, through the
// existing confirm slide, after the user has looked at the numbers. This file
// reads, matches, and grades the situation; the batch writer below creates
// PERSONAL bets only (the settled-backfill and unmatched cases).

'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('./db');

const { parseBetslip }   = require('./betslip_parse');
const { matchBet }       = require('./betslip_match');
const { isTrackingClosed, isSuspended, hasGameStarted } = require('./pick_cutoff');
const { getLinesForGame } = require('./lines_scraper');
const ub = require('./user_bets');

function uid(req) { return req && req.session && req.session.user ? req.session.user.id : null; }

// 256KB: a dense My Bets screenshot OCRs to a few KB, so this is many times the
// worst real case while still refusing an attempt to post a novel.
router.use(express.json({ limit: '256kb' }));
router.use((req, res, next) => {
  if (!uid(req)) return res.status(401).json({ error: 'Login required' });
  next();
});

// ── Verified range ────────────────────────────────────────────────────────────
// Mirrors openLineConfirm() in public/modules/track.js so the server's verdict and
// the confirm slide's badge can never disagree. KEEP THE TWO IN SYNC: the tolerance
// below and VERIFY_TOL in track.js are the same rule stated twice.
const VERIFY_TOL = 0.09;

function americanToDecimal(a) {
  const o = Number(a);
  if (!Number.isFinite(o) || o === 0) return null;
  return o < 0 ? 1 + 100 / Math.abs(o) : 1 + o / 100;
}
function decimalToAmerican(d) {
  const x = Number(d);
  if (!Number.isFinite(x) || x <= 1) return null;
  return x >= 2 ? Math.round((x - 1) * 100) : -Math.round(100 / (x - 1));
}
function rangeOf(nums) {
  const v = nums.filter(n => n != null && Number.isFinite(Number(n))).map(Number);
  return v.length ? { lo: Math.min(...v), hi: Math.max(...v) } : null;
}

const SLOT_ODDS_FIELD = { home_ml: 'ml_home', away_ml: 'ml_away', over: 'ou_over_odds', under: 'ou_under_odds' };
const SLOT_LINE_FIELD = { home_spread: 'spread_home', away_spread: 'spread_away', over: 'over_under', under: 'over_under' };

// Per-book odds + line for a slot, from every book we scrape plus the CA number.
// Spread juice is not stored per book (flat -110), same as the client.
function slotBookRanges(game, slot) {
  const isSpread = slot === 'home_spread' || slot === 'away_spread';
  const hasLine  = isSpread || slot === 'over' || slot === 'under';
  const oddsField = SLOT_ODDS_FIELD[slot];
  const lineField = SLOT_LINE_FIELD[slot];

  const books = getLinesForGame(game.espn_game_id) || {};
  const oddsVals = [], lineVals = [];
  for (const key of Object.keys(books)) {
    const b = books[key];
    if (!b) continue;
    const line = lineField ? b[lineField] : null;
    if (isSpread) { if (line != null) { oddsVals.push(-110); lineVals.push(Number(line)); } }
    else {
      if (b[oddsField] != null) oddsVals.push(Number(b[oddsField]));
      if (line != null) lineVals.push(Number(line));
    }
  }
  // The CA line itself is always part of the band.
  const caOdds = isSpread ? -110 : (oddsField ? game[oddsField] : null);
  const caLine = isSpread ? (slot === 'home_spread' ? game.spread_home : game.spread_away)
               : hasLine  ? game.over_under : null;
  if (caOdds != null) oddsVals.push(Number(caOdds));
  if (caLine != null) lineVals.push(Number(caLine));

  return {
    hasLine, isSpread,
    caOdds: caOdds == null ? null : Number(caOdds),
    caLine: caLine == null ? null : Number(caLine),
    oddsRange: rangeOf(oddsVals.map(americanToDecimal)),
    lineRange: hasLine ? rangeOf(lineVals) : null,
    bookCount: Object.keys(books).length,
  };
}

// Would this bet verify? Returns { verified, issue } with issue being the plain
// sentence the confirm slide shows when it will not.
function verifyVerdict(bet, game, slot) {
  if (!game || !slot) return { verified: false, issue: 'We could not match this to a game we track, so it will save as a personal bet.', bands: null };
  const bands = slotBookRanges(game, slot);
  const odds = Number(bet.odds);
  if (!Number.isFinite(odds) || odds === 0) return { verified: false, issue: 'We could not read the odds, so it will save as a personal bet.', bands };
  const dec = americanToDecimal(odds);
  if (!bands.oddsRange || dec == null) return { verified: false, issue: 'No book odds to check against, so it will save as a personal bet.', bands };

  const oLo = bands.oddsRange.lo * (1 - VERIFY_TOL), oHi = bands.oddsRange.hi * (1 + VERIFY_TOL);
  if (!(dec >= oLo && dec <= oHi)) {
    const f = v => { const a = decimalToAmerican(v); return a == null ? '?' : (a > 0 ? '+' + a : String(a)); };
    return { verified: false, issue: `Those odds sit outside the book range (${f(oLo)} to ${f(oHi)}), so it will save as a personal bet.`, bands };
  }
  if (bands.hasLine) {
    const ln = Number(bet.line);
    if (!Number.isFinite(ln)) return { verified: false, issue: 'We could not read the line, so it will save as a personal bet.', bands };
    if (!bands.lineRange) return { verified: false, issue: 'No book line to check against, so it will save as a personal bet.', bands };
    const pad = v => VERIFY_TOL * Math.abs(v);
    const lLo = bands.lineRange.lo - pad(bands.lineRange.lo), lHi = bands.lineRange.hi + pad(bands.lineRange.hi);
    if (!(ln >= lLo && ln <= lHi)) {
      return { verified: false, issue: `That line sits outside the book range (${(+lLo.toFixed(1))} to ${(+lHi.toFixed(1))}), so it will save as a personal bet.`, bands };
    }
  }
  return { verified: true, issue: null, bands };
}

// ── Board ─────────────────────────────────────────────────────────────────────
// today_games carries the current board day plus the forward days that
// forward_games.js upserts, which is every game a scanned slip could be pregame on.
function boardGames() {
  try {
    return db.prepare(`
      SELECT espn_game_id, sport, status, status_detail, clock, period, start_time, actual_start_at,
             home_team, home_short, home_name, home_abbr,
             away_team, away_short, away_name, away_abbr,
             home_score, away_score, tennis_home_games, tennis_away_games,
             ml_home, ml_away, spread_home, spread_away, over_under, ou_over_odds, ou_under_odds
      FROM today_games
    `).all();
  } catch (_) {
    // Older schemas without the tennis game counters still need to match.
    try {
      return db.prepare(`SELECT * FROM today_games`).all();
    } catch (_e) { return []; }
  }
}

// ── Duplicate detection ───────────────────────────────────────────────────────
// Sharing the same slip twice, or a My Bets list that includes something already
// tracked, must not double-count. Same user + same game + same slot-ish selection
// + same price, still pending, inside a day.
function findDuplicate(userId, bet, match) {
  try {
    const rows = db.prepare(`
      SELECT id, selection, odds, line, bet_type, espn_game_id, result, placed_at
      FROM user_bets
      WHERE user_id = ? AND placed_at >= datetime('now', '-2 days')
      ORDER BY id DESC LIMIT 200
    `).all(userId);
    const sel = String(bet.selection || '').toLowerCase().trim();
    for (const r of rows) {
      if (String(r.bet_type) !== String(bet.bet_type)) continue;
      if (match.espn_game_id && r.espn_game_id && r.espn_game_id !== match.espn_game_id) continue;
      if (!match.espn_game_id && String(r.selection || '').toLowerCase().trim() !== sel) continue;
      if (bet.odds != null && r.odds != null && Number(r.odds) !== Number(bet.odds)) continue;
      if (bet.line != null && r.line != null && Number(r.line) !== Number(bet.line)) continue;
      return r.id;
    }
  } catch (_) {}
  // A verified track lives in game_votes, not user_bets.
  if (match.espn_game_id && match.slot) {
    try {
      const v = db.prepare(`SELECT id FROM game_votes WHERE user_id = ? AND espn_game_id = ? AND pick_slot = ?`)
        .get(userId, match.espn_game_id, match.slot);
      if (v) return `vote:${v.id}`;
    } catch (_) {}
  }
  return null;
}

// ── POST /api/betslip/parse ───────────────────────────────────────────────────
// Body: { text, blocks?, source? }  ->  everything the confirm screen needs, in one
// round trip: what the slip says, which game it is, whether tracking is still open,
// and whether it would verify.
router.post('/parse', (req, res) => {
  try {
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text : '';
    const blocks = Array.isArray(body.blocks) ? body.blocks.slice(0, 4000) : null;
    if (!text && !(blocks && blocks.length)) {
      return res.status(400).json({ error: 'Nothing to read.' });
    }

    const parsed = parseBetslip({ text, blocks });
    const games  = boardGames();
    const userId = uid(req);

    const bets = parsed.bets.map((bet) => {
      const match = matchBet(bet, games);
      const game  = match.game;

      // Legs of a parlay each need their own game so bet_legs can auto-grade.
      const legs = (bet.legs || []).map((l) => {
        const lm = matchBet(l, games);
        return {
          ...l,
          espn_game_id: lm.espn_game_id, slot: lm.slot, side: lm.side, sport: lm.sport,
          match_score: lm.score,
          matchup_label: lm.game ? `${lm.game.away_team} @ ${lm.game.home_team}` : null,
        };
      });

      let tracking = { open: false, reason: 'unmatched' };
      if (game) {
        if (isSuspended(game))         tracking = { open: false, reason: 'suspended' };
        else if (hasGameStarted(game)) tracking = { open: false, reason: 'started' };
        else if (isTrackingClosed(game)) tracking = { open: false, reason: 'closed' };
        else tracking = { open: true, reason: null };
      }

      // Verification is only meaningful while tracking is open.
      const verdict = tracking.open
        ? verifyVerdict(bet, game, match.slot)
        : { verified: false, issue: game ? 'That game has started, so it will save as a personal bet.' : 'We could not match this to a game we track, so it will save as a personal bet.', bands: game && match.slot ? slotBookRanges(game, match.slot) : null };

      // A parlay is never a verified track (the leaderboard counts single picks),
      // but its legs still need games so the parlay grades itself.
      const canVerify = bet.bet_type !== 'parlay' && bet.bet_type !== 'prop' && bet.bet_type !== 'future';

      return {
        ...bet,
        legs,
        match: {
          espn_game_id: match.espn_game_id, slot: match.slot, side: match.side,
          sport: match.sport, score: match.score, ambiguous: match.ambiguous,
          alternatives: (match.alternatives || []).map(a => {
            const g = games.find(x => x.espn_game_id === a.espn_game_id);
            return g ? { espn_game_id: g.espn_game_id, sport: g.sport, label: `${g.away_team} @ ${g.home_team}`, score: a.score } : null;
          }).filter(Boolean),
        },
        game: game ? {
          espn_game_id: game.espn_game_id, sport: game.sport, status: game.status,
          home_team: game.home_team, away_team: game.away_team, start_time: game.start_time,
          label: `${game.away_team} @ ${game.home_team}`,
        } : null,
        tracking,
        verify: {
          eligible: canVerify,
          verified: canVerify && verdict.verified,
          issue: canVerify ? verdict.issue : (bet.bet_type === 'parlay'
            ? 'Parlays track as personal bets.'
            : 'Player props and futures track as personal bets.'),
          ca_odds: verdict.bands ? verdict.bands.caOdds : null,
          ca_line: verdict.bands ? verdict.bands.caLine : null,
          book_count: verdict.bands ? verdict.bands.bookCount : 0,
        },
        duplicate_of: findDuplicate(userId, bet, match),
      };
    });

    res.json({
      book: parsed.book, book_key: parsed.bookKey,
      capture: parsed.capture,
      warnings: parsed.warnings,
      bets,
      board_size: games.length,
    });
  } catch (err) {
    console.error('[betslip] parse error:', err.message);
    res.status(500).json({ error: 'Could not read that slip.' });
  }
});

// ── POST /api/betslip/import ──────────────────────────────────────────────────
// Batch-create PERSONAL bets from a reviewed scan. This is the settled-backfill and
// multi-bet path; it never creates a verified track (see the header note).
//
// Body: { bets: [ { bet_type, selection, side, line, odds, stake, book, notes,
//                   espn_game_id, sport, result, legs? } ], skip_duplicates? }
router.post('/import', (req, res) => {
  const userId = uid(req);
  const rows = Array.isArray((req.body || {}).bets) ? req.body.bets : [];
  if (!rows.length) return res.status(400).json({ error: 'No bets to import.' });
  if (rows.length > 50) return res.status(400).json({ error: 'Too many bets in one import.' });
  const skipDupes = (req.body || {}).skip_duplicates !== false;

  const created = [], skipped = [], failed = [];
  const games = boardGames();

  for (const raw of rows) {
    try {
      const betType = String(raw.bet_type || '').toLowerCase();
      const game = raw.espn_game_id ? games.find(g => g.espn_game_id === String(raw.espn_game_id)) : null;

      if (skipDupes) {
        const dupe = findDuplicate(userId, raw, { espn_game_id: raw.espn_game_id || null, slot: raw.slot || null });
        if (dupe) { skipped.push({ selection: raw.selection, reason: 'duplicate', existing: dupe }); continue; }
      }

      // THE START GATE, server side. A slip shared after first pitch is history, not
      // a bet we are willing to grade off a line frozen before it: it saves with the
      // user's own result, or stays pending for them to settle.
      const started = game ? isTrackingClosed(game) : false;

      // Jack's rule on a settled slip: we grade it, the screenshot does not. A bet
      // we can tie to a real game keeps result 'pending' and the normal results
      // cron settles it off the final score. Only a bet we can NEVER grade (no game,
      // a prop, a future) keeps the result the user confirmed off the slip.
      const gradable = !!(raw.espn_game_id && ['ml', 'spread', 'over', 'under'].includes(betType));
      const claimed  = ['win', 'loss', 'push', 'void'].includes(String(raw.result || '').toLowerCase())
        ? String(raw.result).toLowerCase() : null;

      const payload = {
        bet_type: betType,
        selection: raw.selection,
        side: raw.side || null,
        line: raw.line == null ? null : Number(raw.line),
        odds: Number(raw.odds),
        stake: Number(raw.stake) || 0,
        sport: raw.sport || (game ? game.sport : null),
        espn_game_id: raw.espn_game_id || null,
        book: raw.book || null,
        notes: buildNote(raw, started, claimed, gradable),
        free_bet: raw.free_bet ? 1 : 0,
        result: gradable ? 'pending' : claimed,
        legs: Array.isArray(raw.legs) && raw.legs.length >= 2 ? raw.legs : undefined,
      };

      const bet = ub.createBet(userId, payload);
      created.push({ id: bet.id, selection: bet.selection, result: bet.result, tracked_late: started });
    } catch (e) {
      failed.push({ selection: raw && raw.selection, error: e.message || 'Could not save' });
    }
  }

  res.json({ created, skipped, failed, count: created.length });
});

// The note is the honest audit trail on a scanned row: where it came from, and why
// it is a personal bet rather than a verified track.
function buildNote(raw, started, claimed, gradable) {
  const bits = [];
  const base = String(raw.notes || '').trim();
  if (base) bits.push(base);
  bits.push(raw.book ? `Scanned from a ${raw.book} slip` : 'Scanned from a betslip');
  if (started) bits.push('game had already started when it was added, so it is history only');
  if (claimed && gradable) bits.push(`slip said ${claimed}, we grade it off the final score`);
  return bits.join('. ').slice(0, 500);
}

module.exports = router;
