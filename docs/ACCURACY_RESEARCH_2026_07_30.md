# Accuracy Research — 2026-07-30

The full "how do we put more winners at 100+" investigation: 13-agent adversarially-verified
workflow (six dimensions, every finding attacked by a hostile verifier) plus hand re-verification
of every headline number on a validated no-lookahead replay harness.

**Harness fidelity:** ladder/gate/chip math copied verbatim from `capper_ratings.js` +
`scoring_v3.js`; replayed scores match production at median diff -1 (75% within +/-15) on the
gen-7 era. All price analysis uses PREGAME capper entry prices only (an early harness draft mixed
in-play prices into slot prices — that is lookahead, it manufactured a phantom heavy-favorite
edge, and it is the trap for any future replay work).

**Data:** 22,235 capper_history rows / 18,497 graded v4-era decisions / 501 cappers /
2,835 reconstructable graded board slots (2,131 with a clean pregame price) / the real tracked
ledger (441 v4-era rows, 210-178). ~21 days of v4 data. Everything below states n and CI;
one p<0.05 in a swept dimension is treated as noise (multiplicity).

---

## 1. What shipped from this research

**Pregame-only capper ratings (d3af377, 2026-07-30).** `recomputeCapperRatings()` ranked cappers
on their full history while the board only ever scores pregame picks. 7,787 of ~19k graded rows
were in-play entries (WTA 82%, ATP 62% of their rows), running ~6pts hotter on win% at short
prices with worse ROI — exactly the number the Wilson ladder ranks on. 61 of 640 ranked cappers
had ZERO pregame decisions; 9 of the 31 top-5% names ranked purely on in-play results
(tradecraft: 424 decisions, all live). Fixed: in-play rows are excluded from the pool, gates,
edge/heavy stats, and the side lean. Rows stay in capper_history; nothing historical restated;
ratings change forward.

Replay of the fix on the v4 era: golds 295 vs 297, record 59.3% vs 56.9%, ROI +10.8% vs +0.6%
(clean prices). Directionally good; win% difference NOT significant (two-prop p=0.55). Ship
justification was correctness, not the backtest.

## 2. The central (well-powered) null

**The v4 score does not order picks against the market.** Spearman(score, price-residual)
= -0.02, CI [-0.06, +0.02], n=2,131. Identical under the pregame pool (-0.022). Edge by score
band flips sign randomly across the whole range. The tracked tier runs at break-even against its
own prices: 56.9% win vs 56.1% implied (edge +0.8, CI [-4.8, +6.4]).

Consequences:
- No reordering rule, bar move, or bonus reshuffle can "pull more winners up to 100" — the score
  cannot tell winners from losers within any band. Volume added by any rule arrives at ~50%.
- The site's edge, where it exists, is in WHICH POOL gets scored at all (sport mix, source mix,
  data hygiene), not in the point arithmetic.

Per sport at the tier (pregame pool, clean prices):

| Sport | n | Record | Win% | Needed | Edge | ROI |
|---|---|---|---|---|---|---|
| WNBA | 78 | 50-28 | 64.1 | 52.4 | +11.7 | +23.6% |
| WTA | 57 | 37-20 | 64.9 | 58.6 | +6.3 | +15.4% |
| ATP | 89 | 54-35 | 60.7 | 56.5 | +4.2 | +14.0% |
| MLB | 66 | 30-36 | 45.5 | 54.9 | -9.5 | -16.8% |

MLB gold's negative edge (-11.9 on the contaminated pool, CI [-24.6, +0.8]) is the only
near-significant tier effect. Combined with MLB's at-chance score AUC (0.490 [0.449, 0.527],
n=904): MLB gold is a random draw from a pool that loses to price. **No MLB scoring knob fixes
MLB.** Closed with power.

## 3. Tested and found NOTHING (closed questions — do not re-run without new data)

- **Edge-based ranking** (rankBy edge / blend): no improvement at any matched volume.
- **Recency half-life** (7-120d sweep): no out-of-sample predictive gain over lifetime; decay
  interacts badly with volume caps. The open "recency" item can be closed.
- **Crowd size / composition**: the crowd inversion is a price confound; controlling for price,
  backer count carries no signal either direction.
- **Cross-source agreement**: only WNBA has real source overlap; PM-presence there = +8.8 edge,
  CI [+0.4, +17.2], p=0.039 under ~35 comparisons — shadow-log only, not shippable.
- **Timing (early vs late pregame entry)** from saved_at: source-confounded; no clean signal.
- **A seeded-random bonus** of realistic size adds picks at 50.6% — the control every additive
  proposal must beat, and none did.

## 4. Open defects worth fixing (flag-only, no accuracy claims)

1. **Tennis duplicate event ids:** 10 player-days appear under 2+ espn_game_ids; the 115
   affected rows graded 93-22 (80.9% vs 57.0% baseline, z=5.1) and feed the ratings pool.
   Wants an audit.js R5 flag + an id-stability guard in tennis_espn.js.
2. **Corrupt stored prices:** 430 capper_history rows with odds outside [-2000, +1500]
   (Badosa @-11011, Wings @-9900...) poisoning edge and heavy-bracket stats. Wants an ingest
   sanity band + audit flag; consider a one-time NULLing of the odds column on those rows.
3. **Discord in-play gap:** Discord-era rows carry no provenance, so a Discord message posted
   mid-game is indistinguishable from pregame in capper_history. Small today (8 Discord rows/day)
   but worth a posted-at vs start-time check at ingest for completeness.

## 5. The one real lever left: forward CLV capture

Every capper-identity signal is now measured at or below chance with adequate power. The one
channel with a plausible mechanism and zero data is closing line value: did the capper's entry
beat the T-60 lock?

Build (capture only, no scoring):
- Persist each capper entry's price + timestamp against the slot's opening line and T-60 locked
  line (line_history already stores openings with captured_at; ca_line already locks T-60;
  capper_history already stores entry odds — the join is the missing piece).
- Nightly, shadow-log `clv_shrunk` per capper in capper_ratings next to `edge_shrunk`.
- Decide in ~60 days: if CLV separates forward cappers, it earns a gate/bonus; if not, delete
  the column. Bounded, reversible, zero-cost.

## 6. Rules for future replay work

- Slot prices must come from PREGAME entries only (in-play prices are outcome-correlated).
- Enforce no-lookahead pools (decisions strictly before the slot's game date).
- Prefer matched-volume (top-K/day) comparisons over absolute bar counts — market/lean/fade
  extras are not reconstructable and shift absolute scores ~0-13.
- The v4 sample is ~21 days; a subgroup p<0.05 inside a sweep is noise until it survives an
  adversarial re-run and a price control.
