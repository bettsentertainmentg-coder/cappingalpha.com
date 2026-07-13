// src/live_alerts.js — content push alerts on the existing web-push pipeline.
// Four alert types, all routed through push.sendOnce (per-user + per-event
// dedupe via push_log) and push topics (per-user preference + paid gating
// enforced in push.js, never here):
//   game_start (free): a game the user voted on / has a pending tracked bet on
//                      just went live.
//   top_pick   (free): once per board day, when today's #1 ranked pick is up.
//   steam      (paid): a sharp pregame line move on a game carrying a CA pick.
//   swing      (paid): a lead change in a live game where the user has action.
// runLiveAlerts() is called from the 5-minute cron (server only) — every read
// here is local SQLite, so a pass costs nothing when there is nothing to send.

const db = require('./db');
const push = require('./push');
const { getCycleDate } = require('./cycle');

// ── Who has action on a game (votes + pending tracked bets + parlay legs) ─────
function usersWithAction(espnGameId) {
  const ids = new Set();
  try {
    for (const r of db.prepare(`SELECT DISTINCT user_id FROM game_votes WHERE espn_game_id = ?`).all(espnGameId)) ids.add(r.user_id);
    for (const r of db.prepare(`SELECT DISTINCT user_id FROM user_bets WHERE espn_game_id = ? AND result = 'pending'`).all(espnGameId)) ids.add(r.user_id);
    for (const r of db.prepare(`SELECT DISTINCT user_id FROM bet_legs WHERE espn_game_id = ? AND result = 'pending'`).all(espnGameId)) ids.add(r.user_id);
  } catch (_) {}
  return [...ids];
}

function matchupLabel(g) {
  return `${g.away_team || 'Away'} @ ${g.home_team || 'Home'}`;
}

// ── game_start: "your game is live now" ──────────────────────────────────────
async function notifyGameStarts() {
  let games = [];
  try {
    games = db.prepare(`SELECT espn_game_id, sport, home_team, away_team FROM today_games WHERE status = 'in'`).all();
  } catch (_) { return; }
  for (const g of games) {
    const users = usersWithAction(g.espn_game_id);
    for (const uid of users) {
      await push.sendOnce(uid, 'game_start', g.espn_game_id, {
        title: 'Your game is live',
        body: `${matchupLabel(g)} just started. Follow it live.`,
        tag: `live-${g.espn_game_id}`,
        url: `/game/${g.espn_game_id}`,
      }).catch(() => {});
    }
  }
}

// ── top_pick: once per board day when the #1 ranked pick is up ────────────────
// Every push subscriber holds an account, and the #1 pick is visible to any
// logged-in user, so naming the pick here leaks nothing. The score never ships.
async function notifyTopPick(getSetting) {
  let top = null;
  try {
    const rows = db.prepare(`
      SELECT p.id, p.score, p.team, p.pick_type, p.spread, p.espn_game_id,
             p.display_score, p.leak_target, p.leak_started_at, p.leak_window_sec,
             sb.v3_total AS v3_total,
             tg.home_team, tg.away_team, tg.status
      FROM picks p
      JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
      LEFT JOIN score_breakdown sb ON sb.pick_id = p.id
      WHERE p.mention_count > 0
    `).all();
    if (!rows.length) return;
    if (getSetting('scoring_version', 'v2') === 'v3') {
      const { v3DisplayScore } = require('./scoring_v3');
      for (const r of rows) r.score = v3DisplayScore(r);
    }
    rows.sort((a, b) => (b.score - a.score) || (a.id - b.id));
    top = rows[0];
  } catch (_) { return; }
  if (!top || top.status !== 'pre') return;   // announce while it's still bettable

  const day = getCycleDate();
  const label = top.pick_type === 'over' || top.pick_type === 'under'
    ? `${top.pick_type.toUpperCase()} ${top.spread ?? ''}`.trim()
    : `${top.team} ${String(top.pick_type || '').toUpperCase()}${top.pick_type === 'spread' && top.spread != null ? ' ' + (top.spread > 0 ? '+' + top.spread : top.spread) : ''}`;
  for (const uid of push.subscribedUserIds()) {
    await push.sendOnce(uid, 'top_pick', day, {
      title: "Today's #1 pick is in",
      body: `${label} (${matchupLabel(top)}) tops today's board.`,
      tag: `top-pick-${day}`,
      url: '/',
    }).catch(() => {});
  }
}

// ── steam: sharp pregame line move on a game carrying a CA pick ───────────────
// Compares each game's oldest vs newest DraftKings line inside the last hour
// (line_history syncs every 15 min). Thresholds are deliberately high — this
// should fire on real steam, not normal drift.
const STEAM_LOOKBACK_MIN = 60;
const STEAM_SPREAD_MOVE  = 1.0;
const STEAM_TOTAL_MOVE   = 1.5;
const STEAM_ML_MOVE      = 25;    // American cents

