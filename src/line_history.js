// src/line_history.js
// Fetches opening line data from ESPN's sports.core API (odds endpoint).
// The /odds endpoint returns both open and current values per provider.
// The opening row locks on first write and carries captured_at — the earliest
// moment we saw odds for the game. Forward games (today+2d) are synced too, so
// the open is usually captured a day or more before game day; rows survive the
// daily reset (per-game prune in wipe.js) so that early capture is never lost.
// Free, no auth, no rate limit. Called every 15 min + every 5 min for soon games.

const db = require('./db');

// ESPN sport → path for sports.core.api.espn.com
const ESPN_PATH = {
  NBA:   { sport: 'basketball',       league: 'nba' },
  WNBA:  { sport: 'basketball',       league: 'wnba' },
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

    // Opening values (from the 'open' sub-objects). The open total lives at
    // item.open.total (openOverUnder is never populated); fall back to current
    // like the other fields — first capture is the earliest we can know.
    const openSpreadH = parseAmerican(home?.open?.pointSpread?.american) ?? curSpreadH;
    const openMlH     = parseAmerican(home?.open?.moneyLine?.american)    ?? curMlH;
    const openMlA     = parseAmerican(away?.open?.moneyLine?.american)    ?? curMlA;
    const openOU      = parseAmerican(item.open?.total?.american) ?? item.openOverUnder ?? curOU;

    const now = new Date().toISOString();

    // Store opening snapshot with INSERT OR IGNORE (locked on first write, kept
    // for the game's lifetime). Skip when ESPN has no values yet — an all-null
    // row would lock and block the real open from ever landing.
    const hasOpen = openSpreadH != null || openMlH != null || openMlA != null || openOU != null;
    if (hasOpen) {
      const ins = db.prepare(`
        INSERT OR IGNORE INTO line_history
          (espn_game_id, book, recorded_at, spread_home, ml_home, ml_away, over_under, captured_at)
        VALUES (?, 'espn_dk', 'opening', ?, ?, ?, ?, ?)
      `).run(game.espn_game_id, openSpreadH, openMlH, openMlA, openOU, now);
      if (!ins.changes) {
        // Row already locked — fill only fields that were null at first capture
        // (ESPN's open values are retroactive facts). Never overwrite a value.
        db.prepare(`
          UPDATE line_history SET
            spread_home = COALESCE(spread_home, ?),
            ml_home     = COALESCE(ml_home, ?),
            ml_away     = COALESCE(ml_away, ?),
            over_under  = COALESCE(over_under, ?)
          WHERE espn_game_id = ? AND book = 'espn_dk' AND recorded_at = 'opening'
        `).run(openSpreadH, openMlH, openMlA, openOU, game.espn_game_id);
      }
    }

    // Store current snapshot — update existing (we always want the latest)
    db.prepare(`
      INSERT INTO line_history
        (espn_game_id, book, recorded_at, spread_home, ml_home, ml_away, over_under, captured_at)
      VALUES (?, 'espn_dk', 'current', ?, ?, ?, ?, ?)
      ON CONFLICT(espn_game_id, book, recorded_at) DO UPDATE SET
        spread_home = excluded.spread_home,
        ml_home     = excluded.ml_home,
        ml_away     = excluded.ml_away,
        over_under  = excluded.over_under,
        captured_at = excluded.captured_at
    `).run(game.espn_game_id, curSpreadH, curMlH, curMlA, curOU, now);

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
