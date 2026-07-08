// books.js — the sportsbook catalog + the "My sportsbooks" picker modal.
//
// One catalog for every surface that talks about books (Settings, the Complete
// Set Up card, the Track a Bet betslip, the detail-page lines table). The list is
// deliberately wider than what we scrape: users pick where they BET; books we
// carry lines for simply light up with numbers wherever they appear.
//
// Selection persists to user_preferences.my_books via PUT /api/account/preferences.
// window._myBooks mirrors it live; a 'myBooksChanged' window event fires after a
// save so open surfaces (Settings card, betslip bubbles, tracking page) refresh.

export const BOOK_GROUPS = [
  { key: 'us', label: 'Sportsbooks', color: '#3b82f6', books: [
    ['draftkings', 'DraftKings'], ['fanduel', 'FanDuel'], ['betmgm', 'BetMGM'],
    ['caesars', 'Caesars'], ['espnbet', 'ESPN BET'], ['fanatics', 'Fanatics'],
    ['betrivers', 'BetRivers'], ['hardrock', 'Hard Rock'], ['bet365', 'bet365'],
    ['circa', 'Circa Sports'],
  ]},
  { key: 'markets', label: 'Prediction markets', color: '#a78bfa', books: [
    ['kalshi', 'Kalshi'], ['polymarket', 'Polymarket'], ['novig', 'Novig'],
    ['prophetx', 'ProphetX'],
  ]},
  { key: 'offshore', label: 'Offshore', color: '#f59e0b', books: [
    ['bovada', 'Bovada'], ['pinnacle', 'Pinnacle'], ['betonline', 'BetOnline'],
    ['mybookie', 'MyBookie'], ['betus', 'BetUS'],
  ]},
  { key: 'dfs', label: 'DFS and pick’em', color: '#2dd4bf', books: [
    ['prizepicks', 'PrizePicks'], ['underdog', 'Underdog'], ['fliff', 'Fliff'],
  ]},
  { key: 'misc', label: 'Anything else', color: 'var(--muted)', books: [
    ['other', 'Other'],
  ]},
];

// Flat [key, label] list (catalog order) for callers that don't care about groups.
export const ALL_BOOKS = BOOK_GROUPS.flatMap(g => g.books);
const LABELS = Object.fromEntries(ALL_BOOKS);
export const bookLabel = (key) => LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : '');

let _sel = new Set();   // selection while the modal is open
let _saving = false;

function ensureModal() {
  if (document.getElementById('book-picker-modal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'book-picker-modal';
  wrap.className = 'modal-overlay hidden';
  wrap.innerHTML = `
    <div class="modal-card bp-card">
      <button class="modal-close" onclick="closeBookPicker()">&#x2715;</button>
      <div class="bp-title">My sportsbooks</div>
      <div class="bp-sub">Pick everywhere you bet. Books we carry lines for show live numbers on your betslip and game pages; the rest are still tracked in your history.</div>
      <div class="bp-groups" id="bp-groups"></div>
      <div class="bp-foot">
        <span class="bp-count" id="bp-count"></span>
        <button class="btn btn-primary bp-save" id="bp-save" onclick="saveBookPicker()">Save</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeBookPicker(); });
}

function renderGroups() {
  const el = document.getElementById('bp-groups');
  if (!el) return;
  el.innerHTML = BOOK_GROUPS.map(g => `
    <div class="bp-group">
      <div class="bp-group-label" style="color:${g.color};">${g.label}</div>
      <div class="bp-chips">
        ${g.books.map(([key, label]) => `
          <button type="button" class="bp-chip${_sel.has(key) ? ' active' : ''}" data-key="${key}" onclick="bpToggle('${key}')">
            ${label}${_sel.has(key) ? ' <i class="fa-solid fa-check"></i>' : ''}
          </button>`).join('')}
      </div>
    </div>`).join('');
  const n = _sel.size;
  const count = document.getElementById('bp-count');
  if (count) count.textContent = n ? `${n} book${n === 1 ? '' : 's'} selected` : 'Nothing selected yet';
}

export function openBookPicker() {
  ensureModal();
  _sel = new Set(Array.isArray(window._myBooks) ? window._myBooks : []);
  renderGroups();
  document.getElementById('book-picker-modal').classList.remove('hidden');
}

export function closeBookPicker() {
  const m = document.getElementById('book-picker-modal');
  if (m) m.classList.add('hidden');
}

function bpToggle(key) {
  if (_sel.has(key)) _sel.delete(key); else _sel.add(key);
  renderGroups();
}

async function saveBookPicker() {
  if (_saving) return;
  _saving = true;
  const btn = document.getElementById('bp-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    const keys = [...(_sel || [])];
    const r = await fetch('/api/account/preferences', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ my_books: keys }),
    });
    if (r.ok) {
      const d = await r.json().catch(() => null);
      window._myBooks = (d && Array.isArray(d.myBooks)) ? d.myBooks : keys;
      window.dispatchEvent(new CustomEvent('myBooksChanged', { detail: { myBooks: window._myBooks } }));
      closeBookPicker();
    }
  } catch (_) {}
  _saving = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
}

window.openBookPicker  = openBookPicker;
window.closeBookPicker = closeBookPicker;
window.bpToggle        = bpToggle;
window.saveBookPicker  = saveBookPicker;

// Seed window._myBooks on page load. The account renderers only set it when the
// Settings/Tracking/Profile views mount, so the home betslip and the standalone
// detail page would otherwise treat every member as book-less. Logged-out (401)
// leaves it undefined, which is correct.
(async () => {
  if (Array.isArray(window._myBooks)) return;
  try {
    const r = await fetch('/api/account', { credentials: 'include' });
    if (!r.ok) return;
    const d = await r.json();
    if (d && Array.isArray(d.myBooks)) {
      window._myBooks = d.myBooks;
      window.dispatchEvent(new CustomEvent('myBooksChanged', { detail: { myBooks: d.myBooks, seeded: true } }));
    }
  } catch (_) {}
})();
