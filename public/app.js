// public/app.js — Entry point (ES module)

import { state, REFRESH_MS } from './modules/state.js';
import { setHeatScale } from './modules/utils.js?v=4';
import { checkAuth, isPaying } from './modules/auth.js';
import { loadPicks } from './modules/picks.js';
import { loadMvp, loadMvpPublic, loadHomeMvp } from './modules/mvp.js?v=35';
import { loadSports } from './modules/sports.js';
import { renderEsports } from './modules/esports.js';
import { loadLeaderboard } from './modules/leaderboard.js?v=15';
import { loadSocials } from './modules/socials.js?v=5';
import { loadTracking, loadSettings, loadProfile } from './modules/account.js?v=60';
import './modules/track.js?v=49';
import './modules/books.js?v=2';
import './modules/modal.js?v=7';
import './modules/member_profile.js?v=23';
import { resumePendingCheckout } from './modules/paywall.js';
import { loadHomeSidebar, loadHeadlines } from './modules/home_sidebar.js?v=8';
import { loadTopGames, loadMySports } from './modules/home_top.js';
import { renderUnlock } from './modules/unlock.js';

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
if ('serviceWorker' in navigator) {
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
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
export function switchTab(tabName) {
  // "My Account" split into "My Tracking" + "Settings". Keep old #account links /
  // callers working by routing them to the tracking view.
  if (tabName === 'account') tabName = 'tracking';
  // The Leaderboard tab became the Socials tab (board folded in as a sub-tab).
  // Old #leaderboard hashes + in-app "View leaderboard" links land on Socials.
  if (tabName === 'leaderboard') tabName = 'socials';

  // Analytics: this SPA never changes the URL on a tab switch, so PostHog's
  // automatic pageview can't see which tab people land on. Emit it explicitly.
  if (window.posthog) {
    try { posthog.capture('tab_viewed', { tab: tabName }); } catch (e) {}
  }

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
    else if (state.authReady) { switchTab('home'); window.openLogin(); return; }
  }
  if (tabName === 'settings') {
    if (state.currentUser) loadSettings();
    else if (state.authReady) { switchTab('home'); window.openLogin(); return; }
  }
  if (tabName === 'profile') {
    if (state.currentUser) loadProfile();
    else if (state.authReady) { switchTab('home'); window.openLogin(); return; }
  }

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
    // (avoids a redundant switchTab on every plain visit).
    if (!document.getElementById('panel-home')?.classList.contains('active')) switchTab('home');
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
  if (state.mvpLoaded) loadMvpTab();
  if (state.leaderboardLoaded) loadLeaderboard(state.leaderboardWindow);
  if (document.getElementById('panel-tracking')?.classList.contains('active')) switchTab('tracking');
  if (document.getElementById('panel-settings')?.classList.contains('active')) switchTab('settings');
  if (document.getElementById('panel-profile')?.classList.contains('active')) switchTab('profile');

  // Referral link (?ref=CODE): a friend arriving from a share link lands right on
  // the signup form, with the "code applied, 3 free days" banner (unlock.js). The
  // code was stashed in localStorage above and is redeemed automatically the moment
  // they finish signing up (auth.doSignup). Logged-out visitors only.
  try {
    if (!state.currentUser && localStorage.getItem('ca_ref') && window.openSignup) {
      window.openSignup();
    }
  } catch (_) {}

  // Handle Stripe redirect back to site
  const params = new URLSearchParams(location.search);
  if (params.get('payment') === 'success') {
    history.replaceState({}, '', '/');
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#16a34a;color:#fff;text-align:center;padding:14px;font-weight:600;font-size:15px;z-index:9999;';
    banner.textContent = 'Payment successful. Welcome to CappingAlpha!';
    document.body.prepend(banner);
    setTimeout(() => banner.remove(), 5000);
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
  setInterval(loadPicks, REFRESH_MS);
  setInterval(loadTopGames, REFRESH_MS);
  // Keep the #1 pick card (live score badge) + sidebar games fresh on the same cadence.
  setInterval(loadHomeSidebar, REFRESH_MS);
  // Home MVP widget too — its record and P/L must fold in games graded during
  // the session, not just what was final at page load.
  setInterval(loadHomeMvp, REFRESH_MS);

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
  }, 30000);
})();
