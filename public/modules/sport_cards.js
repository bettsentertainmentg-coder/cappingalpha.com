// modules/sport_cards.js — "Today's CA Scores" sport-card rail (CA Rankings tab)
// A horizontally scrolling PLAYING-CARD per sport (fixed portrait size, every
// card identical). Combo layout (2026-07-21): no view flipping — each card
// stacks its LIVE, STARTING SOON, and GRADED picks in one scroll, the head
// corner carries the day record + a win/loss/live segment bar, and the footer
// keeps the CA sport profile button. A centered sport-bubble row above the
// rail jumps to a card and flags live sports.
//
// MOCK MODE (local review): open the site with ?mockrail=1 and the rail renders
// a built-in fake slate (5-10 picks per sport, every sport) instead of the live
// board — for eyeballing the design. Strip before ship if Jack prefers.

import { state } from './state.js';
import { sportBadge, scoreDisplay, pickLabel, teamNickname, PICK_HEAT_COLOR, currentBoardDate, SPORT_THEMES, flatUnitReturn, pickOddsAmerican } from './utils.js?v=5';

// Display grouping: both tennis tours share one card, like the Sports tab.
export function displaySport(sport) {
  const s = (sport || '').toUpperCase();
  if (s === 'ATP' || s === 'WTA') return 'Tennis';
  return sport || '—';
}

let _filters = { min: 100, max: null, sport: 'ALL' };
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

// ── The Combo pick row (shared by the sport cards AND the Complete Ranking) ──
// Lab anatomy: [rank] [score ring] [pick + odds / sport chip + context] [end
// cell: start time | stacked live linescore | result chip + money].
const LOCK_RING_SVG = `<svg width="12" height="14" viewBox="0 0 11 13" fill="none" aria-hidden="true"><rect x="1" y="5.5" width="9" height="7" rx="1.5" fill="#64748b"></rect><path d="M2.5 5.5V3.5a3 3 0 0 1 6 0v2" stroke="#64748b" stroke-width="1.5" stroke-linecap="round" fill="none"></path></svg>`;

function _fmtOdds(o) {
  const n = Number(o);
  if (!n || Number.isNaN(n)) return '';
  return n > 0 ? `+${n}` : `${n}`;
}
function _pickOdds(p) {
  const t = (p.pick_type || '').toLowerCase();
  // Same odds resolution as the P/L math (pickOddsAmerican): board rows keep the
  // real line in captured_ml/original_ml, not ml_odds — so the odds SHOWN on a row
  // and the money computed from them always agree.
  if (t === 'ml' || t === 'over' || t === 'under') return _fmtOdds(pickOddsAmerican(p));
  return ''; // board payloads carry no spread juice; omit rather than guess
}
function _abbrOf(name) {
  const nick = teamNickname(name) || String(name || '');
  return nick.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
}
function _stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

// Flat $10 return for a graded pick (the tracked-record unit). Delegates to the
// single P/L source of truth so the card money matches the chart to the cent.
export function caPickProfit10(p) { return flatUnitReturn(p, 10); }

