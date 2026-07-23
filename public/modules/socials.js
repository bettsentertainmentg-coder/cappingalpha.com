// modules/socials.js — the Socials tab (Clubhouse direction): Feed | Friends |
// Board. Feed cards are the logged activity itself (a tracked pick, a settled
// result, a streak, a weekly medal); the verbs are Tail, Fade, Boost, Comment.
// Board folds in the existing leaderboard with Everyone/Friends + sport filters.
//
// Backend: src/social.js via /api/social/*, /api/members/search, plus the
// existing /api/friends, /api/leaderboard, /api/account (referral code).
// Tail opens the Track a Bet sheet prefilled (track.js openTrackForSlot with the
// author id as tail_of), per Jack's call — the member confirms/adjusts and the
// verified vote records the tail.

import { state } from './state.js';
import { avatarFor, fmtOdds, fmtSpread, teamNickname } from './utils.js?v=5';
import { loadLeaderboard } from './leaderboard.js?v=15';

// ── small helpers ─────────────────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function uStr(u) { if (u == null) return '—'; const s = (u >= 0 ? '+' : '') + u.toFixed(2).replace(/\.00$/, '') + 'u'; return s; }
function uCls(u) { return u == null ? '' : (u >= 0 ? 'soc-u-pos' : 'soc-u-neg'); }
// A settled push nets 0u but is neither a win nor a loss — render it neutral,
// never green, so "+0u" doesn't read as a win.
function resCls(result, u) { return result === 'push' ? 'soc-u-push' : uCls(u); }
function recStr(r) { if (!r) return ''; return `${r.wins}-${r.losses}${r.pushes ? '-' + r.pushes : ''}`; }
function pctStr(p) { return p == null ? '—' : `${Math.round(p)}%`; }
function timeAgo(iso) {
  if (!iso) return '';
  const t = Date.parse(String(iso).replace(' ', 'T') + (String(iso).includes('T') ? '' : 'Z'));
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function av(u, size) {
  return avatarFor(u ? (u.username || '') : '', size, u ? u.avatar_url : null);
}
const OPP = { home_ml: 'away_ml', away_ml: 'home_ml', home_spread: 'away_spread', away_spread: 'home_spread', over: 'under', under: 'over' };

// Pick label off the slot + snapshot lines (mirrors utils.pickLabel intent).
function slotLabel(g, pick) {
  const slot = pick.slot;
  const homeNick = g.home_team ? teamNickname(g.home_team, g.away_team) : 'Home';
  const awayNick = g.away_team ? teamNickname(g.away_team, g.home_team) : 'Away';
  if (slot === 'home_ml') return `${homeNick} ML`;
  if (slot === 'away_ml') return `${awayNick} ML`;
  if (slot === 'home_spread') return `${homeNick} ${fmtSpread(pick.spread)}`;
  if (slot === 'away_spread') return `${awayNick} ${fmtSpread(pick.spread)}`;
  if (slot === 'over')  return `${g.home_team && g.away_team ? awayNick + '/' + homeNick + ' ' : ''}Over ${pick.spread ?? ''}`.trim();
  if (slot === 'under') return `${g.home_team && g.away_team ? awayNick + '/' + homeNick + ' ' : ''}Under ${pick.spread ?? ''}`.trim();
  return slot;
}
function slotOdds(pick) {
  const slot = pick.slot;
  if (slot === 'home_ml') return pick.ml_home;
  if (slot === 'away_ml') return pick.ml_away;
  if (slot === 'over') return pick.ou_over_odds || -115;
  if (slot === 'under') return pick.ou_under_odds || -115;
  return pick.user_odds || -110; // spreads: no juice stored
}
function matchupLine(g) {
  if (!g) return '';
  const bits = [];
  if (g.away_team && g.home_team) bits.push(`${teamNickname(g.away_team, g.home_team)} @ ${teamNickname(g.home_team, g.away_team)}`);
  if (g.sport) bits.push(g.sport);
  if (g.status === 'post' && g.home_score != null) bits.push(`Final ${g.away_score}-${g.home_score}`);
  else if (g.status === 'in') bits.push('Live');
  else if (g.start_time) { const d = new Date(g.start_time); if (!isNaN(d)) bits.push(d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })); }
  return bits.join(' · ');
}

// ── module state ──────────────────────────────────────────────────────────────
let _pane = 'feed';
let _feedCursor = null;
let _feedLoading = false;
let _feedDone = false;
let _friendsLoaded = false;
let _referral = null;
let _searchTimer = null;

