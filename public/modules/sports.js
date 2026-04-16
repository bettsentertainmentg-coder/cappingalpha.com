// modules/sports.js — Sports tab: filtered picks + schedule + game search

import { state } from './state.js';
import { gameTime } from './utils.js';
import { renderPicks } from './picks.js';

// ── All today's games — loaded once when Sports tab opens ─────────────────────
let _allGames = [];

async function loadAllGames() {
  try {
    _allGames = await fetch('/api/games').then(r => r.json()) || [];
  } catch (_) {
    _allGames = [];
  }
}

export async function loadSports(sport) {
  await loadAllGames();
  initGameSearch();
  renderSportPicks(sport);
  await loadSchedule(sport);
}

export function setSport(sport) {
  state.activeSport = sport;
  document.querySelectorAll('.sport-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.sport === sport));
  document.getElementById('sport-picks-title').textContent    = sport + ' Picks';
  document.getElementById('sport-schedule-title').textContent = sport + ' Schedule';
  renderSportPicks(sport);
  loadSchedule(sport);
}

// Tennis combines ATP + WTA picks; all other sports filter by label directly.
// globalRankMap ensures free users only see the true #1 overall pick, not the #1 per sport.
export function renderSportPicks(sport) {
  const labels = sport === 'Tennis' ? ['ATP', 'WTA'] : [sport.toUpperCase()];
  const filtered = state.allPicks.filter(p => labels.includes((p.sport || '').toUpperCase()));
  const globalRankMap = new Map(state.allPicks.map((p, i) => [p.id, i + 1]));
  renderPicks(filtered, 'sport-picks-body', globalRankMap);
}

// ── Build a schedule row HTML string ─────────────────────────────────────────
function scheduleRowHtml(g) {
  const matchup = `${g.away_team || '?'} @ ${g.home_team || '?'}`;
  let rightCol;
  if (g.status === 'post') {
    rightCol = `<span style="font-size:13px;color:#8892a4;">${g.away_score}-${g.home_score} Final</span>`;
  } else if (g.status === 'in') {
    const sportUp = (g.sport || '').toUpperCase();
    const periodLabel = sportUp === 'MLB'
      ? `${g.period === 1 ? '1st' : g.period === 2 ? '2nd' : g.period === 3 ? '3rd' : (g.period || '') + 'th'} Inn`
      : sportUp === 'ATP' || sportUp === 'WTA'
        ? `Set ${g.period || ''}`
        : `P${g.period || ''}`;
    rightCol = `<span class="schedule-live"><span style="width:6px;height:6px;border-radius:50%;background:#4ade80;display:inline-block;animation:pulse 1s infinite;"></span>${g.away_score}-${g.home_score} · ${periodLabel}</span>`;
  } else {
    rightCol = `<span class="schedule-time">${gameTime(g.start_time)}</span>`;
  }
  return `<div class="schedule-row" style="cursor:pointer;" onclick="openGameModal('${g.espn_game_id}')"><span class="schedule-matchup">${matchup}</span>${rightCol}</div>`;
}

// ── Tennis: two stacked sections (ATP + WTA) in the same schedule panel ──────
async function loadTennisSchedule() {
  const el = document.getElementById('sport-schedule-body');
  el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;

  const [atpRows, wtaRows] = await Promise.all([
    fetch('/api/games?sport=ATP').then(r => r.json()).catch(() => []),
    fetch('/api/games?sport=WTA').then(r => r.json()).catch(() => []),
  ]);

  const renderSection = (label, rows) => {
    const items = rows.length
      ? rows.map(scheduleRowHtml).join('')
      : `<div style="padding:12px 16px;color:var(--muted);font-size:13px;">No ${label} matches today.</div>`;
    return `
      <div style="border-bottom:1px solid var(--border);">
        <div style="padding:10px 16px 6px;font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--muted);text-transform:uppercase;">${label}</div>
        <div class="schedule-list">${items}</div>
      </div>`;
  };

  el.innerHTML = renderSection('ATP', atpRows) + renderSection('WTA', wtaRows);
}

// ── Standard single-sport schedule ───────────────────────────────────────────
export async function loadSchedule(sport) {
  if (sport === 'Tennis') {
    return loadTennisSchedule();
  }

  const el = document.getElementById('sport-schedule-body');
  try {
    const res  = await fetch(`/api/games?sport=${sport}`);
    const rows = await res.json();

    if (!rows || rows.length === 0) {
      el.innerHTML = `<div class="empty" style="padding:32px;"><p>No ${sport} games today.</p></div>`;
      return;
    }

    el.innerHTML = `<div class="schedule-list">${rows.map(scheduleRowHtml).join('')}</div>`;
  } catch (_) {
    el.innerHTML = `<div class="empty" style="padding:32px;"><p>Failed to load schedule.</p></div>`;
  }
}

// ── Game search ───────────────────────────────────────────────────────────────
function initGameSearch() {
  const input    = document.getElementById('game-search-input');
  const dropdown = document.getElementById('game-search-dropdown');
  if (!input || !dropdown || input._searchInit) return;
  input._searchInit = true; // only bind once

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { dropdown.innerHTML = ''; dropdown.classList.remove('open'); return; }

    const matches = _allGames.filter(g => {
      const matchup = `${g.away_team || ''} ${g.home_team || ''}`.toLowerCase();
      return matchup.includes(q);
    }).slice(0, 8);

    if (!matches.length) { dropdown.innerHTML = ''; dropdown.classList.remove('open'); return; }

    dropdown.innerHTML = matches.map(g => {
      const matchup = `${g.away_team || '?'} @ ${g.home_team || '?'}`;
      let metaRight = '';
      if (g.status === 'post')     metaRight = `${g.away_score}–${g.home_score} Final`;
      else if (g.status === 'in')  metaRight = `<span style="color:#4ade80;font-weight:700;">LIVE</span>`;
      else                         metaRight = gameTime(g.start_time);
      return `<div class="game-search-item" onclick="selectSearchGame('${g.espn_game_id}')">
        <span class="game-search-matchup">${matchup}</span>
        <span class="game-search-meta">
          <span class="sport-badge" style="font-size:10px;padding:2px 6px;">${g.sport}</span>
          ${metaRight}
        </span>
      </div>`;
    }).join('');
    dropdown.classList.add('open');
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      input.value = '';
      dropdown.innerHTML = '';
      dropdown.classList.remove('open');
    }
    if (e.key === 'Enter') {
      const first = dropdown.querySelector('.game-search-item');
      if (first) first.click();
    }
    // Arrow keys to navigate suggestions
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...dropdown.querySelectorAll('.game-search-item')];
      if (!items.length) return;
      const focused = dropdown.querySelector('.game-search-item.focused');
      const idx = focused ? items.indexOf(focused) : -1;
      if (focused) focused.classList.remove('focused');
      const next = e.key === 'ArrowDown'
        ? items[(idx + 1) % items.length]
        : items[(idx - 1 + items.length) % items.length];
      next.classList.add('focused');
      next.scrollIntoView({ block: 'nearest' });
    }
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (!input.closest('.game-search-wrap').contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });
}

window.selectSearchGame = function(espnGameId) {
  const input    = document.getElementById('game-search-input');
  const dropdown = document.getElementById('game-search-dropdown');
  if (input)    { input.value = ''; }
  if (dropdown) { dropdown.innerHTML = ''; dropdown.classList.remove('open'); }
  window.openGameModal(espnGameId);
};

// Refresh sport picks when picks reload (avoids circular dep with picks.js)
document.addEventListener('picksUpdated', () => {
  if (state.sportsLoaded) renderSportPicks(state.activeSport);
});

Object.assign(window, { setSport });
