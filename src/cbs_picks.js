// src/cbs_picks.js
// CBS Sports expert-picks grid (structured HTML, no AI). Their NFL and college
// football pages publish a weekly grid where every cell is a bet button whose
// data-config carries the writer's name AND the pick, so nothing has to be
// inferred from column position:
//   <button data-config='{... "meta":{"bets":[{"expertLabel":"Tom Fornelli",...}]},
//                         "line":"-38.5","marketName":"Spread"}'>
//     <div class="BetButton-text"> USC -38.5 </div>
// Only NFL and CFB carry free named picks; the other CBS sports are SportsLine
// (paid) and are deliberately not touched.
//
// The grid is published ahead of the slate and buttons flip to WIN/LOSS text
// once a game finishes, so a button that still renders is a pregame pick. There
// is no per-pick timestamp, so arrival time is stamped at poll time — the same
// convention the Action Network ingest uses.

const https = require('https');
const db = require('./db');
const { recordSourcePick, findGameByTeams, sideOf } = require('./source_ingest');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'text/html,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function get(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: HEADERS, timeout: 20000 }, (res) => {
      let b = '';
      const end = () => finish({ status: res.statusCode, body: b });
      res.on('data', (c) => { b += c; if (b.length > 8_000_000) res.destroy(); });
      res.on('end', end);
      res.on('close', end);
    });
    req.on('error', () => finish({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); finish({ status: 0, body: '' }); });
  });
}

const PAGES = [
  { url: 'https://www.cbssports.com/nfl/picks/experts/', sport: 'NFL' },
  { url: 'https://www.cbssports.com/college-football/picks/experts/', sport: 'NCAAF' },
];

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

// A grid row is one game: two GameMatchup-teamAbbr cells then one bet button
// per expert. Rows are split on the matchup cell so buttons can never be
// attributed to the wrong game.
function parseRows(html) {
  const out = [];
  const chunks = String(html || '').split('GameMatchup-teamAbbr');
  // chunks[0] is pre-table; each subsequent pair of abbrs opens a row.
  for (let i = 1; i < chunks.length; i += 2) {
    const a = (chunks[i].match(/^">?\s*([A-Z0-9&.-]{2,8})\s*</) || [])[1];
    const b = chunks[i + 1] ? (chunks[i + 1].match(/^">?\s*([A-Z0-9&.-]{2,8})\s*</) || [])[1] : null;
    if (!a || !b) continue;
    // The row's buttons live between this matchup and the next one.
    const rowHtml = (chunks[i + 1] || '').split('GameMatchup-teamAbbr')[0];
    const picks = [];
    for (const m of rowHtml.matchAll(/data-config='([^']+)'[\s\S]{0,400}?BetButton-text">\s*([^<]+?)\s*<\/div>/g)) {
      let cfg = null;
      try { cfg = JSON.parse(decode(m[1])); } catch (_) { continue; }
      const expert = (((cfg.meta || {}).bets || [])[0] || {}).expertLabel;
      if (!expert) continue;
      picks.push({
        expert: decode(expert).trim(),
        text: decode(m[2]).replace(/\s+/g, ' ').trim(),
        line: cfg.line != null ? String(cfg.line) : null,
        market: String(cfg.marketName || '').toLowerCase(),
      });
    }
    if (picks.length) out.push({ teamA: a, teamB: b, picks });
  }
  return out;
}

// "USC -38.5" / "SEA -4.5" / "Chiefs" (straight-up tab, no number).
function parsePickText(text, market, cfgLine) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || /^(win|loss|push|pending|--)$/i.test(t)) return null;
  const m = t.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)$/);
  if (m) return { picked: m[1].trim(), pickType: 'spread', line: parseFloat(m[2]) };
  // No number on the cell: a straight-up (moneyline) pick.
  if (market.includes('spread') && cfgLine != null) {
    const n = parseFloat(cfgLine);
    if (Number.isFinite(n)) return { picked: t, pickType: 'spread', line: n };
  }
  return { picked: t, pickType: 'ml', line: null };
}

async function pollCbsPicks() {
  if (db.getSetting('cbs_scrape_enabled', '1') !== '1') return 0;
  let inserted = 0, dupes = 0, rows = 0;

  for (const page of PAGES) {
    const res = await get(page.url);
    if (res.status !== 200 || !res.body) { console.warn(`[cbs] ${page.sport} fetch failed:`, res.status); continue; }
    for (const row of parseRows(res.body)) {
      const game = findGameByTeams(row.teamA, row.teamB, page.sport);
      if (!game) continue;
      rows++;
      for (const p of row.picks) {
        const parsed = parsePickText(p.text, p.market, p.line);
        if (!parsed) continue;
        const side = sideOf(game, parsed.picked);
        if (!side) continue;
        const out = recordSourcePick({
          source: 'cbs',
          capperName: p.expert,
          handle: p.expert,
          game,
          pickType: parsed.pickType,
          side,
          line: parsed.line,
          odds: null, // grid shows the line, not the juice; standard juice applies
          postedAtMs: Date.now(), // grid carries no per-pick stamp; pregame while the button renders
          meta: { market: p.market, cell: p.text },
        });
        if (out === 'inserted') inserted++;
        else if (out === 'duplicate') dupes++;
      }
    }
  }
  if (inserted || dupes) console.log(`[cbs] poll: ${inserted} new picks, ${dupes} known across ${rows} matched games`);
  return inserted;
}

module.exports = { pollCbsPicks, parseRows, parsePickText };

// CLI: node src/cbs_picks.js
if (require.main === module) pollCbsPicks().then(() => process.exit(0));
