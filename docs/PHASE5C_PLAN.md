# Phase 5c Plan: Sports Rework (per-sport pages + nav dropdown + line board)

Jack's locked decisions (2026-07-06):
- Every sport gets a REAL server-rendered URL (cappingalpha.com/mlb, /nba, /soccer, ...) like the game detail pages. SEO-indexable, shareable.
- Sports list: the core 10 (MLB, NBA, WNBA, NHL, NFL, NCAAF, CBB, Tennis, Golf, Soccer) plus UFC/MMA. 11 pages.
- The SPA Sports tab is REPLACED: the top nav "Sports" becomes a dropdown (same pattern as About) listing ALL sports year-round, not just today's. Clicking a sport goes to its page. Mobile drawer gets a matching expandable Sports group.
- Nav click behavior (About and Sports alike): first tap opens the dropdown, tapping the header item inside navigates.
- Tailer analytics: OUT of 5c entirely (data keeps collecting via game_votes.tailed_pick_id; display work parked).
- The line-shopping board lives INSIDE each sport page (per-sport best-price board), not as a separate tab.

## Each sport page contains (all data already flows; zero new costs)

1. **Headlines for that sport** — headlines.js filtered by sport.
2. **Today's games** — today_games rows for the sport (engine_events for MMA/Boxing), linking to each game's detail page.
3. **Line-shopping board** — per market (ML/spread/total), best price across all books from book_lines + ESPN DK + prediction markets; offshore tagged; book labels through one helper for future affiliate links.
4. **MVP picks for that sport** — mvp_picks filtered by sport, recent + record.
5. **Sport info** — short static blurb per sport (how we cover it, what markets exist, bonus rules).

## Build order

- src/sport_page.js — buildSportPageHtml(sportKey): one data-driven template for all 11 (reuse detail_page.js buildNav + esc patterns). Per-sport INFO map for blurbs.
- index.js — GET /:sportSlug routes from an explicit allowlist (mlb, nba, wnba, nhl, nfl, ncaaf, cbb, tennis, golf, soccer, mma). Must not shadow /faq, /privacy, /game/:id, /:sport/:slug detail routes (register before /:sport/:slug, after static pages).
- Nav (index.html + app.js + detail_page.js buildNav + game-detail pages): Sports dropdown desktop + drawer group; remove the SPA Sports tab button; sport pages linked. Keep switchTab('sports') working for old deep links by redirecting to /mlb (or the user's favorite sport).
- Tennis page combines ATP+WTA; MMA page reads engine_events + Kalshi event odds (kalshi_events.js) since no today_games rows exist.
- Sitemap/robots: add the 11 URLs. JSON-LD SportsOrganization/CollectionPage per page.

## Verify pattern (unchanged)

Preview server (launch.json autoPort), throwaway @example.com accounts, adversarial review Workflow before commit, pm2 restart after src/ changes, delete test users. Ship gate stands: bet-tracking branch only.

## Then: Phase 6 (/security-audit gate), Phase 7 (Capacitor app)
