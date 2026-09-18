# CappingAlpha Grading Rules

One page. Eleven rules. Every surface (rankings, history, tracked bets, capper
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
- Order of truth at grade time FOR A CA ROW (board picks, tracked bets, the
  permanent archive): line_snapshots (the lock record), then the locked stamp
  on the row itself (captured_*/live_*), then the display line
  (src/results.js evaluatePick).
- That order is for CA rows ONLY. A capper ledger row grades at its own number
  and nothing else (R6) — `evaluatePick(row, game, { ownLine: true })`.
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
- ENFORCED (2026-09-10): `evaluatePick` takes `{ ownLine: true }` for ledger
  rows, which skips the line_snapshots lookup and every captured_/live_ stamp.
  Audit rule R6 regrades same-day ledger rows against their own line and flags
  any that disagree (`ledger_line_mismatch`).
- Why it needed enforcing: the snapshot lookup only needs a game id and a team
  name, both of which a capper_history row has, so it won every time and each
  capper was graded at the CA's locked line. On 2026-09-09 Seattle beat New
  England by exactly 3 with the CA line at 3, and all 146 spread rows on the
  game graded PUSH (+4.5, +3.5, -2.5 and -3.5 alike). Totals graded against the
  game's 44.5, so a 21.5 under on a 23-point game came back a WIN. 1,687 grades
  across 473 cappers were wrong, 813 of them win/loss flips, in the table the
  Wilson ladder is built from. Restated by src/ledger_regrade.js
  (POST /admin/api/regrade-ledger).

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

## R11. A suspended match is not a pregame match (2026-08-02)
- ESPN files a halted event (suspended, postponed, rain delay, abandoned) as
  state `post` with a partial or empty linescore. tennis_espn.js downgrades
  those to `pre` so grading can never settle a half-played match off a partial
  score. That downgrade is correct and stays. Its consequence is the rule here:
  `status = 'pre'` is NOT proof a match is pregame, and no gate may treat it so.
- Scoring and membership follow R9's `hasGameStarted()`, which now also counts
  TENNIS GAMES PLAYED. Sets won only counts COMPLETED sets, so a match suspended
  inside the first set scores 0-0; on a row re-listed after the 3-day prune
  (which carries no stamped start) that read as fully pregame.
- New picks arriving on a suspended match are refused by BOTH intake paths. The
  Discord path already was (savePick calls `hasGameStarted`, and the message is
  logged to `skipped_messages` as `late_post_start`). The wave-1 scrapers were
  not: they judged in-play by comparing the source timestamp to `start_time`
  alone, and tennis_espn takes ESPN's freshest date on every upsert, so a halted
  match gets re-dated to its resumption. A pick posted while the match sat 1-1
  in sets then read as pregame and earned a `capper_history` row that graded
  into the Wilson pool. `recordSourcePick` now also asks `hasGameStarted`.
- User tracking (votes, the Track a Bet line board, the verified confirm slide)
  uses the stricter `pick_cutoff.isTrackingClosed()`: closed once a game has
  started AND while it is suspended. A halt freezes our line while the market
  moves or is pulled, and nothing in the payload says whether play resumes in 20
  minutes or tomorrow.
- The T-60 line lock skips any started game. `ca_line_locked` lives on
  today_games, so a match that outlives the prune and gets re-listed comes back
  unlocked with its start time in the past, and the lock would rewrite a tracked
  bet's odds and line at a mid-match number.
- Every surface says so: the pick row, the Sports card, the home strip, the #1
  card, the game modal and the detail page all show an amber SUSPENDED chip with
  the score reached before play stopped. None of them shows a start time.
- Why: three Toronto matches were suspended by rain on 2026-08-02. All three sat
  on the board reading like upcoming games, one of them with Pegula already a set
  up on a gold Eala pick, and voting plus verified tracking were still open on
  every one of them at the frozen pregame price.

## R12. A favorite with no posted price is priced at its spread, not at -110 (2026-09-08)

- A moneyline pick on a side whose spread is -25 or worse, where no book posted a
  moneyline, grades at -100000 (`storage.impliedHeavyMl`, used by
  `results.capperBetOdds` and `scoring_v3.heavyDisplayCapFor`). A quarter of a
  college football Saturday looks like this (six of the 12 games at -25 or worse
  on 2026-09-12 carried no price at all; where a book did post one at those
  spreads it was -4500 to -50000).
- Why: `capperBetOdds` returned null and `capper_ratings.effOdds` substituted
  -110, so a capper who took Howard at Indiana -56.5 on the moneyline was
  credited +0.91 units and +0.48 edge for a bet that pays a few cents. Over a
  season the sure-thing pickers would look like the best records on the site.
- The synthetic price is derived at grade time only. It is never written into
  `today_games.ml_*`, which is the public line, the CA lock basis and the
  betslip VERIFY_TOL band. Spreads and totals are unaffected.
- The display cap applies too: an unpriced -25 favorite on the moneyline shows
  at most 95, silver at best, the same as any -300 or heavier price (R7).
- Not changed: `capper_ratings.effOdds` still substitutes -110 when a stored
  price is genuinely missing on a normal game. That touches a third of every
  graded moneyline decision across every sport and needs its own backtest.

## R13. A Discord pick names its sport, and the game must be in it (2026-09-08)

- `expert_data.js` resolves a team name through `game_match.lookupTodayGameForSport`,
  which keeps `espn_live.lookupTodayGame`'s answer when it agrees with the sport
  the reader extracted, and otherwise searches inside the reader's sport, ranked
  by match quality (an exact stored name beats a leading or trailing word, which
  beats a substring). Two games tying at the best quality that are not a
  doubleheader are REFUSED and written to `source_skips` with the candidates.
- Why: `lookupTodayGame` breaks a multi-sport tie with a fixed priority list
  (CBB, NBA, NHL, WCBB, MLB, NFL) that omits college football, so "Tigers" on a
  Saturday went to the Detroit Tigers and "Kansas" in November goes to the
  basketball game, and the pick graded against the wrong final. Measured on a
  November Saturday: 18 of 112 college sides wrong, then 0, with no change to
  any other sport. Adding NCAAF to the priority list was measured zero-sum.
- A reader mislabel (NBA for a WNBA pick) still lands where it always did: the
  unconstrained answer is kept whenever the reader's sport has no candidate, so
  the existing WNBA and Soccer guards see the same rows they saw before.

## R14. A ledger line must be possible for its sport and market (2026-09-10, enforced 2026-09-15)

- A capper_history row whose quoted number cannot be a full-game line for its
  sport is not a bet we can grade: an MLB "game total" of 0.5 or 1 is a team
  total or a prop, a 184.5 filed under MLB is a basketball line on a
  wrong-game match. Audit rule R14 flags them (`implausible_line`).
- The bands live in ONE place, `src/ledger_sanity.js` (TOTAL_BAND, SPREAD_MAX),
  shared by the audit, the ingest gate (R15) and the restatement, so the three
  can never disagree about what a full-game line is. Generous at the real
  edges (a Coors 15, FAMU @ Miami -56.5), closed to everything else.
- The 2026-09-15 restatement (`POST /admin/api/sanitize-ledger`, dry run by
  default) voided every graded row the bands refuse, every spread or total
  priced past +-1000, and every row whose own provenance names another market
  (Polymarket "Total Sets", "Set Handicap", the All-Star exhibition). Voided
  rows keep the grade they had in `result_before_void` and carry the reason in
  `void_reason`; `{ restore: true, reason }` reverses one reason. 2,734 rows
  across 521 cappers on the prod export, 1,300 wins to 1,294 losses, which is
  what a coin flip filed as a decision looks like.

## R15. Only a full-game market joins the ledger (2026-09-15)

- The Felix317 profile: 6-3 and +29.2 units on NFL "overs" that read "over 5
  +800", "over 1 +550", "over 40". BettingPros serves game props, quarter and
  inning lines, team totals, drive-result bets and alternates with the SAME
  `line.type` values as the full-game markets, and only player props carry a
  `player_id`. Action Network's first-five totals (`period != 'game'`) and team
  totals (`competitor_id`), Polymarket's tennis set markets, and Covers'
  pre-September cross-sport matches reached the ledger the same way. 7,950
  rows across 926 cappers were flagged in the export that day.
- Every source pick now clears the gate in `src/ledger_sanity.js` inside
  `source_ingest.recordSourcePick`, after the pregame check and before the
  insert: the number must sit inside the sport's full-game band, agree with
  the game's own line when the board holds one (per-sport tolerance:
  TOTAL_TOL / SPREAD_TOL, so an alternate line or a period line is refused
  even when it is inside the band), and be priced like that market. A spread
  or total past +-300 takes the board's juice (or standard juice) and notes
  `price_replaced` in provenance; a moneyline past +-2500 takes the board's
  price or is refused. Hand-typed prices (BettingPros, `trustPrice: false`)
  are also replaced when they disagree with the board by more than 10 points
  of implied probability. A refusal is logged to `source_skips` with the
  reason and the board's line, so nothing is dropped silently.
