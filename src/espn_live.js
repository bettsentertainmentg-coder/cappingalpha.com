// src/espn_live.js — ESPN unofficial API for live scores and spreads
// No API key required

const axios = require('axios');
const db = require('./db');
const { getCycleDate } = require('./cycle');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const SPORTS = {
  ncaab: 'basketball/mens-college-basketball',
  nfl:   'football/nfl',
  nhl:   'hockey/nhl',
  mlb:   'baseball/mlb',
  nba:   'basketball/nba',
};

// ── Normalize pick sport string → ESPN scoreboard path ────────────────────────
function normalizeSport(sport) {
  const s = (sport || '').toUpperCase().replace(/[\s-]/g, '');
  const map = {
    CBB:               'basketball/mens-college-basketball',
    NCAAB:             'basketball/mens-college-basketball',
    NCAAT:             'basketball/mens-college-basketball', // NCAA Tournament
    COLLEGEBASKETBALL: 'basketball/mens-college-basketball',
    WCBB:              'basketball/womens-college-basketball',
    BASKETBALL:        'basketball/nba',                    // generic → try NBA
    NBA:               'basketball/nba',
    NFL:               'football/nfl',
    NCAAF:             'football/college-football',
    CFB:               'football/college-football',
    NHL:               'hockey/nhl',
    MLB:               'baseball/mlb',
  };
  return map[s] || null;
}

// ── 60-second in-memory scoreboard cache ─────────────────────────────────────
const scoreboardCache = new Map(); // sportPath → { ts, promise }
const CACHE_TTL_MS = 60 * 1000;

async function fetchScoreboard(sportPath) {
  const cached = scoreboardCache.get(sportPath);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log(`[ESPN] Using cached ${sportPath} scoreboard`);
    return cached.promise;
  }
  console.log(`[ESPN] Fetching fresh ${sportPath} scoreboard`);
  const promise = axios.get(`${ESPN_BASE}/${sportPath}/scoreboard`, { timeout: 10000 })
    .then(res => res.data?.events || [])
    .catch(err => {
      console.warn(`[CappperBoss:espn] fetchScoreboard(${sportPath}) error:`, err.message);
      return [];
    });
  scoreboardCache.set(sportPath, { ts: Date.now(), promise });
  return promise;
}

// ── Fetch ESPN events for a specific date (YYYYMMDD) ─────────────────────────
async function fetchScoreboardForDate(sportPath, dateStr) {
  try {
    const res = await axios.get(
      `${ESPN_BASE}/${sportPath}/scoreboard?dates=${dateStr}`,
      { timeout: 10000 }
    );
    return res.data?.events || [];
  } catch (err) {
    console.warn(`[CappperBoss:espn] fetchScoreboardForDate(${sportPath}, ${dateStr}) error:`, err.message);
    return [];
  }
}

// ── Format a Date as YYYYMMDD for ESPN date param ─────────────────────────────
function toEspnDate(d) {
  const etStr = d.toLocaleDateString('en-CA', {
    timeZone: 'America/New_York'
  }); // returns YYYY-MM-DD in ET
  return etStr.replace(/-/g, ''); // returns YYYYMMDD
}

// ── Sports to fetch for today_games ──────────────────────────────────────────
const TODAY_SPORTS = [
  { path: 'basketball/mens-college-basketball',   label: 'CBB'  },
  { path: 'basketball/womens-college-basketball', label: 'WCBB' },
  { path: 'basketball/nba',                       label: 'NBA'  },
  { path: 'hockey/nhl',                           label: 'NHL'  },
  { path: 'baseball/mlb',                         label: 'MLB'  },
  { path: 'football/nfl',                         label: 'NFL'  },
];

// ── Upsert a single ESPN event into today_games ───────────────────────────────
function upsertTodayGame(ev, sportLabel) {
  const comp = ev.competitions?.[0] || {};
  const home = comp.competitors?.find(c => c.homeAway === 'home') || {};
  const away = comp.competitors?.find(c => c.homeAway === 'away') || {};
  const state = ev.status?.type?.state || 'pre'; // 'pre', 'in', or 'post'

  db.prepare(`
    INSERT INTO today_games (
      espn_game_id, sport, status, period, clock, start_time,
      home_score, away_score,
      home_team, home_short, home_name, home_abbr,
      away_team, away_short, away_name, away_abbr,
      fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(espn_game_id) DO UPDATE SET
      status     = excluded.status,
      period     = excluded.period,
      clock      = excluded.clock,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      fetched_at = excluded.fetched_at,
      -- Snapshot total runs when inning 2 begins (period=2, first_inning_runs not yet set)
      first_inning_runs = CASE
        WHEN excluded.sport = 'MLB'
          AND excluded.period >= 2
          AND first_inning_runs IS NULL
        THEN excluded.home_score + excluded.away_score
        ELSE first_inning_runs
      END
  `).run(
    ev.id, sportLabel, state,
    ev.status?.period || null,
    ev.status?.displayClock || null,
    ev.date || null,
    parseInt(home.score || 0, 10),
    parseInt(away.score || 0, 10),
    home.team?.displayName || null,
    home.team?.shortDisplayName || null,
    home.team?.name || null,
    home.team?.abbreviation || null,
    away.team?.displayName || null,
    away.team?.shortDisplayName || null,
    away.team?.name || null,
    away.team?.abbreviation || null
  );
}

