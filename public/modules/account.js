// modules/account.js — "My Tracking" + "Settings" views (split from the old My Account tab)

import { state } from './state.js';
import { sportBadge, matchupLabel, scoreDisplay, pickLabel, PICK_HEAT_COLOR, calcVoteReturn, avatarFor } from './utils.js?v=1';
import { doRedeemCode } from './paywall.js';
import { loadUserBets, setBetsData } from './track.js?v=19';

const ALL_SPORTS = ['MLB', 'NBA', 'WNBA', 'NHL', 'NFL', 'NCAAF', 'CBB', 'ATP', 'WTA', 'Golf'];

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
    const data    = await accountRes.json();
    const friends = friendsRes.ok ? (await friendsRes.json()).friends || [] : [];
    const bets    = betsRes.ok ? (await betsRes.json()).bets || [] : [];
    renderTracking({ ...data, friends, bets });
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

export async function saveFavSports() {
  const pills  = document.querySelectorAll('#fav-sport-pills .sport-pill');
  const sports = Array.from(pills).filter(p => p.classList.contains('active')).map(p => p.dataset.sport);
  const msgEl  = document.getElementById('fav-saved-msg');
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
export async function saveBankroll() {
  const unitEl = document.getElementById('settings-unit-size');
  const brEl   = document.getElementById('settings-bankroll');
  const msgEl  = document.getElementById('bankroll-saved');
  const unit_size        = parseFloat(unitEl?.value) || 20;
  const starting_bankroll = parseFloat(brEl?.value)   || 0;
  try {
    const res = await fetch('/api/account/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit_size, starting_bankroll }),
    });
    if (res.ok && msgEl) { msgEl.style.display = ''; setTimeout(() => { msgEl.style.display = 'none'; }, 1800); }
  } catch (_) {}
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

async function changeUsername() {
  const input  = document.getElementById('change-username-input');
  const errEl  = document.getElementById('change-username-error');
  const okEl   = document.getElementById('change-username-ok');
  const newName = (input?.value || '').trim();
  errEl.textContent = '';
  okEl.style.display = 'none';
  if (!newName) { errEl.textContent = 'Enter a username.'; return; }
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
  let good = 0, bad = 0, n = 0;
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
    n++; if (d > 0) good++; else if (d < 0) bad++;
  }
  return { n, good, bad, pct: n ? Math.round(100 * good / n) : null };
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
function buildItems(votes, bets, unit) {
  const items = [];
  for (const v of (votes || [])) {
    const r = (v.result || '').toLowerCase();
    if (r === 'win' || r === 'loss' || r === 'push') {
      const u = calcVoteReturn(v, 1);
      items.push({ units: u, dollars: +(u * unit).toFixed(2), riskedD: unit, result: r, ts: tsOf(v.voted_at), sport: (v.sport || '').toUpperCase() || 'Other', type: slotType(v.pick_slot) });
    }
  }
  for (const b of (bets || [])) {
    const r = (b.result || '').toLowerCase();
    if (r === 'win' || r === 'loss' || r === 'push') {
      const d = b.payout != null ? b.payout : 0;
      items.push({ units: unit > 0 ? d / unit : 0, dollars: d, riskedD: b.stake || 0, result: r, ts: tsOf(b.settled_at || b.placed_at), sport: (b.sport || '').toUpperCase() || 'Other', type: betType(b.bet_type) });
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
  return `
    <div class="brk-section">By sport</div>${rows(breakdownBy(items, 'sport'), true)}
    <div class="brk-section" style="margin-top:10px;">By bet type</div>${rows(breakdownBy(items, 'type'), false)}`;
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
// Cumulative P/L from the unified items (sorted by time), in the chosen metric.
let trackChart = null;
let _trackMetric = 'dollars'; // 'dollars' | 'units'
function fmtMetric(v) { return _trackMetric === 'units' ? (v >= 0 ? '+' : '') + v.toFixed(2) + 'u' : (v >= 0 ? '+' : '') + '$' + v.toFixed(2); }
function drawTrackGraph(items) {
  const canvas = document.getElementById('voted-pl-chart');
  const label  = document.getElementById('voted-pl-total');
  if (!canvas) return;
  const sorted = items.slice().sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) {
    if (label) { label.textContent = _trackMetric === 'units' ? '0.00u' : '$0.00'; label.className = 'graph-pl-label'; }
    if (trackChart) { trackChart.destroy(); trackChart = null; }
    return;
  }
  const field = _trackMetric === 'units' ? 'units' : 'dollars';
  let cum = 0;
  const pts = sorted.map(it => { cum = +(cum + it[field]).toFixed(4); return +cum.toFixed(2); });
  const total = pts[pts.length - 1];
  if (label) { label.textContent = fmtMetric(total); label.className = 'graph-pl-label ' + (total >= 0 ? 'pos' : 'neg'); }
  const css = getComputedStyle(document.documentElement);
  const tick = (css.getPropertyValue('--muted').trim()) || '#8892a4';
  const grid = (css.getPropertyValue('--grid-line').trim()) || 'rgba(255,255,255,0.05)';
  const line = total >= 0 ? '#4ade80' : '#f87171';
  const unitSuffix = _trackMetric === 'units' ? 'u' : '';
  const dollarPrefix = _trackMetric === 'units' ? '' : '$';
  if (trackChart) { trackChart.destroy(); trackChart = null; }
  trackChart = new Chart(canvas, {
    type: 'line',
    data: { labels: pts.map((_, i) => i + 1), datasets: [{ data: pts, borderColor: line, backgroundColor: line + '18', borderWidth: 2, pointRadius: pts.length > 40 ? 0 : 4, pointHoverRadius: 6, fill: true, tension: 0.2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: () => '', label: i => fmtMetric(Number(i.raw)) } } },
      scales: { x: { display: false }, y: { grid: { color: grid }, ticks: { color: tick, callback: v => dollarPrefix + v + unitSuffix } } },
    },
  });
}
export function setTrackMetric(m) {
  _trackMetric = (m === 'units') ? 'units' : 'dollars';
  document.querySelectorAll('[data-track-metric]').forEach(b => b.classList.toggle('active', b.dataset.trackMetric === _trackMetric));
  recomputeTrackStats();
}
export function recomputeTrackStats() {
  const votes = window._trackingVotes || [];
  const bets  = window._trackingBets || [];
  const unit  = Number(window._trackUnitSize) > 0 ? Number(window._trackUnitSize) : 20;
  const all   = buildItems(votes, bets, unit);
  const items = itemsInRange(all, _trackRange);
  const pend  = pendingCount(votes, bets);
  const strip = document.getElementById('track-strip');
  if (strip) strip.innerHTML = trackStripHtml(items, pend);
  const extra = document.getElementById('track-extra');
  if (extra) extra.innerHTML = trackExtraHtml(items, clvOf(votesInRange(votes, _trackRange)));
  const brk = document.getElementById('track-breakdown');
  if (brk) brk.innerHTML = breakdownHtml(items);
  drawTrackGraph(items);
}
export function setTrackRange(r) {
  _trackRange = r;
  document.querySelectorAll('[data-track-range]').forEach(b => b.classList.toggle('active', b.dataset.trackRange === r));
  recomputeTrackStats();
}

// ── My Tracking view ──────────────────────────────────────────────────────────
function renderTracking(data) {
  const el = document.getElementById('tracking-content');
  const { votes = [], friends = [], bets = [], unitSize } = data;
  const unit = Number(unitSize) > 0 ? Number(unitSize) : 20;

  // Unified personal series: verified votes + settled custom bets.
  const items = buildItems(votes, bets, unit);
  const pend  = pendingCount(votes, bets);
  const initStats = statsOf(items);

  // Stash for live recompute (timeframe pills, unit input, after a bet mutation).
  window._trackingVotes  = votes;
  window._trackingBets   = bets;
  window._trackUnitSize  = unit;

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

  el.innerHTML = `
    <div class="track-range-row account-reveal">
      ${[['today', 'Today'], ['week', 'Last 7'], ['month', 'Last 30'], ['all', 'All time']].map(([r, lbl]) =>
        `<button class="track-range-btn${r === 'all' ? ' active' : ''}" data-track-range="${r}" onclick="setTrackRange('${r}')">${lbl}</button>`).join('')}
    </div>
    <div class="track-stats account-reveal" id="track-strip">${trackStripHtml(items, pend)}</div>
    <div class="track-stats track-extra-grid account-reveal" id="track-extra">${trackExtraHtml(items, clvOf(votes))}</div>

    <div class="account-reveal" style="display:flex;gap:14px;align-items:center;margin-bottom:20px;flex-wrap:wrap;">
      <div class="track-verified-note" style="margin-bottom:0;flex:1;min-width:240px;">
        <span class="tvn-badge" title="A verified pick is a side tracked on a real game at our recorded line. It grades automatically and is the only kind that counts on the leaderboard. Custom bets are personal only." style="cursor:help;">Verified</span>
        <span>Verified picks (a side tracked on a real game) are graded automatically and count on the leaderboard. Custom bets are personal only.</span>
      </div>
      <button class="track-submit" style="width:auto;white-space:nowrap;padding:11px 18px;" onclick="openTrackSheet()"><i class="fa-solid fa-plus" style="margin-right:7px;"></i>Track a Bet</button>
    </div>

    <div class="account-layout">
      <div>
        <div class="graph-card account-reveal" style="margin-bottom:20px;">
          <div class="graph-header">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="graph-title">Cumulative P/L</span>
              <div class="theme-toggle" style="padding:2px;">
                <button class="theme-opt active" data-track-metric="dollars" style="padding:4px 11px;" onclick="setTrackMetric('dollars')">$</button>
                <button class="theme-opt" data-track-metric="units" style="padding:4px 11px;" onclick="setTrackMetric('units')">Units</button>
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
          </div>
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
    setBetsData(bets);          // custom-bets list from the data we already fetched
    initReveal('tracking-content');
  });
}

// ── Settings view ─────────────────────────────────────────────────────────────
function renderSettings(data) {
  const el = document.getElementById('settings-content');
  const { user, favoriteSports = [], allPicks = [], isPublic, avatarUrl, unitSize, startingBankroll, defaultOdds = 'consensus' } = data;
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
        <button class="btn btn-ghost" style="font-size:13px;padding:6px 12px;" onclick="changeUsername()">Save</button>
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
          <div style="padding:16px 20px 18px;">
            <div style="font-size:13px;color:var(--muted);">Alerts for game results, pick grades, and your tracked bets. <span style="color:var(--text);font-weight:600;">Coming soon.</span></div>
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
              <button class="sport-pill-save" onclick="saveBankroll()">Save</button>
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
              <button class="sport-pill-save" onclick="saveFavSports()">Save</button>
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

  requestAnimationFrame(() => initReveal('settings-content'));
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

Object.assign(window, {
  deleteVote, toggleFavSport, saveFavSports, drawVotedPlGraph, changeUsername,
  toggleAccountPrivacy, uploadAvatar, saveUnitSize, saveBankroll, sendPasswordReset,
  loadTracking, loadSettings, setTrackRange, recomputeTrackStats, saveDefaultOdds, setTrackMetric,
});
