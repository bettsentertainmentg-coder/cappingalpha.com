# Build the V2 Capper Database section into the real app (new session)

Paste this into a new session started FROM `~/projects/capperboss-v2` (the V2 worktree, branch `v2-database`, off origin/master). Model: Fable 5.1, high effort. Read first: CLAUDE.md, docs/V2_DATABASE_PLAN.md (sections 3, 5, 6, 7b, 9, 10), the memory note project_v2_capper_database, and docs/APP_WORKSHOP.md in `~/projects/capperboss-app`.

## Goal

Jack wants to stop looking at simulations and edit the real thing. Ship the V2 game page section, the bottom section wheel and the header search button into the actual game page, behind the product switch, so the iOS app shows it on real games. V1 keeps running and is one setting away.

## The pixel reference (port it literally, do not restyle)

- Fragment: docs/mockups/v2_game_backers_v18.json (html + scoped css, classes `.v18`, the color contract `.pk pk-<side>`, `.src src-an|pm|cv|cm`, `.stk`, `.sb`). Rename the scope to the real section classes but keep every size, spacing and color decision.
- Host color contract: docs/mockups/lab_chrome.html, the block starting at "round 3 color contract" (team ink and fill variables, the four pick-chip modes, the three badge modes). Ship the settled modes: pick chips TINT, badges TINTED TEXT, cards EDGE TO EDGE. Keep the other modes in CSS behind html classes so Jack can flip them from the admin preview.
- Real-page proof: docs/mockups/v2_game_section_real_page.png (what it must look like on a phone) and docs/mockups/build_real_page_mock.py (how the fragment was injected into the prod page; the header search button and the bottom wheel CSS live there).
- Rules, all settled with Jack (plan section 7b): heading "Capper Database" (a better media-style name is still open; make the string one constant), subline "N cappers · SPORT record · $10 a pick"; five count pills with side-colored text (away ink, home ink, Over green, Under yellow, redder-orange Under when the team wears gold or yellow); no six-slot grid; no humility line or grading note in the section, a round (i) at the bottom right that opens the note "Their record as we recorded it since July 2026, graded by us at the line and price we saw. It can differ from records they publish. $10 a pick. N more cappers we track have not qualified in SPORT yet."; ONE tap per row opening the capper profile on that sport's tab (the pick chip is information only); badge on the name line, name 15px then 13px past 12 characters, cut at 16 with "..."; metrics line "W-L  +$money  +ROI% ROI", "Recorded Nh before start", chips Small sample (under 20 in the sport), "SPORT W5" flame / "SPORT L5" snowflake from 5 straight, season badges "+$610 this season" and "61-41 this season" for the top 5% of the sport this season by money and by win percentage (30-pick floor), on the faded chip with colored numbers (money green or red, W green, L red, T yellow); order money in the sport descending; four and a half rows visible with a fade, "Show more" expands to a contained scroller about seven and a half rows tall with an up-arrow (no words) to collapse; with three or fewer cappers, no fade and no button; freeze at the true start; W / L / PUSH tint after grading; unqualified cappers only as the count in the (i).

## Backend needed (the smallest slice of Phase 1 that makes the section real)

1. db.js: `capper_ratings_v2` (per capper x scope x window as in plan 5a), `capper_qualifications` (the one-way door, insert-only), the registry columns slug / display_name / name_mode / alias_name / hidden / live_at, indexes on capper_history (capper_name, game_date) and (espn_game_id). Settings: product_mode ('v1'), v2_min_picks 30, v2_bar_kind 'units', v2_bar_value 100, v2_streak_min 5.
2. src/capper_v2.js: recomputeCapperV2() with the plan 3c exclusions (live, backfill, no espn_game_id, corrupt prices, implausible lines via audit.implausibleLine, wallets failing the straight-bettor screen), the qualification pass on the OVERALL record, season badge marks (top 5% in sport this season by money and by win% with the 30-pick floor), streaks per sport. Hooks: 5:20am, startup, after a grade pass, admin button. Never at request time.
3. src/capper_public.js: publicCapper() and the alias pool (scripts/gen_alias_pool.js, handle-style names; Discord-only and BettingPros cappers aliased; FAKE badge in admin).
4. src/game_backers.js: getGameBackers(espn_game_id) reading capper_history pending + graded rows for the game, joined to capper_ratings_v2 (sport scope) and the registry, live cappers only, unqualified as a count. Rides GET /api/game/:id as `backers` when product_mode is v2 or the admin preview cookie is set.
5. src/product_mode.js: getProductMode(req) honoring an admin-only `?mode=v2` preview that sets a cookie for that browser. /api/config returns product_mode.
6. Seed for local work: scripts/seed_capper_history.js loads data/capper-server-pull/full-export-20260903.json (or a fresh pull) into the local DB and runs the recompute.

## Frontend

- src/detail_page.js: under v2 the picks section renders the Capper Database shell (title, subline, pills, list, (i)); public/game-detail.js renders rows from `backers`; game-detail.css carries the ported styles and the color contract. The mobile tab label "PICKS" becomes "CAPPERS".
- The section wheel (`.ca-mobile-tabs`) is pinned to the BOTTOM of the page on phones, flush above the tab bar (measure the tab bar height), scroll spy unchanged. Under v2 only.
- Header: a search button after the hamburger (magnifier, same style as the hamburger), left of the wordmark; it opens the existing game search for now (global search comes with the home phase).
- Cache-buster chain on every touched module (docs/UI_VOCABULARY.md rule 9). Name the new components in UI_VOCABULARY: Capper Row, Count Pills, Source Badge, Pick Chip, Season Badge, Streak Chip, Section Wheel (bottom), Header Search.

## The switch

settings.product_mode = 'v1' by default: nothing public changes. Under 'v2' (or the admin preview) the game page shows the section, the wheel moves to the bottom, the search button appears. V1's picks section and its JS stay in the code path for 'v1'; deleting nothing. Admin: a "V2 Database" tab with the product switch, the preview toggle, the bar settings and a Recompute button (the rest of the admin tab can follow).

## Ship and verify

1. Build on `v2-database`, commit, push, deploy to master (Railway). Run the recompute once on prod from the admin button.
2. In `~/projects/capperboss-app` (branch `app`): commit the uncommitted page-stack work first (Jack approved), merge origin/master, run the app in the iOS Simulator, open a real game page with the admin preview on, and screenshot it. The app frames the prod game page, so the section arrives with no app UI work.
3. Report with the screenshot from the simulator, the prod URL with the preview cookie instructions, and anything that differs from the reference PNG.

Do not touch expert_data.js or espn_live.js. No V1 scoring in the section. No capper name in push, CTAs, share cards or titles. No em dashes in copy.
