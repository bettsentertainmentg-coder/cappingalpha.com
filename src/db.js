// src/db.js — Shared SQLite database for CappperBoss
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.CAPPER_DB || path.join(__dirname, '..', 'data', 'capper.db');
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
// CA official line lock (T-60): the line the CA rankings + tracking use is whatever
// the market shows 1 hour before start. lockCaLinesAtT60() (src/ca_line.js) snapshots
// it once and sets ca_line_locked=1 so no later odds refresh moves it.
try { db.exec(`ALTER TABLE today_games ADD COLUMN ca_line_locked INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN ca_line_at TEXT`); } catch (_) {}

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
try { db.exec(`ALTER TABLE mvp_picks ADD COLUMN home_team TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE mvp_picks ADD COLUMN away_team TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN ou_over_odds REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN ou_under_odds REAL`); } catch (_) {}
// Soccer 3-way moneyline: the draw leg's price (ESPN DK drawOdds). Display only —
// draw is never a pick slot; a drawn match grades ML picks as losses on both sides.
try { db.exec(`ALTER TABLE today_games ADD COLUMN ml_draw REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE book_lines  ADD COLUMN ml_draw REAL`); } catch (_) {}
// Live game-state for condensed in-game scoreboards (e.g. baseball bases/outs/
// half-inning). Populated by src/live_situation.js from ESPN's free scoreboard,
// cleared when a game is no longer live. live_detail = "Bot 5th"; live_bases is a
// bitmask (1=on first, 2=on second, 4=on third); live_outs = 0..2.
try { db.exec(`ALTER TABLE today_games ADD COLUMN live_detail TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN live_outs INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN live_bases INTEGER`); } catch (_) {}
// ESPN league path for sports whose scoreboard is per-competition (soccer:
// 'soccer/usa.1', 'soccer/fifa.world', ...). Stamped by soccer_espn.js so the
// live tracker + summary fetches know which competition scoreboard to hit.
try { db.exec(`ALTER TABLE today_games ADD COLUMN league_path TEXT`); } catch (_) {}
// First moment a game's status flipped to 'in' (live). Used to enforce the
// 5-minute-past-actual-start scoring cutoff. NULL until ESPN reports the game live.
try { db.exec(`ALTER TABLE today_games ADD COLUMN actual_start_at TEXT`); } catch (_) {}
// First moment a game's status flipped to 'post' (final). Used by the per-game
// prune to keep a finished game for a grace tail past its actual end. NULL until final.
try { db.exec(`ALTER TABLE today_games ADD COLUMN actual_end_at TEXT`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tg_status_end ON today_games (status, actual_end_at)`); } catch (_) {}
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

// Partial-game (period) book lines — F5 (MLB first 5 innings), 1H, etc. Kept in
// their own table because book_lines is UNIQUE(espn_game_id, book) and its read
// path assumes one full-game row per book. Fed by the CA Odds Engine relay
// (odds_ingest.storeEngineBookLines routes rows with a period). Not wiped, like
// book_lines. Spread juice columns included: F5 runlines are +-0.5 juice-heavy
// lines, so the money math needs the odds, not just the number.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_lines_period (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      espn_game_id      TEXT    NOT NULL,
      book              TEXT    NOT NULL,
      period            TEXT    NOT NULL,
      ml_home           REAL,
      ml_away           REAL,
      spread_home       REAL,
      spread_away       REAL,
      spread_home_odds  REAL,
      spread_away_odds  REAL,
      over_under        REAL,
      ou_over_odds      REAL,
      ou_under_odds     REAL,
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(espn_game_id, book, period)
    )
  `);
} catch (_) {}

// Snapshot columns for game_votes — survive daily wipe
try { db.exec(`ALTER TABLE game_votes ADD COLUMN home_team TEXT`);      } catch (_) {}
try { db.exec(`ALTER TABLE game_votes ADD COLUMN away_team TEXT`);      } catch (_) {}
try { db.exec(`ALTER TABLE game_votes ADD COLUMN sport TEXT`);          } catch (_) {}
try { db.exec(`ALTER TABLE game_votes ADD COLUMN ml_home REAL`);        } catch (_) {}
try { db.exec(`ALTER TABLE game_votes ADD COLUMN ml_away REAL`);        } catch (_) {}
try { db.exec(`ALTER TABLE game_votes ADD COLUMN ou_over_odds REAL`);   } catch (_) {}
try { db.exec(`ALTER TABLE game_votes ADD COLUMN ou_under_odds REAL`);  } catch (_) {}
try { db.exec(`ALTER TABLE game_votes ADD COLUMN spread REAL`);         } catch (_) {}
try { db.exec(`ALTER TABLE game_votes ADD COLUMN result TEXT NOT NULL DEFAULT 'pending'`); } catch (_) {}
try { db.exec(`ALTER TABLE game_votes ADD COLUMN score REAL`);          } catch (_) {}
// Closing line/odds for the voted slot, snapshotted at grade time from today_games
// (the last pre-game values; markets stop updating at 'pre'). Powers CLV.
try { db.exec(`ALTER TABLE game_votes ADD COLUMN closing_odds REAL`);   } catch (_) {}
try { db.exec(`ALTER TABLE game_votes ADD COLUMN closing_line REAL`);   } catch (_) {}
// The user's OWN wager for personal "My Tracking" P/L (dollars risked + the odds they
// actually got). NULL for quick-votes cast from the game modal. The LEADERBOARD never
// reads these — it always counts a vote as a flat 1 unit at the CA line (leaderboard.js
// voteReturn(v, 1)); these only scale the user's private P/L.
try { db.exec(`ALTER TABLE game_votes ADD COLUMN user_stake REAL`);     } catch (_) {}
try { db.exec(`ALTER TABLE game_votes ADD COLUMN user_odds REAL`);      } catch (_) {}
// Tail attribution (Phase 5): the scanned pick this vote tracked, when the voted
// side matches a capper's pick for the game. Powers tailers count + tail slippage.
try { db.exec(`ALTER TABLE game_votes ADD COLUMN tailed_pick_id INTEGER`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_game_votes_tailed ON game_votes (tailed_pick_id) WHERE tailed_pick_id IS NOT NULL`); } catch (_) {}

// prev_ columns for book_lines line-movement tracking
try { db.exec(`ALTER TABLE book_lines ADD COLUMN prev_ml_home REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE book_lines ADD COLUMN prev_ml_away REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE book_lines ADD COLUMN prev_spread_home REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE book_lines ADD COLUMN prev_spread_away REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE book_lines ADD COLUMN prev_over_under REAL`); } catch (_) {}

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

// Community chat per game. Snapshot columns (home/away/sport) let messages
// survive the daily today_games wipe and stay queryable for the leaderboard.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      espn_game_id TEXT    NOT NULL,
      message      TEXT    NOT NULL,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      deleted      INTEGER NOT NULL DEFAULT 0,
      home_team    TEXT,
      away_team    TEXT,
      sport        TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_game_messages_game ON game_messages (espn_game_id, created_at)`);
} catch (_) {}
// Dummy-comment phase tag (NULL for real users). 'pre' / 'post' lets the dummy
// commenter cap itself at one pre-game and one post-game message per game.
try { db.exec(`ALTER TABLE game_messages ADD COLUMN comment_phase TEXT`); } catch (_) {}

