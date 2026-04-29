// CappperBoss — Sports betting intelligence agent
require('dotenv').config({
  path: require('path').join(process.env.HOME || '/Users/jack', 'Projects/AgentOSO/.env')
});
// Also load local .env if present (Railway uses env vars directly)
require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: false });

const express  = require('express');
const session  = require('express-session');
const cron     = require('node-cron');
const path     = require('path');
const crypto   = require('crypto');
const SQLiteStore = require('./src/session_store');

const db      = require('./src/db');
const scanner = require('./src/discord_scanner');
const admin   = require('./src/admin');
const auth    = require('./src/auth');
const { runDailyWipe }                    = require('./src/wipe');
const { lockMorningLines, getLines } = require('./src/lines');
const { refreshOdds } = require('./src/odds_api');
const { getRecentMvpPicks, getAllTimeRecord, resolveConflictingMvpPicks } = require('./src/mvp');
const { getSetting } = require('./src/db');
const { updateLiveScores, fetchTodaysGames, refreshEspnOdds } = require('./src/espn_live');
const { fetchTodaysTennisMatches, updateTennisLiveScores } = require('./src/tennis_espn');
const { fetchGolfTournaments, updateGolfLeaderboards }    = require('./src/golf_espn');
const { resolveResults }   = require('./src/results');
const { getCycleDate }                                = require('./src/cycle');
const { MVP_THRESHOLD, CHANNEL_POINTS }               = require('./src/scoring');
const { getFullGameContext }                          = require('./src/game_stats');
const { getLinesForGame }                             = require('./src/lines_scraper');
const { fetchPublicBetting, getPublicBettingForGame } = require('./src/public_betting');

// ── Active hours: 5am–1am ET ──────────────────────────────────────────────────
const ACTIVE_START = 5;
const ACTIVE_END   = 25; // 1am ET = hour 25

function etHour() {
  const etStr = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false
  });
  const h = parseInt(etStr, 10);
  return h < (ACTIVE_END - 24) ? h + 24 : h;
}

function isActiveHours() {
  const h = etHour();
  return h >= ACTIVE_START && h < ACTIVE_END;
}

// ── Session secret ────────────────────────────────────────────────────────────
// Must be set in .env for production. Falls back to a random secret in dev
// (sessions reset on each restart — fine locally, not acceptable in prod).
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.warn('[security] SESSION_SECRET not set in .env — generating a random secret. Sessions will invalidate on every restart.');
}
const secret = SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ── In-memory rate limiter — login + signup ───────────────────────────────────
// Tracks attempts per IP. No extra npm packages needed at this scale.
const _loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip     = req.ip || req.connection.remoteAddress || 'unknown';
  const now    = Date.now();
  const WINDOW = 15 * 60 * 1000; // 15 minutes
  const MAX    = 10;              // attempts per window

  const attempts = (_loginAttempts.get(ip) || []).filter(t => now - t < WINDOW);
  if (attempts.length >= MAX) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  attempts.push(now);
  _loginAttempts.set(ip, attempts);
  next();
}
// Prune the attempts map hourly so it doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of _loginAttempts) {
    const fresh = times.filter(t => now - t < 15 * 60 * 1000);
    if (fresh.length === 0) _loginAttempts.delete(ip);
    else _loginAttempts.set(ip, fresh);
  }
}, 60 * 60 * 1000).unref();

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // Required for secure cookies behind Railway/Heroku proxies

// Stripe webhook MUST be registered before express.json() — needs raw body for signature verification
app.post('/auth/stripe-webhook', express.raw({ type: 'application/json' }), auth.stripeWebhook);