export function caPickRowHtml(p, opts = {}) {
  const graded = isGraded(p);
  const live = !graded && p.game_status === 'in';
  const r = (p.result || '').toLowerCase();
  const isVoid = r === 'void' || !!(p.annotation && p.annotation.toLowerCase().includes('not counted'));
  const outscored = !!p._outscored;
  const heat = PICK_HEAT_COLOR(p.score || 0);
  const goldLine = state.CONFIG?.mvp_display_threshold || 100;

  const rowCls = 'ca-row'
    + (live ? ' live' : '')
    + (graded ? (isVoid || r === 'push' ? ' g-push' : r === 'win' ? ' g-win' : r === 'loss' ? ' g-loss' : ' g-push') : '');

  // Score ring: outcome color once graded, sky while live, heat color pre-game
  // (grey when outscored), silver/dim tiers below the gold line.
  let ringColor, numColor;
  if (opts.locked) { ringColor = '#3a4356'; numColor = '#64748b'; }
  else if (graded) {
    ringColor = r === 'win' ? 'rgba(74,222,128,0.6)' : r === 'loss' ? 'rgba(248,113,113,0.6)' : 'rgba(148,163,184,0.55)';
    numColor = r === 'win' ? '#4ade80' : r === 'loss' ? '#f87171' : '#94a3b8';
  } else if (live) { ringColor = 'rgba(56,189,248,0.7)'; numColor = '#38bdf8'; }
  else if (outscored) { ringColor = 'rgba(148,163,184,0.5)'; numColor = 'var(--muted)'; }
  else if ((p.score || 0) < 75) { ringColor = '#39415a'; numColor = '#8892a4'; }
  else if ((p.score || 0) < goldLine) { ringColor = '#a8b2c2'; numColor = '#c0c8d4'; }
  else { ringColor = heat.color.startsWith('#') ? heat.color + '90' : heat.color; numColor = heat.color; }

  const score = p.score != null ? Math.round(p.score) : '—';
  const fire = !opts.locked && !graded && !live && heat.fire && !outscored ? '<span class="ca-rail-fire">🔥</span>' : '';
  const ring = opts.locked
    ? `<span class="ca-row-ring lockr">${LOCK_RING_SVG}</span>`
    : `<span class="ca-row-ring" style="color:${numColor};border-color:${ringColor};">${score}${fire}</span>`;

  // Main: pick + odds on line 1; sport chip + context on line 2.
  const pt = (p.pick_type || '').toLowerCase();
  const isTotal = pt === 'over' || pt === 'under';
  const label = isTotal && p.team ? `${teamNickname(p.team)} ${pickLabel(p)}` : pickLabel(p);
  const odds = _pickOdds(p);
  const oddsHtml = odds ? `<span class="ca-row-odds">${odds}</span>` : '';
  let context;
  if (graded) {
    const as = p.game_away_score ?? p.away_score, hs = p.game_home_score ?? p.home_score;
    context = (as != null && hs != null) ? `Final ${as}-${hs}` : 'Final';
  } else if (isTotal && p.away_team && p.home_team) {
    context = `${teamNickname(p.away_team, p.home_team)} @ ${teamNickname(p.home_team, p.away_team)}`;
  } else {
    context = oppFor(p);
  }
  const voidNote = isVoid ? `<div class="ca-rail-void-note">${p.annotation || 'Void. Not counted in the record.'}</div>` : '';
  const outNote = outscored && !graded ? `<div class="ca-rail-void-note">Currently outscored</div>` : '';
  const main = opts.locked
    ? `<div class="ca-row-main"><div class="ca-row-l1 blurred">Members only</div><div class="ca-row-l2 blurred">${sportBadge(p.sport)}</div></div>`
    : `<div class="ca-row-main">
        <div class="ca-row-l1">${label}${oddsHtml}</div>
        <div class="ca-row-l2">${sportBadge(p.sport)}${context ? `<span>${context}</span>` : ''}</div>
        ${voidNote}${outNote}
      </div>`;

  // End cell.
  let end;
  if (opts.locked) {
    end = `<div class="ca-row-end"><span class="ca-row-time blurred">—</span></div>`;
  } else if (live) {
    const as = p.game_away_score ?? 0, hs = p.game_home_score ?? 0;
    const pair = [
      { a: p.away_abbr || _abbrOf(p.away_team), s: as },
      { a: p.home_abbr || _abbrOf(p.home_team), s: hs },
    ].sort((x, y) => y.s - x.s);
    const clock = _stripTags(scoreDisplay(p)).replace(/^\s*\d+\s*-\s*\d+\s*/, '') || 'Live';
    end = `<div class="ca-row-end ca-row-live">
      <span class="lsc">${pair[0].a} ${pair[0].s}</span>
      <span class="lsc">${pair[1].a} ${pair[1].s}</span>
      <span class="lck"><span class="ca-live-dot ca-live-dot--flash"></span>${clock}</span></div>`;
  } else if (graded) {
    const chip = (isVoid || r === 'push')
      ? `<span class="ca-res-chip p">${isVoid ? 'VOID' : 'PUSH'}</span>`
      : r === 'win' ? `<span class="ca-res-chip w">WIN</span>` : `<span class="ca-res-chip l">LOSS</span>`;
    // Money only on tracked (gold) picks — untracked board picks aren't in the record.
    let money = '';
    if (!isVoid && r !== 'push' && (p.score || 0) >= goldLine) {
      const pf = caPickProfit10(p);
      money = `<span class="ca-row-money ${pf > 0 ? 'pos' : pf < 0 ? 'neg' : ''}">${pf >= 0 ? '+' : '-'}$${Math.abs(pf).toFixed(2).replace(/\.00$/, '')}</span>`;
    }
    end = `<div class="ca-row-end ca-row-res">${chip}${money}</div>`;
  } else {
    end = `<div class="ca-row-end"><span class="ca-row-time">${_stripTags(scoreDisplay(p)) || ''}</span></div>`;
  }

  const rank = opts.rank ? `<span class="ca-row-rank${opts.rank === 1 ? ' rk1' : ''}">${opts.rank}</span>` : '';
  const click = !opts.locked && p.espn_game_id ? ` onclick="location.href='/game/${p.espn_game_id}'" style="cursor:pointer;"` : '';
  return `<div class="${rowCls}"${click}>${rank}${ring}${main}${end}</div>`;
}

