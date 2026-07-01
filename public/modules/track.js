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
const SPORTS = ['MLB', 'NBA', 'WNBA', 'NHL', 'NFL', 'NCAAF', 'CBB', 'ATP', 'WTA', 'Golf', 'Soccer', 'UFC', 'WCBB', 'Boxing'];

let _bets    = [];
let _filters = { sport: '', status: 'all' };

// Payout preview — mirror of src/odds_math.americanProfit (manual default -110).
function americanProfit(odds, stake) {
  const o = (odds == null || isNaN(parseFloat(odds))) ? -110 : parseFloat(odds);
  return o < 0 ? stake * (100 / Math.abs(o)) : stake * (o / 100);
}
function unitSize() { return Number(window._trackUnitSize) > 0 ? Number(window._trackUnitSize) : 20; }

// Lightweight toast for tracked/settled/error feedback (Backlog P0 #1).
export function showToast(msg, kind) {
  let host = document.getElementById('ca-toast-host');
  if (!host) { host = document.createElement('div'); host.id = 'ca-toast-host'; document.body.appendChild(host); }
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
    _bets = (await res.json()).bets || [];
    renderBets();
  } catch (_) { el.innerHTML = ''; }
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

function renderBets() {
  const el = document.getElementById('track-bets-content');
  if (!el) return;

  const filtered = _bets.filter(b => {
    if (_filters.sport && (b.sport || '').toUpperCase() !== _filters.sport) return false;
    if (_filters.status === 'pending' && b.result !== 'pending') return false;
    if (_filters.status === 'settled' && b.result === 'pending') return false;
    return true;
  });

  // Sport filter options come from the sports actually present in the user's bets.
  const presentSports = [...new Set(_bets.map(b => (b.sport || '').toUpperCase()).filter(Boolean))];
  // Keep the active sport in the list even if settling/deleting left zero matching
  // bets, so the dropdown reflects the real filter instead of silently snapping
  // back to "All sports" while an empty state shows (Backlog P2 #34).
  if (_filters.sport && !presentSports.includes(_filters.sport)) presentSports.push(_filters.sport);
  const sportOpts = ['<option value="">All sports</option>']
    .concat(presentSports.map(s => `<option value="${s}"${_filters.sport === s ? ' selected' : ''}>${s}</option>`))
    .join('');

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
    rows = `<div style="padding:26px 20px;color:var(--muted);font-size:14px;">${_bets.length === 0
      ? 'No custom bets yet. Tap "Track a Bet" to log one.'
      : 'No bets match this filter.'}</div>`;
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

  el.innerHTML = `
    <div class="bet-filter-row">
      <select class="bet-filter" onchange="setBetFilter('sport', this.value)">${sportOpts}</select>
      <select class="bet-filter" onchange="setBetFilter('status', this.value)">
        <option value="all"${_filters.status === 'all' ? ' selected' : ''}>All</option>
        <option value="pending"${_filters.status === 'pending' ? ' selected' : ''}>Pending</option>
        <option value="settled"${_filters.status === 'settled' ? ' selected' : ''}>Settled</option>
      </select>
    </div>
    <div class="bet-list">${rows}</div>`;
}

export function setBetFilter(key, val) { _filters[key] = val; renderBets(); }

