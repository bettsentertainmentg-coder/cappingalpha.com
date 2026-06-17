// modules/unlock.js — "Unlock the CappingAlpha" upgrade page. Hero with the pricing
// (Unlock the CappingAlpha), the tracked-record widget (all-time record + best-window
// % / units / chart), an Action-style signup block above the comparison, the Free vs
// CappingAlpha comparison, and an all-time P/L chart. Reuses startCheckout() and
// /auth/signup; never changes prices.

import { state } from './state.js';
import { isViewer, isPaying } from './auth.js';
import { startCheckout } from './paywall.js';

const YES = '<span class="uc-yes">&#10003;</span>';
const NO  = '<span class="uc-no">&#8211;</span>';
const LOCK = '&#128274;';   // closed padlock
const UNLOCK = '&#128275;'; // open padlock

// All unlock-page styling lives here (injected once) so it can't be clobbered by
// parallel edits to index.html's <style> block.
const UNLOCK_CSS = `
.unlock-page { max-width:1040px; margin:0 auto; padding:28px 20px 80px; }
.unlock-h2 { font-size:24px; font-weight:800; text-align:center; margin:0 0 22px; font-family:'Space Grotesk',sans-serif; }
.unlock-hero { display:grid; grid-template-columns:1.1fr 0.9fr; gap:40px; align-items:center; padding:24px 0 52px; }
.unlock-eyebrow { color:var(--accent); font-weight:800; letter-spacing:0.3px; text-transform:none; font-size:16px; margin-bottom:10px; }
.unlock-hero-text h1 { font-size:52px; line-height:1.04; font-weight:900; margin:0 0 16px; font-family:'Space Grotesk',sans-serif; letter-spacing:-1px; }
.unlock-gold { color:var(--gold); }
.unlock-sub { font-size:18px; color:var(--muted); line-height:1.5; margin:0 0 22px; max-width:520px; }
.unlock-sub-link { color:var(--accent); cursor:pointer; text-decoration:underline; font-weight:700; }
.unlock-sub-link:hover { color:var(--text); }
.unlock-note { background:rgba(34,197,94,0.12); border:1px solid rgba(34,197,94,0.3); color:#4ade80; padding:12px 18px; border-radius:10px; font-weight:600; display:inline-block; }
.unlock-buy { margin-top:22px; }
.unlock-seewhat { display:inline-block; color:var(--accent); cursor:pointer; font-weight:700; font-size:14px; text-decoration:underline; }
.unlock-seewhat:hover { color:var(--text); }
/* "See everything you get  ·  Log in" — one left-aligned row, stays left even when
   the hero centers on phones. Wraps gracefully on very narrow screens. */
.unlock-hero-links { display:flex; align-items:center; justify-content:flex-start; gap:10px; flex-wrap:wrap; margin-top:16px; }
.unlock-hero-sep { color:var(--muted); }
.unlock-hero-login { color:var(--accent); cursor:pointer; font-weight:700; font-size:14px; text-decoration:underline; }
.unlock-hero-login:hover { color:var(--text); }
.unlock-buy-head { font-size:19px; font-weight:800; margin-bottom:12px; font-family:'Space Grotesk',sans-serif; }
.unlock-price-row { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; max-width:760px; margin:0 auto; }
.unlock-hero .unlock-price-row { gap:10px; max-width:none; margin:0; }
.unlock-price-card { position:relative; background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:26px 18px 20px; text-align:center; cursor:pointer; transition:transform .12s, border-color .12s; }
.unlock-hero .unlock-price-card { padding:16px 10px 13px; }
.unlock-price-card:hover { transform:translateY(-3px); border-color:var(--accent); }
.unlock-price-card.featured { border-color:var(--gold); box-shadow:0 0 30px rgba(255,215,0,0.12); }
.unlock-price-badge { position:absolute; top:-11px; left:50%; transform:translateX(-50%); background:var(--gold); color:#111; font-size:11px; font-weight:800; padding:3px 12px; border-radius:20px; white-space:nowrap; }
.unlock-hero .unlock-price-badge { font-size:10px; padding:2px 9px; top:-9px; }
.unlock-price-amt { font-size:40px; font-weight:800; color:var(--gold); }
.unlock-hero .unlock-price-amt { font-size:28px; }
.unlock-price-amt span { font-size:16px; color:var(--muted); font-weight:600; }
.unlock-hero .unlock-price-amt span { font-size:13px; }
.unlock-price-sub { font-size:13px; color:var(--muted); margin:6px 0 16px; }
.unlock-hero .unlock-price-sub { font-size:11px; margin:4px 0 12px; }
.unlock-price-btn { width:100%; padding:10px !important; font-size:15px !important; }
.unlock-hero .unlock-price-btn { padding:8px !important; font-size:13px !important; }
.ub-unlock { display:none; }
.unlock-price-card:hover .ub-lock { display:none; }
.unlock-price-card:hover .ub-unlock { display:inline; }
.unlock-hero-stats { display:flex; gap:16px; margin-top:30px; align-items:stretch; max-width:560px; }
.uhs-alltime { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px 18px; display:flex; flex-direction:column; justify-content:center; text-align:center; min-width:128px; }
.uhs-rec-big { font-size:32px; font-weight:900; color:#fff; font-family:'Space Grotesk',sans-serif; line-height:1; letter-spacing:-0.5px; }
.uhs-rec-sub { font-size:12px; color:var(--muted); margin-top:7px; }
.uhs-month { flex:1; background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:12px 16px 8px; min-width:0; }
.uhs-month-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-bottom:4px; }
.uhs-month-pct { font-size:15px; font-weight:800; color:var(--text); }
.uhs-month-units { font-size:14px; font-weight:800; white-space:nowrap; }
.uhs-month-units.pos { color:var(--green); } .uhs-month-units.neg { color:var(--red); }
.uhs-month-chart { height:72px; position:relative; }
.unlock-hero-art { position:relative; display:flex; justify-content:center; }
.unlock-phone { position:relative; width:270px; height:540px; background:#0a0c12; border-radius:40px; padding:12px; box-shadow:0 30px 70px rgba(0,0,0,0.6), 0 0 0 2px #2a2f3a, 0 0 50px rgba(255,215,0,0.12); z-index:2; }
.unlock-phone-notch { position:absolute; top:18px; left:50%; transform:translateX(-50%); width:92px; height:20px; background:#0a0c12; border-radius:12px; z-index:3; }
.unlock-phone-screen { width:100%; height:100%; background:var(--bg); border-radius:30px; overflow:hidden; padding:30px 14px 14px; }
.unlock-phone-glow { position:absolute; bottom:-30px; left:50%; transform:translateX(-50%); width:240px; height:60px; background:radial-gradient(ellipse, rgba(255,215,0,0.4) 0%, transparent 70%); filter:blur(10px); z-index:1; }
.uph-head { font-size:12px; font-weight:800; color:var(--muted); text-align:center; margin-bottom:12px; }
.uph-head span { color:var(--gold); }
.uph-row { display:flex; align-items:center; gap:8px; padding:9px 10px; border-radius:8px; margin-bottom:7px; background:var(--surface); }
.uph-bars { flex:1; display:flex; flex-direction:column; gap:4px; }
.uph-bars i { height:5px; border-radius:3px; background:var(--surface2); display:block; }
.uph-bars i:nth-child(1){width:70%;} .uph-bars i:nth-child(2){width:45%;} .uph-bars i:nth-child(3){width:60%;}
.uph-lock { color:var(--muted); font-size:12px; }
.uph-cta { margin-top:10px; text-align:center; font-size:11px; font-weight:800; color:#111; background:var(--gold); padding:8px; border-radius:8px; }
.uph-hero { background:linear-gradient(135deg, rgba(255,215,0,0.22), rgba(255,215,0,0.05)); border:1.5px solid var(--gold); border-radius:12px; padding:13px; display:flex; align-items:center; gap:12px; margin-bottom:14px; box-shadow:0 0 22px rgba(255,215,0,0.15); }
.uph-hero-rank { font-size:26px; font-weight:900; color:var(--gold); }
.uph-hero-team { font-size:14px; font-weight:800; color:var(--text); }
.uph-hero-tag { font-size:10px; font-weight:700; color:#4ade80; margin-top:3px; }
.uph-locked-label { font-size:9.5px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; text-align:center; }
.uph-locked { opacity:0.55; }
.unlock-pillars { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin:8px 0 46px; }
.unlock-pillar { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:18px; }
.unlock-pillar-title { font-weight:800; font-size:15px; margin-bottom:8px; color:var(--gold); }
.unlock-pillar-desc { font-size:13px; color:var(--muted); line-height:1.45; }
.unlock-account { margin:0 auto 48px; max-width:600px; }
.unlock-account-card { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:34px 44px; text-align:center; }
.unlock-account-h { font-size:22px; font-weight:800; margin-bottom:6px; font-family:'Space Grotesk',sans-serif; }
.unlock-account-sub { font-size:13px; color:var(--muted); margin-bottom:20px; line-height:1.5; }
.unlock-social { display:flex; flex-direction:column; gap:10px; }
.unlock-social-btn { display:flex; align-items:center; justify-content:center; gap:10px; width:100%; padding:11px 14px; border-radius:10px; border:1px solid var(--border); background:var(--surface2); color:var(--text); font-family:inherit; font-size:14px; font-weight:700; cursor:pointer; transition:border-color .12s, background .12s; }
.unlock-social-btn:hover { border-color:var(--accent); background:#222a3a; }
.unlock-social-btn span { font-weight:900; width:20px; height:20px; display:inline-flex; align-items:center; justify-content:center; border-radius:50%; font-size:13px; flex-shrink:0; }
.us-g { background:#fff; color:#4285F4; } .us-a { background:#fff; color:#000; } .us-f { background:#1877F2; color:#fff; }
.unlock-or { display:flex; align-items:center; gap:12px; color:var(--muted); font-size:12px; margin:18px 0; }
.unlock-or::before, .unlock-or::after { content:''; flex:1; height:1px; background:var(--border); }
.unlock-form { display:flex; flex-direction:column; gap:10px; }
.unlock-form input { width:100%; background:var(--surface2); border:1px solid var(--border); color:var(--text); padding:12px 14px; border-radius:10px; font-size:15px; font-family:inherit; }
.unlock-form input:focus { outline:none; border-color:var(--accent); }
.unlock-signup-btn { padding:12px !important; font-size:15px !important; margin-top:4px; }
.unlock-form-err { color:var(--red); font-size:13px; min-height:16px; text-align:left; }
.unlock-tos { font-size:12px; color:var(--muted); margin-top:16px; line-height:1.5; }
.unlock-tos a { color:var(--accent); cursor:pointer; }
.unlock-account-login { font-size:13px; color:var(--muted); margin-top:14px; }
.unlock-account-login a { color:var(--accent); cursor:pointer; font-weight:600; }
.unlock-compare-wrap { margin-bottom:48px; }
.unlock-compare { background:var(--surface); border:1px solid var(--border); border-radius:14px; overflow:hidden; max-width:760px; margin:0 auto; }
.uc-row { display:grid; grid-template-columns:1fr 110px 130px; align-items:center; padding:13px 18px; border-bottom:1px solid var(--border); }
.uc-row:last-child { border-bottom:none; }
.uc-head { background:var(--surface2); font-weight:800; font-size:13px; text-transform:uppercase; letter-spacing:0.5px; }
.uc-head .uc-col { text-align:center; }
.uc-head-ca { text-transform:none; }
.uc-feature { font-size:14px; color:var(--text); }
.uc-col { text-align:center; font-size:14px; }
.uc-gold { color:var(--gold); font-weight:700; }
.uc-yes { color:var(--green); font-weight:800; font-size:17px; }
.uc-col.uc-gold .uc-yes { color:var(--gold); }
.uc-no { color:var(--muted); }
.uc-partial { font-size:11px; color:var(--muted); }
.uc-topwin { color:var(--gold); font-weight:800; white-space:nowrap; }
.unlock-proof { text-align:center; background:linear-gradient(120deg, rgba(255,215,0,0.07), rgba(59,130,246,0.07)); border:1px solid var(--border); border-radius:14px; padding:26px 24px; margin-bottom:24px; }
.unlock-proof-pl-head { display:flex; align-items:baseline; justify-content:space-between; max-width:560px; margin:0 auto 6px; }
.unlock-proof-pl-label { font-size:12px; font-weight:800; letter-spacing:0.06em; text-transform:uppercase; color:var(--muted); }
.unlock-proof-pl-amt { font-size:30px; font-weight:900; font-family:'Space Grotesk',sans-serif; }
.unlock-proof-pl-amt.pos { color:var(--green); } .unlock-proof-pl-amt.neg { color:var(--red); }
.unlock-proof-chart-wrap { height:150px; max-width:560px; margin:0 auto; position:relative; }
.unlock-proof-snippet { font-size:15px; font-weight:600; color:var(--text); max-width:520px; margin:14px auto 4px; line-height:1.5; }
.unlock-proof-betsize { font-size:12px; color:var(--muted); margin-top:2px; }
.unlock-code-cta { text-align:center; font-size:14px; color:var(--muted); margin-top:8px; }
.unlock-code-cta a { color:var(--accent); cursor:pointer; font-weight:700; text-decoration:underline; }
.unlock-legal { text-align:center; font-size:12px; color:var(--muted); margin-top:18px; }
@media (max-width:820px) {
  .unlock-hero { grid-template-columns:1fr; gap:30px; text-align:center; }
  .unlock-hero-text h1 { font-size:40px; }
  .unlock-sub { margin-left:auto; margin-right:auto; }
  .unlock-hero-stats { margin-left:auto; margin-right:auto; flex-direction:column; }
  .unlock-pillars { grid-template-columns:repeat(2,1fr); }
  .uc-row { grid-template-columns:1fr 70px 90px; }
}`;

