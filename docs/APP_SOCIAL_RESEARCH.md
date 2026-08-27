# App Social Research: Friends in the Intro and the Socials Tab

Branch `app`, worktree `/Users/jack/projects/capperboss-app`. Research date 2026-08-02.

---

## 1. The short answer

- **Build one new onboarding step at 8.5, after the account exists and before the paywall: the invite screen.** It hands the new member their referral code and a share sheet. Zero backend, zero permissions, one file plus a stylesheet. It is the only friend-shaped screen that renders identically on day one and day one thousand.
- **Pair it with a fifth carousel slide** that shows what following members looks like. The slide sells, the step acts. Slide 3 already promises "follow friends" today with no follow-through anywhere in the intro, so this makes an existing claim true.
- **Do not build a "suggested people to follow" step yet.** With a near-empty member base it renders its fallback state for the entire launch window, and today's suggestion query does not exclude seeded accounts, so it would recommend dummy members to a brand-new user on the most trusting screen in the app.
- **In the Socials tab, the single highest-value change is reordering the Friends pane.** The invite card is currently dead last in the DOM and it is the only surface on that pane that works with zero members. Make it the empty state, high on the pane, and delete the "No friends yet" dead end that points at rails which render as empty strings.
- **Cold start is the whole ballgame, and the honest answer is not "find friends", it is "bring one".** Every competitor mechanism (starter packs, hot-streak rails, most-followed) is a query against a populated graph. The referral loop is the only mechanism that creates one, and give 3 / get 3 is already the most generous offer in the competitive set.
- **Five things have to be fixed before any of this ships, and none of them are design work:** there is no way to eject an abusive user (App Store 1.2 blocker), seeded accounts appear in search and suggestions, the follow endpoint ignores blocks and pushes the blocked user's handle to the target, the referral earn cap is `Infinity` with no email verification, and the app's push preference keys do not match the keys the sender reads so opt-outs silently do nothing.
- **Contact sync: no.** Google's April 2026 policy names "inviting or referring someone to join a service" as the case that should not request `READ_CONTACTS`, with an October 28 2026 enforcement date, and iOS 18's limited-access picker degrades the yield anyway. At our member count a contacts match returns zero. It is all cost, no payoff.
- **One structural fact that frames the timeline:** a release build cannot reach production at all today. Bearer auth middleware and the `capacitor://localhost` CORS allowance live only on `app`, not on `master`, which is what `cappingalpha.com` serves. There is already one large pending backend merge. New endpoints join that queue rather than creating a new blocker, but they do not reach TestFlight until it lands.

---

## 2. What we already have

### Shipped and working

| Layer | What exists |
|---|---|
| Graph | `follows` (one-way, instant, no approval state), `social_blocks` with `kind` block or mute, `social_reactions` (Boosts), `social_comments` (400 chars, 20 per hour), `social_reports` |
| Feed | Derived at read time, no event table. Four card kinds: vote, bet, award, house. Boost, Comment, Tail, Fade verbs. Streak rail computed on every request |
| Friends pane | Member search, three suggested rails, friends list, invite card |
| Leaderboard | Week/month/all-time, `scope=all` or `friends`, per-sport, podium, medals, inline follow pill |
| Profiles | Full member popup, follow button, profit calendar, two-ledger toggle, CLV block, medal badges, "Share a win" |
| Referral | Lazily minted code per account, `?ref=CODE` capture on web, auto-redeem after signup, give 3 / get 3 |
| Push | Free VAPID plus native FCM. Topics `social_follow` and `social_tail` already fire |
| Onboarding | Nine-step machine, four-slide carousel, live username availability, Apple and Google sign-in |
| Share | `@capacitor/share` v8.0.1 is already installed and registered on both platforms |

### Built and never surfaced

This list is the cheapest product in the codebase.

- **`kind='mute'` blocks.** Full server support: content hidden one way, follows preserved, target never told. The UI only ever sends `kind:'block'`.
- **Follower list.** `followerIds()` and `followCounts()` exist and follower counts already ship on every profile. No endpoint exposes the list, so you cannot follow back.
- **`user.follows_me`** is computed and rendered as a "Follows you" chip, and never drives a suggestion.
- **`user_bets.tail_of_user_id`** exists, is nulled on account deletion, and is written nowhere. A tail routed into a manual bet loses attribution silently.
- **`profile_json`** (bio, favorite sport, style) is validated, stored, and returned on your own account. `getMemberProfile` never selects it, so nobody can see another member's bio.
- **`leaderboard_awards` medals** are computed and self-healing, and appear on no feed card, friends row, leaderboard row, or search result.
- **CLV per member** is computed on every profile load and barely surfaced. Almost no consumer betting app shows members their closing line value.
- **`.soc-bub`** notification badge CSS exists on the Socials sub-nav and is rendered by nothing.
- **`.soc-why`** CSS exists and is referenced by nothing. `user_bets.notes` exists and Track a Bet already collects a note.

### What is missing entirely

No friend requests, no groups, no head-to-head query, no notification inbox, no comment notification, no follower endpoint, no cold-start suggestion rail, no content filter on any user-generated write path, and no way to ban a user.

---

## 3. What the field does

Kept to the patterns that changed my recommendation.

**Nobody asks for friends before an account exists.** Zero exceptions found across Sleeper, Strava, Duolingo, PrizePicks, Underdog, Splash, BeReal, Bluesky. Identity first, social second. Mechanically unavoidable: you cannot match a user against a graph before they are in it.

