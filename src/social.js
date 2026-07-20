// src/social.js — the Socials tab backend: feed, boosts, comments, blocks and
// reports, member search, suggested members, profit calendar, true-history
// profile extras.
//
// FEED IS DERIVED, NOT STORED. Items come straight from game_votes / user_bets /
// leaderboard_awards (all wipe-surviving) at read time, so history backfills
// itself, there are no write hooks to forget, and a bug fix re-derives the past.
// The only stored social state is what users add on top: boosts (reactions),
// comments, blocks, reports (tables in db.js).
//
// Subject keys address feed items across those tables:
//   'vote:<game_votes.id>' | 'bet:<user_bets.id>' | 'award:<leaderboard_awards.id>'
//   | 'house:<YYYY-MM-DD>'
//
// TWO-LEDGER RULE (Jack, 2026-07-17): rankings count verified picks at a flat
// 1 unit. The social side may show TRUE stakes (user_stake on votes, stake on
// user_bets) per the owner's public/private status, with unverified entries
// always labeled. hide_stakes (user_preferences) strips dollar figures from
// everything a non-owner sees.

const db = require('./db');
const {
  gradedRows, aggregate, statify, voteReturn, userIsPublic, getLeaderboard,
} = require('./leaderboard');

const COMMENT_MAX = 400;
const COMMENTS_PER_HOUR = 20;

// ── Graph helpers ─────────────────────────────────────────────────────────────
function followeeIds(meId) {
  return db.prepare(`SELECT followee_id FROM follows WHERE follower_id = ?`).all(meId).map(r => r.followee_id);
}
function followerIds(meId) {
  return db.prepare(`SELECT follower_id FROM follows WHERE followee_id = ?`).all(meId).map(r => r.follower_id);
}
function mutualSet(meId) {
  const out = new Set(followerIds(meId));
  const both = new Set();
  for (const id of followeeIds(meId)) if (out.has(id)) both.add(id);
  return both;
}
// Users whose content I must not see (I blocked/muted them, or they blocked me),
// and users who must not see mine.
function hiddenAuthorSet(meId) {
  const rows = db.prepare(`
    SELECT blocker_id, blocked_id, kind FROM social_blocks
    WHERE blocker_id = ? OR (blocked_id = ? AND kind = 'block')
  `).all(meId, meId);
  const hidden = new Set();
  for (const r of rows) {
    if (r.blocker_id === meId) hidden.add(r.blocked_id);          // I blocked or muted them
    else if (r.kind === 'block') hidden.add(r.blocker_id);        // they hard-blocked me
  }
  return hidden;
}
function isBlockedEitherWay(a, b) {
  return !!db.prepare(`
    SELECT 1 FROM social_blocks
    WHERE (blocker_id = ? AND blocked_id = ? AND kind = 'block')
       OR (blocker_id = ? AND blocked_id = ? AND kind = 'block')
  `).get(a, b, b, a);
}
// Profile visibility mirror of leaderboard.getMemberProfile's rule: public, or
// self, or MUTUAL follow (one-way follow is not enough to see a private member).
function canViewMember(viewerId, userId) {
  if (viewerId === userId) return true;
  if (isBlockedEitherWay(viewerId ?? -1, userId)) return false;
  if (userIsPublic(userId)) return true;
  if (viewerId == null) return false;
  const iFollow = db.prepare(`SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?`).get(viewerId, userId);
  const followsMe = db.prepare(`SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?`).get(userId, viewerId);
  return !!(iFollow && followsMe);
}

function hideStakesFor(userId) {
  const row = db.prepare(`SELECT hide_stakes FROM user_preferences WHERE user_id = ?`).get(userId);
  return !!(row && row.hide_stakes);
}

// ── Record + streak memo (60s) ────────────────────────────────────────────────
// Feed cards wear each author's all-time record chip; recomputing the full
// aggregation per request would be wasteful, and 60s staleness is invisible.
let _recMemo = { at: 0, byUser: new Map() };
function recordsByUser() {
  const now = Date.now();
  if (now - _recMemo.at > 60_000) {
    _recMemo = { at: now, byUser: aggregate(gradedRows('all')) };
  }
  return _recMemo.byUser;
}
function recordChip(userId) {
  const agg = recordsByUser().get(userId);
  if (!agg) return { wins: 0, losses: 0, pushes: 0, total_votes: 0, win_pct: null, units: 0, roi: null };
  return statify(agg);
}

