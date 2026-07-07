// modules/track.js — Track-Bet sheet, custom bet entry, and the user's bet history.
//
// Two ways to track a bet:
//   - Verified: "Track this side" on a real game (writes a vote; auto-graded; counts
//     on the leaderboard). Handled in modal.js / game-detail.js.
//   - Custom:   a manual bet you log yourself (this module). Personal only, you
//     settle it yourself, never on the leaderboard.

import { state } from './state.js';
import { sportBadge } from './utils.js?v=1';

const BOOKS  = ['DraftKings', 'FanDuel', 'Kalshi', 'Polymarket', 'Other'];
const SPORTS = ['MLB', 'NBA', 'WNBA', 'NHL', 'NFL', 'NCAAF', 'CBB', 'ATP', 'WTA', 'Golf', 'Soccer', 'UFC', 'MMA', 'WCBB', 'Boxing', 'F1', 'NASCAR', 'Cricket', 'Rugby'];

let _bets      = [];
let _betsTotal = 0;
let _filters   = { sport: '', status: 'all', q: '', book: '' };

// Payout preview — mirror of src/odds_math.americanProfit (manual default -110).
function americanProfit(odds, stake) {
  const o = (odds == null || isNaN(parseFloat(odds))) ? -110 : parseFloat(odds);
  return o < 0 ? stake * (100 / Math.abs(o)) : stake * (o / 100);
}
function unitSize() { return Number(window._trackUnitSize) > 0 ? Number(window._trackUnitSize) : 20; }
// Escape any DB-sourced string before it goes into innerHTML (leg selections,
// bet selections). Server strips <> too, this is defense in depth.
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Lightweight toast for tracked/settled/error feedback (Backlog P0 #1).
export function showToast(msg, kind) {
  let host = document.getElementById('ca-toast-host');
  if (!host) { host = document.createElement('div'); host.id = 'ca-toast-host'; document.body.appendChild(host); }
  // One toast at a time — rapid actions replace the previous message instead of stacking.
  host.querySelectorAll('.ca-toast').forEach(el => el.remove());
  const t = document.createElement('div');
  t.className = 'ca-toast' + (kind === 'err' ? ' err' : '');
  t.textContent = msg;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 260); }, 2600);
}

// ── Bet history (renders into #track-bets-content on the My Tracking page) ─────
export async function loadUserBets() {
  const el = document.getElementById('track-bets-content');
  if (!el) return;
  try {
    const res = await fetch('/api/bets?limit=300');
    if (!res.ok) { el.innerHTML = ''; return; }
    const d = await res.json();
    _bets = d.bets || [];
    _betsTotal = d.total != null ? d.total : _bets.length;
    renderBets();
  } catch (_) { el.innerHTML = ''; }
}

// Fetch the next page past the 300-bet window and append it.
export async function loadMoreBets(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
  try {
    const res = await fetch(`/api/bets?limit=300&offset=${_bets.length}`);
    if (res.ok) {
      const d = await res.json();
      _bets = _bets.concat(d.bets || []);
      if (d.total != null) _betsTotal = d.total;
      renderBetList();
      return;
    }
  } catch (_) {}
  if (btn) { btn.disabled = false; btn.textContent = 'Load more'; }
}

function betResultPill(r) {
  r = (r || 'pending').toLowerCase();
  if (r === 'win')  return `<span class="result-win">W</span>`;
  if (r === 'loss') return `<span class="result-loss">L</span>`;
  if (r === 'push') return `<span class="result-push">P</span>`;
  if (r === 'void') return `<span style="color:var(--muted);">Void</span>`;
  return `<span style="color:var(--muted);">Pending</span>`;
}

// A settled bet's P/L. Push/Void return the stake, so render a neutral $0.00 rather
// than a green "+$0.00", which reads like a small win.
function payoutCell(b) {
  if (b.payout == null) return `<span style="color:var(--muted);">—</span>`;
  // Push/Void return the stake; a free-bet loss costs nothing -> neutral, not red.
  if (b.result === 'push' || b.result === 'void' || (b.free_bet && b.result === 'loss'))
    return `<span style="color:var(--muted);font-weight:700;">$0.00</span>`;
  const c = b.payout >= 0 ? '#4ade80' : '#f87171';
  return `<span style="color:${c};font-weight:700;">${b.payout >= 0 ? '+' : ''}$${Math.abs(b.payout).toFixed(2)}</span>`;
}

// One bet passes when it matches every active filter (sport, status, book, search).
function betMatchesFilters(b) {
  if (_filters.sport && (b.sport || '').toUpperCase() !== _filters.sport) return false;
  if (_filters.status === 'pending' && b.result !== 'pending') return false;
  if (_filters.status === 'settled' && b.result === 'pending') return false;
  if (_filters.book && (b.book || '') !== _filters.book) return false;
  if (_filters.q) {
    const hay = `${b.selection || ''} ${b.notes || ''} ${b.book || ''} ${b.sport || ''}`.toLowerCase();
    if (!hay.includes(_filters.q.toLowerCase())) return false;
  }
  return true;
}

// Controls render once; the list re-renders on every filter change so the search
// box never loses focus mid-keystroke.
function renderBets() {
  const el = document.getElementById('track-bets-content');
  if (!el) return;

  // Sport filter options come from the sports actually present in the user's bets.
  const presentSports = [...new Set(_bets.map(b => (b.sport || '').toUpperCase()).filter(Boolean))];
  // Keep the active sport in the list even if settling/deleting left zero matching
  // bets, so the dropdown reflects the real filter instead of silently snapping
  // back to "All sports" while an empty state shows (Backlog P2 #34).
  if (_filters.sport && !presentSports.includes(_filters.sport)) presentSports.push(_filters.sport);
  const sportOpts = ['<option value="">All sports</option>']
    .concat(presentSports.map(s => `<option value="${s}"${_filters.sport === s ? ' selected' : ''}>${s}</option>`))
    .join('');
  const books = [...new Set(_bets.map(b => b.book).filter(Boolean))].sort();
  if (_filters.book && !books.includes(_filters.book)) books.push(_filters.book);
  const bookOpts = ['<option value="">All books</option>']
    .concat(books.map(b => `<option value="${b.replace(/"/g, '&quot;')}"${_filters.book === b ? ' selected' : ''}>${b}</option>`))
    .join('');

  el.innerHTML = `
    <div class="bet-filter-row">
      <input type="search" class="bet-filter bet-q" id="bet-q" placeholder="Search bets..." autocomplete="off"
             value="${(_filters.q || '').replace(/"/g, '&quot;')}" oninput="setBetFilter('q', this.value)" />
      <select class="bet-filter" id="bet-f-sport" onchange="setBetFilter('sport', this.value)">${sportOpts}</select>
      <select class="bet-filter" id="bet-f-status" onchange="setBetFilter('status', this.value)">
        <option value="all"${_filters.status === 'all' ? ' selected' : ''}>All</option>
        <option value="pending"${_filters.status === 'pending' ? ' selected' : ''}>Pending</option>
        <option value="settled"${_filters.status === 'settled' ? ' selected' : ''}>Settled</option>
      </select>
      ${books.length ? `<select class="bet-filter" id="bet-f-book" onchange="setBetFilter('book', this.value)">${bookOpts}</select>` : ''}
    </div>
    <div class="bet-list" id="bet-list-box"></div>`;
  renderBetList();
}

function renderBetList() {
  const box = document.getElementById('bet-list-box');
  if (!box) return;
  const filtered = _bets.filter(betMatchesFilters);

  const rowHtml = (b) => {
    const u = b.units != null ? `${(+b.units).toFixed(2)}u` : '';
    const stake = b.stake ? `$${(+b.stake).toFixed(0)}` : '';
    const payout = payoutCell(b);
    const oddsStr = b.odds > 0 ? `+${b.odds}` : `${b.odds}`;
    const settleBtns = (b.result === 'pending' && !b.espn_game_id)
      ? `<div class="bet-settle-row">
           <button class="bet-settle-btn win"  onclick="event.stopPropagation();settleBetUI(${b.id},'win')">Won</button>
           <button class="bet-settle-btn loss" onclick="event.stopPropagation();settleBetUI(${b.id},'loss')">Lost</button>
           <button class="bet-settle-btn push" onclick="event.stopPropagation();settleBetUI(${b.id},'push')">Push</button>
           <button class="bet-settle-btn push" onclick="event.stopPropagation();settleBetUI(${b.id},'void')">Void</button>
         </div>`
      : '';
    return `
      <div class="bet-row" onclick="openBetDetail(${b.id})" style="cursor:pointer;">
        <div class="bet-row-main">
          <div class="bet-row-sel">${b.selection || '—'} ${b.sport ? sportBadge(b.sport) : ''}${b.free_bet ? '<span class="free-tag"><i class="fa-solid fa-bolt"></i> Free</span>' : ''}</div>
          <div class="bet-row-sub">${oddsStr}${stake ? ' · ' + stake : ''}${u ? ' · ' + u : ''}${b.book ? ' · ' + b.book : ''}</div>
          ${b.notes ? `<div style="font-size:11px;color:var(--muted);font-style:italic;margin-top:2px;">${b.notes}</div>` : ''}
          ${settleBtns}
        </div>
        <div class="bet-row-right">
          <div>${betResultPill(b.result)}</div>
          <div style="margin-top:3px;">${payout}</div>
        </div>
        <i class="fa-solid fa-chevron-right bet-chevron" aria-hidden="true"></i>
      </div>`;
  };

  // Day-grouped feed with a per-day net (Backlog P1 #25).
  const dayLabel = (s) => {
    if (!s) return 'Earlier';
    const t = Date.parse(String(s).replace(' ', 'T') + 'Z');
    return isNaN(t) ? 'Earlier' : new Date(t).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
  };
  let rows;
  if (filtered.length === 0) {
    // Zero matches with an active filter gets a one-tap way out instead of a dead end.
    const anyFilter = _filters.sport || _filters.book || _filters.q;
    const clearBtn = anyFilter
      ? ` <button class="bet-settle-btn push" style="margin-left:8px;" onclick="clearBetFilters()">Clear filters</button>`
      : '';
    rows = `<div style="padding:26px 20px;color:var(--muted);font-size:14px;">${_bets.length === 0
      ? 'No custom bets yet. Tap "Track a Bet" to log one.'
      : `No bets match these filters.${clearBtn}`}</div>`;
  } else {
    const groups = []; const idx = new Map();
    for (const b of filtered) {
      const k = dayLabel(b.settled_at || b.placed_at);
      if (!idx.has(k)) { idx.set(k, groups.length); groups.push({ k, bets: [] }); }
      groups[idx.get(k)].bets.push(b);
    }
    rows = groups.map(g => {
      const net = g.bets.reduce((s, b) => s + (b.result !== 'pending' && b.payout != null ? b.payout : 0), 0);
      const hasSettled = g.bets.some(b => b.result !== 'pending');
      const netStr = hasSettled ? `<span style="color:${net >= 0 ? '#4ade80' : '#f87171'};font-weight:700;">${net >= 0 ? '+' : ''}$${Math.abs(net).toFixed(2)}</span>` : '';
      return `<div class="bet-day-head"><span>${g.k}</span>${netStr}</div>${g.bets.map(rowHtml).join('')}`;
    }).join('');
  }

  // Paging past the first 300: only offer more when unfiltered (offsets and client
  // filters do not mix cleanly, and 300 bets is months of history for most users).
  const more = (!_filters.q && !_filters.book && !_filters.sport && _filters.status === 'all' && _bets.length < _betsTotal)
    ? `<div style="padding:12px 20px;text-align:center;"><button class="bet-settle-btn push" onclick="loadMoreBets(this)">Load more (showing ${_bets.length} of ${_betsTotal})</button></div>`
    : '';
  box.innerHTML = rows + more;
}

export function setBetFilter(key, val) {
  _filters[key] = val;
  // Keep the visible control in sync when a filter is set programmatically
  // (e.g. the Clear filters button), then refresh just the list.
  const ctlId = { sport: 'bet-f-sport', status: 'bet-f-status', book: 'bet-f-book', q: 'bet-q' }[key];
  const ctl = ctlId && document.getElementById(ctlId);
  if (ctl && ctl.value !== val) ctl.value = val;
  renderBetList();
}
export function clearBetFilters() {
  _filters.q = ''; _filters.book = ''; _filters.sport = '';
  renderBets(); // full rebuild resyncs every control
}

// Render the custom-bets list from data already fetched by loadTracking (avoids a
// second /api/bets round-trip).
export function setBetsData(bets, total) {
  _bets = bets || [];
  _betsTotal = total != null ? total : _bets.length;
  renderBets();
}

