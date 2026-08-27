// test/betslip_parse.test.js — run: node test/betslip_parse.test.js
//
// Fixtures are transcribed from real sportsbook screenshots, in the reading order
// a plain OCR pass produces (which is NOT the visual row order — that is the whole
// reason the blocks path exists, and it gets its own section at the bottom).
const assert = require('node:assert');
const P = require('../src/betslip_parse');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };
const near = (a, b, tol, m) => { assert.ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ~${b})`); n++; };

// ── 1. FanDuel share card — Jack's screenshot, verbatim ───────────────────────
// The canonical case: no stake anywhere (the share card omits it on purpose), the
// price sits on the header row, and the share sheet contributes five lines of
// chrome that all look like proper nouns.
const FD_SHARE = `6:56
My Bets
$0.00
Open
Settled
Straight Bet
-136
Lorenzo Sonego
MONEYLINE
Lorenzo Sonego v James Duckworth
6:14PM ET
Share in the FanDuel Community
New Post
More ways to share
Copy image
Copy link
Messages
WhatsApp
X`;

{
  const r = P.parseBetslip(FD_SHARE);
  eq(r.book, 'FanDuel', 'fd share: book detected');
  eq(r.capture, 'share_card', 'fd share: capture type');
  eq(r.bets.length, 1, 'fd share: exactly one bet (share chrome is not a bet)');
  const b = r.bets[0];
  eq(b.bet_type, 'ml', 'fd share: moneyline');
  eq(b.selection, 'Lorenzo Sonego', 'fd share: selection');
  eq(b.odds, -136, 'fd share: odds off the header row');
  eq(b.stake, null, 'fd share: no stake on a share card');
  eq(b.line, null, 'fd share: no line on a moneyline');
  ok(b.matchup && /Duckworth/.test(b.matchup.b), 'fd share: matchup captured');
  eq(b.matchup.sep, 'v', 'fd share: separator');
  eq(b.result, null, 'fd share: pending');
  ok(b.confidence >= 0.7, 'fd share: high confidence');
  // The share-sheet app names must never survive as selections.
  ok(!r.bets.some(x => /WhatsApp|Messages|Copy link|New Post/i.test(x.selection)), 'fd share: no chrome bets');
}

// ── 2. DraftKings single with a spread + wager ────────────────────────────────
const DK_SPREAD = `DraftKings
Bet Receipt
Los Angeles Lakers -4.5
Point Spread
Los Angeles Lakers @ Boston Celtics
Today 7:30PM ET
-110
$25.00 Wager
To Win $22.73`;

{
  const r = P.parseBetslip(DK_SPREAD);
  eq(r.book, 'DraftKings', 'dk spread: book');
  eq(r.bets.length, 1, 'dk spread: one bet');
  const b = r.bets[0];
  eq(b.bet_type, 'spread', 'dk spread: type');
  eq(b.selection, 'Los Angeles Lakers', 'dk spread: team without the handicap');
  eq(b.line, -4.5, 'dk spread: line');
  eq(b.odds, -110, 'dk spread: juice');
  eq(b.stake, 25, 'dk spread: wager');
  near(b.to_win, 22.73, 0.01, 'dk spread: to win');
  eq(b.matchup.away, 'Los Angeles Lakers', 'dk spread: @ means left side is away');
  eq(b.matchup.home, 'Boston Celtics', 'dk spread: home side');
}

// ── 3. Totals — the over/under split ─────────────────────────────────────────
{
  const r = P.parseBetslip(`BetMGM
Over 8.5
Total Runs
New York Yankees @ Baltimore Orioles
-115
$20.00 Wager
To Win $17.39`);
  const b = r.bets[0];
  eq(b.bet_type, 'over', 'total: over becomes its own bet type');
  eq(b.line, 8.5, 'total: line');
  eq(b.odds, -115, 'total: juice');
  eq(b.selection, 'Over', 'total: selection reads Over');
  eq(r.book, 'BetMGM', 'total: book');
}
{
  const r = P.parseBetslip(`Caesars
