// modules/sports.js — Sports tab: the Network Two broadcast board.
//
// RENDER LAYER IS A LITERAL PORT of docs/mockups/broadcast/mock3_network2.html
// (the r3 final Jack approved). Every mock class carries an nx- prefix; the DOM
// shapes mirror the mock's renderVitals / renderBubbles / renderDays / bandHtml /
// linesStrip / chipRow / caChip / clusterChip / lockChip / xpHtml / cardHtml /
// section / renderLedger builders. Mock features with no live data yet (public
// betting chip, tracked-bet avatar strip, move notes) are omitted, never faked.
//
// Data discipline: one /api/games + /api/golf/tournaments fetch per refresh,
// plus at most ONE /api/golf/:id fetch for the active tournament's leaderboard.
// state.allPicks (already polled by app.js) and state.CONFIG are reused. No new
// endpoints, no per-card fetches, exactly one countdown interval.

import { state } from './state.js';
import {
  gameTime, pickLabel, fmtOdds, fmtSpread,
  onBoardForSport, currentBoardDate, teamNickname,
} from './utils.js?v=5';
import { isPaying } from './auth.js';
import { TEAM_COLORS } from './modal.js?v=8';

// Escape everything that reaches innerHTML (team/tournament/player names are
// scraped third-party text).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Module state ──────────────────────────────────────────────────────────────
let _allGames        = [];          // every /api/games row (today + forward-seeded)
let _golfTournaments = [];
let _golfLb          = new Map();   // tournament id -> top-3 leaderboard rows
let _selSports       = new Set();   // empty = All
let _openCards       = new Set();   // expanded card ids
let _bells           = new Set();   // per-game alert toggles (in-memory stub)
let _query           = '';
let _curDay          = 0;           // day rail: 0 = Today .. 3
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

  // One golf-detail fetch per refresh: the active tournament's top-3 leaderboard.
  _golfLb = new Map();
  const act = _golfTournaments.find(t => t.status === 'in') || _golfTournaments[0];
  if (act) {
    try {
      const d = await fetch(`/api/golf/${act.espn_tournament_id}`).then(r => (r.ok ? r.json() : null));
      const lb = JSON.parse(d?.tournament?.leaderboard_json || '[]') || [];
      const top3 = lb.slice(0, 3).map(p => ({
        pos: p.position ?? '', name: p.player?.fullName || '', score: p.score ?? '',
      })).filter(p => p.name);
      if (top3.length) _golfLb.set(String(act.espn_tournament_id), top3);
    } catch (_) {}
  }
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

function renderCtx() {
  return {
    member: isPaying(),
    byGame: picksByGame(),
    rankedBySport: rankedCountBySport(),
    top: visibleTopPick(),
  };
}

// ── Band gradient helpers (mock: Cinema jacket, darkened for AA) ─────────────
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

// Short live text for the band state cell (the mock's liveShort).
function liveShortText(g) {
  const sp = (g.sport || '').toUpperCase();
  const detail = g.live_detail;
  if (detail && (sp === 'MLB' || sp === 'NFL' || sp === 'NCAAF')) return detail;
  const clock = g.clock && g.clock !== '0:00' ? ` ${g.clock}` : '';
  const p = g.period ? `${periodLabel(g)}${clock}` : '';
  return p || 'Live';
}

function finalLabel(g) {
  const sp = (g.sport || '').toUpperCase();
  if (sp === 'SOCCER' && (g.away_score ?? 0) === (g.home_score ?? 0)) return 'FT · Draw';
  return 'Final';
}