function injectUnlockCss() {
  if (document.getElementById('unlock-css')) return;
  const st = document.createElement('style');
  st.id = 'unlock-css';
  st.textContent = UNLOCK_CSS;
  document.head.appendChild(st);
}

const COMPARE = [
  ['Today\'s top-ranked pick', true, true],
  ['Live game intel (lines, weather, pitchers)', true, true],
  ['Market signals (line moves, public %, Polymarket, Kalshi)', true, true],
  ['Permanent pick-history archive', true, true],
  ['Every sport, every day (MLB, NBA, WNBA, NHL, Tennis, Golf)', true, true],
  ['Vote and track your own P/L', true, true],
  ['Every pick\'s score and conviction', '#1 only', true],
  ['MVP picks, full long-term record', 'recent only', true],
  ['__ALLPICKS__', false, true],
  ['Zero ads', false, true],
];

const PILLARS = [
  ['Trained AI agents', 'Specialized agents, each tuned to a different signal, weigh public data in real time before a pick ever scores.'],
  ['Player tracking', 'Form, injuries, rest days, home and away splits, who is hot and who is cold, all factored in.'],
  ['Book line reference', 'Opening lines lock each morning as the baseline, so every pick is measured against what the market said.'],
  ['Cross-market validation', 'Picks are cross-checked against prediction markets to surface where independent markets agree, or disagree, with the books.'],
];

