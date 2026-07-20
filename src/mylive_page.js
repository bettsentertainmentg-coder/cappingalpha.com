// src/mylive_page.js — "My action, live": a second-screen dashboard of every
// game the user has action on (votes, pending tracked bets, parlay legs), fed
// by GET /api/my/live and polled client-side (~20s, visibility-gated). Built to
// stay open on a phone next to the TV. Server renders the shell only; all data
// arrives via the API so the page is cheap and session-aware.

const { buildNav, esc } = require('./detail_page');

const CSS = `
.ml-wrap { max-width: 980px; margin: 0 auto; padding: 24px 14px 64px; }
.ml-hero h1 { font-family: 'Space Grotesk', sans-serif; font-size: 26px; margin: 8px 0 4px; }
.ml-sub { color: var(--muted, #9aa4b2); font-size: 14px; margin: 0 0 18px; }
.ml-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.ml-card { display: block; background: var(--card, #141a24); border: 1px solid var(--line, #232b38); border-radius: 12px; padding: 14px 16px; text-decoration: none; color: inherit; transition: border-color .15s; }
.ml-card:hover { border-color: var(--gold, #d4af37); }
.ml-card.live { border-color: #2f7d4f; }
.ml-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.ml-sport { font-size: 11px; font-weight: 700; letter-spacing: .06em; color: var(--muted, #9aa4b2); background: #1a2230; border-radius: 5px; padding: 2px 7px; }
.ml-state { font-size: 12px; font-weight: 700; }
.ml-state.live { color: #4ade80; }
.ml-state.pre  { color: var(--muted, #9aa4b2); }
.ml-state.post { color: var(--muted, #9aa4b2); }
.ml-team { display: flex; justify-content: space-between; font-size: 15px; padding: 3px 0; }
.ml-team .nm { font-weight: 600; }
.ml-team .sc { font-weight: 800; font-variant-numeric: tabular-nums; }
.ml-team.ahead .sc { color: #4ade80; }
.ml-detail { font-size: 12px; color: var(--muted, #9aa4b2); margin-top: 6px; min-height: 15px; }
.ml-slots { border-top: 1px solid var(--line, #232b38); margin-top: 10px; padding-top: 8px; }
.ml-slot { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; padding: 3px 0; }
.ml-slot .lbl { color: #c6cdd8; }
.ml-slot .kind { color: var(--muted, #9aa4b2); font-size: 11px; }
.ml-empty { background: var(--card, #141a24); border: 1px solid var(--line, #232b38); border-radius: 12px; padding: 26px 20px; text-align: center; color: var(--muted, #9aa4b2); font-size: 14px; }
.ml-empty a { color: var(--gold, #d4af37); }
.ml-updated { font-size: 11px; color: var(--muted, #9aa4b2); margin-top: 16px; text-align: center; }
`;