function fmtCd(ms) {
  if (ms <= 0) return 'Starting';
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// Mock stateHtml: live dot + short text; soon = amber countdown + muted start;
// pre = start time; post = final label.
function stateHtml(g) {
  if (g.status === 'in') {
    return `<span class="nx-state"><i class="nx-dot"></i>${esc(liveShortText(g))}</span>`;
  }
  if (g.status === 'pre') {
    const t = new Date(g.start_time).getTime();
    if (isSoon(g) && !Number.isNaN(t)) {
      return `<span class="nx-state pre n"><span class="nx-cdw nx-cd" data-dl="${t}">${fmtCd(t - Date.now())}</span><i class="nx-stmut n">${esc(gameTime(g.start_time))} ET</i></span>`;
    }
    return `<span class="nx-state pre n">${esc(gameTime(g.start_time))} ET</span>`;
  }
  return `<span class="nx-state fin">${esc(finalLabel(g))}</span>`;
}

// ── Card pieces (mock DOM shapes) ─────────────────────────────────────────────
function bandTeam(g, side) {
  const name = side === 'home' ? g.home_team : g.away_team;
  return `<div class="nx-bt ${side === 'home' ? 'h' : 'a'}">` +
    `<span class="nx-lg">${esc(mono(name, g.sport))}</span>` +
    `<span class="nx-bn">${esc(displayName(name))}</span></div>`;
}

function chevBtn(g) {
  const open = _openCards.has(String(g.espn_game_id));
  return `<button type="button" class="nx-chev" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} game details">` +
    `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.5 5l4.5 4.5L11.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
}

function bandHtml(g) {
  const hasScore = g.status === 'in' || g.status === 'post';
  const aLose = hasScore && (g.away_score ?? 0) < (g.home_score ?? 0) ? ' lose' : '';
  const hLose = hasScore && (g.home_score ?? 0) < (g.away_score ?? 0) ? ' lose' : '';
  const mid = `<div class="nx-bmid"><span class="nx-bsport">${esc((g.sport || '').toUpperCase())}</span>${stateHtml(g)}</div>`;
  return `<div class="nx-band" style="${bandStyle(g)}">` +
    bandTeam(g, 'away') +
    (hasScore ? `<span class="nx-bs n${aLose}">${g.away_score ?? 0}</span>` : '') +
    mid +
    (hasScore ? `<span class="nx-bs n${hLose}">${g.home_score ?? 0}</span>` : '') +
    bandTeam(g, 'home') + chevBtn(g) + `</div>`;
}

function hasLines(g) {
  return g.ml_home != null || g.ml_away != null || g.spread_home != null || g.over_under != null;
}

// Mock linesStrip: SPR / TOT / ML shorts, plus the Graded tag on settled games.
function linesStrip(g) {
  if (!hasLines(g)) {
    if (g.status === 'pre') return `<div class="nx-lines quiet">Lines post closer to start</div>`;
    return '';
  }
  const hm = mono(g.home_team, g.sport), am = mono(g.away_team, g.sport);
  const spans = [];
  if (g.spread_home != null || g.spread_away != null) {
    const homeFav = g.spread_home != null && g.spread_home <= 0;
    const side = homeFav ? `${hm} ${fmtSpread(g.spread_home)}` : `${am} ${fmtSpread(g.spread_away)}`;
    spans.push(`<span><em>SPR</em>${esc(side)}</span>`);
  }
  if (g.over_under != null) spans.push(`<span><em>TOT</em>O ${esc(String(g.over_under))}</span>`);
  if (g.ml_home != null || g.ml_away != null) {
    const fav = (g.ml_home != null && (g.ml_away == null || g.ml_home <= g.ml_away)) ? g.ml_home : g.ml_away;
    spans.push(`<span><em>ML</em>${esc(fmtOdds(fav))}</span>`);
  }
  const end = g.status === 'post' ? `<span class="nx-ltag gr">Graded</span>` : '';
  return `<div class="nx-lines n">${spans.join('')}${end}</div>`;
}

// ── CA element (mock caChip): member cluster / free gold #1 / free lock chip ──
const LK_C = `<svg class="nx-lkC" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><rect x="1.6" y="4.6" width="7.8" height="5.4" rx="1.2" fill="#FFD700"/><path d="M3.3 4.6V3.2a2.2 2.2 0 0 1 4.4 0v1.4" fill="none" stroke="#FFD700" stroke-width="1.4"/></svg>`;
const LK_O = `<svg class="nx-lkO" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><rect x="1.6" y="4.6" width="7.8" height="5.4" rx="1.2" fill="#FFD700"/><path d="M3.3 4.6V2.7a2.2 2.2 0 0 1 4.4 0v.7" fill="none" stroke="#FFD700" stroke-width="1.4" transform="rotate(24 3.3 4.6)"/></svg>`;

// Stable blurred placeholder digits hashed off the game id (mock: 60 + id % 40;
// a placeholder, never the real score, which never ships to free sessions).
function lockedDigits(g) {
  const key = String(g.espn_game_id || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return 60 + (Math.abs(h) % 40);
}

function lockChip(g) {
  return `<button type="button" class="nx-lockchip n" title="Unlock with full access" aria-label="Unlock with full access">` +
    `<img src="/ca-logo.png" alt="CappingAlpha" onerror="this.style.display='none'">` +
    `<span class="nx-lockwrap"><span class="nx-dg">${lockedDigits(g)}</span>${LK_C}${LK_O}</span></button>`;
}

// Mock bubbSize: d = 8 + (score - 10) * 0.2, clamp 8..30.
function bubbSize(s) {
  const d = 8 + ((s || 0) - 10) * 0.2;
  return Math.max(8, Math.min(30, Math.round(d * 10) / 10));
}

function clusterChip(gamePicks) {
  const goldAt   = state.CONFIG?.mvp_display_threshold ?? 100;
  const silverAt = state.CONFIG?.mvp_threshold ?? 75;
  const picks = gamePicks.slice(0, 5);
  let h = `<button type="button" class="nx-cluster" aria-label="Scored picks for this game, highest first">`;
  picks.forEach((p, i) => {
    const d = bubbSize(p.score);
    const cls = p.score >= goldAt ? 'g' : p.score >= silverAt ? 's' : 'm';
    const res = (p.result || '').toLowerCase();
    const ring = res === 'win' ? ' rw' : res === 'loss' ? ' rl' : '';
    h += `<span class="nx-bubb ${cls}${ring}" style="width:${d}px;height:${d}px;font-size:${d >= 24 ? 10 : d >= 17 ? 9 : 8}px" title="${esc(pickLabel(p))} · CA ${p.score}">` +
         (i < 3 && d >= 12 ? `<span class="n">${p.score}</span>` : '') + `</span>`;
  });
  return h + `</button>`;
}

function caChip(g, ctx) {
  if (!isBoardGame(g)) return '';                    // future days carry no CA presence
  if (ctx.member) {
    const picks = ctx.byGame.get(String(g.espn_game_id));
    return picks && picks.length ? clusterChip(picks) : '';
  }
  // Free view: only the #1 pick is revealed; other games in sports that hold
  // ranked picks today get the locked chip (sport-level granularity: locked
  // rows ship without game ids, by server privacy design).
  const tp = ctx.top;
  if (tp && String(tp.espn_game_id) === String(g.espn_game_id)) {
    return `<button type="button" class="nx-cac gold n"><span class="nx-txt">CA ${tp.score} · ${esc(pickLabel(tp))} · #1</span></button>`;
  }
  if ((ctx.rankedBySport.get(sportKey(g.sport)) || 0) > 0) return lockChip(g);
  return '';
}

