# CappingAlpha Mobile UI: Issue Registry + Design Vocabulary

Current as of 2026-07-13. Written during the iPhone app-readiness sweep.
Two jobs: (1) a labeled registry of every mobile UI defect found, with root cause and status, and (2) a named vocabulary for every component, animation, scroll behavior, and icon system on the site, so future work (including the app build) has one shared language.

Rule going forward: when a new surface ships, it uses these names and obeys the App-Ready Invariants at the bottom.

---

## Part 1: Issue Registry

ID convention: `AREA-##`. Areas: NAV (navigation), SCROLL (scrolling and containment), ZOOM (viewport zoom), TEXT (typography overflow), FIT (layout fit), SAFE (safe areas and fixed bars), SYS (system-level consistency).

### Fixed in this sweep (2026-07-13)

| ID | Issue | Root cause | Fix |
|---|---|---|---|
| NAV-01 | "Incorrect hamburger" on /tools, game detail, sport pages, /mylive. Old floating dropdown list, taller than the screen, bottom items unreachable, looked nothing like the app menu | buildNav rendered a legacy `#ca-detail-menu` fixed dropdown (no max-height, no scroll) while index.html had moved to a slide-in drawer. Two menu implementations | buildNav now renders the same `.ca-drawer` + `.ca-drawer-overlay` + `.ca-tabbar` as index.html, styled in game-detail.css. One nav system everywhere |
| NAV-02 | /mylive icons render blank | Page loads buildNav (FontAwesome icons) without the FontAwesome stylesheet | FA link added to mylive shell (and tools shell) |
| NAV-03 | Server-page top bar overflowed on phones (Unlock CappingAlpha button crowded the wordmark) | Desktop `.nav-actions` never swapped to a compact mobile variant on buildNav pages | Ported index.html's `.nav-actions-mobile` (compact gold Unlock pill + avatar); desktop actions hide at 768px |
| SCROLL-01 | "Floating screen": whole page pans sideways on the leaderboard, podium and table cut off at both edges | Non-contained wide descendants (period pills, stat-card text, table) leak past `body { overflow-x: hidden }` on iOS; hidden also risks breaking position sticky | `overflow-x: clip` + `overscroll-behavior-x: none` on html/body; every wide descendant individually contained (see FIT/TEXT items) |
| SCROLL-02 | Leaderboard table: twin scrollbars, no momentum, rubber-bands the page | `.lb-table-scroll` declared only `overflow-y`; overflow-x computed to auto implicitly; no `-webkit-overflow-scrolling` or `overscroll-behavior` | Explicit two-axis scroll container with momentum + `overscroll-behavior: contain` |
| SCROLL-03 | Scrolled leaderboard rows lose identity (names clipped mid-word, "ngAlpha") | No sticky columns; horizontal scroll hides rank and member | New Sticky Rail Table pattern: rank + member columns pin left (`position: sticky`) with opaque row-tint backgrounds; badges wrap under the name so metrics peek in |
| SCROLL-04 | /results 7-column table forces page-level sideways scroll | Table sat directly in the page with no scroll wrapper, page had no overflow guard | Wrapped in `.table-wrap` contained scroller; body overflow guard + 560px breakpoint added |
| ZOOM-01 | Screen "zooms and floats" after tapping an input, never resets | iOS Safari auto-zooms the page when a focused text control renders under 16px (tools inputs were 15px, track-sheet search 14px, code entry 15px) | 16px floor on all text-entry controls at 768px and below (`!important` guard in index.html + game-detail.css); tools inputs bumped at source |
| TEXT-01 | "@PatsParlayProphet" painted across the neighboring stat card | `.lb-stat-val` 24px with no wrap rules; grid cards missing `min-width: 0`, so long unbreakable handles paint outside | Cards get `min-width: 0` + `overflow: hidden`; values get `overflow-wrap: anywhere`; 20px on phones |
| TEXT-02 | OFFICIAL badge clipped mid-word in table rows | Badge had no `white-space: nowrap` or `flex-shrink: 0`; card overflow boundary cut it | Badge is now an atomic chip (nowrap + shrink-0); member cell wraps badges below the name on phones |
| FIT-01 | Podium cards ran off the right edge (gold #1 half visible) | Not the podium's own sizing (it is fluid); inherited the SCROLL-01 page pan | Fixed by containment; plus a 480px compression pass (tighter gaps, smaller name/units) so all three slots always fit |
| FIT-02 | Period pills (This Week / This Month / All-Time) overflowed their rail | Flex items cannot shrink below min-content (~405px total vs ~342px available); `flex: 1` alone does not help | `min-width: 0` + nowrap on pills; 13px font and tighter padding at 480px |
| SAFE-01 | Safe-area padding was inert on every page but index.html | `env(safe-area-inset-*)` only activates with `viewport-fit=cover`, which only index.html set | `viewport-fit=cover` added to detail, sport, tools, results, mylive, faq, terms, privacy |
| SAFE-02 | Content and floating pieces collide with the fixed tab bar | body padding was a flat 56px (no inset); cookie banner and FAB used raw offsets | body clears `58px + inset`; FAB rides at `64px + inset`; cookie banner rides above the tab bar on phones; drawer footer + terms/privacy version chips inset-aware |
| SCROLL-05 | Drawer and Track Bet sheet lists chain-scroll into the page; drawer footer hidden behind iOS toolbar | 100vh drawer ignores collapsed browser chrome; scrollers lacked containment | Drawer is `100dvh` (100vh fallback) with `overscroll-behavior: contain` + momentum; `.tg-results` contained in both copies of the stylesheet |
| SYS-01 | Grey tap flash and double-tap-zoom delay on controls; landscape font inflation | No touch polish rules | `-webkit-tap-highlight-color: transparent`, `touch-action: manipulation` on controls, `text-size-adjust: 100%` (index.html + game-detail.css + static pages) |
| SYS-02 | Returning visitors would get new markup with stale CSS (unstyled drawer) | game-detail.css and track-sheet.css were linked with no version param; leaderboard.js template changed | Cache-buster chain bumped: `app.js?v=72`, `leaderboard.js?v=9`, `game-detail.css?v=2`, `track-sheet.css?v=2` |

### Open (known, deliberate, or needs Jack's call)

| ID | Issue | Notes |
|---|---|---|
| SYS-03 | Palette drift on tools + mylive | Their CSS uses `var(--card, #141a24)`, `var(--line, #232b38)`, `var(--gold, #d4af37)` but `--card`/`--line` are never defined, so the fallbacks always apply: slightly darker cards and a bronze gold instead of #FFD700. Looks intentional-ish on tools (bronze headings). Decide: adopt bronze as the "SEO page" accent or align to the app tokens |
| NAV-04 | results, faq, terms, privacy keep a minimal `.site-header` (logo + Back to app), no drawer or tab bar | Deliberate for now: results is a lean crawler-first page by design (its file header says so), legal pages are destinations, not the app. Even so there are two sub-variants (faq has the velvet sticky header, terms/privacy/results have a flat grey one). Worth unifying the look later |
| SYS-04 | track-sheet.css is a hand-extracted copy of the betslip styles in index.html | Every `.track-*`/`.tg-*`/`.ob-*`/`.bp-*` change must be made twice. Known sync hazard, called out in the file header. Candidate for extraction into one shared file |
| SYS-05 | No skeleton loaders | Every loading state is the spinner. Fine for now; if the app build wants skeletons, add one shimmer primitive, not per-surface one-offs |
| SYS-06 | Five live-dot treatments and four icon systems (see vocabulary) | Consolidation candidates listed below. Cosmetic, not broken |
| SCROLL-06 | Leaderboard table keeps its 612px inner vertical scroll on phones | Two nested vertical scrollables (page + table) is tolerable but not ideal; if it feels bad on device, drop the max-height at 768px and let the page own vertical scrolling |

---

## Part 2: Design Vocabulary

Use these names in issues, commits, and design talk. File references point at the canonical implementation.

### Design tokens
One dark token set, remapped for light theme under `html[data-theme="light"]`:
`--bg #0f1117 / --surface #171b24 / --surface2 #1e2330 / --border #252c3b / --text #e2e8f0 / --muted #8892a4 / --accent #3b82f6 / --gold #FFD700 (--gold-ink for text; #8B6914 in light) / --green #22c55e / --red #ef4444`.
Defined in index.html and mirrored in game-detail.css (which adds detail-page tokens like `--accent-live-score #38bdf8`).

### Navigation
| Name | What it is | Where |
|---|---|---|
| Top Bar | 56px sticky velvet-photo bar with scrim. Left: hamburger (phone) + wordmark + nav tabs (desktop). Right: actions | index.html nav; game-detail.css `nav` |
| Nav Drawer | 300px left slide-in panel, `left .24s ease`, dim overlay, full height (100dvh), scrollable | `.ca-drawer` + `.ca-drawer-overlay`, both surfaces |
| Drawer Accordion | Expandable drawer section (Sports, About, My Account) with chevron flip | `.ca-drawer-account-toggle` + `.ca-drawer-sub` |
| Tab Bar | Fixed bottom bar, 4 destinations (Home, Rankings, Sports, Tracking), icons + 10px labels, safe-area padded, 768px and below | `.ca-tabbar` |
| FAB | Floating action button, bottom right pill ("+ Track Bet"), lifts above the Tab Bar on phones | `.track-fab` |
| Avatar Menu | Top-right avatar toggling the account dropdown; one dropdown serves desktop + mobile triggers | `.nav-avatar-btn` / `#ca-acct` + `#ca-acct-m` |
| Nav Dropdown | Desktop hover-free click dropdown under a nav tab, `ddIn` pop | `.about-dropdown`, `#sports-dropdown` |
| Compact Unlock | Phone top-bar gold pill: "Unlock" + CA logo chip | `.nav-unlock-m` |
| Site Header (minimal) | Logo + "Back to app" bar on crawler/legal pages | results, faq, terms, privacy |

### Scroll types
| Name | Behavior | Canonical example |
|---|---|---|
| Page Scroll | The one vertical scroll the page owns. Horizontal is always clipped at html/body (`overflow-x: clip` + `overscroll-behavior-x: none`) | every page |
| Chip Rail | Horizontal strip of pills/chips, hidden scrollbar, momentum, never wraps | sport filter row, ticker chips, My Sports chips, slot picker |
| Card Rail | Horizontal card strip with visible 4px accent scrollbar and desktop drag-to-scroll (grab cursor) | Top Games row (`.ca-top-games-row`, drag logic in home_top.js) |
| Contained Table Scroll | Wide table inside its own two-axis scroller: momentum + `overscroll-behavior: contain`, page never pans | `.lb-table-scroll`, `.sp-scroll`, results `.table-wrap` |
| Sticky Rail Table | Contained Table Scroll plus pinned identity columns (sticky left, opaque tinted backgrounds, hairline divider) | leaderboard rank + member columns, 768px and below |
| Sheet Scroll | Vertical scroll inside a sheet/modal body, contained so it never chains to the page | `.track-sheet`, `.tg-results`, drawer |
| Sticky Header | Element pins while its section scrolls | top bar, table `th`, detail section nav, mobile TOC |
| Scroll Spy | Scroll position drives the active tab; smooth-scroll on tap with sticky offsets | game-detail.js section nav |
| Reveal-on-scroll | Content fades/rises in when it enters the viewport (IntersectionObserver, reduced-motion aware) | `.account-reveal` |
| Transform Carousel | Swipeable gallery that moves via transforms, not native scroll (the gauge "lazy susan", touch-swipe steps one bet type) | `.ca-gauge-slide`, game-detail.js |
| Stuck Morph | Sticky element changes size/shadow once pinned (rAF-throttled is-stuck class) | `.ca-mobile-tabs.is-stuck` |
| Scroll Hint | Fake mini scrollbar shown only when a rail overflows | `.ca-slot-scrollbar` |

Not used anywhere (by choice, candidates for the app): native `scroll-snap`, marquee auto-scroll, pull-to-refresh.

### Overlays and surfaces
| Name | What it is |
|---|---|
| Center Modal | `.modal-overlay` + `.modal-card` (auth, codes). Instant show, no enter animation |
| Game Modal | `.game-modal-card` two-column popup (game detail in the SPA, member profiles) |
| Bottom Sheet | Track Bet flow: scrim fade .18s + sheet rise .18s; docks to bottom edge with a grab handle on phones |
| Book Picker | `.bp-card` sub-modal above the sheet (z 400) |
| Drill-down Modal | `.ca-hist-modal` on the detail page |
| Toast | Bottom-center rise + fade chip, `.ca-toast` (.err variant), safe-area aware |
| Cookie Banner | Fixed bottom disclosure card; rides above the Tab Bar on phones |
| Paywall Fade | Gradient fade over locked list + CTA card (`.inline-paywall-*`) |
| Rank Lock | Floating lock box over blurred rows (`.ca-rank-lock-box`, `.blurred`) |
| Locked Teaser | Synthetic gold curve drawn where a locked chart would be (score_timeline.js) |

### Cards and rows
Game Tile (`.ca-tg-tile`), #1 Pick Card (`.ca-top-pick-card` with live/won/lost states), Stat Tile (`.lb-stat-card`, `.track-stat`, `.nu-card`, `.pf-stat`), Podium Card (`.lb-podium-slot`, 2-1-3 layout, medal + avatar + units), Pick Row (ranked table row with heat color), Home Pick Row, Voted Pick Row, History Row (`.ca-hist-row`, result-tinted edge), Empty State (`.empty` icon + line), Spinner (`.spinner`/`.ca-spinner`).

### Chips, badges, pills
| Name | Notes |
|---|---|
| Sport Badge | THREE styles today: gradient card badge (`sportBadge()` in utils.js), plain table badge (`.sport-badge`), detail badge (`.ca-sport-badge`). Consolidation candidate |
| OFFICIAL Badge | Gold gradient chip on house rows (`.lb-house-badge`, podium `-house-tag`). Atomic: never wraps or shrinks |
| Heat Color | Score-driven color ramp + fire emoji threshold (`PICK_HEAT_COLOR()`, `.ca-heat-1..5`) |
| Status Pill | pre/live/final (`.ca-status-*`, `.ca-gh-status-pill`) |
| Result Badge | WIN/LOSS/PUSH chips (`.ca-dp-result-*`, `.sp-pill`, `.res-*`) |
| Period Pills | This Week / This Month / All-Time segmented rail (`.lb-windows`) |
| Knob Switch | Public/private sliding toggle (`.lb-priv-switch` + knob) |
| Segmented Control | Away/Home sliding-pill toggle with pop flash (`.ca-hist-toggle`), bet-type `.bet-seg` |
| Follow Pill | Outline accent button, "Following" muted state |
| Tier Badge | free/paid chip |

### Animation vocabulary
| Name | Effect | Duration/easing | Used by |
|---|---|---|---|
| ddIn | dropdown pop: fade + 4px rise + 0.98 scale | .12s ease | account/about/sports dropdowns |
| Drawer Slide | left -320px to 0 | .24s ease | Nav Drawer |
| Sheet Rise | scrim fade + translateY(10px) to 0 | .18s ease | Track Bet sheet |
| Toast Rise | fade + translateY(12px) | .2s | toasts |
| pulse | opacity 1 to 0.4 blink | 1 to 1.6s infinite | live dots (several sizes) |
| ca-live-dot | opacity blink | 1.4s infinite | detail status pill |
| ca-live-glow | blue glow box-shadow swell | 1.1s infinite | #1 pick + schedule live dots |
| obflash | one-shot blue flash on a changed odds line | 1.5s ease | betslip line refresh |
| spin / ca-spin | loading spinner | 0.7s linear | spinners (duplicate keyframes) |
| caHistPop | brightness pop on the segmented slider | .36s | Away/Home switch |
| Slider Glide | segmented pill slide | .32s cubic-bezier(.22,1,.36,1) | Away/Home switch |
| Needle Swing | gauge needle sweeps to its angle | 720ms cubic-bezier(.22,.7,.18,1.06) | signature gauge |
| ca-vp-draw | line draws on (dashoffset) | .9s ease-out | value pulse chart |
| ca-vp-ping | radar ping at line end | 1.8s infinite | value pulse chart |
| Reveal | fade + 16px rise on enter | .55s cubic-bezier(.16,1,.3,1) | account sections |
| Tile Lift | hover translateY(-1 to -3px) + shadow | .12-.15s | tiles, podium, cards |
| Bar Fill | width transition on meters | .3s | setup/history meters |

Reduced motion: gauge needle, value pulse, live command dot, and account reveal already respect `prefers-reduced-motion`. New animations must too.

### Iconography (four systems today)
1. FontAwesome 6.5.0 (primary, ~115 uses): sport icons, nav, chevrons, locks, tab bar.
2. Inline SVG (currentColor): lock (`LOCK_SVG`), tennis racket (the one non-FA sport icon), hamburger, search, baseball diamond, gauges, charts.
3. Emoji: medals (rank/podium), fire (heat threshold), trophy/lock empty states, the lock/unlock hover swap on unlock CTAs.
4. One-off geometric Unicode glyphs on the About signal cards.

Direction for the app: FA stays the default; SVG for anything drawn/animated; medals + fire emoji are brand voice and stay; do not add a fifth system.

### Known duplicates (refactor candidates)
- `spin` vs `ca-spin` keyframes (identical).
- Betslip styles duplicated between index.html and track-sheet.css (sync by hand).
- `.modal-overlay` defined in both index.html and game-detail.css.
- Three sport badge styles; five live-dot treatments split between green #4ade80 and blue #38bdf8.
- results_page.js styles hardcode hex values instead of tokens.

---

## Part 3: App-Ready Invariants (the new rules)

Every page, present and future, must hold these. They are what "app ready" means as a website:

1. **No page pans sideways, ever.** html/body get `max-width: 100%; overflow-x: hidden; overflow-x: clip; overscroll-behavior-x: none`. Anything wider than the viewport scrolls inside its own container.
2. **Wide content = Contained Table Scroll.** `overflow-x: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain`. Tables that lose identity when scrolled get the Sticky Rail.
3. **No text control under 16px on phones.** iOS auto-zoom is the "floating screen" bug. The `!important` guard at 768px is the backstop; still write 16px at source.
4. **Flex/grid children that hold text get `min-width: 0`**, and big display values get `overflow-wrap: anywhere` or ellipsis. Chips are atomic (nowrap + shrink-0).
5. **Safe areas are real.** Every page sets `viewport-fit=cover`; fixed bars/chips/footers pad with `env(safe-area-inset-*)`; content clears the Tab Bar (`58px + inset`); floating pieces stack above it (FAB `64px + inset`).
6. **Full-height overlays use `100dvh`** with a 100vh fallback, and contain their own scroll.
7. **Touch polish everywhere:** transparent tap highlight, `touch-action: manipulation` on controls, `text-size-adjust: 100%`.
8. **One nav system.** Top Bar + Nav Drawer + Tab Bar come from buildNav (server pages) or index.html (SPA) with identical class names. Never fork a third menu.
9. **Cache-buster chain on every shipped asset change:** bump `?v=` on the changed file AND every importer up to the entry script/link.
10. **New animation or scroll behavior gets a name here first.** If it is not in the vocabulary, it does not ship.