**The apps that ask at signup are ones you cannot use alone.** Sleeper needs ten people for a league. Splash needs entrants. FanDuel Friends Mode needs opponents. Solo-utility apps in our exact shape (Betstamp, Pikkit, theScore, Underdog, PrizePicks) either demote it to Settings or skip it. CappingAlpha is fully valuable alone, so a hard friend step would be asking a favor before delivering value.

**The cold-start answer is always follow strangers or follow topics, never add friends.** Pikkit ships Discover rails (popular, most copied, consistent winners). Sleeper ships followable channels per league and per team. ESPN, at enormous scale, asks for favorite teams instead of friends. Strava shows Suggested Follows even to users who never sync contacts. All four solve the empty screen with something that is populated on day one.

**Bluesky starter packs are the best-evidenced cold-start mechanism that exists.** Peer-reviewed, 25 million users: packs drove up to 43 percent of all follow actions at peak, and members of a pack got up to 85 percent more followers. The design detail that matters is that a pack is one tap for many follows, not a list of individual buttons. Worth stealing later, once there are people to put in a pack.

**Social adoption in betting apps is low, and this should set our ambition.** Roughly 2 percent of DraftKings bettors use the social feed, after three years and multiple feature waves, from the largest operator in the category. Do not gate onboarding on it and do not degrade the core product for it.

**A feed can ship before a graph.** FanDuel launched its Community Feed in 2026 with no follow and no comments. Dabble made the feed the homepage. We already have this right: house and award cards are system-generated, so the feed is non-empty at n=1.

**Threads removed the best graph import in the industry.** Meta had one-tap access to the entire Instagram graph and killed it because people preferred building a different graph. That is a live A/B result pointing the opposite way from the standard playbook, and it is the strongest argument that an aggressive early friend import is not automatically correct.

**Deposit-gated referrals are the norm and we should not copy them.** PrizePicks pays $25 after the friend deposits. Underdog pays bonus entries after a $10 deposit. Ours pays on signup, which is more generous and far simpler to explain. Underdog's one genuinely good idea: the referral code is the referrer's username, so it is speakable.

**The two warnings.** Beli gated its app behind inviting four friends with a skip labelled "Give up my invite", and the viral complaint was from a user who could not think of four people. The FTC record on contact handling is expensive: Path $800k, LinkedIn $13M for two reminder emails, Twitter $150M for reusing 2FA phone numbers. Both cases argue for a soft ask and no address book.

---

## 4. The recommended onboarding step

**Build the invite step at 8.5. One screen, after the account, before the paywall, obviously skippable.**

### Placement in the step machine

```
RENDER[8.5] = renderInviteStep;                  // onboarding.js:119-126
// afterAuth :631   else goTo(9, 'fwd');   ->    else goTo(8.5, 'fwd');
```

That is the entire machine change. Three notes, all load-bearing:

1. **Do not widen `setSkipVisible(n >= 2 && n <= 8)`.** Earlier drafts of this design said to. That is wrong and it would be expensive. Skip is wired to `finish()`, not to "next", so it **ends onboarding**. Today step 9 (the paywall) is the only screen where Skip is hidden, and it is reached directly from `afterAuth`. Because `8.5 > 8`, the existing predicate already hides Skip on the new step, which is exactly what we want. Leave line 134 alone and verify `setSkipVisible(false)` is the state on 8.5 before merging. The step gets its own inline "Maybe later" instead.
2. **Do not touch the other two `afterAuth` exits.** Line 623 (`pendingPlan`) is a user who chose a plan on step 9 and bounced back to create an account, and they must go straight to checkout. Line 630 (`isPaying()`) is an existing subscriber. Both correctly bypass 8.5.
3. `goTo` clamps `n >= 2 && n <= 5` to `2`, so a fractional key outside that range is safe. `_cur` is assigned and never read anywhere, so `8.5` breaks nothing.

### The screen

```
.ob-pad.ob-center
  .ob-icon              fa-solid fa-user-plus
  h1.ob-h1
  p.ob-body
  .ob-code              tappable, copies
  .ob-code-cap          "Tap to copy"
  button.ob-btn-gold.ob-btn-block     primary
  button.ob-btn-ghost.ob-btn-block    secondary -> goTo(9, 'fwd')
  p.ob-fine
```

Data comes from `GET /api/account`, which mints the referral code lazily on read. Cache it to `window.__caRef` so the Socials tab can reuse it. New CSS is two rules (`.ob-code`, `.ob-code-cap`) using the existing `--soc` sky tokens, which are defined for both themes.

Share plumbing, in this order, calling the plugin through the `window.Capacitor.Plugins` global rather than adding an export to `native.js` (which would force a cache bump across ten importers):

```js
window.Capacitor?.Plugins?.Share?.share({ title, text: message, url })
  ?? navigator.share?.({ title, text: message, url })
  ?? navigator.clipboard.writeText(`${message} ${url}`)
```

`navigator.share` does not exist in Android WebView at all. That is a live bug in the current `socInviteShare`, and this step must not repeat it. Passing `url` separately from `text` is what makes iOS Messages render a link card instead of raw text.

### Final copy

**Default state**

