// modules/sport_cards.js — "Today's CA Scores" sport-card rail (CA Rankings tab)
// A horizontally scrolling PLAYING-CARD per sport (fixed portrait size, every
// card identical): sport chip + day tally in the header, the day's ungraded
// picks as concise scrollable rows (score + pick + matchup, live games
// highlighted), and a footer with the CA sport profile button. Once a pick
// grades, a "See graded" button appears and flips the card to the graded list.
//
// MOCK MODE (local review): open the site with ?mockrail=1 and the rail renders
// a built-in fake slate (5-10 picks per sport, every sport) instead of the live
// board — for eyeballing the design. Strip before ship if Jack prefers.

import { state } from './state.js';
import { sportBadge, scoreDisplay, pickLabel, teamNickname, PICK_HEAT_COLOR, currentBoardDate } from './utils.js?v=4';

// Display grouping: both tennis tours share one card, like the Sports tab.
export function displaySport(sport) {
  const s = (sport || '').toUpperCase();
  if (s === 'ATP' || s === 'WTA') return 'Tennis';
  return sport || '—';
}

let _filters = { min: 100, max: null, sport: 'ALL' };
const _view = new Map();          // key -> 'today' | 'live' | 'graded' (current face)
const _userChoice = new Set();    // keys the user explicitly switched this session
const _cardsByKey = new Map();    // key -> last-rendered card data (for the waterfall swap)
const _animating = new Set();     // keys mid-waterfall (defer rail re-renders so they don't clobber it)
const _timers = new Map();        // key -> [timeout ids] for the in-flight waterfall (cancel on re-tap)
let _pendingRender = false;       // a re-render was requested while animating; run it after
let _usedFallback = false;

// True when the last render filled the rail from today's tracked picks instead
// of the live board (mvp.js appends a note to the section header).
export function railUsedFallback() { return _usedFallback; }

function isGraded(p) {
  const r = (p.result || '').toLowerCase();
  return r === 'win' || r === 'loss' || r === 'push' || r === 'void';
}

// When a pick finished, for the graded list's most-recent-first order. Board
// rows may not carry resolved_at; the game's start time is the fallback proxy.
function _finishTs(p) {
  const t = Date.parse(p.resolved_at || '');
  if (!Number.isNaN(t)) return t;
  const s = Date.parse(p.start_time || '');
  return Number.isNaN(s) ? 0 : s;
}

// "vs Red Sox" / "@ Red Sox" tag under the status of open rows — the matchup
// line is gone, so this keeps the opponent visible. Listing-order sports
// (tennis) always read "vs"; their home/away means nothing.
function oppFor(p) {
  if (!p.home_team || !p.away_team || !p.team) return '';
  const t = String(p.team).trim();
  const isHome = t === String(p.home_team).trim();
  const isAway = t === String(p.away_team).trim();
  if (!isHome && !isAway) return '';
  const opp = isHome ? p.away_team : p.home_team;
  const nick = teamNickname(opp, p.team);
  const s = (p.sport || '').toUpperCase();
  const listingOrder = s === 'ATP' || s === 'WTA' || s === 'GOLF';
  return (listingOrder || isHome) ? `vs ${nick}` : `@ ${nick}`;
}

