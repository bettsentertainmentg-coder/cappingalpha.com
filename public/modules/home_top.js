// public/modules/home_top.js
// Home page lead rows:
//  • "Today's Top Games" — market-hotness strip, click → standalone detail page.
//  • "My Sports" — pick/save the sports you follow, then see each one's games
//    as an inline strip (same tiles as Top Games), click → detail page.

import { state }     from './state.js';
import { isPaying }  from './auth.js';
import { sportBadge, gameTime, pickLabel, LOCK_SVG } from './utils.js';

// All sports the product supports. Tennis is the merged ATP+WTA label.
const MS_ALL_SPORTS = ['MLB', 'NBA', 'WNBA', 'NHL', 'NFL', 'NCAAF', 'CBB', 'Tennis', 'Golf'];

// ── Team colors (for the abbreviation chips) ────────────────────────────────────
// Same source + lookup the detail page uses (/team_colors.json, keyed sport→abbr).
let _teamColors = null;
let _teamColorsPromise = null;
function _ensureTeamColors() {
  if (_teamColors) return Promise.resolve();
  if (!_teamColorsPromise) {
    _teamColorsPromise = fetch('/team_colors.json')
      .then(r => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then(j => { _teamColors = j; });
  }
  return _teamColorsPromise;
}
const _ABBR_ALIAS = { NBA: { NY: 'NYK', SA: 'SAS', GS: 'GSW', NO: 'NOP', UTAH: 'UTA' } };
function _teamColor(sport, abbr) {
  if (!_teamColors || !abbr) return null;
  const sp = (sport || '').toUpperCase();
  const a  = String(abbr).toUpperCase();
  const bucket = _teamColors[sp] || {};
  const alias  = (_ABBR_ALIAS[sp] || {})[a] || a;
  return bucket[a] || bucket[alias] || null;
}

// ── Shared tile rendering (used by both rows) ───────────────────────────────────
function _shortName(full, short) {
  if (short) return short;
  if (!full) return '';
  return full.split(' ').pop();
}

// Period/inning label for a live game (mirrors utils.scoreDisplay): baseball
// shows the inning, hockey/basketball show the period/quarter, never a raw clock
// of "0:00".
function _livePeriod(g) {
  const sport = (g.sport || '').toUpperCase();
  const n = g.period;
  const ord = (x) => x === 1 ? '1st' : x === 2 ? '2nd' : x === 3 ? '3rd' : `${x}th`;
  if (sport === 'MLB') return n ? `${ord(n)} Inn` : 'Live';
  if (sport === 'NHL' || sport === 'CBB' || sport === 'WCBB') {
    const p = n ? `P${n}` : '';
    return [p, g.clock && g.clock !== '0:00' ? g.clock : ''].filter(Boolean).join(' ') || 'Live';
  }
  // NBA / WNBA / NFL / NCAAF and similar: quarter + clock when meaningful.
  const q = n ? `Q${n}` : '';
  return [q, g.clock && g.clock !== '0:00' ? g.clock : ''].filter(Boolean).join(' ') || 'Live';
}

// Foot status: live period (score lives in the team rows now), Final, or start time.
function _statusHtml(g) {
  const start = gameTime(g.start_time);
  if (g.status === 'in')   return `<span class="ca-tg-live"><span class="ca-tg-live-dot"></span>${_livePeriod(g)}</span>`;
  if (g.status === 'post') return `<span class="ca-tg-final">Final</span>`;
  return `<span class="ca-tg-time">${start}</span>`;
}

function _isUnlocked(tp) {
  return !!tp && tp.score != null && (isPaying() || tp.is_global_1);
}

// CA score chip colour: bronze under 35, silver 35–49, gold 50+ (MVP).
function _caColor(score) {
  if (score >= 50) return '#FFD700';
  if (score >= 35) return '#C0C0C0';
  return '#cd7f32';
}

// 3-letter team abbreviation: prefer the ESPN abbr, else derive from short/full name.
function _abbr(full, short, abbr) {
  if (abbr) return String(abbr).toUpperCase();
  const base = (short || full || '').trim();
  if (!base) return '?';
  const w = base.split(/\s+/);
  if (w.length >= 2) return (w[0][0] + w[1][0] + (w[1][1] || '')).toUpperCase();
  return base.slice(0, 3).toUpperCase();
}

// Top-right CA score chip: marquee badge + score, only when there's a rated pick
// (no dashes). Locked for free users beyond the global #1. A small blue badge
// shows how many rated picks are on the game.
function _cornerCluster(g) {
  const tp = g.top_pick;
  if (!tp) return '';
  // Pick-count badge shows for everyone (it's not paid content) when >1.
  const multi = (g.pick_count > 1)
    ? `<span class="ca-tg-multi" title="${g.pick_count} rated picks on this game">${g.pick_count}</span>`
    : '';
  // Non-paying users: the server withholds the score, so render a gray/silver CA
  // chip with the badge, a blurred placeholder, and a lock — same shape as a real
  // chip so the row reads consistently. The real number is never sent to them.
  if (tp.locked || !_isUnlocked(tp)) {
    return `<span class="ca-tg-corner">
      <span class="ca-tg-ca ca-tg-ca-locked" title="Unlock with full access"><img src="/ca-logo.png" class="ca-tg-ca-logo" alt="CA" onerror="this.style.display='none'"><span class="ca-tg-ca-lockwrap"><span class="ca-tg-ca-blur">00</span><span class="ca-tg-ca-lock">${LOCK_SVG}</span></span></span>${multi}</span>`;
  }
  if (tp.score == null) return '';
  const col = _caColor(tp.score);
  return `<span class="ca-tg-corner">
    <span class="ca-tg-ca" style="color:${col};border-color:${col}66" title="${pickLabel(tp)}"><img src="/ca-logo.png" class="ca-tg-ca-logo" alt="CA" onerror="this.style.display='none'">${tp.score}</span>${multi}</span>`;
}

// One stacked team row: abbr + short name + score (score appears once the game starts).
function _teamRow(g, isHome) {
  const full  = isHome ? g.home_team  : g.away_team;
  const short = isHome ? g.home_short : g.away_short;
  const abbr  = isHome ? g.home_abbr  : g.away_abbr;
  const post  = g.status === 'post';
  const pre   = g.status !== 'in' && !post;
  const my    = (isHome ? g.home_score : g.away_score) ?? 0;
  const opp   = (isHome ? g.away_score : g.home_score) ?? 0;
  const cls   = 'ca-tg-team' + (post && my > opp ? ' ca-tg-team-win' : '') + (post && my < opp ? ' ca-tg-team-lose' : '');
  const score = pre ? '' : `<span class="ca-tg-tscore">${my}</span>`;
  // Soft team-coloured abbreviation chip: primary background (darkened a touch so
  // bright primaries stay easy on the eyes) + secondary text. Falls back to the
  // neutral grey chip when no colour is known (e.g. tennis players).
  const tc = _teamColor(g.sport, abbr || short);
  const abbrStyle = (tc && tc.primary)
    ? ` style="background:linear-gradient(rgba(0,0,0,.16),rgba(0,0,0,.16)),${tc.primary};color:${tc.secondary || '#ffffff'};"`
    : '';
  return `<div class="${cls}"><span class="ca-tg-abbr"${abbrStyle}>${_abbr(full, short, abbr)}</span><span class="ca-tg-tname">${_shortName(full, short)}</span>${score}</div>`;
}

// ESPN-style scoreboard tile: gradient sport badge + CA chip, two stacked teams
// with scores, status + More in the foot.
function _gameTile(g) {
  const tp = g.top_pick;
  const pickTitle = _isUnlocked(tp) ? ` · Top pick: ${pickLabel(tp)}` : '';
  const away = _shortName(g.away_team, g.away_short);
  const home = _shortName(g.home_team, g.home_short);
  return `<div class="ca-tg-tile" onclick="location.href='/game/${g.espn_game_id}'" title="${away} @ ${home}${pickTitle}">
    <div class="ca-tg-head">
      ${sportBadge(g.sport)}
      ${_cornerCluster(g)}
    </div>
    <div class="ca-tg-teams">
      ${_teamRow(g, false)}
      ${_teamRow(g, true)}
    </div>
    <div class="ca-tg-foot">
      ${_statusHtml(g)}
      <span class="ca-tg-more">More ›</span>
    </div>
  </div>`;
}

// ── Today's Top Games ───────────────────────────────────────────────────────────
export async function loadTopGames() {
  const el = document.getElementById('ca-top-games-row');
  if (!el) return;

  await _ensureTeamColors();
  try {
    const res = await fetch('/api/games/top');
    if (!res.ok) throw new Error('fetch failed');
    const games = await res.json();
    if (!games || games.length === 0) {
      el.innerHTML = `<div class="ca-top-games-empty">No games to feature yet today.</div>`;
      return;
    }
    el.innerHTML = games.map(_gameTile).join('');
  } catch (_) {
    el.innerHTML = `<div class="ca-top-games-empty">Top games unavailable.</div>`;
  }
}

// ── My Sports ─────────────────────────────────────────────────────────────────
let _msSelected = [];   // currently selected sports (display labels, in priority order)
let _msSaved    = [];   // last-saved baseline, to detect unsaved changes

function _toLabel(s) { return (s === 'ATP' || s === 'WTA') ? 'Tennis' : s; }

// Map display labels back to the preferences allowlist (Tennis → ATP + WTA).
function _toPrefSports(labels) {
  const out = [];
  for (const s of labels) {
    if (s === 'Tennis') { out.push('ATP', 'WTA'); }
    else out.push(s);
  }
  return [...new Set(out)];
}

export async function loadMySports() {
  const el = document.getElementById('ca-my-sports-row');
  if (!el) return;

  // Seed selection from saved favorites for logged-in users.
  _msSelected = [];
  if (state.currentUser) {
    const acc = await fetch('/api/account').then(r => r.ok ? r.json() : null).catch(() => null);
    if (acc && Array.isArray(acc.favoriteSports)) {
      const labels = [...new Set(acc.favoriteSports.map(_toLabel))];
      // Keep them in MS_ALL_SPORTS display order for stable ranking.
      _msSelected = MS_ALL_SPORTS.filter(s => labels.includes(s));
    }
  }
  _msSaved = [..._msSelected];

  _renderMySports();
}

function _renderMySports() {
  const el = document.getElementById('ca-my-sports-row');
  if (!el) return;

  const chips = MS_ALL_SPORTS.map(s => {
    const active = _msSelected.includes(s);
    return `<button class="ca-ms-chip${active ? ' active' : ''}" onclick="toggleMySport('${s}')">${s}</button>`;
  }).join('');

  const dirty = _msSelected.join(',') !== _msSaved.join(',');
  const saveBtn = dirty
    ? `<button class="ca-ms-chip ca-ms-save" onclick="saveMySports()">Save</button>`
    : '';

  const hint = _msSelected.length === 0
    ? `<span class="ca-ms-hint">Pick the sports you want to follow.</span>`
    : '';

  el.innerHTML = `
    <div class="ca-ms-chips">${chips}${saveBtn}${hint}</div>
    <div class="ca-ms-strips" id="ca-ms-strips"></div>`;

  _renderMyStrips();
}

export function toggleMySport(sport) {
  if (_msSelected.includes(sport)) {
    _msSelected = _msSelected.filter(s => s !== sport);
  } else {
    // Keep MS_ALL_SPORTS display order so ranking stays stable.
    _msSelected = MS_ALL_SPORTS.filter(s => s === sport || _msSelected.includes(s));
  }
  _renderMySports();
}

export async function saveMySports() {
  // Saving requires an account — send logged-out users to signup.
  if (!state.currentUser) {
    if (window.openSignup) window.openSignup();
    return;
  }
  try {
    const res = await fetch('/api/account/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite_sports: _toPrefSports(_msSelected) }),
    });
    if (res.ok) {
      _msSaved = [..._msSelected];
      _renderMySports();
    }
  } catch (_) { /* leave the Save button up so they can retry */ }
}

