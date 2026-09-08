# College Football: Ship Report

**Date:** 2026-09-07, updated 2026-09-08 · **Commits on master:** `55d4817`, `62f4854`, `43f1083`, `9d1482d`, `da9f130`, `67ca630`, plus the Sep 8 batch · **Status:** all deployed to cappingalpha.com

Companion to [NCAAF_COVERAGE_AUDIT.md](NCAAF_COVERAGE_AUDIT.md), which holds the root-cause evidence.
This report lists every change that shipped, sorted by batch, with how each was verified.

---

## Where college football stands now

| Priority (Jack's order) | State |
|---|---|
| 1. Complete schedule | Done. 87 of 87 ESPN FBS games for the next 7 days on prod, none missing, none extra. Refreshes at 5am and every 5 minutes |
| 2. Displayed properly | Done. Week view on the Sports tab and `/ncaaf`; school names and real abbreviations on every surface |
| 3. Betting odds | Done. 53 of 87 priced from ESPN's free DraftKings feed at ship time, the rest fill as books post; the CA Odds Engine's 14 books now match |
| 3. Public betting + markets | Done. ActionNetwork splits and Polymarket markets now reach college games |
| 4. Scraping every game | Done for all seven sources including Discord (Sep 8) |

---

## Batch 0: Games on the board (`55d4817`)

The fix for why nothing ever worked, plus the edge cases caught along the way.

| File | Change | Why |
|---|---|---|
| `src/ncaaf_espn.js` | Deleted `User-Agent: Mozilla/5.0` from the ESPN call | `site.api.espn.com` returned **403** on it in production while every fetcher without the header got 200. Confirmed in the Railway log. No college football game had ever been written |
| `src/live_tracker.js`, `src/live_situation.js`, `src/espn_summary.js` | Deleted the same header | The live tracker was blind for **every sport**: prod returned outs, bases, count, batter and last play all null on a live MLB game. `espn_summary` went from nothing to 622 plays and 79 win-prob points on the same game |
| `src/ncaaf_espn.js` | Odds from ESPN's `sports.core` endpoint | The college football scoreboard carries no odds block at all (0 of 68 events), unlike WNBA and Soccer. `sports.core` has full DraftKings spread, total, both moneylines and the juice. Only pregame games missing a line are looked up, six at a time |
| `src/odds_api.js` | `NCAAF: null` | Lines are free, so the 500-credit Odds API tier is not billed for an 80-game Saturday |
| `src/ncaaf_espn.js` + `index.js` | 7-day rolling forward window on the 5am pass | College football is weekly and picks publish days ahead. Seven days is safe because no college team appears twice in any rolling 7-day window (verified across 120 days of the schedule). A rolling window, not "through Saturday": Sunday, Thursday, Friday, Labor Day and bowl weekdays all carry games |
| `src/ncaaf_espn.js`, `src/db.js`, `src/lines.js` | `neutral_site` column; both sides seed `is_home_team = 0` on a neutral-site game | No host means no home-field edge. 1.2% of the regular season, 92% of bowl games including CFP games like Michigan at Texas, which would have handed the "home" side a false +5. Fixed at slot-seeding so the v3 side lean and capper ratings are correct too |
| `src/ncaaf_espn.js` | Skip "TBD at TBD" rows | ESPN publishes unfilled bowl slots as literal TBD rows, 40 of them in the week of Dec 26. Each would seed six pick slots |
| `src/ncaaf_espn.js` | Per-game error isolation, `console.error` on failure | Found in testing: one bad row lost 79 of Saturday's 80 games. And the original `console.warn` is why a season-long outage was invisible |
| `src/db.js` | `ml_draw` added to the `book_lines` CREATE and the ALTER repeated after it | Latent bug: on a fresh database the ALTER ran before the table existed, no-op'd, and every ESPN line write then threw. Prod only survived because its DB predates the column |
| `src/game_stats.js`, `src/team_history.js`, `src/line_history.js` | `americanfootball/…` to `football/…` | ESPN retired the old slug (400 vs 200). Killed popup stats, Team Form, team history, gamelogs and opening-line capture for NCAAF **and NFL**. The fix had been sitting uncommitted in a working tree, in no commit on any branch |
| `index.js` | 5-minute live pass fetches scores only; 3-hourly pass tops up odds | Keeps the `sports.core` lookups off the hot path |

**Verified:** scratch-DB run wrote 87 games (80 on Saturday), 47 priced, 0 TBD leaked, 522 slots, 2.2s. Neutral site: 44 neutral slots, zero carrying a home bonus, hosted games keep theirs. On prod: `/api/games?sport=NCAAF` went from `[]` to 87 rows; `team-history` for NCAAF and NFL went from `{"unavailable":true}` to real records.

---

## Batch A: Display (`62f4854`)

| File | Change | Why |
|---|---|---|
| `public/modules/sports.js` | Day rail is 7 days; a future day renders its schedule instead of "posts in the morning"; a chip appears only for a day with games in the current sport filter; changing the sport re-renders the rail; a stranded selection snaps back to Today | Saturday's 80 games were on prod and unreachable from the main app. The rail was a mock that loaded nothing past today. MLB keeps its daily strip; NCAAF shows Thu, Fri, Sat |
| `src/sport_page.js` | "This week" section under Today's games, one block per upcoming ET day, same row builder | A Monday `/ncaaf` page with one game and no view of Saturday was useless |
| `public/modules/utils.js` | `teamLabel(row, name)`: college sports display ESPN's short name; `pickLabel` routes through it | `teamNickname` is a pro rule (drop the city, keep the mascot) and it mangled every school: "Florida State Seminoles" read "State Seminoles", Ohio State and Penn State both read "State". Now "Florida St", "Ohio St", "Texas A&M". Every other sport unchanged |
| `sport_cards.js`, `home_sidebar.js`, `socials.js`, `member_profile.js`, `mvp.js`, `sports.js` | Explicit matchup renders switch to `teamLabel` | The 18 call sites that draw a team name on a game row |
| `public/modules/sports.js` | College tiles show ESPN's real abbreviation | The derived monogram read the first letters of the full name: "Arizona State Sun Devils" became **ASS**. Now ORE, ASU, TA&M, PSU |
| `index.js` | `/api/picks` and `/api/games` ship `home_short`, `away_short`, `home_abbr`, `away_abbr` | The picks queries fetched none of them; `/api/games` sent the shorts only. `pick_privacy` is a denylist, so nothing else leaks |
| 20 files | Cache-buster sweep: utils 9 to 10 on all importers plus `game-detail.js`, sport_cards 31 to 32, home_sidebar 15 to 16, mvp 48 to 49, socials 7 to 8, member_profile 27 to 28, app.js 129 to 130, game-detail 13 to 14 | `sw.js` caches `?v=` URLs immutably; any content change without a bump serves stale code |

**Verified on a local server against the real 87-game window:** rail reads Today 62, Thu 1, Fri 5, Sat 80; the Sat chip renders all 80 cards with lines where posted; tiles read "ORE Oregon, OKST Oklahoma St, ASU Arizona St, TA&M Texas A&M"; the picks query yields `Florida St | SMU | FSU | SMU`. On prod: `/ncaaf` shows Thursday 1, Friday 5, Saturday 80.

---

## Batch B: Betting info (`62f4854`)

| File | Change | Why |
|---|---|---|
| `src/public_betting.js:16`, `scripts/pb_relay.js:37` | AN slug `college-football` to `ncaaf` | The old slug 404s, the new one serves 99 games. Two independent paths, both fixed |
| `src/polymarket.js` | Tag `ncaaf` to `cfb` | `ncaaf` is the futures tag (playoff seeds, win totals, zero matchups); `cfb` carries the games |
| `src/polymarket.js` | Page by volume, require " vs " in the title | 80 games a week plus next week's plus the futures board exceeds one page; real matchups float above futures |
| `src/polymarket.js` | College teams match on the school name (display name with ESPN's mascot stripped) | The matcher keyed on the last word of the team name. Pro events are titled by mascot ("Yankees vs. Red Sox"); college events by school ("SMU vs. Florida State"). Nothing had ever matched |
| Verified only | CA Odds Engine NCAAF rows | Running (pm2, 6 days up) and covering NCAAF across 14 books; they now find game rows to attach to |

**Verified:** live `syncPolymarketData` against the 87 games matched **64** (was 0). SMU at Florida State: $995k volume, home 61.5%, total 54.5 with over/under probabilities.

---

## Batch C: Scraping every game (`43f1083`)

The matcher you designed, with the 4-point tolerance.

| File | Change | Why |
|---|---|---|
| `src/source_ingest.js` | `resolveGameMatches` rewritten. (1) Sport constraint narrows the pool. (2) One team pair, several games (a doubleheader): nearest unstarted wins, exactly as before. (3) Different pairs: keep candidates whose market is within **4 points** of the posted spread (picked side) or total, or within 60 of the posted moneyline; exactly one survivor is taken. (4) Still ambiguous: **refuse** and log | The old rule took the earliest kickoff. For college that is a coin flip: "Texas" + "State" hits four different games on one Saturday. A wrong hit lands a graded row in the wrong capper pool |
| `src/source_ingest.js` | `findGameByTeams` / `findGameByAbbrs` take an opts bag (pickType, side, line, odds, source, capper, picked); `lineAgrees` derives the side per candidate when the caller only knows the picked name | Covers and WagerTalk parse the pick before the game is known |
| `src/source_ingest.js` | `sportForLeague()` maps source league labels to CA sports | Unknown leagues return null and match unconstrained rather than dropping the pick |
| `src/an_experts.js` | Passes AN's `league_name` as the sport, plus full line confirmation | The one source that matched with no sport. "Clemson Tigers @ LSU Tigers" could land on Detroit's Tigers |
| `src/covers_contests.js`, `src/wagertalk.js` | Pass the pick's line | They have it at match time |
| `src/bettingpros.js`, `src/cbs_picks.js`, `src/polymarket_wallets.js` | Pass a source label | They match per event before picks are parsed; the label feeds the refusal log |
| `src/db.js`, `src/wipe.js` | New `source_skips` table (source, capper, sport, picked, pick type, line, odds, reason, candidates JSON); pruned at 14 days | The refuse-and-log half of the rule. Ambiguous picks are visible and recoverable instead of guessed |

**Verified on the real 2026-09-12 slate, 16 of 16 cases:** no line refuses and logs; Texas -14 takes Texas A&M; Texas Tech -26 takes the Oregon State game; over 64 takes Texas State; over 50 fits three games and refuses with the right reason; the boundary accepts a 4.0 gap and refuses 4.5; ML -600 takes A&M while ML -120 correctly refuses (Texas State -118 and Texas -120 cannot be told apart by price); a doubleheader still returns the earlier game with nothing logged; a full name narrows before the resolver runs.

---

## Batch C, follow-ups (`9d1482d`, `da9f130`)

Two things surfaced within the first hour of Batch C running on prod and from the edge-case hunt that ran alongside it.

| File | Change | Why |
|---|---|---|
| `src/source_ingest.js` | `findGameByTeams` tries the **full** team strings first and falls back to last words only when that finds nothing | Prod refused "Ohio State @ Texas" across four games and "Washington State @ Kansas State" across thirty-two, because only the last word of each name was ever used as the substring, and for college that word is usually "State". Every refused pick now resolves to one game before the line check; a genuine bare collision still refuses |
| `src/lines.js`, `src/scoring.js`, `src/storage.js`, `src/scoring_v3.js` | **Correction to Batch 0.** The home slot always carries `is_home_team = 1` again; the v2 home bonus reads a `neutral` flag (looked up from `today_games.neutral_site`) and the v4 side lean skips neutral games outright | `is_home_team` is the side selector every reader uses (`capperBetOdds`, the T-60 `slotDisplay`, the popup's `buildPickBySlot`, `pickSlotKey`). Seeding it 0 on a neutral game made both sides read "away": one ML pick vanished from the page, grading wrote the opponent's odds, the lock stamped the wrong side's line. No neutral game reached a live board before the correction |
| `src/storage.js` | `getCanonicalTeam` scores both sides | It tested only the home side, one-way, and returned it on any brush: "Kovacevic" contains "vac" so a Kovacevic pick was filed on Vacherot; "Islanders" contains LA's abbreviation. With 172 college names in play this files a lot of picks on the opponent. Audit measured 110 wrong to 10 with zero regressions on pro sports |
| `src/source_ingest.js` | `sideOf` scores both sides; a dead tie returns null | Home-first and one-way: "New York" filed a Mets pick on the Yankees. Batch C made it load-bearing for the line confirmation. Audit measured 144 wrong to 0 |
| `docs/ALGO_PLAYBOOK.html` | Neutral-site rule and the line-confirmed matcher added; "Current as of" bumped | The Playbook rule in CLAUDE.md |

**Verified:** 13 of 13 side-resolution cases; 6 of 6 re-runs of the exact picks prod had refused; neutral home slot keeps `is_home_team = 1` with v2 bonus 0 and hosted games still at 5. Prod showed zero refusals in the first window after the restart.

---

## Batch D, the two decisions (Sep 8)

Both approved on Sep 8 and shipped together.

| File | Change | Why |
|---|---|---|
| `src/game_match.js` (new), `src/expert_data.js` (import + 4 call sites) | Discord picks resolve inside the sport the reader named, ranked by match quality (exact stored name beats a leading or trailing word, which beats a substring). A tie at the best quality that is not a doubleheader is refused and logged to `source_skips`. If the reader's sport has no candidate and the only match is another sport, that is refused too | `lookupTodayGame` broke multi-sport ties with a priority list that omits college football, so "Tigers" on a Saturday went to the Detroit Tigers and the pick graded on a baseball final. The same quality ranking also fixes "Texas" resolving to Texas A&M inside football. `espn_live.js` itself is untouched |
| `src/storage.js`, `src/results.js`, `src/scoring_v3.js` | A moneyline pick on a side with a spread of -25 or worse and no posted price grades at -100000, and the display cap treats it as the heaviest favorite (95, silver at best) | Six of Saturday's twelve 25-point favorites carry no moneyline at all; the ratings were substituting -110 and crediting a sure thing with +0.91 units. Where a book does price those spreads it is -4500 to -50000. Derived at grade time only, never written to the public line |
| `docs/GRADING_RULES.md` | R12 (unpriced favorites) and R13 (Discord names its sport) | The rule book |
| `docs/ALGO_PLAYBOOK.html` | Sep 8 entry, chapter 7 sentence; Desktop copy and artifact republished | The Playbook rule |

**Verified:** 9 of 9 favorites cases through the real `capperBetOdds` and the display cap on the actual Howard at Indiana row; 12 of 12 Discord cases on the real Saturday slate, including "Texas" now resolving to the Longhorns where the old lookup returned Texas A&M, a Tuesday "Tigers" from a football capper refused instead of landing on Detroit, a CBB pick refused on a football Saturday, the Yankees and a doubleheader unchanged. One expectation of mine was wrong and the code was right: a bare "Tigers" on college football Saturday names six teams (Missouri, Memphis, Towson, LSU, Clemson, Auburn) and is correctly refused.

## Still open, from the edge-case hunt (30 agents, verified)

Ranked. None of these were in the three batches you confirmed, so none shipped. The first three are correctness, the rest coverage or polish.

| # | What | Where | Why it matters | Size |
|---|---|---|---|---|
| 1 | Done Sep 8 (Batch D) | | | |
| 2 | Done Sep 8 (Batch D) | | | |
| 3 | **The scanner's own canonicalizer omits `home_abbr`.** "OSU" finds the right game and is handed to the wrong team | `src/expert_data.js:184` | Audit measured NCAAF 449 wrong to 4, CBB 192 to 3, zero regressions. Protected file; same shape of change as Batch D | ~10 lines |
| 4 | Book rows dropped on shared-mascot games (LSU Tigers @ Auburn Tigers, White Sox @ Red Sox) | `src/odds_ingest.js:50` | Zero book coverage on 7 real CFB games this season | ~8 lines |
| 5 | `storage.findTodayGame` has no date filter against an 8-day board, so a pick for next Saturday can grade on this Saturday's final | `src/storage.js:227` | Live today: SMU sits on both Sep 7 and Sep 12 | ~20 lines |
| 6 | Postponed games grade off a phantom 0-0 final (pre-existing, 10 bad prod rows in MLB/WNBA) | `src/results.js` | Known from July; not college-specific | ~12 lines + restatement |
| 7 | Phase 6 from the original plan: a per-sport "in season but zero games" alert | `src/ops_health.js`, `src/admin.js`, `src/audit.js` | The alarm that would have caught this in August instead of September | 2 to 3 days |

Items 4, 5 and 7 are in files I can edit. Item 3 is in a protected file. Item 6 is a separate repair with its own restatement.

## The Discord path, resolved

Shipped Sep 8 as Batch D. `espn_live.js` is untouched; `expert_data.js` carries one import and four one-line call-site changes; all new logic lives in `src/game_match.js`.

---

## Also in this session, outside the batches

- `docs/NCAAF_COVERAGE_AUDIT.md`: the 11-layer audit with every root cause and its proof.
- Scratch test DBs and a `capperboss-ncaaf` entry in `.claude/launch.json` (gitignored) that runs the worktree on port 3077 against a DB holding the real 87-game window. Useful for the next college football change.
- Copy left as you chose: `unlock.js` and `/ncaaf` keep their present-tense promises; picks will follow.
- App: untouched by design. It has no native sport list and rewrites API calls to cappingalpha.com, so every backend and shared-module fix above reaches it on the deploy. The shared-module bundle rebuild waits for the next release.