function rowHtml(p) {
  const live = p.game_status === 'in';
  const r = (p.result || '').toLowerCase();
  const isVoid = r === 'void' || !!(p.annotation && p.annotation.toLowerCase().includes('not counted'));
  // Graded rows tint by outcome: green win, red loss, grey push/void.
  const gradeCls = !isGraded(p) ? ''
    : (isVoid || r === 'push') ? ' graded-push'
    : r === 'win' ? ' graded-win'
    : r === 'loss' ? ' graded-loss' : ' graded-push';
  const click = p.espn_game_id ? ` onclick="location.href='/game/${p.espn_game_id}'"` : '';
  const heat = PICK_HEAT_COLOR(p.score || 0);
  const outscored = !!p._outscored;
  const scoreColor = outscored ? 'var(--muted)' : heat.color;
  const showFire = heat.fire && !outscored;
  const score = p.score != null ? Math.round(p.score) : '—';
  // Ring around the score number, same color family as the number: outcome color
  // for graded rows, grey when outscored, the heat color (softened) otherwise.
  const ringColor = isGraded(p)
    ? (r === 'win' ? 'rgba(74,222,128,0.55)' : r === 'loss' ? 'rgba(248,113,113,0.55)' : 'rgba(148,163,184,0.55)')
    : outscored ? 'rgba(148,163,184,0.5)'
    : (heat.color.startsWith('#') ? heat.color + '80' : heat.color);
  // No matchup line — but a bare "Over 8.5" identifies nothing, so totals keep
  // the team in the label (same convention as the P/L chart tooltips).
  const pt = (p.pick_type || '').toLowerCase();
  const label = (pt === 'over' || pt === 'under') && p.team
    ? `${teamNickname(p.team)} ${pickLabel(p)}` : pickLabel(p);
  const voidNote = isVoid
    ? `<div class="ca-rail-void-note">${p.annotation || 'Void. Not counted in the record.'}</div>` : '';
  const outscoredNote = outscored ? `<div class="ca-rail-void-note">Currently outscored</div>` : '';
  const pushChip = r === 'push' ? `<span class="ca-push-chip">Push</span>` : '';
  // Opponent tag ("@ Cubs" / "vs Cubs") sits directly under the pick on every
  // face — upcoming, live, and graded read the same way.
  const opp = oppFor(p);
  const oppUnder = opp ? `<div class="ca-rail-opp-under">${opp}</div>` : '';
  return `<div class="ca-rail-row${live ? ' live' : ''}${gradeCls}"${click}>
    <span class="ca-rail-score" style="color:${scoreColor};border-color:${ringColor};">${score}${showFire ? '<span class="ca-rail-fire">🔥</span>' : ''}</span>
    <div class="ca-rail-main">
      <div class="ca-rail-label">${label}${pushChip}</div>
      ${oppUnder}${voidNote}${outscoredNote}
    </div>
    <div class="ca-rail-status">${scoreDisplay(p)}</div>
  </div>`;
}

// Flat-unit return for a graded pick, mirroring the P/L math elsewhere: ML uses
// its odds, totals their juice, spreads default -115.
function _ret(p) {
  const r = (p.result || '').toLowerCase();
  if (r === 'loss') return -1;
  if (r !== 'win') return 0;
  const type = (p.pick_type || '').toLowerCase();
  const odds = type === 'ml' ? (p.ml_odds || -115)
             : (type === 'over' || type === 'under') ? (p.ou_odds || -115)
             : -115;
  return odds < 0 ? 100 / Math.abs(odds) : odds / 100;
}

// The graded face's header: today's record / win% / ROI for this sport,
// voids excluded (never counted in any record on the site).
function dayStatsHtml(graded) {
  const counted = graded.filter(p => {
    const r = (p.result || '').toLowerCase();
    return r === 'win' || r === 'loss' || r === 'push';
  });
  const wins   = counted.filter(p => (p.result || '').toLowerCase() === 'win').length;
  const losses = counted.filter(p => (p.result || '').toLowerCase() === 'loss').length;
  const pushes = counted.length - wins - losses;
  const decided = wins + losses;
  const winPct = decided ? Math.round(100 * wins / decided) + '%' : '—';
  const profit = counted.reduce((s, p) => s + _ret(p), 0);
  const roi = decided ? 100 * profit / decided : null;
  const roiStr = roi == null ? '—' : `${roi >= 0 ? '+' : ''}${roi.toFixed(0)}%`;
  const roiColor = roi == null ? 'var(--text)' : roi >= 0 ? 'var(--green)' : 'var(--red)';
  // Same colors as the #1 ranked pick's record bar: green wins, red losses,
  // gold win%. Pushes stay off the header (their chips show on the rows).
  return `<div class="ca-card-stats">
    <div class="ca-card-stat"><b style="color:var(--green);">${wins}</b><span>Wins</span></div>
    <div class="ca-card-stat"><b style="color:var(--red);">${losses}</b><span>Losses</span></div>
    <div class="ca-card-stat"><b style="color:var(--gold-ink);">${winPct}</b><span>Win%</span></div>
    <div class="ca-card-stat"><b style="color:${roiColor};">${roiStr}</b><span>ROI</span></div>
  </div>`;
}

const profileBtnHtml = (key) =>
  `<button class="ca-profile-btn" onclick="openSportProfile('${key}', 'all')">
    <i class="fa-solid fa-clock-rotate-left" style="font-size:11px;"></i>&nbsp; ${key} History
  </button>`;

// A card shows one of three views: today's UPCOMING picks, the LIVE picks, or the
// GRADED picks. Switching views is a per-row waterfall flip (setCardView), not a
// whole-card flip.
function viewBuckets(card) {
  const { list } = card;
  const graded = list.filter(isGraded).sort((a, b) => _finishTs(b) - _finishTs(a));
  const open = list.filter(p => !isGraded(p));
  const live = open.filter(p => p.game_status === 'in');
  const upcoming = open.filter(p => p.game_status !== 'in');
  return { graded, live, upcoming };
}

