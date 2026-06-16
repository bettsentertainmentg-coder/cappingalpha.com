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
const { getCycleDate } = require('./cycle');

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

// Sports a dummy may be restricted to (admin-editable). Empty = all sports.
const DUMMY_SPORTS = ['MLB', 'NBA', 'WNBA', 'NHL', 'NFL', 'NCAAF', 'CBB', 'ATP', 'WTA', 'Golf'];

// Starting volume presets (only applied when a dummy is first seeded; admin edits
// in dummy_settings always win after that). Most are light, one heavy, one moderate.
function presetFor(username) {
  if (username === 'CoverCity')     return { min: 10, max: 22 }; // heavy hitter
  if (username === 'LineMoveLarry') return { min: 4,  max: 7  }; // moderate
  return { min: 1, max: 4 };                                     // light
}

// Per-dummy settings with sane fallbacks if the row is missing.
function getDummySettings(userId) {
  const r = db.prepare(`SELECT min_picks, max_picks, sports, active FROM dummy_settings WHERE user_id = ?`).get(userId);
  if (!r) return { min_picks: 1, max_picks: 4, sports: [], active: 1 };
  let sports = [];
  try { sports = JSON.parse(r.sports || '[]'); } catch (_) {}
  return { min_picks: r.min_picks, max_picks: r.max_picks, sports, active: r.active };
}

// Today's pick quota for a dummy: a number in [min, max], seeded by id + cycle date
// so it varies day to day but is stable across the day's cron runs. 0 if inactive.
function dailyQuota(user) {
  const s = getDummySettings(user.id);
  if (!s.active) return 0;
  const lo = Math.max(0, s.min_picks | 0);
  const hi = Math.max(lo, s.max_picks | 0);
  const seed = hash100(`${user.id}:${getCycleDate()}:q`);
  return lo + (hi > lo ? (seed % (hi - lo + 1)) : 0);
}

// ── Seed accounts ─────────────────────────────────────────────────────────────
// Idempotent: creates any missing dummy accounts, flags existing ones, ensures a
// public preferences row. Unusable password (random hash) so they can't be used
// to log in. Returns the number newly created.
async function seedDummyAccounts() {
  // INSERT OR IGNORE preserves any admin edits on re-seed.
  const ensureSettings = (uid, name) => {
    const p = presetFor(name);
    db.prepare(`INSERT OR IGNORE INTO dummy_settings (user_id, min_picks, max_picks, sports, active) VALUES (?, ?, ?, '[]', 1)`)
      .run(uid, p.min, p.max);
  };

  let created = 0;
  for (const name of DUMMY_USERS) {
    const existing = db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`).get(name);
    if (existing) {
      db.prepare(`UPDATE users SET is_dummy = 1 WHERE id = ?`).run(existing.id);
      db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id, favorite_sports, is_public) VALUES (?, '[]', 1)`).run(existing.id);
      ensureSettings(existing.id, name);
      continue;
    }
    const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12);
    const info = db.prepare(`
      INSERT INTO users (email, password_hash, subscription_tier, username, is_dummy, created_at)
      VALUES (?, ?, 'free', ?, 1, datetime('now'))
    `).run(`${name.toLowerCase()}@seed.cappingalpha.local`, hash, name);
    db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id, favorite_sports, is_public) VALUES (?, '[]', 1)`)
      .run(info.lastInsertRowid);
    ensureSettings(info.lastInsertRowid, name);
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
  const dummies = db.prepare(`SELECT id, username FROM users WHERE is_dummy = 1`).all();
  if (!dummies.length) return 0;

  const picks = db.prepare(`
    SELECT p.espn_game_id, p.pick_type, p.is_home_team, p.sport,
           g.home_team, g.away_team,
           g.ml_home, g.ml_away, g.ou_over_odds, g.ou_under_odds,
           g.spread_home, g.spread_away, g.over_under
    FROM picks p
    JOIN today_games g ON g.espn_game_id = p.espn_game_id
    WHERE p.score >= 35 AND g.status != 'post' AND p.espn_game_id IS NOT NULL
  `).all();
  if (!picks.length) return 0;

  // One candidate per (game, slot) — dedupe cappers picking the same side.
  const candidates = [];
  const seen = new Set();
  for (const p of picks) {
    const slot = pickToSlot(p);
    if (!slot) continue;
    const key = p.espn_game_id + ':' + slot;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = slot === 'home_spread' ? p.spread_home
               : slot === 'away_spread' ? p.spread_away
               : (slot === 'over' || slot === 'under') ? p.over_under
               : null;
    candidates.push({ ...p, slot, line });
  }
  if (!candidates.length) return 0;

  const hasVote   = db.prepare(`SELECT 1 FROM game_votes WHERE user_id = ? AND espn_game_id = ? AND pick_slot = ?`);
  // How many picks this dummy already has on the current slate (so re-running the
  // cron through the day tops up toward the quota instead of re-betting).
  const placedToday = db.prepare(`SELECT COUNT(*) c FROM game_votes WHERE user_id = ? AND espn_game_id IN (SELECT espn_game_id FROM today_games)`);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO game_votes
      (user_id, espn_game_id, pick_slot, voted_at, home_team, away_team, sport,
       ml_home, ml_away, ou_over_odds, ou_under_odds, spread)
    VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let added = 0;
  const tx = db.transaction(() => {
    for (const d of dummies) {
      const s = getDummySettings(d.id);
      if (!s.active) continue;
      let remaining = dailyQuota(d) - placedToday.get(d.id).c;
      if (remaining <= 0) continue;
      // Restrict to the dummy's chosen sports (empty = all sports).
      const allowed = s.sports.length ? new Set(s.sports.map(x => String(x).toUpperCase())) : null;
      // Stable per-dummy ordering so each picks the same subset across runs.
      const avail = candidates
        .filter(c => !allowed || allowed.has(String(c.sport || '').toUpperCase()))
        .map(c => ({ c, h: hash100(`${d.id}:${c.espn_game_id}:${c.slot}`) }))
        .sort((a, b) => a.h - b.h);
      for (const { c } of avail) {
        if (remaining <= 0) break;
        if (hasVote.get(d.id, c.espn_game_id, c.slot)) continue;
        if (hasVote.get(d.id, c.espn_game_id, PAIR[c.slot])) continue; // no both-sides
        const r = insert.run(d.id, c.espn_game_id, c.slot, c.home_team, c.away_team, c.sport,
          c.ml_home, c.ml_away, c.ou_over_odds, c.ou_under_odds, c.line);
        if (r.changes) { added++; remaining--; }
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
           COALESCE(ds.min_picks, 1) AS min_picks,
           COALESCE(ds.max_picks, 4) AS max_picks,
           COALESCE(ds.sports, '[]') AS sports,
           COALESCE(ds.active, 1)    AS active,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id) AS total_votes,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'win')  AS wins,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'loss') AS losses,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'push') AS pushes,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'pending') AS pending
    FROM users u
    LEFT JOIN user_preferences up ON up.user_id = u.id
    LEFT JOIN dummy_settings ds ON ds.user_id = u.id
    WHERE u.is_dummy = 1
    ORDER BY u.username COLLATE NOCASE
  `).all().map(r => {
    let sports = [];
    try { sports = JSON.parse(r.sports || '[]'); } catch (_) {}
    return { ...r, sports };
  });
}

