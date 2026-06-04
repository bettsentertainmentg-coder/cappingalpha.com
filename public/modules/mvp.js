// modules/mvp.js — MVP tab, P/L graph

import { state } from './state.js';
import { isPaying } from './auth.js';
import { pickLabel, sportBadge, matchupLabel, scoreDisplay, teamNickname } from './utils.js';
import { renderPicks } from './picks.js';

let mvpChart  = null;
let homeChart = null;

// ── Range key → day count ─────────────────────────────────────────────────────
const RANGE_DAYS = { '1D': 1, '5D': 5, '7D': 7, '21D': 21, '1M': 30, '3M': 90, 'ALL': Infinity };
let _currentRange     = 'ALL';
let _homeRange        = 'ALL';

// ── MVP tab loading ───────────────────────────────────────────────────────────
export async function loadMvp() {
  try {
    const res = await fetch('/api/mvp');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.mvpData = await res.json();
    renderMvpTab(state.mvpData, false);
  } catch (err) {
    console.error('[MVP] load error:', err);
    document.getElementById('mvp-tab-content').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠</div><h3>Failed to load MVP data</h3><p style="color:#f87171;">${err.message}</p></div>`;
  }
}

export async function loadMvpPublic() {
  try {
    const res = await fetch('/api/mvp/public');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.mvpData = await res.json();
    renderMvpTab(state.mvpData, true);
  } catch (err) {
    console.error('[MVP public] load error:', err);
    document.getElementById('mvp-tab-content').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠</div><h3>Failed to load MVP data</h3><p style="color:#f87171;">${err.message}</p></div>`;
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

// Resolved MVP picks that count toward the W/L/P record: decided results only,
// excluding voided / deduped ("not counted") picks. Single source of truth so the
// initial render and every timeframe toggle (home + tab) compute the same record.
function _resolvedPicks(picks) {
  return (picks || []).filter(p =>
    (p.result === 'win' || p.result === 'loss' || p.result === 'push') &&
    !(p.annotation && p.annotation.includes('not counted'))
  );
}

function _computeRecord(picks) {
  const wins   = picks.filter(p => p.result === 'win').length;
  const losses = picks.filter(p => p.result === 'loss').length;
  const pushes = picks.filter(p => p.result === 'push').length;
  const total  = wins + losses;
  const winRate = total > 0 ? `${Math.round(wins / total * 100)}%` : '0%';
  return { wins, losses, pushes, winRate };
}

function _recordBarHtml(rec, limited) {
  return `
    <div class="record-item"><div class="record-val green">${rec.wins}</div><div class="record-label">Wins</div></div>
    <div class="record-item"><div class="record-val red">${rec.losses}</div><div class="record-label">Losses</div></div>
    <div class="record-item"><div class="record-val">${rec.pushes}</div><div class="record-label">Pushes</div></div>
    <div class="record-item"><div class="record-val gold">${rec.winRate}</div><div class="record-label">Win%</div></div>
    ${limited ? '' : `<div class="record-item"><div class="record-val">${rec.pending ?? ''}</div><div class="record-label">Active</div></div>`}
    <div style="margin-left:auto;font-size:10px;color:var(--muted);align-self:center;text-align:right;line-height:1.6;">$10 flat per pick<br>hypothetical</div>`;
}

// ── MVP tab rendering ─────────────────────────────────────────────────────────
export function renderMvpTab({ picks = [], record = { wins: 0, losses: 0, pushes: 0, pending: 0, win_rate: '0%' } } = {}, limited = false) {
  const container = document.getElementById('mvp-tab-content');

  const liveMvpPicks = state.allPicks.filter(p => p.game_status === 'in' && (p.score || 0) >= state.CONFIG.mvp_threshold);

  const graphDisclaimer = `<p class="graph-disclaimer">Hypothetical performance. CappingAlpha never wagers on any game.</p>`;

  const liveTodaySections = limited ? '' : `
    ${liveMvpPicks.length > 0 ? `
      <div class="mvp-section-title">Live MVP Games</div>
      <div class="card" style="margin-bottom:24px;">
        <div id="mvp-live-body"></div>
      </div>
    ` : ''}
    <div class="mvp-section-title">Today's MVPs</div>
    <div class="card" style="margin-bottom:24px;">
      <div id="mvp-today-body"></div>
    </div>`;

  const upgradePrompt = limited ? `
    <div class="inline-paywall-card" style="margin-bottom:28px;">
      <h3>Follow Today's MVP Picks Live</h3>
      <p style="color:var(--muted);font-size:13px;margin:0 0 16px;">Today's games, live action, and full P/L tracking are available to subscribers.</p>
      <div class="paywall-pricing-row">
        <div class="paywall-price-card" onclick="startCheckout('day')">
          <div class="paywall-price">$1</div>
          <div class="paywall-price-label">Day</div>
        </div>
        <div class="paywall-price-card paywall-price-featured" onclick="startCheckout('week')">
          <div class="paywall-price">$4</div>
          <div class="paywall-price-label">/week</div>
        </div>
        <div class="paywall-price-card" onclick="startCheckout('year')">
          <div class="paywall-price">$75</div>
          <div class="paywall-price-label">/year</div>
        </div>
      </div>
      <div class="inline-paywall-login">Already have access? <a onclick="openLogin()">Log in</a> &nbsp;&middot;&nbsp; <a onclick="openSignup()">Sign up free</a></div>
    </div>` : '';

  const mvpHero = `
    <div class="mvp-tab-hero">
      <div class="mvp-tab-badge">MVP Picks</div>
      <h2 class="mvp-tab-title">Elite Signal Tracker</h2>
      <p class="mvp-tab-desc">Picks that scored ${state.CONFIG?.mvp_display_threshold || state.CONFIG?.mvp_threshold || 50}+ points. Every result is tracked, wins, losses, and pushes, for full transparency.</p>
    </div>`;

  // Compute initial record for selected range
  const filteredForBar = _filterByDays(_resolvedPicks(picks), RANGE_DAYS[_currentRange] ?? Infinity);
  const barRec = _computeRecord(filteredForBar);
  if (!limited) barRec.pending = record.pending;

  container.innerHTML = mvpHero + `
    <div class="graph-card">
      <div class="graph-header">
        <div>
          <div class="graph-title" id="pl-label-title">ALL-TIME P/L</div>
          <div id="pl-total" class="graph-pl-label" style="margin-top:4px;">—</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div class="graph-range-row">
            <button class="graph-range-btn mvp-range-btn" data-key="1D"  onclick="setGraphDays('1D')">1D</button>
            <button class="graph-range-btn mvp-range-btn" data-key="5D"  onclick="setGraphDays('5D')">5D</button>
            <button class="graph-range-btn mvp-range-btn" data-key="7D"  onclick="setGraphDays('7D')">7D</button>
            <button class="graph-range-btn mvp-range-btn" data-key="21D" onclick="setGraphDays('21D')">21D</button>
            <button class="graph-range-btn mvp-range-btn" data-key="1M"  onclick="setGraphDays('1M')">1M</button>
            <button class="graph-range-btn mvp-range-btn" data-key="3M"  onclick="setGraphDays('3M')">3M</button>
            <button class="graph-range-btn mvp-range-btn active" data-key="ALL" onclick="setGraphDays('ALL')">ALL</button>
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
        ${_recordBarHtml(barRec, limited)}
      </div>
    </div>

    ${upgradePrompt}
    ${liveTodaySections}

    <div class="mvp-section-title">MVP Pick History</div>
    <div class="mvp-history-wrap">
      <div class="card" style="border:none;border-radius:0;">
        <div id="mvp-history-body"></div>
      </div>
    </div>`;

  if (liveMvpPicks.length > 0) {
    renderMvpRows(liveMvpPicks, 'mvp-live-body', { useLiveScore: true });
  }

  const todayMvps = state.allPicks
    .filter(p => (p.score || 0) >= state.CONFIG.mvp_threshold)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  if (todayMvps.length === 0) {
    const el = document.getElementById('mvp-today-body');
    if (el) el.innerHTML = `<div class="empty" style="padding:24px;"><p>No MVP picks today yet.</p></div>`;
  } else {
    renderMvpRows(todayMvps, 'mvp-today-body', { useLiveScore: true, showStar: true });
  }

  renderMvpRows(picks, 'mvp-history-body');
  drawPlGraph(picks);
}

// ── MVP row rendering ─────────────────────────────────────────────────────────
export function renderMvpRow(p, i, opts = {}) {
  const rank        = i + 1;
  const resultDisplay = opts.useLiveScore ? scoreDisplay(p) : mvpResultDisplay(p);
  const isPush = p.result === 'push';
  const isVoid = p.result === 'void' || !!(p.annotation && p.annotation.includes('not counted'));
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

  const displayThreshold = state.CONFIG?.mvp_display_threshold || state.CONFIG?.mvp_threshold || 50;
  const isGold   = (p.score || 0) >= displayThreshold;
  const rowClass = isGold ? 'mvp-row' : 'mvp-row-silver';
  const starColor = isGold ? 'var(--gold)' : '#a0aec0';
  // Rank marker. Top table: star for #1, number otherwise. History rows get a
  // small gold/silver tier dot — the literal "MVP" tag on every single row was
  // redundant (everything in these tables is already an MVP). Keep the gold.
  const rankMarker = opts.showStar
    ? (rank === 1 ? `<span style="color:${starColor};">★</span>` : `${rank}`)
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
    el.innerHTML = `<div class="empty"><p>No MVP picks recorded yet.</p></div>`;
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
      && (p.score || 0) >= (state.CONFIG.mvp_threshold || 50)
      && !(p.annotation && p.annotation.includes('not counted')))
    .sort((a, b) => (a.saved_at || a.game_date || '').localeCompare(b.saved_at || b.game_date || ''));

  const plLabel = document.getElementById('pl-total');
  if (resolved.length === 0) {
    if (plLabel) { plLabel.textContent = '$0.00'; plLabel.className = 'graph-pl-label'; }
    return;
  }

  const days = RANGE_DAYS[_currentRange] ?? Infinity;

  // ── 1D: per-pick display for the latest day (already starts at $0) ────────
  if (days === 1) {
    const latestDate = resolved[resolved.length - 1].game_date;
    const todayPicks = resolved.filter(p => p.game_date === latestDate);
    let cum = 0;
    const displayData = todayPicks.map(p => {
      const ret = calcReturn(p, unit);
      cum = +(cum + ret).toFixed(2);
      return { pick: p, ret, cumPL: cum };
    });

    const windowPL = +(todayPicks.reduce((s, p) => s + calcReturn(p, unit), 0)).toFixed(2);
    _updatePlLabel(plLabel, windowPL);
    const titleEl = document.getElementById('pl-label-title');
    if (titleEl) titleEl.textContent = "TODAY'S P/L";

    const lineColor = windowPL >= 0 ? '#4ade80' : '#f87171';
    _drawChart('pl-chart', mvpChart, (c) => { mvpChart = c; }, {
      labels:    displayData.map((_, i) => `Pick ${i + 1}`),
      values:    displayData.map(d => d.cumPL),
      lineColor,
      unit,
      tooltip: {
        title:      (items, data) => { const d = data[items[0].dataIndex]; const r = (d.pick.result || '').toLowerCase(); return `${r === 'win' ? '✓' : r === 'loss' ? '✗' : '~'} ${pickLabel(d.pick)}`; },
        afterTitle: (items, data) => { const d = data[items[0].dataIndex]; return `${d.ret >= 0 ? '+' : ''}$${d.ret.toFixed(2)}  ·  Running: $${d.cumPL.toFixed(2)}`; },
        afterBody:  null,
      },
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
  const useDetailedTooltip = ['1D','5D','7D','21D','1M'].includes(_currentRange);

  _drawChart('pl-chart', mvpChart, (c) => { mvpChart = c; }, {
    labels,
    values:    displayData.map(d => d.cumPL),
    lineColor,
    unit,
    tooltip: {
      title:      (items, data) => { const d = data[items[0].dataIndex]; const wins = d.picks.filter(p => p.result === 'win').length; const losses = d.picks.filter(p => p.result === 'loss').length; return `${items[0].label}  ·  ${wins}W ${losses}L`; },
      afterTitle: (items, data) => { const d = data[items[0].dataIndex]; return `Day P/L: ${d.dayPL >= 0 ? '+' : ''}$${d.dayPL.toFixed(2)}  ·  Total: $${d.cumPL.toFixed(2)}`; },
      afterBody:  useDetailedTooltip ? (items, data) => {
        const d = data[items[0].dataIndex];
        return d.picks.map(p => {
          const r   = (p.result || '').toLowerCase();
          const ret = calcReturn(p, unit);
          const icon = r === 'win' ? '✓' : r === 'loss' ? '✗' : '~';
          const pt   = (p.pick_type || '').toLowerCase();
          const label = (pt === 'over' || pt === 'under') ? `${teamNickname(p.team)} ${pickLabel(p)}` : pickLabel(p);
          return `  ${icon} ${label}  ·  ${r === 'win' ? '+' : ''}$${ret.toFixed(2)}`;
        });
      } : null,
    },
    displayData,
  });
}

function _updatePlLabel(el, dollarPL) {
  if (!el) return;
  el.textContent = (dollarPL >= 0 ? '+' : '') + '$' + dollarPL.toFixed(2);
  el.className   = 'graph-pl-label ' + (dollarPL >= 0 ? 'pos' : 'neg');
}

// ── Shared chart renderer ─────────────────────────────────────────────────────
function _drawChart(canvasId, existingChart, setChart, { labels, values, lineColor, unit, tooltip, displayData }) {
  if (existingChart) { existingChart.destroy(); }
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const yCallback = v => (v >= 0 ? '+' : '') + '$' + v.toFixed(0);

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative P/L',
        data: values,
        borderColor: lineColor,
        backgroundColor: lineColor + '18',
        borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, fill: true, tension: 0.3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e2330', borderColor: '#252c3b', borderWidth: 1,
          titleColor: '#e2e8f0', bodyColor: '#8892a4', padding: 12,
          callbacks: {
            title:      items => tooltip.title      ? tooltip.title(items, displayData)      : items[0].label,
            afterTitle: items => tooltip.afterTitle ? tooltip.afterTitle(items, displayData) : undefined,
            label:      ()    => null,
            afterBody:  tooltip.afterBody
              ? items => tooltip.afterBody(items, displayData)
              : undefined,
          },
        },
      },
      scales: {
        x: { ticks: { color: '#8892a4', font: { size: 11 }, maxTicksLimit: 12 }, grid: { color: '#252c3b' } },
        y: { ticks: { color: '#8892a4', callback: yCallback }, grid: { color: '#252c3b' } },
      },
    },
  });
  setChart(chart);
}

