// modules/sports.js — Sports tab: the Network Two broadcast board.
//
// One component family replaces the old picks-table + schedule split:
//   - vitals strip (date, games, live, ranked, Full record link)
//   - sport bubbles sorted by daily activity (live x3 + ranked x2 + games),
//     additive multi-select, empty set = All, zero-game sports stay selectable
//   - status-grouped board: Live / Starting soon (<= 90 min, live countdown) /
//     Upcoming / Final
//   - broadcast game cards: two-tone team-color band, lines strip, CA element
//     (member score-bubble clusters, free lock chip), inline chevron expansion
//     with Track / Details / bell exits
//   - cross-day search over every /api/games row (tomorrow's seeded games
//     included), results tagged by day
//
// Data discipline: one /api/games + /api/golf/tournaments fetch per refresh,
// state.allPicks (already polled by app.js), state.CONFIG. No new endpoints,
// no per-card fetches, exactly one countdown interval.

import { state } from './state.js';
import {
  gameTime, pickLabel, liveStateHtml, fmtOdds, fmtSpread,
  onBoardForSport, currentBoardDate, teamNickname,
} from './utils.js?v=4';
import { isPaying } from './auth.js';
import { TEAM_COLORS } from './modal.js?v=8';

// Escape everything that reaches innerHTML (team/tournament names are scraped
// third-party text).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Module state ──────────────────────────────────────────────────────────────
let _allGames        = [];          // every /api/games row (today + forward-seeded)
let _golfTournaments = [];
let _selSports       = new Set();   // empty = All
let _openCards       = new Set();   // expanded card ids
let _bells           = new Set();   // per-game alert toggles (in-memory stub)
let _query           = '';
let _cdTimer         = null;        // the ONE countdown interval
let _bound           = false;

const SPORT_CATALOG = ['MLB', 'NBA', 'WNBA', 'NFL', 'NCAAF', 'CBB', 'NHL', 'Soccer', 'Tennis', 'Golf'];
const SOON_MS = 90 * 60 * 1000;

// ── Sport key helpers ─────────────────────────────────────────────────────────
function sportKey(sport) {
  const s = (sport || '').toUpperCase();
  if (s === 'ATP' || s === 'WTA') return 'Tennis';
  return SPORT_CATALOG.find(k => k.toUpperCase() === s) || (sport || 'Other');
}

// A game belongs on today's board when it is live/final, or a pre-game on
// today's board day (tennis gets the shared ~10h lookahead via utils).
function isBoardGame(g) {
  if (g.status === 'in' || g.status === 'post') return true;
  return onBoardForSport(g.start_time, g.sport);
}

function startsInMs(g) {
  const t = new Date(g.start_time).getTime();
  return Number.isNaN(t) ? Infinity : t - Date.now();
}
function isSoon(g) { return g.status === 'pre' && startsInMs(g) <= SOON_MS; }

// ── Data ──────────────────────────────────────────────────────────────────────
async function refreshBoardData() {
  const [games, golf] = await Promise.all([
    fetch('/api/games').then(r => r.json()).catch(() => []),
    fetch('/api/golf/tournaments').then(r => r.json()).catch(() => []),
  ]);
  _allGames        = Array.isArray(games) ? games : [];
  _golfTournaments = Array.isArray(golf)  ? golf  : [];
}