> **Bring someone, you both get 3 days**
>
> Send your code to someone who follows the same games. When they join with it, you each get 3 free days of full access, and their tracked bets show up in your feed next to yours.

- Code block: `AB7K2M4Q`
- Caption under it: `Tap to copy`
- Primary: `Share my code`
- Secondary: `Maybe later`
- Fine print: `Share it with as many people as you like. Nothing is sent on your behalf. You choose where it goes.`

Two deliberate corrections from the first draft. The old body said "someone who argues with you about games", which frames the product as social gambling banter on an 18+ app carrying gambling-guideline scrutiny. And the old fine print said "One code, no limit on how many people use it", which publicly promises an uncapped referral on the exact screen where we are about to cap it. Say nothing about limits.

**Failure state** (account fetch errors or returns no code)

> **Bring someone along**
>
> Your invite code lives in Socials, under Friends. Share it whenever you like and you both get 3 free days.

- Primary: `Continue`
- No dashed code box, no spinner. Render the failure body immediately and swap the code box in only on a successful fetch, so the step can never hang on a loading state.

**Cold-start variant: there isn't one, and that is the point.** The screen is byte-identical at zero members and at fifty thousand. There is no list to be empty, no rail to collapse, no query that can return nothing. A user who knows nobody on the platform is precisely the user this screen is for, because it asks them to bring someone they already know rather than pretending we are populated.

**Cut the "you arrived with a friend's code" variant.** It cannot fire in the app. `localStorage.ca_ref` is written in exactly one place, from `location.search`, and the Capacitor WebView origin never carries `?ref=`. The only native entry point reads `payment` and nothing else, and the AASA file claims one component with a literal `TEAMID` placeholder. Building that branch produces dead code that will never be exercised in QA. Revisit it in the same session that lands the universal-link work.

### Skip behavior

`Maybe later` goes to `goTo(9, 'fwd')`. Neither label shames the user, which is the specific Beli failure. There is no gate, no counter, no "invite one person to continue". Not now, not later.

**One thing to fix while you are here:** the toast host sits at `z-index: 400` and the onboarding overlay at `z-index: 12000`, so any toast fired from this step renders behind the overlay. On the clipboard path the toast is the only feedback the button did anything, and that path is the Android default. Give the step its own inline confirmation instead: swap the button label to `Copied` for two seconds.

### Follow-up nudge

No push. A "come invite people" notification is promotional under Apple 4.5.4 and would need its own opt-in consent language. The invite lives in four passive places instead:

1. Socials, Friends pane, as the empty state (Tier 1 below).
2. Profile tab action row, as a third button next to Bet History and My Sportsbooks. The row already flexes.
3. Settings, under Membership, where it already is.
4. The Tracking tab's friends block, which today is dead text with no button on the tab most users live in.

### Runner-up, in two lines

**Option: a "follow a few members" list at the same 8.5 slot.** Better product once the graph exists, and the step machine change is identical, so swapping it in later costs nothing. Overrule me if you would rather ship it now, but know that it renders its "Early days here" fallback for every user until we have six or more public, non-seeded members with five graded decisions each, and it needs the `is_dummy` filter fixed first or it will recommend seeded accounts.

---

## 5. The recommended Socials tab work

### Diagnosis

The Friends pane is ordered backwards for a pre-launch app. Search is first and returns nothing. The three suggested rails are second and render as literal empty strings, so the pane silently collapses. The friends list is third and its empty state says "Follow members above or search by name" while pointing at rails that are invisible. The invite card, the only surface that works with zero members, is last.

Meanwhile the Feed never shows its designed empty state, because you are always your own author, so a brand-new user sees exactly one house card and no prompt at all.

Fix order, not features.

---

### Tier 0: fix before any of it (not design work, but it gates everything)

| # | Fix | Why it blocks |
|---|---|---|
| 0.1 | `users.banned_at` plus a check in the session path, `POST /admin/api/social-reports/:id/resolve`, and an admin comment delete wired to the flag that already exists | Apple 1.2 and Play both require the ability to eject an abusive user. The admin queue is read-only by its own comment, `social_reports.resolved` is queried and never written, and every proposal here increases the number of screens where a stranger reaches a new member |
| 0.2 | `AND COALESCE(u.is_dummy, 0) = 0` in `rebuildSuggested`, `searchMembers`, and `rankAll` | `is_dummy` exists and is referenced only in `dummy_accounts.js`, `db.js`, and `auth.js`. Seeded accounts currently appear in search, suggestions, and the public leaderboard as real members. Independently an FTC exposure, already flagged in the compliance research |
| 0.3 | Block check plus rate limit on `POST /api/follow/:userId` | It does not call `isBlockedEitherWay`, which exists and is used by the feed. Block someone, they re-follow, and you get a push containing their handle. That is the 1.2 "ability to block" claim failing in the exact way a reviewer tests it. Follow, boost, and report are also the only unlimited write endpoints in the app |
| 0.4 | Push topic key rename **with a migration** | The app settings screen writes `social_tails` / `social_follows` / `social_comments`; the sender reads `social_tail` / `social_follow`. Opt-outs currently do nothing, which is precisely the Apple 4.5.4 clause. This is not the "three-word fix" an earlier draft called it: unset preference means ON, so a naive rename takes a user who explicitly toggled a topic off and hands them an unset key, silently opting them back in. Rename plus a one-time pass over every `notify_prefs` blob |
| 0.5 | Content filter on comments, usernames, and (if 2.2 ships) bios | Apple 1.2 requires a filtering method. Comments check length and rate only. Usernames pass a character-class regex with no wordlist. A vendored public-domain slur list is a single file |

