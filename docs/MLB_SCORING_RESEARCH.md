# MLB Scoring Rework Research (2026-07-23)

Why MLB is the worst sport in the v4 Wilson engine, what the data and the literature say, and the candidate fixes with a 21-day no-lookahead backtest. Data: fresh server pull 2026-07-23 (576 cappers, 14,712 graded rows, 1,750 archive picks) + /api/mvp/public (516 tracked picks).

## 1. The damage (tracked gold record)

| Sport, last 21 days | n | Record | Win% | Flat 1u P/L |
|---|---|---|---|---|
| **MLB** | 163 | 77-83-3 | **48.1** | **-18.8u** |
| WNBA | 91 | 55-35-1 | 61.1 | +10.5u |
| ATP | 65 | 37-26-2 | 58.7 | -2.2u |
| WTA | 49 | 34-15-0 | 69.4 | +3.9u |
| Soccer | 9 | 8-1-0 | 88.9 | +6.7u |

Every non-MLB sport combined: ~63.5% win rate, +19u. MLB is the only bleeding sport, and it is also the volume hog: 24, 25, 10, 32, 25 tracked picks on Jul 18-22 (avg 11.3/day, peak 32).

## 2. Root cause findings (internal data)

**F1. The score does not discriminate inside MLB.** MLB golds scored 140+ win 53.3%; non-MLB golds scored 100-119 win 65.0%. The strongest MLB score bucket is weaker than the weakest non-MLB bucket. Raising the bar or capping by score cannot fix MLB (verified: daily top-5 by score = 41.7%, bar at 120 = 51.2%).

**F2. Source mix: MLB is fed only by the weak sources.** Last 21d graded capper picks in MLB: Covers 2,454 at 47.7%, ActionNetwork 1,196 at 48.8%, Discord 465 at 49.3%. Polymarket wallets, the best source (56.9% in other sports), have ZERO MLB picks all-time (7,603 picks: WNBA/ATP/WTA only; the gamma market map never covered MLB).

**F3. Overall Wilson rank transfers poorly to MLB, and real MLB skill exists but is drowned out.**
- Overall-ranked (pts>0) cappers: 61.7% outside MLB, 55.1% inside MLB.
- Backers with a proven MLB record (15+ MLB decisions, 55%+ MLB win rate): 291-190 (60.5%, +71.1u) on MLB last 21d.
- Everyone else backing MLB: 46-49% across ~3,500 picks. The overall pool ladder hands these cappers full points on MLB picks anyway.

**F4. Consensus stacking is inverted in MLB.** MLB golds by mention count last 21d: 3-5 mentions 44.7%, 6-9 51.4%, 10+ 43.9%. Non-MLB: 1-2 mentions 68.5%, 3-5 66.2%, 10+ 48.4%. With 15 MLB games/day and a flood of mediocre Covers/AN backers, the half-peak stack turns crowd noise into gold mints. Heavy stacking is mildly bad everywhere; in MLB it is the primary mint path.

**F5. Bet-type splits (21d, tracked):** ML 43-44-3 (-10.5u), under 26-21 (+2.6u), over 6-13 (-7.7u), spread 2-5 (-3.2u). Within ML: big favorites (-150 or shorter) 12-5, other favorites 27-32-3, dogs 4-7.

## 3. External research (web, 2026-07-23)

Full agent report in session; highlights with the strongest sourcing:

- MLB closing lines have tested efficient across four decades of studies (Woodland & Woodland 1994; Paul et al. JSE; 88k-game 1977-2018 study). CA locks at T-60, near-close, so MLB picks are graded against an essentially efficient price.
- MLB and NHL are the two most random major sports at single-game level (Lopez, Matthews & Baumer, Annals of Applied Statistics 2018). A capper's MLB record carries less skill signal per decision than any other sport we track.
- Tipster persistence is ~zero: Pyckio million-bet analysis indistinguishable from chance; elite +6.7%-yield tipsters went -2.2% on their next 3,687 tips (past-to-future yield correlation 0.00077). 500-1,000 bets is the literature's skill/luck separation threshold.
- MLB totals are publicly shaded to the over (public on the over in 75.8% of games since 2005); public-backed overs lost -103u across ~6,900 games; over bets with the total moving DOWN ran -16.2% ROI. Unders only paid at contrarian extremes.
- Reverse favorite-longshot bias in MLB (favorites overbet), but it largely vanishes by close.
- Crowd aggregation literature: majority agreement adds value, weighting individuals by past accuracy does not (Oddsportal 68k-event study). Volume-without-edge portfolios regress; commercial products (BetQL, Rithmm) gate on minimum edge vs the market price, and Action Network ranks experts per sport, never cross-sport.