// ── entry ─────────────────────────────────────────────────────────────────────
export function loadSocials() {
  socialsPane(_pane, true);
}

// Deep-link straight to the Leaderboard sub-tab (the "View leaderboard" links).
export function viewLeaderboard() {
  _pane = 'board';
  if (window.switchTab) window.switchTab('socials');
  else socialsPane('board', true);
}

export function socialsPane(pane, force) {
  if (!['feed', 'friends', 'board'].includes(pane)) pane = 'feed';
  _pane = pane;
  document.querySelectorAll('.soc-sn').forEach(b => b.classList.toggle('active', b.dataset.socPane === pane));
  document.querySelectorAll('.soc-pane').forEach(p => p.classList.toggle('active', p.id === `soc-pane-${pane}`));
  if (pane === 'feed') { if (force || !_feedCursorInit) initFeed(); }
  if (pane === 'friends') { if (force || !_friendsLoaded) loadFriendsHub(); }
  if (pane === 'board') { loadLeaderboard(state.leaderboardWindow || 'week'); renderSportRail(); }
}
let _feedCursorInit = false;

// ══ FEED ═══════════════════════════════════════════════════════════════════════
function initFeed() {
  _feedCursor = null; _feedDone = false; _feedCursorInit = true;
  const feed = document.getElementById('soc-feed');
  if (feed) feed.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  loadFeed(true);
}

async function loadFeed(fresh) {
  if (_feedLoading || (_feedDone && !fresh)) return;
  _feedLoading = true;
  try {
    const qs = _feedCursor && !fresh ? `?cursor=${encodeURIComponent(_feedCursor)}` : '';
    const res = await fetch(`/api/social/feed${qs}`);
    if (!res.ok) throw new Error('feed');
    const data = await res.json();
    if (fresh) renderStreakRail(data.streakRail || []);
    renderFeed(data, fresh);
    _feedCursor = data.nextCursor;
    _feedDone = !data.nextCursor;
  } catch (_) {
    const feed = document.getElementById('soc-feed');
    if (feed && fresh) feed.innerHTML = `<div class="empty"><div class="empty-icon">⚠</div><h3>Couldn't load your feed</h3><p>Please try again in a moment.</p></div>`;
  } finally { _feedLoading = false; }
}

function renderStreakRail(rail) {
  const el = document.getElementById('soc-streak-rail');
  if (!el) return;
  if (!rail.length) { el.innerHTML = ''; return; }
  const items = rail.map(u => {
    const hot = (u.streak || 0) >= 3;
    const flame = hot ? `<span class="flame">🔥</span>` : '';
    const wtxt = u.me && !(u.streak >= 1) ? '—' : `W${u.streak || 0}`;
    return `<button class="soc-streak ${hot ? 'hot' : ''} ${u.me ? 'me' : ''}" onclick="openMemberModal(${u.id}, 'all')">
      <div class="ring">${av(u, 48)}${flame}</div>
      <div class="nm">${u.me ? 'You' : esc(u.username)}</div>
      <div class="w">${wtxt}</div>
    </button>`;
  }).join('');
  el.innerHTML = `<div class="soc-eyebrow" style="margin-top:2px;">Hot in your circle <span class="rule"></span></div>
    <div class="soc-streaks">${items}</div>`;
}

function renderFeed(data, fresh) {
  const feed = document.getElementById('soc-feed');
  if (!feed) return;
  const items = data.items || [];
  if (fresh && !items.length) {
    feed.innerHTML = `<div class="empty"><div class="empty-icon">👋</div><h3>Your feed is quiet</h3>
      <p>Follow a few members to see their picks, results, and streaks here. Try the Friends tab.</p>
      <button class="soc-tail" style="max-width:220px;margin:14px auto 0;display:block;" onclick="socialsPane('friends')">Find members</button></div>`;
    return;
  }
  const html = items.map(feedCard).join('');
  const moreBtn = data.nextCursor
    ? `<button id="soc-more" class="soc-scope" style="width:100%;margin-top:6px;" onclick="socialsMore()">Load more</button>` : '';
  if (fresh) feed.innerHTML = html + moreBtn;
  else {
    const old = document.getElementById('soc-more'); if (old) old.remove();
    feed.insertAdjacentHTML('beforeend', html + moreBtn);
  }
}

