// modules/leaderboard.js — Leaderboard tab
// Ranks members by units won on their voted picks. CappingAlpha (the house) is
// always present and highlighted; clicking it jumps to the MVP Picks tab. Member
// rows / podium / cards open the profile popup. A privacy toggle sits at the top.

import { state } from './state.js';
import { avatarFor, sportBadge } from './utils.js';

const WINDOWS = [['week', 'This Week'], ['month', 'This Month'], ['all', 'All-Time']];

let _data = null;          // last-rendered leaderboard payload (for re-sorting)
let _me = null;            // last "me" payload (drives the privacy toggle in the controls row)
let _sortKey = null;       // null → server rank order; else a column key
let _sortDir = -1;         // -1 desc, +1 asc
const SORT_DEFAULT_DESC = { record: true, win_pct: true, units: true, roi: true, rank: false };

function unitsHtml(u, big) {
  const n = Number(u || 0);
  const cls = n >= 0 ? 'pos' : 'neg';
  return `<span class="lb-units ${cls}"${big ? ' style="font-size:inherit;"' : ''}>${n >= 0 ? '+' : ''}${n.toFixed(2)}u</span>`;
}
function unitsStr(u) {
  const n = Number(u || 0);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}u`;
}
function fmtPct(p) { return p == null ? '—' : `${Math.round(p)}%`; }
function fmtRoi(r) { return r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(1)}%`; }
function record(r) { return `${r.wins}-${r.losses}${r.pushes ? '-' + r.pushes : ''}`; }
function rankMedal(rank) {
  if (rank === 1) return ' 🥇';
  if (rank <= 5) return ' 🥈';
  if (rank <= 10) return ' 🥉';
  return '';
}
// Gray lock shown on the caller's OWN row when their account is private. Only the
// owner is ever sent this row, so the lock means "you still hold this spot, but
// it's hidden from everyone else."
function privacyLock(r) {
  if (!(r.is_me && r.is_public === 0)) return '';
  return ` <i class="fa-solid fa-lock" style="color:var(--muted);font-size:10px;" title="Hidden from the public leaderboard. Only you can see your spot here."></i>`;
}
// Click target for a row: house → MVP tab, member → profile popup (scoped to the
// window being viewed so the popup shows that window's record + chart).
function rowClick(r, window) {
  return r.is_house ? `switchTab('mvp')` : `openMemberModal(${r.user_id}, '${window}')`;
}

export async function loadLeaderboard(window) {
  if (window) state.leaderboardWindow = window;
  state.leaderboardView = 'board';
  const win = state.leaderboardWindow;
  const content = document.getElementById('lb-content');
  // Light up the active controls immediately so a switch feels instant.
  renderControls(win);
  // Only show the spinner on the very first load. On a switch we keep the current
  // board in place until new data arrives, so the page height never collapses.
  const hasBoard = content && content.querySelector('.lb-stat-grid, .empty');
  if (content && !hasBoard) content.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const res = await fetch(`/api/leaderboard?window=${encodeURIComponent(win)}`);
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    renderLeaderboard(data);
  } catch (_) {
    if (content) content.innerHTML = `<div class="empty"><div class="empty-icon">⚠</div><h3>Couldn't load the leaderboard</h3><p>Please try again in a moment.</p></div>`;
  }
}

function renderLeaderboard(data) {
  _me = data.me;
  renderControls(data.window);
  const topEl = document.getElementById('lb-top-week');
  if (topEl) topEl.innerHTML = ''; // folded into the podium now
  renderMeBanner(data.me, data.min_votes);
  renderBody(data);
}

