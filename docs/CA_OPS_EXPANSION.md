# CA Ops Expansion: The In-House Odds API

Research date: 2026-07-09 (late night). Four-workstream deep research: commercial
benchmark (web), market-depth probes (live, this Mac), new-source probes (live,
this Mac), and an architecture headroom audit. Every endpoint claim below was
verified with a real request on 2026-07-09 unless marked otherwise. Owner: Jack.

## EXECUTION STATUS (built 2026-07-10, same night, all phases)

Everything below was implemented and live-verified the night of the research.
- Phase 0 hardeners: cycle in-flight guard, transaction-wrapped ingest (once
  per POST, match-once-per-event for props), heartbeat meta cap fixed (valid
  JSON stub instead of truncated garbage), period readers parameterized.
- Phase 1: 5 new AN books (fanatics, thescore, ballybet, unibet, betvictor)
  verified flowing; AN team totals; Pinnacle team totals + alternate ladders +
  priced player-prop specials; BetRivers full-catalog parse (props, milestones,
  team totals, F3 period lines); FanDuel popular-tab swap + prop tabs (within
  12h); DK depth subcategories + book_props table with 3-day pruning.
- Phase 2: engine_event_lines lane (Esports/MMA/Boxing/Cricket/Table Tennis/
  Darts/Rugby/Volleyball) from Pinnacle sport ids 12/22/6/8, Bovada coupons,
  Kambi 4-segment paths, DK league 9034. First cycle: 411 event-lane rows
  (Esports 23 incl Dota 2 EWC, MMA 27+, Boxing, Cricket).
- Phase 3: adapters parallelized per book (cold sweep every 5 min), hot loop
  every 75s for games starting within 90 min (league boards only, lite mode).
- Phase 4: book_lines_closing archive (4:58am snapshot + admin query endpoint)
  and the CA consensus line (src/consensus.js, 5-min cron, /api/game payload,
  game-detail Public markets row).
- First expanded cycle: 4,187 adapter rows (was ~920), 1,549 prop rows, 411
  event-lane rows, F3+F5 periods storing. Props + event lanes 404-firewall
  against prod until the next ship; everything else flows already.
- Still open by design: live in-play lane, blocked offshore books (quarterly
  re-probe), futures, DK esports league id, golf H2H parsing (odd shape).

Ground rules this plan respects: zero paid APIs, no logins, public endpoints
only, plain fetch from the Mac's residential IP, lines lock at game start.

---

## 1. Where CA Ops stands today (baseline, 2026-07-09 ~10pm ET)

- 9 books live on prod: bovada, draftkings, fanduel, betrivers, pinnacle + the
  AN aggregator four (bet365, betmgm, caesars, hardrock).
- Coverage after the date-aware matcher deploy: bet365 27 MLB games, FD 28,
  BR 22, DK 21 (multi-day board). WNBA all books. Tennis via Bovada relay.
- Markets: full-game ML/spread/total + F5 (MLB first five innings) from 5 books
  into book_lines_period (46 rows/cycle stored).
- Cadence: 5-minute cycle, ~131 requests, ~97s of built-in sleep, 2.5-4 min
  wall clock (50-80% duty cycle). Sequential adapters.
- Lines lock at start at every layer (engine drop + ingest guard + writer guards).

## 2. The commercial bar (what the paid products sell)

| Capability | The Odds API | OpticOdds (enterprise) | SportsGameOdds (mid) | Unabated (sharp) |
|---|---|---|---|---|
| Books | 40+ | 200+ marketed, 363 in docs | 85+ | sharp set + majors |
| Sports | 70+ | 38 categories, 500+ soccer leagues | 28+ / 67 leagues | ~8 US |
| Esports | none | CS2/LoL/Dota2/Valorant/CoD | yes | no |
| Player props | 18-63 keys/sport, per-event only | "unmatched", incl live | all tiers, 1,276 market types | props + DFS lines |
| Alternates / periods | yes / yes (incl F5) | yes / yes | yes / yes | yes / yes |
| Live in-play | 40s featured | sub-second push | 30-60s | tiered latency |
| Pre-match cadence | 60s | sub-second | 10min free to sub-min $299 | poll 1/s + push |
| Historical / closing | 10x credit cost | open/close + history | $299+ tier | closing + settlement |
| Price | $30-249/mo | ~$5k+/mo reported | $99-299/mo | $3k/mo |