- Each source also refuses on its own word for the market, before the gate:
  BettingPros keeps one learned market id per full-game market per sport
  (`BP_FULL_GAME`) plus a label shape ("Over 44.5", never "Ravens o36.5");
  Action Network drops `period != 'game'`, `player_id`, and totals with a
  `competitor_id`; Polymarket's market screen (`SKIP_Q`) now excludes set
  markets, handicaps, exhibitions and every prop phrasing, on the live map
  and the holders backfill alike.
- Heavy prices are shown, never counted (Jack, 2026-09-15 and 2026-09-18).
  A moneyline at -2000 or heavier is recorded as the capper said it, visible
  on the profile, and voided from the record (`heavy_price`); it never scores
  on the board. 386 such rows on the first pass, nearly all Polymarket wallets
  at -2400 and beyond, plus ten Covers -10000s. A -1000 cut tried on
  2026-09-16 was undone on 2026-09-18 at Jack's call; its -1000..-1999 rows
  were restored. Spreads and totals past +-1000 were already out.
- Rows only the source's own market label can expose (a BettingPros "5th
  Inning Moneyline" carries an ordinary price and no line, so no band sees
  it) are voided in LIST mode: `{ ids, reason }` to the sanitize endpoint,
  from a cross-check that re-reads BettingPros' market ids per event. Their
  picks endpoint pages at 50, and a busy NFL game carries ~1,000 picks; the
  live poll now walks pages down to the previous poll's watermark instead of
  reading the 50 most recent picks only.
