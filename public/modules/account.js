// modules/account.js — "My Tracking" + "Settings" views (split from the old My Account tab)

import { state } from './state.js';
import { sportBadge, matchupLabel, scoreDisplay, pickLabel, PICK_HEAT_COLOR, calcVoteReturn, avatarFor } from './utils.js?v=1';
import { doRedeemCode } from './paywall.js';
import { loadUserBets, setBetsData } from './track.js?v=42';
// Full sportsbook catalog + the "My sportsbooks" picker modal live in books.js.
import { bookLabel, openBookPicker } from './books.js?v=2';

const ALL_SPORTS = ['MLB', 'NBA', 'WNBA', 'NHL', 'NFL', 'NCAAF', 'CBB', 'ATP', 'WTA', 'Golf', 'Soccer'];

// Re-render the books-dependent views after the picker modal saves.
window.addEventListener('myBooksChanged', () => {
  if (document.getElementById('panel-settings')?.classList.contains('active')) loadSettings();
  if (document.getElementById('panel-tracking')?.classList.contains('active')) loadTracking();
  if (document.getElementById('panel-profile')?.classList.contains('active')) loadProfile();
});

// ── Loaders ───────────────────────────────────────────────────────────────────
export async function loadTracking() {
  const el = document.getElementById('tracking-content');
  if (!el) return;
  el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const [accountRes, friendsRes, betsRes] = await Promise.all([
      fetch('/api/account'),
      fetch('/api/friends'),
      fetch('/api/bets?limit=300'),
    ]);
    if (accountRes.status === 401) { window.switchTab('home'); window.openLogin(); return; }
    const data     = await accountRes.json();
    const friends  = friendsRes.ok ? (await friendsRes.json()).friends || [] : [];
    const betsData = betsRes.ok ? await betsRes.json() : {};
    renderTracking({ ...data, friends, bets: betsData.bets || [], betsTotal: betsData.total });
  } catch (err) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">⚠</div><h3>Failed to load tracking</h3><p>${err.message}</p></div>`;
  }
}

export async function loadSettings() {
  const el = document.getElementById('settings-content');
  if (!el) return;
  el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const [accountRes, picksRes] = await Promise.all([
      fetch('/api/account'),
      fetch('/api/picks'),
    ]);
    if (accountRes.status === 401) { window.switchTab('home'); window.openLogin(); return; }
    const data  = await accountRes.json();
    const picks = picksRes.ok ? await picksRes.json() : [];
    renderSettings({ ...data, allPicks: picks });
  } catch (err) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">⚠</div><h3>Failed to load settings</h3><p>${err.message}</p></div>`;
  }
}

// Back-compat alias: older callers / #account links route here.
export const loadAccount = loadTracking;

// ── Vote mutations ────────────────────────────────────────────────────────────
export async function deleteVote(espn_game_id, slot) {
  try {
    const res = await fetch(`/api/game/${espn_game_id}/vote`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot }),
    });
    if (res.status === 409) { window.showToast && window.showToast('Game has started, so this pick is locked.', 'err'); return; }
    if (!res.ok) return;
    loadTracking();
  } catch (_) {}
}

function voteSlotLabel(v) {
  return {
    home_ml:     `${(v.home_team||'').split(' ').pop()} ML`,
    away_ml:     `${(v.away_team||'').split(' ').pop()} ML`,
    home_spread: `${(v.home_team||'').split(' ').pop()} Spread`,
    away_spread: `${(v.away_team||'').split(' ').pop()} Spread`,
    over:        v.spread ? `Over ${v.spread}` : 'Over',
    under:       v.spread ? `Under ${v.spread}` : 'Under',
  }[v.pick_slot] || v.pick_slot;
}

// ── P/L graph (cumulative dollar return at the user's unit size) ───────────────
let votedChart = null;

export function drawVotedPlGraph(votes, unit = 20) {
  const canvas = document.getElementById('voted-pl-chart');
  const label  = document.getElementById('voted-pl-total');
  if (!canvas) return;

  const resolved = votes.filter(v =>
    v.result === 'win' || v.result === 'loss' || v.result === 'push'
  );

  if (resolved.length === 0) {
    if (label) { label.textContent = '$0.00'; label.className = 'graph-pl-label'; }
    if (votedChart) { votedChart.destroy(); votedChart = null; }
    return;
  }

  let cum = 0;
  const points = resolved.map(v => {
    const ret = calcVoteReturn(v, unit);
    cum = +(cum + ret).toFixed(2);
    return { label: voteSlotLabel(v), cumPL: cum, ret, result: v.result };
  });

  const totalPL = points[points.length - 1].cumPL;
  if (label) {
    label.textContent = (totalPL >= 0 ? '+' : '') + '$' + totalPL.toFixed(2);
    label.className   = 'graph-pl-label ' + (totalPL >= 0 ? 'pos' : 'neg');
  }

  // Theme-aware chart chrome (greys/grid flip with light/dark).
  const css       = getComputedStyle(document.documentElement);
  const tickColor = (css.getPropertyValue('--muted').trim()) || '#8892a4';
  const gridColor = (css.getPropertyValue('--grid-line').trim()) || 'rgba(255,255,255,0.05)';
  const lineColor = totalPL >= 0 ? '#4ade80' : '#f87171';
  if (votedChart) { votedChart.destroy(); votedChart = null; }

  votedChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: points.map((_, i) => `Pick ${i + 1}`),
      datasets: [{
        label: 'Cumulative P/L',
        data: points.map(p => p.cumPL),
        borderColor: lineColor,
        backgroundColor: lineColor + '18',
        borderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7,
        fill: true,
        tension: 0.2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => points[items[0].dataIndex]?.label || '',
            label: item => {
              const p = points[item.dataIndex];
              const sign = p.ret >= 0 ? '+' : '';
              return [`Cumulative: $${item.raw.toFixed(2)}`, `This pick: ${sign}$${p.ret.toFixed(2)}`];
            },
          },
        },
      },
      scales: {
        x: { display: false },
        y: {
          grid: { color: gridColor },
          ticks: { color: tickColor, callback: v => '$' + v },
        },
      },
    },
  });
}

// Tracking page: change the unit size locally (redraw) and persist it so it
// sticks across sessions and feeds future dollar/units math everywhere.
export async function saveUnitSize(val) {
  const unit = parseFloat(val) || 20;
  window._trackUnitSize = unit;
  // Re-render the strip, hot-streak/best-week, and graph for the new unit size.
  if (window.recomputeTrackStats) window.recomputeTrackStats();
  else drawVotedPlGraph(window._trackingVotes || [], unit);
  try {
    await fetch('/api/account/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit_size: unit }),
    });
  } catch (_) {}
}

// ── Settings mutations ────────────────────────────────────────────────────────
export function toggleFavSport(el) {
  el.classList.toggle('active');
}

export async function toggleAccountPrivacy(makePublic) {
  const msgEl = document.getElementById('lb-privacy-saved');
  try {
    const res = await fetch('/api/account/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_public: makePublic }),
    });
    if (res.ok) {
      if (msgEl) { msgEl.style.display = ''; setTimeout(() => { msgEl.style.display = 'none'; }, 1800); }
      loadSettings();
    }
  } catch (_) {}
}

export async function uploadAvatar(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const errEl = document.getElementById('avatar-error');
  if (errEl) errEl.textContent = '';
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
    if (errEl) errEl.textContent = 'Use a PNG, JPG, or WebP image.';
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    if (errEl) errEl.textContent = 'Image too large (max 2MB).';
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await fetch('/api/account/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: reader.result }),
      });
      const data = await res.json();
      if (!res.ok) { if (errEl) errEl.textContent = data.error || 'Upload failed.'; return; }
      loadSettings();
    } catch (_) { if (errEl) errEl.textContent = 'Upload failed. Try again.'; }
  };
  reader.readAsDataURL(file);
}

// Disable a Save button and show "Saving..." while its request is in flight, so a
// slow network can't collect double-taps that fire the request twice.
async function withSaving(btn, fn) {
  if (btn && btn.disabled) return;
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  try { await fn(); }
  finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}

export async function saveFavSports(btn) {
  const pills  = document.querySelectorAll('#fav-sport-pills .sport-pill');
  const sports = Array.from(pills).filter(p => p.classList.contains('active')).map(p => p.dataset.sport);
  const msgEl  = document.getElementById('fav-saved-msg');
  await withSaving(btn, async () => {
    try {
      const res = await fetch('/api/account/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite_sports: sports }),
      });
      if (res.ok) {
        if (msgEl) { msgEl.style.display = ''; setTimeout(() => { msgEl.style.display = 'none'; }, 2000); }
      }
    } catch (_) {}
  });
}

// Default odds source (Settings). Persists immediately on tap.
export async function saveDefaultOdds(v) {
  document.querySelectorAll('.odds-source').forEach(b => {
    const on = b.dataset.odds === v;
    b.classList.toggle('active', on);
    const chk = b.querySelector('.odds-check');
    if (chk) chk.textContent = on ? '✓' : '';
  });
  try {
    await fetch('/api/account/preferences', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_odds: v }),
    });
  } catch (_) {}
}

// Bankroll + unit size (Settings). Persists both at once.
export async function saveBankroll(btn) {
  const unitEl = document.getElementById('settings-unit-size');
  const brEl   = document.getElementById('settings-bankroll');
  const msgEl  = document.getElementById('bankroll-saved');
  const unit_size        = parseFloat(unitEl?.value) || 20;
  const starting_bankroll = parseFloat(brEl?.value)   || 0;
  await withSaving(btn, async () => {
    try {
      const res = await fetch('/api/account/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unit_size, starting_bankroll }),
      });
      if (res.ok) {
        window._trackUnitSize = unit_size; // keep the betslip default in sync right away
        if (msgEl) { msgEl.style.display = ''; setTimeout(() => { msgEl.style.display = 'none'; }, 1800); }
      }
    } catch (_) {}
  });
}

// ── Push notifications (Settings) — free web push, per device ─────────────────
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function currentPushSub() {
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch (_) { return null; }
}
export async function togglePush(btn) {
  if (!pushSupported()) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Working...'; }
  try {
    const sub = await currentPushSub();
    if (sub) {
      await fetch('/api/push/subscribe', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
      await sub.unsubscribe();
      window.showToast && window.showToast('Notifications turned off for this device.');
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        window.showToast && window.showToast('Notifications are blocked in your browser settings.', 'err');
        return;
      }
      const keyRes = await fetch('/api/push/key');
      if (!keyRes.ok) { window.showToast && window.showToast('Push is not available right now.', 'err'); return; }
      const { key } = await keyRes.json();
      const reg = await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
      const save = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s.toJSON()) });
      if (!save.ok) { await s.unsubscribe().catch(() => {}); window.showToast && window.showToast('Could not save this device. Try again.', 'err'); return; }
      window.showToast && window.showToast('Notifications are on for this device.');
    }
  } catch (_) {
    window.showToast && window.showToast('Could not change notifications. Try again.', 'err');
  } finally {
    refreshPushCard();
  }
}
async function refreshPushCard() {
  const el = document.getElementById('push-card-body');
  if (!el) return;
  if (!pushSupported()) {
    el.innerHTML = `<div style="font-size:13px;color:var(--muted);">This browser does not support notifications yet. On iPhone, add CappingAlpha to your Home Screen (Share, then Add to Home Screen), then open it from that icon and turn notifications on here in Settings.</div>`;
    return;
  }
  const sub = await currentPushSub();
  el.innerHTML = `
    <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">A ping when your tracked bets and verified picks grade. Per device, off by default.</div>
    <button class="sport-pill-save" onclick="togglePush(this)">${sub ? 'Turn off on this device' : 'Turn on notifications'}</button>
    ${sub ? `<div style="font-size:12px;color:var(--green);margin-top:8px;">On for this device.</div>` : ''}`;
}

