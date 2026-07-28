// modules/calcs.js — built-in betting calculators (the /tools math, native).
// A bottom sheet with a chip rail: No vig, EV, Parlay, Hold, Hedge, Kelly,
// Rollover. All math is client side and live (results update as you type).
// Opened from Settings > Betting calculators and the Tracking page link.

// ── Odds math ─────────────────────────────────────────────────────────────────
function parseAm(v) {
  const s = String(v ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  const n = parseFloat(s.replace('+', ''));
  if (!isFinite(n) || Math.abs(n) < 100) return null;
  return s.startsWith('-') ? -Math.abs(n) : Math.abs(n);
}
function amToDec(o) { return o < 0 ? 1 + 100 / Math.abs(o) : 1 + o / 100; }
function decToAm(d) {
  if (!isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
}
function fmtAm(o) { return o == null ? '—' : (o > 0 ? '+' + o : String(o)); }
function fmtPct(x, dp = 1) { return isFinite(x) ? (100 * x).toFixed(dp) + '%' : '—'; }
function fmtD(x) { return isFinite(x) ? (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2) : '—'; }
const num = (id) => { const v = parseFloat(document.getElementById(id)?.value); return isFinite(v) ? v : null; };
const am  = (id) => parseAm(document.getElementById(id)?.value);
const row = (l, v, cls = '') => `<div class="cx-row"><span>${l}</span><b class="${cls}">${v}</b></div>`;
const need = (msg) => `<div class="cx-need">${msg}</div>`;

// ── The tools ─────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    key: 'novig', label: 'No vig', title: 'No-vig fair odds',
    blurb: 'Strip the book margin from a two-way market to see the fair line.',
    form: `
      <label>Side A odds <input type="text" inputmode="text" id="cx-nv-a" placeholder="-110"></label>
      <label>Side B odds <input type="text" inputmode="text" id="cx-nv-b" placeholder="-110"></label>`,
    calc() {
      const a = am('cx-nv-a'), b = am('cx-nv-b');
      if (a == null || b == null) return need('Enter both sides in American odds, like -110 or +145.');
      const pa = 1 / amToDec(a), pb = 1 / amToDec(b);
      const total = pa + pb, hold = total - 1;
      const fa = pa / total, fb = pb / total;
      return row('Book hold (vig)', fmtPct(hold, 2)) +
        row('Side A fair probability', fmtPct(fa)) +
        row('Side A fair odds', fmtAm(decToAm(1 / fa)), 'pos') +
        row('Side B fair probability', fmtPct(fb)) +
        row('Side B fair odds', fmtAm(decToAm(1 / fb)), 'pos');
    },
  },
  {
    key: 'ev', label: 'EV', title: 'Expected value',
    blurb: 'What a bet is worth on average, given your win probability.',
    form: `
      <label>Your odds <input type="text" inputmode="text" id="cx-ev-o" placeholder="+120"></label>
      <label>Win probability (%) <input type="number" id="cx-ev-p" placeholder="48" min="0" max="100"></label>
      <label>Stake ($) <input type="number" id="cx-ev-s" placeholder="100" min="0"></label>`,
    calc() {
      const o = am('cx-ev-o'), p = num('cx-ev-p'), s = num('cx-ev-s');
      if (o == null || p == null || s == null) return need('Enter odds, your win probability, and a stake.');
      const dec = amToDec(o), pw = Math.min(Math.max(p / 100, 0), 1);
      const ev = pw * (dec - 1) * s - (1 - pw) * s;
      const be = 1 / dec;
      return row('Expected value', fmtD(ev), ev >= 0 ? 'pos' : 'neg') +
        row('EV per dollar', fmtPct(ev / s, 2), ev >= 0 ? 'pos' : 'neg') +
        row('Breakeven win rate', fmtPct(be)) +
        row('Your edge vs breakeven', fmtPct(pw - be, 2), pw - be >= 0 ? 'pos' : 'neg');
    },
  },
  {
    key: 'parlay', label: 'Parlay', title: 'Parlay payout',
    blurb: 'Combined odds and payout for up to 8 legs.',
    form: `
      <div id="cx-pl-legs">
        <label>Leg 1 odds <input type="text" inputmode="text" class="cx-pl-leg" placeholder="-110"></label>
        <label>Leg 2 odds <input type="text" inputmode="text" class="cx-pl-leg" placeholder="-110"></label>
      </div>
      <button type="button" class="cx-addleg" onclick="cxAddLeg()">+ Add a leg</button>
      <label>Stake ($) <input type="number" id="cx-pl-stake" placeholder="10" min="0"></label>`,
    calc() {
      const legs = [...document.querySelectorAll('.cx-pl-leg')]
        .map(i => parseAm(i.value)).filter(v => v != null);
      const s = num('cx-pl-stake');
      if (legs.length < 2) return need('Enter at least two legs in American odds.');
      const dec = legs.reduce((a, o) => a * amToDec(o), 1);
      const out = row('Legs counted', String(legs.length)) +
        row('Combined odds', fmtAm(decToAm(dec)), 'pos') +
        row('Implied probability', fmtPct(1 / dec));
      return s == null ? out
        : out + row('Total payout', fmtD(s * dec)) + row('Profit if it hits', fmtD(s * (dec - 1)), 'pos');
    },
  },
  {
    key: 'hold', label: 'Hold', title: 'Book hold',
    blurb: 'The margin a book keeps on any market, two-way or three-way.',
    form: `
      <label>Side A odds <input type="text" inputmode="text" id="cx-hd-a" placeholder="-110"></label>
      <label>Side B odds <input type="text" inputmode="text" id="cx-hd-b" placeholder="-110"></label>
      <label>Side C odds (3-way, optional) <input type="text" inputmode="text" id="cx-hd-c" placeholder=""></label>`,
    calc() {
      const a = am('cx-hd-a'), b = am('cx-hd-b'), c = am('cx-hd-c');
      if (a == null || b == null) return need('Enter at least two sides.');
      const ps = [a, b, ...(c != null ? [c] : [])].map(o => 1 / amToDec(o));
      const hold = ps.reduce((x, y) => x + y, 0) - 1;
      return row('Market implied total', fmtPct(1 + hold, 2)) +
        row('Book hold (vig)', fmtPct(hold, 2), hold > 0.06 ? 'neg' : '') +
        row('Hold per side', fmtPct(hold / ps.length, 2));
    },
  },
  {
    key: 'hedge', label: 'Hedge', title: 'Hedge a bet',
    blurb: 'Lock in a result by betting the other side at current odds.',
    form: `
      <label>Original odds <input type="text" inputmode="text" id="cx-hg-o" placeholder="+300"></label>
      <label>Original stake ($) <input type="number" id="cx-hg-s" placeholder="50" min="0"></label>
      <label>Other side odds now <input type="text" inputmode="text" id="cx-hg-h" placeholder="-140"></label>`,
    calc() {
      const o = am('cx-hg-o'), s = num('cx-hg-s'), h = am('cx-hg-h');
      if (o == null || s == null || h == null) return need('Enter the original bet and the hedge odds.');
      const decO = amToDec(o), decH = amToDec(h);
      const hs = (s * decO) / decH;
      const locked = s * decO - s - hs;
      return row('Hedge stake', fmtD(hs)) +
        row('Guaranteed profit either way', fmtD(locked), locked >= 0 ? 'pos' : 'neg') +
        row('If you skip the hedge: win', fmtD(s * (decO - 1)), 'pos') +
        row('If you skip the hedge: loss', fmtD(-s), 'neg');
    },
  },
  {
    key: 'kelly', label: 'Kelly', title: 'Kelly stake',
    blurb: 'A bankroll-scaled stake size from your edge. Most bettors use a fraction of it.',
    form: `
      <label>Your odds <input type="text" inputmode="text" id="cx-k-o" placeholder="+110"></label>
      <label>Win probability (%) <input type="number" id="cx-k-p" placeholder="50" min="0" max="100"></label>
      <label>Bankroll ($) <input type="number" id="cx-k-b" placeholder="1000" min="0"></label>`,
    calc() {
      const o = am('cx-k-o'), p = num('cx-k-p'), bk = num('cx-k-b');
      if (o == null || p == null || bk == null) return need('Enter odds, win probability, and bankroll.');
      const b = amToDec(o) - 1, pw = Math.min(Math.max(p / 100, 0), 1);
      const f = (b * pw - (1 - pw)) / b;
      if (f <= 0) return need('No edge at these numbers. Kelly says pass on this bet.');
      return row('Full Kelly', `${fmtPct(f)} of bankroll (${fmtD(bk * f)})`) +
        row('Half Kelly', fmtD(bk * f / 2), 'pos') +
        row('Quarter Kelly', fmtD(bk * f / 4)) +
        `<div class="cx-need">Full Kelly swings hard. Half or quarter tends to be the livable version.</div>`;
    },
  },
  {
    key: 'rollover', label: 'Rollover', title: 'Bonus rollover',
    blurb: 'What a deposit bonus really costs to clear.',
    form: `
      <label>Bonus amount ($) <input type="number" id="cx-r-b" placeholder="200" min="0"></label>
      <label>Rollover requirement (x) <input type="number" id="cx-r-x" placeholder="10" min="0"></label>
      <label>Average hold you bet into (%) <input type="number" id="cx-r-h" placeholder="4.5" min="0" step="0.1"></label>`,
    calc() {
      const b = num('cx-r-b'), x = num('cx-r-x'), h = num('cx-r-h');
      if (b == null || x == null) return need('Enter the bonus and its rollover multiplier.');
      const wager = b * x;
      const hold = (h == null ? 4.5 : h) / 100;
      const cost = wager * hold;
      const net = b - cost;
      return row('Required wagering', fmtD(wager)) +
        row('Expected cost to clear', fmtD(cost), 'neg') +
        row('Bonus net of clearing cost', fmtD(net), net >= 0 ? 'pos' : 'neg') +
        `<div class="cx-need">Cost assumes typical lines. Betting into lower-hold markets clears cheaper.</div>`;
    },
  },
];

