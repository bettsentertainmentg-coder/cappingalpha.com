// test/bet_card.test.js — run: node test/bet_card.test.js
//
// The shareable bet card: token security, SVG content for every result state, and
// a real PNG rasterization when @resvg/resvg-js and the vendored fonts are present.

const assert = require('node:assert');
const path   = require('node:path');
const os     = require('node:os');
const fs     = require('node:fs');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-betcard-'));
process.env.CAPPER_DB = path.join(SCRATCH, 'test.db');
process.env.SESSION_SECRET = 'test-secret-for-bet-cards';
process.env.UI_ONLY = '1';

const db = require('../src/db');
const card = require('../src/bet_card');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

const USER = db.prepare(`INSERT INTO users (email, password_hash) VALUES (?, ?)`).run('card@example.com', 'x').lastInsertRowid;

function mkBet(o) {
  return db.prepare(`
    INSERT INTO user_bets (user_id, bet_type, sport, selection, side, line, odds, stake, units,
                           espn_game_id, result, payout, verified, source, home_team, away_team, book)
    VALUES (@user_id,@bet_type,@sport,@selection,@side,@line,@odds,@stake,@units,@espn_game_id,@result,@payout,@verified,'manual',@home_team,@away_team,@book)
  `).run({
    user_id: USER, bet_type: 'ml', sport: 'ATP', selection: 'Lorenzo Sonego', side: 'home',
    line: null, odds: -136, stake: 20, units: 1, espn_game_id: 'T1', result: 'pending',
    payout: null, verified: 0, home_team: 'Lorenzo Sonego', away_team: 'James Duckworth',
    book: 'FanDuel', ...o,
  }).lastInsertRowid;
}

const WIN  = mkBet({ result: 'win',  payout: 14.71 });
const LOSS = mkBet({ result: 'loss', payout: -20 });
const PEND = mkBet({});
const PUSH = mkBet({ result: 'push', payout: 0, bet_type: 'spread', line: -4.5, odds: -110,
  selection: 'Los Angeles Lakers', sport: 'NBA', home_team: 'Boston Celtics', away_team: 'Los Angeles Lakers' });

// A parlay with legs.
const PARLAY = mkBet({ bet_type: 'parlay', selection: '3-leg parlay', odds: 596, stake: 10, result: 'win', payout: 59.6, sport: 'MULTI', home_team: null, away_team: null });
const insLeg = db.prepare(`INSERT INTO bet_legs (bet_id, user_id, espn_game_id, sport, selection, bet_type, side, line, odds, result, leg_index) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
insLeg.run(PARLAY, USER, 'N1', 'NBA', 'Los Angeles Lakers', 'spread', 'away', -4.5, -110, 'win', 0);
insLeg.run(PARLAY, USER, 'N1', 'NBA', 'Over', 'over', 'over', 220.5, -110, 'win', 1);
insLeg.run(PARLAY, USER, 'T1', 'ATP', 'Lorenzo Sonego', 'ml', 'home', null, -136, 'win', 2);

// ── 1. Token security ────────────────────────────────────────────────────────
{
  const t = card.tokenFor(WIN);
  ok(/^[0-9a-f]{24}$/.test(t), 'token: 24 hex chars');
  eq(card.tokenValid(WIN, t), true, 'token: valid for its own bet');
  eq(card.tokenValid(LOSS, t), false, 'token: does NOT open a different bet');
  eq(card.tokenValid(WIN, ''), false, 'token: empty rejected');
  eq(card.tokenValid(WIN, null), false, 'token: null rejected');
  eq(card.tokenValid(WIN, t.slice(0, 23)), false, 'token: truncated rejected');
  eq(card.tokenValid(WIN, t.replace(/.$/, x => x === 'a' ? 'b' : 'a')), false, 'token: tampered rejected');
  // Sequential guessing must not work: neighbouring ids have unrelated tokens.
  ok(card.tokenFor(WIN) !== card.tokenFor(WIN + 1), 'token: not sequential');
}

// ── 2. SVG content per result ────────────────────────────────────────────────
const svgFor = (id) => {
  const bet = db.prepare(`SELECT * FROM user_bets WHERE id = ?`).get(id);
  const legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ? ORDER BY leg_index`).all(id);
  return card.buildSvg(bet, legs, { w: 12, l: 8, p: 1 }, 20);
};
{
  const s = svgFor(WIN);
  ok(s.includes('WON'), 'svg win: badge');
  ok(s.includes('Lorenzo Sonego'), 'svg win: selection');
  ok(s.includes('-136'), 'svg win: odds');
  ok(s.includes('+$14.71'), 'svg win: profit in dollars');
  ok(s.includes('0.74u'), 'svg win: profit in units at a $20 unit');
  ok(s.includes('FanDuel'), 'svg win: book');
  ok(s.includes('12-8-1 tracked'), 'svg win: record');
  ok(s.includes('cappingalpha.com'), 'svg win: footer');
  ok(s.startsWith('<svg'), 'svg win: is an svg');
}
{
  const s = svgFor(LOSS);
  ok(s.includes('LOST'), 'svg loss: badge');
  ok(s.includes('-$20.00'), 'svg loss: the loss is shown honestly, not hidden');
}
{
  const s = svgFor(PEND);
  ok(s.includes('ON THE BOARD'), 'svg pending: badge');
  ok(s.includes('to win'), 'svg pending: shows the potential return, not a profit');
  ok(!s.includes('WON'), 'svg pending: never claims a win');
}
{
  const s = svgFor(PUSH);
  ok(s.includes('PUSH'), 'svg push: badge');
  ok(s.includes('-4.5'), 'svg push: spread line rendered with its sign');
}
{
  const s = svgFor(PARLAY);
  ok(s.includes('3-Leg Parlay'), 'svg parlay: headline');
  ok(s.includes('+596'), 'svg parlay: combined odds');
  ok(s.includes('Over 220.5'), 'svg parlay: a leg with its line');
  ok(s.includes('+$59.60'), 'svg parlay: payout');
}

