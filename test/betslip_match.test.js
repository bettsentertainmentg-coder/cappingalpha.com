// test/betslip_match.test.js — run: node test/betslip_match.test.js
//
// Matching a parsed slip onto a real game. The fixtures below are shaped exactly
// like today_games rows (the name-variant columns are what the matcher reads).
const assert = require('node:assert');
const M = require('../src/betslip_match');
const { parseBetslip } = require('../src/betslip_parse');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

// ── A board with the traps on it ─────────────────────────────────────────────
// Toronto appears three times across three sports, which is the city-overlap trap
// that already bites the Discord reader (see reader_rules.js). Two Lakers-ish
// names and a doubleheader are in here too.
const GAMES = [
  { espn_game_id: 'g-nba-1', sport: 'NBA', status: 'pre', start_time: '2026-08-27 23:30:00',
    home_team: 'Boston Celtics', home_short: 'Celtics', home_name: 'Celtics', home_abbr: 'BOS',
    away_team: 'Los Angeles Lakers', away_short: 'Lakers', away_name: 'Lakers', away_abbr: 'LAL' },
  { espn_game_id: 'g-mlb-1', sport: 'MLB', status: 'pre', start_time: '2026-08-27 23:05:00',
    home_team: 'Baltimore Orioles', home_short: 'Orioles', home_name: 'Orioles', home_abbr: 'BAL',
    away_team: 'New York Yankees', away_short: 'Yankees', away_name: 'Yankees', away_abbr: 'NYY' },
  { espn_game_id: 'g-mlb-tor', sport: 'MLB', status: 'pre', start_time: '2026-08-27 23:07:00',
    home_team: 'Toronto Blue Jays', home_short: 'Blue Jays', home_name: 'Blue Jays', home_abbr: 'TOR',
    away_team: 'Tampa Bay Rays', away_short: 'Rays', away_name: 'Rays', away_abbr: 'TB' },
  { espn_game_id: 'g-mls-tor', sport: 'Soccer', status: 'pre', start_time: '2026-08-27 23:30:00',
    home_team: 'Toronto FC', home_short: 'Toronto', home_name: 'Toronto FC', home_abbr: 'TOR',
    away_team: 'Inter Miami', away_short: 'Miami', away_name: 'Inter Miami', away_abbr: 'MIA' },
  { espn_game_id: 'g-nhl-tor', sport: 'NHL', status: 'pre', start_time: '2026-08-27 23:00:00',
    home_team: 'Toronto Maple Leafs', home_short: 'Maple Leafs', home_name: 'Maple Leafs', home_abbr: 'TOR',
    away_team: 'Montreal Canadiens', away_short: 'Canadiens', away_name: 'Canadiens', away_abbr: 'MTL' },
  { espn_game_id: 'g-atp-1', sport: 'ATP', status: 'pre', start_time: '2026-08-26 22:14:00',
    home_team: 'Lorenzo Sonego', home_short: 'Sonego', home_name: 'Sonego', home_abbr: 'SON',
    away_team: 'James Duckworth', away_short: 'Duckworth', away_name: 'Duckworth', away_abbr: 'DUC' },
  { espn_game_id: 'g-atp-2', sport: 'ATP', status: 'pre', start_time: '2026-08-27 15:00:00',
    home_team: 'Nicolas Jarry', home_short: 'Jarry', home_name: 'Jarry', home_abbr: 'JAR',
    away_team: 'Alexander Zverev', away_short: 'Zverev', away_name: 'Zverev', away_abbr: 'ZVE' },
];

const first = (text) => parseBetslip(text).bets[0];

// ── 1. Jack's FanDuel card, end to end ───────────────────────────────────────
{
  const bet = first(`Straight Bet
-136
Lorenzo Sonego
MONEYLINE
Lorenzo Sonego v James Duckworth
6:14PM ET
Share in the FanDuel Community`);
  const m = M.matchBet(bet, GAMES);
  eq(m.espn_game_id, 'g-atp-1', 'fd card: matched the tennis match');
  eq(m.side, 'home', 'fd card: Sonego is the home side');
  eq(m.slot, 'home_ml', 'fd card: slot');
  eq(m.sport, 'ATP', 'fd card: sport');
  ok(m.score >= 0.9, 'fd card: strong score');
  eq(m.ambiguous, false, 'fd card: unambiguous');
}

