// modules/member_profile.js — Member profile popup
// Opened from the leaderboard. Mirrors the game detail modal. Shows avatar, the
// record/units/ROI for the window it was opened from, a cumulative P/L chart for
// that window, achievement badges, and recent picks (scrollable, sport-filtered).
// Privacy is enforced server-side (a private member returns 403 to others).

import { state } from './state.js';
import { avatarFor, sportBadge } from './utils.js?v=3';

let _picks = [];           // recent picks for the open profile (for sport filtering)
let _sportFilter = 'all';
let _chart = null;         // Chart.js instance for the P/L line
let _userId = null;        // the member currently open (so the toggle can re-fetch)
let _activeWindow = 'all'; // the timeframe shown in the popup

const WINDOW_LABEL = { week: 'This Week', month: 'This Month', all: 'All-Time' };
const TOGGLE_WINDOWS = [['week', 'Week'], ['month', 'Month'], ['all', 'All-Time']];

const BADGE_TIERS = [
  ['gold',   'gold',   '🥇', 'finished #1'],
  ['silver', 'silver', '🥈', 'finished top 5'],
  ['bronze', 'bronze', '🥉', 'finished top 10'],
];

function teamNick(name) {
  if (!name) return '';
  const w = String(name).trim().split(' ');
  return w[w.length - 1];
}

function pickLabel(p) {
  const h = teamNick(p.home_team), a = teamNick(p.away_team);
  switch (p.pick_slot) {
    case 'home_ml':     return `${h} ML`;
    case 'away_ml':     return `${a} ML`;
    case 'home_spread': return `${h} Spread`;
    case 'away_spread': return `${a} Spread`;
    case 'over':        return p.spread ? `Over ${p.spread}` : 'Over';
    case 'under':       return p.spread ? `Under ${p.spread}` : 'Under';
    default:            return p.pick_slot;
  }
}

function resultChip(r) {
  if (r === 'win')  return `<span class="result-win">W</span>`;
  if (r === 'loss') return `<span class="result-loss">L</span>`;
  if (r === 'push') return `<span class="result-push">P</span>`;
  return `<span style="color:var(--muted);">·</span>`;
}

// Open a member's profile. `window` is the leaderboard timeframe it was clicked
// from — it becomes the highlighted default inside the popup, but the popup has its
// own Week/Month/All-Time toggle so you see the full picture from any entry point.
export async function openMemberModal(userId, window) {
  _userId = userId;
  _activeWindow = window || state.leaderboardWindow || 'all';
  const modal = document.getElementById('member-modal');
  const content = document.getElementById('member-modal-content');
  if (!modal || !content) return;
  destroyChart();
  modal.classList.remove('hidden');
  content.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  await fetchMember();
}

// Re-fetch the open member for the current _activeWindow and re-render. Used both
// on open and when the in-popup timeframe toggle changes.
async function fetchMember() {
  const content = document.getElementById('member-modal-content');
  if (!content || _userId == null) return;
  try {
    const res = await fetch(`/api/member/${_userId}?window=${encodeURIComponent(_activeWindow)}`);
    if (res.status === 403) {
      content.innerHTML = `<div class="empty"><div class="empty-icon">🔒</div><h3>This member is private</h3><p>They've hidden their stats from the leaderboard.</p></div>`;
      return;
    }
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    _picks = data.recentPicks || [];
    _sportFilter = 'all';
    renderMemberProfile(data);
  } catch (_) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">⚠</div><h3>Couldn't load this profile</h3><p>Please try again.</p></div>`;
  }
}

// In-popup timeframe switch. Updates the highlight instantly, then re-fetches that
// window's record + chart + picks for the same member (badges stay all-time).
export function setMemberWindow(window) {
  if (_userId == null || window === _activeWindow) return;
  _activeWindow = window;
  const toggle = document.getElementById('mp-window-toggle');
  if (toggle) toggle.querySelectorAll('button').forEach(b => {
    const on = b.dataset.mw === window;
    b.style.color = on ? '#1a1205' : 'var(--muted)';
    b.style.background = on ? 'linear-gradient(135deg,#FFD700,#f0b400)' : 'none';
  });
  destroyChart();
  fetchMember();
}