// ── MVP tab range / mode setters ──────────────────────────────────────────────
export function setGraphDays(key) {
  _currentRange    = key;
  state.graphDays  = RANGE_DAYS[key] ?? Infinity;

  document.querySelectorAll('.mvp-range-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.key === key);
  });

  if (state.mvpData) {
    drawPlGraph(state.mvpData.picks);
    // Update record bar for this range
    const filtered = _filterByDays(_resolvedPicks(state.mvpData.picks), RANGE_DAYS[key] ?? Infinity);
    const rec = _computeRecord(filtered);
    const barEl = document.getElementById('record-bar');
    const limited = !isPaying();
    if (barEl) barEl.innerHTML = _recordBarHtml(rec, limited);
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
              <button class="graph-range-btn home-range-btn" data-key="1M"  onclick="setHomeGraphDays('1M')">1M</button>
              <button class="graph-range-btn home-range-btn" data-key="3M"  onclick="setHomeGraphDays('3M')">3M</button>
              <button class="graph-range-btn home-range-btn active" data-key="ALL" onclick="setHomeGraphDays('ALL')">ALL</button>
            </div>
            <div style="font-size:11px;color:var(--muted);text-align:right;line-height:1.5;max-width:160px;">${state.CONFIG?.mvp_display_threshold || state.CONFIG?.mvp_threshold || 50}+ pt picks tracked, win/loss logged for every one.</div>
          </div>
        </div>
        <div class="graph-canvas-wrap" style="height:150px;">
          <canvas id="home-pl-chart"></canvas>
        </div>
        <div class="record-bar" id="home-record-bar" style="border-top:1px solid rgba(255,255,255,0.06);padding:12px 20px;">
          ${_recordBarHtml(initRec, true)}
        </div>
      </div>`;

    const picksCard = document.getElementById('home-picks-card');
    if (picksCard) {
      picksCard.innerHTML = `
        <div class="card">
          <div class="card-header">
            <span class="card-title">Today's Picks</span>
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
      && (p.score || 0) >= (state.CONFIG.mvp_threshold || 50)
      && !(p.annotation && p.annotation.includes('not counted')))
    .sort((a, b) => (a.saved_at || a.game_date || '').localeCompare(b.saved_at || b.game_date || ''));

  const plLabel = document.getElementById('home-pl-total');
  if (resolved.length === 0) {
    if (plLabel) { plLabel.textContent = '$0.00'; plLabel.className = 'graph-pl-label'; }
    return;
  }

  if (days === 1) {
    const latestDate = resolved[resolved.length - 1].game_date;
    const todayPicks = resolved.filter(p => p.game_date === latestDate);
    let cum = 0;
    const displayData = todayPicks.map(p => {
      const ret = calcReturn(p, unit); cum = +(cum + ret).toFixed(2);
      return { pick: p, ret, cumPL: cum };
    });
    const windowPL = +(todayPicks.reduce((s, p) => s + calcReturn(p, unit), 0)).toFixed(2);
    _updateHomePlLabel(plLabel, windowPL);
    const titleEl = document.getElementById('home-pl-title');
    if (titleEl) titleEl.textContent = "TODAY'S P/L";
    _drawChart('home-pl-chart', homeChart, (c) => { homeChart = c; }, {
      labels: displayData.map((_, i) => `Pick ${i + 1}`),
      values: displayData.map(d => d.cumPL),
      lineColor: windowPL >= 0 ? '#4ade80' : '#f87171',
      unit,
      tooltip: { title: (items, data) => { const d = data[items[0].dataIndex]; const r = (d.pick.result||'').toLowerCase(); return `${r==='win'?'✓':r==='loss'?'✗':'~'} ${pickLabel(d.pick)}`; }, afterTitle: (items, data) => { const d = data[items[0].dataIndex]; return `${d.ret>=0?'+':''}$${d.ret.toFixed(2)}  ·  Running: $${d.cumPL.toFixed(2)}`; }, afterBody: null },
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
      afterBody: (items, data) => {
        const d = data[items[0].dataIndex];
        return d.picks.map(p => {
          const r    = (p.result || '').toLowerCase();
          const ret  = calcReturn(p, unit);
          const icon = r === 'win' ? '✓' : r === 'loss' ? '✗' : '~';
          const pt   = (p.pick_type || '').toLowerCase();
          const label = (pt === 'over' || pt === 'under') ? `${teamNickname(p.team)} ${pickLabel(p)}` : pickLabel(p);
          return `  ${icon} ${label}  ·  ${r === 'win' ? '+' : ''}$${ret.toFixed(2)}`;
        });
      },
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
    const filtered = _filterByDays(_resolvedPicks(state.homeMvpPicks), RANGE_DAYS[key] ?? Infinity);
    const rec = _computeRecord(filtered);
    const barEl = document.getElementById('home-record-bar');
    if (barEl) barEl.innerHTML = _recordBarHtml(rec, true);
  }
}

export function redrawHomeGraph() {
  if (state.homeMvpPicks) drawHomeGraph(state.homeMvpPicks);
}

Object.assign(window, {
  setGraphDays, redrawGraph,
  setHomeGraphDays, redrawHomeGraph,
});
