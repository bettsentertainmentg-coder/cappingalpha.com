// src/value_engine.js — Pick retrieval and ranking
// Scoring is handled by storage.js (via scoring.js) on write.
// This module just reads ranked picks from the DB.

const db = require('./db');

// ── Get ranked picks from the last 30 hours, ordered by score ─────────────────
function getRankedPicks() {
  return db.prepare(`
    SELECT * FROM picks
    WHERE parsed_at >= datetime('now', '-30 hours')
      AND mention_count > 0
    ORDER BY score DESC
  `).all();
}

// ── No-op: scoring happens in storage.js on write ─────────────────────────────
function recalculateToday() {}

module.exports = { getRankedPicks, recalculateToday };
