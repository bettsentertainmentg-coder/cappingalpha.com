// src/session_store.js
// SQLite-backed session store using the existing better-sqlite3 connection.
// Replaces the default in-memory store — sessions survive server restarts,
// don't leak memory, and work correctly under PM2 restarts.
//
// Zero extra npm packages — uses the same db.js connection already open.

const { Store } = require('express-session');
const db = require('./db');

// ── Create sessions table if it doesn't exist ────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT NOT NULL PRIMARY KEY,
    sess    TEXT NOT NULL,
    expired TEXT NOT NULL
  )
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions (expired)`); } catch (_) {}

// ── Store class ───────────────────────────────────────────────────────────────
class SQLiteStore extends Store {
  constructor({ ttlSeconds = 7 * 24 * 60 * 60 } = {}) {
    super();
    this.ttl = ttlSeconds; // default: 7 days

    // Prune expired sessions every 15 minutes
    // .unref() so this timer doesn't keep the process alive on shutdown
    setInterval(() => {
      try {
        const deleted = db.prepare(`DELETE FROM sessions WHERE expired < ?`).run(new Date().toISOString());
        if (deleted.changes > 0) console.log(`[sessions] Pruned ${deleted.changes} expired session(s)`);
      } catch (_) {}
    }, 15 * 60 * 1000).unref();
  }

  // Read a session
  get(sid, cb) {
    try {
      const row = db.prepare(`SELECT sess, expired FROM sessions WHERE sid = ?`).get(sid);
      if (!row) return cb(null, null);
      if (row.expired < new Date().toISOString()) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  // Write / update a session
  set(sid, session, cb) {
    try {
      const maxAge = session?.cookie?.maxAge;
      const ttl    = typeof maxAge === 'number' ? Math.floor(maxAge / 1000) : this.ttl;
      const expired = new Date(Date.now() + ttl * 1000).toISOString();
      db.prepare(`
        INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired
      `).run(sid, JSON.stringify(session), expired);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  // Extend expiry without changing session data
  touch(sid, session, cb) {
    this.set(sid, session, cb);
  }

  // Delete a session (logout)
  destroy(sid, cb) {
    try {
      db.prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  // Optional: count active sessions (admin use)
  length(cb) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE expired > ?`).get(new Date().toISOString());
      cb(null, row.c);
    } catch (err) {
      cb(err);
    }
  }
}

module.exports = SQLiteStore;
