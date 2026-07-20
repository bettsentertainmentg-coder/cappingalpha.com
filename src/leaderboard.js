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
const { settledProfit } = require('./odds_math');

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

// Routed through the shared odds_math.settledProfit. Behavior-preserving: we pass
// `voteOdds(v) || -115` so votes keep their -115 missing-odds default (their graded
// history was scored that way), rather than odds_math's -110 manual default.
function voteReturn(v, unit = 1) {
  return settledProfit(v.result, voteOdds(v) || -115, unit);
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
// Optional sport scope for the Socials board filter. 'Tennis' is one button on
// the site but two sports in the data, same convention as the CA sport cards.
const BOARD_SPORTS = ['MLB', 'NBA', 'WNBA', 'NFL', 'NCAAF', 'CBB', 'NHL', 'SOCCER', 'TENNIS', 'ATP', 'WTA'];
function sportScope(sport) {
  if (!sport) return null;
  const s = String(sport).toUpperCase();
  if (!BOARD_SPORTS.includes(s)) return null;
  return s === 'TENNIS' ? ['ATP', 'WTA'] : [s];
}
function sportClause(list) {
  if (!list) return { sql: '', params: [] };
  return { sql: `AND UPPER(COALESCE(gv.sport,'')) IN (${list.map(() => '?').join(',')})`, params: list };
}

function gradedRows(window, sport) {
  const sc = sportClause(sportScope(sport));
  return db.prepare(`
    SELECT gv.user_id, gv.pick_slot, gv.result,
           gv.ml_home, gv.ml_away, gv.ou_over_odds, gv.ou_under_odds
    FROM game_votes gv
    WHERE gv.result IN ('win','loss','push')
      ${votesWindowClause(window)}
      ${sc.sql}
  `).all(...sc.params);
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

// The house record must show the SAME population as the public Track record page
// (/results) and the CA Rankings tab, so the CappingAlpha row on the board never
// disagrees with the record those pages print. Mirrors the threshold logic in
// index.js: tracked tier is 100 on the v3 scale (old 65 rescaled), otherwise the
// admin-set display threshold on the v2 scale.
function houseThreshold() {
  if (db.getSetting('scoring_version', 'v2') === 'v3') return 100;
  const t = parseInt(db.getSetting('mvp_display_threshold', MVP_THRESHOLD), 10);
  return Number.isFinite(t) ? t : MVP_THRESHOLD;
}

// Aggregate the tracked MVP picks (optionally one sport) into a units record.
function houseAgg(window, sport) {
  const params = sport ? [houseThreshold(), sport] : [houseThreshold()];
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
  `).all(houseThreshold()).map(r => r.sport).filter(Boolean);

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

// Full qualifying population for a window, ranked together by units. Options:
//   sport      — scope every record to one sport (Socials board filter)
//   friendsSet — the friends board: show EVERY followed member (+ self) with NO
//                minimum (a member with zero graded picks rides a 0-0 / 0u row),
//                and ONLY the one combined CappingAlpha house row (Jack, 2026-07-17:
//                everyone effectively follows the main house; the per-sport CA bots
//                are dropped here). The public board keeps the min-votes gate + the
//                full house set.
function rankAll(window, opts = {}) {
  const byUser = aggregate(gradedRows(window, opts.sport));
  const userMeta = db.prepare(`
    SELECT u.id AS user_id, u.username, COALESCE(up.is_public, 1) AS is_public
    FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id
  `).all();
  const metaById = new Map(userMeta.map(m => [m.user_id, m]));

  const mkMember = (uid, agg) => ({
    user_id: uid,
    username: (metaById.get(uid) || {}).username || `user${uid}`,
    is_public: (metaById.get(uid) || {}).is_public == null ? 1 : (metaById.get(uid) || {}).is_public,
    is_house: 0,
    ...statify(agg),
  });

  const members = [];
  if (opts.friendsSet) {
    // Every followed member (+ self), no minimum — build from the follow set so a
    // friend with no graded picks still appears.
    const zero = { wins: 0, losses: 0, pushes: 0, units: 0, risked: 0 };
    for (const uid of opts.friendsSet) {
      if (uid == null || !metaById.has(uid)) continue;
      members.push(mkMember(uid, byUser.get(uid) || zero));
    }
  } else {
    for (const [uid, agg] of byUser.entries()) {
      if (agg.wins + agg.losses < minVotes(window)) continue;
      members.push(mkMember(uid, agg));
    }
  }

  // House rows: friends board = the combined main CappingAlpha only; a sport-scoped
  // public board = that sport's CA bots; the plain public board = the full set.
  const sportList = sportScope(opts.sport);
  let house;
  if (opts.friendsSet) house = houseEntries(window).filter(e => !e.sport);
  else if (sportList)  house = houseEntries(window).filter(e => e.sport && sportList.includes(String(e.sport).toUpperCase()));
  else                 house = houseEntries(window);

  const ranked = [...members, ...house].sort(SORT);
  ranked.forEach((u, i) => { u.rank = i + 1; });
  return ranked;
}

// Public board for a window + the caller's own row (even if private/unqualified).
// opts: { scope: 'all' | 'friends', sport: string|null } (Socials board filters).
function getLeaderboard(window, meId, opts = {}) {
  const w = ['week', 'month', 'all'].includes(window) ? window : 'week';
  const scope = opts.scope === 'friends' && meId != null ? 'friends' : 'all';
  // Friends board membership: yourself + the members you follow, but a PRIVATE
  // member only counts as a friend when you both follow each other (mutual). A
  // private member you follow one-way stays hidden — same rule the feed and the
  // profile popup enforce, so their picks show to their friends and nobody else.
  let friendsSet = null;
  if (scope === 'friends') {
    const myFollowers = new Set(db.prepare(`SELECT follower_id FROM follows WHERE followee_id = ?`).all(meId).map(r => r.follower_id));
    friendsSet = new Set([meId]);
    for (const fid of followeeIds(meId)) {
      if (userIsPublic(fid) || myFollowers.has(fid)) friendsSet.add(fid);
    }
  }
  const ranked = rankAll(w, { sport: opts.sport, friendsSet });

  // Who the caller already follows — lets the board render inline Follow buttons.
  const followed = meId != null ? new Set(followeeIds(meId)) : new Set();

  // Public board: house + public members, plus the caller's OWN row even when it's
  // private. Other people's private rows stay hidden; the caller-only inclusion is
  // safe because this is filtered per-request against meId. Friends scope keeps
  // private FOLLOWEES visible to this caller (the friends directory precedent:
  // a member you follow stays visible to you after going private).
  const rows = ranked
    .filter(u => u.is_house || u.is_public === 1 || (meId != null && u.user_id === meId)
              || (friendsSet != null && u.user_id != null && friendsSet.has(u.user_id)))
    .map(u => ({
      rank: u.rank, user_id: u.user_id, username: u.username,
      is_house: u.is_house ? 1 : 0, sport: u.sport || null,
      is_public: u.is_house ? 1 : (u.is_public == null ? 1 : u.is_public),
      wins: u.wins, losses: u.losses, pushes: u.pushes, total_votes: u.total_votes,
      win_pct: u.win_pct, units: u.units, roi: u.roi,
      is_me: meId != null && u.user_id === meId,
      is_following: !u.is_house && followed.has(u.user_id) ? 1 : 0,
    }));

  let me = null;
  if (meId != null) {
    const mine = ranked.find(u => u.user_id === meId);
    const isPublic = userIsPublic(meId);
    if (mine) {
      me = { ...mine, is_me: true, qualified: true, is_public: isPublic };
    } else {
      const agg = aggregate(gradedRows(w, opts.sport)).get(meId);
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
  return {
    window: w, scope, sport: sportScope(opts.sport) ? opts.sport : null,
    rows, me, topOfWeek,
    min_votes: scope === 'friends' ? 0 : minVotes(w),
  };
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
    const isPub  = m.is_public == null ? 1 : m.is_public;
    const mutual = myFollowers.has(m.user_id);
    const base = {
      user_id: m.user_id,
      username: m.username || `user${m.user_id}`,
      avatar_url: m.avatar_path ? `/avatars/${m.avatar_path}` : null,
      is_public: isPub,
      mutual,
    };
    // A private member exposes their record only to a mutual follow, matching
    // getMemberProfile. A one-way follow keeps the row but not the numbers.
    if (!isPub && !mutual) {
      return { ...base, private_hidden: true, ...statify({ wins: 0, losses: 0, pushes: 0, units: 0, risked: 0 }) };
    }
    const agg = byUser.get(m.user_id) || { wins: 0, losses: 0, pushes: 0, units: 0, risked: 0 };
    return { ...base, ...statify(agg) };
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
           gv.closing_odds, gv.user_odds,
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

  // Closing Line Value: how often the member's number beat where the line closed.
  // ml + totals only (spread closing juice isn't stored). Odds taken = user_odds
  // when they wagered, else the CA slot odds captured on the vote.
  const impl = o => (o < 0 ? (-o) / (-o + 100) : 100 / (o + 100));
  let clvGood = 0, clvN = 0, clvSum = 0;
  for (const v of votes) {
    if (v.closing_odds == null) continue;
    let taken = v.user_odds;
    if (taken == null) {
      if (v.pick_slot === 'home_ml') taken = v.ml_home;
      else if (v.pick_slot === 'away_ml') taken = v.ml_away;
      else if (v.pick_slot === 'over') taken = v.ou_over_odds;
      else if (v.pick_slot === 'under') taken = v.ou_under_odds;
      else continue; // spread
    }
    if (taken == null) continue;
    const d = impl(v.closing_odds) - impl(taken); // > 0 => beat the close
    clvN++; clvSum += d; if (d > 0) clvGood++;
  }
  const clv = { n: clvN, good: clvGood, pct: clvN ? Math.round(100 * clvGood / clvN) : null, avg_cents: clvN ? +(100 * clvSum / clvN).toFixed(1) : null };

  return {
    stats: statify(agg),
    chart,
    clv,
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
  // A private member is visible to self and to MUTUAL follows (friends) only.
  // A one-way follow is not enough: following is instant + approval-free, so a
  // unilateral follow would let anyone bypass the private flag with one click.
  if (!isPublic && !isMe && !(iFollow && followsMe)) return { error: 'private' };

  const { stats, chart, recentPicks, clv } = memberWindowData(userId, w);
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
    clv,
    badges: memberBadges(userId),
    recentPicks,
  };
}

// ── CappingAlpha sport profiles ───────────────────────────────────────────────
// Popup data for a "CappingAlpha {SPORT}" bot — same payload shape as a member
// profile so the frontend renders both through one layout. sport 'all' = the
// combined house record. Tennis is one card on the site but two sports in
// mvp_picks, so it expands to both tours.
const CA_SPORT_ALIASES = { TENNIS: ['ATP', 'WTA'] };

function caSportList(sport) {
  if (!sport || String(sport).toLowerCase() === 'all') return null;
  return CA_SPORT_ALIASES[String(sport).toUpperCase()] || [sport];
}

function mvpOdds(p) {
  const type = (p.pick_type || '').toLowerCase();
  return (type === 'ml') ? (p.ml_odds || -115)
       : (type === 'over' || type === 'under') ? (p.ou_odds || -115)
       : -115;
}

// Tracked picks for a sport set within a window, oldest → newest. Same population
// rule as houseAgg (voids + "not counted" excluded) so the profile's record always
// matches the CappingAlpha rows on the board.
function caProfileRows(window, sports) {
  const clause = sports ? `AND sport IN (${sports.map(() => '?').join(',')})` : '';
  return db.prepare(`
    SELECT id, team, sport, pick_type, spread, game_date, espn_game_id,
           score, result, home_score, away_score, ml_odds, ou_odds,
           home_team, away_team, saved_at, resolved_at
    FROM mvp_picks
    WHERE score >= ? AND (result IS NULL OR result != 'void')
      AND (annotation IS NULL OR annotation NOT LIKE '%not counted%')
      ${clause}
      ${houseWindowClause(window)}
    ORDER BY COALESCE(resolved_at, saved_at) ASC, id ASC
  `).all(houseThreshold(), ...(sports || []));
}

// All-time record per display sport (ATP+WTA folded into Tennis) + combined.
// Powers the sport-card header on the CA Rankings tab in one request.
function getCaSportSummary() {
  const rows = caProfileRows('all', null);
  const blank = () => ({ wins: 0, losses: 0, pushes: 0, units: 0, risked: 0 });
  const all = blank();
  const bySport = new Map();
  for (const p of rows) {
    const r = (p.result || '').toLowerCase();
    if (r !== 'win' && r !== 'loss' && r !== 'push') continue;
    const key = (p.sport === 'ATP' || p.sport === 'WTA') ? 'Tennis' : (p.sport || 'Other');
    if (!bySport.has(key)) bySport.set(key, blank());
    for (const agg of [all, bySport.get(key)]) {
      if (r === 'win') { agg.wins++; agg.risked++; }
      else if (r === 'loss') { agg.losses++; agg.risked++; }
      else agg.pushes++;
      agg.units += settledProfit(r, mvpOdds(p), 1);
    }
  }
  const sports = {};
  for (const [key, agg] of bySport.entries()) sports[key] = statify(agg);
  return { all: statify(all), sports };
}

// Full profile payload for the popup. Mirrors getMemberProfile's shape; pending
// (ungraded) picks ride along only for paid callers — today's board is paid.
function getCaSportProfile(sport, window, includePending) {
  const w = ['week', 'month', 'all'].includes(window) ? window : 'all';
  const sports = caSportList(sport);
  const rows = caProfileRows(w, sports);

  const agg = { wins: 0, losses: 0, pushes: 0, units: 0, risked: 0 };
  const chart = [];
  const picks = [];
  let cum = 0, i = 0;
  for (const p of rows) {
    const r = (p.result || '').toLowerCase();
    const graded = r === 'win' || r === 'loss' || r === 'push';
    const ret = graded ? +settledProfit(r, mvpOdds(p), 1).toFixed(2) : 0;
    if (graded) {
      if (r === 'win') { agg.wins++; agg.risked++; }
      else if (r === 'loss') { agg.losses++; agg.risked++; }
      else agg.pushes++;
      agg.units += ret;
      cum = +(cum + ret).toFixed(2);
      // Carry the pick fields so the chart tooltip can name the actual pick
      // taken on that date (not a generic "This pick"). d = x-axis date label.
      chart.push({
        i: ++i, cum, ret, result: r, d: p.game_date, sport: p.sport,
        team: p.team, pick_type: p.pick_type, spread: p.spread,
        home_team: p.home_team, away_team: p.away_team,
      });
    }
    if (graded || includePending) {
      picks.push({
        sport: p.sport, team: p.team, pick_type: p.pick_type, spread: p.spread,
        home_team: p.home_team, away_team: p.away_team,
        espn_game_id: p.espn_game_id, game_date: p.game_date,
        result: graded ? r : 'pending', units: ret,
        home_score: p.home_score, away_score: p.away_score,
        score: graded ? p.score : null,
      });
    }
  }

  const firstParams = sports ? [houseThreshold(), ...sports] : [houseThreshold()];
  const first = db.prepare(`
    SELECT MIN(game_date) AS d FROM mvp_picks
    WHERE score >= ? ${sports ? `AND sport IN (${sports.map(() => '?').join(',')})` : ''}
  `).get(...firstParams);

  return {
    house: true,
    sport: sports ? sport : null,
    user: {
      id: null,
      username: sports ? `${HOUSE_NAME} ${sport}` : HOUSE_NAME,
      avatar_url: null,
      created_at: first && first.d ? first.d : null,
      is_me: false, is_public: 1, is_following: 0, follows_me: 0,
      followers: null, following: null, is_house: 1,
    },
    window: w,
    stats: statify(agg),
    chart,
    clv: { n: 0 },
    badges: {
      gold:   { total: 0, week: 0, month: 0 },
      silver: { total: 0, week: 0, month: 0 },
      bronze: { total: 0, week: 0, month: 0 },
    },
    recentPicks: picks.reverse().slice(0, 80), // newest first
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
  getCaSportProfile,
  getCaSportSummary,
  // Shared record math for the Socials layer (src/social.js) — one implementation
  // of the units/record aggregation so feed chips can never drift from the board.
  gradedRows, aggregate, statify, voteOdds, voteReturn, userIsPublic,
};
