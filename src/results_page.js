// src/results_page.js — server-rendered, crawlable track-record page (/results).
//
// This is the site's strongest organic-SEO surface: real, fresh, keyword-rich
// content (team names, sports, dates, outcomes) at a stable URL, rendered in
// plain HTML so search engines and AI answer engines can read it without
// executing any JavaScript. The live app behind the paywall is mostly invisible
// to crawlers; this page is not.

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SPORT_LABEL = {
  MLB: 'MLB', NBA: 'NBA', WNBA: 'WNBA', NHL: 'NHL', NFL: 'NFL',
  ATP: 'Tennis', WTA: 'Tennis', GOLF: 'Golf',
};

function sportLabel(s) {
  return SPORT_LABEL[(s || '').toUpperCase()] || s || '';
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  } catch (_) { return String(d).slice(0, 10); }
}

// Server-side selection label. Uses full team names (better for search than
// nicknames). Mirrors the conventions in public/modules/utils.js pickLabel.
function pickStr(p) {
  const type = (p.pick_type || '').toLowerCase();
  const team = p.team || '';
  const spread = p.spread != null ? p.spread : null;
  const spreadFmt = spread != null ? (spread > 0 ? `+${spread}` : `${spread}`) : null;
  if (type === 'over' || type === 'under') {
    const total = spread != null ? Math.abs(parseFloat(spread)) : null;
    const lbl = type === 'over' ? 'Over' : 'Under';
    return total != null ? `${lbl} ${total}` : lbl;
  }
  if (type === 'nrfi') return team ? `${team} NRFI` : 'NRFI';
  if (type === 'ml') return team ? `${team} ML` : 'Moneyline';
  if (type === 'spread' || type === 'set_spread') {
    return team ? `${team} ${spreadFmt || ''}`.trim() : (spreadFmt || 'Spread');
  }
  if (team) return spreadFmt ? `${team} ${spreadFmt}` : team;
  return p.pick_type || '—';
}

function matchup(p) {
  if (p.away_team && p.home_team) return `${p.away_team} @ ${p.home_team}`;
  return p.team || '';
}

function finalScore(p) {
  if (p.away_score == null || p.home_score == null) return '';
  return `${p.away_score}-${p.home_score}`;
}

