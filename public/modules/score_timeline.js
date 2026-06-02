// modules/score_timeline.js
// Renders the Conviction curve — the score-over-time chart on the picks tab of
// the game popup and the standalone detail page.
//
// Color tells the story: the line warms from gray to gold as the score climbs
// toward MVP, then lights up fully gold (with a soft glow) once it crosses the
// MVP threshold. Each step is marked with its delta (+10, +5, +30 ...) shown
// faintly at all times and emphasized on hover.

let timelineChart = null;

const GRAY = [100, 116, 139];   // #64748b — neutral start
const GOLD = [250, 204, 21];    // #facc15 — MVP gold

function shortTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Gray → gold ramp keyed to how close the score is to MVP. Stays grayer early
// (slight ease) then warms toward gold; pinned to gold once MVP is reached.
function heatRgb(score, threshold) {
  const ratio = Math.max(0, Math.min(1, score / threshold));
  const t = Math.pow(ratio, 1.25);
  const r = Math.round(GRAY[0] + (GOLD[0] - GRAY[0]) * t);
  const g = Math.round(GRAY[1] + (GOLD[1] - GRAY[1]) * t);
  const b = Math.round(GRAY[2] + (GOLD[2] - GRAY[2]) * t);
  return [r, g, b];
}
const rgb  = ([r, g, b], a) => a == null ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;

export function drawPickTimeline(timeline, mvpThreshold = 50, canvasId = 'pick-timeline-chart') {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }

  const hasData = Array.isArray(timeline) && timeline.length > 0;

  const points = hasData ? timeline.map(e => ({
    ts: e.ts, score: e.score, delta: e.delta, label: e.label,
  })) : [];

  const finalScore = hasData ? points[points.length - 1].score : 0;
  const isMvp      = finalScore >= mvpThreshold;
  const goldStr    = rgb(GOLD);

  // Line color. MVP → solid gold across the whole line. Otherwise a left-to-right
  // gradient that follows each point's score (gray climbing toward gold).
  const lineColor = (ctx) => {
    const { chart } = ctx;
    const area = chart.chartArea;
    if (!area) return isMvp ? goldStr : rgb(heatRgb(finalScore, mvpThreshold));
    if (isMvp) return goldStr;
    const g = chart.ctx.createLinearGradient(area.left, 0, area.right, 0);
    const n = Math.max(1, points.length - 1);
    points.forEach((p, i) => g.addColorStop(i / n, rgb(heatRgb(p.score, mvpThreshold))));
    return g;
  };

  // Soft area fill under the line, tinted to match and fading downward.
  const fillColor = (ctx) => {
    const { chart } = ctx;
    const area = chart.chartArea;
    const base = isMvp ? GOLD : heatRgb(finalScore, mvpThreshold);
    if (!area) return rgb(base, 0.14);
    const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, rgb(base, isMvp ? 0.28 : 0.20));
    g.addColorStop(1, rgb(base, 0.01));
    return g;
  };

  const dataset = hasData ? [{
    label: 'Score',
    data: points.map(p => p.score),
    borderColor: lineColor,
    backgroundColor: fillColor,
    borderWidth: isMvp ? 2.5 : 2,
    pointRadius: 4,
    pointHoverRadius: 8,
    pointBackgroundColor: ctx => rgb(heatRgb(points[ctx.dataIndex]?.score ?? 0, mvpThreshold)),
    pointBorderColor: 'rgba(11,14,20,0.9)',
    pointBorderWidth: 1.5,
    pointHoverBorderColor: '#ffffff',
    pointHoverBorderWidth: 2,
    fill: true,
    tension: 0.25,
  }] : [];

  // ── Glow plugin: wraps the dataset draw in a gold shadow once MVP is hit ──
  const glowPlugin = {
    id: 'mvpGlow',
    beforeDatasetDraw(chart) {
      if (!isMvp) return;
      const { ctx } = chart;
      ctx.save();
      ctx.shadowColor = 'rgba(250,204,21,0.55)';
      ctx.shadowBlur = 14;
    },
    afterDatasetDraw(chart) {
      if (isMvp) chart.ctx.restore();
    },
  };

  // ── Delta markers: each step's "+N" drawn above its point. Faint at rest,
  //    bigger + white + lifted when that point is hovered. ──
  const markerPlugin = {
    id: 'deltaMarkers',
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      const { ctx } = chart;
      const top = chart.chartArea.top;
      const active = new Set(chart.getActiveElements().map(a => a.index));

      meta.data.forEach((pt, i) => {
        const d = points[i]?.delta;
        if (!d || d <= 0) return;
        const on   = active.has(i);
        const text = `+${d}`;
        const off  = on ? 14 : 10;
        const above = (pt.y - off) >= top + 6;

        ctx.save();
        ctx.font = `${on ? 700 : 600} ${on ? 14 : 11}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = above ? 'bottom' : 'top';
        ctx.globalAlpha = on ? 1 : 0.6;
        ctx.fillStyle = on ? '#ffffff' : rgb(heatRgb(points[i].score, mvpThreshold));
        if (on) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 4; }
        ctx.fillText(text, pt.x, above ? pt.y - off : pt.y + off);
        ctx.restore();
      });
    },
  };

  timelineChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: hasData ? points.map(p => shortTime(p.ts)) : ['', '', '', '', ''],
      datasets: dataset,
    },
    plugins: [glowPlugin, markerPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },                       // no initial tween
      transitions: { active: { animation: { duration: 180 } } }, // subtle hover grow
      interaction: { mode: 'index', intersect: false },
      hover: { mode: 'index', intersect: false },
      layout: { padding: { top: 18 } },                 // headroom for top markers
      plugins: {
        legend: { display: false },
        tooltip: hasData ? {
          displayColors: false,
          callbacks: {
            title: () => '',
            label: item => points[item.dataIndex]?.label || '',
          },
        } : { enabled: false },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#8892a4', maxRotation: 0, autoSkipPadding: 16, font: { size: 10 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#8892a4', stepSize: 10 },
          suggestedMax: Math.max(mvpThreshold + 10, finalScore + 15),
        },
      },
    },
  });
}

export function destroyPickTimeline() {
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
}