// ── Fetch today's games for all sports, upsert to today_games ─────────────────
// Stores every game ESPN returns for today's date — no time filtering.
async function fetchTodaysGames() {
  const todayStr = getCycleDate().replace(/-/g, ''); // YYYYMMDD for ESPN param

  let total = 0;
  await Promise.all(TODAY_SPORTS.map(async ({ path, label }) => {
    try {
      const events = await fetchScoreboardForDate(path, todayStr);
      for (const ev of events) upsertTodayGame(ev, label);
      total += events.length;
      if (events.length > 0) {
        console.log(`[ESPN] today_games: ${events.length} ${label} games upserted`);
      }
    } catch (err) {
      console.warn(`[ESPN] fetchTodaysGames(${label}) error:`, err.message);
    }
  }));
  console.log(`[ESPN] fetchTodaysGames complete: ${total} total games`);
  return total;
}

// ── Sport priority for disambiguation: CBB > NBA > NHL > MLB ─────────────────
// "Kansas" matches Kansas Jayhawks (CBB) not Kansas City Royals (MLB).
const SPORT_PRIORITY = { CBB: 1, NBA: 2, NHL: 3, WCBB: 4, MLB: 5, NFL: 6 };

function pickBySportPriority(rows) {
  if (!rows.length) return null;
  return rows.sort((a, b) =>
    (SPORT_PRIORITY[a.sport] || 99) - (SPORT_PRIORITY[b.sport] || 99)
  )[0];
}

// ── Synchronous DB lookup: find a today_game row matching a team name ─────────
// Pass 1: exact / word-boundary prefix+suffix on all stored name variants.
// Pass 2: substring LIKE '%...%' fallback for nicknames ("Ducks", "Raptors").
// Pass 3: if messageDate given and passes 1+2 empty, retry with messageDate+1 day
//         to catch evening ET games stored with next-day UTC date in start_time.
// When multiple rows match across sports, highest-priority sport wins.
// Optional messageDate (YYYY-MM-DD) restricts results to games on that date,
// preventing a stale CBB pick from matching today's MLB game of the same city.
// Shorthand nicknames → expanded term used in DB queries
const NICKNAME_MAP = {
  yanks:   'yankees',
  phils:   'phillies',
  rox:     'rockies',
  clips:   'clippers',
  celts:   'celtics',
  // 'sox' intentionally omitted — fuzzy LIKE '%sox%' already matches both Red Sox and White Sox
};

function lookupTodayGame(teamName, messageDate) {
  const raw = (teamName || '').toLowerCase().trim();
  const s   = NICKNAME_MAP[raw] ?? raw;
  if (s.length < 2) return null;

  function queryExact(dateClause) {
    return db.prepare(`
      SELECT * FROM today_games WHERE (
        LOWER(home_team)  = ? OR LOWER(home_team)  LIKE ? || ' %' OR LOWER(home_team)  LIKE '% ' || ?
        OR LOWER(home_short) = ? OR LOWER(home_name) = ? OR LOWER(home_abbr) = ?
        OR LOWER(away_team)  = ? OR LOWER(away_team)  LIKE ? || ' %' OR LOWER(away_team)  LIKE '% ' || ?
        OR LOWER(away_short) = ? OR LOWER(away_name) = ? OR LOWER(away_abbr) = ?
      )${dateClause}
    `).all(s, s, s, s, s, s, s, s, s, s, s, s);
  }

  function queryFuzzy(dateClause) {
    return db.prepare(`
      SELECT * FROM today_games WHERE (
        LOWER(home_team)  LIKE '%' || ? || '%' OR LOWER(away_team)  LIKE '%' || ? || '%'
        OR LOWER(home_short) LIKE '%' || ? || '%' OR LOWER(away_short) LIKE '%' || ? || '%'
        OR LOWER(home_name)  LIKE '%' || ? || '%' OR LOWER(away_name)  LIKE '%' || ? || '%'
        OR LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?
      )${dateClause}
    `).all(s, s, s, s, s, s, s, s);
  }

  // Build optional date filter clause: match start_time date portion
  const dateClause = messageDate ? ` AND DATE(start_time) = '${messageDate}'` : '';

  // Pass 1 — exact, "name %", "% name" patterns
  const exactRows = queryExact(dateClause);
  if (exactRows.length) return pickBySportPriority(exactRows);

  // Pass 2 — substring fallback for standalone nicknames ("Ducks" → "Anaheim Ducks")
  const fuzzyRows = queryFuzzy(dateClause);
  if (fuzzyRows.length) return pickBySportPriority(fuzzyRows);

  // Pass 3 — evening ET games are stored with the next UTC day in start_time
  // e.g. 8 PM ET = 2026-03-24T00:00Z → DATE(start_time) = '2026-03-24', msgDate = '2026-03-23'
  if (messageDate) {
    const nextDay = new Date(messageDate + 'T12:00:00Z');
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const nextDateStr = nextDay.toISOString().slice(0, 10);
    const nextDateClause = ` AND DATE(start_time) = '${nextDateStr}'`;

    const nextExact = queryExact(nextDateClause);
    if (nextExact.length) return pickBySportPriority(nextExact);

    const nextFuzzy = queryFuzzy(nextDateClause);
    if (nextFuzzy.length) return pickBySportPriority(nextFuzzy);
  }

  return null;
}