// ── 3. Escaping ──────────────────────────────────────────────────────────────
// The selection is user-controlled (it comes off a scanned slip or a typed form),
// and it lands inside an SVG text node. It must never be able to close that node.
{
  const evil = mkBet({ selection: '</text><script>alert(1)</script>', result: 'win', payout: 5 });
  const s = svgFor(evil);
  ok(!s.includes('<script>'), 'escape: no raw script tag survives');
  ok(!s.includes('</text><'), 'escape: cannot close the text node');
  ok(s.includes('&lt;'), 'escape: entity-encoded instead');
}

// ── 4. Share caption ─────────────────────────────────────────────────────────
{
  ok(/cashed/i.test(card.shareText(WIN)), 'caption: a win reads as a win');
  ok(/did not land/i.test(card.shareText(LOSS)), 'caption: a loss is stated plainly');
  ok(/I am on/i.test(card.shareText(PEND)), 'caption: a pending bet is not claimed as a result');
  for (const id of [WIN, LOSS, PEND, PUSH, PARLAY]) {
    const t = card.shareText(id);
    ok(t.includes('cappingalpha.com'), `caption ${id}: links home`);
    ok(!/—/.test(t), `caption ${id}: no em dash (house style)`);
    // The hard rule: user-facing copy never names a source or the scoring.
    ok(!/discord|action network|polymarket|covers|wilson|percentile|ladder|band/i.test(t),
       `caption ${id}: reveals no sources or scoring mechanics`);
  }
}

// ── 5. Real rasterization ────────────────────────────────────────────────────
if (card.available()) {
  const png = card.renderBetCardPng(WIN);
  ok(Buffer.isBuffer(png) && png.length > 2000, 'render: produced a real PNG');
  eq(png.slice(1, 4).toString('ascii'), 'PNG', 'render: PNG magic bytes');
  // Cached second call returns the same buffer.
  ok(card.renderBetCardPng(WIN) === png, 'render: cached on a second call');
  ok(Buffer.isBuffer(card.renderBetCardPng(PARLAY)), 'render: parlay card renders');
  eq(card.renderBetCardPng(999999), null, 'render: unknown bet renders nothing');
} else {
  console.log('  (resvg or fonts unavailable, skipped rasterization checks)');
}

fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(`bet_card.test.js: ${n} assertions passed`);
