// src/tools_page.js — free betting calculators under /tools (SEO funnel).
// Server-rendered shells; every calculator runs entirely in the browser (no
// API calls, no cost). One data-driven template shared by all tools, same
// shell conventions as sport_page.js. House style: no em dashes, humble tone.

const { buildNav, esc } = require('./detail_page');

// ── Shared client-side odds math (inlined into every tool page) ───────────────
const CALC_JS = `
function amToProb(o){ o=parseFloat(o); if(!isFinite(o)||Math.abs(o)<100) return null; return o>0 ? 100/(o+100) : (-o)/((-o)+100); }
function amToDec(o){ o=parseFloat(o); if(!isFinite(o)||Math.abs(o)<100) return null; return o>0 ? 1+o/100 : 1+100/(-o); }
function decToAm(d){ if(!isFinite(d)||d<=1) return null; return d>=2 ? Math.round((d-1)*100) : Math.round(-100/(d-1)); }
function probToAm(p){ if(!isFinite(p)||p<=0||p>=1) return null; return p>=0.5 ? Math.round(-100*p/(1-p)) : Math.round(100*(1-p)/p); }
function fmtAm(o){ if(o==null) return '\\u2014'; return o>0 ? '+'+o : String(o); }
function fmtPct(p,d){ if(p==null) return '\\u2014'; return (100*p).toFixed(d==null?1:d)+'%'; }
function fmtUsd(v){ if(v==null||!isFinite(v)) return '\\u2014'; var s=v<0?'-':''; return s+'$'+Math.abs(v).toFixed(2); }
function num(id){ var v=parseFloat(document.getElementById(id).value); return isFinite(v)?v:null; }
`;