// Board controls: the Week/Month/All-Time switcher with a Friends button to its
// right (logged-in only) that opens the separate Friends page.
function renderControls(activeWin) {
  const el = document.getElementById('lb-window-switch');
  if (!el) return;
  const windows = `<div class="lb-windows">` + WINDOWS.map(([key, label]) =>
    `<button class="lb-win-btn${key === activeWin ? ' active' : ''}" onclick="switchLbWindow('${key}')">${label}</button>`
  ).join('') + `</div>`;
  const friendsBtn = state.currentUser
    ? `<button onclick="showFriends()" style="border:1px solid var(--border);background:var(--surface);color:var(--text);font-family:inherit;font-weight:800;font-size:13.5px;padding:11px 20px;border-radius:999px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:7px;"><i class="fa-solid fa-user-group" style="font-size:12px;color:var(--accent);"></i>Friends</button>`
    : '';
  // 3-column grid: privacy toggle (left) | centered windows | Friends button (right).
  el.innerHTML = `<div class="lb-controls">
    ${privacyCell()}
    ${windows}
    <div class="lb-friends-cell">${friendsBtn}</div>
  </div>`;
}

// Left-side control: a clear public/private switch for logged-in members. Replaces
// the old full-width banner that used to sit above the board. Logged-out users get
// a compact "log in" pill in the same slot.
function privacyCell() {
  if (!state.currentUser) {
    return `<div class="lb-privacy-cell">
      <button class="lb-priv-toggle" onclick="openLogin()" title="Log in to appear on the leaderboard and track your rank.">
        <i class="fa-solid fa-right-to-bracket" style="color:var(--accent);"></i><span>Log in to rank</span>
      </button>
    </div>`;
  }
  const isPublic = _me ? _me.is_public === 1 : true;
  return `<div class="lb-privacy-cell">
    <button class="lb-priv-toggle ${isPublic ? 'is-public' : 'is-private'}" onclick="toggleLbPrivacy(${isPublic ? 'false' : 'true'})"
      title="${isPublic ? 'You appear on the public leaderboard. Tap to hide.' : 'Only you can see your rank. Tap to go public.'}">
      <i class="fa-solid ${isPublic ? 'fa-eye' : 'fa-eye-slash'}"></i>
      <span>${isPublic ? 'Public' : 'Private'}</span>
      <span class="lb-priv-switch"><span class="lb-priv-knob"></span></span>
    </button>
  </div>`;
}

// ── Friends page ──────────────────────────────────────────────────────────────
export function showFriends() {
  if (!state.currentUser) { if (window.openLogin) window.openLogin(); return; }
  state.leaderboardView = 'friends';
  loadFriends();
}
export function showBoard() {
  loadLeaderboard(state.leaderboardWindow);
}

async function loadFriends() {
  const el = document.getElementById('lb-content');
  renderFriendsControls();
  // Friends page has no rank / top-of-week banners.
  ['lb-top-week', 'lb-me-banner'].forEach(id => {
    const n = document.getElementById(id); if (n) n.innerHTML = '';
  });
  if (el) el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const res = await fetch('/api/friends');
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    renderFriendsList(data);
  } catch (_) {
    if (el) el.innerHTML = `<div class="empty"><div class="empty-icon">⚠</div><h3>Couldn't load your friends</h3><p>Please try again.</p></div>`;
  }
}

function renderFriendsControls() {
  const el = document.getElementById('lb-window-switch');
  if (!el) return;
  el.innerHTML = `<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px;">
    <button onclick="showBoard()" style="border:1px solid var(--border);background:var(--surface);color:var(--text);font-family:inherit;font-weight:700;font-size:13px;padding:9px 16px;border-radius:999px;cursor:pointer;white-space:nowrap;"><i class="fa-solid fa-arrow-left" style="font-size:11px;margin-right:6px;"></i>Leaderboard</button>
    <div style="font-size:17px;font-weight:800;">Your Friends</div>
  </div>`;
}