export async function settleBetUI(id, result) {
  try {
    const res = await fetch(`/api/bets/${id}/settle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result }),
    });
    // Settling works on already-settled custom bets too (the API re-grades), so this
    // doubles as the "fix a mis-settled result" path from the bet detail. Close the
    // sheet on success so it never lingers showing the old result.
    if (res.ok) { showToast('Result updated'); closeTrackSheet(); refreshTracking(); }
    else showToast('Could not update the result.', 'err');
  } catch (_) { showToast('Network error. Try again.', 'err'); }
}

// Delete is gated by an in-app inline confirm (confirmDeleteBet) in the detail
// sheet, so this just performs the delete (no native confirm() — Backlog P2 #27).
export async function deleteBetUI(id) {
  try {
    const res = await fetch(`/api/bets/${id}`, { method: 'DELETE' });
    if (res.ok) { showToast('Bet deleted'); closeTrackSheet(); refreshTracking(); }
    else showToast('Could not delete.', 'err');
  } catch (_) { showToast('Network error. Try again.', 'err'); }
}
// Inline two-step confirm (no native dialog). The delete button hides and a confirm
// row appears in its place; Cancel restores the button without re-rendering the sheet.
export function confirmDeleteBet(id) {
  const btn = document.getElementById('bd-delete-area');
  if (!btn) { deleteBetUI(id); return; }
  if (document.getElementById('bd-confirm-row')) return; // already confirming
  // Insert the confirm row FIRST, hide the button after — if the insert ever fails,
  // the delete button is still there instead of stranding the user.
  btn.insertAdjacentHTML('afterend', `<div class="bd-confirm" id="bd-confirm-row" role="alertdialog" aria-label="Confirm delete">
    <span>Delete this bet?</span>
    <button class="bet-settle-btn loss" onclick="deleteBetUI(${id})">Delete</button>
    <button class="bet-settle-btn push" onclick="cancelDeleteBet()">Cancel</button>
  </div>`);
  btn.style.display = 'none';
  document.querySelector('#bd-confirm-row .bet-settle-btn.push')?.focus();
}
export function cancelDeleteBet() {
  document.getElementById('bd-confirm-row')?.remove();
  const btn = document.getElementById('bd-delete-area');
  if (btn) { btn.style.display = ''; btn.focus(); }
}

// Re-pull the whole tracking view after a mutation so stats + lists stay in sync.
function refreshTracking() {
  if (window.loadTracking) window.loadTracking();
  else loadUserBets();
}

// ── Bet detail / edit (tap a bet row) — Backlog P1 #9 ─────────────────────────
function ensureSheetHost() {
  let host = document.getElementById('track-sheet-host');
  if (!host) { host = document.createElement('div'); host.id = 'track-sheet-host'; document.body.appendChild(host); }
  return host;
}
export function openBetDetail(id) {
  const b = _bets.find(x => x.id === id);
  if (!b) return;
  const pending = b.result === 'pending';
  const oddsStr = b.odds > 0 ? '+' + b.odds : '' + b.odds;
  // A parlay with any game-linked leg auto-grades, so it hides the manual-settle
  // buttons (the server rejects a hand settle on it) the same way single
  // game-linked bets do.
  const autoGraded = !!b.espn_game_id || (b.bet_type === 'parlay' && Array.isArray(b.legs) && b.legs.some(l => l.espn_game_id));
  const host = ensureSheetHost();
  host.innerHTML = `
    <div class="track-overlay" id="track-overlay" onclick="if(event.target===this)closeTrackSheet()">
      <div class="track-sheet" role="dialog" aria-modal="true" aria-label="Bet detail">
        <div class="track-sheet-grab"></div>
        <div class="track-sheet-head"><span>Bet detail</span><button class="track-sheet-x" onclick="closeTrackSheet()" aria-label="Close">✕</button></div>
        <div class="track-form">
          <div class="ob-head" style="margin-bottom:2px;">${esc(b.selection) || '—'} ${b.sport && b.sport !== 'MULTI' ? sportBadge(b.sport) : ''}</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">${betResultPill(b.result)} · ${b.bet_type === 'parlay' ? 'Parlay' : (b.verified ? 'Verified' : 'Custom')}${b.book ? ' · ' + b.book : ''}</div>
          ${(b.bet_type === 'parlay' && Array.isArray(b.legs) && b.legs.length) ? `<div class="pl-legs" style="margin-bottom:12px;">${b.legs.map(l => `
            <div class="pl-leg"><div class="pl-leg-main"><span class="pl-leg-sel">${esc(l.selection)}</span>${l.sport && l.sport !== 'MULTI' ? sportBadge(l.sport) : ''}</div>
              <div class="pl-leg-side">${betResultPill(l.result)}<span class="pl-leg-odds">${l.odds > 0 ? '+' + l.odds : l.odds}</span></div></div>`).join('')}</div>` : ''}
          ${pending ? `
            <div style="display:flex;gap:12px;">
              <div class="settings-field" style="flex:1;"><label for="bd-odds">Odds</label><input type="number" id="bd-odds" value="${b.odds}" step="5" /></div>
              <div class="settings-field" style="flex:1;"><label for="bd-stake">Stake</label><div class="field-prefix-wrap"><span class="field-prefix">$</span><input type="number" id="bd-stake" value="${b.stake}" min="0" step="1" /></div></div>
            </div>
            <div class="settings-field"><label for="bd-notes">Note</label><input type="text" id="bd-notes" value="${(b.notes || '').replace(/"/g, '&quot;')}" maxlength="200" /></div>
            <button class="track-submit" onclick="saveBetEdit(${b.id})">Save changes</button>
            ${!autoGraded ? `<div class="bet-settle-row" style="margin-top:12px;">
              <button class="bet-settle-btn win"  onclick="settleBetUI(${b.id},'win')">Won</button>
              <button class="bet-settle-btn loss" onclick="settleBetUI(${b.id},'loss')">Lost</button>
              <button class="bet-settle-btn push" onclick="settleBetUI(${b.id},'push')">Push</button>
              <button class="bet-settle-btn push" onclick="settleBetUI(${b.id},'void')">Void</button>
            </div>` : `<div class="track-form-note">${b.bet_type === 'parlay' ? 'This parlay grades automatically as its games finish.' : 'This is a game-linked bet. It grades automatically when the game finishes.'}</div>`}
          ` : `
            <div class="bd-rows">
              <div class="bd-row"><span>Odds</span><span>${oddsStr}</span></div>
              <div class="bd-row"><span>Stake</span><span>$${(b.stake || 0).toFixed(2)}</span></div>
              <div class="bd-row"><span>Result</span><span>${b.result}</span></div>
              <div class="bd-row"><span>P/L</span>${payoutCell(b)}</div>
            </div>
            ${b.notes ? `<div class="track-form-note" style="font-style:italic;">${b.notes}</div>` : ''}
            ${!autoGraded ? `
            <div class="track-form-note" style="margin-top:12px;margin-bottom:6px;">Marked it wrong? Update the result:</div>
            <div class="bet-settle-row">
              <button class="bet-settle-btn win"  onclick="settleBetUI(${b.id},'win')">Won</button>
              <button class="bet-settle-btn loss" onclick="settleBetUI(${b.id},'loss')">Lost</button>
              <button class="bet-settle-btn push" onclick="settleBetUI(${b.id},'push')">Push</button>
              <button class="bet-settle-btn push" onclick="settleBetUI(${b.id},'void')">Void</button>
            </div>` : ''}
          `}
          ${b.espn_game_id ? `<button class="track-opt" style="margin-top:12px;" onclick="closeTrackSheet();openGameModal('${b.espn_game_id}')">
            <span class="track-opt-ic" style="background:rgba(59,130,246,.14);color:var(--accent);"><i class="fa-solid fa-arrow-up-right-from-square"></i></span>
            <span><span class="track-opt-t">View game</span><span class="track-opt-d">Open the matchup, lines, and live score.</span></span>
          </button>` : ''}
          ${(b.result === 'win') ? `<button class="track-opt" style="margin-top:12px;" onclick="shareBet(${b.id})">
            <span class="track-opt-ic" style="background:rgba(74,222,128,.14);color:#4ade80;"><i class="fa-solid fa-share-nodes"></i></span>
            <span><span class="track-opt-t">Share this win</span><span class="track-opt-d">Make a card to post or send.</span></span>
          </button>` : ''}
          <button class="track-opt" id="bd-delete-area" style="margin-top:12px;" onclick="confirmDeleteBet(${b.id})">
            <span class="track-opt-ic" style="background:rgba(239,68,68,.14);color:#ef4444;"><i class="fa-solid fa-trash"></i></span>
            <span><span class="track-opt-t" style="color:#ef4444;">Delete bet</span><span class="track-opt-d">Remove it from your tracking.</span></span>
          </button>
        </div>
      </div>
    </div>`;
  requestAnimationFrame(() => document.getElementById('track-overlay')?.classList.add('open'));
}
// ── Share a win (Phase 5) — canvas card, no server ────────────────────────────
// Renders a settled winning bet to a PNG and shares it via the Web Share API
// (mobile) or downloads it (desktop). Pure client, CappingAlpha-branded.
export async function shareBet(id) {
  const b = _bets.find(x => x.id === id);
  if (!b) return;
  const W = 1080, H = 1080, dpr = 1;
  const cv = document.createElement('canvas');
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0b1220'); grad.addColorStop(1, '#0f1117');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  // accent bar
  ctx.fillStyle = '#3b82f6'; ctx.fillRect(0, 0, W, 14);
  const cx = W / 2;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '800 40px system-ui, sans-serif';
  ctx.fillText('CappingAlpha', cx, 120);
  // WINNER badge
  ctx.fillStyle = '#4ade80';
  ctx.font = '900 130px system-ui, sans-serif';
  ctx.fillText('WINNER', cx, 340);
  // selection (wrap)
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 58px system-ui, sans-serif';
  const sel = String(b.selection || 'My bet');
  const words = sel.split(' '); let line = '', y = 470;
  for (const w of words) {
    if (ctx.measureText(line + w).width > W - 160 && line) { ctx.fillText(line.trim(), cx, y); line = ''; y += 74; }
    line += w + ' ';
  }
  ctx.fillText(line.trim(), cx, y);
  // odds + payout stats
  const oddsStr = b.odds > 0 ? '+' + b.odds : '' + b.odds;
  const profit = b.payout != null ? b.payout : 0;
  const unit = Number(window._trackUnitSize) > 0 ? Number(window._trackUnitSize) : 20;
  const uStr = `+${(profit / unit).toFixed(2)}u`;
  ctx.font = '800 84px system-ui, sans-serif';
  ctx.fillStyle = '#4ade80';
  ctx.fillText(`+$${Math.abs(profit).toFixed(2)}`, cx, y + 200);
  ctx.font = '600 44px system-ui, sans-serif';
  ctx.fillStyle = '#8892a4';
  ctx.fillText(`${oddsStr}  ·  ${uStr}${b.book ? '  ·  ' + b.book : ''}`, cx, y + 270);
  // footer
  ctx.fillStyle = '#64748b';
  ctx.font = '500 34px system-ui, sans-serif';
  ctx.fillText('cappingalpha.com', cx, H - 70);

  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  if (!blob) { showToast('Could not make the card.', 'err'); return; }
  const file = new File([blob], 'cappingalpha-win.png', { type: 'image/png' });
  const text = `${sel} cashed. ${oddsStr} on CappingAlpha.`;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text });
      return;
    }
  } catch (_) { /* user canceled or share failed -> fall through to download */ }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'cappingalpha-win.png';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Saved your win card.');
}

export async function saveBetEdit(id) {
  const odds  = parseFloat(document.getElementById('bd-odds')?.value);
  const stake = parseFloat(document.getElementById('bd-stake')?.value);
  const notes = (document.getElementById('bd-notes')?.value || '').trim() || null;
  try {
    const res = await fetch(`/api/bets/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ odds, stake, notes }),
    });
    if (res.ok) { showToast('Bet updated'); closeTrackSheet(); refreshTracking(); }
    else { const d = await res.json().catch(() => ({})); showToast(d.error || 'Could not update.', 'err'); }
  } catch (_) { showToast('Network error. Try again.', 'err'); }
}

// ── Track-Bet sheet ───────────────────────────────────────────────────────────
export function openTrackSheet() {
  if (!state.currentUser) { window.openLogin && window.openLogin(); return; }
  let host = document.getElementById('track-sheet-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'track-sheet-host';
    document.body.appendChild(host);
  }
  host.innerHTML = `
    <div class="track-overlay" id="track-overlay" onclick="if(event.target===this)closeTrackSheet()">
      <div class="track-sheet" role="dialog" aria-modal="true" aria-label="Track a bet">
        <div class="track-sheet-grab"></div>
        <div class="track-sheet-head">
          <span>Track a Bet</span>
          <button class="track-sheet-x" onclick="closeTrackSheet()" aria-label="Close">✕</button>
        </div>
        <div id="track-sheet-body">${sheetMenuHtml()}</div>
      </div>
    </div>`;
  requestAnimationFrame(() => document.getElementById('track-overlay')?.classList.add('open'));
  mountParlayTray(); // resume a running parlay if the sheet was closed mid-build
}

export function closeTrackSheet() {
  stopBoardPoll();
  const ov = document.getElementById('track-overlay');
  if (!ov) return;
  ov.classList.remove('open');
  setTimeout(() => { const h = document.getElementById('track-sheet-host'); if (h) h.innerHTML = ''; }, 180);
}

function sheetMenuHtml() {
  return `
    <button class="track-opt" onclick="trackFromGame()">
      <span class="track-opt-ic" style="background:rgba(59,130,246,.14);color:var(--accent);"><i class="fa-solid fa-magnifying-glass"></i></span>
      <span><span class="track-opt-t">From a game</span><span class="track-opt-d">Pick a side on a real game. Verified, counts on the leaderboard.</span></span>
    </button>
    <button class="track-opt" onclick="showCustomForm()">
      <span class="track-opt-ic" style="background:rgba(251,122,86,.16);color:#fb7a56;"><i class="fa-solid fa-pen"></i></span>
      <span><span class="track-opt-t">Custom bet</span><span class="track-opt-d">Log any bet yourself (props, parlays, anything). Personal tracking only.</span></span>
    </button>
    <button class="track-opt" onclick="showBetScan()">
      <span class="track-opt-ic" style="background:rgba(167,139,250,.16);color:#a78bfa;"><i class="fa-regular fa-image"></i></span>
      <span><span class="track-opt-t">Upload betslip</span><span class="track-opt-d">Snap your betslip and the form fills itself in. Read on your device.</span></span>
    </button>`;
}

