// test/betslip_router.test.js — run: node test/betslip_router.test.js
//
// End-to-end over the real router, the real DB schema, and the real gates. This is
// the suite that proves Jack's rule: a scanned bet counts exactly when a tapped one
// would (matched game + pregame + inside the book range) and never otherwise.
//
// Uses a scratch DB via CAPPER_DB, so it touches nothing real.

const assert = require('node:assert');
const path   = require('node:path');
const os     = require('node:os');
const fs     = require('node:fs');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-betslip-'));
process.env.CAPPER_DB = path.join(SCRATCH, 'test.db');
process.env.UI_ONLY = '1';

const express = require('express');
const db = require('../src/db');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

// ── Seed a board ─────────────────────────────────────────────────────────────
const USER_ID = db.prepare(`INSERT INTO users (email, password_hash) VALUES (?, ?)`)
  .run('betslip-test@example.com', 'x').lastInsertRowid;

const inFuture = (mins) => new Date(Date.now() + mins * 60000).toISOString().slice(0, 19).replace('T', ' ');
const inPast   = (mins) => new Date(Date.now() - mins * 60000).toISOString().slice(0, 19).replace('T', ' ');

function seedGame(g) {
  db.prepare(`
    INSERT INTO today_games
      (espn_game_id, sport, status, start_time, home_team, home_short, home_name, home_abbr,
       away_team, away_short, away_name, away_abbr, home_score, away_score,
       ml_home, ml_away, spread_home, spread_away, over_under, ou_over_odds, ou_under_odds)
    VALUES (@espn_game_id,@sport,@status,@start_time,@home_team,@home_short,@home_name,@home_abbr,
            @away_team,@away_short,@away_name,@away_abbr,@home_score,@away_score,
            @ml_home,@ml_away,@spread_home,@spread_away,@over_under,@ou_over_odds,@ou_under_odds)
  `).run({
    home_score: 0, away_score: 0, ml_home: null, ml_away: null, spread_home: null,
    spread_away: null, over_under: null, ou_over_odds: null, ou_under_odds: null, ...g,
  });
}
function seedBook(espn_game_id, book, vals) {
  db.prepare(`
    INSERT INTO book_lines (espn_game_id, book, ml_home, ml_away, spread_home, spread_away, over_under, ou_over_odds, ou_under_odds)
    VALUES (@espn_game_id,@book,@ml_home,@ml_away,@spread_home,@spread_away,@over_under,@ou_over_odds,@ou_under_odds)
  `).run({
    espn_game_id, book, ml_home: null, ml_away: null, spread_home: null, spread_away: null,
    over_under: null, ou_over_odds: null, ou_under_odds: null, ...vals,
  });
}

// A pregame tennis match (Jack's screenshot), a pregame NBA game, and a game that
// has already started.
seedGame({ espn_game_id: 'T1', sport: 'ATP', status: 'pre', start_time: inFuture(180),
  home_team: 'Lorenzo Sonego', home_short: 'Sonego', home_name: 'Sonego', home_abbr: 'SON',
  away_team: 'James Duckworth', away_short: 'Duckworth', away_name: 'Duckworth', away_abbr: 'DUC',
  ml_home: -136, ml_away: 114 });
seedBook('T1', 'draftkings', { ml_home: -138, ml_away: 116 });
seedBook('T1', 'fanduel',    { ml_home: -134, ml_away: 112 });

seedGame({ espn_game_id: 'N1', sport: 'NBA', status: 'pre', start_time: inFuture(240),
  home_team: 'Boston Celtics', home_short: 'Celtics', home_name: 'Celtics', home_abbr: 'BOS',
  away_team: 'Los Angeles Lakers', away_short: 'Lakers', away_name: 'Lakers', away_abbr: 'LAL',
  spread_home: -4.5, spread_away: 4.5, over_under: 220.5, ou_over_odds: -110, ou_under_odds: -110 });
seedBook('N1', 'draftkings', { spread_home: -4.5, spread_away: 4.5, over_under: 220.5, ou_over_odds: -110, ou_under_odds: -110 });
seedBook('N1', 'fanduel',    { spread_home: -5,   spread_away: 5,   over_under: 221,   ou_over_odds: -112, ou_under_odds: -108 });