const pollIntervals = new Map(); // gameId → intervalId

// Score history for detectDue: gameId → [{home, away, ts}, ...]
const scoreHistory = new Map();
const HISTORY_LIMIT = 20; // keep last 20 snapshots per game

// ── Fetch scoreboard for a sport ──────────────────────────────────────────────
async function fetchLiveGames(sport) {
  const sportPath = SPORTS[sport.toLowerCase()] || sport;
  const url = `${ESPN_BASE}/${sportPath}/scoreboard`;

  try {
    const res = await axios.get(url, { timeout: 10000 });
    const events = res.data?.events || [];

    return events.map(ev => {
      const comp = ev.competitions?.[0] || {};
      const home = comp.competitors?.find(c => c.homeAway === 'home') || {};
      const away = comp.competitors?.find(c => c.homeAway === 'away') || {};
      const odds = comp.odds?.[0] || {};
      const spread = odds.details ? parseFloat(odds.details.replace(/[^-\d.]/g, '')) : null;

      return {
        espn_game_id: ev.id,
        home_team:    home.team?.displayName || '',
        away_team:    away.team?.displayName || '',
        home_score:   parseInt(home.score || 0, 10),
        away_score:   parseInt(away.score || 0, 10),
        spread,
        status:       ev.status?.type?.description || 'unknown',
        state:        ev.status?.type?.state        || 'pre',
        sport:        sport.toLowerCase(),
        name:         ev.name || `${away.team?.displayName} @ ${home.team?.displayName}`,
        startTime:    ev.date,
      };
    });
  } catch (err) {
    console.error(`[CappperBoss:espn] fetchLiveGames(${sport}) error:`, err.message);
    return [];
  }
}

// ── Upsert game to DB ─────────────────────────────────────────────────────────
function upsertGame(game) {
  db.prepare(`
    INSERT INTO live_games (espn_game_id, home_team, away_team, sport,
                            home_score, away_score, spread, status, last_polled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(espn_game_id) DO UPDATE SET
      home_score  = excluded.home_score,
      away_score  = excluded.away_score,
      spread      = excluded.spread,
      status      = excluded.status,
      last_polled = excluded.last_polled
  `).run(
    game.espn_game_id, game.home_team, game.away_team, game.sport,
    game.home_score, game.away_score, game.spread, game.status
  );

  // Append to score history
  const history = scoreHistory.get(game.espn_game_id) || [];
  history.push({ home: game.home_score, away: game.away_score, ts: Date.now() });
  if (history.length > HISTORY_LIMIT) history.shift();
  scoreHistory.set(game.espn_game_id, history);
}

// ── Detect 10+ point swing vs opening spread ──────────────────────────────────
function detectSwing(gameId) {
  const game = db.prepare(`SELECT * FROM live_games WHERE espn_game_id = ?`).get(gameId);
  if (!game || game.spread == null) return null;

  const currentMargin = game.home_score - game.away_score;
  const swing = Math.abs(currentMargin - game.spread);

  if (swing >= 10) {
    return { gameId, swing, currentMargin, openingSpread: game.spread, game };
  }
  return null;
}