export function backToTrackMenu() {
  stopBoardPoll();
  const body = document.getElementById('track-sheet-body');
  if (body) body.innerHTML = sheetMenuHtml();
}

// ── Betslip scan — free OCR, zero API credits ─────────────────────────────────
// Tesseract.js (vendored under /vendor/tesseract, ~10MB lazy-loaded on first use)
// reads the screenshot in the user's own browser; the image never leaves their
// device. A heuristic parser lifts selection/odds/stake/book and prefills the
// custom form for the user to confirm. A Mac-Ollama structuring pass can slot in
// later; the paid Haiku path is never used here.
let _tessWorker = null;
let _tessIdleTimer = null;
// Free the ~100MB wasm worker a minute after the last scan; a rescan just reloads it.
function scheduleTessRelease() {
  if (_tessIdleTimer) clearTimeout(_tessIdleTimer);
  _tessIdleTimer = setTimeout(() => {
    _tessIdleTimer = null;
    if (_tessWorker) { try { _tessWorker.terminate(); } catch (_) {} _tessWorker = null; }
  }, 60000);
}
async function getTessWorker(onProgress) {
  if (_tessWorker) return _tessWorker;
  if (!window.Tesseract) {
    await new Promise((ok, err) => {
      const s = document.createElement('script');
      s.src = '/vendor/tesseract/tesseract.min.js';
      s.onload = ok; s.onerror = () => err(new Error('tesseract load failed'));
      document.head.appendChild(s);
    });
  }
  // Absolute URLs: the worker runs from a blob context where relative paths
  // cannot resolve (importScripts throws on '/vendor/...').
  const base = location.origin + '/vendor/tesseract';
  _tessWorker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: base + '/worker.min.js',
    corePath:   base,
    langPath:   base,
    logger: m => { if (m.status === 'recognizing text' && onProgress) onProgress(Math.round(m.progress * 100)); },
  });
  return _tessWorker;
}

export function showBetScan() {
  stopBoardPoll();
  const body = document.getElementById('track-sheet-body');
  if (!body) return;
  body.innerHTML = `
    <button class="ob-back" onclick="backToTrackMenu()">‹ Back</button>
    <div class="track-form">
      <div class="ob-head" style="margin-bottom:4px;">Upload a betslip</div>
      <div class="track-form-note">Screenshot the slip in your sportsbook app, then choose it here. Reading happens on your device; the image is never uploaded anywhere.</div>
      <label class="track-opt" style="cursor:pointer;">
        <span class="track-opt-ic" style="background:rgba(167,139,250,.16);color:#a78bfa;"><i class="fa-regular fa-image"></i></span>
        <span><span class="track-opt-t">Choose screenshot</span><span class="track-opt-d">PNG or JPG. Tighter crops read better.</span></span>
        <input type="file" accept="image/*" style="display:none;" onchange="scanBetslip(this)" />
      </label>
      <div id="scan-status" style="font-size:13px;color:var(--muted);padding:10px 2px;"></div>
      <button class="track-opt" onclick="showCustomForm()">
        <span class="track-opt-ic" style="background:rgba(251,122,86,.16);color:#fb7a56;"><i class="fa-solid fa-pen"></i></span>
        <span><span class="track-opt-t">Type it in instead</span><span class="track-opt-d">The regular custom bet form.</span></span>
      </button>
    </div>`;
}

export async function scanBetslip(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const st = document.getElementById('scan-status');
  const say = t => { if (st) st.textContent = t; };
  try {
    say('Loading the reader (first time can take a few seconds)...');
    const worker = await getTessWorker(p => say(`Reading your slip... ${p}%`));
    say('Reading your slip...');
    const { data } = await worker.recognize(file);
    const parsed = parseBetslipText(data && data.text || '');
    if (!parsed.selection && parsed.odds == null && parsed.stake == null) {
      say('Could not read a bet off that image. Try a tighter screenshot, or type it in below.');
      return;
    }
    openScannedBet(parsed);
  } catch (_) {
    say('Could not read that image. You can type the bet in below instead.');
  } finally {
    scheduleTessRelease();
  }
}

// Heuristics over the OCR text. Betslips are clean digital screenshots, so plain
// pattern-matching gets the big four (selection, odds, stake, book) most of the time.
function parseBetslipText(raw) {
  const text = String(raw || '');
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 1);
  const lower = text.toLowerCase();
  const out = { selection: '', odds: null, stake: null, book: '', bet_type: 'ml', totalSide: null, line: null };

  for (const [hint, name] of [
    ['draftkings', 'DraftKings'], ['fanduel', 'FanDuel'], ['betmgm', 'BetMGM'],
    ['caesars', 'Caesars'], ['bovada', 'Bovada'], ['betonline', 'BetOnline'],
    ['hard rock', 'Hard Rock'], ['espn bet', 'ESPN BET'], ['betrivers', 'BetRivers'],
    ['pinnacle', 'Pinnacle'], ['kalshi', 'Kalshi'], ['polymarket', 'Polymarket'],
  ]) { if (lower.includes(hint)) { out.book = name; break; } }

  const NOISE = /betslip|bet slip|open bets|settled|cash ?out|share|wager|total|payout|returns|to win|odds|selections?|leg/i;

  // Odds: prefer a candidate sharing a line with real words (the selection line).
  // No lookbehind assertions here: Safari before 16.4 fails to PARSE the whole
  // module on (?<!...), which would blank the entire app for those users. Group 1
  // captures the boundary character instead; group 2 is the odds.
  const oddsRe = /(^|[^\d.])([+-]\d{3,4})(?!\d)/g;
  const oddsIn = (s) => { const found = []; let m; oddsRe.lastIndex = 0; while ((m = oddsRe.exec(s))) found.push(parseFloat(m[2])); return found; };
  const stripOdds = (s) => { oddsRe.lastIndex = 0; return s.replace(oddsRe, (all, p1) => p1); };
  let firstOdds = null;
  for (const l of lines) {
    const found = oddsIn(l);
    if (!found.length) continue;
    if (firstOdds == null) firstOdds = found[0];
    if (/[a-z]{3,}/i.test(stripOdds(l))) { out.odds = found[0]; break; }
  }
  if (out.odds == null) out.odds = firstOdds;

  const stakeM = lower.match(/(?:total wager|wager|risk|stake|bet amount|bet)[^\d$]{0,12}\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (stakeM) out.stake = parseFloat(stakeM[1]);
  else { const d = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/); if (d) out.stake = parseFloat(d[1]); }
  const winM = lower.match(/(?:to win|payout|potential winnings|returns)[^\d$]{0,12}\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (out.odds == null && out.stake > 0 && winM) {
    const ratio = parseFloat(winM[1]) / out.stake;
    if (isFinite(ratio) && ratio > 0) out.odds = ratio >= 1 ? Math.round(ratio * 100) : -Math.round(100 / ratio);
  }

  const ou = text.match(/\b(over|under)\s+(\d+(?:\.\d)?)/i);
  if (ou) { out.bet_type = 'total'; out.totalSide = ou[1].toLowerCase(); out.line = parseFloat(ou[2]); }
  else if (/parlay/i.test(lower)) out.bet_type = 'parlay';
  else if (/spread|run ?line|puck ?line|handicap/i.test(lower)) {
    out.bet_type = 'spread';
    const sp = text.match(/(^|[^\d.])([+-]\d{1,2}(?:\.5)?)(?![\d.])/); // no lookbehind (Safari < 16.4)
    if (sp) out.line = parseFloat(sp[2]);
  } else if (/money ?line/i.test(lower)) out.bet_type = 'ml';

  // Selection: the line carrying the odds, minus the odds token; else the first
  // real-word line that isn't slip chrome or the book's own name.
  const oddsStr = out.odds != null ? (out.odds > 0 ? '+' + out.odds : String(out.odds)) : null;
  let sel = oddsStr ? lines.find(l => l.includes(oddsStr) && /[a-z]{3,}/i.test(stripOdds(l))) : null;
  if (sel) sel = stripOdds(sel).replace(/[|•·]+/g, ' ').trim();
  if (!sel) sel = lines.find(l => /[a-z]{3,}/i.test(l) && !NOISE.test(l) && !(out.book && l.toLowerCase().includes(out.book.toLowerCase()))) || '';
  out.selection = sel.slice(0, 80);
  return out;
}

// Prefill the custom form with whatever the scan found; the user confirms.
function openScannedBet(p) {
  showCustomForm();
  if (p.bet_type === 'total') { setFormField('bet_type', 'total'); if (p.totalSide) setFormField('totalSide', p.totalSide); }
  else if (p.bet_type && p.bet_type !== 'ml') setFormField('bet_type', p.bet_type);
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; };
  set('cf-selection', p.selection);
  set('cf-odds', p.odds);
  set('cf-stake', p.stake);
  set('cf-line', p.line);
  if (p.book) {
    _form.book = p.book;
    document.querySelectorAll('.bet-seg[onclick^="setFormBook"]').forEach(b => b.classList.toggle('active', b.textContent === p.book));
  }
  const form = document.querySelector('#track-sheet-body .track-form');
  if (form) form.insertAdjacentHTML('afterbegin', `<div class="track-form-note" style="border:1px solid rgba(167,139,250,.4);border-radius:8px;padding:8px 10px;"><i class="fa-regular fa-image" style="color:#a78bfa;margin-right:6px;"></i>Read from your screenshot. Double-check the numbers before tracking.</div>`);
  updatePayoutPreview();
}

const TRACK_DAY_MIN = -7;   // a week back (past games = custom)
const TRACK_DAY_MAX = 14;   // two weeks ahead (UFC/soccer cards are often 1-2 weeks out)

let _trackGames    = [];   // today's games (verified-capable, from /api/games)
let _trackSport    = '';
let _trackQuery    = '';
let _trackDay      = 0;     // 0 = today; +/- = other days (custom-only until lines ship)
let _dayMeta       = [];    // [{ offset, dateStr }] for lazy day fetches
let _dayCache      = {};    // offset -> games[] for non-today days
let _sportMenuOpen = false;

function ymd(d) { return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }

// Date strings (YYYYMMDD) for today-7 .. today+7, for lazy per-day fetches.
function buildDayMeta() {
  const out = [];
  const now = new Date();
  for (let i = TRACK_DAY_MIN; i <= TRACK_DAY_MAX; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    out.push({ offset: i, dateStr: i === 0 ? '' : ymd(d) });
  }
  return out;
}
function dateLabel(offset) {
  if (offset === 0)  return 'Today';
  if (offset === -1) return 'Yesterday';
  if (offset === 1)  return 'Tomorrow';
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); // e.g. "Mon Jun 29"
}

// CappingAlpha core sports (we track them with game detail pages + lines). These sort
// to the TOP of the sport dropdown by our betting volume. Every other sport ESPN gives
// us (UFC, Soccer, WCBB, ...) is offered too but sorts to the bottom and is custom-only.
const CORE_SPORTS = ['MLB', 'NBA', 'NHL', 'WNBA', 'NFL', 'NCAAF', 'CBB', 'ATP', 'WTA', 'GOLF', 'SOCCER'];
// Mascot-style last-word shortening reads wrong for soccer clubs ("United",
// "City"), so soccer keeps full names everywhere.
const FULL_NAME_SPORTS = new Set(['SOCCER']);
function sortSports(arr) {
  return arr.slice().sort((a, b) => {
    const ia = CORE_SPORTS.indexOf(a), ib = CORE_SPORTS.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;   // both core: by our order
    if (ia >= 0) return -1;                    // core before extra
    if (ib >= 0) return 1;
    return a.localeCompare(b);                  // extras alphabetical
  });
}
// Does this game have a usable line we can verify-track against? If the odds columns
// aren't in the payload at all (an older /api/games, or the local dev mirror), we can't
// tell from here, so treat it as line-available and let the odds board make the call.
function hasLine(g) {
  if (!g) return false;
  const oddsKnown = ('ml_home' in g) || ('over_under' in g) || ('spread_home' in g);
  if (!oddsKnown) return true;
  return g.ml_home != null || g.ml_away != null || g.over_under != null || g.spread_home != null;
}
// A game is custom-only unless it's today, a core sport we run detail pages for, and we
// have a line for it (Jack: "verified on any game with a line"). Other days come from the
// schedule feed (no odds-board path) and non-core sports are always custom.
function isCustomGame(g) {
  if (!CORE_SPORTS.includes((g.sport || '').toUpperCase())) return true;
  if (_trackDay !== 0) return true;
  return !hasLine(g);
}

