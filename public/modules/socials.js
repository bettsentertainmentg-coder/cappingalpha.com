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
import { avatarFor, fmtOdds, fmtSpread, teamNickname, skelRows } from './utils.js?v=7';
import { loadLeaderboard } from './leaderboard.js?v=17';
import { haptic } from './native.js?v=2';

// ── small helpers ─────────────────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function uStr(u) { if (u == null) return '—'; const s = (u >= 0 ? '+' : '') + u.toFixed(2).replace(/\.00$/, '') + 'u'; return s; }
function uCls(u) { return u == null ? '' : (u >= 0 ? 'soc-u-pos' : 'soc-u-neg'); }
// A settled push nets 0u but is neither a win nor a loss, so it renders neutral,
// never green. The result word is the authority on colour: a free-bet loss nets
// 0u and still has to read as a loss, and no data slip should ever paint a loss
// green.
function resCls(result, u) {
  if (result === 'push') return 'soc-u-push';
  if (result === 'win') return 'soc-u-pos';
  if (result === 'loss') return 'soc-u-neg';
  return uCls(u);
}
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
  // Skeleton loading state (7g): card-shaped gray blocks while the feed fetch
  // is in flight, cross-faded to content in renderFeed.
  if (feed) feed.innerHTML = skelRows(5, 'card');
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
  // Cross-fade skeleton → content (fresh loads replace the skeleton below).
  if (fresh && feed.querySelector('.ca-skel')) {
    feed.classList.add('ca-content-in');
    setTimeout(() => feed.classList.remove('ca-content-in'), 250);
  }
  const items = data.items || [];
  if (fresh && !items.length) {
    feed.innerHTML = `<div class="empty"><div class="empty-icon">👋</div><h3>Your feed is quiet</h3>
      <p>Follow a member or invite someone, and their picks and results land here.</p>
      <button class="soc-tail" style="max-width:220px;margin:14px auto 0;display:block;" onclick="socialsPane('friends')">Find members</button></div>`;
    return;
  }
  // You are always your own author, so the empty state above almost never fires
  // and a brand-new member just sees one house card with no prompt. Pin a
  // starter card instead, gated on the SERVER's following count: a client-side
  // guess pins "it is just you" over the populated feed of someone who follows
  // twenty people who happened to be quiet.
  const starter = (fresh && data.following_count === 0) ? feedStarter() : '';
  const html = starter + items.map(feedCard).join('');
  const moreBtn = data.nextCursor
    ? `<button id="soc-more" class="soc-scope" style="width:100%;margin-top:6px;" onclick="socialsMore()">Load more</button>` : '';
  if (fresh) feed.innerHTML = html + moreBtn;
  else {
    const old = document.getElementById('soc-more'); if (old) old.remove();
    feed.insertAdjacentHTML('beforeend', html + moreBtn);
  }
}

function feedStarter() {
  return `<div class="soc-fcard starter">
    <h4>Fill your feed</h4>
    <p>Right now this is you and the board. Follow a member or invite someone, and their picks, results, and streaks land here as they happen.</p>
    <div class="soc-verbs">
      <button class="soc-tail" onclick="socialsPane('friends')">Find members</button>
      <button class="soc-fade" onclick="socialsPane('friends')">Invite a friend</button>
    </div>
  </div>`;
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
  haptic('medium'); // native feel (7g): Boost lands with a medium tap
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
  haptic('medium'); // native feel (7g): Tail/Fade land with a medium tap
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
// One /api/friends fetch drives the whole pane, because the friend COUNT decides
// the layout: at zero the invite card is the empty state and sits up top, above
// a solo "your week" card; past zero it drops to the bottom as a standing offer
// and the week card turns into a circle scoreboard.
//
// _friendsLoaded is only latched once the fetch settles. Latching it first meant
// a deep link that beat checkAuth left three empty panes with no way to retry.
async function loadFriendsHub() {
  let friends = [];
  let failed = false;
  try {
    const res = await fetch('/api/friends');
    const d = res.ok ? await res.json() : { friends: [] };
    friends = d.friends || [];
  } catch (_) { failed = true; }
  if (!failed) _friendsLoaded = true;

  renderFriends(friends, failed);
  await Promise.all([renderInvite(friends.length), renderWeek(friends.length), renderSuggested()]);
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
    const html =
      rail('Hot streaks', '', d.hot_streaks) +
      rail('Top this week', `<button class="more" onclick="socialsPane('board')">Board</button>`, d.top_week) +
      rail('Most followed', '', d.most_followed);
    // Every rail gates on a streak, a weekly vote minimum, or existing follower
    // counts, so all three come back empty before launch and this block used to
    // render as an empty string. Say so instead, and point at a surface that is
    // actually populated.
    el.innerHTML = html || emptySuggested();
  } catch (_) { el.innerHTML = emptySuggested(); }
}