function renderFriendsList(data) {
  const el = document.getElementById('lb-content');
  if (!el) return;
  const friends = data.friends || [];
  if (!friends.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">👥</div><h3>You're not following anyone yet</h3><p>Open any member's profile from the leaderboard and tap Follow. They'll show up here.</p></div>`;
    return;
  }
  const rows = friends.map(f => {
    const mutual = f.mutual ? `<span style="margin-left:7px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#1a1205;background:linear-gradient(135deg,#FFD700,#f0b400);padding:1px 7px;border-radius:999px;vertical-align:middle;">Mutual</span>` : '';
    const priv = f.is_public === 0 ? ` <span style="color:var(--muted);font-size:11px;">· private</span>` : '';
    return `<div onclick="openMemberModal(${f.user_id}, 'all')"
      onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='none'"
      style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;transition:background .12s;">
      ${avatarFor(f.username, 38, f.avatar_url)}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;">@${f.username}${mutual}</div>
        <div style="font-size:12px;color:var(--muted);">${record(f)} · ${fmtPct(f.win_pct)} win${priv}</div>
      </div>
      <div style="text-align:right;">
        ${unitsHtml(f.units)}
        <div style="font-size:11px;color:var(--muted);">${fmtRoi(f.roi)} ROI</div>
      </div>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="card" style="padding:4px 6px;">
    <div style="padding:10px 14px 8px;font-size:12px;color:var(--muted);">Following ${friends.length} member${friends.length === 1 ? '' : 's'} · tap anyone to view their profile</div>
    ${rows}
  </div>`;
}

function renderMeBanner(me, minVotes) {
  const el = document.getElementById('lb-me-banner');
  if (!el) return;
  if (!me) { el.innerHTML = ''; return; }
  const privNote = me.is_public === 0 ? ` <span style="color:var(--muted);font-size:12px;">(hidden from others)</span>` : '';
  if (me.qualified) {
    el.innerHTML = `<div class="lb-banner me">
      <span style="font-weight:700;">Your rank: <span style="color:var(--gold);">#${me.rank}</span>${privNote}</span>
      <div style="margin-left:auto;text-align:right;">
        <div>${unitsHtml(me.units)} · ${fmtRoi(me.roi)} ROI</div>
        <div style="font-size:12px;color:var(--muted);">${record(me)} · ${fmtPct(me.win_pct)}</div>
      </div>
    </div>`;
  } else {
    el.innerHTML = `<div class="lb-banner me">
      <span>You need ${me.needed} more graded vote${me.needed === 1 ? '' : 's'} to join the board (min ${minVotes}).${privNote}</span>
      <div style="margin-left:auto;text-align:right;font-size:12px;color:var(--muted);">${record(me)} so far</div>
    </div>`;
  }
}

function renderBody(data) {
  const el = document.getElementById('lb-content');
  if (!el) return;
  const rows = data.rows || [];
  const members = rows.filter(r => !r.is_house);
  const house = rows.find(r => r.is_house && !r.sport); // combined CappingAlpha
  const leader = members[0];
  const winLabel = data.window === 'week' ? 'This Week' : data.window === 'month' ? 'This Month' : 'All-Time';

  _data = data;
  el.innerHTML = statCards(members, house, leader, winLabel)
    + podium(rows, data.window)
    + `<div id="lb-table-host">${table(rows, data.min_votes, data.window)}</div>`
    + howItWorks();
}

function statCards(members, house, leader, winLabel) {
  const houseCard = house ? `
    <div class="lb-stat-card house">
      <div class="lb-stat-label">CappingAlpha · The Line to Beat</div>
      <div class="lb-stat-val" style="color:${(house.units||0) >= 0 ? 'var(--green)' : 'var(--red)'};">${unitsStr(house.units)}</div>
      <div class="lb-stat-sub">${record(house)} · ${fmtPct(house.win_pct)} · ranked #${house.rank}</div>
    </div>` : '';
  const leaderCard = `
    <div class="lb-stat-card">
      <div class="lb-stat-label">${winLabel} Leader</div>
      <div class="lb-stat-val">${leader ? '@' + leader.username : '—'}</div>
      <div class="lb-stat-sub">${leader ? unitsStr(leader.units) + ' · ' + record(leader) : 'No members ranked yet'}</div>
    </div>`;
  const countCard = `
    <div class="lb-stat-card">
      <div class="lb-stat-label">Ranked Members</div>
      <div class="lb-stat-val">${members.length}</div>
      <div class="lb-stat-sub">${members.length ? 'competing this period' : 'be the first to qualify'}</div>
    </div>`;
  return `<div class="lb-stat-grid">${leaderCard}${houseCard}${countCard}</div>`;
}

function podiumSlot(row, place, window) {
  const placeCls = `lb-podium-${place}`;
  const medal = place === 1 ? '🥇' : place === 2 ? '🥈' : '🥉';
  if (!row) {
    return `<div class="lb-podium-slot ${placeCls} lb-podium-empty">
      <div class="lb-podium-medal">${medal}</div>
      <div class="lb-podium-av">${avatarFor('?', place === 1 ? 56 : 46)}</div>
      <div class="lb-podium-name">Open spot</div>
      <div class="lb-podium-rec">Be the first</div>
    </div>`;
  }
  const av = row.is_house
    ? `<div style="width:${place === 1 ? 56 : 46}px;height:${place === 1 ? 56 : 46}px;border-radius:50%;background:linear-gradient(135deg,#1a2030,#3b82f6);display:inline-flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:15px;">CA</div>`
    : avatarFor(row.username, place === 1 ? 56 : 46);
  const name = row.is_house
    ? `${row.username}<div class="lb-podium-house-tag">Official</div>`
    : `@${row.username}${row.is_me ? ' <span style="color:var(--gold);font-size:11px;">(you)</span>' : ''}${privacyLock(row)}`;
  return `<div class="lb-podium-slot ${placeCls} clickable" onclick="${rowClick(row, window)}">
    <div class="lb-podium-medal">${medal}</div>
    <div class="lb-podium-av">${av}</div>
    <div class="lb-podium-name">${name}</div>
    <div class="lb-podium-units" style="color:${(row.units||0) >= 0 ? 'var(--green)' : 'var(--red)'};">${unitsStr(row.units)}</div>
    <div class="lb-podium-rec">${record(row)} · ${fmtPct(row.win_pct)}</div>
  </div>`;
}

function podium(rows, window) {
  // Visual order: 2nd, 1st (center, raised), 3rd.
  return `<div class="lb-podium">
    ${podiumSlot(rows[1], 2, window)}
    ${podiumSlot(rows[0], 1, window)}
    ${podiumSlot(rows[2], 3, window)}
  </div>`;
}

// Re-orders rows for a clicked column. _sortKey null keeps the server rank order.
function sortedRows(rows) {
  if (!_sortKey) return rows;
  const val = (r) => {
    switch (_sortKey) {
      case 'record':  return r.wins - r.losses;
      case 'win_pct': return r.win_pct == null ? -Infinity : r.win_pct;
      case 'units':   return r.units;
      case 'roi':     return r.roi == null ? -Infinity : r.roi;
      case 'rank':    return r.rank;
      default:        return 0;
    }
  };
  return [...rows].sort((a, b) => (val(a) - val(b)) * _sortDir);
}

function sortArrow(key) {
  if (_sortKey !== key) return '';
  return `<span class="lb-sort-arrow">${_sortDir === 1 ? '▲' : '▼'}</span>`;
}
function th(key, label, leftCls) {
  const active = _sortKey === key ? ' active' : '';
  return `<th class="${leftCls ? 'lb-left ' : ''}sortable${active}" onclick="sortLeaderboard('${key}')">${label}${sortArrow(key)}</th>`;
}

function table(rows, minVotes, window) {
  if (!rows.length) {
    return `<div class="empty"><div class="empty-icon">🏆</div><h3>No ranked members yet</h3><p>Vote on picks and rack up at least ${minVotes} graded votes to claim a spot.</p></div>`;
  }
  const body = sortedRows(rows).map(r => {
    const cls = r.is_house ? 'lb-row lb-house' : `lb-row${r.is_me ? ' lb-me' : ''}`;
    const member = r.is_house
      ? `<div class="lb-member"><div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#1a2030,#3b82f6);display:inline-flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:12px;flex-shrink:0;">CA</div>${r.username}${r.sport ? ' ' + sportBadge(r.sport) : ''} <span class="lb-house-badge">Official</span></div>`
      : `<div class="lb-member">${avatarFor(r.username, 30)} @${r.username}${r.is_me ? ' <span style="color:var(--gold);font-size:11px;">(you)</span>' : ''}${privacyLock(r)}</div>`;
    return `<tr class="${cls}" onclick="${rowClick(r, window)}" title="${r.is_house ? "View the CA Picks" : 'View profile'}">
      <td class="lb-left lb-rank${r.rank === 1 ? ' lb-r1' : ''}">${r.rank}${rankMedal(r.rank)}</td>
      <td class="lb-left">${member}</td>
      <td>${record(r)}</td>
      <td>${fmtPct(r.win_pct)}</td>
      <td>${unitsHtml(r.units)}</td>
      <td>${fmtRoi(r.roi)}</td>
    </tr>`;
  }).join('');

  return `<div class="card" style="padding:6px 14px 10px;">
    <div class="lb-table-scroll">
      <table class="lb-table">
        <thead><tr>
          ${th('rank', '#', true)}
          <th class="lb-left">Member</th>
          ${th('record', 'Record')}
          ${th('win_pct', 'Win %')}
          ${th('units', 'Units')}
          ${th('roi', 'ROI')}
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </div>`;
}

export function sortLeaderboard(key) {
  if (_sortKey === key) _sortDir = -_sortDir;
  else { _sortKey = key; _sortDir = SORT_DEFAULT_DESC[key] ? -1 : 1; }
  const host = document.getElementById('lb-table-host');
  if (host && _data) host.innerHTML = table(_data.rows, _data.min_votes, _data.window);
}

function howItWorks() {
  return `<div class="lb-howto">
    <div class="lb-howto-title">How the rankings work</div>
    <div class="lb-howto-grid">
      <div class="lb-howto-item">
        <div class="lb-howto-ico">📈</div>
        <div><div class="lb-howto-h">Ranked by units</div><div class="lb-howto-p">Every pick you vote on is graded at 1 unit. Underdog wins pay more, so units reward sharp calls, not just volume.</div></div>
      </div>
      <div class="lb-howto-item">
        <div class="lb-howto-ico">✅</div>
        <div><div class="lb-howto-h">Qualify by graded votes</div><div class="lb-howto-p">Place enough graded votes in the window to appear: 7 this week, 10 this month, 25 all-time. Win %, record, and ROI show on every row.</div></div>
      </div>
      <div class="lb-howto-item">
        <div class="lb-howto-ico">🛡️</div>
        <div><div class="lb-howto-h">Beat the CappingAlpha bots</div><div class="lb-howto-p">CappingAlpha bots are our tracked CA picks, overall and per sport. Outrank them to prove you're beating the model.</div></div>
      </div>
      <div class="lb-howto-item">
        <div class="lb-howto-ico">🥇</div>
        <div><div class="lb-howto-h">Earn badges</div><div class="lb-howto-p">Finish a week or month at #1 for gold, top 5 for silver, top 10 for bronze. They stack on your profile.</div></div>
      </div>
    </div>
  </div>`;
}

export function switchLbWindow(w) { loadLeaderboard(w); }

export async function toggleLbPrivacy(makePublic) {
  try {
    await fetch('/api/account/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_public: makePublic }),
    });
  } catch (_) {}
  loadLeaderboard(state.leaderboardWindow);
}

Object.assign(window, { loadLeaderboard, switchLbWindow, toggleLbPrivacy, sortLeaderboard, showFriends, showBoard });