---

### Tier 1: this session, front end plus one line of backend

**1.1 Reorder the Friends pane and load it once.**

```html
<div class="soc-search">…</div>
<div id="soc-search-results"></div>
<div id="soc-week"></div>          <!-- NEW -->
<div id="soc-friends-list"></div>  <!-- MOVED UP -->
<div id="soc-suggested"></div>     <!-- MOVED DOWN -->
<div id="soc-invite"></div>
```

`loadFriendsHub` fetches `/api/friends` once, sequentially, then fans the result out to the renderers. Today `renderFriends` fetches it privately and nothing else can see the count. Set `_friendsLoaded = true` only after the fetches settle, or reset it in the catch, or a deep link that beats `checkAuth` leaves you with three empty panes and no way to retry without `force`.

**1.2 The invite card becomes the empty state.** When `friends.count === 0` it renders high on the pane under a "Your circle" eyebrow. When you have friends it drops to the bottom as a standing offer. Same card, one number decides the position. Delete the "No friends yet" dead end.

> **Your circle**
>
> **Right now it is just you and the board**
>
> Invite someone who follows the same games. When they join with your code you both get 3 free days of full access.
>
> `AB7K2M4Q`  `Share`  `Copy`
>
> `Browse the leaderboard`   `Search a username`

When `count > 0`, the standing card plus a progress line:

> **Bring a friend, both get 3 days**
>
> Share your code. When a friend joins with it you each get 3 free days of full access.
>
> `3 people have joined with your code. That is 9 free days so far.`

Singular form: `1 person has joined with your code. That is 3 free days so far.` Say "people", not "friends". Friends means mutual follows everywhere else in this codebase and referral redeemers are not that.

Share message, with the url passed as a separate field:

> `3 free days on CappingAlpha, for both of us. It ranks the day's picks and shows how every one of them settles. My code is already applied at this link:`

Toast on copy: `Code copied`.

**1.3 Your week.** `GET /api/leaderboard?window=week&scope=friends` returns you plus every followee plus one combined CappingAlpha house row, with `min_votes` dropped to zero.

Corrected from the first draft, which rendered a two-column scoreboard between the user and the product at n=1. At zero and at five members that card reads `You  0-0  /  CappingAlpha  +3.10u`, or worse, `CappingAlpha  -4.20u` when the house has a bad week on a five-game sample. Making the app's own losing week the lead item on the Friends pane, or putting a brand-new member on the losing side of a scoreboard on their first visit, is not a card worth building.

So: **the versus layout only appears once the circle has more than one member.**

*Circle is just you, no graded picks:*
> **Your week**
>
> No graded picks yet this week.
>
> Vote on a pick or track a bet and your week starts showing up here.
>
> `See today's board`

*Circle is just you, you have picks:*
> **Your week**
>
> `+1.85u`
> `4-2 · 67% win`
>
> Add someone to your circle and this card keeps score for them too.
>
> `Invite a friend`

*Circle has friends:*
> **Your week in your circle**
>
> `You  +1.85u  4-2`   VS   `@nate  +4.20u  9-4`
>
> You are **#2 of 6** in your circle this week.
>
> Then up to three member rows, yours highlighted, tapping opens the member popup.

Rules: never say beating, crushing, or on fire. State the number. Ties read as level, not as a win.

**1.4 Cut "The line to beat" rail.** An earlier draft proposed a second `GET /api/leaderboard?window=all` call to render CappingAlpha house profiles as a follow-shaped rail. Dropping it, for two reasons. The house rows already ride the `scope=friends` response, so it was a duplicate aggregation. And the leaderboard endpoint has no memo anywhere: `gradedRows` is a full scan of `game_votes` plus a full users join on every call. Opening the redesigned pane would have fired four uncached full-table aggregations. It is fine at 50 users and it is the first thing that falls over at 5,000. The board itself already carries the house record, and the Rankings tab is one tap away.

**1.5 Suggested rails must never render nothing.**

> **Members to follow**
>
> **Nobody to suggest yet**
>
> Suggestions show up here as members build a graded record. The leaderboard is the place to look meanwhile.
>
> `Board`

One row tall, honest, and it points at a surface that is populated. It does not pretend there are people.

**1.6 Feed starter card.** Pin one card above the feed when the member follows nobody.

> **Fill your feed**
>
> Right now this is you and the board. Follow a member or invite someone, and their picks, results, and streaks land here as they happen.
>
> `Find members`   `Invite a friend`

Corrected gating. The first draft used a client heuristic (streak rail length plus item authorship), which fires falsely for a member following twenty people who happen to be quiet this week, pinning "it is just you and the board" above their populated feed with no dismiss control. `getFeed` already computes the followee list. Return `following_count` in the payload and gate on `following_count === 0`. One line each side. That one line is the only backend in Tier 1, and it joins the existing merge queue.

Also fix the feed's quiet-state copy, which currently says "Try the Friends tab":

> Follow a member or invite someone, and their picks and results land here.

**1.7 Search misses convert to invites.** Searching for a friend who is not on the platform is the highest-intent invite moment in the app, and today it produces one grey sentence.

