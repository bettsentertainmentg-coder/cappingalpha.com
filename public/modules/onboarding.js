// modules/onboarding.js — 9-screen first-run onboarding (Phase 7d)
//
// Runs inside the app shell on first launch (isNative() && no ca_onboarded flag)
// and on the web when the URL carries ?onboard=1 (desktop preview + the admin
// phone lab). One full-screen overlay hosts every step; steps slide with the
// "Onboard Glide" transition (240ms transform, killed under
// prefers-reduced-motion; named in docs/UI_VOCABULARY.md).
//
// Flow: 1 age gate -> 2-5 carousel -> 6 notification soft-ask -> 7 value tease
// (locked #1 teaser, never a real pick: guests see NO picks, same as the server
// enforces) -> 8 account (signup/login + Apple/Google) -> 9 soft trial paywall.
//
// Gating rules:
//   - never shown when the current user is paying
//   - logged-in non-paying users arriving via ?onboard=1 start at step 9
//   - ca_onboarded=1 is set on finish OR skip
//   - the age gate stores ca_age_ok=1 and is skipped on later native runs
//     (?onboard=1 always shows the full flow so the lab can preview step 1)

import { state } from './state.js';
import { isPaying, checkAuth } from './auth.js';
import { startCheckout, resumePendingCheckout } from './paywall.js';
import * as native from './native.js?v=1';

// ── Local storage (safe wrappers; private browsing can throw) ─────────────────
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} },
};

let _host = null;        // overlay root element
let _stage = null;       // step container
let _cur = 0;            // current step number
let _dobYear = null;     // birth year captured at the age gate (feeds signup)
let _authHappened = false; // signup/login happened mid-flow -> reload on finish
let _busy = false;       // guards double-taps during the 240ms glide

const REDUCED = (() => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (_) { return false; }
})();

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Entry: called once from app.js boot, after checkAuth() ────────────────────
export function maybeStartOnboarding() {
  let force = false;
  try { force = new URLSearchParams(location.search).get('onboard') === '1'; } catch (_) {}
  const nativeFirstRun = native.isNative() && LS.get('ca_onboarded') !== '1';
  if (!force && !nativeFirstRun) return;
  if (isPaying()) return; // a paying member never sees this flow

  let startAt;
  if (state.currentUser) startAt = 9;                          // logged-in, not paying
  else if (LS.get('ca_age_ok') === '1' && !force) startAt = 2; // age already verified on this device
  else startAt = 1;

  openOverlay();
  goTo(startAt, 'fwd', true);
}

// ── Overlay shell ─────────────────────────────────────────────────────────────
function openOverlay() {
  if (_host) return;
  window.__caOnboardActive = true;
  _host = document.createElement('div');
  _host.className = 'ob-overlay';
  _host.id = 'ca-onboard';
  _host.innerHTML = `
    <div class="ob-top">
      <div class="ob-brand">Capping<b>Alpha</b></div>
      <button type="button" class="ob-skip" id="ob-skip" style="display:none;">Skip</button>
    </div>
    <div class="ob-stage" id="ob-stage"></div>`;
  document.body.appendChild(_host);
  document.documentElement.classList.add('ob-lock');
  _stage = _host.querySelector('#ob-stage');
  _host.querySelector('#ob-skip').addEventListener('click', finish);
}

function setSkipVisible(on) {
  const b = _host && _host.querySelector('#ob-skip');
  if (b) b.style.display = on ? '' : 'none';
}

function finish() {
  LS.set('ca_onboarded', '1');
  window.__caOnboardActive = false;
  // Drop ?onboard=1 from the URL so a reload does not re-open the flow.
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('onboard')) {
      u.searchParams.delete('onboard');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    }
  } catch (_) {}
  if (_host) { _host.remove(); _host = null; _stage = null; }
  document.documentElement.classList.remove('ob-lock');
  // An account was created or signed in mid-flow: reboot the app so every
  // surface renders for the logged-in tier instead of the guest view.
  if (_authHappened) location.reload();
}

// 7f: the native checkout-return path (app.js handleCheckoutReturn) completes an
// open onboarding flow once the tier flips to paying. A window hook rather than
// an export so app.js does not need a second import of this module's internals;
// callers gate on window.__caOnboardActive first.
window.__caOnboardComplete = finish;

// ── Step navigation: the Onboard Glide ────────────────────────────────────────
// Steps 2-5 are one carousel screen, so the stage steps are 1, C, 6, 7, 8, 9.
const RENDER = {
  1: renderAgeGate,
  2: renderCarousel,
  6: renderNotifAsk,
  7: renderValueTease,
  8: renderAccount,
  9: renderPaywall,
};

