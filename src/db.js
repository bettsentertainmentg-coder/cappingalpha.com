// src/db.js — Shared SQLite database for CappperBoss
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'capper.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS picks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    capper_name   TEXT,
    team          TEXT    NOT NULL,
    pick_type     TEXT,
    spread        REAL,
    sport         TEXT,
    sport_record  TEXT,
    game_date     TEXT,
    mention_count INTEGER NOT NULL DEFAULT 1,
    raw_message   TEXT,
    score         REAL    NOT NULL DEFAULT 0,
    channel       TEXT,
    channel_weight REAL   NOT NULL DEFAULT 1.0,
    parsed_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS personal_picks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    team       TEXT    NOT NULL,
    pick_type  TEXT,
    spread     REAL,
    sport      TEXT,
    game_date  TEXT,
    result     TEXT    NOT NULL DEFAULT 'pending',
    noted_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id      TEXT,
    alert_type   TEXT    NOT NULL,
    message      TEXT    NOT NULL,
    triggered_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS live_games (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    espn_game_id TEXT    NOT NULL UNIQUE,
    home_team    TEXT    NOT NULL,
    away_team    TEXT    NOT NULL,
    sport        TEXT    NOT NULL,
    home_score   INTEGER NOT NULL DEFAULT 0,
    away_score   INTEGER NOT NULL DEFAULT 0,
    spread       REAL,
    status       TEXT,
    last_polled  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS raw_messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_id           INTEGER NOT NULL,
    channel           TEXT    NOT NULL,
    message_text      TEXT    NOT NULL,
    author            TEXT,
    message_timestamp TEXT,
    saved_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (pick_id) REFERENCES picks(id)
  );

  CREATE TABLE IF NOT EXISTS scanner_state (
    channel_id      TEXT NOT NULL PRIMARY KEY,
    last_message_id TEXT,
    last_scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS today_games (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    espn_game_id  TEXT NOT NULL UNIQUE,
    sport         TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pre',
    period        INTEGER,
    clock         TEXT,
    start_time    TEXT,
    home_score    INTEGER NOT NULL DEFAULT 0,
    away_score    INTEGER NOT NULL DEFAULT 0,
    home_team     TEXT,
    home_short    TEXT,
    home_name     TEXT,
    home_abbr     TEXT,
    away_team     TEXT,
    away_short    TEXT,
    away_name     TEXT,
    away_abbr     TEXT,
    fetched_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_picks_date      ON picks (parsed_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_date     ON alerts (triggered_at);
  CREATE INDEX IF NOT EXISTS idx_personal_date   ON personal_picks (noted_at);
  CREATE INDEX IF NOT EXISTS idx_raw_msg_pick_id ON raw_messages (pick_id);

  CREATE TABLE IF NOT EXISTS bot_picks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_id      INTEGER,
    team         TEXT    NOT NULL,
    sport        TEXT,
    pick_type    TEXT,
    spread       REAL,
    game_date    TEXT,
    result       TEXT    NOT NULL DEFAULT 'pending',
    espn_game_id TEXT,
    added_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jack_picks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_id      INTEGER,
    team         TEXT    NOT NULL,
    sport        TEXT,
    pick_type    TEXT,
    spread       REAL,
    game_date    TEXT,
    result       TEXT    NOT NULL DEFAULT 'pending',
    espn_game_id TEXT,
    noted_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Migrations for existing databases ─────────────────────────────────────────
try { db.exec(`ALTER TABLE picks ADD COLUMN sport_record TEXT`); }       catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN capper_name TEXT`); }        catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN score_breakdown TEXT`); }           catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN free_plays_mentions INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN community_mentions  INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN pod_mentions        INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`DROP TABLE IF EXISTS cappers`); }                                       catch (_) {}
try { db.exec(`DROP INDEX IF EXISTS idx_picks_capper`); }                 catch (_) {}
try { db.exec(`ALTER TABLE raw_messages ADD COLUMN message_id TEXT`); }   catch (_) {}
try { db.exec(`DROP INDEX IF EXISTS idx_raw_msg_message_id`); } catch (_) {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_msg_pick_message ON raw_messages (pick_id, message_id) WHERE message_id IS NOT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN game_verified INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN espn_game_id TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN pending_review INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE bot_picks ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
// Clean duplicate raw_messages — keep earliest row per (pick_id, message_id) pair
try {
  db.exec(`
    DELETE FROM raw_messages
    WHERE message_id IS NOT NULL
      AND id NOT IN (SELECT MIN(id) FROM raw_messages WHERE message_id IS NOT NULL GROUP BY pick_id, message_id)
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mvp_picks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      team          TEXT    NOT NULL,
      sport         TEXT,
      pick_type     TEXT,
      spread        REAL,
      original_line TEXT,
      game_date     TEXT,
      score         REAL,
      result        TEXT    NOT NULL DEFAULT 'pending',
      saved_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS line_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id         TEXT    NOT NULL,
      team            TEXT    NOT NULL,
      original_ml     REAL,
      original_spread REAL,
      original_ou     REAL,
      locked_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(game_id, team)
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_lines (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id        TEXT    NOT NULL,
      current_ml     REAL,
      current_spread REAL,
      current_ou     REAL,
      fetched_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(game_id)
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      email                TEXT    NOT NULL UNIQUE,
      password_hash        TEXT    NOT NULL,
      subscription_tier    TEXT    NOT NULL DEFAULT 'free',
      subscription_expires TEXT,
      created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS score_breakdown (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      pick_id         INTEGER NOT NULL,
      channel_points  INTEGER NOT NULL DEFAULT 0,
      sport_bonus     INTEGER NOT NULL DEFAULT 0,
      home_bonus      INTEGER NOT NULL DEFAULT 0,
      total           INTEGER NOT NULL DEFAULT 0,
      breakdown_json  TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (pick_id) REFERENCES picks(id)
    )
  `);
} catch (_) {}

try { db.exec(`ALTER TABLE today_games ADD COLUMN first_inning_runs INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN ml_home        REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN ml_away        REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN spread_home    REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN spread_away    REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN over_under     REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN odds_updated_at TEXT`); } catch (_) {}

try { db.exec(`ALTER TABLE mvp_picks ADD COLUMN espn_game_id TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE mvp_picks ADD COLUMN home_score INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE mvp_picks ADD COLUMN away_score INTEGER`); } catch (_) {}
// Backfill scores for any existing resolved mvp_picks from today_games
try {
  db.exec(`
    UPDATE mvp_picks SET
      home_score = (SELECT tg.home_score FROM today_games tg WHERE tg.espn_game_id = mvp_picks.espn_game_id),
      away_score = (SELECT tg.away_score FROM today_games tg WHERE tg.espn_game_id = mvp_picks.espn_game_id)
    WHERE result != 'pending' AND espn_game_id IS NOT NULL AND home_score IS NULL
  `);
} catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN result TEXT NOT NULL DEFAULT 'pending'`); } catch (_) {}
try { db.exec(`ALTER TABLE mvp_picks ADD COLUMN ml_odds REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE mvp_picks ADD COLUMN annotation TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE mvp_picks ADD COLUMN ou_odds REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN ou_over_odds REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN ou_under_odds REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN original_ml REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN original_ou REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN is_home_team INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_picks_slot ON picks (espn_game_id, team, pick_type) WHERE espn_game_id IS NOT NULL`); } catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skipped_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT    NOT NULL UNIQUE,
      channel    TEXT    NOT NULL,
      author     TEXT,
      content    TEXT    NOT NULL,
      reason     TEXT,
      skipped_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id         INTEGER NOT NULL PRIMARY KEY,
      favorite_sports TEXT    NOT NULL DEFAULT '[]',
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_lines (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      espn_game_id    TEXT    NOT NULL,
      book            TEXT    NOT NULL,
      ml_home         REAL,
      ml_away         REAL,
      spread_home     REAL,
      spread_away     REAL,
      over_under      REAL,
      ou_over_odds    REAL,
      ou_under_odds   REAL,
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(espn_game_id, book)
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_votes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      espn_game_id TEXT    NOT NULL,
      pick_slot    TEXT    NOT NULL,
      voted_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, espn_game_id, pick_slot),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
} catch (_) {}

try { db.exec(`ALTER TABLE users ADD COLUMN username TEXT`); } catch (_) {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username) WHERE username IS NOT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT`); } catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_codes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      code         TEXT    NOT NULL UNIQUE,
      type         TEXT    NOT NULL,
      notes        TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      activated_by INTEGER,
      activated_at TEXT,
      expires_at   TEXT
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      model                 TEXT    NOT NULL,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd    REAL    NOT NULL DEFAULT 0,
      created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

