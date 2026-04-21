// modules/mvp.js — MVP tab, P/L graph

import { state } from './state.js';
import { isPaying } from './auth.js';
import { pickLabel, sportBadge, matchupLabel, scoreDisplay, teamNickname } from './utils.js';

let mvpChart = null;

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

// ── MVP tab rendering ─────────────────────────────────────────────────────────
export function renderMvpTab({ picks = [], record = { wins: 0, losses: 0, pushes: 0, pending: 0, win_rate: '0%' } } = {}, limited = false) {
  const container = document.getElementById('mvp-tab-content');

  const liveMvpPicks = state.allPicks.filter(p => p.game_status === 'in' && (p.score || 0) >= state.CONFIG.mvp_threshold);

  const graphDisclaimer = `<p class="graph-disclaimer">Hypothetical performance — CappingAlpha never wagers on any game.</p>`;

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
      <p class="mvp-tab-desc">Picks that scored ${state.CONFIG?.mvp_display_threshold || state.CONFIG?.mvp_threshold || 50}+ points across our verified analyst network. Every result is tracked — wins, losses, pushes — for full transparency. No cherry-picking.</p>
    </div>`;

  container.innerHTML = mvpHero + `
    <div class="graph-card">
      <div class="graph-header">
        <div>
          <div class="graph-title" id="pl-label-title">ALL-TIME P/L</div>
          <div id="pl-total" class="graph-pl-label" style="margin-top:4px;">—</div>
        </div>
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          <div class="graph-range-row">
            <button class="graph-range-btn"        data-days="1"        onclick="setGraphDays(1)">1D</button>
            <button class="graph-range-btn"        data-days="7"        onclick="setGraphDays(7)">7D</button>
            <button class="graph-range-btn active" data-days="30"       onclick="setGraphDays(30)">30D</button>
            <button class="graph-range-btn"        data-days="90"       onclick="setGraphDays(90)">90D</button>
            <button class="graph-range-btn"        data-days="Infinity" onclick="setGraphDays(Infinity)">All</button>
          </div>
          <div class="unit-input-row">
            <label for="unit-size">Unit: $</label>
            <input type="number" id="unit-size" value="20" min="1" oninput="redrawGraph()" />
          </div>
        </div>
      </div>
      <div class="graph-canvas-wrap">
        <canvas id="pl-chart"></canvas>
      </div>
      ${graphDisclaimer}
    </div>

    <div class="card" style="margin-bottom:24px;">
      <div class="record-bar" id="record-bar">
        <div class="record-item"><div class="record-val green">${record.wins}</div><div class="record-label">Wins</div></div>
        <div class="record-item"><div class="record-val red">${record.losses}</div><div class="record-label">Losses</div></div>
        <div class="record-item"><div class="record-val">${record.pushes}</div><div class="record-label">Pushes</div></div>
        <div class="record-item"><div class="record-val gold">${record.win_rate}</div><div class="record-label">Win Rate</div></div>
        ${limited ? '' : `<div class="record-item"><div class="record-val">${record.pending}</div><div class="record-label">Pending</div></div>`}
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
  const rankContent = opts.showStar ? (rank === 1 ? '★ ' : rank + ' ') : '';
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
  const rowClass = (p.score || 0) >= displayThreshold ? 'mvp-row' : 'mvp-row-silver';

  return `
    <tr class="${rowClass}" style="${dimRow ? 'opacity:0.45;' : ''}">
      <td class="rank">${rankContent}<span class="badge-mvp" style="font-size:0.6em;vertical-align:middle;">MVP</span></td>
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

// ── P/L graph ─────────────────────────────────────────────────────────────────
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

export function drawPlGraph(picks) {
  const unit = parseFloat(document.getElementById('unit-size')?.value) || 20;

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

  if (state.graphDays === 1) {
    const latestDate = resolved[resolved.length - 1].game_date;
    const todayPicks = resolved.filter(p => p.game_date === latestDate);
    let cum = 0;
    const displayData = todayPicks.map(p => {
      const ret = calcReturn(p, unit);
      cum = +(cum + ret).toFixed(2);
      return { pick: p, ret, cumPL: cum };
    });

    const windowPL = +(todayPicks.reduce((s, p) => s + calcReturn(p, unit), 0)).toFixed(2);
    if (plLabel) {
      plLabel.textContent = (windowPL >= 0 ? '+' : '') + '$' + windowPL.toFixed(2);
      plLabel.className   = 'graph-pl-label ' + (windowPL >= 0 ? 'pos' : 'neg');
    }
    const titleEl = document.getElementById('pl-label-title');
    if (titleEl) titleEl.textContent = "TODAY'S P/L";

    const lineColor = windowPL >= 0 ? '#4ade80' : '#f87171';
    if (mvpChart) { mvpChart.destroy(); mvpChart = null; }
    const ctx = document.getElementById('pl-chart');
    if (!ctx) return;

    mvpChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: displayData.map((_, i) => `Pick ${i + 1}`),
        datasets: [{
          label: 'Cumulative P/L',
          data: displayData.map(d => d.cumPL),
          borderColor: lineColor,
          backgroundColor: lineColor + '18',
          borderWidth: 2, pointRadius: 5, pointHoverRadius: 7, fill: true, tension: 0.2,
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
              title: items => {
                const d = displayData[items[0].dataIndex];
                const r = (d.pick.result || '').toLowerCase();
                const icon = r === 'win' ? '✓' : r === 'loss' ? '✗' : '~';
                return `${icon} ${pickLabel(d.pick)}`;
              },
              afterTitle: items => {
                const d = displayData[items[0].dataIndex];
                return `${d.ret >= 0 ? '+' : ''}$${d.ret.toFixed(2)}  ·  Running: $${d.cumPL.toFixed(2)}`;
              },
              label: () => null,
            },
          },
        },
        scales: {
          x: { ticks: { color: '#8892a4', font: { size: 11 } }, grid: { color: '#252c3b' } },
          y: { ticks: { color: '#8892a4', callback: v => (v >= 0 ? '+' : '') + '$' + v.toFixed(0) }, grid: { color: '#252c3b' } },
        },
      },
    });
    return;
  }

  const byDate = {};
  for (const p of resolved) {
    const d = p.game_date || 'unknown';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(p);
  }

  const allDates = Object.keys(byDate).sort();
  let cumulative = 0;
  const allDailyData = allDates.map(d => {
    const dayPicks = byDate[d];
    const dayPL = dayPicks.reduce((sum, p) => sum + calcReturn(p, unit), 0);
    cumulative += dayPL;
    return { date: d, picks: dayPicks, dayPL: +dayPL.toFixed(2), cumPL: +cumulative.toFixed(2) };
  });

  const displayData = isFinite(state.graphDays) ? allDailyData.slice(-state.graphDays) : allDailyData;
  const labels = displayData.map(d => {
    const dt = new Date(d.date + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  const data = displayData.map(d => d.cumPL);

  const windowPL = +(displayData.reduce((sum, d) => sum + d.dayPL, 0)).toFixed(2);
  if (plLabel) {
    plLabel.textContent = (windowPL >= 0 ? '+' : '') + '$' + windowPL.toFixed(2);
    plLabel.className   = 'graph-pl-label ' + (windowPL >= 0 ? 'pos' : 'neg');
  }

  const titleEl = document.getElementById('pl-label-title');
  if (titleEl) {
    if (!isFinite(state.graphDays)) titleEl.textContent = 'ALL-TIME P/L';
    else titleEl.textContent = `${state.graphDays}-DAY P/L`;
  }

  const lineColor = windowPL >= 0 ? '#4ade80' : '#f87171';
  if (mvpChart) { mvpChart.destroy(); mvpChart = null; }
  const ctx = document.getElementById('pl-chart');
  if (!ctx) return;

  mvpChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative P/L',
        data,
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
            title: items => {
              const d = displayData[items[0].dataIndex];
              const wins   = d.picks.filter(p => p.result === 'win').length;
              const losses = d.picks.filter(p => p.result === 'loss').length;
              return `${items[0].label}  —  ${wins}W ${losses}L`;
            },
            afterTitle: items => {
              const d = displayData[items[0].dataIndex];
              return `Day P/L: ${d.dayPL >= 0 ? '+' : ''}$${d.dayPL.toFixed(2)}  ·  Total: $${d.cumPL.toFixed(2)}`;
            },
            label: () => null,
            afterBody: items => {
              const d = displayData[items[0].dataIndex];
              return d.picks.map(p => {
                const r   = (p.result || '').toLowerCase();
                const ret = calcReturn(p, unit);
                const icon = r === 'win' ? '✓' : r === 'loss' ? '✗' : '~';
                const pt = (p.pick_type || '').toLowerCase();
                const label = (pt === 'over' || pt === 'under') ? `${teamNickname(p.team)} ${pickLabel(p)}` : pickLabel(p);
                return `  ${icon} ${label} — ${r === 'win' ? '+' : ''}$${ret.toFixed(2)}`;
              });
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#8892a4', font: { size: 11 }, maxTicksLimit: 12 }, grid: { color: '#252c3b' } },
        y: { ticks: { color: '#8892a4', callback: v => (v >= 0 ? '+' : '') + '$' + v.toFixed(0) }, grid: { color: '#252c3b' } },
      },
    },
  });
}

export function redrawGraph() {
  if (state.mvpData) drawPlGraph(state.mvpData.picks);
}

export function setGraphDays(days) {
  state.graphDays = days === 'Infinity' ? Infinity : Number(days);
  document.querySelectorAll('.graph-range-btn').forEach(b => {
    const d = b.dataset.days === 'Infinity' ? Infinity : Number(b.dataset.days);
    b.classList.toggle('active', d === state.graphDays);
  });
  if (state.mvpData) drawPlGraph(state.mvpData.picks);
}

// ── Home page MVP section ─────────────────────────────────────────────────────
export async function loadHomeMvp() {
  try {
    const res = await fetch('/api/mvp/public');
    if (!res.ok) return;
    const { picks, record } = await res.json();
    if (!picks || picks.length === 0) return;

    const section = document.getElementById('home-mvp-section');
    if (!section) return;
    section.style.display = '';

    const recEl = document.getElementById('home-mvp-record');
    if (recEl) {
      recEl.innerHTML = `
        <div class="record-item"><div class="record-val green">${record.wins}</div><div class="record-label">Wins</div></div>
        <div class="record-item"><div class="record-val red">${record.losses}</div><div class="record-label">Losses</div></div>
        <div class="record-item"><div class="record-val">${record.pushes}</div><div class="record-label">Pushes</div></div>
        <div class="record-item"><div class="record-val gold">${record.win_rate}</div><div class="record-label">Win Rate</div></div>`;
    }

    renderMvpRows(picks, 'home-mvp-body');
  } catch (err) {
    console.error('[home-mvp] load error:', err);
  }
}

Object.assign(window, { setGraphDays, redrawGraph });
