// src/pick_cutoff.js
// Scoring lock: once a game has actually started (status='in' stamped via
// game_start_tracker), new pick mentions are only accepted for 5 minutes.
// Anything later is rejected and logged to skipped_messages.

const db = require('./db');

const GRACE_MS = 5 * 60 * 1000;

function isPickAcceptable(game) {
  if (!game || !game.actual_start_at) return true;
  // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' in UTC with no offset.
  // Convert to ISO so new Date() parses it as UTC, not local time.
  const iso = game.actual_start_at.includes('T')
    ? game.actual_start_at
    : game.actual_start_at.replace(' ', 'T') + 'Z';
  const startedAt = new Date(iso).getTime();
  if (Number.isNaN(startedAt)) return true;
  return (Date.now() - startedAt) <= GRACE_MS;
}

function logLatePick(pick) {
  const rm = pick.raw_message;
  if (!rm?.id) return;
  try {
    db.prepare(`
      INSERT OR IGNORE INTO skipped_messages
        (message_id, channel, author, content, reason)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      String(rm.id),
      pick.channel ?? null,
      rm.author ?? null,
      rm.content ?? '',
      'late_post_start'
    );
  } catch (err) {
    console.warn('[pickCutoff] logLatePick error:', err.message);
  }
}

module.exports = { isPickAcceptable, logLatePick, GRACE_MS };