// ── Tool definitions ──────────────────────────────────────────────────────────
// Each tool: slug, name, short (index card copy), title/desc (SEO), inputs +
// results markup, calc JS (reads inputs, writes results), and explainer HTML.
const TOOLS = [
  {
    slug: 'no-vig',
    name: 'No-Vig Fair Odds Calculator',
    short: 'Strip the juice from any two-way line and see the fair price.',
    title: 'No-Vig Fair Odds Calculator (Free) | CappingAlpha',
    desc: 'Free no-vig calculator. Enter both sides of a betting line to remove the vig and see the fair odds and true implied probability.',
    inputs: `
      <label>Side A odds <input type="text" inputmode="text" autocomplete="off" id="nv-a" placeholder="-110" /></label>
      <label>Side B odds <input type="text" inputmode="text" autocomplete="off" id="nv-b" placeholder="-110" /></label>`,
    resultsIds: ['nv-out'],
    calc: `
function runCalc(){
  var a=num('nv-a'), b=num('nv-b');
  var pa=amToProb(a), pb=amToProb(b);
  var el=document.getElementById('nv-out');
  if(pa==null||pb==null){ el.innerHTML=''; return; }
  var total=pa+pb, hold=total-1;
  var fa=pa/total, fb=pb/total;
  el.innerHTML =
    row('Book implied probability', fmtPct(pa)+' / '+fmtPct(pb)) +
    row('Total market (with vig)', fmtPct(total)) +
    row('Book hold (vig)', fmtPct(hold,2)) +
    row('No-vig fair probability', fmtPct(fa)+' / '+fmtPct(fb)) +
    row('No-vig fair odds', fmtAm(probToAm(fa))+' / '+fmtAm(probToAm(fb)));
}`,
    explainer: `
      <p>Every posted line includes the book's margin (the vig). Two -110 sides imply 52.4% each, which adds to 104.8%. The extra 4.8% is what the book keeps over time.</p>
      <p>Removing the vig rescales both probabilities so they add to 100%. The result is the market's fair estimate of each side, which is a better baseline than the posted price when you want to judge whether a bet has value.</p>
      <p>Fair-price math like this is a standard part of how sharp bettors judge a line, and a good habit to build before any bet.</p>`,
  },
  {
    slug: 'ev',
    name: 'Expected Value (EV) Calculator',
    short: 'Check what a bet is worth given your odds and your win probability.',
    title: 'Betting EV Calculator: Expected Value of a Bet (Free) | CappingAlpha',
    desc: 'Free expected value calculator for sports betting. Enter your odds, stake, and win probability to see the EV of a bet in dollars and percent.',
    inputs: `
      <label>Your odds <input type="text" inputmode="text" autocomplete="off" id="ev-odds" placeholder="+120" /></label>
      <label>Win probability (%) <input type="number" id="ev-prob" placeholder="48" min="0" max="100" /></label>
      <label>Stake ($) <input type="number" id="ev-stake" placeholder="100" min="0" /></label>`,
    resultsIds: ['ev-out'],
    calc: `
function runCalc(){
  var o=num('ev-odds'), p=num('ev-prob'), s=num('ev-stake');
  var el=document.getElementById('ev-out');
  var d=amToDec(o);
  if(d==null||p==null||s==null||p<=0||p>=100||s<=0){ el.innerHTML=''; return; }
  p=p/100;
  var win=(d-1)*s, ev=p*win-(1-p)*s, evPct=ev/s;
  var be=1/d;
  el.innerHTML =
    row('Profit if it wins', fmtUsd(win)) +
    row('Expected value', fmtUsd(ev)) +
    row('EV as % of stake', fmtPct(evPct,2)) +
    row('Break-even win probability', fmtPct(be)) +
    row('Your edge vs break-even', fmtPct(p-be,2));
}`,
    explainer: `
      <p>Expected value is the long-run average of a bet: (win probability x profit) minus (loss probability x stake). Positive EV means the price is better than your estimate of the true chance; negative EV means the price is worse.</p>
      <p>The hard part is the win probability. A useful starting point is the no-vig fair probability from the market, then adjust from there if you think you know something the market does not.</p>`,
  },
  {
    slug: 'parlay',
    name: 'Parlay Calculator',
    short: 'Combine up to eight legs and see the true payout and implied odds.',
    title: 'Parlay Calculator: Payout and Odds for Multi-Leg Bets (Free) | CappingAlpha',
    desc: 'Free parlay calculator. Enter up to 8 American odds legs and a stake to see the combined odds, total payout, and implied probability of the parlay.',
    inputs: `
      <div id="pl-legs">
        <label>Leg 1 odds <input type="text" inputmode="text" autocomplete="off" class="pl-leg" placeholder="-110" /></label>
        <label>Leg 2 odds <input type="text" inputmode="text" autocomplete="off" class="pl-leg" placeholder="-110" /></label>
      </div>
      <button type="button" class="tool-add" id="pl-add">+ Add leg</button>
      <label>Stake ($) <input type="number" id="pl-stake" placeholder="10" min="0" /></label>`,
    resultsIds: ['pl-out'],
    calc: `
document.getElementById('pl-add').addEventListener('click', function(){
  var wrap=document.getElementById('pl-legs');
  var n=wrap.querySelectorAll('.pl-leg').length;
  if(n>=8) return;
  var lab=document.createElement('label');
  lab.innerHTML='Leg '+(n+1)+' odds <input type="text" inputmode="text" autocomplete="off" class="pl-leg" placeholder="-110" />';
  wrap.appendChild(lab);
  lab.querySelector('input').addEventListener('input', runCalc);
});
function runCalc(){
  var legs=[].slice.call(document.querySelectorAll('.pl-leg'))
    .map(function(i){ return amToDec(i.value); })
    .filter(function(d){ return d!=null; });
  var s=num('pl-stake');
  var el=document.getElementById('pl-out');
  if(legs.length<2){ el.innerHTML=''; return; }
  var dec=legs.reduce(function(a,b){ return a*b; },1);
  var html =
    row('Legs counted', String(legs.length)) +
    row('Combined decimal odds', dec.toFixed(3)) +
    row('Combined American odds', fmtAm(decToAm(dec))) +
    row('Implied probability', fmtPct(1/dec,2));
  if(s!=null&&s>0){
    html += row('Total payout', fmtUsd(s*dec)) + row('Profit', fmtUsd(s*(dec-1)));
  }
  el.innerHTML=html;
}`,
    explainer: `
      <p>A parlay multiplies the decimal odds of every leg. Each leg carries the book's vig, so the margin compounds: a two-leg parlay of standard -110 sides carries roughly double the hold of a single bet.</p>
      <p>That is why parlays pay less than their true odds more often than not. This calculator shows the implied probability of the combined ticket so you can see what the payout actually asks the legs to do.</p>`,
  },
  {
    slug: 'hold',
    name: 'Hold (Vig) Calculator',
    short: 'See how much margin the book has baked into a market.',
    title: 'Sportsbook Hold Calculator: Vig on Any Market (Free) | CappingAlpha',
    desc: 'Free hold calculator. Enter every side of a betting market (two-way or three-way) to see the sportsbook vig as a percentage.',
    inputs: `
      <label>Side A odds <input type="text" inputmode="text" autocomplete="off" id="hd-a" placeholder="-110" /></label>
      <label>Side B odds <input type="text" inputmode="text" autocomplete="off" id="hd-b" placeholder="-110" /></label>
      <label>Side C odds (3-way, optional) <input type="text" inputmode="text" autocomplete="off" id="hd-c" placeholder="" /></label>`,
    resultsIds: ['hd-out'],
    calc: `
function runCalc(){
  var pa=amToProb(num('hd-a')), pb=amToProb(num('hd-b')), pc=amToProb(num('hd-c'));
  var el=document.getElementById('hd-out');
  if(pa==null||pb==null){ el.innerHTML=''; return; }
  var total=pa+pb+(pc||0);
  var hold=total-1;
  el.innerHTML =
    row('Market total', fmtPct(total,2)) +
    row('Book hold (vig)', fmtPct(hold,2)) +
    row('Hold per side', fmtPct(hold/(pc!=null?3:2),2)) +
    row('What that means', hold<=0.045 ? 'Sharper than a standard -110/-110 market.' : hold<=0.06 ? 'Around standard for a US book.' : 'Wide. Worth shopping this line at another book.');
}`,
    explainer: `
      <p>Hold is the book's built-in margin: the sum of every side's implied probability minus 100%. A standard -110/-110 spread market holds about 4.5%. Three-way soccer markets often hold more.</p>
      <p>Lower hold means better prices for you. Comparing hold across books on the same game is one of the simplest ways to find the better place to bet.</p>`,
  },
  {
    slug: 'hedge',
    name: 'Hedge Calculator',
    short: 'Work out the hedge stake that locks in the same profit either way.',
    title: 'Hedge Bet Calculator: Lock In Profit (Free) | CappingAlpha',
    desc: 'Free hedge calculator. Enter your original bet and the current odds on the other side to see the hedge stake that equalizes profit on every outcome.',
    inputs: `
      <label>Original odds <input type="text" inputmode="text" autocomplete="off" id="hg-odds" placeholder="+300" /></label>
      <label>Original stake ($) <input type="number" id="hg-stake" placeholder="100" min="0" /></label>
      <label>Hedge odds (other side) <input type="text" inputmode="text" autocomplete="off" id="hg-hedge" placeholder="-150" /></label>`,
    resultsIds: ['hg-out'],
    calc: `
function runCalc(){
  var d1=amToDec(num('hg-odds')), s1=num('hg-stake'), d2=amToDec(num('hg-hedge'));
  var el=document.getElementById('hg-out');
  if(d1==null||d2==null||s1==null||s1<=0){ el.innerHTML=''; return; }
  var h=(d1*s1)/d2;                  // equalize total return on both outcomes
  var profit=d1*s1-s1-h;             // same on either result
  el.innerHTML =
    row('Hedge stake', fmtUsd(h)) +
    row('Guaranteed profit', fmtUsd(profit)) +
    row('Return if original wins', fmtUsd(d1*s1-s1-h)) +
    row('Return if hedge wins', fmtUsd(d2*h-h-s1)) +
    (profit<0 ? row('Note','A full hedge locks in a loss at these prices. A partial hedge or letting it ride may fit better.') : '');
}`,
    explainer: `
      <p>Hedging places a second bet on the opposite side so the combined position pays the same no matter what happens. The equal-profit stake is (original decimal odds x original stake) divided by the hedge decimal odds.</p>
      <p>A hedge gives up some expected value in exchange for certainty. Whether that trade is worth it depends on the prices and on how much variance you want to carry.</p>`,
  },
  {
    slug: 'kelly',
    name: 'Kelly Criterion Calculator',
    short: 'Size a bet from your edge and bankroll with the Kelly formula.',
    title: 'Kelly Criterion Calculator for Sports Betting (Free) | CappingAlpha',
    desc: 'Free Kelly criterion calculator. Enter your odds, win probability, and bankroll to see the full, half, and quarter Kelly stake for a bet.',
    inputs: `
      <label>Your odds <input type="text" inputmode="text" autocomplete="off" id="ky-odds" placeholder="+110" /></label>
      <label>Win probability (%) <input type="number" id="ky-prob" placeholder="50" min="0" max="100" /></label>
      <label>Bankroll ($) <input type="number" id="ky-bank" placeholder="1000" min="0" /></label>`,
    resultsIds: ['ky-out'],
    calc: `
function runCalc(){
  var d=amToDec(num('ky-odds')), p=num('ky-prob'), bank=num('ky-bank');
  var el=document.getElementById('ky-out');
  if(d==null||p==null||p<=0||p>=100){ el.innerHTML=''; return; }
  p=p/100;
  var b=d-1, q=1-p;
  var f=(b*p-q)/b;                   // full Kelly fraction
  var html = row('Full Kelly fraction', f>0 ? fmtPct(f,2) : '0% (no edge at this price)');
  if(f>0&&bank!=null&&bank>0){
    html += row('Full Kelly stake', fmtUsd(bank*f))
          + row('Half Kelly stake', fmtUsd(bank*f/2))
          + row('Quarter Kelly stake', fmtUsd(bank*f/4));
  }
  el.innerHTML=html;
}`,
    explainer: `
      <p>The Kelly criterion sizes a bet in proportion to your edge: fraction = (b x p - q) / b, where b is the decimal odds minus 1, p is your win probability, and q is 1 - p. No edge means no bet.</p>
      <p>Full Kelly assumes your probability estimate is exactly right, which it rarely is. Many bettors use half or quarter Kelly to cut the swings that come from overestimating an edge.</p>`,
  },
  {
    slug: 'rollover',
    name: 'Free Play and Rollover Calculator',
    short: 'See what a bonus or free play is really worth after the rollover.',
    title: 'Free Play and Bonus Rollover Calculator (Free) | CappingAlpha',
    desc: 'Free rollover calculator for sportsbook bonuses and free plays. Enter the bonus, rollover multiplier, and your average odds to see the real value of the offer.',
    inputs: `
      <label>Bonus / free play amount ($) <input type="number" id="ro-amt" placeholder="100" min="0" /></label>
      <label>Bonus type
        <select id="ro-type">
          <option value="freeplay">Free play (winnings only, stake not returned)</option>
          <option value="cash">Cash bonus (stake returned)</option>
        </select>
      </label>
      <label>Deposit ($, if the offer requires one) <input type="number" id="ro-dep" placeholder="100" min="0" /></label>
      <label>Rollover multiplier (x) <input type="number" id="ro-mult" placeholder="5" min="0" step="0.5" /></label>
      <label>Rollover applies to
        <select id="ro-base">
          <option value="both">Deposit + bonus</option>
          <option value="bonus">Bonus only</option>
        </select>
      </label>
      <label>Average odds you bet <input type="text" inputmode="text" autocomplete="off" id="ro-odds" placeholder="-110" /></label>`,
    resultsIds: ['ro-out'],
    calc: `
function runCalc(){
  var F=num('ro-amt'), D=num('ro-dep')||0, M=num('ro-mult'), A=num('ro-odds');
  if(A==null&&document.getElementById('ro-odds').value.trim()==='') A=-110;
  var type=document.getElementById('ro-type').value;
  var base=document.getElementById('ro-base').value;
  var el=document.getElementById('ro-out');
  var dec=amToDec(A), q=amToProb(A);
  if(F==null||F<=0||M==null||M<=0||dec==null){ el.innerHTML=''; return; }
  // Assume a standard-hold two-way market (about 4.76% overround, the -110/-110
  // shape) and no skill edge: fair win prob = implied prob / total overround.
  var p=q/1.0476;
  var edge=Math.max(0,1-p*dec);           // expected loss per $1 of cash handle
  var H=M*(base==='both' ? (D+F) : F);    // total handle the book requires
  var rows='';
  var value;
  if(type==='freeplay'){
    var fpEV=p*(dec-1)*F;                 // the free play bet itself, on average
    var cashHandle=Math.max(0,H-F);       // the free play usually counts toward rollover
    var cost=cashHandle*edge;
    value=fpEV-cost;
    rows = row('Required rollover handle', fmtUsd(H)) +
           row('Free play expected return', fmtUsd(fpEV)+' ('+fmtPct(fpEV/F,0)+' of face)') +
           row('Expected cost of clearing the rest', fmtUsd(cost)) +
           row('What the offer is really worth', fmtUsd(value)+' ('+fmtPct(value/F,0)+' of face)');
  } else {
    var cost2=H*edge;
    value=F-cost2;
    rows = row('Required rollover handle', fmtUsd(H)) +
           row('Bonus cash', fmtUsd(F)) +
           row('Expected cost of clearing', fmtUsd(cost2)) +
           row('What the offer is really worth', fmtUsd(value)+' ('+fmtPct(value/F,0)+' of face)');
  }
  rows += row('Read', value>0
    ? 'Still positive after the rollover, at these assumptions.'
    : 'The rollover likely costs more than the bonus is worth, at these assumptions.');
  el.innerHTML=rows;
}`,
    explainer: `
      <p>A free play pays winnings only, so it is worth less than cash before the rollover even starts. Bet at a standard -110 price it returns about 45% of face on average; underdog prices convert more of it because the winnings side is bigger.</p>
      <p>Rollover is the total amount you must wager before you can withdraw. Every dollar of that handle passes through the book's margin, and that cost comes straight out of the bonus. This calculator nets the two numbers so you can see what an offer is actually worth.</p>
      <p>It assumes a standard-hold market and no skill edge, so treat the result as a baseline. A 5x rollover on a small free play often survives the math; a 30x rollover on deposit plus bonus usually does not.</p>`,
  },
];