// Mock chipRow: pub chip + avatar strip + CA chip. Public betting and tracked-bet
// avatars have no board-payload data yet, so only the CA element renders; an
// empty row renders nothing (no invented counts).
function chipRow(g, ctx) {
  const h = caChip(g, ctx);
  if (!h) return '';
  return `<div class="nx-chips">${h}</div>`;
}

// ── Expansion (mock xpHtml: mcell markets left, xrow context right, exits) ───
function xpHtml(g, ctx) {
  const hm = mono(g.home_team, g.sport), am = mono(g.away_team, g.sport);
  let left = '';
  if (hasLines(g)) {
    if (g.spread_home != null || g.spread_away != null) {
      left += `<div class="nx-mcell n"><b>SPREAD</b><span>${esc(am)} ${esc(fmtSpread(g.spread_away))} / ${esc(hm)} ${esc(fmtSpread(g.spread_home))}</span></div>`;
    }
    if (g.over_under != null) {
      left += `<div class="nx-mcell n"><b>TOTAL</b><span>O ${esc(String(g.over_under))} ${esc(fmtOdds(g.ou_over_odds))} / U ${esc(String(g.over_under))} ${esc(fmtOdds(g.ou_under_odds))}</span></div>`;
    }
    if (g.ml_home != null || g.ml_away != null) {
      left += `<div class="nx-mcell n"><b>ML</b><span>${esc(am)} ${esc(fmtOdds(g.ml_away))} / ${esc(hm)} ${esc(fmtOdds(g.ml_home))}</span></div>`;
    }
  } else {
    left += `<div class="nx-xrow">Lines post closer to start</div>`;
  }

  const sp = (g.sport || '').toUpperCase();
  const joiner = (sp === 'ATP' || sp === 'WTA') ? 'vs' : 'at';
  let right = `<div class="nx-xrow"><b>${esc(displayName(g.away_team))}</b>&nbsp;${joiner}&nbsp;<b>${esc(displayName(g.home_team))}</b></div>`;
  if (g.status === 'pre')     right += `<div class="nx-xrow">Starts ${esc(gameTime(g.start_time))} ET</div>`;
  else if (g.status === 'in') right += `<div class="nx-xrow">Live now, ${esc(String(g.away_score ?? 0))}-${esc(String(g.home_score ?? 0))}</div>`;
  else                        right += `<div class="nx-xrow">Final, ${esc(String(g.away_score ?? 0))}-${esc(String(g.home_score ?? 0))}</div>`;
  if (ctx.member) {
    const cnt = (ctx.byGame.get(String(g.espn_game_id)) || []).length;
    if (cnt) right += `<div class="nx-xrow"><b class="n">${cnt}</b>&nbsp;ranked ${cnt === 1 ? 'pick' : 'picks'} on this game</div>`;
  }

  const id = esc(String(g.espn_game_id));
  const bellOn = _bells.has(String(g.espn_game_id));
  let exits = `<div class="nx-exits">`;
  exits += `<button type="button" class="nx-xbtn" data-act="details" data-id="${id}">Details</button>`;
  if (g.status !== 'post' && hasLines(g)) exits += `<button type="button" class="nx-xbtn pri" data-act="track" data-id="${id}">Track</button>`;
  exits += `<button type="button" class="nx-xbtn nx-bell${bellOn ? ' on' : ''}" data-act="bell" data-id="${id}" aria-pressed="${bellOn}" aria-label="Toggle game alerts for this matchup">` +
    `<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path class="bfill" d="M12 3a6 6 0 0 0-6 6v3.6L4.4 16.6h15.2L18 12.6V9a6 6 0 0 0-6-6z"/><path class="bfill" d="M10 19.5a2 2 0 0 0 4 0"/></svg></button>`;
  exits += `</div>`;

  return `<div class="nx-xp"><div><div class="nx-xpin"><div class="nx-cols"><div>${left}</div><div>${right}</div></div>${exits}</div></div></div>`;
}