function goTo(n, dir = 'fwd', instant = false) {
  if (!_stage || _busy) return;
  if (n >= 2 && n <= 5) n = 2;
  const render = RENDER[n];
  if (!render) return;
  _cur = n;
  setSkipVisible(n >= 2 && n <= 8);

  const old = _stage.firstElementChild;
  const el = document.createElement('div');
  el.className = 'ob-step';
  render(el);
  _stage.appendChild(el);
  el.scrollTop = 0;

  if (instant || REDUCED || !old) {
    if (old) old.remove();
    return;
  }
  _busy = true;
  el.classList.add(dir === 'fwd' ? 'ob-in-right' : 'ob-in-left');
  // Force a layout so the entering transform is painted before it animates off.
  void el.offsetWidth;
  el.classList.remove('ob-in-right', 'ob-in-left');
  old.classList.add(dir === 'fwd' ? 'ob-out-left' : 'ob-out-right');
  setTimeout(() => { old.remove(); _busy = false; }, 260);
}

// ══ Step 1: age gate ══════════════════════════════════════════════════════════
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function renderAgeGate(el) {
  const nowYear = new Date().getFullYear();
  let yearOpts = '';
  for (let y = nowYear; y >= nowYear - 100; y--) yearOpts += `<option value="${y}">${y}</option>`;
  let dayOpts = '';
  for (let d = 1; d <= 31; d++) dayOpts += `<option value="${d}">${d}</option>`;
  el.innerHTML = `
    <div class="ob-pad">
      <div class="ob-icon"><i class="fa-solid fa-cake-candles" aria-hidden="true"></i></div>
      <h1 class="ob-h1">First, your date of birth</h1>
      <p class="ob-body">CappingAlpha is for adults. You must be 18 or older to use the app.</p>
      <div class="ob-dob-row">
        <label class="ob-dob-field"><span>Month</span>
          <select id="ob-dob-m">${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}</select>
        </label>
        <label class="ob-dob-field ob-dob-day"><span>Day</span>
          <select id="ob-dob-d">${dayOpts}</select>
        </label>
        <label class="ob-dob-field"><span>Year</span>
          <select id="ob-dob-y"><option value="">Year</option>${yearOpts}</select>
        </label>
      </div>
      <div class="ob-err" id="ob-age-err"></div>
      <button type="button" class="ob-btn ob-btn-gold" id="ob-age-go">Continue</button>
      <p class="ob-fine">If you or someone you know has a gambling problem, help is available. Call 1-800-GAMBLER.</p>
    </div>`;
  el.querySelector('#ob-age-go').addEventListener('click', () => {
    const m = parseInt(el.querySelector('#ob-dob-m').value, 10);
    const d = parseInt(el.querySelector('#ob-dob-d').value, 10);
    const y = parseInt(el.querySelector('#ob-dob-y').value, 10);
    const err = el.querySelector('#ob-age-err');
    err.textContent = '';
    if (!Number.isInteger(y)) { err.textContent = 'Please pick your year of birth.'; return; }
    // Reject dates that do not exist (February 31 etc).
    const dob = new Date(y, m - 1, d);
    if (dob.getFullYear() !== y || dob.getMonth() !== m - 1 || dob.getDate() !== d) {
      err.textContent = 'That date does not exist. Please check it.'; return;
    }
    const now = new Date();
    let age = now.getFullYear() - y;
    const beforeBday = (now.getMonth() < dob.getMonth()) ||
      (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate());
    if (beforeBday) age -= 1;
    if (age < 18) { renderUnderage(); return; }
    _dobYear = y;
    LS.set('ca_age_ok', '1');
    goTo(2, 'fwd');
  });
}

function renderUnderage() {
  if (!_stage) return;
  setSkipVisible(false);
  const el = document.createElement('div');
  el.className = 'ob-step';
  el.innerHTML = `
    <div class="ob-pad ob-center">
      <div class="ob-icon ob-icon-muted"><i class="fa-solid fa-hand" aria-hidden="true"></i></div>
      <h1 class="ob-h1">Sorry, not yet</h1>
      <p class="ob-body">CappingAlpha is only for adults 18 and older. We take that seriously, so this is where the road ends for now.</p>
      <p class="ob-fine">Please gamble responsibly. If you or someone you know has a gambling problem, help is available. Call 1-800-GAMBLER.</p>
      <button type="button" class="ob-link" id="ob-age-back">Entered the wrong date? Go back</button>
    </div>`;
  const old = _stage.firstElementChild;
  _stage.appendChild(el);
  if (old) old.remove();
  el.querySelector('#ob-age-back').addEventListener('click', () => goTo(1, 'back', true));
}