- Why refuse rather than re-file: a first-five total is a real bet, but it is
  not a bet on the game total, and the ledger has one slot per game market.
  A dropped pick costs one data point. A misfiled one is a coin flip counted
  as a decision, and the Wilson ladder that prices every pick is built on
  decisions.

## R16. A source pick belongs to the game on the source's own date (2026-09-16)

- The board carries several days of games (forward_games.js), so an MLB or
  WNBA series puts the same two teams on it two to four times. Every source
  keeps listing a pick as pending while its game is being played, and the
  shared matcher (`source_ingest.resolveGameMatches`) dropped the started game
  and handed the pick to the NEXT game of the series. The dedup key includes
  the game, so the copy went in as a new row and was graded against a game the
  capper never bet. Measured on the 2026-09-16 export: 15,198 rows (13,980
  graded, 787 cappers), Covers 7,685, BettingPros 5,297, Action Network 1,805,
  the article columns 411. 97% of the Covers copies were saved within 30
  minutes of the real game's first pitch. Mike Spector's one Reds column was
  graded three times across one series.
- The rule: a source that knows when its game is passes it, and that alone
  picks the board game, started or not (a started one is then refused as
  in-play, never re-homed). BettingPros passes its event time, Action Network
  its `starts_at`, Polymarket its market's `gameStartTime`, Covers the date
  heading over each pending table, and an article its game date from the title
  or URL, else its publish time (the first game of the matchup after it). A
  source with no date (WagerTalk, CBS) is refused while an earlier game of the
  same matchup started less than 8 hours ago (`SERIES_GUARD_MS`); polls repeat,
  so a real pick on the later game still lands after the window.
