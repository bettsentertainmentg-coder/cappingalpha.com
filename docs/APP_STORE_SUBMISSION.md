# CappingAlpha App Store Submission Packet (Phase 7h)

The complete submission packet for both stores: listing drafts, questionnaire answers, privacy mappings, reviewer notes, screenshot shot-list, TestFlight steps, and Xcode entitlement setup. Grounded in docs/APP_LAUNCH_PLAN.md sections 5, 8, 9 and the live legal pages (public/terms.html, public/responsible-gambling.html, public/delete-account.html, public/privacy.html, public/site.webmanifest).

Facts this packet assumes (all shipped or locked):

| Item | Value |
|---|---|
| Bundle / package id | com.cappingalpha.app (capacitor.config.json) |
| App name | CappingAlpha |
| Entity | CappingAlpha LLC (Florida), organization accounts on both stores |
| Payments | Stripe checkout opened in the system browser, US storefront link-out (plan section 5). No IAP at launch |
| Trial | 3-day free trial for first-time subscribers, then $4/week. $75/year and $1 day pass also exist (terms.html section 10) |
| Markets | United States only at launch (D6) |
| Guests | Can browse home and leaderboards but see NO picks. The daily #1 pick requires a signed-in free account |
| Analytics | PostHog is DISABLED inside the native shell. No analytics SDK, no session replay in the app |
| Sign-in | Email/username + password, Google, and Sign in with Apple (built now) |
| Push | @capacitor-firebase/messaging planned (7e). Declare push tokens only if 7e ships before submission |
| Live URLs | cappingalpha.com/terms, /privacy, /responsible-gambling, /delete-account, /faq (all routed in index.js) |

Copy rules that bind every word below: no em dashes, humble tone (often / tends to, never guaranteed), never name pick sources or scoring mechanics, only "our proprietary scoring engine". Women's-league copy never uses him/his.

---

## 1. App Store listing draft (App Store Connect)

| Field | Value | Limit |
|---|---|---|
| Name | CappingAlpha | 30 chars (12 used) |
| Subtitle | Sports data and pick rankings | 30 chars (29 used) |
| Primary category | Sports | |
| Secondary category | Utilities (or leave empty) | |
| Keywords | odds,lines,bet tracker,handicapping,parlay,nfl,nba,mlb,nhl,live scores,leaderboard,units | 100 chars (88 used). No competitor or sportsbook brand names, no words already in name/subtitle |
| Support URL | https://cappingalpha.com/faq | |
| Marketing URL | https://cappingalpha.com | |
| Privacy Policy URL | https://cappingalpha.com/privacy | |
| Copyright | 2026 CappingAlpha LLC | |
| Availability | United States only (D6) | |
| Price | Free (subscription purchased on the web, see section 5 of the launch plan) | |

### Promotional text (170 chars, editable without review)

> See how the day's board stacks up. Our proprietary scoring engine ranks the top picks across every major sport, and you track your own results with live P/L.

### Description (leads with the sports data / analytics identity)

> CappingAlpha is a sports data and analytics platform. We gather the day's games, lines, and market data across every major sport, then our proprietary scoring engine grades the board and ranks the picks it currently rates highest.
>
> WHAT YOU GET
>
> - Daily ranked board: our engine scores the day's picks and ranks the top 50 across football, basketball, baseball, hockey, college sports, soccer, tennis, golf, and combat sports
> - Free daily #1 pick: create a free account and see the top-ranked pick every day
> - Live scores and odds: real-time scores plus line comparison across major sportsbooks
> - Bet tracking: log your own bets, watch live profit and loss, and keep an honest record
> - Friends and leaderboards: follow friends, compare tracked records, and tail ideas you like
> - Personalized alerts: pick grades, game starts, line moves, and social activity, each on its own toggle, with quiet hours
>
> Browsing scores, odds, and leaderboards is free and requires no account. A free account unlocks the daily #1 ranked pick and bet tracking. CA Rankings, the paid tier, unlocks the full ranked board: first-time subscribers get a 3-day free trial, then $4 per week, with a $75 annual plan and a $1 day pass also available. Subscriptions are purchased and managed on cappingalpha.com.
>
> Rankings are data, not promises. Scores move as new information arrives, and past performance does not predict future results.
>
> IMPORTANT
>
> CappingAlpha is not a sportsbook and does not accept, place, or facilitate wagers of any kind. All picks, rankings, and tracking are for informational and entertainment purposes only. If you or someone you know has a gambling problem, call 1-800-GAMBLER.
>
> You must be 18 or older to use CappingAlpha.
>
> Terms of Service: https://cappingalpha.com/terms
> Privacy Policy: https://cappingalpha.com/privacy
> Responsible Gambling: https://cappingalpha.com/responsible-gambling

