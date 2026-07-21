// modules/mvp.js — MVP tab, P/L graph

import { state } from './state.js';
import { isPaying } from './auth.js';
import { pickLabel, sportBadge, matchupLabel, scoreDisplay, teamNickname, gameTime, currentBoardDate } from './utils.js?v=4';
import { renderPicks } from './picks.js';
import { unlockCtaHtml } from './paywall.js';
import { renderSportRail, displaySport, railUsedFallback, railMockActive } from './sport_cards.js?v=20';

let mvpChart  = null;
let homeChart = null;

// ── Range key → day count ─────────────────────────────────────────────────────
// 'YD' is yesterday: the board day before the latest one, same per-pick
// rendering as 1D (both map to 1 so drawPlGraph takes the per-pick branch).
const RANGE_DAYS = { '1D': 1, 'YD': 1, '5D': 5, '7D': 7, '10D': 10, '21D': 21, '1M': 30, '3M': 90, 'ALL': Infinity };
let _currentRange     = 'ALL';
let _homeRange        = 'ALL';

// ── Rankings-tab filters (chart + record bar + sport-card rail) ───────────────
// Score range starts at the gold line (100) and can be widened/narrowed in both
// directions; the sport dropdown scopes everything to one display sport.
let _plSport  = 'ALL';
let _scoreMin = null;   // lazy-initialized to the gold line on first render
let _scoreMax = null;   // null = no upper bound

function _goldLine() {
  return state.CONFIG?.mvp_display_threshold || state.CONFIG?.mvp_threshold || 100;
}

function _passesFilters(p) {
  const s = p.score || 0;
  if (s < (_scoreMin ?? 0)) return false;
  if (_scoreMax != null && s > _scoreMax) return false;
  if (_plSport !== 'ALL' && displaySport(p.sport) !== _plSport) return false;
  return true;
}

