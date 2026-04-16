// modules/paywall.js — Paywall HTML and access code redemption

import { state } from './state.js';
import { isViewer, isAccount, isPaying } from './auth.js';
import { LOCK_SVG } from './utils.js';

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
    if (!res.ok) { alert(data.error || 'Could not start checkout. Try again.'); return; }
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

export function inlinePaywallHtml() {
  const loggedIn = !isViewer();
  const loginRow = loggedIn
    ? ''
    : `<div class="inline-paywall-login">Already have access? <a onclick="openLogin()">Log in</a></div>`;
  const freeNote = isViewer()
    ? `<div class="paywall-code-link" style="margin-top:6px;"><a onclick="openSignup()">Sign up free</a> to vote on games and track your picks.</div>`
    : '';
  return `
    <div class="inline-paywall-wrap" id="paywall-wrap">
      <div class="inline-paywall-fade"></div>
      <div class="inline-paywall-card" id="paywall-card">
        <h3>Unlock Today's Top Picks</h3>
        <div class="paywall-pricing-row">
          <div class="paywall-price-card" onclick="startCheckout('day')">
            <div class="paywall-price">$1</div>
            <div class="paywall-price-label">Day</div>
          </div>
          <div class="paywall-price-card paywall-price-featured" onclick="startCheckout('week')">
            <div class="paywall-price">$4</div>
            <div class="paywall-price-label">/week</div>
          </div>
          <div class="paywall-price-card" onclick="startCheckout('year')">
            <div class="paywall-price">$75</div>
            <div class="paywall-price-label">/year</div>
          </div>
        </div>
        ${loginRow}
        <div class="paywall-code-link"><a onclick="openCodeEntry()">I have an access code</a></div>
        ${freeNote}
      </div>
    </div>`;
}

export function inlineSignupCtaHtml() {
  return inlinePaywallHtml();
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
    <h3>Unlock All Ranked Plays</h3>
    <p>$1/day &middot; $4/week &middot; $75/year</p>
    <div class="inline-paywall-btns">
      <button class="btn btn-gold" onclick="openSignup()">Day $1</button>
      <button class="btn btn-primary" onclick="openSignup()">Week $4</button>
      <button class="btn btn-primary" onclick="openSignup()">Annual $75</button>
    </div>
    <div class="inline-paywall-login">Already have access? <a onclick="openLogin()">Log in</a></div>
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

Object.assign(window, { openCodeEntry, renderPaywallDefault, doRedeemCode, startCheckout, resumePendingCheckout });
