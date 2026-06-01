// public/modules/gauge.js
// CappingAlpha signature gauge — solid half-disc with a dynamic gradient
// transition that follows the %, a small outlined arrow needle, a big
// leading-% read-out below the pivot, and a quoted editorial classification
// tag. Matte card framing — no radial highlights.
//
// Pure render: takes options, returns HTML string. No DOM access, no fetches.
//
// Usage:
//   import { cappingGauge } from '/modules/gauge.js';
//   container.innerHTML = cappingGauge({
//     betLabel:   'MONEYLINE',
//     leftLabel:  'Mariners', rightLabel: 'Mets',
//     leftPct:    79,         rightPct:   21,
//     leftColor:  '#005C5C',  rightColor: '#002D72',
//     centerLine: '-1.5',     // optional: shown between team names below widget
//     size:       'md',       // 'md' (~210px) | 'sm' (~170px, modal)
//   });

let _gaugeUid = 0;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Convert a hex color to an rgba() string with the given alpha. Used to apply
// team secondary colors as outlines + underlines at partial opacity inline.
function hexToRgba(hex, alpha = 1) {
  if (typeof hex !== 'string' || hex[0] !== '#') return `rgba(255,255,255,${alpha})`;
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Brighten hex → readable variant ──────────────────────────────────────────
// Lifts HSL lightness to at least minL while preserving hue + saturation.
function brighten(hex, minL = 0.66) {
  if (typeof hex !== 'string' || hex[0] !== '#') return hex;
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return hex;

  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let l = (max + min) / 2;
  if (l >= minL) return hex;

  const d = max - min;
  let H, S;
  if (d === 0) { H = 0; S = 0; }
  else {
    S = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r)      H = ((g - b) / d) + (g < b ? 6 : 0);
    else if (max === g) H = ((b - r) / d) + 2;
    else                H = ((r - g) / d) + 4;
    H *= 60;
  }
  l = minL;

  const C = (1 - Math.abs(2 * l - 1)) * S;
  const X = C * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = l - C / 2;
  let rp = 0, gp = 0, bp = 0;
  if (H <  60) [rp, gp, bp] = [C, X, 0];
  else if (H < 120) [rp, gp, bp] = [X, C, 0];
  else if (H < 180) [rp, gp, bp] = [0, C, X];
  else if (H < 240) [rp, gp, bp] = [0, X, C];
  else if (H < 300) [rp, gp, bp] = [X, 0, C];
  else              [rp, gp, bp] = [C, 0, X];
  const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0'); // eslint-disable-line
  return '#' + toHex(rp) + toHex(gp) + toHex(bp);
}