// ── 2. Team sport with @ ─────────────────────────────────────────────────────
{
  const bet = first(`Los Angeles Lakers -4.5
Point Spread
Los Angeles Lakers @ Boston Celtics
-110`);
  const m = M.matchBet(bet, GAMES);
  eq(m.espn_game_id, 'g-nba-1', 'nba: matched');
  eq(m.side, 'away', 'nba: Lakers are the visitor');
  eq(m.slot, 'away_spread', 'nba: slot');
}

// Short name only, no matchup line.
{
  const m = M.matchBet(first(`Celtics\nMoneyline\n-180`), GAMES);
  eq(m.espn_game_id, 'g-nba-1', 'short name: matched');
  eq(m.slot, 'home_ml', 'short name: home slot');
}

// ── 3. Totals ride the matchup line ──────────────────────────────────────────
// The selection is just "Over", so without the matchup there is nothing to match
// on. This is the case that justifies how hard the parser works to keep it.
{
  const bet = first(`Over 8.5
Total Runs
New York Yankees @ Baltimore Orioles
-115`);
  const m = M.matchBet(bet, GAMES);
  eq(m.espn_game_id, 'g-mlb-1', 'total: matched via the matchup line');
  eq(m.slot, 'over', 'total: over slot');
  eq(m.side, null, 'total: no team side');
  eq(m.sport, 'MLB', 'total: sport');
}
{
  const m = M.matchBet(first(`Under 220.5\nTotal Points\nLakers @ Celtics\n-108`), GAMES);
  eq(m.slot, 'under', 'total: under slot');
  eq(m.espn_game_id, 'g-nba-1', 'total: under matched');
}
// A total with no matchup cannot be placed, and must not guess.
{
  const m = M.matchBet(first(`Over 8.5\nTotal Runs\n-115`), GAMES);
  eq(m.espn_game_id, null, 'total: no matchup means no match, not a guess');
}

// ── 4. The Toronto trap ──────────────────────────────────────────────────────
// Three Torontos on the board. The market label is the only thing separating them.
{
  const mlb = M.matchBet(first(`Toronto Blue Jays\nMoneyline\n-150`), GAMES);
  eq(mlb.espn_game_id, 'g-mlb-tor', 'toronto: Blue Jays -> MLB');

  const nhl = M.matchBet(first(`Toronto Maple Leafs\nMoneyline\n-150`), GAMES);
  eq(nhl.espn_game_id, 'g-nhl-tor', 'toronto: Maple Leafs -> NHL');

  const soccer = M.matchBet(first(`Toronto FC\nMatch Result\n+120`), GAMES);
  eq(soccer.espn_game_id, 'g-mls-tor', 'toronto: Toronto FC -> Soccer');

  // "Toronto" alone against a run line: the MLB hint has to break the tie.
  const runline = M.matchBet(first(`Toronto -1.5\nRun Line\n+150`), GAMES);
  eq(runline.sport, 'MLB', 'toronto: run line pins it to baseball');

  const puckline = M.matchBet(first(`Toronto -1.5\nPuck Line\n+180`), GAMES);
  eq(puckline.sport, 'NHL', 'toronto: puck line pins it to hockey');
}

// ── 5. Unmatched cases stay unmatched ────────────────────────────────────────
{
  const m = M.matchBet(first(`Kansas City Chiefs\nMoneyline\n-150`), GAMES);
  eq(m.espn_game_id, null, 'absent team: no match');
  eq(m.slot, null, 'absent team: no slot');

  // A player prop is readable but never slot-gradable.
  const p = M.matchBet(first(`Jayson Tatum 25+ Points\nPlayer Points\nLakers @ Celtics\n-140`), GAMES);
  eq(p.slot, null, 'prop: no slot even when the game matches');
  eq(p.espn_game_id, 'g-nba-1', 'prop: game still identified from the matchup');
}

