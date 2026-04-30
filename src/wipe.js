// src/wipe.js
// 4:58am daily reset — clears stale data so the 5am setup can start fresh.

const db = require('./db');

const WIPE_TABLES = [
  'score_breakdown',   // FK → picks, must go first
  'raw_messages',      // FK → picks, must go first
  'picks',
  'today_games',
  'live_games',
  'scanner_state',
  'skipped_messages',  // cycle-scoped — 5am first scan re-fetches from 12:30am anyway
  'line_snapshots',
  'live_lines',
];

// Archive threshold — same as MVP_THRESHOLD minimum
const ARCHIVE_MIN_SCORE = 35;

// ── Archive all picks ≥35 pts to pick_history BEFORE the wipe destroys them ──
// Uses INSERT OR IGNORE so re-runs (e.g. restart crash after archive but before
// wipe completes) are safe — existing records are never overwritten.
function archivePickHistory() {
  const picks = db.prepare(`
    SELECT p.id, p.espn_game_id, p.sport, p.game_date,
           p.team, p.pick_type, p.spread, p.original_ml, p.original_ou,
           p.is_home_team, p.score, p.mention_count, p.channel,
           p.result, p.capper_name, p.parsed_at,
           tg.home_team, tg.away_team, tg.home_abbr, tg.away_abbr,
           tg.home_score, tg.away_score,
           sb.channel_points, sb.sport_bonus, sb.home_bonus
    FROM picks p
    LEFT JOIN today_games    tg ON tg.espn_game_id = p.espn_game_id
    LEFT JOIN score_breakdown sb ON sb.pick_id      = p.id
    WHERE p.score >= ?
  `).all(ARCHIVE_MIN_SCORE);

  if (!picks.length) {
    console.log('[archive] No picks meet the threshold — nothing to archive');
    return 0;
  }

  const getMsgs = db.prepare(`
    SELECT author, channel, message_text
    FROM raw_messages WHERE pick_id = ? ORDER BY id ASC
  `);

  const upsert = db.prepare(`
    INSERT OR IGNORE INTO pick_history
      (pick_id, espn_game_id, sport, game_date,
       home_team, away_team, home_abbr, away_abbr,
       team, pick_type, spread, ml_odds, ou_odds, is_home_team,
       score, mention_count, channel, channel_points, sport_bonus, home_bonus,
       capper_name, messages_json, result, home_score, away_score, first_seen_at)
    VALUES
      (?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?)
  `);

  const archiveAll = db.transaction((rows) => {
    let count = 0;
    for (const p of rows) {
      const msgs = getMsgs.all(p.id);
      const { changes } = upsert.run(
        p.id,           p.espn_game_id ?? null, p.sport ?? null, p.game_date ?? null,
        p.home_team ?? null, p.away_team ?? null, p.home_abbr ?? null, p.away_abbr ?? null,
        p.team,         p.pick_type ?? null, p.spread ?? null, p.original_ml ?? null,
        p.original_ou ?? null, p.is_home_team ?? 0,
        p.score,        p.mention_count ?? 1, p.channel ?? null,
        p.channel_points ?? null, p.sport_bonus ?? null, p.home_bonus ?? null,
        p.capper_name ?? null, JSON.stringify(msgs),
        p.result ?? 'pending', p.home_score ?? null, p.away_score ?? null, p.parsed_at ?? null
      );
      count += changes;
    }
    return count;
  });

  const archived = archiveAll(picks);
  console.log(`[archive] ${archived} new picks archived to pick_history (${picks.length} eligible)`);
  return archived;
}

async function runDailyWipe() {
  console.log('[wipe] Starting daily wipe...');

  // Archive BEFORE wiping so pick data + raw_messages are still accessible
  archivePickHistory();

  for (const table of WIPE_TABLES) {
    const { changes } = db.prepare(`DELETE FROM ${table}`).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
    console.log(`[wipe] ${table}: ${changes} rows deleted`);
  }

  console.log('[wipe] Daily wipe complete');
}

module.exports = { runDailyWipe, archivePickHistory };