export function socialsMore() { loadFeed(false); }

function boostBtn(it) {
  const b = it.boosts || { count: 0, me: false };
  return `<button class="soc-react ${b.me ? 'on' : ''}" onclick="socBoost(this,'${it.key}')">⚡ <span>${b.count}</span></button>`;
}
function commentBtn(it) {
  return `<button class="soc-react" onclick="socToggleComments(this,'${it.key}')">💬 ${it.comment_count || 0}</button>`;
}
function kebab(it) {
  if (it.user == null || !it.user.id) return '';
  return `<button class="soc-kebab" title="More" onclick="socReport('${it.key}',${it.user.id})">⋯</button>`;
}

function feedCard(it) {
  if (it.kind === 'house') return houseCard(it);
  if (it.kind === 'award') return awardCard(it);
  if (it.kind === 'bet') return betCard(it);
  return voteCard(it);
}

function headHtml(it, sub) {
  const u = it.user || {};
  const r = u.record;
  const streak = (u.streak || 0) >= 3 ? ` · W${u.streak} 🔥` : '';
  const rec = r ? `<b>${recStr(r)}</b> · <span class="${uCls(r.units)}">${uStr(r.units)}</span>${streak}` : (sub || '');
  return `<div class="soc-fhead">
    <div onclick="openMemberModal(${u.id}, 'all')" style="cursor:pointer;flex-shrink:0;">${av(u, 36)}</div>
    <div class="who" onclick="openMemberModal(${u.id}, 'all')">
      <div class="un">@${esc(u.username)}</div>
      <div class="rec">${rec}</div>
    </div>
    <div class="time">${timeAgo(it.created_at)}</div>
    ${kebab(it)}
  </div>`;
}

function voteCard(it) {
  const g = it.game || {};
  const graded = it.result && it.result !== 'pending';
  const cls = graded ? (it.result === 'win' ? ' win' : it.result === 'loss' ? ' loss' : '') : '';
  const label = slotLabel(g, it.pick || {});
  const odds = fmtOdds(slotOdds(it.pick || {}));
  const live = g.status === 'in';
  const closed = graded || live || g.status === 'post';

  // Right side of the bet block: settled result, live chip, or the verified 1u chip.
  let rt = '';
  if (graded) {
    const rl = it.result.toUpperCase();
    rt = `<span class="soc-result-big ${resCls(it.result, it.units)}">${rl}${it.units != null ? ' ' + uStr(it.units) : ''}</span><span class="soc-chip verified">✓ 1u</span>`;
  } else if (live) {
    rt = `<span class="soc-chip live"><span class="dot"></span>LIVE</span><span class="soc-chip verified">✓ 1u</span>`;
  } else {
    rt = `<span class="soc-chip verified">✓ 1u verified</span>${g.sport ? `<span class="soc-chip sport">${esc(g.sport)}</span>` : ''}`;
  }

  const proof = it.tails > 0 ? `<div class="soc-proof"><b>${it.tails} ${it.tails === 1 ? 'friend tailed' : 'friends tailed'}</b> this pick</div>` : '';

  // Verbs: pregame pending → Tail/Fade; otherwise locked.
  let verbs;
  if (!closed && g.espn_game_id) {
    verbs = `<button class="soc-tail" onclick="socTail('${g.espn_game_id}','${it.pick.slot}',${it.user.id})">Tail</button>
      <button class="soc-fade" onclick="socTail('${g.espn_game_id}','${OPP[it.pick.slot]}',${it.user.id})">Fade</button>`;
  } else {
    verbs = `<span class="soc-locked">${graded ? 'Settled' : 'Locked at start'}</span>`;
  }

  return `<div class="soc-fcard${cls}" data-key="${it.key}">
    ${headHtml(it)}
    <div class="soc-betblock">
      <div class="pick"><div class="l1">${esc(label)} <span class="odds">${odds}</span></div>
        <div class="l2">${esc(matchupLine(g))}</div></div>
      <div class="rt">${rt}</div>
    </div>
    ${proof}
    <div class="soc-verbs">${verbs}${boostBtn(it)}${commentBtn(it)}</div>
    <div class="soc-comment-slot"></div>
  </div>`;
}