function viewRows(card, view) {
  const b = viewBuckets(card);
  return view === 'live' ? b.live : view === 'graded' ? b.graded : b.upcoming;
}

function headMetaInner(card, view) {
  const b = viewBuckets(card);
  if (view === 'live') return `<div class="ca-card-live-head"><span class="ca-live-dot ca-live-dot--flash"></span>${b.live.length} live now</div>`;
  if (view === 'graded') return dayStatsHtml(b.graded);
  return `<div class="ca-card-tally">${card.list.length} Edge scores ranked</div>`;
}

function emptyMsgHtml(card, view) {
  const b = viewBuckets(card);
  const msg = view === 'live' ? 'No live games right now.'
    : view === 'graded' ? 'Nothing graded yet.'
    : (b.live.length || b.graded.length) ? 'All games live or final.' : 'All picks graded.';
  return `<div class="ca-card-empty">${msg}</div>`;
}

function bodyInner(card, view) {
  const rows = viewRows(card, view);
  return rows.length ? rows.map(rowHtml).join('') : emptyMsgHtml(card, view);
}

// Two persistent buttons sit above the History button: Live and Graded. Clicking
// one navigates to that view AND that same button smoothly recolors + renames to
// "Rankings (N)" (N = picks currently being ranked = upcoming) as the return to
// the ranking board. The other button keeps its Live/Graded label. On the today
// (rankings) view neither is active. Buttons never move or resize — only their
// color (via a background-color transition) and text change.
function _flipBtnLabel(card, type, view) {
  const b = viewBuckets(card);
  if (view === type) return `Rankings (${b.upcoming.length})`;
  if (type === 'live') return `<span class="ca-live-dot ca-live-dot--flash"></span>Live (${b.live.length})`;
  return `Graded (${b.graded.length})`;
}
function flipBtnHtml(card, type, view) {
  const active = view === type;
  const target = active ? 'today' : type;
  return `<button class="ca-flip-btn ca-fb-${type}${active ? ' active' : ''}" data-type="${type}" onclick="setCardView('${card.key}','${target}')">${_flipBtnLabel(card, type, view)}</button>`;
}
function flipSlotInner(card, view) {
  return `<div class="ca-flip-row">${flipBtnHtml(card, 'live', view)}${flipBtnHtml(card, 'graded', view)}</div>`;
}
// Update the two buttons IN PLACE (same DOM nodes) so the color change animates
// via CSS transition instead of a hard swap.
function _applyFlipBtn(btn, card, type, view) {
  const active = view === type;
  btn.classList.toggle('active', active);
  btn.setAttribute('onclick', `setCardView('${card.key}','${active ? 'today' : type}')`);
  btn.innerHTML = _flipBtnLabel(card, type, view);
}
function updateFlipSlot(el, card, view) {
  const liveBtn = el.querySelector('.ca-flip-btn[data-type="live"]');
  const gradedBtn = el.querySelector('.ca-flip-btn[data-type="graded"]');
  if (liveBtn && gradedBtn) {
    _applyFlipBtn(liveBtn, card, 'live', view);
    _applyFlipBtn(gradedBtn, card, 'graded', view);
  } else {
    const slot = el.querySelector('.ca-card-flip-slot');
    if (slot) slot.innerHTML = flipSlotInner(card, view);
  }
}

function cardHtml(card) {
  const key = card.key;
  const view = _view.get(key) || 'today';
  const chipSport = key === 'Tennis' ? (card.list[0]?.sport || 'ATP') : key;
  // Footer: a swappable flip-slot (See Live/See Graded/Current Rankings) ABOVE a
  // static History button. Only the flip-slot changes on a view switch.
  return `<div class="ca-sport-card" data-sport="${key}">
    <div class="ca-card-face">
      <div class="ca-card-head">${sportBadge(chipSport)}<div class="ca-card-meta">${headMetaInner(card, view)}</div></div>
      <div class="ca-card-body">${bodyInner(card, view)}</div>
      <div class="ca-card-foot">
        <div class="ca-card-flip-slot">${flipSlotInner(card, view)}</div>
        ${profileBtnHtml(key)}
      </div>
    </div>
  </div>`;
}

