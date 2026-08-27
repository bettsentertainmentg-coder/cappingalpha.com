# Betslip scan — a screenshot becomes a tracked bet

**Shipped 2026-08-26.** Turns a sportsbook screenshot into a bet on the user's
record, on the web today and from the iOS share sheet in the app.

Keep this file in sync with `src/betslip_parse.js`, `src/betslip_match.js`,
`src/betslip_router.js` and the scan block in `public/modules/track.js`.

---

## 1. The two rules

Everything here follows from two decisions Jack made on 2026-08-26.

**Trust.** A scanned bet gets no special trust and no special penalty. It clears
the same two gates as a bet placed by tapping a line in the app:

| Gate | Where it lives | Effect |
|---|---|---|
| Pregame only | `isTrackingClosed(game)` in `src/pick_cutoff.js` | Started or suspended = never a verified track |
| Inside the book range | `VERIFY_TOL = 0.09` on decimal odds, and on the line for spread/total | Outside the band = personal bet |

Clear both and it rides `POST /api/game/:id/vote` as a verified tracked bet.
Miss either and it lands in `user_bets` as a personal bet, still auto-graded off
the game when we know which game it is. In Jack's words: *"as long as it's within
range and before the game starts, like any other tracked bet, yes have it count."*

There is deliberately **no verified-write endpoint** in `betslip_router.js`. A
verified track is only ever created by the existing vote endpoint, through the
existing confirm slide, after a human has looked at the numbers.

**Privacy.** The screenshot never leaves the device. OCR runs locally, and only
the extracted TEXT is posted. No server here ever holds a user's betslip image.

---

## 2. The path

```
screenshot
   |
   |  device-side OCR  (free, offline)
   |    web    -> Tesseract.js, vendored at /vendor/tesseract
   |    iOS    -> Apple Vision (CANativePlugin.swift), also returns word BOXES
   v
POST /api/betslip/parse   { text, blocks? }        <- text only, never the image
   |
   |  betslip_parse.js   rules parser  -> bets[]
   |  betslip_match.js   today_games   -> game + slot
   |  pick_cutoff.js     start gate    -> tracking open?
   |  book_lines         verify band   -> would it verify?
   v
one bet  -> the REAL confirm slide, prefilled (openLineConfirm)
many bets -> the review list, then the same endpoints per row
   |
   v
verified -> POST /api/game/:id/vote      (leaderboard, 1 unit at the CA line)
otherwise-> POST /api/betslip/import     (user_bets, personal only)
```

Parsing lives on the server so a book redesigning its slip is a deploy, not an
App Store release. It also means the web scanner and the app scanner share one
parser and improve together.

---

## 3. The parser (`src/betslip_parse.js`)

Rules only. No model, no Haiku, no Ollama. Betslips are clean digital screenshots
with a small stable vocabulary, and a rules parser is the thing that can be
unit-tested against fixtures.

### Capture types

| Type | What it is | Tell |
|---|---|---|
| `share_card` | The image a book renders for "share my bet" | No stake anywhere |
| `slip` | One bet with wager and to-win | Money labels present |
| `list` | My Bets with several bets stacked | More than one bet parsed |
| `settled` | Carries WON / LOST / PUSH / CASHED OUT | A result badge |

**Share cards omit the stake on purpose.** They are built for bragging, not
record keeping. The confirm screen fills the risk from the user's unit size and
says so in the banner.

### Segmentation

The market label is the anchor. Every book prints one under or beside each
selection, and it is the most reliable token on the slip.

1. Each market label starts a **leg**. Its selection is the nearest preceding
   unclaimed wordy line; its price is on the selection line, the market line, or
   just after.
2. A parlay header claims the next N legs. Any leg not claimed is its own
   straight bet, which is how a My Bets list of four singles comes back as four
   bets without knowing anything about that book's row chrome.
3. Amounts belong to the bet whose span they fall in, where a span runs from one
   bet's anchor to the next bet's anchor.

### The rules that stop specific disasters

