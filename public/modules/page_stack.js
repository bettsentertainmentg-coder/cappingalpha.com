// public/modules/page_stack.js — the app's pushed-page stack.
//
// Inside the app shell a game (or /mylive, or a sport page) opens like a native
// push: the page slides in from the right over what is underneath (which
// parallaxes left under a dim), the CA marquee pulses while it loads, and Back
// (button, left-edge swipe, hardware back) slides it away to exactly what was
// there. Pages stack: a link inside a pushed page pushes another one on top.
//
// Each page is the normal server-rendered document loaded in a frame with
// ?embed=app (+ top=<status bar inset>) so it keeps its own CSS/JS and unmounts
// cleanly (timers, polling, the live tracker) the moment the frame is removed.
// The documents talk over postMessage ('ca:embed-*'); the bundled shell also
// hands its bearer token across because the frame is cross-origin there and
// carries no cookie. The document is prefetched on touchstart, so by the time
// the tap lands it is usually already in the HTTP cache.
//
// On the plain website window.goGame / window.goPage are plain navigations.
// Set localStorage.ca_stack = '1' to preview the stack in a desktop browser.

import { isNative, apiUrl, getToken, haptic, openExternal } from './native.js?v=2';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';   // UIKit's push curve
const DUR_OUT = 320;                              // slide-in lives in CSS (380ms)
const READY_TIMEOUT = 15000;
const PREP_TTL = 800;                             // ms a touchstart-prepared page waits for its tap
const UNDER_SHIFT = 30;                           // % the surface underneath slides left
const DIM = 0.5;
// Server pages that push in the shell (besides /game/...). Mirrors SPORT_PAGES.
const PUSHABLE = /^\/(mylive|mlb|nba|wnba|nfl|nhl|ncaaf|cbb|tennis|golf|soccer|mma)\/?(?:[?#].*)?$/;

const _stack = [];        // open pages, bottom -> top
let _afterUnwind = null;  // runs once the whole stack has been popped
let _armed = false;
let _safeTop = null;

function stackEnabled() {
  try { if (localStorage.getItem('ca_stack') === '1') return true; } catch (_) {}
  return isNative() || document.documentElement.classList.contains('ca-app');
}
function reducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}
function gameHref(id, slot) {
  return `/game/${encodeURIComponent(id)}` + (slot ? `?slot=${encodeURIComponent(slot)}` : '');
}
function pushableHref(href) {
  if (!href) return null;
  if (href.startsWith('/game/')) return href;
  return PUSHABLE.test(href) ? href : null;
}
// The status-bar inset, measured once from env(): the page draws its own header
// under the status bar, so it needs the number (env() reads 0 inside a frame).
function safeTop() {
  if (_safeTop != null) return _safeTop;
  const probe = document.createElement('div');
  probe.className = 'ca-stack-probe';
  document.body.appendChild(probe);
  _safeTop = Math.round(parseFloat(getComputedStyle(probe).paddingTop) || 0);
  probe.remove();
  return _safeTop;
}
function frameSrc(href) {
  const sep = href.includes('?') ? '&' : '?';
  return apiUrl(`${href}${sep}embed=app&top=${safeTop()}`);
}
// The tab bar stays put under the pushed pages (as in ESPN), so a page covers
// exactly the area above it.
function tabBarHeight() {
  const bar = document.getElementById('ca-tabbar');
  if (!bar) return 0;
  try { if (getComputedStyle(bar).display === 'none') return 0; } catch (_) {}
  return Math.round(bar.getBoundingClientRect().height);
}
function top() { return _stack.length ? _stack[_stack.length - 1] : null; }
// What slides left under a new page: the app shell for the first page, the
// current top page for a deeper one.
function underTargets() {
  const t = top();
  if (t) return [t.page];
  return Array.from(document.querySelectorAll('body > nav:not(.ca-tabbar), .tab-panel.active, .track-fab'));
}

// Build the DOM for a page and start loading it. Not yet on the stack: the
// panel sits off-screen at translateX(100%) until activate().
function buildEntry(href) {
  const bottom = tabBarHeight() + 'px';
  const depth = _stack.length;
  const dim = document.createElement('div');
  dim.className = 'ca-stack-dim';
  dim.style.bottom = bottom;
  dim.style.zIndex = String(120 + depth * 3);

  const page = document.createElement('div');
  page.className = 'ca-stack-page';
  page.style.bottom = bottom;
  page.style.zIndex = String(122 + depth * 3);
  page.innerHTML = `
    <iframe class="ca-stack-frame" title="Page"></iframe>
    <div class="ca-stack-loader">
      <button class="ca-stack-loader-back" type="button" aria-label="Back">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.5 2L3.5 6L7.5 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Back
      </button>
      <img src="/ca-logo.png" alt="" draggable="false">
      <div class="ca-stack-loader-slow" hidden>Taking longer than usual. <button type="button" class="ca-stack-retry">Retry</button></div>
    </div>
    <div class="ca-stack-edge" aria-hidden="true"></div>`;

  const frame  = page.querySelector('.ca-stack-frame');
  const loader = page.querySelector('.ca-stack-loader');
  const src    = frameSrc(href);
  let origin = location.origin;
  try { origin = new URL(src, location.href).origin; } catch (_) {}

  const entry = { href, dim, page, frame, loader, under: [], origin, timer: null, ready: false, active: false, closing: false, after: null };
  document.body.append(dim, page);
  frame.src = src;
  loader.querySelector('.ca-stack-loader-back').addEventListener('click', () => { if (top() === entry) closeTop(true); });
  loader.querySelector('.ca-stack-retry').addEventListener('click', () => {
    loader.querySelector('.ca-stack-loader-slow').hidden = true;
    armReadyTimer(entry);
    frame.src = src;
  });
  armEdgeSwipe(entry);
  armReadyTimer(entry);
  return entry;
}

function destroyEntry(entry) {
  clearTimeout(entry.timer);
  entry.under.forEach(el => { el.classList.remove('ca-stack-under'); el.style.transform = ''; el.style.transition = ''; });
  entry.page.remove();
  entry.dim.remove();
}

function armReadyTimer(entry) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (!entry.ready && entry.page.isConnected) entry.loader.querySelector('.ca-stack-loader-slow').hidden = false;
  }, READY_TIMEOUT);
}

