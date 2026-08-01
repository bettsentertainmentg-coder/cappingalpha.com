// src/nav_tabs.js — THE top nav bar, defined once.
//
// There are two renderers for the same bar: the SPA's static markup in
// public/index.html, and the server-rendered copy in src/detail_page.js that
// every game page, sport page and tools page uses. They were maintained by hand
// in two places and drifted every single time the nav changed — the game detail
// page was still showing "Leaderboard" months after the tab became "Socials",
// and still rendered Sports as a dropdown after that was dropped. Jack, 2026-08-01:
// "IDK WHY THIS ALWAYS HAPPENS but the top tabs can never stay up to date."
//
// This file is the answer. detail_page.js builds its bar from NAV_TABS, and
// assertNavInSync() reads public/index.html at boot and shouts if the SPA's
// tab list has drifted from it. Change the bar HERE, and the server side follows
// automatically; if you change index.html and forget this file, the boot log
// tells you immediately instead of a user finding it on a detail page weeks later.

const NAV_TABS = [
  { tab: 'mvp',     label: 'Rankings', logo: true },
  { tab: 'sports',  label: 'Sports' },
  { tab: 'esports', label: 'Esports' },
  { tab: 'socials', label: 'Socials' },
  { tab: 'about',   label: 'About', dropdown: [
    { href: '/#about', label: 'About' },
    { href: '/faq',    label: 'FAQ' },
    { href: '/tools',  label: 'Betting Calculators' },
  ] },
];

// Boot check: does the SPA's nav still match this list, in this order?
// Reads only the <div class="nav-tabs"> block so unrelated data-tab attributes
// elsewhere in the page (the mobile tab bar, the drawer) can't produce a false
// alarm. Never throws — a nav mismatch must not take the site down.
function assertNavInSync() {
  try {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const start = html.indexOf('<div class="nav-tabs">');
    if (start < 0) return null;
    // Walk to the matching close of the nav-tabs div.
    let i = start, depth = 0, end = -1;
    const re = /<\/?div\b/g;
    re.lastIndex = start;
    let m;
    while ((m = re.exec(html))) {
      depth += m[0] === '</div' ? -1 : 1;
      if (depth === 0) { end = m.index; break; }
      i = m.index;
    }
    const block = html.slice(start, end > 0 ? end : start + 4000);
    const spa = [...block.matchAll(/data-tab="([a-z]+)"/g)].map(x => x[1]);
    const mine = NAV_TABS.map(t => t.tab);
    const same = spa.length === mine.length && spa.every((t, idx) => t === mine[idx]);
    if (!same) {
      console.error('[nav] TOP NAV OUT OF SYNC — public/index.html and src/nav_tabs.js disagree.');
      console.error(`[nav]   index.html : ${spa.join(', ')}`);
      console.error(`[nav]   nav_tabs.js: ${mine.join(', ')}`);
      console.error('[nav]   The game/sport/tools pages render from nav_tabs.js, so they will show the stale bar until these match.');
    }
    return { same, spa, mine };
  } catch (_) { return null; }
}

module.exports = { NAV_TABS, assertNavInSync };