The IMPORTANT block is the required disclaimer copy from plan section 8. It must appear in three places: this listing, the app's About/footer line, and the Responsible Gambling page (already live). Do not trim it.

### What's New (v1.0)

> The first CappingAlpha app: the daily ranked board, live scores and odds, bet tracking with live P/L, friends and leaderboards, and personalized alerts.

---

## 2. Apple age-rating questionnaire draft answers

Mandatory since January 31, 2026; submission is blocked until it is completed. Answer the live questionnaire truthfully; these are the draft answers for the content we actually have. Expected result: 18+ (gambling content moved from 17+ to 18+ under the 2026 tiers).

| Question area | Answer | Why |
|---|---|---|
| Cartoon or fantasy violence | None | |
| Realistic violence | None | |
| Sexual content or nudity | None | |
| Profanity or crude humor | None (app content). UGC is covered below | |
| Alcohol, tobacco, drug use or references | None | |
| Horror or fear themes | None | |
| Medical or treatment information | None | |
| Simulated gambling | None | No casino-style games, no play-money wagering. Community votes are non-monetary sentiment (terms section 5) |
| Real-money gambling or contests | No | We do not accept, place, or facilitate wagers. No prizes, no consideration |
| Gambling and betting references or themes | Frequent/Intense | The entire app is sports wagering information: odds, lines, picks, hypothetical P/L. Answer at the top intensity, honestly |
| Unrestricted web access | No | External links open in the system browser, the app is not a browser |
| User-generated content | Yes | Comments, profiles, follows. Moderation answers: report and block tools exist, zero-tolerance policy in terms section 9, reports acted on typically within 24 hours |
| App-level age assurance | Yes, in-app 18+ date-of-birth gate on first run | Onboarding screen 1 (plan section 4) |

Notes:

- If the live questionnaire result comes back below 18+, re-check the gambling-references answer; under-answering it is a rejection risk under Guideline 5.3.
- Check whether the US launch triggers the Declared Age Range API or any 18+ download blocking at submission time (plan section 11 must-verify list).
- Set the age rating BEFORE building screenshots; the rating gates which screenshots reviewers compare against.

---

## 3. Apple privacy nutrition labels mapping

Core fact: PostHog does not run inside the native shell. There is no analytics SDK, no session replay, and no third-party tracking in the app. That removes the Usage Data / Diagnostics declarations the website would need, and "Data Used to Track You" is None.

Declare "Data Linked to You" as follows. Everything is collected for App Functionality only, nothing for tracking, advertising, or third-party analytics.

| Apple data type | What it is for us | Linked to identity | Purpose |
|---|---|---|---|
| Contact Info: Email Address | Account email (signup, password reset, support) | Yes | App Functionality |
| Identifiers: User ID | Username, account id, Google account identifier, Apple user identifier from Sign in with Apple | Yes | App Functionality |
| Purchases: Purchase History | Subscription status, plan, and payment result received from Stripe. Card numbers never touch our servers | Yes | App Functionality |
| User Content: Other User Content | Comments, tracked bets and notes, votes, follows, referral relationships | Yes | App Functionality |
| User Content: Photos or Videos | Profile photo, only if the user uploads one | Yes | App Functionality |
| Identifiers: Device ID | FCM push token stored in push_devices. ONLY declare if 7e (native push) ships in the submitted build; omit otherwise | Yes | App Functionality |

Declare as NOT collected:

| Apple data type | Why not |
|---|---|
| Usage Data (Product Interaction, Advertising Data) | PostHog is disabled in the shell. In-app actions like votes and tracked bets are declared under User Content, not analytics |
| Diagnostics (Crash Data, Performance Data) | No crash or performance SDK in the app |
| Location (Precise or Coarse) | The app never requests location. See edge case below |
| Financial Info | Card details are entered only on Stripe's checkout in the system browser, never in the app |
| Browsing History, Search History, Contacts, Health, Messages | Not collected |

Edge case, flag for Jack before submitting: the server derives approximate region from IP for security (privacy.html section 12 table). Standard practice for security-only server logs is to not declare Coarse Location; if App Review pushes back, add Coarse Location, linked, App Functionality, and note the security purpose in the review notes.

Also confirm in App Store Connect: "Data Used to Track You: None", account deletion supported in-app (Guideline 5.1.1(v)), and the privacy policy URL matches https://cappingalpha.com/privacy.

---

## 4. Reviewer notes packet (App Review notes field)

### Demo account