Under 220.5
Total Points
Lakers @ Celtics
-108`);
  eq(r.bets[0].bet_type, 'under', 'total: under');
  eq(r.bets[0].line, 220.5, 'total: under line');
}

// ── 4. Parlay with legs ──────────────────────────────────────────────────────
const DK_PARLAY = `DraftKings
3 Leg Parlay
+596
Los Angeles Lakers -4.5
Point Spread
Lakers @ Celtics
-110
Over 220.5
Total Points
Lakers @ Celtics
-110
New York Yankees
Moneyline
Yankees @ Orioles
-150
$10.00 Wager
To Win $59.60`;

{
  const r = P.parseBetslip(DK_PARLAY);
  eq(r.bets.length, 1, 'parlay: one bet, not three');
  const b = r.bets[0];
  eq(b.bet_type, 'parlay', 'parlay: type');
  eq(b.legs.length, 3, 'parlay: three legs');
  eq(b.odds, 596, 'parlay: the book\'s own combined price wins over our product');
  eq(b.stake, 10, 'parlay: stake');
  eq(b.legs[0].bet_type, 'spread', 'parlay: leg 1 spread');
  eq(b.legs[0].line, -4.5, 'parlay: leg 1 line');
  eq(b.legs[1].bet_type, 'over', 'parlay: leg 2 over');
  eq(b.legs[1].line, 220.5, 'parlay: leg 2 line');
  eq(b.legs[2].bet_type, 'ml', 'parlay: leg 3 ml');
  eq(b.legs[2].odds, -150, 'parlay: leg 3 odds');
  ok(/3-leg parlay/.test(b.selection), 'parlay: selection label');
}

// A parlay with no printed combined price falls back to the product of its legs.
{
  const r = P.parseBetslip(`FanDuel
2 Leg Parlay
Lakers -4.5
Point Spread
-110
Yankees
Moneyline
-150`);
  const b = r.bets[0];
  eq(b.bet_type, 'parlay', 'parlay product: type');
  // -110 (1.909) x -150 (1.667) = 3.182 -> +218
  near(b.odds, 218, 2, 'parlay product: combined odds computed from legs');
}

// Same game parlay labelling.
{
  const r = P.parseBetslip(`FanDuel
Same Game Parlay
+450
Jayson Tatum 25+ Points
Player Points
-140
Celtics -4.5
Point Spread
-110`);
  const b = r.bets[0];
  eq(b.bet_type, 'parlay', 'sgp: type');
  ok(/same game parlay/.test(b.selection), 'sgp: labelled same game');
  eq(b.odds, 450, 'sgp: combined price');
  eq(b.legs[0].bet_type, 'prop', 'sgp: player prop leg');
}

// A cropped parlay header with fewer than two legs is dropped, never invented.
{
  const r = P.parseBetslip(`4 Leg Parlay
+1150
Lakers -4.5
Point Spread
-110`);
  ok(!r.bets.some(b => b.bet_type === 'parlay'), 'cropped parlay: not invented');
  eq(r.bets.length, 1, 'cropped parlay: the readable leg still lands as a straight');
}

// ── 5. Multi-bet list screenshot ─────────────────────────────────────────────
const FD_LIST = `My Bets
Open
Settled
Straight
$10.00
Lorenzo Sonego
MONEYLINE
Lorenzo Sonego v James Duckworth
6:14PM ET
-136
To Win $7.35
Straight
$25.00
Los Angeles Lakers -4.5
SPREAD
Lakers @ Celtics
7:30PM ET
-110
To Win $22.73
Straight
$15.00
Over 8.5
TOTAL RUNS
Yankees @ Orioles
7:05PM ET
-115
To Win $13.04`;

{
  const r = P.parseBetslip(FD_LIST);
  eq(r.capture, 'list', 'list: capture type');
  eq(r.bets.length, 3, 'list: three separate bets');
  eq(r.bets[0].selection, 'Lorenzo Sonego', 'list: bet 1 selection');
  eq(r.bets[0].stake, 10, 'list: bet 1 stake stays with bet 1');
  eq(r.bets[1].line, -4.5, 'list: bet 2 line');
  eq(r.bets[1].stake, 25, 'list: bet 2 stake');
  eq(r.bets[2].bet_type, 'over', 'list: bet 3 type');
  eq(r.bets[2].stake, 15, 'list: bet 3 stake');
  // The single most valuable property of the segmenter: money never crosses bets.
  ok(r.bets.every((b, i) => b.stake === [10, 25, 15][i]), 'list: no stake bleed between bets');
}

// ── 6. Settled slips ─────────────────────────────────────────────────────────
{
  const r = P.parseBetslip(`FanDuel