function reveal(entry) {
  if (entry.ready) return;
  entry.ready = true;
  clearTimeout(entry.timer);
  entry.page.classList.add('ready');
}

// Put a built page on the stack and slide it in.
function activate(entry) {
  entry.under = underTargets();
  entry.under.forEach(el => el.classList.add('ca-stack-under'));
  entry.active = true;
  _stack.push(entry);
  try { history.pushState({ caStack: _stack.length }, '', location.href); } catch (_) {}
  // Commit the off-screen transform (forced layout), then run the slide on a
  // timer rather than requestAnimationFrame, which stalls in a hidden document.
  void entry.page.offsetWidth;
  setTimeout(() => {
    if (!entry.active) return;
    document.documentElement.classList.add('ca-stack-open');
    entry.page.classList.add('in');
    entry.dim.classList.add('in');
  }, 16);
}

export function pushPage(href) {
  href = pushableHref(href);
  if (!href) return;
  const t = top();
  if (t && t.href === href && !t.closing) return;   // double tap
  haptic('light');
  activate(buildEntry(href));
}
export function pushGamePage(id, slot) { pushPage(gameHref(id, slot || '')); }

// ── Touchstart preload ────────────────────────────────────────────────────────
// The row under the finger tells us the page; fetch it now so the document is
// in the HTTP cache (embed documents carry a short private max-age) before the
// tap fires, ~100-300ms ahead. Nothing touches the DOM here: inserting the
// frame mid-touch makes WebKit drop the tap's click.
let _prefetched = { href: '', at: 0 };
function hrefFromTarget(el) {
  if (!el || !el.closest) return null;
  if (el.closest('.ca-stack-page')) return null;
  const a = el.closest('a[href]');
  if (a) return pushableHref(a.getAttribute('href') || '');
  const card = el.closest('.nx-card[data-id]');
  if (card) return gameHref(card.dataset.id);
  const g = el.closest('[onclick*="goGame("]');
  if (g) {
    const m = /goGame\('([^']+)'(?:,\s*'([^']*)')?\)/.exec(g.getAttribute('onclick') || '');
    if (m) return gameHref(m[1], m[2] || '');
  }
  const p = el.closest('[onclick*="goPage("]');
  if (p) {
    const m = /goPage\('([^']+)'\)/.exec(p.getAttribute('onclick') || '');
    if (m) return pushableHref(m[1]);
  }
  return null;
}
function prefetch(href) {
  if (_prefetched.href === href && Date.now() - _prefetched.at < 8000) return;
  _prefetched = { href, at: Date.now() };
  try { fetch(frameSrc(href), { mode: 'no-cors', credentials: 'include' }).catch(() => {}); } catch (_) {}
}

