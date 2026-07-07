# Phase 5c Plan: Line-Shopping Board + Tailer Analytics

The last feature batch before the Phase 6 security gate. Both halves consume data that already flows; nothing new is scraped and nothing costs money. Written so a fresh session can execute without prior context. Pair with docs/TRACKING_ROADMAP.md; prior-phase reference in docs/PHASE5_PLAN.md.

## 5c.1 Public line-shopping board (roadmap task #18, the Phase 4 leftover)

A public "Lines" surface: every game today, best price per market across all books we carry. This is the free-for-everyone traffic hook; the betslip compare table (already shipped) is the per-pick version of the same idea.

- **Data**: book_lines has 9 books per game (engine) + today_games ESPN DK columns + kalshi_cache/polymarket_cache implied. All served by getLinesForGame(). A one-query board endpoint: GET /api/lines-board returns per game { matchup, sport, start, per-market rows: { market, side, best: {book, odds/line}, spread of prices } }. Compute best by decimal odds (reuse odds_math.americanToDecimal server-side).
- **UI**: new "Lines" tab or a section under Sports. Table per sport: game rows, ML/spread/total columns showing the best price + book logo/label, tap opens the game detail (or openTrackForSlot to track it). Offshore tag rules identical to game-detail.js OFFSHORE set. Mobile: horizontal scroll inside the card, never the page.
- **Affiliate hooks**: render book labels through one helper so affiliate deep links can be added later in one place. No links yet.
- **Free for everyone**: no paywall on this tab. It is the marketing surface.

## 5c.2 Tailer analytics (5.2b, data foundation shipped in Phase 5)

game_votes.tailed_pick_id is already auto-set on every verified track that matches a scanned pick, and /api/game returns a per-pick tailers count.

- **Tailers on pick rows**: show "N tailing" on ranked pick rows (picks.js) and the game-detail pick panel when count > 0.
- **Tail slippage**: for each tailed vote with user_odds, slippage = implied(user_odds) - implied(pick's line at scan, from line_snapshots/score_breakdown context). Aggregate per capper: "tailers of X average -4 cents vs the posted line". Surface on the capper leaderboard profile card.
- **Tailer P/L**: reuse the vote grading that already exists; group graded tailed votes by the pick's capper (picks -> capper_history mapping) for a "what tailing X actually returned" line on capper profiles.
- Keep it read-only aggregation: no new writes beyond what Phase 5 already stores.

## 5c.3 Small carry-alongs

- Custom-bet selection escaping sweep flagged in Phase 5 review (renderBets bet-row-sel renders unescaped; esc() already exists in track.js) - fix while touching the file, do not wait for Phase 6.
- Betslip schedule fight rows: if Bovada engine_events and Kalshi disagree on a fight's existence, nothing breaks (strip simply doesn't match); no work needed, just a note.

## Then: Phase 6 (security audit gate) and Phase 7 (Capacitor app)

- Phase 6: run the full security audit (/security-audit) across auth, admin, relays (HMAC), the new bets/legs/votes endpoints, XSS sweep of every innerHTML sink, rate limiting on POST /api/bets. Fix everything it confirms. This is the gate before any public ship.
- Phase 7: Capacitor app per docs/TRACKING_ROADMAP.md (token auth path, bundled frontend, push reuse, 18+ gate). App-store fees are the single allowed cost.

## Verify pattern (unchanged)

Preview server via launch.json (autoPort), throwaway @example.com accounts, sqlite seeding for graded scenarios, adversarial review Workflow before commit, pm2 restart capperboss after src/ changes, delete test users after. Ship gate stands: commit + push bet-tracking only; nothing to master without Jack's explicit go-ahead.