function rowHtml(p) { return caPickRowHtml(p); }

const profileBtnHtml = (key) =>
  `<button class="ca-profile-btn" onclick="openSportProfile('${key}', 'all')">History &amp; profile</button>`;

// The three buckets every card stacks, in display order: LIVE, STARTING SOON
// (still ranked by score — the rail sort), GRADED (most recent final first).
function viewBuckets(card) {
  const { list } = card;
  const graded = list.filter(isGraded).sort((a, b) => _finishTs(b) - _finishTs(a));
  const open = list.filter(p => !isGraded(p));
  const live = open.filter(p => p.game_status === 'in');
  const upcoming = open.filter(p => p.game_status !== 'in');
  return { graded, live, upcoming };
}

// Graded picks that count toward a record (voids and "not counted" never do).
function _counted(graded) {
  return graded.filter(p => {
    const r = (p.result || '').toLowerCase();
    if (p.annotation && p.annotation.toLowerCase().includes('not counted')) return false;
    return r === 'win' || r === 'loss' || r === 'push';
  });
}

// Card-head corner: the day's record line in the record-bar colors (wins green,
// losses red, win% gold, ROI by sign) over a win/loss/live/pending segment bar.
// Before anything grades it reads as a signal count.
function cornerMetaHtml(card) {
  const b = viewBuckets(card);
  const counted = _counted(b.graded);
  const wins    = counted.filter(p => (p.result || '').toLowerCase() === 'win').length;
  const losses  = counted.filter(p => (p.result || '').toLowerCase() === 'loss').length;
  const decided = wins + losses;
  const segs = [
    ...b.graded.map(p => {
      const r = (p.result || '').toLowerCase();
      return `<i class="${r === 'win' ? 'w' : r === 'loss' ? 'l' : ''}"></i>`;
    }),
    ...b.live.map(() => '<i class="lv"></i>'),
    ...b.upcoming.map(() => '<i></i>'),
  ].join('');
  let line;
  if (decided) {
    const profit = counted.reduce((s, p) => s + flatUnitReturn(p, 1), 0);
    const roi = 100 * profit / decided;
    line = `<b style="color:var(--green);">${wins}</b><span class="sep">-</span><b style="color:var(--red);">${losses}</b>`
      + `<span class="sep"> · </span><b style="color:var(--gold-ink);">${Math.round(100 * wins / decided)}%</b>`
      + `<span class="sep"> · </span><b style="color:${roi >= 0 ? 'var(--green)' : 'var(--red)'};">${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI</b>`;
  } else {
    const n = card.list.length;
    line = `<b>${n}</b> signal${n === 1 ? '' : 's'} today`;
  }
  return `<div class="ca-corner"><div class="ca-corner-line">${line}</div><div class="ca-corner-bar">${segs}</div></div>`;
}