// ── Page CSS (shares game-detail.css variables; scoped to .tools-*) ───────────
const TOOLS_CSS = `
.tools-wrap { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
.tools-hero h1 { font-family: 'Source Sans Pro', system-ui, sans-serif; font-weight: 700; letter-spacing: -0.3px; font-size: 28px; margin: 8px 0 6px; }
.tools-tagline { color: var(--muted, #9aa4b2); margin: 0 0 20px; font-size: 15px; }
.tools-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
.tools-card { display: block; background: var(--card, #141a24); border: 1px solid var(--line, #232b38); border-radius: 12px; padding: 16px; text-decoration: none; color: inherit; transition: border-color .15s; }
.tools-card:hover { border-color: var(--gold, #d4af37); }
.tools-card h2 { font-size: 16px; margin: 0 0 6px; color: var(--gold, #d4af37); }
.tools-card p { font-size: 13px; margin: 0; color: var(--muted, #9aa4b2); line-height: 1.45; }
.tool-calc { background: var(--card, #141a24); border: 1px solid var(--line, #232b38); border-radius: 12px; padding: 18px; margin: 18px 0; }
.tool-calc label { display: block; font-size: 13px; color: var(--muted, #9aa4b2); margin: 10px 0 4px; }
/* 16px minimum: anything smaller makes iOS Safari zoom the page when the input
   takes focus, and the zoom sticks after (the "floating screen" bug). */
.tool-calc input, .tool-calc select { width: 100%; max-width: 260px; display: block; background: #0d1119; color: #e8edf4; border: 1px solid var(--line, #232b38); border-radius: 8px; padding: 9px 10px; font-size: 16px; }
.tool-calc input:focus, .tool-calc select:focus { outline: none; border-color: var(--gold, #d4af37); }
.tool-calc select { max-width: 340px; }
.tool-add { background: none; border: 1px dashed var(--line, #232b38); color: var(--muted, #9aa4b2); border-radius: 8px; padding: 6px 12px; margin-top: 10px; cursor: pointer; font-size: 13px; }
.tool-results { margin-top: 16px; }
.tool-row { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-top: 1px solid var(--line, #232b38); font-size: 14px; }
.tool-row .tr-label { color: var(--muted, #9aa4b2); }
.tool-row .tr-val { font-weight: 700; font-variant-numeric: tabular-nums; }
.tool-explainer { font-size: 14px; line-height: 1.6; color: #c6cdd8; }
.tool-explainer p { margin: 10px 0; }
.tools-more { margin-top: 28px; }
.tools-more h3 { font-size: 15px; margin-bottom: 10px; }
.tools-cta { margin-top: 30px; background: var(--card, #141a24); border: 1px solid var(--gold, #d4af37); border-radius: 12px; padding: 16px; font-size: 14px; }
.tools-cta a { color: var(--gold, #d4af37); font-weight: 700; }
`;