// Permanent per-game detail snapshot for MVP picks. Captures the free-but-wiped
// enrichment (public betting, line history, Polymarket, Kalshi, book lines + the
// game header) at game start so the MVP detail view survives the daily wipe.
// ESPN data (status, scores, box, stats) is re-fetched live, so it's not stored.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mvp_detail_snapshots (
      espn_game_id   TEXT PRIMARY KEY,
      captured_at    TEXT NOT NULL DEFAULT (datetime('now')),
      game_json      TEXT,
      picks_json     TEXT,
      public_betting TEXT,
      line_history   TEXT,
      polymarket     TEXT,
      kalshi         TEXT,
      lines          TEXT,
      insights       TEXT
    )
  `);
} catch (_) {}

try { db.exec(`ALTER TABLE users ADD COLUMN username TEXT`); } catch (_) {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username) WHERE username IS NOT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT`); } catch (_) {}

// ── Leaderboard ───────────────────────────────────────────────────────────────
// Per-user public/private flag (1 = visible on the public leaderboard, 0 = hidden).
// Default 1 (public by default); an absent user_preferences row is also treated as
// public via COALESCE(up.is_public, 1) in the ranking queries.
try { db.exec(`ALTER TABLE user_preferences ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
// Per-user bet-tracking config: unit size (dollars per 1 unit) + starting bankroll.
// Powers the "My Tracking" page — net units, dollar P/L, and bankroll-over-time.
// unit_size replaces the throwaway UI-only default that used to live in account.js.
try { db.exec(`ALTER TABLE user_preferences ADD COLUMN unit_size REAL NOT NULL DEFAULT 20`); } catch (_) {}
try { db.exec(`ALTER TABLE user_preferences ADD COLUMN starting_bankroll REAL NOT NULL DEFAULT 0`); } catch (_) {}
// Default odds source shown to the user (consensus | draftkings | kalshi | polymarket).
try { db.exec(`ALTER TABLE user_preferences ADD COLUMN default_odds TEXT NOT NULL DEFAULT 'consensus'`); } catch (_) {}
// Sportsbooks the user actually bets at ("My books"): JSON array of book keys.
// Drives the Track a Bet book bubbles + the detail-page "My books" lines group.
try { db.exec(`ALTER TABLE user_preferences ADD COLUMN my_books TEXT NOT NULL DEFAULT '[]'`); } catch (_) {}
// Notification preference center: JSON of topic -> boolean (absent = on).
// Topics + paid gating live in src/push.js TOPICS; enforced in sendToUserTopic.
try { db.exec(`ALTER TABLE user_preferences ADD COLUMN notify_prefs TEXT NOT NULL DEFAULT '{}'`); } catch (_) {}

// ── user_bets (Phase B) — free-entry + game-linked personal bet tracking ──────
// The MANUAL counterpart to game_votes. A bet may be game-linked (espn_game_id set
// -> auto-graded by results.evaluateVote in the cron) or purely manual (no game id
// -> the user self-settles). `verified` = can this count on ranked boards; only
// vote/scanned/synced are verifiable, manual is personal-tracking only (the trust
// moat). Snapshot columns let a settled bet keep its P/L + CLV after the daily wipe.
// NEVER wiped (not in wipe.js FULL_WIPE_TABLES).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_bets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      bet_type      TEXT    NOT NULL,
      sport         TEXT,
      selection     TEXT    NOT NULL,
      side          TEXT,
      line          REAL,
      odds          REAL    NOT NULL,
      stake         REAL    NOT NULL DEFAULT 0,
      units         REAL,
      espn_game_id  TEXT,
      game_date     TEXT,
      closing_odds  REAL,
      closing_line  REAL,
      result        TEXT    NOT NULL DEFAULT 'pending',
      payout        REAL,
      verified      INTEGER NOT NULL DEFAULT 0,
      source        TEXT    NOT NULL DEFAULT 'manual',
      home_team     TEXT,
      away_team     TEXT,
      book          TEXT,
      notes         TEXT,
      placed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      settled_at    TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_bets_user        ON user_bets (user_id, placed_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_bets_user_result ON user_bets (user_id, result)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_bets_grade       ON user_bets (result, espn_game_id) WHERE espn_game_id IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_bets_verified    ON user_bets (verified, result, settled_at)`);
} catch (_) {}
// Free bet: a loss doesn't count (payout 0, excluded from the record); a win does.
try { db.exec(`ALTER TABLE user_bets ADD COLUMN free_bet INTEGER NOT NULL DEFAULT 0`); } catch (_) {}

