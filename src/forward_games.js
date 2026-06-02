// src/forward_games.js
// Fetches the next N days of game schedule from ESPN and upserts them into
// today_games, so picks posted overnight for a future game can match a real
// espn_game_id immediately (instead of being stored with no game and wiped).
//
// ESPN scoreboard-by-date only — FREE. Never calls the Odds API. Forward games
// arrive with whatever embedded ESPN/DK odds exist (often null); their lines get
// locked at their own 5am via the COALESCE-on-first-write path in upsertTodayGame.
// Slots seed automatically once the rows exist (src/lines.js seedPickSlots).
//
// Template: mirrors espn_live.fetchTodaysGames() but loops dates +1..+N.

const { getCycleDate, addDays } = require('./cycle');
const { fetchScoreboardForDate, upsertTodayGame, TODAY_SPORTS } = require('./espn_live');

// Fetch today+1 .. today+daysAhead for all team sports, upsert into today_games.
async function fetchForwardGames(daysAhead = 2) {
  const base = getCycleDate();
  let total = 0;

  for (let d = 1; d <= daysAhead; d++) {
    const dateStr = addDays(base, d).replace(/-/g, ''); // YYYYMMDD for ESPN param
    await Promise.all(TODAY_SPORTS.map(async ({ path, label }) => {
      try {
        const events = await fetchScoreboardForDate(path, dateStr);
        for (const ev of events) upsertTodayGame(ev, label);
        if (events.length > 0) {
          total += events.length;
          console.log(`[forward] today_games: ${events.length} ${label} games (+${d}d ${dateStr})`);
        }
      } catch (err) {
        console.warn(`[forward] fetchForwardGames(${label} +${d}d) error:`, err.message);
      }
    }));
  }

  console.log(`[forward] fetchForwardGames complete: ${total} games (next ${daysAhead}d)`);
  return total;
}

module.exports = { fetchForwardGames };
