// src/leaderboard.js
// Member leaderboard + profile aggregates, computed off game_votes (+ users,
// user_preferences). The CappingAlpha "house" row is computed off mvp_picks with
// the same units math. Achievement badges come from leaderboard_awards, populated
// by an idempotent, self-healing finalize pass over completed calendar periods.
//
// Units are computed in JS (not SQL) so the math stays identical to the frontend
// payout helper in public/modules/utils.js (American odds, slot→odds branching).

const db = require('./db');
const { MVP_THRESHOLD } = require('./scoring');

// Minimum decided (win+loss) votes to qualify per window. Longer windows demand a
// bigger sample so a hot week can't fluke onto the all-time board.
const MIN_BY_WINDOW = { week: 7, month: 10, all: 25 };
function minVotes(window) { return MIN_BY_WINDOW[window] ?? 10; }
const HOUSE_NAME = 'CappingAlpha';

// ── Payout math (server mirror of utils.calcVoteReturn) ───────────────────────
function voteOdds(v) {
  const s = v.pick_slot;
  if (s === 'home_ml') return v.ml_home || null;
  if (s === 'away_ml') return v.ml_away || null;
  if (s === 'over')    return v.ou_over_odds  || -115;
  if (s === 'under')   return v.ou_under_odds || -115;
  return -115; // spreads: no juice stored, default -115
}

function voteReturn(v, unit = 1) {
  const r = (v.result || '').toLowerCase();
  if (r === 'push' || r === 'pending' || !r) return 0;
  if (r === 'loss') return -unit;
  const odds = voteOdds(v) || -115;
  return odds < 0 ? unit * (100 / Math.abs(odds)) : unit * (odds / 100);
}

// ── Window clauses ────────────────────────────────────────────────────────────
// Rolling windows for the live board (week = last 7d, month = last 30d).
function votesWindowClause(window) {
  if (window === 'week')  return `AND gv.voted_at >= datetime('now','-7 days')`;
  if (window === 'month') return `AND gv.voted_at >= datetime('now','-30 days')`;
  return '';
}
function houseWindowClause(window) {
  if (window === 'week')  return `AND date(game_date) >= date('now','-7 days')`;
  if (window === 'month') return `AND date(game_date) >= date('now','-30 days')`;
  return '';
}

// ── Aggregation ───────────────────────────────────────────────────────────────
function gradedRows(window) {
  return db.prepare(`
    SELECT gv.user_id, gv.pick_slot, gv.result,
           gv.ml_home, gv.ml_away, gv.ou_over_odds, gv.ou_under_odds
    FROM game_votes gv
    WHERE gv.result IN ('win','loss','push')
      ${votesWindowClause(window)}
  `).all();
}

function gradedRowsBetween(startIso, endIso) {
  return db.prepare(`
    SELECT gv.user_id, gv.pick_slot, gv.result,
           gv.ml_home, gv.ml_away, gv.ou_over_odds, gv.ou_under_odds
    FROM game_votes gv
    WHERE gv.result IN ('win','loss','push')
      AND gv.voted_at >= ? AND gv.voted_at < ?
  `).all(startIso, endIso);
}

// rows → Map<user_id, {wins,losses,pushes,units,risked}>
function aggregate(rows) {
  const byUser = new Map();
  for (const v of rows) {
    let u = byUser.get(v.user_id);
    if (!u) { u = { wins: 0, losses: 0, pushes: 0, units: 0, risked: 0 }; byUser.set(v.user_id, u); }
    if (v.result === 'win') u.wins++;
    else if (v.result === 'loss') u.losses++;
    else u.pushes++;
    if (v.result === 'win' || v.result === 'loss') u.risked += 1;
    u.units += voteReturn(v, 1);
  }
  return byUser;
}

function statify(agg) {
  const decided = agg.wins + agg.losses;
  return {
    wins: agg.wins, losses: agg.losses, pushes: agg.pushes,
    total_votes: agg.wins + agg.losses + agg.pushes,
    win_pct: decided ? +(100 * agg.wins / decided).toFixed(1) : null,
    units: +agg.units.toFixed(2),
    roi: agg.risked ? +(100 * agg.units / agg.risked).toFixed(1) : null,
  };
}

