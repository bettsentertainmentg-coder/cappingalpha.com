# CappingAlpha V2: the capper database. Build plan

Written 2026-09-14, revised 2026-09-15 (round 2 of Jack's answers, the ESPN home and preferences flow, player profiles, App Store purchases). Sources: the kickoff prompt (docs/prompts/V2_CAPPER_DATABASE_KICKOFF.md), Jack's voice notes, profile sketch, the ESPN home screenshot, the ESPN preferences screen recording and two ESPN player-page screenshots, the Sept 3 direction plan (docs/CA_DIRECTION_PLAN_2026_09.md sections 3, 7, 9), the Path B product concept and codebase inventory reports (docs/research/2026-09-03-direction/work/), and the legal lens summary (work/RESULTS_ROUND2_ALL.json; section 3d of the direction plan).

Status: PLAN ONLY. Nothing is built. Section 14 lists what is settled and what is still open. The game page mock lab (seven layouts) is a separate artifact linked there.

---

## 1. What V2 is, in one paragraph

CappingAlpha stops ranking picks. It reports on the cappers who post picks in public, grades every pick itself at the line and price it recorded, and shows two things: who is on each pick today, and what each capper's record is. Cappers are ranked on money made (net at $10 flat per pick). A capper goes live on the site only after crossing a qualification bar on their overall record, and once live is never taken off. There is no score, no band, no points, no #1 pick. The app is the front door: an ESPN-style home (scores, favorites, my games, articles, no capper content), Cappers in the middle tab, "who is on this game" on every game page, player profiles, and App Store purchases instead of Stripe. The whole thing sits behind one setting, settings.product_mode, default 'v1'. V1 keeps running underneath: its scrapers, grading and audit are exactly the pipeline V2 reads from.

Positioning (Jack, 2026-09-14): CappingAlpha is a reporting source, sports media. We show only people we can show, from picks they posted publicly, graded by us. Records are history, not advice.

Build order (Jack, 2026-09-15): wrap up the UI, wrap up the capper database, make sure bet tracking is sound, then the App Store. Section 12 follows that order.

---

## 2. What V1 gives V2 for free (and what it does not)

| V1 piece | V2 use |
|---|---|
| Scrapers (an_experts, covers_contests, polymarket_wallets, bettingpros, wagertalk, the column ingests) writing capper_history through source_ingest | THE feed. V2 has no scraper of its own. |
| results.js Pass 5 grading of capper_history + audit.js re-checks | THE grades. V2 never grades. |
| capper_aliases, capper_registry, capper_source_handles, buildResolver() in capper_ratings.js | Identity. V2 reuses the resolver as data plumbing (it is not the Wilson engine). |
| Admin capper popup (equity curve at admin.js:3620, monthly bars :3642, per-sport and per-type tables) | Template for the public profile. Only the curve, bars and record tables port. Header chips, fade panel, points pipeline, Band/Pts/Edge columns never cross. |
| member_profile.js popup, socials leaderboard table, Sticky Rail Table, Segmented Control, Chip Rail, the Top Games Card Rail, My Sports picker, game search, headlines.js (Google News feed) | UI components and feeds for the profile popup, the database table, the game page toggle, the new home and Articles. |
| detail_page.js + game-detail.js (server-rendered game page, framed by the app's page stack) | "Who is on this game" is built once here and reaches the app with zero app work. |
| player_form.js (ESPN athlete gamelog), tennis_photos.js (Wikipedia photo resolver), game_stats.js (ESPN summary, team schedule) | The seeds of player profiles and the schedule fetcher. |
| user_preferences.favorite_sports, push topics (game_start, grades) | The seed for Favorites and the My Games bell. |
| polymarket_wallets.js straight-bettor screen (hedge / cashout / sell / pregame gates) | The rule that keeps prediction-market TRADERS out; V2 documents it publicly. |
| pick_privacy.js | Stays for V1 rows. V2 gets its own filter (capper_public.js). |
| capper_ratings (Wilson ladder) | NOT used. V2 materializes its own table. |

What V1 does not give: Discord capper_history writes stopped 2026-08-27 and the Polymarket wallet feed stopped 2026-08-31 (direction plan section 7, items 1 and 2). Both are handed to the Profile Data Accuracy Audit session (docs/prompts/LEDGER_ACCURACY_AUDIT_ADDENDUM.md). V2 builds nothing that depends on either coming back.

---

## 3. The ranking, the bar, and the one-way door

### 3a. Conventions

| Term | Definition |
|---|---|
| Graded pick | result in win, loss, push. Void and pending never count. |
| Units | Net dollars at a flat $10 stake on every graded pick, at the price stored on the row. Win at +150 = +$15. Win at -120 = +$8.33. Loss = -$10. Push = $0. Displayed as dollars ("+$204"), with "at $10 per pick" in the Grading Note. |
| ROI | units / (10 x graded picks). Pushes are in the denominator (they risked $10). |
| Record | W-L-P. Win% = W / (W + L). |
| Sample | graded picks, first pick date, last pick date, active in the last 14 days. |
| Priced share | graded rows with a stored price / graded rows. The rest are graded at -110 (sides) or -115 (totals) and the profile says so. |
| Scope | overall, one per sport (Tennis = ATP + WTA together), one per bet type within a sport (ML, spread, total). |
| Window | all-time, 30 days, 7 days (by game_date). |
| Ordering inside a sport (settled 2026-09-15) | money made in that sport, descending; tiebreak win% then record size. ROI is always shown beside it and is a sortable column, never the default. Default window all-time; 30-day and 7-day filters one tap away. |
| Sample inside a sport (Jack, item 16) | a capper who is live shows every pick publicly, even their fifth NFL pick, but ranks below cappers with a real NFL sample. Proposed mechanism: sample tiers inside a sport (50+ picks, 20-49, under 20) as the first sort key, money inside each tier; the tier is labeled on the row ("15 NFL picks, small sample"). Open, item 32. |
| Streak | the current run of wins or losses. Shown from 5 straight: the count with a flame for wins, a snowflake for losses. |

### 3b. Qualification: a one-way door on the OVERALL record (Jack, items 11 and 16)

- A capper appears on the live site only after crossing the bar on their overall record (all sports together). Before that they exist only in the admin pool: no profile, no name on a game page, no search hit, no sitemap entry. Unqualified cappers show publicly only as a count ("4 more cappers we track have not qualified yet").
- Once live, never taken off. The profile stays live with whatever the record becomes. The only removal is an admin hide for a legal order; rows are never deleted.
- Once live, every pick shows publicly in every sport, including sports where the sample is tiny; the sport ranking handles the sample (3a).
- Written by the nightly job into capper_qualifications with the date and the bar that was met. Insert-only.
- The bar value is OPEN (Jack: "profitability or ROI after a minimum number of bets"). At a bar of "positive", units and ROI are the same test; they differ only above zero.

What the one-way door does at each bar, on the overall record. The Sept 3 export walked in date order, before the ledger fix (every number will move; the shape will not):

| Bar (at 30+ graded picks overall) | Qualified at some point | Negative today | Median today | Who they are |
|---|---|---|---|---|
| units > 0 | 226 | 103 (46%) | +$13 | Polymarket 95, Covers 54, BettingPros 37, AN 19, Discord 19, columns 2 |
| units >= $100 | 61 | 11 (18%) | +$92 | Polymarket 34, Covers 8, BettingPros 8, AN 6, Discord 5 |
| units >= $200 | 14 | 0 | +$234 | Polymarket 10, AN 2, BettingPros 1, Discord 1 |
| ROI >= 5% | 185 | 68 (37%) | +$25 | |
| ROI >= 10% | 154 | 47 (31%) | +$38 | |

Read: "positive at 30" opens the door to 226 people and nearly half would already be showing a loss; "+$100 at 30" opens it to 61 with fewer than one in five underwater. Recommendation: 30+ graded picks overall and units of +$100 or more, both admin settings, plus a "meets the bar today" filter on the Database view (on by default) so the first view is the currently profitable set while the door stays one-way. Polymarket wallets are more than half of the live set at every bar, so the feed fix in the accuracy audit matters for day one.

### 3c. Rows excluded before anything is counted (every V2 reader, applied once at materialization time)

| Exclusion | Rule | Why |
|---|---|---|
| In-play | sources_json carries live:true | never a pregame pick |
| Polymarket backfill | sources_json carries backfill:true, or espn_game_id is null | outcome-selected history, not observed picks |
| Polymarket traders | wallets that fail the straight-bettor screen (hedge / cashout / sell / pregame gates in polymarket_wallets.js) | Jack: we track bettors who take one side before the game and hold it, never traders |
| Corrupt price | odds not null and (abs(odds) < 100, or odds < -2000, or odds > +1500) | 607 rows in the Sept 3 export |
| Implausible line | audit.implausibleLine() from the ledger fix branch | 569 rows, an ingest bug, still unfixed at the source |
| Wrong-line grades | the ledger fix (section 4) restates them; until it has run on prod, no V2 number is public | 1,687 wrong grades across 473 cappers |

Handled at read time, not hidden: the 20% of picks with no stored price (shown as priced share), same-capper both-sides pairs (both rows count, the game page marks "both sides").

---

## 4. Prerequisite: the ledger, owned by the accuracy audit session

"The ledger" is capper_history: the table with every capper's picks and their win/loss results, the thing every V2 number is computed from. Jack is already running a Profile Data Accuracy Audit session on it (BettingPros mis-matched picks). That session now owns every ledger repair; docs/prompts/LEDGER_ACCURACY_AUDIT_ADDENDUM.md is the list to paste into it: the wrong-line fix (branch fix/ledger-line-grading, merges clean, regrade endpoint dry-run first), BettingPros matching, in-play Polymarket fills, backfill rows, the bettor-vs-trader screen and its public paragraph, the two dead feeds, corrupt prices, tennis tours, the UTC game_date, both-sides pairs, audit coverage.

V2 reads the ledger and applies section 3c on top. No V2 number goes public until the wrong-line regrade has run on prod.

---

## 5. Data layer

### 5a. New tables and columns (src/db.js, migrations run at boot as always)

capper_ratings_v2, one row per (capper, scope, window):

| Column | Meaning |
|---|---|
| canonical_name | registry key |
| scope | 'overall', 'sport:MLB', 'type:MLB/ml' |
| window | 'all', '30d', '7d' |
| graded, wins, losses, pushes | counts |
| units | net dollars at $10 flat |
| roi, win_pct | derived |
| avg_odds | mean American price of graded picks (a style stat: favorites vs dogs) |
| priced | graded rows with a stored price |
| first_pick, last_pick | game_date bounds |
| active_14d | 0/1 |
| streak_len, streak_kind | current run, e.g. 7 and 'W' |
| sample_tier | 'large' 50+, 'medium' 20-49, 'small' under 20 (per scope) |
| meets_bar | 0/1, meets the bar today (display filter; qualification lives in capper_qualifications) |
| rank_money | position among live cappers in this scope and window under the tier-then-money order |
| computed_at | |

UNIQUE(canonical_name, scope, window). Indexes on (scope, window, sample_tier, units).

capper_qualifications, the one-way door: canonical_name, qualified_at, bar_json (the bar values met), UNIQUE(canonical_name). Insert-only.

capper_profile_v2, one row per capper: curve_json (cumulative units by graded pick, overall and per sport, downsampled to 200 points), monthly_json, style_json (top sport, top bet type, favorite vs underdog share, picks per week, typical price), sources_json (public source classes plus the handle where it is public), computed_at. A profile is one read, never a history scan.

capper_registry, new columns:

| Column | Meaning |
|---|---|
| slug | UNIQUE, backfilled for every registry row; aliased cappers get the slug of their alias name |
| display_name | admin override |
| name_mode | 'auto' (alias if every source of this capper is discord or bettingpros, else public), 'public', 'alias' |
| alias_name | the pseudonym; the real-to-alias mapping is admin-only and marked FAKE wherever admin shows it |
| hidden | 0/1, admin only, for a legal order. Rows are never deleted. |
| optout_at, optout_note | the request trail |
| bio, bio_sources_json, bio_status | the bio text, the URLs it was written from, 'draft' / 'approved' |
| primary_source | derived nightly, drives the badge |
| live_at | denormalized from capper_qualifications |

capper_requests: the public correction / alias / removal / claim form (slug, kind, contact, message, ip_hash, status, admin_note, created_at, resolved_at). Rate limited like /api/support.

favorites (new, replaces the favorite_sports-only model): user_id, kind ('team' | 'capper' | 'player' | 'sport'), key (team: sport + ESPN team id; capper: slug; player: sport + ESPN athlete id; sport: label), label, added_at, UNIQUE(user_id, kind, key). favorite_sports stays as a mirror for the existing readers.

players (cache, not a source of truth): sport, espn_id, name, team, position, jersey, bio_json (height, weight, birthdate, college, country), stats_json (season line + ranks), updated_at. Filled on demand and by the favorites sweep from ESPN's free athlete endpoints (section 7f).

schedule (upcoming games per team, beyond today): sport, espn_team_id, espn_game_id, start_time, opponent, home_away, network, fetched_at. Filled daily for favorited teams by src/schedule.js (ESPN team schedule endpoint, free; espn_live.js untouched).

apple_transactions (section 8): original_transaction_id UNIQUE, user_id, product_id, purchased_at, expires_at, status, environment, last_notification_at, raw_json.

Indexes added on capper_history: (capper_name, game_date) and (espn_game_id).

Settings (all editable in the admin V2 tab):

| Key | Default | Meaning |
|---|---|---|
| product_mode | 'v1' | the switch |
| v2_min_picks | 30 | qualification bar, graded picks overall |
| v2_bar_kind | 'units' | 'units' or 'roi' (open, item 11) |
| v2_bar_value | 100 | the units ($) or ROI (%) threshold (open, item 11) |
| v2_streak_min | 5 | streak length before the flame or snowflake shows |
| v2_free_pending | 0 | 1 = pending picks free (settled: paid) |
| v2_alias_prefix | unused | aliases are names from the pool, not numbers |

### 5b. The materialization: src/capper_v2.js

recomputeCapperV2(): one pass over capper_history (about 80k rows), alias fold through buildResolver(), the exclusions from section 3c, then counts per (capper, scope, window) plus streaks, curves, monthly and style; then the qualification pass (insert any capper whose overall record crossed the bar; stamp live_at). Writes inside one transaction. Under a second on the current volume.

Triggers: 5:20am with the nightly ratings job, at startup, after every grade pass that changed a row (the same hook results.js:1036 uses for V1), and the admin Recompute button. Ratings are never computed from raw history at request time.

Reads (all O(1) table reads): getBoard({sport, window, minPicks, source, sort, q, meetsBar}), getToday({sport, window}), getProfile(slug, {window}), getProfilePicks(slug, {before, limit, pending}), getNextUp() (admin: closest to the bar), plus src/game_backers.js getGameBackers(espn_game_id).

### 5c. Naming: src/capper_public.js

Every capper row leaving the server goes through publicCapper(row, registry):

| Keeps | Drops |
|---|---|
| display name (alias name when name_mode resolves to alias, else display_name, else canonical), slug, initials, source platform or Community, record, units, roi, win_pct, graded, sample tier, priced share, streak, first/last pick, live_at | canonical raw name when aliased, channel, score, pick_id, sources_json, score_v2_original, any capper_ratings (V1) column, any handle that is an email |

Rules baked in:
- Platform names on the badge for public sources (settled): Action Network, Covers, Polymarket, WagerTalk, and the column outlets. Discord is always "Community", always aliased.
- BettingPros cappers are aliased from day one (Jack's lean, item 7): the ingest uses a key harvested from their site and their parent company's terms ban commercial use; a fake name costs nothing and can be flipped to the public slug later with one flag if permission arrives. BettingPros identities key on the profile slug internally, never the username (often an email).
- Aliases are fake names, handle-style (BlueLinePicks, RiverCityRick): a pool generated once by scripts/gen_alias_pool.js, assigned at random, never derived from the real name, never reused, never a realistic first-and-last name, stored only in the registry. Admin shows a FAKE badge on every aliased row and the real name beside it. A later reveal flips name_mode to public and keeps the alias as a redirect. Community profiles carry the line "Shown under a pseudonym."
- A capper on Discord AND a public source shows under the public source only (settled).
- hidden = 1 removes the capper from every public reader. Alias is the standard remedy; hide is the escalation.
- Polymarket wallets show the handle, else the shortened address (0x99F0...9495). Only wallets that pass the straight-bettor screen are ever shown.
- No capper name in paywall CTAs, push text, share cards, OG tags or SEO titles. Profile pages carry a plain title ("<name> on CappingAlpha") and the OG card shows record, units and n only.

---

## 6. Routes

### 6a. Public API (index.js; new routes added to MIRROR_SKIP so local dev serves them itself)

| Route | Returns | Tier |
|---|---|---|
| GET /api/config | adds product_mode, the v2 block, and store: 'apple' or 'stripe' for the client | all |
| GET /api/cappers?sport=&window=&min_picks=&source=&sort=&q=&meets_bar= | the database list, live cappers only, tier-then-money order | free |
| GET /api/cappers/today?sport=&window= | live cappers with a pending pick on a game starting today, grouped by game | paid (free: counts only, names masked) |
| GET /api/capper/:slug?window= | profile: header, record tiles, per-sport and per-type tables, curve, monthly, style line, bio, today's picks, recent picks (first page), sources, grading note | free; today's pending picks paid |
| GET /api/capper/:slug/picks?before=&limit= | pick list pages | free for graded rows |
| GET /api/game/:id | adds backers: {byPick: six slots, byCapper: one list, counts, unqualified_count, frozen, graded} under v2 (or admin preview) | pregame: paid (free: counts). Finished: free |
| POST /api/capper/request | the correction / alias / removal / claim form | all, rate limited |
| GET /api/home | favorites rail, my games, most wagered, articles (filtered by favorites when any) | free |
| GET /api/search?q= | games, teams, live cappers, players (section 7g) | free |
| GET /api/favorites, PUT /api/favorites | the favorites list and its edits | account |
| GET /api/player/:sport/:id (+ /gamelog, /splits, /news) | player profile payloads (section 7f) | free |
| GET /capper/:slug | server-rendered profile page (web + share links; noindex under 50 graded) | free |
| GET /player/:sport/:slug | server-rendered player page (web + share links) | free |
| POST /api/iap/verify, POST /api/iap/apple-notifications, POST /api/iap/restore | section 8 | app |
| sitemap | adds /capper/<slug> for live cappers with 50+ graded | |

V1 routes stay behind the admin login (Jack, item 17): the old Rankings tab content, /results and the MVP pages move under admin as "OG" pages (a dropdown on the MVP History tab: "OG MVP page", "OG Rankings", "OG Results"). They keep running in the background; nothing public links to them.

Admin preview: an admin session plus ?mode=v2 on any page (or the toggle in the V2 tab) renders V2 for that browser only, so Jack can use the whole flow on prod before flipping.

### 6b. Admin: the "V2 Database" tab and the menu rework

The V2 Database tab:

| Piece | What |
|---|---|
| The pool | every capper in capper_ratings_v2 with every column, scope and window pickers, LIVE / NOT YET chips, FAKE badge with the real name beside aliased rows, source and name-mode columns, hidden rows dimmed, click-through to the public profile plus the raw canonical name |
| Next up | the cappers closest to the bar (graded picks and dollars short), so Jack sees who is about to go live |
| Bar settings | v2_min_picks, bar kind and value, streak threshold, free-pending flag |
| Per-capper editor | display_name, name_mode, alias_name (reassign from the pool), hidden, bio (draft / approved) with the source URLs listed under it, notes |
| Requests inbox | capper_requests with resolve actions (alias, correct, hide, decline) and the admin note |
| Product switch | product_mode with a confirm step, plus the preview toggle |
| Health | last write per source, rows in the last 24h, the two dark feeds called out, last recompute time, live count per sport |
| Recompute | POST /admin/api/v2/recompute |

Three options for the admin top menu (Jack, item 17; today it is fourteen tabs in one strip):

| Option | Shape | Cost |
|---|---|---|
| A. Two rows | Row one is what you use daily: V2 Database, Next up, Requests, Bios, Sources and Health, Users, Access Codes, Settings. Row two is one dropdown labeled "V1 (legacy)" holding Today's Picks, Cappers, Messages, Source Feed, MVP History (with the OG pages), Pick History, Archive, Reader, AI Usage, Dummy Accounts, CA Ops Receptions, Playbook. | about a day; nothing inside the old tabs changes |
| B. Grouped sidebar | A left rail with five groups: Database (pool, next up, requests, bios, aliases), Feeds (source health, receptions, reader, AI usage), Product (settings, product switch, articles, home), People (users, access codes, dummy accounts), Legacy V1 (the old tabs and OG pages). The current tab bodies mount unchanged inside. | two to three days; scales as V2 grows |
| C. Mode toggle | A V2 / V1 switch at the top left of admin that swaps the whole strip. V2 mode: Database, Next up, Requests, Bios, Health, Product. V1 mode: the current strip untouched. Users, Access Codes, AI Usage and Reader appear in both. | about a day; two places to remember |

Recommendation: A now (cheapest, keeps every old surface one click away), B when the V2 tab outgrows a row.

Routes: GET /admin/api/v2/board.json, GET /admin/api/v2/next-up.json, POST /admin/api/v2/settings, POST /admin/api/v2/capper/:id, POST /admin/api/v2/capper/:id/bio, GET /admin/api/v2/requests, POST /admin/api/v2/requests/:id, POST /admin/api/v2/mode, POST /admin/api/v2/recompute. The existing V1 admin tab bodies are not touched.

---

## 7. Surfaces

Every record surface carries the Grading Note: "Graded by CappingAlpha from picks we captured at the line we recorded. Not the handicapper's own record. Coverage may be partial." plus n, "at $10 per pick", the priced share where under 90%, and a Sample Chip under 50 graded picks ("Small sample, 34 picks").

### 7a. Cappers tab (the app's middle tab; web: the tab that is Rankings today)

Sub-nav pills: Today | Database. (Following comes later with the socials layer.)

Today: every live capper with a pending pick on a game starting today, grouped by game in start-time order, cappers inside a game in the tier-then-money order for that sport. A row = initials disc, display name, Source Badge, the pick (team, line, their price, recorded time), record and money in that sport with ROI beside it, Sample Chip, streak. Filters as a Chip Rail: sport, source, window (all / 30d / 7d), minimum picks (20 / 30 / 50 / 100), "meets the bar today". Search by name. Empty state: "No cappers have posted on today's games yet. This fills in through the day and freezes at each game's start." Paid; free users see the games with a count per game and masked rows (one masked cell per row, never a blur wall) and a subscribe prompt.

Database: the full leaderboard of live cappers. Sticky Rail Table on phones (name pinned), columns: position, capper (with Source Badge), graded, record, money, ROI, win%, priced, last pick, streak. Sort by any column, default money. Controls: sport rail, window pills, min-picks selector, source chips, "meets the bar today" toggle (on by default), search. Under the header when sorted by money or ROI, the Bar Note: "At 30 picks a bettor with no edge lands anywhere from about -30% to +20% ROI. Sorting by money puts the lucky and the skilled together at the top." No podium. Row tap opens the profile.

### 7b. Game page: the Capper section (CHOSEN 2026-09-16: variant 18 of the mock lab)

BUILT 2026-09-16 (branch v2-database): src/capper_db_section.js renders the section server-side from src/game_backers.js; the data layer is src/capper_v2.js (capper_ratings_v2 + capper_qualifications, the one-way door), src/capper_public.js (naming + the alias pool src/alias_pool.json), src/product_mode.js (the switch + admin preview), the admin "V2 Database" tab, /capper/:slug as a shell page (src/capper_page.js) until the profile lab settles the real one. Seed for local work: scripts/seed_capper_history.js. Assumption made in the build: the season money badge uses a 10-pick floor (the plan only set a floor for the win% badge).

The section is the "Ledger, clean" layout, settled with Jack over three mock rounds (docs/mockups/v2_game_backers_lab3.html, fragment docs/mockups/v2_game_backers_v18.json, real-page injection script docs/mockups/build_real_page_mock.py). Rules, all settled:

- Heading "Capper Database" for now (Jack wants a media-style name; candidates: Capper Report, The Capper Desk, Cappers on this game). Subline "N cappers · <SPORT> record · $10 a pick". No humility line, no grading note in the section; a small round (i) at the bottom right opens: "Their record as we recorded it since July 2026, graded by us at the line and price we saw. It can differ from records they publish. $10 a pick. N more cappers we track have not qualified in <SPORT> yet."
- Count strip: five pills (All N, AWAY n, HOME n, Over n, Under n) as a filter; pill TEXT in the side colors (away and home team ink colors, Over green, Under yellow; when a team wears gold or yellow the Under falls back to a redder orange). No six-slot grid.
- Cards edge to edge (ESPN style), 14px inner padding on text.
- One tap per row: the whole row opens the capper profile on that sport's tab. The pick chip and price are information, never a control.
- Row: initials disc; name with the source badge on the same line (badge never wraps under; name 15px, 13px past 12 characters, cut at 16 with "..." and the full name on the profile); the metrics line "W-L  +$money  +ROI% ROI" (money green or red); "Recorded Nh before start"; then chips: Small sample (under 20 picks in the sport), the sport streak from 5 straight ("MLB W5" flame / "MLB L5" snowflake), and two season badges (money "+$610 this season", record "61-41 this season", the numbers colored: money green or red, wins green, losses red, ties yellow, on a faded grey chip like the streak chip). Season badges go to cappers in the top 5% of the sport this season by money, and by win percentage with a 30-pick floor in that sport, whichever applies, both if both.
- Right side: the pick chip (team-colored, Tint mode: team ink color on a faint wash; Filled mode tabled) with the price under it ("at -108", or "no price, graded at -110"), and one chevron at the far right.
- Source badges in Tinted text mode (Polymarket violet, Action Network green, Covers red, Community grey text on a faint wash).
- List shows four and a half rows with a fade, then "Show more" turns the list into a contained scroller about seven and a half rows tall; an up-arrow button (no words) collapses it. Three or fewer cappers: no fade, no button.
- Order: money in the sport descending (sample tiers per item 32 once settled).
- The game page's section wheel (CAPPERS, LINES, BETTING, FORM, HISTORY, INJURIES, CONTEXT) moves to the BOTTOM of the page on phones, pinned flush above the tab bar (measure the bar, no gap), so it is reachable by thumb (Jack, 2026-09-16). Scroll spy unchanged.
- The header gets a search button right after the hamburger, left of the wordmark (hamburger, search, CappingAlpha, Unlock). For now it opens the game search; it becomes the Global Search with the home phase.
- Build prompts: docs/prompts/V2_GAME_SECTION_BUILD.md (ship this section, the wheel and the search button into the real app behind product_mode with an admin preview) and docs/prompts/V2_CAPPER_PROFILE_MOCK.md (the profile lab, five directions).
- Freeze at the true start; W / L / PUSH after grading (host tints the pick chip); unqualified cappers only as the count inside the (i).

### 7c. Capper profile (Jack's sketch, 2026-09-14)

Popup in the app and the web SPA (new public/modules/capper_profile.js, reusing member_profile.js CSS, chart and list helpers) and a server-rendered /capper/:slug page for links, share and SEO. One payload. Opens on the sport tab it was tapped from (a game page tap lands on that sport).

Anatomy, top to bottom, mapped to the sketch:

| Sketch element | V2 |
|---|---|
| Bio box (with the arrow) | Bio Box: the approved bio for public figures (analysts, authors, influencers): who they are and how they bet, short, in our own words, written from their public pages plus our style stats; every bio's source URLs are listed under it in admin. Otherwise the auto Style Line ("Mostly MLB moneylines, leans underdogs, about 15 picks a week"). |
| "JB" circle | initials disc, deterministic color from the name hash, never external imagery |
| Name | display name (pseudonym for Community and BettingPros cappers, with "Shown under a pseudonym") |
| "Polymarket" pill | Source Badge with the platform name; "Community" for Discord |
| "273-100 roi" | Record big (W-L, pushes small), money in dollars and ROI beside it, window pills (All / 30d / 7d) |
| MLB / WNBA / NFL / NHL chips | Sport Chip Rail, All first, one chip per sport with 1+ graded pick, sorted by graded count; the tier label on each ("68 picks" / "small sample") |
| "NFL Performance 70-25 ROI 2.5%" | Sport Panel: record, ROI, money ("$200" style), graded, priced share, by-bet-type mini table (ML / spread / total) |
| the chart | equity curve for the selected chip (money by graded pick, oldest first, runs negative, no smoothing), from curve_json |
| (new, item 3) | Today's Picks: every pending pick this capper has on today's games (game, pick, line, their price, recorded time). Free users see the rows masked with "Subscribe to see today's picks"; graded rows are always visible. |
| "Recent picks" | the pick list: date, matchup, pick, their line and price (or "graded at -110"), result, money; 50 rows then load more |
| "7W Hotstreak" flame | Streak Chip: the count with a flame on a winning run and a snowflake on a losing run, from 5 straight |
| (not drawn) | monthly bars, Grading Note, "How we grade" link to /faq#grading, "Is this you? Claim, correct or remove" link to the request form, Follow (adds the capper to Favorites) |

Absent by rule: bands, points, Wilson, gates, fade, channel, CA scores, any external self-reported record (AN's own record and Covers units stay in meta_json for admin only).

Bios are written on the Claude plan, not through the API: a session runs a bio workflow over the public-figure cappers (their public profile pages plus our style stats), writes {slug, bio, sources[]} JSON, and imports it through the admin bio endpoint as drafts; Jack approves in admin. Haiku only if plan usage matters. About 60 to 100 public figures today (AN experts, columnists, WagerTalk handicappers).

### 7d. Capper database (web)

The Database sub-tab of 7a, same module, wider table on desktop. Positions are positions in a sorted table, never "#1 capper" as a label.

### 7e. Home, app and web: ESPN's home, no capper content (Jack, items 14 and 21 to 25)

Order (item 21, option B): Most Wagered, Favorites, My Games, Articles.

| Element | CappingAlpha V2 |
|---|---|
| Top bar | Global Search icon top left (section 7g), wordmark centered, avatar / settings right |
| Most Wagered | the existing Top Games Card Rail, first |
| Favorites Rail | one circle per favorite, scrolls sideways, "+ Add" at the end. Teams: our own mark (abbreviation on team colors) inside a white ring with a small sport badge on the rim, like ESPN's football badge. Players: initials disc for now (no faces until imagery is cleared) inside a white ring with the sport badge. Cappers: initials disc inside a GOLD ring. Tap opens the team page, the player profile or the capper profile. Logged out: the "+ Add" prompt only. |
| My Games | the next game of each favorite team and of each favorite player's team: both marks, records, day and time, network where ESPN has it, a bell that toggles a game_start alert for that game (existing push topic). Needs games beyond today: src/schedule.js fills the schedule table daily for favorited teams from ESPN's free team-schedule endpoint. |
| Articles | the existing headlines feed (Google News RSS, 30-minute cache) rendered as an article list under My Games, ESPN-style cards; when the user has favorites, articles that mention a favorite team, player or capper rise to the top. Filler for now; the section is meant to be edited later. The old headline strip is reworked into this (cleaner, simpler, more ESPN). |

The Preferences page (from the ESPN recording), reached from "+ Add" and from Settings: sections My Teams, My Cappers, My Players, My Sports, each listing what is followed with a chevron and an "Add more" link. Add pages: "Tap your favorite teams" (search box, a league rail on the left, a grid of team marks, Finish), "Add Players" (search, Top Players with Follow buttons, Browse by Sport), "Add Cappers" (search, the live cappers by sport, Follow), "Tap your favorite leagues" (a grid of sport tiles). My Reporters is open (item 33). Onboarding gets the same page as a step.

Removed under v2: the #1 Pick Card, Today's Picks, the CA P/L widget, the rankings language. No capper sections on the home.

### 7f. Player profiles (new, Jack item 31; from the two ESPN screenshots)

A player page for any athlete in a covered sport, reached from search, from the Favorites rail, from game pages (rosters and probables later) and from the schedule. Server-rendered (src/player_page.js on the sport_page.js pattern, framed in the app through the page stack) with the payload from GET /api/player/:sport/:id.

| ESPN element | CappingAlpha V2 |
|---|---|
| Header: name, team mark, number, position (or country and flag for golf and tennis) | same, from ESPN's athlete record; our own team mark; no headshot until imagery is cleared (an initials disc in the team's colors) |
| HT/WT, birthdate, college (birthplace for golf) | same |
| Follow | adds the player to Favorites (gold ring is for cappers; players get the white ring) |
| Season stats tiles with league rank | the sport's headline stats with rank where ESPN provides it |
| Tabs: Overview, News, Stats, Bio, Splits, Game Log (golf: Overview, News, Bio, Results, Scorecards) | same tab set per sport family, from the athlete overview, stats, splits, gamelog and news endpoints (player_form.js already reads the gamelog) |
| Previous game box with the player's line | same |
| Latest news cards | the news endpoint where it exists, else the headlines feed filtered by the player's name |
| (ours) | a "Cappers on this player's next game" link into the game page section, and later prop-bet history when book_props is exposed |

Sports: NFL, MLB, NBA, WNBA, NHL, NCAAF, golf, tennis. ESPN's free endpoints, fetched and verified 2026-09-15 (one athlete per sport):
- Id lookup: site.web.api.espn.com/apis/search/v2?query=<name> returns player hits with the numeric id in the uid ("a:NNNN") and defaultLeagueSlug. Rosters: site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams/{teamId}/roster (this host returns 403 to any Mozilla user agent string; send a plain one, or use the site.web.api mirror).
- Team sports (NFL, MLB, NBA, WNBA, NHL, NCAAF with league slug college-football): site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{id} gives the header (name, jersey, position, height, weight, birthdate, birthplace, college, draft, experience, team, injuries) and statsSummary WITH league rank; /overview gives the season line, recent games with per-game stats, the next game, per-player news and awards; /stats (career by season), /splits, /gamelog (player_form.js already reads it), /bio (awards, team history). The previous-game box comes from summary?event=<eventId> boxscore. The news?athlete= parameter is ignored; per-player news comes from /overview.
- Golf (pga): the v3 athlete record has bio, country, college, hand, turnedPro and ranked season stats; /overview has recentTournaments (position, score, rounds), seasonRankings, next and previous tournament. No /stats, /splits or /gamelog; scorecards come from the core competitor refs (hole by hole).
- Tennis (atp / wta): a thin bio on the league-scoped core record (the unscoped sports/tennis/athletes/{id} document carries flag and headshot), W-L, titles and prize money from core season statistics, results from the core season eventlog, rank from the rankings feed. No /stats, /splits or /gamelog.
- No rate limiting seen across ~150 requests from one IP; cache aggressively server-side (one fetch per athlete per few minutes). Headshot URLs are ESPN-owned imagery and are NOT used (item 23).
Size: L (4 to 5 days; team sports first, golf and tennis after).

### 7g. Global search

One box: games (today and the schedule table), teams, live cappers, players. Games and teams from today_games plus a static team index per sport; cappers from capper_ratings_v2 (live only); players from the players cache first, then ESPN's search endpoint for misses (cached). Results sheet grouped by kind, each row tappable into its page. Web: the same box in the top bar.

### 7h. About page rework

Rewritten in the reporting-source voice: what CappingAlpha is (sports media that reports on public handicappers), where the picks come from (public platforms, named; community channels under pseudonyms), how we grade (the Grading Note expanded, the price basis, missing prices, in-play never counted, tennis retirements void), how we track prediction-market bettors (the bettor-vs-trader rule from the accuracy audit, in plain English), how a capper goes live (the bar, in plain English, no mechanics), pseudonyms and the claim / correct / remove path, and the standard disclaimer. FAQ and Terms get the matching sections.

---

## 8. App Store purchases (Jack: no Stripe in the app; the last step)

The app sells through Apple in-app purchase; the website keeps Stripe. One entitlement on the server (users.subscription_tier + subscription_expires) fed by two stores, with a store column. Direct StoreKit 2, no RevenueCat (item 20: "whatever makes us the most money"; a wrapper takes 1% above $2,500 a month and adds nothing we need).

| Product | Apple type | Price | Notes |
|---|---|---|---|
| Day pass | consumable | $1.00 | grants 24 hours from purchase |
| Weekly | auto-renewable subscription | $5.00 | 3-day free trial as an introductory offer; Apple enforces first-time-only itself |
| Annual | auto-renewable subscription | $75.00 | same subscription group as weekly so upgrades and downgrades work |

Round prices are Jack's rule. Whether $1.00 / $5.00 / $75.00 exist as Apple price points (Apple expanded its price list in 2023) is being verified by the research agent; if a whole-dollar point is missing the nearest is $0.99 / $4.99 / $74.99 and Jack decides (item 35).

Flow: the app's paywall lists Apple's localized prices from StoreKit; purchase happens in Apple's sheet; the app posts the signed transaction to POST /api/iap/verify; the server verifies it with the App Store Server API (StoreKit 2, JWS, no shared secret), grants the tier, stores the transaction in apple_transactions; App Store Server Notifications V2 hit POST /api/iap/apple-notifications for renewals, expirations, cancellations, refunds and billing retries and keep the expiry in sync; Restore Purchases re-links a device to the account; a "Manage subscription" link opens Apple's page. Sandbox handled by the environment column. Web users on Stripe are untouched; the paywall hides plans the user already holds so nobody is double-charged. The Phase 7 "Stripe in the system browser" flow is removed from the app build. Android later, same endpoint shape with Google Play verification.

Small Business Program: 15% commission instead of 30% for developers under $1M in proceeds in the prior calendar year; the Account Holder enrolls in App Store Connect; an LLC qualifies. Details from the research agent go into section 14.

Jack's side: App Store Connect products, the subscription group, the free-trial introductory offer, an App Store Connect API key (issuer id, key id, .p8) as Railway env, the Paid Apps agreement, banking and tax forms, sandbox tester accounts, the Small Business Program enrollment. The Stripe weekly price moves to $5 for the web. The auto-renewal disclosure (the ROSCA item from the July legal research) applies to both stores; Apple's sheet carries its own, the web checkout still needs ours.

---

## 9. The switch

settings.product_mode = 'v1' | 'v2', default 'v1'. One helper, src/product_mode.js: getProductMode(req) honoring the admin preview.

Read in:

| Place | v2 behavior |
|---|---|
| /api/config | product_mode + v2 block + store; the SPA and the app branch on it at boot |
| src/nav_tabs.js | navTabs(mode): the 'mvp' Rankings entry becomes {tab:'cappers', label:'Cappers'}; assertNavInSync becomes mode-aware (index.html buttons carry data-mode="v1" / "v2" and the check compares the buttons for the active mode). Still defined once. |
| public/index.html + app.js | both tab buttons and both panels exist in the markup; boot shows the set for the mode; hash routing accepts #cappers; the home panel renders home_v2 |
| app tab bar | data-tabbar="cappers" beside "mvp", one visible per mode; the shell applies the last-known mode from localStorage before first paint, then the config answer |
| detail_page.js, sport_page.js, results_page.js, tools_page.js, player_page.js | buildNav(mode); the game page renders backers instead of ranked picks |
| index.js /api/game | attaches backers, drops the ranked picks list from the public payload under v2 |
| the V1 pages | behind the admin login as OG pages (6a) |
| push.js / live_alerts.js | top_pick topic disabled under v2; game_start powers the My Games bell; a capper_pick topic arrives with the socials layer, later |
| paywall.js copy | v2 variant: sells today's picks, live game cards and alerts; never a capper name, never "winners"; Apple prices in the app |
| onboarding (app) | v2 copy variant on the screens that mention rankings; the Preferences page as a step |
| sitemap, About, FAQ, Terms | v2 sections (7h) |

Under v1 every new file is inert. Flipping back is that one setting.

Free vs paid under v2 (settled): all graded records, profiles, the database, finished-game cards, the home and player pages free; today's pending picks (Cappers tab Today, profile Today's Picks, pregame game cards) paid with a subscribe prompt where free users would see them; alerts paid. Prices $1/day, $5/week with the 3-day trial, $75/year; Apple prices in the app.

---

## 10. App vs web split

| Layer | Where built | How it reaches the other surface |
|---|---|---|
| Backend, DB, admin, /api/*, the switch, IAP server side, schedule and player fetchers | v2-database branch (worktree ~/projects/capperboss-v2, off origin/master) -> master -> Railway | the app talks to Railway; nothing to port |
| Game page "Who is on this game", /capper/:slug and /player pages, nav | same branch (server-rendered) | the app frames these pages through the page stack |
| Cappers tab, profile popup, home v2, Favorites rail, Preferences page, search sheet, tab bar mode, onboarding copy, StoreKit paywall | ~/projects/capperboss-app on branch app, after committing the pushed-page stack work and merging origin/master (which brings the V2 backend) | cherry-picked to master for web parity at the end; the StoreKit paywall stays app-only |

App dev loop for data: the app dev server (localhost:3013, UI_ONLY, throwaway DB) has no capper history. Two options, both planned: a seed script (scripts/seed_capper_history.js loads a full-export JSON into the local DB and runs the V2 recompute) for backend work in the V2 worktree, and the existing prod mirror for app UI work once Phase 1 is live on Railway.

Known state of the app branch: 38 commits ahead and 51 behind origin/master, with the pushed-page stack work (page_stack.js, embed_child.js, 15 modified files) sitting uncommitted since Sept 10. It gets committed as-is first (Jack, item 12).

---

## 11. Files touched

New: src/capper_v2.js, src/capper_public.js, src/game_backers.js, src/product_mode.js, src/capper_page.js, src/player_page.js, src/players.js, src/schedule.js, src/search.js, src/favorites.js, src/iap.js, scripts/seed_capper_history.js, scripts/gen_alias_pool.js, public/modules/cappers.js, public/modules/capper_profile.js, public/modules/home_v2.js, public/modules/favorites.js, public/modules/preferences.js, public/modules/search_sheet.js, public/modules/iap.js (app), public/player.js + public/player.css (the player page), docs/V2_DATABASE_PLAN.md (this), docs/prompts/LEDGER_ACCURACY_AUDIT_ADDENDUM.md, docs/mockups/v2_game_backers_lab.html.

Modified: src/db.js, index.js (routes, config, MIRROR_SKIP, sitemap, /api/game, nav, the OG admin pages), src/admin.js (V2 tab, menu rework), src/nav_tabs.js, src/detail_page.js, public/game-detail.js, public/game-detail.css, public/index.html (panels, tab buttons with data-mode, tab bar item, CSS for the named components), public/app.js (tab routing, config, home), public/modules/paywall.js (copy + Apple prices), public/modules/account.js (favorites), public/modules/home_top.js, src/headlines.js (favorites boost), src/push.js, src/live_alerts.js, src/auth.js (entitlement from two stores), public/faq.html, public/about section, public/terms.html, docs/UI_VOCABULARY.md, CLAUDE.md, plus the ledger fix's six files by merge (through the audit session).

New components for docs/UI_VOCABULARY.md: Capper Row, Backer Card, Slot Column, Source Badge, Sample Chip, Streak Chip, Grading Note, Bar Note, Bio Box, Style Line, Sport Panel, Today's Picks, Mode-gated Tab, Global Search, Favorites Rail, Favorite Circle (white ring + sport badge for teams and players, gold ring for cappers), My Games Card, Articles List, Preferences Page, Player Header, Stat Tiles with rank, Player Tabs.

---

## 12. Phases, in Jack's order (UI, capper database, bet tracking, App Store)

| Phase | What ships | Where | Size |
|---|---|---|---|
| 0 | Ledger accuracy (the audit session, docs/prompts/LEDGER_ACCURACY_AUDIT_ADDENDUM.md): wrong-line regrade, BettingPros matching, PM in-play and backfill, the two feeds, corrupt prices, tennis tours, UTC dates. Commit the app page-stack work. CLAUDE.md amendment. | audit session + app | that session's schedule |
| 1 | Data layer, inert: tables and columns, capper_v2.js materialization + qualification door + cron hooks, capper_public.js + the alias pool, product_mode.js, /api/config block, seed script, admin V2 Database tab (pool, next up, bar settings, editor, requests, switch, preview) and the admin menu rework (option A). | v2-database -> master | M (3 to 4 days) |
| 2 | UI, app first: the game page section (the layout Jack picks from the lab), the Cappers tab (Today + Database), the capper profile popup and page with Today's Picks, the ESPN home (Most Wagered, Favorites rail, My Games + schedule fetcher + bell, Articles), the Preferences page and add flows, Global Search, player profiles (team sports first). | app branch + v2-database | L (10 to 13 days) |
| 3 | Capper database wrap-up: bios workflow and import, alias pool review in admin, About / FAQ / Terms rework, the claim / correct / remove form, sitemap, web parity for the Cappers tab and profile. | both | M (3 days) |
| 4 | Bet tracking soundness: a pass over Track a Bet, user_bets grading, the betslip scan, parlays and the My Tracking surfaces under the new home (bugs only, no features). | both | M (2 to 3 days) |
| 5 | App Store: StoreKit client, /api/iap/*, notifications, restore, entitlement merge, paywall with Apple prices, Stripe removed from the app, App Store Connect setup on Jack's side, submission packet refresh, TestFlight. | app branch + backend | M (3 days) + Jack's setup |
| 6 | The switch end to end and the flip: nav_tabs, index.html mode buttons, tab bar, page navs, paywall and onboarding copy, push topics, OG admin pages, flip test in both modes; then product_mode = v2 when Jack says. | both | M (2 days) |

Estimate: 25 to 30 engineer-days for phases 1 to 6, plus the audit session. Nothing public changes until Jack sets product_mode = 'v2'.

---

## 13. Rules this plan holds to

- V1 logic untouched: scoring.js, scoring_v3.js, capper_ratings.js, mvp.js, results.js grading (except the ledger fix through the audit session), expert_data.js, espn_live.js.
- No V1 score, band, points or tracked P/L on any V2 surface. No negative labels beyond the streak snowflake. Records are history, not advice.
- No capper name in CTAs, push, share cards, OG tags or SEO titles. Discord and BettingPros never named. Alias on request, never delete. Unqualified cappers never named.
- No athlete faces and no real club logos until imagery is cleared; our own marks and initials discs meanwhile.
- Copy: humble, no em dashes, no certainty words, never "no cherry-picking", scoring mechanics never.
- Cache-buster chain on every touched module; every new component named in docs/UI_VOCABULARY.md first.
- CLAUDE.md line 30 amended in the same session the first name goes public: capper names and platforms from public sources may be shown; scoring mechanics stay private forever.

---

## 14. Decisions

### 14a. Settled (Jack, 2026-09-15, both rounds)

| # | Decision |
|---|---|
| 1 | Platform names on the Source Badge for public sources. Discord always "Community", always aliased. |
| 2 | Weekly $5, 3-day trial stays. App sells through the App Store, never Stripe. |
| 3 | Graded records free; today's pending picks paid; Today's Picks section on every profile, masked for free users with a subscribe prompt. |
| 4, 28 | Streak Chip: count with a flame (wins) or snowflake (losses), from 5 straight. |
| 5, 27 | Bios for public figures, written in our words from their public pages, produced on the Claude plan (sessions, not API spend), source URLs listed under each bio in admin, approved there. |
| 6 | A capper on Discord and a public source shows under the public source only. |
| 7 | BettingPros cappers aliased until permission (Jack's lean; see the note under 14c). |
| 8 | One Tennis scope. |
| 9 | The ledger gets fixed; the accuracy audit session owns it (addendum written). |
| 10 | Dropped: no default hiding of quiet cappers; a Last pick column instead. |
| 11 (rule) | One-way door on the overall record; once live, never taken off; unqualified only in admin. Bar value open. |
| 12 | Commit the page-stack work on `app` as-is first. |
| 13 | Money shown as dollars at $10 per pick. |
| 14, 21 | ESPN home, no capper content, order: Most Wagered, Favorites, My Games, Articles. |
| 15 | Inside a sport: money made in that sport, tiebreak win% then record size; ROI beside it; all-time default with 30-day and 7-day filters. |
| 16 | Qualification judged on the overall record; a live capper's every pick shows, sport ranking handles small samples (mechanism open, item 32). |
| 17 | V1 pages behind the admin login as OG pages; admin menu rework option A now, B later. |
| 18, 26 | Aliases: handle-style fake names from a generated pool, FAKE badge in admin, reveal later if ever possible. |
| 20 | Direct StoreKit 2, round prices, the App Store phase comes last. |
| 22 | Favorites rail holds teams, cappers and players: white ring with a sport badge for teams and players, gold ring for cappers; "+ Add" opens the ESPN-style Preferences page. |
| 23 | Our own team marks and initials discs by default; imagery paths researched (14c). |
| 24, 25 | Articles = the existing headlines feed as an ESPN-style list, favorites float up, filler for now; the strip reworked cleaner. |
| 29 | Unqualified cappers appear only in admin. |
| 30 | Admin "Next up" list. |
| 31 | Search includes players; player profiles get built (7f). |

### 14b. Open

| # | Question | Two plain options | Recommended |
|---|---|---|---|
| 11 (value) | The bar on the overall record. Section 3b: "+$100 at 30 picks" opens the door to 61 cappers with 11 underwater today; "positive at 30" to 226 with 103 underwater. | (a) 30+ picks and +$100 or more. (b) 30+ picks and ROI 10% or more (154 live, 47 underwater). | (a) |
| 19 | The game page layout: pick from the seven in the lab (link in 14c), or name the two to merge. | | |
| 32 | Inside a sport, how does sample size beat money? | (a) Sample tiers first (50+ picks, then 20-49, then under 20), money inside each tier, the tier labeled on the row. (b) Money only, with a "small sample" chip and nothing else. | (a) |
| 33 | "My Reporters" from the ESPN flow: who are our reporters? | (a) Skip the section; cappers are the people you follow. (b) The bylined columnists (CBS, SportsbookWire, TheSpread) as a Reporters list separate from cappers. | (a) |
| 34 | Player profiles: which sports first? | (a) NFL, MLB, NBA, NHL, WNBA now; NCAAF, golf, tennis in the next pass. (b) All eight at once (adds 2 to 3 days). | (a) |
| 35 | If Apple has no $1.00 / $5.00 / $75.00 price points, use $0.99 / $4.99 / $74.99 in the app and keep round numbers on the web? | (a) Nearest Apple points. (b) $1.99 / $5.99 / $79.99 style rounding up. | pending the research result |
| 36 | The phase order in section 12 (data layer first because every screen needs it, then the UI, then database wrap-up, bet tracking, App Store, flip). OK? | (a) Yes. (b) Change it. | (a) |
| 37 | The About page rewrite (7h): I draft it, you approve before it ships? | (a) Yes. (b) Ship on the flip without a review. | (a) |
| 38 | The Discord scanner is a self-bot (forbidden by Discord). Retire it, or replace it with a consented bot? Discord names are pseudonyms either way. Jack-only. | | |

### 14c. Answers to Jack's questions (2026-09-15)

Item 7, BettingPros. Yes, we are commercial use: CappingAlpha sells subscriptions, so the "no commercial use" clause in FantasyPros' terms applies to us (FantasyPros is the company that owns BettingPros; the two share terms and an API). The realistic worst case for naming their users is not a lawsuit on day one: it is a cease-and-desist letter plus a block or a rotated key that kills the feed, and a terms-of-service claim behind it if we ignore the letter (the hiQ case is the reminder that a terms claim can cost real money after years). Reverting to fake names is one flag per capper (name_mode), so it is reversible in minutes. Since the fake names cost nothing and remove the exposure, they are the default; the feed itself is the accuracy audit's problem.

Item 9, the ledger. Nothing new to decide: the addendum is written for the audit session and it owns the repairs.

Item 10. Dropped as a question. The point was only that the Polymarket tracker stopped adding picks on Aug 31 (a prod bug in the addendum), so those bettors currently show no recent picks. Once the feed is back this needs no rule. Polymarket bettors are tracked like any capper; traders are screened out by the existing straight-bettor gates, and the About page will say so in plain English.

Item 23, imagery (research 2026-09-15, three agents plus two skeptics per claim; not legal advice, what the sources say):
- Team logos are the highest-risk path. Nominative fair use covers a team NAME used to identify a game; for stylized logos the Ninth Circuit (Toyota v. Tabari) treats the logo as more of the mark than necessary when the word would do, and illustrated logos also carry copyright. Apple's App Review does not entertain fair-use arguments: documented rejections under guideline 5.2.1 / 4.1 for NBA, FIFA and club logos, with two exits only, rights documents on letterhead or removal. No league runs a small-app digital logo license; NFL Properties, NBA Properties and CLC programs are merchandise-shaped (minimum guarantees, years-in-business screens). Every data vendor (Sportradar, SportsDataIO, Sportmonks, API-Football, TheSportsDB) disclaims logo rights. Sports-Reference's posture ("we use them under a fair use argument, small resolution, educational") is a web-only stance by a large site and does not transfer to an iOS app. Emailing leagues is not a path.
- ESPN's CDN logos and headshots (a.espncdn.com) are governed by Disney's terms: personal, noncommercial, no scraping, no building a business on it. The site serves ESPN tennis headshots today (tennis_photos.js, mock_live.js); the recommendation is to stop and never add ESPN logos.
- Athlete faces have a free, legal path: Wikimedia Commons photos under CC BY / CC BY-SA, commercial reuse allowed with attribution (author, license, link) and a share-alike note for edits. tennis_photos.js already resolves Wikipedia photos but stores only the URL; it needs the license, author and file page stored and a credit rendered (a small caption or an /image-credits page), and photos shown only on factual game / record surfaces, never in paywall, push, share cards or marketing (California 3344(d) and Gionfriddo / C.B.C. cover sports reporting; Commons warns that advertising-type use needs the subject's consent). About 77% coverage on tennis today; other sports untested.
- Paid headshots exist but are editorial-only and per-image (Getty Editorial about $167 a month for 10 downloads; AP metered; SportsDataIO and Sportradar sell headshots but Sportradar's image API is "prohibited for betting clients" and Stats Perform bars commercial use of headshots). Not a fit.
- Team colors plus an abbreviation (our own marks) are the lowest-risk option: the one color-scheme case (Smack Apparel) protected colors only combined with other school indicia on merchandise, and the vendors ship team hex colors as data. Keep a "team names and marks belong to their owners; not affiliated with any league" line in Terms.
Decision stands: own marks for teams in the app and on the web; athlete faces from Wikimedia Commons with credits (all sports, a fix to tennis_photos.js first); no ESPN imagery; real logos only ever web-only and small, if at all, after counsel.

Item 35, Apple prices, and the Small Business Program (research 2026-09-15 against Apple's own pages):
- Whole-dollar prices exist: Apple's 2023 pricing update runs every $0.10 up to $10 and lets developers "price products beyond $0.99 endings to incorporate rounded price endings (X.00)", so $1.00 and $5.00 are valid US price points. $75.00 is very likely available (secondary sources describe $1 steps from $50 to $200) but was not confirmed on a primary page; App Store Connect's "See Additional Prices" list settles it, else $74.99. Round numbers stand.
- A 3-day free trial is a standard introductory-offer duration on an auto-renewable subscription; Apple enforces one introductory offer per subscription group per Apple ID, so put the trial on the weekly product only and read eligibility from StoreKit (isEligibleForIntroOffer) rather than our Stripe flag.
- Small Business Program: 15% instead of 30% for developers with no more than $1M in proceeds in the prior calendar year across all associated accounts; new developers qualify from day one; the Account Holder of the organization membership enrolls after accepting the latest Paid Apps agreement; the rate starts 15 days after the fiscal month of approval; associated developer accounts must be disclosed. An LLC qualifies.
- The day pass as a consumable is the type Apple guidance points to for timed access under 7 days; the server stamps 24 hours from the purchase date.
- Server side: the App Store Server API and Server Notifications V2 are JWS-signed and need an In-App Purchase key (.p8), key id, issuer id and the bundle id (plus the app's Apple id for production verification); no shared secret. Apple ships @apple/app-store-server-library for Node.
- US link-out: since May 1, 2025 (the Epic v. Apple contempt order) US-storefront apps may include buttons and links to web checkout, and no commission has been charged on link-outs to date; Apple's August 2026 proposal (15%, 5% under the Small Business Program) is pending before the court and the Supreme Court granted review in June 2026. IAP stays the only in-app purchase path; a "cheaper on the web" link is a nice-to-have, not a plan.
- Guideline 5.3.4 (licensing, geo-restriction, must be free) applies to real-money wagering apps; an information-only app is outside it but should expect an 18+ rating and carry an "information only, no wagers" line. Submit from the LLC's organization account.

Game page lab: docs/mockups/v2_game_backers_lab.html (add ?v=N&review=1 for one full-height variant), published at https://claude.ai/artifact/TJJmfoCw6TURbx7n1zbqLz. Seven directions, same nine cappers: 1 Ledger (one list, side filter, six-slot count grid), 2 Sides (away left, home right, totals band), 3 Market tabs (Win / Spread / Total, one open), 4 Odds board (price cells with capper stacks, every slot listed below), 5 Slot grid (2x3 cards), 6 Slips (betting-slip cards), 7 Split (featured capper per side, the rest folded). Built by seven independent designers, each checked by a rule critic and revised once; the research JSON beside it holds the critiques.

Round 2 (Jack liked Ledger and Slips, found the rest too much, wants compact with nothing cut off and two tap targets per row): docs/mockups/v2_game_backers_lab2.html, published at https://claude.ai/artifact/LRZ4vp8AX67fnJZe1VAA5D. Five hybrids built from the Ledger and Slips fragments, each critiqued for rules, height and truncation and revised once, shown with the originals (1, 6) and a preview of the Lines and Public betting sections underneath: 8 Ledger + slip stub (Ledger rows, the pick as a tear-off ticket stub on the right, five rows then "Show all 9", about 770px), 9 Two-line slips (each capper a small ticket: who on line one, the bet plus the metrics line on line two, dashed tear lines, all nine, about 875px), 10 Collapsed ledger with one expanded slip (52px rows, the money leader opened as a ticket with their line, NFL picks and a Track this side button, "Show all 9", about 870px), 11 Side-grouped ledger (DAL, CHI, Over, Under groups with counts, single-line rows, ticket glyph for the bet sheet, about 900px), 12 Slip rail + ledger (a sideways rail of slips up top, the ledger under it, "Show all 9", about 800px).

Round 3 (Jack: lean Ledger, number 8 is the favorite; team-colored pick chips and brand-colored source badges with toggles; the six-slot grid and the explanatory copy out of the section, a small (i) instead; the streak per sport; cards edge to edge like ESPN; side-grouped rejected; the slip rail liked): docs/mockups/v2_game_backers_lab3.html, published at https://claude.ai/artifact/8irofwY86B3oefu1iHPQJm. The lab now carries a color contract (pick chips .pk-dal / .pk-chi / .pk-over / .pk-under, badges .src-an / .src-pm / .src-cv / .src-cm, streak .stk) colored by the host in four pick modes (Filled, Outline, Tint, Neutral), three badge modes (Brand, Tinted text, Neutral) and two card widths (Edge to edge, Inset), switchable live and by URL (?cm=&bm=&w=). Variants: 13 Ledger clean (five rows plus Show all 9, ticket-notched Bet stub, streak at the end of the metrics line, about 600px), 14 Ledger two zones (Profile and Bet zones split by a hairline, streak as a rim badge on the disc, all nine, about 790px), 15 Rail + ledger colored (side-tinted slip rail up top, five rows plus Show all 9, about 730px), 16 Ledger stacked two-line (dense 56px rows, all nine, pick chip and ticket glyph on line two, count strip pills in side colors, about 800px), 17 Ledger side edges (a 4px left edge in the side color per row, count pills in side colors, five rows plus Show all 9, about 600px). Grading note copy inside the (i), per Jack: "Their record as we recorded it since July 2026, graded by us at the line and price we saw. It can differ from records they publish. $10 a pick." 

Jack-only tasks outside this build: the Discord self-bot decision, FantasyPros API access if ever wanted, counsel review of the naming standard, the App Store description rewrite in the reporting-source voice, App Store Connect products, agreements, API key, sandbox testers and the Small Business Program enrollment, the Stripe weekly price change to $5 for the web.