function cardHtml(g, ctx, dayTag) {
  const id = String(g.espn_game_id);
  let h = `<div class="nx-card${_openCards.has(id) ? ' open' : ''}" data-id="${esc(id)}"${g.status === 'post' ? ' style="opacity:.93"' : ''}>`;
  if (dayTag) h += `<div class="nx-dtag">${esc(dayTag)}</div>`;
  h += bandHtml(g);
  h += linesStrip(g);
  h += chipRow(g, ctx);
  h += xpHtml(g, ctx);
  return h + `</div>`;
}

// Golf: mock band.golf + top-3 leaderboard rows. Golf picks live in their own
// table (not the ranked board payload), so no CA element here.
function golfCardHtml(t) {
  const id = String(t.espn_tournament_id);
  const rl = t.status === 'in'
    ? `<span class="nx-rl"><i class="nx-dot"></i>Round ${esc(String(t.current_round || '?'))} live</span>`
    : `<span class="nx-rl">${esc(t.start_date ? new Date(t.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Upcoming')}</span>`;
  let h = `<div class="nx-card nx-golfcard" data-tid="${esc(id)}">` +
    `<div class="nx-band golf" style="background:linear-gradient(105deg,${_bandC('#14532D', 0.55)},${_bandC('#1F7A46', 0.38)})">` +
    `<div class="nx-gt"><div class="nx-tn">${esc(t.name || 'Tournament')}</div>${rl}</div></div>`;
  for (const l of (_golfLb.get(id) || [])) {
    h += `<div class="nx-lb"><span class="nx-p">${esc(String(l.pos))}</span><span class="nx-nn">${esc(l.name)}</span><span class="nx-s n">${esc(String(l.score))}</span></div>`;
  }
  return h + `</div>`;
}