const SCRIPT = `
const SLOT_LABEL = {
  home_ml: 'ML', away_ml: 'ML', home_spread: 'Spread', away_spread: 'Spread',
  over: 'Over', under: 'Under',
};
function slotText(g, s) {
  if (s.kind === 'vote') {
    const home = s.slot === 'home_ml' || s.slot === 'home_spread';
    const team = s.slot === 'over' || s.slot === 'under'
      ? s.slot.charAt(0).toUpperCase() + s.slot.slice(1)
      : (home ? (g.home_short || g.home_team) : (g.away_short || g.away_team));
    return team + ' ' + (SLOT_LABEL[s.slot] || s.slot);
  }
  const bits = [s.selection || '', (s.bet_type || '').toUpperCase()];
  if (s.line != null) bits.push(s.line > 0 ? '+' + s.line : String(s.line));
  return bits.filter(Boolean).join(' ');
}
function kindText(s) {
  if (s.kind === 'vote') return 'vote';
  if (s.kind === 'parlay_leg') return 'parlay leg';
  return s.stake ? '$' + s.stake + ' bet' : 'bet';
}
function stateText(g) {
  if (g.status === 'in') {
    const bits = [g.period ? String(g.period) : '', g.clock || '', g.live_detail || ''].filter(Boolean);
    return bits.join(' \\u00b7 ') || 'Live';
  }
  if (g.status === 'post') return 'Final';
  try {
    return new Date(g.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
  } catch (_) { return 'Scheduled'; }
}
function card(g) {
  const live = g.status === 'in';
  const homeAhead = (g.home_score ?? 0) > (g.away_score ?? 0);
  const awayAhead = (g.away_score ?? 0) > (g.home_score ?? 0);
  const showScore = g.status !== 'pre';
  const slots = (g.my_slots || []).map(s =>
    '<div class="ml-slot"><span class="lbl">' + slotText(g, s) + '</span><span class="kind">' + kindText(s) + '</span></div>'
  ).join('');
  return '<a class="ml-card' + (live ? ' live' : '') + '" href="/game/' + encodeURIComponent(g.espn_game_id) + '">' +
    '<div class="ml-top"><span class="ml-sport">' + (g.sport || '') + '</span>' +
    '<span class="ml-state ' + (live ? 'live' : g.status) + '">' + stateText(g) + '</span></div>' +
    '<div class="ml-team' + (awayAhead ? ' ahead' : '') + '"><span class="nm">' + (g.away_team || '') + '</span><span class="sc">' + (showScore ? (g.away_score ?? 0) : '') + '</span></div>' +
    '<div class="ml-team' + (homeAhead ? ' ahead' : '') + '"><span class="nm">' + (g.home_team || '') + '</span><span class="sc">' + (showScore ? (g.home_score ?? 0) : '') + '</span></div>' +
    '<div class="ml-detail">' + (g.tennis_score_detail || '') + '</div>' +
    (slots ? '<div class="ml-slots">' + slots + '</div>' : '') +
    '</a>';
}
async function refresh() {
  const grid = document.getElementById('ml-grid');
  try {
    const res = await fetch('/api/my/live');
    if (res.status === 401) {
      grid.innerHTML = '<div class="ml-empty">Log in on the <a href="/">main site</a> first, then come back here.</div>';
      return;
    }
    const data = await res.json();
    const games = data.games || [];
    if (!games.length) {
      grid.innerHTML = '<div class="ml-empty">No action on today\\u2019s board yet. Vote a pick or <a href="/">track a bet</a> and it shows up here live.</div>';
    } else {
      grid.innerHTML = games.map(card).join('');
    }
    const upd = document.getElementById('ml-updated');
    upd.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  } catch (_) { /* keep the last render on a blip */ }
}
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
`;

function buildMyLivePageHtml(user) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>My Action, Live | CappingAlpha</title>
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta name="description" content="Every game you have action on, live on one screen." />
  <meta name="robots" content="noindex" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Sans+Pro:wght@300;400;600;700;900&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
  <link rel="stylesheet" href="/game-detail.css?v=2" />
  <style>${CSS}</style>
</head>
<body>

${buildNav(user)}

<div class="ml-wrap">
  <header class="ml-hero">
    <h1>My Action, Live</h1>
    <p class="ml-sub">Every game you voted or tracked a bet on, one screen, updating live. Keep it open next to the game.</p>
  </header>
  <div class="ml-grid" id="ml-grid">
    <div class="ml-empty">Loading your games...</div>
  </div>
  <div class="ml-updated" id="ml-updated"></div>
</div>

<footer style="max-width:900px;margin:48px auto 0;padding:16px;border-top:1px solid #252c3b;color:#8892a4;font-size:12px;line-height:1.7;text-align:center;">
  <div>CappingAlpha is a sports information and data platform, not a sportsbook. All figures are hypothetical and for informational and entertainment purposes only. 18+ to use CappingAlpha. Gambling problem? Call 1-800-GAMBLER.</div>
  <div style="margin-top:6px;"><a href="/" style="color:#8892a4;">Home</a> · <a href="/terms" style="color:#8892a4;">Terms</a> · <a href="/privacy" style="color:#8892a4;">Privacy</a> · <a href="/responsible-gambling" style="color:#8892a4;">Responsible Gambling</a></div>
</footer>

<script>${SCRIPT}</script>

</body>
</html>`;
}

module.exports = { buildMyLivePageHtml };