// ══ Steps 2-5: carousel ═══════════════════════════════════════════════════════
const SLIDES = [
  {
    icon: 'fa-solid fa-ranking-star',
    title: 'Every major sport, one board',
    body: 'CappingAlpha is a sports data platform that ranks the sharpest picks of the day across MLB, NBA, NFL, NHL, tennis, soccer, golf, and more.',
  },
  {
    icon: 'fa-solid fa-gauge-high',
    title: 'Ranked, not guessed',
    body: 'Our proprietary scoring engine grades every play and surfaces the ones that tend to matter most. No hot takes, just the data.',
  },
  {
    icon: 'fa-solid fa-chart-line',
    title: 'Track it, share it',
    body: 'Track your bets, follow friends, and watch your live P/L move as the games play out.',
  },
  {
    icon: 'fa-solid fa-unlock',
    title: 'Free and paid, honestly',
    body: 'A free account gets the #1 ranked pick every day. A paid pass opens the full top 50 board. No pressure either way.',
  },
];

function renderCarousel(el) {
  let idx = 0;
  el.innerHTML = `
    <div class="ob-car-vp" id="ob-car-vp">
      <div class="ob-car-track" id="ob-car-track">
        ${SLIDES.map(s => `
          <div class="ob-slide">
            <div class="ob-icon"><i class="${s.icon}" aria-hidden="true"></i></div>
            <h1 class="ob-h1">${s.title}</h1>
            <p class="ob-body">${s.body}</p>
          </div>`).join('')}
      </div>
    </div>
    <div class="ob-dots" id="ob-dots">
      ${SLIDES.map((_, i) => `<button type="button" class="ob-dot${i === 0 ? ' active' : ''}" data-i="${i}" aria-label="Slide ${i + 1}"></button>`).join('')}
    </div>
    <div class="ob-nav">
      <button type="button" class="ob-btn ob-btn-ghost" id="ob-car-back" style="visibility:hidden;">Back</button>
      <button type="button" class="ob-btn ob-btn-gold" id="ob-car-next">Next</button>
    </div>`;

  const track = el.querySelector('#ob-car-track');
  const dots = el.querySelectorAll('.ob-dot');
  const backBtn = el.querySelector('#ob-car-back');
  const nextBtn = el.querySelector('#ob-car-next');

  function show(i) {
    idx = Math.max(0, Math.min(SLIDES.length - 1, i));
    track.style.transform = `translateX(-${idx * 100}%)`;
    dots.forEach((d, j) => d.classList.toggle('active', j === idx));
    backBtn.style.visibility = idx === 0 ? 'hidden' : '';
    nextBtn.textContent = idx === SLIDES.length - 1 ? 'Continue' : 'Next';
  }
  backBtn.addEventListener('click', () => show(idx - 1));
  nextBtn.addEventListener('click', () => {
    if (idx === SLIDES.length - 1) goTo(6, 'fwd');
    else show(idx + 1);
  });
  dots.forEach(d => d.addEventListener('click', () => show(parseInt(d.dataset.i, 10))));

  // Swipe: horizontal drags flip slides; mostly-vertical moves are left alone.
  const vp = el.querySelector('#ob-car-vp');
  let sx = 0, sy = 0, swiping = false;
  vp.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; swiping = true;
  }, { passive: true });
  vp.addEventListener('touchend', (e) => {
    if (!swiping) return;
    swiping = false;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    show(idx + (dx < 0 ? 1 : -1));
  }, { passive: true });
}

// ══ Step 6: notification soft-ask ═════════════════════════════════════════════
function renderNotifAsk(el) {
  el.innerHTML = `
    <div class="ob-pad ob-center">
      <div class="ob-icon"><i class="fa-solid fa-bell" aria-hidden="true"></i></div>
      <h1 class="ob-h1">Know the moment it matters</h1>
      <p class="ob-body">A graded result lands. A game you follow goes live. The day's #1 pick posts. Alerts cover the moments worth knowing about, and nothing else.</p>
      <button type="button" class="ob-btn ob-btn-gold ob-btn-block" id="ob-notif-yes">Turn on alerts</button>
      <button type="button" class="ob-btn ob-btn-ghost ob-btn-block" id="ob-notif-later">Maybe later</button>
      <p class="ob-fine">You can change this anytime in Settings.</p>
    </div>`;
  el.querySelector('#ob-notif-yes').addEventListener('click', async () => {
    LS.set('ca_notif_choice', 'on');
    try {
      if (native.isNative()) {
        // Phase 7e adds the native permission hook; feature-detect so this step
        // ships now and lights up when the hook lands.
        if (typeof native.requestPushPermission === 'function') await native.requestPushPermission();
      } else if (state.currentUser) {
        await webPushSubscribe();
      }
    } catch (_) {}
    goTo(7, 'fwd');
  });
  el.querySelector('#ob-notif-later').addEventListener('click', () => {
    LS.set('ca_notif_choice', 'later');
    goTo(7, 'fwd');
  });
}

