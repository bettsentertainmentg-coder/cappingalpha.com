// public/modules/live_tracker.js
// The live "command bar" on the game detail page (MLB v1): a clear R/H/E
// scoreboard, the game state (diamond + count + outs), the matchup (batter /
// pitcher / on deck), and the VALUE PULSE as a sparkline that builds over the game.
// Polls GET /api/game/:id/live every ~12s while the page is visible and the game
// is live. Re-renders fully each poll (the sparkline data is the animation).

let _timer = null;
let _ctx   = null;   // { gameId, activeSlot, teams, betsHtml, startLabel }
let _visBound = false;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function unmountLiveCommand() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _ctx = null;
}

export async function mountLiveCommand({ gameId, activeSlot, teams, betsHtml, startLabel }) {
  unmountLiveCommand();
  _ctx = { gameId, activeSlot, teams: teams || {}, betsHtml: betsHtml || '', startLabel: startLabel || '' };
  const el = document.getElementById('ca-live-command');
  if (!el) return;
  el.innerHTML = `<div class="ca-lc-loading">Loading live game...</div>`;
  if (!_visBound) { document.addEventListener('visibilitychange', _onVis); _visBound = true; }
  await tick();
  _timer = setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 12000);
}

function _onVis() { if (document.visibilityState === 'visible' && _ctx) tick(); }

async function tick() {
  if (!_ctx) return;
  const el = document.getElementById('ca-live-command');
  if (!el) { unmountLiveCommand(); return; }
  let data;
  try {
    const r = await fetch(`/api/game/${encodeURIComponent(_ctx.gameId)}/live`);
    if (!r.ok) return;            // keep last render on a transient error
    data = await r.json();
  } catch (_) { return; }
  if (!data || !data.state) return;
  render(el, data);
  if (data.state.status !== 'in') unmountLiveCommand();   // game ended -> stop polling
}

// ── Scoreboard cell: line score (innings build out) + R / H / E ───────────────
function boxscoreHtml(s) {
  const t = (_ctx && _ctx.teams) || {};
  const awayName = esc(t.awayName || t.awayAbbr || s.awayAbbr || 'Away');
  const homeName = esc(t.homeName || t.homeAbbr || s.homeAbbr || 'Home');
  const aR = s.awayScore ?? 0, hR = s.homeScore ?? 0;
  const aLine = Array.isArray(s.awayLine) ? s.awayLine : [];
  const hLine = Array.isArray(s.homeLine) ? s.homeLine : [];
  const nInn = Math.max(aLine.length, hLine.length, 0);
  const hasHE = (s.homeHits != null || s.awayHits != null);
  const aLead = aR > hR, hLead = hR > aR;

  const innHd = Array.from({ length: nInn }, (_, i) => `<span class="ca-ls-i">${i + 1}</span>`).join('');
  const innCells = (line) => Array.from({ length: nInn }, (_, i) => `<span class="ca-ls-i">${line[i] == null ? '' : line[i]}</span>`).join('');
  const heHd  = hasHE ? `<span class="ca-ls-c">H</span><span class="ca-ls-c">E</span>` : '';
  const heRow = (h, e) => hasHE ? `<span class="ca-ls-c">${h ?? '-'}</span><span class="ca-ls-c">${e ?? '-'}</span>` : '';
  const row = (name, lead, line, r, h, e) => `
    <div class="ca-ls-row${lead ? ' ca-ls-row--lead' : ''}">
      <span class="ca-ls-team">${name}</span>
      <span class="ca-ls-inns">${innCells(line)}</span>
      <span class="ca-ls-r">${r}</span>${heRow(h, e)}
    </div>`;
  return `
    <div class="ca-ls">
      <div class="ca-ls-row ca-ls-hd"><span class="ca-ls-team"></span><span class="ca-ls-inns">${innHd}</span><span class="ca-ls-r">R</span>${heHd}</div>
      ${row(awayName, aLead, aLine, aR, s.awayHits, s.awayErrors)}
      ${row(homeName, hLead, hLine, hR, s.homeHits, s.homeErrors)}
    </div>`;
}

