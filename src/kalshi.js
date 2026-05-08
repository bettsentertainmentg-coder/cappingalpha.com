// src/kalshi.js
// Fetches moneyline, spread, and total from Kalshi's free public API.
// Game events = win/lose only. Spread + total are in separate series.
// Consensus line = market closest to 50% probability (most balanced).

const db = require('./db');

const GAME_SERIES   = { NBA: 'KXNBAGAME',   MLB: 'KXMLBGAME',   NHL: 'KXNHLGAME',   NFL: 'KXNFLGAME'   };
const SPREAD_SERIES = { NBA: 'KXNBASPREAD', MLB: 'KXMLBSPREAD', NHL: 'KXNHLSPREAD', NFL: 'KXNFLSPREAD' };
const TOTAL_SERIES  = { NBA: 'KXNBATOTAL',  MLB: 'KXMLBTOTAL',  NHL: 'KXNHLTOTAL',  NFL: 'KXNFLTOTAL'  };

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

async function syncKalshiData(games) {
  const preGames = games.filter(g => g.status === 'pre' && GAME_SERIES[g.sport]);
  await _syncGames(preGames);
}

async function syncKalshiSoon(games) {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  const soonGames = games.filter(g => {
    if (g.status !== 'pre' || !GAME_SERIES[g.sport]) return false;
    if (!g.start_time) return false;
    const msUntil = new Date(g.start_time).getTime() - now;
    return msUntil >= 0 && msUntil <= ONE_HOUR;
  });
  await _syncGames(soonGames);
}

async function _syncGames(games) {
  if (!games.length) return;

  const bySport = {};
  for (const g of games) {
    if (GAME_SERIES[g.sport]) (bySport[g.sport] = bySport[g.sport] || []).push(g);
  }

  const sports = Object.entries(bySport);
  for (let si = 0; si < sports.length; si++) {
    const [sport, sportGames] = sports[si];
    if (si > 0) await _sleep(800); // pause between sports to avoid rate limiting
    try {
      // Fetch 3 series sequentially with gaps — Kalshi rate-limits parallel bursts
      const gameEvts   = await fetchSeries(GAME_SERIES[sport]);   await _sleep(300);
      const spreadEvts = await fetchSeries(SPREAD_SERIES[sport]); await _sleep(300);
      const totalEvts  = await fetchSeries(TOTAL_SERIES[sport]);

      const marketMap = {}; // espn_game_id → { moneyline, spread, total }
      const volumeMap = {};

      // Moneyline from game events (filter to today's date — series returns multiple days)
      for (const ev of gameEvts) {
        const game = matchEventToGame(ev, sportGames);
        if (!game) continue;
        if (!eventMatchesGameDate(ev, game)) continue;
        const ml = extractMoneyline(ev, game);
        if (!ml) continue;
        if (!marketMap[game.espn_game_id]) marketMap[game.espn_game_id] = {};
        marketMap[game.espn_game_id].moneyline = ml.moneyline;
        volumeMap[game.espn_game_id] = ml.volume;
      }

      // Spread
      for (const ev of spreadEvts) {
        const game = matchEventToGame(ev, sportGames);
        if (!game) continue;
        if (!eventMatchesGameDate(ev, game)) continue;
        const spread = extractSpread(ev, game);
        if (!spread) continue;
        if (!marketMap[game.espn_game_id]) marketMap[game.espn_game_id] = {};
        marketMap[game.espn_game_id].spread = spread;
      }

      // Total
      for (const ev of totalEvts) {
        const game = matchEventToGame(ev, sportGames);
        if (!game) continue;
        if (!eventMatchesGameDate(ev, game)) continue;
        const total = extractTotal(ev);
        if (!total) continue;
        if (!marketMap[game.espn_game_id]) marketMap[game.espn_game_id] = {};
        marketMap[game.espn_game_id].total = total;
      }

      for (const [id, markets] of Object.entries(marketMap)) {
        storeMarkets(id, markets, volumeMap[id] || null);
      }
    } catch (_) {}
  }
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchSeries(seriesTicker) {
  const url = `${BASE_URL}/events?series_ticker=${seriesTicker}&with_nested_markets=true&limit=100&status=open`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await _sleep(1500 * attempt);
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (r.status === 429) { await _sleep(2000); continue; }
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data?.events) ? data.events : [];
    } catch (_) {
      if (attempt === 2) return [];
    }
  }
  return [];
}

// ── Extraction helpers ────────────────────────────────────────────────────────

const cityOf = (name) => (name || '').split(' ').slice(0, -1).join(' ').toLowerCase();
const nickOf  = (name) => (name || '').split(' ').pop().toLowerCase();

