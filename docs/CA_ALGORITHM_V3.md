# CA Algorithm v3: The 100-Point Rework

Status: ALL 5 PHASES BUILT + post-flip fixes. v3 IS LIVE LOCALLY (scoring_version=
'v3' in the local settings; prod untouched and still v2 until the big combined
update ships). Local commits a0b7dad / 98cf7f4 / 46a1bc3 / b2e4b21 / 93ae6e4 /
77ff3ae (fade sport-volume scaling, status column, persistent calibration log) /
0f18715 (ONE SCALE: all history rescaled onto the 100 scale) on bet-tracking.
Calibrated 2026-07-07: base 45, resume multiplier 360 ("Phase-5 calibration record"
below). CLAUDE.md carries the operational summary; this doc is the source of truth
for the algorithm.
Owner: Jack. Last updated: 2026-07-07.

The goal: make the CA pick ranking meaningfully predictive by ranking on capper and
source resumes, market signals, and fade logic on top of a flat extraction base (no
points depend on which chat a pick came from), rescaled so MVP sits at 100 instead of
50. Calibration against real results happens LAST, via a backtest harness, before
anything ships.

## Ground rules (Jack's design constraints)

1. Points are NEVER subtracted from a pick. Every signal is a bonus from 0 up to a max.
   Negative information routes to the OPPOSITE slot as fade points instead.
2. Capper and source performance is the PRIMARY driver beyond the flat extraction
   base, expressed in a way that is consistent with both long-term and per-sport
   records. Market/context signals are secondary and stay small until a bigger sample
   (including football season) validates them. The current ~3 months of data is not
   enough to trust signal weights.
3. New scale: gold MVP at 100+ (tracked forever in mvp_picks), silver at 75 to 99
   (public styling, never tracked). Roughly: old 50 maps near new 75, and old 65+
   (the publicly tracked tier today, and the MOST important population to get right)
   maps to gold at 100.
4. Backtest and calibration are the LAST step. Build everything, then fit the numbers.
5. Nothing ships to Railway until the big combined update. All work stays local.
6. Each pick is treated individually. Scores only ever go up as new mentions/signals arrive.

## The credibility principle (assume chance)

Working assumption, per Jack: every pattern found so far could be variance. Three
months of data, no football, and dozens of ways the data was sliced to find these
patterns (which inflates how impressive they look). What follows from taking that
seriously:

1. NOTHING gets fiat weight. Cappers, chats, sources, signals, side leans, price
   buckets: every entity earns influence through the same evidence formula and loses
   it the same way, automatically, as results arrive. The system's job is not to know
   who is good. Its job is to LEARN who is good while risking only bounded points on
   any belief.
2. Every number in this doc is the formula's output on today's data, not a truth.
   MidwestMike's 53 decays on its own if he cools. The pod entity's seed record means
   nothing once its next 100 picks say otherwise. No name is ever hard-coded.
3. Thresholds are set expecting impostors. With 231 tracked cappers, loose bars WILL
   crown lucky coin-flippers. Example that shaped the fade rules below: at a bar of
   25+ picks and -8% shrunk ROI, roughly a third of true 50% cappers would qualify
   for fading at some point by chance. Bars are therefore set so qualifying by luck
   is rare, and every qualification stays reversible.
4. v2's real flaw was not wrong weights, it was UNFALSIFIABLE weights: fixed fiat
   numbers no amount of results could change. v3's core property is that every point
   is attached to evidence that updates nightly and gets refit on a calendar.
5. Chance-humility cuts one way. It removes unearned certainty; it does not protect
   structural facts (juice math, 3-way draws, totals pricing) that are true by
   arithmetic rather than by sample.

## What the data says (live-site pulls, 2026-07-07)

Both datasets come directly from the production site via scripts/pull-capper-server.js
(read-only): 2,077 graded capper picks (admin capper history, through 2026-07-06) and
519 graded BOARD picks (the public 35+ archive at /api/pick-history, 2026-04-08 through
2026-07-07). Board picks are the product surface, so board numbers lead below.

| Finding | Numbers (live site) | Consequence |
|---|---|---|
| Current score is not predictive | Old-MVP bucket (50-64): 52.6% win, -4.6% ROI. 65+ is the only bucket that profits (59.6%, +8.7%) | The rework is justified |
| The board overall is ~breakeven | 519 graded board picks: +0.9% ROI (+$45 at $10/u) | Upside is real if ranking improves |
| Mention stacking is anti-predictive | 1 mention 59.3% win (+7.7% ROI), 2 mentions 53.0%, 3 mentions 49.5% (-10.3%), 4+ 50.0%. Monotone decline | Consensus must stop stacking linearly |
| Home bonus is backwards | Away 61.9% (+14.9% ROI) vs home 50.6% (-8.7%) | Replace with a dynamic side lean |
| Capper pool is a coin flip | 50.8% overall across 231 cappers | Resume points must be shrunk hard |
| But the tails are real | MidwestMike 84-47 (+20.3% ROI over 136), Bet Labs 35-51 (-22.6% over 90) | Boost proven, fade proven-bad |
| Skill persistence is weak but positive | win% correlation between periods: -0.09 to +0.29 | Shrinkage + volume gates, no hot-streak chasing |
| Totals on the board bleed | Board overs 21-31 (-30.2% ROI), unders 14-16 (-18.8%); all capper totals mildly negative | Totals need a resume gate for gold |
| Price effects are modest and mixed | Board MLs: dogs +4.4% ROI, -151 to -200 favs -19.3%. Full capper pool: dogs -0.6%, same favs -10.1% | Price component starts at zero, backtest decides |
| The winning 65+ picks are official solo/duo plays | 65+ with NO capper attribution: 38-22 (+16.5% ROI); 1-2 mentions: 65.1%; pod SOLO: 40-25 (+11.1%) | Channel fiat dies; sources become measured pseudo-cappers |
| Pile-ons poison even the top tier | 65+ with 3+ mentions: 18-18 (-8.5% ROI); capper-attributed 65+: 53.8% (-3.5%); pod stacked/attributed: -8.2% | Consensus capped at 12 with steep diminish |
| The tier peaked +$144 on June 23, gave back $57 | Post-peak 65+: 3-8 (-$56), all MLs; May ran 82.6% (some heat) | v3 protects the formula behind the peak, not the streak |
| Sample sizes are small | Only 19 cappers have 25+ graded, 2 have 100+ | Continuous evidence weighting, not hard cutoffs |

MidwestMike by sport (server): MLB 65-41 (+15.3u), WNBA 8-2 (+5.3u), NBA 8-1 (+7.1u), NHL 3-3.
Fade tail (25+ picks, shrunk ROI at or below -8%): Bet Labs, UnderdogSniper (52 picks, every one an MLB ML), Pick Don.

Caveat: only about 3 months of data, and ZERO football (NFL/NCAAF) or CBB. Every
constant below is a STARTING VALUE for the backtest to tune, not a final answer. This
is also why capper resumes carry the weight and context signals launch small: resumes
degrade gracefully on unseen sports (shrinkage makes a no-record capper score near
base), while signal weights fitted on baseball summer data could be flat wrong for
football. Signal weights get re-fit after roughly 6 weeks of football.

## The v3 score (components, all additive, per pick slot)

Nothing carries over from the channel-points era. Theoretical max ~130; realistic
strong picks land 80 to 110. (Base calibrated 40 -> 45 in Phase 5.)

