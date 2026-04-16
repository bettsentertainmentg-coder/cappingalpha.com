// src/lines_scraper.js
// Stores DraftKings + FanDuel lines per game in the book_lines table.
// Called from odds_api.js inside its existing per-game loop — zero extra API credits.

const db = require('./db');

// ── Extract lines for a specific book from an Odds API game object ────────────
function extractBookLines(oddsGame, bookKey) {
  const book = (oddsGame.bookmakers || []).find(b => b.key === bookKey);
  if (!book) return null;

  const result = {
    ml_home:       null,
    ml_away:       null,
    spread_home:   null,
    spread_away:   null,
    over_under:    null,
    ou_over_odds:  null,
    ou_under_odds: null,
  };

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

// ── Align Odds API lines to ESPN home/away orientation ────────────────────────
// Odds API home_team may differ from ESPN home_team — swap if needed.
function alignLines(lines, oddsGame, espnHomeTeam) {
  const oddsHomeNick = (oddsGame.home_team || '').split(' ').pop().toLowerCase();
  const espnHomeNick = (espnHomeTeam || '').split(' ').pop().toLowerCase();
  if (oddsHomeNick === espnHomeNick) return lines;

  // Swap home/away for ML and spread.
  // Each team already has their own signed spread — straight swap, never negate.
  return {
    ...lines,
    ml_home:     lines.ml_away,
    ml_away:     lines.ml_home,
    spread_home: lines.spread_away,
    spread_away: lines.spread_home,
  };
}

// ── Store DK + FD lines for a game — called from odds_api.js ─────────────────
function storeBookLines(espn_game_id, oddsGame, espnHomeTeam) {
  for (const bookKey of ['draftkings', 'fanduel']) {
    const raw = extractBookLines(oddsGame, bookKey);
    if (!raw) continue;
    const lines = alignLines(raw, oddsGame, espnHomeTeam);

    db.prepare(`
      INSERT INTO book_lines
        (espn_game_id, book, ml_home, ml_away, spread_home, spread_away,
         over_under, ou_over_odds, ou_under_odds, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(espn_game_id, book) DO UPDATE SET
        ml_home       = excluded.ml_home,
        ml_away       = excluded.ml_away,
        spread_home   = excluded.spread_home,
        spread_away   = excluded.spread_away,
        over_under    = excluded.over_under,
        ou_over_odds  = excluded.ou_over_odds,
        ou_under_odds = excluded.ou_under_odds,
        updated_at    = datetime('now')
    `).run(
      espn_game_id, bookKey,
      lines.ml_home, lines.ml_away,
      lines.spread_home, lines.spread_away,
      lines.over_under, lines.ou_over_odds, lines.ou_under_odds
    );
  }
}

// ── Read lines for the game detail popup ─────────────────────────────────────
function getLinesForGame(espn_game_id) {
  const rows = db.prepare(
    `SELECT * FROM book_lines WHERE espn_game_id = ?`
  ).all(espn_game_id);

  const result = { draftkings: null, fanduel: null };
  for (const row of rows) {
    if (row.book === 'draftkings' || row.book === 'fanduel') {
      result[row.book] = {
        ml_home:       row.ml_home,
        ml_away:       row.ml_away,
        spread_home:   row.spread_home,
        spread_away:   row.spread_away,
        over_under:    row.over_under,
        ou_over_odds:  row.ou_over_odds,
        ou_under_odds: row.ou_under_odds,
      };
    }
  }
  return result;
}

module.exports = { storeBookLines, getLinesForGame };