The literature's verdict matches the data: the system mints MLB golds where no edge exists, priced by a near-efficient market, backed by sources with no persistent MLB skill.

## 4. 21-day backtest (no lookahead)

Gate variants applied to the 216 resolved MLB archive golds (score 100+), with each backer's MLB record computed only from picks graded strictly before each game date:

| Variant | n | Record | Win% | P/L | Avg/day (peak) |
|---|---|---|---|---|---|
| Baseline: all MLB golds | 216 | 99-110-7 | 47.4 | -23.6u | 14.4 (44) |
| Any proven-MLB backer 15dec/55% | 192 | 90-96-6 | 48.4 | -18.3u | 13.7 (41) |
| + ML+under only | 154 | 79-70-5 | 53.0 | -2.3u | 11.0 (32) |
| Proven 20dec/57% + ML+under only | 131 | 72-56-3 | **56.3** | **+5.9u** | 9.4 (25) |
| Proven 15/55 + ML+under + mentions<=9 | 75 | 43-31-1 | **58.1** | **+6.0u** | 5.4 (16) |

Notes:
- The 15dec/55% raw bar decays without lookahead (small-sample hot streaks qualify early, then regress). The stricter 20dec/57% bar holds. Shrinkage or a higher bar is required, exactly as the literature predicts.
- With today's (lookahead) ratings the same gates showed 54.5-64.4%, so treat ~56-58% as the honest replay number and expect forward reality lower still. The promise of this rework is not "MLB wins 58%"; it is "stop minting 14/day of coin-flip golds against an efficient market."
- Tested and REJECTED: daily top-N by score (41.7%, because high MLB scores = biggest swarms = worst picks), gold bar raise alone (51.2%), mention cap alone (50.5%).

## 5. Proposed fixes (menu)

### Core pack (recommended)

**Fix 1: MLB in-sport ladder.** For MLB picks, a backer's ladder points come from their MLB-scope record, not the overall pool: fewer than ~20 MLB decisions = flat UNRANKED 10 regardless of overall band; break-even gate runs on the MLB shrunk win% (existing gateT machinery pointed at the sport:MLB row). Injection points: materialize per-sport pts/stack_add in the capper_ratings.js sport-pool loop (lines ~322-340), read them in scoring_v3.js backerLadder/backerAggregate for MLB picks. Config as a settings-keyed sport set (e.g. v3_insport_sports = ["MLB"]) so NHL etc. can join later.

**Fix 2: MLB stack tightening.** Only MLB-qualified backers contribute stack on MLB picks, and the stack halves again (quarter-peak) for MLB. Kills the Covers-swarm mint path (F4). Lands in backerAggregate (scoring_v3.js ~235-256).

**Fix 3: MLB overs blocked from gold.** Extend the existing totals gate: MLB over picks cannot reach gold (silver styling still possible). Unders unaffected. Internal 6-13 plus the strongest external totals finding. Lands next to totalsGateOk (scoring_v3.js ~337-342).

Expected combined effect on the last 21 days: from 47.4% / -23.6u / 14.4 per day to roughly 56-58% / +6u / 5-9 per day.

### Optional add-ons

**Fix 4: market-move confirmation for MLB (phase 2).** Award MLB market-signal points (or require for gold) only when the line has moved toward the pick since the line_history opening capture. Strongest external evidence (CLV literature; +20% vs -16.2% ROI split by move direction); untested internally because per-pick open-vs-lock data needs assembly. Infrastructure exists.

**Fix 5: per-sport empirical-Bayes shrinkage in ratings.** Fit sport-pool priors so MLB records shrink hardest before the Wilson step. More principled version of Fix 1's decision floor; medium effort; can replace the raw bars later.