// ── Vitals / bubbles / day rail / ledger ─────────────────────────────────────
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

// Mock ordering: activity = live*3 + ranked*2 + games; zero-game sports last.
function sortedSports() {
  const activity = s => s.live * 3 + s.ranked * 2 + s.games;
  return sportStats().sort((a, b) => {
    const az = a.games === 0, bz = b.games === 0;
    if (az !== bz) return az ? 1 : -1;
    const d = activity(b) - activity(a);
    if (d) return d;
    if (b.games !== a.games) return b.games - a.games;
    return a.key < b.key ? -1 : 1;
  });
}

// Board-day stats from the tracked record the home widget already loads.
// Flat 1u math: win +1, loss -1, pushes 0.
function _settledUnits(rows) {
  const w = rows.filter(p => String(p.result || '').toLowerCase() === 'win').length;
  const l = rows.filter(p => String(p.result || '').toLowerCase() === 'loss').length;
  return { w, l, units: w - l };
}
function _rowsOn(datePrefix) {
  return (state.homeMvpPicks || []).filter(p => String(p.game_date || '').slice(0, datePrefix.length) === datePrefix);
}
function _settledOf(rows) {
  return rows.filter(p => ['win', 'loss', 'push'].includes(String(p.result || '').toLowerCase()));
}
function fmtU(u) { return `${u > 0 ? '+' : ''}${u.toFixed(1)}u`; }
function unitsHtml(u) {
  if (u >= 0) return `<span class="nx-u n">${fmtU(u)}</span>`;
  return `<span class="n" style="color:var(--red);font-weight:800">${fmtU(u)}</span>`;
}

// Mock renderVitals: date, Games, Live (sky), Tracked, spacer, caline button.
function renderVitals() {
  const el = document.getElementById('nx-vitals');
  if (!el) return;
  const games = boardGames();
  const liveCt = games.filter(g => g.status === 'in').length + _golfTournaments.filter(t => t.status === 'in').length;
  const total = games.length + _golfTournaments.length;
  const dateLabel = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
  const todayRows = _rowsOn(currentBoardDate());
  const settled = _settledOf(todayRows).filter(p => String(p.result).toLowerCase() !== 'push');
  const caline = settled.length
    ? `Board today <b class="n">${fmtU(_settledUnits(settled).units)}</b> settled, ${todayRows.length} tracked &rsaquo;`
    : `Full record &rsaquo;`;
  el.innerHTML =
    `<span class="nx-vdate">${esc(dateLabel)}</span>` +
    `<span class="nx-v"><b>Games</b><span class="n">${total}</span></span>` +
    `<span class="nx-v"><b>Live</b><span class="n" style="color:var(--nx-live)">${liveCt}</span></span>` +
    `<span class="nx-v"><b>Tracked</b><span class="n">${todayRows.length}</span></span>` +
    `<span class="nx-vsp"></span>` +
    `<button type="button" class="nx-caline n" data-nav="mvp">${caline}</button>`;
}

