// public/modules/home_top.js
// Home page lead rows:
//  • "Today's Top Games" — market-hotness strip, click → standalone detail page.
//  • "My Sports" — pick/save the sports you follow, then see each one's games
//    as an inline strip (same tiles as Top Games), click → detail page.

import { state }     from './state.js';
import { isPaying }  from './auth.js';
import { sportBadge, gameTime, PICK_HEAT_COLOR, pickLabel, teamNickname, LOCK_SVG } from './utils.js';

// All sports the product supports. Tennis is the merged ATP+WTA label.
const MS_ALL_SPORTS = ['MLB', 'NBA', 'WNBA', 'NHL', 'NFL', 'NCAAF', 'CBB', 'Tennis', 'Golf'];

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

function _statusHtml(g) {
  const start = gameTime(g.start_time);
  if (g.status === 'in') {
    return `<span class="ca-tg-live">
      <span class="ca-tg-live-dot"></span>
      <span class="ca-tg-score-num">${g.away_score ?? 0}–${g.home_score ?? 0}</span>
      <span class="ca-tg-meta"><span class="ca-tg-period">${_livePeriod(g)}</span><span class="ca-tg-start">${start}</span></span>
    </span>`;
  }
  if (g.status === 'post') {
    return `<span class="ca-tg-final">
      <span class="ca-tg-score-num">${g.away_score ?? 0}–${g.home_score ?? 0}</span>
      <span class="ca-tg-meta"><span class="ca-tg-period">Final</span><span class="ca-tg-start">${start}</span></span>
    </span>`;
  }
  return `<span class="ca-tg-time">${start}</span>`;
}

// Very short pick descriptor for the tile, e.g. "Dodgers ML", "Over 8.5", "Rays -1.5".
function _abbrevPick(tp) {
  const type = (tp.pick_type || '').toLowerCase();
  const line = tp.spread != null ? Math.abs(parseFloat(tp.spread)) : null;
  if (type === 'over')  return line != null ? `Over ${line}`  : 'Over';
  if (type === 'under') return line != null ? `Under ${line}` : 'Under';
  const nick = teamNickname(tp.team) || tp.team || '';
  if (type === 'ml') return `${nick} ML`;
  if (type === 'spread') {
    const s = tp.spread != null ? (tp.spread > 0 ? `+${tp.spread}` : `${tp.spread}`) : '';
    return s ? `${nick} ${s}` : `${nick} Spread`;
  }
  return pickLabel(tp);
}

function _isUnlocked(tp) {
  return !!tp && tp.score != null && (isPaying() || tp.is_global_1);
}

// Top-right cluster: abbreviated pick (when unlocked) + CappingAlpha score, with
// a small badge when more than one pick on the game scored.
function _cornerCluster(g) {
  const tp = g.top_pick;
  if (!tp || tp.score == null) {
    return `<span class="ca-tg-score ca-tg-score-none">—</span>`;
  }
  if (!_isUnlocked(tp)) {
    return `<span class="ca-tg-score ca-tg-score-locked" title="Unlock with full access">${LOCK_SVG}</span>`;
  }
  const heat  = PICK_HEAT_COLOR(tp.score);
  const fire  = heat.fire ? ' 🔥' : '';
  const multi = (g.pick_count > 1)
    ? `<span class="ca-tg-multi" title="${g.pick_count} rated picks on this game">${g.pick_count}</span>`
    : '';
  return `<span class="ca-tg-pick" title="${pickLabel(tp)}">${_abbrevPick(tp)}</span>
    <span class="ca-tg-score" style="color:${heat.color};border-color:${heat.color}55;">${tp.score}${fire}</span>${multi}`;
}

function _gameTile(g) {
  const away = _shortName(g.away_team, g.away_short);
  const home = _shortName(g.home_team, g.home_short);
  const tp   = g.top_pick;
  // Reveal the pick text on hover only when unlocked — keep paid content gated.
  const pickTitle = _isUnlocked(tp) ? ` · Top pick: ${pickLabel(tp)}` : '';
  return `<div class="ca-tg-tile" onclick="location.href='/game/${g.espn_game_id}'" title="${away} @ ${home}${pickTitle}">
    <div class="ca-tg-top">
      ${sportBadge(g.sport)}
      <span class="ca-tg-corner">${_cornerCluster(g)}</span>
    </div>
    <div class="ca-tg-matchup">${away} @ ${home}</div>
    <div class="ca-tg-bottom">
      ${_statusHtml(g)}
      <span class="ca-tg-more">More ›</span>
    </div>
  </div>`;
}

// ── Today's Top Games ───────────────────────────────────────────────────────────
export async function loadTopGames() {
  const el = document.getElementById('ca-top-games-row');
  if (!el) return;

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