// ── CappingAlpha house rows (from mvp_picks) ──────────────────────────────────
// A small minimum so a sport with only a pick or two doesn't get its own bot.
const HOUSE_SPORT_MIN = 3;

// Aggregate the tracked MVP picks (optionally one sport) into a units record.
function houseAgg(window, sport) {
  const params = sport ? [MVP_THRESHOLD, sport] : [MVP_THRESHOLD];
  const rows = db.prepare(`
    SELECT pick_type, result, ml_odds, ou_odds
    FROM mvp_picks
    WHERE score >= ? AND (result IS NULL OR result != 'void')
      AND (annotation IS NULL OR annotation NOT LIKE '%not counted%')
      ${sport ? 'AND sport = ?' : ''}
      ${houseWindowClause(window)}
  `).all(...params);

  const agg = { wins: 0, losses: 0, pushes: 0, units: 0, risked: 0 };
  for (const p of rows) {
    const r = (p.result || '').toLowerCase();
    if (r !== 'win' && r !== 'loss' && r !== 'push') continue; // skip pending
    if (r === 'win') agg.wins++;
    else if (r === 'loss') agg.losses++;
    else agg.pushes++;
    const type = (p.pick_type || '').toLowerCase();
    const odds = (type === 'ml') ? (p.ml_odds || -115)
               : (type === 'over' || type === 'under') ? (p.ou_odds || -115)
               : -115;
    if (r === 'win') { agg.units += odds < 0 ? (100 / Math.abs(odds)) : (odds / 100); agg.risked += 1; }
    else if (r === 'loss') { agg.units += -1; agg.risked += 1; }
  }
  return agg;
}

// The house bots: a combined "CappingAlpha" plus one "CappingAlpha {SPORT}" per
// sport we track (filtered MVP performance). They fill the board automatically and
// are always present (the combined one) / present once a sport has enough picks.
function houseEntries(window) {
  const entries = [{
    user_id: null, username: HOUSE_NAME, is_house: 1, sport: null, is_public: 1,
    ...statify(houseAgg(window, null)),
  }];

  const sports = db.prepare(`
    SELECT DISTINCT sport FROM mvp_picks
    WHERE score >= ? AND (result IS NULL OR result != 'void') AND sport IS NOT NULL
      ${houseWindowClause(window)}
  `).all(MVP_THRESHOLD).map(r => r.sport).filter(Boolean);

  for (const sp of sports) {
    const agg = houseAgg(window, sp);
    if (agg.wins + agg.losses < HOUSE_SPORT_MIN) continue;
    entries.push({
      user_id: null, username: `${HOUSE_NAME} ${sp}`, is_house: 1, sport: sp, is_public: 1,
      ...statify(agg),
    });
  }
  return entries;
}

// ── Ranking ───────────────────────────────────────────────────────────────────
const SORT = (a, b) =>
  b.units - a.units ||
  (b.roi ?? -1e9) - (a.roi ?? -1e9) ||
  (b.win_pct ?? -1) - (a.win_pct ?? -1) ||
  b.total_votes - a.total_votes ||
  ((a.user_id ?? 1e9) - (b.user_id ?? 1e9));

// Full qualifying population for a window: members ≥ MIN_RESOLVED_VOTES plus the
// always-present house row, ranked together by units.
function rankAll(window) {
  const byUser = aggregate(gradedRows(window));
  const userMeta = db.prepare(`
    SELECT u.id AS user_id, u.username, COALESCE(up.is_public, 1) AS is_public
    FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id
  `).all();
  const metaById = new Map(userMeta.map(m => [m.user_id, m]));

  const members = [];
  for (const [uid, agg] of byUser.entries()) {
    if (agg.wins + agg.losses < minVotes(window)) continue;
    const meta = metaById.get(uid) || {};
    members.push({
      user_id: uid,
      username: meta.username || `user${uid}`,
      is_public: meta.is_public == null ? 1 : meta.is_public,
      is_house: 0,
      ...statify(agg),
    });
  }

  const ranked = [...members, ...houseEntries(window)].sort(SORT);
  ranked.forEach((u, i) => { u.rank = i + 1; });
  return ranked;
}