function renderBubbles() {
  const el = document.getElementById('nx-bubs');
  if (!el) return;
  el.classList.toggle('dim', searchActive());
  const total = boardGames().length + _golfTournaments.length;
  let h = `<button type="button" class="nx-bub${_selSports.size === 0 ? ' on' : ''}" data-sport="__all" aria-pressed="${_selSports.size === 0}">All <span class="nx-ct n">${total}</span></button>`;
  for (const s of sortedSports()) {
    const on = _selSports.has(s.key);
    h += `<button type="button" class="nx-bub${on ? ' on' : ''}" data-sport="${esc(s.key)}" aria-pressed="${on}">` +
         `${s.live > 0 ? '<span class="nx-ldot"></span>' : ''}${esc(s.key)} <span class="nx-ct n">${s.games}</span></button>`;
  }
  el.innerHTML = h;
}

// Mock renderDays: Today + next 3 days. Only today's data is loaded, so future
// days carry no count and render the posts-in-the-morning note when selected.
function renderDays() {
  const el = document.getElementById('nx-days');
  if (!el) return;
  el.classList.toggle('dim', searchActive());
  let h = '';
  for (let i = 0; i < 4; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const label = i === 0 ? 'Today' : d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    const sub = i === 0
      ? d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')
      : d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
    const ct = i === 0 ? `<span class="nx-ct n">${boardGames().length + _golfTournaments.length}</span>` : '';
    const on = i === _curDay;
    h += `<button type="button" class="nx-day${on ? ' on' : ''}" data-day="${i}" aria-pressed="${on}">` +
         `<span class="nx-dl">${esc(label)}${ct}</span><span class="nx-ds">${esc(sub)}</span></button>`;
  }
  el.innerHTML = h;
}

