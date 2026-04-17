// src/golf_espn.js — PGA Tour tournament fetcher + leaderboard updater
// Template: mirrors tennis_espn.js pattern but for multi-day golf tournaments.
// Tournaments never wiped — golf_picks and golf_tournaments persist across daily wipe.
//
// DO NOT import espn_live.js or touch discord_scanner.js.

const db = require('./db');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga';

// ── Tier filter — majors + premier events only ────────────────────────────────
const GOLF_TIER_KEYWORDS = [
  'masters', 'u.s. open', 'us open', 'the open', 'pga championship',
  'players championship', 'tour championship', 'fedex', 'bmw',
  'genesis invitational', 'arnold palmer', 'wells fargo', 'rbc canadian',
];

function isMajor(eventName) {
  const lower = (eventName || '').toLowerCase();
  return GOLF_TIER_KEYWORDS.some(k => lower.includes(k));
}

// ── ESPN fetch helper ─────────────────────────────────────────────────────────
async function espnFetch(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn('[golf_espn] fetch error:', err.message);
    return null;
  }
}

// ── Parse a leaderboard from ESPN event competitors ───────────────────────────
function parseLeaderboard(competitors) {
  if (!Array.isArray(competitors)) return [];
  return competitors.map(c => {
    const athlete = c.athlete || {};
    const stats   = c.statistics || [];
    const rounds  = (c.linescores || []).map(ls => ls.value ?? ls.displayValue ?? null);

    // Score relative to par — espn stores as string like "-10" or "E"
    const score = c.score ?? c.displayValue ?? 'E';
    const thru  = c.status?.thru ?? c.thru ?? null;

    return {
      position:   c.status?.position?.displayName ?? c.position ?? '—',
      player: {
        fullName:  athlete.displayName  || '',
        shortName: athlete.shortName    || '',
        lastName:  (athlete.displayName || '').split(' ').pop(),
      },
      score,
      rounds,
      thru: thru != null ? String(thru) : '—',
      status: c.status?.type?.description || 'active',
    };
  }).sort((a, b) => {
    // Sort by position number; non-numeric positions go last
    const posA = parseInt(a.position, 10) || 999;
    const posB = parseInt(b.position, 10) || 999;
    return posA - posB;
  });
}

// ── Upsert a tournament into golf_tournaments ─────────────────────────────────
function upsertTournament(data) {
  const {
    espn_tournament_id, name, course, city, state,
    start_date, end_date, status, current_round, leaderboard_json,
  } = data;

  db.prepare(`
    INSERT INTO golf_tournaments
      (espn_tournament_id, name, course, city, state, start_date, end_date,
       status, current_round, leaderboard_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(espn_tournament_id) DO UPDATE SET
      name             = excluded.name,
      course           = excluded.course,
      city             = excluded.city,
      state            = excluded.state,
      start_date       = excluded.start_date,
      end_date         = excluded.end_date,
      status           = excluded.status,
      current_round    = excluded.current_round,
      leaderboard_json = excluded.leaderboard_json,
      updated_at       = datetime('now')
  `).run(
    espn_tournament_id, name, course, city, state,
    start_date, end_date, status, current_round, leaderboard_json,
  );
}

// ── Fetch all active PGA Tour tournaments ─────────────────────────────────────
async function fetchGolfTournaments() {
  console.log('[golf_espn] Fetching PGA Tour tournaments...');
  const data = await espnFetch(`${ESPN_BASE}/scoreboard`);
  if (!data?.events) {
    console.warn('[golf_espn] No events in scoreboard response');
    return;
  }

  let count = 0;
  for (const event of data.events) {
    const name = event.name || event.shortName || '';
    if (!isMajor(name)) continue;

    const comp   = event.competitions?.[0] || {};
    const venue  = comp.venue || {};
    const status = event.status?.type?.description?.toLowerCase() || 'pre';
    const espnStatus = status.includes('final') ? 'post'
                     : status.includes('in') || status.includes('active') ? 'in'
                     : 'pre';

    // Fetch detailed scoreboard for this event to get leaderboard
    const detail = await espnFetch(`${ESPN_BASE}/scoreboard?event=${event.id}`);
    const detailComp = detail?.events?.[0]?.competitions?.[0] || comp;
    const competitors = detailComp.competitors || comp.competitors || [];
    const leaderboard = parseLeaderboard(competitors);

    // Current round
    const currentRound = detailComp.status?.period ?? event.status?.period ?? 1;

    upsertTournament({
      espn_tournament_id: String(event.id),
      name,
      course:    venue.fullName  || venue.name || null,
      city:      venue.address?.city  || null,
      state:     venue.address?.state || null,
      start_date: event.date || null,
      end_date:   event.endDate || null,
      status:     espnStatus,
      current_round: currentRound,
      leaderboard_json: JSON.stringify(leaderboard),
    });
    count++;
    console.log(`[golf_espn] Upserted tournament: ${name} (status=${espnStatus}, players=${leaderboard.length})`);
  }

  console.log(`[golf_espn] Done — ${count} major tournament(s) processed`);
}

