// src/odds_api.js
// Fetches odds from The Odds API and writes them into today_games.
// Called at 6am (all pre-game sports) and 4pm (pre-game only — skips started games).
// Only updates games with status = 'pre'. Never touches in-progress or finished games.

const axios = require('axios');
const db    = require('./db');
const { storeBookLines } = require('./lines_scraper');

const API_KEY  = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4/sports';

// Map ESPN sport labels → Odds API sport keys
const SPORT_KEY_MAP = {
  MLB:   'baseball_mlb',
  NBA:   'basketball_nba',
  NHL:   'icehockey_nhl',
  NFL:   'americanfootball_nfl',
  NCAAF: 'americanfootball_ncaaf',
  CBB:   'basketball_ncaab',
  WCBB:  null, // not available on Odds API
  ATP:   'tennis_atp',
  WTA:   'tennis_wta',
};

// ── Fetch odds for one sport from The Odds API ────────────────────────────────
async function fetchOddsForSport(sportKey) {
  if (!API_KEY) {
    console.warn('[odds_api] ODDS_API_KEY not set');
    return [];
  }

  try {
    const res = await axios.get(`${BASE_URL}/${sportKey}/odds`, {
      params: {
        apiKey:    API_KEY,
        regions:   'us',
        markets:   'h2h,spreads,totals',
        oddsFormat: 'american',
      },
      timeout: 15000,
    });

    const remaining = res.headers['x-requests-remaining'];
    console.log(`[odds_api] ${sportKey}: ${res.data.length} games fetched (${remaining} credits remaining)`);
    return res.data || [];
  } catch (err) {
    console.warn(`[odds_api] fetchOddsForSport(${sportKey}):`, err.message);
    return [];
  }
}

// ── Match an Odds API game to a today_games row ───────────────────────────────
// Odds API gives us home_team/away_team as full display names.
// We match against today_games using the same fuzzy logic as the scanner.
function findTodayGame(oddsGame) {
  // Odds API home/away can be opposite of ESPN — match by finding both teams anywhere
  const t1 = (oddsGame.home_team || '').toLowerCase();
  const t2 = (oddsGame.away_team || '').toLowerCase();

  // Extract last word (nickname) for fuzzy matching: "Minnesota Twins" → "twins"
  const n1 = t1.split(' ').pop();
  const n2 = t2.split(' ').pop();

  return db.prepare(`
    SELECT * FROM today_games
    WHERE status = 'pre'
      AND (
        LOWER(home_team) LIKE '%' || ? || '%' OR LOWER(away_team) LIKE '%' || ? || '%'
        OR LOWER(home_team) LIKE '%' || ? || '%' OR LOWER(away_team) LIKE '%' || ? || '%'
      )
      AND (
        LOWER(home_team) LIKE '%' || ? || '%' OR LOWER(away_team) LIKE '%' || ? || '%'
        OR LOWER(home_team) LIKE '%' || ? || '%' OR LOWER(away_team) LIKE '%' || ? || '%'
      )
    LIMIT 1
  `).get(n1, n1, t1, t1, n2, n2, t2, t2);
}

// ── Extract best available line from Odds API bookmakers ─────────────────────
function extractLines(oddsGame) {
  // Prefer DraftKings, then FanDuel, then first available
  const priority = ['draftkings', 'fanduel', 'betmgm', 'williamhill_us'];
  const books = oddsGame.bookmakers || [];

  let book = null;
  for (const key of priority) {
    book = books.find(b => b.key === key);
    if (book) break;
  }
  if (!book) book = books[0];
  if (!book) return null;

  const result = { ml_home: null, ml_away: null, spread_home: null, spread_away: null, over_under: null, ou_over_odds: null, ou_under_odds: null };

  for (const market of book.markets || []) {
    if (market.key === 'h2h') {
      for (const outcome of market.outcomes || []) {
        if (outcome.name === oddsGame.home_team) result.ml_home = outcome.price;
        else result.ml_away = outcome.price;
      }
    }
    if (market.key === 'spreads') {
      for (const outcome of market.outcomes || []) {
        if (outcome.name === oddsGame.home_team) result.spread_home = outcome.point;
        else result.spread_away = outcome.point;
      }
    }
    if (market.key === 'totals') {
      const over  = market.outcomes?.find(o => o.name === 'Over');
      const under = market.outcomes?.find(o => o.name === 'Under');
      if (over)  { result.over_under = over.point; result.ou_over_odds = over.price ?? null; }
      if (under) { result.ou_under_odds = under.price ?? null; }
    }
  }

  return result;
}

// ── Write odds into today_games for a single game ────────────────────────────
function applyOddsToGame(game, lines, oddsGame) {
  // Odds API home_team may differ from ESPN home_team — align by nickname match
  const oddsHomeNick = (oddsGame.home_team || '').split(' ').pop().toLowerCase();
  const espnHomeNick = (game.home_team || '').split(' ').pop().toLowerCase();
  const oddsMatchesEspn = oddsHomeNick === espnHomeNick;

  // If Odds API home ≠ ESPN home, swap ML and spread values.
  // Odds API gives each team their own signed spread (home: -1.5, away: +1.5) —
  // straight swap only, never negate (negating would corrupt both values).
  const ml_home     = oddsMatchesEspn ? lines.ml_home     : lines.ml_away;
  const ml_away     = oddsMatchesEspn ? lines.ml_away     : lines.ml_home;
  const spread_home = oddsMatchesEspn ? lines.spread_home : lines.spread_away;
  const spread_away = oddsMatchesEspn ? lines.spread_away : lines.spread_home;

  db.prepare(`
    UPDATE today_games
    SET ml_home         = ?,
        ml_away         = ?,
        spread_home     = ?,
        spread_away     = ?,
        over_under      = ?,
        ou_over_odds    = ?,
        ou_under_odds   = ?,
        odds_updated_at = datetime('now')
    WHERE espn_game_id = ? AND status = 'pre'
  `).run(ml_home, ml_away, spread_home, spread_away, lines.over_under, lines.ou_over_odds, lines.ou_under_odds, game.espn_game_id);
}

// ── Main: fetch all odds for sports currently in today_games ──────────────────
// Only processes games with status = 'pre'.
// Sports are determined by what ESPN already loaded — no hardcoded list.
async function refreshOdds() {
  if (!API_KEY) {
    console.warn('[odds_api] Skipping — ODDS_API_KEY not set');
    return 0;
  }

  // Get distinct sports from today_games that have pre-game games remaining
  const activeSports = db.prepare(
    `SELECT DISTINCT sport FROM today_games WHERE status = 'pre'`
  ).all().map(r => r.sport);

  if (!activeSports.length) {
    console.log('[odds_api] No pre-game sports in today_games — skipping');
    return 0;
  }

  console.log(`[odds_api] Refreshing odds for: ${activeSports.join(', ')}`);

  let updated = 0;

  for (const sport of activeSports) {
    const sportKey = SPORT_KEY_MAP[sport];
    if (!sportKey) {
      console.log(`[odds_api] No Odds API key for sport ${sport} — skipping`);
      continue;
    }

    const games = await fetchOddsForSport(sportKey);

    for (const oddsGame of games) {
      const todayGame = findTodayGame(oddsGame);
      if (!todayGame) continue;

      const lines = extractLines(oddsGame);
      if (!lines) continue;

      applyOddsToGame(todayGame, lines, oddsGame);
      storeBookLines(todayGame.espn_game_id, oddsGame, todayGame.home_team);
      updated++;
    }
  }

  console.log(`[odds_api] refreshOdds complete: ${updated} games updated`);
  return updated;
}

module.exports = { refreshOdds };
