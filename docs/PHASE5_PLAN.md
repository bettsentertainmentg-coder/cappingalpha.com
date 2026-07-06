# Phase 5 Plan: Parlay Legs + Social Loop

The next tracking phase after 4a-4e (engine, ops console, soccer, betslip compare, vote-to-betslip). Everything here is zero marginal cost per the standing rule. Written so a fresh session can execute without prior context; pair with docs/TRACKING_ROADMAP.md and docs/MAC_SETUP.md.

## 5.1 Parlay legs

Today `user_bets.bet_type='parlay'` is a single row with one combined odds number, self-settled, never auto-graded (`betToSlot()` returns null for parlays).

- **Schema:** new `bet_legs` table: id, bet_id (FK user_bets.id), espn_game_id (nullable), sport, selection, bet_type (ml/spread/over/under/prop), side, line, odds, result (default 'pending'). Never wiped. Index on (bet_id), (result, espn_game_id).
- **Combined odds:** product of decimal odds of legs, converted back to American, shown live in the builder. Push/void legs drop out of the product and the parlay re-prices (standard book behavior).
- **Grading:** extend `gradePendingBets()` (src/user_bets.js): grade each pending leg with the existing `evaluateVote()` path (game-linked legs only; prop legs stay manual). Parlay result: any leg loss = loss; all decided legs win = win; pushes re-price. Settle payout from the re-priced combined odds. Push notifications already fire from the same spot.
- **Builder UI (track.js):** on the betslip confirm slide, an "Add another leg" button switches the sheet into parlay mode: a leg list grows as the user taps more lines from the board (back to Board keeps the slip). Custom form gets the same. Verified status does not apply to parlays (personal only, like today).
- **Watch out:** the soccer draw rule (draws lose 3-way MLs) applies per-leg. Same-game parlays: allow but do not correlate-price; just label them SGP in the row.

## 5.2 Tail a capper

- Tail button on ranked pick rows + game detail pick panel -> `openTrackForSlot(espn_game_id, slot)` (already built in track.js, used by the detail page vote buttons). Add a `tailed_pick_id` column on game_votes to attribute the tail.
- Profiles/leaderboard: "tailers" count per capper; tailer-vs-capper realized ROI (the capper's line vs the odds the tailer actually got = tail slippage). Nobody in the market measures this; it fits the accountability brand.

## 5.3 Share a win

- Canvas-rendered card for a settled bet (selection, odds, stake or units, result, CA branding), Web Share API with download fallback. Entry point: bet detail sheet + a share icon on won bets in history. No servers involved; pure client.

## 5.4 Profile depth

- Capper CLV card on member profiles (closing odds already captured on votes; clvOf() in account.js is reusable).
- Best Book card: per-user win rate by `user_bets.book`.

## Prereqs already in place (do not rebuild)

- `openTrackForSlot(id, slot)` in track.js: opens the sheet at a line's confirm slide from any page that loads the module + /track-sheet.css (see detail_page.js for the include pattern).
- `ca:tracked` CustomEvent fires on every successful track; host pages listen to update counts in place (game-detail.js has the reference implementation).
- Book compare table + BOOK_LABELS + OFFSHORE_BOOKS in track.js; 9 books flow via the odds engine.
- Local dev: /api/games and /api/game/:id are served locally (engine books + soccer visible); pick context merges from the prod mirror when local picks are empty (index.js, MIRROR_URL block + /api/game handler tail).

## Verify pattern for this phase

Preview server (launch.json, autoPort) + a throwaway @example.com account; parlay grading via seeded game-linked legs on finished games in data/capper.db; delete test users after. pm2 restart capperboss after any src/ change.