- **Odds vs lines.** American odds have an explicit sign, three or more digits,
  and **no decimal point**. `-136` is a price, `-4.5` is a handicap, `-7` is a
  handicap. Without the decimal rule a spread lands in the odds field and the
  bet grades at a nonsense price.
- **Chrome.** The FanDuel share sheet alone contributes `Messages`, `WhatsApp`,
  `New Post`, `Copy link` and `X`, all of which read as perfectly good team names
  to a naive parser. `CHROME_RE` drops them before they can become selections.
- **The balance chip.** `$0.00` at the top of every My Bets screen is chrome.
  Reading it as the wager put a zero-stake bet in the record.
- **Market labels never carry a number.** `Jayson Tatum 25+ Points` is a
  selection; `Player Points` is the market. Without that guard the prop pattern
  swallowed the selection and the bet came back with none.
- **Plausibility gate.** A slip must show at least one thing that only appears on
  a betslip (a known book, a bet header, an American price, a matchup, a result
  badge, or an unambiguous market) before anything is read as a bet. A restaurant
  receipt reading `Total 16.50` minted a totals bet in testing.
- **No lookbehind assertions anywhere.** Safari before 16.4 fails to *parse* a
  module containing `(?<!...)`, which would blank the whole app for those users.

### Blocks (the native path)

Apple Vision and ML Kit return positioned words. Betslips are two-column layouts
and plain OCR reading order splits the selection from its price;
`linesFromBlocks()` regroups words by vertical overlap so `Lorenzo Sonego` and
`-136` end up on one row again. It accepts normalized (0..1) or pixel coordinates
and infers which from the median glyph height.

Vision reports a **bottom-left** origin. Both the plugin and the extension flip
`y` to top-left before sending. Getting that backwards reverses the reading order
of the entire slip.

---

## 4. The matcher (`src/betslip_match.js`)

Pure. Takes parsed bets plus `today_games` rows and returns the game, the side,
and which of the six pick slots the bet is.

It deliberately does **not** reuse `storage.findTodayGame`: that matcher is tuned
for short Discord pick strings and does raw substring containment both ways,
which on OCR text happily matches the share-sheet `X` to any team with an x in
its name. Everything here is token-scored and thresholded (`MATCH_MIN = 0.62`).

Evidence, in order of strength:

1. **The matchup line names both sides.** The strongest signal, and the only way
   in for a total (whose selection is just "Over 174.5"). It is **added on top of**
   the selection score rather than max'd in, so a confirmed two-sided match
   out-ranks a name-only one. Naming an opponent the game does not have counts
   against that candidate.
2. **The selection names one side**, scored on every stored name variant.
3. **Sport hints from the market label.** "Run Line" is only baseball, "Puck
   Line" only hockey. This is what keeps an MLS Toronto off an MLB Toronto and a
   Maple Leafs bet off Toronto FC. A shared hint (`Total Goals` is NHL or Soccer)
   cannot break a tie, so those are kept separate from the exclusive ones.
4. **Start-time agreement** within 20 minutes of the ET clock the slip printed.
   This is what separates the two halves of a doubleheader.

Two candidates within `AMBIG_DELTA` are flagged `ambiguous` and the alternatives
are returned so the UI can ask rather than guess.

---

## 5. Endpoints

### `POST /api/betslip/parse`

Body `{ text, blocks? }`. Returns everything the confirm screen needs in one
round trip: what the slip says, which game it is, whether tracking is still open,
whether it would verify, and whether it duplicates something already tracked.

Never writes. Rate limited to 60 per 10 minutes.

### `POST /api/betslip/import`

Body `{ bets: [...], skip_duplicates? }`. Batch-creates **personal** bets only,
for the settled-backfill and multi-bet cases. Caps at 50 per call.

**Settled slips are graded by us, not by the screenshot.** A bet we can tie to a
real game is stored `pending` and the normal results cron settles it off the
final score; the slip's own WON/LOST badge is ignored. Only a bet we can never
grade (no game, a prop, a future) keeps the result the user confirmed. Every
imported row carries its provenance in `notes`.

### `GET /api/bets/:id/share`

Returns the signed card URL and caption for one of the caller's own bets.

### `GET /og/bet/:id.png?t=<hmac>`