WON
Lorenzo Sonego
MONEYLINE
Lorenzo Sonego v James Duckworth
-136
$10.00
Total Payout $17.35`);
  const b = r.bets[0];
  eq(b.result, 'win', 'settled: win read');
  eq(b.stake, 10, 'settled: stake');
  near(b.to_win, 7.35, 0.01, 'settled: profit derived from total payout minus stake');
  eq(r.capture, 'settled', 'settled: capture type');
}
{
  eq(P.parseBetslip(`DraftKings\nLOST\nLakers -4.5\nPoint Spread\n-110\n$25.00 Wager`).bets[0].result, 'loss', 'settled: loss');
  eq(P.parseBetslip(`PUSH\nLakers -4\nPoint Spread\n-110`).bets[0].result, 'push', 'settled: push');
  eq(P.parseBetslip(`Cashed Out\nLakers -4.5\nPoint Spread\n-110`).bets[0].result, 'void', 'settled: cash out is not a graded win');
  eq(P.parseBetslip(`VOID\nLakers -4.5\nPoint Spread\n-110`).bets[0].result, 'void', 'settled: void');
}

// ── 7. Odds vs lines — the confusion that ruins a record ─────────────────────
{
  eq(P.americanIn('Lorenzo Sonego -136').map(o => o.value)[0], -136, 'odds: three digits with a sign');
  eq(P.americanIn('Lakers -4.5').length, 0, 'odds: a decimal is never a price');
  eq(P.americanIn('Lakers -7').length, 0, 'odds: two digits is a line, not a price');
  eq(P.americanIn('Parlay +1150').map(o => o.value)[0], 1150, 'odds: four digits');
  eq(P.americanIn('6:14PM ET').length, 0, 'odds: a kickoff time is not a price');
  eq(P.americanIn('Won 2024').length, 0, 'odds: an unsigned year is not a price');
  eq(P.handicapIn('Lakers -4.5').map(h => h.value)[0], -4.5, 'line: signed decimal');
  eq(P.handicapIn('Lakers +7').map(h => h.value)[0], 7, 'line: signed integer under 100');
  eq(P.handicapIn('Sonego -136').length, 0, 'line: a price is not a handicap');
}

// Even money and fractional prices.
{
  eq(P.parseBetslip(`Lakers\nMoneyline\nEVEN`).bets[0].odds, 100, 'odds: EVEN is +100');
  eq(P.parseBetslip(`bet365\nArsenal\nMatch Result\n5/2`).bets[0].odds, 250, 'odds: fractional 5/2 -> +250');
  eq(P.parseBetslip(`bet365\nArsenal\nMatch Result\n1/2`).bets[0].odds, -200, 'odds: fractional 1/2 -> -200');
}

// Price recovered from the money when the odds got cropped.
{
  const r = P.parseBetslip(`FanDuel\nLakers\nMoneyline\n$100.00 Wager\nTo Win $250.00`);
  eq(r.bets[0].odds, 250, 'odds: derived from stake and profit when the price is missing');
}
{
  eq(P.oddsFromMoney(25, 22.73), -110, 'oddsFromMoney: favourite');
  eq(P.oddsFromMoney(10, 25), 250, 'oddsFromMoney: underdog');
  eq(P.oddsFromMoney(0, 10), null, 'oddsFromMoney: no stake');
}

// ── 8. Chrome rejection ──────────────────────────────────────────────────────
{
  ['Open', 'Settled', 'My Bets', 'Copy link', 'WhatsApp', 'New Post', 'More ways to share',
   '$0.00', 'Cash Out', '6:56', 'Deposit', 'Share in the FanDuel Community']
    .forEach(c => ok(P.isChrome(c), `chrome: "${c}" rejected`));
  ['Lorenzo Sonego', 'Los Angeles Lakers -4.5', 'Over 8.5']
    .forEach(c => ok(!P.isChrome(c), `chrome: "${c}" kept`));
}

// ── 9. Markets ───────────────────────────────────────────────────────────────
{
  eq(P.marketOf('MONEYLINE'), 'ml', 'market: moneyline');
  eq(P.marketOf('Money Line'), 'ml', 'market: money line spaced');
  eq(P.marketOf('Point Spread'), 'spread', 'market: point spread');
  eq(P.marketOf('Run Line'), 'spread', 'market: run line');
  eq(P.marketOf('Puck Line'), 'spread', 'market: puck line');
  eq(P.marketOf('Asian Handicap'), 'spread', 'market: asian handicap');
  eq(P.marketOf('Total Points'), 'total', 'market: total points');
  eq(P.marketOf('Totals'), 'total', 'market: totals');
  eq(P.marketOf('Over/Under'), 'total', 'market: over/under');
  eq(P.marketOf('Alternate Spread'), 'spread', 'market: alt spread');
  eq(P.marketOf('Anytime Touchdown Scorer'), 'prop', 'market: prop');
  eq(P.marketOf('Strikeouts'), 'prop', 'market: strikeouts prop');
  eq(P.marketOf('Lorenzo Sonego'), null, 'market: a player name is not a market');
  eq(P.marketOf('Lakers @ Celtics'), null, 'market: a matchup is not a market');
}

// ── 10. Matchups ─────────────────────────────────────────────────────────────
{
  const m = P.matchupOf('Lakers @ Celtics');
  eq(m.away, 'Lakers', 'matchup: @ sets away');
  eq(m.home, 'Celtics', 'matchup: @ sets home');
  const t = P.matchupOf('Lorenzo Sonego v James Duckworth');
  eq(t.a, 'Lorenzo Sonego', 'matchup: v separator left');
  eq(t.home, null, 'matchup: v carries no home/away information');
  eq(P.matchupOf('Lakers -4.5'), null, 'matchup: a priced selection is not a matchup');
  eq(P.matchupOf('To Win $22.73'), null, 'matchup: money is not a matchup');
  ok(P.matchupOf('Arsenal vs Chelsea'), 'matchup: vs');
  ok(P.matchupOf('Real Madrid - Barcelona'), 'matchup: dash between two wordy sides');
}

// ── 10b. Merged columns on the matchup row ───────────────────────────────────
// REGRESSION, found by running real Tesseract over a rendered My Bets list on
// 2026-08-26. Books right-align "To Win $X" onto the SAME visual row as the
// matchup, and OCR emits one merged line. Rejecting any line carrying money lost
// the matchup on every bet, which only SHOWED on totals: a total's selection is
// just "Over 174.5", so the matchup is the only thing that can name its game.
{
  const m = P.matchupOf('Toronto Tempo @ Seattle Storm To Win $13.64');
  ok(m, 'merged row: matchup still found behind the To Win column');
  eq(m.away, 'Toronto Tempo', 'merged row: away');
  eq(m.home, 'Seattle Storm', 'merged row: home');

  ok(P.matchupOf('Lakers @ Celtics 7:30PM ET'), 'merged row: start time tail cut');
  ok(P.matchupOf('Lakers @ Celtics $25.00'), 'merged row: bare amount cut');
  ok(P.matchupOf('Yankees @ Orioles Total Payout $47.73'), 'merged row: total payout cut');
  ok(P.matchupOf('Arsenal vs Chelsea Cash Out'), 'merged row: cash out cut');

  // The tail cut must not turn a priced SELECTION into a matchup.
  eq(P.matchupOf('Seattle Storm -6.5 -110'), null, 'merged row: a priced selection is still not a matchup');
  eq(P.matchupOf('Over 174.5 -110'), null, 'merged row: a total selection is still not a matchup');
  eq(P.matchupOf('To Win $22.73'), null, 'merged row: a bare money label is still not a matchup');
}

// The full three-bet list exactly as Tesseract emitted it, columns merged.
{
  const r = P.parseBetslip(`My Bets