// Started: status flipped AND a score on the board.
seedGame({ espn_game_id: 'S1', sport: 'MLB', status: 'in', start_time: inPast(30),
  home_team: 'Baltimore Orioles', home_short: 'Orioles', home_name: 'Orioles', home_abbr: 'BAL',
  away_team: 'New York Yankees', away_short: 'Yankees', away_name: 'Yankees', away_abbr: 'NYY',
  home_score: 2, away_score: 1, ml_home: -120, ml_away: 100 });

// Suspended: filed 'pre' on our side (tennis_espn downgrades it) but not playable.
seedGame({ espn_game_id: 'X1', sport: 'ATP', status: 'pre', start_time: inFuture(120),
  home_team: 'Nicolas Jarry', home_short: 'Jarry', home_name: 'Jarry', home_abbr: 'JAR',
  away_team: 'Alexander Zverev', away_short: 'Zverev', away_name: 'Zverev', away_abbr: 'ZVE',
  ml_home: -150, ml_away: 125 });
db.prepare(`UPDATE today_games SET status_detail = 'STATUS_SUSPENDED' WHERE espn_game_id = 'X1'`).run();

// ── Server ───────────────────────────────────────────────────────────────────
const app = express();
let SESSION_USER = { id: USER_ID };
app.use((req, _res, next) => { req.session = SESSION_USER ? { user: SESSION_USER } : {}; next(); });
app.use('/api/betslip', require('../src/betslip_router'));

