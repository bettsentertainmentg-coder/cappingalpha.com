// src/kalshi.js
// Fetches moneyline, spread, and total from Kalshi's free public API.
// Game events = win/lose only. Spread + total are in separate series.
// Consensus line = market closest to 50% probability (most balanced).

const db = require('./db');
const { ET_OFFSET_MS } = require('./cycle');

// Per-game moneyline series. Team sports use KX<LEAGUE>GAME; tennis uses
// KXATPMATCH / KXWTAMATCH (the KXATPGAME/KXWTAGAME slugs exist but return no open
// events). College hoops (CBB) and tennis only publish a winner market, no
// spread/total series — those are simply absent from SPREAD_SERIES/TOTAL_SERIES.
const GAME_SERIES   = {
  NBA:  'KXNBAGAME',  MLB:   'KXMLBGAME',   NHL: 'KXNHLGAME',   NFL: 'KXNFLGAME',
  WNBA: 'KXWNBAGAME', NCAAF: 'KXNCAAFGAME', CBB: 'KXNCAABGAME',
  ATP:  'KXATPMATCH', WTA:   'KXWTAMATCH',
};
const SPREAD_SERIES = {
  NBA:  'KXNBASPREAD',  MLB:   'KXMLBSPREAD',   NHL: 'KXNHLSPREAD', NFL: 'KXNFLSPREAD',
  WNBA: 'KXWNBASPREAD', NCAAF: 'KXNCAAFSPREAD',
};
const TOTAL_SERIES  = {
  NBA:  'KXNBATOTAL',  MLB:   'KXMLBTOTAL',   NHL: 'KXNHLTOTAL', NFL: 'KXNFLTOTAL',
  WNBA: 'KXWNBATOTAL', NCAAF: 'KXNCAAFTOTAL',
};

// Sports where home_team/away_team hold player names, not city + nickname.
const TENNIS_SPORTS = new Set(['ATP', 'WTA']);

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