function emptySuggested() {
  return `<div class="soc-eyebrow">Members to follow <span class="rule"></span></div>
    <div class="soc-quiet">
      <b>Nobody to suggest yet</b>
      <p>Suggestions show up here as members build a graded record. The leaderboard is the place to look meanwhile.</p>
      <button class="soc-quiet-go" onclick="socialsPane('board')">Board</button>
    </div>`;
}

function renderFriends(friends, failed) {
  const el = document.getElementById('soc-friends-list');
  if (!el) return;
  try {
    if (failed) {
      el.innerHTML = `<div class="soc-eyebrow">Your circle <span class="rule"></span></div>
        <div class="soc-quiet"><b>Couldn't load your circle</b><p>Please try again in a moment.</p>
        <button class="soc-quiet-go" onclick="socialsPane('friends', true)">Retry</button></div>`;
      return;
    }
    // Zero friends is not a dead end any more: the invite card renders above
    // this slot and IS the empty state, so there is nothing useful to say here.
    if (!friends.length) { el.innerHTML = ''; return; }
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
    el.innerHTML = `<div class="soc-eyebrow">Your circle · ${friends.length} <span class="rule"></span></div>${rows}`;
  } catch (_) { el.innerHTML = ''; }
}

// The invite card lives in two slots and only ever fills one. With an empty
// circle it is the pane's empty state and renders high; once there are friends
// it drops to the bottom as a standing offer.
async function renderInvite(friendCount) {
  const top = document.getElementById('soc-invite-top');
  const bottom = document.getElementById('soc-invite');
  if (!top || !bottom) return;
  if (!_referral) {
    try { const res = await fetch('/api/account'); if (res.ok) { const a = await res.json(); _referral = a.referral || null; } } catch (_) {}
  }
  const code = _referral && _referral.code ? _referral.code : null;
  const empty = !friendCount;
  top.innerHTML = empty ? inviteCard(code, _referral, true) : '';
  bottom.innerHTML = empty ? '' : inviteCard(code, _referral, false);
}

function inviteCard(code, ref, lead) {
  const c = code ? esc(code) : '…';
  // "people", never "friends": friends means a mutual follow everywhere else in
  // this app, and someone who redeemed your code is not that. Days come from the
  // server's own days_earned rather than a redemptions x 3 guess, so the number
  // stays right if the grant ever changes.
  const uses = ref && ref.redemptions ? ref.redemptions : 0;
  const days = ref && ref.days_earned != null ? ref.days_earned : uses * 3;
  const progress = uses > 0
    ? `<div class="soc-inv-prog">${uses === 1
        ? `1 person has joined with your code. That is ${days} free ${days === 1 ? 'day' : 'days'} so far.`
        : `${uses} people have joined with your code. That is ${days} free ${days === 1 ? 'day' : 'days'} so far.`}</div>`
    : '';
  const head = lead
    ? `<h4>Right now it is just you and the board</h4>
       <p>Invite someone who follows the same games. When they join with your code you both get 3 free days of full access.</p>`
    : `<h4>Bring a friend, both get 3 days</h4>
       <p>Share your code. When a friend joins with it, you each get 3 free days of full access.</p>`;
  const alt = lead
    ? `<div class="soc-inv-alt">
         <button onclick="socialsPane('board')">Browse the leaderboard</button>
         <button onclick="socFocusSearch()">Search a username</button>
       </div>`
    : '';
  return `${lead ? '<div class="soc-eyebrow">Your circle <span class="rule"></span></div>' : ''}
    <div class="soc-invite">
      ${head}
      <div class="row"><div class="code">${c}</div>
        <button class="go" onclick="socInviteShare('${c}')">Share</button>
        <button class="go ghost" onclick="socCopyCode('${c}')">Copy</button></div>
      ${progress}
      ${alt}
    </div>`;
}

