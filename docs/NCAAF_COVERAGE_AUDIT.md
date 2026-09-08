# College Football (NCAAF): Coverage Audit and Fix Plan

**Date:** 2026-09-07 · **Branch audited:** `origin/master` (what production runs) · **Status:** audit complete, nothing shipped yet

Deep audit of why college football is absent from the site and the app. 11 parallel investigators,
28 findings that survived adversarial verification, 2 refuted. Every claim below was re-verified
by hand against production logs, the live ESPN API, or the running site.

---

## 1. The answer in one paragraph

College football has never once reached the board during a season, and the cause is a single line.
`src/ncaaf_espn.js:24` sends `User-Agent: Mozilla/5.0` on its ESPN call. In production that request
gets a **403**, every time, while every other ESPN fetcher (which sends no User-Agent override)
gets a 200 from the same host in the same minute. The failure is swallowed into a `console.warn`
nobody reads, so zero games have ever been written. Everything downstream is already built and
correct: scoring, grading, the lines layer, all 14 books in the CA Odds Engine, all seven capper
sources, the frontend, and the app. They are idle for want of game rows.

### Proof, straight from the Railway log

```
[ESPN] today_games: 11 MLB games upserted                                     <- espn_live.js, no UA override
[ncaaf_espn] fetchTodaysNcaafGames error: Request failed with status code 403  <- sends Mozilla/5.0
[live_situation] MLB scoreboard fetch failed: Request failed with status code 403  <- sends Mozilla/5.0
```

Those are the only two 403s in the log, and they are exactly the two modules that override the
User-Agent on `site.api.espn.com`. That is the whole tell.

### What the site shows today

| Check | Result |
|---|---|
| ESPN slate, Sat 2026-09-05 | 68 FBS games |
| ESPN slate, Sat 2026-09-12 | 80 FBS games |
| `prod /api/games?sport=NCAAF` | `[]` |
| `prod /api/game/401856661` (Louisville at Ole Miss) | 404, row does not exist |
| Prod picks by sport | ATP 32, MLB 90, Soccer 1. No NCAAF |
| All-time capper ledger | Zero NCAAF rows, ever |
| `/ncaaf` page | "No NCAAF games on the board today", printed directly above six live CBS college football headlines |

---

## 2. Blast radius beyond college football

The same header sits on three more modules that all hit `site.api.espn.com`:

| File | Line | What it powers |
|---|---|---|
| `src/ncaaf_espn.js` | 24 | All college football games |
| `src/live_situation.js` | 77 | In-game state for every sport |
| `src/live_tracker.js` | 54 | The live command bar |
| `src/espn_summary.js` | 74 | Play-by-play, leaders, team stats |

`src/espn_probs.js` also sends it but hits `sports.core.api.espn.com`, a different host, and is
working (prod returns a real win probability).

**The live tracker is running blind for every sport right now.** Prod, on a live MLB game:

```json
{"status":"in","period":7,"homeScore":4,"awayScore":5,
 "detail":null,"half":null,"outs":null,"bases":null,"balls":null,"strikes":null,
 "batter":null,"pitcher":null,"lastPlay":null}
```

The diamond, the count, and the last play are all dead. Deleting four headers fixes college
football and repairs the live tracker for MLB, NFL, NBA, NHL, soccer and tennis at the same time.

---

## 3. The other verified root causes

### 3.1 ESPN retired the `americanfootball` slug, and the fix is stranded uncommitted

`sports.core .../americanfootball/leagues/college-football/...` returns **400**. `.../football/...`
returns **200**. Master still uses the dead form in three files, which kills popup stats, injuries,
venue, Team Form, team history, player gamelogs and the ESPN opening-line capture for **NCAAF and NFL**.

Proven on production through a public endpoint:

```
/api/team-history?teamId=194&sport=NCAAF  ->  {"unavailable":true}
/api/team-history?teamId=12&sport=NFL     ->  {"unavailable":true}
/api/team-history?teamId=10&sport=MLB     ->  full 13-7 summary
```