// Public board for a window + the caller's own row (even if private/unqualified).
function getLeaderboard(window, meId) {
  const w = ['week', 'month', 'all'].includes(window) ? window : 'week';
  const ranked = rankAll(w);

  const rows = ranked
    .filter(u => u.is_house || u.is_public === 1)
    .map(u => ({
      rank: u.rank, user_id: u.user_id, username: u.username,
      is_house: u.is_house ? 1 : 0, sport: u.sport || null,
      wins: u.wins, losses: u.losses, pushes: u.pushes, total_votes: u.total_votes,
      win_pct: u.win_pct, units: u.units, roi: u.roi,
      is_me: meId != null && u.user_id === meId,
    }));

  let me = null;
  if (meId != null) {
    const mine = ranked.find(u => u.user_id === meId);
    const isPublic = userIsPublic(meId);
    if (mine) {
      me = { ...mine, is_me: true, qualified: true, is_public: isPublic };
    } else {
      const agg = aggregate(gradedRows(w)).get(meId);
      const s = agg ? statify(agg) : { wins: 0, losses: 0, pushes: 0, total_votes: 0, win_pct: null, units: 0, roi: null };
      me = {
        rank: null, qualified: false, is_me: true, is_public: isPublic,
        user_id: meId, username: usernameFor(meId),
        ...s,
        needed: Math.max(0, minVotes(w) - (s.wins + s.losses)),
      };
    }
  }

  const topOfWeek = w === 'week' ? (rows.find(r => !r.is_house) || null) : null;
  return { window: w, scope: 'all', rows, me, topOfWeek, min_votes: minVotes(w) };
}

// ── Follows (one-way, Twitter style) ──────────────────────────────────────────
function followeeIds(userId) {
  if (userId == null) return [];
  return db.prepare(`SELECT followee_id FROM follows WHERE follower_id = ?`).all(userId).map(r => r.followee_id);
}
function isFollowing(a, b) {
  if (a == null || b == null) return false;
  return !!db.prepare(`SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?`).get(a, b);
}
function followCounts(userId) {
  const followers = db.prepare(`SELECT COUNT(*) c FROM follows WHERE followee_id = ?`).get(userId).c;
  const following = db.prepare(`SELECT COUNT(*) c FROM follows WHERE follower_id = ?`).get(userId).c;
  return { followers, following };
}

// Friends directory: the members you follow, with their all-time record so the
// list reads as a quick roster. No threshold, no bots, private follows kept (a
// member you follow stays visible to you after going private). Sorted best-first;
// each entry is clickable through to the full profile popup. Excludes yourself.
function getFriendsList(meId) {
  if (meId == null) return { friends: [], count: 0, logged_out: true };
  const ids = followeeIds(meId);
  if (!ids.length) return { friends: [], count: 0 };

  const byUser = aggregate(gradedRows('all')); // all-time stats
  const myFollowers = new Set(
    db.prepare(`SELECT follower_id FROM follows WHERE followee_id = ?`).all(meId).map(r => r.follower_id)
  );
  const ph = ids.map(() => '?').join(',');
  const meta = db.prepare(`
    SELECT u.id AS user_id, u.username, u.avatar_path, COALESCE(up.is_public, 1) AS is_public
    FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id
    WHERE u.id IN (${ph})
  `).all(...ids);

  const friends = meta.map(m => {
    const agg = byUser.get(m.user_id) || { wins: 0, losses: 0, pushes: 0, units: 0, risked: 0 };
    return {
      user_id: m.user_id,
      username: m.username || `user${m.user_id}`,
      avatar_url: m.avatar_path ? `/avatars/${m.avatar_path}` : null,
      is_public: m.is_public == null ? 1 : m.is_public,
      mutual: myFollowers.has(m.user_id),
      ...statify(agg),
    };
  }).sort(SORT);

  return { friends, count: friends.length };
}

function userIsPublic(userId) {
  const row = db.prepare(`SELECT is_public FROM user_preferences WHERE user_id = ?`).get(userId);
  return row ? (row.is_public == null ? 1 : row.is_public) : 1;
}
function usernameFor(userId) {
  const row = db.prepare(`SELECT username FROM users WHERE id = ?`).get(userId);
  return (row && row.username) || `user${userId}`;
}