- Provision a dedicated reviewer account BEFORE submitting: username `appreview` (or nearest available), email appreview@cappingalpha.com, a fresh strong password generated at submission time.
- Grant it paid CA Rankings access server-side (comp the subscription tier directly in the users table, no Stripe object needed) so reviewers see the full ranked board, picks 1-50.
- Verify the account on prod the same day the build is submitted: login works, board renders, tracking works, deletion flow visible (but tell reviewers deletion is permanent).
- Enter the credentials in the App Review Information section, not in the public listing.

### One-paragraph explanation (paste into review notes)

> CappingAlpha is an informational sports data and analytics product. We aggregate publicly available game, score, and odds data, apply our proprietary scoring engine, and publish ranked picks, leaderboards, and self-logged bet tracking. The app does not accept, place, or facilitate wagers, holds no funds, has no sportsbook integrations or bet-slip handoff, and contains no real-money gaming of any kind. It is the same informational service as cappingalpha.com, which has operated publicly with these policies. Users must be 18 or older, pass an in-app date-of-birth gate, and see a responsible-gambling disclaimer with the 1-800-GAMBLER helpline.

### Additional notes for the reviewer

- Guests intentionally see no picks. Browsing scores, odds, and leaderboards works signed out; the daily #1 pick and the ranked board require sign-in. Please use the demo account above to see the full experience. This mirrors the website's existing server-side enforcement and is not a bug.
- Subscriptions are purchased on cappingalpha.com via Stripe, opened in the system browser under the US storefront external-link rules (Guideline 3.1.1 as applied to the US storefront). The app itself sells nothing.
- Sign in with Apple is offered alongside Google sign-in per Guideline 4.8.
- In-app account deletion: My Account > Delete account (Guideline 5.1.1(v)). Public page: https://cappingalpha.com/delete-account
- Responsible gambling: https://cappingalpha.com/responsible-gambling
- Terms: https://cappingalpha.com/terms and Privacy: https://cappingalpha.com/privacy

### Precedents (cite only if pushed on Guideline 5.3 / 4.2)

| App | App Store ID | Relevance |
|---|---|---|
| Action Network: Sports Betting | id1083677479 | Approved informational picks, odds, and tracking app |
| Pikkit: Sports Bet Tracker | id1586567110 | Approved self-logged bet tracking with P/L |
| BettingPros: Sports Betting | id1468109182 | Approved picks and odds analysis app |

Wording if needed: "Comparable informational sports-analytics apps (Action Network id1083677479, Pikkit id1586567110, BettingPros id1468109182) are live on the App Store under the same model: information and tracking only, no wagering."

---

## 5. Google Play

### Listing draft (Play Console, Main store listing)

| Field | Value | Limit |
|---|---|---|
| App name | CappingAlpha | 30 chars |
| Short description | Sports data and analytics: ranked picks, odds, live scores, and bet tracking. | 80 chars (77 used) |
| Full description | Reuse the App Store description from section 1 verbatim, including the IMPORTANT disclaimer block | 4000 chars |
| Category | Sports | |
| Tags | Sports, Stats | |
| Contact email | support@cappingalpha.com | |
| Contact website | https://cappingalpha.com | |
| Privacy policy | https://cappingalpha.com/privacy | required field |
| Countries | United States only (D6) | |
| Price | Free | |
| Ads declaration | No ads | |

