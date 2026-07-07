// test/win_prob_generic.test.js — run: node test/win_prob_generic.test.js
const assert = require('node:assert');
const {
  parseClockSec, genericProgress, clockHomeWP, anchoredWP, soccerProbs, genericOverProb, mlbCountAdjust,
} = require('../src/win_prob_generic');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// ── parseClockSec ──────────────────────────────────────────────────────────────
ok(parseClockSec('7:42') === 462, 'MM:SS parses');
ok(parseClockSec('12:00') === 720, 'quarter start parses');
ok(parseClockSec('24.7') === 24, 'sub-minute tenths parse');
ok(parseClockSec('0.0') === 0, 'zero clock parses');
ok(parseClockSec("45'") === 2700, 'soccer minute parses');
ok(parseClockSec("45'+2'") === 2820, 'soccer stoppage parses');
ok(parseClockSec('Halftime') === null, 'garbage clock -> null');
ok(parseClockSec(null) === null, 'null clock -> null');

// ── genericProgress ────────────────────────────────────────────────────────────
ok(genericProgress('NFL', 1, '15:00') === 0, 'NFL kickoff -> 0');
ok(Math.abs(genericProgress('NFL', 3, '7:30') - (2 * 900 + 450) / 3600) < 0.01, 'NFL mid Q3');
ok(genericProgress('NFL', 4, '0:00') === 0.98, 'NFL final gun clamps to 0.98');
ok(genericProgress('NFL', 5, '10:00') === 0.98, 'NFL OT pins at 0.98');
ok(genericProgress('NBA', 2, 'Halftime') === Math.min(0.98, 1440 / 2880), 'unparseable clock reads as period over');
ok(Math.abs(genericProgress('CBB', 2, '20:00') - 0.5) < 0.01, 'CBB start of 2nd half = 0.5');
ok(Math.abs(genericProgress('SOCCER', 1, "30'") - 1800 / 5400) < 0.01, 'soccer 30th minute');
ok(Math.abs(genericProgress('SOCCER', 1, "45'+4'") - 2700 / 5400) < 0.01, 'first-half stoppage clamps at 45');
ok(genericProgress('SOCCER', 3, "91'") === 0.98, 'soccer extra time pins at 0.98');
ok(genericProgress('NOPE', 2, '5:00') === 0, 'unknown sport -> 0');

// ── clockHomeWP ────────────────────────────────────────────────────────────────
ok(clockHomeWP('hockey', 2, 0, 0.5) > clockHomeWP('hockey', 1, 0, 0.5), 'WP rises with lead (NHL)');
ok(clockHomeWP('hockey', 1, 0, 0.9) > clockHomeWP('hockey', 1, 0, 0.3), 'same lead worth more later');
ok(clockHomeWP('basketball', 0, 10, 0.9) < 0.15, 'down 10 late (hoops) -> low');
ok(clockHomeWP('football', 0, 0, 0.1) > 0.5, 'level game keeps a small home edge');
const bounded = [clockHomeWP('hockey', 8, 0, 0.97), clockHomeWP('football', 0, 40, 0.97)];
for (const w of bounded) ok(w > 0 && w < 1, 'clock WP bounded (0,1)');

// ── anchoredWP ─────────────────────────────────────────────────────────────────
ok(Math.abs(anchoredWP(0.52, 0.70, 0) - 0.70) < 0.04, 'at t=0 the anchor ~= pregame');
ok(Math.abs(anchoredWP(0.52, 0.70, 0.98) - 0.52) < 0.03, 'late the table dominates');
ok(anchoredWP(0.52, null, 0.3) === 0.52, 'no prior -> table');

// ── soccerProbs ────────────────────────────────────────────────────────────────
const lvl0 = soccerProbs({ homeScore: 0, awayScore: 0, progress: 0, preHome3: null });
ok(Math.abs(lvl0.home + lvl0.away + lvl0.draw - 1) < 1e-9, '3-way probs sum to 1');
const lvlLate = soccerProbs({ homeScore: 1, awayScore: 1, progress: 0.9, preHome3: null });
ok(lvlLate.draw > lvl0.draw, 'level match late -> draw more likely');
const up2 = soccerProbs({ homeScore: 2, awayScore: 0, progress: 0.5, preHome3: null });
ok(up2.draw < lvl0.draw, 'draw collapses with a 2-goal lead');
ok(up2.home > 0.7, 'two up at the hour is a strong favorite');
const anchored = soccerProbs({ homeScore: 0, awayScore: 0, progress: 0, preHome3: 0.55 });
ok(Math.abs(anchored.home - 0.55) < 0.06, 'pregame anchor holds at kickoff');
ok(anchored.home > lvl0.home, 'favorite anchor lifts the home leg');

// ── genericOverProb ────────────────────────────────────────────────────────────
ok(genericOverProb(0, 220.5, 0.05, 'basketball') === 0.5, 'too early -> 50%');
ok(genericOverProb(140, 220.5, 0.5, 'basketball') > 0.6, 'over pace midgame -> over likely');
ok(genericOverProb(80, 220.5, 0.6, 'basketball') < 0.4, 'under pace late -> over unlikely');
ok(genericOverProb(3, null, 0.5, 'hockey') === null, 'no line -> null');
ok(genericOverProb(4, 2.5, 0.6, 'soccer') > 0.7, 'goals flying in -> over likely');

// ── mlbCountAdjust ─────────────────────────────────────────────────────────────
const base = 0.60;
const st30 = { inning: 7, half: 'bot', outs: 1, bases: 2, balls: 3, strikes: 0 };   // hitter's count, home batting
const st02 = { inning: 7, half: 'bot', outs: 1, bases: 2, balls: 0, strikes: 2 };   // pitcher's count
ok(mlbCountAdjust(base, st30) > base, 'hitters count nudges home up (home batting)');
ok(mlbCountAdjust(base, st02) < base, 'pitchers count nudges home down (home batting)');
ok(mlbCountAdjust(null, st30) === null, 'null passes through');
ok(Math.abs(mlbCountAdjust(base, { ...st30, balls: 0, strikes: 0 }) - base) < 1e-9, '0-0 count is neutral');

console.log(`win_prob_generic.test.js: ${n} assertions passed`);
