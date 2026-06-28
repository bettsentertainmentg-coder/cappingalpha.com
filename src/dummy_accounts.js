// src/dummy_accounts.js
// Seed/dummy member accounts that look like real members. They auto-vote on the
// day's picks and chat on games, so the public leaderboard + game pages aren't
// empty at launch. They start from now (no backfill) and build a record as those
// games resolve, via the same grading path as real votes. Fully managed from the
// admin Dummy Accounts tab.
//
// These are NOT the CappingAlpha "Official" house bots (which come from mvp_picks).
// Dummies are ordinary users (is_dummy = 1) with their own game_votes + chat.
//
// Each dummy carries a PERSONALITY (admin-editable, per-account knobs):
//   personality   — display label
//   min/max picks — daily bet range          | min/max week — weekly bet cap
//   sports        — sports they bet ([]=all)  | ranking_pct  — % of bets from the
//                                               35+ CA rankings (rest = random board)
//   fade_mvp      — bet the OPPOSITE side of every 50+ MVP pick (contrarian)
//   comment_pct   — chattiness (% chance/game)| comment_pre/post — timing
//   comment_sports— sports they comment on    | comments — their comment pool

const db = require('./db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getCycleDate } = require('./cycle');

// Picks at/above this score are "MVP" — the side a fader bets against.
const MVP_FADE_THRESHOLD = 50;

// Realistic-looking handles. Editable later from the admin panel.
const DUMMY_USERS = [
  'SharpShooter22', 'FadeTheNoise', 'GritsAndGravy', 'NightcapNate', 'ChalkBoardCheryl',
  'ParlayProphet', 'TheUnderdogUnit', 'VegasVantage', 'LineMoveLarry', 'CoverCity',
];

// Sports a dummy may be restricted to (admin-editable). Empty = all sports.
const DUMMY_SPORTS = ['MLB', 'NBA', 'WNBA', 'NHL', 'NFL', 'NCAAF', 'CBB', 'ATP', 'WTA', 'Golf'];

const PAIR = {
  home_ml: 'away_ml', away_ml: 'home_ml',
  home_spread: 'away_spread', away_spread: 'home_spread',
  over: 'under', under: 'over',
};

// ── Personality presets ───────────────────────────────────────────────────────
// Applied once when a dummy is first seeded (or when an existing dummy has no
// personality yet). Admin edits always win afterward — re-seeding never clobbers a
// row whose personality is already set. Comment strings support {team} (the side
// they bet) and {sport} tokens. Casual member voice, no certainty/hype words.
const PERSONA_PRESETS = {
  SharpShooter22: {
    personality: 'Sharp Shooter', min: 1, max: 3, minW: 6, maxW: 14, ranking: 100, fade: 0,
    cpct: 25, cpre: 1, cpost: 0, sports: [], csports: [],
    comments: ['Small but confident on {team}.', '{team} is the sharp side here.', 'Line value on {team}, easy call.'],
  },
  FadeTheNoise: {
    personality: 'The Fader', min: 2, max: 5, minW: 10, maxW: 25, ranking: 100, fade: 1,
    cpct: 60, cpre: 1, cpost: 1, sports: [], csports: [],
    comments: ['Public is all over the other side, so I am fading.', 'Everyone loves the chalk, I will take {team}.', 'Fading the hype. {team} for me.', 'Too much steam the other way. {team}.'],
  },
  GritsAndGravy: {
    personality: 'MLB Grinder', min: 3, max: 6, minW: 15, maxW: 30, ranking: 80, fade: 0,
    cpct: 40, cpre: 1, cpost: 1, sports: ['MLB'], csports: ['MLB'],
    comments: ['Baseball is the only sport that matters. {team}.', 'Riding {team} on the diamond.', 'First five or full game, {team} for me.'],
  },
  NightcapNate: {
    personality: 'West Coast Nightcap', min: 1, max: 4, minW: 5, maxW: 18, ranking: 70, fade: 0,
    cpct: 35, cpre: 0, cpost: 1, sports: ['NBA', 'MLB', 'NHL'], csports: [],
    comments: ['Late slate is where I live. {team}.', 'Nightcap play: {team}.', 'Staying up for {team}.'],
  },
  ChalkBoardCheryl: {
    personality: 'Chalk Chaser', min: 2, max: 5, minW: 10, maxW: 24, ranking: 95, fade: 0,
    cpct: 30, cpre: 1, cpost: 0, sports: [], csports: [],
    comments: ['Favorites are favorites for a reason. {team}.', 'Laying the chalk with {team}.', '{team} should handle this one.'],
  },
  ParlayProphet: {
    personality: 'Volume Parlay', min: 5, max: 10, minW: 30, maxW: 55, ranking: 60, fade: 0,
    cpct: 50, cpre: 1, cpost: 1, sports: [], csports: [],
    comments: ['Adding {team} to the slip.', '{team} is leg three today.', 'More legs, more fun. {team}.'],
  },
  TheUnderdogUnit: {
    personality: 'Dog Bettor', min: 1, max: 4, minW: 7, maxW: 20, ranking: 50, fade: 0,
    cpct: 40, cpre: 1, cpost: 1, sports: [], csports: [],
    comments: ['Give me the points and the dog. {team}.', 'Upset brewing with {team}.', 'Plus money on {team}, love it.'],
  },
  VegasVantage: {
    personality: 'Low-Volume Sharp', min: 1, max: 2, minW: 4, maxW: 10, ranking: 100, fade: 0,
    cpct: 20, cpre: 1, cpost: 0, sports: [], csports: [],
    comments: ['One play I trust today: {team}.', 'Quality over quantity. {team}.', '{team} is the only number I like.'],
  },
  LineMoveLarry: {
    personality: 'Line Mover', min: 2, max: 5, minW: 12, maxW: 26, ranking: 85, fade: 0,
    cpct: 45, cpre: 1, cpost: 0, sports: [], csports: [],
    comments: ['Line moved toward {team}, following it.', 'Steam on {team}.', 'Sharp money looks like {team}.'],
  },
  CoverCity: {
    personality: 'Heavy Hitter', min: 6, max: 12, minW: 35, maxW: 60, ranking: 75, fade: 0,
    cpct: 55, cpre: 1, cpost: 1, sports: [], csports: [],
    comments: ['Big slate today, {team} included.', 'Hammering {team}.', '{team} is a max bet for me.'],
  },
};
const DEFAULT_PRESET = {
  personality: '', min: 1, max: 4, minW: 0, maxW: 0, ranking: 100, fade: 0,
  cpct: 0, cpre: 1, cpost: 0, sports: [], csports: [], comments: [],
};

// Shared fallbacks when a persona has no custom pool. Pre = pick flavor; post =
// generic reactions (kept separate so post-game lines never read as pre-game).
const DEFAULT_PRE_COMMENTS = [
  'Locked in on {team} tonight.', '{team} is my play here.', 'Feeling good about {team}.',
  'Tailing {team}, line still looks ok.', 'On {team}. Should be a good one.',
];
const DEFAULT_POST_COMMENTS = [
  'Good run on this one.', 'Onto the next.', 'That is how you start the day.',
  'Tough beat, shake it off.', 'Booked it. Next one.',
];

// ── Date / hashing helpers ────────────────────────────────────────────────────
// Stable hash → 0..99, so a dummy's selection is deterministic and idempotent
// across cron runs (re-running never expands a dummy's subset for the same key).
function hash100(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h % 100;
}

// Monday (UTC) of the current cycle week — the weekly-cap window start.
function cycleWeekStart() {
  const dt = new Date(getCycleDate() + 'T00:00:00Z');
  const dow = dt.getUTCDay();             // 0=Sun..6=Sat
  dt.setUTCDate(dt.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return dt.toISOString().slice(0, 10);
}

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

// Line snapshot for a slot, from a game row carrying odds columns.
function lineForSlot(slot, g) {
  if (slot === 'home_spread') return g.spread_home;
  if (slot === 'away_spread') return g.spread_away;
  if (slot === 'over' || slot === 'under') return g.over_under;
  return null;
}

// Team nickname = last word (home_short is already short when present).
function nick(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  return s.split(' ').pop();
}

// The human side label for a slot (used in comment {team} tokens).
function slotSideLabel(slot, g) {
  const home = nick(g.home_short || g.home_team || 'home');
  const away = nick(g.away_short || g.away_team || 'away');
  if (slot && slot.startsWith('home')) return home;
  if (slot && slot.startsWith('away')) return away;
  if (slot === 'over')  return 'the over';
  if (slot === 'under') return 'the under';
  return home;
}

// ── Settings ──────────────────────────────────────────────────────────────────
function getDummySettings(userId) {
  const r = db.prepare(`
    SELECT min_picks, max_picks, sports, active, personality, min_week, max_week,
           ranking_pct, fade_mvp, comment_pct, comment_pre, comment_post,
           comment_sports, comments
    FROM dummy_settings WHERE user_id = ?
  `).get(userId);
  if (!r) return { ...DEFAULT_PRESET, min_picks: 1, max_picks: 4, active: 1 };
  const J = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
  return {
    min_picks: r.min_picks, max_picks: r.max_picks, sports: J(r.sports), active: r.active,
    personality: r.personality || '', min_week: r.min_week | 0, max_week: r.max_week | 0,
    ranking_pct: r.ranking_pct == null ? 100 : r.ranking_pct, fade_mvp: r.fade_mvp ? 1 : 0,
    comment_pct: r.comment_pct | 0, comment_pre: r.comment_pre ? 1 : 0, comment_post: r.comment_post ? 1 : 0,
    comment_sports: J(r.comment_sports), comments: J(r.comments),
  };
}

// Today's pick quota: a number in [min, max], seeded by id + cycle date so it
// varies day to day but is stable across the day's cron runs.
function dailyQuota(user, s) {
  if (!s.active) return 0;
  const lo = Math.max(0, s.min_picks | 0);
  const hi = Math.max(lo, s.max_picks | 0);
  const seed = hash100(`${user.id}:${getCycleDate()}:q`);
  return lo + (hi > lo ? seed % (hi - lo + 1) : 0);
}

// This week's cap. Infinity when no weekly range is configured (max_week = 0).
function weeklyQuota(user, s) {
  if (!(s.max_week > 0)) return Infinity;
  const lo = Math.max(0, s.min_week | 0);
  const hi = Math.max(lo, s.max_week | 0);
  const seed = hash100(`${user.id}:${cycleWeekStart()}:wq`);
  return lo + (hi > lo ? seed % (hi - lo + 1) : 0);
}

// ── Seed accounts ─────────────────────────────────────────────────────────────
// Idempotent: creates missing dummy accounts, flags existing ones, ensures a
// public preferences row, and hydrates the personality preset on first sight.
async function seedDummyAccounts() {
  // Write the full preset only when the row is new or still un-personalized.
  const applyPreset = (uid, name) => {
    const p = PERSONA_PRESETS[name] || DEFAULT_PRESET;
    db.prepare(`INSERT OR IGNORE INTO dummy_settings (user_id) VALUES (?)`).run(uid);
    const cur = db.prepare(`SELECT personality FROM dummy_settings WHERE user_id = ?`).get(uid);
    if (cur && cur.personality && cur.personality.trim()) return; // admin-personalized — leave it
    db.prepare(`
      UPDATE dummy_settings SET
        personality = ?, min_picks = ?, max_picks = ?, min_week = ?, max_week = ?,
        sports = ?, ranking_pct = ?, fade_mvp = ?, comment_pct = ?, comment_pre = ?,
        comment_post = ?, comment_sports = ?, comments = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(
      p.personality || name, p.min, p.max, p.minW, p.maxW,
      JSON.stringify(p.sports || []), p.ranking, p.fade, p.cpct, p.cpre,
      p.cpost, JSON.stringify(p.csports || []), JSON.stringify(p.comments || []), uid,
    );
  };

  let created = 0;
  for (const name of DUMMY_USERS) {
    const existing = db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`).get(name);
    if (existing) {
      db.prepare(`UPDATE users SET is_dummy = 1 WHERE id = ?`).run(existing.id);
      db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id, favorite_sports, is_public) VALUES (?, '[]', 1)`).run(existing.id);
      applyPreset(existing.id, name);
      continue;
    }
    const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12);
    const info = db.prepare(`
      INSERT INTO users (email, password_hash, subscription_tier, username, is_dummy, created_at)
      VALUES (?, ?, 'free', ?, 1, datetime('now'))
    `).run(`${name.toLowerCase()}@seed.cappingalpha.local`, hash, name);
    db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id, favorite_sports, is_public) VALUES (?, '[]', 1)`)
      .run(info.lastInsertRowid);
    applyPreset(info.lastInsertRowid, name);
    created++;
  }
  if (created) console.log(`[dummy] seeded ${created} dummy account(s)`);
  return created;
}

// ── Auto-vote ─────────────────────────────────────────────────────────────────
// Place dummy votes on today's slate for games that haven't finished. ranking_pct
// of each dummy's daily quota comes from the 35+ CA rankings (or their fades); the
// rest from random other board games, so they read like independent bettors.
// Snapshot columns mirror the real vote endpoint so grading is identical. Idempotent.
function runDummyVotes() {
  const dummies = db.prepare(`SELECT id, username FROM users WHERE is_dummy = 1`).all();
  if (!dummies.length) return 0;

  // Ranked source: 35+ picks on unfinished games (carry score for fade decisions).
  const ranked = db.prepare(`
    SELECT p.espn_game_id, p.pick_type, p.is_home_team, p.sport, p.score,
           g.home_team, g.away_team,
           g.ml_home, g.ml_away, g.ou_over_odds, g.ou_under_odds,
           g.spread_home, g.spread_away, g.over_under
    FROM picks p
    JOIN today_games g ON g.espn_game_id = p.espn_game_id
    WHERE p.score >= 35 AND g.status != 'post' AND p.espn_game_id IS NOT NULL
  `).all();

  // One candidate per (game, slot) — dedupe cappers picking the same side. Each
  // candidate keeps `mvp` so faders know which sides to flip.
  const rankedCandidates = [];
  const rankedSeen = new Set();
  const rankedGameIds = new Set();
  for (const p of ranked) {
    const slot = pickToSlot(p);
    if (!slot) continue;
    rankedGameIds.add(p.espn_game_id);
    const key = p.espn_game_id + ':' + slot;
    if (rankedSeen.has(key)) continue;
    rankedSeen.add(key);
    rankedCandidates.push({ ...p, slot, line: lineForSlot(slot, p), mvp: p.score >= MVP_FADE_THRESHOLD });
  }

  // Fade source: the OPPOSITE side of every MVP (50+) pick. Built once, reused by
  // any fader. Skips a flip whose pair side a real capper also took (rare).
  const fadeCandidates = [];
  const fadeSeen = new Set();
  for (const c of rankedCandidates) {
    if (!c.mvp) continue;
    const fadeSlot = PAIR[c.slot];
    if (!fadeSlot) continue;
    const key = c.espn_game_id + ':' + fadeSlot;
    if (fadeSeen.has(key)) continue;
    fadeSeen.add(key);
    fadeCandidates.push({ ...c, slot: fadeSlot, line: lineForSlot(fadeSlot, c) });
  }

  // Random-board source: any unfinished game, all bettable slots that have odds.
  // Excludes games already covered by the rankings so the two pools don't overlap.
  const boardGames = db.prepare(`
    SELECT espn_game_id, sport, home_team, away_team,
           ml_home, ml_away, ou_over_odds, ou_under_odds,
           spread_home, spread_away, over_under
    FROM today_games WHERE status != 'post' AND espn_game_id IS NOT NULL
  `).all();
  const boardCandidates = [];
  for (const g of boardGames) {
    if (rankedGameIds.has(g.espn_game_id)) continue;
    const slots = [];
    if (g.ml_home != null) slots.push('home_ml');
    if (g.ml_away != null) slots.push('away_ml');
    if (g.over_under != null) { slots.push('over'); slots.push('under'); }
    for (const slot of slots) {
      boardCandidates.push({ ...g, slot, line: lineForSlot(slot, g) });
    }
  }

  const hasVote     = db.prepare(`SELECT 1 FROM game_votes WHERE user_id = ? AND espn_game_id = ? AND pick_slot = ?`);
  const placedToday = db.prepare(`SELECT COUNT(*) c FROM game_votes WHERE user_id = ? AND espn_game_id IN (SELECT espn_game_id FROM today_games)`);
  const placedWeek  = db.prepare(`SELECT COUNT(*) c FROM game_votes WHERE user_id = ? AND date(voted_at) >= ?`);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO game_votes
      (user_id, espn_game_id, pick_slot, voted_at, home_team, away_team, sport,
       ml_home, ml_away, ou_over_odds, ou_under_odds, spread)
    VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const weekStart = cycleWeekStart();

  let added = 0;
  const tx = db.transaction(() => {
    for (const d of dummies) {
      const s = getDummySettings(d.id);
      if (!s.active) continue;

      const dayLeft  = dailyQuota(d, s) - placedToday.get(d.id).c;
      const weekLeft = weeklyQuota(d, s) - placedWeek.get(d.id, weekStart).c;
      let remaining = Math.min(dayLeft, weekLeft);
      if (remaining <= 0) continue;

      // Split the remaining quota: rankings share vs random board share.
      const pct = Math.max(0, Math.min(100, s.ranking_pct));
      let rankingCount = Math.round(remaining * pct / 100);
      let otherCount   = remaining - rankingCount;

      const allowed = s.sports.length ? new Set(s.sports.map(x => String(x).toUpperCase())) : null;
      const inSport = (c) => !allowed || allowed.has(String(c.sport || '').toUpperCase());

      // Deterministic per-dummy ordering so each picks the same subset across runs.
      const order = (list) => list
        .filter(inSport)
        .map(c => ({ c, h: hash100(`${d.id}:${c.espn_game_id}:${c.slot}`) }))
        .sort((a, b) => a.h - b.h)
        .map(x => x.c);

      const place = (c) => {
        if (hasVote.get(d.id, c.espn_game_id, c.slot)) return false;
        if (hasVote.get(d.id, c.espn_game_id, PAIR[c.slot])) return false; // no both-sides
        const r = insert.run(d.id, c.espn_game_id, c.slot, c.home_team, c.away_team, c.sport,
          c.ml_home, c.ml_away, c.ou_over_odds, c.ou_under_odds, c.line);
        if (r.changes) { added++; remaining--; return true; }
        return false;
      };

      // 1) Rankings (or fades) up to the rankings share.
      const rankSource = s.fade_mvp ? fadeCandidates : rankedCandidates;
      for (const c of order(rankSource)) {
        if (rankingCount <= 0 || remaining <= 0) break;
        if (place(c)) rankingCount--;
      }
      // 2) Random board games for the remainder. Any rankings share we couldn't
      //    fill (thin slate) rolls into the board allowance so the quota still fills.
      otherCount += rankingCount;
      for (const c of order(boardCandidates)) {
        if (otherCount <= 0 || remaining <= 0) break;
        if (place(c)) otherCount--;
      }
    }
  });
  tx();
  if (added) console.log(`[dummy] placed ${added} dummy vote(s)`);
  return added;
}

// ── Auto-comment ──────────────────────────────────────────────────────────────
// Drop chat messages on games a dummy has bet, into the same per-game chat real
// users see. At most one pre-game and one post-game comment per dummy per game
// (tracked via game_messages.comment_phase). Deterministic + idempotent.
function pickComment(s, g, phase, userId) {
  let pool = phase === 'post' ? DEFAULT_POST_COMMENTS
           : (s.comments.length ? s.comments : DEFAULT_PRE_COMMENTS);
  if (!pool.length) return null;
  const idx = hash100(`${userId}:${g.espn_game_id}:${phase}:t`) % pool.length;
  return String(pool[idx])
    .replace(/\{team\}/g, slotSideLabel(g.pick_slot, g))
    .replace(/\{sport\}/g, g.sport || 'the game');
}

function runDummyComments() {
  const dummies = db.prepare(`SELECT id FROM users WHERE is_dummy = 1`).all();
  if (!dummies.length) return 0;

  const gamesFor = db.prepare(`
    SELECT v.espn_game_id, v.pick_slot, g.sport, g.status,
           g.home_team, g.away_team, g.home_short, g.away_short
    FROM game_votes v
    JOIN today_games g ON g.espn_game_id = v.espn_game_id
    WHERE v.user_id = ?
    GROUP BY v.espn_game_id
  `);
  const alreadyPhase = db.prepare(`
    SELECT 1 FROM game_messages
    WHERE user_id = ? AND espn_game_id = ? AND deleted = 0 AND comment_phase = ?
  `);
  const insert = db.prepare(`
    INSERT INTO game_messages (user_id, espn_game_id, message, home_team, away_team, sport, comment_phase)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let added = 0;
  const tx = db.transaction(() => {
    for (const d of dummies) {
      const s = getDummySettings(d.id);
      if (!s.active || s.comment_pct <= 0) continue;
      if (!s.comment_pre && !s.comment_post) continue;
      const allow = s.comment_sports.length ? new Set(s.comment_sports.map(x => String(x).toUpperCase())) : null;

      for (const g of gamesFor.all(d.id)) {
        if (allow && !allow.has(String(g.sport || '').toUpperCase())) continue;
        const phase = g.status === 'post' ? 'post' : 'pre'; // pre covers scheduled + live
        if (phase === 'pre' && !s.comment_pre) continue;
        if (phase === 'post' && !s.comment_post) continue;
        if (alreadyPhase.get(d.id, g.espn_game_id, phase)) continue;
        if (hash100(`${d.id}:${g.espn_game_id}:${phase}:c`) >= s.comment_pct) continue;
        const text = pickComment(s, g, phase, d.id);
        if (!text) continue;
        insert.run(d.id, g.espn_game_id, text, g.home_team, g.away_team, g.sport, phase);
        added++;
      }
    }
  });
  tx();
  if (added) console.log(`[dummy] posted ${added} dummy comment(s)`);
  return added;
}

// ── Admin helpers ─────────────────────────────────────────────────────────────
function listDummyAccounts() {
  return db.prepare(`
    SELECT u.id, u.username, u.created_at,
           COALESCE(up.is_public, 1)     AS is_public,
           COALESCE(ds.min_picks, 1)     AS min_picks,
           COALESCE(ds.max_picks, 4)     AS max_picks,
           COALESCE(ds.min_week, 0)      AS min_week,
           COALESCE(ds.max_week, 0)      AS max_week,
           COALESCE(ds.sports, '[]')     AS sports,
           COALESCE(ds.active, 1)        AS active,
           COALESCE(ds.personality, '')  AS personality,
           COALESCE(ds.ranking_pct, 100) AS ranking_pct,
           COALESCE(ds.fade_mvp, 0)      AS fade_mvp,
           COALESCE(ds.comment_pct, 0)   AS comment_pct,
           COALESCE(ds.comment_pre, 1)   AS comment_pre,
           COALESCE(ds.comment_post, 0)  AS comment_post,
           COALESCE(ds.comment_sports, '[]') AS comment_sports,
           COALESCE(ds.comments, '[]')   AS comments,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id) AS total_votes,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'win')     AS wins,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'loss')    AS losses,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'push')    AS pushes,
           (SELECT COUNT(*) FROM game_votes v WHERE v.user_id = u.id AND v.result = 'pending') AS pending,
           (SELECT COUNT(*) FROM game_messages m WHERE m.user_id = u.id AND m.deleted = 0)     AS comment_count
    FROM users u
    LEFT JOIN user_preferences up ON up.user_id = u.id
    LEFT JOIN dummy_settings ds ON ds.user_id = u.id
    WHERE u.is_dummy = 1
    ORDER BY u.username COLLATE NOCASE
  `).all().map(r => {
    const J = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
    return { ...r, sports: J(r.sports), comment_sports: J(r.comment_sports), comments: J(r.comments) };
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
  const set = (col, val) => db.prepare(`UPDATE dummy_settings SET ${col} = ?, updated_at = datetime('now') WHERE user_id = ?`).run(val, id);
  const clampInt = (v, hi) => Math.max(0, Math.min(hi, parseInt(v, 10) || 0));

  if (f.personality !== undefined) set('personality', String(f.personality || '').slice(0, 60));
  if (f.min_picks   !== undefined) set('min_picks', clampInt(f.min_picks, 50));
  if (f.max_picks   !== undefined) set('max_picks', clampInt(f.max_picks, 50));
  if (f.min_week    !== undefined) set('min_week', clampInt(f.min_week, 300));
  if (f.max_week    !== undefined) set('max_week', clampInt(f.max_week, 300));
  if (f.ranking_pct !== undefined) set('ranking_pct', clampInt(f.ranking_pct, 100));
  if (f.comment_pct !== undefined) set('comment_pct', clampInt(f.comment_pct, 100));
  if (f.fade_mvp     !== undefined) set('fade_mvp', f.fade_mvp ? 1 : 0);
  if (f.active       !== undefined) set('active', f.active ? 1 : 0);
  if (f.comment_pre  !== undefined) set('comment_pre', f.comment_pre ? 1 : 0);
  if (f.comment_post !== undefined) set('comment_post', f.comment_post ? 1 : 0);

  const normSports = (val) => {
    let arr = Array.isArray(val) ? val : String(val || '').split(',');
    arr = arr.map(x => String(x).trim().toUpperCase());
    if (arr.some(x => x === 'ALL')) arr = [];
    const valid = new Set(DUMMY_SPORTS.map(x => x.toUpperCase()));
    return [...new Set(arr.filter(x => valid.has(x)))];
  };
  if (f.sports !== undefined)         set('sports', JSON.stringify(normSports(f.sports)));
  if (f.comment_sports !== undefined) set('comment_sports', JSON.stringify(normSports(f.comment_sports)));

  if (f.comments !== undefined) {
    // Accept an array, or a newline/pipe-separated string from the admin textarea.
    let arr = Array.isArray(f.comments) ? f.comments : String(f.comments || '').split(/\r?\n|\|/);
    arr = arr.map(x => String(x).trim()).filter(Boolean).slice(0, 40).map(x => x.slice(0, 280));
    set('comments', JSON.stringify(arr));
  }

  // Keep max >= min on both ranges.
  const s = db.prepare(`SELECT min_picks, max_picks, min_week, max_week FROM dummy_settings WHERE user_id = ?`).get(id);
  if (s && s.min_picks > s.max_picks) set('max_picks', s.min_picks);
  if (s && s.min_week  > s.max_week && s.max_week > 0) set('max_week', s.min_week);

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
  runDummyComments,
  listDummyAccounts,
  saveDummyAccount,
};
