// modules/auth.js — Auth state, tier helpers, login/signup/logout

import { state } from './state.js';
import { avatarFor } from './utils.js?v=1';

// ── Tier helpers ──────────────────────────────────────────────────────────────
export function isViewer()  { return !state.currentUser; }
export function isAccount() { return !!state.currentUser && state.currentUser.tier === 'free'; }
export function isPaying()  { return !!state.currentUser && state.currentUser.tier !== 'free'; }
export function isMvpUser() {
  return !!state.currentUser && (
    state.currentUser.tier === 'annual' ||
    state.currentUser.tier === 'code'   ||
    state.currentUser.tier === 'day'
  );
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function checkAuth() {
  try {
    const res  = await fetch('/auth/me');
    const data = await res.json();
    state.currentUser = data.user;
    // Preload the unit size at boot so the Track FAB's default stake is the user's
    // real unit, not the hardcoded $20 fallback (it used to load only once the
    // Tracking tab had been opened).
    if (data.user && data.user.unit_size != null) window._trackUnitSize = Number(data.user.unit_size);
  } catch (_) {
    state.currentUser = null;
  }
  updateNavAuth();
}

export function updateNavAuth() {
  const btnLogin   = document.getElementById('btn-login');
  const btnSignup  = document.getElementById('btn-signup');
  const btnLogout  = document.getElementById('btn-logout');
  const userInfo   = document.getElementById('nav-user-info');
  const navAvatar  = document.getElementById('nav-avatar-btn');    // desktop trigger
  const mNavAvatar = document.getElementById('m-nav-avatar-btn');  // mobile trigger
  // Mobile drawer mirrors the same auth state. It previously never updated, so the
  // phone always showed "Log In / Get Access" (and the upgrade prompt) even when
  // signed in and subscribed.
  const dLogout  = document.getElementById('drawer-btn-logout');
  const dUpgrade = document.getElementById('drawer-upgrade');
  const drawerFooter = document.getElementById('ca-drawer-footer');
  // Mobile top-bar action: Unlock (logged out) vs My Account (signed in).
  const mUnlock  = document.getElementById('m-nav-unlock');

  const loggedIn = !!state.currentUser;
  const paying   = loggedIn && state.currentUser.tier !== 'free';
  const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };

  show(btnLogin,  !loggedIn);
  show(btnSignup, !loggedIn);
  show(btnLogout, loggedIn);
  // The avatar dropdown replaces the old "My Account" button + username span: it
  // carries the identity, so the standalone username span stays hidden. Both the
  // desktop and mobile avatars open the same dropdown; CSS shows whichever fits the
  // current width, so we just fill both.
  show(navAvatar, loggedIn);
  show(mNavAvatar, loggedIn);
  show(userInfo, false);
  if (loggedIn) {
    const u = state.currentUser;
    const av = avatarFor(u.username || u.email, 30, u.avatar_url || null);
    const s1 = document.getElementById('nav-avatar-slot');
    const s2 = document.getElementById('m-nav-avatar-slot');
    if (s1) s1.innerHTML = av;
    if (s2) s2.innerHTML = av;
    const nameEl  = document.getElementById('account-dd-name');
    const emailEl = document.getElementById('account-dd-email');
    if (nameEl)  nameEl.textContent  = u.username ? '@' + u.username : (u.email || '');
    if (emailEl) emailEl.textContent = u.email || '';
  }

  show(dLogout, loggedIn);
  // Drop the "Premium Access" upgrade shortcut once they already pay.
  show(dUpgrade, !paying);
  // Drawer footer holds the logged-out Unlock CTA (replaces old Log In / Get Access).
  show(drawerFooter, !loggedIn);

  // Unlock CTA (desktop nav): show to anyone not already paying.
  show(document.getElementById('btn-unlock'), !paying);
  // Mobile top-bar: Unlock when logged out; the avatar (handled above) when signed in.
  show(mUnlock,  !loggedIn);
  // Track-Bet FAB: floating, only for logged-in users. Set 'flex' explicitly (not
  // via show(), whose '' would fall back to the CSS display:none default).
  const fab = document.getElementById('track-fab');
  if (fab) fab.style.display = loggedIn ? 'flex' : 'none';

  // Identify user in PostHog so sessions are linked to accounts.
  if (loggedIn && window.posthog) {
    posthog.identify(String(state.currentUser.id), {
      email: state.currentUser.email,
      tier:  state.currentUser.tier,
    });
  }
}

// ── Login modal ───────────────────────────────────────────────────────────────
export function openLogin() {
  document.getElementById('login-modal').classList.remove('hidden');
  document.getElementById('login-email').focus();
}
export function closeLogin() {
  document.getElementById('login-modal').classList.add('hidden');
  document.getElementById('login-error').textContent = '';
}

export async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Email and password required.'; return; }
  try {
    const res  = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Login failed.'; return; }
    location.reload();
  } catch (_) { errEl.textContent = 'Network error. Try again.'; }
}