// ── bet_legs (Phase 5) — legs of a parlay user_bet. NEVER wiped. ───────────────
// One row per leg of a bet_type='parlay' user_bet. Game-linked legs auto-grade via
// the same evaluateVote path as single bets; prop legs stay manual. The parent
// parlay's result/payout is derived from its legs (any loss = loss, all win = win,
// pushes drop out and re-price the combined odds).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bet_legs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      bet_id       INTEGER NOT NULL,
      user_id      INTEGER NOT NULL,
      espn_game_id TEXT,
      sport        TEXT,
      selection    TEXT NOT NULL,
      bet_type     TEXT NOT NULL,
      side         TEXT,
      line         REAL,
      odds         REAL NOT NULL,
      result       TEXT NOT NULL DEFAULT 'pending',
      settled_at   TEXT,
      leg_index    INTEGER NOT NULL DEFAULT 0
    )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bet_legs_bet   ON bet_legs (bet_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bet_legs_grade ON bet_legs (result, espn_game_id) WHERE espn_game_id IS NOT NULL`);
} catch (_) {}

// ── bankroll_ledger (Phase B) — append-only bankroll adjustments. NEVER wiped. ──
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bankroll_ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      amount      REAL    NOT NULL,
      kind        TEXT    NOT NULL DEFAULT 'adjustment',
      note        TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bankroll_ledger_user ON bankroll_ledger (user_id, created_at)`);
} catch (_) {}
// Optional uploaded avatar (stored under the data volume; null = generated initials).
try { db.exec(`ALTER TABLE users ADD COLUMN avatar_path TEXT`); } catch (_) {}
// Seed/dummy member accounts (look like real members; auto-vote 35+ picks to seed
// the public leaderboard). 1 = dummy, managed from the admin Dummy Accounts tab.
try { db.exec(`ALTER TABLE users ADD COLUMN is_dummy INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
// Per-dummy, admin-editable behavior: daily pick range, allowed sports (JSON array;
// [] = all sports), and whether they currently vote at all.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dummy_settings (
      user_id    INTEGER PRIMARY KEY,
      min_picks  INTEGER NOT NULL DEFAULT 1,
      max_picks  INTEGER NOT NULL DEFAULT 4,
      sports     TEXT    NOT NULL DEFAULT '[]',
      active     INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
} catch (_) {}
// ── Personality upgrade (additive migrations; safe to re-run) ──────────────────
// personality   : free-text label shown in admin (e.g. "Chalk Chaser").
// min_week/max_week : weekly bet range — caps total picks placed in the cycle week.
// ranking_pct   : 0-100, share of daily picks drawn from the 35+ CA rankings; the
//                 remainder are random games on today's board (independent-looking).
// fade_mvp      : 1 = bet the OPPOSITE side of every 50+ MVP pick (contrarian).
// comment_pct   : 0-100, chance to drop a chat comment on an eligible game.
// comment_pre / comment_post : whether they comment before / after a game.
// comment_sports: JSON array, sports they'll comment on ([] = same as bet sports).
// comments      : JSON array of comment template strings ([] = shared default pool).
try { db.exec(`ALTER TABLE dummy_settings ADD COLUMN personality TEXT NOT NULL DEFAULT ''`); } catch (_) {}
try { db.exec(`ALTER TABLE dummy_settings ADD COLUMN min_week INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE dummy_settings ADD COLUMN max_week INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE dummy_settings ADD COLUMN ranking_pct INTEGER NOT NULL DEFAULT 100`); } catch (_) {}
try { db.exec(`ALTER TABLE dummy_settings ADD COLUMN fade_mvp INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE dummy_settings ADD COLUMN comment_pct INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE dummy_settings ADD COLUMN comment_pre INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
try { db.exec(`ALTER TABLE dummy_settings ADD COLUMN comment_post INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE dummy_settings ADD COLUMN comment_sports TEXT NOT NULL DEFAULT '[]'`); } catch (_) {}
try { db.exec(`ALTER TABLE dummy_settings ADD COLUMN comments TEXT NOT NULL DEFAULT '[]'`); } catch (_) {}
// Speeds up per-window leaderboard aggregates (filter by result + voted_at, group by user).
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_game_votes_user_result_voted ON game_votes (user_id, result, voted_at)`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_game_votes_result_voted ON game_votes (result, voted_at)`); } catch (_) {}
// /api/account lists a user's votes ordered by voted_at (no result filter), and the
// bet-history sport filter hits user_bets by (user_id, sport).
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_game_votes_user_voted ON game_votes (user_id, voted_at)`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_user_bets_user_sport ON user_bets (user_id, sport)`); } catch (_) {}

// Mac-side service heartbeats (odds engine, pb-relay) — never wiped. One row per
// service; /admin/health flags anything that stops checking in.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_heartbeats (
      service   TEXT PRIMARY KEY,
      last_seen TEXT NOT NULL,
      meta_json TEXT
    )`);
} catch (_) {}

// Events relayed by the odds engine for sports ESPN has no free scoreboard for
// (boxing, non-UFC MMA, esports, table tennis, cricket, ...). Feeds the
// betslip's game picker as custom-only entries. Refreshed every engine cycle;
// old rows pruned on ingest.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      sport      TEXT NOT NULL,
      home_team  TEXT NOT NULL,
      away_team  TEXT NOT NULL,
      start_time TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sport, home_team, away_team)
    )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_engine_events_start ON engine_events (start_time)`);
} catch (_) {}
// League/competition label for engine events (esports title, MMA org, ...).
try { db.exec(`ALTER TABLE engine_events ADD COLUMN league TEXT`); } catch (_) {}

// Per-book lines for ENGINE EVENTS (the non-ESPN sports lane: esports, MMA,
// boxing, table tennis, cricket, darts, golf H2H...). Kept apart from
// book_lines because these events have no espn_game_id and never enter the
// CA-line/grading/rankings pipeline — display and Track a Bet only. Keyed by
// the engine_events natural key + book; pruned alongside engine_events.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_event_lines (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sport         TEXT NOT NULL,
      home_team     TEXT NOT NULL,
      away_team     TEXT NOT NULL,
      book          TEXT NOT NULL,
      league        TEXT,
      start_time    TEXT,
      ml_home       REAL,
      ml_away       REAL,
      spread_home   REAL,
      spread_away   REAL,
      over_under    REAL,
      ou_over_odds  REAL,
      ou_under_odds REAL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sport, home_team, away_team, book)
    )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_engine_event_lines_ev ON engine_event_lines (sport, home_team, away_team)`);
} catch (_) {}

// Per-book PLAYER PROPS + team totals + alternate ladders (the market-depth
// lane). entity = player name, team name (team totals / alt spreads), or ''
// (alt totals). market = normalized market key per parser ('strikeouts',
// 'to_hit_hr', 'team_total', 'alt_spread', 'alt_total', ...). Yes-price
// markets store the price in over_odds with line/under_odds NULL. UNLIKE
// book_lines this table is PRUNED (game_date + the stale-game sweep): props
// at full scale are ~50k rows/day and have no long-term read path.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_props (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      espn_game_id TEXT NOT NULL,
      book         TEXT NOT NULL,
      entity       TEXT NOT NULL,
      market       TEXT NOT NULL,
      line         REAL,
      over_odds    REAL,
      under_odds   REAL,
      game_date    TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(espn_game_id, book, entity, market, line)
    )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_book_props_game ON book_props (espn_game_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_book_props_date ON book_props (game_date)`);
} catch (_) {}