let _cxKey = 'novig';
function cxAddLeg() {
  const box = document.getElementById('cx-pl-legs');
  if (!box || box.children.length >= 8) return;
  const n = box.children.length + 1;
  const lab = document.createElement('label');
  lab.innerHTML = `Leg ${n} odds <input type="text" inputmode="text" class="cx-pl-leg" placeholder="-110">`;
  box.appendChild(lab);
  wireCalc();
}
function cxRecalc() {
  const tool = TOOLS.find(t => t.key === _cxKey);
  const out = document.getElementById('cx-out');
  if (tool && out) out.innerHTML = tool.calc();
}
function wireCalc() {
  const body = document.getElementById('cx-body');
  if (!body) return;
  body.querySelectorAll('input').forEach(i => { i.oninput = cxRecalc; });
  cxRecalc();
}
function renderCalc() {
  const tool = TOOLS.find(t => t.key === _cxKey) || TOOLS[0];
  const chips = TOOLS.map(t =>
    `<button class="cx-chip${t.key === _cxKey ? ' on' : ''}" onclick="cxGo('${t.key}')">${t.label}</button>`).join('');
  const body = document.getElementById('cx-body');
  if (!body) return;
  body.innerHTML = `
    <div class="cx-chips">${chips}</div>
    <div class="cx-title">${tool.title}</div>
    <div class="cx-blurb">${tool.blurb}</div>
    <div class="cx-form">${tool.form}</div>
    <div class="cx-out" id="cx-out"></div>`;
  wireCalc();
}
function cxGo(key) { _cxKey = key; renderCalc(); }

export function openCalcs(key) {
  if (key && TOOLS.some(t => t.key === key)) _cxKey = key;
  let host = document.getElementById('cx-host');
  if (!host) { host = document.createElement('div'); host.id = 'cx-host'; document.body.appendChild(host); }
  host.innerHTML = `
    <div class="track-overlay open" onclick="if(event.target===this)closeCalcs()">
      <div class="track-sheet" role="dialog" aria-modal="true" aria-label="Betting calculators">
        <div class="track-sheet-grab"></div>
        <div class="track-sheet-head"><span>Calculators</span><button class="track-sheet-x" onclick="closeCalcs()" aria-label="Close">✕</button></div>
        <div id="cx-body" style="padding:2px 16px calc(18px + env(safe-area-inset-bottom));"></div>
      </div>
    </div>`;
  renderCalc();
}
export function closeCalcs() {
  const h = document.getElementById('cx-host');
  if (h) h.innerHTML = '';
}

Object.assign(window, { openCalcs, closeCalcs, cxGo, cxAddLeg });