function _yesterdayBoardDate() {
  const d = new Date(currentBoardDate() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Mock renderLedger: yesterday record/units/bets + this month + the one-hour
// line sentence + the Full record link.
function renderLedger() {
  const el = document.getElementById('nx-ledger');
  if (!el) return;
  let parts = '';
  try {
    const ySettled = _settledOf(_rowsOn(_yesterdayBoardDate()));
    if (ySettled.length) {
      const { w, l, units } = _settledUnits(ySettled);
      parts += `Yesterday: <b class="n">${w}-${l}</b>, ${unitsHtml(units)} across <b class="n">${ySettled.length}</b> tracked bets. `;
    }
    const mSettled = _settledOf(_rowsOn(currentBoardDate().slice(0, 7)));
    if (mSettled.length) {
      const { w, l, units } = _settledUnits(mSettled);
      parts += `This month: <b class="n">${w}-${l}</b>, ${unitsHtml(units)}. `;
    }
  } catch (_) {}
  el.innerHTML = `${parts}Every tracked pick is graded at the line locked one hour before start.` +
    `<a href="#" id="nx-ledger-link">Full record &rsaquo;</a>`;
}

// ── Sections (mock section() eyebrow pattern) ─────────────────────────────────
function searchActive() { return _query.length >= 2; }

function sectionHtml(title, cards, extraNote) {
  if (!cards.length) return '';
  return `<div class="nx-eye">${title} <span class="nx-r"></span> <em class="n">${cards.length}</em> game${cards.length === 1 ? '' : 's'}${extraNote ? ', ' + extraNote : ''}</div>` +
         `<div class="nx-grid">${cards.join('')}</div>`;
}

function renderSections() {
  const host = document.getElementById('nx-sections');
  if (!host) return;
  const bubs = document.getElementById('nx-bubs');
  const days = document.getElementById('nx-days');
  if (bubs) bubs.classList.toggle('dim', searchActive());
  if (days) days.classList.toggle('dim', searchActive());
  if (searchActive()) { renderSearch(host); return; }

  if (_curDay !== 0) {
    host.innerHTML = `<div class="nx-postnote">The board for each day posts in the morning.</div>`;
    return;
  }

  const ctx = renderCtx();
  const byStart = (a, b) => String(a.start_time || '').localeCompare(String(b.start_time || ''));
  const games = boardGames().filter(g => _selSports.size === 0 || _selSports.has(sportKey(g.sport)));
  const golfOn = _selSports.size === 0 || _selSports.has('Golf');
  const golf = golfOn ? _golfTournaments : [];

  let h = '';
  // Friendly empty notices for selected zero-game sports (mock pattern).
  for (const s of sortedSports()) {
    if (_selSports.has(s.key) && s.games === 0) {
      h += `<div class="nx-notice"><b>No ${esc(s.key)} games today.</b> The next slate posts here.</div>`;
    }
  }

  const live = games.filter(g => g.status === 'in').sort(byStart).map(g => cardHtml(g, ctx))
    .concat(golf.filter(t => t.status === 'in').map(golfCardHtml));
  const pre  = games.filter(g => g.status === 'pre');
  const soon = pre.filter(isSoon).sort(byStart).map(g => cardHtml(g, ctx));
  const up   = pre.filter(g => !isSoon(g)).sort(byStart).map(g => cardHtml(g, ctx))
    .concat(golf.filter(t => t.status !== 'in').map(golfCardHtml));
  const fin  = games.filter(g => g.status === 'post').sort(byStart).map(g => cardHtml(g, ctx));

  h += sectionHtml('Live', live);
  h += sectionHtml('Starting soon', soon, 'within 90 min');
  h += sectionHtml('Upcoming', up, 'soonest first');
  h += sectionHtml('Final', fin);

  if (!live.length && !soon.length && !up.length && !fin.length && h.indexOf('nx-notice') < 0) {
    h += `<div class="nx-notice">Nothing on the board for this filter.</div>`;
  }
  host.innerHTML = h;
}

// ── Cross-day search (mock renderSearch: dtag day labels) ─────────────────────
function _etDate(d) { return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }

function dayTagFor(iso) {
  if (!iso) return '';
  const d = _etDate(iso);
  if (d === _etDate(Date.now())) return 'Today';
  if (d === _etDate(Date.now() + 86400000)) return 'Tomorrow';
  return new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
}

function gameMatches(g, q) {
  const hay = [g.sport, sportKey(g.sport), g.away_team, g.home_team,
    mono(g.away_team, g.sport), mono(g.home_team, g.sport)].join(' ').toLowerCase();
  return hay.indexOf(q) >= 0;
}

function renderSearch(host) {
  const q = _query.toLowerCase();
  const ctx = renderCtx();
  const res = _allGames.filter(g => gameMatches(g, q))
    .sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));
  const golfRes = _golfTournaments.filter(t => `golf ${t.name || ''} ${t.course || ''}`.toLowerCase().indexOf(q) >= 0);

  if (!res.length && !golfRes.length) {
    host.innerHTML = `<div class="nx-notice">Nothing matches that. Try a team, player, or sport.</div>`;
    return;
  }
  const cards = res.map(g => cardHtml(g, ctx, dayTagFor(g.start_time))).concat(golfRes.map(golfCardHtml));
  host.innerHTML =
    `<div class="nx-eye">Search results <span class="nx-r"></span> <em class="n">${cards.length}</em> game${cards.length === 1 ? '' : 's'}</div>` +
    `<div class="nx-grid">${cards.join('')}</div>`;
}

// ── Countdown ticker (the single interval; mock's shared .cd ticker) ─────────
function ensureTicker() {
  if (_cdTimer) return;
  _cdTimer = setInterval(() => {
    const els = document.querySelectorAll('#nx-sections .nx-cd');
    for (const el of els) {
      el.textContent = fmtCd(parseInt(el.dataset.dl, 10) - Date.now());
    }
  }, 1000);
}