// Render the custom-bets list from data already fetched by loadTracking (avoids a
// second /api/bets round-trip).
export function setBetsData(bets) { _bets = bets || []; renderBets(); }

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
// Inline two-step confirm (no native dialog).
export function confirmDeleteBet(id) {
  const el = document.getElementById('bd-delete-area');
  if (!el) { deleteBetUI(id); return; }
  el.outerHTML = `<div class="bd-confirm" id="bd-delete-area">
    <span>Delete this bet?</span>
    <button class="bet-settle-btn loss" onclick="deleteBetUI(${id})">Delete</button>
    <button class="bet-settle-btn push" onclick="openBetDetail(${id})">Cancel</button>
  </div>`;
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
  const host = ensureSheetHost();
  host.innerHTML = `
    <div class="track-overlay" id="track-overlay" onclick="if(event.target===this)closeTrackSheet()">
      <div class="track-sheet" role="dialog" aria-modal="true" aria-label="Bet detail">
        <div class="track-sheet-grab"></div>
        <div class="track-sheet-head"><span>Bet detail</span><button class="track-sheet-x" onclick="closeTrackSheet()" aria-label="Close">✕</button></div>
        <div class="track-form">
          <div class="ob-head" style="margin-bottom:2px;">${b.selection || '—'} ${b.sport ? sportBadge(b.sport) : ''}</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">${betResultPill(b.result)} · ${b.verified ? 'Verified' : 'Custom'}${b.book ? ' · ' + b.book : ''}</div>
          ${pending ? `
            <div style="display:flex;gap:12px;">
              <div class="settings-field" style="flex:1;"><label for="bd-odds">Odds</label><input type="number" id="bd-odds" value="${b.odds}" step="5" /></div>
              <div class="settings-field" style="flex:1;"><label for="bd-stake">Stake</label><div class="field-prefix-wrap"><span class="field-prefix">$</span><input type="number" id="bd-stake" value="${b.stake}" min="0" step="1" /></div></div>
            </div>
            <div class="settings-field"><label for="bd-notes">Note</label><input type="text" id="bd-notes" value="${(b.notes || '').replace(/"/g, '&quot;')}" maxlength="200" /></div>
            <button class="track-submit" onclick="saveBetEdit(${b.id})">Save changes</button>
            ${!b.espn_game_id ? `<div class="bet-settle-row" style="margin-top:12px;">
              <button class="bet-settle-btn win"  onclick="settleBetUI(${b.id},'win')">Won</button>
              <button class="bet-settle-btn loss" onclick="settleBetUI(${b.id},'loss')">Lost</button>
              <button class="bet-settle-btn push" onclick="settleBetUI(${b.id},'push')">Push</button>
              <button class="bet-settle-btn push" onclick="settleBetUI(${b.id},'void')">Void</button>
            </div>` : `<div class="track-form-note">This is a game-linked bet — it grades automatically when the game finishes.</div>`}
          ` : `
            <div class="bd-rows">
              <div class="bd-row"><span>Odds</span><span>${oddsStr}</span></div>
              <div class="bd-row"><span>Stake</span><span>$${(b.stake || 0).toFixed(2)}</span></div>
              <div class="bd-row"><span>Result</span><span>${b.result}</span></div>
              <div class="bd-row"><span>P/L</span>${payoutCell(b)}</div>
            </div>
            ${b.notes ? `<div class="track-form-note" style="font-style:italic;">${b.notes}</div>` : ''}
            ${!b.espn_game_id ? `
            <div class="track-form-note" style="margin-top:12px;margin-bottom:6px;">Marked it wrong? Update the result:</div>
            <div class="bet-settle-row">
              <button class="bet-settle-btn win"  onclick="settleBetUI(${b.id},'win')">Won</button>
              <button class="bet-settle-btn loss" onclick="settleBetUI(${b.id},'loss')">Lost</button>
              <button class="bet-settle-btn push" onclick="settleBetUI(${b.id},'push')">Push</button>
              <button class="bet-settle-btn push" onclick="settleBetUI(${b.id},'void')">Void</button>
            </div>` : ''}
          `}
          ${b.espn_game_id ? `<button class="track-opt" style="margin-top:12px;" onclick="closeTrackSheet();openGameModal('${b.espn_game_id}')">
            <span class="track-opt-ic" style="background:rgba(34,197,94,.14);color:#22c55e;"><i class="fa-solid fa-arrow-up-right-from-square"></i></span>
            <span><span class="track-opt-t">View game</span><span class="track-opt-d">Open the matchup, lines, and live score.</span></span>
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
}