// ── Member profile ────────────────────────────────────────────────────────────
// All of a member's votes within a window (oldest → newest), enriched with units.
function memberWindowVotes(userId, window) {
  const clause = window === 'week'  ? `AND gv.voted_at >= datetime('now','-7 days')`
               : window === 'month' ? `AND gv.voted_at >= datetime('now','-30 days')`
               : '';
  const rows = db.prepare(`
    SELECT gv.espn_game_id, gv.pick_slot, gv.result, gv.voted_at,
           COALESCE(gv.sport, tg.sport)         AS sport,
           COALESCE(gv.home_team, tg.home_team) AS home_team,
           COALESCE(gv.away_team, tg.away_team) AS away_team,
           gv.ml_home, gv.ml_away, gv.ou_over_odds, gv.ou_under_odds, gv.spread,
           tg.status, tg.home_score, tg.away_score
    FROM game_votes gv
    LEFT JOIN today_games tg ON tg.espn_game_id = gv.espn_game_id
    WHERE gv.user_id = ? ${clause}
    ORDER BY gv.voted_at ASC
  `).all(userId);
  return rows.map(r => ({ ...r, units: +voteReturn(r, 1).toFixed(2) }));
}

// Window-scoped record/units + a cumulative-units chart series + the recent-pick
// list (newest first). Everything reflects the window the profile was opened from.
function memberWindowData(userId, window) {
  const votes = memberWindowVotes(userId, window);
  const graded = votes.filter(v => ['win', 'loss', 'push'].includes(v.result));
  const agg = aggregate(graded.map(v => ({ user_id: userId, ...v }))).get(userId)
            || { wins: 0, losses: 0, pushes: 0, units: 0, risked: 0 };

  // Cumulative units over graded picks, chronological — points for a P/L line.
  let cum = 0;
  const chart = graded.map((v, i) => {
    cum = +(cum + voteReturn(v, 1)).toFixed(2);
    return { i: i + 1, cum, ret: v.units, result: v.result };
  });

  return {
    stats: statify(agg),
    chart,
    recentPicks: votes.slice().reverse(), // newest first
  };
}

function memberBadges(userId) {
  const rows = db.prepare(`
    SELECT period_type, tier, COUNT(*) AS c
    FROM leaderboard_awards WHERE user_id = ?
    GROUP BY period_type, tier
  `).all(userId);
  const blank = () => ({ total: 0, week: 0, month: 0 });
  const out = { gold: blank(), silver: blank(), bronze: blank() };
  for (const r of rows) {
    const tier = out[r.tier];
    if (!tier) continue;
    tier.total += r.c;
    if (r.period_type === 'week') tier.week += r.c;
    else if (r.period_type === 'month') tier.month += r.c;
  }
  return out;
}

// Full profile payload. Returns { error:'private' } when a non-owner requests a
// private member (caller maps that to 403), or null when the user doesn't exist.
function getMemberProfile(userId, meId, window) {
  const w = ['week', 'month', 'all'].includes(window) ? window : 'all';
  const user = db.prepare(`SELECT id, username, avatar_path, created_at FROM users WHERE id = ?`).get(userId);
  if (!user) return null;
  const isPublic = userIsPublic(userId);
  const isMe = meId != null && meId === userId;
  const iFollow = isFollowing(meId, userId);   // I follow them
  const followsMe = isFollowing(userId, meId); // they follow me
  // A private member stays visible to people who already follow them (and to self).
  if (!isPublic && !isMe && !iFollow) return { error: 'private' };

  const { stats, chart, recentPicks } = memberWindowData(userId, w);
  const counts = followCounts(userId);
  return {
    user: {
      id: user.id,
      username: user.username || `user${user.id}`,
      avatar_url: user.avatar_path ? `/avatars/${user.avatar_path}` : null,
      created_at: user.created_at,
      is_me: isMe,
      is_public: isPublic,
      is_following: iFollow,
      follows_me: followsMe,
      followers: counts.followers,
      following: counts.following,
    },
    window: w,
    stats,
    chart,
    badges: memberBadges(userId),
    recentPicks,
  };
}

// ── Achievement awards (self-healing finalize) ────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }

