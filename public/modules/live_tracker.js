// public/modules/live_tracker.js
// The live "command bar" on the game detail page, for every tracked sport: a
// line-score scoreboard and a sport-specific situation cell (MLB diamond +
// count, NFL down-and-distance, NBA clock + run, NHL power play + shots,
// soccer minute + key events, tennis set board).
//
// Below the grid: the tracked-bets row, then a tab strip (Value pulse | Plays |
// Leaders | Stats). The VALUE PULSE is the tracker's only chart (members-only,
// fed by the ~12s /live poll); Plays/Leaders/Stats are free content fed by
// GET /api/game/:id/live/feed (~25s, lazy). Tennis has no feed, so its strip
// carries the pulse tab alone.
//
// Polls GET /api/game/:id/live every ~12s while the page is visible and the
// game is live. The grid re-renders fully each poll; the tabs keep their own
// state so the active tab never resets mid-game.

let _timer = null;
let _feedTimer = null;
let _ctx   = null;   // { gameId, sport, activeSlot, teams, slotLabels, betsHtml, startLabel, on404 }
let _visBound = false;
let _feed = null;         // last /live/feed payload
let _feedSupported = true;
let _activeTab = 'pulse';
let _playsScoringOnly = false;
let _run = null;          // basketball run detector: { lastH, lastA, team, pts }
let _lastPulse = null;    // latest per-slot pulse from /live — the pulse tab reads it
let _lastPulseSlot = null; // which slot that pulse belongs to (names the pick in the panel)
let _lastFinal = false;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FAMILY = {
  MLB: 'baseball', NFL: 'football', NCAAF: 'football',
  NBA: 'basketball', WNBA: 'basketball', CBB: 'basketball', WCBB: 'basketball',
  NHL: 'hockey', SOCCER: 'soccer', ATP: 'tennis', WTA: 'tennis',
};
const famOf = () => FAMILY[String(_ctx?.sport || 'MLB').toUpperCase()] || 'baseball';

export function unmountLiveCommand() {
  _stopPolling();
  _ctx = null; _feed = null; _feedSupported = true; _activeTab = 'pulse'; _playsScoringOnly = false; _run = null;
  _lastPulse = null; _lastPulseSlot = null; _lastFinal = false;
}

function _stopPolling() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_feedTimer) { clearInterval(_feedTimer); _feedTimer = null; }
}

export async function mountLiveCommand({ gameId, sport, activeSlot, teams, slotLabels, betsHtml, startLabel, on404 }) {
  const sameGame = _ctx && _ctx.gameId === gameId;
  _stopPolling();
  _ctx = { gameId, sport: sport || 'MLB', activeSlot, teams: teams || {}, slotLabels: slotLabels || {}, betsHtml: betsHtml || '', startLabel: startLabel || '', on404: on404 || null };
  if (!sameGame) { _feed = null; _feedSupported = famOf() !== 'tennis'; _activeTab = 'pulse'; _playsScoringOnly = false; _run = null; _lastPulse = null; _lastPulseSlot = null; _lastFinal = false; }
  const el = document.getElementById('ca-live-command');
  if (!el) return;
  el.innerHTML = `<div class="ca-lc-loading">Loading live game...</div>`;
  if (!_visBound) { document.addEventListener('visibilitychange', _onVis); _visBound = true; }
  await tick();
  _timer = setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 12000);
  if (_feedSupported) {
    await feedTick();
    _feedTimer = setInterval(() => { if (document.visibilityState === 'visible') feedTick(); }, 25000);
  }
}

function _onVis() { if (document.visibilityState === 'visible' && _ctx) { tick(); if (_feedSupported) feedTick(); } }

async function tick() {
  if (!_ctx) return;
  const el = document.getElementById('ca-live-command');
  if (!el) { unmountLiveCommand(); return; }
  let data;
  try {
    const q = (location.search.indexOf('final=1') !== -1) ? '?final=1' : '';   // local finished-game preview
    const r = await fetch(`/api/game/${encodeURIComponent(_ctx.gameId)}/live${q}`);
    if (r.status === 404) {
      // Wiped historical game: the detail page reconstructs from snapshots but
      // there is no live row to track. Hand back to the classic layout.
      const cb = _ctx.on404; unmountLiveCommand();
      if (typeof cb === 'function') cb();
      return;
    }
    if (!r.ok) return;            // keep last render on a transient error
    data = await r.json();
  } catch (_) { return; }
  if (!data || !data.state) return;
  render(el, data);
  if (data.state.status !== 'in') {
    // Final: stop the polls but keep ctx/feed so the tabs stay browsable.
    _stopPolling();
    if (_feedSupported) feedTick();   // one last feed refresh for the completed chart
  }
}