What customers actually pay for, ranked: (1) live in-play, (2) props depth,
(3) sharp books + exchanges in the set, (4) sub-60s pre-match cadence,
(5) alternates + periods, (6) closing-line history, (7) no-vig consensus
(Unabated's whole moat is one computed number), (8) push delivery, (9) breadth
checkboxes (esports, table tennis, 500 soccer leagues).

CA Ops already owns pieces nobody gives away free: Pinnacle (sharp anchor),
Polymarket + Kalshi (the exchange lane, direct), a closing-line capture (the
lines lock IS a closing archive), and 9 books at 5-minute cadence.

## 3. Verified findings

### 3a. Market depth on the books we already scrape (all verified live)

Zero-extra-request wins (the payloads we already download contain these):

| Win | Source of truth | Evidence |
|---|---|---|
| Team totals | Pinnacle markets/straight `type=team_total` | 93 MLB rows in the current payload |
| Alternate ladders | Pinnacle `isAlternate=true` rows | 275/697 MLB rows, full ladders |
| Player prop specials | Pinnacle matchups `type=special` + priced in the SAME straight payload (matchupId = special id) | 318 MLB specials (~28/game: HR, TB, Ks, ER, outs), WNBA ~17/game |
| Team totals (Caesars + BetMGM) | AN scoreboard `core_bet_type_6_team_score` | 4 rows/game, only these two brands carry it |
| Full BetRivers catalog | the per-event Kambi call the F5 pass ALREADY makes | 542 offers on a game-day event: 489 player props ("Player Occurrence Line", player in `outcome.participant`), team totals, alt ladders (MAIN_LINE tag logic already written), First 3 Innings, per-quarter markets (WNBA) |
| FanDuel alternates + team totals + F5 in one call | switch the existing per-game call from `tab=first-5-innings` to `tab=popular` (superset) | ALTERNATE_RUN_LINES, ALTERNATE_TOTAL_RUNS, HOME/AWAY_TOTAL_RUNS, 1ST_HALF_*, 1ST_INNING_* in one payload |

Cheap adds (+1 request per league per family, slate-wide not per-game):

- DraftKings nash subcategories: `leagues/{id}/categories/{cat}/subcategories/{sub}`.
  Alternate run line (493/13168), alternate totals (493/13169), team totals
  (1674), batter/pitcher prop families (743/1031: O/U + milestones, player name
  always in `participants[]` with stat metadata). Best player-identity data of
  any book. Futures categories exist per league (Champion, Divisions, Wins).
- Bovada per-event displayGroups (the call already spent for MLB F5): Alternate
  Lines group (incl team totals), Pitcher/Player Props, Game Props, and for
  basketball: quarters + halves (28 Q1 markets on a WNBA game). 200 markets on
  a WNBA event at T-2h.
- FanDuel prop tabs (+2 calls/game inside 24h): batter-props, pitcher-props.
  Must read `layout.tabs` first (unknown slugs silently return the default tab).

Timing reality: prop boards hang on GAME DAY everywhere (Kambi event: 36 offers
at T-21h, 542 at T-1min). A props pass needs cadence weighted to the pre-lock
window, not the morning.

Period markets: book_lines_period's shape already fits quarters and halves
(period TEXT + UNIQUE(game, book, period)); only readers hardcode 'F5' today.
Pinnacle baseball periods: 0 game, 1 F5, 3 first inning; live games expose
per-inning periods. Basketball: 1 = half, live rows consistent with quarters.

### 3b. New books (verified live)

The AN aggregator carries far more than the 4 books we pull. Confirmed
returning full odds for 13/13 MLB games today, each a ONE-LINE regex add to
`AN_TARGET_BOOKS`:

| New book | Coverage verified | Effort |
|---|---|---|
| Fanatics | 13/13 | one regex line |
| theScore Bet | 13/13 | one regex line |
| Bally Bet | 13/13 | one regex line |
| Unibet | 13/13 | one regex line |
| BetVictor | 13/13 | one regex line |

That takes the matrix from 9 to 14 books. AN also exposes pseudo-books worth
storing separately someday: id 15 Consensus and id 30 Open (the market open).
Skip Kalshi id 4727 (we scrape it directly).

Blocked (verified again tonight, honest list): ESPN BET (no public API, not in
AN), Fanatics direct (no public DNS for API hosts; AN covers it), BetUS,
Heritage, BetAnySports, Stake, GG.bet, Thunderpick (all Cloudflare/Incapsula
403), MyBookie (client-side widget, no JSON), Everygame (CF-gated odds),
BookMaker.eu (server-rendered HTML scoreboard, no JSON; parseable but brittle,
low priority). Exchanges: Novig is a reachable GraphQL endpoint (feasible,
needs query construction, small book); ProphetX/Sporttrade/Cloudbet are
partner/key-gated (violates no-login).

### 3c. Esports + more sports (verified live)

Esports has two clean free sources, both reusing existing adapter patterns:

1. Pinnacle sport id 12 (best): `/sports/12/leagues` then the same
   matchups + markets/straight calls. CS2, LoL, Dota 2, Valorant, R6; 42 live
   matchups tonight; identical payload shape to team sports (home/away
   alignment, ML + spread). League ids rotate per tournament, so add a
   discovery step. Sharpest esports prices in the market.
2. Bovada `esports` coupon path: 47 events, ML + spread + total, standard
   coupon shape (the existing parser handles it).

More sports, all with working endpoints tonight:

| Sport | Sources verified | Notes |
|---|---|---|
| MMA / UFC | Pinnacle sport 22 (27 matchups), Bovada ufc-mma (67 events, "Fight Winner" ML + spread + total rounds), Kambi ufc_mma (18), DK nash league 9034 (22 events) | 4 books converge; Bovada/DK need ML/market name mappings |
| Boxing | Pinnacle sport 6, Bovada boxing (37 events, "To Win the Bout") | already have Bovada fixtures via engine_events |
| Table tennis | Bovada (33 events), Kambi table_tennis (40) | ML only |
| Cricket | Pinnacle sport 8 (16), Bovada (29), Kambi (21) | ML (+spread/total on Kambi rugby-style) |
| Darts / snooker / volleyball / aussie rules / rugby | Bovada + Kambi both | ML or full ML/spread/total |
| Golf H2H matchups | Bovada golf (131 events incl Round Match-Ups H2H MLs), Kambi golf (44) | player names in outcome descriptions |
| ITF/Challenger tennis | Kambi tennis/all/all/all (100 events) | below the site's current tier filter, but the ENGINE can still record them |

Kambi gotcha discovered: the working path is 4 segments
(`listView/{sport}/all/all/all/matches.json`); the current 3-segment pattern
404s for new sports. The US operator (rsiusil) carries no esports.

NFL note: Pinnacle already prices week 1 (527 straight rows incl 32 team
totals + 320 alternates) plus 77 priced season-long player props. Football
coverage starts flowing the day the adapters ask for it.

### 3d. Architecture constraints (audit)

- Cycle: adapters run sequentially; ~131 requests + ~97s sleep = 2.5-4 min
  wall per 5-min cycle. `setInterval` has NO in-flight guard (odds_engine.js:398):
  at faster intervals, cycles overlap and double per-host volume.
- Parallelizing per-book costs nothing politeness-wise (different hosts) and
  drops a full sweep to the slowest adapter (~30-40s).
- Ingest: 700-row chunks are fine; the loop commits per row (no transaction)
  and matchGame re-matches per row. Props multiply rows 50-200x per game, so:
  transaction-wrap each POST + match once per (book, event) and fan out.
- Schema: props do NOT fit book_lines. Minimal add: `book_props`
  (espn_game_id, book, player, market, line, over_odds, under_odds, game_date,
  updated_at, UNIQUE(game, book, player, market)) on the book_lines_period
  pattern. MUST be pruned (props at scale = ~50k rows/day = ~4.5GB/yr if kept;
  give it game_date and prune with the stale-game sweep). book_lines_period
  itself already fits Q1/1H with no schema change (parameterize readers).
- Non-ESPN sports (esports, MMA, boxing, table tennis, cricket, darts, golf
  H2H): today_games can never hold them (no ESPN scoreboard), and the engine
  must never mint today_games rows. The lane that exists: engine_events
  (fixtures, fed by Bovada, listed by the betslip as custom-only entries).
  Build `engine_event_lines` = book_lines shape keyed to engine_events + book,
  matched with the same matchGame against engine_events rows. Explicitly
  display/track-only: no CA line, no grading, no rankings.
- Ops console: the matrix auto-extends for new books/sports on book_lines.
  Props, periods beyond F5, and the event lane need their own count queries.
  Heartbeat meta truncates at 4,000 chars and silently blanks when exceeded;
  more adapters WILL hit this. Raise or slim it first.

## 4. The build-out roadmap

### Phase 0: hardeners (do first, ~half a day)
1. Cycle in-flight guard (skip a tick if the previous cycle is still running).
2. Transaction-wrap each ingest POST (pattern exists in wipe.js/ca_line.js).
3. Heartbeat meta: slim adapter stats + raise the 4k cap so ops never blanks.
4. Parameterize the period readers (getPeriodLinesForGame + book-cell f5 flag
   become period-aware).

### Phase 1: free depth + 14 books (highest value per line of code)
1. AN regex lines: Fanatics, theScore, Bally, Unibet, BetVictor (9 -> 14 books).
2. AN team totals branch (Caesars + BetMGM) into book_props or a team-total
   column strategy (decide with the book_props table).
3. Pinnacle: parse team_total rows, isAlternate ladders, and prop specials
   (priced in the payload we already fetch).
4. BetRivers: parse the full per-event catalog we already download (props,
   team totals, alt ladders, First 3 Innings).
5. FanDuel: switch the per-game call to tab=popular (alternates + team totals
   + F5 in one).
6. New table book_props + pruning + ingest routing (+ ops count query).
Requires: book_props schema, prop parsing per book, zero new request volume.

### Phase 2: esports + sports breadth (the checkbox parity play)
1. engine_event_lines lane (schema + ingest + betslip read via eng-<id>).
2. Pinnacle esports (sport 12 + league discovery) and Bovada esports path.
3. Kambi 4-segment path + new sports entries (table tennis, cricket, darts,
   rugby, aussie rules, volleyball, golf H2H, ITF tennis).
4. Combat lane: MMA/boxing from Pinnacle + Bovada + Kambi + DK 9034 (market
   name mappings: "Fight Winner", "To Win the Bout", "Total Rounds").
5. Ops matrix section for the event lane.

### Phase 3: cadence (approach the 60s bar)
1. Parallelize adapters per-book (full sweep ~40s, zero politeness cost).
2. Hot/cold split: cold full sweep every 5 min; hot loop every 60-90s hitting
   ONLY the one-call league boards (Kambi, DK nash, FD page, Pinnacle) filtered
   to games starting within ~90 min, small relay POSTs. Precedent already in
   index.js (high-frequency sync for games within 60 min + in-flight guards).
3. Props pass weighted to the pre-lock window (boards hang on game day).

### Phase 4: the products no one gives away free
1. Closing-line archive as a product surface: the lock already freezes closes
   in book_lines; add timestamped daily snapshots (book, game, close) and a
   query endpoint. The Odds API charges 10x credits for exactly this.
2. CA consensus line (the Unabated-Line clone): no-vig blend across 14 books
   with Pinnacle as the sharp anchor; store per game; show on the detail page
   and use for CLV in capper grading. Trivial math once Phase 1 lands.
3. Public-market lane tightening: Polymarket + Kalshi pollers already exist;
   exchange odds move fastest (the paid APIs refresh exchanges at 10-20s), so
   put them on the hot loop. Novig GraphQL as a later small add.

### Explicit non-goals (for now)
- Live in-play odds: a separate project with real risk (grading/PL contamination;
  see the live-line-gap audit). The lock-at-start rule stays authoritative;
  any future live lane must be a separate display-only pipeline (is_live flag),
  never book_lines.
- Blocked offshore books (BetUS, MyBookie, Stake, etc.): re-probe quarterly,
  do not build headless-browser workarounds.
- 500-league soccer breadth and futures markets: futures need their own table
  and product story; park both.

## 5. What this buys, in market terms

After Phases 0-2: 14 books, player props from 4+ books, alternates + team
totals + period markets, esports (2 sources), MMA/boxing/cricket/table tennis/
golf H2H, all at 5-min cadence. That is feature-parity with SportsGameOdds'
$299/mo tier (minus live in-play), with sharper sources than The Odds API's
$119/mo tier, at $0/mo.
After Phase 3: pre-match cadence competitive with The Odds API's fixed 60s.
After Phase 4: two features (closing archive, no-vig consensus) that only
$3k-5k/mo products ship today, plus the exchange lane nobody else has direct.

## Appendix: probe artifacts

Raw payloads + probe scripts from the research session live in the session
scratchpad (probe_lib.js, p1_an_books.js .. p12_final.js, raw/). Endpoint
patterns, headers, and keys referenced are the ones already in
scripts/odds_engine.js and scripts/odds_adapters.js.