// Password reset — sends a reset link to the account email (reuses the existing
// forgot-password flow; no password is entered here).
export async function sendPasswordReset(email) {
  const msgEl = document.getElementById('settings-pw-msg');
  const btn   = document.getElementById('settings-pw-btn');
  if (btn) btn.disabled = true;
  try {
    await fetch('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (msgEl) { msgEl.textContent = `Reset link sent to ${email}. Check your inbox.`; msgEl.style.display = ''; }
  } catch (_) {
    if (msgEl) { msgEl.textContent = 'Could not send right now. Please try again.'; msgEl.style.display = ''; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function changeUsername(btn) {
  const input  = document.getElementById('change-username-input');
  const errEl  = document.getElementById('change-username-error');
  const okEl   = document.getElementById('change-username-ok');
  const newName = (input?.value || '').trim();
  errEl.textContent = '';
  okEl.style.display = 'none';
  if (!newName) { errEl.textContent = 'Enter a username.'; return; }
  await withSaving(btn, async () => {
    try {
      const res  = await fetch('/auth/username', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: newName }),
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Failed to update.'; return; }
      okEl.style.display = '';
      okEl.textContent   = `Username updated to "${data.username}"`;
      setTimeout(() => loadSettings(), 1500);
    } catch (_) { errEl.textContent = 'Network error. Try again.'; }
  });
}

// ── Access status card (shown in Settings) ────────────────────────────────────
function accessStatusWidget(user) {
  const tier = user.subscription_tier;

  if (tier === 'paid') {
    const exp = user.subscription_expires ? new Date(user.subscription_expires) : null;
    const expStr = exp
      ? exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Active';
    return `
      <div class="access-status-card access-status-paid">
        <div class="access-status-icon">✓</div>
        <div>
          <div class="access-status-label">Active Subscription</div>
          <div class="access-status-val">Renews ${expStr}</div>
        </div>
      </div>`;
  }

  if (tier === 'code') {
    const expires = user.subscription_expires;
    if (!expires) {
      return `
        <div class="access-status-card access-status-code">
          <div class="access-status-icon">∞</div>
          <div>
            <div class="access-status-label">Lifetime Access</div>
            <div class="access-status-val" style="color:var(--gold);">∞ Never expires</div>
          </div>
        </div>`;
    }
    const expDate = new Date(expires);
    const msLeft  = expDate - Date.now();
    const hrs     = Math.max(0, Math.floor(msLeft / 3_600_000));
    const mins    = Math.max(0, Math.floor((msLeft % 3_600_000) / 60_000));
    const days    = Math.floor(hrs / 24);
    const isExpired = msLeft <= 0;
    const isUrgent  = !isExpired && hrs < 24;
    const timeStr   = isExpired ? 'Expired'
      : isUrgent ? `${hrs}h ${mins}m remaining`
      : `${days} day${days !== 1 ? 's' : ''} remaining`;
    const cls = isExpired || isUrgent ? ' urgent' : '';
    const expFmt = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `
      <div class="access-status-card access-status-code${cls}">
        <div class="access-status-icon">⏱</div>
        <div>
          <div class="access-status-label">Access Code Active</div>
          <div class="access-status-val">${timeStr}</div>
          <div class="access-status-expires">Expires ${expFmt}</div>
        </div>
      </div>`;
  }

  // Free user — show code entry form
  return `
    <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">Have a promo code? Enter it below to unlock access.</div>
    <div style="display:flex;gap:8px;">
      <input type="text" id="account-code-input" placeholder="Enter code" autocomplete="off"
             style="flex:1;font-size:13px;"
             onkeydown="if(event.key==='Enter')doRedeemCode('account-code-input','account-code-error')" />
      <button class="btn btn-gold" style="font-size:13px;padding:8px 14px;" onclick="doRedeemCode('account-code-input','account-code-error')">Redeem</button>
    </div>
    <div class="form-error" id="account-code-error" style="margin-top:8px;font-size:12px;"></div>`;
}

// ── My Tracking: unified personal stats (verified votes + custom bets) ────────
// This page is the user's PERSONAL view — it merges verified picks (votes) AND
// custom bets into one P/L. The leaderboard tab stays verified-only (votes), so
// custom bets never affect ranking. Verified votes count as a flat 1u at the
// user's unit size; custom bets carry their own real stake -> units.
let _trackRange = 'all'; // today | week | month | all

function tsOf(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).replace(' ', 'T') + 'Z');
  return isNaN(t) ? 0 : t;
}
function rangeStart(range) {
  const now = Date.now();
  if (range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (range === 'week')  return now - 7 * 864e5;
  if (range === 'month') return now - 30 * 864e5;
  return 0;
}
function etDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function votesInRange(votes, range) {
  const start = rangeStart(range);
  if (!start) return votes;
  return votes.filter(v => { const t = tsOf(v.voted_at); return t === 0 ? true : t >= start; });
}
// Closing Line Value: did you get a better price than where the line closed?
// Price CLV for ML + totals (you beat the close when your implied prob is lower).
function clvOf(votes) {
  const impl = o => (o < 0 ? (-o) / (-o + 100) : 100 / (o + 100));
  let good = 0, bad = 0, n = 0, sum = 0;
  const diffs = []; // per-pick CLV in "cents" of implied probability (x100)
  for (const v of (votes || [])) {
    const co = v.closing_odds;
    if (co == null) continue;
    const slot = v.pick_slot;
    let yours = null;
    if (slot === 'home_ml') yours = v.ml_home;
    else if (slot === 'away_ml') yours = v.ml_away;
    else if (slot === 'over') yours = v.ou_over_odds;
    else if (slot === 'under') yours = v.ou_under_odds;
    else continue; // spread (line CLV) skipped in the small version
    if (yours == null) continue;
    const d = impl(co) - impl(yours); // > 0 => you beat the close
    n++; sum += d; diffs.push(+(100 * d).toFixed(1));
    if (d > 0) good++; else if (d < 0) bad++;
  }
  return { n, good, bad, pct: n ? Math.round(100 * good / n) : null, avg: n ? +(100 * sum / n).toFixed(1) : null, diffs };
}
// The odds a vote was effectively taken at (the user's own number when they wagered,
// otherwise the CA slot odds; spreads carry the flat -110 convention).
function voteOddsOf(v) {
  if (v.user_odds != null) return v.user_odds;
  const slot = v.pick_slot;
  if (slot === 'home_ml') return v.ml_home ?? -110;
  if (slot === 'away_ml') return v.ml_away ?? -110;
  if (slot === 'over')    return v.ou_over_odds ?? -110;
  if (slot === 'under')   return v.ou_under_odds ?? -110;
  return -110;
}
// Units this item returns under FLAT 1u staking (the "discipline counterfactual").
function flatUnitsOf(it) {
  if (it.result === 'push') return 0;
  if (it.result === 'loss') return -1;
  const o = (it.odds == null || !isFinite(it.odds)) ? -110 : it.odds;
  return o < 0 ? 100 / Math.abs(o) : o / 100;
}
// One settled item: { units, dollars, riskedD, result, ts }.
function slotType(slot) {
  if (slot === 'home_ml' || slot === 'away_ml') return 'ML';
  if (slot === 'home_spread' || slot === 'away_spread') return 'Spread';
  if (slot === 'over' || slot === 'under') return 'Total';
  return 'Other';
}
function betType(bt) {
  return { ml: 'ML', spread: 'Spread', over: 'Total', under: 'Total', prop: 'Prop', parlay: 'Parlay', future: 'Future' }[bt] || 'Other';
}
// Profit on a winning bet at American odds (mirror of the server + betslip math).
function americanProfit(odds, stake) {
  const o = (odds == null || isNaN(parseFloat(odds))) ? -110 : parseFloat(odds);
  return o < 0 ? stake * (100 / Math.abs(o)) : stake * (o / 100);
}
// Display bits for the record drill-down list: what was picked + the game line.
function voteSelOf(v) {
  const nick = (t) => (t || '').split(' ').pop();
  const slot = v.pick_slot || '';
  const spr  = v.spread != null ? (v.spread > 0 ? '+' + v.spread : String(v.spread)) : '';
  if (slot === 'home_ml')     return `${nick(v.home_team)} ML`;
  if (slot === 'away_ml')     return `${nick(v.away_team)} ML`;
  if (slot === 'home_spread') return `${nick(v.home_team)} ${spr}`.trim();
  if (slot === 'away_spread') return `${nick(v.away_team)} ${spr}`.trim();
  if (slot === 'over')        return 'Over';
  if (slot === 'under')       return 'Under';
  return slot || 'Pick';
}
function voteSubOf(v) {
  const nick = (t) => (t || '').split(' ').pop();
  const t = v.start_time ? Date.parse(v.start_time) : tsOf(v.voted_at);
  const d = t ? new Date(t) : null;
  const ds = d ? `${d.getMonth() + 1}/${d.getDate()}` : '';
  const finalWord = v.status === 'post' ? 'Final' : '';
  if (v.home_score != null && v.away_score != null) {
    return `${nick(v.away_team)} ${v.away_score} - ${v.home_score} ${nick(v.home_team)}${finalWord || ds ? ` · ${[finalWord, ds].filter(Boolean).join(' ')}` : ''}`;
  }
  return `${nick(v.away_team)} @ ${nick(v.home_team)}${ds ? ' · ' + ds : ''}`;
}
function buildItems(votes, bets, unit) {
  const items = [];
  for (const v of (votes || [])) {
    const r = (v.result || '').toLowerCase();
    if (r === 'win' || r === 'loss' || r === 'push') {
      // A verified vote is a flat 1 unit at the CA line on the LEADERBOARD. On the user's
      // PRIVATE tracking we honor the actual risk + odds they entered on the betslip
      // (stored on the vote); quick-votes with no wager fall back to 1u at the CA line,
      // reproducing the prior behavior exactly.
      const hasWager = v.user_stake != null && v.user_stake > 0;
      const stakeD = hasWager ? v.user_stake : unit;      // dollars risked
      let dollars;
      if (r === 'push') dollars = 0;
      else if (r === 'loss') dollars = -stakeD;
      else dollars = (hasWager && v.user_odds != null) ? americanProfit(v.user_odds, stakeD) : calcVoteReturn(v, 1) * unit;
      items.push({ units: unit > 0 ? dollars / unit : 0, dollars: +dollars.toFixed(2), riskedD: stakeD, result: r, ts: tsOf(v.voted_at), sport: (v.sport || '').toUpperCase() || 'Other', type: slotType(v.pick_slot), odds: voteOddsOf(v),
                   verified: true, sel: voteSelOf(v), sub: voteSubOf(v), gameId: v.espn_game_id || null });
    }
  }
  for (const b of (bets || [])) {
    const r = (b.result || '').toLowerCase();
    // A free-bet loss counts in the record at $0 P/L (payout is already 0 server-side).
    // Hiding the loss entirely inflates the record — the win rate has to stay honest.
    if (r === 'win' || r === 'loss' || r === 'push') {
      const d = b.payout != null ? b.payout : 0;
      const bt = new Date(tsOf(b.settled_at || b.placed_at));
      items.push({ units: unit > 0 ? d / unit : 0, dollars: d, riskedD: b.stake || 0, result: r, ts: tsOf(b.settled_at || b.placed_at), sport: (b.sport || '').toUpperCase() || 'Other', type: betType(b.bet_type), odds: (b.odds != null && isFinite(b.odds)) ? b.odds : -110, book: b.book || null,
                   verified: false, sel: b.selection || betType(b.bet_type), sub: `${b.book ? b.book + ' · ' : ''}${bt.getMonth() + 1}/${bt.getDate()}` });
    }
  }
  return items;
}
// Group settled items by a key (sport or type) -> net units + W-L record, sorted by units.
function breakdownBy(items, key) {
  const m = new Map();
  for (const it of items) {
    const k = it[key] || 'Other';
    const row = m.get(k) || { k, units: 0, wins: 0, losses: 0, pushes: 0 };
    row.units += it.units;
    if (it.result === 'win') row.wins++; else if (it.result === 'loss') row.losses++; else row.pushes++;
    m.set(k, row);
  }
  return [...m.values()].map(r => ({ ...r, units: +r.units.toFixed(2) })).sort((a, b) => b.units - a.units);
}
// AN-style sport tiles: record + net per league, each opening that sport's record
// page. Favorite sports with nothing settled yet become "+ Add Bets" tiles.
function sportTilesHtml(items) {
  const rows = breakdownBy(items, 'sport');
  const have = new Set(rows.map(r => r.k));
  const favs = (window._trackingFavSports || []).map(s => String(s).toUpperCase());
  const addTiles = favs.filter(s => !have.has(s)).slice(0, 4);
  if (!rows.length && !addTiles.length) {
    return `<div style="padding:12px 0;color:var(--muted);font-size:13px;">No settled bets yet.</div>`;
  }
  const tile = (r, i) => {
    const up = r.units >= 0;
    return `<div class="sport-tile" onclick="openRecordView('sport','${r.k.replace(/'/g, '')}')" title="Open ${r.k} record">
      ${i === 0 && r.units > 0 ? '<i class="fa-solid fa-star sport-tile-star"></i>' : ''}
      <div class="sport-tile-name">${r.k}</div>
      <div class="sport-tile-rec">${r.wins}-${r.losses}-${r.pushes || 0}</div>
      <div class="sport-tile-net ${up ? 'pos' : 'neg'}">${up ? '+' : ''}${r.units.toFixed(2)}u <i class="fa-solid fa-caret-${up ? 'up' : 'down'}"></i></div>
    </div>`;
  };
  const add = (s) => `<div class="sport-tile sport-tile-add" onclick="openTrackSheet()" title="Track a ${s} bet">
      <div class="sport-tile-name">${s}</div>
      <div class="sport-tile-rec">0-0-0</div>
      <div class="sport-tile-net add">+ Add Bets</div>
    </div>`;
  return `<div class="sport-tile-grid">${rows.map(tile).join('')}${addTiles.map(add).join('')}</div>`;
}
function breakdownHtml(items) {
  const rows = (list, withBadge) => list.length === 0
    ? `<div style="padding:12px 0;color:var(--muted);font-size:13px;">No settled bets yet.</div>`
    : list.map(r => {
        const uCls = r.units >= 0 ? '#4ade80' : '#f87171';
        const decided = r.wins + r.losses;
        const wp = decided > 0 ? Math.round(100 * r.wins / decided) + '%' : '—';
        return `<div class="brk-row">
          <span class="brk-label">${withBadge ? sportBadge(r.k) : r.k}</span>
          <span class="brk-rec">${r.wins}-${r.losses}${r.pushes ? '-' + r.pushes : ''} · ${wp}</span>
          <span class="brk-units" style="color:${uCls};">${r.units >= 0 ? '+' : ''}${r.units.toFixed(2)}u</span>
        </div>`;
      }).join('');
  // By book: only bets carry a book (votes are at the CA line), so this section
  // appears once the user has logged bets with a book. Best book = most net units.
  const bookItems = items.filter(it => it.book);
  const byBook = bookItems.length ? breakdownBy(bookItems, 'book') : [];
  return `
    <div class="brk-section">By sport</div>${sportTilesHtml(items)}
    <div class="brk-section" style="margin-top:10px;">By bet type</div>${rows(breakdownBy(items, 'type'), false)}
    ${byBook.length ? `<div class="brk-section" style="margin-top:10px;">By book</div>${rows(byBook, false)}` : ''}`;
}
function pendingCount(votes, bets) {
  const vp = (votes || []).filter(v => !['win', 'loss', 'push'].includes((v.result || '').toLowerCase())).length;
  const bp = (bets || []).filter(b => (b.result || '').toLowerCase() === 'pending').length;
  return vp + bp;
}
function itemsInRange(items, range) {
  const start = rangeStart(range);
  if (!start) return items;
  return items.filter(it => it.ts === 0 ? true : it.ts >= start);
}
function statsOf(items) {
  let netUnits = 0, netD = 0, riskedD = 0, wins = 0, losses = 0, pushes = 0;
  for (const it of items) {
    netUnits += it.units; netD += it.dollars;
    if (it.result === 'win') wins++; else if (it.result === 'loss') losses++; else pushes++;
    if (it.result === 'win' || it.result === 'loss') riskedD += it.riskedD;
  }
  const decided = wins + losses;
  return {
    netUnits: +netUnits.toFixed(2), netD: +netD.toFixed(2),
    roi: riskedD > 0 ? +(100 * netD / riskedD).toFixed(1) : null,
    wins, losses, pushes, decided,
    winPct: decided > 0 ? Math.round(100 * wins / decided) : null,
  };
}
function trackStripHtml(items, pending) {
  const s = statsOf(items);
  const cls = s.netUnits >= 0 ? 'pos' : 'neg';
  const roiCls = s.roi == null ? '' : (s.roi >= 0 ? 'pos' : 'neg');
  return `
    <div class="track-stat"><div class="track-stat-label">Net Units</div><div class="track-stat-val ${cls}">${s.netUnits >= 0 ? '+' : ''}${s.netUnits.toFixed(2)}u</div><div class="track-stat-sub">${s.netD >= 0 ? '+' : ''}$${Math.abs(s.netD).toFixed(2)} profit</div></div>
    <div class="track-stat"><div class="track-stat-label">ROI</div><div class="track-stat-val ${roiCls}">${s.roi == null ? '—' : (s.roi >= 0 ? '+' : '') + s.roi.toFixed(1) + '%'}</div><div class="track-stat-sub">on money risked</div></div>
    <div class="track-stat"><div class="track-stat-label">Record</div><div class="track-stat-val">${s.wins}-${s.losses}${s.pushes ? '-' + s.pushes : ''}</div><div class="track-stat-sub">${pending} pending</div></div>
    <div class="track-stat"><div class="track-stat-label">Win Rate</div><div class="track-stat-val">${s.winPct !== null ? s.winPct + '%' : '—'}</div><div class="track-stat-sub">of decided</div></div>`;
}
function hotStreakDays(items) {
  const m = new Map();
  for (const it of items) {
    if (it.result !== 'win' && it.result !== 'loss') continue;
    const d = etDate(it.ts); if (!d) continue;
    m.set(d, (m.get(d) || 0) + it.units);
  }
  const dates = [...m.keys()].sort().reverse();
  let streak = 0;
  for (const d of dates) { if (m.get(d) > 0) streak++; else break; }
  return streak;
}
function bestWeekDollars(items) {
  const m = new Map();
  for (const it of items) {
    if (it.result !== 'win' && it.result !== 'loss') continue;
    const d = etDate(it.ts); if (!d) continue;
    const wk = Math.floor(Date.parse(d + 'T00:00:00Z') / (7 * 864e5));
    m.set(wk, (m.get(wk) || 0) + it.dollars);
  }
  let best = 0;
  for (const val of m.values()) best = Math.max(best, val);
  return +best.toFixed(2);
}
function trackExtraHtml(items, clv) {
  const streak = hotStreakDays(items);
  const best = bestWeekDollars(items);
  return `
    <div class="track-stat"><div class="track-stat-label">Hot Streak</div><div class="track-stat-val">${streak > 0 ? '🔥 ' : ''}${streak}<span style="font-size:14px;font-weight:600;color:var(--muted);"> day${streak !== 1 ? 's' : ''}</span></div><div class="track-stat-sub">winning days in a row</div></div>
    <div class="track-stat"><div class="track-stat-label">Best Week</div><div class="track-stat-val ${best >= 0 ? 'pos' : ''}">${best >= 0 ? '+' : ''}$${Math.abs(best).toFixed(2)}</div><div class="track-stat-sub">best 7-day profit</div></div>
    <div class="track-stat"><div class="track-stat-label">Closing Line Value</div><div class="track-stat-val">${clv && clv.n ? clv.pct + '%' : '—'}</div><div class="track-stat-sub">${clv && clv.n ? `beat the close (${clv.good}/${clv.n})` : 'on graded verified picks'}</div></div>`;
}

// ── Phase 2 analytics: odds bands, downside, calendar heatmap, CLV card ────────

// Win rate vs breakeven by odds band. Breakeven is the implied probability of the
// odds you took; beating it is what actually pays, not the raw win rate.
const ODDS_BANDS = [
  { label: '-200 or shorter', lo: -Infinity, hi: -200 },
  { label: '-199 to -150',    lo: -199,      hi: -150 },
  { label: '-149 to -105',    lo: -149,      hi: -105 },
  { label: '-104 to +104',    lo: -104,      hi: 104  },
  { label: '+105 to +150',    lo: 105,       hi: 150  },
  { label: '+151 or longer',  lo: 151,       hi: Infinity },
];
function oddsBandsHtml(items) {
  const impl = o => (o < 0 ? (-o) / (-o + 100) : 100 / (o + 100));
  const bands = ODDS_BANDS.map(b => ({ ...b, wins: 0, losses: 0, beSum: 0 }));
  for (const it of items) {
    if (it.result !== 'win' && it.result !== 'loss') continue;
    const o = (it.odds == null || !isFinite(it.odds)) ? -110 : it.odds;
    const band = bands.find(b => o >= b.lo && o <= b.hi);
    if (!band) continue;
    band.beSum += impl(o);
    if (it.result === 'win') band.wins++; else band.losses++;
  }
  const rows = bands.filter(b => b.wins + b.losses > 0).map(b => {
    const n = b.wins + b.losses;
    const actual = Math.round(100 * b.wins / n);
    const be = Math.round(100 * b.beSum / n);
    const ok = actual >= be;
    return `<div class="ob-band-row" title="Win rate ${actual}% vs ${be}% needed to break even at these odds">
      <span class="ob-band-label">${b.label}</span>
      <span class="ob-band-bar">
        <span class="ob-band-fill" style="width:${actual}%;background:${ok ? '#4ade80' : '#f87171'};"></span>
        <span class="ob-band-be" style="left:${be}%;" title="Breakeven ${be}%"></span>
      </span>
      <span class="ob-band-rec">${b.wins}-${b.losses} · ${actual}%</span>
    </div>`;
  }).join('');
  if (!rows) return `<div style="padding:10px 0;color:var(--muted);font-size:13px;">Settled bets land here, grouped by the odds you took. The tick on each bar is the win rate you need to break even.</div>`;
  return rows + `<div style="padding-top:8px;font-size:11px;color:var(--muted);">Bar = your win rate. Tick = the win rate needed to break even at those odds.</div>`;
}

// Downside panel: the numbers winners watch. Cold streak mirrors hotStreakDays.
function coldStreakDays(items) {
  const m = new Map();
  for (const it of items) {
    if (it.result !== 'win' && it.result !== 'loss') continue;
    const d = etDate(it.ts); if (!d) continue;
    m.set(d, (m.get(d) || 0) + it.units);
  }
  const dates = [...m.keys()].sort();
  let worst = 0, run = 0;
  for (const d of dates) { if (m.get(d) < 0) { run++; worst = Math.max(worst, run); } else run = 0; }
  return worst;
}
function maxDrawdownUnits(items) {
  const sorted = items.slice().sort((a, b) => a.ts - b.ts);
  let cum = 0, peak = 0, dd = 0;
  for (const it of sorted) { cum += it.units; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return +dd.toFixed(2);
}
function worstWeekDollars(items) {
  const m = new Map();
  for (const it of items) {
    if (it.result !== 'win' && it.result !== 'loss') continue;
    const d = etDate(it.ts); if (!d) continue;
    const wk = Math.floor(Date.parse(d + 'T00:00:00Z') / (7 * 864e5));
    m.set(wk, (m.get(wk) || 0) + it.dollars);
  }
  let worst = 0;
  for (const val of m.values()) worst = Math.min(worst, val);
  return +worst.toFixed(2);
}
function downsideHtml(items) {
  const dd = maxDrawdownUnits(items);
  const cold = coldStreakDays(items);
  const ww = worstWeekDollars(items);
  const row = (label, val, sub) => `<div class="brk-row"><span class="brk-label">${label}</span><span class="brk-rec">${sub}</span><span class="brk-units">${val}</span></div>`;
  return row('Max drawdown', dd > 0 ? `-${dd.toFixed(2)}u` : '0.00u', 'deepest dip from a peak')
    + row('Coldest streak', `${cold} day${cold !== 1 ? 's' : ''}`, 'losing days in a row')
    + row('Worst week', `${ww < 0 ? '-' : ''}$${Math.abs(ww).toFixed(2)}`, 'roughest 7-day stretch');
}

// Calendar heatmap: last 12 weeks of daily net units, GitHub-style.
function heatmapHtml(items) {
  const byDay = new Map();
  for (const it of items) {
    if (it.result !== 'win' && it.result !== 'loss' && it.result !== 'push') continue;
    const d = etDate(it.ts); if (!d) continue;
    byDay.set(d, (byDay.get(d) || 0) + it.units);
  }
  // Walk from the Sunday 11 weeks back through today (ET), one cell per day.
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - (77 + today.getDay()));
  const cells = [];
  const cur = new Date(start);
  while (cur <= today) {
    const key = cur.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const u = byDay.get(key);
    let style = '';
    if (u != null && u !== 0) {
      const alpha = Math.min(0.9, 0.25 + Math.abs(u) / 3 * 0.65); // saturate at 3u
      style = `background:${u > 0 ? `rgba(74,222,128,${alpha.toFixed(2)})` : `rgba(248,113,113,${alpha.toFixed(2)})`};`;
    }
    const label = new Date(cur).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    cells.push(`<span class="hm-cell" style="${style}" title="${label}${u != null ? ` · ${u >= 0 ? '+' : ''}${u.toFixed(2)}u` : ''}"></span>`);
    cur.setDate(cur.getDate() + 1);
  }
  return `<div class="hm-grid">${cells.join('')}</div>
    <div style="padding-top:8px;font-size:11px;color:var(--muted);">Each square is a day: green up, red down, deeper color means a bigger swing.</div>`;
}

// CLV card: the verified-picks edge signal, in plain English, with a distribution.
function clvCardHtml(clv) {
  if (!clv || !clv.n) {
    return `<div style="padding:4px 0;color:var(--muted);font-size:13px;">Once your verified picks grade, we compare the number you took to where the line closed. Beating the close often signals real edge, win or lose.</div>`;
  }
  const avg = clv.avg == null ? 0 : clv.avg;
  const read = avg >= 0
    ? 'Getting a better number than the close tends to be the strongest sign of long-term edge.'
    : 'Getting a worse number than the close tends to drag on results over time, so line shopping can help.';
  const buckets = [
    { label: '-10c+',  lo: -Infinity, hi: -10 },
    { label: '-10 to -3', lo: -10, hi: -3 },
    { label: 'even', lo: -3, hi: 3 },
    { label: '+3 to +10', lo: 3, hi: 10 },
    { label: '+10c+', lo: 10, hi: Infinity },
  ].map(b => ({ ...b, n: 0 }));
  for (const d of clv.diffs) {
    const b = buckets.find(b => d > b.lo && d <= b.hi) || buckets[2];
    b.n++;
  }
  const maxN = Math.max(1, ...buckets.map(b => b.n));
  const bars = buckets.map((b, i) => `
    <div class="clv-bar-wrap" title="${b.n} pick${b.n !== 1 ? 's' : ''}">
      <span class="clv-bar" style="height:${Math.max(3, Math.round(44 * b.n / maxN))}px;background:${i < 2 ? '#f87171' : i === 2 ? 'var(--muted)' : '#4ade80'};"></span>
      <span class="clv-bar-lbl">${b.label}</span>
    </div>`).join('');
  return `
    <div style="font-size:13.5px;line-height:1.5;">You beat the closing line on <b>${clv.pct}%</b> of graded verified picks (${clv.good}/${clv.n}), averaging <b>${avg >= 0 ? '+' : ''}${avg} cents</b> of implied probability. ${read}</div>
    <div class="clv-dist">${bars}</div>`;
}

// ── Global filters (sport + bet type) applied across the tracking analytics ────
let _trackSportF = '', _trackTypeF = '';
function applyTrackFilters(items) {
  return items.filter(it =>
    (!_trackSportF || it.sport === _trackSportF) &&
    (!_trackTypeF || it.type === _trackTypeF));
}
export function setTrackFilter(kind, val) {
  if (kind === 'sport') _trackSportF = val; else _trackTypeF = val;
  recomputeTrackStats();
}

// ── Net Units cards (AN-style): net units at a glance across 4 timeframes ──────
function startOfTodayTs() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function netUnitsCardsHtml(items) {
  const sToday = startOfTodayTs();
  const yest = items.filter(it => it.ts >= sToday - 864e5 && it.ts < sToday);
  // Each tile opens the Net Record drill-down with its window pre-selected.
  const defs = [
    ['Yesterday', statsOf(yest),                          'yesterday'],
    ['Last 7',    statsOf(itemsInRange(items, 'week')),   'week'],
    ['Last 30',   statsOf(itemsInRange(items, 'month')),  'month'],
    ['All Time',  statsOf(items),                         'all'],
  ];
  return defs.map(([label, s, win]) => {
    const cls = s.netUnits >= 0 ? 'pos' : 'neg';
    const rec = `${s.wins}-${s.losses}${s.pushes ? '-' + s.pushes : ''}`;
    return `<div class="nu-card nu-click" onclick="openRecordView('net','${win}')" title="Open ${label} record">
      <div class="nu-label">${label}</div>
      <div class="nu-val ${cls}">${s.netUnits >= 0 ? '+' : ''}${s.netUnits.toFixed(2)}u</div>
      <div class="nu-sub">${s.netD >= 0 ? '+' : ''}$${Math.abs(s.netD).toFixed(2)} · ${rec}</div>
    </div>`;
  }).join('');
}

// ── Performance card body (headline P/L + ROI / Record / Win% for a timeframe) ──
function performanceHtml(items, pending) {
  const s = statsOf(items);
  const dCls = s.netD >= 0 ? 'pos' : 'neg';
  const m = (label, val, cls) => `<div class="perf-metric"><span class="perf-m-label">${label}</span><span class="perf-m-val ${cls || ''}">${val}</span></div>`;
  return `
    <div class="perf-headline ${dCls}">${s.netD >= 0 ? '+' : ''}$${Math.abs(s.netD).toFixed(2)}</div>
    <div class="perf-metrics">
      ${m('Net Units', `${s.netUnits >= 0 ? '+' : ''}${s.netUnits.toFixed(2)}u`, s.netUnits >= 0 ? 'pos' : 'neg')}
      ${m('ROI', s.roi == null ? '—' : `${s.roi >= 0 ? '+' : ''}${s.roi.toFixed(1)}%`, s.roi == null ? '' : (s.roi >= 0 ? 'pos' : 'neg'))}
      ${m('Record', `${s.wins}-${s.losses}${s.pushes ? '-' + s.pushes : ''}`)}
      ${m('Win %', s.winPct !== null ? `${s.winPct}%` : '—')}
    </div>
    <div class="perf-note">Your custom + verified bets together${pending ? ` · ${pending} pending` : ''}. Custom bets are personal and do not count on the leaderboard.</div>`;
}
// Cumulative P/L from the unified items (sorted by time), in the chosen metric.
let trackChart = null;
let _trackMetric = 'dollars'; // 'dollars' | 'units' | 'bankroll'
function fmtMetric(v) {
  if (_trackMetric === 'bankroll') return '$' + v.toFixed(2);
  return _trackMetric === 'units' ? (v >= 0 ? '+' : '') + v.toFixed(2) + 'u' : (v >= 0 ? '+' : '') + '$' + v.toFixed(2);
}
function drawTrackGraph(items) {
  const canvas = document.getElementById('voted-pl-chart');
  const label  = document.getElementById('voted-pl-total');
  const empty  = document.getElementById('track-graph-empty');
  if (!canvas) return;
  const sorted = items.slice().sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) {
    if (label) {
      label.textContent = _trackMetric === 'units' ? '0.00u'
        : _trackMetric === 'bankroll' ? '$' + (Number(window._trackBankroll) || 0).toFixed(2) : '$0.00';
      label.className = 'graph-pl-label';
    }
    if (trackChart) { trackChart.destroy(); trackChart = null; }
    // Teach on the very first visit (the intro card above carries the CTA button);
    // a range with no bets just says so.
    if (empty) {
      const neverTracked = !(window._trackingVotes || []).length && !(window._trackingBets || []).length;
      empty.innerHTML = neverTracked
        ? `<div>Your P/L graph builds here once your first bet settles.</div>`
        : `<div>No settled bets in this timeframe yet.</div>`;
      empty.style.display = '';
    }
    return;
  }
  if (empty) empty.style.display = 'none';
  const isBankroll = _trackMetric === 'bankroll';
  const field = (!isBankroll && _trackMetric === 'units') ? 'units' : 'dollars';
  const startBR = Number(window._trackBankroll) || 0;
  let cum = isBankroll ? startBR : 0;
  const pts = sorted.map(it => { cum = +(cum + it[field]).toFixed(4); return +cum.toFixed(2); });
  // Flat 1u pace: the same bets at a disciplined flat unit. Not shown on bankroll view.
  let flatPts = null;
  if (!isBankroll) {
    const unit = Number(window._trackUnitSize) > 0 ? Number(window._trackUnitSize) : 20;
    let fc = 0;
    flatPts = sorted.map(it => {
      const fu = flatUnitsOf(it);
      fc = +(fc + (_trackMetric === 'units' ? fu : fu * unit)).toFixed(4);
      return +fc.toFixed(2);
    });
  }
  // Running peak: the fill between it and the actual line shades every underwater stretch.
  let pk = -Infinity;
  const peakPts = pts.map(v => { pk = Math.max(pk, v); return +pk.toFixed(2); });
  const total = pts[pts.length - 1];
  if (label) {
    label.textContent = fmtMetric(total);
    label.className = 'graph-pl-label ' + ((isBankroll ? total >= startBR : total >= 0) ? 'pos' : 'neg');
  }
  const css = getComputedStyle(document.documentElement);
  const tick = (css.getPropertyValue('--muted').trim()) || '#8892a4';
  const grid = (css.getPropertyValue('--grid-line').trim()) || 'rgba(255,255,255,0.05)';
  const line = (isBankroll ? total >= startBR : total >= 0) ? '#4ade80' : '#f87171';
  const unitSuffix = _trackMetric === 'units' ? 'u' : '';
  const dollarPrefix = _trackMetric === 'units' ? '' : '$';
  if (trackChart) { trackChart.destroy(); trackChart = null; }
  const datasets = [
    { label: 'Actual', data: pts, borderColor: line, backgroundColor: line + '18', borderWidth: 2, pointRadius: pts.length > 40 ? 0 : 4, pointHoverRadius: 6, fill: true, tension: 0.2, order: 1 },
    { label: 'Peak', data: peakPts, borderColor: 'rgba(248,113,113,0.35)', borderWidth: 1, borderDash: [3, 4], pointRadius: 0, pointHoverRadius: 0, tension: 0, order: 3,
      fill: { target: 0, above: 'rgba(248,113,113,0.10)', below: 'rgba(0,0,0,0)' } },
  ];
  if (flatPts) datasets.push({ label: 'Flat 1u', data: flatPts, borderColor: 'rgba(96,165,250,0.75)', borderWidth: 1.5, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 4, fill: false, tension: 0.2, order: 2 });
  trackChart = new Chart(canvas, {
    type: 'line',
    data: { labels: pts.map((_, i) => i + 1), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { filter: i => i.dataset.label !== 'Peak', callbacks: { title: () => '', label: i => `${i.dataset.label}: ${fmtMetric(Number(i.raw))}` } },
      },
      scales: { x: { display: false }, y: { grid: { color: grid }, ticks: { color: tick, callback: v => dollarPrefix + v + unitSuffix } } },
    },
  });
}
export function setTrackMetric(m) {
  _trackMetric = (m === 'units' || m === 'bankroll') ? m : 'dollars';
  document.querySelectorAll('[data-track-metric]').forEach(b => b.classList.toggle('active', b.dataset.trackMetric === _trackMetric));
  recomputeTrackStats();
}
export function recomputeTrackStats() {
  const votes = window._trackingVotes || [];
  const bets  = window._trackingBets || [];
  const unit  = Number(window._trackUnitSize) > 0 ? Number(window._trackUnitSize) : 20;
  const all      = buildItems(votes, bets, unit);
  const filtered = applyTrackFilters(all);           // global sport/type filters
  const ranged   = itemsInRange(filtered, _trackRange);
  const pend     = pendingCount(votes, bets);
  // Net Units cards show all 4 fixed timeframes (data-driven, not the dropdown).
  const nu = document.getElementById('track-nu');
  if (nu) nu.innerHTML = netUnitsCardsHtml(filtered);
  // Performance card follows the dropdown timeframe.
  const perf = document.getElementById('track-perf');
  if (perf) perf.innerHTML = performanceHtml(ranged, pend);
  // Hot streak / best week / CLV are all-time concepts.
  const extra = document.getElementById('track-extra');
  if (extra) extra.innerHTML = trackExtraHtml(filtered, clvOf(votes));
  // Breakdown + graph follow the dropdown timeframe.
  const brk = document.getElementById('track-breakdown');
  if (brk) brk.innerHTML = breakdownHtml(ranged);
  // Phase 2 analytics.
  const bands = document.getElementById('track-bands');
  if (bands) bands.innerHTML = oddsBandsHtml(ranged);
  const down = document.getElementById('track-downside');
  if (down) down.innerHTML = downsideHtml(filtered);
  const hm = document.getElementById('track-heatmap');
  if (hm) hm.innerHTML = heatmapHtml(filtered);
  const clvEl = document.getElementById('track-clv');
  if (clvEl) clvEl.innerHTML = clvCardHtml(clvOf(votes));
  drawTrackGraph(ranged);
}
export function setTrackRange(r) {
  _trackRange = r;
  document.querySelectorAll('[data-track-range]').forEach(b => b.classList.toggle('active', b.dataset.trackRange === r));
  recomputeTrackStats();
}