function buildResultsPageHtml({ picks = [], record = {} }) {
  const wins   = record.wins || 0;
  const losses = record.losses || 0;
  const pushes = record.pushes || 0;
  const winRate = record.win_rate || '0%';
  const total = wins + losses + pushes;

  // Cap the rendered table for page weight; note it if we trim.
  const MAX_ROWS = 200;
  const shown = picks.slice(0, MAX_ROWS);

  const rows = shown.map((p) => {
    const r = (p.result || '').toLowerCase();
    const rClass = r === 'win' ? 'res-win' : r === 'loss' ? 'res-loss' : 'res-push';
    const rText = r === 'win' ? 'WIN' : r === 'loss' ? 'LOSS' : r === 'push' ? 'PUSH' : '';
    return `<tr class="${rClass}">
      <td class="num">${esc(fmtDate(p.game_date || p.saved_at))}</td>
      <td>${esc(sportLabel(p.sport))}</td>
      <td>${esc(matchup(p))}</td>
      <td class="pick">${esc(pickStr(p))}</td>
      <td class="num">${esc(finalScore(p))}</td>
      <td class="num">${p.score != null ? esc(p.score) : ''}</td>
      <td class="res ${rClass}">${rText}</td>
    </tr>`;
  }).join('\n');

  const title = 'Track Record | CappingAlpha MVP Picks Results';
  const desc = `CappingAlpha's tracked MVP picks: ${wins} wins, ${losses} losses, ${pushes} pushes (${winRate} win rate on decided picks). Every top-rated play, scored and recorded for transparency across MLB, NBA, WNBA, NHL, Tennis, and Golf.`;
  const canonical = 'https://cappingalpha.com/results';

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: title,
    description: desc,
    url: canonical,
    isPartOf: { '@type': 'WebSite', name: 'CappingAlpha', url: 'https://cappingalpha.com/' },
    publisher: { '@type': 'Organization', name: 'CappingAlpha', url: 'https://cappingalpha.com/' },
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${canonical}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <meta name="theme-color" content="#0f1117" />
  <meta property="og:site_name" content="CappingAlpha" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:image" content="https://cappingalpha.com/ca-logo.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="https://cappingalpha.com/ca-logo.png" />
  <script type="application/ld+json">${jsonLd}</script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
    html, body { max-width: 100%; overflow-x: hidden; overflow-x: clip; }
    a { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f1117; color: #e2e8f0; font-size: 15px; line-height: 1.6; padding: 0 0 96px; }
    .site-header { border-bottom: 1px solid #1e2535; padding: 14px 16px; display: flex; align-items: center; gap: 16px; }
    .site-header-logo { font-size: 15px; font-weight: 700; color: #e2e8f0; letter-spacing: 0.02em; }
    .site-header-logo span { color: #3b82f6; }
    .site-header-back { margin-left: auto; font-size: 13px; color: #8892a4; text-decoration: none; }
    .site-header-back:hover { color: #3b82f6; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 40px 16px 0; }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    .slogan { color: #3b82f6; font-size: 14px; font-weight: 600; margin-bottom: 18px; }
    .lede { color: #c8d3e0; max-width: 680px; margin-bottom: 28px; }
    .record-strip { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 32px; }
    .stat { background: #171b24; border: 1px solid #252c3b; border-radius: 10px; padding: 14px 20px; min-width: 110px; }
    .stat .v { font-size: 24px; font-weight: 700; }
    .stat .l { font-size: 12px; color: #8892a4; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; }
    .stat .v.win { color: #4ade80; } .stat .v.loss { color: #f87171; } .stat .v.rate { color: #FFD700; }
    /* The 7-column table scrolls inside its own container on phones — the page
       itself never scrolls sideways. */
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    thead th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #8892a4; padding: 10px 10px; border-bottom: 1px solid #252c3b; }
    tbody td { padding: 10px 10px; border-bottom: 1px solid #1a2130; color: #c8d3e0; }
    tbody td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.pick { font-weight: 600; color: #e2e8f0; }
    td.res { font-weight: 700; font-size: 12px; }
    .res-win td.res { color: #4ade80; } .res-loss td.res { color: #f87171; } .res-push td.res { color: #8892a4; }
    .disclaimer { color: #6b7689; font-size: 12px; line-height: 1.7; margin-top: 32px; max-width: 720px; }
    .cta { display: inline-block; margin: 24px 0 8px; background: #3b82f6; color: #fff; padding: 11px 22px; border-radius: 8px; font-weight: 600; text-decoration: none; }
    .footer-links { margin-top: 40px; font-size: 13px; color: #8892a4; }
    .footer-links a { color: #8892a4; text-decoration: none; } .footer-links a:hover { color: #3b82f6; }
    .empty { color: #8892a4; padding: 40px 0; }
    @media (max-width: 560px) {
      .wrap { padding-top: 26px; }
      h1 { font-size: 23px; }
      .stat { min-width: 88px; padding: 11px 14px; flex: 1 1 88px; }
      .stat .v { font-size: 20px; }
      thead th, tbody td { padding: 9px 8px; }
      table { font-size: 12.5px; }
    }
  </style>
</head>
<body>
  <div class="site-header">
    <a href="/" class="site-header-logo">Capping<span>Alpha</span></a>
    <a href="/" class="site-header-back">← Back to app</a>
  </div>
  <div class="wrap">
    <div class="slogan">The receipts.</div>
    <h1>CappingAlpha Track Record</h1>
    <p class="lede">Every MVP pick we surface gets recorded and graded once the game finishes. Win or lose, it stays on the board. We do not condone gambling, but if you are betting anyway, there is no reason to do it without checking CappingAlpha first.</p>

    <div class="record-strip">
      <div class="stat"><div class="v win">${wins}</div><div class="l">Wins</div></div>
      <div class="stat"><div class="v loss">${losses}</div><div class="l">Losses</div></div>
      <div class="stat"><div class="v">${pushes}</div><div class="l">Pushes</div></div>
      <div class="stat"><div class="v rate">${esc(winRate)}</div><div class="l">Win rate</div></div>
      <div class="stat"><div class="v">${total}</div><div class="l">Total graded</div></div>
    </div>

    ${shown.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Sport</th><th>Matchup</th><th>Pick</th><th>Final</th><th>Score</th><th>Result</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table></div>${picks.length > MAX_ROWS ? `<p class="disclaimer">Showing the most recent ${MAX_ROWS} of ${picks.length} graded MVP picks.</p>` : ''}`
      : `<p class="empty">No graded MVP picks yet. Check back after today's slate finishes.</p>`}

    <a class="cta" href="/">See today's board</a>

    <p class="disclaimer">CappingAlpha never wagers on any game. All performance data shown is for informational and entertainment purposes only and reflects the picks our proprietary scoring engine rated in its highest-conviction tier. Past results are not indicative of future outcomes. Anything can happen in a sporting event. Must be 18 or older. If gambling stops being fun, call 1-800-GAMBLER.</p>

    <div class="footer-links">
      <a href="/">Home</a> &nbsp;·&nbsp; <a href="/faq">FAQ</a> &nbsp;·&nbsp; <a href="/terms">Terms</a> &nbsp;·&nbsp; <a href="/privacy">Privacy</a> &nbsp;·&nbsp; <a href="/responsible-gambling">Responsible Gambling</a>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { buildResultsPageHtml };