// Subscribe-only web push path (mirrors the Settings toggle in account.js, minus
// the unsubscribe half; the choice was already recorded for logged-out users).
function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function webPushSubscribe() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return;
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise(resolve => setTimeout(() => resolve(null), 1500)),
  ]);
  if (!reg) return;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return; // this device is already on
  const keyRes = await fetch('/api/push/key');
  if (!keyRes.ok) return;
  const { key } = await keyRes.json();
  const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
  const save = await fetch('/api/push/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s.toJSON()),
  });
  if (!save.ok) await s.unsubscribe().catch(() => {});
}

// ══ Step 7: value tease — the home board with the locked #1 teaser ════════════
// Guests see NO pick content anywhere (the server enforces the same rule), so
// this renders the exact locked card the website shows logged-out visitors:
// blurred placeholder pick + the lock overlay. Real public numbers (the
// rankings record from /api/mvp/public) sit underneath.
function renderValueTease(el) {
  el.innerHTML = `
    <div class="ob-pad">
      <h1 class="ob-h1">Today's board is live</h1>
      <p class="ob-body">Here is where the day's #1 ranked play sits. It unlocks with a free account.</p>
      <div class="ca-top-pick-card ob-tease-card">
        <div class="ca-tp-brand">
          <span class="ca-tp-logo-fallback" style="display:flex;">CA</span>
          <div class="ca-tp-title"><span class="ca-tp-title-rank">#1</span> <span class="ca-tp-title-pick">Ranked</span></div>
        </div>
        <div style="position:relative;">
          <div style="filter:blur(7px);opacity:0.7;user-select:none;pointer-events:none;" aria-hidden="true">
            <div class="ca-tp-matchup">New York @ Boston</div>
            <div class="ca-tp-team-row"><span class="ca-tp-team">Yankees Win</span></div>
            <div class="ca-tp-live-line"><span class="ca-tp-live-dot"></span><span class="ca-tp-live-score">2-0</span><span class="bb-half">Bot 4th</span></div>
            <div class="ca-tp-sub"><span class="ca-tp-pts">65 pts</span> &middot; MLB</div>
          </div>
          <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:86%;background:var(--surface);border:1px solid var(--border);border-radius:9px;box-shadow:0 10px 26px rgba(0,0,0,0.55);padding:9px 10px 8px;text-align:center;">
            <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:7px;line-height:1.3;">See today's #1 ranked play</div>
            <button type="button" class="ca-tp-login-btn" id="ob-tease-login">
              <span class="ucb-lock">&#128274;</span><span class="ucb-open">&#128275;</span>Log in to see it
            </button>
            <div style="margin-top:6px;font-size:10px;color:var(--muted);">No account? <a class="ca-tp-signup-link" id="ob-tease-signup">Sign up free</a></div>
          </div>
        </div>
        <div class="ob-tease-record" id="ob-tease-record"></div>
      </div>
      <button type="button" class="ob-btn ob-btn-gold ob-btn-block" id="ob-tease-cta">Create your free account</button>
    </div>`;
  el.querySelector('#ob-tease-cta').addEventListener('click', () => goTo(8, 'fwd'));
  el.querySelector('#ob-tease-signup').addEventListener('click', () => goTo(8, 'fwd'));
  el.querySelector('#ob-tease-login').addEventListener('click', () => { _accountMode = 'login'; goTo(8, 'fwd'); });

  // Real public record under the teaser, same feed the logged-out website uses.
  fetch('/api/mvp/public').then(r => r.ok ? r.json() : null).then(data => {
    const slot = el.querySelector('#ob-tease-record');
    if (!slot || !data || !data.record) return;
    const rec = data.record;
    if ((rec.wins || 0) + (rec.losses || 0) < 5) return; // too thin to headline
    slot.innerHTML = `
      <div class="ca-tp-record" style="margin-top:10px;">
        <div><b class="green">${Number(rec.wins) || 0}</b><span>Wins</span></div>
        <div><b class="red">${Number(rec.losses) || 0}</b><span>Losses</span></div>
        <div><b class="gold">${esc(rec.win_rate || '0%')}</b><span>Win%</span></div>
      </div>
      <div class="ob-fine" style="margin-top:6px;text-align:center;">Every graded #1 pick, wins and losses alike. Past results never promise future ones.</div>`;
  }).catch(() => {});
}