- BettingPros stamps are UTC (every NFL 1:00pm ET kickoff reads 17:00). They
  were read as Eastern and shifted the wrong way, so every BettingPros time
  came out four hours early. The started-game check hid it for a correct
  match; with the series bug it let bets placed during a game through.
- The copies were voided in list mode (`wrong_game_series`), keeping the
  original row on the real game.

## R17. A moneyline with no price is not graded (2026-09-16)

- The ratings price an unpriced row at -110. For a moneyline that is badly
  wrong: sjoe36758's six unpriced college favorites (BettingPros drops any
  price past +-2000, so a missing price there usually IS an extreme favorite)
  each paid +0.91 units on a win.
- At ingest an unpriced moneyline takes the board's price for its side; a deep
  favorite with no posted price is priced from its spread (R12) and then
  refused as heavy; anything else is refused (`ml_no_price`).
- The restatement first gives an unpriced row the median closing price for its
  side across the archived books (`book_lines_closing`), else its spread-implied
  price, else today's board, and records where it came from in
  `capper_history.odds_source`. Only a row with no price anywhere is voided.
  `{ restore: true, reason: 'prices' }` clears every backfilled price.
- Spreads and totals with no juice (Covers, CBS) still settle at standard juice:
  the line decides those bets, and the juice moves units a few cents.

## R18. A board line must belong to the game it sits on (2026-09-17)

- `odds_api.findTodayGame` matched an Odds API event to a board game on the
  NICKNAME with no date, and took the first row. The board now carries a full
  week of college football, so "Maine Black Bears @ Boston College Eagles" is
  a Bears and an Eagles and so are three other games that week: the 4pm
  refresh wrote another game's numbers onto that row (spread 1.5 and total
  47.5 against every book's -38.5 and 53.5) and `storeBookLines` put the wrong
  moneyline on its DraftKings row. Seven of 99 board games carried a line no
  book agreed with.
- The rule: both full team names must fit the board row, and when several
  rows still fit, the event's own `commence_time` picks the one within 3
  hours. Otherwise the event is skipped and logged, never written to a guess.
- Why it matters beyond display: the board line is what the market gate
  (R15) measures a source pick against, so a wrong board number refuses real
  picks. The CA official line itself locks from `book_lines` (R1), which is
  why grading was not hit.

## R19. One capper, one side of a market (2026-09-17)

- A capper cannot hold both sides of the same market on the same game as a
  pick. Where the ledger has both, it is a reader artifact (a Discord message
  naming both teams graded onto both slots, an NRFI stored once per team) or a
  wallet hedging, which is a trade and not a read. Either way the pair is a
  guaranteed 1-1 that inflates the volume the Wilson ladder rewards.
- Both rows void (`both_sides`, reversible); there is no way to tell which
  side was meant. 1,261 pairs on the 2026-09-17 export: Polymarket 946, then
  Covers 137, BettingPros 130, Discord 22, Action Network 20.
- Live hedges and flips are already withdrawn pregame by
  `source_ingest.removeSourceEntry`. This is the history that rule never saw.
- Different markets on one game (a moneyline and a spread) are not a pair, and
  neither is the same side twice.

Current as of 2026-09-18.
