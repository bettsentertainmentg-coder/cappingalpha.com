# Rankings + grading deep audit, 2026-07-30

Trigger: a completed ATP match (Tabilo beat Atmane 2-0) showed **WIN** on the game
detail page and **VOID** on the Rankings list, with a note claiming the losing side
had more points. Jack's report: "countless inconsistencies across all of the
rankings board", matches vanishing from the Rankings list, and picks missing from
the all-time P/L and the graph.

The three rules the product is supposed to obey:

1. Cappers are ranked on their past PREGAME picks.
2. Picks tally up through the day. **Everything stops at the start of the match.**
3. The highest-ranked bets go on a permanent record.

Rule 2 is the one that is broken, in five separate places.

---

## 1. Root cause: the start-of-match rule is enforced in three places out of five

| Path | Gate? | Evidence |
|---|---|---|
| Scraper sources (AN, Covers, Polymarket, WagerTalk) | Yes | `src/source_ingest.js:186` `if (!live` |
| Capper ranking pool | Yes, since `d3af377` (2026-07-30) | `isLiveRow()` |
| **Discord mentions to the board** | **None** | `src/expert_data.js` only checks the 12:30am cycle window |
| **Tracked bet INSERT** | **None** | `src/storage.js:834` |
| **Boot migration insert** | **None, deliberately** | `index.js:3193-3226` |

`saveMvpPick` computes the gate value and then throws it away:

```js
// src/storage.js:746-747  — computed
gameStarted = game.status !== 'pre' || (Number.isFinite(startMs) && startMs <= Date.now());

// src/storage.js:844      — used ONCE, inside the else (UPDATE) branch only
const scoreLocked = gameStarted || ['win','loss','push','void'].includes(...);
```

The `if (!exists)` INSERT branch (`:811-838`) checks only for a missing ML price
and the heavy-price gate. Nothing about whether the game has started.