// ── Detect "due" team: opponent on 8+ unanswered, other team scored ≤2 ────────
// Returns {team, points_scored_against, is_due, game_id} or null
function detectDue(gameId) {
  const history = scoreHistory.get(gameId);
  if (!history || history.length < 3) return null;

  const game = db.prepare(`SELECT * FROM live_games WHERE espn_game_id = ?`).get(gameId);
  if (!game) return null;

  // Look at last several snapshots to find a scoring run
  const window = history.slice(-8); // last 8 snapshots
  const first = window[0];
  const last  = window[window.length - 1];

  const homeScored = last.home - first.home;
  const awayScored = last.away - first.away;

  // Home team on a run — away is "due"
  if (homeScored >= 8 && awayScored <= 2) {
    return {
      team:                 game.away_team,
      opponent:             game.home_team,
      points_scored_against: homeScored,
      is_due:               true,
      game_id:              gameId,
    };
  }

  // Away team on a run — home is "due"
  if (awayScored >= 8 && homeScored <= 2) {
    return {
      team:                 game.home_team,
      opponent:             game.away_team,
      points_scored_against: awayScored,
      is_due:               true,
      game_id:              gameId,
    };
  }

  return null;
}

// ── Poll a specific game every 60s ───────────────────────────────────────────
async function pollGame(gameId, sport) {
  if (pollIntervals.has(gameId)) {
    console.log(`[CappperBoss:espn] Already polling game ${gameId}`);
    return;
  }

  console.log(`[CappperBoss:espn] Starting poll for game ${gameId} (${sport})`);

  const tick = async () => {
    const games = await fetchLiveGames(sport);
    const game = games.find(g => g.espn_game_id === gameId);
    if (!game) return;

    upsertGame(game);

    const alerts = require('./alerts');

    // Check swing
    const swingData = detectSwing(gameId);
    if (swingData) {
      alerts.sendAlert(
        `⚡ SWING ALERT: ${game.away_team} @ ${game.home_team} — ` +
        `${swingData.swing.toFixed(1)} pt swing vs spread (${game.home_score}-${game.away_score})`,
        gameId,
        'SWING'
      );
    }

    // Check due
    const dueData = detectDue(gameId);
    if (dueData) {
      alerts.checkDue(dueData, game);
    }

    if (game.status?.includes('Final') || game.status?.includes('Game Over') || game.state === 'post') {
      console.log(`[CappperBoss:espn] Game ${gameId} finished (${game.status}). Stopping poll.`);
      stopPoll(gameId);
    }
  };

  await tick();
  const interval = setInterval(tick, 60 * 1000);
  pollIntervals.set(gameId, interval);
}

function stopPoll(gameId) {
  const interval = pollIntervals.get(gameId);
  if (interval) {
    clearInterval(interval);
    pollIntervals.delete(gameId);
  }
}

function getMonitoredGames() {
  if (pollIntervals.size === 0) return [];
  const ids = [...pollIntervals.keys()];
  return db.prepare(
    `SELECT * FROM live_games WHERE espn_game_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
}

// ── Clear all in-memory state (polls, score history, cache) ──────────────────
function clearAllState() {
  // Stop all active game polls
  for (const [gameId, interval] of pollIntervals) {
    clearInterval(interval);
  }
  pollIntervals.clear();
  scoreHistory.clear();
  scoreboardCache.clear();
  console.log('[ESPN] Cleared all in-memory state (polls, score history, cache)');
}

// ── Update scores for all picks with active games ────────────────────────────
async function updateLiveScores() {
  // Get ALL game IDs with picks today — no limit, ESPN calls are free
  const topGames = db.prepare(`
    SELECT DISTINCT espn_game_id
    FROM picks
    WHERE game_date = (SELECT MAX(game_date) FROM picks)
      AND espn_game_id IS NOT NULL
      AND mention_count > 0
  `).all().map(r => r.espn_game_id);

  if (!topGames.length) return;

  // Fetch updated game data from ESPN for each unique sport in those games
  const games = db.prepare(
    `SELECT DISTINCT espn_game_id, sport FROM today_games WHERE espn_game_id IN (${topGames.map(() => '?').join(',')})`
  ).all(...topGames);

  const sportPaths = [...new Set(games.map(g => normalizeSport(g.sport)).filter(Boolean))];

  for (const path of sportPaths) {
    try {
      const events = await fetchScoreboard(path);
      for (const ev of events) {
        if (topGames.includes(ev.id)) upsertTodayGame(ev, games.find(g => g.espn_game_id === ev.id)?.sport || '');
      }
    } catch (err) {
      console.warn(`[ESPN] updateLiveScores(${path}):`, err.message);
    }
  }
}

module.exports = {
  fetchLiveGames, pollGame, stopPoll, detectSwing, detectDue, getMonitoredGames,
  fetchScoreboard, fetchScoreboardForDate, toEspnDate, normalizeSport,
  fetchTodaysGames, lookupTodayGame, clearAllState, SPORTS, updateLiveScores,
};