function betCard(it) {
  const b = it.bet || {};
  const graded = it.result && it.result !== 'pending';
  const cls = graded ? (it.result === 'win' ? ' win' : it.result === 'loss' ? ' loss' : '') : '';
  const chip = it.verified
    ? `<span class="soc-chip verified">✓ Verified</span>`
    : `<span class="soc-chip unverified">Unverified${it.stake != null ? ' · $' + Math.round(it.stake) : ''}</span>`;
  const rt = graded
    ? `<span class="soc-result-big ${resCls(it.result, it.units)}">${it.result.toUpperCase()}${it.units != null ? ' ' + uStr(it.units) : ''}</span>${chip}`
    : `${chip}${b.book ? `<span class="soc-chip sport">${esc(b.book)}</span>` : ''}`;
  const line2 = [matchupLine(it.game), b.book].filter(Boolean).join(' · ');
  return `<div class="soc-fcard${cls}" data-key="${it.key}">
    ${headHtml(it)}
    <div class="soc-betblock">
      <div class="pick"><div class="l1">${esc(b.selection || '')} <span class="odds">${fmtOdds(b.odds)}</span></div>
        <div class="l2">${esc(line2)}</div></div>
      <div class="rt">${rt}</div>
    </div>
    <div class="soc-verbs">${boostBtn(it)}${commentBtn(it)}</div>
    <div class="soc-comment-slot"></div>
  </div>`;
}

function awardCard(it) {
  const a = it.award || {};
  const medal = a.rank === 1 ? '🥇' : a.rank === 2 ? '🥈' : a.rank === 3 ? '🥉' : '🏅';
  const period = a.period_type === 'week' ? "last week's board" : "last month's board";
  return `<div class="soc-fcard award" data-key="${it.key}">
    ${headHtml(it, 'earned a medal')}
    <div style="display:flex;align-items:center;gap:12px;margin-top:10px;">
      <div style="font-size:34px;line-height:1;">${medal}</div>
      <div style="min-width:0;">
        <div style="font-weight:800;font-size:14px;">Finished #${a.rank} on ${period}</div>
        ${a.units != null ? `<div style="font-size:12px;color:var(--muted);margin-top:2px;"><span class="${uCls(a.units)}">${uStr(a.units)}</span> for the ${a.period_type}</div>` : ''}
      </div>
    </div>
    <div class="soc-verbs">${boostBtn(it)}${commentBtn(it)}</div>
    <div class="soc-comment-slot"></div>
  </div>`;
}

