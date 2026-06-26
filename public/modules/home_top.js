// public/modules/home_top.js
// Home page lead rows:
//  • "Today's Top Games" — market-hotness strip, click → standalone detail page.
//  • "My Sports" — pick/save the sports you follow, then see each one's games
//    as an inline strip (same tiles as Top Games), click → detail page.

import { state }     from './state.js';
import { isPaying }  from './auth.js';
import { sportBadge, gameTime, pickLabel, basesDiamond, outsDots } from './utils.js';

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

function _isTennis(g) {
  const s = (g.sport || '').toUpperCase();
  return s === 'ATP' || s === 'WTA';
}

// Per-set games for a tennis match: [{set,home,away}, ...]. Empty if not started
// or detail not yet synced.
function _tennisSets(g) {
  try { return JSON.parse(g.tennis_score_detail || '[]') || []; } catch (_) { return []; }
}

// Period/inning label for a live game (mirrors utils.scoreDisplay): baseball
// shows the inning, hockey/basketball show the period/quarter, never a raw clock
// of "0:00".
function _livePeriod(g) {
  const sport = (g.sport || '').toUpperCase();
  const n = g.period;
  const ord = (x) => x === 1 ? '1st' : x === 2 ? '2nd' : x === 3 ? '3rd' : `${x}th`;
  if (sport === 'ATP' || sport === 'WTA') return n ? `Set ${n}` : 'Live';
  if (sport === 'MLB') return n ? `${ord(n)} Inn` : 'Live';
  if (sport === 'NHL' || sport === 'CBB' || sport === 'WCBB') {
    const p = n ? `P${n}` : '';
    return [p, g.clock && g.clock !== '0:00' ? g.clock : ''].filter(Boolean).join(' ') || 'Live';
  }
  // NBA / WNBA / NFL / NCAAF and similar: quarter + clock when meaningful.
  const q = n ? `Q${n}` : '';
  return [q, g.clock && g.clock !== '0:00' ? g.clock : ''].filter(Boolean).join(' ') || 'Live';
}

// True when a game carries live baseball state we can draw as a bases diamond.
function _hasBases(g) {
  return g.status === 'in' && (g.sport || '').toUpperCase() === 'MLB' && !!g.live_detail;
}

