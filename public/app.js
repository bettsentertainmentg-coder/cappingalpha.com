// public/app.js — Entry point (ES module)

import { state, REFRESH_MS } from './modules/state.js';
import { setHeatScale } from './modules/utils.js?v=7';
import { isNative, initNative, hideSplash, onNotificationTap, haptic } from './modules/native.js?v=2';
import { checkAuth, isPaying } from './modules/auth.js';
import { loadPicks } from './modules/picks.js';
import { loadMvp, loadMvpPublic, loadHomeMvp } from './modules/mvp.js?v=43';
import { loadSports } from './modules/sports.js?v=4';
import { renderEsports } from './modules/esports.js';
import { loadLeaderboard } from './modules/leaderboard.js?v=17';
import { loadSocials } from './modules/socials.js?v=7';
import { loadTracking, loadSettings, loadProfile, renderTrackingGuest } from './modules/account.js?v=69';
import './modules/track.js?v=53';
import './modules/books.js?v=2';
import './modules/modal.js?v=10';
import './modules/member_profile.js?v=25';
import { resumePendingCheckout } from './modules/paywall.js';
import { loadHomeSidebar, loadHeadlines } from './modules/home_sidebar.js?v=12';
import { loadTopGames, loadMySports } from './modules/home_top.js';
import { loadHomeScores } from './modules/home_scores.js?v=4';
import './modules/calcs.js?v=1';
import { renderUnlock } from './modules/unlock.js';
import { maybeStartOnboarding } from './modules/onboarding.js?v=2';

// ── Referral capture ──────────────────────────────────────────────────────────
// A ?ref=CODE share link stores the code; doSignup() redeems it right after the
// account is created (give-a-day / get-a-day).
try {
  const refCode = new URLSearchParams(location.search).get('ref');
  if (refCode && /^[A-Za-z0-9]{4,16}$/.test(refCode)) localStorage.setItem('ca_ref', refCode);
} catch (_) {}