// The share-sheet chrome must never match a team. "X" is the killer: a naive
// substring matcher hits half the board with it.
{
  eq(M.nameScore('X', 'Boston Celtics'), 0, 'chrome: X matches nothing');
  eq(M.nameScore('Messages', 'Los Angeles Lakers'), 0, 'chrome: Messages matches nothing');
  eq(M.nameScore('Copy link', 'Toronto FC'), 0, 'chrome: Copy link matches nothing');
  // A single shared filler word ("New") scores something, but must stay well under
  // the claim threshold: one common token is not evidence of a team.
  ok(M.nameScore('New Post', 'New York Yankees') < M.MATCH_MIN, 'chrome: New Post cannot claim the Yankees');
  ok(M.nameScore('Los Angeles', 'Los Angeles Lakers') < 1, 'chrome: a bare city is not the team');
}

// ── 6. Name scoring ──────────────────────────────────────────────────────────
{
  eq(M.nameScore('Lakers', 'Lakers'), 1, 'score: exact');
  ok(M.nameScore('Los Angeles Lakers', 'Lakers') >= 0.85, 'score: long name vs short variant');
  ok(M.nameScore('Sonego', 'Lorenzo Sonego') >= 0.85, 'score: surname vs full name');
  ok(M.nameScore('Yankees', 'Yankee') >= 0.9, 'score: plural stemming');
  eq(M.nameScore('LAL', 'LAL'), 1, 'score: identical abbreviation is exact');
  ok(M.nameScore('lal', 'LAL') >= 0.95, 'score: abbreviation case-insensitive');
  eq(M.nameScore('BOS', 'LAL'), 0, 'score: wrong abbreviation');
  ok(M.nameScore('Nicolas Jarry', 'Nicolás Jarry') === 1, 'score: accents folded');
  ok(M.nameScore('Inter Miami', 'Miami') >= 0.85, 'score: club vs short');
  // Two different teams sharing a city word must not match on it alone.
  ok(M.nameScore('New York Yankees', 'New York Mets') < 0.62, 'score: shared city is not a match');
}

// ── 6b. The matchup line out-ranks a name-only match ─────────────────────────
// REGRESSION, found against the live board on 2026-08-26. A player on two games
// in the same window scores 1.0 on the selection alone for BOTH, so a matcher that
// max()'s the matchup in instead of adding it cannot separate them: a slip reading
// "Jacob Fearnley v Jurij Rodionov" tied with a different, already-finished
// Fearnley match and lost the coin flip. Naming both sides has to win.
{
  const twoGames = [
    { espn_game_id: 'done', sport: 'ATP', status: 'post', start_time: '2026-08-26 18:00:00',
      home_team: 'Jacob Fearnley', home_short: 'Fearnley', home_abbr: 'FEA',
      away_team: 'Luka Pavlovic', away_short: 'Pavlovic', away_abbr: 'PAV' },
    { espn_game_id: 'next', sport: 'ATP', status: 'pre', start_time: '2026-08-27 15:00:00',
      home_team: 'Jacob Fearnley', home_short: 'Fearnley', home_abbr: 'FEA',
      away_team: 'Jurij Rodionov', away_short: 'Rodionov', away_abbr: 'ROD' },
  ];
  const m = M.matchBet(first(`FanDuel\nStraight Bet\n-275\nJacob Fearnley\nMONEYLINE\nJacob Fearnley v Jurij Rodionov`), twoGames);
  eq(m.espn_game_id, 'next', 'two-sided matchup beats a name-only tie');
  eq(m.ambiguous, false, 'two-sided matchup is not ambiguous');
  eq(m.slot, 'home_ml', 'two-sided matchup: slot');

  // The reverse: naming an opponent this game does not have is evidence AGAINST it.
  const only = [twoGames[0]];
  const m2 = M.matchBet(first(`FanDuel\nJacob Fearnley\nMONEYLINE\nJacob Fearnley v Jurij Rodionov`), only);
  const m3 = M.matchBet(first(`FanDuel\nJacob Fearnley\nMONEYLINE`), only);
  ok(m2.score < m3.score, 'a wrong named opponent scores below no opponent at all');
}

