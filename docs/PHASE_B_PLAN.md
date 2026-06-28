All anchors confirmed. The reports are accurate. Here is the synthesized plan.

# CappingAlpha Phase B Plan

Bet tracking, Action Network-style, with a verified-vs-manual trust moat. This document is the single source of truth. It resolves conflicts between the five research reports and gives an engineer a sequenced, executable plan grounded in the real codebase.

---

## 1. North Star: the easiest find-game → track-bet flow

**The flow:** tap a pick/game row → the game opens (modal on the SPA, bottom sheet on mobile) with the side pre-selected → tap **"Track this side."** Done.

- **1 tap** from the picks board for a verified track (the chip writes a `game_votes` row directly).
- **2 taps** with an optional stake refinement: tap "Track this side," then tap a units quick-chip (0.5u / 1u / 2u / 5u) that defaults to the user's saved `unit_size`. No typing, ever, on the common path.

This is faster than Action Network's QuickSlip (~2 taps) and Outlier (~4-5 taps) because **CappingAlpha already owns the pick, the side, and the line.** The entire verified path is a relabel of the existing vote primitive plus a units chip, not new infrastructure.

The single technical insight tying everything together: there is ONE canonical "selected side" primitive already used on every surface, the **slot key** (`home_ml | away_ml | home_spread | away_spread | over | under`). Every clickable row already computes it. The vote endpoint already snapshots odds + line per slot and grades server-side. Track Bet rides that exact rail.

---

## 2. The verified-vs-manual model

A **verified** bet is one CappingAlpha can vouch for: the user picked a real side on a real game, at the real line, locked before kickoff, with odds the server snapshotted (not typed), graded from final ESPN scores. That is exactly what a `game_votes` row already is. A **manual** bet is anything the user free-types (stake, odds, book, any selection including props/futures/parlays) for their own dollar tracking. Manual bets live in the new `user_bets` table tagged `verified=0`. They show on the user's personal "My Tracking" page but are **excluded from every ranked/credibility leaderboard.** This is the Pikkit / Juice Reel trust moat stated plainly: a user typing in their own moneyline must never inflate the public board. The split is enforced structurally, not by a flag check: the leaderboard query reads `game_votes` only, so manual bets are excluded by construction with zero leaderboard code changes.

| Surface | Data source | Counts on ranked board? |
|---|---|---|
| Ranked leaderboard (units/ROI/credibility) | `game_votes` only | Yes (verified by construction) |
| "Track this side" verified track | `game_votes` (existing vote endpoint) | Yes |
| "Custom pick" manual entry | `user_bets`, `verified=0`, `source='manual'` | No |
| Betslip photo OCR (Phase C) | `user_bets`, `verified=0` | No |
| Personal "My Tracking" / "My Action" profile | `game_votes` + all `user_bets` | N/A (personal view; manual rows tagged "Manual") |
| Future: synced/scanned verified bets | `user_bets WHERE verified=1` unioned in | Only when explicitly enabled (off in v1) |

**Decisive rules:**
- `source` is provenance (`manual | vote | scanned | synced`); `verified` is the policy bit. Rule: `verified = (source !== 'manual') ? 1 : 0`. They are separate columns on purpose, so if a "synced" book ever proves spoofable you flip policy without rewriting provenance.
- `source` and `verified` are **server-assigned, never client-supplied.** A client POST trying to set `verified:1` is ignored.
- Grading and trust are orthogonal. A manual bet the user linked to a real `espn_game_id` CAN auto-grade and still be `verified=0`. Verification is about who can vouch for the bet, not whether it can be settled.

---

## 3. Data model

### 3.1 `user_bets` (NEW, never wiped)

Modeled on the `game_votes` snapshot discipline so a bet self-grades and self-displays after the 4:58am wipe. `wipe.js` is an allowlist (`FULL_WIPE_TABLES` at `wipe.js:22`, `pruneStaleGames` at `wipe.js:43`), so a new permanent table survives by default with no `wipe.js` functional change.