export function socCopyCode(code) {
  if (!code || code === '…') return;
  haptic('light');
  try {
    navigator.clipboard?.writeText(code).then(
      () => { if (window.showToast) window.showToast('Code copied'); }, () => {});
  } catch (_) {}
}

export function socFocusSearch() {
  const input = document.getElementById('soc-search-input');
  if (!input) return;
  // 'center', not 'start': the sub-nav is sticky at a different offset under
  // html.ca-app than on web, and 'start' tucks the input under it in the app.
  input.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => input.focus(), 260);
}

// ── Your week ─────────────────────────────────────────────────────────────────
// The versus layout only appears once the circle has more than one member. At
// n=1 a two-column scoreboard puts a brand-new member against the house, which
// either humiliates them or leads the pane with CappingAlpha's losing week.
// A member with no graded picks sits at exactly 0u, and uCls paints anything
// >= 0 green. "0-0  +0u" in green reads as a winning week that never happened,
// so no-decision rows stay neutral.
function wkCls(r) { return (r && (r.wins || r.losses)) ? uCls(r.units) : ''; }

async function renderWeek(friendCount) {
  const el = document.getElementById('soc-week');
  if (!el) return;
  let rows = [];
  try {
    const res = await fetch('/api/leaderboard?window=week&scope=friends');
    const d = res.ok ? await res.json() : {};
    rows = (d.rows || []).filter(r => !r.is_house);
  } catch (_) { el.innerHTML = ''; return; }

  const me = rows.find(r => r.is_me);
  const mine = me ? `<div class="soc-wk-big ${wkCls(me)}">${uStr(me.units)}</div>
      <div class="soc-wk-sub">${recStr(me)} · ${pctStr(me.win_pct)} win</div>` : '';

  if (!friendCount) {
    el.innerHTML = !me || !(me.wins || me.losses)
      ? `<div class="soc-eyebrow">Your week <span class="rule"></span></div>
         <div class="soc-quiet"><b>No graded picks yet this week</b>
           <p>Vote on a pick or track a bet and your week starts showing up here.</p>
           <button class="soc-quiet-go" onclick="switchTab('mvp')">See today's board</button></div>`
      : `<div class="soc-eyebrow">Your week <span class="rule"></span></div>
         <div class="soc-wk">${mine}
           <p class="soc-wk-note">Add someone to your circle and this card keeps score for them too.</p></div>`;
    return;
  }

  const sorted = [...rows].sort((a, b) => (b.units ?? -1e9) - (a.units ?? -1e9));
  const leader = sorted[0];
  const myIdx = sorted.findIndex(r => r.is_me);
  const versus = (me && leader && leader !== me)
    ? `<div class="soc-vs">
         <div class="side"><div class="nm">You</div><div class="u ${wkCls(me)}">${uStr(me.units)}</div><div class="r">${recStr(me)}</div></div>
         <div class="mid">vs</div>
         <div class="side"><div class="nm">@${esc(leader.username || '')}</div><div class="u ${wkCls(leader)}">${uStr(leader.units)}</div><div class="r">${recStr(leader)}</div></div>
       </div>` : `<div class="soc-wk">${mine}</div>`;
  const place = (me && myIdx >= 0 && sorted.length > 1)
    ? `<div class="soc-wk-note">You are #${myIdx + 1} of ${sorted.length} in your circle this week.</div>` : '';
  const list = sorted.slice(0, 3).map(r => `<div class="soc-wkrow ${r.is_me ? 'me' : ''}" onclick="${r.is_me ? '' : `openMemberModal(${r.user_id}, 'all')`}">
      <span class="nm">${r.is_me ? 'You' : '@' + esc(r.username || '')}</span>
      <span class="r">${recStr(r)}</span>
      <span class="u ${wkCls(r)}">${uStr(r.units)}</span>
    </div>`).join('');
  el.innerHTML = `<div class="soc-eyebrow">Your week in your circle <span class="rule"></span></div>
    <div class="soc-wk">${versus}${place}${list}</div>`;
}

