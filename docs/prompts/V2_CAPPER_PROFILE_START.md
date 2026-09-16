# Capper profile: start here (paste this whole file into a new session)

You are starting in `~/projects/capperboss` (the main checkout, branch bet-tracking). Do NOT build there. Model: Fable 5.1, high effort.

## Step 0: move to the right folder and catch up

1. Switch this session's working directory to `/Users/jack/projects/capperboss-v2` (the V2 worktree, branch `v2-database`). Use the directory tool, not `cd`.
2. In that folder run `git fetch origin` and `git merge --ff-only origin/master` so the branch matches what is deployed.
3. If `node_modules` is missing there, symlink it: `ln -sfn /Users/jack/projects/capperboss/node_modules node_modules`. If `data/capper.db` is missing, run `node scripts/seed_capper_history.js` (loads the newest prod export, seeds six busy games into today_games, runs the V2 recompute) and then set the local switch: `node -e 'const db=require("./src/db");db.setSetting("product_mode","v2");db.setSetting("v2_free_pending","1")'`.
4. Read, in this order: `CLAUDE.md` (the main checkout's; the worktree has none), the memory notes `project_v2_game_section_build` and `project_v2_capper_database`, `docs/V2_DATABASE_PLAN.md` sections 7b and 7c, `docs/prompts/V2_CAPPER_PROFILE_MOCK.md` (the lab spec, every rule for the page lives there), `src/capper_page.js` (the profile SHELL that exists today), `src/capper_db_section.js` and the `html.ca-v2` block at the end of `public/game-detail.css` (the row anatomy, chips, badges and color contract the profile must share), `src/capper_v2.js` and `src/game_backers.js` (where every number comes from).

## What exists already (do not rebuild it)

- The game page's **Capper Report** section is live (behind `settings.product_mode`, admin preview with `?mode=v2`). Each row is ONE link to `/capper/<slug>?sport=<SPORT>`.
- `/capper/:slug` (src/capper_page.js) is a plain placeholder: header, big record, sport chips, sport panel, recent picks, the (i) note. It uses the real data: `capper_ratings_v2` (per capper x scope x window) via `capper_v2.getRating`, the registry via `capper_public.publicCapper` (aliases, badges, hidden), and `capper_history` for the pick list. V2 only, noindex.
- Local server for the browser: launch config `v2-server` (port 3021, `ADMIN_PASSWORD=devpreview`, both `.claude/launch.json` files carry it). Open `http://localhost:3021/mlb/sox-vs-yankees-2026-09-17`, tap any row. `http://localhost:3021/capper/oldschool0909?sport=MLB` is a real live capper on the seeded data.
- The app: `~/projects/capperboss-app` (branch `app`). Its dev server is the pm2 app `capperboss-app` on localhost:3013, DB already seeded and set to V2. To see a change in the iOS Simulator: merge into `app` (`git merge origin/master`, resolve the `?v=` collisions by taking the higher number, check the brace count of game-detail.css, `node --check` the server files), `pm2 restart capperboss-app`, then in the Simulator (attach first) go Home, tap Sox at Yankees, tap a row. A page opened in the first seconds after a restart can be the old HTML; Back and reopen.

## Phase A: the lab (Jack picks, nothing built yet)

Follow `docs/prompts/V2_CAPPER_PROFILE_MOCK.md` exactly: five directions by independent designers (sketch literal, stat-first, ledger continuity, tabbed, compact card stack), one critic pass and one revision each, the VeryLucky888 fixture on the Athletics at Rays game, assembled with `docs/mockups/assemble_lab.js` + `docs/mockups/lab_chrome.html` into `docs/mockups/v2_capper_profile_lab.html`, one headless-Chrome render per direction at 500px reviewed before publishing (the Browser pane cannot open artifacts), published as a private artifact. Then STOP and ask Jack which direction wins, with two plain options per open question.

## Phase B: build the winner into the real page

After Jack picks: port the winning fragment literally into `src/capper_page.js` (server-rendered like the game section, CSS in `public/game-detail.css` under `html.ca-v2`, classes prefixed `.cp-`), the sport tab preselected from `?sport=`, window pills All / 30d / 7d reading the `window` column, Today's Picks from `capper_history` pending rows joined to `today_games` (paid; free users see one masked cell + one subscribe prompt), Recent picks 25 then Show more (same 4.5-rows-then-scroller behavior as the report), streak and season chips from the same fields the report uses, Follow as a stub button for now (Favorites arrive with the home phase), the (i) note and the two footer links. Names never truncate on the profile. No scores, bands, Wilson, gates, fade, channel names, self-reported records, or the words expert / pro / sharp / proven / hot / cold / fade / best / worst / winner / loser. No em dashes.

Then: cache-buster bump on every file that links the stylesheet, commit on `v2-database`, push, `git push origin v2-database:master` (Railway deploys; V1 stays untouched because the page is v2-only), merge into `app`, restart `capperboss-app`, open the profile from a row in the Simulator and send Jack the screenshot. Update `docs/V2_DATABASE_PLAN.md` 7c, `docs/UI_VOCABULARY.md`, the CLAUDE.md file note for src/capper_page.js, and the memory note.

## Rules

Do not touch expert_data.js or espn_live.js. Never name a capper in push, CTAs, share cards or titles. Ask Jack questions with context and two plain options, never a bare label. Keep V1 one setting away.
