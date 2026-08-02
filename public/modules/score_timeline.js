// modules/score_timeline.js
// Renders the Conviction curve — the score-over-time chart on the picks tab of
// the game popup and the standalone detail page.
//
// Color tells the story: the line warms from gray to gold as the score climbs
// toward MVP, then lights up fully gold (with a soft glow) once it crosses the
// MVP threshold. Each step is marked with its delta (+10, +5, +30 ...) shown
// faintly at all times and emphasized on hover.
//
// EXACT TALLYING AND TIMING (Jack 2026-07-31). Three things were wrong for
// anyone trying to actually watch a pick:
//   - the x axis was a CATEGORY axis, so points sat at even intervals. A step
//     four hours after the last one looked identical to one twenty seconds after
//     it. The axis is now real time, so distance on the chart is elapsed time.
//   - first pitch was drawn nowhere, on any surface, so there was no way to see
//     whether a step landed while the pick was still bettable.
//   - negative deltas were skipped by the marker plugin (`if (d <= 0) return`),
//     so the one thing worth explaining — a score going DOWN — rendered as a
//     line sloping into nothing with no label on it.
// Now: true time axis, a first-pitch marker, post-start steps drawn in alarm red
// (they should not exist), and every delta labelled in both directions.

let timelineChart = null;

const GRAY = [100, 116, 139];   // #64748b — neutral start
const GOLD = [250, 204, 21];    // #facc15 — MVP gold
const ALARM = [248, 113, 113];  // #f87171 — anything that moved after first pitch

const ET = { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' };

function tsMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v);
  // SQLite stamps ('YYYY-MM-DD HH:MM:SS', UTC, no zone) need normalising or they
  // parse as local time and land hours off.
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  return new Date(iso).getTime();
}

// "7:44pm" — lowercase meridiem kept, because 7:44 alone is ambiguous on a board
// that carries morning tennis and night baseball.
function clockLabel(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString('en-US', ET).replace(' AM', 'am').replace(' PM', 'pm');
}

// Round clock ticks. Chart.js picks "nice" values for a linear scale, but on an
// epoch-ms axis "nice" means round MILLISECONDS, so the axis came out reading
// 7:29am / 11:00am / 1:46pm / 4:33pm. Snap to whole hours instead (US Eastern is
// a whole-hour offset, so UTC hour boundaries are ET hour boundaries) at a step
// that keeps roughly 4 to 6 labels across whatever span the pick covers.
const HOUR = 3600 * 1000;
const TICK_STEPS = [15 * 60 * 1000, 30 * 60 * 1000, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR];
function niceTimeTicks(min, max) {
  const span = Math.max(1, max - min);
  const step = TICK_STEPS.find(s => span / s <= 6) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const out = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) out.push({ value: t });
  return out.length ? out : [{ value: min }, { value: max }];
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