// ── My Tracking view ──────────────────────────────────────────────────────────
// ── Record drill-down pages (AN-style) ─────────────────────────────────────────
// One template behind every stat surface: Net Record (window tiles), {SPORT}
// Record (sport tiles), Current Streak (profile). Timeframe tabs + filters
// re-scope in place; every page carries the cumulative chart; custom bets ride
// along greyed with a tag (personal view — the leaderboard never sees them).
let _recScope = null;   // { kind:'net'|'sport'|'streak', sport, window, fSport, fType, fBook, showFilters }
let recChart = null;
const escRec = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function openRecordView(kind, param) {
  _recScope = {
    kind,
    sport: kind === 'sport' ? String(param || '').toUpperCase() : null,
    window: kind === 'net' ? (param || 'all') : 'all',
    fSport: '', fType: '', fBook: '', showFilters: false,
  };
  const panel = document.getElementById('panel-tracking');
  if (!panel || !panel.classList.contains('active')) {
    // Entered from the profile: switch tabs — loadTracking sees _recScope and
    // renders the record view the moment the data lands.
    window.switchTab('tracking');
    return;
  }
  if (!window._trackingVotes && !window._trackingBets) { loadTracking(); return; }
  renderRecordView();
}
export function closeRecordView() {
  _recScope = null;
  if (recChart) { recChart.destroy(); recChart = null; }
  loadTracking();
}
export function recSetWindow(w) { if (_recScope) { _recScope.window = w; renderRecordView(); } }
export function recToggleFilters() { if (_recScope) { _recScope.showFilters = !_recScope.showFilters; renderRecordView(); } }
export function recSetFilter(kind, val) {
  if (!_recScope) return;
  if (kind === 'sport') _recScope.fSport = val;
  else if (kind === 'type') _recScope.fType = val;
  else _recScope.fBook = val;
  renderRecordView();
}