function windowToggle(active) {
  const btn = (key, label) => {
    const on = key === active;
    return `<button data-mw="${key}" onclick="setMemberWindow('${key}')" style="flex:1;border:none;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:800;padding:7px 12px;border-radius:999px;transition:all .14s;${on ? 'color:#1a1205;background:linear-gradient(135deg,#FFD700,#f0b400);' : 'color:var(--muted);background:none;'}">${label}</button>`;
  };
  return `<div id="mp-window-toggle" style="display:flex;gap:4px;background:var(--surface2);border:1px solid var(--border);border-radius:999px;padding:4px;margin:16px 0 6px;">
    ${TOGGLE_WINDOWS.map(([k, l]) => btn(k, l)).join('')}
  </div>`;
}

export function closeMemberModal(event) {
  if (event && event.target !== event.currentTarget) return;
  destroyChart();
  const modal = document.getElementById('member-modal');
  if (modal) modal.classList.add('hidden');
  const content = document.getElementById('member-modal-content');
  if (content) content.innerHTML = '';
  _picks = [];
  _userId = null;
}

function destroyChart() {
  if (_chart) { _chart.destroy(); _chart = null; }
}

function followBtnStyle(following) {
  const base = 'padding:8px 18px;border-radius:999px;cursor:pointer;font-family:inherit;font-weight:800;font-size:13px;white-space:nowrap;flex-shrink:0;transition:all .14s;';
  return following
    ? base + 'color:var(--text);background:var(--surface2);border:1px solid var(--border);'
    : base + 'color:#1a1205;background:linear-gradient(135deg,#FFD700,#f0b400);border:none;';
}

