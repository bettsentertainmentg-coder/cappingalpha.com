# CappingAlpha Bet Tracking — Unified Implementation Backlog

## Builds shipped (post-loop, on branch `bet-tracking`)
- **More sports + sorted dropdown — DONE + verified (2026-06-28).** Expanded `src/track_schedule.js` to pull every clean ESPN free scoreboard: team sports + WCBB + UFC/MMA (fight cards expand into one row per fight) + Soccer (EPL/MLS/UCL/La Liga/Serie A/Bundesliga/FA Cup). Robust parser handles no-home/away (fighters/matchups) and multi-competition events. Betslip sport dropdown now sorts CORE CappingAlpha sports first (MLB,NBA,NHL,WNBA,NFL,NCAAF,CBB,ATP,WTA,Golf) by our volume, then everything else (UFC, Soccer, WCBB) at the bottom, custom-only (`isCustomGame` = non-today OR non-core). Today also merges in extra-sport games from the schedule feed so UFC/soccer show today too. Date stepper range extended to -7..+14 (UFC/soccer cards are 1-2 weeks out). Custom-bet form sport list gained Soccer/UFC/WCBB/Boxing. Verified end-to-end on a real UFC date (14 fights listed + tagged custom + open the custom form preset to UFC; dropdown sorted core-first), 0 errors. track.js v18 / account.js v21 / app.js v33. Boxing has no ESPN scoreboard (custom-form only); Tennis/Golf future stays on the existing feed.

- **#19 Week-ahead schedule — DONE + verified (2026-06-28).** Built as its own SEPARATE module per Jack's steer: new `src/track_schedule.js` fetches the next 6 days of team-sport games (MLB/NBA/WNBA/NHL/NFL/NCAAF/CBB) straight from ESPN's free scoreboard API, in-memory cached, exposed at `GET /api/track/schedule?date=YYYYMMDD`. It does NOT read/write today_games, touch espn_live/forward_games, or use any Odds API credits. The betslip "From a game" picker now has a day row (Today + 6). Today keeps the existing verified-capable path (odds board); future days are CUSTOM ONLY (no lines exist for them) — future games are tagged "custom", show a one-line note, and tapping one opens the custom-bet form with the sport preset and the matchup as the placeholder. Lazy per-day fetch. Verified end-to-end in browser (day chips, future load, custom-form preset) + regressions clean (qa12 6/6, qa15 9/9, qa19 0 errors), 0 console errors. Files: NEW `src/track_schedule.js`; `index.js` (+1 mount line); `public/modules/track.js` (day picker + future routing); cache bumps track.js v15 / account.js v18 / app.js v30. Tennis/Golf intentionally excluded from the week view (per-player scoreboards; already covered for today).