// ══ Step 8: account (signup / login + Apple / Google) ═════════════════════════
let _accountMode = 'signup'; // 'signup' | 'login' — the tease's Log in link flips it
let _availTimer = null;
let _availSeq = 0;

function renderAccount(el) {
  const mode = _accountMode;
  _accountMode = 'signup'; // one-shot override
  const appleBtn = native.isNative()
    ? `<button type="button" class="ob-btn ob-social ob-apple" id="ob-apple"><i class="fa-brands fa-apple" aria-hidden="true"></i> Continue with Apple</button>`
    : '';
  const needYear = !_dobYear;
  el.innerHTML = `
    <div class="ob-pad">
      <h1 class="ob-h1" id="ob-acct-title">${mode === 'login' ? 'Welcome back' : 'Create your free account'}</h1>
      <p class="ob-body" id="ob-acct-sub">${mode === 'login' ? 'Log in to pick up where you left off.' : 'Your username is how friends find you on the leaderboard.'}</p>
      <div class="ob-err" id="ob-acct-err"></div>
      ${appleBtn}
      <button type="button" class="ob-btn ob-social" id="ob-google"><span class="ob-g">G</span> Continue with Google</button>
      <div class="ob-or"><span>or</span></div>

      <div id="ob-form-signup" style="display:${mode === 'login' ? 'none' : ''};">
        <label class="ob-field"><span>Email</span><input type="email" id="ob-su-email" autocomplete="email" /></label>
        <label class="ob-field"><span>Username</span>
          <div class="ob-uname-wrap">
            <input type="text" id="ob-su-uname" autocomplete="username" maxlength="20" placeholder="e.g. sharpbettor99" />
            <span class="ob-uname-mark" id="ob-uname-mark"></span>
          </div>
        </label>
        <div class="ob-uname-note" id="ob-uname-note">3 to 20 characters. Letters, numbers, and underscores.</div>
        <label class="ob-field"><span>Password</span><input type="password" id="ob-su-pass" autocomplete="new-password" /></label>
        <label class="ob-field"><span>Confirm password</span><input type="password" id="ob-su-conf" autocomplete="new-password" /></label>
        ${needYear ? `<label class="ob-field"><span>Year of birth</span><input type="number" id="ob-su-year" inputmode="numeric" placeholder="YYYY" min="1900" max="${new Date().getFullYear()}" /></label>` : ''}
        <label class="ob-tos">
          <input type="checkbox" id="ob-su-tos" />
          <span>I am 18 or older and agree to the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a></span>
        </label>
        <button type="button" class="ob-btn ob-btn-gold ob-btn-block" id="ob-su-go">Create Account</button>
        <div class="ob-fine" style="text-align:center;">Already have an account? <button type="button" class="ob-link" id="ob-to-login">Log in</button></div>
      </div>

      <div id="ob-form-login" style="display:${mode === 'login' ? '' : 'none'};">
        <label class="ob-field"><span>Email or username</span><input type="text" id="ob-li-email" autocomplete="username" /></label>
        <label class="ob-field"><span>Password</span><input type="password" id="ob-li-pass" autocomplete="current-password" /></label>
        <button type="button" class="ob-btn ob-btn-gold ob-btn-block" id="ob-li-go">Log In</button>
        <div class="ob-fine" style="text-align:center;">New here? <button type="button" class="ob-link" id="ob-to-signup">Create a free account</button></div>
      </div>
    </div>`;

  const err = el.querySelector('#ob-acct-err');
  const showErr = (m) => { err.textContent = m || ''; };

  // Mode flips
  el.querySelector('#ob-to-login').addEventListener('click', () => setAcctMode(el, 'login'));
  el.querySelector('#ob-to-signup').addEventListener('click', () => setAcctMode(el, 'signup'));

  // Live username availability (400ms debounce; green check / red taken + variants)
  const uInput = el.querySelector('#ob-su-uname');
  uInput.addEventListener('input', () => {
    clearTimeout(_availTimer);
    const mark = el.querySelector('#ob-uname-mark');
    const note = el.querySelector('#ob-uname-note');
    mark.textContent = ''; mark.className = 'ob-uname-mark';
    const u = uInput.value.trim();
    if (!u) { note.textContent = '3 to 20 characters. Letters, numbers, and underscores.'; note.className = 'ob-uname-note'; return; }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(u)) {
      note.textContent = '3 to 20 characters. Letters, numbers, and underscores.';
      note.className = 'ob-uname-note bad';
      return;
    }
    note.textContent = 'Checking...'; note.className = 'ob-uname-note';
    _availTimer = setTimeout(() => checkUsername(el, u), 400);
  });

  // Submit: signup
  el.querySelector('#ob-su-go').addEventListener('click', () => submitSignup(el, showErr));
  // Submit: login
  el.querySelector('#ob-li-go').addEventListener('click', () => submitLogin(el, showErr));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (el.querySelector('#ob-form-login').style.display !== 'none') submitLogin(el, showErr);
    else submitSignup(el, showErr);
  });

  // Social: both providers route through the consent explainer first (a new
  // account is gated server-side on 18+ and ToS consent either way).
  el.querySelector('#ob-google').addEventListener('click', () => renderConsent('google'));
  const ab = el.querySelector('#ob-apple');
  if (ab) ab.addEventListener('click', () => renderConsent('apple'));
}