The commit message on the ratings fix two days ago states "the board has always
scored pregame picks exclusively (source_ingest's live gate)." That is true for
scrapers and false for Discord. The ledger inherited the false half.

### 1a. The upstream gate is porous even where it exists

`src/pick_cutoff.js:10-20` returns `true` (accept) whenever `actual_start_at` is
NULL, and `actual_start_at` is only stamped by `stampActualStarts()` on
`WHERE status = 'in'`. Three ways through:

- Game is past `start_time` but ESPN still says `'pre'` (routine for tennis).
- Game flips `pre → post` between polls, so it is never stamped.
- The intentional 5-minute grace, which was meant for board mentions, also lets a
  **tracked bet** be minted on a live game.

### 1b. Source liveness is judged on the wrong clock

`src/source_ingest.js:126` computes `live` from the source's **posting**
timestamp, not ingestion time. Pollers run every 10 to 30 minutes. A pick posted
60 seconds pregame but ingested 20 minutes after first pitch reads `live=false`
and takes the full board path.

---

## 2. Measured damage to the record

Every v4-era game's real start time was rebuilt from ESPN's public archive
(free, 100% coverage on all 318 games) and compared to each bet's `saved_at`
(a column default stamped at INSERT, never updated).

**48 of 457 v4-era tracked bets (10.5%) were created after their game started.**

| How late | Rows | Mechanism |
|---|---|---|
| Under 5 min | 26 | the 5-minute score cron lag |
| 5 to 30 min | 13 | Discord mentions arriving mid-match |
| Over 2 hours | 9 | bulk boot-migration inserts |

**8 legitimately-pregame bets were wrongly voided by these late arrivals**, each
carrying a "had more points" note naming a bet that did not exist at first pitch:

| Voided pregame bet | Beaten by a bet minted |
|---|---|
| Alejandro Tabilo ML 163 (07-30) | +1.5 min late |
| Seattle Mariners ML (07-27) | +414 min late |
| Seattle Storm ML + spread (07-15) | +0.1 / +1.2 min late |
| Seattle Storm spread (07-17) | +1.2 min late |
| NY Liberty over, Seattle Storm spread (07-22) | +0.1 min late |
| Golden State spread (07-29) | +15.5 min late |

Record impact of restating: **212-188 (53.0%) becomes roughly 200-178 (52.9%).**
Neutral. This is a correctness fix, not a flattering one.

### 2a. The worst rows are outcome-contaminated

Three clusters share an insert timestamp to the second:

- `2026-07-28 01:45:09` — six MLB bets in one second, up to **7 hours** after
  first pitch. One went on the record as a **WIN**.
- `2026-07-23 22:39:51` — two bets, one **13.5 hours** after the match started.
- `2026-07-21 00:01:13` — two WNBA bets.

The mechanism is explicit in `index.js:3193-3226`, the `RECORD_SYNC_GEN` boot
migration. It selects gold board picks with **no `today_games` status filter**,
calls `saveMvpPick`, and then reads the finished game's result and writes it
onto the fresh row:

```js
// index.js:3221-3226
if (['win','loss','push'].includes(p.result || '')) {
  db.prepare(`UPDATE mvp_picks SET result = ?, home_score = ?, away_score = ? ...`)
```

Its own comment says "started/graded included, this once". It is not once: the
generation has been bumped six times (gen 2 through 7), and it re-fires on every
bump. Generation bumps at `2026-07-23 18:37 UTC` and `2026-07-27 21:27 UTC`
correlate with two of the three clusters at a consistent offset.

Whatever the intent, the result is bets recorded after the outcome was known,
graded from the final score. These must come off the record.

---

## 3. Why the Rankings list loses matches

Two independent mechanisms, both confirmed in code.

### 3a. The ledger is never re-polled while you sit on the tab

`public/app.js:399-417` has `setInterval` for `loadPicks`, `loadTopGames`,
`loadHomeSidebar` and `loadHomeMvp`. **There is no interval for `loadMvp`.**
`loadMvpTab()` (`app.js:145-154`) returns early unless the cached render is over
60 seconds old *and* the tab is re-entered.

The Rankings card stitches its list from two sources
(`public/modules/sport_cards.js:370-381`):

- graded rows from `state.mvpData` (`/api/mvp`), refreshed only on tab entry
- open rows from `state.allPicks` (`/api/picks`), refreshed every 30s while live

At the instant a live match grades:

- the board row gets `result='win'` → `isGraded` true → dropped from the open bucket (`:379`)
- the ledger is still stale, saying `pending` → `isGraded` false → dropped from the graded bucket (`:371`)

**The match is in neither bucket and disappears.** It returns only when the tab is
re-entered. Tennis grades on the 30-second live tick, so this fires constantly.
This is the "live tennis matches disappearing out of thin air" report.

### 3b. Deleting the ledger row un-caps the board pick, pushing it under the filter

`src/scoring_v3.js:588-610` `heavyDisplayCapFor` exempts a pick from the 95-point
heavy display cap **only if a tracked row exists**. So for an ML at or past the
heavy gate:

1. Ledger row exists → cap `Infinity` → board ships score 163 → row renders.
2. A 5-minute sweep deletes the ledger row (demotion `mvp.js:202`, pre-gate
   `:260`, or flip `:365`/`:374`).
3. Next refresh → cap 95 → below the rail's 100 filter (`sport_cards.js:345`) →
   **row gone from every sport bucket**.
4. Promotion sweep re-inserts → cap lifts → **row reappears**.

A self-reinforcing flap on a 5-minute cycle. This is "matches go missing
entirely, then reappear".

### 3c. Two board-day clocks

`mvp_picks.game_date` is stamped with the 12:30am ET cycle rule
(`src/storage.js:752`, `src/cycle.js:44-52`). The rail filters on the 5:00am ET
rule (`public/modules/utils.js:101-106`). Rows graded between 12:30am and 5:00am
ET are filed under tomorrow and are invisible for four and a half hours.

### 3d. Two score scales on one 100-point filter

Tracked rows carry the **true** v3 total. Board rows carry the **reveal-aware,
heavy-capped display** score. Both are filtered at `>= 100`. A pick at a true 102
and a display 95 is invisible while open and appears the moment it grades.

---

## 4. Why every list looks and grades differently

### 4a. The two grade columns are never reconciled

| Fact | Column | Written by |
|---|---|---|
| Did the pick win? | `picks.result` | `src/results.js:774` |
| Did the bet count? | `mvp_picks.result` | `src/mvp.js:397`, `src/results.js:817/838/855` |

A conflict void writes `mvp_picks.result='void'` and **nothing ever writes it back
into `picks`**. Verified: the only two writers of `picks.result` in the repo are
`results.js:774` (normal grading) and `tennis_regrade.js:240`. So `picks.result`
stays `'win'` forever.

Every surface reading `picks` prints **WIN**. Every surface reading `mvp_picks`
prints **VOID**. That is the Tabilo screenshot, exactly.

Roughly 18 surfaces read the ledger (Rankings strip, P/L chart, history list,
sport cards, home widget, sidebar, unlock page, leaderboard house rows, CA
profile, `/results`, sport landing pages, OG cards, admin). Roughly 9 read the
board (game detail page, game popup, today's picks table, Sports tab, home #1
card, open rows on the sport cards, Tracking tab).

### 4b. The game detail page alone has three result sources

`/game/:id` resolves its pick result three different ways:

- live/today game → `picks` (`index.js:2693-2697`)
- historical game **with** a snapshot → a frozen copy of `picks` taken at first
  pitch (`index.js:2661`, `src/mvp_snapshot.js:29-31`), never refreshed, so it
  usually reads `pending` and renders no badge at all
- historical game **without** a snapshot → `mvp_picks` (`index.js:2622-2633`)

Two historical games at the same URL shape can render two different truths.

### 4c. No shared "what result should this show" helper

`isVoidedPick` / `isOutscoredVoid` exist at `public/modules/sport_cards.js:43-49`,
but `game-detail.js:925`, `modal.js:1080`, `picks.js:87`, `results_page.js:74`,
`sport_page.js:416` and `og_card.js:93` each hand-roll the check, and none of them
know about the `not counted` annotation at all.

Counted across the codebase: **8 independent implementations of "is this pick
counted"** and **10 independent P/L formulas** with default juice varying between
-110 and -115 depending on the file.

### 4d. Public records computed over different populations

`src/sport_page.js:179-196` (`/mlb`, `/tennis`, every sport landing page) has
**no score threshold and no annotation filter**:

```sql
SELECT result, COUNT(*) FROM mvp_picks
WHERE sport COLLATE NOCASE IN (...) AND result IN ('win','loss','push')
  AND COALESCE(retired,0) = 0
```

Every other public record filters `score >= 100` and excludes `not counted`. So
the "All-time MLB record" on `/mlb` is guaranteed to disagree with the same
number on the leaderboard and the CA profile popup. `src/og_card.js:83-89` has
the same gap and can print "CA PICK … WIN" on a share card for a pick the
Rankings tab excludes.

Five different filter sets exist across the record queries. The admin ROI
(`src/admin.js:727`) also puts pushes in the denominator while every public
surface uses wins + losses, so admin ROI reads lower than the site for identical
picks.

### 4e. Chart and strip disagree on the same card

- Rankings record strip (`public/modules/mvp.js:210-212`) does **not** apply the
  sport-chip filter.
- Rankings P/L chart (`:719-722`) does.

Select the Tennis chip and the strip still reports all-time all-sports while the
chart, the ROI readout and the rail all move. Same card, two records.

The history list (`:376-383`) applies neither the sport filter nor the score max,
so its per-day P/L can disagree with the chart's point for that same day.

### 4f. Multi-day windows use the wrong timezone

`_filterByDays` (`public/modules/mvp.js:105-111`) builds its cutoff from browser
local time then `.toISOString()`, producing a UTC date compared against ET
`game_date`. 1D and YD use ET correctly; **5D, 7D, 10D, 21D and 3M do not**, so
their boundary is off by a day west of UTC. Same pattern in
`home_sidebar.js:213-216` and `unlock.js:193-198`.

---

## 5. Structural hazards found (no live corruption yet)

These are latent. Each was tested against the live record and currently has zero
affected rows, but each is reachable.

- **`retired` is ignored everywhere it matters.** `src/mvp.js` honours it in the
  two read helpers only (`:19`, `:30`). The conflict resolver (`:419-422`), the
  demotion sweep (`:173-178`), and `results.js` passes 2, 3 and 4 all ignore it.
  A row restated off the record still competes for the bet slot and can void a
  live one. **This blocks the restatement: retiring the 48 rows would let them
  re-void the 8 restored ones within 5 minutes.** Must be fixed first.
- **`results.js` pass 3 can overwrite a void.** `results.js:843-858` snapshots
  the row set, then `await`s a network fetch per row, then writes
  `WHERE id = ?` with no result guard. `annotation = COALESCE(annotation, ?)`
  would preserve the `not counted` note on a row now marked `win`. Verified
  against prod: **0 rows currently affected.**
- **The conflict resolver fails open on missing games.** `mvp.js:417` reads
  `if (game && game.status === 'pre') continue;` so a pruned game has no gate,
  and the game query (`:389-393`) has no date bound. Months-old settled pairs are
  re-litigated 288 times a day.
- **Cron ordering guarantees a stale status.** `resolveConflictingMvpPicks`
  (`index.js:3537`) is synchronous and completes before the async score refresh
  (`:3550`) yields. The resolver never sees a status newer than the previous
  tick: 5 minutes stale in active hours, up to 4 hours overnight.
- **Case-sensitive identity.** `saveMvpPick` matches `pick_type` case-sensitively
  (`storage.js:802-809`) while `mvp.js` uses `LOWER(...)`. `'ML'` vs `'ml'` can
  produce two tracked rows on one bet.
- **Deletes leave no trace.** No annotation, no audit flag, no record. Unlike
  `retired=1`, which was designed to be reversible and visible.
- **Two `not counted` tests, one case-sensitive.** `public/modules/mvp.js:135`
  uses `annotation.includes('not counted')`; `sport_cards.js:45` lowercases
  first. Latent only because every note generator emits lowercase today.
- **`calcVoteReturn` has no void branch.** `public/modules/utils.js:302-309`:
  `'void'` is not push, pending or loss, so it falls through and **pays out as a
  winner**. Masked because both current callers pre-filter, but live for any new
  caller.
- **`pick_history` holds two rows per gold pick.** `src/db.js:1282-1295` inserts
  a mirror row with a synthetic negative `pick_id` on every boot; `results.js`
  only updates the real one, so the mirror freezes at its first-seen grade.
  Inflates `/api/pick-history` and the admin 30-day drift record.
- **`index.js:1441` `COALESCE(p.result, gv.result)`** makes a member's own vote
  record change meaning at the daily wipe, when the `picks` join goes NULL.

---

## 6. The audit cannot see any of this

`src/audit.js` enforces R1, R2, R3a, R3b, R4, R7, R8, R8b. There is no R5 or R6.

**No rule checks when a tracked bet was created.** `mvp_picks.saved_at`, the one
column that proves it, is never read by the audit. There is also no rule covering
deletions, and `_closeStale` will close any existing flag on a deleted row.

No test coverage exists for `saveMvpPick`, `resolveConflictingMvpPicks`,
`resolveResults`, or the audit itself.

---

## 7. Fix plan, in mandatory order

**Order matters.** Applying the restatement before step 1 would silently undo it.

1. **Make `retired` authoritative.** Add `COALESCE(retired,0)=0` to the conflict
   resolver row set, all three delete sweeps, and the `results.js` write guards.
2. **Gate the tracked-bet INSERT on game start.** Use the `gameStarted` value
   `saveMvpPick` already computes. Add the same guard to the `RECORD_SYNC_GEN`
   promotion block so a boot migration can never mint a bet on a played game.
3. **Add fast start detection.** A 20 to 30 second ESPN watcher for games in the
   start window (T-15min to T+60min) so first serve is known within half a
   minute instead of up to 5. Free: ESPN is already cached per sport. Cannot be
   a hard clock cutoff, because tennis start times are "not before" estimates
   and routinely run 30 to 90 minutes late.
4. **Gate the Discord board path** the way `source_ingest` gates scrapers.
5. **Add audit rules R5 (no tracked bet created at or after its game's start) and
   R6 (no untraced ledger deletion).** These make the class of bug self-reporting.
6. **Poll the ledger on the Rankings tab** and hold a row in the list when it is
   graded in one source but not yet the other.
7. **One board-day clock** and one score scale for the 100-point filter.
8. **One result vocabulary across surfaces.** Yellow "outvoted, not counted" with
   the reason, on the detail page as well as the Rankings list.
9. **Apply the restatement**: retire the 48 in-play rows, un-void the 8 victims,
   re-grade them.

---

## Appendix: reproducing the measurement

```
scratchpad/starts.py    # rebuild every v4-era game's start time from ESPN
scratchpad/restate.py   # diff saved_at vs start_time, emit restate_plan.json
```

`starts.py` resolved 318/318 games. Both scripts are read-only.
