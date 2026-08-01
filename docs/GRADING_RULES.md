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
Jack, 2026-07-31: "THE TRACKING AND POINTS TALLYING ENDS AT THE START OF THE GAME
FOR ANY PICK EVER. NOTHING IS TRACKED PAST THAT."

- Pregame, points move freely: new backers, rating changes, rescores all count
  (a late whale is signal, not noise).
- **At the start, the SCORE itself freezes.** Whatever a pick is worth at first
  pitch is what it is worth forever. `computeAndLogV3` returns the stored total
  untouched once the game has begun (src/scoring_v3.js). No late mention, no
  ratings recompute, no board rescore, no boot migration may move it.
- Zero grace. A mention landing one second after the start is rejected
  (`GRACE_MS = 0`, src/pick_cutoff.js). First pitch is detected within 30
  seconds by the start watcher, so there is no clock skew left to forgive.
- In-play source entries are DROPPED, not logged. They used to be inserted into
  capper_history flagged live in provenance on a "record-only" theory; d3af377
  then had to exclude 7,787 of ~19k graded rows from the ratings pool (WTA 82%,
  ATP 62%) because they had been shaping every capper's rank. A row we refuse to
  judge on should not exist (src/source_ingest.js).
- Why the score freeze had to be added: gating only the tracked-bet INSERT left
  the score free to climb. On 2026-07-31 Diana Shnaider crossed 100 DURING her
  match and rendered as a gold pick that was never bettable. A pick must not be
  able to reach gold after the moment it could have been bet.

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
- Voids: tennis player replacement, tennis match ended early (R8),
  dimension-conflict voids. Nothing else.

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
- Judged ONCE, at tracking time, on the FRESH canonical price right then
  (today_games, then freshest book_lines — never the frozen 50-cross capture).
  The judged price is stamped as mvp_picks.gate_ml_odds; ml_odds is later
  overwritten by the T-60 lock by design, so the stamp is the only surviving
  record of what the gate saw, and the audit judges the stamp. Tracked at
  -250 in the morning and -320 by evening rides (accepted risk). Blocked at
  -320 and softened to -280 pregame gets in on the next promotion pass.
- The gate erodes only with evidence, never by fiat: a backer with 30+ graded
  heavy-bracket decisions (implied 75%+) and positive shrunk price edge
  unlocks the pick (storage.heavyBracketUnlocked; a top-15% rank requirement
  was tried 2026-07-29 and reverted the same day — the bracket bar filters
  hard enough on its own). Once one qualifying backer opens it, the whole
  pick counts: tracked, gold-badged, and every joiner's consensus points
  included whether or not those joiners are approved (scoring was never
  gated).
- Pre-gate leftovers: rows tracked before the gate existed carry no
  gate_ml_odds stamp. The 5-minute sweep judges each pending PREGAME one once
  at the current price (heavy = removed, else stamped to ride); graded
  leftovers are retired by re-running scripts/heavy_restate.js.
- DISPLAY CAP (Jack 2026-07-29): a pick the gate keeps off the record must not
  wear the tracked tier either. An untracked, un-unlocked ML currently priced
  past the gate shows at most 95 (silver) on every public surface, curve
  included (scoring_v3.heavyDisplayCapFor). True total untouched; a tracked
  drift-ride keeps its gold (it IS a bet). Cap follows the live price: softens
  under the gate, or gets tracked, and the cap lifts.
- History restated to v4 launch (2026-07-09) via the retire mechanism
  (scripts/heavy_restate.js) so the record reads as if the rule existed from
  v4 day one. Retired rows are never deleted and stay reversible.

## R8. A tennis match that stops early settles nothing (2026-07-30)
- A retirement, walkover, default or withdrawal VOIDS every side market on the
  match (ML, game spread, set handicap) and the under. That is how books settle
  a match that did not play out, and now how we do.
- The one exception is a market already decided by the play that DID happen: an
  over whose total games were passed before the stoppage wins, and a set
  moneyline on a set that finished before it grades normally.
- A set belongs to nobody until it is COMPLETE (6+ games with a 2-game lead, or
  7-6). One counter owns this rule for the whole codebase: src/tennis_score.js.
  Never re-implement it locally.
- Two independent triggers, so no single missed signal can mint a grade:
  ESPN's status name (STATUS_RETIRED and friends), and the structural check
  that a real final has a winner holding 2+ completed sets. The structural one
  needs no status string, so an unrecognized status cannot slip through.
- Why: on 2026-07-30 Darderi retired trailing 0-3 in set one of ATP 178921.
  results.js carried its own naive set counter that credited the unfinished set
  to Svrcina, read the match as a 1-0 final, and graded a tracked gold ML as a
  LOSS. tennis_espn.js wrote the true 0-0 to the same row minutes later, so the
  page showed a LOSS beside a "FINAL 0-0" panel. Audit rule R8 now flags any
  tennis grade standing on a final no player could have won.

## R9. A tracked bet is placed BEFORE first pitch, or it is not a bet (2026-07-30)
- No row may be created in the tracked ledger at or after its game's start.
  Not by a mention, not by a promotion sweep, not by a boot migration.
- Every gate calls one helper, `pick_cutoff.hasGameStarted()`. A game has
  started when ESPN says it is no longer pregame, when a real start was stamped,
  or when live play is on the board. For fixed-schedule sports a passed start
  time also counts; for tennis and golf it does not, because ESPN lists those as
  "not before" and matches routinely go off 30 to 90 minutes late.
- First pitch is detected within 30 seconds, not 5 minutes: the live tick also
  wakes for games inside the start window (index.js `startWindowOpen`).
- Both halves of the proof are stored on the row and survive the daily wipe:
  `saved_at` (when the bet was created) and `game_start_at` (when its game
  began). Audit rule R9 compares them on every pass.
- Why: 48 of 457 v4-era tracked bets were created after their game started. 26
  of those inside 5 minutes, on the old cron lag. Because an in-play row had
  been collecting mentions while the match played out, it usually carried MORE
  points than the legitimate pregame bet, won the conflict resolver under R3,
  and VOIDED the real bet. Eight good bets were destroyed that way, including a
  Tabilo ML on 2026-07-30 that went on to win its match and showed VOID on the
  Rankings list beside a WIN badge on the game page. Worse, the boot migration
  promoted already-finished games and then read the FINAL SCORE to grade them
  (six MLB bets in one second, up to 7 hours after first pitch, one recorded as
  a win). Full autopsy: docs/RANKINGS_AUDIT_2026_07_30.md.

## R10. Nothing leaves the ledger untraced (2026-07-30)
- The pregame sweeps may delete a tracked row while its game is still pregame.
  That is R3's flip rule working, and it is the only legitimate deletion.
- Every deletion is snapshotted into `mvp_deletions` first, with the reason and
  whether the game had started. Never wiped. Audit rule R10 flags any deletion
  that happened after a game started.
- `retired = 1` is authoritative everywhere, not just in the read helpers. A row
  restated off the record cannot claim a game's bet slot, cannot void a live
  row, and cannot be graded back to life. Before this, retiring a row left it
  competing in the conflict resolver, so any restatement silently undid itself
  on the next 5-minute pass.
- Why: deletes left no annotation, no flag and nothing to autopsy, which is how
  rows vanished from the Rankings list with no explanation.

Current as of 2026-07-30.