// ── Closing ───────────────────────────────────────────────────────────────────
// viaHistory: true when the close starts from our own UI (Back, swipe, a link
// inside the page), so the history entry pushed on open is popped too. false
// when the pop itself (browser / hardware back) is what closes the page.
export function closeTop(viaHistory = true) {
  const entry = top();
  if (!entry || entry.closing) return;
  entry.closing = true;
  entry.active = false;
  if (viaHistory) { try { history.back(); } catch (_) {} }
  const dur = reducedMotion() ? 0 : DUR_OUT;
  entry.page.style.transition = `transform ${dur}ms ${EASE}`;
  entry.dim.style.transition  = `opacity ${dur}ms ${EASE}`;
  entry.under.forEach(el => { el.style.transition = `transform ${dur}ms ${EASE}`; });
  if (_stack.length === 1) document.documentElement.classList.remove('ca-stack-open');
  entry.page.classList.remove('in');
  entry.dim.classList.remove('in');
  // Inline targets so a half-dragged page animates from wherever it is.
  entry.page.style.transform = 'translateX(100%)';
  entry.dim.style.opacity = '0';
  entry.under.forEach(el => { el.style.transform = 'translateX(0)'; });
  setTimeout(() => finish(entry), dur + 20);
}

function finish(entry) {
  const i = _stack.indexOf(entry);
  if (i >= 0) _stack.splice(i, 1);
  destroyEntry(entry);
  const after = entry.after;
  entry.after = null;
  if (after) { try { after(); } catch (_) {} }
  if (!_stack.length && _afterUnwind) { const fn = _afterUnwind; _afterUnwind = null; try { fn(); } catch (_) {} }
}

// Everything off at once: the top page animates, the ones under it just go.
function closeAll(viaHistory, after) {
  if (!_stack.length) { if (after) after(); return; }
  const depth = _stack.length;
  while (_stack.length > 1) {
    const e = _stack.shift();
    destroyEntry(e);
  }
  document.documentElement.classList.remove('ca-stack-open');
  _afterUnwind = after || null;
  if (viaHistory && depth > 1) {
    // One pop for the extra entries, then closeTop pops the last.
    try { history.go(-(depth - 1)); } catch (_) {}
  }
  closeTop(viaHistory);
}

// ── Left-edge swipe back ──────────────────────────────────────────────────────
// The strip sits over the frame (touches inside a frame never reach the parent),
// follows the finger, and commits past a third of the width or on a flick.
function armEdgeSwipe(entry) {
  const edge = entry.page.querySelector('.ca-stack-edge');
  let startX = 0, startY = 0, startT = 0, dx = 0, dragging = false, decided = false;
  const width = () => entry.page.getBoundingClientRect().width || window.innerWidth || 1;
  const setProgress = (p) => {          // 0 = open, 1 = fully swept away
    entry.page.style.transform = `translateX(${p * 100}%)`;
    entry.dim.style.opacity = String(DIM * (1 - p));
    entry.under.forEach(el => { el.style.transform = `translateX(${-UNDER_SHIFT * (1 - p)}%)`; });
  };
  edge.addEventListener('touchstart', (e) => {
    if (entry.closing || top() !== entry || e.touches.length !== 1) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; startT = Date.now();
    dx = 0; dragging = true; decided = false;
  }, { passive: true });
  edge.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    const mx = t.clientX - startX, my = t.clientY - startY;
    if (!decided) {
      if (Math.abs(mx) < 6 && Math.abs(my) < 6) return;
      decided = true;
      if (Math.abs(my) > Math.abs(mx)) { dragging = false; return; }   // a scroll, not a swipe
      entry.page.style.transition = 'none';
      entry.dim.style.transition = 'none';
      entry.under.forEach(el => { el.style.transition = 'none'; });
    }
    dx = Math.max(0, mx);
    setProgress(dx / width());
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (!decided) return;
    const p = dx / width();
    const v = dx / Math.max(1, Date.now() - startT);   // px per ms
    entry.page.style.transition = '';
    entry.dim.style.transition = '';
    entry.under.forEach(el => { el.style.transition = ''; });
    if (p > 0.34 || v > 0.6) {
      closeTop(true);
    } else {
      entry.page.style.transform = '';
      entry.dim.style.opacity = '';
      entry.under.forEach(el => { el.style.transform = ''; });
    }
  };
  edge.addEventListener('touchend', end);
  edge.addEventListener('touchcancel', end);
}