export function closeTrackSheet() {
  const ov = document.getElementById('track-overlay');
  if (!ov) return;
  ov.classList.remove('open');
  setTimeout(() => { const h = document.getElementById('track-sheet-host'); if (h) h.innerHTML = ''; }, 180);
}

function sheetMenuHtml() {
  return `
    <button class="track-opt" onclick="trackFromGame()">
      <span class="track-opt-ic" style="background:rgba(34,197,94,.14);color:#22c55e;"><i class="fa-solid fa-magnifying-glass"></i></span>
      <span><span class="track-opt-t">From a game</span><span class="track-opt-d">Pick a side on a real game. Verified, counts on the leaderboard.</span></span>
    </button>
    <button class="track-opt" onclick="showCustomForm()">
      <span class="track-opt-ic" style="background:rgba(59,130,246,.14);color:#3b82f6;"><i class="fa-solid fa-pen"></i></span>
      <span><span class="track-opt-t">Custom bet</span><span class="track-opt-d">Log any bet yourself (props, parlays, anything). Personal tracking only.</span></span>
    </button>
    <button class="track-opt track-opt-soon" disabled>
      <span class="track-opt-ic" style="background:var(--surface2);color:var(--muted);"><i class="fa-regular fa-image"></i></span>
      <span><span class="track-opt-t">Upload betslip <span class="track-soon">Soon</span></span><span class="track-opt-d">Snap a betslip and we'll read it for you.</span></span>
    </button>`;
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
const CORE_SPORTS = ['MLB', 'NBA', 'NHL', 'WNBA', 'NFL', 'NCAAF', 'CBB', 'ATP', 'WTA', 'GOLF'];
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
  const nameOf = (full, sport) => CORE_SPORTS.includes((sport || '').toUpperCase()) ? (full || '').split(' ').pop() : (full || '');
  el.innerHTML = note + games.map(g => {
    const cust = isCustomGame(g);
    const away = nameOf(g.away_team, g.sport);
    const home = nameOf(g.home_team, g.sport);
    const time = g.start_time ? new Date(g.start_time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) : '';
    const status = cust
      ? (g.status === 'post' ? `Final ${g.away_score ?? ''}-${g.home_score ?? ''}` : time)
      : g.status === 'post' ? `Final ${g.away_score ?? ''}-${g.home_score ?? ''}`
      : g.status === 'in' ? `<span style="color:#38bdf8;">LIVE ${g.away_score ?? 0}-${g.home_score ?? 0}</span>`
      : time;
    const matchup = `${away} @ ${home}`;
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

export async function pickTrackGame(id) {
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
  const awayN = away.split(' ').pop(), homeN = home.split(' ').pop();

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
  const bolt = live ? '<i class="fa-solid fa-bolt ob-bolt" title="Live odds right now"></i>' : '';

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
  const lines = finished ? '' : `
    ${hasML ? `<div class="ob-section">Moneyline</div>
    ${line('away_ml', `${awayN}`, g.ml_away, g.ml_away == null)}
    ${line('home_ml', `${homeN}`, g.ml_home, g.ml_home == null)}` : ''}
    ${hasSpread ? `<div class="ob-section">Spread</div>
    ${line('away_spread', `${awayN} ${_sp(g.spread_away)}`, -110, g.spread_away == null)}
    ${line('home_spread', `${homeN} ${_sp(g.spread_home)}`, -110, g.spread_home == null)}` : ''}
    ${g.over_under != null ? `<div class="ob-section">Total</div>
    ${line('over',  `Over ${g.over_under}`,  g.ou_over_odds, false)}
    ${line('under', `Under ${g.over_under}`, g.ou_under_odds, false)}` : ''}
    ${noLines ? `<div class="track-form-note" style="margin-top:4px;">No betting lines posted for this game yet. Use Custom bet to log it.</div>` : ''}`;

  body.innerHTML = `
    <button class="ob-back" onclick="trackFromGame()">‹ Games</button>
    <div class="ob-head">${away} @ ${home} ${sportBadge(g.sport)}${live ? ' <span class="ob-live">LIVE</span>' : ''}</div>
    <div class="track-form-note">${finished
      ? 'This game is final, so tracking is closed. Use Custom bet to log it.'
      : live
        ? `<i class="fa-solid fa-bolt ob-bolt"></i> Live odds — tap a line to track it at the live number, graded automatically.`
        : `Tap a line to track it. Verified, locked at this number, graded automatically.${g.line_source ? ` <span style="color:#a78bfa;">Line via ${g.line_source === 'kalshi' ? 'Kalshi' : 'Polymarket'}</span>` : ''}`}</div>
    ${finished || noLines ? '' : `<div class="ob-caline-row"${live ? ' style="color:#38bdf8;"' : ''} title="${live ? 'Live line right now' : "CappingAlpha's line, estimated from the books we track"}">${live ? 'Live Line' : 'CA Line'}</div>`}
    ${finished ? '' : `<div class="ob-grid">${lines}</div>`}
    <button class="track-opt" style="margin-top:12px;" onclick="showCustomForm()">
      <span class="track-opt-ic" style="background:rgba(59,130,246,.14);color:#3b82f6;"><i class="fa-solid fa-pen"></i></span>
      <span><span class="track-opt-t">Log it as a custom bet instead</span><span class="track-opt-d">Set your own stake, odds, and book.</span></span>
    </button>`;
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
// Default = the CA line, tracked verified (1 unit on the leaderboard). Editing the odds
// (typing your own, or tapping a book price) flips it to a personal custom bet.
let _confirm = null;

function slotToBet(slot) {
  if (slot === 'home_ml' || slot === 'away_ml') return 'ml';
  if (slot === 'home_spread' || slot === 'away_spread') return 'spread';
  return slot; // 'over' | 'under'
}
function bookOddsForSlot(slot) {
  const field = { home_ml: 'ml_home', away_ml: 'ml_away', home_spread: 'spread_home', away_spread: 'spread_away', over: 'ou_over_odds', under: 'ou_under_odds' }[slot];
  const L = (_board && _board.lines) || {};
  const out = [];
  if (L.draftkings && L.draftkings[field] != null) out.push({ book: 'DraftKings', odds: L.draftkings[field] });
  if (L.fanduel   && L.fanduel[field]   != null) out.push({ book: 'FanDuel',    odds: L.fanduel[field] });
  return out;
}

export function openLineConfirm(id, slot, label, caOdds) {
  const g = _board && _board.game; if (!g) return;
  _confirm = { id, slot, label, caOdds: caOdds == null ? null : Number(caOdds), book: '' };
  const body = document.getElementById('track-sheet-body'); if (!body) return;
  const away = g.away_team || 'Away', home = g.home_team || 'Home';
  const bookRows = bookOddsForSlot(slot).map(b =>
    `<button type="button" class="lc-book" onclick="setConfirmOdds(${b.odds})">${b.book}<span>${b.odds > 0 ? '+' + b.odds : b.odds}</span></button>`
  ).join('');
  const caTxt = _confirm.caOdds != null ? (_confirm.caOdds > 0 ? '+' + _confirm.caOdds : '' + _confirm.caOdds) : '—';
  body.innerHTML = `
    <button class="ob-back" onclick="pickTrackGame('${id}')">‹ Board</button>
    <div class="ob-head">${away} @ ${home} ${sportBadge(g.sport)}</div>
    <div class="lc-sel">${label}</div>
    <div class="track-form">
      <div class="settings-field">
        <label for="lc-odds">Odds</label>
        <div class="lc-odds-row">
          <input type="number" id="lc-odds" value="${_confirm.caOdds ?? ''}" step="5" oninput="onConfirmOddsChange()" />
          <span class="lc-caline">CA Line ${caTxt}</span>
        </div>
        ${bookRows ? `<div class="lc-books">${bookRows}</div>` : ''}
        <div class="lc-mode" id="lc-mode">Verified pick. Tracks 1 unit at the CA line on the leaderboard.</div>
      </div>
      <div style="display:flex;gap:12px;">
        <div class="settings-field" style="flex:1;"><label for="lc-stake">Risk</label><div class="field-prefix-wrap"><span class="field-prefix">$</span><input type="number" id="lc-stake" value="${unitSize()}" min="0" step="1" disabled oninput="lcPayout()" /></div></div>
        <div class="settings-field" style="flex:1;"><label>To win</label><div class="lc-towin" id="lc-towin">—</div></div>
      </div>
      <div class="settings-field">
        <label>Book (optional)</label>
        <div class="bet-seg-row" style="flex-wrap:wrap;">${BOOKS.map(b => `<button type="button" class="bet-seg" onclick="setConfirmBook('${b}',this)">${b}</button>`).join('')}</div>
      </div>
      <div class="settings-field"><label for="lc-note">Note (optional)</label><input type="text" id="lc-note" placeholder="e.g. tailed @capper" maxlength="200" /></div>
      <div class="lc-freebet-row">
        <button type="button" class="lc-freebet" id="lc-freebet" onclick="toggleConfirmFreeBet()"><i class="fa-solid fa-bolt"></i> Free Bet</button>
        <span class="ca-link" style="font-size:12px;" onclick="freeBetInfo()">What's this?</span>
      </div>
      <button class="track-submit" id="lc-submit" onclick="confirmTrackBet()">Track Bet</button>
      <div class="form-error" id="lc-error" style="margin-top:8px;font-size:12px;"></div>
    </div>`;
  lcPayout();
}
export function toggleConfirmFreeBet() {
  _confirm.freeBet = !_confirm.freeBet;
  const el = document.getElementById('lc-freebet'); if (el) el.classList.toggle('active', _confirm.freeBet);
  onConfirmOddsChange();
}
export function freeBetInfo() {
  let host = document.getElementById('track-info-host');
  if (!host) { host = document.createElement('div'); host.id = 'track-info-host'; document.body.appendChild(host); }
  const close = `document.getElementById('track-info-host').innerHTML=''`;
  host.innerHTML = `
    <div class="track-overlay open" onclick="if(event.target===this){${close}}">
      <div class="track-sheet" role="dialog" aria-modal="true" aria-label="Free bet">
        <div class="track-sheet-head"><span>Free bet</span><button class="track-sheet-x" onclick="${close}" aria-label="Close">✕</button></div>
        <div class="track-form" style="padding-top:2px;">
          <p style="font-size:14px;line-height:1.55;margin:0 0 10px;">A <b>free bet</b> is one where a loss doesn't count against your record, but a win still does.</p>
          <p style="font-size:13px;line-height:1.5;color:var(--muted);margin:0 0 14px;">Free bets are personal only. They are never counted on the CappingAlpha leaderboard.</p>
          <button class="track-submit" onclick="${close}">Got it</button>
        </div>
      </div>
    </div>`;
}
export function setConfirmBook(book, btn) {
  _confirm.book = _confirm.book === book ? '' : book;
  btn.parentElement.querySelectorAll('.bet-seg').forEach(x => x.classList.remove('active'));
  if (_confirm.book) btn.classList.add('active');
}
export function setConfirmOdds(o) { const el = document.getElementById('lc-odds'); if (el) { el.value = o; onConfirmOddsChange(); } }
export function onConfirmOddsChange() {
  const v = parseFloat(document.getElementById('lc-odds')?.value);
  const isCa = _confirm.caOdds != null && v === _confirm.caOdds;
  const verified = isCa && !_confirm.freeBet; // a free bet is always personal-only
  const mode = document.getElementById('lc-mode');
  const stake = document.getElementById('lc-stake');
  if (mode) {
    mode.className = 'lc-mode' + (verified ? '' : ' lc-mode-custom');
    mode.textContent = verified
      ? 'Verified pick. Tracks 1 unit at the CA line on the leaderboard.'
      : _confirm.freeBet
        ? "Free bet — personal only. A loss won't count, a win will. Not on the leaderboard."
        : 'Custom odds — tracked as a personal bet only, not on the leaderboard.';
  }
  if (stake) { stake.disabled = verified; if (verified) stake.value = unitSize(); } // verified = flat 1 unit
  lcPayout();
}
export function lcPayout() {
  const odds = parseFloat(document.getElementById('lc-odds')?.value);
  const stake = parseFloat(document.getElementById('lc-stake')?.value) || 0;
  const el = document.getElementById('lc-towin');
  if (el) el.textContent = stake ? `$${americanProfit(odds, stake).toFixed(2)}` : '—';
}
export async function confirmTrackBet() {
  const errEl = document.getElementById('lc-error'); if (errEl) errEl.textContent = '';
  const odds  = parseFloat(document.getElementById('lc-odds')?.value);
  const stake = parseFloat(document.getElementById('lc-stake')?.value) || 0;
  const note  = (document.getElementById('lc-note')?.value || '').trim() || null;
  // A free bet is always a personal bet (never on the leaderboard), so it takes the
  // custom path even at the CA line.
  const verified = _confirm.caOdds != null && odds === _confirm.caOdds && !_confirm.freeBet;
  const btn   = document.getElementById('lc-submit'); if (btn) btn.disabled = true;
  try {
    if (verified) {
      const res = await fetch(`/api/game/${_confirm.id}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: _confirm.slot }) });
      if (res.status === 401) { window.openLogin && window.openLogin(); return; }
      if (res.status === 409) { showToast('That game has started — verified tracking is closed.', 'err'); return; }
      if (!res.ok) { showToast('Could not track that. Try again.', 'err'); return; }
      showToast('Tracked: ' + _confirm.label + ' (verified)');
    } else {
      if (!Number.isFinite(odds) || odds === 0) { if (errEl) errEl.textContent = 'Enter valid odds (e.g. -110).'; return; }
      const g = _board.game;
      const res = await fetch('/api/bets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        bet_type: slotToBet(_confirm.slot), selection: _confirm.label, sport: g.sport,
        odds, stake, book: _confirm.book || null, notes: note, result: 'pending', espn_game_id: _confirm.id,
        free_bet: _confirm.freeBet ? 1 : 0,
      }) });
      if (!res.ok) { showToast('Could not track that. Try again.', 'err'); return; }
      showToast('Tracked: ' + _confirm.label + (_confirm.freeBet ? ' (free bet)' : ' (custom)'));
    }
    closeTrackSheet(); refreshTracking();
  } catch (_) { showToast('Network error. Try again.', 'err'); }
  finally { if (btn) btn.disabled = false; }
}

let _form = { bet_type: 'ml', result: 'pending', book: '', totalSide: 'over' };

export function showCustomForm() {
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
  setBetFilter, settleBetUI, deleteBetUI, loadUserBets,
  filterTrackGames, setTrackSport, pickTrackGame, trackLine, showToast,
  openBetDetail, saveBetEdit, confirmDeleteBet,
  setTrackDay, trackFutureGame, toggleSportMenu, stepTrackDay,
  openLineConfirm, setConfirmBook, setConfirmOdds, onConfirmOddsChange, lcPayout, confirmTrackBet,
  toggleConfirmFreeBet, freeBetInfo,
});

// Close the sport dropdown when clicking outside it.
document.addEventListener('click', (e) => {
  if (_sportMenuOpen && !e.target.closest('#tg-sportdd')) { _sportMenuOpen = false; renderSportDropdown(); }
});

// Escape closes the track sheet / bet detail (Backlog P2 #24).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('track-overlay')) closeTrackSheet();
});