async function notifySteam() {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT lh.espn_game_id, lh.recorded_at, lh.spread_home, lh.ml_home, lh.over_under,
             tg.home_team, tg.away_team, tg.status
      FROM line_history lh
      JOIN today_games tg ON tg.espn_game_id = lh.espn_game_id
      WHERE tg.status = 'pre'
        AND lh.recorded_at >= datetime('now', '-${STEAM_LOOKBACK_MIN} minutes')
        AND EXISTS (SELECT 1 FROM picks p WHERE p.espn_game_id = lh.espn_game_id AND p.mention_count > 0)
      ORDER BY lh.espn_game_id, lh.recorded_at ASC
    `).all();
  } catch (_) { return; }
  if (!rows.length) return;

  const byGame = new Map();
  for (const r of rows) {
    if (!byGame.has(r.espn_game_id)) byGame.set(r.espn_game_id, []);
    byGame.get(r.espn_game_id).push(r);
  }

  const day = getCycleDate();
  for (const [gameId, hist] of byGame) {
    if (hist.length < 2) continue;
    const first = hist[0], last = hist[hist.length - 1];
    const moves = [];
    if (first.spread_home != null && last.spread_home != null && Math.abs(last.spread_home - first.spread_home) >= STEAM_SPREAD_MOVE) {
      moves.push(`spread ${first.spread_home > 0 ? '+' : ''}${first.spread_home} to ${last.spread_home > 0 ? '+' : ''}${last.spread_home}`);
    }
    if (first.over_under != null && last.over_under != null && Math.abs(last.over_under - first.over_under) >= STEAM_TOTAL_MOVE) {
      moves.push(`total ${first.over_under} to ${last.over_under}`);
    }
    if (first.ml_home != null && last.ml_home != null && Math.abs(last.ml_home - first.ml_home) >= STEAM_ML_MOVE) {
      moves.push(`ML ${first.ml_home > 0 ? '+' : ''}${first.ml_home} to ${last.ml_home > 0 ? '+' : ''}${last.ml_home}`);
    }
    if (!moves.length) continue;
    const g = hist[0];
    for (const uid of push.subscribedUserIds()) {
      await push.sendOnce(uid, 'steam', `${gameId}:${day}`, {
        title: 'Line steam',
        body: `${matchupLabel(g)}: ${moves.join(', ')} in the last hour.`,
        tag: `steam-${gameId}`,
        url: `/game/${gameId}`,
      }).catch(() => {});
    }
  }
}

// ── swing: lead change in a live game where the user has action ───────────────
// In-memory previous-leader map, seeded on the first observation of each game
// (no alert on seed, and none on server restart — push_log also dedupes on the
// specific new leader, so a re-observed lead change never double-fires).
const _prevLeader = new Map();   // espn_game_id -> 'home' | 'away' | 'tied'

function leaderOf(g) {
  const h = g.home_score ?? 0, a = g.away_score ?? 0;
  return h > a ? 'home' : a > h ? 'away' : 'tied';
}

async function notifySwings() {
  let games = [];
  try {
    games = db.prepare(`SELECT espn_game_id, sport, home_team, away_team, home_score, away_score, status FROM today_games WHERE status = 'in'`).all();
  } catch (_) { return; }
  for (const g of games) {
    const now = leaderOf(g);
    const prev = _prevLeader.get(g.espn_game_id);
    _prevLeader.set(g.espn_game_id, now);
    if (prev === undefined || prev === now) continue;   // seed pass or no change
    if (now === 'tied') continue;                        // announce new leads, not ties
    const leaderName = now === 'home' ? g.home_team : g.away_team;
    const users = usersWithAction(g.espn_game_id);
    for (const uid of users) {
      await push.sendOnce(uid, 'swing', `${g.espn_game_id}:${now}`, {
        title: 'Lead change',
        body: `${leaderName} just took the lead (${g.away_score}-${g.home_score}, ${matchupLabel(g)}).`,
        tag: `swing-${g.espn_game_id}`,
        url: `/game/${g.espn_game_id}`,
      }).catch(() => {});
    }
  }
  // Drop finished games from the map so it can't grow across days.
  for (const key of _prevLeader.keys()) {
    if (!games.some(g => g.espn_game_id === key)) _prevLeader.delete(key);
  }
}

// ── Entry point (5-min cron, server only) ─────────────────────────────────────
async function runLiveAlerts(getSetting) {
  try { await notifyGameStarts(); } catch (e) { console.warn('[alerts] game_start:', e.message); }
  try { await notifyTopPick(getSetting); } catch (e) { console.warn('[alerts] top_pick:', e.message); }
  try { await notifySteam(); } catch (e) { console.warn('[alerts] steam:', e.message); }
  try { await notifySwings(); } catch (e) { console.warn('[alerts] swing:', e.message); }
  // Keep the dedupe log bounded.
  try { db.prepare(`DELETE FROM push_log WHERE sent_at < datetime('now', '-14 days')`).run(); } catch (_) {}
}

module.exports = { runLiveAlerts };