// ── 7. Ambiguity is surfaced, not guessed ────────────────────────────────────
{
  const twins = [
    { espn_game_id: 'dh-1', sport: 'MLB', status: 'pre', start_time: '2026-08-27 17:05:00',
      home_team: 'Baltimore Orioles', home_short: 'Orioles', home_abbr: 'BAL',
      away_team: 'New York Yankees', away_short: 'Yankees', away_abbr: 'NYY' },
    { espn_game_id: 'dh-2', sport: 'MLB', status: 'pre', start_time: '2026-08-27 23:05:00',
      home_team: 'Baltimore Orioles', home_short: 'Orioles', home_abbr: 'BAL',
      away_team: 'New York Yankees', away_short: 'Yankees', away_abbr: 'NYY' },
  ];
  const m = M.matchBet(first(`New York Yankees\nMoneyline\n-150`), twins);
  eq(m.ambiguous, true, 'doubleheader: flagged ambiguous');
  ok(m.alternatives.length >= 1, 'doubleheader: alternative offered');

  // The printed start time resolves it.
  const timed = M.matchBet(first(`New York Yankees\nMoneyline\nYankees @ Orioles\n7:05PM ET\n-150`), twins);
  eq(timed.espn_game_id, 'dh-2', 'doubleheader: 7:05PM ET picks the night game');
  eq(timed.ambiguous, false, 'doubleheader: time resolves the tie');
}

// ── 8. Start-time agreement ──────────────────────────────────────────────────
{
  const g = GAMES[1]; // 23:05 UTC = 7:05PM ET
  eq(M.startAgrees({ time: '7:05PM' }, g), true, 'time: exact ET match');
  eq(M.startAgrees({ time: '7:15PM' }, g), true, 'time: inside the 20 minute window');
  eq(M.startAgrees({ time: '9:05PM' }, g), false, 'time: two hours off');
  eq(M.startAgrees(null, g), null, 'time: no hint is not a verdict');
  eq(M.startAgrees({ time: '7:05PM' }, { start_time: null }), null, 'time: no game time is not a verdict');
}

// ── 9. Slots ─────────────────────────────────────────────────────────────────
{
  eq(M.slotFor('ml', 'home'), 'home_ml', 'slot: home ml');
  eq(M.slotFor('ml', 'away'), 'away_ml', 'slot: away ml');
  eq(M.slotFor('spread', 'home'), 'home_spread', 'slot: home spread');
  eq(M.slotFor('spread', 'away'), 'away_spread', 'slot: away spread');
  eq(M.slotFor('over'), 'over', 'slot: over');
  eq(M.slotFor('under'), 'under', 'slot: under');
  eq(M.slotFor('prop', 'home'), null, 'slot: prop has none');
  eq(M.slotFor('parlay', 'home'), null, 'slot: parlay has none');
  eq(M.slotFor('ml', null), null, 'slot: ml without a side has none');
}

// ── 10. matchAll over a parlay ───────────────────────────────────────────────
// Every leg needs its own game so bet_legs can auto-grade.
{
  const parsed = parseBetslip(`DraftKings
3 Leg Parlay
+596
Los Angeles Lakers -4.5
Point Spread
Lakers @ Celtics
-110
Over 8.5
Total Runs
Yankees @ Orioles
-110
Toronto Maple Leafs
Moneyline
Canadiens @ Maple Leafs
-150
$10.00 Wager`);
  const [m] = M.matchAll(parsed, GAMES);
  eq(m.legs.length, 3, 'parlay: three legs matched');
  eq(m.legs[0].espn_game_id, 'g-nba-1', 'parlay: leg 1 game');
  eq(m.legs[0].slot, 'away_spread', 'parlay: leg 1 slot');
  eq(m.legs[1].espn_game_id, 'g-mlb-1', 'parlay: leg 2 game');
  eq(m.legs[1].slot, 'over', 'parlay: leg 2 slot');
  eq(m.legs[2].espn_game_id, 'g-nhl-tor', 'parlay: leg 3 game');
  eq(m.legs[2].slot, 'home_ml', 'parlay: leg 3 slot');
  ok(m.legs.every(l => l.espn_game_id), 'parlay: every leg is gradable');
}

// ── 11. Empty / defensive ────────────────────────────────────────────────────
{
  eq(M.matchBet(null, GAMES).espn_game_id, null, 'defensive: null bet');
  eq(M.matchBet(first('Celtics\nMoneyline\n-180'), []).espn_game_id, null, 'defensive: empty board');
  eq(M.matchBet(first('Celtics\nMoneyline\n-180'), null).espn_game_id, null, 'defensive: null board');
  eq(M.matchAll(null, GAMES).length, 0, 'defensive: null parse');
}

console.log(`betslip_match.test.js: ${n} assertions passed`);
