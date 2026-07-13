// src/closing_lines.js — the closing-line archive.
//
// book_lines rows are already frozen at each game's start by the lines-lock
// rule, so by day's end they ARE the closing lines. This module snapshots them
// (joined with the game context that the daily prune will delete) into
// book_lines_closing, the permanent archive. Runs at the 4:58am reset, before
// pruneStaleGames removes finished games. Idempotent: UNIQUE(espn_game_id,
// book) + INSERT OR REPLACE, so a crash-rerun just refreshes the same rows.
//
// This is a product surface: the paid odds APIs charge extra for historical
// closes (The Odds API bills 10x credits). Ours accumulates for free.

const db = require('./db');

function snapshotClosingLines() {
  let stored = 0;
  try {
    const run = db.transaction(() => {
      stored = db.prepare(`
        INSERT OR REPLACE INTO book_lines_closing
          (game_date, espn_game_id, sport, matchup, start_time, book,
           ml_home, ml_away, spread_home, spread_away,
           over_under, ou_over_odds, ou_under_odds, snapped_at)
        SELECT
          COALESCE(substr(tg.start_time, 1, 10), date('now')),
          bl.espn_game_id, tg.sport,
          COALESCE(tg.away_abbr, tg.away_team) || ' @ ' || COALESCE(tg.home_abbr, tg.home_team),
          tg.start_time, bl.book,
          bl.ml_home, bl.ml_away, bl.spread_home, bl.spread_away,
          bl.over_under, bl.ou_over_odds, bl.ou_under_odds, datetime('now')
        FROM book_lines bl
        JOIN today_games tg USING (espn_game_id)
        WHERE tg.start_time IS NOT NULL
          AND datetime(replace(substr(tg.start_time, 1, 19), 'T', ' ')) <= datetime('now')
      `).run().changes;
    });
    run();
    if (stored) console.log(`[closing] archived ${stored} closing line rows`);
  } catch (err) {
    console.error('[closing] snapshot failed:', err.message);
  }
  return stored;
}

// Query helper for the admin endpoint: closes for a date (optionally one
// sport / one book), newest games first.
function getClosingLines({ date, sport, book } = {}) {
  const where = ['game_date = ?'];
  const args = [date || new Date().toISOString().slice(0, 10)];
  if (sport) { where.push('UPPER(sport) = UPPER(?)'); args.push(String(sport).slice(0, 12)); }
  if (book)  { where.push('book = ?'); args.push(String(book).toLowerCase().slice(0, 24)); }
  try {
    return db.prepare(`
      SELECT game_date, espn_game_id, sport, matchup, start_time, book,
             ml_home, ml_away, spread_home, spread_away,
             over_under, ou_over_odds, ou_under_odds, snapped_at
      FROM book_lines_closing
      WHERE ${where.join(' AND ')}
      ORDER BY start_time, espn_game_id, book
    `).all(...args);
  } catch (_) { return []; }
}

module.exports = { snapshotClosingLines, getClosingLines };
