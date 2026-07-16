# Form & Load — methodology

Plain-English record of how the **Team Form / Player Form** tab computes every number.
Keep this in sync when you change the engines. Not loaded into context automatically —
read it when you touch the scoring.

**Code:** `src/player_form.js` (engines), `src/tennis_player_form.js` (tennis),
`src/game_form.js` (assembly + lineup/starter + travel), `public/game-detail.js` (display).

**Philosophy:** descriptive, not predictive. Form = "who's been hot lately." Load =
"how taxed coming in" (workload + rest), **never** "injury risk." All free ESPN data
(athlete gamelogs, team schedule, game summary). Effects are real but small, so we
keep the tone humble and dim low-sample reads.

---

## Form (Hot / Cold dial)

Compares a player's **recent** production to a **baseline**, in units of their own
standard deviation (a z-score), then maps to HOT / EVEN / COLD.

**Metric per sport** (`primaryStat`):
- MLB hitter: **TB+** = total bases + walks + HBP (on-base-inclusive; a walk = 1 base).
- MLB pitcher: **K-BB** (net strikeouts).
- NBA / WNBA / CBB: **PRA** (points + rebounds + assists).
- NHL: **SOG** (shots on goal).
- NFL / NCAAF: **YDS** (QB passing; RB rush+rec; else receiving).

**Windows** (recent / baseline games):
- MLB hitter: **7 / 42**. MLB pitcher: 3 / 9.
- NBA 5/15, WNBA 5/12, CBB 5/13 (min 10 min played). NHL 10/25 (min 5:00 TOI).
- NFL 3/7, NCAAF 3/6. Min games to score: 6 (MLB hitter), 2–6 otherwise.

**Recent side is recency-weighted (EWMA), not a flat average.** The newest game
counts fully and each older game fades by `decay = 0.5^(1 / (short/2))` — a half-life
of `short/2` games. For MLB hitters (short 7) that's decay ≈ 0.82, so the 7th-most-
recent game carries ≈ 30% the weight of the latest. No hard window cliff. The
**baseline stays a flat long average** (their true normal, equal-weighted).

**Score:** `z = (ewmaRecent − baselineMean) / baselineSD`, clamped ±3. Thin recent
samples are shrunk toward 0.

**League blend (MLB hitters only):** raw self-vs-self misses that a slugger producing
well above league is "hot" even if it's normal for that hitter. So:
`z = 0.70 × selfZ + 0.30 × leagueZ`, where `leagueZ = (recentMean − 1.85) / 1.5`
(1.85 TB+ ≈ a typical regular's per-game value). Self stays the heavier factor.

**Buckets → label:** z ≥ +1.0 hot, ≥ +0.4 warm → **HOT**; −0.4…+0.4 → **EVEN**;
≤ −0.4 cool, ≤ −1.0 cold → **COLD**. **Pitchers** show the same five buckets as
command words: **SHARP / SEMI-SHARP / EVEN / SEMI-WILD / WILD** (Form = K-BB, so it
*is* command, and a separate "sharp/wild" note would just duplicate it).

**Dial display:** the needle + tint map position as `50 + z×24` (clamped 0–100), so a
genuine hot stretch (z≈1) clearly leans and z≈2 maxes out red — even (z≈0) stays
centered grey. Tint runs deep blue → ice → grey → orange → deep red. Tunable in
game-detail.js (`formPct` multiplier, `FORM_STOPS`).

**Low sample:** fewer than 10 qualifying recent games adds a "limited sample (N g)"
note to the tooltip (the dial is NOT faded — a shown value always renders full).
Below the min-games floor the dial is empty (grey dome, no needle) = no data yet.

### The 4th column — MLB pitchers only ("ERA")
Earned-run average accumulated over recent outings to ~15 IP (stable for starters
≈3 outings and relievers ≈10; the game count rides in the cell as "(N GP)"). The
**results** axis — distinct from Form (command / K-BB) and Load (fatigue). Tone:
≤3.00 good (green), ≥4.75 bad (red), else neutral.

**Everyone else has no 4th column** — Name · Form · Load · Splits · Status. Hitters'
recent production already shows in the name cell; a usage/minutes "trend" is redundant
with Load. (`computeUsageTrend` and `computeBatterNote` still exist but aren't
displayed.) Note NBA/NHL blocks are internally tagged role `batter`, so anything
metric-specific gates on `sport === 'MLB'`.

### Recent-bat note (MLB hitters, the "Recent" column)
Separate from Form (answers "what has he done lately," power-first). Over last 5 played
games, in priority order: `N HR · L5` (hot if ≥2) → `N-gm hit streak` (hot if ≥4) →
`N multi-hit · L5` → `0 H · L5` (cold) → `N H · L5`. This is hits/HR, while Form is
TB+ — they intentionally answer different questions, so they can disagree.

---

## Load (Fresh → Very Heavy dial)

A 0–100 "how taxed coming in" score → 5 bands. **Workload + rest, not injury risk.**

**Bands:** <28 Fresh (green) · <48 Moderate (yellow) · <66 Elevated (amber) ·
<84 Heavy (orange) · ≥84 Very Heavy (red).

**Rest factor** (most sports): 0 days = 1.0, 1 = 0.65, 2 = 0.35, 3 = 0.15, 4+ = 0.

**MLB starting pitcher:** `0.55 × fPrev + 0.45 × fRest`. fPrev from last outing pitch
count (75→115 = 0→1), fRest high on short rest (≤3 days = 1.0, 4 = 0.6, 5 = 0.2, 6+ = 0).

**MLB reliever** (pos RP, or ≥2 appearances in last 4 days, or last outing ≤3 IP):
load is appearance frequency, not one big start. `0.45 × fFreq + 0.30 × fB2b + 0.25 × fVol`:
fFreq from appearances in last 3 days (1→0, 3→maxed), fB2b 1.0 if pitched yesterday
(0.4 if 2 days ago), fVol from pitches over last 3 days (25→70).

**MLB hitter:** `0.55 × fRest + 0.35 × fDensity`. MLB plays daily, so a day off reads
fresh; fDensity rises from games in last 7 (5/wk normal → 8/wk congested).

**NBA / WNBA / CBB / NHL / NFL / NCAAF:** ACWR-style. `w.acute × fAcute + w.rest × fRest
+ w.density × fDensity`, score ×100.
- fAcute = acute:chronic workload ratio of the load stat (minutes / time-on-ice /
  touches), mapped 0.8→1.8 onto 0→1.
- Windows + weights: NBA/WNBA acute3 chronic10 (.48/.32/.20, minutes); CBB acute2
  chronic6 (.50/.35/.15); NHL acute3 chronic12 (.42/.33/.25, TOI); NFL/NCAAF acute2
  chronic4 (.50/.30/.20, touches).
- fDensity flags back-to-backs / congested stretches per sport.

**Tennis:** `0.50 × fAcute + 0.35 × fRest + 0.15 × fLast`. fAcute = sets played in last
12 days (4→18), fLast = sets in the immediate prior match (2→5).

**Travel / time-zone (all team sports):** time-zone shift from the team's last-game
venue to tonight's (from the schedule's venue state) adds a small capped bump:
`min(12, zonesCrossed × 4)`, added to every player's score then re-banded. A note
("Cross-country trip" / "N time zones traveled") shows on the dial and as a team chip.
DST ignored (only the delta matters). The biggest rest effect (back-to-backs) is
already in fRest; this is the cross-country compounding on top.