async function feedTick() {
  if (!_ctx || !_feedSupported) return;
  try {
    const r = await fetch(`/api/game/${encodeURIComponent(_ctx.gameId)}/live/feed`);
    if (!r.ok) return;
    const f = await r.json();
    if (f && f.unsupported) { _feedSupported = false; renderTabs(); return; }
    _feed = f;
    renderTabs();
  } catch (_) {}
}

// ── Scoreboard cell: line score (periods build out) + totals ──────────────────
function periodHeaders(fam, nCols) {
  // Numeric period columns everywhere; the situation cell names the format
  // (Q3 / P2 / 2H / Set 3), matching how scoreboards read at a glance.
  return Array.from({ length: nCols }, (_, i) => `<span class="ca-ls-i">${i + 1}</span>`).join('');
}

function boxscoreHtml(s, statusHtml = '') {
  const t = (_ctx && _ctx.teams) || {};
  const fam = famOf();
  const awayName = esc(t.awayName || t.awayAbbr || s.awayAbbr || 'Away');
  const homeName = esc(t.homeName || t.homeAbbr || s.homeAbbr || 'Home');
  const aT = s.awayScore ?? 0, hT = s.homeScore ?? 0;
  const aLead = aT > hT, hLead = hT > aT;

  // Tennis: the line score IS the set board (games per set, tiebreaks raised).
  if (fam === 'tennis') {
    const sets = Array.isArray(s.sets) ? s.sets : [];
    const hd = sets.map((_, i) => `<span class="ca-ls-i">${i + 1}</span>`).join('');
    const cell = (v, tb, won) => `<span class="ca-ls-i${won ? ' ca-ls-i--won' : ''}">${v ?? ''}${tb != null ? `<sup>${tb}</sup>` : ''}</span>`;
    const row = (name, lead, side) => `
      <div class="ca-ls-row${lead ? ' ca-ls-row--lead' : ''}">
        <span class="ca-ls-team">${name}${s.serving === side ? ' <span class="ca-lc-serve" title="Serving"></span>' : ''}</span>
        <span class="ca-ls-inns">${sets.map(st => cell(st[side], st[side + 'Tb'], st.winner === side)).join('')}</span>
        <span class="ca-ls-r">${side === 'home' ? hT : aT}</span>
      </div>`;
    return `
      <div class="ca-ls">
        <div class="ca-ls-row ca-ls-hd"><span class="ca-ls-team">${statusHtml}</span><span class="ca-ls-inns">${hd}</span><span class="ca-ls-r">Sets</span></div>
        ${row(awayName, aLead, 'away')}
        ${row(homeName, hLead, 'home')}
      </div>`;
  }

  const aLine = Array.isArray(s.awayLine) ? s.awayLine : [];
  const hLine = Array.isArray(s.homeLine) ? s.homeLine : [];
  const nCols = Math.max(aLine.length, hLine.length, 0);
  const hasHE = (s.homeHits != null || s.awayHits != null);
  const totLbl = fam === 'baseball' ? 'R' : 'T';

  const innHd = periodHeaders(fam, nCols);
  const innCells = (line) => Array.from({ length: nCols }, (_, i) => `<span class="ca-ls-i">${line[i] == null ? '' : line[i]}</span>`).join('');
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
      <div class="ca-ls-row ca-ls-hd"><span class="ca-ls-team">${statusHtml}</span><span class="ca-ls-inns">${innHd}</span><span class="ca-ls-r">${totLbl}</span>${heHd}</div>
      ${row(awayName, aLead, aLine, aT, s.awayHits, s.awayErrors)}
      ${row(homeName, hLead, hLine, hT, s.homeHits, s.homeErrors)}
    </div>`;
}

function diamondSvg(bases = 0) {
  const on = (m) => (bases & m) ? 'ca-lc-base--on' : '';
  return `<svg class="ca-lc-diamond" viewBox="0 0 60 60" width="58" height="58" aria-hidden="true">
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

// ── Situation cell (column 2) per sport ────────────────────────────────────────
function baseballStateHtml(s) {
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

function footballStateHtml(s) {
  const t = (_ctx && _ctx.teams) || {};
  const posAbbr = s.possession === 'home' ? (t.homeAbbr || s.homeAbbr) : s.possession === 'away' ? (t.awayAbbr || s.awayAbbr) : null;
  const dd = s.downDistanceText || (s.down ? `${s.down} & ${s.distance ?? '-'}` : null);
  const rz = s.isRedZone ? `<span class="ca-lc-rz">Red zone</span>` : '';
  const to = (n) => (typeof n === 'number') ? pips(Math.min(n, 3), 3, 'ca-lc-pip--to') : '';
  return `
    <div class="ca-lc-stateline ca-lc-stateline--col">
      <div class="ca-lc-half">${esc(s.detail || 'Live')}</div>
      ${dd ? `<div class="ca-lc-dd${s.isRedZone ? ' ca-lc-dd--rz' : ''}">${posAbbr ? `<span class="ca-lc-poss">${esc(posAbbr)} <i class="fa-solid fa-football"></i></span>` : ''} ${esc(dd)}${s.yardLineText && !dd.includes(String(s.yardLineText)) ? ` at ${esc(s.yardLineText)}` : ''} ${rz}</div>` : ''}
      <div class="ca-lc-count"><span class="ca-lc-count-lbl">TO ${esc(t.awayAbbr || s.awayAbbr || '')}</span>${to(s.awayTimeouts)}<span class="ca-lc-count-lbl">${esc(t.homeAbbr || s.homeAbbr || '')}</span>${to(s.homeTimeouts)}</div>
      ${s.lastPlay ? `<div class="ca-lc-lastplay">${esc(s.lastPlay)}</div>` : ''}
    </div>`;
}

function basketballStateHtml(s) {
  const runChip = (_run && _run.pts >= 6 && _run.team)
    ? `<span class="ca-lc-run">${_run.pts}-0 run, ${esc(_run.team === 'home' ? (_ctx?.teams?.homeAbbr || s.homeAbbr || 'home') : (_ctx?.teams?.awayAbbr || s.awayAbbr || 'away'))}</span>`
    : '';
  return `
    <div class="ca-lc-stateline ca-lc-stateline--col">
      <div class="ca-lc-half">${esc(s.detail || s.clock || 'Live')}</div>
      ${runChip}
      ${s.lastPlay ? `<div class="ca-lc-lastplay">${esc(s.lastPlay)}</div>` : ''}
    </div>`;
}

function hockeyStateHtml(s) {
  const t = (_ctx && _ctx.teams) || {};
  const st = String(s.strength || '').toLowerCase();
  const pp = st.includes('pp-home') ? `<span class="ca-lc-pp">Power play, ${esc(t.homeAbbr || s.homeAbbr || 'home')}</span>`
           : st.includes('pp-away') ? `<span class="ca-lc-pp">Power play, ${esc(t.awayAbbr || s.awayAbbr || 'away')}</span>`
           : st.includes('en') ? `<span class="ca-lc-pp ca-lc-pp--en">Empty net</span>` : '';
  const sog = (s.homeSOG != null || s.awaySOG != null)
    ? `<div class="ca-lc-sog"><span class="ca-lc-count-lbl">Shots</span> ${esc(t.awayAbbr || s.awayAbbr || '')} <b>${s.awaySOG ?? '-'}</b> · ${esc(t.homeAbbr || s.homeAbbr || '')} <b>${s.homeSOG ?? '-'}</b></div>`
    : '';
  return `
    <div class="ca-lc-stateline ca-lc-stateline--col">
      <div class="ca-lc-half">${esc(s.detail || s.clock || 'Live')}</div>
      ${pp}${sog}
      ${s.lastPlay ? `<div class="ca-lc-lastplay">${esc(s.lastPlay)}</div>` : ''}
    </div>`;
}

const SOCCER_ICON = { goal: 'fa-solid fa-futbol', yellow: 'ca-card ca-card--y', red: 'ca-card ca-card--r', sub: 'fa-solid fa-right-left', pen: 'fa-solid fa-futbol' };
function soccerStateHtml(s) {
  const evs = Array.isArray(s.keyEventsCompact) ? s.keyEventsCompact.slice(-5) : [];
  const evHtml = evs.map(e => {
    const ic = e.type === 'yellow' || e.type === 'red'
      ? `<span class="${SOCCER_ICON[e.type]}"></span>`
      : `<i class="${SOCCER_ICON[e.type] || 'fa-regular fa-circle'}"></i>`;
    return `<div class="ca-lc-kev">${ic}<span class="ca-lc-kev-min">${esc(e.min || '')}</span><span class="ca-lc-kev-p">${esc(e.player || '')}</span></div>`;
  }).join('');
  const bar = (lbl, hv, av) => (hv == null && av == null) ? '' : (() => {
    const h = Number(hv) || 0, a = Number(av) || 0, tot = h + a;
    const hp = tot > 0 ? Math.round((h / tot) * 100) : 50;
    return `<div class="ca-lc-sbar"><span class="ca-lc-sbar-a">${a}</span><div class="ca-lc-sbar-t"><div class="ca-lc-sbar-h" style="width:${100 - hp}%"></div></div><span class="ca-lc-sbar-hv">${h}</span><span class="ca-lc-sbar-lbl">${lbl}</span></div>`;
  })();
  const poss = s.possessionPct ? bar('Poss %', s.possessionPct.home, s.possessionPct.away) : '';
  const shots = s.shots ? bar('Shots', s.shots.home, s.shots.away) : '';
  return `
    <div class="ca-lc-stateline ca-lc-stateline--col">
      <div class="ca-lc-half">${esc(s.detail || s.minute || 'Live')}</div>
      ${evHtml ? `<div class="ca-lc-kevents">${evHtml}</div>` : ''}
      ${poss}${shots}
    </div>`;
}

function tennisStateHtml(s) {
  const cur = s.currentSetGames;
  const t = (_ctx && _ctx.teams) || {};
  const serveName = s.serving === 'home' ? (t.homeName || s.homeAbbr) : s.serving === 'away' ? (t.awayName || s.awayAbbr) : null;
  return `
    <div class="ca-lc-stateline ca-lc-stateline--col">
      <div class="ca-lc-half">${esc(s.detail || 'Live')}</div>
      ${cur ? `<div class="ca-lc-lastplay">Current set: ${cur.away ?? 0}-${cur.home ?? 0}</div>` : ''}
      ${serveName ? `<div class="ca-lc-lastplay"><span class="ca-lc-serve"></span> ${esc(serveName)} serving</div>` : ''}
    </div>`;
}

function situationHtml(s) {
  const fam = famOf();
  if (fam === 'baseball')   return baseballStateHtml(s);
  if (fam === 'football')   return footballStateHtml(s);
  if (fam === 'basketball') return basketballStateHtml(s);
  if (fam === 'hockey')     return hockeyStateHtml(s);
  if (fam === 'soccer')     return soccerStateHtml(s);
  if (fam === 'tennis')     return tennisStateHtml(s);
  return `<div class="ca-lc-stateline"><span class="ca-lc-half">${esc(s.detail || s.clock || 'Live')}</span></div>`;
}

function matchupHtml(s) {
  const fam = famOf();
  if (fam === 'baseball') {
    const rows = [];
    if (s.batter)  rows.push(`<div class="ca-lc-mrow"><span class="ca-lc-mlbl">AB</span><span class="ca-lc-mname">${esc(s.batter)}</span>${s.batterLine ? `<span class="ca-lc-mline">${esc(s.batterLine)}</span>` : ''}</div>`);
    if (s.pitcher) rows.push(`<div class="ca-lc-mrow"><span class="ca-lc-mlbl">P</span><span class="ca-lc-mname">${esc(s.pitcher)}</span>${s.pitcherLine ? `<span class="ca-lc-mline">${esc(s.pitcherLine)}</span>` : ''}</div>`);
    if (Array.isArray(s.dueUp) && s.dueUp.length) rows.push(`<div class="ca-lc-mrow ca-lc-mrow--ondeck"><span class="ca-lc-mlbl">On deck</span><span class="ca-lc-mname">${esc(s.dueUp[0])}</span></div>`);
    if (!rows.length) return `<div class="ca-lc-mrow ca-lc-mrow--empty">Between batters</div>`;
    return rows.join('');
  }
  // Football/basketball/hockey statelines already render lastPlay — repeating it
  // here just doubled the text. Soccer/tennis statelines don't, so the last play
  // (when present) still earns the row; otherwise the cell stays situation-only.
  if (fam === 'football' || fam === 'basketball' || fam === 'hockey') return '';
  if (s.lastPlay) return `<div class="ca-lc-mrow"><span class="ca-lc-mlbl">Last</span><span class="ca-lc-mname">${esc(s.lastPlay)}</span></div>`;
  return '';
}

// ── Value pulse: signed (-100..+100) windowed line chart ─────────────────────
// (sport-agnostic; dims vary by container — the tab panel draws it wider)
function valuePulseSvg(history, color, live = true, dims = null) {
  const W = dims?.W || 260, H = dims?.H || 100, padL = 28, padR = 8, padT = 8, padB = 16;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const raw  = Array.isArray(history) ? history : [];
  const hist = raw.map(h => (typeof h === 'number' ? h : (h && typeof h.v === 'number' ? h.v : null))).filter(v => v !== null);
  const pers = raw.map(h => (typeof h === 'number' ? null : (h ? h.p : null)));
  if (hist.length < 2) {
    return `<svg class="ca-vp" viewBox="0 0 ${W} ${H}">
      <line x1="${padL}" y1="${padT + innerH / 2}" x2="${W - padR}" y2="${padT + innerH / 2}" class="ca-vp-zero"/>
      <text x="${W / 2}" y="${padT + innerH / 2 - 5}" class="ca-vp-axis" text-anchor="middle">building...</text></svg>`;
  }
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
        const bx = (padL + ((p - lo) / uspan) * innerW).toFixed(1);
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
  const ping = live ? `<circle class="ca-vp-ping" cx="${lx}" cy="${ly}" r="3.5" fill="${color}"/>` : '';
  return `<svg class="ca-vp" viewBox="0 0 ${W} ${H}">
    ${grid}${xaxis}
    <polygon points="${area}" fill="${color}" fill-opacity="0.10"/>
    <polyline class="${live ? 'ca-vp-line' : ''}" pathLength="1" points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    ${ping}
    <circle cx="${lx}" cy="${ly}" r="3.5" fill="${color}" stroke="#0d1117" stroke-width="1.5"/>
  </svg>`;
}

// The pulse tracks the slot the user is viewing; when that side has no CA pick
// the first tracked slot stands in — returning the key lets the panel say which.
function pickPulse(pulses) {
  if (!pulses) return { pulse: null, slot: null };
  if (_ctx && pulses[_ctx.activeSlot]) return { pulse: pulses[_ctx.activeSlot], slot: _ctx.activeSlot };
  const keys = Object.keys(pulses);
  return keys.length ? { pulse: pulses[keys[0]], slot: keys[0] } : { pulse: null, slot: null };
}

function pulseCellHtml(pulse, isFinal, dims = null, pickName = '') {
  if (!pulse) return `<div class="ca-lc-pulse-empty">No CA pick tracked on this game.</div>`;
  if (pulse.locked) {
    // No pick name here on purpose — the locked view must not reveal which
    // slots carry CA picks (same anti-leak rule as the blurred scores).
    return `<div class="ca-lc-pulse-locked" onclick="openSignup()" title="Members only">
      <div class="ca-vp-wrap ca-blurred">${valuePulseSvg([12, -8, 24, -16, 30, 5, -12, 22], '#FFD700', !isFinal, dims)}</div>
      <div class="ca-lc-pulse-lock"><i class="fa-solid fa-lock"></i> Unlock the ${isFinal ? 'value read' : 'live value read'}</div>
      <div class="ca-lc-pulse-sub"><a onclick="event.stopPropagation();openLogin()">Log in</a> or <a onclick="event.stopPropagation();openSignup()">create a free account</a></div>
    </div>`;
  }
  const color = pulse.color || '#8892a4';
  const v = (typeof pulse.value === 'number') ? pulse.value : 0;
  const caret = pulse.sign > 0 ? '▲' : pulse.sign < 0 ? '▼' : '•';
  const vtxt = `${v > 0 ? '+' : ''}${Math.round(v)}`;
  const approx = pulse.approx ? ` <span class="ca-lc-pulse-approx">approx</span>` : '';
  const winPct = (typeof pulse.winPct === 'number') ? ` <span class="ca-lc-pulse-wp ca-num">${pulse.winPct}%</span>` : '';
  const pick = pickName ? `<span class="ca-lc-pulse-pick">${esc(pickName)}</span> ` : '';
  const lead = isFinal ? '<span class="ca-lc-pulse-final">Closed</span> ' : `<span class="ca-lc-pulse-caret" style="color:${esc(color)}">${caret}</span> `;
  return `
    <div class="ca-vp-wrap">${valuePulseSvg(pulse.history, color, !isFinal, dims)}</div>
    <div class="ca-lc-pulse-label">${pick}${lead}<span class="ca-vp-val" style="color:${esc(color)}">${vtxt}</span> ${esc(pulse.label || '')}${approx}${winPct}</div>
    <a class="ca-lc-pulse-note" href="/faq#value-pulse" title="Our model rates this pick's live value from the game state versus where it locked. A probabilistic read, not a promise.">What this means</a>`;
}

function resultHtml(s) {
  const t = (_ctx && _ctx.teams) || {};
  const aN = esc(t.awayName || s.awayAbbr || 'Away'), hN = esc(t.homeName || s.homeAbbr || 'Home');
  const aR = s.awayScore ?? 0, hR = s.homeScore ?? 0;
  const winName = hR > aR ? hN : (aR > hR ? aN : null);
  const top = winName
    ? `<div class="ca-lc-mrow"><span class="ca-lc-mlbl">Final</span><span class="ca-lc-mname">${winName} win ${Math.max(aR, hR)}-${Math.min(aR, hR)}</span></div>`
    : `<div class="ca-lc-mrow"><span class="ca-lc-mlbl">Final</span><span class="ca-lc-mname">${aR}-${hR}</span></div>`;
  const last = s.lastPlay ? `<div class="ca-lc-mrow ca-lc-mrow--ondeck"><span class="ca-lc-mlbl">Last</span><span class="ca-lc-mname">${esc(s.lastPlay)}</span></div>` : '';
  return top + last;
}

// Basketball run detector: unanswered points across successive polls.
function trackRun(s) {
  if (famOf() !== 'basketball' || s.status !== 'in') { _run = null; return; }
  const h = s.homeScore ?? 0, a = s.awayScore ?? 0;
  if (!_run) { _run = { lastH: h, lastA: a, team: null, pts: 0 }; return; }
  const dh = h - _run.lastH, da = a - _run.lastA;
  if (dh > 0 && da === 0)      _run = { lastH: h, lastA: a, team: 'home', pts: (_run.team === 'home' ? _run.pts : 0) + dh };
  else if (da > 0 && dh === 0) _run = { lastH: h, lastA: a, team: 'away', pts: (_run.team === 'away' ? _run.pts : 0) + da };
  else if (dh > 0 || da > 0)   _run = { lastH: h, lastA: a, team: null, pts: 0 };
  else { _run.lastH = h; _run.lastA = a; }
}

// ── Main grid render (per poll) ────────────────────────────────────────────────
function render(el, data) {
  const s = data.state;
  const fam = famOf();
  const isFinal = s.status === 'post';
  trackRun(s);
  const pp = pickPulse(data.pulses);     // the pulse tab reads these
  _lastPulse = pp.pulse; _lastPulseSlot = pp.slot;
  _lastFinal = isFinal;
  const bets  = (_ctx && _ctx.betsHtml) || '';
  // Live/Final rides inside the line score's empty header cell — a full header
  // row above the scoreboard was a wasted line, especially on phones.
  const statusHtml = isFinal
    ? `<span class="ca-ls-status ca-ls-status--final">Final</span>`
    : `<span class="ca-ls-status ca-ls-status--live">Live <span class="ca-lc-livedot"></span></span>`;
  const midHd = fam === 'baseball' ? (isFinal ? 'Result' : 'At the plate') : (isFinal ? 'Result' : 'Situation');
  const matchupInner = isFinal ? resultHtml(s) : matchupHtml(s);

  const gridHtml = `
      <div class="ca-lc-grid">
        <div class="ca-lc-cell ca-lc-cell--score">
          ${boxscoreHtml(s, statusHtml)}
        </div>
        <div class="ca-lc-cell ca-lc-cell--matchup ca-lc-fam-${fam}">
          ${isFinal ? '' : situationHtml(s)}
          ${matchupInner ? `<div class="ca-lc-matchwrap">
            <div class="ca-lc-cell-hd">${midHd}</div>
            <div class="ca-lc-matchup">${matchupInner}</div>
          </div>` : ''}
        </div>
      </div>
      ${bets ? `<div class="ca-lc-betsrow"><span class="ca-lc-foot-lbl">Your tracked bets</span><div class="ca-lc-foot-bets">${bets}</div></div>` : ''}`;

  // First render builds the shell (grid + tabs + panel); later polls only swap
  // the grid so the active tab and its scroll never reset. The pulse tab is the
  // exception: it draws from this poll's data, so refresh it while it's active.
  let grid = el.querySelector('#ca-lc-grid-wrap');
  if (!grid) {
    el.innerHTML = `
      <div class="ca-lc">
        <div id="ca-lc-grid-wrap">${gridHtml}</div>
        <div id="ca-lc-tabs-wrap"></div>
      </div>`;
    renderTabs();
  } else {
    grid.innerHTML = gridHtml;
    if (_activeTab === 'pulse') renderTabs();
  }
}

// ── Tabs: Value pulse (the only chart) | Plays | Leaders | Stats ───────────────
const TABS = [
  { id: 'pulse',   label: 'Value pulse' },
  { id: 'plays',   label: 'Plays' },
  { id: 'leaders', label: 'Leaders' },
  { id: 'stats',   label: 'Stats' },
];

export function caLcSetTab(id) { _activeTab = id; renderTabs(); }
export function caLcToggleScoring(el) { _playsScoringOnly = !!el.checked; renderTabs(); }
if (typeof window !== 'undefined') { window.caLcSetTab = caLcSetTab; window.caLcToggleScoring = caLcToggleScoring; }

function renderTabs() {
  const wrap = document.getElementById('ca-lc-tabs-wrap');
  if (!wrap) return;
  // No feed (tennis): the strip still carries the pulse; the feed tabs drop off.
  const tabs = _feedSupported ? TABS : TABS.filter(t => t.id === 'pulse');
  if (!tabs.some(t => t.id === _activeTab)) _activeTab = 'pulse';

  const strip = tabs.map(t => {
    const dot = (t.id === 'pulse' && !_lastFinal) ? ' <span class="ca-lc-livedot"></span>' : '';
    return `<button class="ca-lc-tab${_activeTab === t.id ? ' ca-lc-tab--on' : ''}" onclick="caLcSetTab('${t.id}')">${t.label}${dot}</button>`;
  }).join('');
  let panel = '';
  if (_activeTab === 'pulse')        panel = pulsePanel();
  else if (_activeTab === 'plays')   panel = playsPanel();
  else if (_activeTab === 'leaders') panel = leadersPanel();
  else if (_activeTab === 'stats')   panel = statsPanel();
  wrap.innerHTML = `
    <div class="ca-lc-tabs">${strip}</div>
    <div class="ca-lc-panel">${panel}</div>`;
}

// The value pulse panel — the tracker's one and only chart. Drawn wider than the
// old grid cell because the panel spans the full command bar; refreshed by every
// ~12s /live poll while active.
function pulsePanel() {
  const dims = (typeof window !== 'undefined' && window.innerWidth <= 720)
    ? { W: 320, H: 120 } : { W: 560, H: 150 };
  const start = (_ctx && _ctx.startLabel) || '';
  const pickName = (_lastPulseSlot && _ctx?.slotLabels?.[_lastPulseSlot]) || '';
  return `<div class="ca-lc-pulse-panel">
    ${pulseCellHtml(_lastPulse, _lastFinal, dims, pickName)}
    ${start ? `<div class="ca-lc-time">${start}</div>` : ''}
  </div>`;
}

function periodTag(p) {
  if (p.period == null) return null;
  const sp = String(_ctx?.sport || '').toUpperCase();
  const fam = famOf();
  if (fam === 'baseball') return `${p.half === 'top' ? 'T' : p.half === 'bot' ? 'B' : ''}${p.period}`;
  const pre = fam === 'hockey' ? 'P' : (sp === 'CBB' || sp === 'WCBB' || fam === 'soccer') ? 'H' : 'Q';
  return `${pre}${p.period}`;
}

function playRow(p) {
  const t = (_ctx && _ctx.teams) || {};
  const who = p.team === 'home' ? (t.homeAbbr || 'HOME') : p.team === 'away' ? (t.awayAbbr || 'AWAY') : '';
  const score = (p.scoring && p.homeScore != null)
    ? `<span class="ca-lc-play-score ca-num">${p.awayScore}-${p.homeScore}</span>` : '';
  const when = [periodTag(p), p.clock].filter(Boolean).join(' ');
  return `<div class="ca-lc-play${p.scoring ? ' ca-lc-play--score' : ''}">
    <span class="ca-lc-play-when">${esc(when)}</span>
    <span class="ca-lc-play-team">${esc(who)}</span>
    <span class="ca-lc-play-text">${esc(p.text || '')}</span>${score}
  </div>`;
}

function playsPanel() {
  const fam = famOf();
  let plays = fam === 'soccer' ? (_feed?.soccer?.keyEvents || []) : (_feed?.plays || []);
  const scoringAll = _feed?.scoringPlays || [];
  if (_playsScoringOnly) plays = scoringAll;
  if (!plays.length) return `<div class="ca-lc-panel-empty">Play-by-play appears once the game starts.</div>`;
  const drive = (_feed?.drive && !_playsScoringOnly)
    ? `<div class="ca-lc-drive">Current drive: ${esc(_feed.drive.team === 'home' ? (_ctx?.teams?.homeAbbr || 'HOME') : (_ctx?.teams?.awayAbbr || 'AWAY'))}${_feed.drive.desc ? `, ${esc(_feed.drive.desc)}` : ''}${_feed.drive.start ? ` (from ${esc(_feed.drive.start)})` : ''}</div>`
    : '';
  const rows = plays.slice().reverse().map(p => fam === 'soccer'
    ? playRow({ ...p, clock: p.min, period: null })
    : playRow(p)).join('');
  return `
    <label class="ca-lc-scoring-toggle"><input type="checkbox" ${_playsScoringOnly ? 'checked' : ''} onchange="caLcToggleScoring(this)"> Scoring plays only</label>
    ${drive}
    <div class="ca-lc-plays">${rows}</div>`;
}

function leaderCol(list, name) {
  if (!Array.isArray(list) || !list.length) return `<div class="ca-lc-panel-empty">No leaders yet.</div>`;
  return `<div class="ca-lc-ldr-team">${esc(name)}</div>` + list.slice(0, 5).map(l => `
    <div class="ca-lc-ldr">
      ${l.headshot ? `<img class="ca-lc-ldr-hs" src="${esc(l.headshot)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
      <div class="ca-lc-ldr-body">
        <div class="ca-lc-ldr-name">${esc(l.name || '')}${l.pos ? ` <span class="ca-lc-ldr-pos">${esc(l.pos)}</span>` : ''}</div>
        <div class="ca-lc-ldr-line"><span class="ca-lc-ldr-cat">${esc(l.cat || '')}</span> ${esc(l.value || '')}</div>
      </div>
    </div>`).join('');
}

function leadersPanel() {
  const L = _feed?.leaders;
  const t = (_ctx && _ctx.teams) || {};
  // NHL: three stars lead the panel once awarded (finished games).
  const stars = (_feed?.hockey?.threeStars || []).slice(0, 3);
  const starsHtml = stars.length ? `
    <div class="ca-lc-ldr-team">Three stars</div>
    <div class="ca-lc-stars">${stars.map(s => `
      <div class="ca-lc-ldr">
        ${s.headshot ? `<img class="ca-lc-ldr-hs" src="${esc(s.headshot)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div class="ca-lc-ldr-body">
          <div class="ca-lc-ldr-name">${'★'.repeat(s.star || 1)} ${esc(s.name || '')}</div>
          <div class="ca-lc-ldr-line">${esc([s.team, s.position].filter(Boolean).join(' · '))}</div>
        </div>
      </div>`).join('')}</div>` : '';
  if (!L || (!L.home?.length && !L.away?.length)) {
    return starsHtml || `<div class="ca-lc-panel-empty">Top performers appear once the game gets going.</div>`;
  }
  return `${starsHtml}<div class="ca-lc-ldr-grid">
    <div>${leaderCol(L.away, t.awayName || t.awayAbbr || 'Away')}</div>
    <div>${leaderCol(L.home, t.homeName || t.homeAbbr || 'Home')}</div>
  </div>`;
}

function statsPanel() {
  const ts = _feed?.teamStats;
  const t = (_ctx && _ctx.teams) || {};
  if (!ts || (!ts.home?.length && !ts.away?.length)) return `<div class="ca-lc-panel-empty">Team stats appear once the game gets going.</div>`;
  const homeMap = new Map((ts.home || []).map(s => [s.label, s.value]));
  const labels = [...new Set([...(ts.away || []).map(s => s.label), ...(ts.home || []).map(s => s.label)])];
  const rows = labels.map(lbl => {
    const av = (ts.away || []).find(s => s.label === lbl)?.value ?? '—';
    const hv = homeMap.get(lbl) ?? '—';
    const an = parseFloat(String(av).replace(/[^\d.\-]/g, '')), hn = parseFloat(String(hv).replace(/[^\d.\-]/g, ''));
    let bar = '';
    if (!isNaN(an) && !isNaN(hn) && (an > 0 || hn > 0)) {
      const hp = Math.round((hn / (an + hn)) * 100);
      bar = `<div class="ca-lc-sbar-t ca-lc-sbar-t--stats"><div class="ca-lc-sbar-h" style="width:${100 - hp}%"></div></div>`;
    }
    return `<div class="ca-lc-stat-row">
      <span class="ca-lc-stat-v ca-num">${esc(String(av))}</span>
      <span class="ca-lc-stat-mid">${bar}<span class="ca-lc-stat-lbl">${esc(lbl)}</span></span>
      <span class="ca-lc-stat-v ca-num">${esc(String(hv))}</span>
    </div>`;
  }).join('');
  return `
    <div class="ca-lc-stat-head"><span>${esc(t.awayAbbr || 'Away')}</span><span></span><span>${esc(t.homeAbbr || 'Home')}</span></div>
    <div class="ca-lc-stats">${rows}</div>`;
}