// Closing-line archive: one row per (game_date, game, book) snapshotted at the
// 4:58am reset from book_lines (rows are already frozen at each game's start
// by the lines-lock rule, so this captures true closes). Never wiped — this is
// the long-term product surface the paid odds APIs charge extra for.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_lines_closing (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      game_date     TEXT NOT NULL,
      espn_game_id  TEXT NOT NULL,
      sport         TEXT,
      matchup       TEXT,
      start_time    TEXT,
      book          TEXT NOT NULL,
      ml_home       REAL,
      ml_away       REAL,
      spread_home   REAL,
      spread_away   REAL,
      over_under    REAL,
      ou_over_odds  REAL,
      ou_under_odds REAL,
      snapped_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(espn_game_id, book)
    )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_book_lines_closing_date ON book_lines_closing (game_date)`);
} catch (_) {}

// CA consensus line: the no-vig, Pinnacle-anchored blend across every stored
// book for a game. Recomputed by cron pre-game; frozen once the game starts
// (the compute skips started games, same lock rule as book_lines).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ca_consensus (
      espn_game_id  TEXT PRIMARY KEY,
      books_used    INTEGER,
      ml_home       REAL,
      ml_away       REAL,
      home_prob     REAL,
      away_prob     REAL,
      spread_home   REAL,
      spread_away   REAL,
      over_under    REAL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
} catch (_) {}

// Web-push subscriptions (one row per device endpoint per user) — never wiped.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      endpoint   TEXT NOT NULL UNIQUE,
      keys_json  TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id)`);
} catch (_) {}
// Content-push dedupe log (push.sendOnce): one row per (user, topic, key) so
// the alert crons can re-observe the same event without double-notifying.
// Pruned by the live-alerts cron (rows older than 14 days), never wiped.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      topic      TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      sent_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, topic, dedupe_key)
    )`);
} catch (_) {}
// Permanent record of weekly/monthly leaderboard finishes (top 10) → drives profile
// badges. Never wiped. tier: gold (#1), silver (top 5), bronze (top 10).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leaderboard_awards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      period_type TEXT    NOT NULL,
      period_key  TEXT    NOT NULL,
      rank        INTEGER NOT NULL,
      tier        TEXT    NOT NULL,
      units       REAL,
      awarded_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, period_type, period_key),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leaderboard_awards_user ON leaderboard_awards (user_id)`);
} catch (_) {}
// Social: one-way follow edges (Twitter style). Powers the Friends leaderboard and
// follower/following counts. Never wiped.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL,
      followee_id INTEGER NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(follower_id, followee_id),
      FOREIGN KEY (follower_id) REFERENCES users(id),
      FOREIGN KEY (followee_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows (follower_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id)`);
} catch (_) {}

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

// Multi-use + custom-duration access codes.
//   max_uses      : how many distinct users may redeem (1 = single-use default, 0 = unlimited)
//   duration_days : access granted on redemption (>0 = N days, 0 = lifetime, NULL = fall back to `type`)
try { db.exec(`ALTER TABLE access_codes ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
try { db.exec(`ALTER TABLE access_codes ADD COLUMN duration_days INTEGER`); } catch (_) {}

// Per-user redemption log (one row per user per code). Powers the usage cap + the
// admin "who used this code" popup. Single-use history is backfilled from access_codes.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_redemptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code_id     INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      redeemed_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(code_id, user_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_redemptions_code ON code_redemptions (code_id)`);
  db.exec(`
    INSERT OR IGNORE INTO code_redemptions (code_id, user_id, redeemed_at)
    SELECT id, activated_by, COALESCE(activated_at, created_at)
    FROM access_codes
    WHERE activated_by IS NOT NULL
  `);
} catch (_) {}

// Referral loop (give-a-day / get-a-day): every account can hold a referral
// code (minted lazily by auth.ensureReferralCode); each account may redeem one
// referral code ever (referred_id UNIQUE). Redemptions grant a day to both sides.
try { db.exec(`ALTER TABLE users ADD COLUMN referral_code TEXT`); } catch (_) {}
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users (referral_code) WHERE referral_code IS NOT NULL`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS referral_redemptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER NOT NULL,
      referred_id INTEGER NOT NULL UNIQUE,
      redeemed_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_referral_redemptions_referrer ON referral_redemptions (referrer_id)`);
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

// Where-to-watch broadcasts (enriched JSON: {tv, streaming, bundles})
try { db.exec(`ALTER TABLE golf_tournaments ADD COLUMN broadcasts_json TEXT`); } catch (_) {}

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
// Google sign-in: links a users row to a Google account (payload.sub).
try { db.exec(`ALTER TABLE users ADD COLUMN google_id TEXT`); } catch (_) {}

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