function sectionHtml(title, cls, rows) {
  if (!rows.length) return '';
  return `<div class="ca-card-eyebrow ${cls}">${title}<span class="ca-eb-rule"></span></div>` + rows.map(rowHtml).join('');
}

function bodyInner(card) {
  const b = viewBuckets(card);
  const counted = _counted(b.graded);
  const w = counted.filter(p => (p.result || '').toLowerCase() === 'win').length;
  const l = counted.filter(p => (p.result || '').toLowerCase() === 'loss').length;
  const html =
    sectionHtml(`<span class="ca-live-dot ca-live-dot--flash"></span>Live · ${b.live.length}`, 'ca-eb-sky', b.live)
    + sectionHtml('Starting soon', 'ca-eb-gold', b.upcoming)
    + sectionHtml(`Graded ${w}-${l}`, 'ca-eb-green', b.graded);
  return html || `<div class="ca-card-empty">Nothing on the board for this sport yet.</div>`;
}

function cardHtml(card) {
  const key = card.key;
  const chipSport = key === 'Tennis' ? (card.list[0]?.sport || 'ATP') : key;
  return `<div class="ca-sport-card" data-sport="${key}">
    <div class="ca-card-face">
      <div class="ca-card-head">${sportBadge(chipSport)}<div class="ca-card-meta">${cornerMetaHtml(card)}</div></div>
      <div class="ca-card-body">${bodyInner(card)}</div>
      <div class="ca-card-foot">${profileBtnHtml(key)}</div>
    </div>
  </div>`;
}

// ── Sport bubbles (centered row above the rail) ───────────────────────────────
// One gradient disc per sport card, real site badge gradients, a pulsing dot
// when that sport has a live pick, tennis-ball seams on Tennis. Tapping one
// scrolls the rail to that sport's card.
const TENNIS_SEAMS = `<svg class="ca-bub-seams" viewBox="0 0 52 52" aria-hidden="true"><path d="M15 -3 C 1 12, 1 40, 15 55"></path><path d="M37 -3 C 51 12, 51 40, 37 55"></path></svg>`;

function bubbleHtml(card) {
  const key = card.key;
  const themeKey = key === 'Tennis' ? 'ATP' : key;
  const grad = (SPORT_THEMES[themeKey] || {}).grad || 'var(--surface2)';
  const hasLive = card.list.some(p => !isGraded(p) && p.game_status === 'in');
  const label = key === 'Soccer' ? 'SOC' : key === 'Tennis' ? 'TEN' : key;
  const small = label.length > 3 ? ' ca-bub-small' : '';
  return `<button class="ca-bub" onclick="caRailScrollTo('${key}')" aria-label="Jump to ${key} card">
    <span class="ca-bub-disc${hasLive ? ' haslive' : ''}" style="background:${grad};">${key === 'Tennis' ? TENNIS_SEAMS : ''}<span class="ca-bub-label${small}">${label}</span>${hasLive ? '<span class="ca-bub-dot"></span>' : ''}</span>
    <span class="ca-bub-name">${key}</span>
  </button>`;
}

function renderSportBubbles(cards) {
  const el = document.getElementById('ca-sport-bubbles');
  if (!el) return;
  el.innerHTML = (cards || []).map(bubbleHtml).join('');
}

export function caRailScrollTo(key) {
  const rail = document.getElementById('ca-sport-rail');
  const card = rail?.querySelector(`.ca-sport-card[data-sport="${key}"]`);
  if (!rail || !card) return;
  const left = rail.scrollLeft + (card.getBoundingClientRect().left - rail.getBoundingClientRect().left) - 8;
  rail.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
}

