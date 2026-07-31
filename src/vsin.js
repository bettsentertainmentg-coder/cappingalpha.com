// src/vsin.js
// VSiN betting splits (data.vsin.com) — actual DraftKings Sportsbook action:
// Bets % (tickets) + Handle % (money) per Spread / Total / Moneyline.
// Free public pages, server-rendered per sport (tennis needs a &league= param).
//
// Role in the pipeline (Jack 2026-07-30): GAP FILLER + TENNIS DEFAULT.
//  - Tennis (ATP/WTA): VSiN is the ONLY free splits source — rows are written
//    outright (overwrite), labeled source='vsin'.
//  - Every other sport: fill what ActionNetwork hasn't scraped — insert a full
//    row when a game has none, or fill NULL columns on an existing AN row
//    (never overwrite a non-null AN value; the two books measure different
//    pools and mixing silently would corrupt the numbers).
// Zero cost, no auth. Pages parse from one <table>: away row then home row per
// game; the total columns read Over on the first row, Under on the second.

const https = require('https');
const db    = require('./db');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'https://data.vsin.com/betting-splits/';

// Our sport label -> VSiN sport key. WNBA has no VSiN page (AN covers it).
const VSIN_SPORT = {
  MLB:   'MLB',
  NBA:   'NBA',
  NFL:   'NFL',
  NHL:   'NHL',
  NCAAF: 'CFB',
  CBB:   'CBB',
  Soccer:'SOC',
  ATP:   'TEN',
  WTA:   'TEN',
};

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Referer': 'https://data.vsin.com/' },
    }, res => {
      // The bare sport URLs 302 to the canonical query form; follow one hop.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return fetchHtml(next).then(resolve, reject);
      }
      let html = '';
      res.on('data', c => { html += c; });
      res.on('end', () => resolve(html));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Table parsing ─────────────────────────────────────────────────────────────
function cellText(c) {
  return c
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ')   // arrows, entities
    .replace(/\s+/g, ' ')
    .trim();
}

function pctOf(txt) {
  const m = /(-?\d+(?:\.\d+)?)\s*%/.exec(txt || '');
  return m ? Math.round(parseFloat(m[1])) : null;
}

// A pair of percentages is real only if it roughly sums to 100 — VSiN renders
// unoffered markets (e.g. tennis spreads) as 0% / 0%.
function pairOk(a, b) {
  return a != null && b != null && a + b >= 90 && a + b <= 110;
}

// Parse the splits table into [{away:{name,...}, home:{name,...}}, ...].
// Row cells: [icon] [name] [sprLine] [sprHnd] [sprBet] [totLine] [totHnd]
// [totBet] [mlOdds] [mlHnd] [mlBet]
function parseSplits(html) {
  const tStart = html.indexOf('<table');
  if (tStart === -1) return [];
  const table = html.slice(tStart, html.indexOf('</table>', tStart));
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  const sides = [];
  for (const r of rows) {
    const cells = [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m => cellText(m[1]));
    if (cells.length < 11) continue;                 // header/section rows
    const name = cells[1];
    if (!name || /^(Spread|Handle|Bets|Total|Money)/.test(name)) continue;
    sides.push({
      name,
      sprHnd: pctOf(cells[3]), sprBet: pctOf(cells[4]),
      totHnd: pctOf(cells[6]), totBet: pctOf(cells[7]),
      mlHnd:  pctOf(cells[9]), mlBet:  pctOf(cells[10]),
    });
  }
  const games = [];
  for (let i = 0; i + 1 < sides.length; i += 2) {
    games.push({ away: sides[i], home: sides[i + 1] });
  }
  return games;
}

// ── Game matching ─────────────────────────────────────────────────────────────
function nick(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return (parts[parts.length - 1] || '').toLowerCase();
}

