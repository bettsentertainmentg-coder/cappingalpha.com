// modules/paywall.js — Paywall HTML and access code redemption

import { state } from './state.js';
import { isViewer, isAccount, isPaying } from './auth.js';
import { LOCK_SVG } from './utils.js?v=4';

const PRICE_IDS = {
  day:  'price_1TMhkAB0ohior8iouVKseqmk',
  week: 'price_1TMhkCB0ohior8iomOMDlrts',
  year: 'price_1TMhkAB0ohior8iohRBOZKdH',
};

export async function startCheckout(plan) {
  const priceId = PRICE_IDS[plan];
  if (!priceId) return;

  if (!state.currentUser) {
    // Store intended plan, show signup — checkout continues after login
    sessionStorage.setItem('pendingPlan', plan);
    window.openSignup();
    return;
  }

  try {
    const res  = await fetch('/auth/create-checkout-session', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ priceId }),
    });
    const data = await res.json();
    if (res.status === 401) { window.openLogin(); return; }
    if (!res.ok) { alert([data.error || 'Could not start checkout. Try again.', data.detail].filter(Boolean).join('\n\n')); return; }
    window.location.href = data.url;
  } catch (_) {
    alert('Network error. Please try again.');
  }
}

// Called after successful login/signup — resume pending checkout if any
export async function resumePendingCheckout() {
  const plan = sessionStorage.getItem('pendingPlan');
  if (!plan || !state.currentUser) return;
  sessionStorage.removeItem('pendingPlan');
  await startCheckout(plan);
}

// Drawer "Premium Access". Logged in → straight to checkout. Logged out → the
// unlock page at the TOP (the "edge, unlocked" hero), NOT scrolled to the
// Create-your-account form — that centered scroll is only for explicit "sign up"
// actions (login popup, etc.), not the hamburger-menu upgrade tap.
export function drawerPremium() {
  if (state.currentUser) { startCheckout('week'); return; }
  window.__caScrollAccount = false;
  if (window.switchTab) window.switchTab('unlock');
}

// Shared upgrade CTA — a gold "Unlock the CappingAlpha" button (lock → unlock on
// hover, like the top-right nav button) that opens the unlock page, with the
// access options underneath. Used by the Today's Picks paywall and the MVP prompt.
export function unlockCtaHtml() {
  return `
    <div class="unlock-cta">
      <button class="unlock-cta-btn" onclick="event.stopPropagation();switchTab('unlock')">
        <span class="ucb-lock">&#128274;</span><span class="ucb-open">&#128275;</span>
        Unlock CappingAlpha
      </button>
      <div class="unlock-cta-access">Already have access? <a onclick="event.stopPropagation();openLogin()">Log in</a> &middot; <a onclick="event.stopPropagation();openCodeModal()">I have a code</a></div>
    </div>`;
}

export function inlinePaywallHtml() {
  return `
    <div class="inline-paywall-wrap" id="paywall-wrap">
      <div class="inline-paywall-fade"></div>
      <div class="inline-paywall-card" id="paywall-card">
        <div class="inline-paywall-head" style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:10px;text-align:center;">See today's complete rankings</div>
        ${unlockCtaHtml()}
      </div>
    </div>`;
}

export function inlineSignupCtaHtml() {
  return inlinePaywallHtml();
}

// Floating box that sits ON TOP of the blurred rankings list (vs. a bar below it),
// so visitors see a full board of blurred picks behind it. Caller wraps the table
// + this box in a .ca-rank-lock-wrap (position:relative).
export function lockedRankingsBoxHtml() {
  return `
    <div class="ca-rank-lock-box">
      <div class="ca-rank-lock-box-head">See today's complete rankings</div>
      ${unlockCtaHtml()}
    </div>`;
}

// ── Access-code modal — context-independent code entry (works from any paywall
// button and the unlock page). Requires an account; otherwise nudges to sign up.
export function openCodeModal() {
  const modal = document.getElementById('code-modal');
  if (!modal) return;
  const entry    = document.getElementById('code-modal-inner');
  const needAcct = document.getElementById('code-modal-needacct');
  const err      = document.getElementById('code-modal-error');
  if (err) err.textContent = '';
  const loggedIn = !!state.currentUser;
  if (entry)    entry.style.display    = loggedIn ? '' : 'none';
  if (needAcct) needAcct.style.display = loggedIn ? 'none' : '';
  modal.classList.remove('hidden');
  if (loggedIn) document.getElementById('code-modal-input')?.focus();
}

export function closeCodeModal() {
  const modal = document.getElementById('code-modal');
  if (modal) modal.classList.add('hidden');
}

export function submitCodeModal() {
  return doRedeemCode('code-modal-input', 'code-modal-error');
}

export function openCodeEntry() {
  const card = document.getElementById('paywall-card');
  if (!card) return;
  if (!state.currentUser) {
    card.innerHTML = `
      <h3>Access Code</h3>
      <p>You need an account to redeem a code.</p>
      <div class="inline-paywall-btns">
        <button class="btn btn-primary" onclick="openSignup()">Create Account</button>
        <button class="btn btn-ghost" onclick="openLogin()">Log In</button>
      </div>
      <div class="paywall-code-link"><a onclick="renderPaywallDefault()">Back</a></div>`;
    return;
  }
  card.innerHTML = `
    <h3>Enter Your Access Code</h3>
    <p>Enter today's code for 24-hour access.</p>
    <div class="code-entry-row">
      <input type="text" id="access-code-input" placeholder="Access code" autocomplete="off" />
      <button class="btn btn-gold" onclick="doRedeemCode()">Redeem</button>
    </div>
    <div class="form-error" id="code-error"></div>
    <div class="paywall-code-link"><a onclick="renderPaywallDefault()">Back</a></div>`;
  document.getElementById('access-code-input').focus();
}

export function renderPaywallDefault() {
  const card = document.getElementById('paywall-card');
  if (!card) return;
  card.innerHTML = `
    <h3>Unlock CappingAlpha</h3>
    <p>3 days free, then $4/week &middot; $75/year (about $1.44/week) &middot; $1 day pass</p>
    <div class="inline-paywall-btns">
      <button class="btn btn-gold" onclick="startCheckout('week')">3 Days Free</button>
      <button class="btn btn-primary" onclick="startCheckout('year')">Annual $75</button>
      <button class="btn btn-primary" onclick="startCheckout('day')">Day $1</button>
    </div>
    <div class="inline-paywall-login">Already have access? <a onclick="openLogin()">Log in</a> &nbsp;·&nbsp; <a onclick="openSignup()">Sign up free</a></div>
    <div class="paywall-code-link"><a onclick="openCodeEntry()">I have an access code</a></div>`;
}

export async function doRedeemCode(inputId = 'access-code-input', errId = 'code-error') {
  const input = document.getElementById(inputId);
  const errEl = document.getElementById(errId);
  const code  = input?.value.trim();
  if (!code) { if (errEl) errEl.textContent = 'Please enter a code.'; return; }
  if (errEl) errEl.textContent = '';
  try {
    const res  = await fetch('/auth/redeem-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) { if (errEl) errEl.textContent = data.error || 'Invalid code.'; return; }
    location.reload();
  } catch (_) { if (errEl) errEl.textContent = 'Network error. Try again.'; }
}

Object.assign(window, { openCodeEntry, renderPaywallDefault, doRedeemCode, startCheckout, resumePendingCheckout, drawerPremium, openCodeModal, closeCodeModal, submitCodeModal });