// ── PWA: service worker (offline shell + push notifications) ──────────────────
// On localhost the SW is actively removed instead of registered: an early sw.js
// briefly cached versioned modules in dev, and a stale mid-edit module graph can
// kill the page. This self-heals any browser that got caught in that window.
// Inside the Capacitor shell the SW is skipped the same way: Capacitor serves the
// bundled assets itself, and a SW layered on top double-caches against it.
if ('serviceWorker' in navigator) {
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    || isNative();
  window.addEventListener('load', async () => {
    if (isLocal) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
        if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
      } catch (_) {}
      return;
    }
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
// Logical active tab. Tracked here (not read from the DOM) because the Tab
// Glide view transition applies the class swap a frame later — a DOM read
// during a pending transition would see the OLD panel and misroute a fast
// second tap. index.html boots with panel-home active.
let _activeTab = 'home';
export function switchTab(tabName) {
  // "My Account" split into "My Tracking" + "Settings". Keep old #account links /
  // callers working by routing them to the tracking view.
  if (tabName === 'account') tabName = 'tracking';
  // The Rankings tab's algo-explainer push appends a return chip inside the
  // About panel; any navigation that isn't that flow removes it so a later
  // direct About visit doesn't show it out of context.
  if (tabName !== 'about') document.getElementById('ca-about-return')?.remove();
  // The Leaderboard tab became the Socials tab (board folded in as a sub-tab).
  // Old #leaderboard hashes + in-app "View leaderboard" links land on Socials.
  if (tabName === 'leaderboard') tabName = 'socials';

  // Analytics: this SPA never changes the URL on a tab switch, so PostHog's
  // automatic pageview can't see which tab people land on. Emit it explicitly.
  if (window.posthog) {
    try { posthog.capture('tab_viewed', { tab: tabName }); } catch (e) {}
  }

  const applySwap = () => {
    const logo = document.querySelector('.logo');
    if (logo) logo.classList.toggle('active', tabName === 'home');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tabName}`));
    // Mobile bottom tab bar active state (home/mvp/sports/tracking).
    document.querySelectorAll('.ca-tabbar-item').forEach(b => b.classList.toggle('active', b.dataset.tabbar === tabName));

    // Land at the top of the page on every tab switch. Without this the page keeps
    // its prior scroll position (e.g. opening Unlock from mid-Home dropped you into
    // the middle of the unlock page instead of the "edge, unlocked" hero).
    window.scrollTo(0, 0);
  };

  // "Tab Glide" (docs/UI_VOCABULARY.md): the shell swap cross-fades + slides 8px
  // via the View Transitions API. Only the synchronous class swap above is
  // wrapped — the data loads below run outside the transition, so nothing waits
  // on a fetch. Skipped when unsupported, when reduced motion is on, and on
  // re-entrant/no-op switches (hashchange re-entry lands here with the tab
  // already current). A second startViewTransition while one is pending skips
  // the first but still flushes its callback, so the last tap always wins.
  const isNewPanel = _activeTab !== tabName;
  _activeTab = tabName;
  if (isNewPanel && document.startViewTransition
      && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.startViewTransition(applySwap);
  } else {
    applySwap();
  }
  // Native feel (7g): a light tick on every real tab change. No-op on web.
  if (isNewPanel) haptic('light');

  if (tabName === 'mvp') {
    loadMvpTab();
  }
  if (tabName === 'sports' && !state.sportsLoaded) {
    state.sportsLoaded = true;
    loadSports(state.activeSport);
  }
  if (tabName === 'esports' && !state.esportsLoaded) {
    state.esportsLoaded = true;
    renderEsports();
  }
  if (tabName === 'socials') {
    if (state.currentUser) loadSocials();
    else if (state.authReady) { switchTab('home'); window.openLogin(); return; }
  }
  if (tabName === 'unlock') renderUnlock();
  // My Tracking + Settings are auth-gated. If auth is still resolving (a /#tracking
  // reload can beat checkAuth), leave the panel active — the post-checkAuth re-sync
  // resolves it instead of bouncing a logged-in member to the login popup.
  if (tabName === 'tracking') {
    if (state.currentUser) loadTracking();
    // Guests see the Account tab's sample preview + get-started step (the AN
    // pattern) instead of being bounced to a login popup.
    else if (state.authReady) renderTrackingGuest();
  }
  if (tabName === 'settings') {
    if (state.currentUser) loadSettings();
    else if (state.authReady) { switchTab('home'); window.openLogin(); return; }
  }
  if (tabName === 'profile') {
    if (state.currentUser) loadProfile();
    else if (state.authReady) { switchTab('home'); window.openLogin(); return; }
  }

  // First visit to a tab gets a one-time coach mark above the tab bar (runs
  // after the auth gates so a bounced tab never claims its mark).
  maybeCoachMark(tabName);

  // Keep the URL hash in sync with the active tab, and give each real tab
  // change its own history entry. This used to replaceState instead, which
  // overwrote the only SPA entry: the tab you were just on never existed in
  // history, so browser Back skipped the site entirely and landed on whatever
  // page came before it (Safari: Rankings then Back dropped onto the betting
  // calculators). pushState never fires hashchange, so no re-entrancy; Back /
  // Forward fire hashchange, and applyHashTab re-enters here with the hash
  // already matching, so nothing extra is pushed. A same-tab respelling
  // (#account to #tracking) is normalized in place. Runs after the auth gates
  // so a bounced gated tab never lands in history.
  try {
    const base = location.pathname + location.search;
    const target = tabName === 'home' ? base : base + '#' + tabName;
    if (base + location.hash !== target) {
      const cur = (location.hash || '').replace('#', '').trim().toLowerCase();
      const curTab = cur === 'account' ? 'tracking' : (cur || 'home');
      if (curTab === tabName) history.replaceState(null, '', target);
      else history.pushState(null, '', target);
    }
  } catch (_) {}

  // Close mobile drawer when navigating
  closeDrawer();
  // Close the account dropdown on any navigation
  closeAccountMenu();
}

window.switchTab = switchTab;

// ── First-visit coach marks ───────────────────────────────────────────────────
// One short tooltip the first time each tab is opened, anchored above the tab
// bar with the arrow on the tab that was tapped. Tap anywhere (or 7s) dismisses.
const COACH_COPY = {
  sports:   'Every game today, by sport. Tap a game for live data and lines.',
  mvp:      'The ranked board. Gold is the top tier, graded in public.',
  socials:  'Friends, tails, and the leaderboard.',
  tracking: 'Your bets and record live here. Track one with the + button.',
};
function maybeCoachMark(tabName) {
  if (!COACH_COPY[tabName]) return;
  if (!matchMedia('(max-width: 768px)').matches) return;   // tab-bar surfaces only
  if (window.__caOnboardActive) return;                    // never over the intro
  let seen; try { seen = localStorage.getItem('ca_coach_' + tabName); } catch (_) { seen = '1'; }
  if (seen === '1') return;
  try { localStorage.setItem('ca_coach_' + tabName, '1'); } catch (_) {}
  document.getElementById('ca-coach')?.remove();
  const el = document.createElement('div');
  el.id = 'ca-coach';
  el.className = 'ca-coach';
  el.innerHTML = `<div class="ca-coach-bubble">${COACH_COPY[tabName]}</div><div class="ca-coach-arrow"></div>`;
  document.body.appendChild(el);
  const btn = document.querySelector(`.ca-tabbar-item[data-tabbar="${tabName}"]`);
  if (btn) {
    const r = btn.getBoundingClientRect();
    el.querySelector('.ca-coach-arrow').style.left = (r.left + r.width / 2 - 7) + 'px';
  }
  const kill = () => { el.remove(); document.removeEventListener('pointerdown', kill, true); };
  setTimeout(() => document.addEventListener('pointerdown', kill, true), 150);
  setTimeout(kill, 7000);
}

// Load the CA Picks tab for the current auth tier. Re-loads when the tier changed
// since the last render — fixes the paywall race where the tab rendered its
// public/limited view (with the "Unlock" prompt) before checkAuth() resolved the
// paid tier, then cached it. Called on tab switch and again once auth resolves.
function loadMvpTab() {
  const paid = isPaying();
  // Re-fetch when the cached render is over a minute old — the record bar,
  // graph, and history must include games graded since the tab last rendered.
  const stale = state.mvpLoadedAt && (Date.now() - state.mvpLoadedAt > 60_000);
  if (state.mvpLoaded && state.mvpLoadedPaid === paid && !stale) return;
  state.mvpLoaded = true;
  state.mvpLoadedPaid = paid;
  if (paid) loadMvp(); else loadMvpPublic();
}

// ── Payment success banner + checkout return (Phase 7f) ───────────────────────
// One banner pattern for both arrival paths: the web's /?payment=success
// redirect and the native checkout return (system browser back to the shell).
function showPaymentSuccessBanner() {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#16a34a;color:#fff;text-align:center;padding:14px;font-weight:600;font-size:15px;z-index:9999;';
  banner.textContent = 'Payment successful. Welcome to CappingAlpha!';
  document.body.prepend(banner);
  setTimeout(() => banner.remove(), 5000);
}

// Re-render every auth-gated surface that may already be on screen. Used at boot
// (a tab can render before checkAuth resolves) and after a native checkout
// return flips the tier mid-session.
function resyncAuthSurfaces() {
  if (state.mvpLoaded) loadMvpTab();
  if (state.leaderboardLoaded) loadLeaderboard(state.leaderboardWindow);
  if (document.getElementById('panel-tracking')?.classList.contains('active')) switchTab('tracking');
  if (document.getElementById('panel-settings')?.classList.contains('active')) switchTab('settings');
  if (document.getElementById('panel-profile')?.classList.contains('active')) switchTab('profile');
}

// Native checkout return: registered with initNative (native.js calls it on the
// first foreground event after a checkout opened in the system browser). Returns
// true when handled so native.js can disarm; false keeps it armed for the next
// resume (e.g. the user came back before finishing, or the webhook lagged).
async function handleCheckoutReturn() {
  const wasPaying = isPaying();
  await checkAuth();
  if (!isPaying()) {
    // The Stripe webhook that flips the tier can land a beat after the success
    // redirect; give it one short retry before staying armed.
    await new Promise(r => setTimeout(r, 2500));
    await checkAuth();
  }
  if (!isPaying()) return false;
  try { sessionStorage.removeItem('ca_checkout_plan'); } catch (_) {}
  if (!wasPaying) {
    resyncAuthSurfaces();
    if (window.__caOnboardActive && typeof window.__caOnboardComplete === 'function') {
      // Completing the flow can reload (an account was created mid-flow); stash
      // the banner in sessionStorage so it survives, and show it directly when
      // no reload happens.
      try { sessionStorage.setItem('ca_payment_banner', '1'); } catch (_) {}
      window.__caOnboardComplete();
      try {
        if (sessionStorage.getItem('ca_payment_banner') === '1') {
          sessionStorage.removeItem('ca_payment_banner');
          showPaymentSuccessBanner();
        }
      } catch (_) {}
    } else {
      showPaymentSuccessBanner();
    }
  }
  return true;
}

// ── Support / contact form (About page) ───────────────────────────────────────
async function sendSupport() {
  const btn    = document.getElementById('support-send');
  const status = document.getElementById('support-status');
  const email  = document.getElementById('support-email');
  const msg    = document.getElementById('support-message');
  const topic  = document.getElementById('support-topic');
  const hp      = document.getElementById('support-website');
  if (!btn || !status || !msg) return;

  const setStatus = (text, kind) => {
    status.textContent = text;
    status.className = 'support-status' + (kind ? ' ' + kind : '');
  };

  const message = (msg.value || '').trim();
  if (message.length < 5) { setStatus('Please add a short message first.', 'err'); msg.focus(); return; }

  btn.disabled = true;
  setStatus('Sending...', '');
  try {
    const r = await fetch('/api/support', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:   (email?.value || '').trim(),
        message,
        topic:   topic?.value || 'General',
        website: hp?.value || '',
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.success) {
      setStatus('Thanks. Your message is on its way.', 'ok');
      msg.value = '';
      if (email) email.value = '';
    } else {
      setStatus(data.error || 'Could not send right now. Please try again.', 'err');
    }
  } catch (_) {
    setStatus('Could not send right now. Please try again.', 'err');
  } finally {
    btn.disabled = false;
  }
}
window.sendSupport = sendSupport;

// Honor a hash like #about / #mvp / #sports on initial load and on subsequent
// hashchange events (e.g. someone clicks "Learn how" on the standalone game
// detail page, which links back to /#about).
const HASH_TABS = new Set(['home', 'sports', 'mvp', 'esports', 'leaderboard', 'about', 'account', 'tracking', 'settings', 'unlock', 'profile']);
function applyHashTab() {
  const h = (location.hash || '').replace('#', '').trim().toLowerCase();
  if (!h) {
    // Browser Back/Forward to the bare URL: return to the Home tab. Skipped on
    // the initial page load, where panel-home is already the active default
    // (avoids a redundant switchTab on every plain visit). Checks the logical
    // tab, not the DOM — a pending Tab Glide applies the class a frame later.
    if (_activeTab !== 'home') switchTab('home');
    return;
  }
  if (HASH_TABS.has(h)) switchTab(h);
}
window.addEventListener('hashchange', applyHashTab);
window.addEventListener('DOMContentLoaded', applyHashTab);

// ── Mobile drawer ─────────────────────────────────────────────────────────────
export function toggleDrawer() {
  const overlay = document.getElementById('ca-drawer-overlay');
  const drawer  = document.getElementById('ca-drawer');
  if (!overlay || !drawer) return;
  const isOpen = drawer.classList.contains('open');
  if (isOpen) {
    closeDrawer();
  } else {
    overlay.classList.add('open');
    drawer.classList.add('open');
  }
}

export function closeDrawer() {
  const overlay = document.getElementById('ca-drawer-overlay');
  const drawer  = document.getElementById('ca-drawer');
  if (!overlay || !drawer) return;
  overlay.classList.remove('open');
  drawer.classList.remove('open');
  // Also close the expandable sub-menus (About + My Account)
  const accountSub = document.getElementById('ca-drawer-account-sub');
  if (accountSub) accountSub.classList.remove('open');
  const aboutSub = document.getElementById('ca-drawer-about-sub');
  if (aboutSub) aboutSub.classList.remove('open');
}

export function toggleDrawerAccount() {
  const sub = document.getElementById('ca-drawer-account-sub');
  const arrow = document.getElementById('ca-drawer-account-arrow');
  if (!sub) return;
  const isOpen = sub.classList.toggle('open');
  if (arrow) arrow.textContent = isOpen ? '▴' : '▾';
}

export function toggleDrawerAbout() {
  const sub = document.getElementById('ca-drawer-about-sub');
  const arrow = document.getElementById('ca-drawer-about-arrow');
  if (!sub) return;
  const isOpen = sub.classList.toggle('open');
  if (arrow) arrow.textContent = isOpen ? '▴' : '▾';
}

export function toggleDrawerSports() {
  const sub = document.getElementById('ca-drawer-sports-sub');
  const chev = document.getElementById('ca-drawer-sports-chev');
  if (!sub) return;
  const isOpen = sub.classList.toggle('open');
  if (chev) chev.textContent = isOpen ? '▾' : '›';
}

// Mobile tabbar Sports: the SPA sports tab is gone, so the tabbar button opens
// the drawer with the sports list expanded (one tap from any sport's page).
export function openSportsPicker() {
  toggleDrawer();
  const sub = document.getElementById('ca-drawer-sports-sub');
  const chev = document.getElementById('ca-drawer-sports-chev');
  if (sub && !sub.classList.contains('open')) {
    sub.classList.add('open');
    if (chev) chev.textContent = '▾';
  }
}

Object.assign(window, { toggleDrawer, closeDrawer, toggleDrawerAccount, toggleDrawerAbout, toggleDrawerSports, openSportsPicker });

// ── Account dropdown (desktop avatar menu) ────────────────────────────────────
export function toggleAccountMenu(e) {
  if (e) e.stopPropagation();
  // App: no dropdown. The avatar goes straight to the profile page; Settings
  // is the gear next to the name up top.
  if (document.documentElement.classList.contains('ca-app')) {
    switchTab('profile');
    return;
  }
  const dd  = document.getElementById('account-dropdown');
  const btn = document.getElementById('nav-avatar-btn');
  if (!dd) return;
  const willOpen = dd.classList.contains('hidden');
  dd.classList.toggle('hidden', !willOpen);
  if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}
export function closeAccountMenu() {
  const dd  = document.getElementById('account-dropdown');
  const btn = document.getElementById('nav-avatar-btn');
  if (dd && !dd.classList.contains('hidden')) dd.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
// Close the menu on any outside click (ignore clicks on either avatar trigger or
// inside the menu itself).
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#account-dropdown, .account-trigger')) return;
  closeAccountMenu();
});
// Close on Escape.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccountMenu(); });

// Support menu item → go to the About page AND scroll to the Contact & Support
// section at the bottom, rather than dropping the user at the top of About.
export function goSupport() {
  switchTab('about');
  setTimeout(() => {
    document.getElementById('support')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 90);
}
window.goSupport = goSupport;

// ── Theme (light / dark) ──────────────────────────────────────────────────────
// Default is dark. The pre-paint inline script in index.html sets the initial
// attribute; this keeps it in sync, persists the choice, and updates the toggle UI.
export function getTheme() {
  try { return localStorage.getItem('ca_theme') === 'light' ? 'light' : 'dark'; }
  catch (_) { return 'dark'; }
}
export function setTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('ca_theme', t); } catch (_) {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#ffffff' : '#0f1117');
  // Reflect on any theme-toggle controls currently on screen.
  document.querySelectorAll('[data-theme-opt]').forEach(b => b.classList.toggle('active', b.dataset.themeOpt === t));
}

Object.assign(window, { toggleAccountMenu, closeAccountMenu, getTheme, setTheme });

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  // Sync theme-color meta + any toggle UI to the saved choice (attribute is already
  // set pre-paint by the inline script in index.html).
  setTheme(getTheme());
  // No-op on web; splash/status-bar/deep-link wiring in the app shell. The
  // callback is the checkout return path (7f): after Stripe opens in the system
  // browser, the next foreground event re-checks /auth/me and reacts to the
  // tier flip (banner, surface re-sync, onboarding completion).
  initNative({ onCheckoutReturn: handleCheckoutReturn });

  // Notification taps (native push, Phase 7e): map the payload's data.type to
  // in-app navigation. Registered immediately after initNative — the earliest
  // point in boot — so a cold-start tap, which the bridge buffers until the
  // listener attaches, lands on the right screen. Web push routes through
  // sw.js instead, which navigates by the same data.url. No-op on web.
  onNotificationTap((data) => {
    const go = () => {
      try {
        const type = (data && data.type) || '';
        const url  = (data && data.url)  || '';
        const gameId = (/^\/game\/([\w-]+)/.exec(url) || [])[1] || (data && data.espn_game_id) || '';
        if (type === 'game_start' || type === 'steam' || type === 'swing') {
          // The game modal when we know the game; the live dashboard otherwise.
          if (gameId && window.openGameModal) window.openGameModal(gameId);
          else window.location.href = '/mylive';
        }
        else if (type === 'grades')   switchTab('mvp');
        else if (type === 'top_pick') switchTab('home');
        else if (type === 'account')  switchTab('settings');
        else if (type === 'social_follow' || type === 'social_tail') switchTab('socials');
        else if (url) window.location.href = url;
      } catch (_) {}
    };
    // A cold-start tap can arrive before the DOM is ready — defer it.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
  });

  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => null);
  if (cfg) {
    state.CONFIG = cfg;
    // Calibrate the pick heat gradient (and 🔥 line) to the live score scale.
    // The threshold drives color only; the raw number is never written into
    // user-facing copy (no-reveal rule).
    setHeatScale({ silver: cfg.mvp_threshold, gold: cfg.mvp_display_threshold, fire: cfg.heat_fire_threshold });
  }
  await checkAuth();
  state.authReady = true;

  // Auth-dependent tabs can render before checkAuth resolves — a /#tab reload makes
  // DOMContentLoaded hash nav beat checkAuth. Re-sync whatever already rendered so a
  // logged-in member never sees the logged-out view: the CA Rankings "Unlock" view,
  // "Log in to rank" on the leaderboard, or an account bounce to the login popup.
  resyncAuthSurfaces();

  // App shell: the shell + auth state are painted, drop the native splash. (A 6s
  // safety timer in initNative covers any throw above; extra calls no-op.)
  hideSplash();

  // First-run onboarding (Phase 7d): native first launch, or ?onboard=1 anywhere
  // (desktop preview + the admin phone lab). No-ops for paying members; sets
  // window.__caOnboardActive while the overlay owns the screen.
  maybeStartOnboarding();

  // Referral link (?ref=CODE): a friend arriving from a share link lands right on
  // the signup form, with the "code applied, 3 free days" banner (unlock.js). The
  // code was stashed in localStorage above and is redeemed automatically the moment
  // they finish signing up (auth.doSignup). Logged-out visitors only. Skipped while
  // the onboarding overlay is up — its own account step redeems the code instead.
  try {
    if (!window.__caOnboardActive && !state.currentUser && localStorage.getItem('ca_ref') && window.openSignup) {
      window.openSignup();
    }
  } catch (_) {}

  // Handle Stripe redirect back to the site (web), plus the banner flag a
  // native checkout return stashed before an onboarding-completion reload (7f).
  const params = new URLSearchParams(location.search);
  let nativeBanner = false;
  try {
    nativeBanner = sessionStorage.getItem('ca_payment_banner') === '1';
    if (nativeBanner) sessionStorage.removeItem('ca_payment_banner');
  } catch (_) {}
  if (params.get('payment') === 'success' || nativeBanner) {
    if (params.get('payment') === 'success') history.replaceState({}, '', '/');
    showPaymentSuccessBanner();
  } else if (params.get('payment') === 'cancelled') {
    history.replaceState({}, '', '/');
  }

  // Resume checkout if user just signed up with a pending plan
  await resumePendingCheckout();

  await loadPicks();
  loadTopGames();
  loadMySports();
  loadHomeMvp();
  loadHomeSidebar();
  loadHeadlines();
  loadHomeScores();   // app shell only (self-gated on html.ca-app)
  setInterval(loadPicks, REFRESH_MS);
  setInterval(loadTopGames, REFRESH_MS);
  // Keep the #1 pick card (live score badge) + sidebar games fresh on the same cadence.
  setInterval(loadHomeSidebar, REFRESH_MS);
  // Home MVP widget too — its record and P/L must fold in games graded during
  // the session, not just what was final at page load.
  setInterval(loadHomeMvp, REFRESH_MS);
  setInterval(loadHomeScores, REFRESH_MS);

  // Near-real-time refresh while a game is live: every 30s re-pull the live
  // surfaces (board scores, #1 card, Top Games tiles). Gated on a live game being
  // present so we don't poll all day; the 5-min baseline above covers everything
  // else and catches a game turning live.
  setInterval(() => {
    const live = (state.allPicks || []).some(p => p.game_status === 'in');
    if (!live) return;
    loadPicks();
    loadTopGames();
    loadHomeSidebar();
    loadHomeScores();
  }, 30000);
})();