function recAllItems() {
  const unit = Number(window._trackUnitSize) > 0 ? Number(window._trackUnitSize) : 20;
  return buildItems(window._trackingVotes || [], window._trackingBets || [], unit);
}
// Items in scope: page kind -> filters -> timeframe, chronological for the chart.
function recItems() {
  const sc = _recScope;
  let items = recAllItems();
  if (sc.kind === 'sport') items = items.filter(i => i.sport === sc.sport);
  if (sc.fSport) items = items.filter(i => i.sport === sc.fSport);
  if (sc.fType)  items = items.filter(i => i.type === sc.fType);
  if (sc.fBook)  items = items.filter(i => i.book === sc.fBook);
  if (sc.kind === 'streak') {
    items = items.slice().sort((a, b) => b.ts - a.ts).slice(0, 10);
  } else if (sc.window === 'yesterday') {
    const s = startOfTodayTs();
    items = items.filter(i => i.ts >= s - 864e5 && i.ts < s);
  } else {
    items = itemsInRange(items, sc.window);
  }
  return items.sort((a, b) => a.ts - b.ts);
}
function recTitle() {
  const sc = _recScope;
  if (sc.kind === 'sport')  return `${sc.sport} Record`;
  if (sc.kind === 'streak') return 'Current Streak';
  return 'Net Record';
}
// Trailing same-result run across ALL graded items (newest first): W3 / L2 badge.
function recStreakBadge() {
  const graded = recAllItems().filter(i => i.result === 'win' || i.result === 'loss')
    .sort((a, b) => b.ts - a.ts);
  if (!graded.length) return '';
  const r = graded[0].result;
  let n = 0;
  for (const it of graded) { if (it.result === r) n++; else break; }
  return `<span class="rec-streak-badge ${r}">${r === 'win' ? 'W' : 'L'}${n}</span>`;
}

