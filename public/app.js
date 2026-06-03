// public/app.js — Entry point (ES module)

import { state, REFRESH_MS } from './modules/state.js';
import { checkAuth, isPaying } from './modules/auth.js';
import { loadPicks } from './modules/picks.js';
import { loadMvp, loadMvpPublic, loadHomeMvp } from './modules/mvp.js';
import { loadSports } from './modules/sports.js';
import { renderEsports } from './modules/esports.js';
import { loadAccount } from './modules/account.js';
import './modules/modal.js';
import { resumePendingCheckout } from './modules/paywall.js';
import { loadHomeSidebar, loadHeadlines } from './modules/home_sidebar.js';
import { loadTopGames, loadMySports } from './modules/home_top.js';

// ── Tab switching ─────────────────────────────────────────────────────────────
export function switchTab(tabName) {
  const logo = document.querySelector('.logo');
  if (logo) logo.classList.toggle('active', tabName === 'home');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tabName}`));

  if (tabName === 'mvp') {
    if (!state.mvpLoaded) {
      state.mvpLoaded = true;
      if (isPaying()) {
        loadMvp();
      } else {
        loadMvpPublic();
      }
    }
  }
  if (tabName === 'sports' && !state.sportsLoaded) {
    state.sportsLoaded = true;
    loadSports(state.activeSport);
  }
  if (tabName === 'esports' && !state.esportsLoaded) {
    state.esportsLoaded = true;
    renderEsports();
  }
  if (tabName === 'account') {
    if (!state.currentUser) { switchTab('home'); window.openLogin(); return; }
    loadAccount();
  }

  // Close mobile drawer when navigating
  closeDrawer();
}

window.switchTab = switchTab;

// Honor a hash like #about / #mvp / #sports on initial load and on subsequent
// hashchange events (e.g. someone clicks "Learn how" on the standalone game
// detail page, which links back to /#about).
const HASH_TABS = new Set(['home', 'sports', 'mvp', 'esports', 'about', 'account']);
function applyHashTab() {
  const h = (location.hash || '').replace('#', '').trim().toLowerCase();
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
  // Also close account sub-menu
  const sub = document.getElementById('ca-drawer-account-sub');
  if (sub) sub.classList.remove('open');
}

export function toggleDrawerAccount() {
  const sub = document.getElementById('ca-drawer-account-sub');
  const arrow = document.getElementById('ca-drawer-account-arrow');
  if (!sub) return;
  const isOpen = sub.classList.toggle('open');
  if (arrow) arrow.textContent = isOpen ? '▴' : '▾';
}

Object.assign(window, { toggleDrawer, closeDrawer, toggleDrawerAccount });

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => null);
  if (cfg) {
    state.CONFIG = cfg;
    const t = cfg.mvp_display_threshold || cfg.mvp_threshold || 50;
    // Backwards compat — keep updating the old id-based element if it's still around
    const el = document.getElementById('about-mvp-pts');
    if (el) el.textContent = t;
    // Update every "MVP points" mention site-wide via shared class
    document.querySelectorAll('.mvp-pts-live').forEach(n => { n.textContent = t; });
  }
  await checkAuth();

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
})();