function houseCard(it) {
  const n = (it.house && it.house.pick_count) || 0;
  return `<div class="soc-fcard house" data-key="${it.key}">
    <div class="soc-fhead">
      <div style="flex-shrink:0;cursor:pointer;" onclick="openSportProfile('all')" title="View CappingAlpha's all-time profile">${avatarFor('CA', 36)}</div>
      <div class="who"><div class="un" style="cursor:pointer;" onclick="openSportProfile('all')">CappingAlpha <span class="soc-chip official">Official</span></div>
        <div class="rec">today's board is live</div></div>
      <div class="time">${timeAgo(it.created_at)}</div>
    </div>
    <div style="margin-top:10px;font-size:13px;color:var(--text);">The #1 pick is in.${n ? ` ${n} picks on today's board.` : ''}</div>
    <div class="soc-verbs"><button class="soc-tail" onclick="switchTab('mvp')">View the board</button>${boostBtn(it)}</div>
  </div>`;
}

// ── feed interactions ─────────────────────────────────────────────────────────
export async function socBoost(btn, key) {
  const on = btn.classList.contains('on');
  const span = btn.querySelector('span');
  const cur = parseInt(span ? span.textContent : '0', 10) || 0;
  // optimistic
  btn.classList.toggle('on', !on);
  if (span) span.textContent = on ? Math.max(0, cur - 1) : cur + 1;
  try {
    const res = await fetch('/api/social/react', {
      method: on ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (res.ok) { const d = await res.json(); if (span && d.count != null) span.textContent = d.count; btn.classList.toggle('on', !!d.me); }
  } catch (_) { /* leave optimistic state */ }
}

export function socTail(gameId, slot, tailOf) {
  if (!state.currentUser) { window.openLogin && window.openLogin(); return; }
  if (window.openTrackForSlot) window.openTrackForSlot(gameId, slot, tailOf);
}

export async function socToggleComments(btn, key) {
  const card = btn.closest('.soc-fcard');
  const slot = card && card.querySelector('.soc-comment-slot');
  if (!slot) return;
  if (slot.dataset.open === '1') { slot.dataset.open = '0'; slot.innerHTML = ''; return; }
  slot.dataset.open = '1';
  slot.innerHTML = `<div class="soc-comments" style="opacity:.6;">Loading…</div>`;
  try {
    const res = await fetch(`/api/social/comments?key=${encodeURIComponent(key)}`);
    const data = res.ok ? await res.json() : { comments: [] };
    renderComments(slot, key, data.comments || []);
  } catch (_) { slot.innerHTML = ''; }
}

function renderComments(slot, key, comments) {
  const rows = comments.map(c => `<div class="soc-cmt" data-cid="${c.id}">
    <div style="flex-shrink:0;">${avatarFor(c.username, 22, c.avatar_url)}</div>
    <div class="txt"><b>@${esc(c.username)}</b>${esc(c.body)}<span class="t">${timeAgo(c.created_at)}</span></div>
    ${c.mine ? `<button class="cx" title="Delete" onclick="socDeleteComment(${c.id})">✕</button>`
             : `<button class="cx" title="Report" onclick="socReport('comment:${c.id}',${c.user_id})">⚑</button>`}
  </div>`).join('');
  slot.innerHTML = `<div class="soc-comments">
    ${rows || '<div style="font-size:12px;color:var(--muted);">No comments yet. Start it off.</div>'}
    <div class="soc-cbox">${avatarFor(state.currentUser ? state.currentUser.username : '', 24)}
      <input type="text" maxlength="400" placeholder="Add a comment" onkeydown="if(event.key==='Enter')socSendComment(this,'${key}')" /></div>
  </div>`;
}

export async function socSendComment(input, key) {
  const body = (input.value || '').trim();
  if (!body) return;
  input.disabled = true;
  try {
    const res = await fetch('/api/social/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, body }),
    });
    if (res.ok) {
      const slot = input.closest('.soc-comment-slot');
      const r2 = await fetch(`/api/social/comments?key=${encodeURIComponent(key)}`);
      const data = r2.ok ? await r2.json() : { comments: [] };
      renderComments(slot, key, data.comments || []);
      // bump the count on the toggle button
      const card = slot.closest('.soc-fcard');
      const cbtn = card && [...card.querySelectorAll('.soc-react')].find(b => b.textContent.includes('💬'));
      if (cbtn) cbtn.innerHTML = `💬 ${(data.comments || []).length}`;
    } else {
      const d = await res.json().catch(() => ({}));
      if (window.showToast) window.showToast(d.error || 'Could not post that.', 'err');
      input.disabled = false;
    }
  } catch (_) { input.disabled = false; }
}

export async function socDeleteComment(id) {
  try {
    const res = await fetch(`/api/social/comments/${id}`, { method: 'DELETE' });
    if (res.ok) { const row = document.querySelector(`.soc-cmt[data-cid="${id}"]`); if (row) row.remove(); }
  } catch (_) {}
}

export function socReport(key, userId) {
  const opts = [];
  const isComment = String(key).startsWith('comment:');
  const msg = isComment ? 'Report this comment?' : 'Report or block this member?';
  // Lightweight action prompt via the toast/confirm pattern already in the app.
  const choice = window.confirm(`${msg}\n\nOK = Report${!isComment ? '   ·   Cancel then use the block option below' : ''}`);
  if (choice) {
    fetch('/api/social/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_key: key, subject_user: userId, reason: '' }),
    }).then(() => { if (window.showToast) window.showToast('Reported. Thanks for the flag.'); }).catch(() => {});
  } else if (!isComment && userId) {
    if (window.confirm('Block this member? You will stop seeing each other.')) socBlock(userId);
  }
}

export async function socBlock(userId) {
  try {
    const res = await fetch(`/api/social/block/${userId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'block' }) });
    if (res.ok) { if (window.showToast) window.showToast('Blocked.'); initFeed(); _friendsLoaded = false; }
  } catch (_) {}
}

// ══ FRIENDS ════════════════════════════════════════════════════════════════════
async function loadFriendsHub() {
  _friendsLoaded = true;
  await Promise.all([renderSuggested(), renderFriends(), renderInvite()]);
  wireSearch();
}

