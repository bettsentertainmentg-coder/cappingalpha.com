# CappingAlpha Bet Tracking Roadmap

This is the product roadmap for My Tracking: where we stand against Action Network, Pikkit, Betstamp, and OddsJam, what we build next, and in what order. It synthesizes the competitive research, the codebase rough-edges audit, and Jack's decisions on free bets, sportsbook sync, the CA Odds Engine, the free data strategy, and the app path. When this doc and older research disagree, this doc wins.

---

## 1. Where We Stand

| Dimension | CappingAlpha | Action Network | Best Competitor | Verdict |
|---|---|---|---|---|
| Entry friction (from a pick) | One tap from a ranked pick or game modal into a prefilled betslip, Risk/To Win sync, book chips | Scoreboard tap, betslip, Track Bet | Betstamp tap-to-track from odds screen | WE WIN (nobody else starts from a scored, ranked pick) |
| Entry friction (off-app bets) | Manual custom form only; "Upload betslip" is a disabled stub | BetScan screenshot OCR + Playbook AI | Pikkit auto-sync (30+ books) | MISSING (OCR lands in Phase 3) |
| Sportsbook sync | None, and staying that way (see What We Deliberately Skipped) | BetSync (shrunk to BetMGM + bet365, breaks often) | Pikkit BookSync | SKIPPED ON PURPOSE (AN's #1 churn source; OCR + fast manual covers it) |
| Bet types | ML, spread, O/U, prop, parlay, future; parlays have no legs, no SGP/teaser/round robin | Straights, props, parlays, SGP, teasers, futures, free bets | Same as AN | GAP (parlay legs is the big one, Phase 5) |
| Grading | Auto two-pass (today_games then ESPN fetch), self-service re-settle on manual bets | Auto-grade broader markets; wrong grades require a support email | Pikkit misgrade detection | PARITY core, WE WIN on self-service regrade, GAP on prop/parlay auto-grade |
| Analytics | Units, ROI, record, win %, hot streak, best week, CLV (verified), sport/type breakdowns, 4 timeframes | Same set plus prop split; CLV counts all bets | OddsJam: CLV vs Pinnacle, EV tracking, odds-band splits | PARITY vs AN, GAP vs OddsJam depth (closed in Phase 2) |
| Graphs | Cumulative P/L line ($ or units toggle), MVP P/L graph | No marketed equity curve | MyBankroll calendar heatmap, Bet Metrics Lab drawdown curves | WE WIN vs AN, GAP vs specialists (closed in Phase 2) |
| Social | Leaderboard (flat 1u, volume gates), follow/friends, member profiles, sentiment votes | Follow tab, tail tracker with counts, share ticket graphics, public profile URLs | JuiceReel verified picks marketplace | PARITY on core, GAP on tailing and shareables (Phase 5) |
| Live | Live scores, live value pulse (MLB only), live odds marker in betslip | Live win probability per bet all sports, iOS Live Activities | Pikkit live sweat views | GAP |
| Notifications | Settings stub says "Coming soon" | Full suite: bet results, line moves, expert picks, scoring plays | Betstamp pick alerts | MISSING (real in Phase 3 via PWA push) |
| Mobile | Responsive web, tab bar, FAB, safe-area CSS; no app, no push | Native iOS/Android, award-winning UX | Pikkit/Betstamp native apps | GAP (path is clear: PWA then Capacitor) |
| Trust model | Verified-within-range at track time, leaderboard 1u flat, immutable verified votes | BetSync verified badge, but synced losses were deletable and imports corrupted records | Betstamp: immutable + odds-must-exist | WE WIN vs AN, PARITY with Betstamp (the gold standard) |
| Line shopping | ESPN DK refresh + 2/day Odds API pulls; single-book view | Odds pages across major books, affiliate-driven | OddsJam full odds screen | GAP today, WE WIN after Phase 4 (CA Odds Engine, free for everyone) |
| Price | Tracking free; picks $1/day, $4/wk, $75/yr | Tracker free but ad-bloated; PRO $24.99/mo, custom bets paywalled | Pikkit free core, Pro $40/mo | WE WIN on price positioning |

---

## 2. Our Unfair Advantages

1. **Third-party capper accountability.** The competitor research names this the #1 white space: everyone verifies their own bets, nobody independently grades what cappers publish without opt-in. Our Discord scan, score, grade, permanent capper_history pipeline is exactly that lane. AN cannot copy it without becoming an anti-tout watchdog against their own expert content business.
2. **Betstamp-grade trust model, already built.** Verified means the odds existed within range at track time, verified votes are immutable, the leaderboard is flat 1u with volume gates, closing lines are captured. AN's trust story collapsed (deletable verified losses, corrupted imports). Ours is structurally sound on day one.
3. **One-tap track from a ranked pick.** The content-to-tracker loop AN monetizes at $24.99/mo, we do from a scored pick at $4/wk. Nobody else has a proprietary score attached to the thing you track.
4. **Free CLV.** Full closing odds/line capture on both votes and bets, computed in betSummary. Pikkit gates CLV behind $40/mo Pro, OddsJam behind $79+/mo. Free plain-English CLV is unclaimed territory.
5. **Prediction-market lines.** Polymarket/Kalshi implied-line fallback means votes can lock and grade even when books post nothing. No tracker we found does this.
6. **Free enrichment stack.** Public betting % (which AN paywalls at PRO), line history, injuries, weather, win probability, all at zero marginal cost. We can give away what AN sells.
7. **Own odds infrastructure (coming).** The CA Odds Engine (Phase 4) turns line shopping from a per-call cost into an in-house asset, the same way the local Ollama reader turned pick extraction free.

---

## 3. UI Improvements (ranked)

Grounded in the codebase rough-edges list and AN complaint mining. Record integrity and clutter are what users leave AN over; those come first. Items 1 through 12 are Phase 1 work.

1. **Fix free-bet accounting (S).** Skipping free-bet losses distorts the record, the exact record-integrity failure that hurt AN's trust. Decision made: a free-bet loss counts in the W-L record at 0 P/L. Show a Free tag and a free-bet W-L line. Copy: "A loss costs nothing but still counts in your record."
2. **Explain verified vs custom decisions (S).** VERIFY_TOL 9% is invisible today. When a bet lands off-range, show the reason: "Your odds (-135) are outside the book range (-118 to -125), so this tracks as a personal bet." AN's opaque grading with email-only recourse is complaint #3.
3. **De-overload the bolt icon (S).** One icon currently means free bet, live odds, and the free-bet toggle. Give live odds a distinct treatment (pulsing dot or LIVE tag) and keep the bolt for free bets only.
4. **Book chip clarity (S).** Render "Over 9 · -117" not "o9 · -117". Same for spread chips.
5. **Bet history search and date range (M).** Text search plus date picker plus book filter, and a load-more past the 300-bet cap. "Find that Dodgers bet from last week" should be instant. (Ships in Phase 3 with the history work.)
6. **Live-refresh the odds board (S/M).** The board loads once and goes stale; stale odds are AN complaint #7. Poll every 30 to 60s while the confirm sheet is open, flash the changed number. (Phase 3; Phase 4 makes the underlying data much fresher.)
7. **Mobile polish pass (S/M).** 48px targets everywhere, truncate long selections, scroll hint on the sport dropdown, focus trap and arrow keys in overlays. This also pays down App Store Guideline 4.2 risk later. (Phase 3.)
8. **Feedback states (S).** Toast queueing, Save button spinners, disabled-while-pending submits. Rapid taps currently double-fire.
9. **Unit size preload (S).** Fetch the preference at app boot, not on Tracking tab open, so the FAB flow never defaults to the hardcoded $20.
10. **Empty states that teach (S).** Zeroed stat cards with no context confuse new users. "Track your first bet to start your record" with a button beats a dash.
11. **Sport filter reset (S)** when the last matching bet settles away.
12. **Proper confirm component (S)** to replace the innerHTML two-step delete.
13. **Keep it uncluttered (ongoing).** A named reason people quit AN is affiliate and article noise inside the tracker. My Tracking should never grow promos. The Phase 4 line-shopping board carries affiliate deep links, but they live on the odds board, not inside a user's record.

---

## 4. Analytics Roadmap

Best-practice demand order across the tracker market: CLV, cumulative units, ROI splits, win rate vs breakeven, EV vs actual, drawdown, flat vs actual, calendar heatmap.

| Order | Feature | Backend status |
|---|---|---|
| 1 | Hero chart upgrade: flat 1u overlay vs actual stakes, shaded max drawdown | Ready. Both 1u and personal-wager math exist (buildItems); drawdown is pure computation |
| 2 | Win rate vs breakeven per odds band | Ready. odds stored on every bet and user_odds on votes; breakeven is arithmetic |
| 3 | CLV upgrade: plain-English card, per-bet distribution histogram, CLV trend | Ready for ML and O/U (closing_odds captured). Needs a column for spreads: closing spread odds are a hardcoded -110 convention today, store real juice at grade time |
| 4 | Calendar heatmap (daily net units, tap a day to see its bets) | Ready. placed_at / voted_at / settled_at all stored |
| 5 | Bankroll over time | Mostly ready. bankroll_ledger table + starting_bankroll pref exist, betSummary already returns bankrollSeries; the UI was never built. Finish the started feature |
| 6 | Splits tabs: book, day of week, time of day, live vs pregame, home/away, fav/dog | Ready but derive. book/placed_at stored; live vs pregame derivable from placed_at vs start_time; fav/dog from odds sign. Needs indexes: user_bets(sport), user_bets(placed_at), game_votes(user_id, voted_at) |
| 7 | Worst streak / longest drawdown / time underwater panel | Ready. Mirror of the hot-streak math |
| 8 | Expected vs actual units (CLV-based EV proxy, the "good or lucky" chart) | Ready-ish. Computable from captured closing odds; no Pinnacle feed needed for v1 |
| 9 | Best Book card + capper CLV on member profiles | Ready. book field and vote closing odds already exist, never surfaced |
| 10 | Parlay legs | Needs schema. New bet_legs table (bet_id, selection, odds, espn_game_id, result) plus leg-aware grading. Do last (Phase 5) |

One global filter bar (date range, sport, type, book) across all charts, the most-praised pattern at Pikkit.

---

## 5. Free Data Strategy

Confirmed principle: open stats, data, and tracking to everyone. Only ranked picks 2 through 50 stay paid. Data pulls users in; the score is the product.

- **Public betting % free.** AN paywalls money % and the bets-vs-money diff at $24.99/mo. We already scrape it and it costs nothing. Surface tickets vs money splits in the game popup and detail page for everyone. This is the single loudest "switch to us" hook.
- **Free CLV for everyone who tracks.** Copy direction: "You beat the closing line on 58% of your bets. That usually means you are getting good numbers."
- **Prediction market vs book line free.** Show Polymarket/Kalshi implied odds next to the book line; flag notable gaps.
- **Line shopping free (Phase 4).** Best price across books per pick, powered by the CA Odds Engine, free for all users, monetized with affiliate deep links per book.
- **Form snapshot free, depth paid.** L5 record and streak in the popup for all; full 10-game splits and player form stay paid.
- **Headlines and game data free.** Injuries, weather, pitchers, line movement are already free; keep it that way, it is SEO surface.
- **Capper social proof free.** Top 3 capper records (from capper_history) on the home page. Whose picks those are today stays paid.
- **Tracking stays 100% free forever.** It is the acquisition engine and the leaderboard supply. Never paywall entry, grading, or core stats; deep analytics (EV vs actual, splits matrix) can become a paid layer later if the need shows up.
- **Keep paid:** picks 2-50, scores, MVP history live sections, pro-depth form, live value pulse magnitude.

---

## 6. App Path

Confirmed sequence: **web polish now, PWA next, Capacitor later.** Not React Native.

Policy reality:

- **Approvable category.** No-wagering trackers are fine under Apple 5.3 (Pikkit, AN, Betstamp all live in the store). State "no real-money wagering" in-app and in review notes. Expect an 18+ rating on both stores; add a simple age gate.
- **The real risk is Guideline 4.2** (repackaged website). We pay it down with push notifications, persistent token login, a native offline state, and no browser chrome.
- **Payments:** US external purchase links are currently allowed on iOS at 0% commission but courts can change that; Google is looser (alt payments live since Dec 2025). Plan: launch with "Subscribe on cappingalpha.com" via the system browser, keep IAP as a fallback for $4/wk and $75/yr if commissions land.
- **Capacitor gotchas:** session cookies break at capacitor://localhost. Add a bearer-token path to auth.js, bundle public/ into the app, CORS-whitelist the app origin, open Stripe in the system browser.

Sequence detail:

1. **Web polish now** (the Phase 1 list; safe-area CSS is already done).
2. **PWA next (Phase 3):** manifest + service worker + offline shell + iOS Declarative Web Push. Days of work, zero store review, zero payment entanglement, and it builds the push plumbing Capacitor reuses.
3. **Capacitor when there is user pull (Phase 7, after the Phase 6 security gate):** token auth, push server (device-token table + send path, none exists today), bundled frontend, the 4.2 native touches.

---

## 7. CA Odds Engine (Phase 4)

A standalone in-house odds service under Jack's company, copying the legal model of The Odds API: collect odds from public sportsbook pages and public JSON endpoints, normalize them, serve them to CappingAlpha.

**Legal footing.** Odds are uncopyrightable facts (Feist v. Rural). Scraping publicly accessible data, with no login and no ToS acceptance, is generally CFAA-safe (hiQ v. LinkedIn). The engine touches public pages and public JSON endpoints only: no logins, no accepted terms, polite request rates, proxy rotation if a book gets touchy. This is the same posture The Odds API and every odds-screen product operates under.

**Head start: the pattern is already proven in production.** src/bovada.js fetches Bovada's public coupon API on the Mac (Bovada geo-blocks datacenter IPs, so Railway cannot fetch it directly) and relays parsed lines to the site via POST /admin/ingest-tennis-lines. That fetch-on-Mac, relay-with-key architecture IS the odds engine; Phase 4 generalizes it beyond tennis. src/esports_markets.js already scrapes Kalshi + Polymarket esports markets the same free way.

**Staged book adapters, easiest first:**

1. **Bovada, all sports.** The parser and Mac relay exist for tennis; widen to team sports. Offshore, but its public JSON is the friendliest anywhere.
2. **DraftKings public JSON.** ESPN already surfaces DK lines and we know the shape.
3. **BetRivers (Kambi platform).** Kambi's public endpoints are famously open and cover every Kambi-powered book.
4. **BetOnline** (offshore) and **Pinnacle guest API** (the sharp reference line; big CLV upgrade).
5. **Aggregator pages.** We already scrape ActionNetwork for public betting %, so the fetch-and-parse pattern exists in-house.
6. **FanDuel, Caesars, ESPN Bet, Hard Rock Bet, Thunderpick** (esports; pairs with the Esports tab) as tier two.
7. **Harder books** (BetMGM, Fanatics) only as demand justifies; bet365 skipped outright.

Realistic steady state: 8 to 12 sources. The constraint is adapter maintenance (books redesign and break scrapers), not feasibility. Launch the line-shopping board at 5 or 6 sources and grow.

**Source health board (includes the Kalshi/Polymarket check).** An admin panel section with one row per data source: every odds adapter plus Kalshi, Polymarket, public betting, line history, and the Bovada relay, showing last successful sync, rows fetched today, and a stale flag when a source misses its expected window. Broken sources surface the same morning instead of days later.

**Offshore rule:** offshore odds (Bovada, BetOnline, Thunderpick) are displayed as information only. Affiliate deep links go on regulated books only; linking out to unlicensed operators from a US-facing site is a legal gray area we stay out of.

**Normalized schema:** one row per (book, market, line, odds, timestamp). Every adapter maps into it; downstream code never knows which book was scraped how.

**Architecture:** runs on the Mac first, same pattern as the local Ollama reader: a separate service that POSTs normalized odds to the site with an API key. Moves to its own server later if uptime or volume demands it. The site treats it as just another data source.

**What it powers:** a line-shopping board, best price across books per pick, free for all users, with affiliate deep links per book. It also feeds the Phase 3 live-refresh board and future CLV depth (more books means better closing-line capture).

**Fallbacks stay in place:** the free ESPN DK refresh (every 3 hours) and the 2/day Odds API calls (within the free 500-credit tier) remain as fallback sources. Per the zero-cost rule, there is no paid upgrade path here: if a book's scraper breaks, coverage narrows to the working adapters and the free fallbacks until it is fixed.

---

## 8. Phased Roadmap

Effort tags: S = under a day, M = days, L = a week or more.

### Phase 1: Trust + polish quick wins (being built now)

- Free-bet accounting fix: loss counts in the record at 0 P/L, Free tag, free-bet W-L line (S)
- Verified/custom reason messaging with the actual odds range shown (S)
- Bolt de-overload: bolt = free bets only, live odds get their own treatment (S)
- Book chip labels: "Over 9 · -117" style (S)
- Unit size preload at app boot (S)
- Toast queueing + save spinners + disabled-while-pending (S)
- Sport filter reset when the last matching bet settles away (S)
- Proper confirm component replacing the innerHTML two-step delete (S)
- Teaching empty states with a call to action (S)
- DB indexes: user_bets(sport), user_bets(placed_at), game_votes(user_id, voted_at) (S)
- Public betting % surfaced free, it is already in the popup pipeline (S)

### Phase 2: Analytics that beat AN

- Hero chart: flat 1u overlay vs actual stakes + shaded max drawdown (M)
- Win rate vs breakeven by odds band (S)
- Plain-English CLV card + per-bet distribution histogram (M); store real spread closing juice at grade time, new column (S)
- Calendar heatmap, daily net units, tap a day for its bets (M)
- Bankroll curve UI on top of the existing bankrollSeries (S)
- Worst streak / longest drawdown / time underwater panel (S)
- Global filter bar: date range, sport, type, book, shared across all charts (M)

### Phase 3: Feature gaps

Standing rule for this phase and every phase after it: zero marginal cost. No new API credits, no paid services. The one paid thing that stays is the Discord message reader as originally built. The only new-cost exception on the whole roadmap is app store registration in Phase 7 (Apple $99/yr, Google $25 once), which has no free alternative.

- Betslip screenshot OCR, fully free: Tesseract.js reads the screenshot in the user's own browser (the image never leaves their device), then the local Mac Ollama reader structures the text into selection, odds, stake, and book, reusing the reader_rules.js pattern. Fallback when the Mac is unreachable: regex parsing for common DraftKings/FanDuel slip formats, then manual entry. The paid Haiku path is not used for scans (M)
- Live odds refresh on the confirm board, 30 to 60s poll, flash changed numbers (S/M)
- Bet history search + date range + book filter + load more past the 300-bet cap (M)
- PWA: manifest, service worker, offline shell, push for bet results and pick alerts; the notifications stub becomes real here (M)
- Mobile touch/focus/truncation pass: 48px targets, truncation, focus traps, arrow keys (S/M)

### Phase 4: CA Odds Engine

- Mac-hosted odds service skeleton, generalizing the proven src/bovada.js fetch-on-Mac + relay-with-key pattern: fetch loop, normalized schema (book, market, line, odds, timestamp), API-key POST to the site (M)
- Bovada all-sports adapter (extend the existing tennis parser) (S/M)
- DraftKings public JSON adapter (M)
- BetRivers/Kambi + BetOnline + Pinnacle guest API adapters (M)
- Aggregator-page adapter, reusing the ActionNetwork scrape pattern (M)
- FanDuel, Caesars, ESPN Bet, Hard Rock Bet, Thunderpick adapters as tier two (M each)
- Source health board in admin: per-source last sync, rows today, stale flags; covers odds adapters + Kalshi + Polymarket + public betting + line history + the Bovada relay (M)
- Line-shopping board UI: best price across books per pick, free for everyone; affiliate deep links on regulated books only, offshore odds informational only (M)
- Wire engine data into the betslip book chips and the live-refresh board; ESPN DK + free-tier Odds API remain fallbacks (S/M)
- Harder-book adapters (BetMGM, Fanatics) only as justified; bet365 skipped (L, ongoing)

### Phase 5: Parlay legs + social loop

- bet_legs table + leg-aware grading + parlay builder UI (L)
- Tail-a-capper from a pick with tailer-vs-capper realized ROI; nobody measures tail slippage and it fits the accountability brand (M)
- Share-a-win graphics and public profile pages (M)
- Capper CLV + Best Book cards on member profiles (S)

### Phase 6: Security + compliance hardening

Gate before anything ships wider. The full audit runs via the /security-audit workflow (deep multi-agent, adversarially verified) and re-runs before every major public ship, including the app submission.

- Access control sweep: ownership checks on every /api/bets, /api/game/:id/vote, and /api/account route; admin router unreachable without auth; rate limits beyond login/signup (M)
- Session + auth hardening: cookie flags, reset-token expiry and single-use, bcrypt cost, session fixation on login (S/M)
- Paywall enforcement: picks 2-50 and scores gated server-side in every endpoint, including new tracking and future odds-engine surfaces (S)
- Injection sweep: prepared statements everywhere, XSS audit of every innerHTML interpolation, avatar upload validation (M)
- Payments: Stripe webhook signature verification, subscription expiry honored on every gate, stated cancel/refund terms (S)
- Infra: security headers (CSP, HSTS, frame denial), secrets hygiene incl. ODDS_ENGINE_SECRET, Railway volume backup story (S/M)
- Legal + compliance: ToS and Privacy reviewed, 21+/18+ notice with responsible gambling resources (1-800-GAMBLER), "informational only, not a sportsbook, no wagering" language site-wide, affiliate disclosure once the odds engine links go live (M)
- Fix everything found, re-verify, write the report to docs/ (M)

### Phase 7: App

- Bearer-token auth path in auth.js alongside sessions (M)
- Capacitor wrap with bundled frontend, CORS-whitelisted app origin (M)
- APNs/FCM push server reusing the PWA push infra, device-token table + send path (M)
- Subscribe-on-web external links via system browser, IAP fallback ready for $4/wk and $75/yr (M)
- Ship iOS + Android: 18+ rating, age gate, "not a sportsbook" positioning (M)

---

## 9. What We Deliberately Skipped

**Credential-based sportsbook sync (SharpSports-style, credential or browser-extension based) is off the roadmap entirely.** It is Action Network's biggest churn source (BetSync shrank to two books and breaks often), and it carries risk we do not want: holding or brokering user sportsbook credentials, murky legal exposure, and users getting their book accounts limited or banned for third-party access. Betslip OCR (Phase 3) plus fast manual entry covers off-site bets without any of that. If OCR plus manual ever proves insufficient, email confirmation parsing is the unexploited alternative to look at first, not sync.