The fix is already written in the `bet-tracking` working tree (6 lines across `game_stats.js`,
`team_history.js`, `line_history.js`) and `git log origin/master..HEAD` on those files is **empty**.
It exists in no commit on any branch. One careless checkout destroys it. NFL week 1 opens 2026-09-10.

`src/espn_probs.js:23` already carries the comment "sports.core paths (NOTE: 'football', never
'americanfootball')". The lesson was learned in one file and never propagated.

### 3.2 A correctness risk: college picks can attach to pro games

`src/an_experts.js:144-145` calls `findGameByAbbrs(a, b)` and `findGameByTeams(a, b)` with **no sport
argument**, even though the Action Network payload carries `league_name`. Every other source passes it
(`bettingpros.js:121`, `covers_contests.js:143`, `wagertalk.js:138`, and others), and
`src/source_ingest.js:45-47` documents exactly why: "without it a bare city pair can hit the wrong
sport's game."

Replaying master's real SQL against today's live board, "Clemson Tigers @ LSU Tigers" matches MLB's
"Detroit Tigers @ Cleveland Guardians" and clears the pregame gate. `src/espn_live.js:202`
`SPORT_PRIORITY` omits NCAAF entirely, so it defaults to 99 and loses every name collision: 11 of 14
bare school names misroute (Texas, Houston, Miami, Kansas, Colorado, Arizona, Cincinnati, Minnesota
and Washington to MLB, Tennessee to the NFL Titans).

This writes a mislabeled row into `capper_history`, which is a Wilson pool input. It is a misgrading
risk, not a coverage gap, and it ranks above everything except the 403.

### 3.3 Coverage gaps

| Gap | Evidence |
|---|---|
| No forward-day NCAAF rows | `src/forward_games.js:23` iterates `espn_live`'s `TODAY_SPORTS`, which lists only CBB, WCBB, NBA, NHL, MLB, NFL. College football is a once-a-week sport whose sources publish days ahead, so midweek picks for Saturday can never match |
| ActionNetwork public betting slug wrong | `src/public_betting.js:16` and `scripts/pb_relay.js:37` use `college-football`, which 404s. `/ncaaf` returns 200 with 99 games |
| Polymarket tag wrong | `src/polymarket.js:17` uses `tag_slug=ncaaf`, which returns 100 futures markets and zero matchups. `tag_slug=cfb` returns 72 of 100 as real matchups including today's games |
| ESPN scoreboard carries no odds for CFB | 0 of 68 events had an odds array. Lines must come from the CA Odds Engine (already scraping NCAAF across all 14 books) or `sports.core`, not the site scoreboard |

### 3.4 Why nobody noticed for a full season

The monitoring stack is dimensioned by **source** and by **table**, never by **sport**. Absence is
structurally undetectable.

- `src/admin.js:4670` `EXPECTED_SOURCES` covers sources only.
- `src/ops_health.js:82` reduces `today_games` to one bare `COUNT(*)`, currently reading "136 games on
  the board, ok" on a weekend that produced 68 college football games and zero rows.
- `ops/ui.html:524` seeds book-matrix columns from the union of sports that have rows, so a sport with
  no rows has no column.
- All eleven `audit.js` rules iterate rows that exist.

The 2026-09-03 research pass literally wrote down "NCAAF and CBB: zero rows" and it was filed as
inventory, never escalated.

---

## 4. One premise I got wrong

I opened this audit believing the dated ESPN query was broken, because `dates=20260906` returns 3
events while the undated call returns 99. That was wrong and the audit corrected it.

ESPN buckets `dates=` by **Eastern game day**, which is exactly what `getCycleDate()` produces.
`dates=20260905` returns 68, `dates=20260912` returns 80, and `dates=20260906` returns 3 because
Sunday genuinely has three college football games. The undated form returns a 99-event **week**
bucket spanning 08-29 to 09-07 and would flood `today_games`.

**The dated query is correct. Do not touch it.** `groups=80&limit=400` is also load-bearing:
`groups=80` is FBS, and without it the scoreboard returns only the Top 25.

---

## 5. The plan

### Phase 1: Games on the board (half a day, 4 files, ~8 lines)

Ship from a detached worktree off `origin/master`. The `bet-tracking` checkout carries ~35 unrelated
modified files and is behind master on several.