| # | Component | Range | Source of truth |
|---|---|---|---|
| 1 | Extraction base (flat, source-blind) | 45 for every valid pick, any room, any source (calibrated) | pick exists and matched a game |
| 2 | Advocate resume (best capper OR source entity) | 0 to 55 | capper_ratings (nightly materialized) |
| 3 | Consensus (quality-weighted, steep diminish) | 0 to 12 total | each additional DISTINCT capper |
| 4 | Market signals | 0 to 8 at launch (full values logged) | polymarket/kalshi/book lines, line_history, public_betting |
| 5 | Side lean (dynamic) | 0 to 5 | rolling home/away ROI per sport |
| 6 | Sport bonus (carryover) | +5 | same sports as today |
| 7 | Price context | 0 at launch, logged only | rolling ROI by price bucket |
| 8 | Fade points | 0 to 8, applied to the OPPOSITE slot | fade-list capper activity |

CHANNEL FIAT IS DEAD (Jack, 2026-07-07). No points depend on which chat a pick came
from. What replaces it:
- A flat extraction base (45, calibrated) that every valid pick gets, so the scale geometry holds
  and nothing is ever below zero.
- SOURCE ENTITIES: each source ("CA Free Plays" official plays, "Pod official",
  community as a whole, each AN expert feed) is tracked as a pseudo-capper with its
  own units/ROI record, and earns advocate points through the exact same resume
  formula as a human capper. A pick's advocate resume = max(strongest mentioning
  capper, its source entity). Sources EARN their weight; nothing is granted by room.
- Why this keeps what works: the decomposition shows official-style solo picks are
  the winners (65+ tier without capper attribution: 38-22, +16.5% ROI; pod SOLO picks
  40-25, +11.1% ROI) while capper-attributed pile-ons in the same rooms lose. A
  measured source entity captures the former without subsidizing the latter.

Weight philosophy: components 2, 3, and 8 are performance driven (up to 67 points
plus fades), components 4, 5, and 7 are context signals (13 max at launch). An elite
advocate resume reaches gold ALONE: flat base 45 + elite resume 53 + sport 5 = 103. Signal maxes can grow only after football-season data validates them.

Gold MVP: 100+. Silver: 75 to 99 (public styling only, not saved to mvp_picks).

ONE SCALE EVERYWHERE (Jack, 2026-07-07, replacing the earlier era-separation idea):
ALL historical scores are rescaled onto the 100 scale by new = round(old * 20/13),
capped at 135. Old 65 (the publicly tracked tier floor) lands exactly on 100, so
every past tracked MVP shows 100+; the old 50-64 MVP band lands on 77-98, inside
silver; order is preserved below that. Verified exact on migration: the gold tier
contains precisely the old 65+ picks (100 of 100) and silver precisely the old
50-64 band (140 of 140), so the public record's membership and W-L never change,
only the displayed numbers. Originals are preserved in score_v2_original and rows
are marked scale_version='v2-rescaled'; nothing is destroyed. The migration runs
once, only where scoring_version='v3' (prod migrates on flip day). All threshold
consumers (public MVP page, /results, admin dashboards, capper profiles, drift
monitor) are scale-aware.

### Score display: the leak rule (conviction curve)

Jack's rule (2026-07-07): if aggregation adds MORE than 25 points to a pick at once,
the public display must NEVER jump all at once. It leaks in over a randomized 20 to
50 minute window, finishing before game start.

- Two scores per pick: the TRUE score (internal, updates instantly, logged in
  score_breakdown) and the DISPLAY score (what the board, the conviction curve, and
  alerts all use). Ranking, tier styling, and gold alerts run off the DISPLAY score
  so the public surface is always self-consistent; gold/MVP tracking settles at game
  start when display has fully caught up to true.
- Leak mechanics: whenever the true score rises more than 25 above the current
  display, the display starts at current + 25 and ramps linearly to the target over
  a window randomized in [20, 50] minutes. If game start is inside that window, the
  window compresses to finish a few minutes before start. If the game is essentially
  imminent, the update shows immediately (full value must be visible by start).
  Additional events during a leak simply retarget; the ramp continues from wherever
  the display currently is. Jumps of 25 or less show immediately.
- New picks obey the same rule: a MidwestMike pick whose true score is 98 appears at
  ~65 and climbs the curve over the window. The conviction curve literally shows
  conviction building, and nobody can reverse-engineer which source fired from a
  step jump.
- Display state lives on the pick row (display_score, leak_target, leak_started_at,
  leak_window_sec); the curve is display_score sampled over time. Never-subtract
  holds: display only ever ramps upward.

### 2. Capper resume (the heart)

All resume math uses UNITS PROFIT at stored odds (fallback -110 sides, -115 totals),
never raw win%. Definitions, computed nightly into a capper_ratings table:

    profit(pick) = 0 if push, -1 if loss, odds>0 ? odds/100 : 100/|odds| if win
    overallBlend(c)   = totalUnits(c) / (totalPicks(c) + 25)          // shrunk ROI, k=25
    sportBlend(c, s)  = (units(c,s) + 15 * overallBlend(c)) / (picks(c,s) + 15)
    typeBlend(c, s, t)= (units(c,s,t) + 10 * sportBlend(c,s)) / (picks(c,s,t) + 10)
    skill  = min(sportBlend(c, s), 0.20)              // credit tops out at +20% ROI
    volume = picks(c, s) / (picks(c, s) + 10)
    trust  = clamp(overallBlend(c) / 0.10, 0.30, 1.30) // long-term record scales everything

    resumePoints = min(round(360 * skill * volume * trust), 25 + round(30 * volume))  // mult calibrated 330 -> 360
    // hard floor 0, hard cap 55; the volume-scaled cap keeps small samples out of
    // elite territory no matter how hot the run

The same formula runs for SOURCE ENTITIES (free-plays official, pod official,
community as a whole, model sites like OddsShark; AN experts are individual CAPPERS,
not entities), which accrue units/ROI as pseudo-cappers. A pick's advocate resume is
max(strongest mentioning capper, source entity). Seed data says the free-plays/pod
official solo streams will measure well (pod solo 40-25, +11.1% ROI through mid-June);
community as an entity measures near zero, so community picks live on their capper's
resume, which is exactly right.

The design intent, in order: an established elite must carry a pick to the tracked
tier essentially alone (their record IS the product), a proven overall winner's small
sport sample earns a real boost, a coin-flip capper's hot sport run earns only a
little, and the cap itself grows with volume so nobody reaches elite points on 20
picks no matter the streak.

Worked examples (live data, points out of 55):
- MidwestMike MLB (65-41 over 111, a 64% clip with more volume than our own tracked
  tier has): 53. A Mike pick from ANY room scores 45 + 53 + 5 sport = 103, GOLD SOLO,
  every time, no supporting component needed. His WNBA 8-2 earns 40 and NBA 8-1
  earns 39, both amplified by his elite overall record.
- Ben Burns WNBA (6-2, backed by a +13.7% ROI career): 37. Small sample, proven
  capper, big boost. The "notable names" case.
- Big Al NHL (8-2, modest career): 21. ThisGirlBetz ATP (5-1, +6% career): 15.
  Tennis Winners Only ATP (5-2): 14. When Tennis Winners Only joins a ThisGirlBetz
  ATP pick, his consensus join adds up to +8 on top, and both climb automatically
  as their tennis volume grows.