function pageShell({ title, desc, canonical, jsonLd, body, user }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${esc(title)}</title>
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <meta property="og:site_name" content="CappingAlpha" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:image" content="https://cappingalpha.com/ca-logo.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="https://cappingalpha.com/ca-logo.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Sans+Pro:wght@300;400;600;700;900&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
  <link rel="stylesheet" href="/game-detail.css?v=2" />
  <style>${TOOLS_CSS}</style>
  <script type="application/ld+json">${jsonLd}</script>
</head>
<body>

${buildNav(user)}

${body}

<footer style="max-width:900px;margin:56px auto 0;padding:18px 16px 0;border-top:1px solid #252c3b;color:#8892a4;font-size:12px;line-height:1.7;text-align:center;">
  <div>CappingAlpha is a sports information and data platform, not a sportsbook. All figures are for informational and entertainment purposes only. 18+ to use CappingAlpha. Gambling problem? Call 1-800-GAMBLER.</div>
  <div style="margin-top:6px;"><a href="/" style="color:#8892a4;">Home</a> · <a href="/faq" style="color:#8892a4;">FAQ</a> · <a href="/terms" style="color:#8892a4;">Terms</a> · <a href="/privacy" style="color:#8892a4;">Privacy</a> · <a href="/responsible-gambling" style="color:#8892a4;">Responsible Gambling</a></div>
</footer>

</body>
</html>`;
}

// ── Index page (/tools) ───────────────────────────────────────────────────────
function buildToolsIndexHtml(user) {
  const cards = TOOLS.map(t => `
    <a class="tools-card" href="/tools/${t.slug}">
      <h2>${esc(t.name)}</h2>
      <p>${esc(t.short)}</p>
    </a>`).join('');

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Free Betting Calculators',
    url: 'https://cappingalpha.com/tools',
    hasPart: TOOLS.map(t => ({
      '@type': 'WebApplication',
      name: t.name,
      url: `https://cappingalpha.com/tools/${t.slug}`,
      applicationCategory: 'UtilitiesApplication',
      operatingSystem: 'Web',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    })),
  });

  const body = `
<div class="tools-wrap">
  <header class="tools-hero">
    <h1>Free Betting Calculators</h1>
    <p class="tools-tagline">The math behind sharper betting: fair odds, expected value, parlays, hold, hedging, and bet sizing. All free, all in your browser.</p>
  </header>
  <div class="tools-grid">${cards}</div>
  <div class="tools-cta">
    Want the work done for you? <a href="/">CappingAlpha</a> runs every game, every day through our proprietary scoring engine and ranks today's picks on one board.
  </div>
</div>`;

  return pageShell({
    title: 'Free Betting Calculators: No-Vig, EV, Parlay, Hold, Hedge, Kelly | CappingAlpha',
    desc: 'Six free sports betting calculators: no-vig fair odds, expected value, parlay payout, sportsbook hold, hedge stakes, and Kelly criterion bet sizing.',
    canonical: 'https://cappingalpha.com/tools',
    jsonLd, body, user,
  });
}

