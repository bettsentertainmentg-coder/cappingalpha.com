# Mock the V2 capper profile (new session)

Paste this into a new session started FROM `~/projects/capperboss-v2`. Model: Fable 5.1, high effort. Read first: CLAUDE.md, docs/V2_DATABASE_PLAN.md sections 7b and 7c, the memory note project_v2_capper_database (the three mock rounds and what Jack settled), Jack's sketch (described in plan 7c), and the lab tooling in docs/mockups/ (assemble_lab.js, lab_chrome.html, build_real_page_mock.py, v2_game_backers_v18.json).

## Goal

The page a row tap on the game section opens: the capper profile, on the sport tab of the game it came from. Produce a phone lab with five directions built by independent designers, each critiqued and revised once, the way the game section was done, then a version of the winner injected into the real app frame so Jack edits from the real thing. Jack picks; do not build the product page yet.

## What the profile holds (Jack's sketch plus what he settled since)

Top to bottom:
1. Header: initials disc (deterministic color from the name; no faces yet), display name (full name here, never cut), source badge in the same tinted-text style as the game section (Polymarket violet, Action Network green, Covers red, Community grey), Follow (adds to Favorites), and the small (i).
2. The big record: W-L large, money in dollars at $10 a pick and ROI beside it, with window pills All / 30d / 7d.
3. Sport chips (All first, then each sport with picks, by count); the selected chip is the sport the user tapped in from. Under it the Sport Panel: record, ROI, money, picks, priced share, a by-bet-type mini table (ML / spread / total), the equity curve (money by graded pick, oldest first, runs negative, no smoothing, one accent line, faint grid, endpoint label).
4. Badges row: streak per sport ("MLB W5" flame / "MLB L5" snowflake, from 5 straight), Small sample under 20 in the sport, season badges "+$610 this season" and "61-41 this season" (top 5% of the sport this season by money and by win percentage with a 30-pick floor), all on the faded grey chip with colored numbers (money green or red, W green, L red, T yellow).
5. Today's Picks: every pending pick on today's games (game, pick chip in team tint, line, their price, recorded time); free users see the rows masked (one masked cell, never a blur wall) with one subscribe prompt.
6. Recent picks: date, matchup, pick chip, their price (or "graded at -110"), result chip, money; 25 rows then "Show more" with the same four-and-a-half-rows-then-scroller behavior as the game section.
7. Bio Box (for public figures, in our words) or the auto Style Line ("Mostly MLB moneylines, leans underdogs, about 15 picks a week"). Jack's sketch has this box at the very top with an arrow; try both top and bottom across the directions.
8. Footer: the (i) note ("Their record as we recorded it since July 2026, graded by us at the line and price we saw. It can differ from records they publish. $10 a pick."), "How we grade" link, "Is this you? Claim, correct or remove" link.

Not on the page: scores, bands, points, Wilson, gates, fade, channel names, any external self-reported record, the words expert / pro / sharp / proven / hot / cold / fade / best / worst / winner / loser.

## Rules carried over from the game section

Edge to edge cards; 14px inner padding; one dark token set (--bg #0f1117, --surface #171b24, --surface2 #1e2330, --border #252c3b, --text #e2e8f0, --muted #8892a4, --accent #3b82f6, --gold #FFD700, --green #22c55e, --red #ef4444) plus the host color contract from lab_chrome.html; system font; tabular numerals; no em dashes; humble copy; little explanatory writing (the (i) holds it); nothing truncated except names on the game rows (the profile shows the full name).

## Fixture

Use a fictional capper on the same game data as the game section (Athletics at Rays, docs/mockups/v2_game_backers_v18.json): VeryLucky888, Polymarket, overall 402-311, +$1,240, ROI +17.4%; MLB 231-171, +$610, +15.2%; NFL 41-27, +$212, +7.8%; WNBA 22-15, +$88, +23.8%; streak MLB W5; season badge "+$610 this season"; today's picks ATH ML at +215 and two more; 25 recent picks with realistic prices; a Style Line. Invent nothing beyond the fixture in the fragments.

## Five directions (one designer each, then a critic, then one revision)

1. Sketch literal: Jack's drawing as drawn, bio box on top with the arrow, record big, chips, panel with curve, recent picks with the streak on the right.
2. Stat-first: the record and money as ESPN-style stat tiles with rank-free labels, the curve wide under them, bio at the bottom.
3. Ledger continuity: the profile built from the same row anatomy as the game section (the metrics line, chips, pick chips), so the two screens read as one system.
4. Tabbed: Overview / Picks / Today / Bio as a sticky segmented bar under the header (ESPN player page feel), Overview rendered.
5. Compact card stack: everything as full-bleed cards in a fixed order with the smallest vertical footprint, curve as a sparkline in the record card.

Critic checks: token and contract compliance, forbidden words, no em dashes, the fixture only, no truncation on the profile, height, the free-tier masking described, the sport chip selected state, both light and dark not required (dark only, like the site).

## Deliverables

- docs/mockups/v2_capper_profile_lab.html assembled with the existing tooling (pills to switch, the same toggles above the phone, notes below), published as an artifact (private), one headless-Chrome render per direction reviewed before publishing (headless Chrome's minimum viewport is 500px; render at 500 and review the profile at that width or in the phone frame).
- After Jack picks: inject the winner into a saved prod page the way build_real_page_mock.py does for the game page (there is no profile page on prod yet, so mount it inside the game page frame under the header as a stand-in), render, and send the screenshot.
- Update docs/V2_DATABASE_PLAN.md section 7c with the settled anatomy and the memory note.