## Loop progress
- **Iter 1 (2026-06-27):** DONE + verified — P0 #1 (confirmation toast), #2 (disable null-odds lines on the board + "no lines posted" note), #3 (atomic settle on create, no phantom-win race), #4 (double-submit guard on verified track).
- **Iter 2 (2026-06-27):** DONE + verified — P0 #5 (payout preview respects result: no "to win" on Lost/Void), P1 #11 (Over/Under toggle for custom Totals -> buckets correctly), P1 #12 (Void result in custom form + settle controls). Note: #8 spread juice is N/A (we store no spread juice; -110 is the only available value).
- **Iter 3 (2026-06-27):** DONE + verified — P1 #15 (Breakdown card: net units + W-L-% By Sport and By Bet Type, merged votes+bets, respects the timeframe pill). buildItems now carries sport+type. Note #6 (inline re-grade) effectively done via the settle buttons on pending custom rows.
- **Iter 4 (2026-06-27):** DONE + verified — P1 #14 (Units/$ toggle on the cumulative P/L graph), P2 #10 (optional Note field on the custom form).
- **Iter 5 (2026-06-27):** DONE + verified — P1 #9 (bet detail/edit sheet via PUT /api/bets/:id + inline settle + delete), P2 #24 (Escape-to-close).
- **Iter 6 (2026-06-27):** DONE + verified — Full-flow QA CLEAN. P1 #7 (best-odds DK/FD line-shopping context on the odds board). P2 #21 (verified-badge tooltip).
- **Iter 7 (2026-06-27):** DONE + verified — P1 #25 (day-grouped bet feed), P2 #30 ($0-stake flag).
- **Iter 8 (2026-06-27):** DONE + verified — P1 #23 (bet-detail "View game" link), P2 #27 (in-app inline confirm delete, no native dialog), P2 #26 (44px mobile tap targets).
- **Iter 9 (2026-06-27):** DONE + verified — P2 #29 (removed dead no-op forEach in setFormBook; book chips still toggle), P2 #31 (odds-board load-failure now shows a Retry button), P2 #28 (aria-modal on the track/detail sheets; most controls already had text/aria + Escape-to-close). QA pass CLEAN (0 errors).
- **Iter 10 (2026-06-27):** Full-flow QA CLEAN (0 console/page errors across the tracking tab, range pills, $/units metric toggle, the custom form incl. Total->over/under mapping + pending bet rendering with settle buttons, book chips, Escape-close, game list, bet detail/edit, inline-confirm delete, Settings, the home avatar dropdown, and mobile 390px tabbar-at-bottom + FAB). Implemented P2 #34 — the bet-feed sport filter now stays selected (showing an empty state) after you delete the last bet in that sport, instead of silently snapping back to "All"; one guard added in renderBets, browser-verified. track.js v12 / account.js v12 / app.js v24.
- **Iter 11 (2026-06-27):** QA sweep CLEAN (0 errors) — re-verified the full flow plus the /game/ detail-page avatar dropdown (opens, has My Tracking) and the #34 fix as a regression. No code change: assessed every remaining P2 and none clears the bar of net-positive + low-risk + locally verifiable. #32 (search min-length) isn't clearly better; #33 (single sport-list) is moot — track.js SPORTS, account.js ALL_SPORTS, and index.js `valid` are already byte-identical, so consolidating is pure churn; #35 (line-movement context on the board) can't be browser-verified locally because no pre-game game carries lines in UI_ONLY; #36 (best-book in detail) needs per-book capture at log time (schema change, not micro); #37 (tagging) is multi-file.
- **Iter 12 (2026-06-27):** Visual QA via screenshots (tracking page, custom form, feed, detail) — 0 errors. Confirmed the day-grouped feed renders all states correctly (W/L/P/Pending pills, settle buttons on pending only, notes + book lines, day net); the "feed missing" look in a full-page capture is just the `.account-reveal` scroll animation (opacity 0 until scrolled), not a bug. Polish shipped: push/void payouts now render a neutral gray "$0.00" instead of a misleading green "+$0.00" (a push returns the stake, it isn't a win). Added a shared `payoutCell()` helper used by both the feed row and the bet-detail P/L; wins stay green, losses red. Browser-verified the exact colors in feed + detail. track.js v13 / account.js v13 / app.js v25.
- **Iter 13 (2026-06-27):** Visual QA of Settings (desktop) + mobile tracking @390px + mobile custom form — 0 errors; confirmed the iter-12 push/void neutral-$0.00 fix also holds on mobile, and the mobile bottom tab bar sits at the viewport bottom. Fixed stale copy: the Settings "Starting bankroll" hint read "Used to show bankroll over time once manual bet tracking ships," but custom/manual bet tracking already shipped — changed to "Used as the starting point for bankroll-over-time tracking (coming soon)," which is accurate (the bankroll-over-time view itself isn't built; starting_bankroll is saved but not yet rendered anywhere). Browser-verified the new copy renders and the stale string is gone. Noted but did NOT change: the global Track-Bet FAB overlaps the bankroll input on Settings (standard fixed-FAB behavior; not worth a special-case). account.js v14 / app.js v26.
- **Iter 14 (2026-06-27):** Verified the LIGHT theme end-to-end (hadn't been visually checked before) — toggled via Settings > Appearance, then screenshotted the tracking page + custom form in light mode. Everything adapts cleanly: white cards / dark text, green-positive / red-negative stats, readable inputs + placeholders, correctly-styled active segments, and the iter-12 push/void neutral-$0.00 holds in light too. Functional regressions (push/void colors, #34 sport-filter, home + detail-page avatar dropdowns) all re-passed. 0 console/page errors. No code change: nothing was broken and no remaining P2 clears net-positive + low-risk + locally-verifiable; forcing one would only risk a regression. No version bump.
- **Iter 15 (2026-06-27):** Rotated coverage onto the settle/edit paths and found a real UX gap: once a CUSTOM bet was settled, the detail sheet was read-only — no way to correct a mis-settle (marked Won, meant Lost) short of delete-and-recreate. The backend `settleBet` already allows re-grading custom bets (no pending guard; only game-linked bets are blocked), so the fix was frontend-only: added a "Marked it wrong? Update the result:" block (Won/Lost/Push/Void) to the settled-bet detail, gated on `!espn_game_id` (game-linked bets stay auto-graded). Also hardened the shared `settleBetUI` to toast + close the sheet on success — which additionally fixes a pre-existing quirk where settling from the detail sheet left it open showing the stale pre-settle result. Verified end-to-end: settle a win, open detail, correct to loss -> sheet closes, feed shows L, API result=loss + payout=-50; re-open still offers the block. Regressed both pending-settle paths (feed-row inline + detail) and push/void neutral rendering — all pass, 0 errors. track.js v14 / account.js v15 / app.js v27.
- **Iter 16 (2026-06-27):** Rotated onto the edit-bet PUT path + Units/$ math (not directly tested before). Edit a pending bet's odds/stake/notes from the detail sheet -> verified PUT /api/bets/:id persists all three, recomputes units from the new stake (80/$20 = 4.00u), the sheet closes, and the feed row reflects 4.00u + the new note. Units/$ graph toggle math is correct: a -110 / $50 win shows +$45.45 in dollars and +2.27u in units (45.45 / 20). Iter-15 correct-result block re-regressed clean. 0 console/page errors. No code change (nothing broken; no remaining P2 clears the bar). No version bump. Coverage is now comprehensive: P0/P1/P2, dark+light, desktop+mobile, custom+verified flows, feed, detail/edit, all settle paths, delete, timeframe/metric math, breakdown, settings, both avatar dropdowns, sport-filter.
- **Iter 17 (2026-06-27):** Rotated onto the Breakdown by-sport/by-bet-type math. Seeded precise bets ($20 unit) and asserted the rendered breakdown vs hand-computed values: By Sport NHL +1.50u (1-0), MLB +0.27u (1-1), NBA +0.00u (0-0-1); By Bet Type ML +1.77u (2-1 67%), Total +0.00u; stat strip Net Units +1.77u / +$35.45 — all exact. Confirmed net units are PROFIT-based (payout/unit, not stake), pushes count 0 in the record, void is excluded entirely, rows sort by units desc, and win% uses decided (wins+losses) only. Polish shipped: the breakdown sport labels rendered the abbreviation twice (the colored sportBadge already contains it, then ` + r.k` repeated it -> "MLB MLB"); changed to show just the badge for sport rows (bet-type rows keep their plain label). Verified visually (badge-only, clean) + by assertion (exactly one "MLB"); math regression re-passed. 0 console/page errors. account.js v16 / app.js v28.
- **Iter 18 (2026-06-27):** Rotated onto the VERIFIED vote path (the leaderboard-counting one) + the $0-stake flag. Voted on real pre-game games via POST /api/game/:id/vote -> 200, the pick lands in /api/account and renders in "My Tracked Picks" (matchup + sport badge + "My Pick" + a remove ✕; pre-game SCORE/RESULT show "—"). Confirmed multiple DISTINCT votes all render (voted 3 games -> 3 in /api/account -> 3 rows; an earlier "1 of 2" was just a duplicate in the test's own pick list, not a bug) and a re-vote on the same slot is handled without a 500. $0-stake flag end-to-end: the payout preview shows "won't affect your P/L," and the stored bet has stake 0 / payout 0 / units 0 so it contributes nothing to ROI/units. Note: local UI_ONLY has no Odds API, so pre-game games carry no ML/spread/OU lines — voting still records the side correctly (odds/CLV get captured at grading time in prod). 0 console/page errors. No code change (nothing broken). No version bump.
- **Iter 19 (2026-06-27):** Rotated onto vote-removal + no-double-count + Settings odds picker, and found a real consistency gap: two native `alert()` dialogs still lived in the vote flows (account.js `deleteVote` 409 "vote cannot be removed", modal.js `voteOnSlot` 409 "voting closed") — P2 #27 replaced native dialogs across the track/vote flows but missed these two. Swapped both to the in-app toast via `window.showToast` (it's exported onto window by track.js). Since modal.js was imported WITHOUT a cache-buster, started versioning it (`?v=1`) so the change actually reaches returning browsers. Verified: vote-remove via the ✕ works (gone from /api/account + "My Tracked Picks" empties, NO native dialog fires), there's no double-count (the verified vote shows only in My Tracked Picks, the custom bet only in the Custom Bets feed, and graded stats count the custom win once at +$45.45 / 1-0 while the pre-game vote stays ungraded), the default-odds picker round-trips to draftkings, and modal.js?v=1 + showToast both load clean. 0 console/page errors, 0 dialogs. account.js v17 / app.js v29 / modal.js v1 (newly versioned). Note: the 409 toast path itself can't be triggered locally (no started games), but the swap is mechanical and showToast is confirmed available; success paths verified.
- **Iter 20 (2026-06-27):** Rotated onto the "From a game" -> STARTED game branch + theme persistence. Verified (via a direct pickTrackGame on a `post` game) that a started game renders "This game has started, so verified tracking is closed. Use Custom bet to log it.", shows NO tappable ob-grid, and offers the "Log it as a custom bet instead" fallback which opens the custom form. Theme persistence: setting Light then reloading keeps `data-theme="light"` (persisted to localStorage), and switching back to Dark survives a reload too. 0 console/page errors, 0 native dialogs. No code change (nothing broken). No version bump. Process note: an initial search->click test "failed" only because two games matched "Osaka" (a finished WTA match + a pre-game one) and the pre-game sorts first, so the click landed on the non-started row — a test-selector ambiguity, not a bug. Data observation for Jack (NOT a tracking bug, not acted on): ESPN labels game 177563 "ATP" though it's Osaka vs Jacquemot (both WTA) — an upstream ESPN classification quirk in tennis_espn's feed; flagging only. **MEANINGFUL BACKLOG EXHAUSTED.** Remaining items all either need Jack's steer or are low value: #19 (week-ahead schedule — needs a new multi-day ESPN schedule fetcher + endpoint; real backend work), #22 (leaderboard timeframe+sport filters + sort — touches leaderboard.js, arguably outside the tracking surface), #16 (calendar/heatmap — decorative), #18 (live chip on pending custom bets — verified picks already show live status; custom bets rarely game-linked), #17 (CLV already shipped), #32-#37 (micro-polish: tag-level P/L, line-movement context, best-book in detail — all minor). Loop continues per Jack's "all day" at a slightly slower cadence; #19/#22 await Jack's call.


De-duplicated from three audits (AN UX gaps, competitor scan, code audit). Ordered P0 first. Each item is self-contained: one concrete change, files to touch, and a one-line acceptance check. All items fit existing data (verified votes, custom bets, today_games DK/FD lines, live scores, line movement, Polymarket/Kalshi) with no new Odds API credits.

---

## P0 — must (broken affordances + table-stakes betslip feel)

### 1. Confirmation toast after tracking any bet
- **Change:** Add a lightweight toast helper and fire it on success from `trackLine()` (verified vote) and `submitCustomBet()` (custom), e.g. "Tracked: Yankees ML −120". Currently both just close the sheet silently.
- **Files:** `public/modules/track.js` (`trackLine` ~L302, `submitCustomBet` ~L460), `public/index.html` (toast CSS/container)
- **Accept:** Tracking a line or submitting a custom bet shows a visible toast naming the bet before/while the sheet closes.

### 2. Disable odds-board lines whose odds are null / "—"
- **Change:** In the odds-board `line()` renderer, mark a line non-clickable when its odds are null/`—` (pre-5am, Golf, or sports with no Odds API). Today `line()` only disables when the game `started`, so tapping a `—` tracks a vote with null odds → ungraded / $0 CLV.
- **Files:** `public/modules/track.js` (odds-board render ~L283, `line()`)
- **Accept:** A `—`/null-odds line on the board is visually disabled and cannot be tapped to create a vote.

### 3. Fix silent settle failure in custom-bet submit (phantom win)
- **Change:** `submitCustomBet` fires `POST /api/bets/:id/settle` as fire-and-forget (`.catch(()=>{})`); on failure the bet stays `pending` but the sheet closes as if graded. Either settle in the same create request (pass `result` to create) or await the settle and surface an error toast on failure.
- **Files:** `public/modules/track.js` (~L454-459), `src/bets_router.js` / `src/user_bets.js` (optional: accept `result` on create)
- **Accept:** Logging an already-settled custom bet either persists with the chosen result or shows an error; it never closes showing a graded result while the row stays pending.

### 4. Guard against double-submit on verified track
- **Change:** Add a pending/disabled state to `trackLine` during the POST (it currently shows nothing). A fast double-tap can fire two votes before the sheet closes.
- **Files:** `public/modules/track.js` (`trackLine` ~L302)
- **Accept:** Double-tapping a line creates exactly one vote; the line/button is disabled while the request is in flight.

### 5. Real-time "to win" payout preview on the custom-bet form
- **Change:** As stake + odds change, show a live "Risk $X to win $Y → returns $Z" line using the existing `americanProfit`. Wire `updatePayoutPreview` to input events; also respect result state (do not show potential win when Result = Lost).
- **Files:** `public/modules/track.js` (`updatePayoutPreview` ~L415, form inputs ~L380)
- **Accept:** Typing stake/odds updates a live payout line; switching Result to Lost hides/zeros the "to win" figure.

### 6. Status pill + inline re-grade on every custom bet row
- **Change:** Every custom-bets row already shows a result pill; make settle controls reachable for any pending self-settled bet and allow re-grading a wrong/ungraded custom bet inline (not a separate screen). Include Won/Lost/Push/Void.
- **Files:** `public/modules/track.js` (`renderBets` ~L74-93, `settleBetUI` ~L114)
- **Accept:** Any self-settled custom bet row can be set/changed to Won/Lost/Push/Void from the row itself and the P/L updates.

### 7. Best-odds highlight on the odds board (DK vs FD)
- **Change:** On the odds board, compare DK and FD prices per side (already returned by `/api/game/:id`) and render the better price in green with a small "Best" badge. Turns the flat board into a line-shopping board.
- **Files:** `public/modules/track.js` (odds-board render ~L249-290)
- **Accept:** For a game with both DK + FD lines, the better price on each side is green and badged "Best".

### 8. Stop tracking spreads at a hardcoded −110 (or label it as assumed)
- **Change:** Odds board renders spread sides as `_odds(-110)` and the vote snapshot (`closingForSlot` / `index.js` vote endpoint) assumes −110, mis-pricing CLV/payout where real juice differs. Pull real spread juice from the game payload when present; otherwise render "−110 (assumed)".
- **Files:** `public/modules/track.js` (~L283-284), `src/user_bets.js` (`closingForSlot` ~L165), `index.js` (vote snapshot ~L1344)
- **Accept:** A spread line shows the real book juice when available, or an explicit "assumed" label; CLV/payout uses that value.

### 9. Edit + Delete reachable from every tracked bet row
- **Change:** Backend already supports `PUT /api/bets/:id` (`updateBet`), but the UI exposes only delete + settle and rows aren't tappable. Make each custom bet (and any not-yet-locked verified vote) tappable into a detail/edit sheet wired to `PUT /api/bets/:id`. Replace the native `confirm('Delete this bet?')` with an in-app confirm.
- **Files:** `public/modules/track.js` (`renderBets` ~L81-93, `deleteBetUI` ~L124), `src/bets_router.js` (`PUT /api/bets/:id` ~L40)
- **Accept:** Tapping a bet row opens an edit sheet; saving updates odds/stake/line/book/notes; delete uses the styled confirm, not `confirm()`.

### 10. Optional name + note fields on custom bets
- **Change:** Add an optional label + freeform note to the custom-bet form and persist them (add columns if absent). Makes off-platform (group-chat / X) bets legible later.
- **Files:** `public/modules/track.js` (custom form ~L336-385), `src/user_bets.js` (`createBet`/`updateBet`), `src/db.js` (migration: `note`, `label` columns on `user_bets`)
- **Accept:** A custom bet saved with a name + note shows both in the bet detail view.

---

## P1 — should (Action/Pikkit parity + core insight)

### 11. Over/Under segmented control for custom Totals
- **Change:** `submitCustomBet` forces every "total" into the `'over'` bucket and relies on free-text "Over/Under 8.5". Add an Over/Under toggle when bet type = Total and set `side` to `over`/`under` so it grades and buckets correctly.
- **Files:** `public/modules/track.js` (custom form ~L437), `src/user_bets.js` (`createBet` side handling ~L51-52)
- **Accept:** A custom Total bet has an Over/Under choice and lands in the correct over/under bucket in the breakdown.

### 12. Void result in the custom form + settle controls
- **Change:** `settleBet` already supports `void` and `betResultPill` renders it, but the form Result control and settle buttons never offer Void. Add Void everywhere a result is chosen.
- **Files:** `public/modules/track.js` (Result control ~L380-385, settle buttons ~L76-78)
- **Accept:** A bet can be logged or settled as Void and renders the Void pill.

### 13. Cumulative units-over-time performance chart on My Tracking
- **Change:** Add a simple cumulative net-units line chart at the top of My Tracking, built from merged verified votes + custom bets (`buildItems`), respecting the active timeframe pill. The single most "Action-like" missing visual.
- **Files:** `public/modules/account.js` (My Tracking render; `buildItems` ~L432)
- **Accept:** My Tracking shows a cumulative net-units curve that re-renders when the timeframe pill changes.

### 14. Units ↔ dollars (and ROI) metric toggle on the graph + stats
- **Change:** Add a 2- or 3-way pill (Units / $ / ROI%) that re-renders the chart y-axis and the stat cards. Dollars derive from `unit_size` in Bankroll & Units settings.
- **Files:** `public/modules/account.js` (My Tracking stats + chart)
- **Accept:** Toggling Units/$/ROI re-renders every figure on My Tracking consistently with the Bankroll & Units unit size.

### 15. Per-sport and per-bet-type breakdown cards above the bet list
- **Change:** Surface small summary cards (record, net units, ROI, win rate) bucketed by Sport and by Bet Type (ML/Spread/Total) above the list, in addition to the existing list filters. Core "where am I actually good" insight.
- **Files:** `public/modules/account.js` (My Tracking render; reuse sport/`pick_type`/result fields)
- **Accept:** My Tracking shows a per-sport row and a per-bet-type row of stat cards reflecting the active timeframe.

### 16. Calendar / heatmap P/L view
- **Change:** Add a month grid where each day is color-coded by net units, with a month total and tap-a-day to filter the list to that day's bets. Pikkit's most-praised screen; pure frontend on data we already have.
- **Files:** `public/modules/account.js` (My Tracking)
- **Accept:** A month calendar renders day cells colored by P/L; tapping a day shows that day's bets.

### 17. CLV done Action's way (beat-close % + value saved) with a plain-English teach and accurate label
- **Change:** Replace the single CLV number with two figures — % of bets that beat the close and cumulative value saved — and add a one-line explainer ("Beating the closing line is the skill signal"). Fix the label: `clvOf` skips spreads, so it covers ML & totals only; the current "graded verified picks" copy overstates it.
- **Files:** `public/modules/account.js` (CLV card ~L515, `clvOf` ~L412-428), `src/user_bets.js` (`betSummary` CLV ~L272)
- **Accept:** The CLV card shows beat-close % + value saved, says "ML & totals only", and includes a short explainer.

### 18. Live status chip on pending tracked bets
- **Change:** For a pending verified bet on an in-progress game, show a live score chip and a simple win/loss-leaning indicator (from live scores; optionally Polymarket/Kalshi %) in the My Tracking list.
- **Files:** `public/modules/account.js` (tracked-picks render ~L600), reads `/api/games` or game live fields
- **Accept:** A pending bet on a live game shows the current score and a leaning indicator instead of just "Pending".

### 19. Week / upcoming game schedule in the track game search (not today-only)
- **Change:** `trackFromGame` fetches today-only `/api/games`; add a date/upcoming window so users can track tomorrow's games and filter sports with no games today. Sport chips should reflect the selected window, not just today.
- **Files:** `public/modules/track.js` (`trackFromGame` ~L198, sport chips ~L210), `index.js` (`/api/games` date param if needed)
- **Accept:** The track game search can show and select a game scheduled beyond today.

### 20. Explain auto-grading on game-linked pending bets + empty board CTA
- **Change:** Game-linked pending bets currently show no settle controls and no hint (`settleBtns` gated on `!espn_game_id`). Add "Grades automatically when the game finishes." Also give the empty odds board a "Log it as a custom bet" CTA instead of dead-ending.
- **Files:** `public/modules/track.js` (`renderBets` ~L74, `renderTrackGames` empty state ~L229)
- **Accept:** A game-linked pending bet shows the auto-grade hint; the empty board offers a custom-bet CTA.

### 21. Verified badge + "what verified means" explainer everywhere a record shows
- **Change:** Visually badge verified-vote bets vs self-reported custom bets in the list, on My Tracking, and on the leaderboard, with a short tooltip (flat 1u, auto-graded, locked at game start). Reinforces leaderboard trust.
- **Files:** `public/modules/account.js` (records/list), `public/modules/track.js` (rows), leaderboard render
- **Accept:** Verified bets show a "Verified" badge with a tooltip; custom bets are visibly distinct.

### 22. Leaderboard timeframe + sport filters and ROI/win%/net-units sort
- **Change:** Expose Last 7 / 30 / all-time and sport filters on the flat-1u verified leaderboard, with a sort toggle (ROI vs win% vs net units).
- **Files:** leaderboard frontend module + backend leaderboard query (`src/leaderboard.js` / its endpoint)
- **Accept:** The leaderboard can be filtered by timeframe + sport and re-sorted by ROI, win%, or net units.

### 23. Bet detail view linking back to the game popup
- **Change:** Tapping a verified bet opens a detail showing matchup, logged line+odds, stake, result, line-at-game-time vs logged (CLV), and a link to re-open the rich game popup via stored `espn_game_id` + slot. Closes the loop between tracking and game data. (Builds on #9's sheet.)
- **Files:** `public/modules/track.js` / `public/modules/account.js`, reuse `openGameModal()` from `modal.js`
- **Accept:** A verified bet's detail shows CLV + a working link back to the game detail popup.

### 24. Escape-to-close + focus trap on the track sheet
- **Change:** The overlay only closes on backdrop click; add Escape-to-close and a focus trap so Tab doesn't escape to the page behind. Also wire Escape on the game-search input (documented behavior, currently missing).
- **Files:** `public/modules/track.js` (sheet setup ~L148-149)
- **Accept:** Escape closes the sheet and clears the search; Tab cycles only within the open sheet.

### 25. Day-grouped bet feed with per-day summary line
- **Change:** Group the bet list under day headers with a per-day record + units summary. Cheap, makes the list feel like Action; pairs with the calendar (#16).
- **Files:** `public/modules/account.js` / `public/modules/track.js` (`renderBets`)
- **Accept:** The bet list shows day headers each with that day's record and net units.

---

## P2 — nice (polish, edge cases, accessibility, retention/social)

### 26. Bump mobile tap targets to ≥44px
- **Change:** `bet-settle-btn` (~24px) and `bet-del` ✕ are below 44px; add `min-height`/padding to settle/delete buttons, sport chips, and segmented controls.
- **Files:** `public/index.html` (`.bet-settle-btn` ~L404, `.bet-del` ~L401, `.tg-chip`, `.bet-seg`)
- **Accept:** Settle, delete, chip, and segment controls are ≥44px tall on mobile.

### 27. Replace native alert()/confirm() in the track + vote flows
- **Change:** `trackLine`/`voteOnSlot` use `alert()` for errors; replace with the in-app toast/confirm from #1/#9 for consistent styling.
- **Files:** `public/modules/track.js` (~L309-310), `public/modules/modal.js` (~L896-897)
- **Accept:** No `alert()`/`confirm()` remain in the track or vote paths.

### 28. ARIA / a11y on interactive controls
- **Change:** Add `aria-pressed`/`role`/`aria-label` to segmented controls, sport chips, odds lines, and game rows; result pills get text not just color; add an `aria-live` region for the form error and payout preview.
- **Files:** `public/modules/track.js` (chips/segments/lines/rows, error ~L389), `public/index.html` (result pill markup)
- **Accept:** Screen-reader users get state + labels on track controls and hear payout/error updates.

### 29. Remove dead no-op loop and verify no double-active segment state
- **Change:** `setFormBook` runs a `document.querySelectorAll('.bet-seg-row .bet-seg').forEach(b => {})` empty loop; remove it and confirm switching bet type after selecting a book never double-activates a segment.
- **Files:** `public/modules/track.js` (~L408)
- **Accept:** The dead loop is gone and only one segment per row is ever active.

### 30. Block or flag $0 stake
- **Change:** `createBet` clamps stake to 0; a $0 bet records a W/L but contributes 0 to ROI/units. Block submission of stake=0 (or flag it) in the form.
- **Files:** `public/modules/track.js` (custom form validation), `src/user_bets.js` (`createBet` ~L47-48)
- **Accept:** Submitting stake=0 is rejected with a clear message (or the bet is flagged as non-counting).

### 31. Odds-board load-failure retry
- **Change:** `pickTrackGame` shows "Could not load this game." with only a back button; add a Retry that re-fetches `/api/game/:id`.
- **Files:** `public/modules/track.js` (~L255)
- **Accept:** A failed game load offers a Retry that re-attempts the fetch.

### 32. Align track game-search min length to 2 chars
- **Change:** `renderTrackGames` filters at `q.length >= 1`, but the documented search uses min 2; raise to 2 to stop thrashing the row list.
- **Files:** `public/modules/track.js` (~L224)
- **Accept:** Single-character queries no longer filter the game list.

### 33. Single source of truth for the sport list
- **Change:** Three drifting sport lists: `track.js SPORTS` (incl. CBB/NCAAF), odds-board chips derived from today's games, and `account.js ALL_SPORTS`. Consolidate into one shared constant.
- **Files:** `public/modules/track.js` (~L13), `public/modules/account.js` (~L8), shared util
- **Accept:** All three places import one sport-list constant.

### 34. Preserve sport filter when a bet list filter yields zero rows
- **Change:** `presentSports` is recomputed from `_bets`; an empty filtered set drops the chosen sport from the dropdown and silently resets it. Keep the selected sport even when no bets match.
- **Files:** `public/modules/track.js` (`renderBets` ~L58)
- **Accept:** Filtering to a sport with zero matching bets keeps the sport selected and shows an empty state.

### 35. Line-movement context under the line you're about to track
- **Change:** On odds-board tap, show a one-line "line moved 7→7.5, 64% of money on home" from existing line history + public betting, so the betslip teaches while you log.
- **Files:** `public/modules/track.js` (odds-board line detail), reads `/api/game/:id` lineHistory + publicBetting
- **Accept:** Tapping a line shows a one-line movement + public-money context note.

### 36. Best-book context inside the bet detail
- **Change:** In the bet detail (#23), show "DK had −110, FD had −105 at logging" so users see we shopped. Reuses DK/FD lines already pulled per game.
- **Files:** `public/modules/track.js` / `public/modules/account.js` (bet detail), game payload
- **Accept:** A bet detail shows both DK and FD prices captured at logging time.

### 37. Bet tagging with tag-level P/L
- **Change:** Add a tags column (free bet, live, promo, custom) to custom + verified bets and a tag breakdown on My Tracking.
- **Files:** `src/db.js` (tags column), `src/user_bets.js`, `public/modules/track.js`, `public/modules/account.js`
- **Accept:** A tagged bet shows its tag and contributes to a tag-level P/L breakdown.

### 38. Parlay / multi-leg custom bet support
- **Change:** `BET_TYPES` already includes `parlay`/`future` but the form exposes only ML/Spread/Total/Prop and legs aren't modeled. Add a parlay builder (stack legs from the odds board or manual), auto-calc combined odds, single stake, grade when all legs settle. Personal-only (never on the flat-1u leaderboard); natural paid-tier gate.
- **Files:** `public/modules/track.js` (custom form ~L336-340), `src/user_bets.js` (`BET_TYPES`/grading ~L13-14, `createBet`), `src/db.js` (parlay legs storage)
- **Accept:** A 2+ leg parlay tracks with combined odds and grades as a single unit when all legs settle.

### 39. "Keep picks in betslip" / staged selections after track
- **Change:** Optionally keep the odds board open / selections staged after a track for fast multi-bet logging.
- **Files:** `public/modules/track.js` (`trackLine` post-success ~L302)
- **Accept:** After tracking, the board can stay open with the option to add another bet.

### 40. Settle / win-loss notifications on tracked bets
- **Change:** Fire a simple in-app (or push) notification when a tracked bet grades ("Lakers −3 graded a WIN, +1u").
- **Files:** results/grading path (`src/results.js` / cron in `index.js`), frontend notice surface
- **Accept:** A graded tracked bet produces a settle notification.

### 41. Shareable winning-bet ticket image
- **Change:** Generate a branded share-card (matchup, line, odds, units won, verified badge) for a settled winning bet; extend the existing `detail_page.js` shareable render. Free marketing loop.
- **Files:** `src/detail_page.js` (per-bet card variant), share entry point in track/account UI
- **Accept:** A settled winning bet produces a downloadable/shareable branded PNG-style card.

### 42. Period/season recap (#ActionWrapped-style) + streak module strip
- **Change:** Build a lightweight swipeable recap (best/worst sport, most profitable team, biggest win) from existing tracking data, and promote Hot Streak + Best Week + a Winning-Days Streak into a horizontal module strip at the top of My Tracking.
- **Files:** `public/modules/account.js` (My Tracking top modules + recap view)
- **Accept:** My Tracking shows a top streak-module strip and a swipeable period recap built from tracked data.

### 43. (Blocked) BetScan-style screenshot-to-track and sportsbook deep-link/QuickSlip
- **Change:** Note as future: image-drop on the custom form pre-filling stake/odds/team via the Haiku reader path (high effort), and one-tap book placement (needs affiliate deals). Park until prioritized / partnerships exist.
- **Files:** `public/modules/track.js`, `src/reader.js` (image path) — future
- **Accept:** Documented as a deferred epic; no implementation expected in this loop.