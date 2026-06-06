// modules/auth.js — Auth state, tier helpers, login/signup/logout

import { state } from './state.js';

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
  const tabAccount = document.getElementById('tab-account');
  // Mobile drawer mirrors the same auth state. It previously never updated, so the
  // phone always showed "Log In / Get Access" (and the upgrade prompt) even when
  // signed in and subscribed.
  const dLogin   = document.getElementById('drawer-btn-login');
  const dSignup  = document.getElementById('drawer-btn-signup');
  const dLogout  = document.getElementById('drawer-btn-logout');
  const dUpgrade = document.getElementById('drawer-upgrade');

  const loggedIn = !!state.currentUser;
  const paying   = loggedIn && state.currentUser.tier !== 'free';
  const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };

  show(btnLogin,  !loggedIn);
  show(btnSignup, !loggedIn);
  show(btnLogout, loggedIn);
  show(tabAccount, loggedIn);
  show(userInfo, loggedIn);
  if (loggedIn && userInfo) userInfo.textContent = state.currentUser.username || state.currentUser.email;

  show(dLogin,  !loggedIn);
  show(dSignup, !loggedIn);
  show(dLogout, loggedIn);
  // Drop the "Premium Access" upgrade shortcut once they already pay.
  show(dUpgrade, !paying);

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
export function openSignup() {
  document.getElementById('signup-modal').classList.remove('hidden');
  document.getElementById('signup-email').focus();
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
      body: JSON.stringify({ email, password, username, tos_agreed: true }),
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
Object.assign(window, {
  openLogin, closeLogin, doLogin,
  openSignup, closeSignup, doSignup,
  doLogout,
  showForgotPassword, showLoginForm, doForgotPassword,
});