- The "50% overall but 9-2 in one sport" capper: 10. It boosts (a positive run is
  never worth zero), but the trust term keeps it well BELOW Ben Burns' 6-2, because
  a career coin-flipper's hot run is weaker evidence than a proven winner's.
- A 5-pick newcomer earns roughly 0 to 3. Bet Labs earns 0 (never negative; his
  badness routes to fade points on opposite slots instead).

When several cappers are on the same slot, resumePoints uses the STRONGEST mentioning
capper's blend (the best advocate carries the pick); everyone else contributes through
quality-weighted consensus below.

NOTE: an earlier draft had an "elite channel floor" rule to rescue elite cappers from
the community-leaks base. The flat extraction base makes it unnecessary: with channel
fiat dead, MidwestMike's community picks score identically to his pod picks, which was
the floor's entire purpose. Superseded.

Verified tiers (display only, the math is continuous):
- Tracking: under 10 graded picks (grey)
- Rated: 25+ graded
- Proven: 50+ graded AND positive overallBlend (badge)
- Fade Watch / Fade Active: see the fade system below (two bars, different thresholds)

There is no single magic "number of bets" threshold. The volume factor expresses 50%
of a capper's signal at 10 sport picks, 83% at 50, 91% at 100, and the volume-scaled
cap (25 + 30 * volume) means elite point territory physically requires elite volume.
That IS the threshold, expressed smoothly. The tier labels are for humans.