// Re-render the rail from the current board. `filters` merges into the last-used
// set so picksUpdated re-renders keep the tab's active filters.
export function renderSportRail(filters) {
  if (filters) _filters = { ..._filters, ...filters };
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

  // "Currently outscored" mirrors the resolver's conflict rule (src/mvp.js):
  // an OPEN pick is outscored only when a CONFLICTING open pick on the same
  // game carries more points — conflicting meaning NO final score lets both
  // win. Same-team side bets never conflict (Wings ML + Wings +4.5 both cash
  // on one final — the old per-game "side" bucket wrongly greyed one), and
  // both-can-win middles (Yankees ML vs Jays +1.5, Over 5.5 vs Under 7.5)
  // never conflict either.
  const _pt  = (p) => (p.pick_type || '').toLowerCase();
  const _pl  = (p) => Number(p.spread ?? 0) || 0;
  const _mid = (lo, hi) => (Math.floor(lo) + 1) <= (Math.ceil(hi) - 1);
  const _conflicts = (a, b) => {
    const ta = _pt(a), tb = _pt(b);
    const aTot = ta === 'over' || ta === 'under', bTot = tb === 'over' || tb === 'under';
    if (aTot !== bTot) return false;
    if (aTot) {
      if (ta === tb) return false;
      const over = ta === 'over' ? a : b, under = ta === 'under' ? a : b;
      return !_mid(_pl(over), _pl(under));
    }
    const na = (a.team || '').toLowerCase(), nb = (b.team || '').toLowerCase();
    if (na && nb && na === nb) return false;
    return !_mid(-(ta === 'ml' ? 0 : _pl(a)), (tb === 'ml' ? 0 : _pl(b)));
  };
  const _gid = (p) => p.espn_game_id || `${p.away_team}@${p.home_team}`;
  const openByGame = new Map();
  for (const p of picks) {
    if (isGraded(p)) continue;
    const k = _gid(p);
    if (!openByGame.has(k)) openByGame.set(k, []);
    openByGame.get(k).push(p);
  }
  for (const p of picks) {
    p._outscored = !isGraded(p) && (openByGame.get(_gid(p)) || [])
      .some(o => o !== p && _conflicts(o, p) && (o.score || 0) > (p.score || 0));
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

  if (!cards.length) {
    const bound = max != null ? `${min ?? 0}–${max}` : `${min ?? 0}+`;
    el.innerHTML = `<div class="empty" style="flex:1;padding:26px;"><p>No ${bound} picks on the board yet today.</p></div>`;
    renderSportBubbles([]);
    return;
  }
  el.innerHTML = cards.map(cardHtml).join('');
  renderSportBubbles(cards);
  _renderRailDots(el, cards.length);
  _syncRailCentering();
}

// Pagination dots under the rail (lab: gold pill = current card). Synced via
// the rail's onscroll property so re-renders never stack listeners.
function _renderRailDots(rail, count) {
  const dots = document.getElementById('ca-rail-dots');
  if (!dots) return;
  if (count < 2) { dots.innerHTML = ''; rail.onscroll = null; return; }
  dots.innerHTML = Array.from({ length: count }, (_, i) => `<i${i === 0 ? ' class="on"' : ''}></i>`).join('');
  const sync = () => {
    const card = rail.querySelector('.ca-sport-card');
    if (!card) return;
    const ix = Math.max(0, Math.min(count - 1, Math.round(rail.scrollLeft / (card.offsetWidth + 14))));
    dots.querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i === ix));
  };
  rail.onscroll = sync;
  sync();
}

// Center the cards whenever they all fit without scrolling; left-align the
// moment they overflow (a centered flex row can't scroll back to its start).
function _syncRailCentering() {
  const el = document.getElementById('ca-sport-rail');
  if (!el) return;
  requestAnimationFrame(() => el.classList.toggle('ca-rail-center', el.scrollWidth <= el.clientWidth + 4));
}
window.addEventListener('resize', _syncRailCentering);

Object.assign(window, { caRailScrollTo });

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
