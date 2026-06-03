// src/polymarket.js
// Fetches prediction market probabilities from Polymarket's free public API.
// No auth, no API key required. Rate limit: 4,000 req/10s.
// Polled every 15 min; every 5 min for games within 60 min of tip.

const db = require('./db');

// Polymarket tag slugs per sport
const TAG_MAP = {
  NBA:   'nba',
  MLB:   'mlb',
  NHL:   'nhl',
  NFL:   'nfl',
  CBB:   'ncaab',
  NCAAF: 'ncaaf',
  // Polymarket tags both tours under a single 'tennis' slug (the 'tennis-atp' /
  // 'tennis-wta' slugs return nothing). Events are player-vs-player; matching is
  // by player last name, same as team nicknames.
  ATP:   'tennis',
  WTA:   'tennis',
};

// Sync all pre-game games
async function syncPolymarketData(games) {
  const preGames = games.filter(g => g.status === 'pre' && TAG_MAP[g.sport]);
  await _syncGames(preGames);
}

// Sync only games within 60 min (for the 5-min cron)
async function syncPolymarketSoon(games) {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  const soonGames = games.filter(g => {
    if (g.status !== 'pre' || !TAG_MAP[g.sport]) return false;
    if (!g.start_time) return false;
    const minsUntil = new Date(g.start_time).getTime() - now;
    return minsUntil >= 0 && minsUntil <= ONE_HOUR;
  });
  await _syncGames(soonGames);
}

async function _syncGames(games) {
  if (!games.length) return;

  // Group by sport tag to minimize API calls
  const bySport = {};
  for (const g of games) {
    const tag = TAG_MAP[g.sport];
    if (!tag) continue;
    (bySport[tag] = bySport[tag] || []).push(g);
  }

  for (const [tag, sportGames] of Object.entries(bySport)) {
    try {
      // The 'tennis' tag has 100+ active events (and the API caps at 100/page),
      // so page through several to cover today's AND upcoming matches. Free API,
      // generous rate limit — extra pages are cheap.
      const pages  = tag === 'tennis' ? 6 : 1;
      const events = await fetchEvents(tag, pages);
      if (!events.length) continue;

      // Accumulate markets across events — first match per type wins
      const gameMarkets = {}; // espn_game_id → merged markets
      const gameVolume  = {}; // espn_game_id → max volume seen

      for (const ev of events) {
        // Skip series-level, season-level, and award events
        const tl = (ev.title || '').toLowerCase();
        if (tl.includes('series') || tl.includes('champion') || tl.includes('total games') ||
            tl.includes('conference') || tl.includes('mvp') || tl.includes('award') ||
            tl.includes('retire') || tl.includes('play-in') || tl.includes('season')) continue;

        const matched = matchGameToEvent(ev, sportGames);
        if (!matched) continue;
        const markets = extractAllMarkets(ev, matched);
        if (!Object.keys(markets).length) continue;

        const id = matched.espn_game_id;
        if (!gameMarkets[id]) gameMarkets[id] = {};
        for (const [type, data] of Object.entries(markets)) {
          if (!gameMarkets[id][type]) gameMarkets[id][type] = data; // keep first
        }
        const vol = parseFloat(ev.volume) || 0;
        gameVolume[id] = Math.max(gameVolume[id] || 0, vol);
      }

      for (const [id, markets] of Object.entries(gameMarkets)) {
        storeMarkets(id, markets, gameVolume[id] || null);
      }
    } catch (e) {
      // Silently ignore network errors
    }
  }
}