async function syncKalshiData(games) {
  // Any status with a Kalshi series — finished games carry the day's biggest
  // volume and must keep their place in the Top Games ranking (settled markets
  // are fetched alongside open ones below).
  const wanted = games.filter(g => GAME_SERIES[g.sport]);
  await _syncGames(wanted);
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
      // Fetch the series sequentially with gaps — Kalshi rate-limits parallel
      // bursts. Spread/total are skipped for leagues that don't publish them
      // (tennis, college hoops) so we don't waste calls on nonexistent series.
      // Also pull SETTLED game events so finished games keep their (often largest)
      // volume in the ranking — their market drops out of the `open` feed.
      const gameEvtsOpen = await fetchSeries(GAME_SERIES[sport], 'open');
      await _sleep(300);
      const gameEvtsSettled = await fetchSeries(GAME_SERIES[sport], 'settled');
      const gameEvts = [...gameEvtsOpen, ...gameEvtsSettled];
      let spreadEvts = [], totalEvts = [];
      if (SPREAD_SERIES[sport]) { await _sleep(300); spreadEvts = await fetchSeries(SPREAD_SERIES[sport]); }
      if (TOTAL_SERIES[sport])  { await _sleep(300); totalEvts  = await fetchSeries(TOTAL_SERIES[sport]); }

      const marketMap = {}; // espn_game_id → { moneyline, spread, total }
      const volumeMap = {};
      // Freeze probabilities once a game tips off (volume keeps flowing for ranking).
      const startedMap = {};
      for (const g of sportGames) startedMap[g.espn_game_id] = !!(g.status && g.status !== 'pre');

      // Moneyline from game events (filter to today's date — series returns multiple days)
      for (const ev of gameEvts) {
        const game = matchEventToGame(ev, sportGames);
        if (!game) continue;
        if (!eventMatchesGameDate(ev, game)) continue;
        // Volume drives the Top Games ranking, so capture it straight off the event
        // even when the moneyline can't be resolved (settled markets have no live
        // bid/ask). Keep the largest seen across the open + settled passes.
        // Kalshi reports volume in CONTRACTS; Polymarket reports USD. The Top Games
        // ranking sums the two, so convert contracts -> dollars here (contracts x
        // mid yes-price, since each contract settles $0-$1). Without this a tennis
        // match with a big contract count outranked an MLB game carrying far more
        // real money. Fall back to $0.50 (max-uncertainty mid) when a settled
        // market has no live bid/ask so its volume still counts in USD terms.
        let evVol = 0;
        for (const m of (ev.markets || [])) {
          const contracts = parseFloat(m.volume_fp || m.volume || 0) || 0;
          if (contracts <= 0) continue;
          const bid = parseFloat(m.yes_bid_dollars), ask = parseFloat(m.yes_ask_dollars);
          const price = (!isNaN(bid) && !isNaN(ask) && (bid + ask) > 0) ? (bid + ask) / 2 : 0.5;
          evVol += contracts * price;
        }
        if (evVol > 0) volumeMap[game.espn_game_id] = Math.max(volumeMap[game.espn_game_id] || 0, evVol);
        const ml = extractMoneyline(ev, game);
        if (!ml) continue;
        if (!marketMap[game.espn_game_id]) marketMap[game.espn_game_id] = {};
        marketMap[game.espn_game_id].moneyline = ml.moneyline;
        if (ml.volume) volumeMap[game.espn_game_id] = Math.max(volumeMap[game.espn_game_id] || 0, ml.volume);
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

      // Games with resolved markets get a full upsert; games with only volume
      // (settled / finished) get a volume-only update so we don't wipe any odds
      // snapshot already on file.
      for (const id of new Set([...Object.keys(marketMap), ...Object.keys(volumeMap)])) {
        if (marketMap[id]) storeMarkets(id, marketMap[id], volumeMap[id] || null, startedMap[id]);
        else if (volumeMap[id] != null) storeVolumeOnly(id, volumeMap[id]);
      }
    } catch (_) {}
  }
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchSeries(seriesTicker, status = 'open') {
  const url = `${BASE_URL}/events?series_ticker=${seriesTicker}&with_nested_markets=true&limit=100&status=${status}`;
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

// Returns false only when BOTH dates are parseable AND they don't match (fails open).
// Compare in ET: the Kalshi ticker date is the game's ET calendar date, but our
// start_time can be stored as midnight UTC (e.g. 2026-06-07T00:00Z = 8pm ET Jun 6).
// Comparing in the server's local time mis-dated these on the UTC production box —
// an NHL playoff game read as "Jun 7" there and never matched its "JUN06" ticker,
// so it silently lost all Kalshi volume. Always normalize the game to its ET date.
function eventMatchesGameDate(ev, game) {
  const evDate = tickerDate(ev.event_ticker || ev.ticker || '');
  if (!evDate || !game.start_time) return true;
  const gt = new Date(game.start_time).getTime();
  if (isNaN(gt)) return true;
  const etYmd = new Date(gt - ET_OFFSET_MS).toISOString().slice(0, 10);
  const evYmd = `${evDate.getFullYear()}-${String(evDate.getMonth() + 1).padStart(2, '0')}-${String(evDate.getDate()).padStart(2, '0')}`;
  return etYmd === evYmd;
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

  const tennis = TENNIS_SPORTS.has(game.sport);
  // Tennis: match on last name only. cityOf() would return a player's FIRST name,
  // which collides when two players share one (e.g. Matteo Arnaldi vs Matteo
  // Berrettini), so never use it for tennis.
  const homeKeys = tennis ? [nickOf(game.home_team)]
                          : [cityOf(game.home_team), nickOf(game.home_team)].filter(Boolean);
  const awayKeys = tennis ? [nickOf(game.away_team)]
                          : [cityOf(game.away_team), nickOf(game.away_team)].filter(Boolean);

  let homeProb = null, awayProb = null, totalVolume = 0;

  for (const m of mktList) {
    const sub  = (m.yes_sub_title || '').toLowerCase();
    const bid  = parseFloat(m.yes_bid_dollars);
    const ask  = parseFloat(m.yes_ask_dollars);
    if (isNaN(bid) || isNaN(ask)) continue;
    const mid = (bid + ask) / 2;
    // Dollar volume (contracts x mid yes-price) so it's comparable to Polymarket
    // USD in the Top Games ranking. See the volume-capture loop in syncKalshi().
    const vol = parseFloat(m.volume_fp || m.volume || 0) || 0;
    if (vol > 0) totalVolume += vol * mid;

    const isHome = homeKeys.some(k => k && sub.includes(k));
    const isAway = awayKeys.some(k => k && sub.includes(k));
    if (isHome && !isAway) homeProb = mid;
    else if (isAway && !isHome) awayProb = mid;
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
    // Tennis events are titled "Lastname vs Lastname" — match purely on last names.
    if (TENNIS_SPORTS.has(g.sport)) {
      const homeLast = nickOf(g.home_team), awayLast = nickOf(g.away_team);
      return !!(homeLast && awayLast && title.includes(homeLast) && title.includes(awayLast));
    }

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

// `started` freezes the probability snapshot once a game tips off — live markets
// race toward 100/0 as the game plays out, which is misleading on a pre-game odds
// popup. Once live/final we keep the last pre-game markets_json and only let
// volume_yes flow (the Top Games ranking is built on it). On a brand-new row (game
// first seen after start) we still seed markets_json so it isn't blank.
function storeMarkets(espn_game_id, markets, volume, started = false) {
  const marketsJson = JSON.stringify(markets);
  if (started) {
    db.prepare(`
      INSERT INTO kalshi_cache (espn_game_id, markets_json, morning_markets_json, volume_yes, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(espn_game_id) DO UPDATE SET
        volume_yes = excluded.volume_yes,
        updated_at = excluded.updated_at
    `).run(espn_game_id, marketsJson, marketsJson, volume);
    return;
  }
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

// Update only the volume for ranking, preserving any markets_json already stored
// (used for settled/finished games whose live odds can't be resolved). Inserts a
// bare row when none exists so the game still ranks.
function storeVolumeOnly(espn_game_id, volume) {
  db.prepare(`
    INSERT INTO kalshi_cache (espn_game_id, markets_json, morning_markets_json, volume_yes, updated_at)
    VALUES (?, '{}', '{}', ?, datetime('now'))
    ON CONFLICT(espn_game_id) DO UPDATE SET
      volume_yes = excluded.volume_yes,
      updated_at = excluded.updated_at
  `).run(espn_game_id, volume);
}

function getKalshiForGame(espn_game_id) {
  return db.prepare(`SELECT * FROM kalshi_cache WHERE espn_game_id = ?`).get(espn_game_id) || null;
}

module.exports = { syncKalshiData, syncKalshiSoon, getKalshiForGame };