Graphics assets: app icon 512x512, feature graphic 1024x500 (dark #0f1117 background, CappingAlpha lockup, no screenshot collage text claims), phone screenshots from section 6.

### IARC content-rating questionnaire draft

Answer the live questionnaire truthfully. Expected result: Mature 17+ (ESRB) / 18 (PEGI and most other regions) via the gambling-references path.

| Question area | Answer |
|---|---|
| Violence, sexuality, language, controlled substances | No / None |
| Does the app allow users to gamble real money (wagers, real-world prizes)? | No |
| Does the app contain simulated gambling (casino-style play-money games)? | No |
| Does the app contain content that references, instructs about, or provides information related to real gambling? | Yes. Sports wagering information: odds, lines, picks, hypothetical P/L |
| User interaction features | Yes: users interact (comments, follows), moderated, with report and block tools |
| Does the app share user location with others? | No |
| Digital purchases | Purchases happen outside Google Play on the web (declare per the current form's wording) |

### App content declarations (Play Console, App content section)

| Declaration | Answer |
|---|---|
| Target audience | 18 and over only. Not directed at children |
| Real-money gambling, games, and contests | No. The app does not offer wagering, prizes, or entry fees. It is informational only (plan section 8: no sportsbook deep-links, no bet-slip handoff) |
| News app | No |
| Health / COVID | No |
| Financial features | None |
| Data safety | Section below |
| Government app | No |
| Login credentials for review | Same demo account as section 4; provide in the App access section since picks require sign-in |

### Data safety form mapping

Mirrors the Apple labels: nothing shared with third parties, nothing for advertising or analytics, everything encrypted in transit (HTTPS), deletion available.

| Play data type | Collected | Shared | Required or optional | Purpose |
|---|---|---|---|---|
| Personal info: Email address | Yes | No | Required for account | Account management |
| Personal info: User IDs | Yes (username, account id, Google / Apple identifiers) | No | Required for account | Account management |
| Financial info: Purchase history | Yes (subscription status and plan from Stripe, no card numbers) | No | Optional (only subscribers) | App functionality |
| Photos: Photos | Yes (optional avatar upload) | No | Optional | App functionality |
| Messages / other UGC | Yes (comments, tracked bets and notes, votes, follows) | No | Optional | App functionality |
| Device or other IDs | Yes ONLY if 7e native push ships in this build (FCM token); otherwise No | No | Optional | App functionality (push delivery) |
| App activity (analytics), App info and performance (crash logs), Location | No | No | | PostHog disabled in the shell, no crash SDK, no location |

Security section answers: data encrypted in transit: Yes. Users can request deletion: Yes, in-app (My Account > Delete account) and via the web. Data deletion URL: https://cappingalpha.com/delete-account

### Organization account advantage

The Play developer account is the CappingAlpha LLC organization account. The personal-account requirement (a closed test with 12+ testers for 14 continuous days before production access) does NOT apply to organization accounts, so production release is not gated on that cohort. Still run a short voluntary closed track (section 7 checklist on Android hardware) before promoting to production. Organization identity verification (D-U-N-S, documents) must already be complete; confirm the account standing in Play Console before uploading the .aab.

---

## 6. Screenshot shot-list

Devices and canvas sizes:

| Device set | Size | Notes |
|---|---|---|
| iPhone 6.7" | 1290 x 2796 | Primary Apple set |
| iPhone 6.1" | 1179 x 2556 | Second Apple set (confirm at submission which sizes Connect still requires; upload both) |
| Pixel (e.g. Pixel 8) | 1080 x 2400 | Play phone set, minimum 2, we ship 6 |

Global rules for every shot:

- Real app UI only (Guideline 2.3.3), dark theme, signed in as the paid demo account unless the shot says otherwise
- Status bar clean: 9:41, full signal, full battery, no debug overlays, no admin surfaces
- NO proprietary internals visible: no pick source names of any kind, no scoring-mechanics terminology or internal thresholds, no admin pages, no raw signal breakdowns. Public scores and ranks are fine
- No real user personal data: only the demo account and seeded dummy accounts appear in social surfaces
- If a WNBA or other women's-league game appears, verify the copy uses her, never him/his
- Keep sportsbook logos incidental (the odds-comparison rows are fine); never a "bet now" framing

The six shots, in listing order:

| # | Screen | State | Caption idea (overlay text, humble tone) |
|---|---|---|---|
| 1 | Rankings board | Paid view, full top 50 loaded, #1 pick at top | "The day's board, ranked by our proprietary scoring engine" |
| 2 | Home | Loaded day with games across 3+ sports, live scores visible | "Every major sport, one board" |
| 3 | Game detail | Live game: score, line comparison rows | "Live scores and line comparison" |
| 4 | Tracking | Mixed open + settled bets, P/L chart with data | "Track your bets and your live P/L" |
| 5 | Socials leaderboard | Loaded leaderboard, demo row highlighted | "Follow friends and compare records" |
| 6 | Notification settings | Loaded, several topics on, quiet hours visible | "Alerts tuned to what you want" |

Capture on real hardware or simulator at exact resolution, then add captions in a template that keeps the disclaimer-safe framing. Reuse the same six compositions for the Pixel set.

---

## 7. TestFlight internal testing steps

1. In Xcode, open ios/App/App.xcworkspace. Set the marketing version (1.0.0) and build number, scheme CappingAlpha, destination Any iOS Device (arm64).
2. Product > Archive, then in Organizer choose Distribute App > App Store Connect > Upload. Automatic signing with the LLC team; the Push and Sign in with Apple capabilities from section 8 must already be on the App ID or the upload fails entitlement validation.
3. In App Store Connect, create the app record first if it does not exist: platform iOS, bundle id com.cappingalpha.app, SKU cappingalpha-ios.
4. Wait for the build to finish processing (usually under an hour), then answer export compliance: the app uses only standard HTTPS/ATS encryption, which qualifies for the exemption. Set ITSAppUsesNonExemptEncryption to false in Info.plist so the prompt stops recurring.
5. TestFlight tab > Internal Testing: create a group (e.g. "CA Core"), add up to 100 internal testers by inviting their Apple accounts as App Store Connect users. Internal builds need NO Beta App Review. Enable automatic distribution for new builds.
6. Testers install the TestFlight app, accept the email invite, install the build.
7. Internal pass checklist (a device pass, not a simulator pass; push needs physical hardware):
   - First run: age gate blocks under-18 DOB, carousel renders, notification soft-ask never fires the OS prompt on Maybe later
   - Guest boundary: scores and leaderboards browse signed out, no picks visible anywhere
   - Signup with username, login with email and username, Sign in with Apple, Google sign-in
   - Trial paywall opens cappingalpha.com checkout in the system browser sheet and the deep-link return lands back in the app with the success banner
   - Push permission prompt only after the priming modal; token registers (if 7e is in the build)
   - Account deletion from My Account completes and signs out (use a throwaway account)
   - Offline launch shows the shell, no white screen; airplane-mode a warm launch
   - Safe areas on notch and home-indicator devices, no sideways pan, inputs at 16px+
8. Fix, bump the build number, re-archive, re-upload. When internal is clean, optionally add an external TestFlight group (external groups DO require Beta App Review, roughly a day) as a dress rehearsal for real review.
9. Before submitting for App Review proper: run the /security-audit gate (plan section 10) and the must-verify list in plan section 11.

---

## 8. Sign in with Apple + push entitlement setup (Xcode + portals)

### Apple Developer portal (developer.apple.com)

1. Certificates, Identifiers & Profiles > Identifiers > com.cappingalpha.app: enable the Sign in with Apple capability and the Push Notifications capability on the App ID. Save (this invalidates old provisioning profiles; automatic signing regenerates them).
2. Keys > create an APNs Auth Key (.p8). Download it ONCE, record the Key ID and Team ID. Store the .p8 outside the repo (never commit it).
3. Firebase console (for 7e): Project settings > Cloud Messaging > Apple app configuration > upload the .p8 with Key ID + Team ID. Add GoogleService-Info.plist to ios/App/App and google-services.json to android/app when the messaging plugin lands.

### Xcode (ios/App/App.xcworkspace, target App)

4. Signing & Capabilities > + Capability > Sign in with Apple.
5. Signing & Capabilities > + Capability > Push Notifications. Add Background Modes > Remote notifications only if silent pushes are ever needed (not required for 7e's visible alerts).
6. This writes App/App.entitlements with com.apple.developer.applesignin and aps-environment (development locally; the App Store distribution profile flips it to production automatically). Commit the entitlements file and the pbxproj change.
7. Confirm automatic signing shows the LLC team and no provisioning errors, then build to a device once to validate the entitlements end to end.

### Server + client wiring (7b/7d scope, noted here so submission does not stall)

8. Native flow: the @capacitor-community/apple-sign-in plugin (or a thin custom bridge) returns an identity token JWT. The server verifies the JWT signature against Apple's public keys (https://appleid.apple.com/auth/keys) with audience com.cappingalpha.app, then creates or links the account by the stable `sub` identifier and issues the same bearer token as email login. Apple may return the email only on FIRST authorization: persist it immediately.
9. Handle Hide My Email relay addresses as normal emails (they are). Do not force a real email.
10. If Sign in with Apple is later added to the website too, create a Services ID + web redirect in the portal; not needed for the native-only flow.
11. Guideline 4.8 check before submitting: since Google sign-in is offered, Sign in with Apple (or an equivalent privacy-preserving option) must be live in the same build.

### Android push counterpart (7e)

12. No entitlement equivalent; the FCM plugin plus google-services.json handles it. Android 13+ runtime POST_NOTIFICATIONS permission is requested through the same priming-modal flow.

---

## Pre-submission checklist (both stores, day-of)

- [ ] Re-verify the highest-volatility items in plan section 11: live Capacitor/Xcode minimums, the US external-link rule status, live text of Guidelines 5.3 / 4.2 / 5.1.1(v) / 3.1.1, and Play's real-money-gambling and billing pages
- [ ] Demo account provisioned, comped, and tested on prod
- [ ] Disclaimer block present in: store listings, in-app About/footer, /responsible-gambling
- [ ] Age-rating questionnaires completed on both stores, results recorded
- [ ] Privacy labels and Data Safety form match the shipped build exactly (push token declared only if 7e shipped)
- [ ] /terms, /privacy, /responsible-gambling, /delete-account all reachable on prod
- [ ] /security-audit run after the last code change
- [ ] Screenshots re-captured from the final build if any visible UI changed