function memberCard(u) {
  const hot = (u.streak || 0) >= 3;
  const following = u.is_following ? 'following' : '';
  const label = u.is_following ? 'Following' : 'Follow';
  const sub = hot ? `W${u.streak} 🔥 · <b class="${uCls(u.record && u.record.units)}">${uStr(u.record ? u.record.units : null)}</b>`
                  : `<b class="${uCls(u.record && u.record.units)}">${uStr(u.record ? u.record.units : null)}</b>`;
  return `<div class="soc-scard">
    <div style="cursor:pointer;" onclick="openMemberModal(${u.id}, 'all')">${av(u, 44)}
      <div class="nm">@${esc(u.username)}</div></div>
    <div class="st">${sub}</div>
    <button class="soc-follow ${following}" onclick="socFollow(this, ${u.id})">${label}</button>
  </div>`;
}

async function renderSuggested() {
  const el = document.getElementById('soc-suggested');
  if (!el) return;
  try {
    const res = await fetch('/api/social/suggested');
    const d = res.ok ? await res.json() : {};
    const rail = (title, more, arr) => (arr && arr.length)
      ? `<div class="soc-eyebrow">${title} <span class="rule"></span>${more}</div><div class="soc-hrail">${arr.map(memberCard).join('')}</div>` : '';
    el.innerHTML =
      rail('Hot streaks', '', d.hot_streaks) +
      rail('Top this week', `<button class="more" onclick="socialsPane('board')">Board</button>`, d.top_week) +
      rail('Most followed', '', d.most_followed);
  } catch (_) { el.innerHTML = ''; }
}

async function renderFriends() {
  const el = document.getElementById('soc-friends-list');
  if (!el) return;
  try {
    const res = await fetch('/api/friends');
    const d = res.ok ? await res.json() : { friends: [] };
    const friends = d.friends || [];
    if (!friends.length) {
      el.innerHTML = `<div class="soc-eyebrow">Your friends <span class="rule"></span></div>
        <div class="empty" style="padding:22px;"><div class="empty-icon">👥</div><h3>No friends yet</h3>
        <p>Follow members above or search by name. When you both follow each other, you're friends.</p></div>`;
      return;
    }
    const rows = friends.map(f => {
      const mutual = f.mutual ? `<span class="soc-chip mutual">Mutual</span>` : '';
      const priv = f.is_public === 0 ? ` · private` : '';
      return `<div class="soc-frow" onclick="openMemberModal(${f.user_id}, 'all')">
        ${avatarFor(f.username, 38, f.avatar_url)}
        <div class="mid"><div class="nm"><span class="h">@${esc(f.username)}</span>${mutual}</div>
          <div class="st">${recStr(f)} · ${pctStr(f.win_pct)} win${priv}</div></div>
        <div class="rt"><div class="${uCls(f.units)}" style="font-size:14px;">${uStr(f.units)}</div>
          <div class="s">${f.roi == null ? '—' : (f.roi >= 0 ? '+' : '') + f.roi.toFixed(1) + '% ROI'}</div></div>
      </div>`;
    }).join('');
    el.innerHTML = `<div class="soc-eyebrow">Your friends · ${friends.length} <span class="rule"></span></div>${rows}`;
  } catch (_) { el.innerHTML = ''; }
}

async function renderInvite() {
  const el = document.getElementById('soc-invite');
  if (!el) return;
  if (!_referral) {
    try { const res = await fetch('/api/account'); if (res.ok) { const a = await res.json(); _referral = a.referral || null; } } catch (_) {}
  }
  const code = _referral && _referral.code ? _referral.code : null;
  el.innerHTML = `<div class="soc-invite">
    <h4>Bring a friend, both get 3 days</h4>
    <p>Share your code. When a friend joins with it, you each get 3 free days of full access.</p>
    <div class="row"><div class="code">${code ? esc(code) : '…'}</div>
      <button class="go" onclick="socInviteShare('${code ? esc(code) : ''}')">Share</button></div>
  </div>`;
}

export function socInviteShare(code) {
  if (!code) return;
  const { message } = referralInvite(code);
  if (navigator.share) { navigator.share({ title: 'CappingAlpha', text: message }).catch(() => {}); return; }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(message).then(
    () => { if (window.showToast) window.showToast('Invite message copied'); },
    () => {}
  );
}

// Shared referral copy: a ready-to-send message with the ref link that lands the
// recipient right on the signup form with the code already applied (app.js opens
// signup on a ?ref= visit; unlock.js shows the "code applied" banner). Prod domain
// so a link shared from any environment reaches the live site.
function referralInvite(code) {
  const url = `https://cappingalpha.com/?ref=${encodeURIComponent(code)}`;
  const message = `I'm using CappingAlpha for ranked sports betting picks. Sign up with my code and we both get 3 free days of full access. Create your account here and the code applies automatically: ${url}`;
  return { url, message };
}