// Current graded win streak per user: walk results newest-first; pushes skip,
// a loss breaks. Bucketed by grade time so a streak updates when results land.
function currentStreaks(userIds) {
  const out = new Map();
  if (!userIds.length) return out;
  const ph = userIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT user_id, result FROM game_votes
    WHERE user_id IN (${ph}) AND result IN ('win','loss','push')
    ORDER BY COALESCE(graded_at, voted_at) DESC, id DESC
  `).all(...userIds);
  const done = new Set();
  for (const r of rows) {
    if (done.has(r.user_id)) continue;
    if (r.result === 'push') continue;
    if (r.result === 'loss') { done.add(r.user_id); if (!out.has(r.user_id)) out.set(r.user_id, 0); continue; }
    out.set(r.user_id, (out.get(r.user_id) || 0) + 1);
  }
  return out;
}

// ── User meta ─────────────────────────────────────────────────────────────────
function usersMeta(ids) {
  if (!ids.length) return new Map();
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT u.id, u.username, u.avatar_path, COALESCE(up.is_public, 1) AS is_public,
           COALESCE(up.hide_stakes, 0) AS hide_stakes
    FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id
    WHERE u.id IN (${ph})
  `).all(...ids);
  return new Map(rows.map(r => [r.id, r]));
}
function publicUser(meta, streaks) {
  return {
    id: meta.id,
    username: meta.username || `user${meta.id}`,
    avatar_url: meta.avatar_path ? `/avatars/${meta.avatar_path}` : null,
    record: recordChip(meta.id),
    streak: streaks ? (streaks.get(meta.id) || 0) : undefined,
  };
}

// ── Feed ──────────────────────────────────────────────────────────────────────
const FEED_PAGE = 25;

function ts(s) { const t = Date.parse(String(s || '').replace(' ', 'T') + (String(s || '').includes('T') ? '' : 'Z')); return Number.isNaN(t) ? 0 : t; }

// Count of members who tailed a specific member's pick on the same slot.
function tailCount(authorId, espnGameId, slot) {
  return db.prepare(`
    SELECT COUNT(*) c FROM game_votes
    WHERE tail_of_user_id = ? AND espn_game_id = ? AND pick_slot = ?
  `).get(authorId, espnGameId, slot).c;
}