// ── Capper history (permanent — never wiped, cross-day capper tracking) ───────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capper_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      capper_name  TEXT NOT NULL,
      sport        TEXT,
      pick_type    TEXT,
      team         TEXT,
      spread       REAL,
      espn_game_id TEXT,
      game_date    TEXT,
      channel      TEXT,
      score        REAL,
      result       TEXT NOT NULL,
      pick_id      INTEGER,
      saved_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_capper_history_dedup ON capper_history (pick_id, capper_name) WHERE pick_id IS NOT NULL`);
} catch (_) {}
// American odds of the bet, captured at result time (for money / P&L tracking).
try { db.exec(`ALTER TABLE capper_history ADD COLUMN odds REAL`); } catch (_) {}

// ── Settings (key-value store for admin-configurable values) ──────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
} catch (_) {}

// ── One-time seed: high-confidence capper name merges (casing / spacing / typos) ──
// Maps messy name variants to a canonical display name via capper_aliases.
// Gated by a settings flag so admins can later delete/edit aliases without them
// being re-created on the next restart. Runs on both local + Railway.
try {
  const seeded = db.prepare("SELECT value FROM settings WHERE key = 'capper_alias_seed_v1'").get();
  if (!seeded) {
    const CAPPER_MERGES = {
      'Smart Money Sports':    ['SmartMoneySports'],
      'MidwestMike':           ['Midwest Mike'],
      'Big Al':                ['Big AL', 'BIG AL'],
      'Bet Labs':              ['Betlabs', 'Bet-Labs', 'Bwt labs'],
      'Your Daily Capper':     ['Your daily Capper'],
      'UnderdogSniper':        ['Underdog Sniper'],
      'Sports Analytics 24/7': ['Sports Analytics'],
      'AFSports':              ['Afsports', 'AfSports'],
      'A11Bets':               ['A11Bet'],
      'Cesar':                 ['CESAR'],
      'Tennis Winners Only':   ['TennisWinnersOnly'],
      'Jacavalier':            ['JACAVALIER', 'Jacavalier Elite'],
      'LaFormula':             ['Laformula'],
      'Vernon Croy':           ['Croy'],
      'Ben Burns':             ['Ben burns'],
      'Hammering Hank':        ['Hammer Hank'],
      'Pick Don':              ['The Pick Don'],
      'Gianni The Greek':      ['Gianni the Greek', 'Gianni'],
      'Robert Ferringo':       ['Ferringo'],
      'James Bets':            ['JamesBets', 'James bets'],
      'Carmine Bianco':        ['Carmone Bianco'],
      'TK Sports Analytics':   ['TK Sports Analysts'],
      'TheGuru':               ['Guru'],
      'Steam Capper':          ['Steam Capper on X'],
      'TBSportbetting':        ['Tbsportsbetting'],
      'RbSports':              ['RbSportsPlays'],
      'BulliesPicks':          ['Bullies Bets'],
      'OutofLineBets':         ['Out Of Line Bets'],
      'Q9':                    ['Dats Q9'],
      'Travy':                 ['Travvy'],
    };
    const insAlias = db.prepare(`INSERT OR IGNORE INTO capper_aliases (canonical_name, alias) VALUES (?, ?)`);
    const seedTxn = db.transaction(() => {
      for (const [canonical, variants] of Object.entries(CAPPER_MERGES)) {
        // Alias the canonical spelling to itself too, so resolution is total.
        insAlias.run(canonical, canonical);
        for (const v of variants) insAlias.run(canonical, v);
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('capper_alias_seed_v1', '1')").run();
    });
    seedTxn();
  }
} catch (_) {}

// ── One-time migration: restore picks voided by old same-game/opposing-team conflict resolver ──
// The old resolver grouped by (espn_game_id, pick_type) without team, so opposing-team
// spread picks (e.g. Hornets spread vs Magic spread) incorrectly conflicted.
// This runs ONCE (gated by settings flag) so future legitimate same-team voids are not reset.
try {
  const already = db.prepare("SELECT value FROM settings WHERE key = 'migration_opposing_team_void_fix'").get();
  if (!already) {
    db.exec(`
      UPDATE mvp_picks
      SET result = 'pending', annotation = NULL
      WHERE result = 'void'
        AND annotation LIKE '%not counted%'
    `);
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration_opposing_team_void_fix', '1')").run();
  }
} catch (_) {}

// ── Public betting % (scraped from ActionNetwork) ─────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_betting (
      espn_game_id          TEXT PRIMARY KEY,
      away_ml_pct           INTEGER,
      home_ml_pct           INTEGER,
      away_ml_money_pct     INTEGER,
      home_ml_money_pct     INTEGER,
      away_spread_pct       INTEGER,
      home_spread_pct       INTEGER,
      away_spread_money_pct INTEGER,
      home_spread_money_pct INTEGER,
      over_pct              INTEGER,
      under_pct             INTEGER,
      over_money_pct        INTEGER,
      under_money_pct       INTEGER,
      fetched_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
} catch (_) {}

// ── pick_history — permanent archive of every pick ≥35 points ─────────────────
// Written live from storage.js when a pick first scores ≥35pts.
// Survives all wipes. Result updated by results.js when the game finalizes.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pick_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      pick_id        INTEGER UNIQUE,
      espn_game_id   TEXT,
      sport          TEXT,
      game_date      TEXT,
      home_team      TEXT,
      away_team      TEXT,
      home_abbr      TEXT,
      away_abbr      TEXT,
      team           TEXT,
      pick_type      TEXT,
      spread         REAL,
      ml_odds        REAL,
      ou_odds        REAL,
      is_home_team   INTEGER NOT NULL DEFAULT 0,
      score          REAL,
      mention_count  INTEGER NOT NULL DEFAULT 1,
      channel        TEXT,
      channel_points INTEGER,
      sport_bonus    INTEGER,
      home_bonus     INTEGER,
      capper_name    TEXT,
      messages_json  TEXT,
      result         TEXT NOT NULL DEFAULT 'pending',
      home_score     INTEGER,
      away_score     INTEGER,
      first_seen_at  TEXT,
      resolved_at    TEXT,
      archived_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pick_history_game   ON pick_history (espn_game_id)`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pick_history_date   ON pick_history (game_date)`);    } catch (_) {}

// ── Live-line capture at the 35-point threshold ──────────────────────────────
// The line locked the moment a pick first crosses 35 points is THE tracked line
// (graph + MVP history). Captured once from the free DraftKings feed (book_lines)
// onto the picks row, then reused by pick_history + mvp_picks so all three agree.
try { db.exec(`ALTER TABLE picks ADD COLUMN captured_ml       REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN captured_spread   REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN captured_total    REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN captured_ou_odds  REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN line_captured_at  TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE pick_history ADD COLUMN live_ml          REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE pick_history ADD COLUMN live_spread      REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE pick_history ADD COLUMN live_total       REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE pick_history ADD COLUMN live_ou_odds     REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE pick_history ADD COLUMN line_captured_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE mvp_picks ADD COLUMN captured_spread   REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE mvp_picks ADD COLUMN captured_total    REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE mvp_picks ADD COLUMN line_captured_at  TEXT`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pick_history_result ON pick_history (result)`);        } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pick_history_sport  ON pick_history (sport)`);         } catch (_) {}

// Dedup index: prevents duplicate (game, team, type, date) entries regardless of pick_id source
try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ph_game_dedup
    ON pick_history (espn_game_id, team, pick_type, game_date)
    WHERE espn_game_id IS NOT NULL
  `);
} catch (_) {}