// ── Events (bound once, delegated; mock stopPropagation discipline) ──────────
function bindEvents() {
  if (_bound) return;
  _bound = true;
  const panel = document.getElementById('panel-sports');
  if (!panel) return;

  panel.addEventListener('click', (e) => {
    // Sport bubbles: additive multi-select; toggling the last one off re-arms All.
    const bub = e.target.closest('.nx-bub');
    if (bub) {
      const key = bub.dataset.sport;
      if (key === '__all') _selSports.clear();
      else if (_selSports.has(key)) _selSports.delete(key);
      else _selSports.add(key);
      renderBubbles();
      renderSections();
      return;
    }

    // Day rail.
    const day = e.target.closest('.nx-day');
    if (day) {
      _curDay = parseInt(day.dataset.day, 10) || 0;
      renderDays();
      renderSections();
      return;
    }

    // Vitals caline + ledger link land on the Rankings tab.
    if (e.target.closest('.nx-caline')) { if (window.switchTab) window.switchTab('mvp'); return; }
    const lg = e.target.closest('#nx-ledger-link');
    if (lg) { e.preventDefault(); if (window.switchTab) window.switchTab('mvp'); return; }

    const chev = e.target.closest('.nx-chev');
    if (chev) {
      e.stopPropagation();
      const card = chev.closest('.nx-card');
      if (!card) return;
      const id = card.dataset.id;
      const nowOpen = !_openCards.has(id);
      if (nowOpen) _openCards.add(id); else _openCards.delete(id);
      card.classList.toggle('open', nowOpen);
      chev.setAttribute('aria-expanded', String(nowOpen));
      chev.setAttribute('aria-label', `${nowOpen ? 'Collapse' : 'Expand'} game details`);
      return;
    }

    const lock = e.target.closest('.nx-lockchip');
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

    // Cluster / revealed CA chip: game page, same as the card body (mock behavior).
    const cl = e.target.closest('.nx-cluster, .nx-cac');
    if (cl) {
      e.stopPropagation();
      const card = cl.closest('.nx-card');
      if (card && card.dataset.id) window.location.href = `/game/${card.dataset.id}`;
      return;
    }

    const golfCard = e.target.closest('.nx-golfcard');
    if (golfCard) {
      if (window.openGolfModal) window.openGolfModal(golfCard.dataset.tid);
      return;
    }

    if (e.target.closest('.nx-xp')) return;   // the expansion body itself never navigates

    const card = e.target.closest('.nx-card');
    if (card && card.dataset.id) window.location.href = `/game/${card.dataset.id}`;
  });

  // Search: icon-expanding pill; Escape / X restores the board exactly.
  const wrap  = document.getElementById('nx-search-wrap');
  const input = document.getElementById('nx-search-input');
  const btn   = document.getElementById('nx-search-btn');
  const x     = document.getElementById('nx-search-x');
  const clearSearch = () => {
    if (input) input.value = '';
    _query = '';
    if (wrap) wrap.classList.remove('open');
    renderBubbles();
    renderDays();
    renderSections();
  };
  if (btn) btn.addEventListener('click', () => {
    if (wrap) wrap.classList.add('open');
    if (input) input.focus();
  });
  if (input) {
    input.addEventListener('input', () => {
      _query = input.value.trim();
      renderBubbles();
      renderDays();
      renderSections();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { clearSearch(); input.blur(); }
    });
  }
  if (x) x.addEventListener('click', clearSearch);
}

// ── Public API (names unchanged for app.js and window callers) ───────────────
function renderAll() {
  renderVitals();
  renderBubbles();
  renderDays();
  renderSections();
  renderLedger();
}

export async function loadSports() {
  bindEvents();
  const host = document.getElementById('nx-sections');
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
  _curDay = 0;
  const key = sportKey(sport);
  _selSports = new Set(key ? [key] : []);
  renderBubbles();
  renderDays();
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