// Switch a card to a new view with a top-to-bottom WATERFALL of per-row flips:
// each row flips edge-on, then becomes the new view's row in that slot — or, when
// the new view has nothing there, collapses to nothing. The button set fades out
// and the new one fades back in as the waterfall lands.
export function setCardView(key, view) {
  const el = document.querySelector(`.ca-sport-card[data-sport="${key}"]`);
  const card = _cardsByKey.get(key);
  if (!el || !card) return;
  const interrupting = _animating.has(key);
  if ((_view.get(key) || 'today') === view && !interrupting) return;

  const body = el.querySelector('.ca-card-body');
  const metaEl = el.querySelector('.ca-card-meta');
  if (!body) return;

  _view.set(key, view);
  _userChoice.add(key); // the user is now driving this card

  // Update the two buttons IN PLACE so the clicked one smoothly recolors +
  // renames to "Rankings (N)"; the History button (static sibling) is untouched.
  updateFlipSlot(el, card, view);

  // Rapid re-tap: cancel the in-flight waterfall and snap straight to the new
  // view (no animation) so half-finished rows can't mix into the result.
  if (interrupting) {
    (_timers.get(key) || []).forEach(clearTimeout);
    _timers.delete(key);
    if (metaEl) metaEl.innerHTML = headMetaInner(card, view);
    body.innerHTML = bodyInner(card, view);
    body.style.minHeight = '';
    _animating.delete(key);
    if (!_animating.size && _pendingRender) { _pendingRender = false; renderSportRail(); }
    return;
  }

  _animating.add(key);  // hold off rail re-renders until the waterfall lands
  const timers = [];
  _timers.set(key, timers);

  const STAGGER = 45, HALF = 130;
  if (metaEl) metaEl.innerHTML = headMetaInner(card, view);

  const oldRows = [...body.children];
  const rows = viewRows(card, view);
  const newHtml = rows.length ? rows.map(rowHtml) : [emptyMsgHtml(card, view)];
  const maxLen = Math.max(oldRows.length, newHtml.length);
  body.style.minHeight = body.offsetHeight + 'px'; // hold height through the swap

  const spawn = (html) => { const t = document.createElement('div'); t.innerHTML = html; return t.firstElementChild; };
  const flipIn = (nr) => {
    nr.style.transformOrigin = 'center top';
    nr.style.transform = 'rotateX(92deg)';
    nr.style.opacity = '0';
    nr.style.transition = `transform ${HALF}ms ease, opacity ${HALF}ms ease`;
    // Double rAF: guarantees the edge-on start is committed before the reveal,
    // so the transition always fires (a single rAF can batch both into one frame).
    requestAnimationFrame(() => requestAnimationFrame(() => { nr.style.transform = 'rotateX(0deg)'; nr.style.opacity = '1'; }));
  };

  let lastEnd = 0;
  for (let i = 0; i < maxLen; i++) {
    const delay = i * STAGGER;
    lastEnd = Math.max(lastEnd, delay + HALF * 2);
    const oldRow = oldRows[i];
    const html = newHtml[i];
    timers.push(setTimeout(() => {
      if (oldRow && oldRow.isConnected) {
        oldRow.style.transformOrigin = 'center top';
        oldRow.style.transition = `transform ${HALF}ms ease, opacity ${HALF}ms ease`;
        oldRow.style.transform = 'rotateX(-92deg)';
        oldRow.style.opacity = '0';
        timers.push(setTimeout(() => {
          if (html) {
            const nr = spawn(html);
            oldRow.replaceWith(nr);
            flipIn(nr);
          } else {
            // Nothing in the new view here — collapse the row into nothing.
            oldRow.style.height = '0px'; oldRow.style.minHeight = '0px';
            oldRow.style.marginTop = '0px'; oldRow.style.marginBottom = '0px';
            oldRow.style.paddingTop = '0px'; oldRow.style.paddingBottom = '0px';
            oldRow.style.borderWidth = '0px'; oldRow.style.overflow = 'hidden';
            timers.push(setTimeout(() => oldRow.remove(), HALF));
          }
        }, HALF));
      } else if (html) {
        const nr = spawn(html); // new view is longer than the old — grow into it
        body.appendChild(nr);
        flipIn(nr);
      }
    }, delay));
  }

  timers.push(setTimeout(() => {
    // Rebuild the meta + body cleanly from state so the settled view exactly
    // matches the data (no leftover inline flip styles). The flip slot was set
    // at the start; the History button is never touched.
    if (metaEl) metaEl.innerHTML = headMetaInner(card, view);
    updateFlipSlot(el, card, view);
    body.innerHTML = bodyInner(card, view);
    body.style.minHeight = '';
    _animating.delete(key);
    _timers.delete(key);
    if (!_animating.size && _pendingRender) { _pendingRender = false; renderSportRail(); }
  }, lastEnd + 60));
}

