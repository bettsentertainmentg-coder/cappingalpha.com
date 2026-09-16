// src/capper_db_section.js — the CAPPER DATABASE section of the game page,
// server-rendered from the backers payload (src/game_backers.js).
//
// A literal port of docs/mockups/v2_game_backers_v18.json (the fragment Jack
// chose on 2026-09-16): same markup, same sizes, same spacing; class scope
// renamed .v18 -> .cdb. The filter pills and the Show more / collapse control
// are CSS-only (hidden radio + checkbox siblings), so the section works before
// game-detail.js runs and never re-renders. Colors follow the host contract
// (html.cm-tint / html.bm-ink / html.w-bleed) in public/game-detail.css; the
// team ink colors ride inline as CSS variables on the section root.
//
// Copy rules: heading = HEADING_LABEL (one constant, Jack still wants a
// media-style name), no explanatory prose in the section, the (i) holds the
// grading note in Jack's wording. No em dashes.

const fs = require('fs');
const path = require('path');

const HEADING_LABEL = 'Capper Report';   // Jack 2026-09-16 (was Capper Database)
const STAKE_LABEL = '$10 a pick';

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Team ink (the legible-on-dark color for a team) ──────────────────────────
let _teamColors = null;
function teamColorsMap() {
  if (_teamColors) return _teamColors;
  try { _teamColors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'team_colors.json'), 'utf8')); }
  catch (_) { _teamColors = {}; }
  return _teamColors;
}
const ABBR_ALIAS = { NBA: { NY: 'NYK', SA: 'SAS', GS: 'GSW', NO: 'NOP', UTAH: 'UTA' } };
function teamColorsFor(game, isHome) {
  const sport = String(game.sport || '').toUpperCase();
  const abbr = String(isHome ? (game.home_abbr || game.home_short || '') : (game.away_abbr || game.away_short || '')).toUpperCase();
  const bucket = teamColorsMap()[sport] || {};
  const alias = (ABBR_ALIAS[sport] || {})[abbr] || abbr;
  return bucket[abbr] || bucket[alias] || null;
}
function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function luminance(hex) {
  const c = hexToRgb(hex); if (!c) return 0;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function lighten(hex, amt) {
  const c = hexToRgb(hex); if (!c) return hex;
  const l = c.map((v) => Math.round(v + (255 - v) * amt));
  return '#' + l.map((v) => v.toString(16).padStart(2, '0')).join('');
}
function rgba(hex, a) {
  const c = hexToRgb(hex); if (!c) return `rgba(59,130,246,${a})`;
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
function hue(hex) {
  const c = hexToRgb(hex); if (!c) return null;
  const [r, g, b] = c.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.18) return null; // too grey to have a hue
  let h;
  if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  h = Math.round(h * 60); if (h < 0) h += 360;
  return h;
}
// The mock's rule (ATH gold, TB light blue): a bright secondary is the ink
// when the primary is near black; otherwise lift the primary until it reads.
function teamInk(colors, fallback) {
  if (!colors || !colors.primary) return fallback;
  const p = colors.primary, s = colors.secondary;
  // a grey or white secondary (NYY, DAL) is not an ink: lift the primary instead
  if (luminance(p) < 0.16 && s && luminance(s) > luminance(p) + 0.12 && hue(s) != null) return s;
  return luminance(p) < 0.42 ? lighten(p, 0.42) : p;
}
const isGoldish = (hex) => { const h = hue(hex); return h != null && h >= 35 && h <= 70 && luminance(hex) > 0.25; };

// ── Rows ─────────────────────────────────────────────────────────────────────
function moneyStr(u) {
  const v = Math.round(Number(u) || 0);
  return (v >= 0 ? '+$' : '-$') + Math.abs(v);
}
function roiStr(r) {
  if (r == null) return '';
  const v = Number(r);
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}% ROI`;
}
function nameHtml(name) {
  const n = String(name || '');
  const shown = n.length > 16 ? n.slice(0, 15) + '...' : n;
  const cls = n.length > 12 ? 'cdb-name cdb-name-sm' : 'cdb-name';
  return `<span class="${cls}">${esc(shown)}</span>`;
}
function chipHtml(ch) {
  if (ch.kind === 'sample') return `<span class="cdb-chip">Small sample</span>`;
  if (ch.kind === 'streak') return `<span class="stk ${ch.dir === 'W' ? 'stk-w' : 'stk-l'}">${esc(ch.text)} ${ch.dir === 'W' ? '🔥' : '❄️'}</span>`;
  if (ch.kind === 'season_money') {
    const u = Number(ch.units) || 0;
    return `<span class="sb sb-money"><b class="${u >= 0 ? 'pos' : 'neg'}">${moneyStr(u)}</b> this season</span>`;
  }
  if (ch.kind === 'season_record') {
    const t = ch.p ? `-<b class="t">${ch.p}</b>` : '';
    return `<span class="sb sb-record"><b class="w">${ch.w}</b>-<b class="l">${ch.l}</b>${t} this season</span>`;
  }
  return '';
}
function priceHtml(c) {
  const fmt = (o) => (o > 0 ? `+${o}` : `${o}`);
  const res = c.result ? `<b class="cdb-res cdb-res-${esc(c.result)}">${c.result === 'push' ? 'PUSH' : c.result === 'win' ? 'W' : 'L'}</b> ` : '';
  if (c.price != null) return `${res}at ${fmt(Math.round(c.price))}`;
  return `${res}no price,<br>graded at ${fmt(c.price_default)}`;
}
function rowHtml(c, sport) {
  const pk = `pk pk-${c.side}${c.result ? ' pk-res-' + esc(c.result) : ''}`;
  const chips = (c.chips || []).map(chipHtml).join('');
  return `<li class="cdb-row cdb-s-${esc(c.side)}">
<a class="cdb-link" href="${esc(c.profile_href)}" aria-label="${esc(c.name)}, ${esc(sport)} profile">
<span class="cdb-disc">${esc(c.initials)}</span>
<span class="cdb-main">
<span class="cdb-ident">${nameHtml(c.name)}<span class="src src-${esc(c.source_cls)}">${esc(c.source)}</span></span>
<span class="cdb-met"><span class="cdb-rec">${esc(c.record)}</span><span class="cdb-money ${c.units >= 0 ? 'cdb-pos' : 'cdb-neg'}">${moneyStr(c.units)}</span><span class="cdb-roi ${c.units >= 0 ? 'cdb-pos' : 'cdb-neg'}">${esc(roiStr(c.roi))}</span></span>
<span class="cdb-sub"><span class="cdb-when">${esc(c.recorded)}</span>${chips}${c.both_sides ? '<span class="cdb-chip">Both sides</span>' : ''}</span>
</span>
<span class="cdb-pick"><b class="${pk}">${esc(c.chip)}</b><span class="cdb-price">${priceHtml(c)}</span></span>
<i class="cdb-chev" aria-hidden="true"></i>
</a>
</li>`;
}

// ── The section ──────────────────────────────────────────────────────────────
function buildCapperDbSection(backers, game) {
  if (!backers) return '';
  const sport = backers.sport_label || backers.sport || '';
  const n = backers.counts ? backers.counts.all : 0;
  const cappers = backers.cappers || [];
  const awayC = teamColorsFor(game, false), homeC = teamColorsFor(game, true);
  let awayInk = teamInk(awayC, '#8fb3ff'), homeInk = teamInk(homeC, '#ff8a4c');
  if (awayInk.toLowerCase() === homeInk.toLowerCase()) homeInk = lighten(homeInk, 0.35);
  // Under is yellow; a gold or yellow team pushes it to a redder orange.
  const underInk = (isGoldish(awayInk) || isGoldish(homeInk)) ? '#ff7a5c' : '#fbbf24';
  const vars = [
    `--team-away-ink:${awayInk}`, `--team-away-tint:${rgba(awayInk, 0.14)}`,
    `--team-home-ink:${homeInk}`, `--team-home-tint:${rgba(homeInk, 0.14)}`,
    `--under-ink:${underInk}`, `--under-tint:${rgba(underInk, 0.16)}`,
  ].join(';');
  const short = n <= 3 ? ' cdb-short' : '';
  const awayAb = esc(backers.away_abbr || 'AWAY'), homeAb = esc(backers.home_abbr || 'HOME');
  const c = backers.counts || { all: 0, away: 0, home: 0, over: 0, under: 0 };
  const note = `Their record as we recorded it since July 2026, graded by us at the line and price we saw. It can differ from records they publish. ${STAKE_LABEL}. ${backers.unqualified} more capper${backers.unqualified === 1 ? '' : 's'} we track ${backers.unqualified === 1 ? 'has' : 'have'} not qualified in ${esc(sport)} yet.`;
  const locked = backers.locked ? `<li class="cdb-row cdb-locked"><a class="cdb-link" href="/#unlock"><span class="cdb-main"><span class="cdb-name">Who is on this game is for members</span><span class="cdb-sub"><span class="cdb-when">${c.all} capper${c.all === 1 ? '' : 's'} recorded before start. Unlock to see them.</span></span></span><i class="cdb-chev" aria-hidden="true"></i></a></li>` : '';
  const empty = !backers.locked && !cappers.length ? `<li class="cdb-row cdb-empty"><span class="cdb-link"><span class="cdb-main"><span class="cdb-sub"><span class="cdb-when">No qualified cappers recorded on this game${backers.frozen ? '' : ' yet'}.</span></span></span></span></li>` : '';
  return `<div class="cdb bleed-root" style="${vars}">
<div class="cdb-wrap${short}">
<input type="radio" name="cdbf" class="cdb-f cdb-f-all" id="cdb-f-all" checked>
<input type="radio" name="cdbf" class="cdb-f cdb-f-away" id="cdb-f-away">
<input type="radio" name="cdbf" class="cdb-f cdb-f-home" id="cdb-f-home">
<input type="radio" name="cdbf" class="cdb-f cdb-f-over" id="cdb-f-over">
<input type="radio" name="cdbf" class="cdb-f cdb-f-under" id="cdb-f-under">
<input type="checkbox" class="cdb-x" id="cdb-x">
<div class="cdb-head">
<h2 class="cdb-title">${esc(HEADING_LABEL)}</h2>
<p class="cdb-count">${n} capper${n === 1 ? '' : 's'} · ${esc(sport)} record · ${STAKE_LABEL}</p>
</div>
<div class="cdb-strip" role="group" aria-label="Filter by side">
<label class="cdb-tab cdb-t-all" for="cdb-f-all">All <b>${c.all}</b></label>
<label class="cdb-tab cdb-t-away" for="cdb-f-away">${awayAb} <b>${c.away}</b></label>
<label class="cdb-tab cdb-t-home" for="cdb-f-home">${homeAb} <b>${c.home}</b></label>
<label class="cdb-tab cdb-t-over" for="cdb-f-over">Over <b>${c.over}</b></label>
<label class="cdb-tab cdb-t-under" for="cdb-f-under">Under <b>${c.under}</b></label>
</div>
<ul class="cdb-list">
${locked}${empty}${cappers.map((x) => rowHtml(x, sport)).join('\n')}
</ul>
<label class="cdb-more" for="cdb-x"><span class="cdb-more-a">Show more</span><span class="cdb-more-b" aria-label="Collapse"><i class="cdb-up"></i></span></label>
<div class="cdb-foot">
<details class="cdb-info">
<summary aria-label="About these records">i</summary>
<p>${note}</p>
</details>
</div>
</div>
</div>`;
}

module.exports = { buildCapperDbSection, HEADING_LABEL, teamInk, teamColorsFor };