function setAcctMode(el, mode) {
  el.querySelector('#ob-form-signup').style.display = mode === 'signup' ? '' : 'none';
  el.querySelector('#ob-form-login').style.display = mode === 'login' ? '' : 'none';
  el.querySelector('#ob-acct-title').textContent = mode === 'login' ? 'Welcome back' : 'Create your free account';
  el.querySelector('#ob-acct-sub').textContent = mode === 'login'
    ? 'Log in to pick up where you left off.'
    : 'Your username is how friends find you on the leaderboard.';
  el.querySelector('#ob-acct-err').textContent = '';
}

async function checkUsername(el, u) {
  const seq = ++_availSeq;
  const mark = el.querySelector('#ob-uname-mark');
  const note = el.querySelector('#ob-uname-note');
  const q = async (name) => {
    const r = await fetch('/api/username-available?u=' + encodeURIComponent(name));
    if (!r.ok) throw new Error('check failed');
    return (await r.json()).available === true;
  };
  try {
    const free = await q(u);
    if (seq !== _availSeq || !mark || !note || !document.body.contains(note)) return;
    if (free) {
      mark.textContent = '✓'; mark.className = 'ob-uname-mark ok';
      note.textContent = 'Available'; note.className = 'ob-uname-note ok';
      return;
    }
    mark.textContent = '✕'; mark.className = 'ob-uname-mark bad';
    note.textContent = 'That one is taken.'; note.className = 'ob-uname-note bad';
    // Two suggested variants, each verified available before it is offered.
    const cands = [u.slice(0, 19) + '2', u.slice(0, 17) + '_ca'];
    const goods = [];
    for (const c of cands) {
      try { if (await q(c)) goods.push(c); } catch (_) {}
    }
    if (seq !== _availSeq || !goods.length || !document.body.contains(note)) return;
    note.innerHTML = 'That one is taken. Try ' +
      goods.map(g => `<button type="button" class="ob-link ob-uname-sug" data-u="${esc(g)}">${esc(g)}</button>`).join(' or ');
    note.querySelectorAll('.ob-uname-sug').forEach(b => b.addEventListener('click', () => {
      const inp = el.querySelector('#ob-su-uname');
      inp.value = b.dataset.u;
      inp.dispatchEvent(new Event('input'));
    }));
  } catch (_) {
    if (seq !== _availSeq || !note) return;
    note.textContent = 'Could not check right now.'; note.className = 'ob-uname-note';
  }
}

function appBody(body) {
  return native.isNative() ? { ...body, client: 'app' } : body;
}
async function storeTokenIfApp(data) {
  if (native.isNative() && data && data.token) { try { await native.setToken(data.token); } catch (_) {} }
}

// After any successful signup or login inside the flow: refresh auth state,
// redeem a stashed referral code (signup only, like the web), then either resume
// a plan chosen on the paywall step, complete (paying account), or move to the
// trial step.
async function afterAuth({ redeemRef } = {}) {
  _authHappened = true;
  if (redeemRef) {
    const ref = LS.get('ca_ref');
    if (ref) {
      LS.del('ca_ref');
      await fetch('/auth/redeem-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ref }),
      }).catch(() => {});
    }
  }
  await checkAuth();
  let pending = null;
  try { pending = sessionStorage.getItem('pendingPlan'); } catch (_) {}
  if (pending && !isPaying()) {
    // They picked a plan on the paywall step before having an account: finish
    // onboarding state and head straight into checkout.
    LS.set('ca_onboarded', '1');
    await resumePendingCheckout();
    return;
  }
  if (isPaying()) finish();
  else goTo(9, 'fwd');
}