// Parse date from Kalshi ticker: KXMLBGAME-26MAY101920DETKC → Date(2026, 4, 10)
const _MONTHS = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
function tickerDate(ticker) {
  const m = (ticker || '').match(/-(\d{2})([A-Z]{3})(\d{1,2})/);
  if (!m) return null;
  const mo = _MONTHS[m[2]];
  if (!mo) return null;
  return new Date(2000 + parseInt(m[1]), mo - 1, parseInt(m[3]));
}

// Returns false only when BOTH dates are parseable AND they don't match (fails open)
function eventMatchesGameDate(ev, game) {
  const evDate = tickerDate(ev.event_ticker || ev.ticker || '');
  if (!evDate || !game.start_time) return true;
  const gd = new Date(game.start_time);
  return evDate.getFullYear() === gd.getFullYear()
      && evDate.getMonth()    === gd.getMonth()
      && evDate.getDate()     === gd.getDate();
}

function closestTo50(markets) {
  let best = null, bestBalance = Infinity;
  for (const m of markets) {
    const bid = parseFloat(m.yes_bid_dollars);
    const ask = parseFloat(m.yes_ask_dollars);
    if (isNaN(bid) || isNaN(ask)) continue;
    const mid = (bid + ask) / 2;
    const balance = Math.abs(mid - 0.5);
    if (balance < bestBalance) {
      bestBalance = balance;
      best = { m, mid };
    }
  }
  return best;
}

// Moneyline: from game events — yes_sub_title tells us which team each market is for
function extractMoneyline(ev, game) {
  const mktList = ev.markets || [];
  if (mktList.length < 2) return null;

  const homeCity = cityOf(game.home_team), awayCity = cityOf(game.away_team);
  const homeNick = nickOf(game.home_team),  awayNick = nickOf(game.away_team);

  let homeProb = null, awayProb = null, totalVolume = 0;

  for (const m of mktList) {
    const sub  = (m.yes_sub_title || '').toLowerCase();
    const bid  = parseFloat(m.yes_bid_dollars);
    const ask  = parseFloat(m.yes_ask_dollars);
    if (isNaN(bid) || isNaN(ask)) continue;
    const mid = (bid + ask) / 2;
    const vol = parseFloat(m.volume_fp || 0);
    if (!isNaN(vol)) totalVolume += vol;

    const isHome = (homeCity && sub.includes(homeCity)) || (homeNick && sub.includes(homeNick));
    const isAway = (awayCity && sub.includes(awayCity)) || (awayNick && sub.includes(awayNick));
    if (isHome) homeProb = mid;
    else if (isAway) awayProb = mid;
  }

  // Fallback: market[0]=away, market[1]=home by ticker convention
  if (homeProb == null || awayProb == null) {
    const m0 = mktList[0], m1 = mktList[1];
    const b0 = parseFloat(m0?.yes_bid_dollars), a0 = parseFloat(m0?.yes_ask_dollars);
    const b1 = parseFloat(m1?.yes_bid_dollars), a1 = parseFloat(m1?.yes_ask_dollars);
    if (!isNaN(b0) && !isNaN(a0) && !isNaN(b1) && !isNaN(a1)) {
      const hAbbrUp = (game.home_abbr || '').toUpperCase();
      const t0 = (m0.ticker || '').toUpperCase();
      const isM0Home = hAbbrUp && t0.endsWith(hAbbrUp);
      homeProb = isM0Home ? (b0 + a0) / 2 : (b1 + a1) / 2;
      awayProb = isM0Home ? (b1 + a1) / 2 : (b0 + a0) / 2;
    }
  }

  if (homeProb == null || awayProb == null) return null;

  const tot = homeProb + awayProb;
  return {
    moneyline: { home_prob: homeProb / tot, away_prob: awayProb / tot },
    volume: totalVolume > 0 ? totalVolume : null,
  };
}