// ── Signup modal ──────────────────────────────────────────────────────────────
// Account creation now lives entirely on the unlock page ("Create your account").
// There is no standalone signup popup — every "sign up / create account" entry
// routes here, scrolling to the account form.
export function openSignup() {
  closeLogin();
  // Tell renderUnlock to center the "Create your account" card once it finishes
  // loading. Scrolling here (before the async render re-flows the page) left the
  // form half off-screen, so renderUnlock owns the scroll now.
  window.__caScrollAccount = true;
  if (window.switchTab) window.switchTab('unlock');
}
export function closeSignup() {
  document.getElementById('signup-modal').classList.add('hidden');
  document.getElementById('signup-error').textContent = '';
}

export async function doSignup() {
  const username  = (document.getElementById('signup-username')?.value || '').trim();
  const email     = document.getElementById('signup-email').value.trim();
  const password  = document.getElementById('signup-password').value;
  const confirm   = document.getElementById('signup-confirm').value;
  const tosCheck  = document.getElementById('signup-tos')?.checked;
  const lbEl      = document.getElementById('signup-leaderboard');
  const publicLb  = lbEl ? lbEl.checked : true;
  const errEl     = document.getElementById('signup-error');
  errEl.textContent = '';
  if (!username) { errEl.textContent = 'Username is required.'; return; }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) { errEl.textContent = 'Username must be 3–20 characters: letters, numbers, underscores only.'; return; }
  if (!email || !password) { errEl.textContent = 'Email and password required.'; return; }
  if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }
  if (password.length < 8)  { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  if (!tosCheck) { errEl.textContent = 'You must agree to the Terms of Service.'; return; }
  try {
    const res  = await fetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, username, tos_agreed: true, public_leaderboard: publicLb }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Signup failed.'; return; }
    location.reload();
  } catch (_) { errEl.textContent = 'Network error. Try again.'; }
}

// ── Forgot password ───────────────────────────────────────────────────────────
export function showForgotPassword() {
  document.getElementById('login-form-inner').style.display  = 'none';
  document.getElementById('login-forgot-inner').style.display = '';
  document.getElementById('login-error').textContent = '';
  document.getElementById('forgot-email').focus();
}
export function showLoginForm() {
  document.getElementById('login-forgot-inner').style.display = 'none';
  document.getElementById('login-form-inner').style.display   = '';
  document.getElementById('forgot-success').style.display     = 'none';
}

export async function doForgotPassword() {
  const email = document.getElementById('forgot-email').value.trim();
  const errEl = document.getElementById('login-error');
  const okEl  = document.getElementById('forgot-success');
  errEl.textContent = '';
  okEl.style.display = 'none';
  if (!email) { errEl.textContent = 'Email is required.'; return; }
  try {
    await fetch('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    okEl.style.display = '';
  } catch (_) { errEl.textContent = 'Network error. Try again.'; }
}

// ── Logout ────────────────────────────────────────────────────────────────────
export async function doLogout() {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}

// ── Enter key handler for modals ──────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (!document.getElementById('login-modal').classList.contains('hidden')) {
    const forgotVisible = document.getElementById('login-forgot-inner')?.style.display !== 'none';
    if (forgotVisible) doForgotPassword(); else doLogin();
  }
  if (!document.getElementById('signup-modal').classList.contains('hidden')) doSignup();
});

// ── Expose to window for inline onclick handlers ──────────────────────────────
// ── Continue with Google (login modal) ────────────────────────────────────────
// GIS token flow → /auth/google (server validates the token + creates/links/logs
// in the account). Dormant until google_client_id is present in /api/config.
let _gisPromise = null;
function _loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (_gisPromise) return _gisPromise;
  _gisPromise = new Promise((resolve, reject) => {
    let s = document.getElementById('gis-script');
    if (s) { s.addEventListener('load', () => resolve()); s.addEventListener('error', () => reject(new Error('gis'))); return; }
    s = document.createElement('script');
    s.id = 'gis-script';
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('gis'));
    document.head.appendChild(s);
  });
  return _gisPromise;
}

export async function loginWithGoogle() {
  const errEl = document.getElementById('login-error');
  const clientId = state.CONFIG?.google_client_id;
  if (!clientId) { if (errEl) errEl.textContent = 'Google sign-in is coming soon. Use email below for now.'; return; }
  if (errEl) errEl.textContent = '';
  try {
    await _loadGis();
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'openid email profile',
      callback: async (resp) => {
        if (resp.error || !resp.access_token) { if (errEl) errEl.textContent = 'Google sign-in was cancelled.'; return; }
        try {
          const r = await fetch('/auth/google', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: resp.access_token }),
          });
          const data = await r.json();
          if (!r.ok) { if (errEl) errEl.textContent = data.error || 'Google sign-in failed.'; return; }
          location.reload();
        } catch (_) { if (errEl) errEl.textContent = 'Network error. Try again.'; }
      },
    });
    tokenClient.requestAccessToken();
  } catch (_) { if (errEl) errEl.textContent = 'Could not reach Google. Try again.'; }
}

Object.assign(window, {
  openLogin, closeLogin, doLogin,
  openSignup, closeSignup, doSignup,
  doLogout, loginWithGoogle,
  showForgotPassword, showLoginForm, doForgotPassword,
});