// Render one inline strip per selected sport (ranked in selection order).
async function _renderMyStrips() {
  const wrap = document.getElementById('ca-ms-strips');
  if (!wrap) return;

  if (_msSelected.length === 0) { wrap.innerHTML = ''; return; }

  wrap.innerHTML = _msSelected.map(s => `
    <div class="ca-ms-strip" data-sport="${s}">
      <div class="ca-ms-strip-head">${s}</div>
      <div class="ca-top-games-row ca-ms-strip-row" id="ca-ms-row-${s}">
        <div class="ca-top-games-empty">Loading...</div>
      </div>
    </div>`).join('');

  // Fetch each sport's games independently so a slow one doesn't block the rest.
  _msSelected.forEach(async (s) => {
    const row = document.getElementById(`ca-ms-row-${s}`);
    if (!row) return;
    try {
      await _ensureTeamColors();
      const games = await fetch(`/api/games/top?sport=${encodeURIComponent(s)}&limit=12`)
        .then(r => r.ok ? r.json() : []);
      row.innerHTML = (games && games.length)
        ? games.map(_gameTile).join('')
        : `<div class="ca-top-games-empty">No ${s} games today.</div>`;
    } catch (_) {
      row.innerHTML = `<div class="ca-top-games-empty">Unavailable.</div>`;
    }
  });
}

window.toggleMySport = toggleMySport;
window.saveMySports  = saveMySports;

// ── Drag-to-scroll for the horizontal game rows (Top Games + My Sports strips) ──
// Mouse only — touch devices already get native swipe, so we don't fight it. A
// document-level handler covers strips that render in asynchronously.
function _initDragScroll() {
  let row = null, startX = 0, startLeft = 0, moved = 0;
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = e.target.closest('.ca-top-games-row');
    if (!r) return;
    row = r; startX = e.clientX; startLeft = r.scrollLeft; moved = 0;
    r.classList.add('ca-dragging');
  });
  document.addEventListener('pointermove', (e) => {
    if (!row) return;
    const dx = e.clientX - startX;
    moved += Math.abs(dx);
    row.scrollLeft = startLeft - dx;
  });
  const end = () => { if (row) row.classList.remove('ca-dragging'); row = null; };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  // Swallow the click that follows a real drag so a tile doesn't navigate mid-drag.
  document.addEventListener('click', (e) => {
    if (moved > 6 && e.target.closest('.ca-top-games-row')) { e.preventDefault(); e.stopPropagation(); moved = 0; }
  }, true);
}
_initDragScroll();