**Low sample:** fewer than 5 recent games adds a tooltip note (dial not faded).

---

## Lineup & starter sourcing (MLB)

- **Batting order:** ESPN's posted lineup (`rosters`, available ~1–3h before first
  pitch) when up → tagged "Lineup confirmed," uses the real `batOrder`. Before that,
  the last game's order as a proxy → tagged "Projected order."
- **Starting pitcher:** ESPN probables (available days ahead). Leads the pitching block
  under a "Starting pitcher" header; the last game's starter (resting tonight) is dropped.
- **Bullpen:** the relievers who pitched in the team's last game (best free proxy for
  available arms; not a guaranteed tonight's-pen).
- **Who plays (other sports / fallback):** the team's most recent completed box score.

---

## Tunable dials (where to nudge)

- Form recency vs stability: the per-sport `short` / `baseline` windows (`HOTCOLD`).
- Form recency bias: the EWMA `decay` in `computeHotCold` (`0.5^(1/(short/2))` — raise
  the divisor to fade older games slower, lower it to weight the latest game harder).
- MLB hitter league blend: `LEAGUE_FORM.MLB` `{ mean 1.85, sd 1.5, selfWeight 0.70 }`.
- Hot/cold thresholds: `bucketFromZ`.
- Load band cutoffs: `bandFor` (shared, kept identical in player_form.js + tennis).
- Load component weights: `LOAD` (team sports), the MLB pitcher/hitter functions, tennis.
- Travel sensitivity: `travelBump` (×4/zone, cap 12) + `STATE_TZ` in game_form.js.
- Low-sample tooltip thresholds: form <10, load <5 (game-detail.js; tooltip only, no fade).

---

## Research basis & caveats

- **Hot hand is real but modest** in baseball (Stanford GSB Green/Zwiebel; FiveThirtyEight).
  Form is a trend read, not a guarantee. Hot-hand work measured on-base, hence TB+.
- **ACWR injury prediction is contested** (Impellizzeri et al.; Frontiers editorial).
  We only use it descriptively and label it "not injury risk," which sidesteps the
  disputed claim. Never relabel Load as injury risk.
- **Rest / back-to-back / travel effects are well supported** (European Journal of
  Sport Science; circadian/travel studies).
- **Box-score load is a proxy** (minutes/pitches), not GPS/biometric load.
- **League baseline is one flat constant**, not park/era/position-adjusted.

### Possible future upgrades (not yet built)
Per-PA rates + empirical-Bayes shrinkage (the recent side is now EWMA-weighted, but
baselines/SD are still flat); opponent/park context adjustment for Form; usage/pace-
weighted load; and the big one — backtest Form/Load against actual outcomes to
calibrate thresholds.