| File | Change |
|---|---|
| `src/ncaaf_espn.js:24` | Delete the `User-Agent` header |
| `src/live_tracker.js:54`, `src/live_situation.js:77`, `src/espn_summary.js:74` | Delete the identical header |
| `src/odds_api.js:19` | Set `NCAAF: null` so restoring the board does not start spending Odds API credits |
| `src/ncaaf_espn.js` | Make the fetcher audible. Log the count unconditionally and log errors at `console.error`. This silence is why a season-long outage was invisible |
| `src/ncaaf_espn.js` | Delete the dead `updateNcaafLiveScores` export (never called anywhere) |

**Verify:** `curl -s "https://cappingalpha.com/api/games?sport=NCAAF" | jq length` should be non-zero
within 5 minutes of deploy, and `/api/game/<cfb id>/live` should return a populated `detail` field on
any live game in any sport.

### Phase 2: Stop the misgrades before Saturday grades (1 to 2 days)

Highest-judgment work in the plan. It touches shared ingest paths used by six sources.

- `src/an_experts.js`: pass the league AN already gives us into the matcher, and verify the picked side by name.
- `src/expert_data.js`: stop the word fallback crossing sports. Do this through a new thin
  `src/game_match.js` wrapper rather than editing the do-not-touch file directly.
- `src/source_ingest.js`: refuse ambiguity in `resolveGameMatches` instead of silently picking the earliest game.
- Audit existing damage: `capper_history` rows from `actionnetwork` whose sport disagrees with the source pick.

### Phase 3: Ship the stranded league-path fix (under an hour)

Cherry-pick the three already-written files onto a worktree off `origin/master`. Do not merge
`bet-tracking`. Then make a dead path loud instead of silent at `line_history.js:57` and
`game_stats.js:155`.

### Phase 4: Forward days and free markets (2 to 3 days)

Forward-day window for NCAAF using its own fetcher (never via `espn_live`), a retro-match pass so a
pick arriving before its game row is not lost, the AN slug fix in both files, the Polymarket tag plus
paging plus matcher, spread juice capture, a Covers HTML-decode for A&M and A&T schools, and the
BettingPros API key regex which is already dead against their current bundle.

### Phase 5: Names, colors, and the app (1 to 2 days)

`teamNickname` currently mangles school names ("Ohio State" renders as "State Buckeyes"), and Ohio
State and Penn State both produce a "STA" chip. Prefer ESPN's short name, which is already stored.
Ship four columns `index.js` fetches but never sends. Pull team colors from ESPN rather than
hand-maintaining a map. Then hand-port three frontend files to branch `app` and rebuild the bundle.

Note: 192 of 362 CBB teams (53%) render mangled today, so this matters more for basketball.

### Phase 6: Make a dead sport impossible to miss (2 to 3 days)

- `src/espn_client.js` (new): one shared ESPN request helper so no per-file header can reintroduce the 403.
- `src/ops_health.js` + `src/admin.js`: add a **sport axis**, with the expected value taken from ESPN
  rather than a hardcoded calendar.
- Fetcher heartbeats at every call site, so a throwing fetcher goes red even when the sport
  legitimately has no games.
- `audit.js` rule **R12**: a sport in season must put games on the board.
- Surface it in `ops/ui.html` and send one push, since the ops console is a localhost page someone has
  to remember to open.

---

## 6. Decisions for Jack

| Question | Recommendation |
|---|---|
| Odds API for college football, or free sources only? | **Free only.** Set `NCAAF: null` in `src/odds_api.js:19`, same as Soccer and WNBA. The CA Odds Engine already covers NCAAF across all 14 books and is relaying ~230 NCAAF rows per cycle that prod discards for lack of a game row |
| Ship Phase 1 alone tonight, or with Phase 2? | **Together, before Saturday.** Phase 1 alone turns on a pick flow whose matcher can still attach a college pick to an MLB game |
| Fix NCAAF only, or build it generically for CBB? | **Generic**, but in Phase 4 rather than Phase 1. Do not delay the 403 fix for a refactor |
| How far ahead should the forward window reach? | **6 days for NCAAF on the 5am pass only**, leaving the hourly pass at 2 days |
| Does the app need a rebuild now? | **No.** Phases 1 to 4 reach the app for free on the Railway deploy, because the app has no native sport list and rewrites API calls to cappingalpha.com. Hold the port for the next release |

