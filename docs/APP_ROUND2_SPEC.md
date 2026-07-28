# CappingAlpha App Round-2 Redesign Spec

Synthesized from 7 research agents (ESPN, theScore, Action Network, DraftKings, FanDuel, Sleeper, Yahoo, B/R, Strava, Apple App Review). Hard rules applied throughout: no em dashes, humble copy, no source/formula reveal ("our proprietary scoring engine" only), hamburger drawer removed, no footer on any content screen.

---

## A. Settings Screen

Entry: gear icon, top-right of the Account tab only. Never in the bottom tab bar. Grouped inset lists, ALL-CAPS gray section headers, icon + label + chevron rows. Toggles only on leaf screens.

Exact order, top to bottom:

**1. Profile header card**
- Avatar (initials chip fallback) + username + tier chip (FREE / gold MEMBER) + member-since line, chevron to Edit Profile

**2. MEMBERSHIP**
- `Manage Subscription` (plan name + renewal date as subtitle; opens Stripe customer portal in the system browser, never rebuilt natively)
- `Restore Purchases` (required once IAP exists)
- `Redeem Access Code`
- `Referral Code` (code + "N friends joined" subtitle, share sheet)

**3. PREFERENCES**
- `Notifications` (chevron to the deep screen, Section B)
- `My Sports` (favorite_sports picker, drag to reorder)
- `My Sportsbooks` (existing books.js picker)
- `Bet Settings` (leaf screen: Unit Size with "applies to future tracked bets only", Units vs Dollars, Odds Format American/Decimal)
- `Appearance` (dark default, reserved row)

**4. SUPPORT**
- `Help and FAQ` (faq.html in in-app browser sheet)
- `Contact Support` (mailto SUPPORT_EMAIL)
- `Rate CappingAlpha` (deep-links App Store write-review URL; requestReview fires separately only after a graded win, never at launch, never on a button)
- `Share CappingAlpha`

**5. ABOUT & LEGAL** (this group absorbs the website footer)
- `About CappingAlpha` (proprietary-engine framing only)
- `Our Track Record` (links to the graded record on Rankings)
- `Terms of Service` (system browser sheet to cappingalpha.com/terms)
- `Privacy Policy` (same pattern; also required in App Store metadata, 5.1.1(i))
- `Responsible Gaming` (existing RG page)
- `Open Source Licenses` (generated list from package.json, native table; cheap real-app tell)

**6. ACCOUNT**
- `Log Out` (plain row, confirm sheet)
- `Delete Account` (red text, one level of friction: typed confirm + password re-entry, plain note on what is deleted vs retained; reuses the Phase 6 flow, required by 5.1.1(v))

**7. Unlabeled footer block**
- "CappingAlpha is an informational sports data platform, not a sportsbook. 18+."
- `Version 2.0.0 (build N)` centered, small gray, read from Capacitor App.getInfo()

---

## B. Notification Preferences Screen

Path: Settings > Notifications. Two-level tree wired 1:1 to push.js TOPICS + user_preferences.notify_prefs. Shape the JSON now as `{topic: {on, sports: [...]}, quiet_hours: {on, from, to}}` so per-entity scoping can be added without migration. Enforced server-side in sendToUserTopic (add the sport filter + quiet window check there).

**0. Permission state row (top, conditional)**
- If OS permission denied: inline banner "Notifications are off for CappingAlpha" + `Enable` button deep-linking to iOS Settings. Dead toggles never shown.

**1. Master switch**
- `Allow Notifications` toggle. Off silences everything but preserves every selection below (theScore kill-switch pattern, do-not-disturb not data loss).

**2. MY PICKS** (free, default ON at permission grant)
- `Pick graded` (topic: grades). Subtitle: "When a game you tracked or voted on settles."
- `Game start` (topic: game_start). Subtitle: "When a game you have action on goes live."

**3. RANKINGS** (free, default ON)
- `#1 pick of the day` (topic: top_pick). Subtitle: "One alert when the day's top ranked pick is set."
- `Rankings updates` (new topic). Subtitle: "When a new pick reaches the top tier."

**4. MARKET ALERTS** (paid; free users see a gold lock chip, tap opens the upgrade sheet inline, AN pattern; default OFF until paying, then ON)
- `Line moves` (topic: steam). Subtitle: "Sharp pregame movement on a game you picked."
- `Score swings` (topic: swing). Subtitle: "Lead changes in games where you have action."

**5. SOCIAL** (default ON)
- `Tails on my picks`
- `New follower`
- `Comments and mentions`