// Ranked picks grouped per game (members get full rows; free rows beyond the
// visible #1 arrive as locked stubs with no game id, so this map is naturally
// empty for them and nothing paid ever renders).
function picksByGame() {
  const map = new Map();
  for (const p of (state.allPicks || [])) {
    if (p.locked || p.score == null || !p.espn_game_id) continue;
    const k = String(p.espn_game_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(p);
  }
  for (const arr of map.values()) arr.sort((a, b) => (b.score || 0) - (a.score || 0));
  return map;
}

function rankedCountBySport() {
  const map = new Map();
  for (const p of (state.allPicks || [])) {
    if (!p.rank) continue;
    const k = sportKey(p.sport);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

// The visible #1 pick (free accounts + members receive it with full fields).
function visibleTopPick() {
  return (state.allPicks || []).find(p => p.rank === 1 && !p.locked && p.score != null && p.espn_game_id) || null;
}

// ── Band gradient (Cinema jacket, darkened for contrast) ─────────────────────
const _BASE = [13, 16, 23], _WHITE = [255, 255, 255];
function _hx(h)        { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function _lum(c)       { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function _mix(a, b, t) { return [Math.round(a[0] * (1 - t) + b[0] * t), Math.round(a[1] * (1 - t) + b[1] * t), Math.round(a[2] * (1 - t) + b[2] * t)]; }
function _rgb(c)       { return `rgb(${c[0]},${c[1]},${c[2]})`; }
function _teamC(hex)   { let c = _hx(hex); if (_lum(c) < 64) c = _mix(c, _WHITE, 0.3); return c; }
function _bandC(hex, t){ return _rgb(_mix(_BASE, _teamC(hex), t)); }

function teamPrimary(name) {
  const c = TEAM_COLORS[name];
  return (c && c[0]) || null;
}

function bandStyle(g) {
  const a = teamPrimary(g.away_team) || '#31435f';
  const h = teamPrimary(g.home_team) || '#233043';
  let ta = 0.42, th = 0.42;
  const live = g.status === 'in', post = g.status === 'post';
  if ((live || post) && typeof g.away_score === 'number' && typeof g.home_score === 'number') {
    if (g.away_score > g.home_score)      { ta = 0.5; th = 0.3; }
    else if (g.home_score > g.away_score) { th = 0.5; ta = 0.3; }
  }
  if (post) { ta *= 0.6; th *= 0.6; }
  const A = _bandC(a, ta), B = _bandC(h, th);
  return `background:linear-gradient(105deg,${A} 0%,${A} 42%,${B} 58%,${B} 100%)`;
}

// Monogram tile: 2-3 letters derived from the name (no abbr columns on /api/games).
function mono(name, sport) {
  const s = (name || '').trim();
  if (!s) return '?';
  const sp = (sport || '').toUpperCase();
  if (sp === 'ATP' || sp === 'WTA') return s.split(/\s+/).pop().slice(0, 3).toUpperCase();
  const w = s.split(/\s+/);
  if (w.length >= 3) return (w[0][0] + w[1][0] + w[2][0]).toUpperCase();
  if (w.length === 2) return (w[0][0] + w[1][0] + (w[1][1] || '')).toUpperCase();
  return s.slice(0, 3).toUpperCase();
}

function displayName(name) {
  return teamNickname(name || '') || name || '?';
}

// ── State cell (band middle) ──────────────────────────────────────────────────
function periodLabel(g) {
  const sp = (g.sport || '').toUpperCase();
  const n  = g.period || '';
  if (sp === 'MLB') return `${n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th'} Inn`;
  if (sp === 'ATP' || sp === 'WTA') return `Set ${n}`;
  if (sp === 'SOCCER') return `${n}H`;
  if (sp === 'CBB') return `H${n}`;
  if (sp === 'NHL') return `P${n}`;
  return `Q${n}`;
}

function fmtCd(ms) {
  if (ms <= 0) return 'Starting';
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function stateCell(g) {
  if (g.status === 'in') {
    const situation = liveStateHtml(g);
    const clock = g.clock && g.clock !== '0:00' ? ` · ${esc(g.clock)}` : '';
    const label = situation || `<span>${esc(periodLabel(g))}${clock}</span>`;
    return `<span class="sbb-state"><i class="sbb-dot"></i>${label}</span>`;
  }
  if (g.status === 'post') return `<span class="sbb-state fin">Final</span>`;
  const t = new Date(g.start_time).getTime();
  if (isSoon(g) && !Number.isNaN(t)) {
    return `<span class="sbb-state pre"><span class="sbb-cd" data-start="${t}">${fmtCd(t - Date.now())}</span><em class="sbb-stmut">${esc(gameTime(g.start_time))}</em></span>`;
  }
  return `<span class="sbb-state pre">${esc(gameTime(g.start_time))}</span>`;
}

// ── Card pieces ───────────────────────────────────────────────────────────────
function chevBtn(g) {
  const open = _openCards.has(String(g.espn_game_id));
  return `<button type="button" class="sbb-chev" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} game details">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.5 5l4.5 4.5L11.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
}

function bandHtml(g) {
  const hasScore = g.status === 'in' || g.status === 'post';
  const aLose = hasScore && (g.away_score ?? 0) < (g.home_score ?? 0) ? ' lose' : '';
  const hLose = hasScore && (g.home_score ?? 0) < (g.away_score ?? 0) ? ' lose' : '';
  const aName = displayName(g.away_team), hName = displayName(g.home_team);
  return `<div class="sbb-band" style="${bandStyle(g)}">
    <div class="sbb-bt"><span class="sbb-lg">${esc(mono(g.away_team, g.sport))}</span><span class="sbb-bn">${esc(aName)}</span></div>
    ${hasScore ? `<span class="sbb-bs${aLose}">${g.away_score ?? 0}</span>` : ''}
    <div class="sbb-bmid"><span class="sbb-bsport">${esc((g.sport || '').toUpperCase())}</span>${stateCell(g)}</div>
    ${hasScore ? `<span class="sbb-bs${hLose}">${g.home_score ?? 0}</span>` : ''}
    <div class="sbb-bt h"><span class="sbb-lg">${esc(mono(g.home_team, g.sport))}</span><span class="sbb-bn">${esc(hName)}</span></div>
    ${chevBtn(g)}
  </div>`;
}

function hasLines(g) {
  return g.ml_home != null || g.ml_away != null || g.spread_home != null || g.over_under != null;
}

function linesStrip(g) {
  if (!hasLines(g)) {
    if (g.status !== 'pre') return '';
    return `<div class="sbb-lines quiet">Lines post closer to start</div>`;
  }
  const hm = mono(g.home_team, g.sport), am = mono(g.away_team, g.sport);
  const parts = [];
  if (g.spread_home != null) parts.push(`<span><em>SPR</em>${esc(hm)} ${esc(fmtSpread(g.spread_home))}</span>`);
  if (g.over_under != null)  parts.push(`<span><em>TOT</em>${esc(String(g.over_under))}</span>`);
  if (g.ml_home != null || g.ml_away != null) {
    const homeFav = (g.ml_home != null) && (g.ml_away == null || g.ml_home <= g.ml_away);
    const favMono = homeFav ? hm : am;
    const favMl   = homeFav ? g.ml_home : g.ml_away;
    parts.push(`<span><em>ML</em>${esc(favMono)} ${esc(fmtOdds(favMl))}</span>`);
  }
  return `<div class="sbb-lines">${parts.join('')}</div>`;
}

// ── CA element: member cluster / free lock chip ──────────────────────────────
const LK_C = `<svg class="sbb-lkC" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><rect x="1.6" y="4.6" width="7.8" height="5.4" rx="1.2" fill="#FFD700"/><path d="M3.3 4.6V3.2a2.2 2.2 0 0 1 4.4 0v1.4" fill="none" stroke="#FFD700" stroke-width="1.4"/></svg>`;
const LK_O = `<svg class="sbb-lkO" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><rect x="1.6" y="4.6" width="7.8" height="5.4" rx="1.2" fill="#FFD700"/><path d="M3.3 4.6V2.7a2.2 2.2 0 0 1 4.4 0v.7" fill="none" stroke="#FFD700" stroke-width="1.4" transform="rotate(24 3.3 4.6)"/></svg>`;

// Stable blurred placeholder digits hashed off the game id (same pattern as the
// home tiles: a placeholder, never the real score, which never ships to free).
function lockedDigits(g) {
  const key = String(g.espn_game_id || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return (Math.abs(h) % 99) + 1;
}

function lockChipHtml(g) {
  return `<button type="button" class="sbb-lockchip" title="Unlock with full access" aria-label="Unlock with full access">
    <img src="/ca-logo.png" alt="CA" onerror="this.style.display='none'">
    <span class="sbb-lockwrap"><span class="sbb-lockdg">${lockedDigits(g)}</span>${LK_C}${LK_O}</span></button>`;
}

function bubbleSize(score) {
  const d = 8 + ((score || 0) - 10) * 0.2;
  return Math.max(8, Math.min(30, Math.round(d * 10) / 10));
}

function clusterHtml(gamePicks) {
  const goldAt   = state.CONFIG?.mvp_display_threshold ?? 100;
  const silverAt = state.CONFIG?.mvp_threshold ?? 75;
  const picks = gamePicks.slice(0, 5);
  let h = `<button type="button" class="sbb-cluster" aria-label="Scored picks on this game, highest first">`;
  picks.forEach((p, i) => {
    const d = bubbleSize(p.score);
    const tier = p.score >= goldAt ? 'g' : p.score >= silverAt ? 's' : 'm';
    const res = (p.result || '').toLowerCase();
    const ring = res === 'win' ? ' rw' : res === 'loss' ? ' rl' : '';
    const fs = d >= 24 ? 10 : d >= 17 ? 9 : 8;
    const num = (i < 3 && d >= 12) ? `<span>${p.score}</span>` : '';
    h += `<span class="sbb-bubb ${tier}${ring}" style="width:${d}px;height:${d}px;font-size:${fs}px" title="${esc(pickLabel(p))} · CA ${p.score}">${num}</span>`;
  });
  return h + `</button>`;
}

function caElement(g, ctx) {
  if (!isBoardGame(g)) return '';                     // future days carry no CA presence
  if (ctx.member) {
    const picks = ctx.byGame.get(String(g.espn_game_id));
    return picks && picks.length ? clusterHtml(picks) : '';
  }
  // Free view: the #1 pick's game is revealed; other games in sports that hold
  // ranked picks today get the lock chip.
  const tp = ctx.top;
  if (tp && String(tp.espn_game_id) === String(g.espn_game_id)) {
    return `<button type="button" class="sbb-cac gold" title="${esc(pickLabel(tp))}">CA ${tp.score} · ${esc(pickLabel(tp))} · #1</button>`;
  }
  if ((ctx.rankedBySport.get(sportKey(g.sport)) || 0) > 0) return lockChipHtml(g);
  return '';
}

function chipRow(g, ctx) {
  const ca = caElement(g, ctx);
  if (!ca) return '';
  return `<div class="sbb-chips">${ca}</div>`;
}

// ── Expansion (two columns: markets left, context right) ─────────────────────
function xpHtml(g, ctx) {
  const hm = mono(g.home_team, g.sport), am = mono(g.away_team, g.sport);
  let left = '';
  if (hasLines(g)) {
    if (g.spread_home != null || g.spread_away != null) {
      left += `<div class="sbb-mcell"><b>SPREAD</b><span>${esc(am)} ${esc(fmtSpread(g.spread_away))} / ${esc(hm)} ${esc(fmtSpread(g.spread_home))}</span></div>`;
    }
    if (g.over_under != null) {
      left += `<div class="sbb-mcell"><b>TOTAL</b><span>O ${esc(String(g.over_under))} ${esc(fmtOdds(g.ou_over_odds))} / U ${esc(String(g.over_under))} ${esc(fmtOdds(g.ou_under_odds))}</span></div>`;
    }
    if (g.ml_home != null || g.ml_away != null) {
      left += `<div class="sbb-mcell"><b>ML</b><span>${esc(am)} ${esc(fmtOdds(g.ml_away))} / ${esc(hm)} ${esc(fmtOdds(g.ml_home))}</span></div>`;
    }
  } else {
    left += `<div class="sbb-xrow">Lines post closer to start</div>`;
  }

  const sp = (g.sport || '').toUpperCase();
  const joiner = (sp === 'ATP' || sp === 'WTA') ? 'vs' : 'at';
  let right = `<div class="sbb-xrow"><b>${esc(displayName(g.away_team))}</b>&nbsp;${joiner}&nbsp;<b>${esc(displayName(g.home_team))}</b></div>`;
  if (g.status === 'pre')       right += `<div class="sbb-xrow">Starts ${esc(gameTime(g.start_time))} ET</div>`;
  else if (g.status === 'in')   right += `<div class="sbb-xrow">Live now, ${esc(String(g.away_score ?? 0))}-${esc(String(g.home_score ?? 0))}</div>`;
  else                          right += `<div class="sbb-xrow">Final, ${esc(String(g.away_score ?? 0))}-${esc(String(g.home_score ?? 0))}</div>`;
  if (ctx.member) {
    const n = (ctx.byGame.get(String(g.espn_game_id)) || []).length;
    if (n) right += `<div class="sbb-xrow"><b>${n}</b>&nbsp;ranked ${n === 1 ? 'pick' : 'picks'} on this game</div>`;
  }

  const id = esc(String(g.espn_game_id));
  const bellOn = _bells.has(String(g.espn_game_id));
  let exits = `<div class="sbb-exits">`;
  exits += `<button type="button" class="sbb-xbtn" data-act="details" data-id="${id}">Details</button>`;
  if (g.status !== 'post') exits += `<button type="button" class="sbb-xbtn pri" data-act="track" data-id="${id}">Track</button>`;
  exits += `<button type="button" class="sbb-xbtn sbb-bell${bellOn ? ' on' : ''}" data-act="bell" data-id="${id}" aria-pressed="${bellOn}" aria-label="Game alerts for this matchup">
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path class="bfill" d="M12 3a6 6 0 0 0-6 6v3.6L4.4 16.6h15.2L18 12.6V9a6 6 0 0 0-6-6z"/><path class="bfill" d="M10 19.5a2 2 0 0 0 4 0"/></svg></button>`;
  exits += `</div>`;

  return `<div class="sbb-xp"><div><div class="sbb-xpin"><div class="sbb-cols"><div>${left}</div><div>${right}</div></div>${exits}</div></div></div>`;
}

function cardHtml(g, ctx, dayTag) {
  const id = String(g.espn_game_id);
  const open = _openCards.has(id);
  let h = `<div class="sbb-card${open ? ' open' : ''}${g.status === 'post' ? ' fin' : ''}" data-id="${esc(id)}">`;
  if (dayTag) h += `<div class="sbb-dtag">${esc(dayTag)}</div>`;
  h += bandHtml(g);
  h += linesStrip(g);
  h += chipRow(g, ctx);
  h += xpHtml(g, ctx);
  return h + `</div>`;
}

// Golf: green tournament card (no markets, no CA element; golf picks live in
// their own table and are not part of the ranked board payload).
function golfCardHtml(t) {
  let stateBit;
  if (t.status === 'in') {
    stateBit = `<span class="sbb-state"><i class="sbb-dot"></i>Round ${esc(String(t.current_round || '?'))} live</span>`;
  } else {
    const d = t.start_date ? new Date(t.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Upcoming';
    stateBit = `<span class="sbb-state pre">${esc(d)}</span>`;
  }
  const sub = [t.course, t.city].filter(Boolean).join(' · ');
  return `<div class="sbb-card sbb-golfcard" data-tid="${esc(String(t.espn_tournament_id))}">
    <div class="sbb-band golf" style="background:linear-gradient(105deg,${_bandC('#14532D', 0.55)},${_bandC('#1F7A46', 0.38)})">
      <div class="sbb-gt"><div class="sbb-gtn">${esc(t.name || 'Tournament')}</div>${sub ? `<div class="sbb-gts">${esc(sub)}</div>` : ''}</div>
      ${stateBit}
    </div>
  </div>`;
}

// ── Vitals / bubbles / ledger ─────────────────────────────────────────────────
function boardGames() { return _allGames.filter(isBoardGame); }

function sportStats() {
  const stats = new Map();
  const ensure = (k) => {
    if (!stats.has(k)) stats.set(k, { key: k, games: 0, live: 0, ranked: 0 });
    return stats.get(k);
  };
  SPORT_CATALOG.forEach(ensure);
  for (const g of boardGames()) {
    const s = ensure(sportKey(g.sport));
    s.games++;
    if (g.status === 'in') s.live++;
  }
  const golf = ensure('Golf');
  golf.games += _golfTournaments.length;
  golf.live  += _golfTournaments.filter(t => t.status === 'in').length;
  for (const [k, n] of rankedCountBySport()) ensure(k).ranked += n;
  return [...stats.values()];
}

function sortedSports() {
  const activity = s => s.live * 3 + s.ranked * 2 + s.games;
  return sportStats().sort((a, b) => {
    const az = a.games === 0, bz = b.games === 0;
    if (az !== bz) return az ? 1 : -1;            // zero-game sports last, still selectable
    const d = activity(b) - activity(a);
    if (d) return d;
    if (b.games !== a.games) return b.games - a.games;
    return a.key < b.key ? -1 : 1;
  });
}

function renderVitals() {
  const el = document.getElementById('sbb-vitals');
  if (!el) return;
  const games = boardGames();
  const liveCt = games.filter(g => g.status === 'in').length + _golfTournaments.filter(t => t.status === 'in').length;
  const rankedCt = (state.allPicks || []).filter(p => p.rank).length;
  const dateLabel = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
  el.innerHTML =
    `<span class="sbb-vdate">${esc(dateLabel)}</span>` +
    `<span class="sbb-v"><b>Games</b><span>${games.length + _golfTournaments.length}</span></span>` +
    `<span class="sbb-v"><b>Live</b><span class="lv">${liveCt}</span></span>` +
    `<span class="sbb-v"><b>Ranked</b><span>${rankedCt}</span></span>` +
    `<span class="sbb-vsp"></span>` +
    `<button type="button" class="sbb-fullrecord sbb-vrec">Full record &rsaquo;</button>`;
}

function renderBubbles() {
  const el = document.getElementById('sbb-bubs');
  if (!el) return;
  el.classList.toggle('dim', _query.length >= 2);
  const total = boardGames().length + _golfTournaments.length;
  let h = `<button type="button" class="sbb-bub${_selSports.size === 0 ? ' on' : ''}" data-sport="__all" aria-pressed="${_selSports.size === 0}">All <span class="ct">${total}</span></button>`;
  for (const s of sortedSports()) {
    const on = _selSports.has(s.key);
    h += `<button type="button" class="sbb-bub${on ? ' on' : ''}" data-sport="${esc(s.key)}" aria-pressed="${on}">` +
         `${s.live > 0 ? '<span class="ldot"></span>' : ''}${esc(s.key)} <span class="ct">${s.games}</span></button>`;
  }
  el.innerHTML = h;
}

function _yesterdayBoardDate() {
  const d = new Date(currentBoardDate() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function renderLedger() {
  const el = document.getElementById('sbb-ledger');
  if (!el) return;
  let lead = 'Every ranked pick is graded and archived, wins and losses alike.';
  try {
    const y = _yesterdayBoardDate();
    const settled = (state.homeMvpPicks || []).filter(p =>
      String(p.game_date || '').slice(0, 10) === y &&
      ['win', 'loss', 'push'].includes(String(p.result || '').toLowerCase()));
    if (settled.length) {
      const w = settled.filter(p => p.result === 'win').length;
      const l = settled.filter(p => p.result === 'loss').length;
      const push = settled.length - w - l;
      const rec = `${w}-${l}${push ? `-${push}` : ''}`;
      lead = `Yesterday: <b>${rec}</b> across ${settled.length} settled ${settled.length === 1 ? 'pick' : 'picks'}.`;
    }
  } catch (_) {}
  el.innerHTML = `<span>${lead}</span><button type="button" class="sbb-fullrecord">Full record &rsaquo;</button>`;
}

// ── Sections ──────────────────────────────────────────────────────────────────
function renderCtx() {
  return {
    member: isPaying(),
    byGame: picksByGame(),
    rankedBySport: rankedCountBySport(),
    top: visibleTopPick(),
  };
}

function sectionHtml(title, cards, note) {
  if (!cards.length) return '';
  return `<div class="sbb-eye">${title} <span class="r"></span> <em>${cards.length}</em>${note ? `<span class="nt">&nbsp;&middot; ${note}</span>` : ''}</div>` +
         `<div class="sbb-grid">${cards.join('')}</div>`;
}

function renderSections() {
  const host = document.getElementById('sbb-sections');
  if (!host) return;
  if (_query.length >= 2) { renderSearchResults(host); return; }

  const ctx = renderCtx();
  const byStart = (a, b) => String(a.start_time || '').localeCompare(String(b.start_time || ''));
  const games = boardGames().filter(g => _selSports.size === 0 || _selSports.has(sportKey(g.sport)));
  const golfOn = _selSports.size === 0 || _selSports.has('Golf');
  const golf = golfOn ? _golfTournaments : [];

  let h = '';
  // Friendly empty notes for selected zero-game sports.
  for (const s of sortedSports()) {
    if (_selSports.has(s.key) && s.games === 0) {
      h += `<div class="sbb-notice"><b>No ${esc(s.key)} games today.</b> They show here the moment a slate posts.</div>`;
    }
  }

  const live = games.filter(g => g.status === 'in').sort(byStart)
    .map(g => cardHtml(g, ctx))
    .concat(golf.filter(t => t.status === 'in').map(golfCardHtml));
  const pre  = games.filter(g => g.status === 'pre');
  const soon = pre.filter(isSoon).sort(byStart).map(g => cardHtml(g, ctx));
  const up   = pre.filter(g => !isSoon(g)).sort(byStart)
    .map(g => cardHtml(g, ctx))
    .concat(golf.filter(t => t.status !== 'in').map(golfCardHtml));
  const fin  = games.filter(g => g.status === 'post').sort(byStart).map(g => cardHtml(g, ctx));

  h += sectionHtml('Live', live);
  h += sectionHtml('Starting soon', soon, 'within 90 min');
  h += sectionHtml('Upcoming', up, 'soonest first');
  h += sectionHtml('Final', fin);

  if (!live.length && !soon.length && !up.length && !fin.length && h.indexOf('sbb-notice') < 0) {
    h += `<div class="sbb-notice">Nothing on the board for this filter.</div>`;
  }
  host.innerHTML = h;
}

// ── Cross-day search ──────────────────────────────────────────────────────────
function _etDate(d) { return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }

function dayTagFor(iso) {
  if (!iso) return '';
  const d = _etDate(iso);
  if (d === _etDate(Date.now())) return 'Today';
  if (d === _etDate(Date.now() + 86400000)) return 'Tomorrow';
  return new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
}

function gameMatches(g, q) {
  const hay = [g.sport, sportKey(g.sport), g.away_team, g.home_team,
    mono(g.away_team, g.sport), mono(g.home_team, g.sport)].join(' ').toLowerCase();
  return hay.indexOf(q) >= 0;
}

function renderSearchResults(host) {
  const q = _query.toLowerCase();
  const ctx = renderCtx();
  const res = _allGames.filter(g => gameMatches(g, q))
    .sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));
  const golfRes = _golfTournaments.filter(t => `golf ${t.name || ''} ${t.course || ''}`.toLowerCase().indexOf(q) >= 0);

  if (!res.length && !golfRes.length) {
    host.innerHTML = `<div class="sbb-notice">Nothing matches that. Try a team, player, or sport.</div>`;
    return;
  }
  const cards = res.map(g => cardHtml(g, ctx, dayTagFor(g.start_time)))
    .concat(golfRes.map(golfCardHtml));
  host.innerHTML =
    `<div class="sbb-eye">Search results <span class="r"></span> <em>${cards.length}</em></div>` +
    `<div class="sbb-grid">${cards.join('')}</div>`;
}

// ── Countdown ticker (the single interval) ────────────────────────────────────
function ensureTicker() {
  if (_cdTimer) return;
  _cdTimer = setInterval(() => {
    const els = document.querySelectorAll('#sbb-sections .sbb-cd');
    if (!els.length) return;
    for (const el of els) {
      const t = parseInt(el.dataset.start, 10) - Date.now();
      el.textContent = fmtCd(t);
    }
  }, 1000);
}

// ── Events (bound once, delegated) ────────────────────────────────────────────
function bindEvents() {
  if (_bound) return;
  _bound = true;
  const panel = document.getElementById('panel-sports');
  if (!panel) return;

  panel.addEventListener('click', (e) => {
    // Sport bubbles: additive multi-select; toggling the last one off re-arms All.
    const bub = e.target.closest('.sbb-bub');
    if (bub) {
      const key = bub.dataset.sport;
      if (key === '__all') _selSports.clear();
      else if (_selSports.has(key)) _selSports.delete(key);
      else _selSports.add(key);
      renderBubbles();
      renderSections();
      return;
    }

    const rec = e.target.closest('.sbb-fullrecord');
    if (rec) { if (window.switchTab) window.switchTab('mvp'); return; }

    const chev = e.target.closest('.sbb-chev');
    if (chev) {
      e.stopPropagation();
      const card = chev.closest('.sbb-card');
      if (!card) return;
      const id = card.dataset.id;
      const nowOpen = !_openCards.has(id);
      if (nowOpen) _openCards.add(id); else _openCards.delete(id);
      card.classList.toggle('open', nowOpen);
      chev.setAttribute('aria-expanded', String(nowOpen));
      chev.setAttribute('aria-label', `${nowOpen ? 'Collapse' : 'Expand'} game details`);
      return;
    }

    const lock = e.target.closest('.sbb-lockchip');
    if (lock) {
      e.stopPropagation();
      if (window.switchTab) window.switchTab('unlock');
      return;
    }

    const bell = e.target.closest('[data-act="bell"]');
    if (bell) {
      e.stopPropagation();
      const id = bell.dataset.id;
      const on = !_bells.has(id);
      if (on) _bells.add(id); else _bells.delete(id);
      bell.classList.toggle('on', on);
      bell.setAttribute('aria-pressed', String(on));
      return;
    }

    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      const id = act.dataset.id;
      if (act.dataset.act === 'details' && window.openGameModal) window.openGameModal(id);
      if (act.dataset.act === 'track' && window.openTrackForSlot) window.openTrackForSlot(id, 'none');
      return;
    }

    const cluster = e.target.closest('.sbb-cluster, .sbb-cac');
    if (cluster) {
      e.stopPropagation();
      const card = cluster.closest('.sbb-card');
      if (card && window.openGameModal) window.openGameModal(card.dataset.id);
      return;
    }

    const golfCard = e.target.closest('.sbb-golfcard');
    if (golfCard) {
      if (window.openGolfModal) window.openGolfModal(golfCard.dataset.tid);
      return;
    }

    if (e.target.closest('.sbb-xp')) return;   // the expansion body itself never navigates

    const card = e.target.closest('.sbb-card');
    if (card && window.openGameModal) window.openGameModal(card.dataset.id);
  });

  // Search: live filter across all days; Escape / X restores the board.
  const input = document.getElementById('sbb-search-input');
  const clear = document.getElementById('sbb-search-x');
  const clearSearch = () => {
    if (input) input.value = '';
    _query = '';
    if (clear) clear.classList.remove('show');
    renderBubbles();
    renderSections();
  };
  if (input) {
    input.addEventListener('input', () => {
      _query = input.value.trim();
      if (clear) clear.classList.toggle('show', _query.length > 0);
      renderBubbles();
      renderSections();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { clearSearch(); input.blur(); }
    });
  }
  if (clear) clear.addEventListener('click', clearSearch);
}

// ── Public API (names unchanged for app.js and window callers) ───────────────
function renderAll() {
  renderVitals();
  renderBubbles();
  renderSections();
  renderLedger();
}

export async function loadSports() {
  bindEvents();
  const host = document.getElementById('sbb-sections');
  if (host && !host.innerHTML.trim()) {
    host.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;
  }
  await refreshBoardData();
  renderAll();
  ensureTicker();
}

// Programmatic sport preselect (deep links / legacy callers).
export function setSport(sport) {
  if (window.posthog) {
    try { posthog.capture('sport_viewed', { sport }); } catch (e) {}
  }
  state.activeSport = sport;
  const key = sportKey(sport);
  _selSports = new Set(key ? [key] : []);
  renderBubbles();
  renderSections();
}

// Legacy export names kept so older callers keep working; both re-render the board.
export function renderSportPicks() { renderSections(); }
export async function loadSchedule() { renderSections(); }

// Ride the existing refresh cadence (loadPicks fires picksUpdated every 5 min,
// plus 30s while a game is live): re-pull the board only while the tab is
// actually on screen. No new polling loop of our own.
document.addEventListener('picksUpdated', async () => {
  if (!state.sportsLoaded) return;
  const panel = document.getElementById('panel-sports');
  if (!panel || !panel.classList.contains('active') || document.hidden) return;
  await refreshBoardData();
  renderAll();
});

Object.assign(window, { setSport });
