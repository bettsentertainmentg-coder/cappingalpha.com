// test/win_prob.test.js — run: node test/win_prob.test.js
const assert = require('node:assert');
const { liveHomeWinProb, tableHomeWP, gameProgress } = require('../src/win_prob');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// Boundary: first pitch ~= pre-game prob.
const fp = { inning: 1, half: 'top', outs: 0, bases: 0, homeScore: 0, awayScore: 0 };
ok(Math.abs(liveHomeWinProb(fp, 0.65) - 0.65) < 0.03, 'first pitch ~= pregame 0.65');
ok(Math.abs(liveHomeWinProb(fp, 0.50) - 0.50) < 0.03, 'first pitch ~= pregame 0.50');

// Monotonic in score (mid game, home batting, no anchor via table).
const mid = (h, a) => tableHomeWP({ inning: 5, half: 'bot', outs: 1, bases: 0, homeScore: h, awayScore: a });
ok(mid(3, 0) > mid(1, 0) && mid(1, 0) > mid(0, 0) && mid(0, 0) > mid(0, 1), 'WP rises with home lead');

// Outs: home batting bot 6, runner on 2nd; fewer outs better.
const outsWP = (o) => tableHomeWP({ inning: 6, half: 'bot', outs: o, bases: 2, homeScore: 0, awayScore: 0 });
ok(outsWP(0) > outsWP(1) && outsWP(1) > outsWP(2), 'WP falls with outs (home batting)');

// Base state: runner on 3rd, 0 out beats empty, 0 out for the batting team.
ok(tableHomeWP({ inning: 6, half: 'bot', outs: 0, bases: 4, homeScore: 0, awayScore: 0 }) >
   tableHomeWP({ inning: 6, half: 'bot', outs: 0, bases: 0, homeScore: 0, awayScore: 0 }),
   'runner on 3rd helps the batting team');

// Blowouts late -> ~0 / ~1.
const lateDown = liveHomeWinProb({ inning: 8, half: 'top', outs: 0, bases: 0, homeScore: 0, awayScore: 10 }, 0.5);
const lateUp   = liveHomeWinProb({ inning: 8, half: 'top', outs: 0, bases: 0, homeScore: 10, awayScore: 0 }, 0.5);
ok(lateDown < 0.06, 'down 10 in 8th -> ~0');
ok(lateUp   > 0.94, 'up 10 in 8th -> ~1');

// Buy-low shape: strong home down 1 early still > 50%; same deficit late is worse.
const earlyDown = liveHomeWinProb({ inning: 2, half: 'top', outs: 0, bases: 0, homeScore: 0, awayScore: 1 }, 0.65);
const lateDown1 = liveHomeWinProb({ inning: 9, half: 'top', outs: 2, bases: 0, homeScore: 0, awayScore: 1 }, 0.65);
ok(earlyDown > 0.5, 'strong home down 1 early still > 50% (prior holds)');
ok(lateDown1 < earlyDown, 'same 1-run deficit later is worse (prior faded)');

// Bounded.
for (const wp of [earlyDown, lateDown1, lateUp, lateDown]) ok(wp > 0 && wp < 1, 'win prob bounded (0,1)');

// gameProgress.
ok(gameProgress({ inning: 1, half: 'top', outs: 0 }) < 0.02, 'gp ~0 at first pitch');
const gpEnd = gameProgress({ inning: 9, half: 'bot', outs: 2 });
ok(gpEnd > 0.95 && gpEnd <= 0.98, 'gp ~1 near the end');

// liveOverProb: line-anchored early, pace-driven late.
const { liveOverProb } = require('../src/win_prob');
ok(Math.abs(liveOverProb(0, 8.5, 0.02) - 0.5) < 0.05, 'over ~50% at first pitch');
ok(liveOverProb(10, 8.5, 0.5) > 0.6, 'well over pace by midgame -> over likely');
ok(liveOverProb(1, 8.5, 0.6) < 0.4, 'well under pace late -> over unlikely');
ok(liveOverProb(5, 0, 0.5) === null, 'no line -> null');

console.log(`win_prob.test.js: ${n} assertions passed`);