```sql
-- ── user_bets — free-entry + game-linked bet tracking (Phase B) ───────────────
-- MANUAL counterpart to game_votes. A bet may be game-linked (espn_game_id set →
-- auto-graded by results.js) or purely manual (no game id → user self-settles).
-- `verified` = can this count on ranked boards. Only vote/scanned/synced are
-- verifiable; manual is personal-tracking only (the trust moat). Snapshot columns
-- let a settled bet keep its P/L + CLV after today_games is wiped. NEVER wiped.
CREATE TABLE IF NOT EXISTS user_bets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,

  bet_type      TEXT    NOT NULL,          -- ml | spread | over | under | prop | parlay | future
  sport         TEXT,                      -- MLB/NBA/.../ATP/WTA/Golf/'' (free text for props/futures)
  selection     TEXT    NOT NULL,          -- human label: "Yankees ML", "Over 8.5", "Judge 2+ HR"
  side          TEXT,                      -- home | away | over | under | null (maps to a vote slot)
  line          REAL,                      -- spread/total the bet needs (null for ml/prop/future/parlay)

  odds          REAL    NOT NULL,          -- American odds entered/snapshotted (-110, +145)
  stake         REAL    NOT NULL DEFAULT 0,-- dollars risked
  units         REAL,                      -- stake / unit_size at placement (SNAPSHOT — see §3.2)

  espn_game_id  TEXT,                      -- null for manual/prop/future/parlay
  game_date     TEXT,                      -- 'YYYY-MM-DD' ET cycle date of the event

  closing_odds  REAL,                      -- closing American odds for this side (CLV)
  closing_line  REAL,                      -- closing spread/total for this side (CLV)

  result        TEXT    NOT NULL DEFAULT 'pending', -- pending | win | loss | push | void
  payout        REAL,                      -- net profit in dollars at settle (signed; -stake on loss)
  verified      INTEGER NOT NULL DEFAULT 0,-- 1 = countable on ranked boards; 0 = personal only
  source        TEXT    NOT NULL DEFAULT 'manual', -- manual | vote | scanned | synced

  home_team     TEXT,                      -- snapshot of game header (survives wipe)
  away_team     TEXT,
  book          TEXT,                      -- sportsbook label (display only)

  notes         TEXT,
  placed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  settled_at    TEXT,

  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_user_bets_user        ON user_bets (user_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_bets_user_result ON user_bets (user_id, result);
CREATE INDEX IF NOT EXISTS idx_user_bets_grade       ON user_bets (result, espn_game_id) WHERE espn_game_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_bets_verified    ON user_bets (verified, result, settled_at);
```

`bet_type` enum: `ml | spread | over | under | prop | parlay | future`. The first four map 1:1 to vote slots and auto-grade. `prop | parlay | future` have no ESPN grading path → always `source='manual'`, user self-settles.

> **Note on Report 3's narrower schema:** Report 3 proposed a leaner `user_bets` (using `total` instead of `over/under`, no snapshot columns). **Use the Report 2 schema above** (decisive). It is the superset: snapshot columns are required for post-wipe survival, and splitting `over`/`under` keeps the 1:1 map to `evaluateVote` slots so auto-grading needs zero new logic.

### 3.2 Bankroll & units — extend `user_preferences`, add ONE ledger

Do **not** add a `user_bankroll` table. `user_preferences.unit_size` and `starting_bankroll` already exist (`db.js:414-415`), are read at `/api/account` (`index.js:886-890`) and written at `/api/account/preferences` (`index.js:974-977`). A new table would duplicate the single-row shape and force a migration.

`units` is **stored as a snapshot** on each bet (not derived live) because the user can change `unit_size` later. A bet placed at $20/unit must keep reading "1u" after they switch to $50/unit. Same discipline as `game_votes` snapshotting odds.

For bankroll-over-time (deposits/withdrawals), add one append-only ledger:

```sql
-- ── bankroll_ledger — append-only bankroll adjustments. NEVER wiped. ──────────
-- starting_bankroll (user_preferences) is the opening balance; this records every
-- change after. Append-only: corrections are a new offsetting row, never UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS bankroll_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  amount      REAL    NOT NULL,            -- signed: +deposit, -withdrawal
  kind        TEXT    NOT NULL DEFAULT 'adjustment', -- deposit | withdrawal | adjustment
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_bankroll_ledger_user ON bankroll_ledger (user_id, created_at);
```

Bankroll series at time *t*:
```
bankroll(t) = starting_bankroll
            + Σ bankroll_ledger.amount  where created_at <= t
            + Σ user_bets.payout        where settled_at <= t and result != 'void'
```
**Decision (decisive):** `bankroll_ledger` is **deferred to B5.** The curve ships in B3 from `starting_bankroll` + cumulative `user_bets.payout` only. The ledger is purely additive and lands later with no schema churn.

### 3.3 Endpoints — `/api/bets/*` (new `src/bets_router.js`)

Mount like `auth.js`/`admin.js`: `app.use('/api/bets', require('./src/bets_router'))`. Every handler gates on `req.session?.user?.id`. **None require paid tier in v1** — personal tracking is free; the moat is verification, not a paywall.

