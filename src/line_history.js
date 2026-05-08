// src/line_history.js
// Fetches opening line data from ESPN's sports.core API (odds endpoint).
// The /odds endpoint returns both open and current values per provider.
// We store the opening values with INSERT OR IGNORE so they lock on first write.
// Free, no auth, no rate limit. Called every 15 min + every 5 min for soon games.

const db = require('./db');

// ESPN sport → path for sports.core.api.espn.com
const ESPN_PATH = {
  NBA:   { sport: 'basketball',       league: 'nba' },
  MLB:   { sport: 'baseball',         league: 'mlb' },
  NHL:   { sport: 'hockey',           league: 'nhl' },
  NFL:   { sport: 'americanfootball', league: 'nfl' },
  CBB:   { sport: 'basketball',       league: 'mens-college-basketball' },
  NCAAF: { sport: 'americanfootball', league: 'college-football' },
};

async function syncLineHistory(games) {
  const preGames = games.filter(g => g.status === 'pre' && ESPN_PATH[g.sport]);
  for (const game of preGames) {
    await fetchAndStore(game);
  }
}

// Only games within 60 min of tip (for the 5-min cron)
async function syncLineHistorySoon(games) {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  const soonGames = games.filter(g => {
    if (g.status !== 'pre' || !ESPN_PATH[g.sport]) return false;
    if (!g.start_time) return false;
    return (new Date(g.start_time).getTime() - now) >= 0 &&
           (new Date(g.start_time).getTime() - now) <= ONE_HOUR;
  });
  for (const game of soonGames) {
    await fetchAndStore(game);
  }
}

function parseAmerican(val) {
  if (val == null) return null;
  const n = parseFloat(String(val).replace(/[^0-9.+-]/g, ''));
  return isNaN(n) ? null : n;
}

async function fetchAndStore(game) {
  const path = ESPN_PATH[game.sport];
  if (!path) return;
  try {
    const url = `https://sports.core.api.espn.com/v2/sports/${path.sport}/leagues/${path.league}/events/${game.espn_game_id}/competitions/${game.espn_game_id}/odds`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const data = await r.json();
    const item = Array.isArray(data.items) ? data.items[0] : null;
    if (!item) return;

    const home = item.homeTeamOdds;
    const away = item.awayTeamOdds;

    // Current values (what ESPN has right now)
    const curSpreadH = item.spread != null ? item.spread : null;
    const curMlH     = home?.moneyLine ?? null;
    const curMlA     = away?.moneyLine ?? null;
    const curOU      = item.overUnder  ?? null;

    // Opening values (from the 'open' sub-object)
    const openSpreadH = parseAmerican(home?.open?.pointSpread?.american) ?? curSpreadH;
    const openMlH     = parseAmerican(home?.open?.moneyLine?.american)    ?? curMlH;
    const openMlA     = parseAmerican(away?.open?.moneyLine?.american)    ?? curMlA;
    const openOU      = item.openOverUnder ?? null; // may not exist

    // Store opening snapshot with INSERT OR IGNORE (locked after first write per day)
    db.prepare(`
      INSERT OR IGNORE INTO line_history
        (espn_game_id, book, recorded_at, spread_home, ml_home, ml_away, over_under)
      VALUES (?, 'espn_dk', 'opening', ?, ?, ?, ?)
    `).run(game.espn_game_id, openSpreadH, openMlH, openMlA, openOU);

    // Store current snapshot — update existing (we always want the latest)
    db.prepare(`
      INSERT INTO line_history
        (espn_game_id, book, recorded_at, spread_home, ml_home, ml_away, over_under)
      VALUES (?, 'espn_dk', 'current', ?, ?, ?, ?)
      ON CONFLICT(espn_game_id, book, recorded_at) DO UPDATE SET
        spread_home = excluded.spread_home,
        ml_home     = excluded.ml_home,
        ml_away     = excluded.ml_away,
        over_under  = excluded.over_under
    `).run(game.espn_game_id, curSpreadH, curMlH, curMlA, curOU);

  } catch (_) {
    // Silently ignore — endpoint may not have data for all sports
  }
}

// Returns { opening, current } or null if no data
function getLineHistoryForGame(espn_game_id) {
  const opening = db.prepare(`
    SELECT * FROM line_history WHERE espn_game_id = ? AND recorded_at = 'opening'
  `).get(espn_game_id);
  const current = db.prepare(`
    SELECT * FROM line_history WHERE espn_game_id = ? AND recorded_at = 'current'
  `).get(espn_game_id);
  if (!opening && !current) return null;
  return { opening, current };
}

module.exports = { syncLineHistory, syncLineHistorySoon, getLineHistoryForGame };
