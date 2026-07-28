// modules/home_scores.js — the app Home scoreboard (native shell only).
// The "My Sports" bundle: filter chips + ESPN-style score rows grouped by
// sport, live games first, upcoming with time + line, finals with the loser
// dimmed and a winner arrow. Where ESPN puts Watch/Highlights, CA puts a lock
// (rankings not unlocked) or the CA score bubble + pick count (paid).
// Rows open the game detail popup. Website home never renders this (ca-app gate).

import { state } from './state.js';
import { isPaying } from './auth.js';
import { gameTime, fmtOdds, liveStateHtml, teamNickname } from './utils.js?v=5';

const GROUP_OF = (s) => { s = (s || '').toUpperCase(); return (s === 'ATP' || s === 'WTA') ? 'Tennis' : s; };
const DEFAULT_ORDER = ['MLB', 'NFL', 'WNBA', 'NBA', 'NHL', 'SOCCER', 'Tennis', 'NCAAF', 'CBB', 'GOLF'];
const LABEL = { SOCCER: 'Soccer', Tennis: 'Tennis', GOLF: 'Golf' };

let _games  = [];
let _filter = 'All';
let _favs   = null;   // group labels from account prefs (uppercased)
let _colors = null;   // /team_colors.json

async function ensureColors() {
  if (_colors) return;
  try { _colors = await (await fetch('/team_colors.json')).json(); } catch (_) { _colors = {}; }
}
async function ensureFavs() {
  if (_favs) return;
  if (!state.currentUser) { _favs = []; return; }
  try {
    const acc = await (await fetch('/api/account')).json();
    _favs = [...new Set((acc.favoriteSports || []).map(GROUP_OF))];
  } catch (_) { _favs = []; }
}
function teamColor(sport, abbr) {
  const s = (_colors || {})[(sport || '').toUpperCase()] || {};
  return (s[(abbr || '').toUpperCase()] || {}).primary || '';
}
// Black or white chip text by background luminance (some team primaries are light).
function chipText(bg) {
  const m = /^#?([0-9a-f]{6})/i.exec(bg || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150 ? '#111' : '#fff';
}

export async function loadHomeScores() {
  const host = document.getElementById('ca-app-scores');
  if (!host || !document.documentElement.classList.contains('ca-app')) return;
  await Promise.all([ensureColors(), ensureFavs()]);
  try {
    // board=1 is the richer projection (abbrs, short names, flags) the Top
    // Games strip already uses; the bare /api/games rows carry neither.
    const res = await fetch('/api/games?board=1');
    if (res.ok) _games = await res.json();
  } catch (_) { /* keep the last good list */ }
  render();
}

// Ranked-pick presence per game, from the already-loaded board (picks.js keeps
// state.allPicks fresh and fires picksUpdated).
function pickMap() {
  const m = new Map();
  for (const p of (state.allPicks || [])) {
    if (!p.espn_game_id) continue;
    const k = String(p.espn_game_id);
    const e = m.get(k) || { n: 0, top: 0 };
    e.n++;
    const sc = Number(p.score || 0);
    if (sc > e.top) e.top = sc;
    m.set(k, e);
  }
  return m;
}

const STATUS_RANK = { in: 0, pre: 1, post: 2 };
function rowsOf(group) {
  return _games
    .filter(g => GROUP_OF(g.sport) === group)
    .sort((a, b) => (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3)
      || Date.parse(a.start_time || 0) - Date.parse(b.start_time || 0));
}

function stateCell(g) {
  if (g.status === 'in') {
    const live = liveStateHtml(g);
    const fallback = [g.period ? (g.game_live_detail || g.live_detail || '') : '', g.clock || ''].filter(Boolean).join(' ');
    return `<span class="hs-state-line"><span class="hs-live-dot">●</span> ${live || fallback || 'Live'}</span>`;
  }
  if (g.status === 'post') return `<span class="hs-state-line">Final</span>`;
  const fav = (g.ml_home != null && g.ml_away != null)
    ? (Number(g.ml_home) <= Number(g.ml_away)
        ? `${g.home_abbr || ''} ${fmtOdds(g.ml_home)}` : `${g.away_abbr || ''} ${fmtOdds(g.ml_away)}`)
    : '';
  const ou = g.over_under != null ? `O/U ${g.over_under}` : '';
  const sub = [fav, ou].filter(Boolean).join(' · ');
  return `<span class="hs-state-line">${gameTime(g.start_time) || ''}</span>${sub ? `<span class="hs-sub">${sub}</span>` : ''}`;
}

function caCell(g, picks) {
  const info = picks.get(String(g.espn_game_id));
  if (!isPaying()) {
    return `<span class="hs-lock" title="CA Rankings"><i class="fa-solid fa-lock" aria-hidden="true"></i></span>`;
  }
  if (!info || !info.n) return '';
  return `<span class="hs-ca-chip">CA ${Math.round(info.top)}</span><span class="hs-count">${info.n} pick${info.n === 1 ? '' : 's'}</span>`;
}

