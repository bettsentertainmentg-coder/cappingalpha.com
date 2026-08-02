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
  onBoardForSport, currentBoardDate, teamNickname, countryColor,
  SPORT_THEMES,
} from './utils.js?v=7';
import { isPaying } from './auth.js';
import { TEAM_COLORS } from './modal.js?v=12';

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

function _chromaHex(hex) { const c = _hx(hex); return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]); }
function teamPrimary(name) {
  const c = TEAM_COLORS[name];
  if (!c || !c[0]) return null;
  // Black/grey-primary teams (Steelers, Pirates) banded as lifted-grey "no
  // color at all" (Jack 2026-07-28) — the livelier of primary/secondary
  // carries the band instead, so Steelers band gold, Pirates band gold.
  const p = c[0], s = c[1];
  if (s && _chromaHex(s) > _chromaHex(p) + 20) return s;
  return p;
}

// Band accents for flags whose primary maps to a dark navy that reads as grey
// on the dark card (USA, GBR, AUS...): the flag's red carries the band instead.
// Gauges elsewhere keep the shared COUNTRY_COLORS navy.
const BAND_COUNTRY_ACCENT = {
  usa: '#B22234', gbr: '#C8102E', aus: '#E4002B', nzl: '#CC142B', new: '#CC142B',
  kor: '#CD2E3A', tha: '#A51931', isr: '#2E5FDF', tpe: '#FE0000', cze: '#D7141A',
};
function tennisBandPair(g) {
  const cc = (code) => { const k = (code || '').toLowerCase(); return BAND_COUNTRY_ACCENT[k] || countryColor(code); };
  let away = cc(g.away_country), home = cc(g.home_country);
  if (!away && !home) return null;
  away = away || '#8b5cf6';
  home = home || '#3b82f6';
  // Same-country matchups (two Americans) banded one flat color: pull the home
  // side toward white so the band still reads as two sides.
  const xa = _hx(away), xh = _hx(home);
  if (Math.hypot(xa[0] - xh[0], xa[1] - xh[1], xa[2] - xh[2]) < 110) {
    const c = _mix(xh, _WHITE, 0.45);
    home = `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  }
  return { away, home };
}

function bandStyle(g) {
  // Tennis players have no TEAM_COLORS entry, so every match banded the same two
  // defaults. Country colors (home/away_country ride /api/games) feed the exact
  // same gradient instead, so no two matchups read alike (2026-07-28).
  const sp = (g.sport || '').toUpperCase();
  const tennis = sp === 'ATP' || sp === 'WTA';
  const pair = tennis ? tennisBandPair(g) : null;
  const a = teamPrimary(g.away_team) || (pair ? pair.away : null) || '#31435f';
  const h = teamPrimary(g.home_team) || (pair ? pair.home : null) || '#233043';
  let ta = tennis ? 0.52 : 0.42, th = tennis ? 0.52 : 0.42;
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

// The abbreviation a sports panel would show. ESPN already ships it on the row
// (CIN, PIT), so prefer it over initials derived from the full name, which turn
// "Cincinnati Bengals" into CBE. Tennis is the exception: ESPN's tennis abbr is
// the first three letters of the FIRST name, where the surname reads far better,
// so those keep the derived form.
function abbrOf(g, side) {
  const sp = (g.sport || '').toUpperCase();
  const name = side === 'home' ? g.home_team : g.away_team;
  if (sp === 'ATP' || sp === 'WTA') return mono(name, g.sport);
  const a = side === 'home' ? g.home_abbr : g.away_abbr;
  const t = a == null ? '' : String(a).trim();
  return t ? t.toUpperCase() : mono(name, g.sport);
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
// Tile content: tennis shows the player's face (photo -> country flag -> the
// monogram letters) inside the same 28px tile; team sports keep the monogram.
// Photos/flags ride /api/games (home/away_photo, home/away_flag).
function tileInner(g, side, name) {
  const sp = (g.sport || '').toUpperCase();
  if (sp === 'ATP' || sp === 'WTA') {
    const photo = g[side + '_photo'], flag = g[side + '_flag'];
    const letters = mono(name, g.sport); // alnum only, safe inside the handler
    const toLetters = `this.onerror=null;var p=this.parentNode;this.remove();if(p)p.textContent='${letters}';`;
    if (photo) {
      const fall = flag ? `this.onerror=null;this.src='${esc(flag)}';` : toLetters;
      return `<img class="nx-lgi" src="${esc(photo)}" alt="" loading="lazy" onerror="${fall}">`;
    }
    if (flag) return `<img class="nx-lgi" src="${esc(flag)}" alt="" loading="lazy" onerror="${toLetters}">`;
  }
  return esc(abbrOf(g, side));
}

function bandTeam(g, side) {
  const name = side === 'home' ? g.home_team : g.away_team;
  return `<div class="nx-bt ${side === 'home' ? 'h' : 'a'}">` +
    `<span class="nx-lg">${tileInner(g, side, name)}</span>` +
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
  // Sport identity chip: the tiny grey text was unreadable on the All tab
  // (Jack 2026-07-28) — the site-wide sport gradient carries it instead.
  const theme = SPORT_THEMES[g.sport] || SPORT_THEMES[(g.sport || '').toUpperCase()];
  const spLabel = (theme && theme.label) || (g.sport || '').toUpperCase();
  const spChip = theme
    ? `<span class="nx-bsport chip" style="background:${theme.grad}">${esc(spLabel)}</span>`
    : `<span class="nx-bsport">${esc((g.sport || '').toUpperCase())}</span>`;
  // The mid is absolutely centered on the card (not flexed between the sides),
  // so the sport chip sits at the same x on every card in the column (Jack:
  // "the icon jumps around left and right"). Sides are wrapped so left and
  // right clusters hug their edges.
  const mid = `<div class="nx-bmid">${spChip}${stateHtml(g)}</div>`;
  return `<div class="nx-band" style="${bandStyle(g)}">` +
    `<div class="nx-bside a">` + bandTeam(g, 'away') +
    (hasScore ? `<span class="nx-bs n${aLose}">${g.away_score ?? 0}</span>` : '') + `</div>` +
    mid +
    `<div class="nx-bside h">` +
    (hasScore ? `<span class="nx-bs n${hLose}">${g.home_score ?? 0}</span>` : '') +
    bandTeam(g, 'home') + `</div>` + chevBtn(g) + `</div>`;
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
  const hm = abbrOf(g, 'home'), am = abbrOf(g, 'away');
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

// ── Public betting element (fills the chips row's empty left side) ────────────
// /api/games ships per game (absent when no data): `pub` (tickets + money %
// per market), `votes` (CA member vote counts per slot), `open` (opening lines).
// Display chain: public betting -> CA community lean -> line movement -> the
// price-implied read, so a game with lines is never blank.
const PPL_ICON = `<svg class="nx-pubi" width="11" height="11" viewBox="0 0 640 512" aria-hidden="true"><path fill="currentColor" d="M96 128a96 96 0 1 1 192 0A96 96 0 1 1 96 128zM0 482.3C0 383.8 79.8 304 178.3 304h27.4c98.5 0 178.3 79.8 178.3 178.3 0 16.4-13.3 29.7-29.7 29.7H29.7C13.3 512 0 498.7 0 482.3zM609.3 512H471.4c5.4-9.4 8.6-20.3 8.6-32v-8c0-60.7-27.1-115.2-69.8-151.8 2.4-.1 4.7-.2 7.1-.2h61.4C567.8 320 640 392.2 640 481.3c0 17-13.8 30.7-30.7 30.7zM432 256c-31 0-59-12.6-79.3-32.9C372.4 196.5 384 163.6 384 128c0-26.8-6.6-52.1-18.3-74.3C384.3 40.1 407.2 32 432 32c61.9 0 112 50.1 112 112s-50.1 112-112 112z"/></svg>`;
const TREND_ICON = `<svg class="nx-pubi" width="11" height="11" viewBox="0 0 512 512" aria-hidden="true"><path fill="currentColor" d="M384 160c-17.7 0-32-14.3-32-32s14.3-32 32-32H480c17.7 0 32 14.3 32 32V224c0 17.7-14.3 32-32 32s-32-14.3-32-32V205.3L342.6 310.6c-12.5 12.5-32.8 12.5-45.3 0L192 205.3 54.6 342.6c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3l160-160c12.5-12.5 32.8-12.5 45.3 0L320 242.7 402.7 160H384z"/></svg>`;

// De-vigged implied probability of the ticket-lead side, from the moneyline.
function _impliedPct(g, homeLed) {
  const toP = (ml) => ml == null ? null : (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));
  const ph = toP(g.ml_home), pa = toP(g.ml_away);
  if (ph == null || pa == null || ph + pa <= 0) return null;
  return Math.round(100 * (homeLed ? ph : pa) / (ph + pa));
}

function _pair(a, h) { return a != null && h != null && a + h >= 90 && a + h <= 110; }

// All displayable markets for a game, scored by how SURPRISING the lean is.
// Spread and total are priced ~50/50, so raw skew counts fully; a moneyline
// lean only counts for how far it runs ABOVE the price-implied probability
// (everyone betting the -400 favorite is not a story). Jack's rule: a 65%
// spread should outrank a 95% ML.
function pubMarkets(g) {
  const p = g.pub;
  if (!p) return [];
  const am = abbrOf(g, 'away'), hm = abbrOf(g, 'home');
  const out = [];
  const push = (tag, a, h, aM, hM, sideA, sideH, score) => {
    if (!_pair(a, h)) return;
    const homeLed = h >= a;
    const side = homeLed ? sideH : sideA;
    const pct = Math.max(a, h);
    const hasM = aM != null && hM != null;
    const moneySamePct = hasM ? (homeLed ? hM : aM) : null;
    const moneySide = hasM ? (hM >= aM ? sideH : sideA) : null;
    const moneySidePct = hasM ? Math.max(aM, hM) : null;
    // Split: the money clearly leans the other way (55+), or runs 12+ points
    // hotter on the same side. A 50/50 money read is not a lean.
    const split = hasM && ((moneySide !== side && moneySidePct >= 55) || (moneySide === side && moneySamePct - pct >= 12));
    out.push({ tag, side, pct, away: a, home: h, awayM: aM, homeM: hM, hasM,
               moneySamePct, moneySide, moneySidePct, split, homeLed,
               score: score(pct, homeLed) });
  };
  push('SPR', p.away_spread, p.home_spread, p.away_spread_money, p.home_spread_money, am, hm,
       (pct) => pct - 50);
  push('O/U', p.over, p.under, p.over_money, p.under_money, 'Ov', 'Un',
       (pct) => (pct - 50) * 0.8);
  push('ML', p.away_ml, p.home_ml, p.away_ml_money, p.home_ml_money, am, hm,
       (pct, homeLed) => {
         const imp = _impliedPct(g, homeLed);
         return imp != null ? Math.max(0, pct - imp) : (pct - 50) * 0.4;
       });
  // Splits are the story regardless of size: float any split market, then by surprise.
  out.sort((x, y) => (y.split - x.split) || (y.score - x.score));
  return out;
}

// ── Public betting element: the Rope Line ────────────────────────────────────
// The crowd's split drawn as a tug of war. Ice-cyan pulls from the away end,
// ember-orange from the home end, and the knot sits exactly where the tickets
// fall. The centre chip carries a crowd icon plus the bet as a bettor reads it
// ("-1.5", "O 8.5", "Win"), never a market code. When the dollars disagree with
// the tickets the rope between the knot and the money caret turns into a
// hatched tension zone in the money side's colour.
// Four states, chosen by p2State: split (dollars disagree, the loudest signal)
// > two (a second market) > money (dollars agree, kept quiet) > base.
const ROPE_STATES = {
  base: "<div class=\"nx-r\" style=\"--nx-r-k:{{AWAY_PCT}}\">\n  <div class=\"nx-r-head\">\n    <span class=\"nx-r-end nx-r-away\"><span class=\"nx-r-pct\">{{AWAY_PCT}}<i>%</i></span><span class=\"nx-r-abbr\">{{AWAY_ABBR}}</span></span>\n    <span class=\"nx-r-chip\">\n      <svg class=\"nx-r-crowd\" viewBox=\"0 0 16 11\" aria-hidden=\"true\"><g class=\"nx-r-back\" fill=\"currentColor\"><circle cx=\"3.4\" cy=\"3.9\" r=\"1.85\"/><path d=\"M0.8 10.6a2.6 2.6 0 0 1 5.2 0z\"/><circle cx=\"12.6\" cy=\"3.9\" r=\"1.85\"/><path d=\"M10 10.6a2.6 2.6 0 0 1 5.2 0z\"/></g><g fill=\"currentColor\" stroke=\"#1b2231\" stroke-width=\".8\" paint-order=\"stroke\"><circle cx=\"8\" cy=\"3.2\" r=\"2.4\"/><path d=\"M4.6 10.6a3.4 3.4 0 0 1 6.8 0z\"/></g></svg>\n      <span class=\"nx-r-mkt\">{{MARKET_LABEL}}</span>\n    </span>\n    <span class=\"nx-r-end nx-r-home\"><span class=\"nx-r-pct\">{{HOME_PCT}}<i>%</i></span><span class=\"nx-r-abbr\">{{HOME_ABBR}}</span></span>\n  </div>\n  <div class=\"nx-r-ropewrap\" aria-hidden=\"true\"><div class=\"nx-r-rope\">\n    <span class=\"nx-r-track\"><i class=\"nx-r-fill nx-r-fill-a\"></i><i class=\"nx-r-fill nx-r-fill-h\"></i></span>\n    <i class=\"nx-r-knot\"></i>\n  </div></div>\n</div>",
  money: "<!-- money agrees with the tickets. add nx-r--money-home when {{MONEY_SIDE}} is the home side -->\n<div class=\"nx-r nx-r--money nx-r--money-home\" style=\"--nx-r-k:{{AWAY_PCT}};--nx-r-m:{{MONEY_PCT}}\">\n  <div class=\"nx-r-head\">\n    <span class=\"nx-r-end nx-r-away\"><span class=\"nx-r-pct\">{{AWAY_PCT}}<i>%</i></span><span class=\"nx-r-abbr\">{{AWAY_ABBR}}</span></span>\n    <span class=\"nx-r-chip\">\n      <svg class=\"nx-r-crowd\" viewBox=\"0 0 16 11\" aria-hidden=\"true\"><g class=\"nx-r-back\" fill=\"currentColor\"><circle cx=\"3.4\" cy=\"3.9\" r=\"1.85\"/><path d=\"M0.8 10.6a2.6 2.6 0 0 1 5.2 0z\"/><circle cx=\"12.6\" cy=\"3.9\" r=\"1.85\"/><path d=\"M10 10.6a2.6 2.6 0 0 1 5.2 0z\"/></g><g fill=\"currentColor\" stroke=\"#1b2231\" stroke-width=\".8\" paint-order=\"stroke\"><circle cx=\"8\" cy=\"3.2\" r=\"2.4\"/><path d=\"M4.6 10.6a3.4 3.4 0 0 1 6.8 0z\"/></g></svg>\n      <span class=\"nx-r-mkt\">{{MARKET_LABEL}}</span>\n    </span>\n    <span class=\"nx-r-end nx-r-home\"><span class=\"nx-r-pct\">{{HOME_PCT}}<i>%</i></span><span class=\"nx-r-abbr\">{{HOME_ABBR}}</span></span>\n  </div>\n  <div class=\"nx-r-ropewrap\" aria-hidden=\"true\"><div class=\"nx-r-rope\">\n    <span class=\"nx-r-track\"><i class=\"nx-r-fill nx-r-fill-a\"></i><i class=\"nx-r-fill nx-r-fill-h\"></i></span>\n    <i class=\"nx-r-knot\"></i><i class=\"nx-r-caret\"></i>\n  </div></div>\n  <div class=\"nx-r-moneyrow\">\n    <svg class=\"nx-r-pull\" viewBox=\"0 0 12 8\" aria-hidden=\"true\"><path d=\"M7.4.9 4.1 4l3.3 3.1M11.4.9 8.1 4l3.3 3.1\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>\n    <span class=\"nx-r-money\"><span class=\"nx-r-cur\">$</span><span class=\"nx-r-pct\">{{MONEY_PCT}}<i>%</i></span><span class=\"nx-r-abbr\">{{MONEY_SIDE}}</span></span>\n    <span class=\"nx-r-tag\">with the crowd</span>\n  </div>\n</div>",
  split: "<!-- dollars lean the other way. add nx-r--money-home when {{MONEY_SIDE}} is the home side -->\n<div class=\"nx-r nx-r--money nx-r--split\" style=\"--nx-r-k:{{AWAY_PCT}};--nx-r-m:{{MONEY_PCT}}\">\n  <div class=\"nx-r-head\">\n    <span class=\"nx-r-end nx-r-away\"><span class=\"nx-r-pct\">{{AWAY_PCT}}<i>%</i></span><span class=\"nx-r-abbr\">{{AWAY_ABBR}}</span></span>\n    <span class=\"nx-r-chip\">\n      <svg class=\"nx-r-crowd\" viewBox=\"0 0 16 11\" aria-hidden=\"true\"><g class=\"nx-r-back\" fill=\"currentColor\"><circle cx=\"3.4\" cy=\"3.9\" r=\"1.85\"/><path d=\"M0.8 10.6a2.6 2.6 0 0 1 5.2 0z\"/><circle cx=\"12.6\" cy=\"3.9\" r=\"1.85\"/><path d=\"M10 10.6a2.6 2.6 0 0 1 5.2 0z\"/></g><g fill=\"currentColor\" stroke=\"#1b2231\" stroke-width=\".8\" paint-order=\"stroke\"><circle cx=\"8\" cy=\"3.2\" r=\"2.4\"/><path d=\"M4.6 10.6a3.4 3.4 0 0 1 6.8 0z\"/></g></svg>\n      <span class=\"nx-r-mkt\">{{MARKET_LABEL}}</span>\n    </span>\n    <span class=\"nx-r-end nx-r-home\"><span class=\"nx-r-pct\">{{HOME_PCT}}<i>%</i></span><span class=\"nx-r-abbr\">{{HOME_ABBR}}</span></span>\n  </div>\n  <div class=\"nx-r-ropewrap\" aria-hidden=\"true\"><div class=\"nx-r-rope\">\n    <span class=\"nx-r-track\"><i class=\"nx-r-fill nx-r-fill-a\"></i><i class=\"nx-r-fill nx-r-fill-h\"></i></span>\n    <i class=\"nx-r-tension\"></i><i class=\"nx-r-knot\"></i><i class=\"nx-r-caret\"></i>\n  </div></div>\n  <div class=\"nx-r-moneyrow\">\n    <svg class=\"nx-r-pull\" viewBox=\"0 0 12 8\" aria-hidden=\"true\"><path d=\"M7.4.9 4.1 4l3.3 3.1M11.4.9 8.1 4l3.3 3.1\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>\n    <span class=\"nx-r-money\"><span class=\"nx-r-cur\">$</span><span class=\"nx-r-pct\">{{MONEY_PCT}}<i>%</i></span><span class=\"nx-r-abbr\">{{MONEY_SIDE}}</span></span>\n    <span class=\"nx-r-tag\">against the crowd</span>\n  </div>\n</div>",
  two: "<div class=\"nx-r nx-r--two\" style=\"--nx-r-k:{{AWAY_PCT}}\">\n  <div class=\"nx-r-head\">\n    <span class=\"nx-r-end nx-r-away\"><span class=\"nx-r-pct\">{{AWAY_PCT}}<i>%</i></span><span class=\"nx-r-abbr\">{{AWAY_ABBR}}</span></span>\n    <span class=\"nx-r-chip\">\n      <svg class=\"nx-r-crowd\" viewBox=\"0 0 16 11\" aria-hidden=\"true\"><g class=\"nx-r-back\" fill=\"currentColor\"><circle cx=\"3.4\" cy=\"3.9\" r=\"1.85\"/><path d=\"M0.8 10.6a2.6 2.6 0 0 1 5.2 0z\"/><circle cx=\"12.6\" cy=\"3.9\" r=\"1.85\"/><path d=\"M10 10.6a2.6 2.6 0 0 1 5.2 0z\"/></g><g fill=\"currentColor\" stroke=\"#1b2231\" stroke-width=\".8\" paint-order=\"stroke\"><circle cx=\"8\" cy=\"3.2\" r=\"2.4\"/><path d=\"M4.6 10.6a3.4 3.4 0 0 1 6.8 0z\"/></g></svg>\n      <span class=\"nx-r-mkt\">{{MARKET_LABEL}}</span>\n    </span>\n    <span class=\"nx-r-end nx-r-home\"><span class=\"nx-r-pct\">{{HOME_PCT}}<i>%</i></span><span class=\"nx-r-abbr\">{{HOME_ABBR}}</span></span>\n  </div>\n  <div class=\"nx-r-ropewrap\" aria-hidden=\"true\"><div class=\"nx-r-rope\">\n    <span class=\"nx-r-track\"><i class=\"nx-r-fill nx-r-fill-a\"></i><i class=\"nx-r-fill nx-r-fill-h\"></i></span>\n    <i class=\"nx-r-knot\"></i>\n  </div></div>\n  <div class=\"nx-r-second\" style=\"--nx-r-s2:{{SECOND_PCT}}\">\n    <span class=\"nx-r-s2chip\">{{SECOND_LABEL}}</span>\n    <span class=\"nx-r-s2val\"><span class=\"nx-r-pct\">{{SECOND_PCT}}<i>%</i></span><span class=\"nx-r-abbr\">{{SECOND_SIDE}}</span></span>\n    <span class=\"nx-r-s2bar\" aria-hidden=\"true\"><i></i><u></u><b></b></span>\n  </div>\n</div>",
};

// ── Full public betting panel (the card dropdown) ────────────────────────────
// Every market, both sides, a blue bar for the share of bets over a gold bar
// for the share of dollars. Comparing the two bar lengths is the whole point:
// a gold bar running past its blue one is money betting bigger than the crowd.
const PANEL_HEAD = "<section class=\"nx-dd-panel\">\n\n  <header class=\"nx-dd-head\">\n    <span class=\"nx-dd-title\">\n      <svg class=\"nx-dd-ico\" viewBox=\"0 0 16 16\" aria-hidden=\"true\">\n        <rect class=\"nx-dd-ico-b\" x=\"1\" y=\"4\" width=\"9\" height=\"2.6\" rx=\"1.3\"/>\n        <rect class=\"nx-dd-ico-m\" x=\"1\" y=\"9.4\" width=\"14\" height=\"2.6\" rx=\"1.3\"/>\n      </svg>\n      Public betting\n    </span>\n    <span class=\"nx-dd-key\">\n      <span class=\"nx-dd-keyitem\"><svg class=\"nx-dd-sw\" viewBox=\"0 0 14 5\" aria-hidden=\"true\"><rect class=\"nx-dd-sw-b\" width=\"14\" height=\"5\" rx=\"2.5\"/></svg># bets</span>\n      <span class=\"nx-dd-keyitem\"><svg class=\"nx-dd-sw\" viewBox=\"0 0 14 5\" aria-hidden=\"true\"><rect class=\"nx-dd-sw-m\" width=\"14\" height=\"5\" rx=\"2.5\"/></svg>money</span>\n    </span>\n  </header>\n";
// One block per market, rendered only when that market actually has data:
// tennis carries a moneyline split and nothing else, so the spread and total
// blocks would otherwise render as empty rows.
const PANEL_MARKETS = [
  "  <div class=\"nx-dd-mkt\">\n    <div class=\"nx-dd-mkt-h\"><span class=\"nx-dd-mkt-name\">Spread</span><span class=\"nx-dd-rule\"></span></div>\n\n    <div class=\"nx-dd-side\">\n      <span class=\"nx-dd-v nx-dd-v--bets\">{{SPR_AWAY_BETS}}%<span class=\"nx-dd-ab\">{{AWAY_ABBR}}</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-fill nx-dd-fill--bets\" style=\"width:{{SPR_AWAY_BETS}}%\"></i></span>\n      <span class=\"nx-dd-num\">{{SPR_AWAY_LINE}}</span>\n      <span class=\"nx-dd-v nx-dd-v--money\">$ {{SPR_AWAY_MONEY}}%<span class=\"nx-dd-ab\">{{AWAY_ABBR}}</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-ref\" style=\"width:{{SPR_AWAY_BETS}}%\"></i><i class=\"nx-dd-fill nx-dd-fill--money\" style=\"width:{{SPR_AWAY_MONEY}}%\"></i></span>\n    </div>\n\n    <div class=\"nx-dd-side\">\n      <span class=\"nx-dd-v nx-dd-v--bets\">{{SPR_HOME_BETS}}%<span class=\"nx-dd-ab\">{{HOME_ABBR}}</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-fill nx-dd-fill--bets\" style=\"width:{{SPR_HOME_BETS}}%\"></i></span>\n      <span class=\"nx-dd-num\">{{SPR_HOME_LINE}}</span>\n      <span class=\"nx-dd-v nx-dd-v--money\">$ {{SPR_HOME_MONEY}}%<span class=\"nx-dd-ab\">{{HOME_ABBR}}</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-ref\" style=\"width:{{SPR_HOME_BETS}}%\"></i><i class=\"nx-dd-fill nx-dd-fill--money\" style=\"width:{{SPR_HOME_MONEY}}%\"></i></span>\n    </div>\n  </div>",
  "  <div class=\"nx-dd-mkt\">\n    <div class=\"nx-dd-mkt-h\"><span class=\"nx-dd-mkt-name\">Total</span><span class=\"nx-dd-rule\"></span></div>\n\n    <div class=\"nx-dd-side\">\n      <span class=\"nx-dd-v nx-dd-v--bets\">{{TOT_OVER_BETS}}%<span class=\"nx-dd-ab\">Over</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-fill nx-dd-fill--bets\" style=\"width:{{TOT_OVER_BETS}}%\"></i></span>\n      <span class=\"nx-dd-num\">{{TOTAL_LINE}}</span>\n      <span class=\"nx-dd-v nx-dd-v--money\">$ {{TOT_OVER_MONEY}}%<span class=\"nx-dd-ab\">Over</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-ref\" style=\"width:{{TOT_OVER_BETS}}%\"></i><i class=\"nx-dd-fill nx-dd-fill--money\" style=\"width:{{TOT_OVER_MONEY}}%\"></i></span>\n    </div>\n\n    <div class=\"nx-dd-side\">\n      <span class=\"nx-dd-v nx-dd-v--bets\">{{TOT_UNDER_BETS}}%<span class=\"nx-dd-ab\">Under</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-fill nx-dd-fill--bets\" style=\"width:{{TOT_UNDER_BETS}}%\"></i></span>\n      <span class=\"nx-dd-num\">{{TOTAL_LINE}}</span>\n      <span class=\"nx-dd-v nx-dd-v--money\">$ {{TOT_UNDER_MONEY}}%<span class=\"nx-dd-ab\">Under</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-ref\" style=\"width:{{TOT_UNDER_BETS}}%\"></i><i class=\"nx-dd-fill nx-dd-fill--money\" style=\"width:{{TOT_UNDER_MONEY}}%\"></i></span>\n    </div>\n  </div>",
  "  <div class=\"nx-dd-mkt\">\n    <div class=\"nx-dd-mkt-h\"><span class=\"nx-dd-mkt-name\">Moneyline</span><span class=\"nx-dd-rule\"></span></div>\n\n    <div class=\"nx-dd-side\">\n      <span class=\"nx-dd-v nx-dd-v--bets\">{{ML_AWAY_BETS}}%<span class=\"nx-dd-ab\">{{AWAY_ABBR}}</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-fill nx-dd-fill--bets\" style=\"width:{{ML_AWAY_BETS}}%\"></i></span>\n      <span class=\"nx-dd-num\">{{ML_AWAY_PRICE}}</span>\n      <span class=\"nx-dd-v nx-dd-v--money\">$ {{ML_AWAY_MONEY}}%<span class=\"nx-dd-ab\">{{AWAY_ABBR}}</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-ref\" style=\"width:{{ML_AWAY_BETS}}%\"></i><i class=\"nx-dd-fill nx-dd-fill--money\" style=\"width:{{ML_AWAY_MONEY}}%\"></i></span>\n    </div>\n\n    <div class=\"nx-dd-side\">\n      <span class=\"nx-dd-v nx-dd-v--bets\">{{ML_HOME_BETS}}%<span class=\"nx-dd-ab\">{{HOME_ABBR}}</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-fill nx-dd-fill--bets\" style=\"width:{{ML_HOME_BETS}}%\"></i></span>\n      <span class=\"nx-dd-num\">{{ML_HOME_PRICE}}</span>\n      <span class=\"nx-dd-v nx-dd-v--money\">$ {{ML_HOME_MONEY}}%<span class=\"nx-dd-ab\">{{HOME_ABBR}}</span></span>\n      <span class=\"nx-dd-track\" aria-hidden=\"true\"><i class=\"nx-dd-ref\" style=\"width:{{ML_HOME_BETS}}%\"></i><i class=\"nx-dd-fill nx-dd-fill--money\" style=\"width:{{ML_HOME_MONEY}}%\"></i></span>\n    </div>\n  </div>",
];
const PANEL_FOOT = "  <p class=\"nx-dd-note\">Bets is the share of wagers placed. Money is the share of dollars. A gold bar past its blue one is money betting bigger than the crowd.</p>\n</section>";

// The bet as a bettor reads it: "-1.5" for a spread (from the leaning side's
// point of view), "O 8.5" / "U 8.5" for a total, "Win" for a moneyline. Falls
// back to the market code when the board has no line yet.
function p2MarketLabel(g, m) {
  if (m.tag === 'ML') return 'Win';
  if (m.tag === 'O/U') {
    if (g.over_under == null) return 'Total';
    return `${m.side === 'Un' ? 'U' : 'O'} ${g.over_under}`;
  }
  // A bare "-1.5" does not say whose number it is, so the spread carries the
  // side it belongs to: "CCU -1.5".
  const n = m.homeLed ? g.spread_home : g.spread_away;
  return n == null ? 'Spread' : `${m.side} ${fmtSpread(n)}`;
}

function p2State(p1, second) {
  if (p1.split) return 'split';
  if (second) return 'two';
  if (p1.hasM) return 'money';
  return 'base';
}

function ropeHtml(g, p1, second) {
  const tpl = ROPE_STATES[p2State(p1, second)];
  const isOU = p1.tag === 'O/U';
  const t = {
    PCT: p1.pct,
    SIDE: p1.side,
    TAG: p1.tag,
    MARKET_LABEL: p2MarketLabel(g, p1),
    SECOND_LABEL: second ? p2MarketLabel(g, second) : '',
    AWAY_ABBR: isOU ? 'Ov' : abbrOf(g, 'away'),
    HOME_ABBR: isOU ? 'Un' : abbrOf(g, 'home'),
    AWAY_PCT: p1.away,
    HOME_PCT: p1.home,
    MONEY_PCT: p1.moneySidePct == null ? '' : p1.moneySidePct,
    MONEY_SIDE: p1.moneySide == null ? '' : p1.moneySide,
    SECOND_PCT: second ? second.pct : '',
    SECOND_SIDE: second ? second.side : '',
    SECOND_TAG: second ? second.tag : '',
  };
  const html = tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => esc(String(t[k] ?? '')));
  return `<span class="nx-pubrope" title="${_mktTitle(p1)}">${html}</span>`;
}

// ── The full public betting panel (card dropdown) ────────────────────────────
// Alternative designs for the full public-betting panel, same template-as-data
// approach as the card element. 'current' keeps the built-in table below.
// The single widest bets-vs-money gap on the game, for designs that lead with
// the conclusion instead of the grid.
function ddDivergence(g) {
  const p = g.pub || {};
  const am = abbrOf(g, 'away'), hm = abbrOf(g, 'home');
  const rows = [
    ['Spread', am, p.away_spread, p.away_spread_money], ['Spread', hm, p.home_spread, p.home_spread_money],
    ['Total', 'Over', p.over, p.over_money], ['Total', 'Under', p.under, p.under_money],
    ['Moneyline', am, p.away_ml, p.away_ml_money], ['Moneyline', hm, p.home_ml, p.home_ml_money],
  ].filter(r => r[2] != null && r[3] != null);
  if (!rows.length) return { market: '', side: '', bets: '', money: '' };
  const best = rows.reduce((a, b) => (Math.abs(b[3] - b[2]) > Math.abs(a[3] - a[2]) ? b : a));
  return { market: best[0], side: best[1], bets: best[2], money: best[3] };
}

function ddTokens(g) {
  const p = g.pub || {};
  const n = (x) => (x == null ? '' : x);
  const dv = ddDivergence(g);
  return {
    DIV_MARKET: dv.market, DIV_SIDE: dv.side, DIV_BETS: dv.bets, DIV_MONEY: dv.money,
    AWAY_ABBR: abbrOf(g, 'away'),
    HOME_ABBR: abbrOf(g, 'home'),
    SPR_AWAY_LINE: g.spread_away == null ? '' : fmtSpread(g.spread_away),
    SPR_HOME_LINE: g.spread_home == null ? '' : fmtSpread(g.spread_home),
    TOTAL_LINE: n(g.over_under),
    ML_AWAY_PRICE: g.ml_away == null ? '' : fmtOdds(g.ml_away),
    ML_HOME_PRICE: g.ml_home == null ? '' : fmtOdds(g.ml_home),
    SPR_AWAY_BETS: n(p.away_spread), SPR_HOME_BETS: n(p.home_spread),
    SPR_AWAY_MONEY: n(p.away_spread_money), SPR_HOME_MONEY: n(p.home_spread_money),
    TOT_OVER_BETS: n(p.over), TOT_UNDER_BETS: n(p.under),
    TOT_OVER_MONEY: n(p.over_money), TOT_UNDER_MONEY: n(p.under_money),
    ML_AWAY_BETS: n(p.away_ml), ML_HOME_BETS: n(p.home_ml),
    ML_AWAY_MONEY: n(p.away_ml_money), ML_HOME_MONEY: n(p.home_ml_money),
  };
}

function ddRender(g) {
  const p = g.pub;
  if (!p) return '';
  const has = [
    _pair(p.away_spread, p.home_spread) || _pair(p.away_spread_money, p.home_spread_money),
    _pair(p.over, p.under) || _pair(p.over_money, p.under_money),
    _pair(p.away_ml, p.home_ml) || _pair(p.away_ml_money, p.home_ml_money),
  ];
  const body = PANEL_MARKETS.filter((_, i) => has[i]).join('\n');
  if (!body) return '';
  const t = ddTokens(g);
  const html = (PANEL_HEAD + '\n' + body + '\n' + PANEL_FOOT)
    .replace(/\{\{(\w+)\}\}/g, (_, x) => esc(String(t[x] ?? '')));
  return `<div class="nx-pubpanel">${html}</div>`;
}

// Fallback 1: the CA community lean from member votes (3+ votes on a family).
function pubVotesLean(g) {
  const v = g.votes;
  if (!v) return null;
  const am = abbrOf(g, 'away'), hm = abbrOf(g, 'home');
  let home = 0, away = 0, over = 0, under = 0;
  for (const [slot, n] of Object.entries(v)) {
    const s = slot.toLowerCase();
    if (s === 'over') over += n;
    else if (s === 'under') under += n;
    else if (s.includes('home')) home += n;
    else if (s.includes('away')) away += n;
  }
  if (home + away >= 3) {
    const homeLed = home >= away;
    return { side: homeLed ? hm : am, pct: Math.round(100 * Math.max(home, away) / (home + away)), n: home + away };
  }
  if (over + under >= 3) {
    return { side: over >= under ? 'Ov' : 'Un', pct: Math.round(100 * Math.max(over, under) / (over + under)), n: over + under };
  }
  return null;
}

// Fallback 2: the day's line movement (opening line vs the board's current one).
function pubLineMove(g) {
  const o = g.open;
  if (!o) return null;
  const am = abbrOf(g, 'away'), hm = abbrOf(g, 'home');
  // Spread move (shown from the favorite's side of the CURRENT number).
  if (o.spread_home != null && g.spread_home != null && Math.abs(g.spread_home - o.spread_home) >= 0.5) {
    const homeFav = g.spread_home <= 0;
    const from = homeFav ? o.spread_home : -o.spread_home;
    const to   = homeFav ? g.spread_home : g.spread_away != null ? g.spread_away : -g.spread_home;
    return { label: `${homeFav ? hm : am} ${fmtSpread(from)} → ${fmtSpread(to)}` };
  }
  if (o.over_under != null && g.over_under != null && Math.abs(g.over_under - o.over_under) >= 0.5) {
    return { label: `Total ${o.over_under} → ${g.over_under}` };
  }
  if (o.ml_home != null && g.ml_home != null && g.ml_away != null && o.ml_away != null) {
    const homeFav = g.ml_home <= g.ml_away;
    const from = homeFav ? o.ml_home : o.ml_away;
    const to   = homeFav ? g.ml_home : g.ml_away;
    if (from != null && Math.abs(to - from) >= 15) {
      return { label: `${homeFav ? hm : am} ML ${fmtOdds(from)} → ${fmtOdds(to)}` };
    }
  }
  return null;
}

// Tooltip text for the element: the market, the lean, and where the money is.
function _mktTitle(m) {
  const money = m.hasM ? ` Money: ${m.moneySidePct}% on ${m.moneySide}.` : '';
  return `${m.pct}% of ${m.tag === 'O/U' ? 'total' : m.tag === 'SPR' ? 'spread' : 'moneyline'} tickets on ${m.side}.${money}`;
}
// Elastic bar: the filled share IS the displayed lead percentage, so the bar
// always agrees with the number beside it.

function pubChip(g) {
  const mkts = pubMarkets(g);

  // ── Fallback chain when no coherent public data ──
  if (!mkts.length) {
    const cv = pubVotesLean(g);
    if (cv) {
      return `<span class="nx-pubalt n" title="How CappingAlpha members lean on this game (${cv.n} votes)">` +
        `<img class="nx-pubca" src="/ca-logo.png" alt="" onerror="this.style.display='none'">` +
        `<b>${cv.pct}%</b> ${esc(cv.side)} <em>CA VOTES</em></span>`;
    }
    const lm = pubLineMove(g);
    if (lm) {
      return `<span class="nx-pubalt n" title="How this line has moved since it opened">${TREND_ICON}${esc(lm.label)} <em>LINE</em></span>`;
    }
    // Floor: what the price itself implies, so a card with lines is never blank.
    // Deliberately NOT dressed as public data: no people icon, MKT label, muted.
    const impHome = _impliedPct(g, true);
    if (impHome != null) {
      const homeLed = impHome >= 50;
      const side = abbrOf(g, homeLed ? 'home' : 'away');
      const pct = homeLed ? impHome : 100 - impHome;
      return `<span class="nx-pubalt mkt n" title="No public betting data for this game yet. ${pct}% is the win chance implied by the current moneyline price."><b>${pct}%</b> ${esc(side)} <em>MKT</em></span>`;
    }
    return '';
  }

  const p1 = mkts[0];
  // Second market: the best one of a DIFFERENT kind (side market vs total), so
  // the pair never restates the same team twice (SPR 78% TEX + ML 78% TEX).
  // 55% floor keeps coin-flip markets out of the second slot.
  const p1Side = p1.tag !== 'O/U';
  const second = mkts.find(m => m !== p1 && (m.tag !== 'O/U') !== p1Side && m.pct >= 55) || null;

  return ropeHtml(g, p1, second);
}

// Mock chipRow: pub chip (left) + CA chip (right). Tracked-bet avatars still
// have no board-payload data; an empty row renders nothing (no invented counts).
function chipRow(g, ctx) {
  const ca = caChip(g, ctx);
  const pub = pubChip(g);
  if (!ca && !pub) return '';
  return `<div class="nx-chips">${pub}${ca}</div>`;
}

// ── Expansion — context the card does NOT already show (Jack 2026-07-28: the
// old panel restated the lines strip + band). Now: the live situation, tennis
// set-by-set, time-to-start, and for members the actual ranked picks.
// Per-set games for a tennis match, from the today_games JSON blob.
function _tennisSets(g) {
  try { return JSON.parse(g.tennis_score_detail || '[]') || []; } catch (_) { return []; }
}

function _relTime(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Expansion, kept BASIC (Jack 2026-07-30): no restating what the card already
// shows (start time, live state). Only info the card doesn't carry — tennis
// set-by-set, members' ranked picks — plus a full-width Track button and the
// bell. Details button deleted: tapping anywhere on the card (except the
// chevron and buttons) goes to the game page.
function xpHtml(g, ctx) {
  const sp = (g.sport || '').toUpperCase();
  const tennis = sp === 'ATP' || sp === 'WTA';
  let rows = '';

  // Tennis: the set-by-set board (the band only shows sets won). Away side
  // first, matching the band's left-to-right order.
  if (tennis) {
    const sets = _tennisSets(g);
    if (sets.length) {
      rows += `<div class="nx-xrow"><b class="nx-xl">Sets</b><b>${esc(sets.map(s => `${s.away}-${s.home}`).join(', '))}</b></div>`;
    }
  }

  // Members: the ranked picks themselves, not just a count.
  if (ctx.member) {
    const picks = ctx.byGame.get(String(g.espn_game_id)) || [];
    if (picks.length) {
      rows += picks.slice(0, 3).map(p => {
        const res = String(p.result || '').toLowerCase();
        const dot = `<i class="nx-pdot${res === 'win' ? ' w' : res === 'loss' ? ' l' : ''}"></i>`;
        return `<div class="nx-xrow nx-xpick">${dot}<b>${esc(pickLabel(p))}</b><span class="n">CA ${p.score}</span></div>`;
      }).join('');
      if (picks.length > 3) rows += `<div class="nx-xrow"><span>+${picks.length - 3} more on the Rankings tab</span></div>`;
    }
  }

  // The full split table: every market, both sides, tickets vs money.
  rows += ddRender(g);

  const id = esc(String(g.espn_game_id));
  const bellOn = _bells.has(String(g.espn_game_id));
  let exits = `<div class="nx-exits">`;
  if (g.status !== 'post' && hasLines(g)) exits += `<button type="button" class="nx-xbtn pri grow" data-act="track" data-id="${id}">Track</button>`;
  exits += `<button type="button" class="nx-xbtn nx-bell${bellOn ? ' on' : ''}" data-act="bell" data-id="${id}" aria-pressed="${bellOn}" aria-label="Toggle game alerts for this matchup">` +
    `<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path class="bfill" d="M12 3a6 6 0 0 0-6 6v3.6L4.4 16.6h15.2L18 12.6V9a6 6 0 0 0-6-6z"/><path class="bfill" d="M10 19.5a2 2 0 0 0 4 0"/></svg></button>`;
  exits += `</div>`;

  return `<div class="nx-xp"><div><div class="nx-xpin">${rows ? `<div class="nx-xinfo">${rows}</div>` : ''}${exits}</div></div></div>`;
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

// Vitals: the left side is all about the day's slate (date, games, live,
// upcoming, finals); the right side is ONE deliberate CA-logo record button
// (the old Tracked stat + settled-units line had no context here — Jack).
function renderVitals() {
  const el = document.getElementById('nx-vitals');
  if (!el) return;
  const games = boardGames();
  const liveCt = games.filter(g => g.status === 'in').length + _golfTournaments.filter(t => t.status === 'in').length;
  const finCt  = games.filter(g => g.status === 'post').length;
  const upCt   = games.filter(g => g.status === 'pre').length;
  const total  = games.length + _golfTournaments.length;
  const dateLabel = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
  el.innerHTML =
    `<span class="nx-vdate">${esc(dateLabel)}</span>` +
    `<span class="nx-v"><b>Games</b><span class="n">${total}</span></span>` +
    `<span class="nx-v"><b>Live</b><span class="n" style="color:var(--nx-live)">${liveCt}</span></span>` +
    `<span class="nx-v"><b>Upcoming</b><span class="n">${upCt}</span></span>` +
    (finCt ? `<span class="nx-v"><b>Finals</b><span class="n">${finCt}</span></span>` : '') +
    `<span class="nx-vsp"></span>` +
    `<button type="button" class="nx-carec n" data-nav="mvp" title="The tracked CA record"><img src="/ca-logo.png" alt="" onerror="this.style.display='none'">CA Scores</button>`;
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
    const ct = i === 0
      ? `<span class="nx-ct n">${boardGames().length + _golfTournaments.length}</span>`
      : (_futureCache.has(futureKey(i)) ? `<span class="nx-ct n">${_futureCache.get(futureKey(i)).length}</span>` : '');
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

// ── Future-day slates (display-only schedule previews) ────────────────────────
// today_games only holds today's board, so the Tue/Wed/Thu tabs pull that day's
// slate from GET /api/games/future (a cached server-side pass over ESPN's free
// scoreboards; the page CSP blocks calling ESPN directly). Rows render through
// the same card renderer: matchup + time, no lines, no picks. The board itself
// still posts the morning of each slate.
const _futureCache = new Map();   // 'YYYYMMDD' -> pseudo-game rows
const _futureLoads = new Set();
function futureKey(dayIdx) {
  const d = new Date(Date.now() + dayIdx * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
}
async function loadFutureDay(dayIdx) {
  const key = futureKey(dayIdx);
  if (_futureCache.has(key) || _futureLoads.has(key)) return;
  _futureLoads.add(key);
  try {
    const res = await fetch(`/api/games/future?date=${key}`);
    _futureCache.set(key, res.ok ? await res.json() : []);
  } catch (_) {
    _futureCache.set(key, []);
  } finally { _futureLoads.delete(key); }
  // Still looking at this day: paint the slate + the day-strip count.
  // (Day taps are delegated, so re-rendering the strip keeps them working.)
  if (_curDay === dayIdx) { renderDays(); renderSections(); }
}
function renderFutureDay(host) {
  const key = futureKey(_curDay);
  if (!_futureCache.has(key)) {
    host.innerHTML = `<div class="nx-postnote">Loading the slate...</div>`;
    loadFutureDay(_curDay);
    return;
  }
  const all = _futureCache.get(key);
  const rows = all.filter(g => _selSports.size === 0 || _selSports.has(sportKey(g.sport)));
  if (!rows.length) {
    host.innerHTML = `<div class="nx-postnote">No games scheduled here yet. The board for each day posts in the morning.</div>`;
    return;
  }
  const ctx = { member: isPaying(), byGame: new Map(), rankedBySport: new Map(), top: null };
  const byStart = (a, b) => String(a.start_time || '').localeCompare(String(b.start_time || ''));
  const bySport = new Map();
  for (const g of rows.sort(byStart)) {
    const k = sportKey(g.sport);
    if (!bySport.has(k)) bySport.set(k, []);
    bySport.get(k).push(g);
  }
  let h = `<div class="nx-notice">Schedule preview. Lines and rankings post the morning of each slate.</div>`;
  for (const [k, list] of bySport) {
    h += sectionHtml(k, list.map(g => cardHtml(g, ctx)));
  }
  host.innerHTML = `<div class="nx-fwrap">${h}</div>`;
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

  if (_curDay !== 0) { renderFutureDay(host); return; }

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
    abbrOf(g, 'away'), abbrOf(g, 'home')].join(' ').toLowerCase();
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
    if (e.target.closest('.nx-caline, .nx-carec')) { if (window.switchTab) window.switchTab('mvp'); return; }
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
      if (act.dataset.act === 'track' && window.openTrackForSlot) window.openTrackForSlot(act.dataset.id, 'none');
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

    // Anywhere else on the card — expansion body included — goes to the game
    // page (Jack 2026-07-30: only the chevron and real buttons do anything else).
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