async function submitSignup(el, showErr) {
  showErr('');
  const email = (el.querySelector('#ob-su-email')?.value || '').trim();
  const username = (el.querySelector('#ob-su-uname')?.value || '').trim();
  const password = el.querySelector('#ob-su-pass')?.value || '';
  const confirm = el.querySelector('#ob-su-conf')?.value || '';
  const tos = !!el.querySelector('#ob-su-tos')?.checked;
  const yearEl = el.querySelector('#ob-su-year');
  const birthYear = _dobYear || parseInt(yearEl?.value, 10);
  const nowYear = new Date().getFullYear();
  if (!username) { showErr('Username is required.'); return; }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) { showErr('Username must be 3 to 20 characters: letters, numbers, underscores only.'); return; }
  if (!email || !password) { showErr('Email and password required.'); return; }
  if (password !== confirm) { showErr('Passwords do not match.'); return; }
  if (password.length < 8) { showErr('Password must be at least 8 characters.'); return; }
  if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > nowYear) { showErr('Enter your year of birth.'); return; }
  if (nowYear - birthYear < 18) { showErr('You must be 18 or older to use CappingAlpha.'); return; }
  if (!tos) { showErr('Please check the box to agree to the Terms of Service.'); return; }
  const btn = el.querySelector('#ob-su-go');
  btn.disabled = true;
  try {
    const res = await fetch('/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(appBody({ email, password, username, tos_agreed: true, birth_year: birthYear })),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showErr(data.error || 'Signup failed.'); btn.disabled = false; return; }
    await storeTokenIfApp(data);
    await afterAuth({ redeemRef: true });
  } catch (_) { showErr('Network error. Try again.'); btn.disabled = false; }
}

async function submitLogin(el, showErr) {
  showErr('');
  const email = (el.querySelector('#ob-li-email')?.value || '').trim();
  const password = el.querySelector('#ob-li-pass')?.value || '';
  if (!email || !password) { showErr('Email and password required.'); return; }
  const btn = el.querySelector('#ob-li-go');
  btn.disabled = true;
  try {
    const res = await fetch('/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(appBody({ email, password })),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showErr(data.error || 'Login failed.'); btn.disabled = false; return; }
    await storeTokenIfApp(data);
    await afterAuth({});
  } catch (_) { showErr('Network error. Try again.'); btn.disabled = false; }
}

// ── Provider consent explainer (the Phase 6 leftover, carousel-styled) ────────
// Shown BEFORE any OAuth runs: a clean card saying exactly what is shared, with
// Continue / Cancel. Doubles as the 18+ / ToS clickwrap the server requires for
// brand-new provider accounts, so the 428 consent gate never fires mid-sheet.
function renderConsent(provider) {
  if (!_stage) return;
  const isGoogle = provider === 'google';
  const el = document.createElement('div');
  el.className = 'ob-step';
  const needYear = !_dobYear;
  el.innerHTML = `
    <div class="ob-pad ob-center">
      <div class="ob-icon">${isGoogle ? '<span class="ob-g ob-g-big">G</span>' : '<i class="fa-brands fa-apple" aria-hidden="true"></i>'}</div>
      <h1 class="ob-h1">Continue with ${isGoogle ? 'Google' : 'Apple'}</h1>
      <p class="ob-body">${isGoogle
        ? 'Google will share your name, email address, and profile picture with CappingAlpha to create or sign in to your account. Nothing is posted anywhere on your behalf.'
        : 'Apple will share your name and email address (or a private relay address you control) with CappingAlpha to create or sign in to your account. Nothing is posted anywhere on your behalf.'}</p>
      ${needYear ? `<label class="ob-field" style="text-align:left;"><span>Year of birth</span><input type="number" id="ob-cs-year" inputmode="numeric" placeholder="YYYY" min="1900" max="${new Date().getFullYear()}" /></label>` : ''}
      <p class="ob-fine">By continuing you confirm you are 18 or older and agree to the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>
      <div class="ob-err" id="ob-cs-err"></div>
      <button type="button" class="ob-btn ob-btn-gold ob-btn-block" id="ob-cs-go">Continue</button>
      <button type="button" class="ob-btn ob-btn-ghost ob-btn-block" id="ob-cs-cancel">Cancel</button>
    </div>`;
  const old = _stage.firstElementChild;
  _stage.appendChild(el);
  if (old) {
    if (REDUCED) old.remove();
    else {
      el.classList.add('ob-in-right');
      void el.offsetWidth;
      el.classList.remove('ob-in-right');
      old.classList.add('ob-out-left');
      setTimeout(() => old.remove(), 260);
    }
  }
  const err = el.querySelector('#ob-cs-err');
  el.querySelector('#ob-cs-cancel').addEventListener('click', () => goTo(8, 'back'));
  el.querySelector('#ob-cs-go').addEventListener('click', async () => {
    err.textContent = '';
    const nowYear = new Date().getFullYear();
    const year = _dobYear || parseInt(el.querySelector('#ob-cs-year')?.value, 10);
    if (!Number.isInteger(year) || year < 1900 || year > nowYear) { err.textContent = 'Enter your year of birth.'; return; }
    if (nowYear - year < 18) { err.textContent = 'You must be 18 or older to use CappingAlpha.'; return; }
    const btn = el.querySelector('#ob-cs-go');
    btn.disabled = true;
    try {
      if (isGoogle) await googleGo(year, err);
      else await appleGo(year, err);
    } finally { btn.disabled = false; }
  });
}

// Google Identity Services loader (same #gis-script node modules/auth.js uses,
// so the script never loads twice).
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
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
}