Open Settled
Straight $25.00
Seattle Storm -238
MONEYLINE
Toronto Tempo @ Seattle Storm To Win $10.50
Straight $50.00
Seattle Storm -6.5 -110
SPREAD
Toronto Tempo @ Seattle Storm To Win $45.45
Straight $15.00
Over 174.5 -110
TOTAL POINTS
Toronto Tempo @ Seattle Storm To Win $13.64
Share in the FanDuel Community`);
  eq(r.bets.length, 3, 'ocr list: three bets');
  eq(r.book, 'FanDuel', 'ocr list: book');
  eq(r.bets[0].bet_type, 'ml', 'ocr list: bet 1 ml');
  eq(r.bets[0].odds, -238, 'ocr list: bet 1 odds');
  eq(r.bets[0].stake, 25, 'ocr list: bet 1 stake');
  near(r.bets[0].to_win, 10.50, 0.01, 'ocr list: bet 1 to win');
  eq(r.bets[1].bet_type, 'spread', 'ocr list: bet 2 spread');
  eq(r.bets[1].line, -6.5, 'ocr list: bet 2 line');
  eq(r.bets[1].stake, 50, 'ocr list: bet 2 stake');
  eq(r.bets[2].bet_type, 'over', 'ocr list: bet 3 over');
  eq(r.bets[2].line, 174.5, 'ocr list: bet 3 line');
  eq(r.bets[2].stake, 15, 'ocr list: bet 3 stake');
  // The one that actually broke: every bet keeps its OWN matchup.
  ok(r.bets.every(b => b.matchup), 'ocr list: every bet kept a matchup');
  ok(r.bets[2].matchup && r.bets[2].matchup.home === 'Seattle Storm',
     'ocr list: the TOTAL has a matchup, which is its only route to a game');
}

// ── 11. OCR damage ───────────────────────────────────────────────────────────
// O-for-zero and l-for-one inside numeric tokens, which is what a dark-mode
// screenshot at low resolution actually produces.
{
  const r = P.parseBetslip(`FanDuel\nStraight Bet\n-l36\nLorenzo Sonego\nMONEYLINE`);
  eq(r.bets[0].odds, -136, 'ocr: l repaired to 1 inside a price');
  const r2 = P.parseBetslip(`DraftKings\nLakers -4.5\nPoint Spread\n-11O\n$25.OO Wager`);
  eq(r2.bets[0].odds, -110, 'ocr: O repaired to 0 inside a price');
  eq(r2.bets[0].stake, 25, 'ocr: O repaired inside an amount');
  // A team whose name legitimately contains those letters must survive untouched.
  eq(P.parseBetslip(`Toronto Blue Jays\nMoneyline\n-150`).bets[0].selection, 'Toronto Blue Jays', 'ocr: letters in a name are left alone');
}

// Unicode minus signs from a rendered share card.
{
  eq(P.parseBetslip(`Lorenzo Sonego\nMONEYLINE\n−136`).bets[0].odds, -136, 'signs: unicode minus');
  eq(P.parseBetslip(`Lakers –4.5\nPoint Spread\n-110`).bets[0].line, -4.5, 'signs: en dash as minus');
}

// ── 12. Blocks path (Apple Vision / ML Kit) ──────────────────────────────────
// Vision returns positioned words. The selection and its price sit on ONE visual
// row but arrive as separate items; regrouping is what puts them back together.
{
  const blocks = [
    { text: 'Straight', x: 0.08, y: 0.10, width: 0.18, height: 0.03 },
    { text: 'Bet',      x: 0.27, y: 0.10, width: 0.07, height: 0.03 },
    { text: '-136',     x: 0.82, y: 0.105, width: 0.12, height: 0.03 },
    { text: 'Lorenzo',  x: 0.08, y: 0.18, width: 0.16, height: 0.03 },
    { text: 'Sonego',   x: 0.25, y: 0.18, width: 0.14, height: 0.03 },
    { text: 'MONEYLINE', x: 0.08, y: 0.23, width: 0.22, height: 0.02 },
  ];
  const rows = P.linesFromBlocks(blocks);
  eq(rows[0], 'Straight Bet -136', 'blocks: header and price rejoined on one row');
  eq(rows[1], 'Lorenzo Sonego', 'blocks: name rejoined');
  eq(rows[2], 'MONEYLINE', 'blocks: market row');
  const r = P.parseBetslip({ text: 'ignored', blocks });
  eq(r.bets[0].odds, -136, 'blocks: parsed through the blocks path');
  eq(r.bets[0].selection, 'Lorenzo Sonego', 'blocks: selection');
}

// Blocks in pixel space (ML Kit) rather than normalized space.
{
  const blocks = [
    { text: 'Lakers', x: 40, y: 300, w: 120, h: 34 },
    { text: '-4.5',   x: 170, y: 302, w: 60, h: 34 },
    { text: '-110',   x: 900, y: 301, w: 80, h: 34 },
    { text: 'Point',  x: 40, y: 350, w: 90, h: 28 },
    { text: 'Spread', x: 135, y: 350, w: 100, h: 28 },
  ];
  const rows = P.linesFromBlocks(blocks);
  eq(rows[0], 'Lakers -4.5 -110', 'blocks px: full row rejoined');
  eq(rows[1], 'Point Spread', 'blocks px: market row');
  const r = P.parseBetslip({ blocks });
  eq(r.bets[0].line, -4.5, 'blocks px: line');
  eq(r.bets[0].odds, -110, 'blocks px: odds');
}

// ── 13. Degenerate input ─────────────────────────────────────────────────────
{
  eq(P.parseBetslip('').bets.length, 0, 'empty: no bets');
  ok(P.parseBetslip('').warnings.includes('no_bet_found'), 'empty: warned');
  eq(P.parseBetslip('just some random words about nothing').bets.length, 0, 'noise: no bets');
  eq(P.parseBetslip({ text: null, blocks: null }).bets.length, 0, 'null input: no bets');
  eq(P.parseBetslip({ blocks: [] }).bets.length, 0, 'empty blocks: no bets');
  // A photo of a menu should not mint a bet.
  eq(P.parseBetslip('Cheeseburger 12.00\nFries 4.50\nTotal 16.50').bets.length, 0, 'menu: no bets');
}

// ── 14. Confidence ───────────────────────────────────────────────────────────
{
  const full = P.parseBetslip(DK_SPREAD).bets[0];
  ok(full.confidence >= 0.85, 'confidence: a complete slip scores high');
  const thin = P.parseBetslip('Lakers\nMoneyline').bets[0];
  ok(thin.confidence < 0.55, 'confidence: no price scores low');
  ok(thin.confidence > 0, 'confidence: a readable selection is not zero');
}

// ── 15. Book detection across the field ──────────────────────────────────────
{
  const cases = [
    ['Share in the FanDuel Community', 'FanDuel'],
    ['DraftKings Sportsbook', 'DraftKings'],
    ['BetMGM', 'BetMGM'], ['Caesars Sportsbook', 'Caesars'],
    ['ESPN BET', 'ESPN BET'], ['Fanatics Sportsbook', 'Fanatics'],
    ['bet365', 'bet365'], ['Hard Rock Bet', 'Hard Rock'],
    ['BetRivers', 'BetRivers'], ['Bovada', 'Bovada'], ['Pinnacle', 'Pinnacle'],
    ['Kalshi', 'Kalshi'], ['Polymarket', 'Polymarket'],
  ];
  for (const [text, want] of cases) {
    eq(P.parseBetslip(`${text}\nLakers\nMoneyline\n-150`).book, want, `book: ${want}`);
  }
  eq(P.parseBetslip('Lakers\nMoneyline\n-150').book, null, 'book: unknown stays null');
}

// ── 16. Selection cleanup ────────────────────────────────────────────────────
{
  eq(P.cleanSelection('Lorenzo Sonego -136'), 'Lorenzo Sonego', 'clean: price stripped');
  eq(P.cleanSelection('Lakers -4.5  $25.00'), 'Lakers -4.5', 'clean: money stripped, line kept');
  eq(P.cleanSelection('WON  Lakers -4.5'), 'Lakers -4.5', 'clean: result badge stripped');
  const s = P.splitSelection('Los Angeles Lakers -4.5', 'spread');
  eq(s.side_name, 'Los Angeles Lakers', 'split: team');
  eq(s.line, -4.5, 'split: line');
  const t = P.splitSelection('Over 220.5', 'total');
  eq(t.total_side, 'over', 'split: over side');
  eq(t.line, 220.5, 'split: total line');
  const tt = P.splitSelection('Lakers Team Total Over 110.5', 'total');
  eq(tt.total_side, 'over', 'split: team total side');
  eq(tt.line, 110.5, 'split: team total line');
}

// ── 17. A REAL Apple Vision payload ──────────────────────────────────────────
// Not transcribed, not imagined: captured out of the App Group container after a
// genuine share-sheet run through CappingAlphaShare on the iOS Simulator
// (2026-08-26). This is the single highest-fidelity fixture we have, because it
// is exactly what the device hands the parser.
//
// Note what Vision's READING ORDER does to the plain text: it emits "-136" after
// the matchup line, nowhere near the "Straight Bet" header it visually sits on.
// The blocks path exists to undo precisely that.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vision_fanduel_share.json'), 'utf8'));

  // The visual rows, rebuilt from the word boxes.
  const rows = P.linesFromBlocks(raw.blocks);
  eq(rows[2], 'Straight Bet -136', 'vision: header and price back on one row');
  eq(rows[3], 'Lorenzo Sonego', 'vision: selection row');
  eq(rows[4], 'MONEYLINE', 'vision: market row');
  eq(rows[5], 'Lorenzo Sonego v James Duckworth 6:14PM ET', 'vision: matchup and start time on one row');

  const b = P.parseBetslip({ text: raw.text, blocks: raw.blocks });
  eq(b.book, 'FanDuel', 'vision: book');
  eq(b.capture, 'share_card', 'vision: share card');
  eq(b.bets.length, 1, 'vision: exactly one bet out of the whole share sheet');
  eq(b.bets[0].bet_type, 'ml', 'vision: moneyline');
  eq(b.bets[0].selection, 'Lorenzo Sonego', 'vision: selection');
  eq(b.bets[0].odds, -136, 'vision: odds');
  eq(b.bets[0].stake, null, 'vision: a share card carries no stake');
  ok(b.bets[0].matchup && /Duckworth/.test(b.bets[0].matchup.b), 'vision: matchup');
  ok(b.bets[0].confidence >= 0.85, 'vision: high confidence');

  // The text-only path (no boxes) must still work, because the browser reader
  // never produces boxes.
  const t = P.parseBetslip({ text: raw.text });
  eq(t.bets.length, 1, 'vision text-only: one bet');
  eq(t.bets[0].odds, -136, 'vision text-only: odds survive the scrambled order');
  eq(t.bets[0].selection, 'Lorenzo Sonego', 'vision text-only: selection');
}

console.log(`betslip_parse.test.js: ${n} assertions passed`);