**6. MY SPORTS filter** (default: user's favorite_sports ON, rest ON; acts as a suppressor, not a subscription)
- One chip/toggle per sport: MLB, NBA, WNBA, NFL, NCAAF, CBB, NHL, Soccer, Tennis, Golf
- Helper text: "Turn a sport off to mute it everywhere above."

**7. QUIET HOURS** (bottom)
- `Quiet hours` toggle + From/To time pickers. Default off; when enabled default 11:00 PM to 8:00 AM. Subtitle: "We hold alerts during these hours." Cheap to enforce on the existing 5-min cron.

**Defaults philosophy:** opt-down. Granting push flips all free topics on with a toast "Alerts on. Tune them in Settings." Paid topics stay locked/off for free users.

**Contextual second door:** bell icon on the game detail header and on upcoming/live score rows toggles that game's alerts inline, writing the same notify_prefs the screen reads. Two doors, one store.

**Push copy patterns** (humble, no sources, no emojis):
- Graded: "Graded: Yankees ML, won (+1.2u)" / "Graded: Under 8.5, lost (-1.0u)"
- Game start: "First pitch: Yankees at Red Sox. You have 2 tracked picks."
- Top pick: "Today's #1 ranked pick is live."
- Steam (paid): "Line move: Phillies -1.5 is now -2.5 on a game you picked."

**Onboarding priming:** dedicated full-screen "Turn on notifications" step before the raw OS prompt, listing three concrete alerts (Pick graded, #1 pick of the day, Game start) with Enable + Maybe later. Never fire the OS prompt cold.

---

## C. Home Scores Experience

Kills the website-y lower home. No footer, no legal links, no sitemap. Pull-to-refresh on the whole surface (strongest single native signal).

Exact module order, top to bottom:

**1. Top bar:** CA wordmark centered, gear absent (gear lives on Account), search optional left. No hamburger.

**2. MY SPORTS rail** (kept, restyled): horizontal scroll of circular chips with 2-4 char labels (ESPN FAVORITES pattern). Tap filters/jumps to that sport on the Sports tab.

**3. #1 RANKED card** (kept): the hero card, unchanged position.

**4. MOST WAGERED** (kept): ALL-CAPS header + right-aligned `See All`, horizontal rail.

**5. MY GAMES card:** one rounded card of hairline-divided rows for every game the user has action on (votes + pending user_bets + parlay legs + favorite-sport games). Live first, then upcoming by start_time, then most recent final. This is the personalization anchor ESPN leads with.

**6. TOP GAMES sections:** per-sport sections, ALL-CAPS header (sport name + game count) + `See All` (opens Sports tab with that sport selected). Within a section: live > upcoming > finals collapsed. Favorite sports' sections float first.

**Row anatomy (shared renderer, 3-column grid + one action slot):**
- Column 1: team abbr/logo + name (+ gray record in parens, pregame only)
- Column 2: right-aligned score column (empty pregame)
- Column 3: state column, content swaps by state, layout never does
- Action slot far right: bell (pre/live) or result pill (final)

**Per state:**
- **Pre:** state column = start time + one metadata line "LINE PHI -1.5 / O/U 8.5" (the CA line; 5am placeholder pre-lock, T-60 locked after; no book names ever). Gold rank chip ("CA #3" or heat flame) on rows carrying ranked picks. Bell icon far right.
- **Live:** state column = period + clock in red, plus the existing liveStateHtml situation line (MLB diamond/count, football down and distance). Leading team's score renders brighter.
- **Final:** "Final" + winner score bold with caret, loser dimmed. Action slot becomes a `Result` pill (green check / red cross when a CA pick graded on it) linking to the detail page.

**See All behavior:** every See All opens the corresponding full list (Sports tab filter or full Most Wagered list), same row renderer, back swipe returns.

---

## D. Sports Tab (per-sport scores pages)

**1. Sticky sport chip rail** at top: `Top` chip first (cross-sport view), then My Sports in the user's order, then remaining in-season sports, off-season last. `Manage` affordance at the rail's end opens a sheet with drag-to-reorder + hide toggles, persisted to user_preferences (theScore pattern; never auto-resort like Yahoo).

**2. Date strip** under the rail: Yesterday | Today | Tomorrow tokens + calendar icon later. Today default, horizontal swipe pages days. today_games is day-scoped so Yesterday/Tomorrow can come later from pick_history/book_lines_closing.

**3. `Top` view:** pinned MY ACTION section first (votes + tracked bets), then stacked per-sport sections with header rows (sport name + count + right-aligned link to that sport's CA record page via sport_page.js). Standings-like content always one level down, never a tab.

**4. Per-sport view:** flat chronological list. Live first, upcoming by start_time, finals collapsed under a `Finals (N)` expander.

**5. Rows:** identical shared renderer as Home (Section C anatomy). The TV-network slot equivalent carries pick/vote count ("12 picks") on the metadata line's right side.

**6. Off-season empty state:** card with sport icon, "No NFL games today", "Season resumes [date]" when known, and a `Notify me when NFL picks return` toggle wired into the per-sport notification filter. Never a dead end, never an outbound link.

**7. Game search** stays in the rail row (existing behavior), opens the detail page.

---

## E. Profile (Account Tab as a "Me" Surface)

Profile = performance + public identity. Settings = admin. Hard split.

**Account tab, top to bottom:**
1. Header: avatar (tap = action sheet with preset CA avatars, gold theme, Sleeper-mascot style; initials chip fallback; no photo upload at launch) + handle + tier chip + member since. Pencil on avatar. Gear top-right (only settings entry in the app).
2. My Record module: tracked W-L, units, flat-unit P/L (utils.flatUnitReturn, the single P/L source of truth).
3. Swipeable performance chips: by sport, by bet type, by time period (AN My Action pattern).
4. Streak / best week module (winning-days streak, best 7-day stretch).
5. Pending and settled bet list (existing My Tracking data).
6. Referral card (code + share).

**Public profile (Socials tie-in), view-only, separate surface:**
- Avatar, handle, graded record from the tracked ledger (state.mvpData rule: records always derive from mvp_picks), boosted/tailed picks, favorite sport chips.
- "CA graded" check on engine-graded picks, visually distinct from self-tracked bets (the AN blue-check trust pattern).
- Never shows: email, subscription, notification prefs.

**Edit Profile screen:** avatar, display name, username, favorite sports, one privacy toggle `Show me on leaderboards` (single toggle, not a matrix), plus a `View as others see it` link. Delete Account does NOT live here; it stays at the bottom of Settings.

---

## F. Legal / Footer Relocation Checklist

Delete the website footer and hamburger drawer from the app shell entirely, then verify each item landed:

| Footer item | New home |
|---|---|
| Terms of Service | Settings > About & Legal row, system browser sheet |
| Privacy Policy | Settings > About & Legal row + App Store Connect metadata URL |
| Responsible Gaming | Settings > About & Legal row + one static line on the paywall sheet ("18+. If gambling is a problem for you or someone you know, help is available: 1-800-GAMBLER") |
| About | Settings > About & Legal (engine framing only, no sources) |
| Graded record link | Settings > `Our Track Record` row pointing at Rankings; record itself stays a product surface |
| Site map | Deleted. The tab bar is the sitemap |
| Support email | Settings > Support > Contact Support |
| Version string | Settings footer, "Version 2.0.0 (build N)", from the binary |
| 18+ / not-a-sportsbook line | Settings footer block + onboarding age gate + App Store 18+ rating with gambling flags |
| Terms acceptance | Inline clickwrap under auth CTAs: "By continuing, you agree to the Terms of Service and acknowledge the Privacy Policy." No checkbox, never reshown |
| Account deletion | In-app, Settings bottom (Apple 5.1.1(v)); already built in Phase 6, this is placement only |
| Open source licenses | New Settings row, generated native table |

**Verification sweep:** no legal link, record footer, or sitemap renders on Home, Sports, Rankings, Socials, or any detail page. Legal pages always open in the system browser sheet (Capacitor Browser), never as in-tab navigations. Submit from the business entity, not an individual (5.1.1(ix), gambling-adjacent is a named regulated field). Complete Apple's new age-rating questionnaire (due Jan 31, 2026) expecting 18+.

---

## Cross-cutting build notes

- One shared score-row renderer (public/modules/utils.js) powers Home MY GAMES, Home TOP GAMES, and every Sports tab list. Build it once.
- Bells and the Notifications screen read/write the same notify_prefs object; sendToUserTopic gains two checks (sport filter, quiet hours) and nothing else changes server-side.
- Defaults are opt-down everywhere: favoriting a sport enables its rows, paid topics stay locked until paying.
- All new copy: plain nouns for row labels, humble verbs elsewhere ("tends to", "can"), no em dashes, no emojis, never a source or mechanic named.