# CappingAlpha Grading Rules

One page. Seven rules. Every surface (rankings, history, tracked bets, capper
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

## R7. Heavy prices require proven backers (2026-07-28)
- An ML gold priced at or past the heavy gate (settings heavy_ml_gate, default
  -300) stays on the board and rankings but never becomes a tracked bet. A
  flat-unit record cannot survive extreme favorites: the v4-era ledger's whole
  deficit traced to MLs at -300 or worse (37-13, 74% wins, -6.29u).
- Judged ONCE, at tracking time, with the canonical odds right then. Tracked
  at -250 in the morning and -320 by evening rides (accepted risk). Blocked at
  -320 and softened to -280 pregame gets in on the next promotion pass.
- The gate erodes only with evidence, never by fiat: a backer with 30+ graded
  heavy-bracket decisions (implied 75%+) and positive shrunk price edge
  unlocks tracking for their own heavy-priced golds
  (storage.heavyBracketUnlocked, capper_ratings heavy_n/heavy_edge_shrunk).
- History restated to v4 launch (2026-07-09) via the retire mechanism
  (scripts/heavy_restate.js) so the record reads as if the rule existed from
  v4 day one. Retired rows are never deleted and stay reversible.

Current as of 2026-07-28.