export async function trackFromGame() {
  stopBoardPoll();
  const body = document.getElementById('track-sheet-body');
  if (!body) return;
  body.innerHTML = `
    <div class="track-game-search">
      <div class="tg-controls">
        <div class="tg-sportdd" id="tg-sportdd"></div>
        <div class="tg-datestep" id="tg-datestep"></div>
      </div>
      <input type="text" id="tg-search" placeholder="Search a game or team..." oninput="filterTrackGames(this.value)" autocomplete="off" />
      <div id="tg-results" class="tg-results"><div style="padding:14px;color:var(--muted);font-size:13px;">Loading games...</div></div>
    </div>`;
  _trackSport = ''; _trackQuery = ''; _trackDay = 0; _dayCache = {}; _sportMenuOpen = false;
  _dayMeta = buildDayMeta();
  renderDateStep();
  renderSportDropdown();
  mountParlayTray(); // keep a running parlay visible while picking another game
  try {
    const res = await fetch('/api/games');
    _trackGames = res.ok ? await res.json() : [];
  } catch (_) { _trackGames = []; }
  renderSportDropdown();
  renderTrackGames();
  // Merge in today's EXTRA-sport games (UFC, Soccer, etc.) from the separate schedule
  // feed so they show today too. They are custom-only. Core sports already came from
  // /api/games (verified-capable); skip those to avoid duplicates.
  const todayStr = ymd(new Date());
  fetch(`/api/track/schedule?date=${todayStr}`).then(r => r.ok ? r.json() : null).then(d => {
    if (!d || !Array.isArray(d.games) || _trackDay !== 0) return;
    const have = new Set(_trackGames.map(g => String(g.espn_game_id)));
    const extras = d.games.filter(g => !CORE_SPORTS.includes((g.sport || '').toUpperCase()) && !have.has(String(g.espn_game_id)));
    if (!extras.length) return;
    _trackGames = _trackGames.concat(extras);
    renderSportDropdown();
    if (_trackDay === 0) renderTrackGames();
  }).catch(() => {});
}

function currentDayGames() {
  return _trackDay === 0 ? _trackGames : (_dayCache[_trackDay] || []);
}

// ── Sport dropdown (AN-style popup menu) ─────────────────────────────────────
function renderSportDropdown() {
  const el = document.getElementById('tg-sportdd');
  if (!el) return;
  const present = sortSports([...new Set(currentDayGames().map(g => (g.sport || '').toUpperCase()).filter(Boolean))]);
  const opts = ['', ...present];
  const menu = _sportMenuOpen
    ? `<div class="tg-sportdd-menu">${opts.map(s =>
        `<button class="tg-sportdd-item" onclick="setTrackSport('${s}')">${s || 'All Sports'}${_trackSport === s ? '<span class="tg-check">✓</span>' : ''}</button>`
      ).join('')}</div>`
    : '';
  el.innerHTML = `<button class="tg-sportdd-btn" onclick="toggleSportMenu(event)">${_trackSport || 'All Sports'}<span class="tg-caret">▾</span></button>${menu}`;
}
export function toggleSportMenu(e) { if (e) e.stopPropagation(); _sportMenuOpen = !_sportMenuOpen; renderSportDropdown(); }
export function setTrackSport(s) { _trackSport = s; _sportMenuOpen = false; renderSportDropdown(); renderTrackGames(); }
export function filterTrackGames(q) { _trackQuery = q; renderTrackGames(); }

// ── Date stepper (< Today / Mon Jun 29 >) ────────────────────────────────────
function renderDateStep() {
  const el = document.getElementById('tg-datestep');
  if (!el) return;
  el.innerHTML =
    `<button class="tg-datestep-btn" onclick="stepTrackDay(-1)" ${_trackDay <= TRACK_DAY_MIN ? 'disabled' : ''} aria-label="Previous day">‹</button>`
    + `<span class="tg-datestep-label">${dateLabel(_trackDay)}</span>`
    + `<button class="tg-datestep-btn" onclick="stepTrackDay(1)" ${_trackDay >= TRACK_DAY_MAX ? 'disabled' : ''} aria-label="Next day">›</button>`;
}
export function stepTrackDay(delta) {
  const next = Math.max(TRACK_DAY_MIN, Math.min(TRACK_DAY_MAX, _trackDay + delta));
  if (next !== _trackDay) setTrackDay(next);
}

// Switch the active day. Today uses the verified-capable /api/games set already loaded;
// a future day lazily fetches its schedule (custom-only) the first time it's opened.
export async function setTrackDay(offset) {
  _trackDay = offset; _trackSport = ''; _trackQuery = ''; _sportMenuOpen = false;
  const s = document.getElementById('tg-search'); if (s) s.value = '';
  renderDateStep();
  if (offset === 0 || _dayCache[offset]) { renderSportDropdown(); renderTrackGames(); return; }
  const el = document.getElementById('tg-results');
  if (el) el.innerHTML = `<div style="padding:14px;color:var(--muted);font-size:13px;">Loading games...</div>`;
  const meta = _dayMeta.find(c => c.offset === offset);
  try {
    const r = await fetch(`/api/track/schedule?date=${meta.dateStr}`);
    const d = r.ok ? await r.json() : null;
    _dayCache[offset] = (d && d.games) || [];
  } catch (_) { _dayCache[offset] = []; }
  if (_trackDay === offset) { renderSportDropdown(); renderTrackGames(); } // ignore if the user already moved on
}

// Future-day game tapped: open the custom-bet form with the sport preset and the
// matchup as a hint. No odds board / verified tracking for future games (no lines).
export function trackFutureGame(sport, matchup) {
  showCustomForm();
  const sportSel = document.getElementById('cf-sport');
  if (sportSel && sport) sportSel.value = sport;
  const sel = document.getElementById('cf-selection');
  if (sel && matchup) sel.placeholder = `Your pick for ${matchup}`;
  loadKalshiEventStrip(sport, matchup);
}

// ── Kalshi reference prices for custom-only events (fights, races) ────────────
// Fight and race rows have no odds board, so the custom form pulls Kalshi's live
// market for the tapped event and shows tappable prices: tap a fighter/driver and
// the pick, odds, and book fill themselves. Reference only; the bet stays custom.
const FIGHT_SPORTS = new Set(['MMA', 'UFC', 'BOXING']);
const RACE_SPORTS  = new Set(['F1', 'NASCAR', 'RACING']);
let _kalshiEvents = null; // session cache of the (already server-cached) feed

async function loadKalshiEventStrip(sport, matchup) {
  const s = (sport || '').toUpperCase();
  const isFight = FIGHT_SPORTS.has(s), isRace = RACE_SPORTS.has(s);
  if (!isFight && !isRace) return;
  const holder = document.getElementById('cf-kalshi');
  if (!holder) return;
  try {
    if (!_kalshiEvents) {
      const r = await fetch('/api/track/kalshi-events');
      _kalshiEvents = r.ok ? (await r.json()).events || [] : [];
    }
  } catch (_) { _kalshiEvents = []; }
  if (!document.getElementById('cf-kalshi')) return; // form closed while loading

  const words = (t) => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
  let ev = null;
  if (isFight) {
    // Match both fighters' last names against the event's outcome names.
    const names = (matchup || '').split('@').map(x => x.trim()).filter(Boolean);
    const lasts = names.map(n => n.split(' ').pop().toLowerCase()).filter(l => l.length >= 3);
    if (lasts.length === 2) {
      ev = _kalshiEvents.find(e => e.kind === 'fight' &&
        lasts.every(l => e.outcomes.some(o => o.name.toLowerCase().includes(l))));
    }
  } else {
    // Match the race title by word overlap; a lone open race for the sport wins by default.
    const races = _kalshiEvents.filter(e => e.kind === 'race' && e.sport.toUpperCase() === (s === 'RACING' ? e.sport.toUpperCase() : s));
    const mw = new Set(words(matchup));
    ev = races.find(e => words(e.title).filter(w => mw.has(w)).length >= 2) || (races.length === 1 ? races[0] : null);
  }
  if (!ev) return;

  const fmtO = o => (o > 0 ? '+' + o : '' + o);
  const raceName = ev.title.replace(/\s*winner\s*$/i, '');
  const chips = ev.outcomes.map(o => {
    const selText = ev.kind === 'fight' ? `${o.name} to win` : `${o.name} to win ${raceName}`;
    return `<button type="button" class="lc-book" onclick="fillFromKalshiEvent(this)" data-sel="${esc(selText)}" data-odds="${o.american}">${esc(o.name)}<span class="lc-bk"><span class="lc-bk-odds">${fmtO(o.american)}</span></span></button>`;
  }).join('');
  holder.innerHTML = `
    <div class="settings-field">
      <label>Kalshi market${ev.kind === 'race' ? ` · ${esc(raceName)}` : ''} <span style="font-weight:400;text-transform:none;letter-spacing:0;">(tap to fill)</span></label>
      <div class="lc-books">${chips}</div>
    </div>`;
}
export function fillFromKalshiEvent(btn) {
  const sel = document.getElementById('cf-selection');
  const odds = document.getElementById('cf-odds');
  if (sel) sel.value = btn.getAttribute('data-sel') || '';
  if (odds) odds.value = btn.getAttribute('data-odds') || '';
  // Mark the book as Kalshi in the segmented book row (it's in BOOKS).
  const bookBtn = [...document.querySelectorAll('.bet-seg')].find(b => b.textContent.trim() === 'Kalshi' && (b.getAttribute('onclick') || '').includes('setFormBook'));
  if (bookBtn && _form.book !== 'Kalshi') bookBtn.click();
  document.querySelectorAll('#cf-kalshi .lc-book').forEach(b => b.classList.toggle('active', b === btn));
  updatePayoutPreview();
}

function renderTrackGames() {
  const el = document.getElementById('tg-results');
  if (!el) return;
  const otherDay = _trackDay !== 0;   // any day that isn't today -> custom-only (until lines ship)
  const q = (_trackQuery || '').trim().toLowerCase();
  let games = currentDayGames();
  if (_trackSport) games = games.filter(g => (g.sport || '').toUpperCase() === _trackSport);
  if (q.length >= 1) games = games.filter(g => `${g.away_team} ${g.home_team} ${g.sport}`.toLowerCase().includes(q));
  // Live first, then upcoming by time, then finals.
  const rank = g => g.status === 'in' ? 0 : g.status === 'post' ? 2 : 1;
  games = games.slice().sort((a, b) => rank(a) - rank(b) || String(a.start_time || '').localeCompare(String(b.start_time || '')));
  games = games.slice(0, 60);
  if (!games.length) {
    const msg = otherDay ? 'No games scheduled for this day.' : (_trackGames.length ? 'No games match.' : 'No games on the board right now.');
    el.innerHTML = `<div style="padding:14px;color:var(--muted);font-size:13px;">${msg}</div>`;
    return;
  }
  const note = otherDay
    ? `<div style="padding:0 2px 8px;color:var(--muted);font-size:11.5px;">Only today's games support verified tracking right now. Other days are logged as custom bets.</div>`
    : '';
  // Core team sports read better as the mascot (last word); fighters/soccer clubs need
  // the full name ("Toronto FC", "Jefferson Nascimento").
  const nameOf = (full, sport) => {
    const s = (sport || '').toUpperCase();
    return CORE_SPORTS.includes(s) && !FULL_NAME_SPORTS.has(s) ? (full || '').split(' ').pop() : (full || '');
  };
  el.innerHTML = note + games.map(g => {
    const cust = isCustomGame(g);
    const away = nameOf(g.away_team, g.sport);
    const home = nameOf(g.home_team, g.sport);
    const time = g.start_time ? new Date(g.start_time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) : '';
    const isEventRow = !away; // races and other single-entry events: just the name
    const status = cust
      ? (g.status === 'post' ? `Final ${g.away_score ?? ''}-${g.home_score ?? ''}` : time)
      : g.status === 'post' ? `Final ${g.away_score ?? ''}-${g.home_score ?? ''}`
      : g.status === 'in' ? `<span style="color:#38bdf8;">LIVE ${g.away_score ?? 0}-${g.home_score ?? 0}</span>`
      : time;
    const matchup = isEventRow ? home : `${away} @ ${home}`;
    const onclick = cust
      ? `trackFutureGame('${(g.sport || '').toUpperCase()}','${matchup.replace(/'/g, "\\'")}')`
      : `pickTrackGame('${g.espn_game_id}')`;
    const tag = cust ? `<span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:1px 4px;margin-left:5px;">custom</span>` : '';
    return `<button class="tg-row" onclick="${onclick}">
      <span class="tg-matchup">${matchup} ${sportBadge(g.sport)}${tag}</span>
      <span class="tg-status">${status} ›</span>
    </button>`;
  }).join('');
}

// ── Odds board: tap a real line to track it (verified) ────────────────────────
let _board = null;
let _lastBoardId = null;
let _boardPoll = null;
let _boardPollId = null; // which game the live interval belongs to
const BOARD_POLL_MS = 45000; // stale odds are a top tracker complaint; keep the board honest

function stopBoardPoll() { if (_boardPoll) { clearInterval(_boardPoll); _boardPoll = null; } _boardPollId = null; }

// Text snapshot of the board's lines (label -> odds text) for change flashing.
function snapshotBoardLines() {
  const m = {};
  document.querySelectorAll('#track-sheet-body .ob-line').forEach(b => {
    const label = b.querySelector('.ob-line-label')?.textContent || '';
    if (label) m[label] = b.querySelector('.ob-line-odds')?.textContent || '';
  });
  return m;
}
function flashChangedLines(before) {
  document.querySelectorAll('#track-sheet-body .ob-line').forEach(b => {
    const label = b.querySelector('.ob-line-label')?.textContent || '';
    const now = b.querySelector('.ob-line-odds')?.textContent || '';
    if (label && before[label] != null && before[label] !== now) b.classList.add('obflash');
  });
}

// Refresh the board's numbers while it stays open. Pauses itself the moment the
// user moves to the confirm slide, the custom form, or the game list; a moved
// number flashes so the change is impossible to miss.
function startBoardPoll(id) {
  stopBoardPoll();
  _boardPollId = id;
  _boardPoll = setInterval(async () => {
    if (_boardPollId !== id) { stopBoardPoll(); return; } // board moved to another game
    const body = document.getElementById('track-sheet-body');
    if (!body || !body.querySelector('.ob-grid')) { stopBoardPoll(); return; }
    try {
      const res = await fetch(`/api/game/${id}`);
      if (!res.ok) return;
      const fresh = await res.json();
      if (!fresh || !fresh.game) return;
      const before = snapshotBoardLines();
      _board = fresh;
      renderOddsBoard();
      flashChangedLines(before);
    } catch (_) {}
  }, BOARD_POLL_MS);
}