---

## 7. Copy that currently over-promises

Phase 1 makes most of this true, so fixing the data beats weakening the copy. If Phase 1 slips past
Saturday, these are the exposed ones:

1. **`src/sport_page.js:118`** is server-rendered and indexed. The `/ncaaf` body says college football
   plays "get scored and ranked by our proprietary scoring engine the same way as the pros", in the
   present tense, directly below "No NCAAF games on the board today". `:122` has the same problem for CBB.
2. **`public/modules/unlock.js:160`** on the pricing page lists NCAAF under "Every sport, every day"
   with a check glyph. Safest neutral wording: "Every sport on the board, every day". The same list is
   in `public/index.html:65` and `public/llms.txt:13`, so fix all three together.
3. **`src/sport_page.js:437`** advertises an MVP record section it cannot fill. Generalize the guard
   already at `:415` from `slug === 'mma'` to `if (!picks.length) return ''`, which fixes NCAAF, CBB
   and Golf at once.
4. **`index.js:406`** puts `/ncaaf` in the sitemap at daily/0.7 with an "index, follow" meta. Do not
   gate the sitemap on `today_games` rows: `/golf` and `/mma` render live content with zero rows there.

Leave `public/modules/sports.js:697` ("No NCAAF games today") alone. It is honest and click-gated.
Leave the nav paths alone; `src/nav_tabs.js` has a boot-time `assertNavInSync()` guard.

---

## 8. What college basketball gets free

**Free:** the Phase 2 sport-aware matchers (CBB is priority 1 in `SPORT_PRIORITY`, so in November every
school playing both sports the same day sends its football picks to the basketball game), the Phase 6
monitoring, and the Phase 5 name fix.

**Still needed:** CBB does not share the 403, but has its own bug. `src/espn_live.js:83` fetches
college basketball with no `groups` parameter and returns a fraction of the slate: 1 of 49 games on
2026-01-15, and 18 of 155 on 2026-02-07. Since `espn_live.js` is do-not-touch, the fix is a
supplemental `src/cbb_espn.js` on the `ncaaf_espn.js` pattern with `groups=50&limit=400`, upserting on
`espn_game_id` so the two writers coexist. Also set `CBB: null` in `src/odds_api.js:20`, more urgently
than NCAAF given 49 to 155 games a day on a 500-credit tier.

---

## 9. What is already correct and needs no work

The dated ESPN query and `groups=80`. `upsertNcaafGame` (proven by executing the real module against a
DB copy: it wrote all 3 of today's games cleanly). `src/wipe.js`, which has no sport allowlist. The
`index.js` wiring, which demonstrably executes at all four call sites. The entire lines layer
(`lines.js`, `ca_line.js`, `closing_lines.js`, `consensus.js`, `lines_scraper.js`), all sport-agnostic.
The CA Odds Engine's NCAAF coverage across all 14 books. `scoring.js` (correct uppercase `NCAAF`, and
correctly absent from `NO_HOME_BONUS_SPORTS`). The cold-start path, since NCAAF is not in
`v3_insport_sports` and so rides the overall Wilson ladder like every other non-MLB sport. `results.js`
grading, which already uses the correct path. All eleven `audit.js` rules. Every capper source mapping
(four confirmed publishing readable free pregame CFB picks right now). `reader_rules.js`. `kalshi.js`.
`insights.js` and `headlines.js`. `detail_page.js` and `og_card.js`. `track_schedule.js`, which is the
one surface already serving live college football data and is the reference implementation.

**Operational load is lower than feared:** the T-60 line lock peaks at 17 to 18 simultaneous games, and
it is pure synchronous SQLite with no network in the loop.

---

## 10. The deadline

**Saturday 2026-09-12 carries 80 FBS games.** Missing it costs a full week of the season and delays the
first NCAAF capper data, which compounds the cold start.