function renderRecordView() {
  const el = document.getElementById('tracking-content');
  if (!el || !_recScope) return;
  const sc = _recScope;
  const items = recItems();
  const s = statsOf(items);
  // Bankroll is an overview-only concept; record pages speak dollars or units.
  const metric = _trackMetric === 'units' ? 'units' : 'dollars';
  const fmt = (v) => metric === 'units'
    ? `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)}u`
    : `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
  const net = metric === 'units' ? s.netUnits : s.netD;

  const tabs = sc.kind === 'streak' ? '' : `
    <div class="rec-tabs">
      ${[['today', 'Today'], ['yesterday', 'Yest'], ['week', 'Last 7'], ['month', 'Last 30'], ['all', 'All']]
        .map(([w, lbl]) => `<button class="rec-tab${sc.window === w ? ' active' : ''}" onclick="recSetWindow('${w}')">${lbl}</button>`).join('')}
    </div>`;

  // Filter options come from everything this page COULD show (kind-scoped, unfiltered).
  let fltSrc = recAllItems();
  if (sc.kind === 'sport') fltSrc = fltSrc.filter(i => i.sport === sc.sport);
  const opts = (list, cur, none) => [`<option value="">${none}</option>`]
    .concat(list.map(v => `<option value="${v}"${cur === v ? ' selected' : ''}>${v}</option>`)).join('');
  const fSports = [...new Set(fltSrc.map(i => i.sport).filter(Boolean))].sort();
  const fTypes  = [...new Set(fltSrc.map(i => i.type).filter(Boolean))].sort();
  const fBooks  = [...new Set(fltSrc.map(i => i.book).filter(Boolean))].sort();
  const filters = !sc.showFilters ? '' : `
    <div class="rec-filters">
      ${sc.kind === 'sport' ? '' : `<select class="perf-range" onchange="recSetFilter('sport', this.value)">${opts(fSports, sc.fSport, 'All sports')}</select>`}
      <select class="perf-range" onchange="recSetFilter('type', this.value)">${opts(fTypes, sc.fType, 'All bet types')}</select>
      ${fBooks.length ? `<select class="perf-range" onchange="recSetFilter('book', this.value)">${opts(fBooks, sc.fBook, 'All books')}</select>` : ''}
    </div>`;

  const rows = items.slice().reverse().map(it => {
    const icon = it.result === 'win' ? '<i class="fa-solid fa-circle-check rec-ic win"></i>'
               : it.result === 'loss' ? '<i class="fa-solid fa-circle-xmark rec-ic loss"></i>'
               : '<i class="fa-solid fa-circle-minus rec-ic push"></i>';
    const v = metric === 'units' ? it.units : it.dollars;
    const oddsStr = it.odds > 0 ? `+${it.odds}` : `${it.odds}`;
    return `<div class="rec-item${it.verified ? '' : ' rec-custom'}">
      ${icon}
      <div class="rec-item-main">
        <div class="rec-item-sel">${escRec(it.sel)} <span class="rec-item-odds">${oddsStr}</span>${it.verified ? '' : '<span class="rec-custom-tag">custom</span>'}</div>
        <div class="rec-item-sub">${escRec(it.sub)}</div>
      </div>
      <div class="rec-item-net ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${it.result === 'push' ? 'Push' : fmt(v)}</div>
    </div>`;
  }).join('');

  // Top Leagues mini card: the user's whole slate, not just this page's scope.
  const top = breakdownBy(recAllItems(), 'sport').slice(0, 3);
  const topRows = top.map(r => `
    <div class="rec-top-row" onclick="openRecordView('sport','${r.k.replace(/'/g, '')}')">
      <span class="rec-top-name">${r.k}</span>
      <span class="rec-top-rec">${r.wins}-${r.losses}-${r.pushes || 0}</span>
      <span class="rec-top-net ${r.units >= 0 ? 'pos' : 'neg'}">${r.units >= 0 ? '+' : ''}${r.units.toFixed(2)}u</span>
    </div>`).join('');

  el.innerHTML = `
    <div class="rec-page">
      <div class="rec-head">
        <button class="rec-back" onclick="closeRecordView()" aria-label="Back to My Tracking"><i class="fa-solid fa-chevron-left"></i></button>
        <span class="rec-title">${recTitle()}${sc.kind === 'streak' ? recStreakBadge() : ''}</span>
        <button class="rec-filter-btn${(sc.fSport || sc.fType || sc.fBook) ? ' on' : ''}" onclick="recToggleFilters()" aria-label="Filters"><i class="fa-solid fa-sliders"></i></button>
      </div>
      ${tabs}${filters}
      <div class="rec-hero">
        <div class="rec-big ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${fmt(net)}</div>
        <button class="rec-share" onclick="shareRecord()" aria-label="Share this record"><i class="fa-solid fa-arrow-up-from-bracket"></i></button>
        <div class="rec-risked">Total Risked: ${metric === 'units' ? (window._trackUnitSize > 0 ? (s => `${s.toFixed(2)}u`)(items.reduce((a, i) => a + ((i.result === 'win' || i.result === 'loss') ? i.riskedD : 0), 0) / window._trackUnitSize) : '0u') : '$' + items.reduce((a, i) => a + ((i.result === 'win' || i.result === 'loss') ? i.riskedD : 0), 0).toFixed(2)}</div>
      </div>
      <div class="rec-stats">
        <span>ROI: <b class="${s.roi == null ? '' : s.roi >= 0 ? 'pos' : 'neg'}">${s.roi == null ? '—' : s.roi + '%'}</b></span>
        <span>Record: <b>${s.wins}-${s.losses}-${s.pushes}</b></span>
        <span>Wins: <b>${s.winPct == null ? '—' : s.winPct + '%'}</b></span>
      </div>
      <div class="rec-chart-card">
        ${items.length ? '<canvas id="rec-chart"></canvas>' : `<div class="rec-chart-empty">No settled bets ${sc.kind === 'streak' ? 'yet' : 'in this timeframe'}.</div>`}
      </div>
      <div class="rec-list">${rows || ''}</div>
      ${top.length ? `
      <div class="rec-mystats-block">
        <div class="rec-mystats-title">My Stats</div>
        <div class="card rec-top-card">
          <div class="rec-top-head"><i class="fa-solid fa-trophy" style="color:var(--gold);"></i> Top Leagues</div>
          ${topRows}
        </div>
      </div>` : ''}
      <button class="rec-viewall" onclick="closeRecordView()">View All Bet History</button>
    </div>`;
  if (items.length) requestAnimationFrame(() => drawRecChart(items, metric));
}

function drawRecChart(items, field) {
  const canvas = document.getElementById('rec-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (recChart) { recChart.destroy(); recChart = null; }
  let cum = 0;
  const pts = items.map(it => +(cum = +(cum + it[field]).toFixed(4)).toFixed(2));
  const total = pts[pts.length - 1] || 0;
  const line = total >= 0 ? '#4ade80' : '#f87171';
  const css = getComputedStyle(document.documentElement);
  const fmt = (v) => field === 'units' ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}u` : `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`;
  recChart = new Chart(canvas, {
    type: 'line',
    data: { labels: pts.map((_, i) => i + 1), datasets: [{ data: pts, borderColor: line, backgroundColor: line + '22', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: true, tension: 0.35 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: () => '', label: (i) => fmt(Number(i.raw)) } } },
      scales: {
        x: { display: false },
        y: { grid: { color: css.getPropertyValue('--grid-line').trim() || 'rgba(255,255,255,0.05)' }, ticks: { color: css.getPropertyValue('--muted').trim() || '#8892a4' } },
      },
    },
  });
}

// Share the scoped record as a PNG card (numbers only on the canvas, no user text).
export async function shareRecord() {
  if (!_recScope) return;
  const items = recItems();
  const s = statsOf(items);
  const metric = _trackMetric === 'units' ? 'units' : 'dollars';
  const net = metric === 'units'
    ? `${s.netUnits >= 0 ? '+' : '-'}${Math.abs(s.netUnits).toFixed(2)}u`
    : `${s.netD >= 0 ? '+' : '-'}$${Math.abs(s.netD).toFixed(2)}`;
  const winLbl = { today: 'Today', yesterday: 'Yesterday', week: 'Last 7', month: 'Last 30', all: 'All time' }[_recScope.window] || 'All time';
  const c = document.createElement('canvas'); c.width = 1080; c.height = 566;
  const x = c.getContext('2d');
  x.fillStyle = '#0f1117'; x.fillRect(0, 0, 1080, 566);
  x.fillStyle = '#171b24'; x.fillRect(40, 40, 1000, 486);
  x.strokeStyle = '#252c3b'; x.lineWidth = 2; x.strokeRect(40, 40, 1000, 486);
  x.fillStyle = '#FFD700'; x.font = '800 36px "Segoe UI", system-ui, sans-serif'; x.fillText('CappingAlpha', 80, 116);
  x.fillStyle = '#8892a4'; x.font = '600 26px "Segoe UI", system-ui, sans-serif';
  x.fillText(`${recTitle()}${_recScope.kind === 'streak' ? '' : ' · ' + winLbl}`, 80, 164);
  x.fillStyle = s.netD >= 0 ? '#4ade80' : '#f87171'; x.font = '900 108px "Segoe UI", system-ui, sans-serif';
  x.fillText(net, 80, 300);
  x.fillStyle = '#e2e8f0'; x.font = '700 34px "Segoe UI", system-ui, sans-serif';
  x.fillText(`Record ${s.wins}-${s.losses}-${s.pushes}`, 80, 386);
  x.fillText(`ROI ${s.roi == null ? '—' : s.roi + '%'}`, 470, 386);
  x.fillText(`Wins ${s.winPct == null ? '—' : s.winPct + '%'}`, 760, 386);
  x.fillStyle = '#8892a4'; x.font = '500 24px "Segoe UI", system-ui, sans-serif';
  x.fillText('cappingalpha.com', 80, 472);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  if (!blob) return;
  const file = new File([blob], 'ca-record.png', { type: 'image/png' });
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'My CappingAlpha record' }); return; } catch (_) {}
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'ca-record.png'; a.click();
  URL.revokeObjectURL(a.href);
}