function cell(v) {
  if (v === true) return YES;
  if (v === false) return NO;
  return `<span class="uc-partial">${v}</span>`;
}

// ── Tracked-record P/L (mirrors the #1 pick card's math) ───────────────────────
const _RANGES = [
  { days: 1, label: '1-Day' }, { days: 5, label: '5-Day' }, { days: 7, label: '7-Day' },
  { days: 21, label: '21-Day' }, { days: 30, label: '1-Month' }, { days: 90, label: '3-Month' },
  { days: Infinity, label: 'All-Time' },
];
const _MIN = 5;

function _resolved(picks) {
  return (picks || []).filter(p => ['win', 'loss', 'push'].includes(p.result) && !(p.annotation && p.annotation.includes('not counted')));
}
function _filterDays(picks, days) {
  if (!isFinite(days)) return picks.slice();
  const c = new Date(); c.setDate(c.getDate() - days);
  const cut = c.toISOString().slice(0, 10);
  return picks.filter(p => (p.game_date || '') >= cut);
}
function _stats(picks, range) {
  const wins = picks.filter(p => p.result === 'win').length;
  const losses = picks.filter(p => p.result === 'loss').length;
  const decided = wins + losses;
  return { ...(range || {}), picks, wins, losses, decided, winRate: decided ? wins / decided : 0 };
}
// "7-Day" -> "through 7 days", "1-Month" -> "through 1 month", "All-Time" -> "all-time".
function _winPhrase(label) {
  if (!label || label === 'All-Time') return 'all-time';
  const m = /^(\d+)-(Day|Month)$/.exec(label);
  if (!m) return label.toLowerCase();
  const n = Number(m[1]);
  return `through ${n} ${m[2].toLowerCase()}${n === 1 ? '' : 's'}`;
}
function _bestWindow(resolved) {
  if (!resolved.length) return null;
  let best = null;
  for (const r of _RANGES) {
    const w = _stats(_filterDays(resolved, r.days), r);
    if (w.decided < _MIN) continue;
    if (!best || w.winRate > best.winRate || (w.winRate === best.winRate && w.decided > best.decided)) best = w;
  }
  if (!best) { const all = _stats(resolved.slice(), _RANGES[_RANGES.length - 1]); return all.decided ? all : null; }
  return best;
}
function _ret(pick, unit) {
  const r = (pick.result || '').toLowerCase();
  if (r === 'push' || r === 'pending' || !r) return 0;
  if (r === 'loss') return -unit;
  const type = (pick.pick_type || '').toLowerCase();
  let odds = type === 'ml' ? (pick.ml_odds || -115) : (type === 'over' || type === 'under') ? (pick.ou_odds || -115) : -115;
  if (!odds) odds = -115;
  return odds < 0 ? +(unit * (100 / Math.abs(odds))).toFixed(2) : +(unit * (odds / 100)).toFixed(2);
}
function _series(picks, unit) {
  const sorted = picks.slice().sort((a, b) => (a.saved_at || a.game_date || '').localeCompare(b.saved_at || b.game_date || ''));
  const byDate = {};
  for (const p of sorted) { const d = p.game_date || 'x'; (byDate[d] ||= []).push(p); }
  const dates = Object.keys(byDate).sort();
  let cum = 0; const labels = [], values = [];
  if (dates.length < 2) {
    sorted.forEach((p, i) => { cum += _ret(p, unit); labels.push('P' + (i + 1)); values.push(+cum.toFixed(2)); });
  } else {
    for (const d of dates) {
      cum += byDate[d].reduce((s, p) => s + _ret(p, unit), 0);
      const dt = new Date(d + 'T12:00:00');
      labels.push(dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      values.push(+cum.toFixed(2));
    }
  }
  return { labels, values, total: +cum.toFixed(2) };
}

const _charts = {};
function drawChart(id, { labels, values, total }) {
  const ctx = document.getElementById(id);
  if (!ctx || typeof Chart === 'undefined') return;
  if (_charts[id]) { _charts[id].destroy(); }
  const color = total >= 0 ? '#22c55e' : '#ef4444';
  _charts[id] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ data: values, borderColor: color, backgroundColor: color + '20', borderWidth: 3, pointRadius: 0, pointHoverRadius: 4, fill: true, tension: 0.4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1e2330', borderColor: '#252c3b', borderWidth: 1, titleColor: '#e2e8f0', bodyColor: '#8892a4', padding: 8, displayColors: false, callbacks: { label: c => `$${Number(c.parsed.y).toFixed(2)}` } } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
}

function buildHeroStats(data, bet, best) {
  const resolved = _resolved(data?.picks || []);
  if (resolved.length < 3) return { html: '', bestSeries: null };
  const all = _stats(resolved);
  const allPct = all.decided ? Math.round(all.winRate * 100) : null;
  const win = best || _stats(resolved, { label: 'All-Time' });
  const bs = _series(win.picks, bet);
  const units = bs.total / bet;
  const upos = bs.total >= 0;
  const bestPct = Math.round(win.winRate * 100);
  const html = `
    <div class="uhs-alltime">
      <div class="uhs-rec-big">${all.wins}-${all.losses}</div>
      <div class="uhs-rec-sub">${allPct != null ? allPct + '% ' : ''}all time</div>
    </div>
    <div class="uhs-month">
      <div class="uhs-month-head">
        <span class="uhs-month-pct">${bestPct}% ${win.label.toLowerCase()}</span>
        <span class="uhs-month-units ${upos ? 'pos' : 'neg'}">${upos ? '+' : '-'}${Math.abs(units).toFixed(1)} units</span>
      </div>
      <div class="uhs-month-chart"><canvas id="unlock-month-chart"></canvas></div>
    </div>`;
  return { html, bestSeries: win.picks.length >= 2 ? bs : null };
}

function buildProof(data, bet) {
  const resolved = _resolved(data?.picks || []);
  if (!resolved.length) return { html: `<div class="unlock-proof-snippet">The tracked record builds daily. Every MVP pick (50+ points) is logged long term, win or lose.</div>`, series: null };
  const s = _series(resolved, bet);
  const pos = s.total >= 0;
  const amt = `${pos ? '+' : '-'}$${Math.abs(s.total).toFixed(2)}`;
  const html = `
    <div class="unlock-proof-pl-head"><span class="unlock-proof-pl-label">All-Time P/L</span><span class="unlock-proof-pl-amt ${pos ? 'pos' : 'neg'}">${amt}</span></div>
    <div class="unlock-proof-chart-wrap"><canvas id="unlock-pl-chart"></canvas></div>
    <div class="unlock-proof-betsize">Based on a flat $${bet} bet size. Every MVP pick (50+ points) is tracked long term, win or lose.</div>`;
  return { html, series: s };
}

function priceCard(plan, price, unit, sub, featured, paying) {
  return `
    <div class="unlock-price-card${featured ? ' featured' : ''}" onclick="unlockBuy('${plan}')">
      ${featured ? '<div class="unlock-price-badge">Most popular</div>' : ''}
      <div class="unlock-price-amt">${price}<span>${unit}</span></div>
      <div class="unlock-price-sub">${sub}</div>
      <button class="btn ${featured ? 'btn-gold' : 'btn-primary'} unlock-price-btn">
        <span class="ub-lock">${LOCK}</span><span class="ub-unlock">${UNLOCK}</span> ${paying ? 'Manage' : 'Unlock'}
      </button>
    </div>`;
}

function unlockHtml() {
  const viewer = isViewer();
  const paying = isPaying();

  const buyBlock = paying
    ? `<div class="unlock-note" style="margin-top:22px;">You are unlocked. Thanks for being a member.</div>`
    : `<div class="unlock-buy">
         <div class="unlock-buy-head"><span class="unlock-gold">Unlock</span> the CappingAlpha</div>
         <div class="unlock-price-row">
           ${priceCard('day', '$1', '/day', 'One day', false, paying)}
           ${priceCard('week', '$4', '/week', 'Cancel anytime', false, paying)}
           ${priceCard('year', '$75', '/year', 'Best value', true, paying)}
         </div>
       </div>`;

  const lockedRows = [1, 2, 3, 4].map(() =>
    `<div class="uph-row uph-locked"><span class="uph-bars"><i></i><i></i><i></i></span><span class="uph-lock">&#128274;</span></div>`).join('');

  const compareRows = COMPARE.map(([label, free, paid]) => {
    const text = label === '__ALLPICKS__' ? `All picks, ranked by our score <span class="uc-topwin" id="uc-topwin"></span>` : label;
    return `
    <div class="uc-row">
      <div class="uc-feature">${text}</div>
      <div class="uc-col">${cell(free)}</div>
      <div class="uc-col uc-gold">${cell(paid)}</div>
    </div>`;
  }).join('');

  const pillars = PILLARS.map(([t, d]) => `
    <div class="unlock-pillar">
      <div class="unlock-pillar-title">${t}</div>
      <div class="unlock-pillar-desc">${d}</div>
    </div>`).join('');

  // Action-style account block, only for logged-out visitors.
  const accountSection = (viewer && !paying) ? `
    <section class="unlock-account" id="unlock-account">
      <div class="unlock-account-card">
        <h2 class="unlock-account-h">Create your account</h2>
        <p class="unlock-account-sub">Free gets you the number one pick. Make an account in seconds, then unlock all picks whenever you want.</p>
        <div class="unlock-social">
          <button class="unlock-social-btn" onclick="window.__unlockSoc('Google')"><span class="us-g">G</span> Continue with Google</button>
        </div>
        <div class="unlock-or"><span>or</span></div>
        <div class="unlock-form">
          <input id="ua-email" type="email" placeholder="Email address" autocomplete="email" />
          <input id="ua-username" type="text" placeholder="Username" autocomplete="username" />
          <input id="ua-password" type="password" placeholder="Password" autocomplete="new-password" />
          <input id="ua-confirm" type="password" placeholder="Confirm password" autocomplete="new-password" />
          <button class="btn btn-primary unlock-signup-btn" onclick="window.__unlockSignup()">Create Account</button>
          <div class="unlock-form-err" id="ua-err"></div>
        </div>
        <div class="unlock-tos">By continuing, you agree to CappingAlpha's <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</div>
        <div class="unlock-account-login">Already have an account? <a onclick="openLogin()">Log in</a> &middot; <a onclick="openCodeModal()">I have a code</a></div>
      </div>
    </section>` : '';

  return `
  <div class="unlock-page">

    <section class="unlock-hero">
      <div class="unlock-hero-text">
        <h1>The edge, <span class="unlock-gold">unlocked</span>.</h1>
        <p class="unlock-sub">Every game, every day, ranked through our <a class="unlock-sub-link" onclick="switchTab('about');setTimeout(()=>document.getElementById('about-algo')?.scrollIntoView({behavior:'smooth',block:'start'}),60)">proprietary scoring engine</a> and expert analysts. All the data, fed straight to your screen.</p>
        ${buyBlock}
        <div class="unlock-hero-links">
          <a class="unlock-seewhat" onclick="document.getElementById('unlock-whatyouget')?.scrollIntoView({behavior:'smooth',block:'start'})">See everything you get &darr;</a>
          ${paying ? '' : `<span class="unlock-hero-sep">&middot;</span><a class="unlock-hero-login" onclick="openLogin()">Have an account? Log in</a>`}
        </div>
        <div class="unlock-hero-stats" id="unlock-hero-stats"></div>
      </div>
      <div class="unlock-hero-art">
        <div class="unlock-phone">
          <div class="unlock-phone-notch"></div>
          <div class="unlock-phone-screen">
            <div class="uph-head">Capping<span>Alpha</span> &middot; Top Picks</div>
            <div class="uph-hero">
              <div class="uph-hero-rank">#1</div>
              <div>
                <div class="uph-hero-team">Today's Top Pick</div>
                <div class="uph-hero-tag">Free to view</div>
              </div>
            </div>
            <div class="uph-locked-label">Every other pick, unlocked with CappingAlpha</div>
            ${lockedRows}
            <div class="uph-cta">Unlock all picks</div>
          </div>
        </div>
        <div class="unlock-phone-glow"></div>
      </div>
    </section>

    <section class="unlock-pillars">${pillars}</section>

    ${accountSection}

    <section class="unlock-compare-wrap" id="unlock-whatyouget">
      <h2 class="unlock-h2">What you get</h2>
      <div class="unlock-compare">
        <div class="uc-row uc-head">
          <div class="uc-feature"></div>
          <div class="uc-col">Free</div>
          <div class="uc-col uc-gold uc-head-ca">CappingAlpha</div>
        </div>
        ${compareRows}
      </div>
    </section>

    <section class="unlock-proof" id="unlock-proof">
      <div class="unlock-proof-pl-head"><span class="unlock-proof-pl-label">All-Time P/L</span><span class="unlock-proof-pl-amt pos">&nbsp;</span></div>
      <div class="unlock-proof-chart-wrap"></div>
      <div class="unlock-proof-betsize">Loading the tracked record...</div>
    </section>

    <div class="unlock-code-cta">Have an access code? <a onclick="openCodeModal()">Redeem it here</a></div>

    <div class="unlock-legal">21+. Gamble responsibly. CappingAlpha is information, not a guarantee of any outcome.</div>
  </div>`;
}

export async function renderUnlock() {
  const panel = document.getElementById('panel-unlock');
  if (!panel) return;
  injectUnlockCss();
  panel.innerHTML = unlockHtml();
  try {
    const data = await fetch('/api/mvp/public').then(r => r.json());
    const bet = parseFloat(state.CONFIG?.bet_unit) || 10;
    const best = _bestWindow(_resolved(data?.picks || []));

    const heroEl = document.getElementById('unlock-hero-stats');
    if (heroEl) { const h = buildHeroStats(data, bet, best); heroEl.innerHTML = h.html; if (h.bestSeries) drawChart('unlock-month-chart', h.bestSeries); }

    const tw = document.getElementById('uc-topwin');
    if (tw && best) tw.innerHTML = `(${Math.round(best.winRate * 100)}% ${_winPhrase(best.label)})`;

    const proofEl = document.getElementById('unlock-proof');
    if (proofEl) { const p = buildProof(data, bet); proofEl.innerHTML = p.html; if (p.series) drawChart('unlock-pl-chart', p.series); }
  } catch (_) { /* leave the static blocks */ }

  // Came here from a "sign up" action (login popup, drawer Premium Access, etc.)?
  // Center the "Create your account" card. We scroll AFTER the async fills above so
  // the hero stats / proof have already re-flowed the page — otherwise the form
  // landed half off-screen. rAF waits for that layout to settle.
  if (window.__caScrollAccount) {
    window.__caScrollAccount = false;
    const acct = document.getElementById('unlock-account');
    if (acct) requestAnimationFrame(() => acct.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }
}

// Inline signup (Action-style block). Consent is via the "By continuing" line, so we
// send tos_agreed:true. Same /auth/signup endpoint as the modal.
async function unlockSignup() {
  const email = (document.getElementById('ua-email')?.value || '').trim();
  const username = (document.getElementById('ua-username')?.value || '').trim();
  const password = document.getElementById('ua-password')?.value || '';
  const confirm = document.getElementById('ua-confirm')?.value || '';
  const err = document.getElementById('ua-err');
  if (err) { err.style.color = ''; err.textContent = ''; }
  if (!email || !password) { if (err) err.textContent = 'Email and password are required.'; return; }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) { if (err) err.textContent = 'Username must be 3 to 20 letters, numbers, or underscores.'; return; }
  if (password.length < 8) { if (err) err.textContent = 'Password must be at least 8 characters.'; return; }
  if (password !== confirm) { if (err) err.textContent = 'Passwords do not match.'; return; }
  try {
    const res = await fetch('/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, username, password, tos_agreed: true }) });
    const data = await res.json();
    if (!res.ok) { if (err) err.textContent = data.error || 'Signup failed.'; return; }
    location.reload();
  } catch (_) { if (err) err.textContent = 'Network error. Try again.'; }
}

// Load Google Identity Services once. Resolves when google.accounts.oauth2 exists.
function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    let s = document.getElementById('gis-script');
    if (s) { s.addEventListener('load', () => resolve()); s.addEventListener('error', () => reject(new Error('gis'))); return; }
    s = document.createElement('script');
    s.id = 'gis-script';
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('gis'));
    document.head.appendChild(s);
  });
}

