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
}

window.switchTab = switchTab;

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => null);
  if (cfg) state.CONFIG = cfg;
  await checkAuth();

  // Handle Stripe redirect back to site
  const params = new URLSearchParams(location.search);
  if (params.get('payment') === 'success') {
    history.replaceState({}, '', '/');
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#16a34a;color:#fff;text-align:center;padding:14px;font-weight:600;font-size:15px;z-index:9999;';
    banner.textContent = 'Payment successful — welcome to CappingAlpha!';
    document.body.prepend(banner);
    setTimeout(() => banner.remove(), 5000);
  } else if (params.get('payment') === 'cancelled') {
    history.replaceState({}, '', '/');
  }

  // Resume checkout if user just signed up with a pending plan
  await resumePendingCheckout();

  await loadPicks();
  loadHomeMvp();
  setInterval(loadPicks, REFRESH_MS);
})();