function renderTracking(data) {
  const el = document.getElementById('tracking-content');
  const { votes = [], friends = [], bets = [], unitSize, startingBankroll,
          user = {}, avatarUrl = null, favoriteSports = [], myBooks = [] } = data;
  const unit = Number(unitSize) > 0 ? Number(unitSize) : 20;

  // Unified personal series: verified votes + settled custom bets.
  const items = buildItems(votes, bets, unit);
  const pend  = pendingCount(votes, bets);
  const initStats = statsOf(items);

  // Stash for live recompute (timeframe pills, unit input, after a bet mutation).
  window._trackingVotes  = votes;
  window._trackingBets   = bets;
  window._trackUnitSize  = unit;
  window._trackBankroll  = Number(startingBankroll) || 0;
  window._myBooks        = myBooks;
  window._trackingFavSports = favoriteSports;

  // A record drill-down is open (or queued from the profile): render it instead of
  // the overview — the freshly stashed data above is exactly what it reads.
  if (_recScope) return renderRecordView();

  // Global filter options come from the sports/types actually in the data; keep a
  // stale active filter visible (like the bet-history dropdown) instead of snapping.
  const fSports = [...new Set(items.map(i => i.sport).filter(Boolean))].sort();
  const fTypes  = [...new Set(items.map(i => i.type).filter(Boolean))].sort();
  if (_trackSportF && !fSports.includes(_trackSportF)) fSports.push(_trackSportF);
  if (_trackTypeF && !fTypes.includes(_trackTypeF)) fTypes.push(_trackTypeF);
  const filterBar = items.length === 0 ? '' : `
    <div class="track-filter-row account-reveal">
      <span class="tfr-label">Filter</span>
      <select class="perf-range" onchange="setTrackFilter('sport', this.value)">
        <option value="">All sports</option>
        ${fSports.map(s => `<option value="${s}"${_trackSportF === s ? ' selected' : ''}>${s}</option>`).join('')}
      </select>
      <select class="perf-range" onchange="setTrackFilter('type', this.value)">
        <option value="">All bet types</option>
        ${fTypes.map(t => `<option value="${t}"${_trackTypeF === t ? ' selected' : ''}>${t}</option>`).join('')}
      </select>
      <span class="tfr-note">Applies to the stats and charts below.</span>
    </div>`;

  // Friends (followed members), each clickable into their profile.
  const friendsHtml = friends.length === 0
    ? `<div style="padding:24px 20px;color:var(--muted);font-size:14px;">You're not following anyone yet. Open a member from the Leaderboard and tap Follow.</div>`
    : friends.map(f => {
        const u = Number(f.units || 0);
        const uCls = u >= 0 ? '#4ade80' : '#f87171';
        const mutual = f.mutual ? ` <span style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#1a1205;background:linear-gradient(135deg,#FFD700,#f0b400);padding:1px 6px;border-radius:999px;vertical-align:middle;">Mutual</span>` : '';
        return `<div onclick="openMemberModal(${f.user_id},'all')" style="display:flex;align-items:center;gap:12px;padding:11px 20px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px;">
          ${avatarFor(f.username, 34, f.avatar_url)}
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;">@${f.username}${mutual}</div>
            <div style="font-size:12px;color:var(--muted);">${f.wins}-${f.losses}${f.pushes ? '-' + f.pushes : ''} · ${f.win_pct == null ? '—' : Math.round(f.win_pct) + '%'} win</div>
          </div>
          <div style="text-align:right;color:${uCls};font-weight:700;">${u >= 0 ? '+' : ''}${u.toFixed(2)}u</div>
        </div>`;
      }).join('');

  const votesHtml = votes.length === 0
    ? `<div style="padding:28px 20px;color:var(--muted);font-size:14px;">No tracked picks yet. Click any pick row or schedule game to vote.</div>`
    : votes.map(v => {
        const matchup   = v.home_team ? `${v.away_team} @ ${v.home_team}` : `Game ${v.espn_game_id}`;
        const slotLabel = voteSlotLabel(v);
        const canDelete = v.status === 'pre';

        const statusStr = v.status === 'in'   ? `<span style="color:#38bdf8;font-size:12px;">LIVE ${v.away_score}–${v.home_score}</span>`
                        : v.status === 'post'  ? `<span style="color:var(--muted);font-size:12px;">Final ${v.away_score}–${v.home_score}</span>`
                        : v.start_time         ? `<span style="color:var(--muted);font-size:12px;">${new Date(v.start_time).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',hour12:true})}</span>`
                        : '';

        const score     = v.score != null ? v.score : '—';
        const heatColor = v.score ? PICK_HEAT_COLOR(v.score).color : 'var(--muted)';
        const isPush    = v.result === 'push';

        const resultStr = v.result === 'win'  ? `<span class="result-win">W</span>`
                        : v.result === 'loss' ? `<span class="result-loss">L</span>`
                        : v.result === 'push' ? `<span class="result-push">P</span>`
                        : `<span style="color:var(--muted);">—</span>`;

        const openAttr = v.espn_game_id && v.home_team
          ? `onclick="openGameModal('${v.espn_game_id}','${v.pick_type || ''}','${(v.team||'').replace(/'/g,"\\'")}')"`
          : '';

        const deleteBtn = canDelete
          ? `<button onclick="event.stopPropagation(); deleteVote('${v.espn_game_id}','${v.pick_slot}')"
               style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;margin-left:8px;flex-shrink:0;"
               title="Remove vote">✕</button>`
          : '';

        return `
          <div class="voted-pick-row" ${openAttr} style="${v.espn_game_id && v.home_team ? 'cursor:pointer;' : ''}${isPush ? 'opacity:0.45;' : ''}">
            <div class="voted-pick-matchup">
              <div>${matchup} ${v.sport ? sportBadge(v.sport) : ''}</div>
              <div class="voted-pick-sub">${statusStr}</div>
            </div>
            <div class="voted-pick-slot" style="display:flex;align-items:center;">${slotLabel}${deleteBtn}</div>
            <div class="voted-pick-score" style="color:${heatColor};">${score}</div>
            <div class="voted-pick-result">${resultStr}</div>
          </div>`;
      }).join('');

  // Brand-new tracker: explain what the zeroed cards mean and hand them the first step.
  const emptyIntro = (items.length === 0 && pend === 0)
    ? `<div class="card account-reveal" style="margin-bottom:20px;padding:22px 20px;text-align:center;">
        <div style="font-size:15px;font-weight:700;margin-bottom:4px;">Track your first bet to start your record</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:14px;">Tap a line on any game to track it verified, or log a custom bet. Your stats, record, and P/L graph build from there.</div>
        <button class="track-submit" style="width:auto;padding:11px 20px;" onclick="openTrackSheet()"><i class="fa-solid fa-plus" style="margin-right:7px;"></i>Track a Bet</button>
      </div>`
    : '';

  el.innerHTML = `
    ${emptyIntro}
    <div class="nu-row account-reveal" id="track-nu">${netUnitsCardsHtml(items)}</div>
    <div class="perf-card account-reveal">
      <div class="perf-head">
        <span class="perf-title">Performance</span>
        <select class="perf-range" onchange="setTrackRange(this.value)" aria-label="Performance timeframe">
          <option value="all" selected>All Time</option>
          <option value="month">Last 30</option>
          <option value="week">Last 7</option>
          <option value="today">Today</option>
        </select>
      </div>
      <div class="perf-body" id="track-perf">${performanceHtml(items, pend)}</div>
    </div>
    <div class="track-stats track-extra-grid account-reveal" id="track-extra">${trackExtraHtml(items, clvOf(votes))}</div>
    ${filterBar}
    <div class="account-reveal" style="display:flex;gap:14px;align-items:center;margin-bottom:20px;flex-wrap:wrap;">
      <div class="track-verified-note" style="margin-bottom:0;flex:1;min-width:240px;">
        <span class="tvn-badge" title="A verified pick is a side tracked on a real game at our recorded line. It grades automatically and is the only kind that counts on the leaderboard. Custom bets are personal only." style="cursor:help;">Verified</span>
        <span>Verified picks (a side tracked on a real game) are graded automatically and count on the <span class="ca-link" onclick="showLeaderboardInfo()">leaderboard</span>. Custom bets are personal only.</span>
      </div>
      <button class="track-submit" style="width:auto;white-space:nowrap;padding:11px 18px;" onclick="openTrackSheet()"><i class="fa-solid fa-plus" style="margin-right:7px;"></i>Track a Bet</button>
    </div>

    <div class="account-layout track-wide">
      <div>
        <div class="graph-card account-reveal" style="margin-bottom:20px;">
          <div class="graph-header">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="graph-title">Cumulative P/L</span>
              <div class="theme-toggle" style="padding:2px;">
                <button class="theme-opt active" data-track-metric="dollars" style="padding:4px 11px;" onclick="setTrackMetric('dollars')">$</button>
                <button class="theme-opt" data-track-metric="units" style="padding:4px 11px;" onclick="setTrackMetric('units')">Units</button>
                <button class="theme-opt" data-track-metric="bankroll" style="padding:4px 11px;" onclick="setTrackMetric('bankroll')">Bankroll</button>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:16px;">
              <div class="unit-input-row">
                <span>Unit $</span>
                <input type="number" id="voted-unit-size" value="${unit}" min="1" max="100000"
                       onchange="saveUnitSize(this.value)"
                       style="width:72px;" />
              </div>
              <div>
                <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px;">ALL-TIME P/L</div>
                <div class="graph-pl-label${initStats.netD >= 0 ? ' pos' : ' neg'}" id="voted-pl-total">${initStats.netD >= 0 ? '+' : ''}$${Math.abs(initStats.netD).toFixed(2)}</div>
              </div>
            </div>
          </div>
          <div class="graph-canvas-wrap">
            <canvas id="voted-pl-chart"></canvas>
            <div class="graph-empty" id="track-graph-empty" style="display:none;"></div>
          </div>
          ${items.length > 0 ? `<div class="graph-hint">Dashed blue = flat 1u pace. Red shading = below your running peak.</div>` : ''}
        </div>

        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header">
            <span class="card-title">Win Rate by Odds</span>
            <span style="font-size:12px;color:var(--muted);">vs breakeven</span>
          </div>
          <div style="padding:12px 20px 16px;"><div id="track-bands">${oddsBandsHtml(items)}</div></div>
        </div>

        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header">
            <span class="card-title">Daily P/L</span>
            <span style="font-size:12px;color:var(--muted);">last 12 weeks</span>
          </div>
          <div style="padding:14px 20px 16px;"><div id="track-heatmap">${heatmapHtml(items)}</div></div>
        </div>

        <div class="card account-reveal">
          <div class="card-header">
            <span class="card-title">My Tracked Picks</span>
            <span style="font-size:12px;color:var(--muted);">Pre-game picks can be removed</span>
          </div>
          ${votes.length > 0 ? `
          <div class="voted-picks-scroll">
            <div class="voted-pick-head">
              <span class="voted-pick-matchup">Game</span>
              <span class="voted-pick-slot">My Pick</span>
              <span class="voted-pick-score">Score</span>
              <span class="voted-pick-result">Result</span>
            </div>
            <div id="voted-picks-list">${votesHtml}</div>
          </div>`
          : `<div id="voted-picks-list">${votesHtml}</div>`}
        </div>
      </div>

      <div>
        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header">
            <span class="card-title">Closing Line Value</span>
            <span style="font-size:12px;color:var(--muted);">verified picks</span>
          </div>
          <div style="padding:12px 20px 16px;"><div id="track-clv">${clvCardHtml(clvOf(votes))}</div></div>
        </div>

        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header">
            <span class="card-title">Downside</span>
            <span style="font-size:12px;color:var(--muted);">risk check</span>
          </div>
          <div style="padding:8px 20px 12px;"><div id="track-downside">${downsideHtml(items)}</div></div>
        </div>

        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header">
            <span class="card-title">Breakdown</span>
            <span style="font-size:12px;color:var(--muted);">net units</span>
          </div>
          <div style="padding:12px 20px 16px;">
            <div id="track-breakdown">${breakdownHtml(items)}</div>
          </div>
        </div>

        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header">
            <span class="card-title">Custom Bets</span>
            <span style="font-size:12px;color:var(--muted);">Logged by you · personal</span>
          </div>
          <div style="padding:14px 20px 18px;">
            <div id="track-bets-content"><div class="spinner-wrap" style="padding:14px;"><div class="spinner"></div></div></div>
          </div>
        </div>

        <div class="card account-reveal">
          <div class="card-header">
            <span class="card-title">My Friends</span>
            <span style="font-size:12px;color:var(--muted);">${friends.length ? `Following ${friends.length}` : ''}</span>
          </div>
          <div class="voted-picks-scroll">${friendsHtml}</div>
        </div>
      </div>
    </div>`;

  requestAnimationFrame(() => {
    recomputeTrackStats();      // strip + extra + unified P/L graph (current range)
    setBetsData(bets, data.betsTotal); // custom-bets list from the data we already fetched
    initReveal('tracking-content');
  });
}