> **No member named "nate"**
>
> If that is someone you know, send them your code and you both get 3 free days.
>
> `Invite`

Placeholder becomes `Search members by username`.

**1.8 A real report sheet, with mute.** Replace the two stacked `window.confirm` calls with a bottom sheet reusing the Track a Bet sheet chrome. Mute is fully supported server-side and has never had UI. Reviewers tap this.

> **@nate**
>
> `Report this post` · Send it to us for review.
> `Mute @nate` · You stop seeing their activity. They are not told.
> `Block @nate` · You both stop seeing each other, and you stop following one another.
> `Cancel`

The block line must state the follow cut, because blocking deletes both edges and unblocking does not restore them.

**1.9 Satellite entry points and small consistency.** Third button on the Profile action row (`Invite Friends`). A button on the Tracking tab's friends empty state, with copy `Your circle is empty. Follow a member from the leaderboard, or invite someone and you both get 3 free days.` And `haptic('light')` on `socFollow`, which is the only social verb in the app without one.

---

### Tier 2: small named backend additions, after the merge

Ordered by value per line.

| # | Addition | Unlocks |
|---|---|---|
| 2.1 | **Bet notes in the feed.** Add `user_bets.notes` to the bet select, render as `.soc-why`, which already exists in CSS and is referenced by nothing. Track a Bet already collects the note | The bettor's own one-line reason. Dabble's bet descriptions are why their feed is readable. It is text, not a wager, and it works at twelve members. Highest ratio of product to code available |
| 2.2 | **Comment notification.** `sendOnce(owner, 'social_comment', …)` plus a `TOPICS` entry | The preference key is already accepted and stored and nothing reads it. Someone replying to your pick and you never hearing about it is the most obviously missing loop in the tab. Requires 0.4 first |
| 2.3 | **`GET /api/followers`** wrapping the existing `followerIds()` | A "Follow back" rail, which is the only member-shaped rail populated for a *new* user the moment anyone finds them. Also the first honest use of `.soc-bub`. **Must** filter through `canViewMember` and `hiddenAuthorSet` first: the naive version returns a private one-way follower's full record, breaking the mutual-follow rule, and includes people you blocked |
| 2.4 | **Cold-start suggestion rails.** Add `new_members` and `same_sports` (overlap on `favorite_sports`) to `rebuildSuggested` | All three current rails gate on a 3-win streak, a 7-vote weekly minimum, or existing follower counts, so all three are empty at launch. Requires 0.2 |
| 2.5 | **Tail attribution on manual bets.** Write `user_bets.tail_of_user_id` in the bets POST path when Track a Bet carries `_tailOf` | The column exists, is nulled on account delete, and is written nowhere, so tail counts undercount silently |
| 2.6 | **Referral link plumbing.** Real Team ID plus a `ref` component in the AASA, `ref` capture in the native `appUrlOpen` listener, `afterAuth({ redeemRef: true })` on the Google and Apple paths, and `?ref=` on the two share-a-win messages | The social-signup drop is a live bug that costs both parties 3 days. Every shared win is currently an uncredited invite. Note the AASA and assetlinks files deploy from **master**, so editing them in this worktree changes nothing until merged |
| 2.7 | **`profile_json` on member profiles** | Nobody can see another member's bio today. Makes profiles feel populated at small n. **Hold until 0.1 and 0.5 land**: this is five lines of code and a brand new moderation surface, and it needs a "Report this profile" affordance shipped with it |
| 2.8 | **Head-to-head** between two members, gated on `canViewMember` both directions | "You and @nate are 4-2 on the same games." Cheap, high flavor. Auto-surface after three disagreements rather than making people go looking. Keep the copy a record comparison, never anything that reads as two members having something at stake |
| 2.9 | **QR on the invite card**, using a vendored encoder under `public/vendor/` to satisfy the CSP | Two people in the same room is the highest-converting invite context, and no camera permission is needed on either side because the stock camera apps open URLs |

---

### Tier 3: plan, do not build

**Crews and private circles.** The backend is nearly free, because `rankAll` already ranks an arbitrary id set with no minimum. The cost is entirely UI plus a second moderation surface (crew names are user content). But an empty crew is a dead screen with one member, so ship it when invite volume shows people are actually bringing friends. Cap size around 25 and rate-limit creation.

**Shareable weekly recap PNG.** The rasterizer, vendored fonts, and fail-safe fallback all exist in the og-card pipeline, so it is one SVG builder plus a route. It waits because the privacy gating is the hard part: a public unauthenticated URL keyed by user id is a record-privacy bypass by enumeration. Opaque token, gated on the member being public, no dollar figures unless the owner shows stakes.

**"Who is on this" social proof on pick and game rows.** Makes the existing vote feature social with no new write path, which is a strong idea. Needs a floor (hide below roughly eight votes on a game) or day one shows "1 member is on this", which is worse than nothing. Count only accounts with a graded pick so alt accounts cannot inflate a side.

**Solo achievement badges, including CLV.** Gives a friendless day-two user a reason to return, which is the actual pre-launch retention problem. CLV is already computed per member and almost no consumer app surfaces it. Every badge must derive from graded results, never from an action the user controls unilaterally, or they get farmed. Names stay humble: "Sharp close" is fine, "Certified winner" is not.

**Activity inbox.** Worth it once there are four notification types worth collecting. Reuses `.soc-bub` and folds in 2.2 and 2.3.