function diamondSvg(bases = 0) {
  const on = (m) => (bases & m) ? 'ca-lc-base--on' : '';
  return `<svg class="ca-lc-diamond" viewBox="0 0 60 60" width="44" height="44" aria-hidden="true">
    <rect class="ca-lc-base ${on(2)}" x="24" y="6"  width="12" height="12" rx="2.5" transform="rotate(45 30 12)"/>
    <rect class="ca-lc-base ${on(1)}" x="42" y="24" width="12" height="12" rx="2.5" transform="rotate(45 48 30)"/>
    <rect class="ca-lc-base ${on(4)}" x="6"  y="24" width="12" height="12" rx="2.5" transform="rotate(45 12 30)"/>
    <rect class="ca-lc-home"          x="25" y="43" width="10" height="10" rx="2" transform="rotate(45 30 48)"/>
  </svg>`;
}

function pips(filled, total, cls) {
  let out = '';
  for (let i = 0; i < total; i++) out += `<span class="ca-lc-pip ${i < filled ? 'ca-lc-pip--on ' + cls : ''}"></span>`;
  return out;
}

function stateLineHtml(s) {
  const isMlb = s.bases != null || s.outs != null || s.balls != null;
  const half = esc(s.detail || (s.period ? `Inn ${s.period}` : 'Live'));
  if (!isMlb) return `<div class="ca-lc-stateline"><span class="ca-lc-half">${esc(s.detail || s.clock || 'Live')}</span></div>`;
  const balls = pips(Math.min(s.balls ?? 0, 3), 3, 'ca-lc-pip--ball');
  const strk  = pips(Math.min(s.strikes ?? 0, 2), 2, 'ca-lc-pip--strike');
  const outs  = pips(Math.min(s.outs ?? 0, 2), 2, 'ca-lc-pip--out');
  return `
    <div class="ca-lc-stateline">
      ${diamondSvg(s.bases || 0)}
      <div class="ca-lc-state-meta">
        <div class="ca-lc-half">${half}</div>
        <div class="ca-lc-count"><span class="ca-lc-count-lbl">B</span>${balls}<span class="ca-lc-count-lbl">S</span>${strk}</div>
        <div class="ca-lc-count"><span class="ca-lc-count-lbl">Out</span>${outs}</div>
      </div>
    </div>`;
}

function matchupHtml(s) {
  const rows = [];
  if (s.batter)  rows.push(`<div class="ca-lc-mrow"><span class="ca-lc-mlbl">AB</span><span class="ca-lc-mname">${esc(s.batter)}</span>${s.batterLine ? `<span class="ca-lc-mline">${esc(s.batterLine)}</span>` : ''}</div>`);
  if (s.pitcher) rows.push(`<div class="ca-lc-mrow"><span class="ca-lc-mlbl">P</span><span class="ca-lc-mname">${esc(s.pitcher)}</span>${s.pitcherLine ? `<span class="ca-lc-mline">${esc(s.pitcherLine)}</span>` : ''}</div>`);
  if (Array.isArray(s.dueUp) && s.dueUp.length) rows.push(`<div class="ca-lc-mrow ca-lc-mrow--ondeck"><span class="ca-lc-mlbl">On deck</span><span class="ca-lc-mname">${esc(s.dueUp[0])}</span></div>`);
  if (!rows.length) return `<div class="ca-lc-mrow ca-lc-mrow--empty">Between batters</div>`;
  return rows.join('');
}