// ── Golf tables (never wiped — tournaments last multiple days) ────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS golf_tournaments (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      espn_tournament_id   TEXT NOT NULL UNIQUE,
      name                 TEXT NOT NULL,
      course               TEXT,
      city                 TEXT,
      state                TEXT,
      start_date           TEXT,
      end_date             TEXT,
      status               TEXT NOT NULL DEFAULT 'pre',
      current_round        INTEGER DEFAULT 1,
      leaderboard_json     TEXT,
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS golf_picks (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      espn_tournament_id   TEXT NOT NULL,
      capper_name          TEXT,
      player_name          TEXT NOT NULL,
      vs_player            TEXT,
      pick_type            TEXT NOT NULL,
      spread_value         REAL,
      sport_record         TEXT,
      channel              TEXT,
      score                REAL NOT NULL DEFAULT 0,
      mention_count        INTEGER NOT NULL DEFAULT 1,
      score_breakdown      TEXT,
      result               TEXT NOT NULL DEFAULT 'pending',
      game_date            TEXT,
      parsed_at            TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_messages_golf (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      golf_pick_id      INTEGER NOT NULL,
      channel           TEXT,
      message_text      TEXT,
      author            TEXT,
      message_timestamp TEXT,
      message_id        TEXT,
      saved_at          TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (golf_pick_id) REFERENCES golf_picks(id)
    )
  `);
} catch (_) {}

try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_golf_pick_msg ON raw_messages_golf (golf_pick_id, message_id) WHERE message_id IS NOT NULL`); } catch (_) {}

