# The App Workshop

How to refine, test, and ship the CappingAlpha app from `~/projects/capperboss-app`. This directory is the app's home: a permanent git worktree on the `app` branch, separate from the website's day-to-day work, sharing one repo and one backend.

## The mental model

| Thing | Where it lives | How it ships |
|---|---|---|
| App UI (screens, onboarding, styles) | `public/` on the `app` branch | Bundled into the binary; ships via TestFlight / store update |
| Backend, data, algo, paywall | Same repo, deployed on Railway from `master` | Ships instantly on Railway deploy; the app picks it up with zero app update |
| Native shells | `ios/`, `android/` | Xcode / Android Studio builds |

**The app always talks to the Railway server in production.** One backend, one database, one Stripe. There is no separate app backend. Most day-to-day improvements (picks, scoring, new data) reach app users with no app update at all, because they are server-side.

**Separation from the website** = this directory + the `app` branch + the store release pipeline. The website keeps shipping from `master` on its own schedule. Nothing here touches Railway until deliberately merged.

## Daily loops, fastest first

### Loop 1: browser (seconds per change)
```
cd ~/projects/capperboss-app
npm run app:serve          # dev server on http://localhost:3013
```
Open `http://localhost:3013` (add `?onboard=1` to see the first-run flow any time). Edit files in `public/`, refresh. Chrome device mode (375 wide) for phone layout. This is where 90% of UI refinement happens.

### Loop 2: the real app in the iOS Simulator (the shell, live)
```
npm run app:serve          # terminal 1: dev server
npm run app:dev            # terminal 2: point the shell at localhost:3013
npx cap run ios            # boots the Simulator running the REAL app shell
```
The app loads straight from your dev server: edit `public/`, reload in the app, changes appear. Splash, haptics, plugins, login all real. API calls and login hit YOUR local server, never prod (native.js only rewrites to cappingalpha.com when running from the bundled shell).

### Loop 3: your physical iPhone, same Wi-Fi
```
npm run app:serve
npm run app:dev -- --lan   # uses your Mac's Wi-Fi IP instead of localhost
npx cap run ios            # pick your device in the target list
```
First device run needs your Apple ID trusted on the phone (Settings > General > VPN and Device Management).

### Loop 4: prod-like build (what reviewers and users get)
```
npm run app:prod           # bundle public/ into the binary, production API
npm run app:ios            # opens Xcode: build/run or Archive for TestFlight
```
This build talks to the live Railway server exactly like the shipped app.

**Rule: always `npm run app:prod` before any Archive or TestFlight upload.** `capacitor.config.json` carries a loud `__DEV_SERVER__` marker whenever the dev state is active.

## Making changes to the app ONLY (not the website)

Three tiers, use the lightest one that fits:

1. **Branch divergence (the default).** The app bundles `public/` from THIS branch (`app`) at build time; the website serves `master` from Railway. So any commit here that never merges to master is app-only automatically. Good for: app screens, onboarding tweaks, app-specific layout work.
2. **`html.ca-app` CSS scope.** The shell stamps `ca-app` on the root element before first paint (website never gets it). `html.ca-app .ca-tabbar { ... }` styles the app only, even for code that lives on both branches. Good for: styling differences you want to keep through master merges.
3. **`isNative()` JS gate** (from `modules/native.js`). Behavior differences: `if (isNative()) { ... }`. Good for: app-only features, hiding web-only UI, native plugin calls.

Server note: there is no app server, so `/api` behavior changes always ship via Railway and affect both surfaces. If server behavior must differ for the app, branch on the request (app requests carry `Authorization: Bearer` and send `client:'app'` at auth).

Rule of thumb: if the site would also benefit, build it un-gated and merge to master later; if it only makes sense in the app, tier 1 or 2. Keeping divergence small keeps the master merges painless.

## Sending updates after launch

1. **Server-side change** (data, scoring, paywall, copy served by API): deploy Railway as always. Every app user has it immediately. This covers most updates.
2. **App UI change** (`public/`): commit on `app`, `npm run app:prod`, bump the build number in Xcode, Archive, upload. TestFlight is installable in minutes; App Store review after the first approval is typically about a day. Google Play similar.
3. **Native change** (new plugin, icons, config): same as 2, plus `npx cap sync` first.
4. Later option: an OTA service (Capgo free tier) can push `public/` changes without store review. Deliberately not wired yet; revisit after launch if store-update cadence feels slow.

## Keeping up with the website

The website keeps improving on `master`, and the app bundles the same `public/`. Periodically (and always before a release):
```
cd ~/projects/capperboss-app
git fetch origin
git merge origin/master     # bring the site's latest UI into the app branch
```
Resolve `?v=` cache-buster collisions by taking the HIGHER number and re-checking the file content (two sessions bumping the same counter with different content is the known trap). Then re-test loops 1-2.

## Ports and places

| What | Where |
|---|---|
| Workshop | `~/projects/capperboss-app` (branch `app`) |
| App dev server | `localhost:3013` (`npm run app:serve`, UI_ONLY, throwaway local DB) |
| Website working tree | `~/projects/capperboss` (unchanged, its own ports) |
| Store submission packet | `docs/APP_STORE_SUBMISSION.md` |
| Launch plan / screen inventory | `docs/APP_LAUNCH_PLAN.md`, `docs/APP_SCREEN_INVENTORY.md` |

## One-time setup still on Jack

- Xcode 26+, then in the App target: enable Sign in with Apple + Push Notifications capabilities
- Team ID into `public/.well-known/apple-app-site-association` (replaces TEAMID)
- Firebase project + APNs .p8 + `google-services.json` + `FIREBASE_SERVICE_ACCOUNT` on Railway (push stays silently off until then)
- Play App Signing SHA-256 into `public/.well-known/assetlinks.json`
- 1024x1024 app icon source art
