// src/polymarket.js
// Fetches prediction market probabilities from Polymarket's free public API.
// No auth, no API key required. Rate limit: 4,000 req/10s.
// Polled every 15 min; every 5 min for games within 60 min of tip.

const db = require('./db');
const { ET_OFFSET_MS } = require('./cycle');

// Polymarket tag slugs per sport
const TAG_MAP = {
  NBA:   'nba',
  WNBA:  'wnba',
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

// Sync every game with a Polymarket tag, any status — live and just-finished games
// keep accumulating volume, which the Top Games ranking is built on. (Polymarket
// matches purely by team/player name, so there's no date filter to trip over.)
async function syncPolymarketData(games) {
  const wanted = games.filter(g => TAG_MAP[g.sport]);
  await _syncGames(wanted);
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
      const gameStarted = {}; // espn_game_id → true once the game is live/final

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
        gameStarted[id] = !!(matched.status && matched.status !== 'pre');
      }

      for (const [id, markets] of Object.entries(gameMarkets)) {
        storeMarkets(id, markets, gameVolume[id] || null, gameStarted[id]);
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
  const totalCandidates  = []; // collect all total markets, pick the main one at end

  const processMarket = (q, outcomes, priceStr, vol = 0) => {
    try {
      const ql = (q || '').toLowerCase();
      // Skip partial-game lines (1st half, 1st 5 innings, 1st inning), player
      // props, series/award markets. The partial totals/spreads were polluting
      // the main-line pick (a "1st 5 innings" run line can sit closer to 50/50
      // than the real run line).
      if (ql.includes('1h ') || ql.includes('half') || ql.includes('1st ') || ql.includes('inning')) return;
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
        // Outcomes: ["Over", "Under"] — line is in the question like "O/U 216.5".
        // Collect every total line; the book lists several (7.5, 8.5, 10.5…) and
        // the main one is simply the most-traded, so pick by volume at the end.
        const overIdx = outs.findIndex(o => o.toLowerCase().startsWith('over'));
        if (overIdx === -1) return;
        const lineMatch = ql.match(/[\d.]+\s*$/); // trailing number from question
        totalCandidates.push({
          over_prob:  overIdx === 0 ? p0 : p1,
          under_prob: overIdx === 0 ? p1 : p0,
          line: lineMatch ? parseFloat(lineMatch[0]) : null,
          vol: vol || 0,
        });
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
    processMarket(ev.question || ev.title || '', ev.outcomes, ev.outcomePrices,
                  parseFloat(ev.volumeNum || ev.volume || 0) || 0);
  }

  // Nested markets (complex events with spread/total sub-markets)
  if (Array.isArray(ev.markets)) {
    for (const m of ev.markets) {
      processMarket(m.question || m.title || '', m.outcomes, m.outcomePrices,
                    parseFloat(m.volumeNum || m.volume || 0) || 0);
    }
  }

  // Pick the most balanced spread (closest to 50/50 probability)
  if (spreadCandidates.length > 0) {
    spreadCandidates.sort((a, b) => a.balance - b.balance);
    const best = spreadCandidates[0];
    result.spread = { home_prob: best.home_prob, away_prob: best.away_prob, line: best.line };
  }

  // Pick the main total = the most-traded line (tiebreak: closest to 50/50). The
  // book quotes several alternate totals; the headline line carries the volume.
  if (totalCandidates.length > 0) {
    totalCandidates.sort((a, b) =>
      (b.vol - a.vol) || (Math.abs(a.over_prob - 0.5) - Math.abs(b.over_prob - 0.5)));
    const t = totalCandidates[0];
    result.total = { over_prob: t.over_prob, under_prob: t.under_prob, line: t.line };
  }

  return result;
}

// `started` freezes the probability snapshot once a game tips off. Live markets
// race toward 100/0 as the game plays out, which is misleading on a "pre-game odds"
// popup — so once the game is live/final we keep the last pre-game markets_json and
// only let volume_usd flow (the Top Games ranking is built on it). The 5-min
// pre-game sync guarantees a fresh snapshot within ~5 min of tip. On a brand-new
// row (game first seen after it started) we still seed markets_json so it isn't blank.
function storeMarkets(espn_game_id, markets, volume, started = false) {
  const marketsJson = JSON.stringify(markets);
  if (started) {
    db.prepare(`
      INSERT INTO polymarket_cache (espn_game_id, markets_json, morning_markets_json, volume_usd, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(espn_game_id) DO UPDATE SET
        volume_usd = excluded.volume_usd,
        updated_at = excluded.updated_at
    `).run(espn_game_id, marketsJson, marketsJson, volume);
    return;
  }
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

// ESPN game's ET calendar date (YYYY-MM-DD). start_time is UTC; the daily slate is
// keyed on the ET date, so shift by the (DST-aware) ET offset before slicing.
function _gameEtDate(startTime) {
  if (!startTime) return null;
  const t = new Date(startTime).getTime();
  if (isNaN(t)) return null;
  return new Date(t - ET_OFFSET_MS).toISOString().slice(0, 10);
}

// A Polymarket event's game date (ET). Prefer a market's gameStartTime (a precise
// UTC instant); fall back to the YYYY-MM-DD embedded in the event slug
// (e.g. mlb-nyy-bos-2026-06-25). Returns null when neither is available.
function _eventEtDate(ev) {
  for (const m of (ev.markets || [])) {
    if (!m.gameStartTime) continue;
    // "2026-06-25 23:10:00+00" → ISO: normalize the space and a bare +00 offset.
    const s = String(m.gameStartTime).trim().replace(' ', 'T').replace(/\+00(:?00)?$/, 'Z');
    const t = new Date(s).getTime();
    if (!isNaN(t)) return new Date(t - ET_OFFSET_MS).toISOString().slice(0, 10);
  }
  const sm = (ev.slug || '').match(/(\d{4}-\d{2}-\d{2})/);
  return sm ? sm[1] : null;
}

// Match a Polymarket event to one of our ESPN games by team names AND date.
// Polymarket leaves finished events active=true, so a same-teams series (e.g. a
// 3-game MLB set) returns several live events at once — matching on names alone
// locked onto a stale, days-old event whose prices never move (the reported
// "Yankees 49%/line +104, not updating" bug). Disambiguate by game date; fail
// open to the name match only when no date is available on either side.
function matchGameToEvent(ev, games) {
  const title = (ev.title || ev.question || '').toLowerCase();
  const nameMatches = games.filter(g => {
    const homeNick = (g.home_team || '').split(' ').pop().toLowerCase();
    const awayNick = (g.away_team || '').split(' ').pop().toLowerCase();
    return homeNick && awayNick && title.includes(homeNick) && title.includes(awayNick);
  });
  if (!nameMatches.length) return null;

  const evDate = _eventEtDate(ev);
  if (evDate) {
    const dated = nameMatches.find(g => _gameEtDate(g.start_time) === evDate);
    if (dated) return dated;
    // Event is dated to a different day than any candidate game → it's another
    // game in the series (or a dead event Polymarket never closed). Skip it
    // rather than overwrite today's odds with stale ones.
    if (nameMatches.some(g => _gameEtDate(g.start_time))) return null;
  }
  return nameMatches[0];
}

function getPolymarketForGame(espn_game_id) {
  return db.prepare(`SELECT * FROM polymarket_cache WHERE espn_game_id = ?`).get(espn_game_id) || null;
}

module.exports = { syncPolymarketData, syncPolymarketSoon, getPolymarketForGame };