app.use(express.json());
app.use(session({
  secret:            secret,
  resave:            false,
  saveUninitialized: false,
  store:             new SQLiteStore(),
  cookie: {
    httpOnly: true,           // JS can't read the cookie — blocks XSS token theft
    secure:   !!process.env.SESSION_SECURE, // set SESSION_SECURE=1 in prod behind HTTPS
    sameSite: 'lax',          // blocks most CSRF while allowing normal navigation
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));
app.use('/auth/login',  loginRateLimit);
app.use('/auth/signup', loginRateLimit);
app.use('/admin', admin);
app.use('/auth', auth);
app.use(express.static(path.join(__dirname, 'public')));

// Terms of Service page
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// Sitemap — submitted to Google Search Console
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://cappingalpha.com/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
</urlset>`);
});

// GET /api/config — scoring constants for the frontend
// NOTE: channel_points intentionally excluded — exposes Discord channel names + weights
app.get('/api/config', (req, res) => {
  const displayThreshold = parseInt(getSetting('mvp_display_threshold', MVP_THRESHOLD), 10);
  res.json({ mvp_threshold: MVP_THRESHOLD, mvp_display_threshold: displayThreshold });
});

// GET /api/picks — today's picks ordered by score desc, enriched with matchup
app.get('/api/picks', (req, res) => {
  const PICKS_QUERY = `
    SELECT p.*,
           COALESCE(tg1.home_team, tg2.home_team) AS home_team,
           COALESCE(tg1.away_team, tg2.away_team) AS away_team,
           COALESCE(tg1.start_time, tg2.start_time) AS start_time,
           COALESCE(tg1.status, tg2.status) AS game_status,
           COALESCE(tg1.period, tg2.period) AS game_period,
           COALESCE(tg1.clock, tg2.clock) AS game_clock,
           COALESCE(tg1.home_score, tg2.home_score) AS game_home_score,
           COALESCE(tg1.away_score, tg2.away_score) AS game_away_score
    FROM picks p
    LEFT JOIN today_games tg1 ON tg1.espn_game_id = p.espn_game_id
    LEFT JOIN today_games tg2 ON (LOWER(tg2.home_team) = LOWER(p.team) OR LOWER(tg2.away_team) = LOWER(p.team))
    WHERE p.game_date = ? AND p.mention_count > 0
    GROUP BY p.id
    ORDER BY p.score DESC
  `;
  let picks = db.prepare(PICKS_QUERY).all(getCycleDate());
  // Between 12:30am–5am ET the cycle date has already flipped but the 5am scan
  // hasn't run yet and the wipe hasn't cleared the DB. Show yesterday's picks
  // as a fallback so the board isn't empty during that window.
  if (picks.length === 0) {
    const h = etHour();
    const inPreWipeWindow = h >= 24 || h < 5; // midnight–5am ET (hour 24-28 wraps)
    if (inPreWipeWindow) {
      const yesterday = (() => {
        const d = new Date(getCycleDate() + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      })();
      picks = db.prepare(PICKS_QUERY).all(yesterday);
    }
  }
  res.json(picks);
});

// GET /api/picks/top — #1 pick today
app.get('/api/picks/top', (req, res) => {
  const TOP_QUERY = `
    SELECT p.*,
           tg.home_team AS matchup_home,
           tg.away_team AS matchup_away
    FROM picks p
    LEFT JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
    WHERE p.game_date = ? AND p.mention_count > 0
    ORDER BY p.score DESC LIMIT 1
  `;
  let pick = db.prepare(TOP_QUERY).get(getCycleDate());
  if (!pick) {
    const h = etHour();
    if (h >= 24 || h < 5) {
      const yesterday = (() => {
        const d = new Date(getCycleDate() + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      })();
      pick = db.prepare(TOP_QUERY).get(yesterday);
    }
  }
  res.json(pick || null);
});

// GET /api/mvp — recent MVP picks + all-time record (paid users)
app.get('/api/mvp', (req, res) => {
  const threshold = parseInt(getSetting('mvp_display_threshold', MVP_THRESHOLD), 10);
  res.json({
    picks:  getRecentMvpPicks(threshold),
    record: getAllTimeRecord(threshold),
  });
});

// GET /api/mvp/public — resolved MVP picks + record for all users (home page)
app.get('/api/mvp/public', (req, res) => {
  const threshold = parseInt(getSetting('mvp_display_threshold', MVP_THRESHOLD), 10);
  const picks = db.prepare(`
    SELECT m.*,
           COALESCE(tg1.home_team, tg2.home_team) AS home_team,
           COALESCE(tg1.away_team, tg2.away_team) AS away_team
    FROM mvp_picks m
    LEFT JOIN today_games tg1 ON tg1.espn_game_id = m.espn_game_id
    LEFT JOIN today_games tg2 ON tg1.espn_game_id IS NULL
                              AND (LOWER(tg2.home_team) = LOWER(m.team) OR LOWER(tg2.away_team) = LOWER(m.team))
    WHERE m.result IN ('win', 'loss', 'push') AND m.score >= ?
      AND (m.annotation IS NULL OR m.annotation NOT LIKE '%not counted%')
    ORDER BY m.saved_at DESC LIMIT 50
  `).all(threshold);

  const rows = db.prepare(`
    SELECT result, COUNT(*) as count FROM mvp_picks
    WHERE result IN ('win', 'loss', 'push') AND score >= ?
      AND (annotation IS NULL OR annotation NOT LIKE '%not counted%')
    GROUP BY result
  `).all(threshold);
  const counts = { win: 0, loss: 0, push: 0 };
  for (const r of rows) counts[r.result] = r.count;
  const decided  = counts.win + counts.loss;
  const win_rate = decided > 0 ? Math.round((counts.win / decided) * 100) + '%' : '0%';

  res.json({ picks, record: { wins: counts.win, losses: counts.loss, pushes: counts.push, win_rate } });
});

// GET /api/games — today's games for schedule widget, optional ?sport= filter
app.get('/api/games', (req, res) => {
  const sport = req.query.sport;
  const rows = sport
    ? db.prepare(`SELECT espn_game_id, sport, home_team, away_team, start_time, status, home_score, away_score, period, clock FROM today_games WHERE UPPER(sport) = UPPER(?) ORDER BY start_time ASC`).all(sport)
    : db.prepare(`SELECT espn_game_id, sport, home_team, away_team, start_time, status, home_score, away_score, period, clock FROM today_games ORDER BY start_time ASC`).all();
  res.json(rows);
});

// ── Golf API routes ───────────────────────────────────────────────────────────
// GET /api/golf/tournaments — list active (non-post) major tournaments
app.get('/api/golf/tournaments', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT espn_tournament_id, name, course, city, state, start_date, end_date,
             status, current_round, updated_at
      FROM golf_tournaments
      WHERE status != 'post'
      ORDER BY start_date ASC
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/golf/:tournamentId — full tournament detail: leaderboard + golf picks
app.get('/api/golf/:tournamentId', (req, res) => {
  try {
    const tournament = db.prepare(`
      SELECT * FROM golf_tournaments WHERE espn_tournament_id = ?
    `).get(req.params.tournamentId);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const picks = db.prepare(`
      SELECT id, capper_name, player_name, vs_player, pick_type, spread_value,
             channel, score, mention_count, result, game_date, parsed_at
      FROM golf_picks
      WHERE espn_tournament_id = ?
      ORDER BY score DESC
    `).all(req.params.tournamentId);

    res.json({ tournament, picks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/golf/picks/all — all golf picks across active tournaments (for sport tab)
app.get('/api/golf/picks/all', (req, res) => {
  try {
    const picks = db.prepare(`
      SELECT gp.*, gt.name as tournament_name, gt.course
      FROM golf_picks gp
      LEFT JOIN golf_tournaments gt ON gt.espn_tournament_id = gp.espn_tournament_id
      WHERE gt.status != 'post' OR gt.status IS NULL
      ORDER BY gp.score DESC
    `).all();
    res.json(picks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/account — current user's profile + preferences + today's voted picks
app.get('/api/account', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Login required' });
  const userId = req.session.user.id;

  const user = db.prepare(`SELECT id, email, username, username_changed_at, subscription_tier, subscription_expires, created_at FROM users WHERE id = ?`).get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const prefs = db.prepare(`SELECT favorite_sports FROM user_preferences WHERE user_id = ?`).get(userId);
  const favoriteSports = prefs ? JSON.parse(prefs.favorite_sports || '[]') : [];

  // Votes joined to today_games + picks. Snapshot columns (gv.*) take priority —
  // they survive the daily wipe; today_games and picks are fallback for today's live data.
  const votes = db.prepare(`
    SELECT gv.espn_game_id, gv.pick_slot, gv.voted_at,
           COALESCE(gv.home_team,    tg.home_team)    AS home_team,
           COALESCE(gv.away_team,    tg.away_team)    AS away_team,
           COALESCE(gv.sport,        tg.sport)        AS sport,
           tg.status, tg.home_score, tg.away_score, tg.start_time,
           COALESCE(gv.ml_home,      tg.ml_home)      AS ml_home,
           COALESCE(gv.ml_away,      tg.ml_away)      AS ml_away,
           COALESCE(gv.ou_over_odds, tg.ou_over_odds) AS ou_over_odds,
           COALESCE(gv.ou_under_odds,tg.ou_under_odds)AS ou_under_odds,
           p.score, p.mention_count,
           COALESCE(p.result, gv.result) AS result,
           p.pick_type, p.team,
           COALESCE(gv.spread, p.spread) AS spread
    FROM game_votes gv
    LEFT JOIN today_games tg ON tg.espn_game_id = gv.espn_game_id
    LEFT JOIN picks p ON p.espn_game_id = gv.espn_game_id
                     AND (
                       (gv.pick_slot = 'home_ml'     AND p.pick_type = 'ml'     AND p.is_home_team = 1)
                    OR (gv.pick_slot = 'away_ml'     AND p.pick_type = 'ml'     AND p.is_home_team = 0)
                    OR (gv.pick_slot = 'home_spread' AND p.pick_type = 'spread' AND p.is_home_team = 1)
                    OR (gv.pick_slot = 'away_spread' AND p.pick_type = 'spread' AND p.is_home_team = 0)
                    OR (gv.pick_slot = 'over'        AND p.pick_type = 'over')
                    OR (gv.pick_slot = 'under'       AND p.pick_type = 'under')
                     )
    WHERE gv.user_id = ?
    ORDER BY gv.voted_at ASC
  `).all(userId);

  res.json({ user, favoriteSports, votes });
});

// DELETE /api/game/:espn_game_id/vote — remove a vote while game is still pre-game
app.delete('/api/game/:espn_game_id/vote', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Login required' });

  const { espn_game_id } = req.params;
  const { slot } = req.body || {};

  if (!slot) return res.status(400).json({ error: 'slot required' });

  const game = db.prepare(`SELECT status FROM today_games WHERE espn_game_id = ?`).get(espn_game_id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.status === 'in' || game.status === 'post') {
    return res.status(409).json({ error: 'Game has started — vote cannot be removed' });
  }

  db.prepare(`DELETE FROM game_votes WHERE user_id = ? AND espn_game_id = ? AND pick_slot = ?`)
    .run(req.session.user.id, espn_game_id, slot);

  res.json({ ok: true });
});

// PUT /api/account/preferences — save favorite sports list
app.put('/api/account/preferences', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Login required' });
  const userId = req.session.user.id;
  const { favorite_sports } = req.body || {};

  const valid = ['MLB', 'NBA', 'NHL', 'NFL', 'NCAAF', 'CBB', 'ATP', 'WTA', 'Golf'];
  const sports = Array.isArray(favorite_sports)
    ? favorite_sports.filter(s => valid.includes(s))
    : [];

  db.prepare(`
    INSERT INTO user_preferences (user_id, favorite_sports, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      favorite_sports = excluded.favorite_sports,
      updated_at      = datetime('now')
  `).run(userId, JSON.stringify(sports));

  res.json({ ok: true, favoriteSports: sports });
});

// GET /api/lines/:team — original + live lines for a team
app.get('/api/lines/:team', (req, res) => {
  const lines = getLines(req.params.team);
  if (!lines) return res.status(404).json({ error: 'Team not found' });
  res.json(lines);
});

// GET /api/game/:espn_game_id — full game detail for popup
app.get('/api/game/:espn_game_id', async (req, res) => {
  const { espn_game_id } = req.params;

  const game = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(espn_game_id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const picks = db.prepare(`
    SELECT * FROM picks WHERE espn_game_id = ? AND mention_count > 0 ORDER BY score DESC
  `).all(espn_game_id);

  // Vote tallies
  const voteRows = db.prepare(`
    SELECT pick_slot, COUNT(*) AS count FROM game_votes WHERE espn_game_id = ? GROUP BY pick_slot
  `).all(espn_game_id);
  const votes = { home_ml: 0, away_ml: 0, home_spread: 0, away_spread: 0, over: 0, under: 0 };
  for (const r of voteRows) { if (votes[r.pick_slot] !== undefined) votes[r.pick_slot] = r.count; }

  // Current user's votes
  let userVote = {};
  if (req.session?.user?.id) {
    const userVotes = db.prepare(`
      SELECT pick_slot FROM game_votes WHERE espn_game_id = ? AND user_id = ?
    `).all(espn_game_id, req.session.user.id);
    for (const r of userVotes) userVote[r.pick_slot] = true;
  }

  // Rank map: pick_id → 1-based rank (picks already sorted score DESC)
  const pickRanks = {};
  picks.forEach((p, i) => { pickRanks[p.id] = i + 1; });

  const lines = getLinesForGame(espn_game_id);

  // Stats + weather in parallel (non-blocking — return nulls on error)
  let stats = { pitchers: [], injuries: [], venue: null, weather: null };
  try {
    stats = await getFullGameContext(espn_game_id, game.sport, game.home_team);
  } catch (_) {}

  const publicBetting = getPublicBettingForGame(espn_game_id);
  res.json({ game, picks, pickRanks, stats, weather: stats.weather ?? null, lines, votes, userVote, publicBetting });
});

// POST /api/game/:espn_game_id/vote — cast a vote on a pick slot
app.post('/api/game/:espn_game_id/vote', (req, res) => {
  if (!req.session?.user?.id) return res.status(401).json({ error: 'Login required' });

  const { espn_game_id } = req.params;
  const { slot } = req.body;
  const userId = req.session.user.id;

  const validSlots = ['home_ml', 'away_ml', 'home_spread', 'away_spread', 'over', 'under'];
  if (!validSlots.includes(slot)) return res.status(400).json({ error: 'Invalid slot' });

  const game = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(espn_game_id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.status === 'in' || game.status === 'post') {
    return res.status(409).json({ error: 'Voting closed — game has started' });
  }

  // Remove any vote on the opposing side of the same bet type
  const VOTE_PAIRS = { home_ml:'away_ml', away_ml:'home_ml', home_spread:'away_spread', away_spread:'home_spread', over:'under', under:'over' };
  const paired = VOTE_PAIRS[slot];

  try {
    db.prepare(`DELETE FROM game_votes WHERE user_id = ? AND espn_game_id = ? AND pick_slot = ?`)
      .run(userId, espn_game_id, paired);
    // Snapshot game metadata at vote time so it persists past the daily wipe
    db.prepare(`
      INSERT OR IGNORE INTO game_votes
        (user_id, espn_game_id, pick_slot, home_team, away_team, sport, ml_home, ml_away, ou_over_odds, ou_under_odds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, espn_game_id, slot,
           game.home_team, game.away_team, game.sport,
           game.ml_home, game.ml_away, game.ou_over_odds, game.ou_under_odds);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const voteRows = db.prepare(`
    SELECT pick_slot, COUNT(*) AS count FROM game_votes WHERE espn_game_id = ? GROUP BY pick_slot
  `).all(espn_game_id);
  const votes = { home_ml: 0, away_ml: 0, home_spread: 0, away_spread: 0, over: 0, under: 0 };
  for (const r of voteRows) { if (votes[r.pick_slot] !== undefined) votes[r.pick_slot] = r.count; }

  const userVotes = db.prepare(`
    SELECT pick_slot FROM game_votes WHERE espn_game_id = ? AND user_id = ?
  `).all(espn_game_id, userId);
  const userVote = {};
  for (const r of userVotes) userVote[r.pick_slot] = true;

  res.json({ votes, userVote });
});

// ── Scan state lives in discord_scanner.js — all paths update the same object ──
async function runScan() {
  await scanner.scanAll().catch(err => console.error('[cron] scan error:', err.message));
}

// GET /admin/scan-status
app.get('/admin/scan-status', (req, res) => res.json(scanner.getScanState()));

// POST /admin/scan-now
app.post('/admin/scan-now', (req, res) => {
  runScan(); // fire and forget
  res.json({ ok: true });
});

// POST /api/scan — manual scan trigger
app.post('/api/scan', async (req, res) => {
  try {
    const saved = await scanner.scanAll();
    res.json({ ok: true, saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Game detail page — slug helpers ──────────────────────────────────────────
function _teamSlug(name) {
  return (name || '').split(' ').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
}
function _sportSlug(sport) {
  const map = { CBB:'ncaamb', NCAAF:'ncaaf', ATP:'tennis', WTA:'tennis', Golf:'golf' };
  return (map[sport] || (sport || 'game')).toLowerCase();
}
function makeDetailUrl(game) {
  const sp   = _sportSlug(game.sport);
  const away = _teamSlug(game.away_team);
  const home = _teamSlug(game.home_team);
  const date = (game.start_time || '').slice(0, 10);
  return `/${sp}/${away}-vs-${home}-${date}`;
}

// 301 redirect: /game/:espn_game_id → slug URL
app.get('/game/:espn_game_id', (req, res) => {
  const game = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(req.params.espn_game_id);
  if (!game) return res.status(404).send('Game not found');
  return res.redirect(301, makeDetailUrl(game));
});

// Standalone detail page: /:sport/:slug
const { buildDetailPageHtml } = require('./src/detail_page');

app.get('/:sport/:slug', async (req, res) => {
  const { sport, slug } = req.params;

  // Valid sport slugs only — guard against catching arbitrary routes
  const SPORT_SLUGS = new Set(['nba','mlb','nhl','nfl','ncaamb','ncaaf','tennis','golf','cbb']);
  if (!SPORT_SLUGS.has(sport.toLowerCase())) return res.status(404).send('Not found');

  // Parse slug: "timberwolves-vs-nuggets-2026-04-28"
  const dateMatch = slug.match(/-(\d{4}-\d{2}-\d{2})$/);
  if (!dateMatch) return res.status(404).send('Not found');
  const date     = dateMatch[1];
  const teamPart = slug.slice(0, slug.length - date.length - 1);
  const vsSplit  = teamPart.split('-vs-');
  if (vsSplit.length < 2) return res.status(404).send('Not found');
  const [awaySlug, homeSlug] = vsSplit;

  // Sport → DB sport label
  const SPORT_MAP = {
    ncaamb:'CBB', ncaaf:'NCAAF', tennis:'ATP', nba:'NBA',
    mlb:'MLB', nhl:'NHL', nfl:'NFL', golf:'Golf', cbb:'CBB',
  };
  const sportFilter = SPORT_MAP[sport.toLowerCase()] || sport.toUpperCase();

  // Fuzzy match on team slug vs stored team names
  const game = db.prepare(`
    SELECT * FROM today_games
    WHERE (LOWER(sport) = LOWER(?) OR (? IN ('ATP','WTA') AND sport IN ('ATP','WTA')))
      AND LOWER(REPLACE(REPLACE(home_team,' ',''),'.','' )) LIKE ?
      AND LOWER(REPLACE(REPLACE(away_team,' ',''),'.','' )) LIKE ?
      AND DATE(start_time) = ?
    LIMIT 1
  `).get(sportFilter, sportFilter, `%${homeSlug}%`, `%${awaySlug}%`, date)
  // If strict fails, try tennis cross-match (ATP vs WTA same slug)
  || (sportFilter === 'ATP' && db.prepare(`
    SELECT * FROM today_games
    WHERE sport IN ('ATP','WTA')
      AND LOWER(REPLACE(REPLACE(home_team,' ',''),'.','' )) LIKE ?
      AND LOWER(REPLACE(REPLACE(away_team,' ',''),'.','' )) LIKE ?
      AND DATE(start_time) = ?
    LIMIT 1
  `).get(`%${homeSlug}%`, `%${awaySlug}%`, date));

  if (!game) return res.status(404).send('Game not found');

  try {
    const picks = db.prepare(`
      SELECT * FROM picks WHERE espn_game_id = ? AND mention_count > 0
      ORDER BY score DESC
    `).all(game.espn_game_id);

    // Pick ranks — same logic as /api/game/:id
    const allRanked = db.prepare(`
      SELECT id FROM picks WHERE game_date = ? AND mention_count > 0 ORDER BY score DESC
    `).all(getCycleDate());
    const pickRanks = {};
    allRanked.forEach((r, i) => { pickRanks[r.id] = i + 1; });

    // Votes
    const voteRows = db.prepare(`
      SELECT pick_slot, COUNT(*) AS total FROM game_votes WHERE espn_game_id = ? GROUP BY pick_slot
    `).all(game.espn_game_id);
    const votes = { home_ml:0, away_ml:0, home_spread:0, away_spread:0, over:0, under:0 };
    for (const v of voteRows) if (v.pick_slot in votes) votes[v.pick_slot] = v.total;

    // User vote
    const userId = req.session?.user?.id;
    const userVote = {};
    if (userId) {
      const uvRows = db.prepare(`SELECT pick_slot FROM game_votes WHERE espn_game_id = ? AND user_id = ?`).all(game.espn_game_id, userId);
      for (const r of uvRows) userVote[r.pick_slot] = true;
    }

    // Stats + lines (on-demand, same as API)
    const stats = await getFullGameContext(game.espn_game_id, game.sport, game.home_team).catch(() => ({}));
    const lines = getLinesForGame(game.espn_game_id);

    const publicBetting = getPublicBettingForGame(game.espn_game_id);
    const payload = {
      game, picks, pickRanks, votes, userVote, stats, lines, publicBetting,
      user: req.session?.user || null,
    };

    // SEO meta
    const away     = game.away_team || 'Away';
    const home     = game.home_team || 'Home';
    const longDate = new Date(game.start_time).toLocaleDateString('en-US',
      { weekday:'long', month:'long', day:'numeric', year:'numeric', timeZone:'America/New_York' });
    const title     = `${away} vs. ${home} · ${longDate} · CappingAlpha`;
    const desc      = `${game.sport} matchup: ${away} at ${home} on ${longDate}. See picks, lines, and sentiment on CappingAlpha.`;
    const canonical = `https://cappingalpha.com${makeDetailUrl(game)}`;
    const sportSlug = _sportSlug(game.sport);

    const html = buildDetailPageHtml({ title, desc, canonical, payload, game, away, home, longDate, sportSlug });
    res.send(html);
  } catch (err) {
    console.error('[detail-page] error:', err.message);
    res.status(500).send('Error loading game detail');
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('[CappperBoss] ─────────────────────────────────');
  console.log(`[CappperBoss] Server: http://localhost:${PORT}`);
  console.log('[CappperBoss] Active hours: 5:00AM–1:00AM ET');
  console.log(`[CappperBoss] Next wipe: 4:58AM ET`);
  console.log('[CappperBoss] ─────────────────────────────────');
});

// ── Startup: restore today's games if empty (handles restarts mid-day) ────────
// Does NOT call Odds API on restart — that runs on the 5am cron only.
// Golf + tennis always refreshed on startup regardless of today_games state.
(async () => {
  // Always refresh golf tournaments and tennis matches on startup — these are
  // cheap ESPN calls and must be current after any mid-day deploy/restart.
  await fetchTodaysTennisMatches().catch(err => console.error('[startup] fetchTodaysTennisMatches error:', err.message));
  await fetchGolfTournaments().catch(err => console.error('[startup] fetchGolfTournaments error:', err.message));

  const gameCount = db.prepare('SELECT COUNT(*) AS c FROM today_games').get().c;
  if (gameCount === 0) {
    console.log('[startup] today_games empty — fetching ESPN games and seeding slots...');
    await fetchTodaysGames().catch(err => console.error('[startup] fetchTodaysGames error:', err.message));
    const { seedPickSlots } = require('./src/lines');
    await seedPickSlots().catch(err => console.error('[startup] seedPickSlots error:', err.message));
  } else {
    console.log(`[startup] today_games has ${gameCount} games — skipping seed`);
  }

  // Populate ESPN odds (DraftKings) into today_games + book_lines.
  // Fills any null odds from today's 5am run and seeds pick slots.
  await refreshEspnOdds().catch(err => console.error('[startup] refreshEspnOdds error:', err.message));

  // Re-evaluate any pending MVP picks (covers picks reset by db.js migration on startup)
  await resolveResults().catch(err => console.error('[startup] resolveResults error:', err.message));

  // Immediately seed public betting % — no API credits, just HTML scrape.
  // Runs unconditionally on startup so data is always fresh after a restart.
  for (const s of ['NBA', 'NFL', 'MLB', 'NHL', 'NCAAF', 'CBB']) {
    fetchPublicBetting(s).catch(e => console.error(`[startup] publicBetting ${s}:`, e.message));
  }
})();

// ── Discord scanner + cron jobs (disabled in UI-only mode) ───────────────────
const UI_ONLY = !!process.env.UI_ONLY;
if (UI_ONLY) {
  console.log('[CappperBoss] UI_ONLY mode — scanner and paid API calls disabled');
} else {
  scanner.init();
}

// ── Cron jobs ─────────────────────────────────────────────────────────────────

// 4:58am ET — final resolve pass, then daily wipe
// Running resolveResults here catches late West Coast games that finish after the
// 1am active-hours cutoff but before the wipe clears picks and today_games.
if (!UI_ONLY) cron.schedule('58 4 * * *', async () => {
  console.log('[cron] 4:58am — pre-wipe final resolve');
  await resolveResults().catch(err => console.error('[cron] pre-wipe resolve error:', err.message));
  console.log('[cron] 4:58am — running daily wipe');
  await runDailyWipe().catch(err => console.error('[cron] wipe error:', err.message));
}, { timezone: 'America/New_York' });

if (!UI_ONLY) cron.schedule('0 5 * * *', async () => {
  console.log('[cron] 5:00am — morning setup: ESPN + Odds + seed slots');
  await fetchTodaysGames().catch(err => console.error('[cron] fetchTodaysGames error:', err.message));
  await fetchTodaysTennisMatches().catch(err => console.error('[cron] fetchTodaysTennisMatches error:', err.message));
  await fetchGolfTournaments().catch(err => console.error('[cron] fetchGolfTournaments error:', err.message));
  await refreshOdds().catch(err => console.error('[cron] refreshOdds error:', err.message));
  await lockMorningLines().catch(err => console.error('[cron] lockMorningLines error:', err.message));
  // Seed initial public betting percentages
  for (const s of Object.keys({ NBA:1, NFL:1, MLB:1, NHL:1, NCAAF:1, CBB:1 })) {
    fetchPublicBetting(s).catch(e => console.error(`[publicBetting] 5am ${s}:`, e.message));
  }
  console.log('[cron] 5:00am — first scan of new cycle (back to 12:30am)');
  await runScan();
}, { timezone: 'America/New_York' });

if (!UI_ONLY) cron.schedule('*/15 * * * *', async () => {
  if (!isActiveHours()) return;
  console.log('[cron] 15-min scan');
  await runScan();
});

if (!UI_ONLY) cron.schedule('0 16 * * *', async () => {
  console.log('[cron] 4pm odds refresh');
  await refreshOdds().catch(err => console.error('[cron] refreshOdds error:', err.message));
  const { seedPickSlots } = require('./src/lines');
  await seedPickSlots().catch(err => console.error('[cron] seedPickSlots error:', err.message));
  // Refresh public betting percentages
  for (const s of Object.keys({ NBA:1, NFL:1, MLB:1, NHL:1, NCAAF:1, CBB:1 })) {
    fetchPublicBetting(s).catch(e => console.error(`[publicBetting] 4pm ${s}:`, e.message));
  }
}, { timezone: 'America/New_York' });

// Smart public betting refresh: every 30 min, hourly cadence unless within 3h of a game start
const _lastPbFetch = {};
cron.schedule('*/30 8-23 * * *', async () => {
  const now = Date.now();
  const THREE_HOURS = 3 * 60 * 60 * 1000;
  for (const sport of ['NBA','NFL','MLB','NHL','NCAAF','CBB']) {
    // Skip only if no games at all today for this sport
    const anyGame = db.prepare(`SELECT 1 FROM today_games WHERE sport = ? LIMIT 1`).get(sport);
    if (!anyGame) continue;
    const upcoming = db.prepare(`
      SELECT start_time FROM today_games WHERE sport = ? AND status = 'pre'
      ORDER BY start_time ASC LIMIT 1
    `).get(sport);
    const gameStartsIn  = upcoming ? new Date(upcoming.start_time).getTime() - now : Infinity;
    const withinWindow  = gameStartsIn > 0 && gameStartsIn <= THREE_HOURS;
    const minsSinceFetch = (now - (_lastPbFetch[sport] || 0)) / 60000;
    if (withinWindow || minsSinceFetch >= 60) {
      fetchPublicBetting(sport).catch(e => console.error(`[publicBetting] cron ${sport}:`, e.message));
      _lastPbFetch[sport] = now;
    }
  }
}, { timezone: 'America/New_York' });

// Every 3 hours — refresh DraftKings lines from ESPN (free, no API credits)
if (!UI_ONLY) cron.schedule('0 */3 * * *', async () => {
  console.log('[cron] 3hr ESPN DK odds refresh');
  await refreshEspnOdds().catch(err => console.error('[cron] refreshEspnOdds error:', err.message));
}, { timezone: 'America/New_York' });

cron.schedule('*/5 * * * *', () => {
  const resolved = resolveConflictingMvpPicks();
  if (resolved > 0) console.log(`[cron] Resolved ${resolved} MVP pick conflicts`);
});

if (!UI_ONLY) cron.schedule('*/5 * * * *', async () => {
  if (!isActiveHours()) return;
  await updateLiveScores().catch(err => console.error('[cron] updateLiveScores error:', err.message));
  await updateTennisLiveScores().catch(err => console.error('[cron] updateTennisLiveScores error:', err.message));
  await updateGolfLeaderboards().catch(err => console.error('[cron] updateGolfLeaderboards error:', err.message));
  await resolveResults().catch(err => console.error('[cron] resolveResults error:', err.message));
});
