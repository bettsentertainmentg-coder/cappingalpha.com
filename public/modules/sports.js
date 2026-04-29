// modules/sports.js — Sports tab: filtered picks + schedule + game search

import { state } from './state.js';
import { gameTime, pickLabel } from './utils.js';
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

// Tennis combines ATP + WTA picks; Golf uses separate golf_picks table; others filter directly.
// globalRankMap ensures free users only see the true #1 overall pick, not the #1 per sport.
export function renderSportPicks(sport) {
  if (sport === 'Golf') {
    renderGolfPicks();
    return;
  }
  const labels = sport === 'Tennis' ? ['ATP', 'WTA'] : [sport.toUpperCase()];
  const filtered = state.allPicks.filter(p => labels.includes((p.sport || '').toUpperCase()));
  const globalRankMap = new Map(state.allPicks.map((p, i) => [p.id, i + 1]));
  renderPicks(filtered, 'sport-picks-body', globalRankMap);
}

// ── Golf picks section ────────────────────────────────────────────────────────
async function renderGolfPicks() {
  const el = document.getElementById('sport-picks-body');
  el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const picks = await fetch('/api/golf/picks/all').then(r => r.json()).catch(() => []);
    if (!picks || picks.length === 0) {
      el.innerHTML = `<div class="empty"><div class="empty-icon">🕐</div><h3>No golf picks yet.</h3><p>Picks appear when a major tournament is active.</p></div>`;
      return;
    }
    const pickTypeLabel = t => {
      if (t === 'h2h')   return 'H2H';
      if (t === 'top5')  return 'Top 5';
      if (t === 'top10') return 'Top 10';
      return t ? t.toUpperCase() : '—';
    };
    const rows = picks.map((p, i) => `
      <tr style="cursor:pointer;" onclick="openGolfModal('${p.espn_tournament_id}')">
        <td class="rank">${i + 1}</td>
        <td class="matchup-cell">
          <span style="font-weight:600;">${p.player_name}</span>${p.vs_player ? ` <span style="color:var(--muted);font-size:12px;">vs ${p.vs_player}</span>` : ''}
          <br><span style="font-size:11px;color:var(--muted);">${p.tournament_name || 'Tournament'}</span>
        </td>
        <td><span class="sport-badge">Golf</span></td>
        <td class="pick-cell" style="${p.result === 'win' ? 'color:#4ade80' : p.result === 'loss' ? 'color:#f87171' : ''}">${pickTypeLabel(p.pick_type)}</td>
        <td class="score-col">${p.score ?? '—'}</td>
      </tr>`).join('');
    el.innerHTML = `<div class="table-scroll"><table><thead><tr><th>Rank</th><th>Player</th><th>Sport</th><th>Pick</th><th class="score-col">Score</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty"><p>Failed to load golf picks.</p></div>`;
  }
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
  return `<div class="schedule-row" style="cursor:pointer;" onclick="window.location.href='/game/${g.espn_game_id}'"><span class="schedule-matchup">${matchup}</span>${rightCol}</div>`;
}

