// src/lines.js
// Handles pick slot seeding and line display.
// Odds now come from today_games (populated by odds_api.js).
// line_snapshots / live_lines are kept for backward compat but no longer the source of truth.

const db             = require('./db');
const { getCycleDate } = require('./cycle');

// ── Seed empty pick slots for every game that has odds in today_games ──────────
async function seedPickSlots() {
  const games = db.prepare(`SELECT * FROM today_games`).all();
  const gameDate = getCycleDate();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO picks
      (team, pick_type, spread, original_ml, original_ou, sport, game_date,
       espn_game_id, is_home_team, mention_count, score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `);

  // Also keep line_snapshots in sync so storage.js fallback still works
  const upsertSnapshot = db.prepare(`
    INSERT INTO line_snapshots (game_id, team, original_ml, original_spread, original_ou)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(game_id, team) DO UPDATE SET
      original_ml     = excluded.original_ml,
      original_spread = excluded.original_spread,
      original_ou     = excluded.original_ou
  `);

  let seeded = 0;

  for (const game of games) {
    const ml_home     = game.ml_home     ?? null;
    const ml_away     = game.ml_away     ?? null;
    const spread_home = game.spread_home ?? null;
    const spread_away = game.spread_away ?? null;
    const ou          = game.over_under  ?? null;

    // Sync line_snapshots
    upsertSnapshot.run(game.espn_game_id, game.home_team, ml_home, spread_home, ou);
    upsertSnapshot.run(game.espn_game_id, game.away_team, ml_away, spread_away, ou);

    const slots = [
      [game.home_team, 'ML',     ml_home,     ml_home, null, game.sport, gameDate, game.espn_game_id, 1],
      [game.away_team, 'ML',     ml_away,     ml_away, null, game.sport, gameDate, game.espn_game_id, 0],
      [game.home_team, 'spread', spread_home, null,    null, game.sport, gameDate, game.espn_game_id, 1],
      [game.away_team, 'spread', spread_away, null,    null, game.sport, gameDate, game.espn_game_id, 0],
      // Over/under anchored to home team, is_home_team=0 — no home bonus for totals
      [game.home_team, 'over',   ou,          null,    ou,   game.sport, gameDate, game.espn_game_id, 0],
      [game.home_team, 'under',  ou,          null,    ou,   game.sport, gameDate, game.espn_game_id, 0],
    ];

    for (const slot of slots) {
      // Update spread on existing slots if odds just arrived (slot may have been seeded without odds)
      const existing = db.prepare(
        `SELECT id FROM picks WHERE espn_game_id=? AND LOWER(team)=LOWER(?) AND pick_type=?`
      ).get(game.espn_game_id, slot[0], slot[1]);

      if (existing) {
        db.prepare(`UPDATE picks SET spread=?, original_ml=?, original_ou=? WHERE id=?`)
          .run(slot[2], slot[3], slot[4], existing.id);
      } else {
        const result = insert.run(...slot);
        if (result.changes > 0) seeded++;
      }
    }
  }

  // Safety: over/under slots must never have home bonus
  db.prepare(`UPDATE picks SET is_home_team=0 WHERE pick_type IN ('over','under')`).run();

  console.log(`[lines] seedPickSlots: ${seeded} new slots, ${games.length} games`);
  return seeded;
}

// ── Lock morning lines: 6am cron only — fetches fresh odds then seeds ────────
async function lockMorningLines() {
  const { refreshOdds } = require('./odds_api');
  await refreshOdds();
  await seedPickSlots();
  console.log('[lines] lockMorningLines complete');
}

// ── Reseed only: use existing today_games odds, no Odds API call ──────────────
// Used by nuke, admin reseed, and restart — never burns credits.
async function reseedFromExisting() {
  return seedPickSlots();
}

// ── Get lines for a specific team (used by /api/lines/:team) ─────────────────
function getLines(team) {
  const game = db.prepare(`
    SELECT * FROM today_games
    WHERE LOWER(home_team) = LOWER(?) OR LOWER(away_team) = LOWER(?)
    LIMIT 1
  `).get(team, team);

  if (!game) return null;

  const isHome = (game.home_team || '').toLowerCase() === (team || '').toLowerCase();

  return {
    ml:     isHome ? game.ml_home     : game.ml_away,
    spread: isHome ? game.spread_home : game.spread_away,
    ou:     game.over_under,
    updated_at: game.odds_updated_at,
  };
}

module.exports = { lockMorningLines, getLines, seedPickSlots, reseedFromExisting };