// Spread: from spread series — multiple "TEAM wins by over X" markets, pick closest to 50%
function extractSpread(ev, game) {
  const best = closestTo50(ev.markets || []);
  if (!best) return null;

  // Parse "TEAM wins by over X [points/runs/goals]"
  const sub = (best.m.yes_sub_title || best.m.title || '').toLowerCase();
  const winMatch = sub.match(/^(.+?)\s+wins by over ([\d.]+)/);
  if (!winMatch) return null;

  const teamStr = winMatch[1].trim();
  const line    = parseFloat(winMatch[2]);

  const homeCity = cityOf(game.home_team), awayCity = cityOf(game.away_team);
  const homeNick = nickOf(game.home_team),  awayNick = nickOf(game.away_team);
  const homeCityFirst = homeCity.split(' ')[0], awayCityFirst = awayCity.split(' ')[0];

  const isHome = (homeCity && teamStr.includes(homeCity))
              || (homeCityFirst && homeCityFirst.length >= 4 && teamStr.includes(homeCityFirst))
              || (homeNick && teamStr.includes(homeNick));
  const isAway = (awayCity && teamStr.includes(awayCity))
              || (awayCityFirst && awayCityFirst.length >= 4 && teamStr.includes(awayCityFirst))
              || (awayNick && teamStr.includes(awayNick));
  if (!isHome && !isAway) return null;

  // Line is home perspective: home favored → negative, home underdog → positive
  // "Home wins by over X" → home_spread = −X → home_prob = mid
  // "Away wins by over X" → home_spread = +X → home_prob = 1 − mid
  const homeLine = isHome ? -line : line;
  const homeProb = isHome ? best.mid : 1 - best.mid;

  return { home_prob: homeProb, away_prob: 1 - homeProb, line: homeLine };
}

// Total: from total series — multiple "Over X" markets, pick closest to 50%
function extractTotal(ev) {
  const best = closestTo50(ev.markets || []);
  if (!best) return null;

  const sub = (best.m.yes_sub_title || best.m.title || '').toLowerCase();
  const lineMatch = sub.match(/over ([\d.]+)/);
  if (!lineMatch) return null;

  const line = parseFloat(lineMatch[1]);
  return { over_prob: best.mid, under_prob: 1 - best.mid, line };
}

// Match a Kalshi event to one of our games by team city/nick in title
function matchEventToGame(ev, games) {
  const title = (ev.title || ev.sub_title || '').toLowerCase();
  // Strip series+date+time prefix to get just the team abbreviation portion of ticker
  // e.g. KXMLBGAME-26MAY081905ATHBAL → ATHBAL
  const tickerTeamPart = (ev.event_ticker || '').replace(/^[A-Z0-9]+-\d{2}[A-Z]{3}\d{2}\d{4}/, '').toUpperCase();

  return games.find(g => {
    const homeCity = cityOf(g.home_team), awayCity = cityOf(g.away_team);
    const homeNick = nickOf(g.home_team),  awayNick = nickOf(g.away_team);
    const homeAbbr = (g.home_abbr || '').toLowerCase();
    const awayAbbr = (g.away_abbr || '').toLowerCase();
    // First word of city handles "Chicago White Sox" → "chicago" matching "chicago ws"
    const homeCityFirst = homeCity.split(' ')[0];
    const awayCityFirst = awayCity.split(' ')[0];

    const hasHome = (homeCity && title.includes(homeCity))
                 || (homeCityFirst && homeCityFirst.length >= 4 && title.includes(homeCityFirst))
                 || (homeNick && title.includes(homeNick))
                 || (homeAbbr && title.includes(homeAbbr));
    const hasAway = (awayCity && title.includes(awayCity))
                 || (awayCityFirst && awayCityFirst.length >= 4 && title.includes(awayCityFirst))
                 || (awayNick && title.includes(awayNick))
                 || (awayAbbr && title.includes(awayAbbr));
    if (hasHome && hasAway) return true;

    // Ticker fallback: check team abbreviations in the ticker's team portion
    // Handles "Athletics" (ESPN abbr ATH, Kalshi title "A's vs Baltimore")
    const hA = (g.home_abbr || '').toUpperCase();
    const aA = (g.away_abbr || '').toUpperCase();
    return !!(tickerTeamPart && hA && aA
           && tickerTeamPart.includes(hA) && tickerTeamPart.includes(aA));
  }) || null;
}

function storeMarkets(espn_game_id, markets, volume) {
  const marketsJson = JSON.stringify(markets);
  db.prepare(`
    INSERT INTO kalshi_cache (espn_game_id, markets_json, morning_markets_json, volume_yes, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(espn_game_id) DO UPDATE SET
      markets_json         = excluded.markets_json,
      morning_markets_json = COALESCE(morning_markets_json, excluded.markets_json),
      volume_yes           = excluded.volume_yes,
      updated_at           = excluded.updated_at
  `).run(espn_game_id, marketsJson, marketsJson, volume);
}

function getKalshiForGame(espn_game_id) {
  return db.prepare(`SELECT * FROM kalshi_cache WHERE espn_game_id = ?`).get(espn_game_id) || null;
}

module.exports = { syncKalshiData, syncKalshiSoon, getKalshiForGame };
