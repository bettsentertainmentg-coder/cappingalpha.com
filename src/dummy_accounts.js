// src/dummy_accounts.js
// Seed/dummy member accounts that look like real members and auto-vote on the
// day's 35+ point picks, so the public leaderboard isn't empty at launch. They
// start from now (no backfill) and build a record as those games resolve, via the
// same grading path as real votes. Managed from the admin Dummy Accounts tab.
//
// These are NOT the CappingAlpha "Official" house bots (which come from mvp_picks).
// Dummies are ordinary users (is_dummy = 1) with their own game_votes.

const db = require('./db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Realistic-looking handles. Editable later from the admin panel.
const DUMMY_USERS = [
  'SharpShooter22', 'FadeTheNoise', 'GritsAndGravy', 'NightcapNate', 'ChalkBoardCheryl',
  'ParlayProphet', 'TheUnderdogUnit', 'VegasVantage', 'LineMoveLarry', 'CoverCity',
];

const PAIR = {
  home_ml: 'away_ml', away_ml: 'home_ml',
  home_spread: 'away_spread', away_spread: 'home_spread',
  over: 'under', under: 'over',
};

// Map a picks-row to the matching game_votes slot. Returns null for bet types we
// don't model on the board (nrfi, tennis set spreads, etc.).
function pickToSlot(pick) {
  const pt = (pick.pick_type || '').toLowerCase();
  if (pt === 'ml')     return pick.is_home_team ? 'home_ml' : 'away_ml';
  if (pt === 'spread') return pick.is_home_team ? 'home_spread' : 'away_spread';
  if (pt === 'over')   return 'over';
  if (pt === 'under')  return 'under';
  return null;
}

// Stable hash → 0..99, so a dummy's pick selection is deterministic and idempotent
// across cron runs (re-running never expands a dummy's subset for the same pick).
function hash100(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h % 100;
}

// Each dummy has its own appetite (≈38–80% of eligible picks) so volumes vary.
function dummyTakeRate(userId) { return 38 + (userId % 7) * 7; }
function dummyTakes(userId, gameId, slot) {
  return hash100(`${userId}:${gameId}:${slot}`) < dummyTakeRate(userId);
}

// ── Seed accounts ─────────────────────────────────────────────────────────────
// Idempotent: creates any missing dummy accounts, flags existing ones, ensures a
// public preferences row. Unusable password (random hash) so they can't be used
// to log in. Returns the number newly created.
async function seedDummyAccounts() {
  let created = 0;
  for (const name of DUMMY_USERS) {
    const existing = db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`).get(name);
    if (existing) {
      db.prepare(`UPDATE users SET is_dummy = 1 WHERE id = ?`).run(existing.id);
      db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id, favorite_sports, is_public) VALUES (?, '[]', 1)`).run(existing.id);
      continue;
    }
    const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12);
    const info = db.prepare(`
      INSERT INTO users (email, password_hash, subscription_tier, username, is_dummy, created_at)
      VALUES (?, ?, 'free', ?, 1, datetime('now'))
    `).run(`${name.toLowerCase()}@seed.cappingalpha.local`, hash, name);
    db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id, favorite_sports, is_public) VALUES (?, '[]', 1)`)
      .run(info.lastInsertRowid);
    created++;
  }
  if (created) console.log(`[dummy] seeded ${created} dummy account(s)`);
  return created;
}

// ── Auto-vote ─────────────────────────────────────────────────────────────────
// Place dummy votes on today's 35+ point picks for games that haven't finished
// yet (so it reads like they bet pre/in-game). Snapshot columns mirror the real
// vote endpoint so grading + leaderboard math are identical. Idempotent.
function runDummyVotes() {
  const dummies = db.prepare(`SELECT id FROM users WHERE is_dummy = 1`).all();
  if (!dummies.length) return 0;

  const picks = db.prepare(`
    SELECT p.espn_game_id, p.pick_type, p.is_home_team, p.score, p.sport,
           g.home_team, g.away_team, g.status,
           g.ml_home, g.ml_away, g.ou_over_odds, g.ou_under_odds,
           g.spread_home, g.spread_away, g.over_under
    FROM picks p
    JOIN today_games g ON g.espn_game_id = p.espn_game_id
    WHERE p.score >= 35 AND g.status != 'post' AND p.espn_game_id IS NOT NULL
  `).all();
  if (!picks.length) return 0;

  const hasVote = db.prepare(`SELECT 1 FROM game_votes WHERE user_id = ? AND espn_game_id = ? AND pick_slot = ?`);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO game_votes
      (user_id, espn_game_id, pick_slot, voted_at, home_team, away_team, sport,
       ml_home, ml_away, ou_over_odds, ou_under_odds, spread)
    VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let added = 0;
  const tx = db.transaction(() => {
    for (const p of picks) {
      const slot = pickToSlot(p);
      if (!slot) continue;
      const line = slot === 'home_spread' ? p.spread_home
                 : slot === 'away_spread' ? p.spread_away
                 : (slot === 'over' || slot === 'under') ? p.over_under
                 : null;
      for (const d of dummies) {
        if (!dummyTakes(d.id, p.espn_game_id, slot)) continue;
        // Never vote both sides of the same bet type.
        if (hasVote.get(d.id, p.espn_game_id, slot)) continue;
        if (hasVote.get(d.id, p.espn_game_id, PAIR[slot])) continue;
        const r = insert.run(d.id, p.espn_game_id, slot, p.home_team, p.away_team, p.sport,
          p.ml_home, p.ml_away, p.ou_over_odds, p.ou_under_odds, line);
        if (r.changes) added++;
      }
    }
  });
  tx();
  if (added) console.log(`[dummy] placed ${added} dummy vote(s) on 35+ picks`);
  return added;
}

// ── Admin helpers ─────────────────────────────────────────────────────────────
function listDummyAccounts() {
  return db.prepare(`
    SELECT u.id, u.username, u.created_at,
           COALESCE(up.is_public, 1) AS is_public,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id) AS total_votes,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'win')  AS wins,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'loss') AS losses,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'push') AS pushes,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'pending') AS pending
    FROM users u
    LEFT JOIN user_preferences up ON up.user_id = u.id
    WHERE u.is_dummy = 1
    ORDER BY u.username COLLATE NOCASE
  `).all();
}

function renameDummyAccount(id, newName) {
  const name = String(newName || '').trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) return { error: 'Username must be 3-20 chars: letters, numbers, underscores.' };
  const row = db.prepare(`SELECT id FROM users WHERE id = ? AND is_dummy = 1`).get(id);
  if (!row) return { error: 'Dummy account not found.' };
  const taken = db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?`).get(name, id);
  if (taken) return { error: 'That username is already taken.' };
  db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(name, id);
  return { ok: true, username: name };
}

// Toggle whether a dummy shows on the public board (still votes regardless).
function setDummyPublic(id, isPublic) {
  const row = db.prepare(`SELECT id FROM users WHERE id = ? AND is_dummy = 1`).get(id);
  if (!row) return { error: 'Dummy account not found.' };
  const pub = isPublic ? 1 : 0;
  db.prepare(`
    INSERT INTO user_preferences (user_id, favorite_sports, is_public)
    VALUES (?, '[]', ?)
    ON CONFLICT(user_id) DO UPDATE SET is_public = excluded.is_public
  `).run(id, pub);
  return { ok: true, is_public: pub };
}

module.exports = {
  DUMMY_USERS,
  seedDummyAccounts,
  runDummyVotes,
  listDummyAccounts,
  renameDummyAccount,
  setDummyPublic,
};
