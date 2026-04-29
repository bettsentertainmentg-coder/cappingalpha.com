// src/public_betting.js
// Scrapes public betting % (tickets + money) from ActionNetwork public-betting pages.
// Data is embedded as __NEXT_DATA__ JSON — no API key needed.
// Provides getPublicBettingForGame() for use in game detail routes.

const https = require('https');
const db    = require('./db');

// ActionNetwork URL slug per sport
const AN_SPORT_SLUG = {
  NBA:   'nba',
  NFL:   'nfl',
  MLB:   'mlb',
  NHL:   'nhl',
  NCAAF: 'college-football',
  CBB:   'ncaab',
};

// Preferred book IDs to use for % data (all return identical %, pick first with data)
const PREFERRED_BOOKS = ['15', '68', '69', '71', '75', '123', '30'];

// ── Fetch HTML ────────────────────────────────────────────────────────────────
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.actionnetwork.com/',
      }
    }, res => {
      let html = '';
      res.on('data', chunk => { html += chunk; });
      res.on('end', () => resolve(html));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Extract __NEXT_DATA__ JSON ────────────────────────────────────────────────
function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{.+?\})<\/script>/s);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

// ── Team nickname (last word) for fuzzy matching ──────────────────────────────
function teamNick(name) {
  return (name || '').trim().split(' ').pop().toLowerCase();
}

// ── Find the best book data block with non-zero % ─────────────────────────────
function findBookData(markets) {
  // Try preferred books first (they all return identical %, just pick first available)
  for (const bookId of PREFERRED_BOOKS) {
    const event = markets[bookId]?.event;
    if (!event) continue;
    const hasData = Object.values(event).flat().some(o => o?.bet_info?.tickets?.percent > 0);
    if (hasData) return event;
  }
  // Fallback: any book with data
  for (const [, bd] of Object.entries(markets)) {
    const event = bd?.event;
    if (!event) continue;
    const hasData = Object.values(event).flat().some(o => o?.bet_info?.tickets?.percent > 0);
    if (hasData) return event;
  }
  return null;
}

// ── Extract pct from a book event block ──────────────────────────────────────
function getPct(event, type, side, field) {
  const outcomes = event[type];
  if (!Array.isArray(outcomes)) return null;
  const o = outcomes.find(x => x.side === side);
  const val = o?.bet_info?.[field]?.percent;
  return (val != null && val > 0) ? val : null;
}

// ── Main scrape: fetch + parse + store for one sport ─────────────────────────
async function fetchPublicBetting(sport) {
  const slug = AN_SPORT_SLUG[sport];
  if (!slug) return;

  let html;
  try {
    html = await fetchHtml(`https://www.actionnetwork.com/${slug}/public-betting`);
  } catch (err) {
    console.error(`[publicBetting] fetch error (${sport}):`, err.message);
    return;
  }

  const nextData = extractNextData(html);
  if (!nextData) {
    console.error(`[publicBetting] no __NEXT_DATA__ for ${sport}`);
    return;
  }

  const games = nextData?.props?.pageProps?.scoreboardResponse?.games;
  if (!Array.isArray(games) || games.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO public_betting (
      espn_game_id,
      away_ml_pct,       home_ml_pct,
      away_ml_money_pct, home_ml_money_pct,
      away_spread_pct,       home_spread_pct,
      away_spread_money_pct, home_spread_money_pct,
      over_pct,  under_pct,
      over_money_pct, under_money_pct,
      fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let stored = 0;
  for (const g of games) {
    const homeTeam = (g.teams || []).find(t => t.id === g.home_team_id);
    const awayTeam = (g.teams || []).find(t => t.id === g.away_team_id);
    if (!homeTeam || !awayTeam) continue;

    // Match to ESPN game by abbr (primary) or team nickname (fallback)
    const homeAbbr = (homeTeam.abbr || '').toUpperCase();
    const awayAbbr = (awayTeam.abbr || '').toUpperCase();
    const homeNick = teamNick(homeTeam.full_name);
    const awayNick = teamNick(awayTeam.full_name);

    // today_games is already wiped+repopulated daily — no date filter needed.
    // Skipping UTC date check avoids false misses for late games (e.g. 10pm ET = next UTC day).
    const dbGame = db.prepare(`
      SELECT espn_game_id FROM today_games
      WHERE sport = ?
        AND (home_abbr = ? OR LOWER(home_team) LIKE ?)
        AND (away_abbr = ? OR LOWER(away_team) LIKE ?)
      LIMIT 1
    `).get(sport, homeAbbr, `%${homeNick}%`, awayAbbr, `%${awayNick}%`);

    if (!dbGame) continue;

    const event = findBookData(g.markets || {});
    if (!event) continue;

    stmt.run(
      dbGame.espn_game_id,
      getPct(event, 'moneyline', 'away', 'tickets'),
      getPct(event, 'moneyline', 'home', 'tickets'),
      getPct(event, 'moneyline', 'away', 'money'),
      getPct(event, 'moneyline', 'home', 'money'),
      getPct(event, 'spread',    'away', 'tickets'),
      getPct(event, 'spread',    'home', 'tickets'),
      getPct(event, 'spread',    'away', 'money'),
      getPct(event, 'spread',    'home', 'money'),
      getPct(event, 'total',     'over',  'tickets'),
      getPct(event, 'total',     'under', 'tickets'),
      getPct(event, 'total',     'over',  'money'),
      getPct(event, 'total',     'under', 'money'),
    );
    stored++;
  }

  if (stored > 0) console.log(`[publicBetting] ${sport}: stored ${stored}/${games.length} games`);
}

// ── Read back for one game (called from route handlers) ───────────────────────
function getPublicBettingForGame(espn_game_id) {
  return db.prepare(`SELECT * FROM public_betting WHERE espn_game_id = ?`).get(espn_game_id) || null;
}

module.exports = { fetchPublicBetting, getPublicBettingForGame };