The share card (`src/bet_card.js`), 1080x1080. A tracked bet is private, so the
URL carries an HMAC of the bet id keyed on `SESSION_SECRET`; only a link the
owner was handed opens it, and the token says nothing about any other bet.
Renders win / loss / push / pending and parlays with their legs. Falls back to
the static logo on any failure, so a share link can never break.

---

## 6. The iOS share sheet

That "More ways to share" row in a book's app is a standard
`UIActivityViewController`. Any app shipping a share extension that accepts an
image appears in it. **FanDuel and DraftKings do not have to know we exist.**

| Piece | Path |
|---|---|
| Share extension | `ios/App/CappingAlphaShare/ShareViewController.swift` |
| Capacitor bridge | `ios/App/App/CANativePlugin.swift` (`window.CANative`) |
| Xcode wiring | `scripts/add_share_extension.rb` (idempotent, re-run after `cap sync`) |
| Web intake | `consumeSharedSlip()` in `public/modules/track.js`, called on launch and every resume |

The extension runs Vision **itself**, so the heavy work happens while the user is
still looking at their book and the app opens on a finished read. It parks the
text and boxes in the shared App Group container and deep-links to
`cappingalpha://betslip`. Only when Vision fails does the raw image travel, and
only into the shared container for the app to retry.

### Still needs a developer account

`scripts/add_share_extension.rb` creates the target and embeds it, but two steps
need the Apple Developer account:

1. Register the App Group `group.com.cappingalpha.app` and tick **App Groups** on
   both the `App` and `CappingAlphaShare` targets.
2. Set the Team on the new `CappingAlphaShare` target.

Until then the group is unavailable and the extension says so out loud rather
than silently dropping the bet.

Android is not built. Jack chose iOS as a fast-follow over doing both at once.

---

## 7. The CSP bugs this work uncovered

The web betslip scanner had been **broken in production since the Phase 6
security gate shipped**. Two directives blocked Tesseract.js, and both are fixed
in `index.js`:

| Directive | Symptom | Fix |
|---|---|---|
| `worker-src 'self'` | Tesseract spawns its wasm worker from a Blob URL, which was refused | `worker-src 'self' blob:` |
| `script-src` with no wasm allowance | `WebAssembly.compile()` refused, so the reader hung forever at "initializing tesseract" | added `'wasm-unsafe-eval'` |

`'wasm-unsafe-eval'` is the narrow directive: it permits WebAssembly compilation
only and still forbids `eval()` and `new Function()` on JavaScript. It is not
`'unsafe-eval'`. Neither change widens the surface meaningfully, because
`script-src` already allows `'unsafe-inline'`.

**If the scanner ever silently stops working, check the CSP first.**

---

## 8. Tests

```bash
node test/betslip_parse.test.js    # 191 assertions
node test/betslip_match.test.js    #  76 assertions
node test/betslip_router.test.js   #  74 assertions, real DB + real gates
node test/bet_card.test.js         #  54 assertions
```

Fixtures are transcribed from real screenshots in the reading order a plain OCR
pass produces. The router suite seeds a scratch DB via `CAPPER_DB` and drives the
real Express router, so it proves the start gate and the verify band end to end.

Three regressions in there came from running the real thing rather than from
imagination, and each names the date and the symptom in a comment:

- A parlay leg stealing the previous leg's matchup line, so every leg after the
  first graded against the wrong game.
- A two-sided matchup tying with a name-only match, which sent a Fearnley bet to
  a finished match instead of the pregame one.
- OCR merging a right-aligned "To Win $X" onto the matchup row, which lost the
  game on every total in a My Bets list.

## 9. Adding a book

1. Add its tells to `BOOKS` in `src/betslip_parse.js`.
2. Screenshot it: share card, single, parlay, settled, and the list view.
3. Transcribe the OCR into `test/betslip_parse.test.js` and assert the numbers.
4. Only add a market pattern if that book genuinely labels a market differently.

Layout profiles are deliberately absent. The market-anchored segmenter has held
across every book tested so far, and per-book layout rules are a maintenance tax
that only pays once a book actually breaks the general parser.
