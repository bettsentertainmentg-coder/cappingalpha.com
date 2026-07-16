# CappingAlpha Grading Rules

One page. Six rules. Every surface (rankings, history, tracked bets, capper
records) must agree with these. If one disagrees, that is a bug: the self-audit
(src/audit.js) re-verifies every graded row every 5 minutes and files a
violation (with a full row snapshot that survives the daily wipe) to
`audit_flags`, readable at GET /admin/api/audit.json.

## R1. One game, one line per market
- 5:00am: line seeded from the market. Until lock it tracks the market. That
  number is a PREVIEW, not the bet price.
- T-60 (one hour before start): the line LOCKS (src/ca_line.js). This is the
  moment the hypothetical bet is placed.
- After T-60 the number never changes, and every surface shows and grades
  against that same locked number. Two different lines for one game's total on
  two pages can never be correct.

## R2. Points freeze at the true start
- Pregame, points move freely: new backers, rating changes, rescores all count
  (a late whale is signal, not noise).
- The freeze trigger is ESPN's status flip to live. Tracked scores sync to the
  board every 5 minutes until then (src/mvp.js), then never move.
- In-play arrivals (a wallet trade after tip, a live pick) are flagged live in
  provenance: record-only for the capper, zero points, never on the board
  (src/source_ingest.js).

## R3. One tracked bet per game per dimension
- Dimensions: MARGIN (moneyline + spread together) and TOTAL (over/under).
- The higher-scored side owns the game's bet. Overtaken pregame = the bet
  flips: the beaten pending row is deleted, the leader rides at the locked
  line (src/mvp.js flip pass).
- Still conflicting when the game goes live = both voided ("rare push").
- Same team ML + spread is one direction, not a conflict; both can ride.

## R4. Grades = final score vs the locked line
- Order of truth at grade time: line_snapshots (the lock record), then the
  locked stamp on the row itself (captured_*/live_*), then the display line
  (src/results.js evaluatePick).
- Soccer ML is 3-way: a draw grades both ML sides as losses.
- Tennis totals and game-spreads grade on GAMES, set markets on sets.
- Voids: tennis player replacement, dimension-conflict voids. Nothing else.

## R5. Voids never count
- A voided bet is excluded from every W/L record and P/L figure. Its note names
  the pick that beat it and both scores at decision time.

## R6. Capper records are a separate ledger
- A capper's own pick grades at THEIR quoted line and odds (their record,
  their price), win or lose, whether or not it ever became the CA tracked bet.
- The CA tracked-bet record (MVP history) is the hypothetical bet ledger ruled
  by R1-R5. The two can legitimately disagree on a line; they can never
  disagree on what the final score was.

Current as of 2026-07-16.