// The board day, human-readable — the small grey text next to the rail title.
function _railDate() {
  const d = new Date(currentBoardDate() + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Custom dropdowns (timeframe / sport / score min / score max) ──────────────
// Shortest window first: the list always opens on Today / Yesterday, then walks
// out to All-Time, so every timeframe control on the site reads the same way.
const RANGE_OPTIONS = [['1D', 'Today'], ['YD', 'Yesterday'], ['5D', '5 Day'], ['7D', '7 Day'], ['10D', '10 Day'], ['21D', '21 Day'], ['1M', '1 Month'], ['3M', '3 Month'], ['ALL', 'All-Time']];
const RANGE_LABEL = Object.fromEntries(RANGE_OPTIONS);

function _ddHtml(id, which, btnLabel, optsHtml) {
  return `<div class="ca-dd" id="${id}">
    <button class="ca-dd-btn" id="${id}-btn" onclick="toggleScoreDd(event, '${which}')">${btnLabel}</button>
    <div class="ca-dd-list">${optsHtml}</div>
  </div>`;
}
function _ddOpt(which, val, label, active) {
  return `<div class="ca-dd-opt${active ? ' active' : ''}" data-val="${val}" onclick="pickDd('${which}', '${val}')">${label}</div>`;
}

// ── MVP tab loading ───────────────────────────────────────────────────────────
export async function loadMvp() {
  try {
    const res = await fetch('/api/mvp');
    // 403 = the server says this session isn't paid (e.g. an expired code grant
    // while the client still holds a non-free tier). Show the public view
    // instead of an error page — same tab a free member gets.
    if (res.status === 403) return loadMvpPublic();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.mvpData = await res.json();
    state.mvpLoadedAt = Date.now();
    renderMvpTab(state.mvpData, false);
  } catch (err) {
    console.error('[MVP] load error:', err);
    document.getElementById('mvp-tab-content').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠</div><h3>Failed to load CA pick data</h3><p style="color:#f87171;">${err.message}</p></div>`;
  }
}

// Dev-only unlock: on localhost the CA Rankings tab renders its FULL layout even
// logged out, so the tab can be reviewed unlocked on the local host. Gated to
// localhost/127.0.0.1, so prod stays paywalled exactly as before.
function _devUnlock() {
  try { return location.hostname === 'localhost' || location.hostname === '127.0.0.1'; }
  catch (_) { return false; }
}

export async function loadMvpPublic() {
  try {
    const res = await fetch('/api/mvp/public');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.mvpData = await res.json();
    state.mvpLoadedAt = Date.now();
    // Full layout when: ?mockrail=1 (mock design review) OR on localhost (dev
    // unlock). Both render the unlocked view with public data; prod stays limited.
    renderMvpTab(state.mvpData, !(railMockActive() || _devUnlock()));
  } catch (err) {
    console.error('[MVP public] load error:', err);
    document.getElementById('mvp-tab-content').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠</div><h3>Failed to load CA pick data</h3><p style="color:#f87171;">${err.message}</p></div>`;
  }
}

// ── Record computation (client-side, per range) ───────────────────────────────
function _filterByDays(picks, dayCount) {
  if (!isFinite(dayCount)) return (picks || []).slice();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - dayCount);
  const cutStr = cutoff.toISOString().slice(0, 10);
  return (picks || []).filter(p => (p.game_date || '') >= cutStr);
}

// The window a range key actually means. 1D is "the latest board day" and YD
// the one before it — NOT rolling 24h cutoffs. A rolling cutoff kept
// yesterday's whole slate in the record bar while the 1D graph plotted only
// today, so the widget said 28-13 over a 3-point line. Graph and record bar
// must both come through here.
// The anchor ignores FUTURE game_date stamps: ESPN's tennis placeholder dates
// can drift a graded row a day ahead, and one such row became "today" and
// collapsed the whole 1D graph to a single pick (Jul 20 Badosa).
function _windowedPicks(picks, rangeKey) {
  if (rangeKey === '1D' || rangeKey === 'YD') {
    const today = currentBoardDate();
    const dates = [...new Set((picks || []).map(p => p.game_date || '').filter(d => d && d <= today))].sort();
    const day = dates[dates.length - (rangeKey === '1D' ? 1 : 2)];
    return day ? picks.filter(p => p.game_date === day) : [];
  }
  return _filterByDays(picks, RANGE_DAYS[rangeKey] ?? Infinity);
}

// Resolved MVP picks that count toward the W/L/P record: decided results only,
// excluding voided / deduped ("not counted") picks. Single source of truth so the
// initial render and every timeframe toggle (home + tab) compute the same record.
function _resolvedPicks(picks) {
  return (picks || []).filter(p =>
    (p.result === 'win' || p.result === 'loss' || p.result === 'push') &&
    !(p.annotation && p.annotation.includes('not counted'))
  );
}

// Voided = a tracked pick knocked out because another pick on the same game
// outscored it (result 'void' or a "not counted" annotation). Excluded from
// W/L; surfaced as its own count on the Rankings tab bar.
function _isVoided(p) {
  return p.result === 'void' || !!(p.annotation && p.annotation.includes('not counted'));
}

// Windowed like the record bar. The 1D/YD board day anchors on the RESOLVED
// set (same day the record shows) so a voided-only latest day can't desync
// the two numbers.
function _voidedInWindow(picks, resolved, rangeKey) {
  const voided = (picks || []).filter(_isVoided);
  if (rangeKey === '1D' || rangeKey === 'YD') {
    const today = currentBoardDate();
    const dates = [...new Set((resolved || []).map(p => p.game_date || '').filter(d => d && d <= today))].sort();
    const day = dates[dates.length - (rangeKey === '1D' ? 1 : 2)];
    return day ? voided.filter(p => p.game_date === day).length : 0;
  }
  return _filterByDays(voided, RANGE_DAYS[rangeKey] ?? Infinity).length;
}

function _computeRecord(picks) {
  const wins   = picks.filter(p => p.result === 'win').length;
  const losses = picks.filter(p => p.result === 'loss').length;
  const pushes = picks.filter(p => p.result === 'push').length;
  const total  = wins + losses;
  const winRate = total > 0 ? `${Math.round(wins / total * 100)}%` : '0%';
  // ROI on money risked (decided bets, flat stakes) — unit size cancels out,
  // so a 1-unit pass matches the graph's P/L at any unit setting.
  const profit = picks.reduce((s, p) => s + calcReturn(p, 1), 0);
  const roi = total > 0 ? +(100 * profit / total).toFixed(1) : null;
  return { wins, losses, pushes, winRate, roi };
}

// `full` = the CA Rankings tab bar only: keeps Pushes and adds the Voided count
// (tracked picks outscored on their game and not counted). Compact bars
// (home widget) show Wins / Losses / Win% / ROI.
function _recordBarHtml(rec, full = false) {
  const roiStr = rec.roi == null ? '—' : `${rec.roi >= 0 ? '+' : ''}${rec.roi.toFixed(1)}%`;
  const roiCls = rec.roi == null ? '' : (rec.roi >= 0 ? 'green' : 'red');
  return `
    <div class="record-item"><div class="record-val green">${rec.wins}</div><div class="record-label">Wins</div></div>
    <div class="record-item"><div class="record-val red">${rec.losses}</div><div class="record-label">Losses</div></div>
    ${full ? `<div class="record-item"><div class="record-val">${rec.pushes}</div><div class="record-label">Pushes</div></div>` : ''}
    ${full ? `<div class="record-item" title="Tracked picks that were outscored by another pick on the same game and not counted in the record."><div class="record-val">${rec.voided ?? 0}</div><div class="record-label">Voided</div></div>` : ''}
    <div class="record-item"><div class="record-val gold">${rec.winRate}</div><div class="record-label">Win%</div></div>
    <div class="record-item"><div class="record-val ${roiCls}">${roiStr}</div><div class="record-label">ROI</div></div>
    <div style="margin-left:auto;font-size:10px;color:var(--muted);align-self:center;text-align:right;line-height:1.6;">$10 flat per pick<br>hypothetical</div>`;
}

// ── MVP tab rendering ─────────────────────────────────────────────────────────
export function renderMvpTab({ picks = [] } = {}, limited = false) {
  const container = document.getElementById('mvp-tab-content');

  // GOLD ONLY on the tracked history surface. mvp_threshold is the silver line
  // (75 under v3) and silvers must never appear there — the tracked tier is 100+.
  const goldLine = _goldLine();
  if (_scoreMin == null) _scoreMin = goldLine; // filter default: gold and up

  const graphDisclaimer = `<p class="graph-disclaimer">Hypothetical performance. CappingAlpha never wagers on any game.</p>`;

  // "Today's CA Scores": one card per sport, horizontally scrollable, rebuilt on
  // every picksUpdated so the rail stays live all day.
  const railSection = limited ? '' : `
    <div class="mvp-section-title" style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
      <span style="display:inline-flex;align-items:center;gap:5px;"><img src="/ca-logo.png" alt="CA" class="ca-pick-logo" style="margin-right:0;" onerror="this.style.display='none'">Scores</span>
      <span id="ca-rail-note" style="font-size:11px;color:var(--muted);font-weight:600;">${_railDate()}</span>
    </div>
    <div id="ca-sport-rail" class="ca-rail"></div>`;

  const upgradePrompt = limited ? `
    <div class="inline-paywall-card" style="margin-bottom:28px;">
      <h3>Follow Today's CA Rankings Live</h3>
      <p style="color:var(--muted);font-size:13px;margin:0 0 16px;">Today's games, live action, and full P/L tracking are available to subscribers.</p>
      ${unlockCtaHtml()}
    </div>` : '';

  const mvpHero = `
    <div class="mvp-tab-hero">
      <div class="mvp-tab-badge"><img src="/ca-logo.png" alt="CA" class="ca-pick-logo" onerror="this.style.display='none'">Rankings</div>
      <h2 class="mvp-tab-title">Elite Signal Tracker</h2>
      <p class="mvp-tab-desc">Picks that scored ${goldLine}+ points. Every result is tracked, wins, losses, and pushes, for full transparency.</p>
    </div>`;

  // Sport dropdown options: every display sport present in the archive or on
  // today's board (Tennis folds ATP+WTA).
  const sportSet = new Set();
  let maxScore = 120;
  for (const p of [...(picks || []), ...(state.allPicks || [])]) {
    const d = displaySport(p.sport);
    if (d && d !== '—') sportSet.add(d);
    if ((p.score || 0) > maxScore) maxScore = p.score;
  }
  const sportOptions = ['ALL', ...[...sportSet].sort()].map(s =>
    _ddOpt('sport', s, s === 'ALL' ? 'All Sports' : s, s === _plSport)).join('');

  // Timeframe dropdown (replaces the old 1D/YD/…/ALL button row).
  const rangeOptions = RANGE_OPTIONS.map(([k, l]) => _ddOpt('range', k, l, k === _currentRange)).join('');

  // Score min/max pickers: 50 → the top score in the data, steps of 10.
  const maxTick = Math.ceil(maxScore / 10) * 10;
  let minOpts = '', maxOpts = _ddOpt('max', null, 'No cap', _scoreMax == null);
  for (let v = 50; v <= maxTick; v += 10) {
    minOpts += _ddOpt('min', v, v, v === _scoreMin);
    maxOpts += _ddOpt('max', v, v, v === _scoreMax);
  }

  // Compute initial record for selected range + filters
  const resolvedAll = _resolvedPicks(picks).filter(_passesFilters);
  const barRec = _computeRecord(_windowedPicks(resolvedAll, _currentRange));
  barRec.voided = _voidedInWindow(picks.filter(_passesFilters), resolvedAll, _currentRange);

  container.innerHTML = mvpHero + `
    ${upgradePrompt}
    ${railSection}
    <div class="graph-card">
      <div class="graph-header">
        <div>
          <div class="graph-title" id="pl-label-title">ALL-TIME P/L</div>
          <div id="pl-total" class="graph-pl-label" style="margin-top:4px;">—</div>
        </div>
        <div class="pl-filter-row">
          ${_ddHtml('pl-range-dd', 'range', RANGE_LABEL[_currentRange] || 'All-Time', rangeOptions)}
          ${_ddHtml('pl-sport-dd', 'sport', _plSport === 'ALL' ? 'All Sports' : _plSport, sportOptions)}
          <div class="pl-score-range" title="Score range: 50 up to the top score, steps of 10.">
            ${_ddHtml('pl-min-dd', 'min', _scoreMin, minOpts)}
            <span>–</span>
            ${_ddHtml('pl-max-dd', 'max', _scoreMax ?? 'Max', maxOpts)}
          </div>
          <div class="unit-input-row">
            <label for="unit-size">Unit: $</label>
            <input type="number" id="unit-size" value="${parseFloat(state.CONFIG?.bet_unit) || 10}" min="1" oninput="redrawGraph()" />
          </div>
        </div>
      </div>
      <div class="graph-canvas-wrap">
        <canvas id="pl-chart"></canvas>
      </div>
      ${graphDisclaimer}
      <div class="record-bar" id="record-bar" style="border-top:1px solid rgba(255,255,255,0.06);margin-top:12px;">
        ${_recordBarHtml(barRec, true)}
      </div>
    </div>
    <div class="mvp-toggle-row">
      <button class="ca-history-toggle" onclick="toggleTodayRankings()">Today's Complete Rankings <i class="fa-solid fa-chevron-down" id="mvp-today-chev" style="font-size:10px;transition:transform .15s;"></i></button>
      <button class="ca-history-toggle" onclick="toggleMvpHistory()">View Full History <i class="fa-solid fa-chevron-down" id="mvp-history-chev" style="font-size:10px;transition:transform .15s;"></i></button>
    </div>

    <div id="mvp-today-rankings-section" style="display:none;">
      <div class="mvp-section-title" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="display:inline-flex;align-items:center;gap:5px;"><img src="/ca-logo.png" alt="CA" class="ca-pick-logo" style="margin-right:0;" onerror="this.style.display='none'">Today's Complete Rankings</span>
        <span style="margin-left:auto;font-size:11px;color:var(--muted);font-weight:400;">Every ranked pick on today's board.</span>
      </div>
      <div class="card"><div id="mvp-today-rankings-body"><div class="spinner-wrap" style="padding:20px;"><div class="spinner"></div></div></div></div>
    </div>

    <div id="mvp-history-section" style="display:none;">
      <div class="mvp-section-title" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="display:inline-flex;align-items:center;gap:5px;"><img src="/ca-logo.png" alt="CA" class="ca-pick-logo" style="margin-right:0;" onerror="this.style.display='none'">History</span>
        <span style="margin-left:auto;font-size:11px;color:var(--muted);font-weight:400;">CappingAlpha history. Rankings that scored ${goldLine}+ pts.</span>
      </div>
      <div class="mvp-history-wrap">
        <div class="card" style="border:none;border-radius:0;">
          <div id="mvp-history-body"></div>
        </div>
      </div>
    </div>`;

  refreshMvpToday();

  // Belt and suspenders: history rows must carry a real gold score. The server
  // already withholds pending pre-game rows; drop any scoreless stragglers.
  renderMvpRows(picks.filter(p => p.score != null && p.score >= goldLine), 'mvp-history-body');
  drawPlGraph(picks);
}

// Expand/collapse the full tracked-history table ("View Full History" under the
// P/L card — the day-to-day surface is the chart + sport-card rail).
export function toggleMvpHistory() {
  const sec = document.getElementById('mvp-history-section');
  const chev = document.getElementById('mvp-history-chev');
  if (!sec) return;
  const open = sec.style.display !== 'none';
  sec.style.display = open ? 'none' : '';
  if (chev) chev.style.transform = open ? '' : 'rotate(180deg)';
  if (!open) requestAnimationFrame(() => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// Expand/collapse the full today's-board ranking (same ranked list as the home
// page, via renderPicks). Re-renders on open and stays fresh on picksUpdated.
export function toggleTodayRankings() {
  const sec = document.getElementById('mvp-today-rankings-section');
  const chev = document.getElementById('mvp-today-chev');
  if (!sec) return;
  const open = sec.style.display !== 'none';
  sec.style.display = open ? 'none' : '';
  if (chev) chev.style.transform = open ? '' : 'rotate(180deg)';
  if (!open) {
    renderPicks(state.allPicks, 'mvp-today-rankings-body');
    requestAnimationFrame(() => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
}
// Keep the open ranking list live as scores climb / games go final.
document.addEventListener('picksUpdated', () => {
  const sec = document.getElementById('mvp-today-rankings-section');
  if (sec && sec.style.display !== 'none') renderPicks(state.allPicks, 'mvp-today-rankings-body');
});

// ── "Today's CA Scores" sport-card rail, rebuilt from the CURRENT board ───────
// Runs at render time AND on every picksUpdated, so the rail populates as soon
// as the board loads and stays fresh all day (scores climb, games go live and
// final) instead of freezing on whatever allPicks held at first render.
export function refreshMvpToday() {
  const rail = document.getElementById('ca-sport-rail');
  if (!rail) return; // Rankings tab not rendered (or limited view)
  renderSportRail({ min: _scoreMin ?? _goldLine(), max: _scoreMax, sport: _plSport });
  const note = document.getElementById('ca-rail-note');
  if (note) {
    note.textContent = _railDate()
      + (railMockActive() ? ' · MOCK SLATE (?mockrail=1)' : railUsedFallback() ? " · today's tracked picks" : '');
  }
}
document.addEventListener('picksUpdated', refreshMvpToday);

// ── Filter setters (sport dropdown + score range) ─────────────────────────────
// One shared pass: chart, record bar, and the sport-card rail all move together.
function _refreshFiltered() {
  if (state.mvpData) {
    drawPlGraph(state.mvpData.picks);
    const resolvedAll = _resolvedPicks(state.mvpData.picks).filter(_passesFilters);
    const rec = _computeRecord(_windowedPicks(resolvedAll, _currentRange));
    rec.voided = _voidedInWindow(state.mvpData.picks.filter(_passesFilters), resolvedAll, _currentRange);
    const barEl = document.getElementById('record-bar');
    if (barEl) barEl.innerHTML = _recordBarHtml(rec, true);
  }
  refreshMvpToday();
}

export function setPlSport(v) {
  _plSport = v || 'ALL';
  _refreshFiltered();
}

// Score min/max dropdowns. Only one list open at a time; any outside click closes.
export function toggleScoreDd(event, which) {
  if (event) event.stopPropagation();
  const target = document.getElementById(`pl-${which}-dd`);
  document.querySelectorAll('.ca-dd.open').forEach(dd => { if (dd !== target) dd.classList.remove('open'); });
  if (target) {
    target.classList.toggle('open');
    // Center the selected value in the list without scrollIntoView — that can
    // scroll the whole page along with the list. The timeframe list is the
    // exception: it always opens at the top so Today / Yesterday are the first
    // things you see. Centering there meant the default All-Time (last option)
    // opened the list scrolled to the bottom, hiding every short window.
    const list = target.querySelector('.ca-dd-list');
    const active = target.querySelector('.ca-dd-opt.active');
    if (target.classList.contains('open') && list) {
      list.scrollTop = (which === 'range' || !active)
        ? 0
        : Math.max(0, active.offsetTop - list.clientHeight / 2 + active.offsetHeight / 2);
    }
  }
}
document.addEventListener('click', () => document.querySelectorAll('.ca-dd.open').forEach(dd => dd.classList.remove('open')));

// One handler for every graph dropdown: timeframe, sport, score min, score max.
export function pickDd(which, val) {
  document.querySelectorAll('.ca-dd.open').forEach(dd => dd.classList.remove('open'));
  if (which === 'range') {
    setGraphDays(val);
  } else if (which === 'sport') {
    _plSport = val || 'ALL';
    _refreshFiltered();
  } else {
    const num = val === 'null' ? null : parseFloat(val);
    if (which === 'min') _scoreMin = num ?? 50;
    else _scoreMax = num; // null = no cap
    _refreshFiltered();
  }
  _syncDdUi();
}

// Button labels + active marks for all four dropdowns, from current state.
function _syncDdUi() {
  const setBtn = (id, label) => { const b = document.getElementById(id); if (b) b.textContent = label; };
  setBtn('pl-range-dd-btn', RANGE_LABEL[_currentRange] || 'All-Time');
  setBtn('pl-sport-dd-btn', _plSport === 'ALL' ? 'All Sports' : _plSport);
  setBtn('pl-min-dd-btn', _scoreMin);
  setBtn('pl-max-dd-btn', _scoreMax ?? 'Max');
  const mark = (ddId, val) => document.querySelectorAll(`#${ddId} .ca-dd-opt`).forEach(o =>
    o.classList.toggle('active', o.dataset.val === String(val)));
  mark('pl-range-dd', _currentRange);
  mark('pl-sport-dd', _plSport);
  mark('pl-min-dd', _scoreMin);
  mark('pl-max-dd', _scoreMax);
}

// ── MVP row rendering ─────────────────────────────────────────────────────────
export function renderMvpRow(p, i, opts = {}) {
  const rank        = i + 1;
  const resultDisplay = opts.useLiveScore ? scoreDisplay(p) : mvpResultDisplay(p);
  const isPush = p.result === 'push';
  const isVoid = _isVoided(p);
  const dimRow = isPush || isVoid;

  let pickCol;
  if (isVoid) {
    pickCol = `<span style="color:var(--muted);">${pickLabel(p)}</span> <span style="font-size:11px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;color:var(--muted);">Void</span>`;
  } else if (isPush) {
    pickCol = `<span style="color:var(--muted);">${pickLabel(p)}</span> <span style="font-size:11px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;">Push</span>`;
  } else {
    pickCol = `<span style="${p.result === 'win' ? 'color:#4ade80' : p.result === 'loss' ? 'color:#f87171' : ''}">${pickLabel(p)}</span>`;
  }

  const annotationHtml = p.annotation
    ? `<div style="font-size:11px;color:var(--muted);font-style:italic;margin-top:3px;">${p.annotation}</div>`
    : '';

  const displayThreshold = state.CONFIG?.mvp_display_threshold || state.CONFIG?.mvp_threshold || 100;
  const isGold   = (p.score || 0) >= displayThreshold;
  const rowClass = isGold ? 'mvp-row' : 'mvp-row-silver';
  const starColor = isGold ? 'var(--gold)' : '#a0aec0';
  // Rank marker. Top table: gold "#1 ★" for the top pick, number otherwise.
  // History rows get a small gold/silver tier dot — the literal "MVP" tag on
  // every single row was redundant (everything in these tables is already an MVP).
  const rankMarker = opts.showStar
    ? (rank === 1 ? `<span style="color:var(--gold);font-weight:700;white-space:nowrap;">#1 ★</span>` : `${rank}`)
    : `<span class="mvp-tier-dot" style="color:${starColor};font-size:0.7em;">●</span>`;

  // Clicking a row opens the full game detail page (live for today's games,
  // snapshot-backed for historical MVP picks).
  const clickable = !!p.espn_game_id;
  const clickAttr = clickable
    ? ` class="${rowClass} mvp-row-click" style="cursor:pointer;${dimRow ? 'opacity:0.45;' : ''}" onclick="location.href='/game/${p.espn_game_id}'"`
    : ` class="${rowClass}" style="${dimRow ? 'opacity:0.45;' : ''}"`;

  return `
    <tr${clickAttr}>
      <td class="rank">${rankMarker}</td>
      <td class="matchup-cell">${matchupLabel(p)}${resultDisplay}${annotationHtml}</td>
      <td>${sportBadge(p.sport)}</td>
      <td class="pick-cell">${pickCol}</td>
      <td style="${dimRow ? 'color:var(--muted);' : ''}">${p.score ?? '—'}</td>
    </tr>`;
}

export function renderMvpRows(picks, targetId, opts = {}) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (!picks || picks.length === 0) {
    el.innerHTML = `<div class="empty"><p>No picks recorded yet.</p></div>`;
    return;
  }
  const rows = picks.map((p, i) => renderMvpRow(p, i, opts)).join('');
  const rankHeader = opts.showStar ? 'Rank' : '';
  el.innerHTML = `<table><thead><tr><th>${rankHeader}</th><th>Matchup</th><th>Sport</th><th>Pick</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderMvpPicks(picks) {
  renderMvpRows(picks, 'mvp-history-body');
}

export function mvpResultDisplay(p) {
  const r    = (p.result || 'pending').toLowerCase();
  const away = p.away_score ?? null;
  const home = p.home_score ?? null;
  const score = (away !== null && home !== null) ? `${away}-${home} Final` : null;
  const dateTag = p.game_date ? `<span style="font-size:0.8em;color:#8892a4;margin-left:5px;font-weight:400;">${p.game_date}</span>` : '';

  if (r === 'win')  return `<span style="font-size:0.88em;font-weight:600;color:#4ade80;margin-left:8px;">${score || 'Win'}${dateTag}</span>`;
  if (r === 'loss') return `<span style="font-size:0.88em;font-weight:700;color:#f87171;margin-left:8px;">${score || 'Loss'}${dateTag}</span>`;
  if (r === 'push') return `<span style="font-size:0.88em;font-weight:600;color:#8892a4;margin-left:8px;">${score || 'Push'}${dateTag}</span>`;
  return `<span style="font-size:0.75em;color:#8892a4;margin-left:8px;">Pending</span>`;
}

// ── Single-day series: realization moments ────────────────────────────────────
// 1D/YD plot by GAME END — the moment the game finalized and the picks were
// graded. Every pick from one game realizes on ONE point (they cash together
// when it ends), points ordered by resolved_at. This grouping is THE single-day
// P/L rule for every CA P/L graph on the site (Rankings tab, home widget, the
// sidebar #1 card) so they all tell the same story. Rows graded before
// resolved_at existed fall back to saved_at ordering with a generic label.
function _resolvedTs(p) {
  const parse = (s) => { if (!s) return NaN; const str = String(s); return Date.parse(str.includes('T') ? str : str.replace(' ', 'T') + 'Z'); };
  const t = parse(p.resolved_at);
  return Number.isNaN(t) ? parse(p.saved_at) : t;
}

export function gameEndGroups(dayPicks, unit, calc = calcReturn) {
  const groups = new Map();
  for (const p of dayPicks) {
    const key = p.espn_game_id || `${p.game_date || ''}|${p.team || ''}|${p.pick_type || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const arr = [...groups.values()].map(picks => {
    const stamps = picks.map(_resolvedTs).filter(t => !Number.isNaN(t));
    return {
      picks,
      ts: stamps.length ? Math.min(...stamps) : NaN,
      hasEnd: picks.some(p => p.resolved_at),
      gamePL: +picks.reduce((s, p) => s + calc(p, unit), 0).toFixed(2),
    };
  }).sort((a, b) => ((Number.isNaN(a.ts) ? 0 : a.ts) - (Number.isNaN(b.ts) ? 0 : b.ts)));
  let cum = 0;
  for (const g of arr) { cum = +(cum + g.gamePL).toFixed(2); g.cumPL = cum; }
  return arr;
}

function _gameEndLabel(g, i) {
  return (g.hasEnd && !Number.isNaN(g.ts)) ? gameTime(g.ts) : `Game ${i + 1}`;
}

// Shared tooltip callbacks for the single-day (per-game) chart.
// One tooltip pick-row: label + P/L, tagged with result so the HTML tooltip can
// color it (win green, loss red, push/void grey — same font, colored).
function _tipItem(p, unit) {
  const r = (p.result || '').toLowerCase();
  const ret = calcReturn(p, unit);
  const pt = (p.pick_type || '').toLowerCase();
  const label = (pt === 'over' || pt === 'under') ? `${teamNickname(p.team)} ${pickLabel(p)}` : pickLabel(p);
  return { text: `${label}  ·  ${ret >= 0 ? '+' : ''}$${ret.toFixed(2)}`, result: r };
}

function _gameEndTooltip(unit) {
  return {
    title: (items, data) => {
      const d = data[items[0].dataIndex];
      const wins   = d.picks.filter(p => p.result === 'win').length;
      const losses = d.picks.filter(p => p.result === 'loss').length;
      const head = matchupLabel(d.picks[0]) || pickLabel(d.picks[0]);
      return `${head}  ·  ${wins}W ${losses}L`;
    },
    afterTitle: (items, data) => {
      const d = data[items[0].dataIndex];
      const when = (d.hasEnd && !Number.isNaN(d.ts)) ? `Final ${gameTime(d.ts)}  ·  ` : '';
      return `${when}Game P/L: ${d.gamePL >= 0 ? '+' : ''}$${d.gamePL.toFixed(2)}  ·  Running: $${d.cumPL.toFixed(2)}`;
    },
    itemsAt: (d) => d.picks.map(p => _tipItem(p, unit)),
  };
}

// ── P/L calculation ───────────────────────────────────────────────────────────
function calcReturn(pick, unit) {
  const r = (pick.result || '').toLowerCase();
  if (r === 'push' || r === 'pending' || !r) return 0;
  if (r === 'loss') return -unit;
  const type = (pick.pick_type || '').toLowerCase();
  let odds;
  if (type === 'ml') {
    odds = pick.ml_odds || null;
  } else if (type === 'over' || type === 'under') {
    odds = pick.ou_odds || -115;
  } else {
    odds = -115;
  }
  if (!odds) odds = -115;
  if (odds < 0) return +(unit * (100 / Math.abs(odds))).toFixed(2);
  return +(unit * (odds / 100)).toFixed(2);
}

// ── MVP tab P/L graph ─────────────────────────────────────────────────────────
export function drawPlGraph(picks) {
  const unit = parseFloat(document.getElementById('unit-size')?.value) || parseFloat(state.CONFIG?.bet_unit) || 10;

  const resolved = (picks || [])
    .filter(p => (p.result === 'win' || p.result === 'loss' || p.result === 'push')
      && _passesFilters(p)
      && !(p.annotation && p.annotation.includes('not counted')))
    .sort((a, b) => (a.saved_at || a.game_date || '').localeCompare(b.saved_at || b.game_date || ''));

  const plLabel = document.getElementById('pl-total');
  if (resolved.length === 0) {
    if (plLabel) { plLabel.textContent = '$0.00'; plLabel.className = 'graph-pl-label'; }
    return;
  }

  const days = RANGE_DAYS[_currentRange] ?? Infinity;

  // ── 1D / YD: realization display for a single board day (starts at $0) ────
  // One point per GAME, plotted at the moment the game ended and its picks
  // graded — several picks on one game all cash on that single point.
  if (days === 1) {
    // Same window as the record bar — a board day by game_date, never "the
    // game_date of the most recently saved row" (a late-graded pick from
    // yesterday can be the newest save).
    const todayPicks = _windowedPicks(resolved, _currentRange);
    const displayData = gameEndGroups(todayPicks, unit);

    const windowPL = +(todayPicks.reduce((s, p) => s + calcReturn(p, unit), 0)).toFixed(2);
    _updatePlLabel(plLabel, windowPL);
    const titleEl = document.getElementById('pl-label-title');
    if (titleEl) titleEl.textContent = _currentRange === 'YD' ? "YESTERDAY'S P/L" : "TODAY'S P/L";

    const lineColor = windowPL >= 0 ? '#4ade80' : '#f87171';
    _drawChart('pl-chart', mvpChart, (c) => { mvpChart = c; }, {
      labels:    displayData.map(_gameEndLabel),
      values:    displayData.map(d => d.cumPL),
      lineColor,
      unit,
      tooltip:   _gameEndTooltip(unit),
      displayData,
    });
    return;
  }

  // ── Multi-day: window first (same window as the record bar), then accumulate
  // from $0 — each timeframe restarts at zero; picks outside it are not carried in.
  const windowed = _filterByDays(resolved, days);
  if (windowed.length === 0) {
    if (plLabel) { plLabel.textContent = '$0.00'; plLabel.className = 'graph-pl-label'; }
    _drawChart('pl-chart', mvpChart, (c) => { mvpChart = c; }, { labels: [], values: [], lineColor: '#4ade80', unit, tooltip: { title: null, afterTitle: null, afterBody: null }, displayData: [] });
    return;
  }

  const byDate = {};
  for (const p of windowed) {
    const d = p.game_date || 'unknown';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(p);
  }

  const allDates = Object.keys(byDate).sort();
  let cumulative = 0, totalPicks = 0;
  const displayData = allDates.map(d => {
    const dayPicks = byDate[d];
    const dayPL = dayPicks.reduce((sum, p) => sum + calcReturn(p, unit), 0);
    cumulative += dayPL;
    totalPicks += dayPicks.length;
    return { date: d, picks: dayPicks, dayPL: +dayPL.toFixed(2), cumPL: +cumulative.toFixed(2), totalPicks };
  });

  const labels = displayData.map(d => {
    const dt = new Date(d.date + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  const windowPL = +(displayData.reduce((sum, d) => sum + d.dayPL, 0)).toFixed(2);
  _updatePlLabel(plLabel, windowPL);
  const titleEl = document.getElementById('pl-label-title');
  if (titleEl) {
    titleEl.textContent = !isFinite(days) ? 'ALL-TIME P/L' : `${_currentRange} P/L`;
  }

  const lineColor = windowPL >= 0 ? '#4ade80' : '#f87171';
  // Show the per-day pick breakdown in the tooltip for every range, including
  // 3M and ALL (each chart point is one day, so the day's picks are available).
  const useDetailedTooltip = true;

  _drawChart('pl-chart', mvpChart, (c) => { mvpChart = c; }, {
    labels,
    values:    displayData.map(d => d.cumPL),
    lineColor,
    unit,
    tooltip: {
      title:      (items, data) => { const d = data[items[0].dataIndex]; const wins = d.picks.filter(p => p.result === 'win').length; const losses = d.picks.filter(p => p.result === 'loss').length; return `${items[0].label}  ·  ${wins}W ${losses}L`; },
      afterTitle: (items, data) => { const d = data[items[0].dataIndex]; return `Day P/L: ${d.dayPL >= 0 ? '+' : ''}$${d.dayPL.toFixed(2)}  ·  Total: $${d.cumPL.toFixed(2)}`; },
      itemsAt: (d) => d.picks.map(p => _tipItem(p, unit)),
    },
    displayData,
  });
}

function _updatePlLabel(el, dollarPL) {
  if (!el) return;
  el.textContent = (dollarPL >= 0 ? '+' : '') + '$' + dollarPL.toFixed(2);
  el.className   = 'graph-pl-label ' + (dollarPL >= 0 ? 'pos' : 'neg');
}

// ── Crosshair (ThinkOrSwim style) ─────────────────────────────────────────────
// Press or touch a chart and drag: a full-height light-blue line follows the
// pointer and PARKS on the point where you let go, tooltip pinned to it. The
// next press moves it. Shared with the History popup via window.caCrosshair.
const caCrosshair = {
  id: 'caCrosshair',
  afterDatasetsDraw(chart) {
    const idx = chart.$caParkIdx;
    if (idx == null) return;
    const pt = chart.getDatasetMeta(0)?.data?.[idx];
    if (!pt) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.strokeStyle = 'rgba(125,211,252,0.85)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pt.x, chartArea.top);
    ctx.lineTo(pt.x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function attachCrosshair(chart) {
  const canvas = chart.canvas;
  canvas.style.touchAction = 'none'; // dragging the chart drives the line, not the page
  let dragging = false;
  const setIdx = (evt) => {
    const els = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, true);
    if (!els.length) return;
    const idx = els[0].index;
    chart.$caParkIdx = idx;
    const active = [{ datasetIndex: 0, index: idx }];
    chart.setActiveElements(active);
    chart.tooltip.setActiveElements(active, { x: els[0].element.x, y: els[0].element.y });
    chart.update('none');
  };
  canvas.addEventListener('pointerdown', (e) => { dragging = true; setIdx(e); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) setIdx(e); });
  const end = () => { dragging = false; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', end);
}
Object.assign(window, { caCrosshair, caAttachCrosshair: attachCrosshair });

// ── Shared interactive HTML tooltip for every P/L chart ───────────────────────
// Canvas tooltips can't fade a row, color rows individually, cap+expand, or be
// clicked — so all P/L charts (tab, home, profile popups) use this one HTML
// tooltip. A chart sets chart.$caTip[dataIndex] = { title, sub, items:[{text,
// result}] }. Shows up to 3 rows; a 4th+ fades the 3rd and adds a "+N more"
// arrow. Hover previews; clicking a point (or "+N more") pins it open + expanded.
let _caTipEl = null, _caTipPin = null, _caTipHover = false;

function _caTipDom() {
  if (_caTipEl) return _caTipEl;
  const el = document.createElement('div');
  el.id = 'ca-cht-tip';
  el.addEventListener('mouseenter', () => { _caTipHover = true; });
  el.addEventListener('mouseleave', () => { _caTipHover = false; if (!_caTipPin) _hideCaTip(); });
  el.addEventListener('click', (e) => {
    if (e.target.closest('.ca-tip-more') && _caTipPin) _renderCaTip(_caTipPin.chart, _caTipPin.index, true);
  });
  document.body.appendChild(el);
  _caTipEl = el;
  return el;
}
// Hidden = fully OUT of layout (display:none + parked off-page). A position:
// absolute tooltip left sitting at a wide offset silently extends the page's
// scroll width, which shifted/off-centered the whole page and could scroll the
// sport-card rail out of view.
function _hideCaTip() {
  if (!_caTipEl) return;
  _caTipEl.style.opacity = '0';
  _caTipEl.style.pointerEvents = 'none';
  _caTipEl.style.display = 'none';
  _caTipEl.style.left = '-9999px';
  _caTipEl.style.top = '-9999px';
}
// Reset on every chart (re)draw so a pin/hover referencing a now-destroyed chart
// can't wedge the tooltip or throw. Shared with the profile popup via window.
function caResetTip() { _caTipPin = null; _caTipHover = false; _hideCaTip(); }

function _renderCaTip(chart, index, expanded) {
  const el = _caTipDom();
  try {
    const d = chart && chart.$caTip && chart.$caTip[index];
    const canvas = chart && chart.canvas;
    const meta = canvas && chart.getDatasetMeta(0) && chart.getDatasetMeta(0).data[index];
    if (!d || !canvas || !meta) { _hideCaTip(); return; }
    const RES = { win: 'var(--green)', loss: 'var(--red)', push: 'var(--muted)', void: 'var(--muted)' };
    const items = d.items || [];
    const showAll = expanded || items.length <= 3;
    const shown = showAll ? items : items.slice(0, 3);
    const rows = shown.map((it, i) => {
      const fade = (!showAll && i === 2) ? 'opacity:.4;' : '';
      const col = RES[(it.result || '').toLowerCase()] || 'var(--text)';
      return `<div class="ca-tip-row" style="color:${col};${fade}">${it.text}</div>`;
    }).join('');
    const more = (!showAll && items.length > 3)
      ? `<div class="ca-tip-more">+${items.length - 3} more <i class="fa-solid fa-chevron-down" style="font-size:9px;"></i></div>` : '';
    el.innerHTML = `<div class="ca-tip-title">${d.title || ''}</div>`
      + (d.sub ? `<div class="ca-tip-sub">${d.sub}</div>` : '')
      + (rows ? `<div class="ca-tip-rows">${rows}</div>` : '') + more;
    el.style.display = 'block';
    el.style.opacity = '1';
    el.style.pointerEvents = 'auto';
    const box = canvas.getBoundingClientRect();
    const px = box.left + window.scrollX + meta.x;
    const py = box.top + window.scrollY + meta.y;
    el.style.left = (px + 14) + 'px';
    el.style.top = (py - 10) + 'px';
    const r = el.getBoundingClientRect();
    // Keep fully within the viewport horizontally so it never extends the page.
    if (r.right > window.innerWidth - 8) el.style.left = Math.max(window.scrollX + 8, px - r.width - 14) + 'px';
    if (r.bottom > window.innerHeight - 8) el.style.top = Math.max(window.scrollY + 8, py - r.height - 10) + 'px';
  } catch (_) { _hideCaTip(); }
}

// Chart.js external tooltip: preview on hover (3-cap) unless a click has pinned it.
function caChartTip(context) {
  const { chart, tooltip } = context;
  if (_caTipPin) return;
  if (!tooltip || tooltip.opacity === 0) {
    setTimeout(() => { if (!_caTipHover && !_caTipPin) _hideCaTip(); }, 80);
    return;
  }
  const dp = tooltip.dataPoints && tooltip.dataPoints[0];
  if (!dp) return;
  _renderCaTip(chart, dp.dataIndex, false);
}

// Click a point → pin open + expanded. Outside click unpins.
function caChartClick(evt, els, chart) {
  if (els && els.length) { _caTipPin = { chart, index: els[0].index }; _renderCaTip(chart, els[0].index, true); }
  else if (_caTipPin) { _caTipPin = null; _hideCaTip(); }
}
document.addEventListener('click', (e) => {
  if (_caTipPin && !e.target.closest('#ca-cht-tip') && e.target.tagName !== 'CANVAS') { _caTipPin = null; _hideCaTip(); }
});

// Build the per-point tip data ({title, sub, items}) from a chart's displayData
// + its tooltip spec ({title, afterTitle, itemsAt}). Shared by tab + home + popup.
function buildCaTip(displayData, tooltip, labels) {
  tooltip = tooltip || {};
  return (displayData || []).map((d, i) => {
    const synth = [{ dataIndex: i, label: labels ? labels[i] : '' }];
    return {
      title: tooltip.title ? tooltip.title(synth, displayData) : (labels ? labels[i] : ''),
      sub: tooltip.afterTitle ? tooltip.afterTitle(synth, displayData) : '',
      items: tooltip.itemsAt ? tooltip.itemsAt(d) : [],
    };
  });
}

Object.assign(window, { caChartTip, caChartClick, buildCaTip, caResetTip });

// ── Shared chart renderer ─────────────────────────────────────────────────────
function _drawChart(canvasId, existingChart, setChart, { labels, values, lineColor, unit, tooltip, displayData }) {
  caResetTip(); // drop any tooltip pinned to the chart we're about to destroy
  if (existingChart) { existingChart.destroy(); }
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const yCallback = v => (v >= 0 ? '+' : '') + '$' + v.toFixed(0);

  const chart = new Chart(ctx, {
    type: 'line',
    plugins: [caCrosshair],
    data: {
      labels,
      datasets: [{
        label: 'Cumulative P/L',
        data: values,
        borderColor: lineColor,
        backgroundColor: lineColor + '18',
        borderWidth: 2, pointRadius: 4, fill: true, tension: 0.3,
        // Clear highlight on the hovered bubble (bigger + white ring).
        pointHoverRadius: 7, pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2,
        pointHoverBackgroundColor: lineColor,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick: (e, els) => caChartClick(e, els, chart),
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false, external: caChartTip },
      },
      scales: {
        x: { ticks: { color: '#8892a4', font: { size: 11 }, maxTicksLimit: 12 }, grid: { color: '#252c3b' } },
        y: { ticks: { color: '#8892a4', callback: yCallback }, grid: { color: '#252c3b' } },
      },
    },
  });
  chart.$caTip = buildCaTip(displayData, tooltip, labels);
  attachCrosshair(chart);
  setChart(chart);
}

// ── MVP tab range / mode setters ──────────────────────────────────────────────
export function setGraphDays(key) {
  _currentRange    = key;
  state.graphDays  = RANGE_DAYS[key] ?? Infinity;

  const btn = document.getElementById('pl-range-dd-btn');
  if (btn) btn.textContent = RANGE_LABEL[key] || 'All-Time';

  if (state.mvpData) {
    drawPlGraph(state.mvpData.picks);
    // Update record bar for this range (same sport/score filters as the chart)
    const resolvedAll = _resolvedPicks(state.mvpData.picks).filter(_passesFilters);
    const rec = _computeRecord(_windowedPicks(resolvedAll, key));
    rec.voided = _voidedInWindow(state.mvpData.picks.filter(_passesFilters), resolvedAll, key);
    const barEl = document.getElementById('record-bar');
    if (barEl) barEl.innerHTML = _recordBarHtml(rec, true);
  }
}

export function redrawGraph() {
  if (state.mvpData) drawPlGraph(state.mvpData.picks);
}

// ── Home page MVP widget ──────────────────────────────────────────────────────
export async function loadHomeMvp() {
  try {
    const endpoint = isPaying() ? '/api/mvp' : '/api/mvp/public';
    const res = await fetch(endpoint);
    if (!res.ok) return;
    const { picks, record } = await res.json();
    if (!picks) return;

    state.homeMvpPicks = picks;

    const section = document.getElementById('home-mvp-section');
    if (!section) return;
    section.style.display = '';

    // Compute initial record (ALL range)
    const initRec = _computeRecord(_resolvedPicks(picks));

    // MVP P/L graph lives in #home-mvp-section; the ranked picks table lives in
    // its own #home-picks-card so the two can be ordered independently on phones.
    section.innerHTML = `
      <div class="graph-card">
        <div class="graph-header">
          <div>
            <div class="graph-title" id="home-pl-title">ALL-TIME P/L</div>
            <div id="home-pl-total" class="graph-pl-label" style="margin-top:4px;">—</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
            <div class="graph-range-row">
              ${RANGE_OPTIONS.map(([k]) =>
                `<button class="graph-range-btn home-range-btn${k === _homeRange ? ' active' : ''}" data-key="${k}" onclick="setHomeGraphDays('${k}')">${k}</button>`).join('')}
            </div>
            <div style="font-size:11px;color:var(--muted);text-align:right;line-height:1.5;max-width:160px;">Top-tier CA picks tracked, win/loss logged for every one.</div>
          </div>
        </div>
        <div class="graph-canvas-wrap" style="height:150px;">
          <canvas id="home-pl-chart"></canvas>
        </div>
        <div class="record-bar" id="home-record-bar" style="border-top:1px solid rgba(255,255,255,0.06);padding:12px 20px;">
          ${_recordBarHtml(initRec)}
        </div>
      </div>`;

    const picksCard = document.getElementById('home-picks-card');
    if (picksCard) {
      picksCard.innerHTML = `
        <div class="card">
          <div class="card-header">
            <span class="card-title">Today's Rankings</span>
            <span style="font-size:11px;color:var(--muted);">Ranked by edge vs. bookmaker odds</span>
          </div>
          <div id="home-picks-body">
            <div class="spinner-wrap" style="padding:20px;"><div class="spinner"></div></div>
          </div>
        </div>`;
    }

    renderPicks(state.allPicks, 'home-picks-body');
    document.addEventListener('picksUpdated', () => renderPicks(state.allPicks, 'home-picks-body'));
    drawHomeGraph(picks);
  } catch (err) {
    console.error('[home-mvp] load error:', err);
  }
}

function drawHomeGraph(picks) {
  const unit = parseFloat(document.getElementById('home-unit-size')?.value) || parseFloat(state.CONFIG?.bet_unit) || 10;
  const days = RANGE_DAYS[_homeRange] ?? Infinity;

  const resolved = (picks || [])
    .filter(p => (p.result === 'win' || p.result === 'loss' || p.result === 'push')
      && (p.score || 0) >= (state.CONFIG?.mvp_display_threshold || 100)
      && !(p.annotation && p.annotation.includes('not counted')))
    .sort((a, b) => (a.saved_at || a.game_date || '').localeCompare(b.saved_at || b.game_date || ''));

  const plLabel = document.getElementById('home-pl-total');
  if (resolved.length === 0) {
    if (plLabel) { plLabel.textContent = '$0.00'; plLabel.className = 'graph-pl-label'; }
    return;
  }

  if (days === 1) {
    // Same realization rule as the Rankings tab: one point per game at its end.
    // 1D and YD both land here (both map to 1 day) — pass the live key so YD
    // anchors on yesterday's board day instead of today's.
    const todayPicks = _windowedPicks(resolved, _homeRange);
    const displayData = gameEndGroups(todayPicks, unit);
    const windowPL = +(todayPicks.reduce((s, p) => s + calcReturn(p, unit), 0)).toFixed(2);
    _updateHomePlLabel(plLabel, windowPL);
    const titleEl = document.getElementById('home-pl-title');
    if (titleEl) titleEl.textContent = _homeRange === 'YD' ? "YESTERDAY'S P/L" : "TODAY'S P/L";
    _drawChart('home-pl-chart', homeChart, (c) => { homeChart = c; }, {
      labels: displayData.map(_gameEndLabel),
      values: displayData.map(d => d.cumPL),
      lineColor: windowPL >= 0 ? '#4ade80' : '#f87171',
      unit,
      tooltip: _gameEndTooltip(unit),
      displayData,
    });
    return;
  }

  // Window first (same window as the record bar), then accumulate from $0.
  const windowed = _filterByDays(resolved, days);
  if (windowed.length === 0) {
    if (plLabel) { plLabel.textContent = '$0.00'; plLabel.className = 'graph-pl-label'; }
    _drawChart('home-pl-chart', homeChart, (c) => { homeChart = c; }, { labels: [], values: [], lineColor: '#4ade80', unit, tooltip: { title: null, afterTitle: null, afterBody: null }, displayData: [] });
    return;
  }

  const byDate = {};
  for (const p of windowed) { const d = p.game_date || 'unknown'; if (!byDate[d]) byDate[d] = []; byDate[d].push(p); }
  const allDates = Object.keys(byDate).sort();
  let cumulative = 0, totalPicks = 0;
  const displayData = allDates.map(d => {
    const dayPicks = byDate[d];
    const dayPL = dayPicks.reduce((sum, p) => sum + calcReturn(p, unit), 0);
    cumulative += dayPL; totalPicks += dayPicks.length;
    return { date: d, picks: dayPicks, dayPL: +dayPL.toFixed(2), cumPL: +cumulative.toFixed(2), totalPicks };
  });

  const labels = displayData.map(d => {
    const dt = new Date(d.date + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  const windowPL = +(displayData.reduce((sum, d) => sum + d.dayPL, 0)).toFixed(2);

  _updateHomePlLabel(plLabel, windowPL);
  const titleEl = document.getElementById('home-pl-title');
  if (titleEl) titleEl.textContent = !isFinite(days) ? 'ALL-TIME P/L' : `${_homeRange} P/L`;

  _drawChart('home-pl-chart', homeChart, (c) => { homeChart = c; }, {
    labels,
    values:    displayData.map(d => d.cumPL),
    lineColor: windowPL >= 0 ? '#4ade80' : '#f87171',
    unit,
    tooltip: {
      title:      (items, data) => { const d = data[items[0].dataIndex]; const wins = d.picks.filter(p=>p.result==='win').length; const losses = d.picks.filter(p=>p.result==='loss').length; return `${items[0].label}  ·  ${wins}W ${losses}L`; },
      afterTitle: (items, data) => { const d = data[items[0].dataIndex]; return `Day: ${d.dayPL>=0?'+':''}$${d.dayPL.toFixed(2)}  ·  Total: $${d.cumPL.toFixed(2)}`; },
      itemsAt: (d) => d.picks.map(p => _tipItem(p, unit)),
    },
    displayData,
  });
}

function _updateHomePlLabel(el, dollarPL) {
  if (!el) return;
  el.textContent = (dollarPL >= 0 ? '+' : '') + '$' + dollarPL.toFixed(2);
  el.className   = 'graph-pl-label ' + (dollarPL >= 0 ? 'pos' : 'neg');
}

export function setHomeGraphDays(key) {
  _homeRange = key;
  document.querySelectorAll('.home-range-btn').forEach(b => b.classList.toggle('active', b.dataset.key === key));
  if (state.homeMvpPicks) {
    drawHomeGraph(state.homeMvpPicks);
    // Update home record bar
    const filtered = _windowedPicks(_resolvedPicks(state.homeMvpPicks), key);
    const rec = _computeRecord(filtered);
    const barEl = document.getElementById('home-record-bar');
    if (barEl) barEl.innerHTML = _recordBarHtml(rec);
  }
}

export function redrawHomeGraph() {
  if (state.homeMvpPicks) drawHomeGraph(state.homeMvpPicks);
}

Object.assign(window, {
  setGraphDays, redrawGraph,
  setHomeGraphDays, redrawHomeGraph,
  setPlSport, pickDd, toggleScoreDd, toggleMvpHistory, toggleTodayRankings,
});
