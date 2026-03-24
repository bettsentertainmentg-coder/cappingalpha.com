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
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_msg_message_id ON raw_messages (message_id) WHERE message_id IS NOT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN game_verified INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN espn_game_id TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN pending_review INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE bot_picks ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
// Clean duplicate raw_messages — keep earliest row per Discord message snowflake
try {
  db.exec(`
    DELETE FROM raw_messages
    WHERE message_id IS NOT NULL
      AND id NOT IN (SELECT MIN(id) FROM raw_messages WHERE message_id IS NOT NULL GROUP BY message_id)
  `);
} catch (_) {}

module.exports = db;
