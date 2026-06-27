// public/modules/live_tracker.js
// The live "command bar" on the game detail page (MLB v1): a clean stylized STATE
// cell (diamond + count + outs + half-inning), a MATCHUP cell (batter / pitcher /
// on deck), and the VALUE PULSE cell (paid-gated). Polls GET /api/game/:id/live
// every ~12s while the page is visible and the game is live. The pulse bar is
// diff-updated in place so its CSS width/color transition stays smooth.

let _timer = null;
let _ctx   = null;   // { gameId, activeSlot }
let _visBound = false;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function unmountLiveCommand() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _ctx = null;
}

export async function mountLiveCommand({ gameId, activeSlot }) {
  unmountLiveCommand();
  _ctx = { gameId, activeSlot };
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

// ── Cells ───────────────────────────────────────────────────────────────────
function diamondSvg(bases = 0) {
  const on = (m) => (bases & m) ? 'ca-lc-base--on' : '';
  // 2nd top, 1st right, 3rd left, home bottom — rounded squares rotated 45deg.
  return `<svg class="ca-lc-diamond" viewBox="0 0 60 60" width="56" height="56" aria-hidden="true">
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

function stateHtml(s) {
  const isMlb = s.bases != null || s.outs != null || s.balls != null;
  const half = esc(s.detail || (s.period ? `Inn ${s.period}` : 'Live'));
  if (!isMlb) {
    // Non-MLB: clock + period only (rich state per sport is a follow-up).
    const clk = [s.period ? `P${s.period}` : '', s.clock || ''].filter(Boolean).join(' ');
    return `<div class="ca-lc-half">${esc(s.detail || clk || 'Live')}</div>`;
  }
  const balls = pips(Math.min(s.balls ?? 0, 3), 3, 'ca-lc-pip--ball');
  const strk  = pips(Math.min(s.strikes ?? 0, 2), 2, 'ca-lc-pip--strike');
  const outs  = pips(Math.min(s.outs ?? 0, 2), 2, 'ca-lc-pip--out');
  return `
    ${diamondSvg(s.bases || 0)}
    <div class="ca-lc-state-meta">
      <div class="ca-lc-half">${half}</div>
      <div class="ca-lc-count"><span class="ca-lc-count-lbl">B</span>${balls}<span class="ca-lc-count-lbl">S</span>${strk}</div>
      <div class="ca-lc-count"><span class="ca-lc-count-lbl">Out</span>${outs}</div>
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

function scoreHtml(s) {
  return `<span class="ca-lc-score ca-num">${s.awayScore ?? 0}<span class="ca-lc-score-dash">-</span>${s.homeScore ?? 0}</span>`;
}

// ── Render (build shell once, then diff-update) ──────────────────────────────
function render(el, data) {
  const s = data.state;
  const pulse = pickPulse(data.pulses);

  if (!el.querySelector('.ca-lc')) {
    el.innerHTML = `
      <div class="ca-lc">
        <div class="ca-lc-cell ca-lc-cell--state">
          <div class="ca-lc-cell-hd">Live <span class="ca-lc-livedot"></span>${scoreHtml(s)}</div>
          <div class="ca-lc-state"></div>
        </div>
        <div class="ca-lc-cell ca-lc-cell--matchup">
          <div class="ca-lc-cell-hd">At the plate</div>
          <div class="ca-lc-matchup"></div>
        </div>
        <div class="ca-lc-cell ca-lc-cell--pulse">
          <div class="ca-lc-cell-hd">Value pulse</div>
          <div class="ca-lc-pulse"></div>
        </div>
      </div>`;
  }
  el.querySelector('.ca-lc-cell-hd').innerHTML = `Live <span class="ca-lc-livedot"></span>${scoreHtml(s)}`;
  el.querySelector('.ca-lc-state').innerHTML = stateHtml(s);
  el.querySelector('.ca-lc-matchup').innerHTML = matchupHtml(s);
  updatePulse(el.querySelector('.ca-lc-pulse'), pulse);
}

// Prefer the pulse for the slot the user is viewing; else the first available.
function pickPulse(pulses) {
  if (!pulses) return null;
  if (_ctx && pulses[_ctx.activeSlot]) return pulses[_ctx.activeSlot];
  const keys = Object.keys(pulses);
  return keys.length ? pulses[keys[0]] : null;
}

function updatePulse(cell, pulse) {
  if (!cell) return;
  if (!pulse) {
    cell.innerHTML = `<div class="ca-lc-pulse-empty">No CA pick tracked on this game.</div>`;
    return;
  }
  if (pulse.locked) {
    cell.innerHTML = `
      <div class="ca-lc-pulse-locked" onclick="openSignup()" title="Members only">
        <div class="ca-lc-pulse-bar"><div class="ca-lc-pulse-fill ca-blurred" style="width:62%;background:#FFD700;"></div></div>
        <div class="ca-lc-pulse-lock"><i class="fa-solid fa-lock"></i> Unlock the live value read</div>
        <div class="ca-lc-pulse-sub"><a onclick="event.stopPropagation();openLogin()">Log in</a> or <a onclick="event.stopPropagation();openSignup()">create a free account</a></div>
      </div>`;
    return;
  }
  // Diff-update the fill in place so the width/color CSS transition stays smooth.
  let bar = cell.querySelector('.ca-lc-pulse-fill');
  if (!bar) {
    cell.innerHTML = `
      <div class="ca-lc-pulse-bar"><div class="ca-lc-pulse-fill"></div></div>
      <div class="ca-lc-pulse-label"></div>
      <div class="ca-lc-pulse-note" title="Our model estimates this pick's live win probability from the score, inning, outs and baserunners, versus where it started. A probabilistic read, not a promise.">What this means</div>`;
    bar = cell.querySelector('.ca-lc-pulse-fill');
  }
  const pct = Math.round((pulse.magnitude || 0) * 100);
  bar.style.width = Math.max(4, pct) + '%';
  bar.style.background = pulse.color || '#8892a4';
  bar.classList.toggle('ca-lc-pulse-fill--pulsing', (pulse.magnitude || 0) >= 0.1);
  const caret = pulse.sign > 0 ? '▲' : pulse.sign < 0 ? '▼' : '•';
  const approx = pulse.approx ? ' <span class="ca-lc-pulse-approx">approx</span>' : '';
  cell.querySelector('.ca-lc-pulse-label').innerHTML =
    `<span class="ca-lc-pulse-caret" style="color:${esc(pulse.color || '#8892a4')}">${caret}</span> ${esc(pulse.label || '')}${approx}`;
}
