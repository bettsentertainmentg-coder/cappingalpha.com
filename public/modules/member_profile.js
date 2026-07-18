// modules/member_profile.js — Member profile popup
// Opened from the leaderboard. Mirrors the game detail modal. Shows avatar, the
// record/units/ROI for the window it was opened from, a cumulative P/L chart for
// that window, achievement badges, and recent picks (scrollable, sport-filtered).
// Privacy is enforced server-side (a private member returns 403 to others).
//
// The SAME popup also serves the CappingAlpha sport profiles (openSportProfile):
// clicking a "CappingAlpha MLB" bot on the leaderboard, or a sport card's
// Profile button on the CA Rankings tab, renders the house record for that sport
// through this exact layout (CA avatar, no follow button, no member badges).

import { state } from './state.js';
import { avatarFor, sportBadge, pickLabel as typePickLabel, teamNickname, currentBoardDate, fmtOdds, fmtSpread } from './utils.js?v=4';

let _picks = [];           // recent picks for the open profile (for sport filtering)
let _sportFilter = 'all';
let _chart = null;         // Chart.js instance for the P/L line
let _userId = null;        // the member currently open (so the toggle can re-fetch)
let _houseSport = null;    // non-null = CA sport profile mode ('MLB', 'Tennis', 'all', ...)
let _activeWindow = 'all'; // the timeframe shown in the popup
let _chartPts = [];        // house chart: the full all-time point series (for the range dd)
let _mpRange = 'ALL';      // house chart timeframe (client-side filter on _chartPts)
let _social = null;        // Socials extras for the open member (calendar, true history)
let _ledgerMode = 'ver';   // 'ver' verified board record | 'true' real-stakes history

const WINDOW_LABEL = { week: 'This Week', month: 'This Month', all: 'All-Time' };
const TOGGLE_WINDOWS = [['week', 'Week'], ['month', 'Month'], ['all', 'All-Time']];

const BADGE_TIERS = [
  ['gold',   'gold',   '🥇', 'finished #1'],
  ['silver', 'silver', '🥈', 'finished top 5'],
  ['bronze', 'bronze', '🥉', 'finished top 10'],
];

// Opponent-aware: two sides deriving the same short name (the All-Star squads)
// display their lead part instead — the shared helper handles that rule.
function teamNick(name, opponent) {
  return name ? teamNickname(String(name), opponent ? String(opponent) : undefined) : '';
}

function pickLabel(p) {
  // House (CA) rows carry pick_type/team instead of a vote's pick_slot — route
  // them through the shared board label helper.
  if (!p.pick_slot) return typePickLabel(p);
  const h = teamNick(p.home_team, p.away_team), a = teamNick(p.away_team, p.home_team);
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
  _houseSport = null;
  await openProfileModal(window);
}

// Open the CappingAlpha history for a display sport ('MLB', 'Tennis', ... or
// 'all' for the combined record). Same popup, same layout, house data. Always
// all-time: the house popup has no timeframe toggle.
export async function openSportProfile(sport) {
  _userId = null;
  _houseSport = sport || 'all';
  _mpRange = 'ALL';
  await openProfileModal('all');
}

async function openProfileModal(window) {
  _activeWindow = window || state.leaderboardWindow || 'all';
  const modal = document.getElementById('member-modal');
  const content = document.getElementById('member-modal-content');
  if (!modal || !content) return;
  destroyChart();
  modal.classList.remove('hidden');
  content.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  await fetchMember();
}