// Foot status: live half-inning/period (baseball bases now live in the team area),
// Final, or start time.
function _statusHtml(g) {
  const start = gameTime(g.start_time);
  if (g.status === 'in') {
    // Baseball: half-inning then outs to its right ("Top 9th ••"); the diamond
    // lives up in the team area. Other sports: plain period/clock.
    if (_hasBases(g)) {
      return `<span class="ca-tg-live"><span class="ca-tg-live-dot"></span>${g.live_detail}${outsDots(g.live_outs)}</span>`;
    }
    return `<span class="ca-tg-live"><span class="ca-tg-live-dot"></span>${_livePeriod(g)}</span>`;
  }
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

// Stable blurred placeholder (1–99) for the locked chip, hashed off the game id
// so it stays put across refreshes. The real score is never sent to non-subs.
function _lockedPlaceholder(g) {
  const key = String(g.espn_game_id || (g.top_pick && g.top_pick.id) || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return (Math.abs(h) % 99) + 1;
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
  // Non-paying users: the server withholds the score, so render the exact same CA
  // chip as subscribers — logo, badge, the works — but with a blurred number and a
  // golden lock over it (the detail-page locked style). The real number is never
  // sent to them; the blurred digits are a stable placeholder, not the score.
  if (tp.locked || !_isUnlocked(tp)) {
    const blur = _lockedPlaceholder(g);
    return `<span class="ca-tg-corner">
      <span class="ca-tg-ca ca-tg-ca-locked" title="Unlock with full access"><img src="/ca-logo.png" class="ca-tg-ca-logo" alt="CA" onerror="this.style.display='none'"><span class="ca-tg-ca-lockwrap"><span class="ca-tg-ca-blur">${blur}</span><span class="ca-tg-ca-lock"><i class="fa-solid fa-lock"></i></span></span></span>${multi}</span>`;
  }
  if (tp.score == null) return '';
  const col = _caColor(tp.score);
  return `<span class="ca-tg-corner">
    <span class="ca-tg-ca" style="color:${col};border-color:${col}66" title="${pickLabel(tp)}"><img src="/ca-logo.png" class="ca-tg-ca-logo" alt="CA" onerror="this.style.display='none'">${tp.score}</span>${multi}</span>`;
}

// One stacked team row: chip + short name + score, plus a winner marker on finals.
// Team sports show a single score; tennis shows ESPN-style per-set columns with the
// set winner's number emphasized (e.g. 6 4 6 vs 4 6 4) instead of a flat "2–1".
function _teamRow(g, isHome) {
  const full  = isHome ? g.home_team  : g.away_team;
  const short = isHome ? g.home_short : g.away_short;
  const abbr  = isHome ? g.home_abbr  : g.away_abbr;
  const flag  = isHome ? g.home_flag  : g.away_flag;
  const post  = g.status === 'post';
  const pre   = g.status !== 'in' && !post;
  const my    = (isHome ? g.home_score : g.away_score) ?? 0;
  const opp   = (isHome ? g.away_score : g.home_score) ?? 0;
  const won   = post && my > opp;
  const cls   = 'ca-tg-team' + (won ? ' ca-tg-team-win' : '') + (post && my < opp ? ' ca-tg-team-lose' : '');

  // Leading chip: tennis players get their country flag (ESPN style), team sports
  // keep the soft team-coloured abbreviation chip. Flag falls back to the abbr chip
  // if the image is missing/broken.
  let chip;
  if (_isTennis(g) && flag) {
    chip = `<span class="ca-tg-flag"><img src="${flag}" alt="" loading="lazy" onerror="this.style.display='none'">${_abbr(full, short, abbr)}</span>`;
  } else {
    const tc = _teamColor(g.sport, abbr || short);
    const abbrStyle = (tc && tc.primary)
      ? ` style="background:linear-gradient(rgba(0,0,0,.16),rgba(0,0,0,.16)),${tc.primary};color:${tc.secondary || '#ffffff'};"`
      : '';
    chip = `<span class="ca-tg-abbr"${abbrStyle}>${_abbr(full, short, abbr)}</span>`;
  }

  // Score area.
  let scoreArea = '';
  const sets = _isTennis(g) ? _tennisSets(g) : [];
  if (_isTennis(g) && sets.length && !pre) {
    const cells = sets.map(s => {
      const v   = isHome ? s.home : s.away;
      const oppV = isHome ? s.away : s.home;
      return `<span class="ca-tg-set${v > oppV ? ' ca-tg-set-won' : ''}">${v}</span>`;
    }).join('');
    scoreArea = `<span class="ca-tg-sets">${cells}</span>`;
  } else if (!pre) {
    scoreArea = `<span class="ca-tg-tscore">${my}</span>`;
  }

  // Winner triangle on finals (kept as a hidden placeholder on the other row so the
  // score columns stay right-aligned across both rows).
  const mark = `<span class="ca-tg-win-mark${won ? '' : ' ca-tg-win-mark-empty'}">◀</span>`;

  return `<div class="${cls}">${chip}<span class="ca-tg-tname">${_shortName(full, short)}</span>${scoreArea}${mark}</div>`;
}

// ESPN-style scoreboard tile: gradient sport badge + CA chip, two stacked teams
// with scores, status + More in the foot.
function _gameTile(g) {
  const tp = g.top_pick;
  const pickTitle = _isUnlocked(tp) ? ` · Top pick: ${pickLabel(tp)}` : '';
  const away = _shortName(g.away_team, g.away_short);
  const home = _shortName(g.home_team, g.home_short);
  // Live baseball: a bases diamond + outs sits in the open space between the team
  // names and their scores (vertically centred across both rows).
  const basesHtml = _hasBases(g)
    ? `<div class="ca-tg-bases">${basesDiamond(g.live_bases)}</div>`
    : '';
  return `<div class="ca-tg-tile" onclick="location.href='/game/${g.espn_game_id}'" title="${away} @ ${home}${pickTitle}">
    <div class="ca-tg-head">
      ${sportBadge(g.sport)}
      ${_cornerCluster(g)}
    </div>
    <div class="ca-tg-teams${basesHtml ? ' tg-has-bases' : ''}">
      ${_teamRow(g, false)}
      ${_teamRow(g, true)}
      ${basesHtml}
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
      if (games && games.length) {
        row.innerHTML = games.map(_gameTile).join('');
      } else {
        // No games → tuck the note inline next to the sport title and collapse
        // the empty row so it doesn't leave a big blank band.
        row.innerHTML = '';
        const strip = row.closest('.ca-ms-strip');
        if (strip) {
          strip.classList.add('ca-ms-strip--empty');
          const head = strip.querySelector('.ca-ms-strip-head');
          if (head && !head.querySelector('.ca-ms-strip-empty')) {
            head.insertAdjacentHTML('beforeend', `<span class="ca-ms-strip-empty">No games today</span>`);
          }
        }
      }
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