// ── Main render ──────────────────────────────────────────────────────────────
export function cappingGauge(opts = {}) {
  const {
    betLabel            = '',
    betLabelColor       = '',           // optional accent color for the bet-label
    leftLabel           = '—',
    rightLabel          = '—',
    leftPct             = null,
    rightPct            = null,
    leftColor           = '#475569',
    rightColor          = '#475569',
    leftColorSecondary  = '',           // optional team secondary for outline + underline
    rightColorSecondary = '',
    centerLine          = null,
    size                = 'md',
  } = opts;

  const noData = leftPct == null || rightPct == null;
  const lp = noData ? 50 : Math.max(0, Math.min(100, Math.round(leftPct)));
  const rp = noData ? 50 : Math.max(0, Math.min(100, Math.round(rightPct)));

  // Needle: points toward the winning side.
  //   leftPct=100  → needle straight left  (-90°)
  //   leftPct=50   → vertical             (0°)
  //   leftPct=0    → needle straight right (+90°)
  const needleDeg = noData ? 0 : Math.max(-90, Math.min(90, (rp - 50) * 1.8));

  // Gradient transition position (along the horizontal of the disc), as a %
  // from the LEFT edge. At lp=79 the left color owns the first 79% of the disc.
  const BLEND = 8;
  const splitPct = noData ? 50 : lp;
  const stopA = Math.max(0,   splitPct - BLEND);
  const stopB = Math.min(100, splitPct + BLEND);

  // Opacity scales with each side's lean. Winner stays saturated; loser fades.
  //   100% lean: winner opacity 0.95, loser opacity 0.35
  //   50/50:     both at 0.65
  // This makes the gradient read as winning-side-dominant instead of feeling
  // muddy when one side's primary color is darker.
  const opacityFor = pct => noData ? 1 : 0.35 + 0.60 * (pct / 100);
  const lOp = opacityFor(lp);
  const rOp = opacityFor(rp);

  const sizeMod = size === 'sm' ? 'sm' : 'md';
  const isTotal = (betLabel || '').toUpperCase() === 'TOTAL';
  const uid     = `cag${++_gaugeUid}`;

  // Geometry. viewBox 0 0 200 110. Disc fills the half-circle from (10,100) to
  // (190,100) — flat side along the bottom. Pivot dot at (100,100). The arrow
  // lives inside the disc.
  const cx = 100, cy = 100, r = 90;
  const discPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} Z`;

  // Arrow: small, ~62% of radius, 5–7 px wide, 1 px white outline.
  const needleLen = sizeMod === 'sm' ? 48 : 56;
  const needleHalfWBase = sizeMod === 'sm' ? 2.4 : 2.8;
  const needleTipExtra  = sizeMod === 'sm' ? 4   : 5;
  const tipY  = cy - needleLen;
  const tip2  = cy - needleLen + 11;
  const hw    = needleHalfWBase;
  const tipHalf = hw + needleTipExtra;
  // Arrow path: a slim shaft with a flared tip.
  const needlePath =
    `M ${cx} ${tipY} ` +
    `L ${cx + tipHalf} ${tip2} ` +
    `L ${cx + hw} ${tip2} ` +
    `L ${cx + hw} ${cy - 4} ` +
    `L ${cx - hw} ${cy - 4} ` +
    `L ${cx - hw} ${tip2} ` +
    `L ${cx - tipHalf} ${tip2} Z`;

  return `
    <div class="cag-block cag-block--${sizeMod}${isTotal ? ' cag-block--total' : ''}${noData ? ' cag-block--empty' : ''}">
      <div class="cag-widget">
        ${betLabel ? `<div class="cag-bet-label"${betLabelColor ? ` style="color:${betLabelColor};"` : ''}>${esc(betLabel)}</div>` : ''}
        <div class="cag-arc-area">
          <svg class="cag-svg" viewBox="0 0 200 110" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            <defs>
              <!-- Dynamic gradient: the transition position follows leftPct.
                   At lp=79 the left color owns 0..71%, blend 71..87%, right color 87..100%. -->
              <linearGradient id="${uid}-fill" x1="0%" x2="100%" y1="50%" y2="50%">
                <stop offset="0%"          stop-color="${noData ? '#1e2330' : leftColor}"  stop-opacity="${lOp.toFixed(2)}"/>
                <stop offset="${stopA}%"   stop-color="${noData ? '#1e2330' : leftColor}"  stop-opacity="${lOp.toFixed(2)}"/>
                <stop offset="${stopB}%"   stop-color="${noData ? '#1e2330' : rightColor}" stop-opacity="${rOp.toFixed(2)}"/>
                <stop offset="100%"        stop-color="${noData ? '#1e2330' : rightColor}" stop-opacity="${rOp.toFixed(2)}"/>
              </linearGradient>

              <!-- Soft drop shadow under the needle -->
              <filter id="${uid}-needle-shadow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="1.5"/>
                <feOffset dy="2" result="offsetBlur"/>
                <feColorMatrix in="offsetBlur" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.55 0" result="dropShadow"/>
                <feMerge>
                  <feMergeNode in="dropShadow"/>
                  <feMergeNode in="SourceGraphic"/>
                </feMerge>
              </filter>
            </defs>

            <!-- 1. Filled half-disc with the dynamic gradient -->
            <path d="${discPath}" fill="url(#${uid}-fill)"/>

            <!-- 2. Subtle outer rim hairline (matte definition, no shine) -->
            <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}"
                  fill="none" stroke="rgba(0,0,0,0.28)" stroke-width="1"/>

            <!-- 3. Needle: small arrow with 1px white outline + soft drop shadow -->
            <g class="cag-needle" style="--target-deg:${needleDeg}deg;" filter="url(#${uid}-needle-shadow)">
              <path d="${needlePath}" fill="#0b0e14" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/>
              <circle cx="${cx}" cy="${cy}" r="${sizeMod === 'sm' ? 4.5 : 5}" fill="#0b0e14" stroke="#ffffff" stroke-width="1"/>
              <circle cx="${cx}" cy="${cy}" r="${sizeMod === 'sm' ? 1.8 : 2}" fill="#cbd5e1"/>
            </g>
          </svg>

        </div>

        <!-- Per-side %s on a row below the disc, with the line value (-1.5,
             7 runs) tucked between them. Three columns: %, line, % — the
             line value sits dead-center under the disc. Empty middle for ML. -->
        <div class="cag-pct-row">
          ${noData ? `
            <span class="cag-side-pct cag-side-pct-l cag-empty">—</span>
            <span class="cag-line-mid${centerLine ? '' : ' cag-line-mid--empty'}">${esc(centerLine || '')}</span>
            <span class="cag-side-pct cag-side-pct-r cag-empty">—</span>
          ` : `
            <span class="cag-side-pct cag-side-pct-l" style="${_pctStyle(leftColor,  leftColorSecondary)}">${lp}%</span>
            <span class="cag-line-mid${centerLine ? '' : ' cag-line-mid--empty'}">${esc(centerLine || '')}</span>
            <span class="cag-side-pct cag-side-pct-r" style="${_pctStyle(rightColor, rightColorSecondary)}">${rp}%</span>
          `}
        </div>
      </div>

      <div class="cag-footer">
        <span class="cag-team cag-team-l" style="${_teamStyle(leftColor,  leftColorSecondary)}">${esc(leftLabel)}</span>
        <span class="cag-team cag-team-r" style="${_teamStyle(rightColor, rightColorSecondary)}">${esc(rightLabel)}</span>
      </div>
    </div>`;
}

// Inline-style builder for per-side % numbers. Primary color drives the text
// fill (brightened for legibility on dark); secondary color (at 70% opacity)
// paints a thin text-stroke that halos each digit with the team's accent hue.
function _pctStyle(primary, secondary) {
  const fill = brighten(primary, 0.72);
  if (!secondary) return `color:${fill};`;
  const stroke = hexToRgba(brighten(secondary, 0.55), 0.7);
  return `color:${fill};-webkit-text-stroke:0.6px ${stroke};`;
}

// Inline-style builder for team names. Primary color drives the text fill;
// secondary color (at 70% opacity) underlines the name.
function _teamStyle(primary, secondary) {
  const fill = brighten(primary, 0.66);
  if (!secondary) return `color:${fill};`;
  const ucolor = hexToRgba(brighten(secondary, 0.55), 0.7);
  return `color:${fill};text-decoration:underline;text-decoration-color:${ucolor};text-decoration-thickness:2px;text-underline-offset:4px;`;
}