function boostMeta(meId, keys) {
  if (!keys.length) return new Map();
  const ph = keys.map(() => '?').join(',');
  const counts = db.prepare(`
    SELECT subject_key, COUNT(*) c FROM social_reactions WHERE subject_key IN (${ph}) GROUP BY subject_key
  `).all(...keys);
  const mine = meId == null ? [] : db.prepare(`
    SELECT subject_key FROM social_reactions WHERE user_id = ? AND subject_key IN (${ph})
  `).all(meId, ...keys);
  const mineSet = new Set(mine.map(r => r.subject_key));
  const out = new Map(keys.map(k => [k, { count: 0, me: mineSet.has(k) }]));
  for (const r of counts) out.get(r.subject_key).count = r.c;
  return out;
}
function commentCounts(keys) {
  if (!keys.length) return new Map();
  const ph = keys.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT subject_key, COUNT(*) c FROM social_comments WHERE subject_key IN (${ph}) AND deleted = 0 GROUP BY subject_key
  `).all(...keys);
  const out = new Map(keys.map(k => [k, 0]));
  for (const r of rows) out.set(r.subject_key, r.c);
  return out;
}

// The whole feed for one member: their follows (plus themselves), minus blocks,
// private authors only when mutual. Cursor = "<ms>:<key>" of the last item.
function getFeed(meId, { cursor = null, limit = FEED_PAGE } = {}) {
  const followees = followeeIds(meId);
  const authorPool = [...new Set([meId, ...followees])];
  const hidden = hiddenAuthorSet(meId);
  const mutuals = mutualSet(meId);
  const metas = usersMeta(authorPool);
  const authors = authorPool.filter(id => {
    if (hidden.has(id)) return false;
    const m = metas.get(id);
    if (!m) return false;
    if (id === meId) return true;
    return m.is_public === 1 || mutuals.has(id);
  });
  if (!authors.length) return { items: [], nextCursor: null, empty: true };

  const ph = authors.map(() => '?').join(',');

  // Votes: one item per vote; its sort time is the GRADE time once settled so
  // wins/losses resurface when they land. today_games join covers live status
  // for today's items; snapshot columns carry everything after the wipe.
  const votes = db.prepare(`
    SELECT gv.id, gv.user_id, gv.espn_game_id, gv.pick_slot, gv.voted_at, gv.graded_at,
           gv.result, gv.spread, gv.ml_home, gv.ml_away, gv.ou_over_odds, gv.ou_under_odds,
           gv.user_stake, gv.user_odds, gv.tail_of_user_id,
           COALESCE(gv.sport, tg.sport)         AS sport,
           COALESCE(gv.home_team, tg.home_team) AS home_team,
           COALESCE(gv.away_team, tg.away_team) AS away_team,
           tg.status, tg.home_score, tg.away_score, tg.start_time
    FROM game_votes gv
    LEFT JOIN today_games tg ON tg.espn_game_id = gv.espn_game_id
    WHERE gv.user_id IN (${ph})
    ORDER BY COALESCE(gv.graded_at, gv.voted_at) DESC, gv.id DESC
    LIMIT 150
  `).all(...authors);

  // True-stakes ledger entries (manual/custom tracked bets).
  const bets = db.prepare(`
    SELECT id, user_id, bet_type, sport, selection, side, line, odds, stake, units,
           espn_game_id, result, payout, verified, book, notes, placed_at, settled_at,
           home_team, away_team
    FROM user_bets
    WHERE user_id IN (${ph})
    ORDER BY COALESCE(settled_at, placed_at) DESC, id DESC
    LIMIT 80
  `).all(...authors);

  const awards = db.prepare(`
    SELECT id, user_id, period_type, period_key, rank, tier, units, awarded_at
    FROM leaderboard_awards
    WHERE user_id IN (${ph})
    ORDER BY awarded_at DESC LIMIT 25
  `).all(...authors);

  const streaks = currentStreaks(authors);

  const items = [];
  for (const v of votes) {
    const graded = ['win', 'loss', 'push'].includes(v.result);
    items.push({
      key: `vote:${v.id}`, kind: 'vote', _ts: ts(v.graded_at || v.voted_at),
      user_id: v.user_id, created_at: v.voted_at, graded_at: v.graded_at,
      game: {
        espn_game_id: v.espn_game_id, sport: v.sport,
        home_team: v.home_team, away_team: v.away_team,
        status: v.status || (graded ? 'post' : null),
        home_score: v.home_score, away_score: v.away_score, start_time: v.start_time,
      },
      pick: {
        slot: v.pick_slot, spread: v.spread,
        ml_home: v.ml_home, ml_away: v.ml_away,
        ou_over_odds: v.ou_over_odds, ou_under_odds: v.ou_under_odds,
        user_odds: v.user_odds,
      },
      result: graded ? v.result : 'pending',
      units: graded ? +voteReturn(v, 1).toFixed(2) : null,
      verified: true,
      stake: v.user_stake || null, stake_owner: v.user_id,
      tail_of_user_id: v.tail_of_user_id || null,
      tails: tailCount(v.user_id, v.espn_game_id, v.pick_slot),
    });
  }
  for (const b of bets) {
    items.push({
      key: `bet:${b.id}`, kind: 'bet', _ts: ts(b.settled_at || b.placed_at),
      user_id: b.user_id, created_at: b.placed_at,
      game: b.espn_game_id ? {
        espn_game_id: b.espn_game_id, sport: b.sport,
        home_team: b.home_team, away_team: b.away_team,
      } : { sport: b.sport },
      bet: {
        bet_type: b.bet_type, selection: b.selection, side: b.side,
        line: b.line, odds: b.odds, book: b.book, notes: b.notes,
      },
      result: b.result || 'pending',
      units: b.units != null ? +Number(b.units).toFixed(2) : null,
      payout: b.payout, stake: b.stake || null, stake_owner: b.user_id,
      verified: !!b.verified,
    });
  }
  for (const a of awards) {
    items.push({
      key: `award:${a.id}`, kind: 'award', _ts: ts(a.awarded_at),
      user_id: a.user_id, created_at: a.awarded_at,
      award: { period_type: a.period_type, period_key: a.period_key, rank: a.rank, tier: a.tier, units: a.units },
    });
  }

  // One paywall-safe house card per board day: the board is live. No pick
  // details, no scores — the tease links to the Rankings tab.
  try {
    const today = db.prepare(`SELECT COUNT(*) c FROM picks WHERE score > 0`).get().c;
    if (today > 0) {
      const d = new Date();
      const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      items.push({
        key: `house:${day}`, kind: 'house', _ts: ts(`${day} 12:00:00`),
        user_id: null, created_at: `${day} 12:00:00`, house: { pick_count: today },
      });
    }
  } catch (_) {}

  items.sort((a, b) => b._ts - a._ts || (a.key < b.key ? 1 : -1));

  // Cursor paging over the merged list.
  let startIdx = 0;
  if (cursor) {
    const [cms, ckey] = String(cursor).split('~');
    const cmsN = Number(cms);
    startIdx = items.findIndex(it => it._ts < cmsN || (it._ts === cmsN && it.key === ckey));
    if (startIdx < 0) startIdx = items.length;
    else if (items[startIdx] && items[startIdx].key === ckey) startIdx += 1;
  }
  const page = items.slice(startIdx, startIdx + limit);
  const last = page[page.length - 1];
  const nextCursor = (startIdx + limit < items.length && last) ? `${last._ts}~${last.key}` : null;

  // Enrich the page only.
  const keys = page.map(i => i.key);
  const boosts = boostMeta(meId, keys);
  const cmts = commentCounts(keys);
  const hideByOwner = new Map([...metas.values()].map(m => [m.id, !!m.hide_stakes]));

  const out = page.map(i => {
    const o = { ...i };
    delete o._ts;
    if (o.user_id != null) {
      const m = metas.get(o.user_id);
      o.user = m ? publicUser(m, streaks) : { id: o.user_id, username: `user${o.user_id}` };
    }
    // Stake privacy: owners always see their own numbers; others only when the
    // owner shows stakes. Units stay (that is the point of the unit ledger).
    if (o.stake != null && o.stake_owner !== meId && hideByOwner.get(o.stake_owner)) {
      o.stake = null; o.payout = null;
    }
    delete o.stake_owner;
    o.boosts = boosts.get(o.key) || { count: 0, me: false };
    o.comment_count = cmts.get(o.key) || 0;
    delete o.user_id;
    return o;
  });

  return { items: out, nextCursor, streakRail: streakRail(meId, authors, streaks, metas) };
}

// The Clubhouse streak rail: me first, then followed members with a live graded
// win streak, best first.
function streakRail(meId, authors, streaks, metas) {
  const rail = [];
  for (const id of authors) {
    const s = streaks.get(id) || 0;
    if (id !== meId && s < 2) continue;
    const m = metas.get(id);
    if (!m) continue;
    rail.push({ ...publicUser(m, streaks), me: id === meId });
  }
  rail.sort((a, b) => (b.me ? -1 : 0) - (a.me ? -1 : 0) || (b.streak || 0) - (a.streak || 0));
  const me = rail.find(r => r.me);
  const rest = rail.filter(r => !r.me).slice(0, 14);
  return me ? [me, ...rest] : rest;
}

// ── Boosts ────────────────────────────────────────────────────────────────────
const KEY_RE = /^(vote|bet|award|house):[\w.-]+$/;
function subjectExists(key) {
  const [kind, id] = key.split(':');
  if (kind === 'vote')  return !!db.prepare(`SELECT 1 FROM game_votes WHERE id = ?`).get(id);
  if (kind === 'bet')   return !!db.prepare(`SELECT 1 FROM user_bets WHERE id = ?`).get(id);
  if (kind === 'award') return !!db.prepare(`SELECT 1 FROM leaderboard_awards WHERE id = ?`).get(id);
  if (kind === 'house') return /^\d{4}-\d{2}-\d{2}$/.test(id);
  return false;
}
function subjectOwner(key) {
  const [kind, id] = key.split(':');
  const q = kind === 'vote' ? `SELECT user_id FROM game_votes WHERE id = ?`
          : kind === 'bet' ? `SELECT user_id FROM user_bets WHERE id = ?`
          : kind === 'award' ? `SELECT user_id FROM leaderboard_awards WHERE id = ?` : null;
  if (!q) return null;
  const row = db.prepare(q).get(id);
  return row ? row.user_id : null;
}
function boost(meId, key) {
  if (!KEY_RE.test(key) || !subjectExists(key)) return { error: 'Not found' };
  const owner = subjectOwner(key);
  if (owner != null && !canViewMember(meId, owner)) return { error: 'Not found' };
  db.prepare(`INSERT OR IGNORE INTO social_reactions (user_id, subject_key) VALUES (?, ?)`).run(meId, key);
  const count = db.prepare(`SELECT COUNT(*) c FROM social_reactions WHERE subject_key = ?`).get(key).c;
  return { ok: true, count, me: true, owner };
}
function unboost(meId, key) {
  db.prepare(`DELETE FROM social_reactions WHERE user_id = ? AND subject_key = ?`).run(meId, key);
  const count = db.prepare(`SELECT COUNT(*) c FROM social_reactions WHERE subject_key = ?`).get(key).c;
  return { ok: true, count, me: false };
}

// ── Comments ──────────────────────────────────────────────────────────────────
function listComments(meId, key) {
  if (!KEY_RE.test(key) || !subjectExists(key)) return { comments: [] };
  // Same visibility gate the writers use, so a private member's comment thread is
  // never readable around the route (defense in depth for the /api route guard).
  const owner = subjectOwner(key);
  if (owner != null && !canViewMember(meId, owner)) return { comments: [] };
  const hidden = meId != null ? hiddenAuthorSet(meId) : new Set();
  const rows = db.prepare(`
    SELECT c.id, c.user_id, c.body, c.created_at, u.username, u.avatar_path
    FROM social_comments c JOIN users u ON u.id = c.user_id
    WHERE c.subject_key = ? AND c.deleted = 0
    ORDER BY c.created_at ASC, c.id ASC LIMIT 60
  `).all(key);
  return {
    comments: rows.filter(r => !hidden.has(r.user_id)).map(r => ({
      id: r.id, user_id: r.user_id,
      username: r.username || `user${r.user_id}`,
      avatar_url: r.avatar_path ? `/avatars/${r.avatar_path}` : null,
      body: r.body, created_at: r.created_at, mine: r.user_id === meId,
    })),
  };
}
function addComment(meId, key, body) {
  if (!KEY_RE.test(key) || !subjectExists(key)) return { error: 'Not found' };
  const owner = subjectOwner(key);
  if (owner != null && !canViewMember(meId, owner)) return { error: 'Not found' };
  const text = String(body || '').trim();
  if (!text) return { error: 'Empty comment' };
  if (text.length > COMMENT_MAX) return { error: `Keep it under ${COMMENT_MAX} characters` };
  const recent = db.prepare(`
    SELECT COUNT(*) c FROM social_comments WHERE user_id = ? AND created_at >= datetime('now','-1 hour')
  `).get(meId).c;
  if (recent >= COMMENTS_PER_HOUR) return { error: 'Slow down a little, try again soon' };
  const info = db.prepare(`INSERT INTO social_comments (subject_key, user_id, body) VALUES (?, ?, ?)`).run(key, meId, text);
  return { ok: true, id: info.lastInsertRowid, owner };
}
function deleteComment(meId, commentId, { admin = false } = {}) {
  const row = db.prepare(`SELECT id, user_id FROM social_comments WHERE id = ? AND deleted = 0`).get(commentId);
  if (!row) return { error: 'Not found' };
  if (!admin && row.user_id !== meId) return { error: 'Not yours' };
  db.prepare(`UPDATE social_comments SET deleted = 1, deleted_by = ? WHERE id = ?`)
    .run(admin ? 'admin' : 'author', commentId);
  return { ok: true };
}

// ── Reports + blocks ──────────────────────────────────────────────────────────
function report(meId, { subject_key = null, subject_user = null, reason = '' }) {
  if (subject_key && !KEY_RE.test(subject_key) && !/^comment:\d+$/.test(subject_key)) return { error: 'Bad subject' };
  db.prepare(`INSERT INTO social_reports (reporter_id, subject_key, subject_user, reason) VALUES (?, ?, ?, ?)`)
    .run(meId, subject_key, subject_user, String(reason || '').slice(0, 300));
  return { ok: true };
}
function block(meId, targetId, kind = 'block') {
  if (meId === targetId) return { error: 'That is you' };
  if (!db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(targetId)) return { error: 'Member not found' };
  const k = kind === 'mute' ? 'mute' : 'block';
  db.prepare(`INSERT OR REPLACE INTO social_blocks (blocker_id, blocked_id, kind) VALUES (?, ?, ?)`).run(meId, targetId, k);
  if (k === 'block') {
    // A hard block cuts the graph both ways so neither side lingers in lists.
    db.prepare(`DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)`)
      .run(meId, targetId, targetId, meId);
  }
  return { ok: true };
}
function unblock(meId, targetId) {
  db.prepare(`DELETE FROM social_blocks WHERE blocker_id = ? AND blocked_id = ?`).run(meId, targetId);
  return { ok: true };
}

// ── Member search ─────────────────────────────────────────────────────────────
// Public members always; private members only when already mutual with the
// caller (a private profile should not be discoverable by name).
function searchMembers(meId, q) {
  const term = String(q || '').trim();
  if (term.length < 2) return { members: [] };
  const like = `%${term.replace(/[%_]/g, ch => '\\' + ch)}%`;
  const rows = db.prepare(`
    SELECT u.id, u.username, u.avatar_path, COALESCE(up.is_public, 1) AS is_public,
           COALESCE(up.hide_stakes, 0) AS hide_stakes
    FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id
    WHERE u.username LIKE ? ESCAPE '\\' AND u.id != ?
    ORDER BY LENGTH(u.username) ASC LIMIT 24
  `).all(like, meId ?? -1);
  const hidden = meId != null ? hiddenAuthorSet(meId) : new Set();
  const mutuals = meId != null ? mutualSet(meId) : new Set();
  const following = new Set(meId != null ? followeeIds(meId) : []);
  const streaks = currentStreaks(rows.map(r => r.id));
  const members = rows
    .filter(r => !hidden.has(r.id) && (r.is_public === 1 || mutuals.has(r.id)))
    .slice(0, 12)
    .map(r => ({
      ...publicUser(r, streaks),
      is_public: r.is_public,
      is_following: following.has(r.id) ? 1 : 0,
      mutual: mutuals.has(r.id) ? 1 : 0,
    }));
  return { members };
}

// ── Suggested members (Friends tab rails) ─────────────────────────────────────
// Global candidate lists cached 2 min; per-caller filtering (self, followed,
// hidden) applied on read. Public members only.
let _suggestMemo = { at: 0, hot: [], top: [], followed: [] };
function rebuildSuggested() {
  const pubs = db.prepare(`
    SELECT u.id, u.username, u.avatar_path, COALESCE(up.is_public, 1) AS is_public
    FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id
    WHERE COALESCE(up.is_public, 1) = 1
  `).all();
  const pubIds = pubs.map(p => p.id);
  const metas = new Map(pubs.map(p => [p.id, p]));
  const streaks = currentStreaks(pubIds);

  const hot = pubIds
    .map(id => ({ id, streak: streaks.get(id) || 0 }))
    .filter(x => x.streak >= 3)
    .sort((a, b) => b.streak - a.streak)
    .slice(0, 14)
    .map(x => publicUser(metas.get(x.id), streaks));

  let top = [];
  try {
    top = getLeaderboard('week', null).rows
      .filter(r => !r.is_house && r.user_id != null && metas.has(r.user_id))
      .slice(0, 14)
      .map(r => ({ ...publicUser(metas.get(r.user_id), streaks), week_units: r.units, week_rank: r.rank }));
  } catch (_) {}

  const followed = db.prepare(`
    SELECT followee_id AS id, COUNT(*) c FROM follows GROUP BY followee_id ORDER BY c DESC LIMIT 30
  `).all()
    .filter(r => metas.has(r.id))
    .slice(0, 14)
    .map(r => ({ ...publicUser(metas.get(r.id), streaks), followers: r.c }));

  _suggestMemo = { at: Date.now(), hot, top, followed };
}
function getSuggested(meId) {
  if (Date.now() - _suggestMemo.at > 120_000) rebuildSuggested();
  const skip = new Set([meId, ...followeeIds(meId)]);
  const hidden = hiddenAuthorSet(meId);
  const keep = u => !skip.has(u.id) && !hidden.has(u.id);
  return {
    hot_streaks: _suggestMemo.hot.filter(keep).slice(0, 8),
    top_week: _suggestMemo.top.filter(keep).slice(0, 8),
    most_followed: _suggestMemo.followed.filter(keep).slice(0, 8),
  };
}

// ── Profile extras: profit calendar + true history ────────────────────────────
// Calendar: last ~5 weeks of daily net units from graded verified picks,
// bucketed by grade day (a pick realizes when it grades, matching the P/L rule).
function profitCalendar(userId) {
  const rows = db.prepare(`
    SELECT COALESCE(graded_at, voted_at) AS t, pick_slot, result,
           ml_home, ml_away, ou_over_odds, ou_under_odds
    FROM game_votes
    WHERE user_id = ? AND result IN ('win','loss','push')
      AND COALESCE(graded_at, voted_at) >= datetime('now','-36 days')
  `).all(userId);
  const byDay = new Map();
  for (const r of rows) {
    const day = String(r.t || '').slice(0, 10);
    if (!day) continue;
    byDay.set(day, +( (byDay.get(day) || 0) + voteReturn(r, 1) ).toFixed(2));
  }
  return [...byDay.entries()].map(([date, units]) => ({ date, units })).sort((a, b) => a.date < b.date ? -1 : 1);
}

// True history: verified picks (votes, with the member's real stake when they
// attached one) merged with tracked bets (user_bets, verified flag decides the
// chip). Dollar figures respect hide_stakes for non-owner viewers.
function trueHistory(userId, viewerId) {
  const hide = viewerId !== userId && hideStakesFor(userId);
  const votes = db.prepare(`
    SELECT id, espn_game_id, pick_slot, voted_at, graded_at, result, spread,
           ml_home, ml_away, ou_over_odds, ou_under_odds, user_stake, user_odds,
           sport, home_team, away_team
    FROM game_votes WHERE user_id = ?
    ORDER BY COALESCE(graded_at, voted_at) DESC, id DESC LIMIT 80
  `).all(userId);
  const bets = db.prepare(`
    SELECT id, bet_type, sport, selection, side, line, odds, stake, units, book,
           espn_game_id, result, payout, verified, placed_at, settled_at, home_team, away_team
    FROM user_bets WHERE user_id = ?
    ORDER BY COALESCE(settled_at, placed_at) DESC, id DESC LIMIT 80
  `).all(userId);

  const rows = [];
  for (const v of votes) {
    const graded = ['win', 'loss', 'push'].includes(v.result);
    rows.push({
      kind: 'vote', id: v.id, _ts: ts(v.graded_at || v.voted_at),
      sport: v.sport, home_team: v.home_team, away_team: v.away_team,
      espn_game_id: v.espn_game_id,
      slot: v.pick_slot, spread: v.spread,
      ml_home: v.ml_home, ml_away: v.ml_away,
      ou_over_odds: v.ou_over_odds, ou_under_odds: v.ou_under_odds,
      odds: v.user_odds || null,
      stake: hide ? null : (v.user_stake || null),
      result: graded ? v.result : 'pending',
      units: graded ? +voteReturn(v, 1).toFixed(2) : null,
      verified: true, at: v.voted_at,
    });
  }
  for (const b of bets) {
    rows.push({
      kind: 'bet', id: b.id, _ts: ts(b.settled_at || b.placed_at),
      sport: b.sport, home_team: b.home_team, away_team: b.away_team,
      espn_game_id: b.espn_game_id,
      selection: b.selection, side: b.side, bet_type: b.bet_type, line: b.line,
      odds: b.odds, book: b.book,
      stake: hide ? null : (b.stake || null),
      payout: hide ? null : (b.payout != null ? b.payout : null),
      result: b.result || 'pending',
      units: b.units != null ? +Number(b.units).toFixed(2) : null,
      verified: !!b.verified, at: b.placed_at,
    });
  }
  rows.sort((a, b) => b._ts - a._ts);
  return { hide_stakes: hide, rows: rows.slice(0, 120).map(r => { const o = { ...r }; delete o._ts; return o; }) };
}

function getMemberExtras(userId, viewerId) {
  if (!canViewMember(viewerId, userId)) return { error: 'private' };
  const streaks = currentStreaks([userId]);
  return {
    calendar: profitCalendar(userId),
    history: trueHistory(userId, viewerId),
    streak: streaks.get(userId) || 0,
    blocked: viewerId != null && viewerId !== userId
      ? !!db.prepare(`SELECT 1 FROM social_blocks WHERE blocker_id = ? AND blocked_id = ?`).get(viewerId, userId)
      : false,
  };
}

module.exports = {
  getFeed, boost, unboost,
  listComments, addComment, deleteComment,
  report, block, unblock,
  searchMembers, getSuggested, getMemberExtras,
  canViewMember, currentStreaks,
};