// opts.startTs — the game's first pitch (actual_start_at preferred, scheduled
// start as the fallback). Drawn as a vertical marker so every step is readable as
// before or after the pick stopped being bettable.
export function drawPickTimeline(timeline, mvpThreshold = 50, canvasId = 'pick-timeline-chart', opts = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }

  const hasData = Array.isArray(timeline) && timeline.length > 0;

  const points = hasData ? timeline.map(e => ({
    ms: tsMs(e.ts), ts: e.ts, score: e.score, delta: e.delta, label: e.label,
    cause: e.cause ?? null, kind: e.kind ?? null, postStart: !!e.postStart,
  })).filter(p => Number.isFinite(p.ms)).sort((a, b) => a.ms - b.ms) : [];

  const startMs = tsMs(opts.startTs);
  const hasStart = Number.isFinite(startMs) && points.length > 0;

  const finalScore = points.length ? points[points.length - 1].score : 0;
  const isMvp      = finalScore >= mvpThreshold;
  const goldStr    = rgb(GOLD);
  const alarmStr   = rgb(ALARM);

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

  const dataset = points.length ? [{
    label: 'Score',
    data: points.map(p => ({ x: p.ms, y: p.score })),
    borderColor: lineColor,
    backgroundColor: fillColor,
    borderWidth: isMvp ? 2.5 : 2,
    // Any leg of the line that crosses into live play is drawn in alarm red and
    // dashed. Points stop at first pitch, so a red leg is a defect, not a feature,
    // and it should be impossible to miss.
    segment: {
      borderColor: ctx => (points[ctx.p1DataIndex]?.postStart ? alarmStr : undefined),
      borderDash:  ctx => (points[ctx.p1DataIndex]?.postStart ? [4, 3] : undefined),
    },
    pointRadius: 4,
    pointHoverRadius: 8,
    pointBackgroundColor: ctx => (points[ctx.dataIndex]?.postStart
      ? alarmStr
      : rgb(heatRgb(points[ctx.dataIndex]?.score ?? 0, mvpThreshold))),
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

      // A true time axis bunches the pre-tip burst, and 11px labels on adjacent
      // points overprint into mush, so some have to be dropped. THE NUMBERS MUST
      // STILL ADD UP. Dropping a label outright (what this did first) printed
      // "+10" beside a visible fifty-point climb, because a run of five clustered
      // mentions showed the first one's delta and swallowed the other four.
      //
      // So a skipped step is not discarded, it is CARRIED: the next label printed
      // is the sum of everything since the last one. Whatever number you can see
      // the line rise by, that is the number written next to it.
      //
      // Two more rules learned the hard way:
      //   - the gap test measures the actual rendered text, not a fixed 22px. A
      //     four-character "+100" at 11px is wider than 22px, so a fixed gap let
      //     the labels it allowed collide anyway.
      //   - the label set is decided WITHOUT looking at what is hovered. Letting
      //     hover force a label in shifted every downstream decision, so numbers
      //     popped in and out as the pointer crossed the chart with no data
      //     change at all.
      const PAD = 5;
      const plan = [];
      ctx.save();
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      let carry = 0;
      let lastRight = -Infinity;
      let flip = false;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const d = p?.delta;
        if (d == null) continue;
        carry += d;
        if (carry === 0) continue;
        const pt = meta.data[i];
        if (!pt) continue;
        const text = `${carry > 0 ? '+' : ''}${carry}`;
        const half = ctx.measureText(text).width / 2;
        const forced = d < 0 || p.postStart || i === points.length - 1;
        const clear = (pt.x - half) >= lastRight + PAD;
        if (!clear && !forced) continue;          // carry it forward to the next label
        // A forced label with no room drops to the other side of the point rather
        // than printing on top of its neighbour.
        flip = forced && !clear ? !flip : false;
        plan.push({ i, text, x: pt.x, y: pt.y, half, below: flip, abnormal: d < 0 || p.postStart, score: p.score });
        lastRight = Math.max(lastRight, pt.x + half);
        carry = 0;
      }
      ctx.restore();

      const { left, right } = chart.chartArea;
      for (const L of plan) {
        // Keep the text inside the plot. The busiest cluster is right before tip,
        // so the combined label lands at the far right edge and used to render
        // half outside the frame, which is where a reader looks first.
        L.x = Math.min(Math.max(L.x, left + L.half + 1), right - L.half - 1);
        const on = active.has(L.i);
        const off = on ? 14 : 10;
        const above = !L.below && (L.y - off) >= top + 6;
        const restColor = L.abnormal ? rgb(ALARM) : rgb(heatRgb(L.score, mvpThreshold));
        ctx.save();
        ctx.font = `${on ? 700 : 600} ${on ? 14 : 11}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = above ? 'bottom' : 'top';
        ctx.globalAlpha = on ? 1 : 0.6;
        ctx.fillStyle = on ? '#ffffff' : restColor;
        if (on) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 4; }
        ctx.fillText(L.text, L.x, above ? L.y - off : L.y + off);
        ctx.restore();
      }
    },
  };

  // ── First-pitch marker: a vertical line at the moment the pick stopped being
  //    bettable. Everything left of it is the real accumulation; anything right
  //    of it should not exist. ──
  const startPlugin = {
    id: 'firstPitch',
    afterDatasetsDraw(chart) {
      if (!hasStart) return;
      const xs = chart.scales.x;
      const area = chart.chartArea;
      if (!xs || !area) return;
      const x = xs.getPixelForValue(startMs);
      if (!Number.isFinite(x) || x < area.left - 1 || x > area.right + 1) return;
      const { ctx } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(248,113,113,0.55)';
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '600 9px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(248,113,113,0.85)';
      // Bottom of the line, not the top: the curve is at its highest near first
      // pitch, so a top label lands in the same band as the delta markers.
      // Flip inside the plot when the marker sits near the right edge.
      const flip = x > area.right - 46;
      ctx.textAlign = flip ? 'right' : 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('FIRST PITCH', flip ? x - 4 : x + 4, area.bottom - 3);
      ctx.restore();
    },
  };

  // Pad the time window so the first and last points aren't glued to the frame,
  // and so the first-pitch marker stays visible when it sits past the last step.
  const lo = points.length ? points[0].ms : 0;
  const hi = points.length ? points[points.length - 1].ms : 1;
  const rightEdge = hasStart ? Math.max(hi, startMs) : hi;
  const pad = Math.max(60 * 1000, (rightEdge - lo) * 0.04);

  timelineChart = new Chart(canvas, {
    type: 'line',
    data: { datasets: dataset },
    plugins: [glowPlugin, markerPlugin, startPlugin],
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
        tooltip: points.length ? {
          displayColors: false,
          callbacks: {
            // Time first — the whole point of the curve is WHEN, and the tooltip
            // used to force an empty title and show the bare delta.
            title: items => clockLabel(points[items[0]?.dataIndex]?.ms) + ' ET',
            label: (item) => {
              const p = points[item.dataIndex];
              if (!p) return '';
              const out = [];
              // `label`/`delta` are stripped for free viewers; the running score
              // is always there, so the tooltip degrades to "84 points".
              if (p.label) out.push(`${p.label} → ${p.score} points`);
              else out.push(`${p.score} points`);
              if (p.cause) out.push(p.cause);
              if (p.postStart) out.push('after first pitch');
              return out;
            },
          },
        } : { enabled: false },
      },
      scales: {
        x: {
          // REAL TIME, not one slot per event. Distance across the chart is
          // elapsed time, so a burst of late action reads as a burst.
          type: 'linear',
          min: lo - pad,
          max: rightEdge + pad,
          grid: { display: false },
          afterBuildTicks: (axis) => { axis.ticks = niceTimeTicks(axis.min, axis.max); },
          ticks: {
            color: '#8892a4', maxRotation: 0, autoSkipPadding: 24, font: { size: 10 },
            callback: (v) => clockLabel(v),
          },
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

// Locked teaser: a synthetic "climbing to MVP" curve drawn for non-paying users
// in place of the real conviction curve. No real data ever reaches the canvas, so
// nothing leaks through the blur — and an up-and-to-the-right gold line reads as a
// strong, high-conviction pick worth unlocking. A small seed-driven jitter keeps
// different locked charts from looking identical.
export function drawLockedTeaser(canvasId = 'pick-timeline-chart', mvpThreshold = 50, seed = 0) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }

  // Deterministic PRNG so the teaser is stable for a given seed (no flicker).
  let s = (seed | 0) || 7;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  // A confident climb that crosses the MVP line and finishes high.
  const shape = [10, 16, 22, 30, 38, 47, 55, 62, 68];
  const data  = shape.map(v => Math.max(4, Math.round(v + (rnd() - 0.5) * 6)));

  const G = [250, 204, 21]; // MVP gold
  const goldStr = `rgb(${G[0]},${G[1]},${G[2]})`;
  const fillColor = (ctx) => {
    const area = ctx.chart.chartArea;
    if (!area) return `rgba(${G[0]},${G[1]},${G[2]},0.18)`;
    const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, `rgba(${G[0]},${G[1]},${G[2]},0.30)`);
    g.addColorStop(1, `rgba(${G[0]},${G[1]},${G[2]},0.01)`);
    return g;
  };

  const glowPlugin = {
    id: 'teaserGlow',
    beforeDatasetDraw(chart) { const { ctx } = chart; ctx.save(); ctx.shadowColor = 'rgba(250,204,21,0.5)'; ctx.shadowBlur = 16; },
    afterDatasetDraw(chart)  { chart.ctx.restore(); },
  };

  timelineChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.map(() => ''),
      datasets: [{
        data, borderColor: goldStr, backgroundColor: fillColor,
        borderWidth: 2.5, pointRadius: 0, fill: true, tension: 0.4,
      }],
    },
    plugins: [glowPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      events: [],                          // fully inert — no hover, no tooltip
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { grid: { display: false }, ticks: { display: false }, border: { display: false } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { display: false },
             border: { display: false }, suggestedMax: mvpThreshold + 22 },
      },
    },
  });
}

export function destroyPickTimeline() {
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
}