// ── Value pulse: signed (-100..+100) windowed line chart ─────────────────────
// High value at the top, low at the bottom, a zero reference line, and a y-window
// that frames the recent swings (min 50 points tall) instead of the full range, so
// per-play moves are legible. Default preserveAspectRatio so the axis text stays crisp.
function valuePulseSvg(history, color) {
  const W = 260, H = 100, padL = 28, padR = 8, padT = 8, padB = 16;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  // Accept either a plain number[] (locked teaser) or [{v, p}] (live, p = period).
  const raw  = Array.isArray(history) ? history : [];
  const hist = raw.map(h => (typeof h === 'number' ? h : (h && typeof h.v === 'number' ? h.v : null))).filter(v => v !== null);
  const pers = raw.map(h => (typeof h === 'number' ? null : (h ? h.p : null)));
  if (hist.length < 2) {
    return `<svg class="ca-vp" viewBox="0 0 ${W} ${H}">
      <line x1="${padL}" y1="${padT + innerH / 2}" x2="${W - padR}" y2="${padT + innerH / 2}" class="ca-vp-zero"/>
      <text x="${W / 2}" y="${padT + innerH / 2 - 5}" class="ca-vp-axis" text-anchor="middle">building...</text></svg>`;
  }
  // Window: frame the data, at least 50 tall, clamped into [-100, 100].
  const dmin = Math.min(...hist), dmax = Math.max(...hist);
  const mid = (dmin + dmax) / 2;
  const range = Math.max(50, (dmax - dmin) * 1.35);
  let top = mid + range / 2, bot = mid - range / 2;
  if (top > 100) { top = 100; bot = 100 - range; }
  if (bot < -100) { bot = -100; top = -100 + range; }
  top = Math.min(100, top); bot = Math.max(-100, bot);
  const span = Math.max(1, top - bot);
  const n = hist.length;
  const yBot = padT + innerH, yLab = (H - 3).toFixed(1);

  // X mapping: bucket points by inning/period so periods are EVENLY spaced and their
  // labels line up under them on a level axis. The line still shows every sample inside
  // its period bucket. Falls back to even index spacing when periods aren't available
  // (e.g. the blurred teaser, which uses plain numbers).
  const allHaveP = pers.length === n && pers.every(p => p != null);
  let x, xaxis = '';
  if (allHaveP) {
    const innings = [...new Set(pers)].sort((a, b) => a - b);
    const byInn = new Map(innings.map(p => [p, []]));
    pers.forEach((p, i) => byInn.get(p).push(i));
    const unit = new Array(n);
    for (const p of innings) {
      const list = byInn.get(p);
      list.forEach((idx, k) => { unit[idx] = p + (list.length === 1 ? 0.5 : (k + 0.5) / list.length); });
    }
    const lo = innings[0], hi = innings[innings.length - 1] + 1, uspan = hi - lo;
    x = (i) => padL + ((unit[i] - lo) / uspan) * innerW;
    innings.forEach((p, k) => {
      if (k > 0) {
        const bx = (padL + ((p - lo) / uspan) * innerW).toFixed(1);   // faint divider before this inning
        xaxis += `<line x1="${bx}" y1="${padT.toFixed(1)}" x2="${bx}" y2="${yBot.toFixed(1)}" class="ca-vp-xgrid"/>`;
      }
      const cx = (padL + ((p + 0.5 - lo) / uspan) * innerW).toFixed(1);
      xaxis += `<text x="${cx}" y="${yLab}" class="ca-vp-xaxis" text-anchor="middle">${p}</text>`;
    });
  } else {
    x = (i) => padL + (i / (n - 1)) * innerW;
  }
  const y = (v) => padT + (1 - (v - bot) / span) * innerH;
  const lbl = (v, yy) => `<text x="${padL - 5}" y="${yy.toFixed(1)}" dominant-baseline="middle" class="ca-vp-axis" text-anchor="end">${v > 0 ? '+' : ''}${Math.round(v)}</text>`;

  let grid = `<line x1="${padL}" y1="${y(top).toFixed(1)}" x2="${W - padR}" y2="${y(top).toFixed(1)}" class="ca-vp-grid"/>${lbl(top, y(top))}`;
  grid    += `<line x1="${padL}" y1="${y(bot).toFixed(1)}" x2="${W - padR}" y2="${y(bot).toFixed(1)}" class="ca-vp-grid"/>${lbl(bot, y(bot))}`;
  const hasZero = top > 0 && bot < 0;
  if (hasZero) {
    const zy = y(0);
    grid += `<line x1="${padL}" y1="${zy.toFixed(1)}" x2="${W - padR}" y2="${zy.toFixed(1)}" class="ca-vp-zero"/><text x="${padL - 5}" y="${zy.toFixed(1)}" dominant-baseline="middle" class="ca-vp-axis ca-vp-axis--zero" text-anchor="end">0</text>`;
  }

  const pts = hist.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const baseY = (hasZero ? y(0) : y(bot)).toFixed(1);
  const area = `${x(0).toFixed(1)},${baseY} ${pts} ${x(n - 1).toFixed(1)},${baseY}`;
  const dots = hist.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.3" fill="${color}" fill-opacity="0.8"/>`).join('');
  const lx = x(n - 1).toFixed(1), ly = y(hist[n - 1]).toFixed(1);
  return `<svg class="ca-vp" viewBox="0 0 ${W} ${H}">
    ${grid}${xaxis}
    <polygon points="${area}" fill="${color}" fill-opacity="0.10"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <circle cx="${lx}" cy="${ly}" r="3.5" fill="${color}" stroke="#11151e" stroke-width="1.5"/>
  </svg>`;
}