// ── Tennis match row helper ───────────────────────────────────────────────────
function tennisMatchRow(g, mode) {
  const home = g.home_short || (g.home_team || '?').split(' ').pop();
  const away = g.away_short || (g.away_team || '?').split(' ').pop();
  const onclick = g.espn_game_id ? `onclick="window.location.href='/game/${g.espn_game_id}'"` : '';

  if (mode === 'post') {
    const badge = g._sport ? `<span style="font-size:10px;color:var(--muted);margin-right:6px;opacity:.7;">${g._sport}</span>` : '';
    return `<div class="tennis-completed-match" ${onclick}>
      <span>${badge}${home} <span style="color:var(--muted);">vs</span> ${away}</span>
      <span style="color:var(--muted);font-size:11px;">Final</span>
    </div>`;
  }

  let right;
  if (mode === 'live') {
    const info = g.period ? `Set ${g.period}` : (g.clock || 'Live');
    right = `<span class="tennis-match-right tlive"><span class="tennis-live-dot" style="width:5px;height:5px;margin-right:3px;"></span>${info}</span>`;
  } else {
    const time = g.start_time ? new Date(g.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'TBD';
    right = `<span class="tennis-match-right">${time}</span>`;
  }

  return `<div class="tennis-match" ${onclick}>
    <span class="tennis-match-name">${home} <span style="color:var(--muted);font-size:11px;font-weight:400;">vs</span> ${away}</span>
    ${right}
  </div>`;
}

function emptyTennisCol(msg) {
  return `<div style="padding:10px 14px;color:var(--muted);font-size:12px;text-align:center;">${msg}</div>`;
}

// ── Tennis schedule state ─────────────────────────────────────────────────────
let _tennisFilter = 'all';
let _tennisData   = { atpAll: [], wtaAll: [] };

// ── Re-renders schedule body + picks column based on current filter ───────────
function renderTennisView(filter) {
  _tennisFilter = filter;
  const { atpAll, wtaAll } = _tennisData;

  const sortAsc  = arr => [...arr].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  const sortDesc = arr => [...arr].sort((a, b) => (b.start_time || '').localeCompare(a.start_time || ''));

  const atpLive = atpAll.filter(g => g.status === 'in');
  const wtaLive = wtaAll.filter(g => g.status === 'in');
  const atpPre  = sortAsc(atpAll.filter(g => g.status === 'pre'));
  const wtaPre  = sortAsc(wtaAll.filter(g => g.status === 'pre'));
  const atpPost = sortDesc(atpAll.filter(g => g.status === 'post'));
  const wtaPost = sortDesc(wtaAll.filter(g => g.status === 'post'));
  const liveCount = atpLive.length + wtaLive.length;

  // ── Update picks column ───────────────────────────────────────────────────
  const globalRankMap = new Map(state.allPicks.map((p, i) => [p.id, i + 1]));
  if (filter === 'live') {
    const liveIds = new Set([...atpLive, ...wtaLive].map(g => g.espn_game_id).filter(Boolean));
    renderPicks(state.allPicks.filter(p => liveIds.has(p.espn_game_id)), 'sport-picks-body', globalRankMap);
  } else {
    const labels = filter === 'atp' ? ['ATP'] : filter === 'wta' ? ['WTA'] : ['ATP', 'WTA'];
    renderPicks(state.allPicks.filter(p => labels.includes((p.sport || '').toUpperCase())), 'sport-picks-body', globalRankMap);
  }

  // ── Widgets ───────────────────────────────────────────────────────────────
  const act = f => filter === f ? ' tennis-widget-active' : '';
  const widgets = `<div class="tennis-widgets">
    ${liveCount ? `<span class="tennis-widget tennis-widget-live${act('live')}" onclick="setTennisFilter('live')"><span class="tennis-live-dot"></span>${liveCount} Live</span>` : ''}
    <span class="tennis-widget${act('atp')}" onclick="setTennisFilter('atp')">ATP ${atpLive.length + atpPre.length}</span>
    <span class="tennis-widget${act('wta')}" onclick="setTennisFilter('wta')">WTA ${wtaLive.length + wtaPre.length}</span>
    ${(atpPost.length + wtaPost.length) ? `<span class="tennis-widget" style="color:var(--muted);">${atpPost.length + wtaPost.length} Completed</span>` : ''}
    ${filter !== 'all' ? `<span class="tennis-widget tennis-widget-clear" onclick="setTennisFilter('all')">× All</span>` : ''}
  </div>`;

  // ── Picks strip (top picks as chips) ────────────────────────────────────
  const stripLabels = filter === 'atp' ? ['ATP'] : filter === 'wta' ? ['WTA'] : ['ATP', 'WTA'];
  const liveIds2 = new Set([...atpLive, ...wtaLive].map(g => g.espn_game_id).filter(Boolean));
  const topPicks = (filter === 'live'
    ? state.allPicks.filter(p => liveIds2.has(p.espn_game_id))
    : state.allPicks.filter(p => stripLabels.includes((p.sport || '').toUpperCase()))
  ).slice(0, 4);

  const picksStrip = topPicks.length ? `
    <div class="tennis-picks-strip">
      <span class="tennis-picks-label">Top Picks</span>
      ${topPicks.map(p => {
        const pt = (p.pick_type || '').toLowerCase();
        const isHome = p.is_home_team === 1 || p.is_home_team === true;
        const slotKey = pt === 'over' ? 'over' : pt === 'under' ? 'under'
          : pt === 'ml' ? (isHome ? 'home_ml' : 'away_ml')
          : pt === 'spread' ? (isHome ? 'home_spread' : 'away_spread') : '';
        const dest = p.espn_game_id ? `/game/${p.espn_game_id}${slotKey ? '?slot=' + slotKey : ''}` : '';
        const oc = dest ? `onclick="window.location.href='${dest}'"` : '';
        return `<span class="tennis-pick-chip" ${oc}>${pickLabel(p)} · ${p.score}pts</span>`;
      }).join('')}
    </div>` : '';

  // ── Schedule content ──────────────────────────────────────────────────────
  const isSingle = filter === 'atp' || filter === 'wta';
  let content = '';

  // Live section
  if (filter === 'live' || filter === 'all') {
    if (liveCount) {
      content += `<div class="tennis-live-head"><span class="tennis-live-dot"></span>Live Now</div>
        <div class="tennis-two-col">
          <div class="tennis-col"><div class="tennis-col-head">ATP</div>${atpLive.length ? atpLive.map(g => tennisMatchRow(g, 'live')).join('') : emptyTennisCol('—')}</div>
          <div class="tennis-col"><div class="tennis-col-head">WTA</div>${wtaLive.length ? wtaLive.map(g => tennisMatchRow(g, 'live')).join('') : emptyTennisCol('—')}</div>
        </div>`;
    } else if (filter === 'live') {
      content += `<div style="padding:24px 16px;color:var(--muted);font-size:13px;text-align:center;">No live matches right now.</div>`;
    }
  } else if (isSingle) {
    const liveSingle = filter === 'atp' ? atpLive : wtaLive;
    if (liveSingle.length) {
      content += `<div class="tennis-live-head"><span class="tennis-live-dot"></span>Live Now</div>${liveSingle.map(g => tennisMatchRow(g, 'live')).join('')}`;
    }
  }

  // Upcoming day sections (skip for 'live' filter)
  if (filter !== 'live') {
    const atpPreF = filter === 'wta' ? [] : atpPre;
    const wtaPreF = filter === 'atp' ? [] : wtaPre;
    const todayUTC    = new Date().toISOString().slice(0, 10);
    const tomorrowUTC = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
    const dayLabel = d => {
      if (d === todayUTC)    return 'Today';
      if (d === tomorrowUTC) return 'Tomorrow';
      return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    };
    const upcomingDates = [...new Set([
      ...atpPreF.map(g => (g.start_time || '').slice(0, 10)),
      ...wtaPreF.map(g => (g.start_time || '').slice(0, 10)),
    ])].filter(Boolean).sort().slice(0, 4);

    upcomingDates.forEach((d, i) => {
      const atpDay = atpPreF.filter(g => (g.start_time || '').slice(0, 10) === d);
      const wtaDay = wtaPreF.filter(g => (g.start_time || '').slice(0, 10) === d);
      const firstBand = i === 0 && !liveCount ? ' first-band' : '';
      content += `<div class="tennis-day-band${firstBand}">${dayLabel(d)}</div>`;
      if (isSingle) {
        const matches = filter === 'atp' ? atpDay : wtaDay;
        content += matches.length ? matches.map(g => tennisMatchRow(g, 'pre')).join('') : emptyTennisCol('No matches');
      } else {
        content += `<div class="tennis-two-col">
          <div class="tennis-col"><div class="tennis-col-head">ATP</div>${atpDay.length ? atpDay.map(g => tennisMatchRow(g, 'pre')).join('') : emptyTennisCol('No matches')}</div>
          <div class="tennis-col"><div class="tennis-col-head">WTA</div>${wtaDay.length ? wtaDay.map(g => tennisMatchRow(g, 'pre')).join('') : emptyTennisCol('No matches')}</div>
        </div>`;
      }
    });

    // Completed
    const completedAll = [
      ...(filter === 'wta' ? [] : atpPost.map(g => ({ ...g, _sport: 'ATP' }))),
      ...(filter === 'atp' ? [] : wtaPost.map(g => ({ ...g, _sport: 'WTA' }))),
    ].sort((a, b) => (b.start_time || '').localeCompare(a.start_time || '')).slice(0, 25);

    if (completedAll.length) {
      content += `<div class="tennis-completed-head">Completed</div>${completedAll.map(g => tennisMatchRow(g, 'post')).join('')}`;
    }
  }

  document.getElementById('sport-schedule-body').innerHTML = widgets + picksStrip + content;
}

// Exposed to window for onclick handlers
window.setTennisFilter = filter => renderTennisView(filter);

// ── Fetch ATP + WTA data then render ─────────────────────────────────────────
async function loadTennisSchedule() {
  _tennisFilter = 'all';
  const el = document.getElementById('sport-schedule-body');
  el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;

  const [atpAll, wtaAll] = await Promise.all([
    fetch('/api/games?sport=ATP').then(r => r.json()).catch(() => []),
    fetch('/api/games?sport=WTA').then(r => r.json()).catch(() => []),
  ]);
  _tennisData = { atpAll, wtaAll };
  renderTennisView('all');
}

// ── Golf schedule: active major tournaments ───────────────────────────────────
async function loadGolfSchedule() {
  const el = document.getElementById('sport-schedule-body');
  el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  try {
    const tournaments = await fetch('/api/golf/tournaments').then(r => r.json()).catch(() => []);
    if (!tournaments || tournaments.length === 0) {
      el.innerHTML = `<div class="empty" style="padding:32px;"><p>No major tournaments active this week.</p></div>`;
      return;
    }
    el.innerHTML = `<div class="schedule-list">${tournaments.map(golfTournamentRowHtml).join('')}</div>`;
  } catch (_) {
    el.innerHTML = `<div class="empty" style="padding:32px;"><p>Failed to load golf schedule.</p></div>`;
  }
}

function golfTournamentRowHtml(t) {
  let rightCol;
  if (t.status === 'post') {
    rightCol = `<span style="font-size:13px;color:var(--muted);">Final</span>`;
  } else if (t.status === 'in') {
    rightCol = `<span class="schedule-live"><span style="width:6px;height:6px;border-radius:50%;background:#4ade80;display:inline-block;animation:pulse 1s infinite;margin-right:5px;"></span>Round ${t.current_round || '?'} Live</span>`;
  } else {
    const dateStr = t.start_date ? new Date(t.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Upcoming';
    rightCol = `<span class="schedule-time">${dateStr}</span>`;
  }
  const subtitle = [t.course, t.city].filter(Boolean).join(' · ');
  return `<div class="schedule-row" style="cursor:pointer;" onclick="openGolfModal('${t.espn_tournament_id}')">
    <span class="schedule-matchup">
      <span style="font-weight:600;">${t.name}</span>
      ${subtitle ? `<br><span style="font-size:11px;color:var(--muted);">${subtitle}</span>` : ''}
    </span>
    ${rightCol}
  </div>`;
}

// ── Standard single-sport schedule ───────────────────────────────────────────
export async function loadSchedule(sport) {
  if (sport === 'Tennis') {
    return loadTennisSchedule();
  }
  if (sport === 'Golf') {
    return loadGolfSchedule();
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
  window.location.href = `/game/${espnGameId}`;
};

// Refresh sport picks when picks reload (avoids circular dep with picks.js)
document.addEventListener('picksUpdated', () => {
  if (state.sportsLoaded) renderSportPicks(state.activeSport);
});

Object.assign(window, { setSport });