**Fix 6 (separate track): add MLB to the Polymarket wallet market map** so the one strong source can feed MLB at all (polymarket_wallets.js gamma sport tags).

### Explicitly not proposed
- Daily top-N by score, MLB gold bar raise alone, mention-count display cap: all tested worse or no better than baseline (Section 4). The score axis itself is what Fixes 1-2 repair.

## 6. Touch list once fixes are picked

- src/capper_ratings.js: per-sport pts/stack_add materialization + MLB decision floor/gate constants.
- src/scoring_v3.js: sport-aware backerLadder/backerAggregate, MLB over gold-gate, breakdown JSON gains an mlb_scoped flag per component (so surfaces can label it).
- src/admin.js: Today's Picks component table (~373-401) + compact breakdown string (~486-495) label MLB-scoped backer/stack rows; capper-detail sport tooltip (~3237, 3248); leaderboard MLB-qualified indication.
- scripts/backtest_scoring.js: mirror every MLB lever (the replay is a fork of the engine) + per-sport reporting.
- docs/CA_ALGORITHM_V3.md v4 section + docs/ALGO_PLAYBOOK.html + Desktop copy + artifact republish (hard rule).
- Conviction curve (pick_timeline.js) follows automatically via computeV3 helpers; reveal components unchanged.
- No public copy changes (proprietary engine rule).

## 7. Round 2 analyses (2026-07-23, after Jack's review)

### 7a. Totals threshold gate (Jack's Fix 3 variant): tested, does not work
"Hold MLB totals unless a backer's record crosses 50%": every form tested passes the LOSERS. MLB totals golds 21d baseline 47-55 (46.1%). No-lookahead gate results (PASS = would go gold, HELD = blocked):

| Gate form | PASS record | HELD record |
|---|---|---|
| any backer totals 10+dec >50% | 45-53 (45.9) | 2-2 |
| best totals backer shrunk >55 | 25-35 (41.7) | 22-20 (52.4) |
| any backer totals 15+dec raw >55% | 35-43 (44.9) | 12-12 |
| Fix1-qualified backer + totals shrunk >50 | 27-34 (44.3) | 20-21 (48.8) |

Backer totals records carry zero-to-negative signal for MLB totals (the qualified backers' overs still went 7-16). Consistent with the external finding that MLB totals are weather/umpire/pitcher specialist markets these sources don't actually handicap. Alternatives: hard-hold all MLB totals from gold, unders-only eligibility, or a MARKET-implied threshold (only track the side the no-vig market itself leans past 50%, ca_consensus/book_lines_closing data exists server-side) which belongs to the Fix 4 family and is testable in phase 2.

### 7b. Contested adjacent picks (both sides of same market scored, 21d archive)
Higher-scored side's record by score gap:

| Gap | MLB | Non-MLB |
|---|---|---|
| 0-10 pts | 15-16 (48.4) | 17-10 (63.0) |
| 11-25 | 20-16 (55.6) | 22-18 (55.0) |
| 26-50 | 30-18 (62.5) | 20-10 (66.7) |
| 51+ | 28-25 (52.8) | 29-27 (51.8) |

In MLB a tight contest (gap <= 10) makes the leader a coin flip; moderate gaps are the healthiest zone; huge gaps sag again because those are the swarm games. Both-sides-gold: MLB hi side 22-17, non-MLB 19-22. Samples are small (n 27-56 per bucket); treat as a monitoring surface (show contested pairs in admin), not a shipped scoring lever yet.

## 8. Open questions for Jack

1. Which fixes ship? (Recommended: core pack 1-3, then Fix 4 as phase 2, Fix 6 as a separate task.)
2. Retroactive record: should the past 21 days of tracked MLB golds be regraded/rewritten under the new rules (removing ~85-140 picks from the public record), or do the rules apply forward only? Rewriting the public tracked record is reversible only via backup and changes what visitors have already seen; forward-only keeps the record honest to what was displayed.
3. MLB qualification bar: 20 decisions is defensible today but only 13 cappers currently clear 20dec/57%. A shrunk-win% bar (Fix 5 style) is the better long-term form.