// ── Capper aliases (fuzzy name normalization) ─────────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capper_aliases (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_name TEXT NOT NULL,
      alias          TEXT NOT NULL UNIQUE,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

try { db.exec(`CREATE INDEX IF NOT EXISTS idx_picks_capper     ON picks      (capper_name)`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_golf_picks_capper ON golf_picks (capper_name)`); } catch (_) {}

// ── User account migrations ───────────────────────────────────────────────────
try { db.exec(`ALTER TABLE users ADD COLUMN username_changed_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN tos_accepted_at TEXT`); } catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
} catch (_) {}

// ── Reader corrections — manual annotations that inject into Haiku prompt ─────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reader_corrections (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_text  TEXT NOT NULL,
      channel       TEXT,
      author        TEXT,
      source        TEXT NOT NULL DEFAULT 'skipped',
      correct_picks TEXT NOT NULL DEFAULT '[]',
      is_no_pick    INTEGER NOT NULL DEFAULT 0,
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

// ── Settings (key-value store for admin-configurable values) ──────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
} catch (_) {}

// ── Migration: restore picks voided by old same-game/opposing-team conflict resolver ──
// The old resolver grouped by (espn_game_id, pick_type) without team, so a Hornets
// spread and Magic spread on the same game would conflict. The new resolver adds team
// to the group. Reset the old mis-voids so results.js can re-evaluate them.
// Uses LIKE to handle any annotation string variant (em-dash encoding differences, etc.)
try {
  db.exec(`
    UPDATE mvp_picks
    SET result = 'pending', annotation = NULL
    WHERE result = 'void'
      AND annotation LIKE '%not counted%'
  `);
} catch (_) {}

function getSetting(key, defaultVal) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultVal;
  } catch (_) { return defaultVal; }
}

function setSetting(key, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  } catch (_) {}
}

module.exports = db;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