// ── Individual tool pages (/tools/:slug) ──────────────────────────────────────
function buildToolPageHtml(slug, user) {
  const tool = TOOLS.find(t => t.slug === slug);
  if (!tool) return null;

  const others = TOOLS.filter(t => t.slug !== slug).map(t =>
    `<a class="tools-card" href="/tools/${t.slug}"><h2>${esc(t.name)}</h2><p>${esc(t.short)}</p></a>`).join('');

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name: tool.name,
        url: `https://cappingalpha.com/tools/${tool.slug}`,
        description: tool.desc,
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Web',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Tools', item: 'https://cappingalpha.com/tools' },
          { '@type': 'ListItem', position: 2, name: tool.name, item: `https://cappingalpha.com/tools/${tool.slug}` },
        ],
      },
    ],
  });

  const body = `
<div class="tools-wrap">
  <header class="tools-hero">
    <div><a href="/tools" style="color:var(--muted,#9aa4b2);font-size:13px;text-decoration:none;">&larr; All calculators</a></div>
    <h1>${esc(tool.name)}</h1>
    <p class="tools-tagline">${esc(tool.short)}</p>
  </header>

  <div class="tool-calc">
    ${tool.inputs}
    <div class="tool-results" id="${tool.resultsIds[0]}"></div>
  </div>

  <div class="tool-explainer">
    <h3>How it works</h3>
    ${tool.explainer}
  </div>

  <div class="tools-cta">
    Calculators show the math. The <a href="/">CappingAlpha</a> rankings do the rest: every game, every day, run through our proprietary scoring engine.
  </div>

  <div class="tools-more">
    <h3>More free calculators</h3>
    <div class="tools-grid">${others}</div>
  </div>
</div>

<script>
${CALC_JS}
function row(label, val){ return '<div class="tool-row"><span class="tr-label">'+label+'</span><span class="tr-val">'+val+'</span></div>'; }
${tool.calc}
document.querySelectorAll('.tool-calc input, .tool-calc select').forEach(function(i){
  i.addEventListener('input', runCalc);
  i.addEventListener('change', runCalc);
});
</script>`;

  return pageShell({
    title: tool.title,
    desc: tool.desc,
    canonical: `https://cappingalpha.com/tools/${tool.slug}`,
    jsonLd, body, user,
  });
}

module.exports = { buildToolsIndexHtml, buildToolPageHtml, TOOLS };