// ── Settings view ─────────────────────────────────────────────────────────────
function renderSettings(data) {
  const el = document.getElementById('settings-content');
  const { user, favoriteSports = [], allPicks = [], isPublic, avatarUrl, unitSize, startingBankroll, defaultOdds = 'consensus', myBooks = [] } = data;
  window._myBooks = myBooks;
  const unit = Number(unitSize) > 0 ? Number(unitSize) : 20;
  const bankroll = Number(startingBankroll) || 0;
  const lbPublic = isPublic == null ? true : isPublic === 1 || isPublic === true;
  const theme = (window.getTheme && window.getTheme()) || 'dark';

  const tierLabel = user.subscription_tier === 'free'
    ? `<span class="tier-badge tier-free">Free</span>`
    : `<span class="tier-badge tier-paid">${user.subscription_tier}</span>`;

  const memberSince = user.created_at
    ? new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : '—';

  // Username change cooldown
  let usernameChangeCooldown = '';
  if (user.username_changed_at) {
    const lastChange  = new Date(user.username_changed_at + 'Z');
    const daysSince   = (Date.now() - lastChange.getTime()) / (1000 * 60 * 60 * 24);
    const daysLeft    = Math.ceil(30 - daysSince);
    if (daysLeft > 0) usernameChangeCooldown = `Can change again in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
  }
  const usernameChangeHtml = usernameChangeCooldown
    ? `<div style="font-size:12px;color:var(--muted);margin-top:8px;">${usernameChangeCooldown}</div>`
    : `<div style="display:flex;gap:8px;margin-top:8px;">
        <input type="text" id="change-username-input" placeholder="${user.username || 'Choose a username'}"
               maxlength="20" style="flex:1;font-size:13px;" />
        <button class="btn btn-ghost" style="font-size:13px;padding:6px 12px;" onclick="changeUsername(this)">Save</button>
       </div>
       <div class="form-error" id="change-username-error" style="font-size:12px;margin-top:4px;"></div>
       <div id="change-username-ok" style="font-size:12px;color:var(--green);margin-top:4px;display:none;"></div>`;

  const pillsHtml = ALL_SPORTS.map(s => `
    <div class="sport-pill${favoriteSports.includes(s) ? ' active' : ''}"
         data-sport="${s}" onclick="toggleFavSport(this)">${s}</div>
  `).join('');

  let favPicksHtml = '';
  if (!favoriteSports.length) {
    favPicksHtml = `<div style="padding:16px 20px 12px;font-size:13px;color:var(--muted);">Select sports above and save to see today's top picks here.</div>`;
  } else {
    const filtered = (allPicks || []).filter(p => favoriteSports.includes((p.sport || '').toUpperCase()));
    if (!filtered.length) {
      favPicksHtml = `<div style="padding:16px 20px 12px;font-size:13px;color:var(--muted);">No picks today for ${favoriteSports.join(', ')}.</div>`;
    } else {
      const rows = filtered.slice(0, 10).map(p => {
        const heat = PICK_HEAT_COLOR(p.score || 0);
        const isPush = p.result === 'push';
        const resultColor = p.result === 'win' ? '#4ade80' : p.result === 'loss' ? '#f87171' : 'var(--muted)';
        const resultLabel = p.result === 'win' ? 'W' : p.result === 'loss' ? 'L' : p.result === 'push' ? 'P' : '—';
        const clickAttr = p.espn_game_id
          ? `onclick="openGameModal('${p.espn_game_id}','${p.pick_type}','${(p.team||'').replace(/'/g,"\\'")}')"`
          : '';
        return `<div style="display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid var(--border);font-size:13px;${p.espn_game_id?'cursor:pointer;':''}${isPush?'opacity:0.45;':''}" ${clickAttr}>
          <div style="flex:1;font-weight:600;">${matchupLabel(p)}
            <div style="font-size:11px;color:var(--muted);font-weight:400;">${scoreDisplay(p)}</div>
          </div>
          <div>${sportBadge(p.sport)}</div>
          <div style="color:var(--muted);font-size:12px;width:90px;">${pickLabel(p)}</div>
          <div style="color:${heat.color};font-weight:700;width:36px;text-align:right;">${p.score ?? '—'}${heat.fire ? ' 🔥' : ''}</div>
          <div style="color:${resultColor};font-weight:700;width:24px;text-align:right;">${resultLabel}</div>
        </div>`;
      }).join('');
      favPicksHtml = `<div class="fav-picks-scroll">${rows}</div>`;
    }
  }

  el.innerHTML = `
    <div class="account-layout">

      <!-- Left column: profile + appearance -->
      <div>
        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header"><span class="card-title">Profile</span></div>
          <div style="padding:4px 20px 12px;">
            <div style="display:flex;align-items:center;gap:14px;padding:8px 0 14px;">
              ${avatarFor(user.username, 56, avatarUrl)}
              <div>
                <label class="btn btn-ghost" style="font-size:12px;padding:6px 12px;cursor:pointer;display:inline-block;">
                  Upload photo
                  <input type="file" accept="image/png,image/jpeg,image/webp" style="display:none;" onchange="uploadAvatar(this)" />
                </label>
                <div style="font-size:11px;color:var(--muted);margin-top:4px;">PNG, JPG, or WebP. Max 2MB.</div>
                <div class="form-error" id="avatar-error" style="font-size:12px;margin-top:2px;"></div>
              </div>
            </div>
            <div class="account-info-row">
              <span class="account-info-label">Username</span>
              <span class="account-info-val" style="font-size:13px;font-weight:600;">${user.username || '<span style="color:var(--muted);">Not set</span>'}</span>
            </div>
            <div class="account-info-row">
              <span class="account-info-label">Email</span>
              <span class="account-info-val" style="font-size:13px;">${user.email}</span>
            </div>
            <div class="account-info-row">
              <span class="account-info-label">Plan</span>
              <span class="account-info-val">${tierLabel}</span>
            </div>
            <div class="account-info-row">
              <span class="account-info-label">Member since</span>
              <span class="account-info-val">${memberSince}</span>
            </div>
            <button class="btn btn-danger" onclick="doLogout()" style="width:100%;margin-top:14px;padding:9px;">Log Out</button>
          </div>
          <div style="padding:0 20px 16px;border-top:1px solid var(--border);margin-top:4px;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding-top:12px;margin-bottom:4px;">Change Username</div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Once per 30 days. Letters, numbers, and underscores only.</div>
            ${usernameChangeHtml}
          </div>
        </div>

        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header"><span class="card-title">Appearance</span></div>
          <div style="padding:16px 20px 18px;">
            <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">Choose how CappingAlpha looks. Dark is the default.</div>
            <div class="theme-toggle">
              <button class="theme-opt${theme === 'dark' ? ' active' : ''}" data-theme-opt="dark" onclick="setTheme('dark')">🌙 Dark</button>
              <button class="theme-opt${theme === 'light' ? ' active' : ''}" data-theme-opt="light" onclick="setTheme('light')">☀ Light</button>
            </div>
          </div>
        </div>

        <div class="card account-reveal">
          <div class="card-header"><span class="card-title">Notifications</span></div>
          <div style="padding:16px 20px 18px;" id="push-card-body">
            <div style="font-size:13px;color:var(--muted);">Checking this device...</div>
          </div>
        </div>
      </div>

      <!-- Right column: tracking config + access + prefs -->
      <div>
        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header"><span class="card-title">Default Odds</span></div>
          <div style="padding:14px 20px 18px;">
            <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">Which odds source to show by default across the site. Limited to the books we pull.</div>
            <div class="odds-source-list">
              ${[['consensus', 'Consensus'], ['draftkings', 'DraftKings'], ['fanduel', 'FanDuel'], ['kalshi', 'Kalshi'], ['polymarket', 'Polymarket']].map(([v, lbl]) => `
                <button class="odds-source${defaultOdds === v ? ' active' : ''}" data-odds="${v}" onclick="saveDefaultOdds('${v}')">
                  <span>${lbl}</span><span class="odds-check">${defaultOdds === v ? '✓' : ''}</span>
                </button>`).join('')}
            </div>
          </div>
        </div>

        <div class="card account-reveal" id="my-books-card" style="margin-bottom:20px;">
          <div class="card-header"><span class="card-title">My Sportsbooks</span></div>
          <div style="padding:16px 20px 18px;">
            <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">Pick the books you actually bet with. They show first when you track a bet and on game page odds.</div>
            ${myBooks.length
              ? `<div class="sport-pill-grid" style="margin-bottom:12px;">${myBooks.map(k => `<div class="sport-pill active" style="cursor:default;">${bookLabel(k)}</div>`).join('')}</div>`
              : `<div style="font-size:13px;color:var(--muted);margin-bottom:12px;">No books selected yet.</div>`}
            <button class="sport-pill-save" onclick="openBookPicker()">${myBooks.length ? 'Manage my books' : 'Select your sportsbooks'}</button>
          </div>
        </div>

        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header"><span class="card-title">Bankroll &amp; Units</span></div>
          <div style="padding:16px 20px 18px;">
            <div style="font-size:13px;color:var(--muted);margin-bottom:14px;">Set what one unit is worth so your tracking shows in real dollars. Units keep your performance comparable no matter your bankroll size.</div>
            <div class="settings-field">
              <label for="settings-unit-size">Unit size (1 unit =)</label>
              <div class="field-prefix-wrap">
                <span class="field-prefix">$</span>
                <input type="number" id="settings-unit-size" value="${unit}" min="1" max="100000" step="1" />
              </div>
            </div>
            <div class="settings-field">
              <label for="settings-bankroll">Starting bankroll (optional)</label>
              <div class="field-prefix-wrap">
                <span class="field-prefix">$</span>
                <input type="number" id="settings-bankroll" value="${bankroll}" min="0" step="1" />
              </div>
              <div class="field-hint">Used as the starting point for bankroll-over-time tracking (coming soon).</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:4px;">
              <button class="sport-pill-save" onclick="saveBankroll(this)">Save</button>
              <span class="sport-pill-saved" id="bankroll-saved" style="display:none;">Saved!</span>
            </div>
          </div>
        </div>

        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header">
            <span class="card-title">${user.subscription_tier === 'free' ? 'Access Code' : 'Access Status'}</span>
          </div>
          <div style="padding:14px 20px 18px;">
            ${accessStatusWidget(user)}
          </div>
        </div>

        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header"><span class="card-title">Favorite Sports</span></div>
          <div style="padding:16px 20px 18px;">
            <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">Pick your sports to filter your personal feed.</div>
            <div class="sport-pill-grid" id="fav-sport-pills">${pillsHtml}</div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:12px;">
              <button class="sport-pill-save" onclick="saveFavSports(this)">Save</button>
              <span class="sport-pill-saved" id="fav-saved-msg" style="display:none;">Saved!</span>
            </div>
          </div>
          ${favPicksHtml
            ? `<div style="border-top:1px solid var(--border);">
                 <div style="padding:10px 20px 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);">Today's Top Picks</div>
                 ${favPicksHtml}
               </div>`
            : ''}
        </div>

        <div class="card account-reveal" style="margin-bottom:20px;">
          <div class="card-header"><span class="card-title">Leaderboard</span></div>
          <div style="padding:16px 20px 18px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <div style="flex:1;">
                <div style="font-weight:600;font-size:14px;">${lbPublic ? 'Public profile' : 'Private profile'}</div>
                <div style="font-size:12px;color:var(--muted);margin-top:2px;">${lbPublic
                  ? 'Other members can see your rank, record, and picks on the leaderboard.'
                  : 'You\'re hidden from other members. You can still see your own rank.'}</div>
              </div>
              <button class="sport-pill-save" onclick="toggleAccountPrivacy(${lbPublic ? 'false' : 'true'})">
                ${lbPublic ? 'Make private' : 'Go public'}
              </button>
            </div>
            <span class="sport-pill-saved" id="lb-privacy-saved" style="display:none;margin-top:8px;">Saved!</span>
          </div>
        </div>

        <div class="card account-reveal">
          <div class="card-header"><span class="card-title">Password</span></div>
          <div style="padding:16px 20px 18px;">
            <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">We'll email a secure reset link to <strong style="color:var(--text);">${user.email}</strong>. The link expires after a short time.</div>
            <button class="btn btn-ghost" id="settings-pw-btn" style="font-size:13px;padding:8px 14px;" onclick="sendPasswordReset('${(user.email||'').replace(/'/g,"\\'")}')">Send reset link</button>
            <div id="settings-pw-msg" style="display:none;font-size:12px;color:var(--green);margin-top:8px;"></div>
          </div>
        </div>
      </div>

    </div>`;

  requestAnimationFrame(() => { initReveal('settings-content'); refreshPushCard(); });
}

