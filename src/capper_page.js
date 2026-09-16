// src/capper_page.js — GET /capper/:slug, the capper profile (V2).
//
// A SHELL until the profile lab settles the real page (docs/prompts/
// V2_CAPPER_PROFILE_MOCK.md): the header (initials disc, public name, source
// badge), the big record with money and ROI, sport chips, the sport panel
// (record, money, ROI, picks, priced share, by bet type) and the recent graded
// picks. Every number comes from capper_ratings_v2 + capper_history through
// the same public naming as the game section. Nothing here names scores,
// bands, or the pipeline. Only live (qualified, not hidden) cappers render.

const db = require('./db');
const { buildNav, esc } = require('./detail_page');
const { buildResolver } = require('./capper_ratings');
const v2 = require('./capper_v2');
const pub = require('./capper_public');

function moneyStr(u) { const v = Math.round(Number(u) || 0); return (v >= 0 ? '+$' : '-$') + Math.abs(v); }
function pct(r) { return r == null ? '' : `${r >= 0 ? '+' : ''}${(Number(r) * 100).toFixed(1)}%`; }
function fmtOdds(o) { if (o == null) return ''; const v = Math.round(Number(o)); return v > 0 ? `+${v}` : `${v}`; }

function buildCapperPageHtml(req, slug, sportWanted) {
  const reg = db.prepare(`SELECT * FROM capper_registry WHERE slug = ? AND hidden = 0 AND live_at IS NOT NULL`).get(slug);
  if (!reg) return null;
  const canonical = reg.canonical_name;
  const srcCounts = {};
  for (const s of db.prepare(`SELECT source, COUNT(*) n FROM capper_history WHERE capper_name = ? AND result IN ('win','loss','push') GROUP BY source`).all(canonical)) srcCounts[s.source || 'discord'] = s.n;
  const p = pub.publicCapper(reg, srcCounts);
  const overall = v2.getRating(canonical, 'overall', 'all') || { graded: 0, wins: 0, losses: 0, pushes: 0, units: 0, roi: null };
  const sports = db.prepare(`
    SELECT substr(scope, 7) AS sport, graded, wins, losses, pushes, units, roi, priced, streak_len, streak_kind
    FROM capper_ratings_v2 WHERE canonical_name = ? AND scope LIKE 'sport:%' AND window = 'all' ORDER BY graded DESC
  `).all(canonical);
  const sport = sports.find((s) => s.sport === sportWanted) ? sportWanted : (sports[0] ? sports[0].sport : null);
  const panel = sport ? sports.find((s) => s.sport === sport) : null;
  const types = sport ? db.prepare(`
    SELECT substr(scope, ${('type:' + sport + '/').length + 1}) AS t, graded, wins, losses, pushes, units, roi
    FROM capper_ratings_v2 WHERE canonical_name = ? AND scope LIKE ? AND window = 'all' ORDER BY graded DESC
  `).all(canonical, `type:${sport}/%`) : [];

  // Recent graded picks: the capper's own rows plus alias spellings, newest first.
  const resolve = buildResolver();
  const names = new Set([canonical]);
  for (const a of db.prepare(`SELECT alias FROM capper_aliases WHERE canonical_name = ?`).all(canonical)) names.add(a.alias);
  for (const h of db.prepare(`SELECT handle FROM capper_source_handles WHERE canonical_name = ?`).all(canonical)) names.add(h.handle);
  const marks = [...names].map(() => '?').join(',');
  const recent = db.prepare(`
    SELECT ch.capper_name, ch.sport, ch.pick_type, ch.team, ch.spread, ch.game_date, ch.result, ch.odds, ch.espn_game_id, ch.saved_at, ch.source, ch.sources_json,
           ph.home_team, ph.away_team, ph.home_abbr, ph.away_abbr
    FROM capper_history ch LEFT JOIN pick_history ph ON ph.espn_game_id = ch.espn_game_id
    WHERE ch.capper_name IN (${marks}) AND ch.result IN ('win','loss','push') AND ch.espn_game_id IS NOT NULL
    GROUP BY ch.id ORDER BY ch.game_date DESC, ch.saved_at DESC LIMIT 25
  `).all(...names).filter((r) => resolve(r.capper_name || canonical, r.source) === canonical);

  const streak = panel && panel.streak_len >= v2.barSettings().streakMin
    ? `<span class="cp-chip">${esc(sport)} ${panel.streak_kind}${panel.streak_len} ${panel.streak_kind === 'W' ? '🔥' : '❄️'}</span>` : '';
  const pickLabel = (r) => {
    const pt = String(r.pick_type || '').toLowerCase();
    if (pt === 'over' || pt === 'under') return `${pt === 'over' ? 'Over' : 'Under'} ${r.spread != null ? r.spread : ''}`.trim();
    const team = r.team || '';
    if (pt === 'spread') return `${team} ${r.spread > 0 ? '+' : ''}${r.spread}`;
    return `${team} ML`;
  };
  const stake = v2.STAKE;
  const unitsOf = (r) => v2.unitReturn(r);

  return `<!DOCTYPE html>
<html lang="en" class="ca-v2 cm-tint bm-ink w-bleed">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${esc(p.name)} on CappingAlpha</title>
  <meta name="robots" content="noindex" />
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
  <link rel="stylesheet" href="/game-detail.css?v=10" />
  <style>
    .cp-page { max-width: 720px; margin: 0 auto; padding: 14px 0 40px; color: var(--text); font-variant-numeric: tabular-nums; }
    .cp-head { display: flex; align-items: center; gap: 12px; padding: 6px 14px 12px; }
    .cp-disc { width: 44px; height: 44px; border-radius: 50%; background: var(--surface2); box-shadow: 0 0 0 1px var(--border); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; }
    .cp-name { font-size: 20px; font-weight: 700; line-height: 1.2; }
    .cp-src { margin-top: 3px; }
    .cp-big { display: flex; align-items: baseline; gap: 14px; padding: 4px 14px 14px; }
    .cp-big .rec { font-size: 30px; font-weight: 800; letter-spacing: -0.01em; }
    .cp-big .money { font-size: 18px; font-weight: 700; }
    .cp-big .roi { font-size: 13px; color: var(--muted); }
    .cp-pos { color: var(--green); } .cp-neg { color: var(--red); }
    .cp-chips { display: flex; gap: 6px; overflow-x: auto; padding: 0 14px 12px; scrollbar-width: none; }
    .cp-chips::-webkit-scrollbar { display: none; }
    .cp-chips a { flex: 0 0 auto; padding: 6px 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); font-size: 12px; font-weight: 700; text-decoration: none; white-space: nowrap; }
    .cp-chips a.on { background: var(--surface2); color: var(--text); box-shadow: inset 0 0 0 1px var(--border), 0 1px 0 rgba(59,130,246,.55); }
    .cp-card { background: var(--surface); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); padding: 12px 14px; margin-bottom: 12px; }
    .cp-card h3 { margin: 0 0 8px; font-size: 13px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
    .cp-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .cp-grid div { font-size: 12px; color: var(--muted); }
    .cp-grid b { display: block; font-size: 15px; color: var(--text); }
    table.cp-t { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    table.cp-t th { text-align: left; color: var(--muted); font-weight: 600; padding: 4px 0; border-bottom: 1px solid var(--border); }
    table.cp-t td { padding: 6px 0; border-bottom: 1px solid var(--border); }
    table.cp-t td:not(:first-child), table.cp-t th:not(:first-child) { text-align: right; }
    .cp-chip { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; font-weight: 600; padding: 3px 6px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface2); color: var(--muted); }
    .cp-res { font-weight: 700; } .cp-res-win { color: var(--green); } .cp-res-loss { color: var(--red); } .cp-res-push { color: var(--gold); }
    .cp-note { padding: 8px 14px; font-size: 11.5px; line-height: 1.45; color: var(--muted); }
    .cp-note a { color: var(--accent); }
    @media (max-width: 768px) { body { padding-bottom: calc(58px + env(safe-area-inset-bottom)); } }
  </style>
</head>
<body>
${buildNav(req.session && req.session.user, 'v2')}
<div class="cp-page">
  <div class="cp-head">
    <span class="cp-disc">${esc(p.initials)}</span>
    <div>
      <div class="cp-name">${esc(p.name)}</div>
      <div class="cp-src"><span class="src src-${esc(p.source_cls)}">${esc(p.source)}</span>${p.aliased ? ' <span class="cp-chip">Shown under a pseudonym</span>' : ''}</div>
    </div>
  </div>
  <div class="cp-big">
    <span class="rec">${overall.wins}-${overall.losses}${overall.pushes ? '-' + overall.pushes : ''}</span>
    <span class="money ${overall.units >= 0 ? 'cp-pos' : 'cp-neg'}">${moneyStr(overall.units)}</span>
    <span class="roi">${esc(pct(overall.roi))} ROI · ${overall.graded} picks</span>
  </div>
  <div class="cp-chips">
    ${sports.map((s) => `<a href="/capper/${encodeURIComponent(slug)}?sport=${encodeURIComponent(s.sport)}" class="${s.sport === sport ? 'on' : ''}">${esc(s.sport)} <span style="opacity:.7">${s.graded}</span></a>`).join('')}
  </div>
  ${panel ? `<div class="cp-card">
    <h3>${esc(sport)} ${streak}</h3>
    <div class="cp-grid">
      <div>Record<b>${panel.wins}-${panel.losses}${panel.pushes ? '-' + panel.pushes : ''}</b></div>
      <div>Money<b class="${panel.units >= 0 ? 'cp-pos' : 'cp-neg'}">${moneyStr(panel.units)}</b></div>
      <div>ROI<b>${esc(pct(panel.roi))}</b></div>
      <div>Priced<b>${panel.graded ? Math.round(100 * panel.priced / panel.graded) : 0}%</b></div>
    </div>
    ${types.length ? `<table class="cp-t" style="margin-top:10px"><tr><th>Bet type</th><th>Record</th><th>Money</th><th>ROI</th></tr>
      ${types.map((t) => `<tr><td>${esc(t.t === 'ml' ? 'Moneyline' : t.t === 'spread' ? 'Spread' : t.t === 'total' ? 'Total' : t.t)}</td><td>${t.wins}-${t.losses}${t.pushes ? '-' + t.pushes : ''}</td><td class="${t.units >= 0 ? 'cp-pos' : 'cp-neg'}">${moneyStr(t.units)}</td><td>${esc(pct(t.roi))}</td></tr>`).join('')}
    </table>` : ''}
  </div>` : ''}
  <div class="cp-card">
    <h3>Recent picks</h3>
    ${recent.length ? `<table class="cp-t"><tr><th>Date</th><th>Pick</th><th>Price</th><th>Result</th><th>$</th></tr>
      ${recent.map((r) => { const u = unitsOf(r); return `<tr><td>${esc(r.game_date)} <span style="color:var(--muted)">${esc(r.sport)}</span></td><td style="text-align:left">${esc(pickLabel(r))}${r.away_abbr && r.home_abbr ? ` <span style="color:var(--muted)">${esc(r.away_abbr)} @ ${esc(r.home_abbr)}</span>` : ''}</td><td>${r.odds != null ? esc(fmtOdds(r.odds)) : `<span style="color:var(--muted)">graded at ${String(r.pick_type).toLowerCase() === 'over' || String(r.pick_type).toLowerCase() === 'under' ? '-115' : '-110'}</span>`}</td><td class="cp-res cp-res-${esc(r.result)}">${esc(String(r.result).toUpperCase())}</td><td class="${u >= 0 ? 'cp-pos' : 'cp-neg'}">${moneyStr(u)}</td></tr>`; }).join('')}
    </table>` : '<div style="color:var(--muted);font-size:12.5px">No graded picks recorded yet.</div>'}
  </div>
  <div class="cp-note">Their record as we recorded it since July 2026, graded by us at the line and price we saw. It can differ from records they publish. $${stake} a pick. <a href="/faq">How we grade</a> · <a href="/#about">Is this you? Claim, correct or remove</a></div>
</div>
</body>
</html>`;
}

module.exports = { buildCapperPageHtml };