// Share order matters. navigator.share does not exist in an Android WebView at
// all and is unreliable in the iOS one, so the Capacitor plugin comes first and
// the Web Share API is only a web fallback. The url rides as its own field so
// iOS Messages renders a link card instead of raw text.
export async function socInviteShare(code) {
  if (!code || code === '…') return;
  haptic('light');
  const { url, message } = referralInvite(code);
  const plug = window.Capacitor?.Plugins?.Share;
  try {
    if (plug?.share) { await plug.share({ title: 'CappingAlpha', text: message, url }); return; }
    if (navigator.share) { await navigator.share({ title: 'CappingAlpha', text: message, url }); return; }
  } catch (_) { return; }              // a dismissed share sheet is not an error
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(`${message} ${url}`);
      if (window.showToast) window.showToast('Invite message copied');
    }
  } catch (_) {}
}

// Shared referral copy: a ready-to-send message with the ref link that lands the
// recipient right on the signup form with the code already applied (app.js opens
// signup on a ?ref= visit; unlock.js shows the "code applied" banner). Prod domain
// so a link shared from any environment reaches the live site.
// The url is returned separately, never baked into the message, because the
// share sheet wants it as its own field. Only the clipboard fallback joins them.
function referralInvite(code) {
  const url = `https://cappingalpha.com/?ref=${encodeURIComponent(code)}`;
  const message = `3 free days on CappingAlpha, for both of us. It ranks the day's picks and shows how every one of them settles. My code is already applied at this link:`;
  return { url, message };
}

export async function socFollow(btn, userId) {
  if (!state.currentUser) { window.openLogin && window.openLogin(); return; }
  haptic('light');   // the only social verb in the app that had no tap feedback
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
    // A search miss is the highest-intent invite moment in the app: you looked
    // for someone by name and they are not here. Convert it instead of dead-ending.
    if (!members.length) {
      const code = _referral && _referral.code ? esc(_referral.code) : '';
      box.innerHTML = `<div class="soc-quiet" style="margin-top:6px;">
        <b>No member named “${esc(q)}”</b>
        <p>If that is someone you know, send them your code and you both get 3 free days.</p>
        ${code ? `<button class="soc-quiet-go" onclick="socInviteShare('${code}')">Invite</button>` : ''}
      </div>`;
      return;
    }
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
  haptic('selection'); // native feel (7g): sport chip change
  _boardSport = sport || null;
  renderSportRail();
  loadLeaderboard(state.leaderboardWindow || 'week', { scope: _boardScope, sport: _boardSport });
}

// ── expose onclick handlers ────────────────────────────────────────────────────
Object.assign(window, {
  socialsPane, socialsMore, socBoost, socTail, socToggleComments, socSendComment,
  socDeleteComment, socReport, socBlock, socFollow, socInviteShare, socCopyCode,
  socFocusSearch, socialsBoardScope, socialsBoardSport, viewLeaderboard,
});