// Fade + rise each card into view as it scrolls in.
function initReveal(rootId) {
  const cards = document.querySelectorAll(`#${rootId} .account-reveal`);
  if (!cards.length) return;
  if (!('IntersectionObserver' in window)) {
    cards.forEach(c => c.classList.add('in'));
    return;
  }
  const obs = new IntersectionObserver((entries, o) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        o.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  cards.forEach((c, i) => {
    c.style.transitionDelay = `${Math.min(i, 6) * 60}ms`;
    obs.observe(c);
  });
}

// Explainer popup for how the leaderboard works (linked from the verified note).
export function showLeaderboardInfo() {
  let host = document.getElementById('lb-info-host');
  if (!host) { host = document.createElement('div'); host.id = 'lb-info-host'; document.body.appendChild(host); }
  const close = `document.getElementById('lb-info-host').innerHTML=''`;
  host.innerHTML = `
    <div class="track-overlay open" onclick="if(event.target===this){${close}}">
      <div class="track-sheet" role="dialog" aria-modal="true" aria-label="About the leaderboard">
        <div class="track-sheet-head"><span>The leaderboard</span><button class="track-sheet-x" onclick="${close}" aria-label="Close">✕</button></div>
        <div class="track-form" style="padding-top:2px;">
          <p style="font-size:14px;line-height:1.55;margin:0 0 10px;">The leaderboard ranks members by their <b>verified</b> picks.</p>
          <p style="font-size:14px;line-height:1.55;color:var(--muted);margin:0 0 10px;">Every verified pick counts as <b style="color:var(--text);">one unit at the CappingAlpha line</b>, the same number for everyone, so it is a fair, side-by-side comparison no matter your stake or which book you use. Your record and units there track you against every other member.</p>
          <p style="font-size:13px;line-height:1.5;color:var(--muted);margin:0 0 14px;">Custom bets (your own odds, or off-platform bets) are personal only and never touch the leaderboard.</p>
          <button class="track-submit" onclick="${close}; window.switchTab && window.switchTab('leaderboard');">View leaderboard</button>
        </div>
      </div>
    </div>`;
}

// ── Account Set Up checklist — shared by My Tracking + My Profile ─────────────
// Compact AN-style card: slim header + thin bar, top 2 unfinished items visible,
// everything else (incl. completed, grayed) behind View more. Disappears once all
// items are done. The notifications item only renders where push is supported.
function buildSetupCard({ user = {}, avatarUrl = null, favoriteSports = [], myBooks = [], bets = [], votes = [] }) {
  const setupItems = [];
  if ('Notification' in window && 'serviceWorker' in navigator) {
    setupItems.push({ icon: 'fa-regular fa-bell', label: 'Turn on notifications',
      done: Notification.permission === 'granted', go: "switchTab('settings')" });
  }
  setupItems.push(
    { icon: 'fa-solid fa-football', label: 'Set favorite sports',
      done: favoriteSports.length > 0, go: "switchTab('settings')" },
    { icon: 'fa-regular fa-user', label: 'Complete your profile',
      sub: 'Add a username and photo so other members recognize you.',
      done: !!(user.username && avatarUrl), go: "switchTab('settings')" },
    { icon: 'fa-regular fa-circle-check', label: 'Track your first bet',
      done: (bets.length + votes.length) > 0, go: 'openTrackSheet()' },
    { icon: 'fa-solid fa-book-open', label: 'Select your sportsbooks',
      done: myBooks.length > 0, go: 'openBookPicker()' },
  );
  const setupDone = setupItems.filter(i => i.done).length;
  if (setupDone >= setupItems.length) return '';
  const row = i => `
    <div class="setup-item${i.done ? ' done' : ''}"${i.done ? '' : ` onclick="${i.go}"`}>
      <i class="${i.icon} setup-item-icon"></i>
      <div class="setup-item-label">${i.label}${i.sub && !i.done ? `<div class="setup-item-sub">${i.sub}</div>` : ''}</div>
      ${i.done
        ? '<i class="fa-solid fa-circle-check setup-item-check"></i>'
        : '<i class="fa-solid fa-chevron-right setup-item-chev"></i>'}
    </div>`;
  const undone   = setupItems.filter(i => !i.done);
  const finished = setupItems.filter(i => i.done);
  const hidden   = [...undone.slice(2), ...finished];
  return `
    <div class="card account-reveal setup-compact" style="margin-bottom:20px;">
      <div class="setup-head">
        <span class="setup-title">Complete Set Up</span>
        <span class="setup-count">${setupDone} of ${setupItems.length}</span>
      </div>
      <div class="setup-bar-wrap"><div class="setup-bar"><div class="setup-bar-fill" style="width:${Math.max(4, Math.round(setupDone / setupItems.length * 100))}%;"></div><i class="fa-solid fa-trophy setup-bar-trophy"></i></div></div>
      ${undone.slice(0, 2).map(row).join('')}
      ${hidden.length ? `
        <div id="setup-more" style="display:none;">${hidden.map(row).join('')}</div>
        <button type="button" class="setup-viewmore" id="setup-viewmore" onclick="toggleSetupMore()">View more <i class="fa-solid fa-chevron-down" style="font-size:9px;"></i></button>` : ''}
    </div>`;
}

// ── My Profile (AN-style) — header stats + quick actions + setup + today ──────
export async function loadProfile() {
  const el = document.getElementById('profile-content');
  if (!el) return;
  el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const accountRes = await fetch('/api/account');
    if (accountRes.status === 401) { window.switchTab('home'); window.openLogin(); return; }
    const account = await accountRes.json();
    const [memberRes, betsRes] = await Promise.all([
      fetch(`/api/member/${account.user.id}?window=all`),
      fetch('/api/bets?limit=300'),
    ]);
    const member   = memberRes.ok ? await memberRes.json() : null;
    const betsData = betsRes.ok ? await betsRes.json() : {};
    renderProfile(account, member, betsData.bets || []);
  } catch (err) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">⚠</div><h3>Failed to load profile</h3><p>${err.message}</p></div>`;
  }
}

function renderProfile(account, member, bets) {
  const el = document.getElementById('profile-content');
  if (!el) return;
  const { user = {}, avatarUrl = null, favoriteSports = [], myBooks = [], votes = [], unitSize } = account;
  const mu    = member?.user  || {};
  const stats = member?.stats || {};
  const name  = user.username || (user.email || '').split('@')[0] || 'Member';

  // Recent Performance (last 7 days, verified + custom) — opens the Current Streak page.
  const pUnit = Number(unitSize) > 0 ? Number(unitSize) : 20;
  const rs = statsOf(buildItems(votes, bets, pUnit).filter(i => i.ts >= Date.now() - 7 * 864e5));

  const totalBets = bets.length + (votes || []).length;
  const units     = stats.units != null ? Number(stats.units) : 0;
  const unitsStr  = `${units > 0 ? '+' : ''}${units.toFixed(1)}u`;
  const unitsCls  = units > 0 ? 'green' : units < 0 ? 'red' : '';

  const todayEt   = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayBets = bets.filter(b => String(b.game_date || b.created_at || '').slice(0, 10) === todayEt);

  el.innerHTML = `
    <div class="pf-head account-reveal">
      ${avatarFor(name, 72, avatarUrl)}
      <div class="pf-id">
        <div class="pf-name">${name}</div>
        ${user.username ? '' : `<div class="pf-name-hint">Set a username in Settings so other members recognize you.</div>`}
      </div>
      <button class="pf-gear" onclick="switchTab('settings')" aria-label="Settings"><i class="fa-solid fa-gear"></i></button>
    </div>
    <div class="pf-stats account-reveal">
      <div class="pf-stat"><b>${totalBets}</b><span>Total Bets</span></div>
      <div class="pf-stat"><b class="${unitsCls}">${unitsStr}</b><span>Units</span></div>
      <div class="pf-stat"><b>${mu.followers ?? 0}</b><span>Followers</span></div>
      <div class="pf-stat"><b>${mu.following ?? 0}</b><span>Following</span></div>
    </div>
    <div class="pf-actions account-reveal">
      <button class="pf-action-btn" onclick="switchTab('tracking')"><i class="fa-solid fa-chart-line"></i> Bet History</button>
      <button class="pf-action-btn" onclick="openBookPicker()"><i class="fa-solid fa-book-open"></i> My Sportsbooks</button>
    </div>
    ${buildSetupCard({ user, avatarUrl, favoriteSports, myBooks, bets, votes })}
    <div class="card account-reveal pf-today">
      <div class="pf-today-head">
        <span class="pf-today-count">Today: <b>${todayBets.length}</b> bet${todayBets.length === 1 ? '' : 's'}</span>
        <button class="track-submit pf-trackbtn" onclick="openTrackSheet()"><i class="fa-solid fa-plus" style="margin-right:6px;"></i>Track Bet</button>
      </div>
      ${todayBets.length ? '' : `<div class="pf-today-empty">Bets you track today will appear here.</div>`}
    </div>
    <div class="card account-reveal pf-mystats" onclick="openRecordView('streak')">
      <div class="pf-recent-left">
        <span>Recent Performance</span>
        <span class="pf-recent-sub">Total Return: <b class="${rs.netD > 0 ? 'green' : rs.netD < 0 ? 'red' : ''}">${rs.netD >= 0 ? '+' : '-'}$${Math.abs(rs.netD).toFixed(2)}</b> · Last 7: ${rs.wins}-${rs.losses}-${rs.pushes}</span>
      </div>
      <span class="pf-mystats-cta">Current Streak ›</span>
    </div>`;
  requestAnimationFrame(() => initReveal('profile-content'));
}

// Expand/collapse the hidden tail of the Complete Set Up card.
function toggleSetupMore() {
  const more = document.getElementById('setup-more');
  const btn  = document.getElementById('setup-viewmore');
  if (!more) return;
  const opening = more.style.display === 'none';
  more.style.display = opening ? '' : 'none';
  if (btn) btn.innerHTML = opening
    ? 'View less <i class="fa-solid fa-chevron-up" style="font-size:9px;"></i>'
    : 'View more <i class="fa-solid fa-chevron-down" style="font-size:9px;"></i>';
}

Object.assign(window, {
  deleteVote, toggleFavSport, saveFavSports, drawVotedPlGraph, changeUsername,
  toggleAccountPrivacy, uploadAvatar, saveUnitSize, saveBankroll, sendPasswordReset,
  loadTracking, loadSettings, setTrackRange, recomputeTrackStats, saveDefaultOdds, setTrackMetric,
  showLeaderboardInfo, setTrackFilter, togglePush, toggleSetupMore,
  openRecordView, closeRecordView, recSetWindow, recToggleFilters, recSetFilter, shareRecord,
});