// Optimistic local toggle (no re-fetch) so unfollowing a private member you're
// viewing doesn't lock you out of the profile you're looking at.
export async function toggleFollow(userId) {
  if (!state.currentUser) { if (window.openLogin) window.openLogin(); return; }
  const btn = document.getElementById('mp-follow-btn');
  if (!btn) return;
  const following = btn.dataset.following === '1';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/follow/${userId}`, { method: following ? 'DELETE' : 'POST' });
    if (res.ok) {
      const data = await res.json();
      btn.dataset.following = following ? '0' : '1';
      btn.textContent = following ? 'Follow' : 'Following';
      btn.setAttribute('style', followBtnStyle(!following));
      const cnt = document.getElementById('mp-followers-count');
      if (cnt && data.followers != null) cnt.textContent = data.followers;
    }
  } catch (_) {
  } finally {
    btn.disabled = false;
  }
}

function renderMemberProfile(data) {
  const { user, stats, badges, chart } = data;
  const winLabel = WINDOW_LABEL[data.window] || 'All-Time';
  const memberSince = user.created_at
    ? new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : '';
  const unitsCls = (stats.units || 0) >= 0 ? 'var(--green)' : 'var(--red)';
  const unitsStr = `${(stats.units || 0) >= 0 ? '+' : ''}${Number(stats.units || 0).toFixed(2)}u`;

  // Everything that controls position/size is inline + the badge boxes are a fixed
  // height, so a stale cached stylesheet (or an in-flow tooltip) can't shift the
  // empty/0 badge. Three identical 60x78 boxes, top-aligned in a no-wrap row.
  const MEDAL_COLORS = {
    gold:   { c: '#FFD700', bg: 'rgba(255,215,0,0.10)' },
    silver: { c: '#c0c8d4', bg: 'rgba(192,200,212,0.10)' },
    bronze: { c: '#cd7f32', bg: 'rgba(205,127,50,0.12)' },
  };
  const badgeHtml = BADGE_TIERS.map(([key, cls, icon, base]) => {
    const b = badges[key] || { total: 0, week: 0, month: 0 };
    const col = MEDAL_COLORS[cls];
    const dim = b.total ? '' : 'opacity:0.32;';
    const tip = b.total
      ? `${b.total}× ${key} — ${base} (${b.week} weekly, ${b.month} monthly)`
      : `No ${key} yet — ${base} on a weekly or monthly board`;
    return `<div class="mp-badge" style="flex:0 0 60px;height:78px;display:flex;flex-direction:column;align-items:center;gap:5px;position:relative;">
      <div style="width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:19px;line-height:1;border:2px solid ${col.c};color:${col.c};background:${col.bg};${dim}">${icon}</div>
      <div style="font-size:12px;font-weight:800;color:var(--text);line-height:1;">${b.total}</div>
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);line-height:1;">${key}</div>
      <div class="mp-tip">${tip}</div>
    </div>`;
  }).join('');

  const chartHtml = (chart && chart.length)
    ? `<div class="mp-chart-wrap"><canvas id="mp-chart"></canvas></div>`
    : `<div style="padding:14px 0;color:var(--muted);font-size:13px;text-align:center;">No graded picks ${winLabel.toLowerCase() === 'all-time' ? 'yet' : 'in this window'}.</div>`;

  const showFollow = !!state.currentUser && !user.is_me;
  const mutual = user.is_following && user.follows_me;
  const relChip = user.is_me ? ''
    : mutual ? `<span style="margin-left:8px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#1a1205;background:linear-gradient(135deg,#FFD700,#f0b400);padding:2px 7px;border-radius:999px;vertical-align:middle;">Mutual</span>`
    : user.follows_me ? `<span style="margin-left:8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:var(--surface2);border:1px solid var(--border);padding:2px 7px;border-radius:999px;vertical-align:middle;">Follows you</span>` : '';
  const countsLine = `<span id="mp-followers-count">${user.followers || 0}</span> follower${(user.followers || 0) === 1 ? '' : 's'} · ${user.following || 0} following${memberSince ? ' · since ' + memberSince : ''}${user.is_public === 0 ? ' · private' : ''}`;
  const followBtn = showFollow
    ? `<button id="mp-follow-btn" data-following="${user.is_following ? 1 : 0}" onclick="toggleFollow(${user.id})" style="${followBtnStyle(user.is_following)}">${user.is_following ? 'Following' : 'Follow'}</button>`
    : '';

  document.getElementById('member-modal-content').innerHTML = `
    <div style="padding:22px 22px 4px;">
      <div style="display:flex;align-items:center;gap:14px;">
        ${avatarFor(user.username, 56, user.avatar_url)}
        <div style="min-width:0;flex:1;">
          <div style="font-size:20px;font-weight:800;">@${user.username}${user.is_me ? ' <span style="color:var(--gold);font-size:12px;">(you)</span>' : relChip}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">${countsLine}</div>
        </div>
        ${followBtn}
      </div>

      ${windowToggle(data.window)}

      <div style="display:flex;gap:22px;margin-top:6px;flex-wrap:wrap;">
        <div class="record-item"><div class="record-val">${stats.wins}-${stats.losses}${stats.pushes ? '-' + stats.pushes : ''}</div><div class="record-label">Record</div></div>
        <div class="record-item"><div class="record-val gold">${stats.win_pct == null ? '—' : Math.round(stats.win_pct) + '%'}</div><div class="record-label">Win Rate</div></div>
        <div class="record-item"><div class="record-val" style="color:${unitsCls};">${unitsStr}</div><div class="record-label">Units</div></div>
        <div class="record-item"><div class="record-val">${stats.roi == null ? '—' : (stats.roi >= 0 ? '+' : '') + stats.roi.toFixed(1) + '%'}</div><div class="record-label">ROI</div></div>
      </div>

      ${(data.clv && data.clv.n) ? `<div class="mp-clv">
        <div class="mp-clv-pct">${data.clv.pct}% <span>beat the close</span></div>
        <div class="mp-clv-sub">${data.clv.good}/${data.clv.n} graded picks${data.clv.avg_cents != null ? ` · avg ${data.clv.avg_cents >= 0 ? '+' : ''}${data.clv.avg_cents} cents` : ''}. Beating the closing line often signals real edge.</div>
      </div>` : ''}

      <div style="display:flex;flex-wrap:nowrap;justify-content:center;align-items:flex-start;gap:26px;margin:16px 0 4px;">${badgeHtml}</div>

      <div class="mp-section-label" style="margin-top:14px;">${winLabel} P/L</div>
      ${chartHtml}
    </div>

    <div style="padding:8px 22px 20px;border-top:1px solid var(--border);">
      <div class="mp-section-label" style="margin-top:12px;">Recent Picks</div>
      ${buildSportFilter()}
      <div class="mp-picks-scroll" id="mp-picks-list"></div>
    </div>`;

  renderPicksList();
  if (chart && chart.length) requestAnimationFrame(() => drawChart(chart));
}

function buildSportFilter() {
  const sports = Array.from(new Set(_picks.map(p => (p.sport || '').toUpperCase()).filter(Boolean)));
  if (sports.length <= 1) return '';
  return `<div class="mp-sport-filter" id="mp-sport-filter">
    <span class="mp-sport-pill active" data-sport="all" onclick="filterMemberPicks('all')">All</span>
    ${sports.map(s => `<span class="mp-sport-pill" data-sport="${s}" onclick="filterMemberPicks('${s}')">${s}</span>`).join('')}
  </div>`;
}

function drawChart(points) {
  const canvas = document.getElementById('mp-chart');
  if (!canvas || !window.Chart) return;
  const last = points.length ? points[points.length - 1].cum : 0;
  const color = last >= 0 ? '#4ade80' : '#f87171';
  destroyChart();
  _chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: points.map(p => `Pick ${p.i}`),
      datasets: [{
        data: points.map(p => p.cum),
        borderColor: color,
        backgroundColor: color + '20',
        borderWidth: 2,
        pointRadius: points.length > 30 ? 0 : 3,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => `Pick ${points[items[0].dataIndex]?.i}`,
            label: item => {
              const p = points[item.dataIndex];
              const sign = p.ret >= 0 ? '+' : '';
              return [`Total: ${item.raw >= 0 ? '+' : ''}${item.raw.toFixed(2)}u`, `This pick: ${sign}${p.ret.toFixed(2)}u (${p.result})`];
            },
          },
        },
      },
      scales: {
        x: { display: false },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8892a4', callback: v => (v > 0 ? '+' : '') + v + 'u' } },
      },
    },
  });
}

function renderPicksList() {
  const el = document.getElementById('mp-picks-list');
  if (!el) return;
  const picks = _sportFilter === 'all'
    ? _picks
    : _picks.filter(p => (p.sport || '').toUpperCase() === _sportFilter);

  if (!picks.length) {
    el.innerHTML = `<div style="padding:18px 0;color:var(--muted);font-size:13px;">No picks to show.</div>`;
    return;
  }

  el.innerHTML = picks.map(p => {
    const matchup = p.home_team ? `${teamNick(p.away_team)} @ ${teamNick(p.home_team)}` : `Game ${p.espn_game_id}`;
    const u = Number(p.units || 0);
    const uCls = u >= 0 ? 'var(--green)' : 'var(--red)';
    const uStr = p.result === 'win' || p.result === 'loss' ? `${u >= 0 ? '+' : ''}${u.toFixed(2)}u` : '';
    return `<div class="mp-pick-row">
      <div style="flex-shrink:0;">${p.sport ? sportBadge(p.sport) : ''}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${pickLabel(p)}</div>
        <div style="font-size:11px;color:var(--muted);">${matchup}</div>
      </div>
      <div style="width:60px;text-align:right;color:${uCls};font-weight:700;font-size:12px;">${uStr}</div>
      <div style="width:24px;text-align:right;">${resultChip(p.result)}</div>
    </div>`;
  }).join('');
}

export function filterMemberPicks(sport) {
  _sportFilter = sport;
  document.querySelectorAll('#mp-sport-filter .mp-sport-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.sport === sport));
  renderPicksList();
}

// Close on Escape, matching the game modal behavior.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('member-modal');
    if (modal && !modal.classList.contains('hidden')) closeMemberModal();
  }
});

Object.assign(window, { openMemberModal, closeMemberModal, filterMemberPicks, setMemberWindow, toggleFollow });