// Data-driven default view (until the user taps a button and owns the card):
// show upcoming if any; else if games are live show LIVE; else show final
// (graded). Recomputed every render.
function applyAutoView(cards) {
  for (const card of cards) {
    if (_userChoice.has(card.key)) continue;
    const b = viewBuckets(card);
    _view.set(card.key, b.upcoming.length ? 'today' : b.live.length ? 'live' : b.graded.length ? 'graded' : 'today');
  }
}

// Re-render the rail from the current board. `filters` merges into the last-used
// set so picksUpdated re-renders keep the tab's active filters.
export function renderSportRail(filters) {
  if (filters) _filters = { ..._filters, ...filters };
  // A waterfall is in flight — don't rebuild the DOM under it. Re-run once it lands.
  if (_animating.size) { _pendingRender = true; return; }
  const el = document.getElementById('ca-sport-rail');
  if (!el) return;

  const { min, max, sport } = _filters;
  const inRange = (p) => {
    const s = p.score || 0;
    if (s < (min ?? 0)) return false;
    if (max != null && s > max) return false;
    if (sport && sport !== 'ALL' && displaySport(p.sport) !== sport) return false;
    return true;
  };

  let picks;
  let fallback = false;
  if (mockRailActive()) {
    picks = MOCK_PICKS.filter(inRange);
  } else {
    picks = (state.allPicks || []).filter(inRange);
    // Fallback source: when the board carries nothing eligible (locally the
    // mirrored /api/picks is a logged-out payload with scores stripped), fill
    // the rail from today's tracked picks — real rows, minus live game state.
    if (!picks.length && state.mvpData?.picks?.length) {
      const today = currentBoardDate();
      picks = state.mvpData.picks
        .filter(p => p.game_date === today)
        .map(p => ({
          ...p,
          game_status: (p.result && p.result !== 'pending') ? 'post' : 'pre',
          game_home_score: p.home_score,
          game_away_score: p.away_score,
        }))
        .filter(inRange);
      fallback = picks.length > 0;
    }
  }
  _usedFallback = fallback;

  // One tracked bet per game per dimension (sides vs totals): when two OPEN
  // picks share a game and dimension, every one below the leader is "currently
  // outscored" — grey score, grey note — until it retakes the lead or starts.
  const gameKey = (p) => {
    const t = (p.pick_type || '').toLowerCase();
    const dim = (t === 'over' || t === 'under') ? 'total' : 'side';
    return `${p.espn_game_id || `${p.away_team}@${p.home_team}`}|${dim}`;
  };
  const bestByKey = new Map();
  for (const p of picks) {
    if (isGraded(p)) continue;
    const k = gameKey(p);
    bestByKey.set(k, Math.max(bestByKey.get(k) ?? -Infinity, p.score || 0));
  }
  for (const p of picks) {
    p._outscored = !isGraded(p) && (p.score || 0) < (bestByKey.get(gameKey(p)) ?? -Infinity);
  }

  const groups = new Map();
  for (const p of picks) {
    const key = displaySport(p.sport);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const cards = [...groups.entries()].map(([key, list]) => {
    list.sort((a, b) => (b.score || 0) - (a.score || 0) || ((a.id || 0) - (b.id || 0)));
    return { key, list, top: list[0]?.score || 0 };
  }).sort((a, b) => b.top - a.top);

  _cardsByKey.clear();
  cards.forEach(c => _cardsByKey.set(c.key, c));

  if (!cards.length) {
    const bound = max != null ? `${min ?? 0}–${max}` : `${min ?? 0}+`;
    el.innerHTML = `<div class="empty" style="flex:1;padding:26px;"><p>No ${bound} picks on the board yet today.</p></div>`;
    return;
  }
  applyAutoView(cards);
  el.innerHTML = cards.map(cardHtml).join('');
  _syncRailCentering();
}

// Center the cards whenever they all fit without scrolling; left-align the
// moment they overflow (a centered flex row can't scroll back to its start).
function _syncRailCentering() {
  const el = document.getElementById('ca-sport-rail');
  if (!el) return;
  requestAnimationFrame(() => el.classList.toggle('ca-rail-center', el.scrollWidth <= el.clientWidth + 4));
}
window.addEventListener('resize', _syncRailCentering);

Object.assign(window, { setCardView });

// ── Drag-to-scroll (mirror of the Today's Games strips in home_top.js) ────────
// Mouse only — touch already swipes natively. Document-level so it survives
// every innerHTML re-render; the capture-phase click swallow stops a row's
// navigation from firing at the end of a real drag.
(function initRailDrag() {
  let rail = null, startX = 0, startLeft = 0, moved = 0;
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = e.target.closest('.ca-rail');
    if (!r) return;
    rail = r; startX = e.clientX; startLeft = r.scrollLeft; moved = 0;
    r.classList.add('ca-dragging');
  });
  document.addEventListener('pointermove', (e) => {
    if (!rail) return;
    const dx = e.clientX - startX;
    moved += Math.abs(dx);
    rail.scrollLeft = startLeft - dx;
  });
  const end = () => { if (rail) rail.classList.remove('ca-dragging'); rail = null; };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  document.addEventListener('click', (e) => {
    if (moved > 6 && e.target.closest('.ca-rail')) { e.preventDefault(); e.stopPropagation(); moved = 0; }
  }, true);
})();