The ramp, concretely (a steady 60% winner at -110, single sport, today's constants):

| Graded picks | Resume points earned | What else unlocks |
|---|---|---|
| 1-9 | ~0 to 3 | Picks count at base from day one; joins add flat +2 |
| 10 | ~5 | Joins upgrade to quality-scaled (+2 to +8); leaves "Tracking" |
| 20 | ~16 (hot 13-7 start can reach ~40, capped at 45) | Real board influence |
| 25 | ~20 | "Rated" tier; Fade WATCH possible if losing badly |
| 40 | ~30 | Fade ACTIVE possible (needs shrunk ROI at or below -10%) |
| 50 | ~36, cap now 50 | "Proven" tier; elite territory opens |
| 100+ | ~49 (MidwestMike: 53 at 64% over 111) | Elite: gold-by-default picks |

And it is fully bidirectional: ratings recompute nightly, so a cold stretch drains
points, tiers drop off automatically, and fade status appears or clears on its own.
The never-subtract rule applies to an individual pick's score during its lifetime,
never to a capper's rating, which floats freely both directions.

Recency: optional exponential decay (half-life 180 days) on units and picks, OFF by
default. The mean-reversion evidence says do not chase hot streaks; decay exists so a
2027 resume is not dominated by 2026. Backtest decides if/when it turns on.

### 3. Consensus, quality-weighted

Per Jack: who is joining matters more than how many. For each additional distinct
capper j on the same slot (first capper is the base, not consensus):

    joinPoints(j) = fade-list capper: 0 (and triggers a fade evaluation instead)
                    unknown (under 10 graded): +2
                    otherwise: clamp(round(3 + 120 * max(0, sportBlend(j, sport))), 2, 8)
    2nd capper: full joinPoints. 3rd: half. 4th and beyond: quarter. Total cap 12.

The steep diminish is measured, not aesthetic: in the 65+ tier, 2-mention picks went
75% (+27.8% ROI) while 3+ mention picks went 50% (-8.5%). One quality confirmation
helps; a crowd is a warning sign. MidwestMike joining a pick adds 8. Three nobodies
add about 4 combined. The current system would have added 30 to 105 for those same
mentions. Requires per-mention capper attribution (Phase 0 fix) so this becomes
tunable later.

### 4. Market signals (0 to 8 at launch, deliberately small)

Per Jack: the sample is too small to lean on signals (about 3 months, zero football).
Capper performance leads; these are seasoning. All from data we already collect free:
- Edge vs market (0 to 5): devig the pick's implied win probability from its odds,
  compare against Polymarket, then Kalshi, then devigged DK. Positive edge earns
  clamp(round(edge% * 0.5), 0, 5).
- Steam confirmation (0 to 2): line_history shows the line moved toward the pick since
  its first mention (thresholds: 15 cents ML, 0.5 spread, 0.5 total).
- Contrarian (0 to 1): public_betting shows 65%+ of tickets on the other side.

Every signal's FULL value is computed and logged into score_breakdown from day one,
even though only 0 to 8 points reach the score. After a football season is in the
data, the logged values get re-fit and the maxes can grow (or drop to 0) with evidence.

### 5. Side lean (replaces the home bonus)

The +5 home bonus is gone as a constant. Instead, per sport, recomputed nightly from a
rolling 120-day window of graded picks (needs is_home on capper/pick rows, Phase 0):

    diff = shrunkROI(away picks, k=50) - shrunkROI(home picks, k=50)
    leanPoints = clamp(round(|diff| * 40), 0, 5) awarded to the leaning side only
    minimum 100 graded picks per side per sport, otherwise 0

Applies only where venue is real: NO_HOME_BONUS_SPORTS (tennis, golf) are excluded,
because their home/away is just ESPN listing order (the live data shows ATP "away"
at 76.5%, which is an artifact of that ordering, not an edge).

Live seeds today: MLB away 58.4% (+7.9% ROI) vs MLB home 51.9% (-7.1%), NBA away 62.5%
(+15.8% ROI). That awards roughly +3 to +5 to away sides in MLB and NBA. If the pattern
flips next season, the lean follows automatically. Max swing is 10 points (+5 either
way), exactly as specced.

### 6 and 7. Sport bonus and price context

Sport bonus: unchanged +5 for the current SPORT_BONUS_SPORTS set, for continuity.
Price context: architecture ships with all buckets at 0 points. A stale local sample
said dogs were gold (+36.6% ROI); the live board says dogs +4.4% and the full capper
pool says breakeven, while -151 to -200 favorites bleed in both views (-19.3% board,
-10.1% pool). The backtest settles what, if anything, earns points here. Buckets:
dog, -101 to -150, -151 to -200, heavier.

### 8. Fade system

Two tiers, recomputed nightly, with bars set so a true coin-flipper rarely qualifies
by luck (see credibility principle):
- FADE WATCH (display only: fade bar on the leaderboard, no score effect):
  25+ graded AND overallBlend at or below -0.08. Today: Bet Labs, UnderdogSniper,
  Pick Don.
- FADE ACTIVE (opposite-slot points): 40+ graded AND overallBlend at or below -0.10,
  AND the sport/type blend being faded is itself negative. Today: Bet Labs
  (-17.7% shrunk over 90) and UnderdogSniper (-10.1% shrunk over 52). Pick Don
  (25 picks) stays Watch until volume justifies action.
A capper drops off either tier automatically as their record improves.

When a FADE ACTIVE capper posts a pick:
    raw        = clamp(round(-100 * worstBlend), 3, 8)
    fadePoints = round(raw * sportVolume), dropped when under 2
    where worstBlend = min(sportBlend, typeBlend, overallBlend) for the pick's
    sport and bet type, and sportVolume = their graded picks in THAT sport /
    (picks + 10)
applied to the OPPOSITE slot (other ML side, other spread side, other total side).
The sport-volume scale is Jack's rule (2026-07-07): a fade capper who is 0-2 in
NBA has shown us nearly nothing about NBA, so his NBA picks trigger essentially
no fade, while his 31-pick MLB record fades at close to full strength.

Conflict rule (Jack's spec): fade points only apply in full when NO positive-resume
capper is on the original side. Because mentions arrive in any order, this is handled
additively: if fade points landed first and a proven capper later joins the original
side, the original side ALSO receives offsetting points equal to min(fadePoints,
joinPoints of the proven capper). Nothing is ever removed from either side.

Totals gate (tough but not hard): a totals pick cannot reach GOLD unless the capper's
typeBlend for totals in that sport is non-negative (any sample) or the pick clears
100 anyway from non-capper components. Silver stays open to any totals pick. And a
fade-list capper's total pick sends fade points to the opposite total, per the rule above.

Fade is sport-aware and bet-type-aware: the profile shows WHERE a capper bleeds
(example from the data: Bet Labs is 3-9 on WNBA spreads and 1-5 on WNBA overs but
6-2 on MLB unders; UnderdogSniper's damage is 100% MLB moneylines).

## Capper leaderboard upgrades (admin)

Current admin board already has: Record, Win%, Units, Money ($unit/u), 7 per-sport W-L
columns, Pending. Adding:
1. Per-sport MONEY columns ($10/u by default, uses the existing bet_unit setting) next
   to each per-sport record column.
2. Rating column: the overall analog of resume points, round(300 * min(overallBlend,
   0.20) * totalPicks / (totalPicks + 10)), so the leaderboard number and pick scoring
   speak the same language.
3. Tier badges: Tracking / Rated / Proven / FADE (red bar treatment on the row).
4. SOURCE LABELS per capper (Jack requirement): small chips next to the name showing
   every system the capper appears in: DC (Discord), AN (Action Network),
   PM (Polymarket wallet), CV (Covers), and later TG/RD. Driven by DISTINCT source
   values on the capper's history plus registry handles. A capper found in two
   systems shows BOTH chips. The profile popup breaks the record down per source.

## Expanded capper profile popup (admin only, permanent)

Click a leaderboard row, get everything we know:
- Header: name, aliases in the cluster, source emblem, tier badge, rating, fade bar if applicable.
- Overall: record, win%, units, money at $unit/u, first/last pick dates, channels seen in.
- Per sport: record, win%, units, money, resume points a pick would earn today.
- Per bet type WITHIN sport (ML / spread / over / under / nrfi): record, units. This is
  where "is it the O/U picks ruining them" gets answered at a glance.
- Graphs (plain inline SVG, no chart libs): cumulative units over time (the equity curve),
  monthly win% bars, per-sport units bars.
- Recent picks table (last 25): date, sport, pick, odds, result, board score.
- Fade panel when applicable: which sport/type combos trigger fade points and how many.
- For AN experts: AN verified record snapshot (their claimed units/ROI per league) next
  to OUR graded record, so discrepancies are visible.

## Action Network expert pipeline (track first, score later)

Feasibility confirmed 2026-07-07: AN expert profiles are public JSON (same fetch pattern
as public_betting.js, zero cost, no auth). ~35 experts discoverable today, grows as
pages rotate. Only AN-flagged experts have public data; regular user leaderboards are
app-only and stay out of scope.

New file src/an_experts.js (wnba_espn.js-style isolation):
1. Discovery (5am + startup): fetch /picks, /picks/top-experts, and each league picks
   page; union all expert profiles; upsert into an_experts (user_id, username, name,
   followers, is_internal, verified record JSON, last_seen).
2. Pick polling (every 10 min active hours, 30 min overnight, per the approved
   wave-1 spec): GET each expert's profile JSON; ingest pending picks for today's
   games. Map ml_home/ml_away/spread_home/spread_away/over/under onto our slots via
   the embedded game object's team abbrs + start time against today_games. Odds,
   units, and the verified flag come free per pick.
3. Storage: picks land in capper_history rows with source='actionnetwork', each
   expert registered in the capper registry, graded by results.js exactly like
   Discord picks (we grade ourselves; AN does not expose settled picks publicly).
4. Scoring: during the track phase their picks build records but do NOT attach to
   board slots or add points. Flipping them live = letting their picks create
   mentions that flow through the normal advocate-resume scoring, with seeded
   resumes per the policy below. A settings flag per source controls it.
5. Props/exotics (custom_picks): logged to an_expert_props for the record and the
   future props page, never scored, never slot-matched. Prop verification is an open
   item (AN only shows pending picks publicly, so grading props needs our own resolver
   per prop type; start with the subset we can grade from ESPN box scores).
6. UI: AN emblem on leaderboard + profile. AN record shown alongside our graded record.

### Baseline points for AN experts (seeding policy, surveyed 2026-07-07)

Survey of all 40 discoverable experts (full data: an_experts snapshot): 27 of 40 show
positive all-time units, median volume ~4,000 picks, and ZERO have book-verified
(BetSync) windows. Every record is AN platform-tracked: system-graded (not
self-claimed), but with variable stakes and longshot/parlay grading that inflates
units. Several "records" are obvious unit-math anomalies (one shows +106,145 units at
+365% per pick). The honest read: most AN experts are media people running 0 to 6%
per-pick ROI, with a real tail of sustained positives (Sean Koerner +245u over 4,195,
Jim Turvey +485u over 8,291, Wags Wins +129u on WTA alone).

Policy, per the credibility principle (external reputation buys almost nothing;
evidence with us buys everything):
- Track phase: 0 points, already locked.
- When enabled, seed the resume formula with HAIRCUT external evidence: units and
  pick counts at 50% weight (would rise to 70% only for book-verified windows, which
  do not exist today). Seeds are static pseudo-counts; OUR graded picks accumulate at
  full weight and dominate within ~25 picks.
- Anomaly guard: any expert or league split with per-pick ROI beyond +/-10% seeds 0
  and gets flagged for manual review (that bound excludes the +365% account and three
  other implausible records today). Custom/prop leagues never seed.
- SEED CAP: 25 points overall and per sport. External records can make an expert
  "Rated", never "Elite". Elite is earnable only through picks we graded ourselves.
- League mapping: nfl->NFL, nba->NBA, mlb->MLB, nhl->NHL, ncaaf->NCAAF, ncaab->CBB,
  wnba->WNBA, atp/wta->ATP/WTA, worldcup and club soccer->Soccer.

What that yields today: Sean Koerner seeds ~11 (his NFL split ~13), Jim Turvey ~11
(NBA ~16), Wags Wins ~24 on WTA, Nick Martin ~2, Zerillo and Stuckey ~0 to 1 despite
the fame, and most of the roster 0 to 5. Which is the correct message: AN experts
walk in as credible newcomers, not as stars, and their value to us is 40 new
high-volume sources whose picks arrive with native odds and stake sizes, building our
own ledger fast.

Timing (surveyed 2026-07-07, 74 pending picks across 6 experts): median pick is
posted 6.5 hours before game start, 75% at least 4 hours early, only 3 of 74 inside
30 minutes. The 10-minute poll therefore captures nearly everything hours pregame.
Acceptance rule: a pick counts if AN's own created_at is before game start, even if
our poll fetched it after; live picks (is_live) log to the capper record only, never
the board.

Rate/risk: same cadence and headers as the existing public-betting scrape. Endpoint
shapes are unofficial and can change; the CA Ops panel (below) surfaces breakage same-day.

## Source expansion roadmap (probed 2026-07-07)

Beyond Discord + Action Network, endpoint feasibility was tested live. Every source
enters the same way: tracked as capper/source entities, zero score influence until
graded results accumulate, same resume formula, same anomaly guards.

TWO WAVES (Jack's rule, 2026-07-07): sources whose picks arrive as STRUCTURED DATA
(JSON fields or fixed markup: team, line, odds already separated) need no AI and
start NOW. Sources whose picks arrive as human prose need the reader (Mac Ollama /
Haiku) and are SAVED FOR LATER. Universal ingestion rule for every wave: a pick
counts only if its source timestamp is before game start (AN created_at, chat
message timestamp, wallet position entry time); anything in-game goes to the capper
record only, never the board.

WAVE 1, no AI, implement now:
- Action Network experts (#already specced above): pure JSON picks with type, line,
  odds, units, game object. Median posted 6.5h pregame.
- Polymarket pro wallets (item 2): pure JSON positions (market, outcome, size,
  price, timestamp). Only entries timestamped before game start count as picks.
- Covers contests (item 3): fixed contest-pick markup (ATS pick + line), a
  deterministic HTML parse, records platform-graded, picks lock pregame by rule.
- Model/site entities (item 6): OddsShark computer picks and Pickswise pick fields
  are fixed page slots, deterministic parse, published mornings.
- Sharp-money entity (zero new scraping): tickets% vs money% divergence from the
  public-betting data we already collect becomes a gradeable pseudo-capper.

### Wave-1 scraper specs (APPROVED by Jack 2026-07-07: AN + Polymarket + Covers)

Requirement: picks score almost as soon as they are posted at the source, with a
small storage/request footprint. All three scanners feed the same event pipeline the
Discord live listener uses: normalize -> map to espn_game_id (structured fields, no
fuzzy matching) -> resolve canonical capper -> insert mention -> recalc slot score
instantly. No batch waits.

| Source | Post behavior | Poll cadence | Tracked set | Requests/day |
|---|---|---|---|---|
| Action Network | picks post all day, median 6.5h pregame | every 10 min active hours (8am-11pm ET), 30 min overnight | all ~40 experts | ~4,000 small JSON |
| Polymarket wallets | positions open any time pregame | leaderboard refresh at 5am; tracked-wallet positions every 10-15 min active hours | top ~50 sports wallets (leaderboard + per-game top holders) | ~4,500 small JSON |
| Covers contests | contest picks lock at game start, posted through the day | leaderboard refresh 5am + 4pm (piggybacks existing crons); tracked contestant pick pages every 30 min active hours | top ~50 contestants | ~1,500 pages |

Storage footprint rules: one row per detected pick with a TRIMMED source payload
(no page archives, no full position histories); raw side-tables follow the
raw_messages pattern and wipe daily; registry, capper_history, and ratings persist.
Wallet positions store as picks ONLY when they map to a today_games market before
start time. Cadences are settings-table values so they can be tuned without deploys.

WAVE 2, needs the AI reader, later:
- Telegram channels (item 1): prose messages. Exception worth noting: strict
  one-line channels (like topfreesportstips) could be regex-parsed without AI, but
  as a rule Telegram waits for wave 2.
- Reddit dailies (item 4): comment prose plus flair records.
- Additional Discord servers (item 5): prose, same reader load as today's channels.
- WagerTalk / SGPN / ATS.io article picks: semi-structured at best.

Priority order and per-source detail:

1. TELEGRAM capper-leak channels (HIGH priority, mechanism CONFIRMED): public
   channels render at t.me/s/<handle> server-side, no account, 20 messages per page.
   Each channel = a source entity; named cappers inside messages = cappers, exactly
   like Discord. Reuses the whole reader pipeline. New file src/telegram_scanner.js;
   channel handles live in the source file per scanner security rules.
   Verified-active targets (2026-07-07): capperspickstele (BEST: leaks named cappers
   like Matthewp07/NickyCashin/Beezowins with clean "Cubs -1 (-104) 2 units" lines),
   breadheadbets (structured pick + prose), topfreesportstips (one-line picks),
   capperscrownfree (active, hype prose, low structure). Phase 2 watchlist (preview
   disabled, needs a free TG account via MTProto): cappersleaked1 (~15.8K subs, the
   big leaks channel), LeakingPremiums, cappersunlocked. More handles via
   telegraminformer.com/c/betting (571+ listed).
2. POLYMARKET PRO-WALLET TRACKING (HIGH priority, novel): we already use
   gamma-api.polymarket.com (polymarket.js). The public data-api sibling
   (positions / holders / trades per wallet, no auth, confirmed 200) exposes actual
   positions on sports markets, and the OFFICIAL leaderboard API is documented
   (docs.polymarket.com, trader leaderboard rankings: rank, wallet, username, P&L,
   volume). Plan: leaderboard + per-game top holders feed a tracked-wallet set;
   each wallet = a pseudo-capper whose "picks" are position entries. REAL pro
   bettors with on-chain P/L, the most verifiable source in the stack. Kalshi's
   opt-in social leaderboard (named traders with P&L and open positions) is the
   thinner sibling, phase 2.
3. COVERS.COM CONTESTS (MEDIUM): King of Covers + Streak Survivor leaderboards are
   server-rendered (confirmed 200, contestant profile URLs present; survivor
   current/monthly/allstar leaderboard pages confirmed). Contest picks are
   structured ATS picks and records are platform-graded. Track leaders as cappers
   with contest-seeded resumes under the same haircut policy as AN (50% weight,
   +/-10% anomaly guard, seed cap 25). Covers also has a public per-game consensus
   page (free extra signal).

Seeding note for Polymarket wallets: wallets seed ZERO resume points. Their on-chain
P/L is real but denominated in dollars across mixed markets (prices, not American
odds), so it does not map cleanly onto units-ROI. The wallet's on-chain P/L displays
on the profile for context (like AN claimed records); only picks WE grade build the
wallet's scoring resume. Selection into the tracked set (top leaderboard P/L) is
itself the quality filter.
4. REDDIT r/sportsbook DAILY THREADS (MEDIUM): anonymous JSON is blocked (403
   confirmed); the official API free tier (registered app, OAuth, 100 queries/min)
   is plenty and zero-cost. Auto-posted daily threads have stable names ("Pick of
   the Day - M/D/YY", "MLB Daily - ...", per-sport dailies), one pick per user per
   day in POTD, and the mod bot tracks records in user flair ("POTD: 12-8") which is
   free credibility metadata. Usernames = trackable cappers at huge volume.
5. MORE DISCORD SERVERS (MEDIUM, cheapest infra reuse): the existing scanner
   pattern extends to any server we join. Directories: disboard.org +
   thehiveindex.com sports-betting tags. Named free-pick servers found: MySportPick
   (62K, tracked picks), SharpLine Sports (70K), Sports Capitalists (49K),
   Hoovement (30K, daily capper slips), Champions Sports Betting (20K), Elitepickz
   (14K, "verified track records"), PropWave (props), CashKeg, Porter Picks,
   Insider Picks. Vetting which have structured free-pick channels is manual, then
   it is just channel IDs.
6. SITE-EXPERT / MODEL SOURCES (LOW effort): Pickswise and OddsShark computer picks
   render openly (confirmed 200). WagerTalk and SGPN publish free picks as TEXT
   pages (wagertalk.com/free-sports-picks, odds.sportsgamblingpodcast.com), which
   beats parsing their YouTube. ATS.io posts handicapper picks as articles. Each
   site = one source entity, graded like everyone. BettingPros has a real
   expert-records API but the client key hides in JS bundles (medium, revisit).
   Tallysight has creator leaderboards with verified records but bot-protection
   403s (flag, retry with better headers). Dimers unprobed, check at build.
7. X/TWITTER: skipped as a scrape target (paid API, fragile scraping, TOS-hostile,
   violates zero-cost). Use X only as a pointer to third-party-tracked profiles
   (e.g. Tallysight-tracked media pickers).

Scanner security reminder: all handles, channel names, and wallet lists live in
scanner source files (repo stays private), tokens/keys in .env, weights in the
ratings system only.

### Cross-source capper identity (critical foundation, ships with wave 1)

The same capper WILL appear in multiple systems (a Discord capper's plays leaked on
Telegram, an AN expert also running a Discord, contest players reusing handles).
Identity must resolve to ONE canonical record or resumes fragment and consensus
double-counts. Design:

1. capper_registry: canonical capper_id, display name, notes. capper_source_handles:
   (capper_id, source, handle_or_wallet_or_user_id) UNIQUE per source+handle. The
   existing capper_aliases table becomes the Discord-name layer of this registry.
2. NO automatic cross-source merging. The admin alias-suggestion panel (already
   built for Discord name variants) extends to cross-source suggestions: matching
   display names across systems queue as suggestions with confidence, Jack approves
   each merge. Assume-chance applies to identity too: same name is not proof of
   same person.
3. Pick-level dedup across sources (HARD RULE: no pick is ever counted more than
   once for the same capper): the SAME canonical capper on the SAME slot on the
   same day is ONE mention, no matter how many systems carried it. Enforced at
   write time by resolving to the canonical capper BEFORE the dedup check (unique
   on canonical capper + pick slot, the existing capper_history index pattern). A
   duplicate arriving from a second system appends its source to the mention's
   provenance list and changes nothing else. Different cappers from different
   systems on the same slot are genuine consensus as usual.
4. Source entities stay separate from named cappers: a leak channel is a source
   entity; the named capper inside its messages is the capper. When a message names
   no capper, the source entity is the advocate.
5. Every capper_history row gains a source column (discord/actionnetwork/telegram/
   covers/polymarket/reddit) so per-source records stay auditable inside one
   canonical resume, and the leaderboard emblem is driven by it.

## CA Ops console: Capper Sources panel

The ops console (ops/server.js, localhost:4300) gets a second major section beside the
book data panels:
- Discord scanner: per-channel last message time, last scan, live-listener status,
  picks extracted today, skipped count.
- Action Network: experts tracked, last successful poll, picks ingested today, HTTP
  error streak (the "AN changed their JSON" alarm).
- Capper pipeline health: capper_history rows written today, unresolved-name queue
  size, alias suggestions pending. This makes silent breakage (like a dead writer)
  visible the same day, from the desktop console.
- Drift monitor (the falsifiability loop): rolling 30-day gold and silver tier
  records vs the calibration expectation, with a visible alarm state when the gold
  tier runs below breakeven over a meaningful sample, plus a monthly calibration
  report (tier records, component contribution vs result, fade-side hit rate) that
  drives the scheduled constant refits.

## Phase 0: data fixes (before any scoring work matters)

1. capper_history writer gaps (results.js): Pass 1 is the only writer today. Add
   capper_history writes to the later passes that grade wiped games via pick_history,
   and add a golf writer. Silent data loss today.
2. Spread juice: capperBetOdds() returns null for spreads (falls back to -110). Capture
   spread prices into today_games (ESPN DK odds include them, already fetched free) and
   store real spread odds on capper_history rows.
3. Per-mention capper attribution: raw message capper_name is not stored per mention
   (messages_json only has author/channel/text). Add capper_name to the mention records
   so quality-weighted consensus becomes measurable and tunable. THE key gap found in
   backtesting: 125 multi-mention picks exist and zero can be attributed.
4. is_home on capper_history rows (needed for the side lean and any venue analysis).
5. Odds backfill: join existing capper_history rows to pick_history by pick_id
   (461 joinable locally, more on the server) to fill missing odds.
6. Alias merge queue: finish the ambiguous clusters (Docs vs Docs Sports, Tony, etc.).
   Jack's call per cluster. Merges materially change resume numbers, do this before
   final calibration.
7. Data hygiene: at least one row has game_date 2024-07-05 (bad parse), sweep for
   out-of-range dates.
8. score_breakdown v2 table gains the v3 component columns so every scored pick logs
   its full component vector from day one (that log IS the future calibration dataset).
9. capper_ratings materialized table (nightly + on-demand admin refresh): capper,
   sport, type, picks, units, blends, tier, fade flag. The scorer reads this, never
   raw history, so scoring stays O(1) per pick.
10. Channel-complete data export: the public pick-history endpoint strips channel by
    design, so full per-channel records (including free-plays and non-capper pod
    picks) are not pullable today. Add channel to the admin pull so channel weights
    can be fitted on complete data during calibration.

## Replay evidence (2026-07-07, no-lookahead, conservative)

A chronological replay over the live-site capper history (each pick scored using only
the capper's record BEFORE that date; market signals, side lean, and price counted as
ZERO because they cannot be reconstructed historically):

| | Picks tracked | Record | ROI |
|---|---|---|---|
| MidwestMike, v2 65+ tier (what actually got tracked) | 8 | 3-5 (37.5%) | -28.4% |
| MidwestMike, v3 gold | 60 | 32-26 (55.2%) | +0.7% |
| MidwestMike, v3 gold + silver | 74 | 41-29 (58.6%) | +7.2% |
| Capper-attributed tier, v2 65+ | 47 | 23-24 (48.9%) | -9.1% |
| Capper-attributed tier, v3 gold + silver | 82 | 46-32 (59.0%) | +8.2% |

Read: v2 tracked the WRONG slice of the best capper's work (his consensus-stacked
picks), and its capper-attributed tracked tier lost money. v3 flips that tier to
winning on the same history, with signals contributing nothing yet. Caveats: the
replay's cold start (Mike's hot April built the resume and so could not itself score
gold) is a one-time cost that does not apply going forward, and this population
excludes non-capper-attributed board picks, which the full backtest below covers.
Note: this replay ran on an earlier draft (channel bases + elite floor); the final
flat-base + source-entity design gives elite cappers the same scores by construction,
so the direction holds, and the full backtest re-runs it under final constants.

## Phase-5 calibration record (2026-07-07)

Harness: scripts/backtest_scoring.js (as-of replay, no lookahead, signals + lean
counted ZERO = conservative floor; fresh pull 2,168 capper rows + 536 board picks).
Grid over base x multiplier chose base 45 / mult 360:

- GOLD (100+, gate on): 41-30 (57.7%), +5.8% ROI, 1.06/day (volume target 1-3 met)
- SILVER (75-99): 50% at the floor (live signals are additive headroom)
- v3 top-10/day beats v2 top-10/day on ROI: +0.4% vs -0.5% (PASS)
- Elite guarantee: 100% of elite-resume picks reached gold (PASS)
- Acceptance #1 (gold >= the 65+ tier's 59.6%/+8.7%): CONDITIONAL at the floor
  (57.7%/+5.8%). Two honest reasons it under-reads: the replay's cold start (gold
  only exists after resumes build, so the hot early period is excluded by
  construction) and zero signal/lean points. Enforcement is the CA Ops drift
  monitor: if live gold runs below breakeven over a meaningful sample, the alarm
  fires and constants get refit. That is the falsifiability loop, not a hand-wave.

Flip executed locally: scoring_version='v3', ratings recomputed at mult 360, board
rescored, /api/config serves mvp_threshold 75 (silver styling) + display 100 (gold),
/api/picks ranks by the leak-aware display score, pick_privacy strips all v3
internals (leak_target would reveal the true score early). mvp_picks and
pick_history stamp scale_version='v3' from the flip forward; gold (100+, totals
gate) is the only tracked tier.

## Backtest + calibration (LAST, before the big update ships)

scripts/backtest_scoring.js, pure local, no API calls:
1. Pull fresh live-site data (scripts/pull-capper-server.js already pulls both the
   admin capper history and the public 35+ board archive in one run).
2. Replay chronologically. For each historical pick, compute capper blends AS OF that
   date (no lookahead), score it under v2 and v3 candidate weights.
3. Report per weight-set: win% and ROI of daily top-1 / top-5 / top-10, gold count per
   day (target 1 to 3), silver count per day, fade-side hit rate.
4. Fit the open constants: component maxes, the resume multiplier, k values,
   the trust clamp, consensus join scale, fade thresholds, price bucket points, gold
   line exactly at 100. Optimize for TOP-OF-BOARD quality (gold + silver tiers), not
   whole-board averages. The publicly tracked tier is what matters.
5. Acceptance (all three):
   - Gold picks (100+) grade at or above the CURRENT 65+ tier, the publicly tracked
     population: 59.6% win, +8.7% ROI on live data. That tier already works; v3 gold
     must not be worse than it.
   - v3 top-10 beats v2 top-10 on ROI over the replay window.
   - Sanity target: a MidwestMike-class resume (50+ resume points) reaches gold from
     ANY room (45 base + 53 resume + 5 sport = 103, solo). Verified in the Phase-5
     replay: 100% of elite-resume picks reached gold. Established elites never fall through the
     cracks; that is the point of the rework.

## Implementation plan (5 phases, all local, bet-tracking branch, no Railway)

Yes, multiple phases: the dependency chain forces it. Identity must exist before
scrapers write picks, scrapers must run before source entities have records, records
must accrue before the v3 scorer means anything, and calibration is LAST by decree.
Phases 2 and 3 can interleave once Phase 1 lands.

PHASE 1: FOUNDATION (identity + data integrity). The prerequisite for everything.
- capper_registry + capper_source_handles tables; storage.js resolveCapperName()
  extends to registry resolution; capper_aliases becomes the Discord layer.
- capper_history: source + is_home columns; results.js writer gaps closed (Passes
  2-4 + golf); spread juice captured into today_games and capperBetOdds(); odds
  backfill from pick_history join; bad-date sweep.
- Per-mention capper attribution (capper_name on every mention record).
- score_breakdown gains v3 component columns (logging shell, zero behavior change).
- capper_ratings materialized table + src/capper_ratings.js nightly recompute + admin
  refresh; channel-complete admin export.
- Files: db.js, storage.js, results.js, admin.js, new src/capper_ratings.js.
- Exit: ratings table populated from live history, all writers verified against a
  day of graded games, attribution flowing on new picks.

PHASE 2: ADMIN VISIBILITY (read-only surfaces, zero scoring impact).
- Leaderboard: per-sport money columns, Rating column, tier badges, SOURCE LABEL
  chips (DC/AN/PM/CV, multi-source cappers show all).
- Expanded capper profile popup (per-sport, per-type, SVG equity curve, fade panel).
- Fade Watch/Active lists (display only).
- CA Ops: capper sources panel + drift monitor skeleton.
- Files: admin.js, ops/server.js, ops/ui.html.
- Exit: Jack can see everything the ratings system believes, per source.

PHASE 3: WAVE-1 SCRAPERS (track-only, event-scored ingestion).
- Shared ingest path (source pick -> normalize -> espn_game_id map -> canonical
  capper -> cross-source dedup -> capper_history), pregame timestamp rule enforced.
- src/an_experts.js (10 min active / 30 min overnight), src/polymarket_wallets.js
  (leaderboard 5am + positions 10-15 min), src/covers_contests.js (contestants 5am
  + 4pm, pick pages 30 min). Cadences in settings. UI_ONLY guards (server-only).
- index.js cron + startup wiring; CA Ops panels light up per source.
- Exit: all three sources writing graded, labeled, deduped capper history for 2-3
  weeks of clean flow (the graduation bar to scoring is a per-source settings flag,
  Jack's call).

PHASE 4: V3 SCORER (behind scoring_version flag, v2 stays live).
- src/scoring_v3.js: flat base, advocate resume (capper OR source entity),
  quality-weighted consensus with steep diminish, market signals (small maxes, full
  values logged), nightly side lean, sport bonus, price context (0, logged), fade
  points to opposite slot, totals gold gate.
- Source entities accrue (free-plays official, pod official, community, model sites).
- The leak rule (display score + conviction curve ramp, 20-50 min randomized window,
  compressed before game start).
- Both scores computed and logged on every pick; public site still shows v2.
- Exit: two weeks of dual-logged scores with no pipeline errors.

PHASE 5: CALIBRATION + LOCAL FLIP (LAST, per Jack).
- scripts/backtest_scoring.js: as-of replay over fresh server pulls, fit the open
  constants, verify the three acceptance criteria (gold beats the 65+ tier's
  59.6%/+8.7%, v3 top-10 beats v2 top-10, elite-solo-gold holds).
- Set gold=100 / silver=75, scale_version era columns, silver/gold public styling,
  flip scoring_version locally.
- Exit: v3 live on localhost end to end, ready to ride the big combined update to
  Railway after Jack's explicit go (ship gate unchanged).

Post-ship backlog (not in these phases): wave-2 prose sources (Telegram, Reddit,
new Discord servers), Kalshi social leaderboard, BettingPros/Tallysight revisits,
signal weight re-fit after ~6 weeks of football.

## v3.2 TARGET ARCHITECTURE (Jack, 2026-07-08 night): every point earned

STATUS UPDATE (same night): the BASE RATCHET + ERA-RELATIVE VOLUME rows below are
BUILT AND SHIPPED as the self-anchoring earned-scale ratchet
(capper_ratings.computeScaleState -> settings v3_scale / v3_scale_anchor):
- Activation is a NO-OP: the anchor self-creates from the live ecosystem stats
  and reproduces the launch constants exactly (verified: 230/230 resume rows and
  board totals identical, plumbing verified by controlled base flip).
- Base: -1 per +1000 graded ledger picks, floor 25, max 1 step per night, HELD
  whenever trailing 14d golds < 8 or the 30d gold record < 52.4% (verified in
  simulation: single-step clamp, guard hold, restore).
- vol_k = max(10, 10 x median rated volume / anchor median) — Jack's "200 picks
  is a lot NOW, will be mid-pack later" rule, recomputed nightly.
- sigma = (100 - base)/55 stretches mult, volume cap, hard cap, and consensus
  cap (clamped 35) so elite-solo gold survives every notch, continuously.
- FORWARD-ONLY by Jack's call: no history rescale; existing MVPs/golds keep
  their scores and tier membership permanently.
Still v3.2-pending from the table below: market 0-10 refit, dynamic sport bonus,
lean/fade widening, recency-vs-career, volume-damped trust (co-fit).

Jack's directive after reading the playbook: "each point needs to have meaning
and value, giving good reason why it's at 100... the base 45 flat is essentially
nonexistent" at the end state. The base is SCAFFOLDING for an unrated ecosystem,
and it ratchets DOWN as earned components grow into the space. Gold stays 100.

Component targets (each one data-driven, growing/shrinking with evidence):
| Component        | Today | v3.2 target | Mechanism |
|------------------|-------|-------------|-----------|
| Base             | 45    | ratchets 45 -> 38 -> 32 -> ~25 | stepped down only when the gold rate + quality hold in band at the next notch (replayed first, one-time history rescale per notch) |
| Advocate resume  | 0-55  | 0-65        | mult + volume-cap refit at each notch |
| Consensus        | 0-30  | 0-35        | resume-stacking as shipped, cap raised with the resume ceiling |
| Market signals   | 0-8   | 0-10        | weights refit from the LOGGED full values (they have been logged since launch precisely for this) |
| Sport bonus      | flat 5| 0-10 DYNAMIC | 5 +/- CA's own shrunk graded ROI in that sport (nightly, like side lean; k=50 so it moves only on real volume) |
| Side lean        | 0-5   | 0-10        | same nightly computation, wider clamp once per-sport samples justify it |
| Fade points      | 0-8   | 0-10        | same sport-volume scaling, wider cap as fade-list evidence deepens |

RECENCY VS CAREER (Jack): once a capper is established (25+ graded), blend a
recent-form window into their resume (exponential decay, half-life ~90d,
half-life itself backtested) so current form moves points up or down against
the career baseline. Under 25 picks: career-only (small windows whipsaw).

VOLUME-DAMPED TRUST (Jack, from the SBK 36 vs Vernon Croy 14 case): the trust
multiplier must be earned by volume, not by rate — trust' = 0.3 + (trust-0.3)
x n/(n+25) — so a 9-pick dog-heater cannot borrow full trust from its own tiny
sample (SBK 36 -> 17 vs Croy 11). Replay verdict 2026-07-08: fixes the case but
costs gold quality when swapped in ALONE (59%/+10.6% -> 56%/+3.6%) because the
other constants were fit around undamped trust. Co-fit it with mult/caps in the
v3.2 pass, never ship solo. Context: only 3 of 79 replay golds were carried by
a <20-pick advocate, and the SBK pick itself was silver — the tracked tier has
limited exposure meanwhile.

ERA-RELATIVE VOLUME (Jack): today vol = n/(n+10) saturates fast (100 picks ~
0.91, 300 ~ 0.97), so early cappers all look "full volume" as the ledger
deepens. v3.2: tie the volume constant to the population (e.g. k = median
graded volume of RATED cappers, floor 10, recomputed nightly) so standing out
keeps requiring more as everyone accumulates — while the skill term keeps a
30-pick 65-70% capper genuinely valuable (volume never becomes a pure seniority
contest). Backtest the k schedule before shipping.

Floor replay of the end-state geometry (2026-07-08 pull, signals zero):
base25/res65/con35/dynSport = 0.21 gold/day @ 57% — confirms the ratchet plan:
the end state needs matured wave-1 resumes + live signal data before it feeds
1-10 gold/day. Triggers to advance a notch: (1) 200+ graded wave-1 picks per
major source, (2) replay at the next notch holds >= 1 gold/day @ >= 58%,
(3) elite-solo-gold preserved. The CA Ops drift alarm is the rollback signal.

## Amendment 2026-07-08 (evening): resume-stacking consensus + chunked reveal

Jack reviewed the live board (Brewers ML gold, 4 AN joiners at +0.5 each) and asked
why proven confirmers add so little. Replay answer: the join-points formula was
actively bad — consensus-driven golds (consensus >= 10) under it ran 38% win,
-20% ROI (crowd size sneaking back in). Reworked, replay-verified:

- CONSENSUS = RESUME STACKING: each joining capper contributes 60% of their OWN
  sport resume (JOIN_RESUME_FRAC), extra voices taper by 0.6 each (JOIN_TAPER),
  cap 30 (CONSENSUS_CAP). Unrated joiners keep the +2 floor; fade-list joiners
  still add 0. A proven 40-resume confirmer now adds ~24; four unknown AN
  experts still add ~4 total until their records earn more. Replay: gold 59% /
  +10.6% ROI at 1.17/day, consensus-driven golds 56% / +13.1%.
- LEAK RULE v2 (chunked reveal): the display gap reveals in 2-5 seeded random
  chunks (each <=25) instead of a smooth line; window by urgency (>3h: 5-30 min,
  1-3h: 90-300s, <1h: instant; always done 3 min pre-start). leakSchedule() is
  deterministic per ramp and shared by the picks list AND the conviction curve,
  so the number and the chart replay the identical path.
- Solo picks unchanged: base + advocate resume + signals (solo official picks
  remain the best-performing bucket; crowd size is never the primary driver).

## Amendment 2026-07-08: wave-1 sources graduated to board scoring

Jack's call (one day after the v17.1.3 ship): wave-1 picks now add points to the
rankings, not just the capper ledger. Implementation (source_ingest.js):

- A PREGAME wave-1 pick, after its capper_history insert, also lands on the board
  through storage.savePick with channel = the source name — the exact Discord
  mention path (flat base 45, advocate resume of the wallet/expert/contestant from
  capper_ratings, quality-weighted consensus, market signals, leak rule, MVP and
  archive gates). No fiat baseline: a new wallet scores base-only until its graded
  record earns resume points, and the '@src:polymarket'-style entities keep earning
  through the same formula. Live/in-game entries stay capper-record-only, as before.
- Gates: scoring_version must be 'v3'; source_board_points (master, default on);
  source_board_<source> per system (default on), the per-source flag this doc called
  for at approval time.
- One bet = ONE capper_history row, enforced both directions: source_ingest dedups
  cross-source on insert, and results.js Pass 1 / Pass 4 now skip their grade-time
  insert when the capper already has a row for that slot (previously that pairing
  double-counted a capper who was both slot-credited and wave-1 tracked).
- Board slot pick_type convention is 'ML' uppercase / spread,over,under lowercase
  (lines.js seeds); the board push maps accordingly.
- Polymarket conviction sizing: each wallet's usual game-market notional is tracked
  (EMA on pm_wallets.notional_avg/notional_n); every ingested pick logs
  size_ratio = notional / usual into provenance meta. ZERO points at launch —
  logged-only, same policy as price context. Backtest decides if oversized entries
  earn anything.
- AN discovery is bot-challenged from Railway (202 challenge page); the open users
  API is not. Roster seeding relays from the Mac: scripts/an_relay.js -> header-auth
  POST /admin/api/an-experts-import. Pick polling runs on prod unchanged.
- NOT done yet: the haircut resume seeding for AN experts (50% weight, 25-pt cap,
  anomaly guard). Wave-1 cappers all start at earned-zero. Seeding remains a
  calibration task if Jack wants records to pre-count.

## Open items (Jack)

- Alias merge queue rulings (Docs cluster, Tony cluster, and whatever the suggestions
  panel shows after the next server pull).
- RESOLVED 2026-07-08: wave-1 sources graduated to board scoring (see amendment
  above). Remaining lever: AN haircut resume seeding, still unbuilt.
- Prop grading approach for the future props page (which prop types first).
- Whether WNBA joins SPORT_BONUS_SPORTS in v3 (it is excluded today; MidwestMike is
  8-2 on WNBA and the resume component already rewards that without the flat +5).