// Find the board row for a VSiN pair; returns { id, flipped } — flipped means
// VSiN's first-listed side is OUR home team (tennis order is arbitrary).
function findBoardGame(sports, a, b) {
  const ph = sports.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT espn_game_id, home_team, away_team FROM today_games
    WHERE sport IN (${ph})
    ORDER BY CASE status WHEN 'pre' THEN 0 WHEN 'in' THEN 1 ELSE 2 END, start_time ASC
  `).all(...sports);
  const an = nick(a.name), bn = nick(b.name);
  if (!an || !bn) return null;
  for (const g of rows) {
    const hn = String(g.home_team || '').toLowerCase();
    const wn = String(g.away_team || '').toLowerCase();
    if (wn.includes(an) && hn.includes(bn)) return { id: g.espn_game_id, flipped: false };
    if (wn.includes(bn) && hn.includes(an)) return { id: g.espn_game_id, flipped: true };
  }
  return null;
}

// ── Storage (merge policy) ────────────────────────────────────────────────────
function toRow(pair) {
  const { away, home } = pair;
  const row = {
    away_ml_pct: away.mlBet, home_ml_pct: home.mlBet,
    away_ml_money_pct: away.mlHnd, home_ml_money_pct: home.mlHnd,
    away_spread_pct: away.sprBet, home_spread_pct: home.sprBet,
    away_spread_money_pct: away.sprHnd, home_spread_money_pct: home.sprHnd,
    // Total: Over reads on the first row, Under on the second.
    over_pct: away.totBet, under_pct: home.totBet,
    over_money_pct: away.totHnd, under_money_pct: home.totHnd,
  };
  // Null out unoffered markets (0%/0% renders).
  if (!pairOk(row.away_ml_pct, row.home_ml_pct)) row.away_ml_pct = row.home_ml_pct = null;
  if (!pairOk(row.away_ml_money_pct, row.home_ml_money_pct)) row.away_ml_money_pct = row.home_ml_money_pct = null;
  if (!pairOk(row.away_spread_pct, row.home_spread_pct)) row.away_spread_pct = row.home_spread_pct = null;
  if (!pairOk(row.away_spread_money_pct, row.home_spread_money_pct)) row.away_spread_money_pct = row.home_spread_money_pct = null;
  if (!pairOk(row.over_pct, row.under_pct)) row.over_pct = row.under_pct = null;
  if (!pairOk(row.over_money_pct, row.under_money_pct)) row.over_money_pct = row.under_money_pct = null;
  return row;
}

function flipRow(r) {
  return {
    away_ml_pct: r.home_ml_pct, home_ml_pct: r.away_ml_pct,
    away_ml_money_pct: r.home_ml_money_pct, home_ml_money_pct: r.away_ml_money_pct,
    away_spread_pct: r.home_spread_pct, home_spread_pct: r.away_spread_pct,
    away_spread_money_pct: r.home_spread_money_pct, home_spread_money_pct: r.away_spread_money_pct,
    over_pct: r.over_pct, under_pct: r.under_pct,
    over_money_pct: r.over_money_pct, under_money_pct: r.under_money_pct,
  };
}

const COLS = [
  'away_ml_pct', 'home_ml_pct', 'away_ml_money_pct', 'home_ml_money_pct',
  'away_spread_pct', 'home_spread_pct', 'away_spread_money_pct', 'home_spread_money_pct',
  'over_pct', 'under_pct', 'over_money_pct', 'under_money_pct',
];

function hasAnyData(row) {
  return COLS.some(c => row[c] != null);
}

// overwrite=true (tennis): the row is VSiN's. Otherwise: create when missing,
// fill NULL columns only when an AN row already exists.
function upsertSplits(espnId, row, overwrite) {
  const existing = db.prepare(`SELECT * FROM public_betting WHERE espn_game_id = ?`).get(espnId);
  if (!existing) {
    db.prepare(`
      INSERT INTO public_betting (espn_game_id, ${COLS.join(', ')}, source, fetched_at)
      VALUES (?, ${COLS.map(() => '?').join(', ')}, 'vsin', datetime('now'))
    `).run(espnId, ...COLS.map(c => row[c]));
    return 'insert';
  }
  const sets = [];
  const vals = [];
  for (const c of COLS) {
    if (row[c] == null) continue;
    if (!overwrite && existing[c] != null) continue;
    sets.push(`${c} = ?`);
    vals.push(row[c]);
  }
  if (!sets.length) return 'noop';
  const src = overwrite ? 'vsin' : (existing.source || (existing.away_ml_pct != null || existing.away_spread_pct != null ? 'mixed' : 'vsin'));
  db.prepare(`UPDATE public_betting SET ${sets.join(', ')}, source = ?, fetched_at = datetime('now') WHERE espn_game_id = ?`)
    .run(...vals, src, espnId);
  return 'fill';
}

// ── Fetchers ──────────────────────────────────────────────────────────────────
async function fetchSportPage(vsinKey, league) {
  const url = `${BASE}?source=DK&sport=${vsinKey}${league ? `&league=${league}` : ''}`;
  return parseSplits(await fetchHtml(url));
}

// Tennis index page lists tournaments as ?league= links; keep tour-level events
// (ATP/WTA), skip Challengers/ITF (not on our board).
async function tennisLeagues() {
  const html = await fetchHtml(`${BASE}?source=DK&sport=TEN`);
  const out = [];
  // League cards: <a href="?...league=NNN"> ... <span class="sp-league-name">ATP - Washington</span>
  for (const m of html.matchAll(/league=(\d+)[^>]*>[\s\S]{0,400}?sp-league-name">([^<]+)</g)) {
    const label = cellText(m[2]);
    if (/^(ATP|WTA)\b/i.test(label)) out.push({ league: m[1], label });
  }
  return out.slice(0, 8);
}

// Main entry: sweep every VSiN sport that has games on today's board.
async function fetchVsinSplits() {
  const boardSports = db.prepare(`SELECT DISTINCT sport FROM today_games`).all().map(r => r.sport);
  const summary = {};
  const seenTen = boardSports.some(s => s === 'ATP' || s === 'WTA');
  const teamSports = boardSports.filter(s => VSIN_SPORT[s] && VSIN_SPORT[s] !== 'TEN');

  for (const sport of teamSports) {
    try {
      const games = await fetchSportPage(VSIN_SPORT[sport]);
      let n = 0;
      for (const pair of games) {
        const hit = findBoardGame([sport], pair.away, pair.home);
        if (!hit) continue;
        let row = toRow(pair);
        if (hit.flipped) row = flipRow(row);
        if (!hasAnyData(row)) continue;
        if (upsertSplits(hit.id, row, false) !== 'noop') n++;
      }
      summary[sport] = n;
    } catch (e) {
      console.error(`[vsin] ${sport}:`, e.message);
    }
    await sleep(400);
  }

  if (seenTen) {
    try {
      let n = 0;
      for (const lg of await tennisLeagues()) {
        const games = await fetchSportPage('TEN', lg.league);
        for (const pair of games) {
          const hit = findBoardGame(['ATP', 'WTA'], pair.away, pair.home);
          if (!hit) continue;
          let row = toRow(pair);
          if (hit.flipped) row = flipRow(row);
          if (!hasAnyData(row)) continue;
          if (upsertSplits(hit.id, row, true) !== 'noop') n++;   // tennis: VSiN owns the row
        }
        await sleep(400);
      }
      summary.Tennis = n;
    } catch (e) {
      console.error('[vsin] tennis:', e.message);
    }
  }

  const parts = Object.entries(summary).map(([k, v]) => `${k}:${v}`).join(' ');
  if (parts) console.log(`[vsin] stored/filled ${parts}`);
  return summary;
}

module.exports = { fetchVsinSplits };