// ── Update leaderboards for active tournaments (5-min cron) ──────────────────
async function updateGolfLeaderboards() {
  const active = db.prepare(`SELECT * FROM golf_tournaments WHERE status != 'post'`).all();
  if (!active.length) return;

  for (const t of active) {
    const detail = await espnFetch(`${ESPN_BASE}/scoreboard?event=${t.espn_tournament_id}`);
    if (!detail?.events?.[0]) continue;

    const event     = detail.events[0];
    const comp      = event.competitions?.[0] || {};
    const status    = event.status?.type?.description?.toLowerCase() || '';
    const espnStatus = status.includes('final') ? 'post'
                     : status.includes('in') || status.includes('active') ? 'in'
                     : 'pre';

    const leaderboard   = parseLeaderboard(comp.competitors || []);
    const currentRound  = comp.status?.period ?? event.status?.period ?? t.current_round;

    db.prepare(`
      UPDATE golf_tournaments SET
        status           = ?,
        current_round    = ?,
        leaderboard_json = ?,
        updated_at       = datetime('now')
      WHERE espn_tournament_id = ?
    `).run(espnStatus, currentRound, JSON.stringify(leaderboard), t.espn_tournament_id);

    // Resolve picks if tournament just finished
    if (espnStatus === 'post' && t.status !== 'post') {
      resolveGolfPicks(t.espn_tournament_id, leaderboard);
    }
  }
}

// ── Resolve golf picks when a tournament finishes ────────────────────────────
function resolveGolfPicks(espn_tournament_id, leaderboard) {
  const picks = db.prepare(
    `SELECT * FROM golf_picks WHERE espn_tournament_id = ? AND result = 'pending'`
  ).all(espn_tournament_id);

  if (!picks.length) return;

  // Build position map: lastName (lowercase) → position number
  const posMap = new Map();
  for (const entry of leaderboard) {
    const pos = parseInt(entry.position, 10);
    if (isNaN(pos)) continue;
    const lastName = (entry.player.lastName || '').toLowerCase();
    const full     = (entry.player.fullName  || '').toLowerCase();
    posMap.set(lastName, pos);
    posMap.set(full,     pos);
  }

  function getPos(name) {
    const n = (name || '').toLowerCase();
    return posMap.get(n) ?? posMap.get(n.split(' ').pop()) ?? null;
  }

  for (const pick of picks) {
    const pos    = getPos(pick.player_name);
    let result   = null;

    if (pos === null) {
      console.warn(`[golf_espn] Can't resolve pick id=${pick.id} — player not found: ${pick.player_name}`);
      continue;
    }

    switch (pick.pick_type) {
      case 'ML':
        result = pos === 1 ? 'win' : 'loss';
        break;
      case 'top5':
        result = pos <= 5 ? 'win' : 'loss';
        break;
      case 'top10':
        result = pos <= 10 ? 'win' : 'loss';
        break;
      case 'h2h': {
        const vsPos = getPos(pick.vs_player);
        if (vsPos === null) {
          console.warn(`[golf_espn] Can't resolve h2h — vs_player not found: ${pick.vs_player}`);
          continue;
        }
        result = pos < vsPos ? 'win' : pos > vsPos ? 'loss' : 'push';
        break;
      }
      default:
        // over/under round props — these are daily, skip auto-resolution here
        continue;
    }

    if (result) {
      db.prepare(`UPDATE golf_picks SET result = ? WHERE id = ?`).run(result, pick.id);
      console.log(`[golf_espn] Resolved golf pick id=${pick.id} ${pick.player_name} ${pick.pick_type} → ${result} (pos=${pos})`);
    }
  }
}

module.exports = { fetchGolfTournaments, updateGolfLeaderboards };