// "Continue with Google". Uses the GIS token model so we keep our own button.
// On consent we get an access token, hand it to /auth/google, and the server
// validates it with Google + creates/links the account. Dormant until a
// google_client_id is present in /api/config.
async function unlockSoc(provider) {
  const err = document.getElementById('ua-err');
  if (err) { err.style.color = 'var(--muted)'; err.textContent = ''; }
  const clientId = state.CONFIG?.google_client_id;
  if (provider !== 'Google' || !clientId) {
    if (err) err.textContent = `${provider} sign-in is coming soon. Create an account with email below for now.`;
    return;
  }
  try {
    await loadGis();
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'openid email profile',
      callback: async (resp) => {
        if (resp.error || !resp.access_token) { if (err) { err.style.color = ''; err.textContent = 'Google sign-in was cancelled.'; } return; }
        try {
          const r = await fetch('/auth/google', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: resp.access_token }),
          });
          const data = await r.json();
          if (!r.ok) { if (err) { err.style.color = ''; err.textContent = data.error || 'Google sign-in failed.'; } return; }
          location.reload();
        } catch (_) { if (err) { err.style.color = ''; err.textContent = 'Network error. Try again.'; } }
      },
    });
    tokenClient.requestAccessToken();
  } catch (_) {
    if (err) { err.style.color = ''; err.textContent = 'Could not reach Google. Try again.'; }
  }
}

// Price-card click. Logged out: stay on the page and scroll to the account block
// (remember the plan so checkout auto-resumes after signup). Logged in: checkout.
function unlockBuy(plan) {
  if (!state.currentUser) {
    try { sessionStorage.setItem('pendingPlan', plan); } catch (_) {}
    const acct = document.getElementById('unlock-account');
    if (acct) acct.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else window.openSignup?.();
    return;
  }
  startCheckout(plan);
}

Object.assign(window, { renderUnlock, unlockBuy, __unlockSignup: unlockSignup, __unlockSoc: unlockSoc });
