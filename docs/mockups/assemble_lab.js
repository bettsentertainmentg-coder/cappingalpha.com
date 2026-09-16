// Assembles a "Who is on this game" phone lab from one or more workflow journals.
// usage: node assemble_lab.js <out.html> [--include 1,6,8] [--title "..."] [--sub "..."] <journal.jsonl> [more journals...]
const fs = require('fs');
const argv = process.argv.slice(2);
const outPath = argv.shift();
let include = null, title = 'Who Is On This Game Lab', sub = 'seven directions for the game page, phone first, same nine cappers in every one';
const journals = [];
while (argv.length) {
  const a = argv.shift();
  if (a === '--include') include = argv.shift().split(',').map(Number);
  else if (a === '--title') title = argv.shift();
  else if (a === '--sub') sub = argv.shift();
  else journals.push(a);
}
const variants = new Map(); // n -> design (last wins: fix after design)
function walk(o) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { o.forEach(walk); return; }
  if (typeof o.html === 'string' && typeof o.css === 'string' && Number.isInteger(o.variant)) { variants.set(o.variant, o); return; }
  for (const v of Object.values(o)) walk(v);
}
for (const j of journals) for (const l of fs.readFileSync(j, 'utf8').split('\n').filter(Boolean)) { try { walk(JSON.parse(l)); } catch (_) {} }
let order = [...variants.keys()].sort((a, b) => a - b);
if (include) order = include.filter(n => variants.has(n));
console.error('variants:', order.join(','));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const bad = /—/g;
const gameHeader = `
<div class="gh">
  <div class="gh-top"><span class="gh-sport">NFL · Sun 1:00 PM ET · Soldier Field</span><span class="gh-live">Pregame</span></div>
  <div class="gh-teams">
    <div class="gh-team"><div class="mark" style="background:#0a2a5c;color:#fff">DAL</div><div class="gh-name">Cowboys</div><div class="gh-rec">1-1</div></div>
    <div class="gh-at">at</div>
    <div class="gh-team"><div class="mark" style="background:#c83803;color:#fff">CHI</div><div class="gh-name">Bears</div><div class="gh-rec">1-1</div></div>
  </div>
  <div class="gh-lines"><span>Spread DAL -1.5</span><span>ML DAL -125 / CHI +105</span><span>Total 44.5</span></div>
  <div class="gh-tabs"><span class="on">CAPPERS</span><span>LINES</span><span>BETTING</span><span>FORM</span><span>INJURIES</span></div>
</div>`;
const nextStub = `
<div class="next-stub">
  <div class="ns-h"><span>Lines · all bet types</span><span class="ns-tabs"><b>SPREAD</b>WIN · TOTAL</span></div>
  <div class="ns-row"><span>DraftKings</span><span>DAL -1.5 (-110)</span><span>CHI +1.5 (-110)</span></div>
  <div class="ns-row"><span>FanDuel</span><span>DAL -1.5 (-108)</span><span>CHI +1.5 (-112)</span></div>
  <div class="ns-h" style="margin-top:14px"><span>Public betting</span><span class="ns-tabs">tickets · money</span></div>
  <div class="ns-row"><span>Spread</span><span>DAL 61% · CHI 39%</span><span>$ 58 / 42</span></div>
</div>`;
const mlbHeader = `
<div class="gh">
  <div class="gh-top"><span class="gh-sport">MLB · Tue 6:40 PM ET</span><span class="gh-live">Pregame</span></div>
  <div class="gh-teams">
    <div class="gh-team"><div class="mark" style="background:#003831;color:#efb21e">ATH</div><div class="gh-name">Athletics</div><div class="gh-rec">72-79</div></div>
    <div class="gh-at">at</div>
    <div class="gh-team"><div class="mark" style="background:#092c5c;color:#8fbce6">TB</div><div class="gh-name">Rays</div><div class="gh-rec">75-76</div></div>
  </div>
  <div class="gh-lines"><span>Run line TB -1.5</span><span>ML ATH +228 / TB -285</span><span>Total 7.5</span></div>
  <div class="gh-tabs"><span class="on">CAPPERS</span><span>LINES</span><span>BETTING</span><span>FORM</span><span>INJURIES</span></div>
</div>`;
const mlbStub = `
<div class="next-stub">
  <div class="ns-h"><span>Lines · all bet types</span><span class="ns-tabs"><b>RUN LINE</b>WIN · TOTAL</span></div>
  <div class="ns-row"><span>DraftKings</span><span>ATH +1.5 (-150)</span><span>TB -1.5 (+125)</span></div>
  <div class="ns-row"><span>FanDuel</span><span>ATH +1.5 (-148)</span><span>TB -1.5 (+122)</span></div>
  <div class="ns-h" style="margin-top:14px"><span>Public betting</span><span class="ns-tabs">tickets · money</span></div>
  <div class="ns-row"><span>Moneyline</span><span>ATH 34% · TB 66%</span><span>$ 41 / 59</span></div>
</div>`;
const chrome = fs.readFileSync(__dirname + '/lab_chrome.html', 'utf8')
  .replace('Who Is On This Game Lab</title>', esc(title) + '</title>')
  .replace('<b>Who Is On This Game Lab</b><span>seven directions for the game page, phone first, same nine cappers in every one</span>', `<b>${esc(title)}</b><span>${esc(sub)}</span>`);
const css = order.map(n => variants.get(n).css.replace(bad, '-')).join('\n\n');
const screens = order.map(n => {
  const v = variants.get(n);
  const mlb = n >= 18; return `<div class="screen-body${n >= 13 ? ' nopad' : ''}${mlb ? ' mlb' : ''}" data-v="${n}" ${n === order[0] ? '' : 'hidden'}>${mlb ? mlbHeader : gameHeader}${v.html.replace(bad, '-')}${mlb ? mlbStub : nextStub}</div>`;
}).join('\n');
const pills = order.map(n => `<button class="mpill${n === order[0] ? ' on' : ''}" data-v="${n}"><b>${n}</b>${esc(variants.get(n).name)}</button>`).join('');
const notes = order.map(n => { const v = variants.get(n); const h = v.estimated_height_px ? ` <span>(about ${v.estimated_height_px}px tall)</span>` : ''; return `<div class="vnote" data-v="${n}" ${n === order[0] ? '' : 'hidden'}><b>${esc(v.name)}.</b> ${esc(v.tagline)}${h}<br><span>${esc(v.rationale)}</span><br><span><b>Free tier:</b> ${esc(v.free_tier_notes)}</span><br><span><b>After the game:</b> ${esc(v.graded_state_notes)}</span></div>`; }).join('');
let realshot = '';
try { const b = fs.readFileSync(__dirname + '/shots/real18.png').toString('base64'); realshot = `<div class="lab-top" style="margin-top:22px"><div class="eyebrow-lab">18 inside the real game page</div><div class="lab-note">The prod game page for Athletics at Rays (tonight) with variant 18 injected in place of the picks section: real header, real lines from 13 books, real public betting underneath. Rendered at the phone breakpoint.</div><img src="data:image/png;base64,${b}" alt="Variant 18 inside the real game page" style="width:min(500px,100%);height:auto;border:1px solid var(--border);border-radius:14px;margin-top:10px"></div>`; } catch (_) {}
/* REALSHOT */
const html = chrome.replace('/*VARIANT_CSS*/', css).replace('<!--PILLS-->', pills).replace('<!--SCREENS-->', screens).replace('<!--NOTES-->', notes + realshot);
fs.writeFileSync(outPath, html);
console.error('wrote', outPath, html.length, 'bytes');
