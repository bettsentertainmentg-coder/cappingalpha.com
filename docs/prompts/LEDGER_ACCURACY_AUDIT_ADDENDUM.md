# Addendum for the "Profile Data Accuracy Audit" session (2026-09-15)

Paste this into the running Profile Data Accuracy Audit session. It extends that session's scope so the ledger (capper_history, the table that holds every capper's picks and their win/loss results) is right on every source before CappingAlpha V2 publishes a single record. V2 (docs/V2_DATABASE_PLAN.md, worktree ~/projects/capperboss-v2) only READS the ledger; this session OWNS ledger repairs. Model: the same Fable 5.1 this plan runs on, high effort; Opus 5 if that is what is available.

## Ground rules for this session

- Work on a worktree off origin/master, never the bet-tracking checkout (81 commits behind master).
- Never delete a ledger row. Wrong rows become void with a reason, or get regraded; history stays.
- Every restatement runs as a DRY RUN first, the report is saved to data/ledger-repair-<date>-<item>.json, and only then applied. Retired-aware (see memory project_rankings_grading_audit).
- Every fix that changes grading gets an audit rule in src/audit.js and a line in docs/GRADING_RULES.md.
- Do not touch the V2 worktree, expert_data.js or espn_live.js.
- End with a memory note and a one-page report (docs/LEDGER_ACCURACY_REPORT_2026_09.md): what was wrong, how many rows, what was done, what is still open.

## Items to add, in priority order

1. **Ship the wrong-line grading fix.** Branch `fix/ledger-line-grading` (worktree /private/tmp/ca-gradefix, commit 79bc6b5, never pushed; merges clean onto origin/master, verified with git merge-tree on 2026-09-14). It makes `evaluatePick(row, game, { ownLine: true })` grade ledger rows at the capper's own line instead of the CA locked line, adds audit R6 (ledger_line_mismatch) and R14 (implausible_line), and adds `POST /admin/api/regrade-ledger` (header auth, dry run by default, rebuilds V1 ratings after a real run). Merge it, deploy, run the regrade dry from the Mac, read the report (rows changed, win/loss flips, per game), then apply. Expected scale: about 1,687 rows across 473 cappers, 813 outright flips.

2. **BettingPros mis-matched picks** (the thing this session is already on). Quantify by sport: how many rows landed on the wrong game or the wrong market; the "MLB total of 0.5" and basketball-numbers-under-MLB rows (569 implausible lines on the Sept 3 export) come from here. Fix `matchGame` in src/bettingpros.js (sport-aware, participants both matched, start-time agreement), void the bad rows with reason 'bad_match', and add an ingest-time guard so a line that cannot be a full-game line for that sport is refused at the door (reuse `audit.implausibleLine`).

3. **In-play Polymarket fills flagged pregame.** About 5.7% of PM moneyline rows marked pregame are fills 10+ points above the pregame lock and win 90% (they were placed with the game in progress). source_ingest judges liveness on saved_at vs start; write a sweep that compares the fill price to the locked line and marks those rows live:true in sources_json (they stay in the table, excluded from every rating). Add the same check at ingest.

4. **Polymarket backfill rows.** The holders discovery inserts a wallet's prior history (about 2,020 rows, sources_json backfill:true, no espn_game_id) only when that history is profitable. Confirm every rating reader excludes backfill:true (capper_ratings.js filters only live). Add the exclusion to V1's recompute so V1 and V2 agree.

5. **Polymarket bettor vs trader.** Jack's rule: we track Polymarket BETTORS (one side, taken before the game, held), never traders. The straight-bettor screen exists (polymarket_wallets.js: hedge / cashout / sell / pregame percentage gates, settings pm_screen_*). Verify it is applied to every wallet still writing rows, verify the flip/hedge guard withdraws both sides when a wallet flips, and write the rule in plain English for the public About page ("How we track prediction-market bettors": one side, before the start, held to the end; hedged or sold positions are not counted). Hand that paragraph to the V2 session.

6. **The Polymarket feed stopped on 2026-08-31** (last capper_history write 00:18 UTC; taper from Aug 26). Likely the 2a810e3 admission rule (180 of 284 wallets untracked, quota 3/day) or an empty market map. Find the cause and restart the feed.

7. **The Discord ledger stopped on 2026-08-27** (writeBackerGrades in results.js writes Discord rows at grade time; zero rows since, while the board still receives Discord picks). Find the cause and restart it. Note for V2: Discord names are always pseudonyms.

8. **Corrupt prices.** 607 rows with odds inside (-100, +100) or outside [-2000, +1500]. Decide per source whether the stored value is a line mistaken for a price (BettingPros/Polymarket patterns) and fix the ingest; null the price on the bad rows so they grade at the default and the priced-share display stays honest.

9. **Tennis rows under the wrong tour.** About 1,503 of 15,095 tennis rows carry the wrong tour (1,353 women stored as ATP; Gauff 137, Pegula 131, Rybakina 117). Fix the sport label from the event's league path or the athlete record; V2 merges the tours for display but V1's per-sport ratings need the right label.

10. **capper_history.game_date is the UTC date** (source_ingest.js). 27 to 36% of rows are stamped a day late (WNBA 48%, NFL 41%). Backfill from today_games / mvp_picks / ESPN start times to the Eastern date, and stamp ET going forward (cycle.js has the offset). Every as-of feature and the nightly ratings inherit this.

11. **Same-capper both-sides pairs.** 2,264 pairs in the export, 1,700 from Covers consensus flips. Decide the rule (keep both and flag, or keep the later one) and document it; V2 will mark "both sides" on game cards either way.

12. **Unpriced rows.** Covers stores no price on any spread or total (49% of its graded rows are unpriced) and Discord 28%. Nothing to repair; make sure the default (-110 sides, -115 totals) is applied in exactly one place and exported as `priced` so profiles can show the share.

13. **Audit coverage.** After the above: R6 and R14 live, plus a new check that game_date equals the Eastern date of the game's start, and a check that no rating pool row carries live:true or backfill:true.

## What to hand back to the V2 session when done

- The regrade report file names and row counts.
- The About-page paragraph from item 5.
- Confirmation that both feeds (Discord, Polymarket) are writing again, with the date they resumed.
- Anything that changes the exclusion rules V2 applies (docs/V2_DATABASE_PLAN.md section 3c).
