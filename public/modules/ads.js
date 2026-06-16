// public/modules/ads.js
// Dormant display ad slots on the home page. Two placements:
//   1. ca-ad-sidebar — medium rectangle under the #1 pick card (left sidebar)
//   2. ca-ad-bar     — slim leaderboard bar between My Sports and Today's Picks
//
// Paid subscribers never see ads (gated on isPaying()). Until Google Ad Manager
// is wired up, the slots show a subtle "Advertisement" placeholder in preview
// mode (localhost, or any page with ?adpreview=1) and render NOTHING in
// production, so the live site stays clean instead of showing empty ad boxes.
//
// To go live once you have a Google Ad Manager account:
//   1. Create the ad units in GAM, note your network id + each ad-unit path.
//   2. Fill gamPath + sizes for each slot below and set GAM_NETWORK_ID.
//   3. Uncomment loadGpt() / defineGptSlot() and call loadGpt() from app.js init.

import { isPaying } from './auth.js';

// One entry per slot. gamPath empty = dormant (placeholder/preview only).
const AD_SLOTS = [
  { id: 'ca-ad-sidebar', shape: 'box', gamPath: '', sizes: [[300, 250]] },
  { id: 'ca-ad-bar',     shape: 'bar', gamPath: '', sizes: [[728, 90], [320, 50]] },
];

// Show placeholders locally / on demand, never to real visitors in production.
const AD_PREVIEW =
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  new URLSearchParams(location.search).has('adpreview');

export function mountAds() {
  const paying = isPaying();
  for (const slot of AD_SLOTS) {
    const el = document.getElementById(slot.id);
    if (!el) continue;
    if (paying) { el.innerHTML = ''; el.style.display = 'none'; continue; }
    renderSlot(el, slot);
  }
}

function renderSlot(el, slot) {
  // Live Google Ad Manager ad takes over once a path is configured.
  if (slot.gamPath && window.googletag) {
    el.className = `ca-ad-slot ca-ad--${slot.shape}`;
    el.style.display = '';
    el.innerHTML = `<div id="${slot.id}-gpt"></div>`;
    defineGptSlot(slot);
    return;
  }
  // Preview: labelled placeholder so the placement + size is visible in dev.
  if (AD_PREVIEW) {
    el.className = `ca-ad-slot ca-ad--${slot.shape}`;
    el.style.display = '';
    el.innerHTML = `<span class="ca-ad-label">Advertisement</span>`;
    return;
  }
  // Production with no live ad yet: render nothing.
  el.innerHTML = '';
  el.style.display = 'none';
}

// ── Google Ad Manager (GPT) — dormant until you have an account ────────────────
// const GAM_NETWORK_ID = '00000000'; // your GAM network id
// export function loadGpt() {
//   if (window.googletag && window.googletag.apiReady) return;
//   window.googletag = window.googletag || { cmd: [] };
//   const s = document.createElement('script');
//   s.async = true;
//   s.src = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';
//   document.head.appendChild(s);
// }
// function defineGptSlot(slot) {
//   const gt = window.googletag;
//   gt.cmd.push(() => {
//     gt.defineSlot(`/${GAM_NETWORK_ID}/${slot.gamPath}`, slot.sizes, `${slot.id}-gpt`)
//       .addService(gt.pubads());
//     gt.enableServices();
//     gt.display(`${slot.id}-gpt`);
//   });
// }
function defineGptSlot() { /* enable when GAM is configured (see comment above) */ }

window.mountAds = mountAds;