// Fetch up to `pages` pages (100 events each) for a tag, concatenated.
async function fetchEvents(tag, pages = 1) {
  const out = [];
  for (let p = 0; p < pages; p++) {
    try {
      const url = `https://gamma-api.polymarket.com/events?tag_slug=${tag}&active=true&closed=false&limit=100&offset=${p * 100}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) break;
      const evs = await r.json();
      if (!Array.isArray(evs) || !evs.length) break;
      out.push(...evs);
      if (evs.length < 100) break;   // last page
    } catch (_) { break; }
  }
  return out;
}

// Detect market type from question text
function detectMarketType(question) {
  const q = (question || '').toLowerCase();
  if (q.includes('o/u') || (q.includes('over') && q.includes('under'))) return 'total';
  if (q.match(/[+-]\d+\.?\d*/) && !q.includes('series') && !q.includes('game ')) return 'spread';
  return 'moneyline';
}

// Extract market data — handles both top-level and nested markets
function extractAllMarkets(ev, game) {
  const result = {};
  const spreadCandidates = []; // collect all spread markets, pick best at end

  const processMarket = (q, outcomes, priceStr) => {
    try {
      const ql = (q || '').toLowerCase();
      // Skip first-half, player props, series/award markets
      if (ql.includes('1h ') || ql.includes('half')) return;
      if (ql.includes('series') || ql.includes('champion') || ql.includes('mvp')) return;
      if (ql.includes('rebounds') || ql.includes('assists') || ql.includes('points o/u')) return;
      if (ql.includes('total games')) return;

      const type = detectMarketType(q);

      const prices = typeof priceStr === 'string' ? JSON.parse(priceStr) : priceStr;
      const outs   = typeof outcomes === 'string' ? JSON.parse(outcomes) : outcomes;
      if (!Array.isArray(prices) || prices.length < 2) return;
      if (!Array.isArray(outs)   || outs.length < 2)   return;

      // Skip "Yes"/"No" outcomes (player props or other binary questions)
      if (outs[0] === 'Yes' || outs[0] === 'No') return;

      const p0 = parseFloat(prices[0]);
      const p1 = parseFloat(prices[1]);
      if (isNaN(p0) || isNaN(p1)) return;

      if (type === 'total') {
        if (result.total) return; // already have one
        // Outcomes: ["Over", "Under"] — line is in the question like "O/U 216.5"
        const overIdx = outs.findIndex(o => o.toLowerCase().startsWith('over'));
        if (overIdx === -1) return;
        const underIdx = overIdx === 0 ? 1 : 0;
        const lineMatch = ql.match(/[\d.]+\s*$/); // trailing number from question
        result.total = {
          over_prob:  overIdx === 0 ? p0 : p1,
          under_prob: underIdx === 0 ? p0 : p1,
          line: lineMatch ? parseFloat(lineMatch[0]) : null,
        };
      } else if (type === 'spread') {
        // Collect all spread candidates — pick closest to 50/50 at the end
        const homeIdx = outs.findIndex(o => nameMatch(o, game.home_team));
        if (homeIdx === -1) return;
        const awayIdx = homeIdx === 0 ? 1 : 0;
        const lineMatch = ql.match(/\(([+-][\d.]+)\)/);
        const homeProb = homeIdx === 0 ? p0 : p1;
        spreadCandidates.push({
          home_prob: homeProb,
          away_prob: awayIdx === 0 ? p0 : p1,
          line: lineMatch ? parseFloat(lineMatch[1]) : null,
          balance: Math.abs(homeProb - 0.5), // closeness to 50/50
        });
      } else if (!result.moneyline) {
        // moneyline — take first
        const homeIdx = outs.findIndex(o => nameMatch(o, game.home_team));
        if (homeIdx === -1) {
          result.moneyline = { home_prob: p0, away_prob: p1 };
          return;
        }
        const awayIdx = homeIdx === 0 ? 1 : 0;
        result.moneyline = {
          home_prob: homeIdx === 0 ? p0 : p1,
          away_prob: awayIdx === 0 ? p0 : p1,
        };
      }
    } catch (_) {}
  };

  // Top-level market (simple events)
  if (ev.outcomePrices || ev.outcomes) {
    processMarket(ev.question || ev.title || '', ev.outcomes, ev.outcomePrices);
  }

  // Nested markets (complex events with spread/total sub-markets)
  if (Array.isArray(ev.markets)) {
    for (const m of ev.markets) {
      processMarket(m.question || m.title || '', m.outcomes, m.outcomePrices);
    }
  }

  // Pick the most balanced spread (closest to 50/50 probability)
  if (spreadCandidates.length > 0) {
    spreadCandidates.sort((a, b) => a.balance - b.balance);
    const best = spreadCandidates[0];
    result.spread = { home_prob: best.home_prob, away_prob: best.away_prob, line: best.line };
  }

  return result;
}

function storeMarkets(espn_game_id, markets, volume) {
  const marketsJson = JSON.stringify(markets);
  db.prepare(`
    INSERT INTO polymarket_cache (espn_game_id, markets_json, morning_markets_json, volume_usd, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(espn_game_id) DO UPDATE SET
      markets_json       = excluded.markets_json,
      -- Lock morning snapshot on first entry (never overwrite once set)
      morning_markets_json = COALESCE(morning_markets_json, excluded.markets_json),
      volume_usd         = excluded.volume_usd,
      updated_at         = excluded.updated_at
  `).run(espn_game_id, marketsJson, marketsJson, volume);
}

// Fuzzy team name match — checks if a string contains the team's last word (city or mascot)
function nameMatch(str, teamName) {
  if (!str || !teamName) return false;
  const s = str.toLowerCase();
  const t = teamName.toLowerCase();
  const nick = t.split(' ').pop();
  return s.includes(nick) || s.includes(t);
}

// Match a Polymarket event to one of our ESPN games by team names in the title
function matchGameToEvent(ev, games) {
  const title = (ev.title || ev.question || '').toLowerCase();
  return games.find(g => {
    const homeNick = (g.home_team || '').split(' ').pop().toLowerCase();
    const awayNick = (g.away_team || '').split(' ').pop().toLowerCase();
    return title.includes(homeNick) && title.includes(awayNick);
  }) || null;
}

function getPolymarketForGame(espn_game_id) {
  return db.prepare(`SELECT * FROM polymarket_cache WHERE espn_game_id = ?`).get(espn_game_id) || null;
}

module.exports = { syncPolymarketData, syncPolymarketSoon, getPolymarketForGame };
