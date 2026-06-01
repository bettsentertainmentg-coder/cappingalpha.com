// modules/score_timeline.js
// Renders the score-over-time stock chart shown on the picks tab of the game popup.
// Tooltip shows only the delta (e.g. "+30"). No explanation, no formula.

let timelineChart = null;

function shortTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function drawPickTimeline(timeline, mvpThreshold = 50, canvasId = 'pick-timeline-chart') {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }

  const hasData = Array.isArray(timeline) && timeline.length > 0;

  const points = hasData ? timeline.map(e => ({
    ts: e.ts, score: e.score, delta: e.delta, label: e.label,
  })) : [];

  const finalScore = hasData ? points[points.length - 1].score : 0;
  const lineColor  = finalScore >= mvpThreshold ? '#facc15' : '#4ade80';

  const dataset = hasData ? [{
    label: 'Score',
    data: points.map(p => p.score),
    borderColor: lineColor,
    backgroundColor: lineColor + '22',
    borderWidth: 2,
    pointRadius: 4,
    pointHoverRadius: 6,
    fill: true,
    tension: 0.25,
  }] : [];

  timelineChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: hasData ? points.map(p => shortTime(p.ts)) : ['', '', '', '', ''],
      datasets: dataset,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
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
          suggestedMax: Math.max(mvpThreshold + 10, finalScore + 10),
        },
      },
    },
  });
}

export function destroyPickTimeline() {
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
}
