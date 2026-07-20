// src/community.js
// Community layer for the game detail page: per-game chat + the vote annotations
// shown next to each chat author. Kept separate from index.js routing so the
// same queries can be reused by future projects (e.g. the leaderboard tab).
//
// Backing tables:
//   game_messages — one row per chat message (see db.js). Snapshot columns let
//                   messages outlive the daily today_games wipe.
//   game_votes    — existing per-user/game/slot votes (already leaderboard-ready
//                   with result + score snapshot columns).

const db = require('./db');

const MAX_MESSAGE_LEN = 500;
// Messages can only be deleted within this window after posting.
const DELETE_WINDOW_MS = 60 * 1000;

// Parse an SQLite datetime('now') string ("2026-06-02 14:30:00", UTC) to ms.
function parseTs(s) {
  if (!s) return NaN;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.getTime();
}

// Short, display-friendly label + side for a vote slot. `side` drives the chip
// color on the frontend (home / away / over / under). Team names come from the
// vote snapshot or the live today_games row.
function slotMeta(slot, game) {
  const homeName = game?.home_short || game?.home_team || 'Home';
  const awayName = game?.away_short || game?.away_team || 'Away';
  switch (slot) {
    case 'home_ml':     return { label: `${homeName} Win`,    side: 'home' };
    case 'away_ml':     return { label: `${awayName} Win`,    side: 'away' };
    case 'home_spread': return { label: `${homeName} Spread`, side: 'home' };
    case 'away_spread': return { label: `${awayName} Spread`, side: 'away' };
    case 'over':        return { label: 'Over',               side: 'over' };
    case 'under':       return { label: 'Under',              side: 'under' };
    default:            return { label: slot,                 side: 'home' };
  }
}

// All votes a user has cast on a game, as annotation objects. Reusable anywhere
// we want to show "what someone is on" for a game.
function getUserGameVotes(userId, espnGameId, game) {
  if (!userId) return [];
  const rows = db.prepare(`
    SELECT pick_slot FROM game_votes WHERE user_id = ? AND espn_game_id = ?
  `).all(userId, espnGameId);
  // Stable order: ML, spread, total.
  const ORDER = ['home_ml', 'away_ml', 'home_spread', 'away_spread', 'over', 'under'];
  return rows
    .map(r => r.pick_slot)
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
    .map(slot => ({ slot, ...slotMeta(slot, game) }));
}

// Full chat for a game, oldest → newest, each message enriched with the author's
// username and their current vote annotations. `currentUserId` flags own messages
// so the frontend can offer a delete affordance.
function getGameChat(espnGameId, currentUserId = null) {
  const game = db.prepare(`
    SELECT espn_game_id, home_team, away_team, home_short, away_short, sport
    FROM today_games WHERE espn_game_id = ?
  `).get(espnGameId) || null;

  const rows = db.prepare(`
    SELECT m.id, m.user_id, m.message, m.created_at, u.username
    FROM game_messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.espn_game_id = ? AND m.deleted = 0
    ORDER BY m.created_at ASC, m.id ASC
  `).all(espnGameId);

  // A private member's votes are visible only to themselves, matching the
  // member-profile privacy gate (posting in chat must not out their picks).
  const publicCache = new Map();
  const isPublic = (uid) => {
    if (!publicCache.has(uid)) {
      const row = db.prepare(`SELECT is_public FROM user_preferences WHERE user_id = ?`).get(uid);
      publicCache.set(uid, row ? (row.is_public == null ? 1 : row.is_public) : 1);
    }
    return publicCache.get(uid);
  };

  // Cache votes per user so a chatty thread doesn't re-query for each message.
  const voteCache = new Map();
  return rows.map(r => {
    if (!voteCache.has(r.user_id)) {
      voteCache.set(r.user_id, getUserGameVotes(r.user_id, espnGameId, game));
    }
    const isMine = currentUserId != null && r.user_id === currentUserId;
    const ts = parseTs(r.created_at);
    return {
      id:         r.id,
      username:   r.username || `user${r.user_id}`,
      message:    r.message,
      created_at: r.created_at,
      votes:      (isMine || isPublic(r.user_id)) ? voteCache.get(r.user_id) : [],
      is_mine:    isMine,
      // Only the author, and only within the first minute, can delete.
      deletable:  isMine && !Number.isNaN(ts) && (Date.now() - ts) <= DELETE_WINDOW_MS,
    };
  });
}

// Post a message. Returns { ok, message } or { error }. Snapshots game metadata.
function addGameMessage(userId, espnGameId, rawText) {
  const text = String(rawText || '').trim();
  if (!text) return { error: 'Message is empty.' };
  if (text.length > MAX_MESSAGE_LEN) return { error: `Message too long (max ${MAX_MESSAGE_LEN}).` };

  const game = db.prepare(`
    SELECT home_team, away_team, sport FROM today_games WHERE espn_game_id = ?
  `).get(espnGameId);
  if (!game) return { error: 'Game not found.' };

  const info = db.prepare(`
    INSERT INTO game_messages (user_id, espn_game_id, message, home_team, away_team, sport)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, espnGameId, text, game.home_team, game.away_team, game.sport);

  const chat = getGameChat(espnGameId, userId);
  const message = chat.find(m => m.id === info.lastInsertRowid) || null;
  return { ok: true, message };
}

// Soft-delete a message — only the author, and only within the delete window
// (first minute after posting). After that messages are permanent.
function deleteGameMessage(userId, espnGameId, messageId) {
  const row = db.prepare(`SELECT user_id, created_at FROM game_messages WHERE id = ? AND espn_game_id = ?`)
    .get(messageId, espnGameId);
  if (!row) return { error: 'Message not found.' };
  if (row.user_id !== userId) return { error: 'Not your message.' };
  const ts = parseTs(row.created_at);
  if (!Number.isNaN(ts) && (Date.now() - ts) > DELETE_WINDOW_MS) {
    return { error: 'This message can no longer be deleted.', expired: true };
  }
  db.prepare(`UPDATE game_messages SET deleted = 1 WHERE id = ?`).run(messageId);
  return { ok: true };
}

module.exports = {
  MAX_MESSAGE_LEN,
  slotMeta,
  getUserGameVotes,
  getGameChat,
  addGameMessage,
  deleteGameMessage,
};