// Open the sheet straight at a specific line's confirm slide. Used by the game
// detail page: tapping a vote button lands here with that page's game + slot,
// so the user goes from "I like this side" to a filled-in betslip in one tap.
// Works logged-out too: the 401 path in confirmTrackBet raises the login modal.
export async function openTrackForSlot(id, slot) {
  let host = document.getElementById('track-sheet-host');
  if (!host) { host = document.createElement('div'); host.id = 'track-sheet-host'; document.body.appendChild(host); }
  host.innerHTML = `
    <div class="track-overlay" id="track-overlay" onclick="if(event.target===this)closeTrackSheet()">
      <div class="track-sheet" role="dialog" aria-modal="true" aria-label="Track a bet">
        <div class="track-sheet-grab"></div>
        <div class="track-sheet-head">
          <span>Track a Bet</span>
          <button class="track-sheet-x" onclick="closeTrackSheet()" aria-label="Close">✕</button>
        </div>
        <div id="track-sheet-body"><div style="padding:20px;color:var(--muted);font-size:13px;">Loading lines...</div></div>
      </div>
    </div>`;
  requestAnimationFrame(() => document.getElementById('track-overlay')?.classList.add('open'));
  await pickTrackGame(id);
  // Simulate tapping the requested line so labels, live swaps, and disabled
  // states all come from the one true render path. If the line has no number,
  // the board stays up and explains itself.
  const btn = [...document.querySelectorAll('#track-sheet-body .ob-line')]
    .find(b => (b.getAttribute('onclick') || '').includes(`'${slot}'`) && !b.disabled);
  if (btn) btn.click();
}

export async function pickTrackGame(id) {
  stopBoardPoll(); // switching games: never let the old game's interval outlive its board
  _lastBoardId = id;
  const body = document.getElementById('track-sheet-body');
  if (body) body.innerHTML = `<div style="padding:20px;color:var(--muted);font-size:13px;">Loading lines...</div>`;
  try {
    const res = await fetch(`/api/game/${id}`);
    _board = res.ok ? await res.json() : null;
  } catch (_) { _board = null; }
  renderOddsBoard();
}

const _odds = o => (o == null || o === '' ? '—' : (o > 0 ? '+' + o : '' + o));
const _sp   = s => (s == null || s === '' ? '—' : (s > 0 ? '+' + s : '' + s));

// Win probability -> American odds (mirror of src/implied_lines.js).
function pmToAmerican(p) {
  const x = Number(p);
  if (!isFinite(x) || x <= 0 || x >= 1) return null;
  return x >= 0.5 ? Math.round(-(x / (1 - x)) * 100) : Math.round(((1 - x) / x) * 100);
}
// Derive a line from the board's cached prediction-market data (Polymarket, then Kalshi).
function impliedFromBoard(board) {
  const source = board.polymarket ? 'polymarket' : (board.kalshi ? 'kalshi' : null);
  const raw = board.polymarket || board.kalshi;
  if (!raw || !raw.markets_json) return null;
  let m; try { m = JSON.parse(raw.markets_json); } catch (_) { return null; }
  const ml = m.moneyline || {}, sp = m.spread || {}, tot = m.total || {};
  const o = {
    source,
    ml_home: pmToAmerican(ml.home_prob), ml_away: pmToAmerican(ml.away_prob),
    spread_home: sp.line != null ? +sp.line : null, spread_away: sp.line != null ? -sp.line : null,
    over_under: tot.line != null ? +tot.line : null,
    ou_over_odds: pmToAmerican(tot.over_prob), ou_under_odds: pmToAmerican(tot.under_prob),
  };
  if (o.ml_home == null && o.over_under == null && o.spread_home == null) return null;
  return o;
}

function renderOddsBoard() {
  const body = document.getElementById('track-sheet-body');
  if (!body) return;
  if (!_board || !_board.game) {
    stopBoardPoll();
    body.innerHTML = `<button class="ob-back" onclick="trackFromGame()">‹ Games</button>
      <div style="padding:18px 0;color:var(--muted);font-size:14px;">Could not load this game's lines.</div>
      <button class="track-submit" style="width:auto;padding:10px 18px;" onclick="pickTrackGame('${_lastBoardId}')">Retry</button>`;
    return;
  }
  const g = _board.game;
  // No sportsbook line? Fall back to the free prediction-market implied line (Polymarket
  // first, then Kalshi). In prod the server already fills this; locally the dev mirror
  // serves the old /api/game, so we derive it here from the market data in the payload.
  if (g.ml_home == null && g.ml_away == null && g.over_under == null && g.spread_home == null) {
    const imp = impliedFromBoard(_board);
    if (imp) { Object.assign(g, imp); g.line_source = g.line_source || imp.source; }
  }
  const id = g.espn_game_id;
  const finished = g.status === 'post';        // only a FINAL game closes tracking
  const live     = g.status === 'in';          // live games stay open, tracked at the live line
  const away = g.away_team || 'Away', home = g.home_team || 'Home';
  const fullNames = FULL_NAME_SPORTS.has((g.sport || '').toUpperCase());
  const awayN = fullNames ? away : away.split(' ').pop();
  const homeN = fullNames ? home : home.split(' ').pop();

  // Live game: prefer the current DraftKings line (freshest) for the numbers we show +
  // lock, so the live bolt reflects the price right now, not the morning open.
  if (live) {
    const dk = (_board.lines || {}).draftkings;
    if (dk) {
      if (dk.ml_home != null) g.ml_home = dk.ml_home;
      if (dk.ml_away != null) g.ml_away = dk.ml_away;
      if (dk.spread_home != null) g.spread_home = dk.spread_home;
      if (dk.spread_away != null) g.spread_away = dk.spread_away;
      if (dk.over_under != null) g.over_under = dk.over_under;
      if (dk.ou_over_odds != null) g.ou_over_odds = dk.ou_over_odds;
      if (dk.ou_under_odds != null) g.ou_under_odds = dk.ou_under_odds;
    }
  }
  // Live odds get a pulsing dot, NOT the bolt — the bolt is the free-bet mark everywhere
  // else, and doubling it up read as "this line is a free bet".
  const bolt = live ? '<span class="ob-livedot" title="Live odds right now"></span>' : '';

  // Tap a line -> the confirmation slide. `numOdds` is the raw number (or null).
  const line = (slot, label, numOdds, disabled) => `
    <button class="ob-line${disabled ? ' ob-line-off' : ''}" ${disabled ? 'disabled' : `onclick="openLineConfirm('${id}','${slot}','${String(label).replace(/'/g, "\\'")}',${numOdds == null ? 'null' : numOdds})"`}>
      <span class="ob-line-label">${label}</span>
      <span class="ob-line-odds">${bolt}${_odds(numOdds)}</span>
    </button>`;

  // Disable a line when its underlying number is missing — tracking a "—" line
  // creates an ungradeable / mis-priced vote (Backlog P0 #2).
  const hasML = g.ml_home != null || g.ml_away != null;
  const hasSpread = g.spread_home != null || g.spread_away != null;
  const noLines = !hasML && !hasSpread && g.over_under == null;
  // The CA/Live line label rides on the FIRST section header (right side), so it sits
  // level with "Moneyline" instead of floating above the grid (Jack's image 3).
  const caText  = live ? 'Live Line' : 'CA Line';
  const caTitle = live ? 'Live line right now' : "CappingAlpha's line, estimated from the books we track";
  let _firstSec = true;
  const secHead = (title) => {
    const tag = (_firstSec && !finished && !noLines)
      ? `<span class="ob-caline-tag${live ? ' live' : ''}" title="${caTitle}">${caText}</span>` : '';
    _firstSec = false;
    return `<div class="ob-section">${title}${tag}</div>`;
  };
  const lines = finished ? '' : `
    ${hasML ? `${secHead('Moneyline')}
    ${line('away_ml', `${awayN}`, g.ml_away, g.ml_away == null)}
    ${line('home_ml', `${homeN}`, g.ml_home, g.ml_home == null)}` : ''}
    ${hasSpread ? `${secHead('Spread')}
    ${line('away_spread', `${awayN} ${_sp(g.spread_away)}`, -110, g.spread_away == null)}
    ${line('home_spread', `${homeN} ${_sp(g.spread_home)}`, -110, g.spread_home == null)}` : ''}
    ${g.over_under != null ? `${secHead('Total')}
    ${line('over',  `Over ${g.over_under}`,  g.ou_over_odds, false)}
    ${line('under', `Under ${g.over_under}`, g.ou_under_odds, false)}` : ''}
    ${noLines ? `<div class="track-form-note" style="margin-top:4px;">No betting lines posted for this game yet. Use Custom bet to log it.</div>` : ''}`;

  body.innerHTML = `
    <button class="ob-back" onclick="trackFromGame()">‹ Games</button>
    <div class="ob-head">${away} @ ${home} ${sportBadge(g.sport)}${live ? ' <span class="ob-live">LIVE</span>' : ''}</div>
    <div class="track-form-note">${finished
      ? 'This game is final, so tracking is closed. Use Custom bet to log it.'
      : live
        ? `<span class="ob-livedot"></span> Live odds. Tap a line to track it at the live number, graded automatically.`
        : `Tap a line to track it. Verified, locked at this number, graded automatically.${g.line_source ? ` <span style="color:#a78bfa;">Line via ${g.line_source === 'kalshi' ? 'Kalshi' : 'Polymarket'}</span>` : ''}`}</div>
    ${finished ? '' : `<div class="ob-grid">${lines}</div>`}
    <button class="track-opt" style="margin-top:12px;" onclick="showCustomForm()">
      <span class="track-opt-ic" style="background:rgba(251,122,86,.16);color:#fb7a56;"><i class="fa-solid fa-pen"></i></span>
      <span><span class="track-opt-t">Log it as a custom bet instead</span><span class="track-opt-d">Set your own stake, odds, and book.</span></span>
    </button>`;
  if (finished || noLines) stopBoardPoll();
  else if (!_boardPoll || _boardPollId !== id) startBoardPoll(id);
  mountParlayTray();
}

let _trackingLine = false;
export async function trackLine(id, slot, label) {
  if (_trackingLine) return;            // guard against double-tap (Backlog P0 #4)
  _trackingLine = true;
  document.querySelectorAll('.ob-line').forEach(b => { b.disabled = true; });
  try {
    const res = await fetch(`/api/game/${id}/vote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot }),
    });
    if (res.status === 401) { window.openLogin && window.openLogin(); return; }
    if (res.status === 409) { showToast('That game has started — verified tracking is closed.', 'err'); return; }
    if (!res.ok) { showToast('Could not track that. Try again.', 'err'); return; }
    showToast('Tracked' + (label ? ': ' + label : '') + ' (verified)');
    closeTrackSheet();
    refreshTracking();
  } catch (_) {
    showToast('Network error. Try again.', 'err');
  } finally {
    _trackingLine = false;
    document.querySelectorAll('.ob-line').forEach(b => { b.disabled = false; });
  }
}

// ── Confirmation slide (tap a line -> configure -> Track Bet) ─────────────────
// AN-style editable slip: Odds, Line (spread/total), Risk, and To Win are all editable
// and stay in sync. A bet is VERIFIED (1 unit at the CA line, on the leaderboard) while
// its odds AND its line sit inside the range of the books we track (within 9% on decimal
// odds) and the risk is left at 1 unit. Move any of those out — or make it a free bet —
// and it becomes a personal custom bet (still auto-graded off the game).
let _confirm = null;

const VERIFY_TOL = 0.09; // 9% outside the book range still counts (Jack's rule)