function pickPulse(pulses) {
  if (!pulses) return null;
  if (_ctx && pulses[_ctx.activeSlot]) return pulses[_ctx.activeSlot];
  const keys = Object.keys(pulses);
  return keys.length ? pulses[keys[0]] : null;
}

function pulseCellHtml(pulse) {
  if (!pulse) return `<div class="ca-lc-pulse-empty">No CA pick tracked on this game.</div>`;
  if (pulse.locked) {
    return `<div class="ca-lc-pulse-locked" onclick="openSignup()" title="Members only">
      <div class="ca-vp-wrap ca-blurred">${valuePulseSvg([12, -8, 24, -16, 30, 5, -12, 22], '#FFD700')}</div>
      <div class="ca-lc-pulse-lock"><i class="fa-solid fa-lock"></i> Unlock the live value read</div>
      <div class="ca-lc-pulse-sub"><a onclick="event.stopPropagation();openLogin()">Log in</a> or <a onclick="event.stopPropagation();openSignup()">create a free account</a></div>
    </div>`;
  }
  const color = pulse.color || '#8892a4';
  const v = (typeof pulse.value === 'number') ? pulse.value : 0;
  const caret = pulse.sign > 0 ? '▲' : pulse.sign < 0 ? '▼' : '•';
  const vtxt = `${v > 0 ? '+' : ''}${Math.round(v)}`;
  const approx = pulse.approx ? ` <span class="ca-lc-pulse-approx">approx</span>` : '';
  return `
    <div class="ca-vp-wrap">${valuePulseSvg(pulse.history, color)}</div>
    <div class="ca-lc-pulse-label"><span class="ca-lc-pulse-caret" style="color:${esc(color)}">${caret}</span> ${esc(pulse.label || '')} <span class="ca-vp-val" style="color:${esc(color)}">${vtxt}</span>${approx}</div>
    <div class="ca-lc-pulse-note" title="Our model rates this pick's live value from the score, inning, outs, baserunners and count versus where it locked. A probabilistic read, not a promise.">What this means</div>`;
}

// Start / scheduled time: top-right of the live card (app-generated HTML, has a <span>).
function metaHtml() {
  const start = (_ctx && _ctx.startLabel) || '';
  return start ? `<div class="ca-lc-meta">${start}</div>` : '';
}

// Footer is just the tracked bets list, inside the card so it never sits flush-left.
function footHtml() {
  const bets = (_ctx && _ctx.betsHtml) || '';
  if (!bets) return '';
  return `<div class="ca-lc-foot">
    <span class="ca-lc-foot-lbl">Your tracked bets</span>
    <div class="ca-lc-foot-bets">${bets}</div>
  </div>`;
}

function render(el, data) {
  const s = data.state;
  const pulse = pickPulse(data.pulses);
  el.innerHTML = `
    <div class="ca-lc">
      ${metaHtml()}
      <div class="ca-lc-grid">
        <div class="ca-lc-cell ca-lc-cell--score">
          <div class="ca-lc-cell-hd">Live <span class="ca-lc-livedot"></span></div>
          ${boxscoreHtml(s)}
          ${stateLineHtml(s)}
        </div>
        <div class="ca-lc-cell ca-lc-cell--matchup">
          <div class="ca-lc-cell-hd">At the plate</div>
          ${matchupHtml(s)}
        </div>
        <div class="ca-lc-cell ca-lc-cell--pulse">
          <div class="ca-lc-cell-hd">Value pulse</div>
          ${pulseCellHtml(pulse)}
        </div>
      </div>
      ${footHtml()}
    </div>`;
}