// Backfill from mvp_picks — runs every startup; INSERT OR IGNORE is idempotent.
// Uses negative synthetic pick_id (-(id + 10_000_000)) so it never collides with real picks.id.
try {
  db.exec(`
    INSERT OR IGNORE INTO pick_history
      (pick_id, espn_game_id, sport, game_date,
       home_team, away_team, team, pick_type, spread, ml_odds, ou_odds,
       score, result, home_score, away_score, first_seen_at, archived_at)
    SELECT
      -(m.id + 10000000),
      m.espn_game_id, m.sport, m.game_date,
      m.home_team, m.away_team, m.team, m.pick_type, m.spread, m.ml_odds, m.ou_odds,
      m.score, m.result, m.home_score, m.away_score, m.saved_at, m.saved_at
    FROM mvp_picks m
    WHERE m.espn_game_id IS NOT NULL
  `);
} catch (_) {}

// ── Line movement history — DraftKings timestamped changes via ESPN internal API ─
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS line_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      espn_game_id TEXT NOT NULL,
      book         TEXT NOT NULL DEFAULT 'draftkings',
      recorded_at  TEXT NOT NULL,
      spread_home  REAL,
      ml_home      REAL,
      ml_away      REAL,
      over_under   REAL,
      captured_at  TEXT,
      UNIQUE(espn_game_id, book, recorded_at)
    )
  `);
} catch (_) {}
try { db.exec(`ALTER TABLE line_history ADD COLUMN captured_at TEXT`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_lh_game ON line_history (espn_game_id, recorded_at DESC)`); } catch (_) {}

// ── Polymarket prediction market cache ───────────────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS polymarket_cache (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      espn_game_id         TEXT NOT NULL UNIQUE,
      markets_json         TEXT,
      morning_markets_json TEXT,
      volume_usd           REAL,
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

// ── Kalshi prediction market cache ───────────────────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kalshi_cache (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      espn_game_id         TEXT NOT NULL UNIQUE,
      markets_json         TEXT,
      morning_markets_json TEXT,
      volume_yes           REAL,
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}
// Migrate old kalshi_cache schema (flat columns → markets_json)
try { db.exec(`ALTER TABLE kalshi_cache ADD COLUMN markets_json TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE kalshi_cache ADD COLUMN morning_markets_json TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE kalshi_cache ADD COLUMN updated_at TEXT`); } catch (_) {}
// Clear stale rows from old flat-column schema so they get re-synced cleanly
try { db.exec(`DELETE FROM kalshi_cache WHERE markets_json IS NULL`); } catch (_) {}

// ── Esports prediction-market cache ──────────────────────────────────────────
// Standalone (no espn_game_id) — esports has no ESPN coverage. Scraped from
// Kalshi + Polymarket by src/esports_markets.js, powers the Esports "Top Games" row.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS esports_markets (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT,
      match_key    TEXT NOT NULL UNIQUE,
      game         TEXT,
      team_a       TEXT,
      team_b       TEXT,
      prob_a       REAL,
      prob_b       REAL,
      volume       REAL,
      tournament   TEXT,
      start_time   TEXT,
      status       TEXT,
      markets_json TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

// Tennis: per-set game counts and score detail for accurate spread/O-U grading and display
try { db.exec(`ALTER TABLE today_games ADD COLUMN tennis_home_games INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN tennis_away_games INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN tennis_score_detail TEXT`); } catch (_) {}

// Tennis: per-player country flag (ESPN flag image URL) + ISO-ish country code.
// Used to render flags in the player avatars and to color the sentiment/vote gauges
// by country instead of a single shared blue (two players are never the same color).
try { db.exec(`ALTER TABLE today_games ADD COLUMN home_flag TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN away_flag TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN home_country TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN away_country TEXT`); } catch (_) {}

// Reader path tracking — which extraction path was used (mac/haiku/fallback)
try { db.exec(`ALTER TABLE api_usage ADD COLUMN reader_path TEXT`); } catch (_) {}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reader_call_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT NOT NULL,
      msg_count   INTEGER NOT NULL DEFAULT 1,
      pick_count  INTEGER NOT NULL DEFAULT 0,
      latency_ms  INTEGER,
      error       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

// 7-day rolling archive of every scanned message that produced a pick.
// raw_messages itself is wiped at 4:58am; this table survives so we can audit
// capper-name extraction quality across days. Purged daily at 5:30am ET.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_messages_archive (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id        TEXT,
      channel           TEXT,
      author            TEXT,
      message_text      TEXT,
      message_timestamp TEXT,
      source            TEXT NOT NULL DEFAULT 'discord',
      pick_id           INTEGER,
      pick_team         TEXT,
      pick_type         TEXT,
      pick_sport        TEXT,
      capper_raw        TEXT,
      capper_name       TEXT,
      capper_matched    INTEGER,
      archived_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_rma_archived ON raw_messages_archive (archived_at)`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_rma_capper   ON raw_messages_archive (capper_name)`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_rma_msgid    ON raw_messages_archive (message_id)`); } catch (_) {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rma_dedup ON raw_messages_archive (message_id, pick_id) WHERE message_id IS NOT NULL`); } catch (_) {}

// ══ CA Algorithm v3 — Phase 1 foundation (docs/CA_ALGORITHM_V3.md) ═══════════

// Cross-source capper identity registry. canonical_name is the one name every
// system resolves into; capper_aliases stays as the Discord name-variant layer.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capper_registry (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_name TEXT NOT NULL UNIQUE,
      notes          TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

// (source, handle) -> canonical capper. handle is a username / wallet / user_id /
// contestant guid depending on the source. meta_json holds the source-side profile
// snapshot (e.g. AN verified record) for display next to OUR graded record.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capper_source_handles (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source         TEXT NOT NULL,
      handle         TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      meta_json      TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (source, handle)
    )
  `);
} catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_csh_canonical ON capper_source_handles (canonical_name)`); } catch (_) {}