function americanToDecimal(a) { a = Number(a); if (!isFinite(a) || a === 0) return null; return a < 0 ? 1 + 100 / Math.abs(a) : 1 + a / 100; }
function decimalToAmerican(d) {
  d = Number(d);
  if (!isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
}
const fmtAm = a => (a == null ? '—' : a > 0 ? '+' + a : '' + a);
function rangeOf(nums) {
  const v = nums.filter(n => n != null && isFinite(n));
  if (!v.length) return null;
  return { lo: Math.min(...v), hi: Math.max(...v) };
}

function slotToBet(slot) {
  if (slot === 'home_ml' || slot === 'away_ml') return 'ml';
  if (slot === 'home_spread' || slot === 'away_spread') return 'spread';
  return slot; // 'over' | 'under'
}
// Display names for every book key the engine or the crons can produce.
const BOOK_LABELS = {
  draftkings: 'DraftKings', fanduel: 'FanDuel', espnbet: 'ESPN BET', caesars: 'Caesars',
  betmgm: 'BetMGM', betrivers: 'BetRivers', bet365: 'bet365', hardrock: 'Hard Rock',
  pinnacle: 'Pinnacle', bovada: 'Bovada', betonline: 'BetOnline', thunderpick: 'Thunderpick',
};
// Books shown as information only (unlicensed in the US): tagged, never linked.
// Keep in sync with OFFSHORE in game-detail.js and OFFSHORE_BOOKS in odds_ingest.js.
const OFFSHORE_BOOKS = new Set(['bovada', 'betonline', 'thunderpick', 'pinnacle', 'mybookie', 'betus']);
const isOffshoreLabel = (lbl) => OFFSHORE_BOOKS.has(String(lbl).toLowerCase().replace(/[^a-z0-9]/g, ''));

// Per-book odds + line for a slot, from the books we scrape. Spread juice isn't stored
// per book (it's a flat -110); the meaningful spread number is the LINE. Powers the
// combined book picker AND the verified range.
function bookInfoForSlot(slot) {
  const L = (_board && _board.lines) || {};
  const isSpread = slot === 'home_spread' || slot === 'away_spread';
  const oddsField = { home_ml: 'ml_home', away_ml: 'ml_away', over: 'ou_over_odds', under: 'ou_under_odds' }[slot];
  const lineField = { home_spread: 'spread_home', away_spread: 'spread_away', over: 'over_under', under: 'over_under' }[slot];
  const label = BOOK_LABELS;
  const out = [];
  const add = (key, obj) => {
    if (!obj) return;
    const line = lineField ? obj[lineField] : null;
    let odds;
    if (isSpread) { if (line == null) return; odds = -110; }
    else { odds = obj[oddsField]; if (odds == null) return; }
    out.push({ book: label[key] || (key.charAt(0).toUpperCase() + key.slice(1)), odds, line: line == null ? null : +line });
  };
  add('draftkings', L.draftkings); add('fanduel', L.fanduel);
  Object.keys(L).forEach(k => { if (k !== 'draftkings' && k !== 'fanduel' && L[k]) add(k, L[k]); });
  return out;
}
// Prediction-market implied odds+line for a slot (Polymarket first, then Kalshi).
function impliedInfoForSlot(slot) {
  const imp = impliedFromBoard(_board);
  if (!imp) return null;
  const odds = { home_ml: imp.ml_home, away_ml: imp.ml_away, over: imp.ou_over_odds, under: imp.ou_under_odds, home_spread: -110, away_spread: -110 }[slot];
  const line = { home_spread: imp.spread_home, away_spread: imp.spread_away, over: imp.over_under, under: imp.over_under }[slot];
  if (odds == null && line == null) return null;
  return { book: imp.source === 'kalshi' ? 'Kalshi' : 'Polymarket', odds: odds == null ? -110 : odds, line: line == null ? null : +line };
}

// Current selection label, reflecting any edit to the line (e.g. "Angels +2.5", "Over 9").
function lcSelLabel() {
  const c = _confirm; if (!c) return '';
  if (!c.hasLine) return c.sideName;
  const el = document.getElementById('lc-line');
  const ln = el && el.value !== '' ? parseFloat(el.value) : c.caLine;
  if (ln == null || isNaN(ln)) return c.sideName;
  return c.isSpread ? `${c.sideName} ${ln > 0 ? '+' + ln : ln}` : `${c.sideName} ${ln}`;
}

export function openLineConfirm(id, slot, label, caOdds) {
  const g = _board && _board.game; if (!g) return;
  stopBoardPoll(); // the confirm slide locks the user's numbers; no background rewrites
  const isSpread = slot === 'home_spread' || slot === 'away_spread';
  const isTotal  = slot === 'over' || slot === 'under';
  const hasLine  = isSpread || isTotal;
  const fullNames = FULL_NAME_SPORTS.has((g.sport || '').toUpperCase());
  const awayN = fullNames ? (g.away_team || 'Away') : (g.away_team || 'Away').split(' ').pop();
  const homeN = fullNames ? (g.home_team || 'Home') : (g.home_team || 'Home').split(' ').pop();
  const sideName = { home_ml: homeN, away_ml: awayN, home_spread: homeN, away_spread: awayN, over: 'Over', under: 'Under' }[slot];
  const caLine = isSpread ? (slot === 'home_spread' ? g.spread_home : g.spread_away)
               : isTotal  ? g.over_under : null;
  const books = bookInfoForSlot(slot);
  const imp   = impliedInfoForSlot(slot);
  // Verified bands: decimal-odds range across the books we track (+ the CA number), and,
  // for spread/total, the line range. 9% of slack outside either edge still counts.
  const oddsDecs = books.map(b => americanToDecimal(b.odds)).concat(americanToDecimal(caOdds));
  if (imp) oddsDecs.push(americanToDecimal(imp.odds));
  const oddsRange = rangeOf(oddsDecs);
  const lineRange = hasLine ? rangeOf(books.map(b => b.line).concat(caLine, imp ? imp.line : null)) : null;

  _confirm = {
    id, slot, betKind: slotToBet(slot), label, sideName,
    caOdds: caOdds == null ? null : Number(caOdds),
    caLine: caLine == null ? null : Number(caLine),
    hasLine, isSpread, isTotal, books, imp, oddsRange, lineRange,
    book: '', freeBet: false, verified: true,
  };

  const body = document.getElementById('track-sheet-body'); if (!body) return;
  const caTxt = _confirm.caOdds != null ? (_confirm.caOdds > 0 ? '+' + _confirm.caOdds : '' + _confirm.caOdds) : '—';
  const lineTxt = _confirm.caLine != null ? (isSpread && _confirm.caLine > 0 ? '+' + _confirm.caLine : '' + _confirm.caLine) : '—';
  const lineLeg = isTotal ? sideName : 'Spread'; // AN labels the total box by its side (Over/Under)
  const unit = unitSize();

  // Action-Network-style row: Risk / To Win / [Line] / Odds side by side (fieldset boxes).
  const fields = `
    <fieldset class="lc-field"><legend>Risk</legend><div class="lc-fin"><span class="lc-fpre">$</span><input type="number" id="lc-stake" value="${unit}" min="0" step="1" oninput="onConfirmField('risk')" /></div></fieldset>
    <fieldset class="lc-field"><legend>To win</legend><div class="lc-fin"><span class="lc-fpre">$</span><input type="number" id="lc-towin" min="0" step="1" oninput="onConfirmField('towin')" /></div></fieldset>
    ${hasLine ? `<fieldset class="lc-field"><legend>${lineLeg}</legend><div class="lc-fin"><span class="lc-fpre lc-sign" id="lc-linepre" style="display:none;">+</span><input type="number" id="lc-line" value="${_confirm.caLine ?? ''}" step="0.5" oninput="onConfirmField('line')" /></div></fieldset>` : ''}
    <fieldset class="lc-field"><legend>Odds</legend><div class="lc-fin"><span class="lc-fpre lc-sign" id="lc-oddspre" style="display:none;">+</span><input type="number" id="lc-odds" value="${_confirm.caOdds ?? ''}" step="5" oninput="onConfirmField('odds')" /></div></fieldset>`;

  body.innerHTML = `
    <button class="ob-back" onclick="pickTrackGame('${id}')">‹ Board</button>
    <div class="lc-sel"><span id="lc-sel">${lcSelLabel()}</span> ${sportBadge(g.sport)}</div>
    <div class="track-form">
      <div class="lc-fields ${hasLine ? 'four' : 'three'}">${fields}</div>
      <div class="lc-caref">CA Line ${caTxt}${hasLine ? ` · ${lineLeg} ${lineTxt}` : ''}</div>
      <div class="lc-mode" id="lc-mode"></div>
      <div class="settings-field">
        <div class="lc-book-head">
          <label style="margin:0;">Book<span class="lc-book-sel" id="lc-book-sel"></span></label>
          <button type="button" class="lc-compare-toggle" id="lc-compare-toggle" onclick="toggleBookCompare()">Compare ${_confirm.books.length + (_confirm.imp ? 1 : 0)} book${(_confirm.books.length + (_confirm.imp ? 1 : 0)) === 1 ? '' : 's'} <i class="fa-solid fa-chevron-down" style="font-size:9px;"></i></button>
        </div>
        <div class="lc-compare" id="lc-compare" style="display:none;">${renderBookCompare()}</div>
      </div>
      <div id="lc-note-area">
        <button type="button" class="lc-addnote" id="lc-addnote" onclick="toggleAddNote()"><i class="fa-solid fa-plus"></i> Add a note</button>
      </div>
      <div class="lc-freebet-row">
        <button type="button" class="lc-freebet" id="lc-freebet" onclick="toggleConfirmFreeBet()"><i class="fa-solid fa-bolt"></i> Free Bet</button>
      </div>
      <button class="track-submit" id="lc-submit" onclick="confirmTrackBet()">Track Bet</button>
      <button type="button" class="lc-addleg" id="lc-addleg" onclick="addLegToParlay()"><i class="fa-solid fa-layer-group"></i> ${_parlayLegs.length ? 'Add to parlay' : 'Start a parlay'}</button>
      <div class="form-error" id="lc-error" style="margin-top:8px;font-size:12px;"></div>
    </div>`;
  onConfirmField('odds'); // seed To Win + verified state
  mountParlayTray();
}

// The book picker IS the compare table: every book's price for this pick, side by
// side, so the user line-shops right where they choose the book. Best payout is
// highlighted green; tapping a row selects that book AND loads its number onto the
// ticket. Offshore books are tagged. Ends with an Other row for unlisted books.
function renderBookCompare() {
  const c = _confirm; if (!c) return '';
  // One unified list: scraped books (index i -> pickConfirmBook(i)) + the implied
  // market ('imp'). Best price = highest decimal odds (biggest payout for the side).
  const entries = c.books.map((b, i) => ({ ...b, sel: String(i) }));
  if (c.imp) entries.push({ ...c.imp, sel: 'imp' });
  let bestDec = -Infinity;
  for (const e of entries) { const d = americanToDecimal(e.odds); if (d != null && d > bestDec) bestDec = d; }
  const fmtO = o => (o == null ? '—' : o > 0 ? '+' + o : '' + o);
  const lineStr = (ln) => {
    if (ln == null) return '';
    if (c.isSpread) return ln > 0 ? '+' + ln : '' + ln;
    if (c.isTotal)  return (c.slot === 'over' ? 'o' : 'u') + ln;
    return '';
  };
  const rows = entries.map(e => {
    const dec = americanToDecimal(e.odds);
    const best = dec != null && Math.abs(dec - bestDec) < 1e-9;
    const off = isOffshoreLabel(e.book);
    const ls = lineStr(e.line);
    return `<button type="button" class="lc-cmp-row${best ? ' best' : ''}${c.book === e.book ? ' active' : ''}" data-book="${e.book}" onclick="pickConfirmBook(${e.sel === 'imp' ? "'imp'" : e.sel})">
      <span class="lc-cmp-book">${e.book}${off ? '<span class="lc-cmp-off">offshore</span>' : ''}</span>
      <span class="lc-cmp-line">${ls || ''}</span>
      <span class="lc-cmp-odds">${fmtO(e.odds)}</span>
    </button>`;
  }).join('');
  const otherRow = `<button type="button" class="lc-cmp-row lc-cmp-other${c.book === 'Other' ? ' active' : ''}" data-book="Other" onclick="pickConfirmBook('other')">
      <span class="lc-cmp-book">Other</span><span class="lc-cmp-line"></span><span class="lc-cmp-odds"></span>
    </button>`;
  return `<div class="lc-cmp-head"><span>Book</span><span>Line</span><span>Odds</span></div>${rows}${otherRow}
    ${entries.length ? '<div class="lc-cmp-note">Best payout in green. Tap a book to load its number.</div>' : ''}`;
}
export function toggleBookCompare() {
  const el = document.getElementById('lc-compare');
  const tog = document.getElementById('lc-compare-toggle');
  if (!el) return;
  const open = el.style.display === 'none';
  el.style.display = open ? '' : 'none';
  if (tog) tog.classList.toggle('open', open);
}
export function pickConfirmBook(idx) {
  const c = _confirm; if (!c) return;
  let info = null, book = 'Other';
  if (idx === 'other') book = 'Other';
  else if (idx === 'imp') { info = c.imp; book = c.imp.book; }
  else { info = c.books[idx]; book = info.book; }
  // Toggle off if re-tapping the selected book.
  if (c.book === book) { c.book = ''; refreshBookHighlight(); return; }
  c.book = book;
  if (info) {
    const oddsEl = document.getElementById('lc-odds'); if (oddsEl && info.odds != null) oddsEl.value = info.odds;
    if (c.hasLine && info.line != null) { const lnEl = document.getElementById('lc-line'); if (lnEl) lnEl.value = info.line; }
    onConfirmField('odds'); // recompute To Win + verified + selection label
  } else {
    refreshBookHighlight();
  }
}
function refreshBookHighlight() {
  document.querySelectorAll('#lc-compare .lc-cmp-row').forEach(el =>
    el.classList.toggle('active', el.getAttribute('data-book') === _confirm.book));
  // With the chips gone, the collapsed state still shows which book is on the ticket.
  const sel = document.getElementById('lc-book-sel');
  if (sel) sel.textContent = _confirm.book ? ` · ${_confirm.book}` : '';
}

// Keep Odds / Risk / To Win in sync, with the ODDS held fixed. Editing To Win solves for
// the Risk; editing Risk (or Odds) recomputes To Win. Editing the line re-labels the
// selection. Any change re-checks whether the ticket still lands inside the verified band.
export function onConfirmField(which) {
  const oddsEl = document.getElementById('lc-odds');
  const riskEl = document.getElementById('lc-stake');
  const winEl  = document.getElementById('lc-towin');
  const odds = parseFloat(oddsEl?.value);
  const risk = parseFloat(riskEl?.value);
  const win  = parseFloat(winEl?.value);
  const perDollar = (isFinite(odds) && odds !== 0) ? (odds < 0 ? 100 / Math.abs(odds) : odds / 100) : null;
  if (which === 'towin') {
    // Editing To Win adjusts the Risk, keeping the odds where they are.
    if (perDollar && perDollar > 0 && isFinite(win) && win >= 0 && riskEl) riskEl.value = (win / perDollar).toFixed(2);
  } else if (which !== 'line') {
    // Editing Risk or Odds recomputes To Win.
    if (perDollar && isFinite(risk) && risk > 0 && winEl) winEl.value = (risk * perDollar).toFixed(2);
  }
  if (which === 'line') { const s = document.getElementById('lc-sel'); if (s) s.textContent = lcSelLabel(); }
  syncSignPrefix();
  updateConfirmMode();
}
// A number input can't render a leading "+", so show a "+" prefix element only when the
// odds (or a spread line) are positive. Negatives keep the input's own "-".
function syncSignPrefix() {
  const o = parseFloat(document.getElementById('lc-odds')?.value);
  const op = document.getElementById('lc-oddspre'); if (op) op.style.display = (isFinite(o) && o > 0) ? '' : 'none';
  const lp = document.getElementById('lc-linepre');
  if (lp) { const ln = parseFloat(document.getElementById('lc-line')?.value); lp.style.display = (_confirm && _confirm.isSpread && isFinite(ln) && ln > 0) ? '' : 'none'; }
}

// A bet is VERIFIED when its odds (and its line, for spread/total) sit inside the range of
// the books we track (±9% on decimal odds). Risk is NOT a factor: any verified bet counts
// as a flat 1 unit at the CA line on the leaderboard no matter what you wager — your Risk /
// To Win are just your own numbers for personal tracking. A free bet is personal-only.
// Why (or why not) the current ticket verifies. Returns null when verified, otherwise
// a plain-English reason with the actual numbers so the 9% rule is never a mystery.
function confirmVerifyIssue() {
  const c = _confirm; if (!c) return 'not-ready';
  if (c.freeBet) return 'free';
  const odds = parseFloat(document.getElementById('lc-odds')?.value);
  if (!isFinite(odds) || odds === 0) return 'Enter odds to see if this bet verifies.';
  const dec = americanToDecimal(odds);
  if (!c.oddsRange || dec == null) return 'No book odds to verify against, so this tracks as a personal bet.';
  const oLo = c.oddsRange.lo * (1 - VERIFY_TOL), oHi = c.oddsRange.hi * (1 + VERIFY_TOL);
  if (!(dec >= oLo && dec <= oHi)) {
    return `Your odds (${fmtAm(odds)}) are outside the book range (${fmtAm(decimalToAmerican(oLo))} to ${fmtAm(decimalToAmerican(oHi))}), so this tracks as a personal bet.`;
  }
  if (c.hasLine) {                                                // spread/total: line must be in range too
    const ln = parseFloat(document.getElementById('lc-line')?.value);
    if (!isFinite(ln)) return 'Enter a line to see if this bet verifies.';
    if (!c.lineRange) return 'No book line to verify against, so this tracks as a personal bet.';
    const pad = v => VERIFY_TOL * Math.abs(v);
    const lLo = c.lineRange.lo - pad(c.lineRange.lo), lHi = c.lineRange.hi + pad(c.lineRange.hi);
    if (!(ln >= lLo && ln <= lHi)) {
      const f = v => +v.toFixed(1);
      return `Your line (${ln > 0 && c.isSpread ? '+' + ln : ln}) is outside the book range (${f(lLo)} to ${f(lHi)}), so this tracks as a personal bet.`;
    }
  }
  return null;
}
function confirmIsVerified() { return confirmVerifyIssue() === null; }
function updateConfirmMode() {
  const c = _confirm; if (!c) return;
  const issue = confirmVerifyIssue();
  c.verified = issue === null;
  const mode = document.getElementById('lc-mode');
  if (mode) {
    mode.className = 'lc-mode' + (c.verified ? '' : ' lc-mode-custom');
    mode.innerHTML = c.verified
      ? '<i class="fa-solid fa-circle-check"></i> Verified: 1 unit at the CA line on the leaderboard.'
      : issue === 'free'
        ? 'Free bet, personal only. A loss costs nothing but still counts in your record. Not on the leaderboard.'
        : `${issue} Not on the leaderboard.`;
  }
  refreshBookHighlight();
}

export function toggleConfirmFreeBet() {
  _confirm.freeBet = !_confirm.freeBet;
  const el = document.getElementById('lc-freebet'); if (el) el.classList.toggle('active', _confirm.freeBet);
  updateConfirmMode();
}
export function toggleAddNote() {
  const area = document.getElementById('lc-note-area');
  if (!area) return;
  area.innerHTML = `<div class="settings-field" style="margin-bottom:0;"><label for="lc-note">Note</label><input type="text" id="lc-note" placeholder="e.g. tailed @capper" maxlength="200" /></div>`;
  const el = document.getElementById('lc-note'); if (el) el.focus();
}
export async function confirmTrackBet() {
  const errEl = document.getElementById('lc-error'); if (errEl) errEl.textContent = '';
  const odds  = parseFloat(document.getElementById('lc-odds')?.value);
  const stake = parseFloat(document.getElementById('lc-stake')?.value) || 0;
  const note  = (document.getElementById('lc-note')?.value || '').trim() || null;
  const lineV = _confirm.hasLine ? parseFloat(document.getElementById('lc-line')?.value) : null;
  const verified = confirmIsVerified();
  const selLabel = lcSelLabel();
  const btn = document.getElementById('lc-submit'); if (btn) btn.disabled = true;
  try {
    if (verified) {
      // Leaderboard counts this as 1 unit at the CA line; stake + odds ride along ONLY to
      // scale the user's private tracking P/L (the server keeps the leaderboard flat 1u).
      const res = await fetch(`/api/game/${_confirm.id}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: _confirm.slot, stake, odds }) });
      if (res.status === 401) { window.openLogin && window.openLogin(); return; }
      if (res.status === 409) { showToast('That game has started — verified tracking is closed.', 'err'); return; }
      if (!res.ok) { showToast('Could not track that. Try again.', 'err'); return; }
      showToast('Tracked: ' + selLabel + ' (verified)');
      // Host pages (game detail) listen and bump their vote counts in place.
      document.dispatchEvent(new CustomEvent('ca:tracked', { detail: { id: _confirm.id, slot: _confirm.slot, verified: true } }));
    } else {
      if (!Number.isFinite(odds) || odds === 0) { if (errEl) errEl.textContent = 'Enter valid odds (e.g. -110).'; return; }
      const g = _board.game;
      // Pass side so a game-linked ml/spread custom bet can auto-grade off the result.
      const side = (_confirm.slot === 'home_ml' || _confirm.slot === 'home_spread') ? 'home'
                 : (_confirm.slot === 'away_ml' || _confirm.slot === 'away_spread') ? 'away' : null;
      const res = await fetch('/api/bets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        bet_type: _confirm.betKind, selection: selLabel, sport: g.sport, side,
        line: (_confirm.hasLine && isFinite(lineV)) ? lineV : null,
        odds, stake, book: _confirm.book || null, notes: note, result: 'pending', espn_game_id: _confirm.id,
        free_bet: _confirm.freeBet ? 1 : 0,
      }) });
      if (!res.ok) { showToast('Could not track that. Try again.', 'err'); return; }
      showToast('Tracked: ' + selLabel + (_confirm.freeBet ? ' (free bet)' : ' (custom)'));
      document.dispatchEvent(new CustomEvent('ca:tracked', { detail: { id: _confirm.id, slot: _confirm.slot, verified: false } }));
    }
    closeTrackSheet(); refreshTracking();
  } catch (_) { showToast('Network error. Try again.', 'err'); }
  finally { if (btn) btn.disabled = false; }
}

// ── Parlay builder (Phase 5) ──────────────────────────────────────────────────
// A cross-game slip built by tapping lines from the board. Legs accumulate in
// _parlayLegs; the tray rides along the top of the sheet so the user can hop
// between games and keep adding. Combined odds are the product of the leg
// decimals, priced client-side and re-checked server-side on submit.
let _parlayLegs = [];
let _parlayMeta = { stake: null, book: '', freeBet: false, note: '' };

function parlayCombinedOdds() {
  let dec = 1, n = 0;
  for (const l of _parlayLegs) { const d = americanToDecimal(l.odds); if (d == null) continue; dec *= d; n++; }
  if (!n) return null;
  return decimalToAmerican(dec);
}
function fmtAmO(o) { return o == null ? '—' : o > 0 ? '+' + o : '' + o; }

// Snapshot the current confirm-slide line as a parlay leg, then return to the
// board so the user can add another (from this game or, via Games, another).
export function addLegToParlay() {
  const c = _confirm; if (!c) return;
  const odds = parseFloat(document.getElementById('lc-odds')?.value);
  if (!Number.isFinite(odds) || odds === 0) { showToast('Enter valid odds first.', 'err'); return; }
  const lineV = c.hasLine ? parseFloat(document.getElementById('lc-line')?.value) : null;
  const side = (c.slot === 'home_ml' || c.slot === 'home_spread') ? 'home'
             : (c.slot === 'away_ml' || c.slot === 'away_spread') ? 'away'
             : (c.slot === 'over' || c.slot === 'under') ? c.slot : null;
  const g = _board && _board.game;
  // Guard: the same exact side of the same game can't be added twice.
  const dup = _parlayLegs.some(l => l.espn_game_id === c.id && l.slot === c.slot);
  if (dup) { showToast('That leg is already in your parlay.', 'err'); return; }
  _parlayLegs.push({
    espn_game_id: c.id, slot: c.slot, betKind: c.betKind, side,
    selection: lcSelLabel(), odds,
    line: (c.hasLine && Number.isFinite(lineV)) ? lineV : null,
    sport: (g && g.sport) || null,
  });
  showToast(`Added. ${_parlayLegs.length} legs.`);
  pickTrackGame(c.id); // back to this game's board (Games from there for another game)
}

export function removeParlayLeg(i) {
  _parlayLegs.splice(i, 1);
  if (!_parlayLegs.length) { closeTrackSheet(); return; }
  reviewParlay();
}
export function clearParlay() { _parlayLegs = []; _parlayMeta = { stake: null, book: '', freeBet: false, note: '' }; closeTrackSheet(); }

// Tray: a persistent bar at the top of the sheet showing the running parlay.
function mountParlayTray() {
  const body = document.getElementById('track-sheet-body'); if (!body) return;
  document.getElementById('parlay-tray')?.remove();
  if (_parlayLegs.length < 1) return;
  const combined = parlayCombinedOdds();
  const tray = document.createElement('div');
  tray.id = 'parlay-tray';
  tray.className = 'parlay-tray';
  tray.innerHTML = `
    <div class="ptray-info"><span class="ptray-count">${_parlayLegs.length}-leg parlay</span><span class="ptray-odds">${fmtAmO(combined)}</span></div>
    <button type="button" class="ptray-review" onclick="reviewParlay()">Review ${_parlayLegs.length >= 2 ? '›' : '(add 1 more)'}</button>`;
  body.prepend(tray);
}

export function reviewParlay() {
  stopBoardPoll();
  const body = document.getElementById('track-sheet-body'); if (!body) return;
  const combined = parlayCombinedOdds();
  const oneGame = _parlayLegs.length >= 2 && new Set(_parlayLegs.map(l => l.espn_game_id)).size === 1;
  const unit = unitSize();
  const stake = _parlayMeta.stake != null ? _parlayMeta.stake : unit;
  const legRows = _parlayLegs.map((l, i) => `
    <div class="pl-leg">
      <div class="pl-leg-main"><span class="pl-leg-sel">${esc(l.selection)}</span>${l.sport ? sportBadge(l.sport) : ''}</div>
      <div class="pl-leg-side"><span class="pl-leg-odds">${fmtAmO(l.odds)}</span>
        <button type="button" class="pl-leg-x" onclick="removeParlayLeg(${i})" aria-label="Remove leg">✕</button></div>
    </div>`).join('');
  body.innerHTML = `
    <button class="ob-back" onclick="trackFromGame()">‹ Add another game</button>
    <div class="lc-sel">${_parlayLegs.length}-leg ${oneGame ? 'same game parlay' : 'parlay'} <span class="pl-combined">${fmtAmO(combined)}</span></div>
    <div class="track-form">
      <div class="pl-legs">${legRows}</div>
      ${oneGame ? `<div class="track-form-note">Same game parlay. Legs from one game can be correlated, so books often price these differently. We track it at the straight combined number.</div>` : ''}
      <div class="lc-fields three" style="margin-top:10px;">
        <fieldset class="lc-field"><legend>Risk</legend><div class="lc-fin"><span class="lc-fpre">$</span><input type="number" id="pl-stake" value="${stake}" min="0" step="1" oninput="onParlayField()" /></div></fieldset>
        <fieldset class="lc-field"><legend>To win</legend><div class="lc-fin"><span class="lc-fpre">$</span><input type="number" id="pl-towin" min="0" step="1" readonly /></div></fieldset>
        <fieldset class="lc-field"><legend>Odds</legend><div class="lc-fin"><span class="lc-fpre lc-sign" id="pl-oddspre" style="display:${combined > 0 ? '' : 'none'};">+</span><input type="number" id="pl-odds" value="${combined}" readonly /></div></fieldset>
      </div>
      <div class="settings-field">
        <label>Book (optional)</label>
        <div class="bet-seg-row" style="flex-wrap:wrap;">
          ${BOOKS.map(b => `<button type="button" class="bet-seg${_parlayMeta.book === b ? ' active' : ''}" onclick="setParlayBook('${b}',this)">${b}</button>`).join('')}
        </div>
      </div>
      <div id="pl-note-area">
        ${_parlayMeta.note ? `<div class="settings-field" style="margin-bottom:0;"><label for="pl-note">Note</label><input type="text" id="pl-note" value="${_parlayMeta.note.replace(/"/g,'&quot;')}" maxlength="200" /></div>`
          : `<button type="button" class="lc-addnote" onclick="toggleParlayNote()"><i class="fa-solid fa-plus"></i> Add a note</button>`}
      </div>
      <div class="lc-freebet-row">
        <button type="button" class="lc-freebet${_parlayMeta.freeBet ? ' active' : ''}" id="pl-freebet" onclick="toggleParlayFreeBet()"><i class="fa-solid fa-bolt"></i> Free Bet</button>
      </div>
      <div class="track-form-note">Parlays are personal tracking (not on the leaderboard). Game-linked legs grade automatically.</div>
      <button class="track-submit" id="pl-submit" onclick="submitParlay()">Track Parlay</button>
      <div class="form-error" id="pl-error" style="margin-top:8px;font-size:12px;"></div>
    </div>`;
  onParlayField();
}
export function onParlayField() {
  const combined = parlayCombinedOdds();
  const stake = parseFloat(document.getElementById('pl-stake')?.value);
  const win = document.getElementById('pl-towin');
  if (win && combined != null && Number.isFinite(stake) && stake > 0) {
    win.value = americanProfit(combined, stake).toFixed(2);
  } else if (win) win.value = '';
}
export function setParlayBook(book, btn) {
  const on = _parlayMeta.book === book;
  _parlayMeta.book = on ? '' : book;
  const row = btn.parentElement;
  row.querySelectorAll('.bet-seg').forEach(b => b.classList.remove('active'));
  if (!on) btn.classList.add('active');
}
export function toggleParlayNote() {
  const area = document.getElementById('pl-note-area'); if (!area) return;
  area.innerHTML = `<div class="settings-field" style="margin-bottom:0;"><label for="pl-note">Note</label><input type="text" id="pl-note" placeholder="e.g. Sunday longshot" maxlength="200" /></div>`;
  document.getElementById('pl-note')?.focus();
}
export function toggleParlayFreeBet() {
  _parlayMeta.freeBet = !_parlayMeta.freeBet;
  document.getElementById('pl-freebet')?.classList.toggle('active', _parlayMeta.freeBet);
}
export async function submitParlay() {
  if (_parlayLegs.length < 2) { showToast('Add at least two legs.', 'err'); return; }
  const errEl = document.getElementById('pl-error'); if (errEl) errEl.textContent = '';
  const stake = parseFloat(document.getElementById('pl-stake')?.value) || 0;
  const note = (document.getElementById('pl-note')?.value || '').trim() || null;
  const btn = document.getElementById('pl-submit'); if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/bets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bet_type: 'parlay', stake, book: _parlayMeta.book || null, notes: note,
        free_bet: _parlayMeta.freeBet ? 1 : 0,
        legs: _parlayLegs.map(l => ({
          bet_type: l.betKind, selection: l.selection, odds: l.odds, side: l.side,
          line: l.line, sport: l.sport, espn_game_id: l.espn_game_id,
        })),
      }),
    });
    if (res.status === 401) { window.openLogin && window.openLogin(); return; }
    if (!res.ok) { const d = await res.json().catch(() => ({})); if (errEl) errEl.textContent = d.error || 'Could not track that.'; return; }
    showToast(`Tracked: ${_parlayLegs.length}-leg parlay`);
    _parlayLegs = []; _parlayMeta = { stake: null, book: '', freeBet: false, note: '' };
    closeTrackSheet(); refreshTracking();
  } catch (_) { if (errEl) errEl.textContent = 'Network error. Try again.'; }
  finally { if (btn) btn.disabled = false; }
}

let _form = { bet_type: 'ml', result: 'pending', book: '', totalSide: 'over' };

export function showCustomForm() {
  stopBoardPoll();
  _form = { bet_type: 'ml', result: 'pending', book: '', totalSide: 'over' };
  const body = document.getElementById('track-sheet-body');
  if (body) body.innerHTML = customFormHtml();
  updatePayoutPreview();
}

function seg(name, value, current, label) {
  return `<button type="button" class="bet-seg${value === current ? ' active' : ''}" onclick="setFormField('${name}','${value}')">${label}</button>`;
}

function customFormHtml() {
  const needsLine = _form.bet_type === 'spread' || _form.bet_type === 'total';
  return `
    <div class="track-form">
      <div class="settings-field">
        <label>Bet type</label>
        <div class="bet-seg-row">
          ${seg('bet_type', 'ml', _form.bet_type, 'Moneyline')}
          ${seg('bet_type', 'spread', _form.bet_type, 'Spread')}
          ${seg('bet_type', 'total', _form.bet_type, 'Total')}
          ${seg('bet_type', 'prop', _form.bet_type, 'Prop')}
        </div>
      </div>
      <div class="settings-field" id="cf-ou-wrap" style="${_form.bet_type === 'total' ? '' : 'display:none;'}">
        <label>Over / Under</label>
        <div class="bet-seg-row">
          ${seg('totalSide', 'over', _form.totalSide || 'over', 'Over')}
          ${seg('totalSide', 'under', _form.totalSide || 'over', 'Under')}
        </div>
      </div>
      <div id="cf-kalshi"></div>
      <div class="settings-field">
        <label for="cf-selection">Your pick</label>
        <input type="text" id="cf-selection" placeholder='e.g. "Yankees ML" or "Judge 2+ HR"' maxlength="80" />
      </div>
      <div style="display:flex;gap:12px;">
        <div class="settings-field" style="flex:1;">
          <label for="cf-sport">Sport</label>
          <select id="cf-sport" style="width:100%;padding:9px 12px;font-size:14px;">
            <option value="">—</option>
            ${SPORTS.map(s => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
        <div class="settings-field" style="flex:1;${needsLine ? '' : 'display:none;'}" id="cf-line-wrap">
          <label for="cf-line">Line</label>
          <input type="number" id="cf-line" step="0.5" placeholder="e.g. -1.5 or 8.5" />
        </div>
      </div>
      <div style="display:flex;gap:12px;">
        <div class="settings-field" style="flex:1;">
          <label for="cf-odds">Odds</label>
          <input type="number" id="cf-odds" value="-110" step="5" oninput="updatePayoutPreview()" />
        </div>
        <div class="settings-field" style="flex:1;">
          <label for="cf-stake">Stake</label>
          <div class="field-prefix-wrap"><span class="field-prefix">$</span>
            <input type="number" id="cf-stake" value="${unitSize()}" min="0" step="1" oninput="updatePayoutPreview()" />
          </div>
        </div>
      </div>
      <div class="track-payout" id="cf-payout"></div>
      <div class="settings-field">
        <label>Book (optional)</label>
        <div class="bet-seg-row" style="flex-wrap:wrap;">
          ${BOOKS.map(b => `<button type="button" class="bet-seg" onclick="setFormBook('${b}',this)">${b}</button>`).join('')}
        </div>
      </div>
      <div class="settings-field">
        <label>Result</label>
        <div class="bet-seg-row">
          ${seg('result', 'pending', _form.result, 'Pending')}
          ${seg('result', 'win', _form.result, 'Won')}
          ${seg('result', 'loss', _form.result, 'Lost')}
          ${seg('result', 'push', _form.result, 'Push')}
          ${seg('result', 'void', _form.result, 'Void')}
        </div>
      </div>
      <div class="settings-field">
        <label for="cf-notes">Note (optional)</label>
        <input type="text" id="cf-notes" placeholder="e.g. tailed @capper, group-chat play" maxlength="200" />
      </div>
      <div class="track-form-note">Custom bets show on your own tracking. They are not added to the verified leaderboard.</div>
      <button class="track-submit" id="cf-submit" onclick="submitCustomBet()">Track bet</button>
      <div class="form-error" id="cf-error" style="margin-top:8px;font-size:12px;"></div>
    </div>`;
}

export function setFormField(name, value) {
  _form[name] = value;
  if (name === 'bet_type') {
    const wrap = document.getElementById('cf-line-wrap');
    if (wrap) wrap.style.display = (value === 'spread' || value === 'total') ? '' : 'none';
    const ou = document.getElementById('cf-ou-wrap');
    if (ou) ou.style.display = (value === 'total') ? '' : 'none';
  }
  if (name === 'result') updatePayoutPreview(); // hide "to win" when Lost/Void
  // Re-highlight the segmented group this control belongs to.
  document.querySelectorAll(`.bet-seg[onclick*="'${name}'"]`).forEach(b => {
    b.classList.toggle('active', b.getAttribute('onclick').includes(`'${value}'`));
  });
}

export function setFormBook(book, btn) {
  const on = _form.book === book;
  _form.book = on ? '' : book;
  // Toggle just the book chips (the row after the Book label).
  const row = btn.parentElement;
  row.querySelectorAll('.bet-seg').forEach(b => b.classList.remove('active'));
  if (!on) btn.classList.add('active');
}

export function updatePayoutPreview() {
  const odds  = parseFloat(document.getElementById('cf-odds')?.value);
  const stake = parseFloat(document.getElementById('cf-stake')?.value) || 0;
  const el = document.getElementById('cf-payout');
  if (!el) return;
  // Flag a $0 stake — it tracks the result but contributes nothing to P/L (Backlog P2 #30).
  if (!stake) { el.innerHTML = `<span style="color:var(--muted);">No stake set, so this won't affect your P/L.</span>`; return; }
  // Respect the chosen result (Backlog P0 #5): don't show a "to win" for a Lost/Void bet.
  if (_form.result === 'loss') { el.innerHTML = `Risk <strong>$${stake.toFixed(2)}</strong> · marked Lost (−$${stake.toFixed(2)})`; return; }
  if (_form.result === 'push' || _form.result === 'void') { el.innerHTML = `Stake returned · $0.00`; return; }
  const win = americanProfit(odds, stake);
  el.innerHTML = `Risk <strong>$${stake.toFixed(2)}</strong> to win <strong>$${win.toFixed(2)}</strong> · returns <strong>$${(win + stake).toFixed(2)}</strong>`;
}

export async function submitCustomBet() {
  const errEl = document.getElementById('cf-error');
  const btn   = document.getElementById('cf-submit');
  if (errEl) errEl.textContent = '';
  const selection = (document.getElementById('cf-selection')?.value || '').trim();
  const odds  = parseFloat(document.getElementById('cf-odds')?.value);
  const stake = parseFloat(document.getElementById('cf-stake')?.value) || 0;
  const sport = document.getElementById('cf-sport')?.value || '';
  const lineV = document.getElementById('cf-line')?.value;
  // DB enum has over/under, not "total". A self-settled custom total is stored in the
  // 'over' bucket (the selection text carries "Over 8.5" / "Under 8.5"); the breakdown
  // labels over/under as "Total".
  const bet_type = _form.bet_type === 'total' ? (_form.totalSide === 'under' ? 'under' : 'over') : _form.bet_type;
  if (!selection) { if (errEl) errEl.textContent = 'Add what you bet on.'; return; }
  if (!Number.isFinite(odds) || odds === 0) { if (errEl) errEl.textContent = 'Enter valid odds (e.g. -110).'; return; }

  if (btn) btn.disabled = true;
  try {
    // Pass the chosen result on CREATE so it's atomic — no fire-and-forget settle
    // that could leave a "pending" row while the sheet closed as graded (P0 #3).
    const res = await fetch('/api/bets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bet_type, selection, sport,
        line: (lineV === '' || lineV == null) ? null : Number(lineV),
        odds, stake, book: _form.book || null,
        notes: (document.getElementById('cf-notes')?.value || '').trim() || null,
        result: _form.result || 'pending',
      }),
    });
    const data = await res.json();
    if (!res.ok) { if (errEl) errEl.textContent = data.error || 'Could not save.'; if (btn) btn.disabled = false; return; }
    showToast('Tracked: ' + selection);
    closeTrackSheet();
    refreshTracking();
  } catch (_) {
    if (errEl) errEl.textContent = 'Network error. Try again.';
    if (btn) btn.disabled = false;
  }
}

Object.assign(window, {
  openTrackSheet, closeTrackSheet, trackFromGame, showCustomForm,
  setFormField, setFormBook, updatePayoutPreview, submitCustomBet,
  setBetFilter, clearBetFilters, loadMoreBets, settleBetUI, deleteBetUI, loadUserBets,
  filterTrackGames, setTrackSport, pickTrackGame, trackLine, showToast,
  openBetDetail, saveBetEdit, confirmDeleteBet, cancelDeleteBet, shareBet,
  setTrackDay, trackFutureGame, toggleSportMenu, stepTrackDay,
  showBetScan, scanBetslip, backToTrackMenu,
  openLineConfirm, onConfirmField, pickConfirmBook, confirmTrackBet, openTrackForSlot,
  addLegToParlay, removeParlayLeg, clearParlay, reviewParlay, onParlayField,
  setParlayBook, toggleParlayNote, toggleParlayFreeBet, submitParlay, fillFromKalshiEvent,
  toggleConfirmFreeBet, toggleAddNote, toggleBookCompare,
});

// Close the sport dropdown when clicking outside it.
document.addEventListener('click', (e) => {
  if (_sportMenuOpen && !e.target.closest('#tg-sportdd')) { _sportMenuOpen = false; renderSportDropdown(); }
});

// Sheet keyboard support: Escape closes, Tab stays trapped inside the sheet, and
// arrow keys walk the sport dropdown (Backlog P2 #24 + the mobile/a11y pass).
document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('track-overlay');
  if (e.key === 'Escape' && overlay) { closeTrackSheet(); return; }
  if (e.key === 'Tab' && overlay) {
    const list = [...overlay.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && _sportMenuOpen) {
    const items = [...document.querySelectorAll('.tg-sportdd-item')];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
  }
});