// ── Messages from the pages ───────────────────────────────────────────────────
function entryForSource(source) {
  for (let i = _stack.length - 1; i >= 0; i--) {
    if (_stack[i].frame.contentWindow === source) return _stack[i];
  }
  return null;
}
async function sendAuth(entry) {
  let token = null;
  try { token = await getToken(); } catch (_) {}
  if (!entry.page.isConnected || !entry.frame.contentWindow) return;
  try { entry.frame.contentWindow.postMessage({ type: 'ca:embed-auth', token: token || null }, entry.origin); } catch (_) {}
}
// A link inside a page: another pushable page stacks on top; a tab or the
// home link unwinds to the shell; anything external opens in the system
// browser (the frame has no Capacitor bridge to do that itself).
function navigateFrom(entry, href, external) {
  if (external) { openExternal(href); return; }
  if (pushableHref(href)) { pushPage(href); return; }
  let tab = null;
  if (href === '/' || href === '') tab = 'home';
  else if (href.startsWith('/#')) tab = href.slice(2);
  else if (href.startsWith('#')) tab = href.slice(1);
  if (tab !== null) { closeAll(true, () => { if (window.switchTab) window.switchTab(tab || 'home'); }); return; }
  closeAll(true, () => { location.href = href; });
}

export function initPageStack() {
  window.goPage = (href) => {
    if (stackEnabled() && pushableHref(href)) pushPage(href);
    else location.href = href;
  };
  window.goGame = (id, slot) => window.goPage(gameHref(id, slot || ''));
  window.openGamePage = (id, slot) => pushPage(gameHref(id, slot || ''));
  window.closeGamePage = closeTop;
  if (_armed) return;
  _armed = true;

  window.addEventListener('popstate', (e) => {
    const depth = (e.state && e.state.caStack) || 0;
    const t = top();
    if (!t || t.closing) return;
    if (_stack.length <= depth) return;          // landed ON a stack entry, not off one
    while (_stack.length > depth + 1) destroyEntry(_stack.shift());
    closeTop(false);
  });

  window.addEventListener('message', (e) => {
    const entry = entryForSource(e.source);
    if (!entry) return;
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'ca:embed-hello':  sendAuth(entry); break;
      case 'ca:embed-ready':  reveal(entry); break;
      case 'ca:embed-back':   if (top() === entry) closeTop(true); break;
      case 'ca:embed-nav':    if (top() === entry) navigateFrom(entry, String(m.href || ''), !!m.external); break;
      case 'ca:embed-login':  closeAll(true, () => { if (window.openLogin)  window.openLogin();  }); break;
      case 'ca:embed-signup': closeAll(true, () => { if (window.openSignup) window.openSignup(); }); break;
    }
  });

  // Shell-side links to pushable pages (My Tracking's "My Action, Live", the
  // sport pages) push instead of navigating.
  document.addEventListener('click', (e) => {
    if (!stackEnabled() || e.defaultPrevented || e.metaKey || e.ctrlKey || e.button) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.target === '_blank' || a.closest('.ca-stack-page')) return;
    let u;
    try { u = new URL(a.getAttribute('href'), location.href); } catch (_) { return; }
    if (u.origin !== location.origin) return;
    const href = pushableHref(u.pathname + u.search + u.hash);
    if (!href) return;
    e.preventDefault();
    pushPage(href);
  }, true);

  // The tab bar stays live under the pages: a tab tap dismisses them all and
  // the tab switch proceeds as usual.
  document.addEventListener('click', (e) => {
    if (!_stack.length) return;
    const item = e.target && e.target.closest ? e.target.closest('.ca-tabbar-item') : null;
    if (!item) return;
    while (_stack.length) destroyEntry(_stack.pop());
    document.documentElement.classList.remove('ca-stack-open');
  }, true);

  // Preload on touchstart (off the dispatch; see prefetch()).
  document.addEventListener('touchstart', (e) => {
    if (!stackEnabled() || e.touches.length !== 1) return;
    const href = hrefFromTarget(e.target);
    if (href) setTimeout(() => prefetch(href), 0);
  }, { capture: true, passive: true });

  window.addEventListener('resize', () => {
    _safeTop = null;
    const b = tabBarHeight() + 'px';
    for (const e of _stack) { e.page.style.bottom = b; e.dim.style.bottom = b; }
  });
}