// Provenance + venue flag on the permanent capper log
try { db.exec(`ALTER TABLE capper_history ADD COLUMN source TEXT NOT NULL DEFAULT 'discord'`); } catch (_) {}
try { db.exec(`ALTER TABLE capper_history ADD COLUMN is_home_team INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE capper_history ADD COLUMN sources_json TEXT`); } catch (_) {}

// Per-mention capper attribution (quality-weighted consensus needs to know WHO
// each mention came from, not just the author/channel)
try { db.exec(`ALTER TABLE raw_messages ADD COLUMN capper_name TEXT`); } catch (_) {}

// Spread juice (The Odds API returns prices alongside points; stored per side)
try { db.exec(`ALTER TABLE today_games ADD COLUMN spread_home_odds REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE today_games ADD COLUMN spread_away_odds REAL`); } catch (_) {}

// v3 component logging (log-only until scoring_version flips) + era markers
try { db.exec(`ALTER TABLE score_breakdown ADD COLUMN v3_total REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE score_breakdown ADD COLUMN v3_json  TEXT`); } catch (_) {}
// Leak rule state (display score ramps; engaged only when scoring_version='v3')
try { db.exec(`ALTER TABLE picks ADD COLUMN display_score   REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN leak_target     REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN leak_started_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE picks ADD COLUMN leak_window_sec INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE mvp_picks    ADD COLUMN scale_version TEXT NOT NULL DEFAULT 'v2'`); } catch (_) {}
try { db.exec(`ALTER TABLE pick_history ADD COLUMN scale_version TEXT NOT NULL DEFAULT 'v2'`); } catch (_) {}
// Persist the v3 total on the permanent archive: score_breakdown (the dual-log
// home) is wiped daily, so pick_history carries the calibration series forever.
try { db.exec(`ALTER TABLE pick_history ADD COLUMN v3_total REAL`); } catch (_) {}

// ── ONE SCALE EVERYWHERE (Jack, 2026-07-07): rescale ALL historical scores onto
// the v3 100-scale. Mapping: new = round(old * 20/13), capped 135. Old 65 (the
// publicly tracked tier floor) lands exactly on 100, old 50-64 (the old MVP
// band) lands 77-98 inside silver, order preserved everywhere below. Originals
// are kept in score_v2_original so nothing is ever destroyed. Runs ONCE, and
// only when v3 is actually live (prod stays untouched until the flip).
try { db.exec(`ALTER TABLE mvp_picks     ADD COLUMN score_v2_original REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE pick_history  ADD COLUMN score_v2_original REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE capper_history ADD COLUMN score_v2_original REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE golf_picks    ADD COLUMN score_v2_original REAL`); } catch (_) {}

// ── v17.1.3 THE FLIP (Jack, 2026-07-07): this deploy takes scoring to v3 ──────
// One-time: set scoring_version='v3' so the history rescale below fires on this
// same boot and the startup board rescore (index.js) runs. Guarded by its own
// marker so any later manual change to scoring_version is respected forever.
try {
  const flipped = db.prepare(`SELECT value FROM settings WHERE key = 'v17_1_3_v3_flip'`).get();
  if (!flipped) {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('scoring_version', 'v3')`).run();
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('v17_1_3_v3_flip', datetime('now'))`).run();
    console.log('[db] v17.1.3: scoring_version flipped to v3 (one-time)');
  }
} catch (err) {
  console.warn('[db] v17.1.3 flip failed:', err.message);
}