**Friend streaks.** The Duolingo mechanic is real (22 percent more likely to complete a daily lesson) but a daily streak that breaks unless you place a bet is engineered pressure to wager daily on an 18+ app. If it is ever built, it counts days you engaged with the board, never days you voted or placed. If that version is not compelling, build nothing.

---

## 6. The build plan

### Before you start

The working tree is dirty: `public/modules/socials.js` and `src/social.js` both carry uncommitted edits (a result-colour fix and a P/L fix). Commit them separately first, or a socials.js rewrite buries unreviewed work in one unreadable diff.

### File by file

| File | Changes |
|---|---|
| `public/modules/account.js` | **First:** the notify-key rename plus migration (0.4). Then the Tracking-tab button, the Profile action button |
| `public/modules/onboarding.js` | `SHOTS.friends` mockup, fifth `SLIDES` entry (the carousel derives dots, back visibility, and the Continue label from `SLIDES.length`, so no other change), `RENDER[8.5]`, `afterAuth:631` retarget, new `renderInviteStep`. **Do not touch line 134** |
| `public/onboarding.css` | Four rules: `.ob-shot-av`, `.ob-shot-pill`, `.ob-code`, `.ob-code-cap` |
| `public/index.html` | Reorder `#soc-pane-friends`, add `#soc-week`, add roughly 30 lines of `.soc-vs` / `.soc-foot` / `.soc-inv-alt` CSS, search placeholder |
| `public/modules/socials.js` | `loadFriendsHub` rewrite, new `renderWeek`, `renderFriends` branch A, `renderInvite(count)`, `emptySuggested`, feed starter card, `socInviteShare` Android fix, `referralInvite`, `socCopyCode`, `socFocusSearch`, `runSearch` miss row, report sheet, follow haptic, window exports |
| `src/social.js` | One line: return `following_count` in the feed payload |

`socFocusSearch` must use `scrollIntoView({ block: 'center' })`, not `'start'`. The sub-nav is sticky at a different offset under `html.ca-app` than on web, and `'start'` puts the input under it in the app only.

Call `Share` through `window.Capacitor.Plugins`, not through `native.js`. Adding an export there forces a cache bump across ten importers. Do not tidy it up later.

### Cache busters

Every value below was read out of the file.

| Module | Current | New | Bump in |
|---|---|---|---|
| `modules/onboarding.js` | `?v=2` | `?v=3` | `app.js:24` (only importer) |
| `/onboarding.css` | `?v=2` | `?v=3` | `index.html:95` |
| `modules/socials.js` | `?v=7` | `?v=8` | `app.js:12` (only importer) |
| `modules/account.js` | `?v=70` | `?v=71` | `app.js:13` (only importer) |
| `app.js` | `?v=159` | `?v=160` | `index.html:4859` |

The service worker caches any `?v=` URL immutably, and there are two independent ways to break this: edit a module without bumping its importer, or bump the importer without bumping `app.js` in `index.html`. Both must move. Ship check: `git diff origin/master -- public/app.js public/index.html | grep '?v='`.

`native.js` (`?v=2`), `utils.js` (`?v=7`), `leaderboard.js` (`?v=17`), and `track.js` (`?v=53`) do not change. Keep it that way.

### Order and time

| Step | Est. |
|---|---|
| Commit the dirty files | 5 min |
| 0.4 notify keys plus migration | 30 min |
| Onboarding step 8.5 | 1.5 to 2 h |
| Carousel slide 5 | 30 to 40 min |
| Friends pane reorder plus `loadFriendsHub` | 30 min |
| Invite as empty state, Copy button, progress line, Android share fix | 1 to 1.5 h |
| Your week (three states) | 1.5 h |
| Small honest states: empty suggested, feed starter, search miss, copy fix, follow haptic | 45 min |
| Satellite invite entry points | 20 min |
| Report / Mute / Block sheet | 1 h |
| Cache busters plus verify | 10 min |

**Roughly 8 hours.** A natural cut line after the invite-as-empty-state gives a coherent ship in about 5: the intro asks for a friend, the Friends pane leads with something real, and the invite card is where it belongs. The minimum viable version is the notify-key fix plus step 8.5 plus cache bumps, about 2.5 hours, one module and one stylesheet, no backend, and it cannot break the Socials tab at all.

Tier 0 items 0.1, 0.2, 0.3, and 0.5 are backend and are their own session. They gate submission, not this build, but they gate submission absolutely.

### What is blocked on a master merge

**The recommended ship needs zero new endpoints.** Every surface uses a route that already exists on master: `/api/account` (referral code), `/api/leaderboard` (with `scope`), `/api/friends`, `/api/social/suggested`, `/api/social/block/:id` with `kind:'mute'`, `PUT /api/account/preferences`.

The `following_count` line and everything in Tier 0 and Tier 2 lands on `app` and merges later.

**The thing to understand about "later":** `app` is 35 commits ahead of master and carries bearer middleware, `capacitor://localhost` CORS, push, DB migrations, and two new modules. A release build points at `cappingalpha.com`, which is master, which has none of that. **Every authenticated call from a release build fails today, with or without this work.** So the backend merge is already the single gate on the whole app. New endpoints join a queue rather than forming a new blocker. The dev loop is unaffected: the Capacitor config points at localhost:3013, the social routes are all in `MIRROR_SKIP`, so everything here works immediately under `npm run app:dev`.