export async function socFollow(btn, userId) {
  if (!state.currentUser) { window.openLogin && window.openLogin(); return; }
  const following = btn.classList.contains('following');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/follow/${userId}`, { method: following ? 'DELETE' : 'POST' });
    if (res.ok) {
      btn.classList.toggle('following', !following);
      btn.textContent = following ? 'Follow' : 'Following';
      // A new follow can change the feed + friends; mark for refresh on next view.
      _feedCursorInit = false; _friendsLoaded = false;
    }
  } catch (_) {} finally { btn.disabled = false; }
}

// Member search (debounced).
function wireSearch() {
  const input = document.getElementById('soc-search-input');
  if (!input || input.dataset.wired) return;
  input.dataset.wired = '1';
  input.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    const q = input.value.trim();
    const box = document.getElementById('soc-search-results');
    if (q.length < 2) { if (box) box.innerHTML = ''; return; }
    _searchTimer = setTimeout(() => runSearch(q), 220);
  });
}
async function runSearch(q) {
  const box = document.getElementById('soc-search-results');
  if (!box) return;
  try {
    const res = await fetch(`/api/members/search?q=${encodeURIComponent(q)}`);
    const d = res.ok ? await res.json() : { members: [] };
    const members = d.members || [];
    if (!members.length) { box.innerHTML = `<div style="font-size:12.5px;color:var(--muted);padding:6px 4px 10px;">No members match “${esc(q)}”.</div>`; return; }
    const rows = members.map(u => {
      const mutual = u.mutual ? `<span class="soc-chip mutual">Mutual</span>` : '';
      return `<div class="soc-frow" style="margin-bottom:6px;">
        <div style="cursor:pointer;flex-shrink:0;" onclick="openMemberModal(${u.id}, 'all')">${av(u, 36)}</div>
        <div class="mid" style="cursor:pointer;" onclick="openMemberModal(${u.id}, 'all')">
          <div class="nm"><span class="h">@${esc(u.username)}</span>${mutual}</div>
          <div class="st">${recStr(u.record)} · ${pctStr(u.record && u.record.win_pct)} win</div></div>
        <button class="soc-follow ${u.is_following ? 'following' : ''}" onclick="event.stopPropagation();socFollow(this, ${u.id})">${u.is_following ? 'Following' : 'Follow'}</button>
      </div>`;
    }).join('');
    box.innerHTML = `<div class="soc-eyebrow">Results <span class="rule"></span></div>${rows}`;
  } catch (_) { box.innerHTML = ''; }
}

// ══ BOARD ══════════════════════════════════════════════════════════════════════
const BOARD_SPORTS = ['All sports', 'MLB', 'NBA', 'WNBA', 'NFL', 'NCAAF', 'CBB', 'NHL', 'Soccer', 'Tennis', 'Golf'];
let _boardSport = null;
let _boardScope = 'all';

function renderSportRail() {
  const el = document.getElementById('soc-sportrail');
  if (!el) return;
  el.innerHTML = BOARD_SPORTS.map(s => {
    const val = s === 'All sports' ? null : s;
    const active = (val === _boardSport) || (val === null && _boardSport === null);
    return `<button class="soc-sp ${active ? 'active' : ''}" onclick="socialsBoardSport(${val ? `'${val}'` : 'null'})">${s}</button>`;
  }).join('');
}

export function socialsBoardScope(scope) {
  _boardScope = scope === 'friends' ? 'friends' : 'all';
  document.querySelectorAll('.soc-scope').forEach(b => b.classList.toggle('active', b.dataset.scope === _boardScope));
  loadLeaderboard(state.leaderboardWindow || 'week', { scope: _boardScope, sport: _boardSport });
}
export function socialsBoardSport(sport) {
  _boardSport = sport || null;
  renderSportRail();
  loadLeaderboard(state.leaderboardWindow || 'week', { scope: _boardScope, sport: _boardSport });
}

// ── expose onclick handlers ────────────────────────────────────────────────────
Object.assign(window, {
  socialsPane, socialsMore, socBoost, socTail, socToggleComments, socSendComment,
  socDeleteComment, socReport, socBlock, socFollow, socInviteShare,
  socialsBoardScope, socialsBoardSport, viewLeaderboard,
});