try {
  const live = db.prepare(`SELECT value FROM settings WHERE key = 'scoring_version'`).get();
  const done = db.prepare(`SELECT value FROM settings WHERE key = 'v3_history_rescale'`).get();
  if (live && live.value === 'v3' && !done) {
    db.exec(`
      UPDATE mvp_picks SET score_v2_original = score,
        score = MIN(135, ROUND(score * 20.0 / 13.0)), scale_version = 'v2-rescaled'
        WHERE scale_version = 'v2' AND score IS NOT NULL;
      UPDATE pick_history SET score_v2_original = score,
        score = MIN(135, ROUND(score * 20.0 / 13.0)), scale_version = 'v2-rescaled'
        WHERE scale_version = 'v2' AND score IS NOT NULL;
      UPDATE capper_history SET score_v2_original = score,
        score = MIN(135, ROUND(score * 20.0 / 13.0))
        WHERE score IS NOT NULL AND score_v2_original IS NULL;
      UPDATE golf_picks SET score_v2_original = score,
        score = MIN(135, ROUND(score * 20.0 / 13.0))
        WHERE score IS NOT NULL AND score_v2_original IS NULL;
    `);
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('v3_history_rescale', datetime('now'))`).run();
    console.log('[db] v3 history rescale complete: all historical scores now on the 100 scale (originals in score_v2_original)');
  }
} catch (err) {
  console.warn('[db] v3 history rescale failed:', err.message);
}

// Materialized capper ratings — the scorer and leaderboard read THIS, never raw
// history. Recomputed nightly + on demand (src/capper_ratings.js).
// scope: 'overall' | 'sport:MLB' | 'type:MLB/over'
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capper_ratings (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_name TEXT NOT NULL,
      scope          TEXT NOT NULL,
      sport          TEXT,
      pick_type      TEXT,
      picks          INTEGER NOT NULL DEFAULT 0,
      wins           INTEGER NOT NULL DEFAULT 0,
      losses         INTEGER NOT NULL DEFAULT 0,
      pushes         INTEGER NOT NULL DEFAULT 0,
      units          REAL    NOT NULL DEFAULT 0,
      blend          REAL,
      resume_points  INTEGER,
      tier           TEXT,
      fade           TEXT,
      sources        TEXT,
      computed_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (canonical_name, scope)
    )
  `);
} catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ratings_scope ON capper_ratings (scope)`); } catch (_) {}

// Wilson percentile engine columns (Jack 2026-07-09 rework: capper percentile
// rank drives pick points; base + resume + join-consensus retired).
// Overall scope: wilson/rank/percentile/band over the all-capper pool, pts =
// per-pick points after the band slide + volume cap, stack_add = what this
// capper adds as an extra backer. Sport scopes: wilson/rank/percentile within
// that sport's pool + sport_bonus_pts (20 top 5%, 10 top 25%).
try { db.exec(`ALTER TABLE capper_ratings ADD COLUMN wilson          REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE capper_ratings ADD COLUMN wilson_rank     INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE capper_ratings ADD COLUMN percentile      REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE capper_ratings ADD COLUMN band            TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE capper_ratings ADD COLUMN pts             REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE capper_ratings ADD COLUMN stack_add       REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE capper_ratings ADD COLUMN decisions       INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE capper_ratings ADD COLUMN win_pct         REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE capper_ratings ADD COLUMN sport_bonus_pts INTEGER`); } catch (_) {}

// ── Wave-1 scraper tables (v3 Phase 3, docs/CA_ALGORITHM_V3.md) ───────────────
// AN experts registry (discovered from public expert pages; picks land in
// capper_history via source_ingest with source='actionnetwork').
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS an_experts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL UNIQUE,
      username    TEXT,
      name        TEXT,
      followers   INTEGER,
      is_internal INTEGER,
      record_json TEXT,
      last_seen   TEXT,
      last_poll   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}
// AN props/exotics: logged for the record + future props page, never scored.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS an_expert_props (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      an_pick_id  TEXT UNIQUE,
      username    TEXT,
      play        TEXT,
      odds        REAL,
      units       REAL,
      starts_at   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}
// Polymarket tracked wallets (pro bettors, on-chain P/L shown on profile only).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pm_wallets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet        TEXT NOT NULL UNIQUE,
      username      TEXT,
      pnl           REAL,
      volume        REAL,
      last_trade_ts INTEGER,
      meta_json     TEXT,
      tracked_since TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}
// Conviction sizing (logged-only signal): rolling average game-market notional
// per wallet, so an oversized entry can be flagged vs the wallet's own usual.
try { db.exec(`ALTER TABLE pm_wallets ADD COLUMN notional_avg REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE pm_wallets ADD COLUMN notional_n INTEGER NOT NULL DEFAULT 0`); } catch (_) {}

// One-time Phase-1 backfill (settings-flag guarded):
//  - seed the registry from existing alias canonicals + history names
//  - discord handles for every known alias
//  - odds + is_home backfill onto old capper_history rows via pick_history
//  - bad-date sweep (a mis-parsed 2024 game_date exists on the server)
try {
  const done = db.prepare(`SELECT value FROM settings WHERE key = 'v3_phase1_backfill'`).get();
  if (!done) {
    db.exec(`
      INSERT OR IGNORE INTO capper_registry (canonical_name)
        SELECT DISTINCT canonical_name FROM capper_aliases WHERE canonical_name IS NOT NULL;
      INSERT OR IGNORE INTO capper_registry (canonical_name)
        SELECT DISTINCT capper_name FROM capper_history WHERE capper_name IS NOT NULL;
      INSERT OR IGNORE INTO capper_source_handles (source, handle, canonical_name)
        SELECT 'discord', alias, canonical_name FROM capper_aliases;
      INSERT OR IGNORE INTO capper_source_handles (source, handle, canonical_name)
        SELECT 'discord', canonical_name, canonical_name FROM capper_registry;
      UPDATE capper_history SET odds = (
        SELECT CASE
          WHEN LOWER(capper_history.pick_type) = 'ml' THEN ph.ml_odds
          WHEN LOWER(capper_history.pick_type) IN ('over','under') THEN ph.ou_odds
          ELSE NULL END
        FROM pick_history ph WHERE ph.pick_id = capper_history.pick_id
      ) WHERE odds IS NULL AND pick_id IS NOT NULL;
      UPDATE capper_history SET is_home_team = (
        SELECT ph.is_home_team FROM pick_history ph WHERE ph.pick_id = capper_history.pick_id
      ) WHERE is_home_team IS NULL AND pick_id IS NOT NULL;
      UPDATE capper_history SET game_date = NULL
        WHERE game_date IS NOT NULL AND game_date < '2026-01-01';
    `);
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('v3_phase1_backfill', datetime('now'))`).run();
    console.log('[db] v3 Phase-1 backfill complete (registry seeded, odds/is_home backfilled)');
  }
} catch (err) {
  console.warn('[db] v3 Phase-1 backfill failed:', err.message);
}

// One-time line-display snap (2026-07-16, settings-flag guarded). Tracked rows'
// display `spread` never followed the CA line lock: mvp_picks/pick_history kept
// their save-time line while captured_*/live_* held the locked line grading
// actually used. Worst symptom (Jul 15 Valkyries@Fever): Over 165.5 and Under
// 169.5 both tracked on one game — the stale 169.5 read as a legit middle to
// the conflict resolver. Snap display to the row's own locked stamp; results
// untouched (every drifted row's result was verified correct against the
// captured line). mvp_picks is unbounded (captured_* was the era-official line
// under lock-on-gold too); pick_history is bounded to the T-60 era because
// older live_* stamps on never-locked games were cross-time captures, not the
// graded line. The 5-min conflict resolver then retro-voids the Jul 15 beaten
// under on its own once the pair's lines agree.
try {
  const done = db.prepare(`SELECT value FROM settings WHERE key = 'line_display_snap_v1'`).get();
  if (!done) {
    db.exec(`
      UPDATE mvp_picks SET spread = captured_total
        WHERE LOWER(pick_type) IN ('over','under') AND captured_total IS NOT NULL
          AND spread IS NOT captured_total;
      UPDATE mvp_picks SET spread = captured_spread
        WHERE LOWER(pick_type) = 'spread' AND captured_spread IS NOT NULL
          AND spread IS NOT captured_spread;
      UPDATE pick_history SET spread = live_total
        WHERE LOWER(pick_type) IN ('over','under') AND live_total IS NOT NULL
          AND spread IS NOT live_total AND game_date >= '2026-07-14';
      UPDATE pick_history SET spread = live_spread
        WHERE LOWER(pick_type) = 'spread' AND live_spread IS NOT NULL
          AND spread IS NOT live_spread AND game_date >= '2026-07-14';
    `);
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('line_display_snap_v1', datetime('now'))`).run();
    console.log('[db] line display snap complete: tracked rows now show the locked line');
  }
} catch (err) {
  console.warn('[db] line display snap failed:', err.message);
}

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