Also worth knowing before any "let's look at it on device" session: `capacitor.config.json` is checked in with `server.url: http://localhost:3013` and `cleartext: true`, carrying its own warning to run `npm run app:prod` before a release build.

### Verify before commit

1. Fresh install path: clear `ca_onboarded` and `ca_age_ok`, reload with `?onboard=1`, walk 1, 2 (five slides), 6, 7, 8, 8.5, 9.
2. **Confirm Skip is hidden on 8.5** and that `Maybe later` reaches the paywall.
3. Paying user: `isPaying()` still calls `finish()` and never sees 8.5.
4. Pending plan: choose Annual from step 9 logged out, land on 8, create the account, confirm it goes straight to checkout and never through 8.5.
5. Friends pane with zero follows: invite card renders high, Your week renders its solo state, no pane is blank.
6. Android: the share button actually opens a share sheet, not a silent clipboard write.

---

## 7. What not to build, and why

**Contact sync. Verdict: no.** Three independent disqualifiers, any one of which is enough. Google's April 2026 policy names "inviting or referring someone to join a service" as the case that should not request `READ_CONTACTS`, with an October 28 2026 deadline after which non-compliant apps are blocked from Play updates. iOS 18's limited-access picker means a large share of grants return a handful of contacts, so the feature is unreliable even when allowed. And at our member count the literal output is "0 of your 400 contacts are here", which is the worst possible first impression on the most trusting screen in the app. Server-side hashing does not change the permission requirement, the privacy label entry, or the Play declaration, and hashed phone numbers are brute-forceable in seconds so they are not anonymous either. Revisit at maybe 5,000 members, not before.

**Deferred deep link attribution.** Android's Play Install Referrer API is free and first-party, worth doing eventually. iOS has no equivalent, and the vendor workarounds are IDFA matching (needs App Tracking Transparency) or clipboard matching (dead since iOS 16, which prompts on any programmatic read). The honest free design is a readable code on a web landing page that the user can paste. Nothing about the invite step should depend on the deferred case working.

**Group chat.** The value is real and the cost is disqualifying for a one-person team. An 18+ betting-adjacent app with open rooms inherits the full 1.2 burden plus "DM me for locks" tout spam, which is exactly the positioning risk we cannot afford. We already have the healthy version: per-game chat, bounded by a game that ends. Apple also revised 1.2 in February 2026 specifically to pull anonymous and random chat under it.

**Any leaderboard with prizes.** Three problems stack. State contest registration and bonding thresholds trigger on prize value in Florida, New York, and Rhode Island. Apple 5.3 requires developer sponsorship, in-app official rules, and an explicit statement that Apple is not a sponsor. And we sell a paid tier where paid users see fifty picks and free users see one, so if placement is materially easier with the subscription, the purchase starts to look like consideration. Bragging rights and medals only.

**Member-versus-member wagering, staking, challenges, or peer-to-peer anything.** Not a "later" item, a never item. Any money movement between users converts this from a sports data platform into real-money gaming under 5.3, which requires licensing in every jurisdiction of use, geo-restriction, and free distribution. It would also undo the Phase 6 positioning work.

**Copy trading and auto-tail into a ledger.** Auto-placing is impossible without a book integration, which is a licensing problem rather than an engineering one. Auto-tracking someone else's pick into your ledger is worse in a subtle way: it corrupts the verified record the entire leaderboard's credibility rests on, because your record would contain picks you never decided on. The two-ledger split exists to keep verified and unverified separate. Do not blur it.

**One-click tail that places or links a bet.** Our Tail opens Track a Bet as a log entry. That distinction is the whole compliance story and the copy must never blur it.

**Daily wagering streaks.** Covered above. Activity streak or nothing.

---

## 8. Open questions for Jack

**1. Referral earn cap.** The code sets it to `Infinity` (your call, 2026-07-28). The only guard is one redemption per referred account, signup has no email verification, and signup shares the login rate limit at ten per fifteen minutes per IP. That is 30 free paid-days per fifteen minutes from throwaway addresses, stacking, with no card and no mailbox. Today it is a quiet leak because nobody knows. The invite step advertises the loop on the first screen after signup and puts the card in four more places, so it becomes a documented one.

- **A:** leave it uncapped, accept the leak, monitor redemptions.
- **B:** cap the referrer at 30 lifetime days (which is what CLAUDE.md still documents) and credit the referrer only after the referred account has one graded action.
- **Recommend B.** The referred side still gets their 3 days instantly, so the invite screen's promise is unchanged. This also decides the fine print, so it has to be settled before the copy ships.

**2. Seeded accounts on the public leaderboard.** Filtering them out of search and suggestions is not optional (item 0.2). The board is a separate call.

- **A:** leave them on the public leaderboard, filter only search and suggestions.
- **B:** filter them everywhere a non-admin can see a member.
- **Recommend B.** A new member arriving from the invite step is told to "browse the leaderboard" as their fallback, so the board is now a recommended destination. A seeded account presented there as a rankable member is the same FTC question already open in the compliance research, and it is cheaper to close it now than to unwind it after launch.

**3. Avatars.** Uploaded images are unmoderated user content with no report path, no filter, and no admin removal. That is a 1.2 finding a reviewer can produce in thirty seconds.