| Method | Path | Body / Query | Returns / rule |
|---|---|---|---|
| POST | `/api/bets` | `{ bet_type, sport?, selection, side?, line?, odds, stake, espn_game_id?, game_date?, book?, notes? }` | `{ bet }`. Server assigns `source`, `verified`, `units`. Snapshots `line`/`odds`/`home_team`/`away_team` from `today_games` if `espn_game_id` set. |
| GET | `/api/bets` | `?status=pending\|settled\|all&sport=&limit=&offset=` | `{ bets, total }` |
| PUT | `/api/bets/:id` | partial `{ odds?, stake?, line?, selection?, book?, notes? }` | `{ bet }`. Owner-scoped. Only while `result='pending'`; 409 otherwise. Recomputes `units`. |
| DELETE | `/api/bets/:id` | — | `{ ok:true }`. Owner-scoped. |
| POST | `/api/bets/:id/settle` | `{ result }` (`win\|loss\|push\|void`) | `{ bet }`. **Manual bets only** (`espn_game_id IS NULL`); 409 on game-linked (can't fake a real outcome). Computes `payout`, stamps `settled_at`. |
| GET | `/api/bets/summary` | `?window=week\|month\|all` | full summary object (below) |

Every `:id` route uses `WHERE id = ? AND user_id = ?`. The verified one-tap track keeps using the **existing** `POST /api/game/:id/vote` — it is unchanged.

`GET /api/bets/summary` shape (feeds the entire "My Action" profile):
```jsonc
{
  "window": "all", "unit_size": 20, "starting_bankroll": 500,
  "totals": {
    "record": { "wins": 31, "losses": 24, "pushes": 3, "pending": 5 },
    "units": 18.4, "profit": 368.0, "roi": 12.7, "win_pct": 56.4,
    "clv": { "good": 19, "bad": 12, "avg_cents": 3.1 }
  },
  "bySport":   [ { "sport": "MLB", "units": 9.2, "profit": 184, "wins": 14, "losses": 9 } ],
  "byBetType": [ { "bet_type": "ml", "units": 5.1 }, { "bet_type": "spread" } ],
  "bankrollSeries": [ { "t": "2026-06-01", "bankroll": 500 } ],
  "verifiedUnits": 11.0
}
```

### 3.4 `src/odds_math.js` (NEW) — unify three diverging payout functions

There are three near-identical American-odds payout functions, and they disagree on the missing-odds default: `leaderboard.js:29-35` and `utils.js:255-262` default **-115**; `admin.js:555-565` defaults **-110** (spread). That split is a latent bug. Create one source of truth:

```js
// src/odds_math.js — single source of truth for American-odds payout.
function americanProfit(odds, stake = 1) {
  const o = (odds == null || isNaN(parseFloat(odds))) ? -110 : parseFloat(odds);
  return o < 0 ? stake * (100 / Math.abs(o)) : stake * (o / 100);
}
function settledProfit(result, odds, stake = 1) {
  const r = (result || '').toLowerCase();
  if (r === 'win')  return +americanProfit(odds, stake).toFixed(4);
  if (r === 'loss') return -stake;
  return 0; // push | void | pending
}
module.exports = { americanProfit, settledProfit };
```
Then route `leaderboard.js voteReturn`, both `admin.js pickProfit` copies (`:555`, `:2291`), and `user_bets.js` through `settledProfit`.

**Decision on the -110/-115 conflict (decisive):** keep **votes at -115** (existing graded history — do not re-grade it) and default **manual `user_bets` at -110** (users enter real odds and rarely leave them blank). Document the divergence in `odds_math.js`. Do not silently carry two undocumented defaults. `leaderboard.js voteReturn` passes `voteOdds(v)` in, preserving its -115 branch; `user_bets.js` lets `americanProfit` apply the -110 fallback.

### 3.5 `src/user_bets.js` (NEW)

```js
const db = require('./db');
const { settledProfit } = require('./odds_math');
const { evaluateVote } = require('./results'); // newly exported

const GRADABLE = new Set(['ml','spread','over','under']);
const VERIFIED_SOURCES = new Set(['vote','scanned','synced']); // NOT 'manual'

function betToSlot(bet) {
  if (bet.bet_type === 'over')   return 'over';
  if (bet.bet_type === 'under')  return 'under';
  if (bet.bet_type === 'ml')     return bet.side === 'home' ? 'home_ml' : 'away_ml';
  if (bet.bet_type === 'spread') return bet.side === 'home' ? 'home_spread' : 'away_spread';
  return null; // prop/parlay/future — not auto-gradable
}
// createBet: server assigns source/verified/units, snapshots line/odds/teams from today_games
// listBets / updateBet / deleteBet: owner-scoped, pending-only mutations
// settleBet: manual only (espn_game_id IS NULL), computes payout via settledProfit
// gradePendingBets: Pass A (today_games) + Pass B (ESPN refetch) — mirrors resolveVotes
// betSummary: aggregates settled bets in JS via settledProfit (byte-identical to leaderboard math)
module.exports = { createBet, listBets, updateBet, deleteBet, settleBet, gradePendingBets, betSummary };
```

### 3.6 Auto-grading: fold into the existing 5-min cron

`evaluateVote` is currently private in `results.js` (exports `resolveResults, resolveVotes` at `:647`). **Export it** (one-line change) so `user_bets.js` reuses the identical grading branch (it already handles tennis via `tennis_home_games`). In `index.js`, in the 5-min results block:
```js
await resolveResults();
await resolveVotes();
await require('./src/user_bets').gradePendingBets();   // NEW — same pass, same ESPN data
```

| Bet shape | Path |
|---|---|
| `espn_game_id` set + `bet_type ∈ {ml,spread,over,under}` + `side` set | **Auto** — `gradePendingBets()` → `betToSlot()` → `evaluateVote(slot, line, game)`. Pass A = today_games, Pass B = ESPN refetch (mirrors `resolveVotes`). |
| `espn_game_id` NULL (prop/future/parlay or manual) | **Self-settle** — `POST /api/bets/:id/settle`. Never touched by cron. |

### 3.7 CLV computation

Inputs exist and are free: opening = `line_history` `recorded_at='opening'` / `line_snapshots` (5am lock); closing = `line_history` `recorded_at='current'` (last pre-kick value). **Gotcha:** `line_history` is in `FULL_WIPE_TABLES` (wiped 4:58am), so closing must be **snapshotted onto the bet at settle time** — that's why `user_bets` has `closing_odds`/`closing_line` and `captureClosing()` runs inside `gradePendingBets()` Pass A while the game is still fresh.

- **ML / totals (price CLV):** `impl(o) = o<0 ? (-o)/(-o+100) : 100/(o+100)`; `clv_prob = impl(closing_odds) - impl(bet.odds)`. Good bet when `clv_prob > 0`. `avg_cents = mean(clv_prob * 100)`.
- **Spread / total (line CLV):** compare the number you got vs the number that closed, in your favor. Good bet when `clv_line > 0`.

CLV is derived in `betSummary()`; only bets with non-null `closing_*` contribute (manual no-game bets simply have no CLV, which is correct).

### 3.8 Leaderboard exclusion rule

`leaderboard.js` ranks purely off `game_votes` + the house off `mvp_picks`. `user_bets` does not touch it, so **manual bets are excluded by default.** Required action: add a comment at `leaderboard.js:51` ("ranked boards are votes-only; user_bets manual rows are excluded by policy") so no one later "helpfully" adds manual bets. The `verified=1` union helper is spec'd but **off in v1.**

### 3.9 Harden `isPaid()` (prerequisite correctness fix)

`isPaid()` (`auth.js:451`) ignores `subscription_expires` and trusts a stale session `user.tier`. A lapsed sub with no Stripe event still reads as paid. Fix to check the DB and honor expiry (NULL expiry = lifetime/comp), parsing the sqlite datetime string the same way `wipe.js:37` / `results.js:455` do (append `T...Z`). One indexed PK lookup per call — negligible. Do this before any paid-gated analytics; v1 tracking is free, so it is not a B1 blocker but is a real bug worth fixing early.

---

## 4. Frontend

All new visuals reuse an existing class or the `_drawChart`/`_recordBarHtml`/`_filterByDays` helpers, stay on `var(--...)` tokens (dark/light just works), and keep the humble no-em-dash voice.

### 4.1 Track-Bet FAB + bottom sheet + manual form

**FAB placement (decisive — resolves Report 3 vs Report 4):** the "+" lives in the **center slot of the mobile bottom tab bar** (raised green, Action Network pattern), NOT a free-floating corner FAB. A corner FAB collides with modal close buttons and home-sidebar cards. On desktop, render a small green "+ Track Bet" pill bottom-right (no tab bar there). Gate on `isAccount()` — logged-in only.

**Bottom sheet** (`openTrackSheet()`), reuses the `.modal-overlay` machinery (dim + `stopPropagation`), docked to the bottom on mobile. Three rows mirror Action Network:
- **From a game** → jumps to the existing game-search list (already loaded on Sports tab); choosing a slot prefills odds from `today_games` → verified path stays verified.
- **Custom pick** → opens the manual form below → `user_bets`, `verified=0`.
- **Upload betslip** → disabled stub, "Coming soon" (Phase C OCR).

**Manual form** (`.settings-field` + `.field-prefix-wrap` for `$`, segmented `.bet-seg` controls): selection, bet type (Moneyline/Spread/Total/Prop), line (hidden for ML), odds (default -110), stake ($-prefixed, default = `unit_size`), book chips, date, result segmented. Live payout preview under Odds ("To win $X · Returns $Y") via `americanProfit`. Footer note (humble, no em dash): "Manual bets show on your own tracking. They are not added to the verified leaderboard." POSTs to `/api/bets` with no client-set verified flag.

### 4.2 My Tracking modules (priority order, top to bottom)

A single **timeframe segmented control** (Yesterday / Last 7 / Last 30 / All Time) at the top re-filters every module below via `_filterByDays` (`mvp.js:45`) + a `window._trackingRange`. Module order:

| # | Module | Backend needed | Reuses |
|---|---|---|---|
| 1a | Timeframe filter | none | `.graph-range-row`/`.graph-range-btn`, `_filterByDays`, `setGraphDays` pattern |
| 1b | Units/Dollars toggle (on P/L graph) | none | `.theme-toggle`/`.theme-opt`, `calcVoteReturn(v,1)` vs `(v,unit)` |
| 1c | Net-units timeframe strip (scroll-snap cards) | none | `.track-stats` → new `.track-strip` (swipeable on phone) |
| 1e | Hot Streak (days) + Best Week | none | `.track-stat` cards; group resolvedVotes by ET date |
| 1f | Bankroll-over-time graph | none (uses `starting_bankroll`) | `_drawChart('bankroll-chart', …)` |
| 1g | Breakdown by League | none | `.record-bar` / new `.brk-row`, `sportBadge()` |
| 1h | Breakdown by bet type (ML/Spread/Total) | none | shared `renderBreakdown(rows, title)` |
| 1d | CLV (value saved, % beat close, Good vs Bad) | `closing_odds` on `game_votes` + `clv` in `/api/account` | `.track-stats` + new `.clv-split` bar |

Everything except CLV ships client-side off votes already returned by `/api/account`. CLV needs the closing-line snapshot (capture in the `espn_live` status transition, no extra Odds API credits) and a `clv` object added to `/api/account`. Once `user_bets` ships, the breakdowns and bankroll series merge `bets` into the same ordered series; the Props/Futures rows in 1h light up. Manual rows render with a grey "Manual" tag; verified rows get a badge — the existing verified note at `account.js:474` becomes the live legend.

### 4.3 Settings restructure (Action Network grouping)

Keep the two-column `.account-layout`; reorder cards into AN's mental model and add two:

| Order | Card | Status |
|---|---|---|
| 1 | Profile | exists (add bio/state/birthday later) |
| 2 | **My Accounts / Default Odds** | NEW — ship the Default Odds picker now (real: `default_odds` pref ∈ consensus/draftkings/kalshi/polymarket, added to the `/api/account/preferences` allowlist at `index.js:953`); book-linking list is a "Soon" stub |
| 3 | Bankroll & Units | exists — move up under Accounts |
| 4 | Appearance | exists |
| 5 | Notifications | NEW — UI-only toggles, "Coming soon" |
| 6 | Favorite Sports / Teams | exists |
| 7 | Privacy (Leaderboard) | exists |
| 8 | Access / Plan | exists |
| 9 | Password | exists |

---

## 5. Mobile

**Bottom tab bar: YES (decisive).** Add a 5-slot fixed bottom tab bar at `≤768px`: **Home · Rankings · Track (+) · Sports · Tracking.** The center is the raised green "+" FAB. Keep the hamburger drawer as the **secondary overflow** (About, Leaderboard, Settings, Support, Logout) — trim its items to that long tail. Today every destination is 2 taps (open drawer → pick); the tab bar makes primary nav 1 tap and puts Track-Bet permanently in the thumb zone.

- The `.ca-tabbar` buttons call the **existing** `switchTab(name)` / `openTrackSheet()` — one nav contract, no new router. Add one line to `switchTab()` (`app.js:45`) to toggle `.ca-tabbar-item.active`. This maps 1:1 onto a native Capacitor tab bar later (CSS-hide the web bar when `Capacitor.isNativePlatform()`).
- **Game modal → bottom sheet on `≤768px`** (CSS-only in the existing `@media (max-width:768px)` block, `index.html:885`): `align-items:flex-end`, `border-radius:16px 16px 0 0`, `max-height:92vh`, grab-handle, keep tap-scrim-to-close.
- **Stake chips** (`0.5u · 1u · 2u · 5u · Custom`) in a sticky `.track-sheet-cta` above the home indicator, computing dollars live from `unit_size`. This removes the keyboard from the hot path entirely (Custom is the only keyboard surface — note the Capacitor Android keyboard-resize gotcha for later).
- **Tap targets:** 44-48px floor. Tab items / FAB / chips / CTA already set `min-height`. Audit `.sport-tab-btn` and `.graph-range-btn` to clear ~44px on mobile. Pad `.ca-home-grid` bottom by the tab bar height so footers aren't hidden.
- **Safe area:** use `env(safe-area-inset-bottom)` (with `0px` fallback) on the tab bar, sheet card, and CTA. `viewport-fit=cover` is already set.
- **Kill the top-right popover on phones:** route the mobile avatar to the drawer account section (`toggleDrawerAccount()`) instead of `.account-dropdown` — one `matchMedia('(max-width:768px)')` conditional in `toggleAccountMenu()`.

---

## 6. Integration points (where Track-Bet CTAs hook in)

**First:** promote `pickSlotKey` (`picks.js:50-58`) to `utils.js`; import in `picks.js`, `modal.js`, `sports.js` (they each re-derive it inline today). Build one helper `openTrackBet({espn_game_id, slot, ...prefill})` and attach at every slot-aware site. Pick objects carry `pick_type/team/spread/is_home_team` but **not odds** — pass `{espn_game_id, slot}` and let the Track sheet read odds/line from `today_games` (the same columns the vote endpoint snapshots at `index.js:1315-1325`).

| Surface | File:line | Hook |
|---|---|---|
| **Standalone detail vote column** (the hub) | `public/game-detail.js:898-926` (`mkVcBtn`), col at `:936` | Primary "Track this side" button. Has `_activeSlot`, `gameId`, `thisLabel`, `slotLineCurrent(_activeSlot, game)` (`:882`), full `_data.game.*`. Default → `handleVoteChoice(gameId, _activeSlot)` (verified, `:972`); "+ stake/book" → manual sheet prefilled. Relabel copy at `:913/920/921` + `:1585-1596`. |
| **Modal vote buttons** (SPA popup) | `public/modal.js:858-866` (`voteSection`); `voteOnSlot` `:882` | Same "Track this side" beside vote buttons; relabel "Vote" → "Track (verified)". Best odds prefill on the site (`game.*` full odds). |
| **Modal ticker chip** | `public/modal.js:270` (`.ticker-chip`); active slot `:222-241` | Optional inline Track on the active chip. |
| **Ranked pick row** | `public/picks.js:60` (`makeRow`); slot `:68`; row `:92` | Small `+1u` Track affordance → `openTrackBet({espn_game_id, slot: pickSlotKey(p)})`. |
| **Schedule row / Tennis match row** | `public/sports.js:106` / `:132` | Game-level (no side) → route to detail, pick side there. |
| **Tennis Top Picks chip** | `public/sports.js:204`; slot `:199-201` | `+1u` Track affordance. |
| **Home Top Games / My Sports tiles** | `public/home_top.js:212` (`_gameTile`) | Keep tile click → detail (shortest); optional corner Track icon using `g.top_pick`'s slot. |
| **Home sidebar #1 pick / game row** | `public/home_sidebar.js:144` / `:367` | Keep → detail page. |
| **Golf pick row** | `public/sports.js:70` (`openGolfModal`) | Separate manual flow (`player_name`/`vs_player`, no vote slot). |

**Backend hooks:** `app.use('/api/bets', …)` in `index.js`; `gradePendingBets()` into the 5-min cron; export `evaluateVote` from `results.js`; `user_bets` + `bankroll_ledger` in `db.js` (after the `pick_history` block, ~`db.js:804`, `try{}catch(_){}` idiom); comment-only note in `wipe.js` near `FULL_WIPE_TABLES`.

---

## 7. Sequenced milestones

Smallest-valuable-first. The minimum-tap track flow + `user_bets` MVP ship first.

| Milestone | Scope | Acceptance check |
|---|---|---|
| **B0 — Plumbing** | Promote `pickSlotKey` to `utils.js`; create `src/odds_math.js` and route `leaderboard.js`/`admin.js` payout through `settledProfit`; export `evaluateVote` from `results.js`; harden `isPaid()`. | Leaderboard numbers unchanged after refactor; `isPaid()` returns false for a sub with a past `subscription_expires`. |
| **B1 — Verified one-tap track** | Relabel modal + detail-page vote buttons to "Track this side (verified)"; add units quick-chips defaulting to `unit_size`. No new backend (reuses `game_votes`). | From a pick row, tap the game → tap "Track this side" → a `game_votes` row is written and the side shows tracked. 1-2 taps, zero typing. |
| **B2 — `user_bets` MVP + Custom pick** | `db.js` tables; `src/user_bets.js`; `src/bets_router.js` (`POST/GET/PUT/DELETE/settle/summary`); FAB + bottom sheet + manual form; `gradePendingBets()` in the 5-min cron. | A manual custom pick saves to `user_bets verified=0`, appears on My Tracking, and is absent from the leaderboard. A game-linked manual bet auto-grades when the game finalizes. |
| **B3 — My Tracking "My Action" build-out** | Timeframe filter, Units/Dollars toggle, net-units strip, Hot Streak/Best Week, bankroll-over-time, By League + By Bet Type breakdowns. Client-only off votes + bets. | Switching timeframe re-filters every module; bankroll curve renders from `starting_bankroll` + cumulative payout. |
| **B4 — Mobile bottom tab bar + sheet ergonomics** | `.ca-tabbar` (5 slots, center FAB), `switchTab()` active-state line, drawer trimmed to overflow, game modal → bottom sheet on `≤768px`, stake chips sticky CTA, mobile avatar → drawer. | On a phone, primary nav is 1 tap; Track sheet opens from the center "+"; the find-game → track flow is ≤2 taps with no keyboard. |
| **B5 — CLV + Settings restructure** | Closing-line snapshot on `game_votes` (capture in `espn_live` status transition) + `clv` in `/api/account`; CLV module on My Tracking; Settings reorder + Default Odds picker (real) + Notifications/Profile-extras stubs; optional `bankroll_ledger`. | CLV "value saved / % beat close / good-vs-bad" renders for graded games; Default Odds pref persists and changes the reference line shown. |
| **B6 (Phase C) — BetScan OCR** | "Upload betslip" → parse via the existing Haiku reader path → prefill the manual form → `user_bets verified=0`. | A betslip screenshot prefills selection/odds/stake; user confirms; saved as manual. |

---

## 8. Risks / decisions for Jack

| Topic | Recommendation (decisive) |
|---|---|
| **Harden `isPaid()` expiry** | Fix now in B0. It's a real correctness bug (lapsed sub still reads paid). Cheap (one PK lookup). Prerequisite to any future paid-gated analytics. |
| **Rename "vote" → "track"** | Yes. UI relabel only — the `game_votes` table, endpoint, and grading stay. "Track this side (verified)" reads better and unifies the mental model. No data migration. |
| **Bottom tab bar** | Yes, 5-slot with center "+" FAB at `≤768px`; drawer becomes overflow. Biggest single mobile usability win and the exact pattern Action Network uses. |
| **FAB: corner vs tab-bar center** | Tab-bar center (resolves the Report 3 corner-FAB vs Report 4 tab-bar conflict). Corner FAB collides with modal close + sidebar cards. |
| **Missing-odds default (-110 vs -115)** | Split: votes stay **-115** (don't re-grade history), manual `user_bets` default **-110**. Documented in `odds_math.js`. Do not carry two silent defaults. |
| **Verified bets on the ranked board** | Off in v1. Board stays `game_votes`-only. The `verified=1` union helper is written but not called — the moat is satisfied by `user_bets` simply being absent from `rankAll()`. |
| **`bankroll_ledger` now vs later** | Later (B5). Curve works from `starting_bankroll` + cumulative payout. Additive, no schema churn to add it. |
| **Odds API deep links ("Bet at book")** | Add `includeLinks=true` + `includeSids=true` to the existing 5am/4pm `odds_api.js` calls — **zero extra credits** (cost is markets × regions). Store per-outcome betslip link on the slot; surface a "Bet at [DraftKings]" button in the modal. This is the affiliate-revenue lane. Schedule as a fast-follow after B2 (optional, not blocking). |
| **BetScan OCR** | Phase C (B6) via the existing Haiku reader path, not a new dependency. Stub the button now; build later. Lands in the unverified bucket regardless, so it ranks last. |
| **`user_bets` schema (Report 2 vs Report 3)** | Use the Report 2 superset (snapshot columns + split over/under). Required for post-wipe survival and zero-new-logic auto-grading. |