// Re-fetch the open profile (member or CA sport) for the current _activeWindow
// and re-render. Used both on open and when the in-popup timeframe toggle changes.
async function fetchMember() {
  const content = document.getElementById('member-modal-content');
  if (!content || (_userId == null && _houseSport == null)) return;
  const url = _houseSport != null
    ? `/api/ca-profile/${encodeURIComponent(_houseSport)}?window=${encodeURIComponent(_activeWindow)}`
    : `/api/member/${_userId}?window=${encodeURIComponent(_activeWindow)}`;
  try {
    const res = await fetch(url);
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
  if ((_userId == null && _houseSport == null) || window === _activeWindow) return;
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

// ── House (CA History) chart timeframe dropdown ───────────────────────────────
// Same look and behavior as the All-Time P/L graph's dropdowns. Filters the
// already-fetched all-time series client-side by each point's game date and
// rebuilds the cumulative line from $0 inside the window.
const MP_RANGE_OPTIONS = [['1D', 'Today'], ['YD', 'Yesterday'], ['5D', '5 Days'], ['7D', '7 Days'], ['21D', '21 Days'], ['1M', '1 Month'], ['3M', '3 Months'], ['ALL', 'All-Time']];
const MP_RANGE_LABEL = Object.fromEntries(MP_RANGE_OPTIONS);
const MP_RANGE_DAYS = { '5D': 5, '7D': 7, '21D': 21, '1M': 30, '3M': 90 };

function _addDays(s, n) {
  const d = new Date(s + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function _mpWindowPoints() {
  let pts = _chartPts;
  // Sport scope: the recent-picks sport filter (incl. ATP vs WTA) also scopes the
  // chart, so switching sport/tour redraws the graph for that sport.
  if (_sportFilter && _sportFilter !== 'all') {
    pts = pts.filter(p => (p.sport || '').toUpperCase() === _sportFilter);
  }
  // Date window.
  if (_mpRange !== 'ALL') {
    const today = currentBoardDate();
    if (_mpRange === '1D') pts = pts.filter(p => p.d === today);
    else if (_mpRange === 'YD') { const yd = _addDays(today, -1); pts = pts.filter(p => p.d === yd); }
    else { const cut = _addDays(today, -(MP_RANGE_DAYS[_mpRange] || 0)); pts = pts.filter(p => p.d && p.d >= cut); }
  }
  // Cumulative always recomputed from $0 over the filtered set.
  let cum = 0;
  return pts.map((p, idx) => { cum = +(cum + p.ret).toFixed(2); return { ...p, cum, i: idx + 1 }; });
}

// Record/win%/ROI for the CURRENT house timeframe, computed from the windowed
// chart points (each carries result + per-unit ret). Fixes the bug where these
// stayed all-time when the timeframe dropdown changed.
function _mpWindowStats() {
  let w = 0, l = 0, p = 0, u = 0;
  for (const pt of _mpWindowPoints()) {
    if (pt.result === 'win') w++; else if (pt.result === 'loss') l++; else if (pt.result === 'push') p++;
    u += pt.ret || 0;
  }
  const dec = w + l;
  return { wins: w, losses: l, pushes: p, win_pct: dec ? +(100 * w / dec).toFixed(1) : null, roi: dec ? +(100 * u / dec).toFixed(1) : null };
}

// The 4 stat cells for the house profile header (Wins/Losses/Win%/ROI), same
// colors as the #1 ranked pick record bar. Shared by render + timeframe change.
function houseStatsInner(s) {
  return `
    <div class="mp-hstat"><b style="color:var(--green);">${s.wins}</b><span>Wins</span></div>
    <div class="mp-hstat"><b style="color:var(--red);">${s.losses}</b><span>Losses</span></div>
    <div class="mp-hstat"><b style="color:var(--gold-ink);">${s.win_pct == null ? '—' : Math.round(s.win_pct) + '%'}</b><span>Win%</span></div>
    <div class="mp-hstat"><b style="color:${(s.roi ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'};">${s.roi == null ? '—' : (s.roi >= 0 ? '+' : '') + s.roi.toFixed(1) + '%'}</b><span>ROI</span></div>`;
}

const MP_DD_CHEV = `<i class="fa-solid fa-chevron-down" style="font-size:9px;margin-left:4px;"></i>`;

function mpRangeDdHtml() {
  const opts = MP_RANGE_OPTIONS.map(([k, l]) =>
    `<div class="ca-dd-opt${k === _mpRange ? ' active' : ''}" data-val="${k}" onclick="mpPickRange('${k}')">${l}</div>`).join('');
  return `<div class="ca-dd" id="mp-range-dd" style="flex-shrink:0;">
    <button class="ca-dd-btn" onclick="mpToggleRange(event)">${MP_RANGE_LABEL[_mpRange]}${MP_DD_CHEV}</button>
    <div class="ca-dd-list">${opts}</div>
  </div>`;
}

export function mpToggleRange(event) {
  if (event) event.stopPropagation();
  const dd = document.getElementById('mp-range-dd');
  if (!dd) return;
  document.querySelectorAll('.ca-dd.open').forEach(d => { if (d !== dd) d.classList.remove('open'); });
  dd.classList.toggle('open');
  const list = dd.querySelector('.ca-dd-list');
  const active = dd.querySelector('.ca-dd-opt.active');
  if (dd.classList.contains('open') && list && active) {
    list.scrollTop = Math.max(0, active.offsetTop - list.clientHeight / 2 + active.offsetHeight / 2);
  }
}

export function mpPickRange(key) {
  _mpRange = key;
  document.querySelectorAll('.ca-dd.open').forEach(d => d.classList.remove('open'));
  const dd = document.getElementById('mp-range-dd');
  if (dd) {
    const btn = dd.querySelector('.ca-dd-btn');
    if (btn) btn.innerHTML = MP_RANGE_LABEL[key] + MP_DD_CHEV; // keep the chevron
    dd.querySelectorAll('.ca-dd-opt').forEach(o => o.classList.toggle('active', o.dataset.val === key));
  }
  const title = document.getElementById('mp-pl-title');
  if (title) title.textContent = `${MP_RANGE_LABEL[key]} P/L`;
  // BUG FIX: recompute the record/win%/ROI for the chosen window (they used to
  // stay stuck on all-time when the timeframe changed).
  const hs = document.querySelector('.mp-hstats');
  if (hs) hs.innerHTML = houseStatsInner(_mpWindowStats());
  drawChart(_mpWindowPoints(), true);
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
  _houseSport = null;
}

function destroyChart() {
  if (window.caResetTip) window.caResetTip(); // clear any tooltip pinned to this chart
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
  const isHouse = !!data.house;
  if (isHouse) _chartPts = chart || [];
  _social = data.social || null;
  _ledgerMode = 'ver';
  const winLabel = WINDOW_LABEL[data.window] || 'All-Time';
  const sinceRaw = user.created_at
    ? (user.created_at.includes('T') || user.created_at.includes(' ') ? user.created_at : user.created_at + 'T12:00:00')
    : null;
  const memberSince = sinceRaw
    ? new Date(sinceRaw).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
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

  const showFollow = !isHouse && !!state.currentUser && !user.is_me;
  const mutual = user.is_following && user.follows_me;
  const relChip = isHouse
    ? `<span style="margin-left:8px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#1a1205;background:linear-gradient(135deg,#FFD700,#f0b400);padding:2px 7px;border-radius:999px;vertical-align:middle;">Official</span>`
    : user.is_me ? ''
    : mutual ? `<span style="margin-left:8px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#1a1205;background:linear-gradient(135deg,#FFD700,#f0b400);padding:2px 7px;border-radius:999px;vertical-align:middle;">Mutual</span>`
    : user.follows_me ? `<span style="margin-left:8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:var(--surface2);border:1px solid var(--border);padding:2px 7px;border-radius:999px;vertical-align:middle;">Follows you</span>` : '';
  const countsLine = isHouse
    ? `Tracked by our scoring engine${memberSince ? ' · since ' + memberSince : ''}`
    : `<span id="mp-followers-count">${user.followers || 0}</span> follower${(user.followers || 0) === 1 ? '' : 's'} · ${user.following || 0} following${memberSince ? ' · since ' + memberSince : ''}${user.is_public === 0 ? ' · private' : ''}`;
  const followBtn = showFollow
    ? `<button id="mp-follow-btn" data-following="${user.is_following ? 1 : 0}" onclick="toggleFollow(${user.id})" style="${followBtnStyle(user.is_following)}">${user.is_following ? 'Following' : 'Follow'}</button>`
    : '';
  const avatar = isHouse
    ? `<div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#1a2030,#3b82f6);display:inline-flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:17px;flex-shrink:0;">CA</div>`
    : avatarFor(user.username, 56, user.avatar_url);

  document.getElementById('member-modal-content').innerHTML = `
    <div style="padding:22px 22px 4px;">
      <div style="display:flex;align-items:center;gap:14px;">
        ${avatar}
        <div style="min-width:0;flex:1;">
          <div style="font-size:20px;font-weight:800;">${isHouse ? '' : '@'}${user.username}${!isHouse && user.is_me ? ' <span style="color:var(--gold);font-size:12px;">(you)</span>' : relChip}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">${countsLine}</div>
        </div>
        ${followBtn}
      </div>

      ${isHouse ? '' : windowToggle(data.window)}

      ${isHouse ? '' : `<div style="display:flex;gap:22px;margin-top:6px;flex-wrap:wrap;">
        <div class="record-item"><div class="record-val">${stats.wins}-${stats.losses}${stats.pushes ? '-' + stats.pushes : ''}</div><div class="record-label">Record</div></div>
        <div class="record-item"><div class="record-val gold">${stats.win_pct == null ? '—' : Math.round(stats.win_pct) + '%'}</div><div class="record-label">Win Rate</div></div>
        <div class="record-item"><div class="record-val" style="color:${unitsCls};">${unitsStr}</div><div class="record-label">Units</div></div>
        <div class="record-item"><div class="record-val">${stats.roi == null ? '—' : (stats.roi >= 0 ? '+' : '') + stats.roi.toFixed(1) + '%'}</div><div class="record-label">ROI</div></div>
      </div>`}

      ${(data.clv && data.clv.n) ? `<div class="mp-clv">
        <div class="mp-clv-pct">${data.clv.pct}% <span>beat the close</span></div>
        <div class="mp-clv-sub">${data.clv.good}/${data.clv.n} graded picks${data.clv.avg_cents != null ? ` · avg ${data.clv.avg_cents >= 0 ? '+' : ''}${data.clv.avg_cents} cents` : ''}. Beating the closing line often signals real edge.</div>
      </div>` : ''}

      ${isHouse ? '' : `<div style="display:flex;flex-wrap:nowrap;justify-content:center;align-items:flex-start;gap:26px;margin:16px 0 4px;">${badgeHtml}</div>`}

      <div class="mp-section-label" style="margin-top:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <span id="mp-pl-title" style="flex-shrink:0;">${isHouse ? MP_RANGE_LABEL[_mpRange] : winLabel} P/L</span>
        ${isHouse ? `<div class="mp-hstats">${houseStatsInner(_mpWindowStats())}
        </div>` : ''}
        ${isHouse ? mpRangeDdHtml() : ''}
      </div>
      ${chartHtml}
    </div>

    ${isHouse ? '' : socialSection(user)}

    <div style="padding:8px 22px 20px;border-top:1px solid var(--border);">
      <div class="mp-section-label" style="margin-top:12px;">Recent Picks</div>
      ${buildSportFilter()}
      <div class="mp-picks-scroll" id="mp-picks-list"></div>
    </div>`;

  renderPicksList();
  if (chart && chart.length) requestAnimationFrame(() => drawChart(isHouse ? _mpWindowPoints() : chart, isHouse));
}

// ── Socials: two-ledger section (profit calendar + Verified/True history) ──────
function socEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function socU(u) { return u == null ? '—' : `${u >= 0 ? '+' : ''}${Number(u).toFixed(2).replace(/\.00$/, '')}u`; }
function socUCls(u) { return u == null ? '' : (u >= 0 ? 'soc-u-pos' : 'soc-u-neg'); }

// The section: only renders when the server attached social extras (viewable
// member). Own profile also gets the hide-stakes toggle + a share-a-win button.
function socialSection(user) {
  if (!_social) return '';
  const cal = _social.calendar || [];
  const hist = (_social.history && _social.history.rows) || [];
  if (!cal.length && !hist.length) return '';
  const hasWin = hist.some(r => r.result === 'win');
  const shareBtn = user.is_me && hasWin
    ? `<button class="soc-scope" style="flex:0 0 auto;padding:7px 14px;" onclick="mpShareWin(${user.id})"><i class="fa-solid fa-share-nodes" style="margin-right:6px;font-size:11px;"></i>Share a win</button>`
    : '';
  return `<div style="padding:6px 22px 4px;border-top:1px solid var(--border);">
    ${cal.length ? `<div class="soc-pcal" style="margin-top:14px;"><div class="cap">Last 5 weeks · profit days</div>${calendarHtml(cal)}</div>` : ''}
    <div style="display:flex;align-items:center;gap:10px;margin-top:14px;">
      <div class="soc-lseg" style="flex:1;margin:0;">
        <button class="active" data-lm="ver"  onclick="mpLedger('ver')">Verified picks</button>
        <button data-lm="true" onclick="mpLedger('true')">True history</button>
      </div>
      ${shareBtn}
    </div>
    <div id="mp-ledger">${ledgerBodyHtml()}</div>
    ${user.is_me ? hideStakesRow() : ''}
  </div>`;
}

function calendarHtml(cal) {
  const byDay = new Map(cal.map(c => [c.date, c.units]));
  const cells = [];
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const start = new Date(today); start.setDate(start.getDate() - 34);
  for (let i = 0; i < 35; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const u = byDay.get(key);
    let cls = '';
    if (u != null) cls = u >= 1 ? 'w2' : u > 0 ? 'w' : u < 0 ? 'l' : '';
    if (key === todayKey) cls += ' today';
    const tip = u != null ? `${key}: ${socU(u)}` : key;
    cells.push(`<div class="d ${cls}" title="${tip}"></div>`);
  }
  return `<div class="grid">${cells.join('')}</div>`;
}

function ledgerBodyHtml() {
  const hist = (_social && _social.history && _social.history.rows) || [];
  const hide = !!(_social && _social.history && _social.history.hide_stakes);
  if (!hist.length) return `<div style="font-size:12.5px;color:var(--muted);padding:12px 2px;">No tracked bets yet.</div>`;
  const rows = hist.map(r => _ledgerMode === 'ver' ? verifiedRow(r) : trueRow(r, hide)).filter(Boolean).join('');
  if (!rows) return `<div style="font-size:12.5px;color:var(--muted);padding:12px 2px;">${_ledgerMode === 'ver' ? 'No verified picks yet.' : 'No tracked bets yet.'}</div>`;
  const note = _ledgerMode === 'ver'
    ? `Board record. Verified picks only, every pick counts 1 unit.`
    : `Unverified bets are self-entered. They show here for the full picture and never count toward rankings.`;
  return rows + `<div style="font-size:11px;color:var(--muted);margin:8px 2px 0;line-height:1.5;">${note}</div>`;
}

// One row of the ledger. Verified mode = board picks only (1u each); True mode =
// everything with real stakes + book + verified/unverified chip.
function rowMatchup(r) {
  if (r.home_team && r.away_team) return `${teamNickname(r.away_team, r.home_team)} @ ${teamNickname(r.home_team, r.away_team)}`;
  return r.sport || '';
}
function rowPickLabel(r) {
  if (r.kind === 'bet') return r.selection || '';
  const home = r.home_team ? teamNickname(r.home_team, r.away_team) : 'Home';
  const away = r.away_team ? teamNickname(r.away_team, r.home_team) : 'Away';
  const s = r.slot;
  if (s === 'home_ml') return `${home} ML`;
  if (s === 'away_ml') return `${away} ML`;
  if (s === 'home_spread') return `${home} ${fmtSpread(r.spread)}`;
  if (s === 'away_spread') return `${away} ${fmtSpread(r.spread)}`;
  if (s === 'over')  return `Over ${r.spread ?? ''}`.trim();
  if (s === 'under') return `Under ${r.spread ?? ''}`.trim();
  return s || '';
}
function resultRt(r) {
  if (r.result === 'win' || r.result === 'loss' || r.result === 'push') {
    const cls = r.result === 'push' ? 'soc-u-push' : socUCls(r.units);
    return `<div class="${cls}" style="font-size:13px;font-weight:800;">${r.result.toUpperCase()}${r.units != null ? ' ' + socU(r.units) : ''}</div>`;
  }
  return `<div style="font-size:11px;color:var(--muted);font-weight:700;">Pending</div>`;
}
function verifiedRow(r) {
  if (r.kind !== 'vote') return ''; // verified board record = votes only
  return `<div class="soc-hrow">
    <div class="mid"><div class="p">${socEsc(rowPickLabel(r))}</div>
      <div class="s">${socEsc([r.sport, rowMatchup(r)].filter(Boolean).join(' · '))}</div></div>
    <div class="rt">${resultRt(r)}<span class="soc-chip verified" style="margin-top:3px;">✓ 1u</span></div>
  </div>`;
}
function trueRow(r, hide) {
  const chip = r.verified
    ? `<span class="soc-chip verified">✓ Verified</span>`
    : `<span class="soc-chip unverified">Unverified</span>`;
  const stakeTxt = (!hide && r.stake != null) ? `$${Math.round(r.stake)} stake` : '';
  const bookTxt = r.book ? socEsc(r.book) : '';
  const sub = [r.sport, bookTxt, stakeTxt].filter(Boolean).join(' · ');
  return `<div class="soc-hrow">
    <div class="mid"><div class="p">${socEsc(rowPickLabel(r))} ${r.odds != null ? `<span style="color:var(--muted);font-weight:600;">${fmtOdds(r.odds)}</span>` : ''}</div>
      <div class="s">${socEsc(sub)}</div></div>
    <div class="rt">${resultRt(r)}<span style="display:block;margin-top:3px;">${chip}</span></div>
  </div>`;
}

function hideStakesRow() {
  const on = !!(_social && _social.history && _social.history.hide_stakes);
  // On your OWN profile the server never hides your numbers, so drive the knob
  // off the saved preference carried in state (falls back to off).
  const pref = state.currentUser && state.currentUser.hideStakes;
  const active = pref != null ? pref : on;
  return `<div class="soc-priv">Hide my stake amounts from others
    <div class="soc-knob ${active ? 'on' : ''}" id="mp-hide-knob" onclick="mpToggleHideStakes(this)"></div></div>`;
}

export function mpLedger(mode) {
  _ledgerMode = mode === 'true' ? 'true' : 'ver';
  document.querySelectorAll('#member-modal-content .soc-lseg button').forEach(b => b.classList.toggle('active', b.dataset.lm === _ledgerMode));
  const body = document.getElementById('mp-ledger');
  if (body) body.innerHTML = ledgerBodyHtml();
}

export async function mpToggleHideStakes(el) {
  const on = el.classList.contains('on');
  el.classList.toggle('on', !on);
  try {
    const res = await fetch('/api/account/preferences', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hide_stakes: !on }),
    });
    if (res.ok) {
      if (state.currentUser) state.currentUser.hideStakes = !on;
      if (window.showToast) window.showToast(!on ? 'Stake amounts hidden' : 'Stake amounts visible');
    } else { el.classList.toggle('on', on); }
  } catch (_) { el.classList.toggle('on', on); }
}

export async function mpShareWin(userId) {
  // Custom message + a link to the CappingAlpha main page. Attach the win-card
  // image where the platform supports file shares; otherwise share/copy the text.
  const site = 'https://cappingalpha.com';
  const text = `On the board with CappingAlpha. Come see the ranked picks and track your own bets: ${site}`;
  try {
    const res = await fetch(`/og/member-win/${userId}.png`);
    if (res.ok && navigator.canShare) {
      const blob = await res.blob();
      const file = new File([blob], 'cappingalpha-win.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text, url: site }); return; }
    }
  } catch (_) {}
  if (navigator.share) { navigator.share({ title: 'CappingAlpha', text, url: site }).catch(() => {}); return; }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => { window.showToast && window.showToast('Share message copied'); }, () => {});
}

function buildSportFilter() {
  const sports = Array.from(new Set(_picks.map(p => (p.sport || '').toUpperCase()).filter(Boolean)));
  if (sports.length <= 1) return '';
  return `<div class="mp-sport-filter" id="mp-sport-filter">
    <span class="mp-sport-pill active" data-sport="all" onclick="filterMemberPicks('all')">All</span>
    ${sports.map(s => `<span class="mp-sport-pill" data-sport="${s}" onclick="filterMemberPicks('${s}')">${s}</span>`).join('')}
  </div>`;
}

// Styled to mirror the CA Rankings All-Time P/L graph. House (CA history)
// popups plot DOLLARS at the site's flat unit with date labels on the x-axis;
// member popups keep their units scale (their whole profile speaks units).
function drawChart(points, isHouse) {
  const canvas = document.getElementById('mp-chart');
  if (!canvas || !window.Chart) return;
  const unit = isHouse ? (parseFloat(state.CONFIG?.bet_unit) || 10) : 1;
  const vals = points.map(p => +(p.cum * unit).toFixed(2));
  const last = vals.length ? vals[vals.length - 1] : 0;
  const color = last >= 0 ? '#4ade80' : '#f87171';
  const money = (v, dec = 0) => (v >= 0 ? '+' : '-') + (isHouse ? '$' : '') + Math.abs(v).toFixed(dec) + (isHouse ? '' : 'u');
  const labels = points.map(p => {
    if (isHouse && p.d) return new Date(p.d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `Pick ${p.i}`;
  });
  destroyChart();
  _chart = new Chart(canvas, {
    type: 'line',
    plugins: window.caCrosshair ? [window.caCrosshair] : [],
    data: {
      labels,
      datasets: [{
        data: vals,
        borderColor: color,
        backgroundColor: color + '18',
        borderWidth: 2,
        pointRadius: points.length > 35 ? 0 : 4,
        fill: true,
        tension: 0.3,
        pointHoverRadius: 7, pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2, pointHoverBackgroundColor: color,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick: (e, els) => window.caChartClick && window.caChartClick(e, els, _chart),
      plugins: {
        legend: { display: false },
        // Shared interactive HTML tooltip (result-colored rows, hover highlight,
        // click to pin). Each profile point is a single pick.
        tooltip: window.caChartTip ? { enabled: false, external: window.caChartTip } : { enabled: true },
      },
      scales: {
        x: { display: !!isHouse, ticks: { color: '#8892a4', font: { size: 11 }, maxTicksLimit: 12 }, grid: { color: '#252c3b' } },
        y: { ticks: { color: '#8892a4', callback: v => money(v) }, grid: { color: '#252c3b' } },
      },
    },
  });
  // Build one tip row per point (a profile point = one pick), tagged with result.
  _chart.$caTip = points.map((p, i) => {
    const ret = +(p.ret * unit).toFixed(2);
    let text;
    if (isHouse && p.pick_type) {
      const pt = (p.pick_type || '').toLowerCase();
      const lbl = (pt === 'over' || pt === 'under') && p.team ? `${teamNick(p.team)} ${typePickLabel(p)}` : typePickLabel(p);
      const matchup = p.home_team && p.away_team ? `  (${teamNick(p.away_team, p.home_team)} @ ${teamNick(p.home_team, p.away_team)})` : '';
      text = `${lbl}${matchup}  ·  ${money(ret, 2)}`;
    } else {
      text = `This pick  ·  ${money(ret, 2)}`;
    }
    return { title: labels[i], sub: `Total: ${money(vals[i], 2)}`, items: [{ text, result: p.result }] };
  });
  if (window.caAttachCrosshair) window.caAttachCrosshair(_chart);
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
    // House rows may predate the matchup columns — fall back to the picked team,
    // and show the game date when the row carries one (members' votes don't).
    const base = p.home_team ? `${teamNick(p.away_team, p.home_team)} @ ${teamNick(p.home_team, p.away_team)}`
               : (p.team || `Game ${p.espn_game_id}`);
    const matchup = p.game_date ? `${base} · ${p.game_date}` : base;
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
  // House (CA) profiles: the sport pill also re-scopes the chart + record stats.
  if (_houseSport != null) {
    const hs = document.querySelector('.mp-hstats');
    if (hs) hs.innerHTML = houseStatsInner(_mpWindowStats());
    drawChart(_mpWindowPoints(), true);
  }
}

// Close on Escape, matching the game modal behavior.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('member-modal');
    if (modal && !modal.classList.contains('hidden')) closeMemberModal();
  }
});

Object.assign(window, { openMemberModal, openSportProfile, closeMemberModal, filterMemberPicks, setMemberWindow, toggleFollow, mpToggleRange, mpPickRange, mpLedger, mpToggleHideStakes, mpShareWin });