function teamLine(g, side, dim, winner) {
  const tennis = ['ATP', 'WTA'].includes((g.sport || '').toUpperCase());
  const full   = side === 'home' ? (g.home_team || '') : (g.away_team || '');
  const opp    = side === 'home' ? (g.away_team || '') : (g.home_team || '');
  const short  = side === 'home' ? g.home_short : g.away_short;
  let  abbr    = side === 'home' ? (g.home_abbr || '') : (g.away_abbr || '');
  const score  = side === 'home' ? g.home_score : g.away_score;
  // ESPN-style short display name: nickname for team sports (opponent-aware so
  // two same-nickname sides keep their lead word), last name for tennis.
  const last = full.trim().split(/\s+/).pop() || full;
  const name = tennis ? (short || last) : (short || teamNickname(full, opp) || full);
  if (tennis && !abbr) abbr = last.slice(0, 3).toUpperCase();
  const col  = tennis ? '' : teamColor(g.sport, abbr);
  const chip = col
    ? `<span class="hs-abbr" style="background:${col};color:${chipText(col)};">${abbr}</span>`
    : `<span class="hs-abbr hs-abbr-plain">${(abbr || name).slice(0, 3).toUpperCase()}</span>`;
  const pts = (g.status === 'pre' || score == null) ? '' : `<span class="hs-pts">${score}</span>`;
  return `<div class="hs-team${dim ? ' dim' : ''}">${chip}<span class="hs-name">${name}</span>${pts}${winner ? '<i class="fa-solid fa-caret-left hs-win-arrow" aria-hidden="true"></i>' : ''}</div>`;
}

function rowHtml(g, picks) {
  const final = g.status === 'post';
  const hs = Number(g.home_score), as = Number(g.away_score);
  const homeWon = final && isFinite(hs) && isFinite(as) && hs > as;
  const awayWon = final && isFinite(hs) && isFinite(as) && as > hs;
  return `<div class="hs-row" onclick="openGameModal('${g.espn_game_id}')">
    <div class="hs-teams">
      ${teamLine(g, 'away', final && homeWon, awayWon)}
      ${teamLine(g, 'home', final && awayWon, homeWon)}
    </div>
    <div class="hs-state">${stateCell(g)}</div>
    <div class="hs-caslot">${caCell(g, picks)}</div>
  </div>`;
}

const MAX_ROWS = 5;
function sectionHtml(group, picks, expanded) {
  const rows = rowsOf(group);
  if (!rows.length) return '';
  const shown = expanded ? rows : rows.slice(0, MAX_ROWS);
  const label = LABEL[group] || group;
  const live = rows.filter(g => g.status === 'in').length;
  return `<div class="hs-sec">
    <div class="hs-sec-head">
      <span class="hs-sec-title">${label}${live ? ` <span class="hs-live-count">${live} live</span>` : ''}</span>
      <span class="hs-sec-link" onclick="switchTab('sports'); window.setSport && setSport('${group === 'Tennis' ? 'Tennis' : label}')">See all &rsaquo;</span>
    </div>
    <div class="hs-card">
      ${shown.map(g => rowHtml(g, picks)).join('')}
      ${rows.length > shown.length ? `<button class="hs-more" onclick="hsFilter('${group}')">All ${rows.length} ${label} games</button>` : ''}
    </div>
  </div>`;
}

function render() {
  const host = document.getElementById('ca-app-scores');
  if (!host) return;
  const groupsPresent = [...new Set(_games.map(g => GROUP_OF(g.sport)))];
  const order = [...new Set([...(_favs || []), ...DEFAULT_ORDER, ...groupsPresent])]
    .filter(gr => groupsPresent.includes(gr));
  if (!order.length) {
    host.innerHTML = `<div class="hs-empty">No games on the board yet today. Check back after the morning refresh.</div>`;
    return;
  }
  if (_filter !== 'All' && !order.includes(_filter)) _filter = 'All';
  const chips = ['All', ...order].map(gr =>
    `<button class="hs-chip${_filter === gr ? ' on' : ''}" onclick="hsFilter('${gr}')">${gr === 'All' ? 'All' : (LABEL[gr] || gr)}</button>`).join('')
    // "+ Add" opens the My Sports picker (guests land on sign-up).
    + `<button class="hs-chip hs-chip-add" onclick="(window.openMySportsPicker || (() => {}))()">Add +</button>`;
  const picks = pickMap();
  const sections = (_filter === 'All' ? order : [_filter])
    .map(gr => sectionHtml(gr, picks, _filter !== 'All')).join('');
  host.innerHTML = `<div class="hs-chips">${chips}</div>${sections}`;
}

window.hsFilter = (f) => { _filter = f; render(); };
// Re-render the CA bubbles when the ranked board refreshes.
window.addEventListener('picksUpdated', () => { if (_games.length) render(); });
// My Sports changed (picker save): re-pull favorites so section order follows.
document.addEventListener('mySportsChanged', () => { _favs = null; loadHomeScores(); });