async function googleGo(birthYear, errEl) {
  const clientId = state.CONFIG?.google_client_id;
  if (!clientId) { errEl.textContent = 'Google sign-in is coming soon. Use email for now.'; return; }
  try {
    await loadGis();
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'openid email profile',
      callback: async (resp) => {
        if (resp.error || !resp.access_token) { errEl.textContent = 'Google sign-in was cancelled.'; return; }
        try {
          const r = await fetch('/auth/google', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(appBody({ access_token: resp.access_token, tos_agreed: true, birth_year: birthYear })),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) { errEl.textContent = data.error || 'Google sign-in failed.'; return; }
          await storeTokenIfApp(data);
          await afterAuth({});
        } catch (_) { errEl.textContent = 'Network error. Try again.'; }
      },
    });
    tokenClient.requestAccessToken();
  } catch (_) { errEl.textContent = 'Could not reach Google. Try again.'; }
}

async function appleGo(birthYear, errEl) {
  let cred = null;
  try { cred = await native.appleSignIn(); } catch (_) {}
  if (!cred || !cred.identity_token) { errEl.textContent = 'Apple sign-in was cancelled.'; return; }
  try {
    const r = await fetch('/auth/apple', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity_token: cred.identity_token, user: cred.user || null,
        tos_agreed: true, birth_year: birthYear, client: 'app',
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { errEl.textContent = data.error || 'Apple sign-in failed.'; return; }
    await storeTokenIfApp(data);
    await afterAuth({});
  } catch (_) { errEl.textContent = 'Network error. Try again.'; }
}

// ══ Step 9: soft trial paywall ════════════════════════════════════════════════
function renderPaywall(el) {
  el.innerHTML = `
    <div class="ob-pad ob-center">
      <div class="ob-eyebrow">CA RANKINGS</div>
      <h1 class="ob-h1">Try CA Rankings free for 3 days, then $4/week</h1>
      <p class="ob-body">The full ranked board, top to bottom, plus paid alerts. Cancel any time during the trial and you pay nothing.</p>
      <button type="button" class="ob-btn ob-btn-gold ob-btn-block" id="ob-pay-week">Start 3 days free</button>
      <div class="ob-plan-rows">
        <button type="button" class="ob-plan-row" id="ob-pay-year"><span>Annual</span><span class="ob-plan-price">$75/year <em>about $1.44/week</em></span></button>
        <button type="button" class="ob-plan-row" id="ob-pay-day"><span>Day pass</span><span class="ob-plan-price">$1</span></button>
      </div>
      <button type="button" class="ob-btn ob-btn-ghost ob-btn-block" id="ob-pay-later">Not now, keep the free #1 pick</button>
      <p class="ob-fine">Checkout is handled securely by Stripe. The free #1 ranked pick stays yours either way.</p>
    </div>`;
  const choose = (plan) => {
    LS.set('ca_onboarded', '1');
    if (!state.currentUser) {
      // No account yet (they skipped step 8): remember the plan, collect the
      // account, and checkout resumes automatically right after.
      try { sessionStorage.setItem('pendingPlan', plan); } catch (_) {}
      goTo(8, 'back');
      return;
    }
    startCheckout(plan);
  };
  el.querySelector('#ob-pay-week').addEventListener('click', () => choose('week'));
  el.querySelector('#ob-pay-year').addEventListener('click', () => choose('year'));
  el.querySelector('#ob-pay-day').addEventListener('click', () => choose('day'));
  el.querySelector('#ob-pay-later').addEventListener('click', finish);
}