// Monday 00:00 UTC of the week containing d.
function mondayOf(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  x.setUTCDate(x.getUTCDate() - dow);
  return x;
}
function isoWeekKey(monday) {
  // monday is the Monday of the week; ISO week = week of its Thursday.
  const thu = new Date(monday);
  thu.setUTCDate(thu.getUTCDate() + 3);
  const firstThu = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const firstThuMon = mondayOf(firstThu);
  const week = 1 + Math.round((thu - firstThuMon) / (7 * 86400000));
  return `${thu.getUTCFullYear()}-W${pad2(week)}`;
}
// SQLite UTC datetime string "YYYY-MM-DD HH:MM:SS".
function sqlTs(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function rankBandTier(rank) {
  if (rank === 1) return 'gold';
  if (rank <= 5) return 'silver';
  if (rank <= 10) return 'bronze';
  return null;
}

// Rank members (no house) within an explicit window and return the top 10. `min`
// is the per-period qualification threshold (week vs month).
function topMembersBetween(startIso, endIso, min) {
  const byUser = aggregate(gradedRowsBetween(startIso, endIso));
  const members = [];
  for (const [uid, agg] of byUser.entries()) {
    if (agg.wins + agg.losses < min) continue;
    members.push({ user_id: uid, ...statify(agg) });
  }
  members.sort(SORT);
  return members.slice(0, 10);
}

function insertAwards(periodType, periodKey, top) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO leaderboard_awards (user_id, period_type, period_key, rank, tier, units)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    rows.forEach((m, i) => {
      const rank = i + 1;
      const tier = rankBandTier(rank);
      if (!tier) return;
      stmt.run(m.user_id, periodType, periodKey, rank, tier, m.units);
    });
  });
  tx(top);
}

// Idempotent: enumerate every COMPLETED calendar week (Mon–Sun) and month from the
// earliest graded vote to now, skip any period already present, and award top 10.
// Safe to call on startup and daily — a missed run self-heals on the next call.
function finalizeLeaderboardAwards() {
  const first = db.prepare(`SELECT MIN(voted_at) AS m FROM game_votes WHERE result IN ('win','loss','push')`).get();
  if (!first || !first.m) return { weeks: 0, months: 0 };
  const start = new Date(String(first.m).replace(' ', 'T') + 'Z');
  if (isNaN(start)) return { weeks: 0, months: 0 };
  const now = new Date();

  const haveWeek = new Set(db.prepare(`SELECT DISTINCT period_key FROM leaderboard_awards WHERE period_type='week'`).all().map(r => r.period_key));
  const haveMonth = new Set(db.prepare(`SELECT DISTINCT period_key FROM leaderboard_awards WHERE period_type='month'`).all().map(r => r.period_key));

  let weeks = 0, months = 0;

  // Weeks: iterate Mondays; a week is complete once its end (next Monday) ≤ now.
  for (let m = mondayOf(start); ; m.setUTCDate(m.getUTCDate() + 7)) {
    const weekEnd = new Date(m); weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
    if (weekEnd > now) break;
    const key = isoWeekKey(m);
    if (!haveWeek.has(key)) {
      insertAwards('week', key, topMembersBetween(sqlTs(m), sqlTs(weekEnd), MIN_BY_WINDOW.week));
      weeks++;
    }
  }

  // Months: iterate first-of-month; complete once the next month's start ≤ now.
  for (let mo = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); ; mo.setUTCMonth(mo.getUTCMonth() + 1)) {
    const monEnd = new Date(Date.UTC(mo.getUTCFullYear(), mo.getUTCMonth() + 1, 1));
    if (monEnd > now) break;
    const key = `${mo.getUTCFullYear()}-${pad2(mo.getUTCMonth() + 1)}`;
    if (!haveMonth.has(key)) {
      insertAwards('month', key, topMembersBetween(sqlTs(mo), sqlTs(monEnd), MIN_BY_WINDOW.month));
      months++;
    }
  }

  if (weeks || months) console.log(`[leaderboard] finalized awards: ${weeks} week(s), ${months} month(s)`);
  return { weeks, months };
}

module.exports = {
  MIN_BY_WINDOW,
  getLeaderboard,
  getMemberProfile,
  getFriendsList,
  followCounts,
  finalizeLeaderboardAwards,
};