- **A:** keep uploads, add a report path plus admin nuke, accept the review risk.
- **B:** ship launch with a generated avatar set (initials plus colour, which the app already renders as a fallback) and re-enable uploads once moderation tooling exists.
- **Recommend B.** It removes an entire class of risk for the price of a feature almost nobody has used yet, and it makes the 1.2 answer trivially demonstrable.

**4. Where the invite step sits.** It is one screen between account creation and the paywall.

- **A:** at 8.5, before the paywall, as specified.
- **B:** after checkout, so nothing at all comes between the account and the trial pitch.
- **Recommend A**, with one condition: Skip stays hidden on 8.5 so the paywall is still unavoidable, and the secondary button is a plain `Maybe later` that lands directly on it. That preserves every paywall impression. If we later measure a drop in trial starts, moving it is a one-line change.

---

## 9. Risks and blockers

| # | Risk | Consequence | Fix |
|---|---|---|---|
| 1 | **No way to eject a user.** No `banned` column anywhere. The admin report queue says "read-only for now" in its own comment and `resolved` is never written. The admin comment-delete function exists and no route calls it | App Store 1.2 rejection, Play UGC policy violation. Every surface in this document increases the exposure | `users.banned_at` plus a session check, a resolve route, and wire the admin delete flag. Before submission, not before this build |
| 2 | **No content filter on any write path.** Comments check length and rate. Usernames pass a character class. Bios (if 2.7 ships) are free text | Same rejection. "A method for filtering objectionable material" is a literal 1.2 requirement and a demo of it is often what clears an appeal | Vendored public-domain wordlist with leetspeak normalization, applied to comments, usernames, and bios in one place |
| 3 | **Follow bypasses blocks and pushes the blocked handle.** The follow route never calls `isBlockedEitherWay`, which exists. Blocking deletes both edges, and nothing stops an instant re-follow, which fires a push containing the blocker's handle | The "block abusive users" claim failing in the exact way a reviewer tests it | Block check plus a 403 in the follow route, and a rate limit on follow and report |
| 4 | **Push opt-outs silently do nothing**, and the naive rename re-opts users in because unset means ON | Apple 4.5.4 requires a working opt-out method for anything the user can turn off | Rename plus a one-time migration over every stored preference blob. Never ship the rename alone |
| 5 | **Seeded accounts appear as real members** in search, suggestions, and the leaderboard | FTC exposure independent of any app store. Also the reason not to ship a suggested-follow onboarding step yet | `is_dummy = 0` in three queries, plus question 2 |
| 6 | **Uploaded avatars are unmoderated images with no report path** | 1.2 finding | Question 3 |
| 7 | **A proposed `/api/followers` leaks private members' records.** `followerIds()` returns every row unfiltered and `publicUser` attaches a full W-L-units record with no privacy check | A private one-way follower's record exposed, breaking the mutual-follow rule, and blocked users surfaced in your own rail | Filter through `canViewMember` and `hiddenAuthorSet`, return `private_hidden: true` with zeroed stats, matching the friends-list precedent. Do not build 2.3 without this |
| 8 | **Tier 3 recap PNG is a public unauthenticated URL by definition** | Record and stake privacy bypassable by enumerating user ids | Opaque token, gated on the member being public and on hide-stakes, before that route exists |
| 9 | **Leaderboard has no query memo.** Every call is a full `game_votes` scan plus a full users join | Fine at 50 users, first thing to fall over at 5,000. Already the reason the house rail was cut | A 60-second memo keyed on window and sport, before member count grows |
| 10 | **A release build cannot reach production.** Bearer middleware and `capacitor://localhost` CORS exist only on `app` | Every authenticated call from a TestFlight build fails today, independent of this work | The app-to-master backend merge. It is already the single gate on the whole app |
| 11 | **Social signups drop a stashed referral code.** The Google and Apple paths pass an empty options object, so the redeem never fires | Both parties silently lose 3 days | One argument on two lines. Free |
| 12 | **The AASA file has a placeholder Team ID and claims only the payment component**, and assetlinks has an all-zero fingerprint. Both deploy from master, not this worktree | Invite links never open the app, on either platform | Real Team ID, a `ref` component, real Play signing fingerprint, merged to master |
| 13 | **Age rating questionnaire.** Apple added social-media questions on 2026-07-09, required for all new submissions from September 2026. A feed with Boost, Tail, and Comment is squarely a social capability | Expect a Social Media descriptor alongside the 18+ gambling rating | Answer honestly. Both descriptors are survivable. An inconsistency is not |
| 14 | **Toasts fired from inside the onboarding overlay are invisible** (z-index 400 under 12000). The clipboard path is the Android default and the toast is its only feedback | Users tap Share, nothing visible happens, they leave | Inline `Copied` state on the button. Do not rely on the global toast from inside the overlay |

---

### Copy discipline check

Every user-facing string proposed in this document was checked against the rules. No em dashes. No source names, no scoring mechanics, no percentile or band language. No certainty words. The strongest claim anywhere in the set is "ranks the day's picks and shows how every one of them settles", which is a description of the ledger, not a promise about outcomes.

One vocabulary decision worth locking: the offer is written **one way** in all five places it appears. "Bring a friend, both get 3 days" in headlines, "you both get 3 free days of full access" in bodies, and the Settings row subtitle changes from "Give 3 days, get 3 days" to match. Three phrasings of one offer across three surfaces reads as three different offers.