// One combined editor for everything admin can change on a dummy. Partial: only
// the fields present in `fields` are updated.
function saveDummyAccount(id, fields) {
  const f = fields || {};
  const row = db.prepare(`SELECT id FROM users WHERE id = ? AND is_dummy = 1`).get(id);
  if (!row) return { error: 'Dummy account not found.' };

  if (f.username !== undefined) {
    const name = String(f.username || '').trim();
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) return { error: 'Username must be 3-20 chars: letters, numbers, underscores.' };
    const taken = db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?`).get(name, id);
    if (taken) return { error: 'That username is already taken.' };
    db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(name, id);
  }

  db.prepare(`INSERT OR IGNORE INTO dummy_settings (user_id) VALUES (?)`).run(id);
  const clampInt = (v) => Math.max(0, Math.min(50, parseInt(v, 10) || 0));
  if (f.min_picks !== undefined) db.prepare(`UPDATE dummy_settings SET min_picks = ?, updated_at = datetime('now') WHERE user_id = ?`).run(clampInt(f.min_picks), id);
  if (f.max_picks !== undefined) db.prepare(`UPDATE dummy_settings SET max_picks = ?, updated_at = datetime('now') WHERE user_id = ?`).run(clampInt(f.max_picks), id);
  if (f.active !== undefined)    db.prepare(`UPDATE dummy_settings SET active = ?, updated_at = datetime('now') WHERE user_id = ?`).run(f.active ? 1 : 0, id);
  if (f.sports !== undefined) {
    let arr = Array.isArray(f.sports) ? f.sports : String(f.sports || '').split(',');
    arr = arr.map(s => String(s).trim().toUpperCase());
    // "all" or empty → no restriction.
    if (arr.some(s => s === 'ALL')) arr = [];
    const valid = new Set(DUMMY_SPORTS.map(s => s.toUpperCase()));
    arr = [...new Set(arr.filter(s => valid.has(s)))];
    db.prepare(`UPDATE dummy_settings SET sports = ?, updated_at = datetime('now') WHERE user_id = ?`).run(JSON.stringify(arr), id);
  }
  // Keep max >= min.
  const s = db.prepare(`SELECT min_picks, max_picks FROM dummy_settings WHERE user_id = ?`).get(id);
  if (s && s.min_picks > s.max_picks) db.prepare(`UPDATE dummy_settings SET max_picks = ? WHERE user_id = ?`).run(s.min_picks, id);

  if (f.is_public !== undefined) {
    db.prepare(`INSERT INTO user_preferences (user_id, favorite_sports, is_public) VALUES (?, '[]', ?)
                ON CONFLICT(user_id) DO UPDATE SET is_public = excluded.is_public`).run(id, f.is_public ? 1 : 0);
  }
  return { ok: true };
}

module.exports = {
  DUMMY_USERS,
  DUMMY_SPORTS,
  seedDummyAccounts,
  runDummyVotes,
  listDummyAccounts,
  saveDummyAccount,
};