// ── Mock slate (?mockrail=1, local design review only) ────────────────────────
// Hard-gated to localhost: on prod the param is inert, so nobody can render the
// fake slate (or the logged-out full layout that rides with it) on the real site.
export function railMockActive() { return mockRailActive(); }
function mockRailActive() {
  try {
    const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    return local && new URLSearchParams(location.search).has('mockrail');
  } catch (_) { return false; }
}

const _h = 3600e3;
const _soon = (hrs) => new Date(Date.now() + hrs * _h).toISOString();
const _ago = (mins) => new Date(Date.now() - mins * 60e3).toISOString();
let _mid = 9000;
const _mk = (score, sport, team, away, home, o = {}) => ({
  id: ++_mid, score, sport, team, away_team: away, home_team: home,
  pick_type: 'ml', spread: null, game_status: 'pre', start_time: _soon(2 + (_mid % 5)),
  result: null, game_home_score: 0, game_away_score: 0, ...o,
});

const MOCK_PICKS = [
  // MLB — 7
  _mk(151, 'MLB', 'New York Yankees', 'New York Yankees', 'Boston Red Sox', { game_status: 'in', game_period: 5, game_away_score: 4, game_home_score: 2 }),
  _mk(133, 'MLB', 'Los Angeles Dodgers', 'San Diego Padres', 'Los Angeles Dodgers', { pick_type: 'spread', spread: -1.5 }),
  _mk(126, 'MLB', 'Chicago Cubs', 'Cincinnati Reds', 'Chicago Cubs', { pick_type: 'over', spread: 8.5, game_status: 'post', result: 'win', game_away_score: 6, game_home_score: 5, resolved_at: _ago(25) }),
  _mk(118, 'MLB', 'Houston Astros', 'Texas Rangers', 'Houston Astros', { game_status: 'post', result: 'loss', game_away_score: 7, game_home_score: 3, resolved_at: _ago(95) }),
  _mk(114, 'MLB', 'Philadelphia Phillies', 'Atlanta Braves', 'Philadelphia Phillies', { pick_type: 'spread', spread: -1.5, game_status: 'in', game_period: 2, game_away_score: 0, game_home_score: 1 }),
  _mk(108, 'MLB', 'Atlanta Braves', 'Atlanta Braves', 'Miami Marlins', { pick_type: 'under', spread: 9, game_status: 'post', result: 'void', game_away_score: 6, game_home_score: 5, resolved_at: _ago(25), annotation: 'Not counted. Cubs Over 8.5 outscored this pick on the same game.' }),
  _mk(102, 'MLB', 'Seattle Mariners', 'Seattle Mariners', 'Oakland Athletics'),
  _mk(105, 'MLB', 'San Diego Padres', 'San Diego Padres', 'Los Angeles Dodgers', { pick_type: 'spread', spread: 1.5 }), // outscored by Dodgers -1.5 (133), same game

  // NBA — 6
  _mk(144, 'NBA', 'Boston Celtics', 'Boston Celtics', 'Miami Heat', { pick_type: 'spread', spread: -4.5, game_status: 'in', game_period: 3, game_clock: '7:42', game_away_score: 78, game_home_score: 71 }),
  _mk(129, 'NBA', 'Los Angeles Lakers', 'Los Angeles Lakers', 'Phoenix Suns'),
  _mk(122, 'NBA', 'Denver Nuggets', 'Denver Nuggets', 'Utah Jazz', { pick_type: 'over', spread: 224.5, game_status: 'post', result: 'win', game_away_score: 118, game_home_score: 112, resolved_at: _ago(40) }),
  _mk(117, 'NBA', 'New York Knicks', 'New York Knicks', 'Philadelphia 76ers', { pick_type: 'spread', spread: 2, game_status: 'post', result: 'push', game_away_score: 108, game_home_score: 110, resolved_at: _ago(12) }),
  _mk(111, 'NBA', 'Golden State Warriors', 'Golden State Warriors', 'Sacramento Kings', { game_status: 'post', result: 'win', game_away_score: 121, game_home_score: 109, resolved_at: _ago(70) }),
  _mk(104, 'NBA', 'Milwaukee Bucks', 'Chicago Bulls', 'Milwaukee Bucks', { pick_type: 'under', spread: 219 }),
  // WNBA — 5
  _mk(140, 'WNBA', 'Las Vegas Aces', 'Las Vegas Aces', 'New York Liberty', { pick_type: 'spread', spread: -3.5, game_status: 'post', result: 'win', game_away_score: 88, game_home_score: 79, resolved_at: _ago(50) }),
  _mk(127, 'WNBA', 'New York Liberty', 'New York Liberty', 'Indiana Fever', { game_status: 'in', game_period: 2, game_clock: '4:18', game_away_score: 41, game_home_score: 38 }),
  _mk(115, 'WNBA', 'Seattle Storm', 'Seattle Storm', 'Phoenix Mercury', { pick_type: 'spread', spread: 4.5 }),
  _mk(109, 'WNBA', 'Phoenix Mercury', 'Phoenix Mercury', 'Dallas Wings', { pick_type: 'over', spread: 165.5 }),
  _mk(103, 'WNBA', 'Indiana Fever', 'Chicago Sky', 'Indiana Fever', { game_status: 'post', result: 'loss', game_away_score: 84, game_home_score: 80, resolved_at: _ago(10) }),
  // NFL — 6
  _mk(148, 'NFL', 'Kansas City Chiefs', 'Kansas City Chiefs', 'Denver Broncos', { pick_type: 'spread', spread: -3 }),
  _mk(131, 'NFL', 'Buffalo Bills', 'Buffalo Bills', 'New York Jets' ),
  _mk(124, 'NFL', 'Philadelphia Eagles', 'Dallas Cowboys', 'Philadelphia Eagles', { pick_type: 'over', spread: 47.5 }),
  _mk(119, 'NFL', 'San Francisco 49ers', 'San Francisco 49ers', 'Seattle Seahawks', { pick_type: 'spread', spread: -6.5, game_status: 'post', result: 'win', game_away_score: 27, game_home_score: 13 }),
  _mk(112, 'NFL', 'Dallas Cowboys', 'Dallas Cowboys', 'Washington Commanders', { game_status: 'in', game_period: 4, game_clock: '11:03', game_away_score: 24, game_home_score: 20 }),
  _mk(105, 'NFL', 'Baltimore Ravens', 'Baltimore Ravens', 'Pittsburgh Steelers', { pick_type: 'under', spread: 44.5 }),
  _mk(109, 'NFL', 'Philadelphia Eagles', 'Dallas Cowboys', 'Philadelphia Eagles', { pick_type: 'under', spread: 47.5 }), // outscored by the Over 47.5 (124), same game

  // NCAAF — 5
  _mk(136, 'NCAAF', 'Georgia Bulldogs', 'Georgia Bulldogs', 'Florida Gators', { pick_type: 'spread', spread: -7 }),
  _mk(125, 'NCAAF', 'Alabama Crimson Tide', 'Alabama Crimson Tide', 'Auburn Tigers' ),
  _mk(116, 'NCAAF', 'Ohio State Buckeyes', 'Ohio State Buckeyes', 'Penn State Nittany Lions', { pick_type: 'over', spread: 58.5, game_status: 'in', game_period: 2, game_clock: '3:55', game_away_score: 17, game_home_score: 14 }),
  _mk(110, 'NCAAF', 'Michigan Wolverines', 'Michigan Wolverines', 'Michigan State Spartans', { pick_type: 'spread', spread: -3.5, game_status: 'post', result: 'win', game_away_score: 31, game_home_score: 17 }),
  _mk(101, 'NCAAF', 'Texas Longhorns', 'Oklahoma Sooners', 'Texas Longhorns'),
  // CBB — 5
  _mk(134, 'CBB', 'Duke Blue Devils', 'North Carolina Tar Heels', 'Duke Blue Devils', { pick_type: 'spread', spread: -5.5 }),
  _mk(123, 'CBB', 'Gonzaga Bulldogs', 'Gonzaga Bulldogs', 'Saint Marys Gaels', { game_status: 'post', result: 'win', game_away_score: 82, game_home_score: 71 }),
  _mk(113, 'CBB', 'Kansas Jayhawks', 'Kansas Jayhawks', 'Baylor Bears', { pick_type: 'over', spread: 148 }),
  _mk(107, 'CBB', 'UConn Huskies', 'Villanova Wildcats', 'UConn Huskies', { pick_type: 'spread', spread: -8, game_status: 'in', game_period: 2, game_clock: '12:30', game_away_score: 44, game_home_score: 52 }),
  _mk(101, 'CBB', 'Purdue Boilermakers', 'Purdue Boilermakers', 'Indiana Hoosiers', { pick_type: 'spread', spread: 3.5 }),
  // NHL — 6
  _mk(138, 'NHL', 'New York Rangers', 'New York Rangers', 'New Jersey Devils'),
  _mk(128, 'NHL', 'Edmonton Oilers', 'Edmonton Oilers', 'Calgary Flames', { pick_type: 'over', spread: 6.5, game_status: 'in', game_period: 2, game_clock: '14:22', game_away_score: 3, game_home_score: 2 }),
  _mk(120, 'NHL', 'Florida Panthers', 'Florida Panthers', 'Tampa Bay Lightning', { pick_type: 'spread', spread: -1.5, game_status: 'post', result: 'loss', game_away_score: 2, game_home_score: 3, resolved_at: _ago(35) }),
  _mk(112, 'NHL', 'Colorado Avalanche', 'Colorado Avalanche', 'Vegas Golden Knights'),
  _mk(106, 'NHL', 'Toronto Maple Leafs', 'Toronto Maple Leafs', 'Montreal Canadiens', { pick_type: 'under', spread: 6 }),
  _mk(102, 'NHL', 'Vegas Golden Knights', 'Vegas Golden Knights', 'Los Angeles Kings', { game_status: 'post', result: 'win', game_away_score: 4, game_home_score: 1, resolved_at: _ago(8) }),
  // Soccer — 5, ALL graded: demos the auto-flip to the graded face
  _mk(135, 'Soccer', 'Arsenal', 'Arsenal', 'Chelsea', { game_status: 'post', result: 'win', game_away_score: 2, game_home_score: 1, resolved_at: _ago(30) }),
  _mk(121, 'Soccer', 'Real Madrid', 'Real Madrid', 'Atletico Madrid', { pick_type: 'spread', spread: -1.5, game_status: 'post', result: 'loss', game_away_score: 1, game_home_score: 1, resolved_at: _ago(75) }),
  _mk(114, 'Soccer', 'Manchester City', 'Manchester City', 'Liverpool', { pick_type: 'over', spread: 3.5, game_status: 'post', result: 'win', game_away_score: 3, game_home_score: 2, resolved_at: _ago(20) }),
  _mk(108, 'Soccer', 'Inter Milan', 'Inter Milan', 'AC Milan', { game_status: 'post', result: 'loss', game_away_score: 0, game_home_score: 1, resolved_at: _ago(120) }),
  _mk(103, 'Soccer', 'Barcelona', 'Barcelona', 'Sevilla', { game_status: 'post', result: 'win', game_away_score: 3, game_home_score: 0, resolved_at: _ago(5) }),
  // Tennis — 8 (ATP + WTA fold into one card)
  _mk(153, 'ATP', 'Carlos Alcaraz', 'Carlos Alcaraz', 'Casper Ruud', { game_status: 'in', game_period: 3, game_away_score: 1, game_home_score: 1 }),
  _mk(141, 'ATP', 'Jannik Sinner', 'Jannik Sinner', 'Daniil Medvedev' ),
  _mk(132, 'WTA', 'Iga Swiatek', 'Iga Swiatek', 'Ons Jabeur', { game_status: 'post', result: 'win', game_away_score: 2, game_home_score: 0, resolved_at: _ago(15) }),
  _mk(124, 'WTA', 'Coco Gauff', 'Coco Gauff', 'Jessica Pegula', { pick_type: 'over', spread: 21.5 }),
  _mk(117, 'ATP', 'Novak Djokovic', 'Novak Djokovic', 'Stefanos Tsitsipas', { pick_type: 'spread', spread: -3.5 }),
  _mk(111, 'WTA', 'Elena Rybakina', 'Elena Rybakina', 'Aryna Sabalenka', { game_status: 'post', result: 'win', game_away_score: 2, game_home_score: 1, resolved_at: _ago(140) }),
  _mk(106, 'ATP', 'Daniil Medvedev', 'Daniil Medvedev', 'Andrey Rublev', { game_status: 'post', result: 'loss', game_away_score: 0, game_home_score: 2, resolved_at: _ago(55) }),
  _mk(101, 'ATP', 'Alexander Zverev', 'Alexander Zverev', 'Taylor Fritz'),
];