const server = app.listen(0);
const PORT = server.address().port;
const post = async (route, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/betslip${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  SESSION_USER = null;
  eq((await post('/parse', { text: 'x' })).status, 401, 'auth: logged out is rejected');
  SESSION_USER = { id: USER_ID };

  // ── 2. Jack's FanDuel card, all the way through ────────────────────────────
  {
    const { status, body } = await post('/parse', { text: `Straight Bet
-136
Lorenzo Sonego
MONEYLINE
Lorenzo Sonego v James Duckworth
6:14PM ET
Share in the FanDuel Community
Copy link
WhatsApp` });
    eq(status, 200, 'fd card: 200');
    eq(body.book, 'FanDuel', 'fd card: book');
    eq(body.bets.length, 1, 'fd card: one bet');
    const b = body.bets[0];
    eq(b.bet_type, 'ml', 'fd card: ml');
    eq(b.odds, -136, 'fd card: odds');
    eq(b.match.espn_game_id, 'T1', 'fd card: matched the match');
    eq(b.match.slot, 'home_ml', 'fd card: slot');
    eq(b.tracking.open, true, 'fd card: pregame, tracking open');
    eq(b.verify.eligible, true, 'fd card: eligible to verify');
    eq(b.verify.verified, true, 'fd card: VERIFIES at the book price');
    eq(b.verify.issue, null, 'fd card: no issue');
    eq(b.duplicate_of, null, 'fd card: not a duplicate');
    ok(b.game && b.game.label.includes('Sonego'), 'fd card: game label');
  }

  // ── 3. Odds outside the book range fall to a personal bet ──────────────────
  {
    const { body } = await post('/parse', { text: `FanDuel
Straight Bet
+900
Lorenzo Sonego
MONEYLINE
Lorenzo Sonego v James Duckworth` });
    const b = body.bets[0];
    eq(b.match.espn_game_id, 'T1', 'out of range: still matched');
    eq(b.tracking.open, true, 'out of range: still pregame');
    eq(b.verify.verified, false, 'out of range: does NOT verify');
    ok(/book range/.test(b.verify.issue), 'out of range: issue names the band');
  }

  // Inside the 9% tolerance still verifies (that is Jack's existing rule).
  {
    const { body } = await post('/parse', { text: `FanDuel\nStraight Bet\n-145\nLorenzo Sonego\nMONEYLINE\nLorenzo Sonego v James Duckworth` });
    eq(body.bets[0].verify.verified, true, 'tolerance: -145 vs a -134/-138 band still verifies');
  }

  // ── 4. THE START GATE ──────────────────────────────────────────────────────
  // The whole trust rule in one assertion: a slip on a game already under way can
  // never be a verified track, no matter how good the price is.
  {
    const { body } = await post('/parse', { text: `DraftKings
New York Yankees
Moneyline
Yankees @ Orioles
+100` });
    const b = body.bets[0];
    eq(b.match.espn_game_id, 'S1', 'started: matched the game');
    eq(b.tracking.open, false, 'started: tracking CLOSED');
    eq(b.tracking.reason, 'started', 'started: reason');
    eq(b.verify.verified, false, 'started: cannot verify');
    ok(/started/.test(b.verify.issue), 'started: issue explains why');
  }

  // A suspended match reads pregame by status and must still be closed.
  {
    const { body } = await post('/parse', { text: `FanDuel\nNicolas Jarry\nMONEYLINE\nNicolas Jarry v Alexander Zverev\n-150` });
    const b = body.bets[0];
    eq(b.match.espn_game_id, 'X1', 'suspended: matched');
    eq(b.tracking.open, false, 'suspended: tracking CLOSED even though status is pre');
    eq(b.tracking.reason, 'suspended', 'suspended: reason');
    eq(b.verify.verified, false, 'suspended: cannot verify');
  }

  // ── 5. Spread and total against real book bands ────────────────────────────
  {
    const { body } = await post('/parse', { text: `DraftKings
Los Angeles Lakers +4.5
Point Spread
Los Angeles Lakers @ Boston Celtics
-110
$25.00 Wager` });
    const b = body.bets[0];
    eq(b.match.slot, 'away_spread', 'spread: slot');
    eq(b.line, 4.5, 'spread: line');
    eq(b.stake, 25, 'spread: stake');
    eq(b.verify.verified, true, 'spread: verifies inside the 4.5/5 band');
  }
  {
    const { body } = await post('/parse', { text: `DraftKings
Over 220.5
Total Points
Lakers @ Celtics
-110` });
    const b = body.bets[0];
    eq(b.match.slot, 'over', 'total: slot');
    eq(b.verify.verified, true, 'total: verifies');
  }
  // A line nowhere near the book band does not verify.
  {
    const { body } = await post('/parse', { text: `DraftKings\nOver 260.5\nTotal Points\nLakers @ Celtics\n-110` });
    eq(body.bets[0].verify.verified, false, 'total: 260.5 against a 220.5 board does not verify');
  }

  // ── 6. Parlays and props are never verified tracks ─────────────────────────
  {
    const { body } = await post('/parse', { text: `DraftKings
2 Leg Parlay
+264
Los Angeles Lakers +4.5
Point Spread
Lakers @ Celtics
-110
Lorenzo Sonego
Moneyline
Sonego v Duckworth
-136
$10.00 Wager` });
    const b = body.bets[0];
    eq(b.bet_type, 'parlay', 'parlay: type');
    eq(b.verify.eligible, false, 'parlay: not eligible for a verified track');
    eq(b.legs.length, 2, 'parlay: two legs');
    eq(b.legs[0].espn_game_id, 'N1', 'parlay: leg 1 game');
    eq(b.legs[1].espn_game_id, 'T1', 'parlay: leg 2 game');
    ok(b.legs.every(l => l.slot), 'parlay: both legs are gradable');
  }
  {
    const { body } = await post('/parse', { text: `FanDuel\nJayson Tatum 25+ Points\nPlayer Points\nLakers @ Celtics\n-140` });
    const b = body.bets[0];
    eq(b.bet_type, 'prop', 'prop: type');
    eq(b.verify.eligible, false, 'prop: never a verified track');
    eq(b.match.slot, null, 'prop: no slot');
  }

  // ── 7. Unmatched games ─────────────────────────────────────────────────────
  {
    const { body } = await post('/parse', { text: `FanDuel\nKansas City Chiefs\nMoneyline\n-150` });
    const b = body.bets[0];
    eq(b.match.espn_game_id, null, 'unmatched: no game');
    eq(b.tracking.reason, 'unmatched', 'unmatched: reason');
    eq(b.verify.verified, false, 'unmatched: personal bet');
    eq(b.game, null, 'unmatched: no game payload');
  }

  // ── 8. Bad input ───────────────────────────────────────────────────────────
  eq((await post('/parse', {})).status, 400, 'input: empty body rejected');
  {
    const { status, body } = await post('/parse', { text: 'Cheeseburger 12.00\nFries 4.50\nTotal 16.50' });
    eq(status, 200, 'input: a non-betslip is a clean 200');
    eq(body.bets.length, 0, 'input: a receipt mints no bets');
    ok(body.warnings.includes('not_a_betslip'), 'input: warned');
  }

  // ── 9. Import creates personal bets and grades them ourselves ──────────────
  {
    const { status, body } = await post('/import', { bets: [
      // Game-linked and settled on the slip: we IGNORE the slip's verdict and let
      // the results cron grade it. Jack's rule.
      { bet_type: 'ml', selection: 'Lorenzo Sonego', side: 'home', odds: -136, stake: 10,
        espn_game_id: 'T1', sport: 'ATP', book: 'FanDuel', result: 'win' },
      // No game we can grade: the user's own confirmed result stands.
      { bet_type: 'prop', selection: 'Jayson Tatum 25+ Points', odds: -140, stake: 20,
        book: 'FanDuel', result: 'win' },
    ] });
    eq(status, 200, 'import: 200');
    eq(body.created.length, 2, 'import: two rows created');
    eq(body.created[0].result, 'pending', 'import: the game-linked settled slip stays PENDING for us to grade');
    eq(body.created[1].result, 'win', 'import: the ungradable prop keeps the user-confirmed result');
    eq(body.failed.length, 0, 'import: nothing failed');

    const row = db.prepare(`SELECT * FROM user_bets WHERE id = ?`).get(body.created[0].id);
    eq(row.verified, 0, 'import: an imported row is NEVER server-marked verified');
    eq(row.espn_game_id, 'T1', 'import: game linked so the cron can grade it');
    ok(/Scanned from a FanDuel slip/.test(row.notes), 'import: provenance noted');
    ok(/we grade it off the final score/.test(row.notes), 'import: grading intent noted');
  }

  // ── 10. Duplicates ─────────────────────────────────────────────────────────
  {
    // The row created above is still pending, so re-scanning the same slip is caught.
    const { body } = await post('/parse', { text: `FanDuel\nStraight Bet\n-136\nLorenzo Sonego\nMONEYLINE\nLorenzo Sonego v James Duckworth` });
    ok(body.bets[0].duplicate_of, 'duplicate: re-scanning the same slip is flagged');

    const again = await post('/import', { bets: [
      { bet_type: 'ml', selection: 'Lorenzo Sonego', side: 'home', odds: -136, stake: 10, espn_game_id: 'T1', sport: 'ATP' },
    ] });
    eq(again.body.created.length, 0, 'duplicate: import skips it');
    eq(again.body.skipped.length, 1, 'duplicate: reported as skipped');
    eq(again.body.skipped[0].reason, 'duplicate', 'duplicate: reason');

    const forced = await post('/import', { skip_duplicates: false, bets: [
      { bet_type: 'ml', selection: 'Lorenzo Sonego', side: 'home', odds: -136, stake: 10, espn_game_id: 'T1', sport: 'ATP' },
    ] });
    eq(forced.body.created.length, 1, 'duplicate: an explicit override still writes');
  }

  // ── 11. Import guards ──────────────────────────────────────────────────────
  eq((await post('/import', { bets: [] })).status, 400, 'import: empty list rejected');
  eq((await post('/import', { bets: new Array(51).fill({ bet_type: 'ml', selection: 'x', odds: -110 }) })).status, 400, 'import: over the batch cap rejected');
  {
    const { body } = await post('/import', { bets: [{ bet_type: 'nonsense', selection: 'x', odds: -110 }] });
    eq(body.created.length, 0, 'import: a bad bet type creates nothing');
    eq(body.failed.length, 1, 'import: and is reported as failed');
  }

  // A bet on a STARTED game imports as history and says so, and never as verified.
  {
    const { body } = await post('/import', { bets: [
      { bet_type: 'ml', selection: 'New York Yankees', side: 'away', odds: 100, stake: 10, espn_game_id: 'S1', sport: 'MLB', book: 'DraftKings' },
    ] });
    eq(body.created.length, 1, 'late import: created');
    eq(body.created[0].tracked_late, true, 'late import: flagged as late');
    const row = db.prepare(`SELECT * FROM user_bets WHERE id = ?`).get(body.created[0].id);
    eq(row.verified, 0, 'late import: not verified');
    ok(/already started/.test(row.notes), 'late import: the note says why');
  }

  server.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`betslip_router.test.js: ${n} assertions passed`);
})().catch(err => {
  server.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
