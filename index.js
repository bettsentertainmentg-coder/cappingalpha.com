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
const scanner = require('./src/expert_data');
const admin   = require('./src/admin');
const auth    = require('./src/auth');
const { publicPick, publicPicks } = require('./src/pick_privacy'); // strip proprietary scoring columns before any pick leaves the server
const { runDailyWipe, pruneStaleGames }   = require('./src/wipe');
const { lockMorningLines, getLines } = require('./src/lines');
const { fetchForwardGames } = require('./src/forward_games');
const { refreshOdds } = require('./src/odds_api');
const { getRecentMvpPicks, getAllTimeRecord, resolveConflictingMvpPicks } = require('./src/mvp');
const { getSetting } = require('./src/db');
// Paywall boundary: free users see rank #1 plus the public tail (rank > PAID_RANK_MAX);
// ranks 2..PAID_RANK_MAX are paid-only. Settings-backed so it's admin-tunable without a
// deploy. Single source of truth — the client reads it via /api/config (paid_rank_max).
const PAID_RANK_MAX = () => parseInt(getSetting('paid_rank_max', 50), 10) || 50;
const { fetchTodaysGames, refreshEspnOdds } = require('./src/espn_live');
const { syncLiveSituations } = require('./src/live_situation');
const { stampActualStarts, stampActualEnds } = require('./src/game_start_tracker');
const { getPickTimeline }   = require('./src/pick_timeline');
const { fetchTodaysTennisMatches, refreshTennisStartTimes } = require('./src/tennis_espn');
const { fetchTennisLines } = require('./src/bovada');
const { fetchTodaysWnbaGames }      = require('./src/wnba_espn');
const { fetchTodaysSoccerGames, updateSoccerLiveScores } = require('./src/soccer_espn');
const { fetchTodaysNcaafGames }     = require('./src/ncaaf_espn');
const { getNhlLive }                = require('./src/nhl_api');
const { fetchGolfTournaments, updateGolfLeaderboards }    = require('./src/golf_espn');
const { resolveResults, resolveVotes } = require('./src/results');
const { recomputeCapperRatings } = require('./src/capper_ratings');
const { discoverAnExperts, pollAnExperts } = require('./src/an_experts');
const { refreshPmWallets, pollPmWallets } = require('./src/polymarket_wallets');
const { refreshCoversContestants, pollCoversPicks } = require('./src/covers_contests');
const { getCycleDate, cycleDateForInstant, addDays, ET_OFFSET_MS } = require('./src/cycle');
const { buildResultsPageHtml } = require('./src/results_page');
const { pingIndexNow, corePages } = require('./src/indexnow');
const { MVP_THRESHOLD, CHANNEL_POINTS }               = require('./src/scoring');
const { getFullGameContext }                          = require('./src/game_stats');
const { getTeamHistory, getEventTeamPlayers, TEAM_SPORTS } = require('./src/team_history');
const { getPlayerGamelog, buildPlayerForm, computeKeyAverages } = require('./src/player_form');
const { getGameForm }                                 = require('./src/game_form');
const { getTennisHistory }                            = require('./src/tennis_player_form');
const { getLinesForGame }                             = require('./src/lines_scraper');
const { fetchPublicBetting, getPublicBettingForGame } = require('./src/public_betting');
const { syncLineHistory, syncLineHistorySoon, getLineHistoryForGame } = require('./src/line_history');
const { syncPolymarketData, syncPolymarketSoon, getPolymarketForGame } = require('./src/polymarket');
const { syncKalshiData, syncKalshiSoon, getKalshiForGame } = require('./src/kalshi');
const { syncEsportsMarkets, getTopEsportsGames } = require('./src/esports_markets');
const { getLineInsights } = require('./src/insights');
const { getHeadlines }   = require('./src/headlines');
const community          = require('./src/community');
const { getLiveState, prevPulseMag, savePulseMag, pushPulseHistory, getPulseHistory, pushWpHistory, getWpHistory } = require('./src/live_tracker');
const { liveWinProb, liveHomeWinProb, liveOverProb, gameProgress } = require('./src/win_prob');
const { genericProgress, clockHomeWP, anchoredWP, soccerProbs, genericOverProb, mlbCountAdjust } = require('./src/win_prob_generic');
const { SPORT_FAMILY } = require('./src/live_state');
const { getFeed } = require('./src/espn_summary');
const { getEspnWinProb } = require('./src/espn_summary');
const { getCoreProbs } = require('./src/espn_probs');
const { MOCK_ID, isMockId, mockActive, mockLiveState, mockFinalState, mockPulseHistory, mockFullPulseHistory, installMockLive } = require('./src/mock_live');
const { replayActive, isReplayId, installReplay, replayLiveState, replayFeed, clearReplays } = require('./src/replay_live');
const { computeValuePulse } = require('./src/live_value');
const { impliedLineForGame } = require('./src/implied_lines');
const { snapshotStartedMvpGames, getSnapshot } = require('./src/mvp_snapshot');
const push = require('./src/push');
push.init(); // free web push (VAPID keys auto-generate into settings on first boot)
const { getLeaderboard, getMemberProfile, getFriendsList, followCounts, finalizeLeaderboardAwards } = require('./src/leaderboard');
const { seedDummyAccounts, runDummyVotes, runDummyComments } = require('./src/dummy_accounts');

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

// Generic per-IP limiter for other sensitive write endpoints (password reset,
// code redemption). Each gets its own bucket so they don't share the login count.
function makeRateLimit({ max = 10, windowMs = 15 * 60 * 1000, msg = 'Too many attempts. Try again later.' } = {}) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of hits) {
      const fresh = times.filter(t => now - t < windowMs);
      if (fresh.length === 0) hits.delete(ip); else hits.set(ip, fresh);
    }
  }, 60 * 60 * 1000).unref();
  return (req, res, next) => {
    const ip  = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: msg });
    arr.push(now); hits.set(ip, arr); next();
  };
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // Required for secure cookies behind Railway/Heroku proxies
app.disable('x-powered-by'); // don't advertise Express

// Security headers on every response. No CSP here yet — the single-file index.html
// uses inline styles/scripts, so a strict CSP needs its own tested pass; these are
// the high-value, non-breaking headers. HSTS only when we're actually behind HTTPS.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // modern guidance: disable the legacy auditor
  if (process.env.SESSION_SECURE) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// Stripe webhook MUST be registered before express.json() — needs raw body for signature verification
app.post('/auth/stripe-webhook', express.raw({ type: 'application/json' }), auth.stripeWebhook);

app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret:            secret,
  resave:            false,
  saveUninitialized: false,
  // rolling: refresh the cookie (and the SQLite session expiry, via store.touch)
  // on every request so an active user effectively stays logged in — returning on
  // the same device doesn't force a re-login. Combined with the 30-day maxAge this
  // is a standard persistent "remember me" session.
  rolling:           true,
  store:             new SQLiteStore(),
  cookie: {
    httpOnly: true,           // JS can't read the cookie — blocks XSS token theft
    secure:   !!process.env.SESSION_SECURE, // set SESSION_SECURE=1 in prod behind HTTPS
    sameSite: 'lax',          // blocks most CSRF while allowing normal navigation
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days (rolling — refreshed each visit)
  },
}));
app.use('/auth/login',  loginRateLimit);
app.use('/auth/signup', loginRateLimit);
// Throttle the other unauthenticated / brute-forceable auth writes.
app.use('/auth/forgot-password', makeRateLimit({ max: 5,  windowMs: 15 * 60 * 1000, msg: 'Too many reset requests. Try again in 15 minutes.' }));
app.use('/auth/redeem-code',     makeRateLimit({ max: 10, windowMs: 15 * 60 * 1000, msg: 'Too many code attempts. Try again in 15 minutes.' }));
app.use('/admin', admin);
app.use('/auth', auth);
app.use('/api/bets', require('./src/bets_router'));   // Phase B personal bet tracking
app.use('/api/track', require('./src/track_schedule')); // bet-tracking week-ahead schedule (separate; custom-only, no Odds API)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));
// Uploaded member avatars live on the data volume (survive redeploys). Cached a day.
app.use('/avatars', express.static(path.join(__dirname, 'data', 'avatars'), { maxAge: 24 * 60 * 60 * 1000 }));

// ── Mirror production data locally ────────────────────────────────────────────
// Local dev runs UI_ONLY (no scanner, no AI) so its DB has no picks/games. With
// MIRROR_PROD set, read-only GET /api/* calls are proxied to production so the
// local UI shows real data. MIRROR_PROD=1 uses cappingalpha.com; or pass a URL.
// Gated on UI_ONLY so it can never run on Railway (prod never sets UI_ONLY).
const MIRROR_URL = (process.env.UI_ONLY && process.env.MIRROR_PROD)
  ? (process.env.MIRROR_PROD === '1' ? 'https://cappingalpha.com' : process.env.MIRROR_PROD.replace(/\/$/, ''))
  : null;
if (MIRROR_URL) {
  console.log(`[mirror] Proxying read-only /api GET requests to ${MIRROR_URL}`);
  // Endpoints that depend on local session (login state) or that don't exist on
  // prod yet (new features in development) stay local. The proxy never forwards
  // cookies, so anything session-scoped MUST be here or it returns logged-out data.
  const MIRROR_SKIP = ['/api/account', '/api/game-form', '/api/bets', '/api/push', '/api/track', '/api/friends'];
  app.use((req, res, next) => {
    if (req.method !== 'GET' || !req.path.startsWith('/api/')) return next();
    if (MIRROR_SKIP.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
    // Games + game detail are served LOCALLY: the local board now carries data
    // prod doesn't have yet (odds-engine books, soccer, engine events), and the
    // game handler already pulls its PICK context from the mirror internally, so
    // local pages get local lines + prod picks. /api/games/top stays mirrored
    // (it ranks by public-betting volume, which only prod accumulates).
    if (req.path === '/api/games' || /^\/api\/game\/[^/]+/.test(req.path)) return next();
    // Local mock live game (dev only): serve Top Games + its detail/pick data
    // locally so the mock surfaces and the real prod top games aren't needed.
    if (mockActive() && (req.path === '/api/games/top' || req.path.startsWith('/api/game/' + MOCK_ID))) return next();
    const target = MIRROR_URL + req.originalUrl;
    fetch(target, { headers: { accept: 'application/json' } })
      .then(async (r) => {
        const body = await r.text();
        res.status(r.status);
        const ct = r.headers.get('content-type');
        if (ct) res.set('content-type', ct);
        res.send(body);
      })
      .catch((err) => {
        console.warn(`[mirror] ${req.path} failed (${err.message}) — falling back to local`);
        next();
      });
  });
}

// Local-dev mock live game (no-op unless UI_ONLY). Inert in production. Re-install on
// a timer so it survives the daily wipe that clears today_games (idempotent upsert).
installMockLive(db);
if (mockActive()) setInterval(() => installMockLive(db), 60 * 1000).unref();

// Local-dev archived-game replay (route-only, nothing auto-installs at startup).
// GET /dev/replay?event=<espnId>&sport=NFL&speed=8 installs a finished real game
// as 'replay_<id>' and replays it through the tracker; ?clear=1 removes replay
// rows. Registered only when replayActive(), so the route does not exist in prod.
if (replayActive()) {
  app.get('/dev/replay', async (req, res) => {
    try {
      if (req.query.clear === '1') {
        return res.json({ cleared: clearReplays(db) });
      }
      const event = String(req.query.event || '').trim();
      const sport = String(req.query.sport || '').trim().toUpperCase();
      if (!event || !sport) return res.status(400).json({ error: 'event and sport are required, e.g. /dev/replay?event=401772966&sport=NFL&speed=8' });
      const speed = req.query.speed ? Number(req.query.speed) : 8;
      const out = await installReplay(db, event, sport, speed);
      res.json({ ok: true, url: `/game/${out.replayId}`, replayId: out.replayId, frames: out.frames, sport, speed: out.speed });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}

// Terms of Service page
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// Privacy Policy page
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// FAQ page (static, carries FAQPage structured data)
app.get('/faq', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'faq.html'));
});

// Track-record page — server-rendered, crawlable. Renders the public MVP record
// as plain HTML so search + AI engines can read it without running JS. Mirrors
// the /api/mvp/public query.
app.get('/results', (req, res) => {
  try {
    const threshold = parseInt(getSetting('mvp_display_threshold', MVP_THRESHOLD), 10);
    const picks = db.prepare(`
      SELECT m.*,
             COALESCE(m.home_team, tg.home_team) AS home_team,
             COALESCE(m.away_team, tg.away_team) AS away_team
      FROM mvp_picks m
      LEFT JOIN today_games tg ON m.home_team IS NULL AND tg.espn_game_id = m.espn_game_id
      WHERE m.result IN ('win', 'loss', 'push') AND m.score >= ?
        AND (m.annotation IS NULL OR m.annotation NOT LIKE '%not counted%')
      ORDER BY m.saved_at DESC
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

    res.send(buildResultsPageHtml({
      picks,
      record: { wins: counts.win, losses: counts.loss, pushes: counts.push, win_rate },
    }));
  } catch (e) {
    console.error('[results] render failed:', e.message);
    res.status(500).send('Track record temporarily unavailable.');
  }
});

// Sitemap — submitted to Google Search Console
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://cappingalpha.com/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
  <url><loc>https://cappingalpha.com/results</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
  <url><loc>https://cappingalpha.com/faq</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>
  <url><loc>https://cappingalpha.com/mlb</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>https://cappingalpha.com/nba</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>https://cappingalpha.com/wnba</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>https://cappingalpha.com/nfl</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>https://cappingalpha.com/nhl</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>https://cappingalpha.com/ncaaf</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>https://cappingalpha.com/cbb</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>https://cappingalpha.com/tennis</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>https://cappingalpha.com/golf</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>https://cappingalpha.com/soccer</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>https://cappingalpha.com/mma</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>https://cappingalpha.com/terms</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>
  <url><loc>https://cappingalpha.com/privacy</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>
</urlset>`);
});

// GET /api/headlines — sports betting news from Google News, Reddit, ESPN (30-min cache)
app.get('/api/headlines', async (req, res) => {
  try {
    res.json(await getHeadlines());
  } catch (_) {
    res.json([]);
  }
});

// GET /api/config — scoring constants for the frontend
// NOTE: channel_points intentionally excluded — exposes Discord channel names + weights
app.get('/api/config', (req, res) => {
  const displayThreshold = parseInt(getSetting('mvp_display_threshold', MVP_THRESHOLD), 10);
  const betUnit = parseFloat(getSetting('bet_unit', 10)) || 10;
  res.json({
    mvp_threshold: MVP_THRESHOLD,
    mvp_display_threshold: displayThreshold,
    bet_unit: betUnit,
    paid_rank_max: PAID_RANK_MAX(),
    google_client_id: process.env.GOOGLE_CLIENT_ID || null,
  });
});

// ── POST /api/support — contact / suggestion form (About page) ────────────────
// Send-only via Resend: emails the ticket to SUPPORT_EMAIL (default
// support@cappingalpha.com) FROM noreply@cappingalpha.com, with reply_to set to
// the submitter so a reply goes straight back to them. No inbound mailbox needed
// on the domain for this to work — only that SUPPORT_EMAIL can receive mail.
const _supportAttempts = new Map();
function supportRateLimit(req, res, next) {
  const ip     = req.ip || req.connection.remoteAddress || 'unknown';
  const now    = Date.now();
  const WINDOW = 15 * 60 * 1000; // 15 minutes
  const MAX    = 5;              // messages per window per IP
  const hits = (_supportAttempts.get(ip) || []).filter(t => now - t < WINDOW);
  if (hits.length >= MAX) {
    return res.status(429).json({ error: 'Too many messages. Please try again in a little while.' });
  }
  hits.push(now);
  _supportAttempts.set(ip, hits);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of _supportAttempts) {
    const fresh = times.filter(t => now - t < 15 * 60 * 1000);
    if (fresh.length === 0) _supportAttempts.delete(ip);
    else _supportAttempts.set(ip, fresh);
  }
}, 60 * 60 * 1000).unref();

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

app.post('/api/support', supportRateLimit, async (req, res) => {
  const { email, message, topic, website } = req.body || {};

  // Honeypot — bots fill hidden fields. Pretend success, drop silently.
  if (website) return res.json({ success: true });

  const msg  = (message || '').toString().trim();
  const from = (email || '').toString().trim();
  if (msg.length < 5)    return res.status(400).json({ error: 'Please include a short message.' });
  if (msg.length > 5000) return res.status(400).json({ error: 'That message is a bit too long.' });
  if (from && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) {
    return res.status(400).json({ error: 'That email address does not look right.' });
  }

  const dest      = process.env.SUPPORT_EMAIL || 'support@cappingalpha.com';
  const safeTopic = (topic || 'General').toString().slice(0, 40);
  const acct      = req.session?.user
    ? `${req.session.user.email || req.session.user.username} (#${req.session.user.id})`
    : 'not logged in';

  if (!process.env.RESEND_API_KEY) {
    console.error('[support] RESEND_API_KEY not set — ticket not emailed');
    return res.status(503).json({ error: 'Support is temporarily unavailable. Please email support@cappingalpha.com directly.' });
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:     'CappingAlpha Support <noreply@cappingalpha.com>',
        to:       [dest],
        reply_to: from || undefined,
        subject:  `[Support] ${safeTopic}`,
        html: `
          <p><strong>Topic:</strong> ${escHtml(safeTopic)}</p>
          <p><strong>From:</strong> ${escHtml(from || 'no email provided')}</p>
          <p><strong>Account:</strong> ${escHtml(acct)}</p>
          <hr>
          <p style="white-space:pre-wrap;">${escHtml(msg)}</p>
        `,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[support] Resend non-OK:', r.status, detail);
      return res.status(502).json({ error: 'Could not send right now. Please try again, or email support@cappingalpha.com.' });
    }
  } catch (err) {
    console.error('[support] Resend error:', err.message);
    return res.status(502).json({ error: 'Could not send right now. Please try again, or email support@cappingalpha.com.' });
  }

  res.json({ success: true });
});

// GET /api/picks — today's picks ordered by score desc, enriched with matchup
// "Today's board" rolls over at the daily wipe (~5am ET), not the 12:30am scanner
// cycle. Shared by /api/picks, /api/picks/top, and /api/games/top so the #1 pick,
// the picks list, and the Top Games strip all agree on which slate is "today".
function currentBoardDate() {
  const nowET = new Date(Date.now() - ET_OFFSET_MS);
  let boardDate = nowET.toISOString().slice(0, 10);
  if (nowET.getUTCHours() < 5) boardDate = addDays(boardDate, -1);
  return boardDate;
}
function isOnBoard(startTime, boardDate) {
  return !!startTime && cycleDateForInstant(startTime) === boardDate;
}

app.get('/api/picks', (req, res) => {
  // Active slate = picks whose game is on TODAY'S BOARD (rolls at the ~5am wipe).
  // The prune keeps finished games (and their picks) until the cycle clear + grace
  // tail, so a join to today_games alone isn't enough — without the board-day
  // filter, yesterday's finished, already-graded picks linger and outrank today's
  // (a stale graded loss was showing up as the #1 pick). Scope to the board day.
  const boardDate = currentBoardDate();
  const PICKS_QUERY = `
    SELECT p.*,
           tg.home_team  AS home_team,
           tg.away_team  AS away_team,
           tg.start_time AS start_time,
           tg.status     AS game_status,
           tg.period     AS game_period,
           tg.clock      AS game_clock,
           tg.home_score AS game_home_score,
           tg.away_score AS game_away_score,
           tg.live_detail AS game_live_detail,
           tg.live_outs   AS game_live_outs,
           tg.live_bases  AS game_live_bases
    FROM picks p
    JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
    WHERE p.mention_count > 0
    GROUP BY p.id
    ORDER BY p.score DESC, p.id ASC
  `;
  const picks = db.prepare(PICKS_QUERY).all().filter(p => isOnBoard(p.start_time, boardDate));

  // Canonical rank over non-push picks (score desc). Pushes are settled/void and
  // don't occupy a ranked slot. Attached so the picks table and Sports tab agree
  // on rank instead of each deriving it from array position.
  let r = 0;
  for (const p of picks) p.rank = (p.result === 'push') ? null : (++r);

  // Server-side paywall enforcement. Free/logged-out users only ever receive the
  // actual #1 pick — EVERY other ranked pick (2..end) is withheld server-side and
  // flagged locked (no more public tail). Pushes (rank null) stay full.
  // Tiered visibility. Paid: everything. Free account: the #1 ranked pick only.
  // Logged-out visitor: nothing — the #1 pick is account-gated to encourage signups,
  // so every ranked pick is withheld and the client shows a "create a free account"
  // CTA in its place.
  const paid = auth.isPaid(req);
  if (!paid) {
    const authed = auth.isAuthed(req);
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      const visible = authed && p.rank === 1;   // free account sees only the #1
      if (p.rank && !visible) {
        // Keep only what the UI needs to render a locked row + paywall nudge.
        // sport is retained so the Sports tab can still show "a locked pick here";
        // team/side/score/game are all withheld.
        picks[i] = { id: p.id, rank: p.rank, sport: p.sport, result: null, locked: true };
      }
    }
  }

  // Strip the proprietary scoring columns (channel/weight/bonuses/raw_message) from
  // every row that survived the paywall pass; capper_name only ships to paid.
  res.json(publicPicks(picks, { paid }));
});

// GET /api/picks/top — #1 pick today
app.get('/api/picks/top', (req, res) => {
  // The #1 ranked pick is account-gated — logged-out visitors get nothing here and
  // the client shows a "create a free account" card in the #1 slot instead.
  if (!auth.isAuthed(req)) return res.json({ locked: true });
  // #1 pick on TODAY'S BOARD only (rolls at the ~5am wipe). Without the board-day
  // filter, yesterday's finished picks linger in the table (the prune keeps them
  // for final scores) and a stale graded loss could win as "Today's #1 Pick".
  const boardDate = currentBoardDate();
  const rows = db.prepare(`
    SELECT p.*,
           tg.home_team  AS home_team,
           tg.away_team  AS away_team,
           tg.start_time AS start_time,
           tg.status     AS game_status,
           tg.period     AS game_period,
           tg.clock      AS game_clock,
           tg.home_score AS game_home_score,
           tg.away_score AS game_away_score,
           tg.live_detail AS game_live_detail,
           tg.live_outs   AS game_live_outs,
           tg.live_bases  AS game_live_bases
    FROM picks p
    JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
    WHERE p.mention_count > 0
    ORDER BY p.score DESC, p.id ASC
  `).all();
  const pick = rows.find(p => isOnBoard(p.start_time, boardDate)) || null;
  res.json(pick ? publicPick(pick, { paid: auth.isPaid(req) }) : pick);
});

// GET /api/mvp — recent MVP picks + all-time record (paid users only).
// Free users get /api/mvp/public instead. requirePaid returns 403 otherwise so
// the full pick list is never sent to non-paying clients.
app.get('/api/mvp', auth.requirePaid, (req, res) => {
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
           COALESCE(m.home_team, tg.home_team) AS home_team,
           COALESCE(m.away_team, tg.away_team) AS away_team
    FROM mvp_picks m
    LEFT JOIN today_games tg ON m.home_team IS NULL AND tg.espn_game_id = m.espn_game_id
    WHERE m.result IN ('win', 'loss', 'push') AND m.score >= ?
      AND (m.annotation IS NULL OR m.annotation NOT LIKE '%not counted%')
    ORDER BY m.saved_at DESC
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

// GET /api/pick-history — permanent pick archive (≥35pts, survives daily wipe)
// Query params: ?sport=MLB  ?result=win|loss|push|pending  ?limit=100 (max 500)
app.get('/api/pick-history', (req, res) => {
  const sport  = req.query.sport  || null;
  const result = req.query.result || null;
  const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  // Explicit display-safe column list — NEVER SELECT *. pick_history rows carry the
  // proprietary scoring decomposition (channel, channel_points, sport_bonus,
  // home_bonus), the raw scanned messages (messages_json), and capper_name; this
  // endpoint is public, so those columns must never ship. `score` stays: the
  // permanent archive is a public transparency record by design.
  let sql = `SELECT id, pick_id, espn_game_id, sport, game_date,
                    home_team, away_team, home_abbr, away_abbr, team,
                    pick_type, spread, ml_odds, ou_odds, is_home_team,
                    score, mention_count, result, home_score, away_score,
                    first_seen_at, resolved_at, archived_at
             FROM pick_history WHERE 1=1`;
  const params = [];
  if (sport) {
    // "Tennis" is a virtual filter that blends both tours (ATP + WTA).
    if (sport.toLowerCase() === 'tennis') {
      sql += ` AND UPPER(sport) IN ('ATP','WTA')`;
    } else {
      sql += ` AND UPPER(sport) = UPPER(?)`; params.push(sport);
    }
  }
  if (result) { sql += ` AND LOWER(result) = LOWER(?)`; params.push(result); }
  sql += ` ORDER BY archived_at DESC LIMIT ?`;
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/games — today's games for schedule widget, optional ?sport= filter
app.get('/api/games', (req, res) => {
  const sport = req.query.sport;
  // Exclude tennis bracket placeholders ("TBD vs TBD" future-round slots).
  const noTbd = `AND UPPER(COALESCE(home_team,'')) != 'TBD' AND UPPER(COALESCE(away_team,'')) != 'TBD'`;
  const cols = `espn_game_id, sport, home_team, away_team, start_time, status, home_score, away_score, period, clock, live_detail, live_outs, live_bases, ml_home, ml_away, spread_home, spread_away, over_under, ou_over_odds, ou_under_odds`;
  let rows = sport
    ? db.prepare(`SELECT ${cols} FROM today_games WHERE UPPER(sport) = UPPER(?) ${noTbd} ORDER BY start_time ASC`).all(sport)
    : db.prepare(`SELECT ${cols} FROM today_games WHERE 1=1 ${noTbd} ORDER BY start_time ASC`).all();
  // Opt-in board scoping: today_games can hold future-dated rows (e.g. the same
  // MLB matchup tomorrow). When ?board=1 is passed, keep only games whose ET cycle
  // date is today's board day — same rule /api/games/top uses. Callers that want
  // the full schedule (Sports tab, game search) omit the flag.
  // Tennis runs on a global clock: early-morning European slates land on tomorrow's
  // board but are only hours away, so tennis also keeps upcoming matches within the
  // next ~10h. Every other sport stays day-only. Mirrored client-side in utils.js.
  if (req.query.board === '1') {
    const boardDate = currentBoardDate();
    const now = Date.now();
    const TENNIS_LOOKAHEAD_MS = 10 * 60 * 60 * 1000;
    rows = rows.filter(g => {
      if (cycleDateForInstant(g.start_time) === boardDate) return true;
      const sp = (g.sport || '').toUpperCase();
      if (sp === 'ATP' || sp === 'WTA') {
        const t = new Date(g.start_time).getTime();
        if (!Number.isNaN(t) && t >= now && (t - now) <= TENNIS_LOOKAHEAD_MS) return true;
      }
      return false;
    });
  }
  res.json(rows);
});

// GET /api/games/top — hottest games of the day, ranked by prediction-market
// volume (Polymarket + Kalshi). Reads only cached tables — no Odds API calls.
// Each game carries its top-scored pick for the "CappingAlpha score" corner; the
// game holding the overall #1 pick is flagged so the frontend can show it free.
app.get('/api/games/top', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 13, 30);

  // Optional sport filter (used by the home "My Sports" strips). Tennis = ATP+WTA.
  const sportParam = (req.query.sport || '').trim();
  let sportFilter = null;
  if (sportParam) {
    sportFilter = (sportParam.toLowerCase() === 'tennis')
      ? ['ATP', 'WTA']
      : [sportParam.toUpperCase()];
  }

  // "Today's board" rolls over at the daily wipe (~5am ET), NOT at the 12:30am
  // scanner-cycle boundary: a finished game keeps riding the board with its final
  // score until the morning wipe. Shared with /api/picks + /api/picks/top so the
  // strip, the picks list, and the #1 pick all agree on "today".
  const boardDate = currentBoardDate();

  // Candidate games = everything on today's board (pre / in / post), with whatever
  // cached market volume exists. Finished games are INCLUDED so the tile shows the
  // final score instead of falling through to a future duplicate of the matchup.
  let candidates = db.prepare(`
    SELECT tg.espn_game_id, tg.sport, tg.home_team, tg.away_team,
           tg.home_short, tg.away_short, tg.home_abbr, tg.away_abbr,
           tg.home_score, tg.away_score,
           tg.tennis_score_detail, tg.home_flag, tg.away_flag,
           tg.status, tg.period, tg.clock, tg.start_time,
           tg.live_detail, tg.live_outs, tg.live_bases,
           pm.volume_usd AS pm_vol,
           k.volume_yes  AS k_vol
    FROM today_games tg
    LEFT JOIN polymarket_cache pm ON pm.espn_game_id = tg.espn_game_id
    LEFT JOIN kalshi_cache     k  ON k.espn_game_id  = tg.espn_game_id
  `).all();

  // Scope to the current board day so a matchup's future-dated rows don't replace
  // today's. Each game's ET cycle date (start_time → cycleDateForInstant) must
  // equal the board day.
  candidates = candidates.filter(g => isMockId(g.espn_game_id) || cycleDateForInstant(g.start_time) === boardDate);

  if (sportFilter) {
    const want = sportFilter.map(s => s.toUpperCase());
    candidates = candidates.filter(g => want.includes((g.sport || '').toUpperCase()));
  }

  // Drop bracket placeholders — future-round tennis slots whose players are not
  // yet determined come back from ESPN as "TBD vs TBD" and must never be featured.
  candidates = candidates.filter(g => {
    const h = (g.home_team || '').trim().toUpperCase();
    const a = (g.away_team || '').trim().toUpperCase();
    return h && a && h !== 'TBD' && a !== 'TBD';
  });

  // Collapse a multi-game series (e.g. a 3-game set, same two teams on
  // consecutive days) down to one tile per matchup — prefer the live/today
  // game, otherwise the soonest upcoming one.
  const byMatch = new Map();
  for (const g of candidates) {
    const key = `${(g.away_team || '').toLowerCase()}@${(g.home_team || '').toLowerCase()}`;
    const cur = byMatch.get(key);
    if (!cur) { byMatch.set(key, g); continue; }
    const liveCur = cur.status === 'in', liveG = g.status === 'in';
    let keep;
    if (liveCur !== liveG) keep = liveG ? g : cur;
    else keep = String(g.start_time || '') < String(cur.start_time || '') ? g : cur;
    byMatch.set(key, keep);
  }
  candidates = [...byMatch.values()];

  if (!candidates.length) return res.json([]);

  // Hotness = ABSOLUTE combined market volume (Polymarket USD + Kalshi), missing
  // source counted as 0. We used to normalize each market to 0–1 against the slate
  // then average the present sources, but a single Polymarket whale (e.g. a $5M+
  // tennis match) inflated the Polymarket max and crushed every other
  // Polymarket-only game — so a Kalshi-only tennis match with ~$800k outranked an
  // NHL game carrying $1M+ on Polymarket. Summing real dollars tracks how much
  // action a game is actually getting, which is what "hottest" should mean, and a
  // game present in BOTH markets correctly ranks above one present in only one.
  for (const g of candidates) {
    g._hotness = (g.pm_vol || 0) + (g.k_vol || 0);
  }

  // Fallback before market data syncs in the morning: order by start time so the
  // row is never empty.
  const anyVolume = candidates.some(g => g._hotness > 0);
  candidates.sort(anyVolume
    ? (a, b) => b._hotness - a._hotness
    : (a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));

  const top = candidates.slice(0, limit);

  // Overall #1 pick (same rule as /api/picks/top) — its game's score is free.
  const globalTop = db.prepare(`
    SELECT p.espn_game_id
    FROM picks p
    JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
    WHERE p.mention_count > 0
    ORDER BY p.score DESC, p.id ASC LIMIT 1
  `).get();
  const globalTopGameId = globalTop ? globalTop.espn_game_id : null;

  const topPickStmt = db.prepare(`
    SELECT id, score, team, pick_type, spread
    FROM picks
    WHERE espn_game_id = ? AND mention_count > 0
    ORDER BY score DESC, id ASC LIMIT 1
  `);

  // How many picks on this game actually scored — drives the "multiple picks"
  // indicator on the tile.
  const pickCountStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM picks
    WHERE espn_game_id = ? AND mention_count > 0 AND score > 0
  `);

  // Paywall: the corner CA score is paid content. Free/logged-out users only get
  // the real score for the overall #1 game; every other game's score is withheld
  // server-side (not just blurred in the browser) and flagged locked so the tile
  // can render a lock. pick_count is non-sensitive and always sent.
  const paid = auth.isPaid(req);

  const out = top.map(g => {
    const tp = topPickStmt.get(g.espn_game_id);
    const pickCount = pickCountStmt.get(g.espn_game_id).c;
    const isG1 = g.espn_game_id === globalTopGameId;
    const unlocked = paid || isG1;
    return {
      espn_game_id: g.espn_game_id,
      sport:        g.sport,
      home_team:    g.home_team,
      away_team:    g.away_team,
      home_short:   g.home_short,
      away_short:   g.away_short,
      home_abbr:    g.home_abbr,
      away_abbr:    g.away_abbr,
      home_score:   g.home_score,
      away_score:   g.away_score,
      tennis_score_detail: g.tennis_score_detail,
      home_flag:    g.home_flag,
      away_flag:    g.away_flag,
      status:       g.status,
      period:       g.period,
      clock:        g.clock,
      start_time:   g.start_time,
      live_detail:  g.live_detail,
      live_outs:    g.live_outs,
      live_bases:   g.live_bases,
      pm_vol:       g.pm_vol,
      k_vol:        g.k_vol,
      pick_count:   pickCount,
      top_pick: tp
        ? (unlocked
            ? { score: tp.score, team: tp.team, pick_type: tp.pick_type, spread: tp.spread, is_global_1: isG1, locked: false }
            // Locked: withhold score/team/side entirely, keep only the flag.
            : { score: null, team: null, pick_type: null, spread: null, is_global_1: false, locked: true })
        : null,
    };
  });

  res.json(out);
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
             score, mention_count, result, game_date, parsed_at
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
    // gp.* includes the proprietary `channel` column — strip model columns before
    // sending (capper_name is kept: the golf modal displays it).
    res.json(publicPicks(picks, { paid: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/esports/top — top esports matches across all titles, ranked by volume
// (scraped from Kalshi + Polymarket, no ESPN coverage). Powers the Esports tab row.
app.get('/api/esports/top', (req, res) => {
  try {
    res.json(getTopEsportsGames());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leaderboard?window=week|month|all — public board (private members hidden)
// plus the logged-in user's own row/rank (shown even when private/unqualified).
// Public read; "me" only resolves when logged in.
app.get('/api/leaderboard', (req, res) => {
  const window = (req.query.window || 'week').toLowerCase();
  const meId   = req.session?.user?.id ?? null;
  try {
    res.json(getLeaderboard(window, meId));
  } catch (err) {
    console.error('[leaderboard]', err.message);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// GET /api/friends — the members the logged-in user follows (directory for the
// Friends page). Each entry carries all-time stats + a mutual flag, clickable
// through to the full profile popup.
app.get('/api/friends', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Login required' });
  try {
    res.json(getFriendsList(req.session.user.id));
  } catch (err) {
    console.error('[friends]', err.message);
    res.status(500).json({ error: 'Failed to load friends' });
  }
});

// POST/DELETE /api/follow/:userId — follow or unfollow a member (one-way, Twitter
// style). Returns the target's updated follower count + your new follow state.
app.post('/api/follow/:userId', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Login required' });
  const me = req.session.user.id;
  const target = parseInt(req.params.userId, 10);
  if (!Number.isInteger(target)) return res.status(400).json({ error: 'Bad user id' });
  if (target === me) return res.status(400).json({ error: 'You cannot follow yourself' });
  const exists = db.prepare(`SELECT id FROM users WHERE id = ?`).get(target);
  if (!exists) return res.status(404).json({ error: 'Member not found' });
  db.prepare(`INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)`).run(me, target);
  res.json({ ok: true, is_following: true, ...followCounts(target) });
});

app.delete('/api/follow/:userId', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Login required' });
  const me = req.session.user.id;
  const target = parseInt(req.params.userId, 10);
  if (!Number.isInteger(target)) return res.status(400).json({ error: 'Bad user id' });
  db.prepare(`DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`).run(me, target);
  res.json({ ok: true, is_following: false, ...followCounts(target) });
});

// GET /api/member/:userId — public profile popup data (stats, badges, recent picks).
// 403 for a private member requested by anyone but themselves (no enumeration).
app.get('/api/member/:userId', (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Bad user id' });
  const meId = req.session?.user?.id ?? null;
  const window = (req.query.window || 'all').toLowerCase();
  try {
    const profile = getMemberProfile(userId, meId, window);
    if (!profile) return res.status(404).json({ error: 'Member not found' });
    if (profile.error === 'private') return res.status(403).json({ error: 'This member is private' });
    res.json(profile);
  } catch (err) {
    console.error('[member]', err.message);
    res.status(500).json({ error: 'Failed to load member' });
  }
});

// GET /api/account — current user's profile + preferences + today's voted picks
app.get('/api/account', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Login required' });
  const userId = req.session.user.id;

  const user = db.prepare(`SELECT id, email, username, username_changed_at, subscription_tier, subscription_expires, created_at, avatar_path FROM users WHERE id = ?`).get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const prefs = db.prepare(`SELECT favorite_sports, is_public, unit_size, starting_bankroll, default_odds, my_books FROM user_preferences WHERE user_id = ?`).get(userId);
  const favoriteSports = prefs ? JSON.parse(prefs.favorite_sports || '[]') : [];
  const isPublic = prefs ? (prefs.is_public == null ? 1 : prefs.is_public) : 1;
  const unitSize = prefs && prefs.unit_size != null ? prefs.unit_size : 20;
  const startingBankroll = prefs && prefs.starting_bankroll != null ? prefs.starting_bankroll : 0;
  const defaultOdds = prefs && prefs.default_odds ? prefs.default_odds : 'consensus';
  const myBooks = prefs ? JSON.parse(prefs.my_books || '[]') : [];
  const avatarUrl = user.avatar_path ? `/avatars/${user.avatar_path}` : null;

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
           COALESCE(p.score, gv.score) AS score, p.mention_count,
           COALESCE(p.result, gv.result) AS result,
           p.pick_type, p.team,
           gv.closing_odds, gv.closing_line, gv.user_stake, gv.user_odds,
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

  // Paywall parity: the CA pick score is paid-only (ranks 2..paid_rank_max). A free
  // user must not read it off their own voted games here — null it unless paid.
  if (!auth.isPaid(req)) { for (const v of votes) v.score = null; }

  res.json({ user, favoriteSports, isPublic, unitSize, startingBankroll, defaultOdds, myBooks, avatarUrl, votes });
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

// ── Web push (free VAPID) — device subscriptions for bet-grade alerts ─────────
app.get('/api/push/key', (req, res) => {
  const key = push.getPublicKey();
  if (!key) return res.status(503).json({ error: 'Push is not available right now.' });
  res.json({ key });
});
app.post('/api/push/subscribe', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Login required' });
  const ok = push.saveSubscription(req.session.user.id, req.body || {});
  if (!ok) return res.status(400).json({ error: 'Invalid subscription' });
  res.json({ ok: true });
});
app.delete('/api/push/subscribe', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Login required' });
  const endpoint = (req.body || {}).endpoint;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  push.removeSubscription(req.session.user.id, endpoint);
  res.json({ ok: true });
});

// PUT /api/account/preferences — save favorite sports and/or leaderboard privacy.
// Accepts a partial body: only the fields present are changed; the rest are kept.
app.put('/api/account/preferences', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Login required' });
  const userId = req.session.user.id;
  const { favorite_sports, is_public, unit_size, starting_bankroll, default_odds, my_books } = req.body || {};

  const valid = ['MLB', 'NBA', 'WNBA', 'NHL', 'NFL', 'NCAAF', 'CBB', 'ATP', 'WTA', 'Golf', 'Soccer'];
  const ODDS_SOURCES = ['consensus', 'draftkings', 'fanduel', 'kalshi', 'polymarket'];
  // Canonical "My books" keys. Superset of what we scrape: the picker is about where
  // the user bets, not which books we have lines for. Mirror of the catalog in
  // public/modules/books.js — keep the two in sync.
  const BOOK_KEYS = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'espnbet', 'fanatics',
                     'betrivers', 'hardrock', 'bet365', 'circa',
                     'kalshi', 'polymarket', 'novig', 'prophetx',
                     'bovada', 'pinnacle', 'betonline', 'mybookie', 'betus',
                     'prizepicks', 'underdog', 'fliff', 'other'];

  // Read the current row so a partial update preserves the untouched fields.
  const cur = db.prepare(`SELECT favorite_sports, is_public, unit_size, starting_bankroll, default_odds, my_books FROM user_preferences WHERE user_id = ?`).get(userId);

  const sports = favorite_sports !== undefined
    ? (Array.isArray(favorite_sports) ? favorite_sports.filter(s => valid.includes(s)) : [])
    : (cur ? JSON.parse(cur.favorite_sports || '[]') : []);

  const pub = is_public !== undefined
    ? (is_public ? 1 : 0)
    : (cur ? (cur.is_public == null ? 1 : cur.is_public) : 1);

  // Clamp numeric inputs to sane ranges; fall back to the stored value (then default).
  const clampNum = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  };
  const unitSize = unit_size !== undefined
    ? clampNum(unit_size, 20, 0.01, 1_000_000)
    : (cur && cur.unit_size != null ? cur.unit_size : 20);
  const bankroll = starting_bankroll !== undefined
    ? clampNum(starting_bankroll, 0, 0, 100_000_000)
    : (cur && cur.starting_bankroll != null ? cur.starting_bankroll : 0);

  const odds = default_odds !== undefined
    ? (ODDS_SOURCES.includes(String(default_odds)) ? String(default_odds) : 'consensus')
    : (cur && cur.default_odds ? cur.default_odds : 'consensus');

  const books = my_books !== undefined
    ? (Array.isArray(my_books)
        ? [...new Set(my_books.map(b => String(b).toLowerCase()))].filter(b => BOOK_KEYS.includes(b))
        : [])
    : (cur ? JSON.parse(cur.my_books || '[]') : []);

  db.prepare(`
    INSERT INTO user_preferences (user_id, favorite_sports, is_public, unit_size, starting_bankroll, default_odds, my_books, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      favorite_sports   = excluded.favorite_sports,
      is_public         = excluded.is_public,
      unit_size         = excluded.unit_size,
      starting_bankroll = excluded.starting_bankroll,
      default_odds      = excluded.default_odds,
      my_books          = excluded.my_books,
      updated_at        = datetime('now')
  `).run(userId, JSON.stringify(sports), pub, unitSize, bankroll, odds, JSON.stringify(books));

  res.json({ ok: true, favoriteSports: sports, is_public: pub, unitSize, startingBankroll: bankroll, defaultOdds: odds, myBooks: books });
});

// POST /api/account/avatar — upload a profile photo as a base64 data URL.
// Dependency-free (no multer): { image: 'data:image/png;base64,...' }. Stored on
// the data volume at data/avatars/<userId>.<ext>; users.avatar_path keeps the name.
app.post('/api/account/avatar', express.json({ limit: '4mb' }), (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Login required' });
  const userId = req.session.user.id;
  const { image } = req.body || {};

  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image || '');
  if (!m) return res.status(400).json({ error: 'Send a PNG, JPG, or WebP image.' });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (max 2MB).' });

  const fs = require('fs');
  const dir = path.join(__dirname, 'data', 'avatars');
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Remove any prior avatar with a different extension so we don't orphan files.
    for (const e of ['png', 'jpg', 'webp']) {
      if (e !== ext) { try { fs.unlinkSync(path.join(dir, `${userId}.${e}`)); } catch (_) {} }
    }
    const fname = `${userId}.${ext}`;
    fs.writeFileSync(path.join(dir, fname), buf);
    db.prepare(`UPDATE users SET avatar_path = ? WHERE id = ?`).run(fname, userId);
    res.json({ ok: true, avatarUrl: `/avatars/${fname}` });
  } catch (err) {
    console.error('[avatar]', err.message);
    res.status(500).json({ error: 'Upload failed' });
  }
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

  // No sportsbook line (common for tennis + niche games)? Fall back to the free
  // prediction-market implied line (Polymarket first, then Kalshi) so the odds board can
  // still show it and a side can be tracked verified, locked at that number.
  if (game.ml_home == null && game.ml_away == null && game.over_under == null && game.spread_home == null) {
    const implied = impliedLineForGame(espn_game_id);
    if (implied) {
      game.ml_home = implied.ml_home;   game.ml_away = implied.ml_away;
      game.spread_home = implied.spread_home; game.spread_away = implied.spread_away;
      game.over_under = implied.over_under;
      game.ou_over_odds = implied.ou_over_odds; game.ou_under_odds = implied.ou_under_odds;
      game.line_source = implied.source; // 'polymarket' | 'kalshi'
    }
  }

  const picks = db.prepare(`
    SELECT * FROM picks WHERE espn_game_id = ? AND mention_count > 0 ORDER BY score DESC, id ASC
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

  // Rank map: pick_id → 1-based rank within this game (picks already sorted score DESC)
  const pickRanks = {};
  picks.forEach((p, i) => { pickRanks[p.id] = i + 1; });

  // Global rank among ALL of today's picks (by score). Free users unlock the
  // CappingAlpha score + conviction curve for the overall #1 pick only — this is
  // how the popup knows whether a pick is that single #1 (not just top of its game).
  const allRanked = db.prepare(
    `SELECT p.id FROM picks p JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
     WHERE p.mention_count > 0 ORDER BY p.score DESC, p.id ASC`
  ).all();
  const globalRank = new Map();
  allRanked.forEach((r, i) => globalRank.set(r.id, i + 1));

  // Attach global rank + score-over-time timeline to each pick for the popup chart.
  // Paywall: hide the CappingAlpha score + conviction curve for locked picks
  // (globalRank 2..paid_rank_max) from non-paying users — same rule as /api/picks,
  // so the popup can't be used to read a locked pick's score from the Network tab.
  // The overall #1 and the public tail (rank > max) stay full.
  const paid    = auth.isPaid(req);
  const maxRank = PAID_RANK_MAX();
  // Tailers: how many members have tracked (tailed) each pick. Free social proof.
  const tailerRows = db.prepare(`SELECT tailed_pick_id, COUNT(*) n FROM game_votes WHERE espn_game_id = ? AND tailed_pick_id IS NOT NULL GROUP BY tailed_pick_id`).all(espn_game_id);
  const tailerMap = new Map(tailerRows.map(r => [r.tailed_pick_id, r.n]));
  for (const p of picks) {
    p.globalRank = globalRank.get(p.id) || null;
    p.timeline = getPickTimeline(p.id);
    p.tailers = tailerMap.get(p.id) || 0;
    if (!paid && p.globalRank && p.globalRank >= 2 && p.globalRank <= maxRank) {
      p.score = null;
      p.timeline = null;
    }
  }

  const lines = getLinesForGame(espn_game_id);

  // Stats + weather in parallel (non-blocking — return nulls on error)
  let stats = { pitchers: [], injuries: [], venue: null, weather: null };
  try {
    // league_path unlocks soccer (per-competition ESPN path lives on the game row)
    stats = await getFullGameContext(espn_game_id, game.sport, game.home_team, game.league_path);
  } catch (_) {}

  const publicBetting = getPublicBettingForGame(espn_game_id);
  const lineHistory   = getLineHistoryForGame(espn_game_id);
  const polymarket    = getPolymarketForGame(espn_game_id);
  const kalshi        = getKalshiForGame(espn_game_id);
  const insights      = getLineInsights(espn_game_id, game);
  const payload = { game, picks, pickRanks, stats, weather: stats.weather ?? null, lines, votes, userVote, publicBetting, lineHistory, polymarket, kalshi, insights };

  // Local UI_ONLY dev: this route is served locally (so the odds-engine books and
  // soccer show), but the local DB has no scanned picks. Borrow the PICK context
  // from prod, same pattern as /api/game/:id/live. Lines/game stay local.
  if (MIRROR_URL && (!picks.length)) {
    try {
      const mr = await fetch(`${MIRROR_URL}/api/game/${encodeURIComponent(espn_game_id)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
      if (mr.ok) {
        const pd = await mr.json();
        if (Array.isArray(pd.picks) && pd.picks.length) {
          payload.picks = pd.picks;
          payload.pickRanks = pd.pickRanks || {};
        }
        if (pd.publicBetting && !payload.publicBetting) payload.publicBetting = pd.publicBetting;
        if (pd.lineHistory && !(payload.lineHistory || []).length) payload.lineHistory = pd.lineHistory;
        if (pd.insights && !(payload.insights || []).length) payload.insights = pd.insights;
      }
    } catch (_) {}
  }
  // Strip proprietary scoring columns (channel/weight/bonuses/raw_message) from
  // every pick before it leaves the server — the score redaction above never
  // covered them. Applied last so mirror-sourced picks are sanitized too.
  payload.picks = publicPicks(payload.picks, { paid });
  res.json(payload);
});

// ── GET /api/game/:id/live — fast (~12s) live state + value pulse (MLB v1) ─────
// Live game STATE (score, diamond, count, batter/pitcher) is public/free. The
// value PULSE magnitude is paid-gated (mirrors /api/picks). Pulls fresh state from
// ESPN's free scoreboard via live_tracker; computes the pulse server-side from our
// win-prob model + the frozen pre-game prob + the pick's CA score. No DB writes.
function _americanToProb(ml) {
  const m = Number(ml);
  if (!m || isNaN(m)) return null;
  return m < 0 ? (-m) / (-m + 100) : 100 / (m + 100);
}
function _pregameHomeProb(poly, kalshi) {
  for (const row of [poly, kalshi]) {
    try {
      const mj = row && row.markets_json ? (typeof row.markets_json === 'string' ? JSON.parse(row.markets_json) : row.markets_json) : null;
      const hp = mj?.moneyline?.home_prob;
      if (typeof hp === 'number' && hp > 0 && hp < 1) return hp;
    } catch (_) {}
  }
  return null;
}
function _slotKey(p) {
  const t = (p.pick_type || '').toLowerCase();
  const home = p.is_home_team === 1 || p.is_home_team === true;
  if (t === 'over') return 'over';
  if (t === 'under') return 'under';
  if (t === 'ml') return home ? 'home_ml' : 'away_ml';
  if (t === 'spread') return home ? 'home_spread' : 'away_spread';
  return null;
}

app.get('/api/game/:espn_game_id/live', async (req, res) => {
  const { espn_game_id } = req.params;
  try {
    // Pick context: local DB in prod; mirror from prod in local UI_ONLY dev.
    let game  = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(espn_game_id);
    let picks = game ? db.prepare(`SELECT * FROM picks WHERE espn_game_id = ? AND mention_count > 0 ORDER BY score DESC, id ASC`).all(espn_game_id) : [];
    let pregameHomeProb = game ? _pregameHomeProb(getPolymarketForGame(espn_game_id), getKalshiForGame(espn_game_id)) : null;
    // Local UI_ONLY dev has no scanned picks/markets — pull the pick context from
    // the prod mirror so the pulse is testable locally. Live STATE still comes from
    // ESPN below. In prod (no MIRROR_URL) this is skipped and local DB is used.
    if (MIRROR_URL && (!game || !picks.length || pregameHomeProb == null)) {
      try {
        const mr = await fetch(`${MIRROR_URL}/api/game/${encodeURIComponent(espn_game_id)}`, { headers: { accept: 'application/json' } });
        if (mr.ok) {
          const pd = await mr.json();
          game = game || pd.game || null;
          if (Array.isArray(pd.picks) && pd.picks.length) picks = pd.picks;
          const mp = _pregameHomeProb(pd.polymarket, pd.kalshi);
          if (mp != null) pregameHomeProb = mp;
        }
      } catch (_) {}
    }
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const sport  = String(game.sport || '').toUpperCase();
    const family = SPORT_FAMILY[sport] || null;
    const fallbackState = {
      status: game.status, detail: game.live_detail || null, period: game.period ?? null, clock: game.clock ?? null,
      homeScore: game.home_score ?? null, awayScore: game.away_score ?? null,
      inning: game.period ?? null,
      half: /bot/i.test(game.live_detail || '') ? 'bot' : (/top/i.test(game.live_detail || '') ? 'top' : null),
      outs: game.live_outs ?? null, bases: game.live_bases ?? null,
      balls: null, strikes: null, batter: null, batterLine: null, pitcher: null, pitcherLine: null, dueUp: [], lastPlay: null,
    };
    // Local-dev mock uses an evolving synthesized state (no ESPN); dev replays
    // use the archived-game frame at the current wall-clock position; real games
    // use the cached ESPN scoreboard, falling back to the stored row.
    const isReplay = replayActive() && isReplayId(espn_game_id);
    const wantFinal = isMockId(espn_game_id) && req.query.final === '1';
    const state = wantFinal
      ? mockFinalState(espn_game_id)
      : (isMockId(espn_game_id)
          ? mockLiveState(espn_game_id)
          : (isReplay
              ? (replayLiveState(espn_game_id) || fallbackState)
              : ((await getLiveState(sport, espn_game_id)) || fallbackState)));

    // NHL scorebug extras (SOG + power play) from the free official NHL api —
    // ESPN's hockey scoreboard carries neither. Null-safe: skipped on any miss.
    if (family === 'hockey' && state.status === 'in' && !isMockId(espn_game_id) && !isReplay) {
      const nhl = await getNhlLive(game).catch(() => null);
      if (nhl) {
        state.strength = nhl.strength ?? state.strength;
        state.homeSOG  = nhl.homeSOG ?? state.homeSOG;
        state.awaySOG  = nhl.awaySOG ?? state.awaySOG;
      }
    }

    // Pulse magnitude is paid-gated (mirrors /api/picks). In local UI_ONLY dev we
    // treat the viewer as paid so the real bar is reviewable without a local paid
    // login. UI_ONLY is never set on Railway, so prod gating is unaffected.
    const paid = auth.isPaid(req) || !!process.env.UI_ONLY;
    const pulses = {};
    let winProb = null;   // free { source, home } block — the game-level win prob read
    // Pulses compute while live AND on the finished game (the completed curve) for
    // every sport with a win-prob read. Tennis has none (set state only).
    if ((state.status === 'in' || state.status === 'post') && family && family !== 'tennis') {
      // Free ESPN sources, cached + request-collapsed. Mock games skip both;
      // replays too (their espn_game_id is synthetic, ESPN would 404 each poll).
      const mock = isMockId(espn_game_id) || isReplay;
      const [coreProbs, espnWp] = mock ? [null, null] : await Promise.all([
        getCoreProbs(sport, espn_game_id).catch(() => null),
        getEspnWinProb(sport, espn_game_id).catch(() => null),
      ]);

      // Pre-game home prob chain: market caches (Polymarket/Kalshi) -> de-vigged
      // implied ML from today_games -> first point of ESPN's win-prob series.
      if (pregameHomeProb == null) {
        const qh = _americanToProb(game.ml_home), qa = _americanToProb(game.ml_away);
        if (qh != null && qa != null && qh + qa > 0) {
          const share = qh / (qh + qa);
          // Soccer MLs are 3-way legs with no stored draw price: scale the
          // two-way share down by a typical pre-game draw mass (approximation).
          pregameHomeProb = family === 'soccer' ? share * 0.74 : share;
        }
      }
      if (pregameHomeProb == null && espnWp?.series?.length) {
        const h0 = espnWp.series[0]?.home;
        if (typeof h0 === 'number' && h0 > 0 && h0 < 100) pregameHomeProb = h0 / 100;
      }

      // Game progress 0..1: outs-based for baseball, clock-based otherwise.
      const gp = family === 'baseball'
        ? gameProgress({ inning: state.inning, half: state.half, outs: state.outs })
        : genericProgress(sport, state.period, state.clock);

      // Live home win prob: freshest free ESPN source first (basketball rides one
      // on the last play), homegrown anchored model as the universal fallback.
      // Soccer is 3-way: a draw grades ML picks as losses on both sides, so each
      // side's WP is its outright win prob, never 1 - opponent.
      let soccerTrio = null, soccerPreTrio = null;
      let homeWpNow = null, wpSource = 'model';
      if (family === 'soccer') {
        soccerTrio    = soccerProbs({ homeScore: state.homeScore, awayScore: state.awayScore, progress: gp, preHome3: pregameHomeProb });
        soccerPreTrio = soccerProbs({ homeScore: 0, awayScore: 0, progress: 0, preHome3: pregameHomeProb });
        homeWpNow = soccerTrio.home;
      } else {
        const fresh = (family === 'basketball' && typeof state.lastPlayHomeWP === 'number') ? state.lastPlayHomeWP
                    : (coreProbs?.latest?.homeWin ?? espnWp?.latestHome ?? null);
        if (fresh != null) {
          // MLB: ESPN's number moves per plate appearance; the homegrown count
          // leverage keeps the pulse twitching per pitch between refreshes.
          homeWpNow = family === 'baseball' ? mlbCountAdjust(fresh, state) : fresh;
          wpSource = 'espn';
        } else if (family === 'baseball') {
          homeWpNow = liveHomeWinProb(state, pregameHomeProb);
        } else {
          homeWpNow = anchoredWP(clockHomeWP(family, state.homeScore, state.awayScore, gp), pregameHomeProb, gp);
        }
      }
      if (homeWpNow != null) winProb = { source: wpSource, home: Math.round(homeWpNow * 1000) / 1000 };

      // Model-only sports (NHL, Soccer) accumulate a win-prob series here so the
      // feed endpoint can still draw a chart (ESPN publishes none for them).
      if (!mock && state.status === 'in' && homeWpNow != null && (family === 'hockey' || family === 'soccer')) {
        pushWpHistory(espn_game_id, gp, homeWpNow);
      }

      const totalPts = (state.homeScore || 0) + (state.awayScore || 0);
      const preOverRaw = (() => {
        const o = _americanToProb(game.ou_over_odds), u = _americanToProb(game.ou_under_odds);
        return (o != null && u != null && o + u > 0) ? o / (o + u) : 0.5;
      })();
      const clamp01 = (x) => Math.max(0, Math.min(1, x));
      const pb = getPublicBettingForGame(espn_game_id);   // public lean at game start (conviction blend)
      for (const p of picks) {
        const slot = _slotKey(p);
        if (!slot) continue;
        const type = (p.pick_type || '').toLowerCase();
        const home = p.is_home_team === 1 || p.is_home_team === true;
        let now = null, pre = null, approx = true;
        if (type === 'ml') {
          if (soccerTrio) {
            now = home ? soccerTrio.home : soccerTrio.away;
            pre = home ? soccerPreTrio.home : soccerPreTrio.away;
          } else {
            if (homeWpNow == null) continue;
            now = home ? homeWpNow : 1 - homeWpNow;
            pre = pregameHomeProb == null ? now : (home ? pregameHomeProb : 1 - pregameHomeProb);
          }
          approx = false;
        } else if (type === 'spread') {
          const cov = coreProbs?.latest?.spreadCoverHome;
          if (cov != null) {
            // ESPN's live cover probability — the real read, not an approximation.
            now = home ? cov : clamp01(1 - cov - (coreProbs.latest.spreadPush || 0));
            const cov0 = coreProbs.first?.spreadCoverHome;
            pre = (cov0 != null)
              ? (home ? cov0 : clamp01(1 - cov0 - (coreProbs.first?.spreadPush || 0)))
              : 0.5;
            approx = false;
          } else {
            // Fallback: read the spread pick off the ML win prob (approximate).
            if (homeWpNow == null) continue;
            now = home ? homeWpNow : (soccerTrio ? soccerTrio.away : 1 - homeWpNow);
            pre = pregameHomeProb == null ? now : (home ? pregameHomeProb : 1 - pregameHomeProb);
            approx = true;
          }
        } else if (type === 'over' || type === 'under') {
          const tOver = coreProbs?.latest?.totalOver;
          if (tOver != null) {
            now = type === 'over' ? tOver : clamp01(1 - tOver - (coreProbs.latest.totalPush || 0));
            const t0 = coreProbs.first?.totalOver;
            const preOver = (t0 != null) ? t0 : preOverRaw;
            pre = type === 'over' ? preOver : 1 - preOver;
            approx = false;
          } else {
            const op = family === 'baseball'
              ? liveOverProb(totalPts, game.over_under, gp)
              : genericOverProb(totalPts, game.over_under, gp, family);
            if (op == null) continue;
            now = type === 'over' ? op : 1 - op;
            pre = type === 'over' ? preOverRaw : 1 - preOverRaw;
            approx = true;
          }
        } else { continue; }

        if (!paid) { pulses[slot] = { locked: true, pickType: type }; continue; }

        // Is the pick's side behind on the scoreboard? (gates the "comeback" wording)
        const trailing = (type === 'ml' || type === 'spread')
          ? (home ? (state.homeScore < state.awayScore) : (state.awayScore < state.homeScore))
          : false;
        // Public lean on the pick's side at game start (0..1), for the conviction blend.
        let publicPct = null;
        if (pb) {
          const raw = type === 'ml'     ? (home ? pb.home_ml_pct     : pb.away_ml_pct)
                    : type === 'spread' ? (home ? pb.home_spread_pct : pb.away_spread_pct)
                    : type === 'over'   ? pb.over_pct
                    : type === 'under'  ? pb.under_pct : null;
          publicPct = (raw == null) ? null : raw / 100;
        }

        const key = `${espn_game_id}:${p.id}`;
        const pulse = computeValuePulse({
          pickWP_now: now, pickWP_pre: pre, caScore: p.score || 0, trailing, publicPct,
          gameProgress: gp, prevMagnitude: prevPulseMag(key), mvpThreshold: MVP_THRESHOLD,
        });
        savePulseMag(key, pulse.magnitude);
        // Value-over-game series for the sparkline: the mock synthesizes a full
        // arc; real games accumulate one point per poll.
        let history;
        if (isMockId(espn_game_id)) {
          const mside = home ? 'home' : 'away';
          history = wantFinal
            ? mockFullPulseHistory(pregameHomeProb, p.score || 0, MVP_THRESHOLD, mside, publicPct, espn_game_id)
            : mockPulseHistory(pregameHomeProb, p.score || 0, MVP_THRESHOLD, mside, publicPct, espn_game_id);
        } else {
          pushPulseHistory(key, pulse.magnitude, state.period);
          history = getPulseHistory(key);
        }
        pulses[slot] = {
          ...pulse, pickType: type, history,
          approx,
          winPct: Math.round(now * 100),
        };
      }
    }

    res.json({ state, winProb, pulses, paid });
  } catch (err) {
    console.error('[api/game/live]', err.message);
    res.status(500).json({ error: 'live unavailable' });
  }
});

// ── GET /api/game/:id/live/feed — lazy tabs data (~25s poll), free content ─────
// Play-by-play, ESPN win-prob series, per-game stat leaders, and team stats for
// the tracker tabs. All FREE (the paid layer is the pulse + cover probabilities
// inside /live). On-demand only: nothing is fetched unless someone is viewing.
app.get('/api/game/:espn_game_id/live/feed', async (req, res) => {
  const { espn_game_id } = req.params;
  try {
    if (isMockId(espn_game_id)) {
      const { mockLiveFeed } = require('./src/mock_live');
      return res.json(typeof mockLiveFeed === 'function' ? mockLiveFeed(espn_game_id) : { unsupported: true });
    }
    // Dev replay: serve the REAL archived game's feed (passthrough) so the tabs
    // show real plays/leaders/win prob while the header state replays.
    if (replayActive() && isReplayId(espn_game_id)) {
      const feed = await replayFeed(espn_game_id);
      return res.json(feed || { unsupported: true });
    }
    let game = db.prepare(`SELECT sport, league_path FROM today_games WHERE espn_game_id = ?`).get(espn_game_id);
    if (!game && MIRROR_URL) {
      try {
        const mr = await fetch(`${MIRROR_URL}/api/game/${encodeURIComponent(espn_game_id)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
        if (mr.ok) { const pd = await mr.json(); game = pd.game || null; }
      } catch (_) {}
    }
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const sport  = String(game.sport || '').toUpperCase();
    const family = SPORT_FAMILY[sport] || null;
    if (!family || family === 'tennis') return res.json({ unsupported: true });

    const feed = await getFeed(sport, espn_game_id, { leaguePath: game.league_path || null });
    if (!feed) return res.json({ unsupported: true });

    // NHL/Soccer have no ESPN win-prob series — serve the model series the live
    // endpoint accumulates poll-by-poll, labeled honestly as a model estimate.
    if (!feed.winprob && (family === 'hockey' || family === 'soccer')) {
      const pts = getWpHistory(espn_game_id);
      if (pts.length >= 2) {
        feed.winprob = { source: 'model', latestHome: pts[pts.length - 1].home / 100, series: pts, scoring: [] };
      }
    }
    // Hockey extras from the free official NHL api: SOG, power play, scoring
    // summary, three stars. Null-safe (the tabs render without it).
    if (family === 'hockey') {
      const fullGame = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(espn_game_id);
      if (fullGame) {
        const nhl = await getNhlLive(fullGame).catch(() => null);
        if (nhl) feed.hockey = nhl;
      }
    }
    res.json(feed);
  } catch (err) {
    console.error('[api/game/live/feed]', err.message);
    res.status(500).json({ error: 'feed unavailable' });
  }
});

// ── History tab: per-team recent games (lazy, public ESPN data, cached) ───────
app.get('/api/team-history', async (req, res) => {
  const teamId = (req.query.teamId || '').toString().trim();
  const sport  = (req.query.sport  || '').toString().trim().toUpperCase();
  if (!teamId) return res.status(400).json({ error: 'teamId required' });
  if (!TEAM_SPORTS.has(sport)) return res.json({ unsupported: true });
  const data = await getTeamHistory(teamId, sport).catch(() => null);
  res.json(data || { unavailable: true });
});

// ── History tab: player drill-down for one past game (box score + form/load) ──
app.get('/api/game-players', async (req, res) => {
  const event  = (req.query.event  || '').toString().trim();
  const teamId = (req.query.teamId || '').toString().trim();
  const sport  = (req.query.sport  || '').toString().trim().toUpperCase();
  if (!event || !teamId) return res.status(400).json({ error: 'event and teamId required' });
  if (!TEAM_SPORTS.has(sport)) return res.json({ unsupported: true });

  const data = await getEventTeamPlayers(event, sport, teamId).catch(() => null);
  if (!data || !data.blocks?.length) return res.json({ unavailable: true });

  // Enrich each block's meaningful players (skip DNP; cap gamelog fan-out).
  for (const blk of data.blocks) {
    const meaningful = blk.rows.filter(r => !r.dnp && r.athleteId).slice(0, 14);
    await Promise.all(meaningful.map(async r => {
      const gl  = await getPlayerGamelog(r.athleteId, sport).catch(() => null);
      const ctx = { role: blk.role, position: r.pos };
      r.form = buildPlayerForm(gl, sport, ctx, event, r.stats);
      // Key averages going INTO this game (before its date), for the name cell.
      const gd = gl && (gl.series.find(g => String(g.eventId) === String(event)) || {}).date;
      r.keyAvgs = gl ? computeKeyAverages(gl, sport, ctx, gd) : [];
    }));
    // Drop the label-keyed object from the payload; statsArr drives the table.
    blk.rows.forEach(r => { delete r.stats; });
  }

  res.json({ sport, ...data });
});

// ── Team Form tab: forward-looking player form/load grid for tonight's game ──
app.get('/api/game-form', async (req, res) => {
  const event  = (req.query.event  || '').toString().trim();
  const teamId = (req.query.teamId || '').toString().trim();
  const sport  = (req.query.sport  || '').toString().trim().toUpperCase();
  const date   = (req.query.date   || '').toString().trim() || null;
  const oppId  = (req.query.oppId  || '').toString().trim() || null;
  if (!teamId) return res.status(400).json({ error: 'teamId required' });
  if (!TEAM_SPORTS.has(sport)) return res.json({ unsupported: true });
  const data = await getGameForm(event, sport, teamId, date, oppId).catch(() => null);
  res.json(data || { unavailable: true });
});

// ── History tab: tennis player recent matches (ESPN eventlog, lazy, cached) ───
app.get('/api/tennis-history', async (req, res) => {
  const player = (req.query.player || '').toString().trim();
  const sport  = (req.query.sport  || '').toString().trim().toUpperCase();
  const date   = (req.query.date   || '').toString().trim() || null;
  if (!player) return res.status(400).json({ error: 'player required' });
  if (sport !== 'ATP' && sport !== 'WTA') return res.json({ unsupported: true });
  const data = await getTennisHistory(player, sport, date).catch(() => null);
  res.json(data || { unavailable: true });
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
  if (game.status === 'post') {
    return res.status(409).json({ error: 'Voting closed — game is final' });
  }
  // Live game: prefer the current DraftKings line so the vote locks the live number the
  // user saw on the board, not the morning open.
  if (game.status === 'in') {
    const dk = getLinesForGame(espn_game_id).draftkings;
    if (dk) {
      if (dk.ml_home != null) game.ml_home = dk.ml_home;
      if (dk.ml_away != null) game.ml_away = dk.ml_away;
      if (dk.spread_home != null) game.spread_home = dk.spread_home;
      if (dk.spread_away != null) game.spread_away = dk.spread_away;
      if (dk.over_under != null) game.over_under = dk.over_under;
      if (dk.ou_over_odds != null) game.ou_over_odds = dk.ou_over_odds;
      if (dk.ou_under_odds != null) game.ou_under_odds = dk.ou_under_odds;
    }
  }
  // Same prediction-market fallback as /api/game: a side tracked off the Polymarket line
  // gets locked + graded at that number rather than null.
  if (game.ml_home == null && game.ml_away == null && game.over_under == null && game.spread_home == null) {
    const implied = impliedLineForGame(espn_game_id);
    if (implied) Object.assign(game, {
      ml_home: implied.ml_home, ml_away: implied.ml_away,
      spread_home: implied.spread_home, spread_away: implied.spread_away,
      over_under: implied.over_under, ou_over_odds: implied.ou_over_odds, ou_under_odds: implied.ou_under_odds,
    });
  }

  // Remove any vote on the opposing side of the same bet type
  const VOTE_PAIRS = { home_ml:'away_ml', away_ml:'home_ml', home_spread:'away_spread', away_spread:'home_spread', over:'under', under:'over' };
  const paired = VOTE_PAIRS[slot];

  // Optional per-user wager (from the Track-Bet confirm slide) for the user's PRIVATE
  // tracking only. The leaderboard ignores these and always counts 1 unit at the CA line.
  const rawStake = Number(req.body.stake);
  const rawOdds  = Number(req.body.odds);
  const userStake = Number.isFinite(rawStake) && rawStake > 0 ? rawStake : null;
  const userOdds  = Number.isFinite(rawOdds)  && rawOdds !== 0 ? rawOdds  : null;

  try {
    db.prepare(`DELETE FROM game_votes WHERE user_id = ? AND espn_game_id = ? AND pick_slot = ?`)
      .run(userId, espn_game_id, paired);
    // Re-voting the SAME slot replaces the prior row so an updated stake/odds sticks
    // (INSERT OR IGNORE alone would keep the stale wager on the existing row).
    db.prepare(`DELETE FROM game_votes WHERE user_id = ? AND espn_game_id = ? AND pick_slot = ?`)
      .run(userId, espn_game_id, slot);
    // Snapshot game metadata at vote time so it persists past the daily wipe.
    // `spread` stores the slot-relevant line (spread for spread slots, total for
    // O/U slots) so the vote can grade itself even after today_games is wiped.
    const voteLine = slot === 'home_spread' ? game.spread_home
                   : slot === 'away_spread' ? game.spread_away
                   : (slot === 'over' || slot === 'under') ? game.over_under
                   : null;
    db.prepare(`
      INSERT OR IGNORE INTO game_votes
        (user_id, espn_game_id, pick_slot, home_team, away_team, sport, ml_home, ml_away, ou_over_odds, ou_under_odds, spread, user_stake, user_odds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, espn_game_id, slot,
           game.home_team, game.away_team, game.sport,
           game.ml_home, game.ml_away, game.ou_over_odds, game.ou_under_odds, voteLine,
           userStake, userOdds);
    // Tail attribution: if this side matches a scanned capper pick for the game,
    // record which pick was tailed (highest-scored match). Zero-friction: every
    // verified track of a capper's side is captured as a tail.
    const SLOT_PICK = { home_ml: ['ml', 1], away_ml: ['ml', 0], home_spread: ['spread', 1], away_spread: ['spread', 0] };
    let tailed = null;
    if (SLOT_PICK[slot]) {
      const [pt, ih] = SLOT_PICK[slot];
      const p = db.prepare(`SELECT id FROM picks WHERE espn_game_id = ? AND pick_type = ? AND is_home_team = ? AND mention_count > 0 ORDER BY score DESC LIMIT 1`).get(espn_game_id, pt, ih);
      tailed = p ? p.id : null;
    } else if (slot === 'over' || slot === 'under') {
      const p = db.prepare(`SELECT id FROM picks WHERE espn_game_id = ? AND pick_type = ? AND mention_count > 0 ORDER BY score DESC LIMIT 1`).get(espn_game_id, slot);
      tailed = p ? p.id : null;
    }
    db.prepare(`UPDATE game_votes SET tailed_pick_id = ? WHERE user_id = ? AND espn_game_id = ? AND pick_slot = ?`)
      .run(tailed, userId, espn_game_id, slot);
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

// GET /api/game/:espn_game_id/chat — public read of the community chat.
// Each message carries its author's username + current vote annotations.
app.get('/api/game/:espn_game_id/chat', (req, res) => {
  const messages = community.getGameChat(req.params.espn_game_id, req.session?.user?.id || null);
  res.json({ messages, maxLength: community.MAX_MESSAGE_LEN });
});

// POST /api/game/:espn_game_id/chat — post a message (login required).
app.post('/api/game/:espn_game_id/chat', (req, res) => {
  if (!req.session?.user?.id) return res.status(401).json({ error: 'Login required' });
  const { message } = req.body || {};
  const result = community.addGameMessage(req.session.user.id, req.params.espn_game_id, message);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// DELETE /api/game/:espn_game_id/chat/:id — remove your own message (login required).
app.delete('/api/game/:espn_game_id/chat/:id', (req, res) => {
  if (!req.session?.user?.id) return res.status(401).json({ error: 'Login required' });
  const result = community.deleteGameMessage(req.session.user.id, req.params.espn_game_id, Number(req.params.id));
  if (result.error) {
    const status = (result.expired || result.error === 'Not your message.') ? 403 : 404;
    return res.status(status).json(result);
  }
  res.json(result);
});

// ── Scan state lives in expert_data.js — all paths update the same object ──
async function runScan() {
  await scanner.scanAll().catch(err => console.error('[cron] scan error:', err.message));
}

// Admin-only guard for control endpoints that live on the main app (the /admin
// router has its own requireAuth). Without this, anyone could trigger Discord
// scans or read scanner state. Matches the admin session set in src/admin.js.
function requireAdmin(req, res, next) {
  if (req.session?.admin) return next();
  res.status(403).json({ error: 'Forbidden' });
}

// GET /admin/scan-status
app.get('/admin/scan-status', requireAdmin, (req, res) => res.json(scanner.getScanState()));

// POST /admin/scan-now
app.post('/admin/scan-now', requireAdmin, (req, res) => {
  runScan(); // fire and forget
  res.json({ ok: true });
});

// POST /api/scan — manual scan trigger (admin only)
app.post('/api/scan', requireAdmin, async (req, res) => {
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
  const map = { CBB:'ncaamb', NCAAF:'ncaaf', ATP:'tennis', WTA:'tennis', Golf:'golf', WNBA:'wnba' };
  return (map[sport] || (sport || 'game')).toLowerCase();
}
function makeDetailUrl(game) {
  const sp   = _sportSlug(game.sport);
  const away = _teamSlug(game.away_team);
  const home = _teamSlug(game.home_team);
  const date = (game.start_time || '').slice(0, 10);
  return `/${sp}/${away}-vs-${home}-${date}`;
}

// Standalone detail page: /:sport/:slug
const { buildDetailPageHtml } = require('./src/detail_page');

// Loose team-name match (handles "LA Angels" vs "Los Angeles Angels" etc.)
function _sameTeam(a, b) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

// Map permanent mvp_picks rows to the picks shape the detail page expects, so a
// historical MVP game with no live picks row still renders its pick cards.
function _mvpRowsToPicks(mvpRows, game) {
  return mvpRows.map(m => {
    const pt = (m.pick_type || '').toLowerCase();
    const isHome = (pt === 'ml' || pt === 'spread') ? (_sameTeam(m.team, game.home_team) ? 1 : 0) : 0;
    return {
      id: m.id, espn_game_id: m.espn_game_id, team: m.team,
      pick_type: m.pick_type, spread_value: m.spread, is_home_team: isHome,
      score: m.score, result: m.result, mention_count: 1, timeline: [],
    };
  });
}

// Reconstruct a historical (post-wipe) game from the MVP snapshot + permanent
// mvp_picks. Returns { game, picks, snap } or null if we have nothing.
function resolveHistoricalGame(espnGameId) {
  const snap = getSnapshot(espnGameId);
  const mvpRows = db.prepare(`SELECT * FROM mvp_picks WHERE espn_game_id = ? ORDER BY score DESC`).all(espnGameId);
  if (!snap && !mvpRows.length) return null;
  const mvp = mvpRows[0] || null;

  let game;
  if (snap?.game) {
    game = { ...snap.game };
  } else if (mvp) {
    game = {
      espn_game_id: espnGameId, sport: mvp.sport,
      home_team: mvp.home_team, away_team: mvp.away_team,
      start_time: mvp.game_date ? `${mvp.game_date}T00:00:00Z` : null,
      status: 'post',
    };
  }
  // Overlay the final score/status from permanent mvp_picks (snapshot was taken
  // at game start, so its scores are empty).
  if (mvp) {
    if (mvp.home_score != null) game.home_score = mvp.home_score;
    if (mvp.away_score != null) game.away_score = mvp.away_score;
    if (mvp.result && mvp.result !== 'pending') game.status = 'post';
  }

  const picks = (snap?.picks && snap.picks.length) ? snap.picks : _mvpRowsToPicks(mvpRows, game);
  return { game, picks, snap };
}

// Shared detail-page renderer. For live games it queries the live tables; for
// historical games the caller passes the reconstructed game/picks and the
// snapshot enrichment via opts (any opt left undefined falls back to live).
// Cached team-colors map (public/team_colors.json) for server-rendering the detail
// page's team circles in the correct colour on first paint (kills the FOUC where
// circles flashed the sport colour before client JS applied team colours).
let _teamColorsCache = null;
function _teamColorsMap() {
  if (_teamColorsCache) return _teamColorsCache;
  try { _teamColorsCache = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'public', 'team_colors.json'), 'utf8')); }
  catch (_) { _teamColorsCache = {}; }
  return _teamColorsCache;
}
const _ABBR_ALIAS = { NBA: { NY: 'NYK', SA: 'SAS', GS: 'GSW', NO: 'NOP', UTAH: 'UTA' } };
function _resolveTeamColor(game, isHome) {
  const sport = (game.sport || '').toUpperCase();
  const abbr  = (isHome ? (game.home_abbr || game.home_short || '') : (game.away_abbr || game.away_short || '')).toUpperCase();
  if (!abbr) return null;
  const bucket = _teamColorsMap()[sport] || {};
  const alias  = (_ABBR_ALIAS[sport] || {})[abbr] || abbr;
  const c = bucket[abbr] || bucket[alias];
  return (c && c.primary) ? c.primary : null;
}

async function renderGameDetail(req, res, game, opts = {}) {
  try {
    let picks = opts.picks;
    if (!picks) {
      picks = db.prepare(`
        SELECT * FROM picks WHERE espn_game_id = ? AND mention_count > 0 ORDER BY score DESC, id ASC
      `).all(game.espn_game_id);
      for (const p of picks) p.timeline = getPickTimeline(p.id);
    }

    // Pick ranks for the paywall (free users unlock the overall #1 pick only).
    // Live: global rank across ALL current picks — no game_date filter, which
    // could miss the cycle date and zero out every rank (that bug locked the #1
    // pick's own share page). Matches the /api/game popup ranking exactly.
    // Historical: per-game rank by score (global ordering is gone after the wipe;
    // pick ids may also have been reused, so never cross-reference the live table).
    const pickRanks = {};
    if (opts.historical) {
      const sorted = [...picks].sort((a, b) => (b.score || 0) - (a.score || 0));
      sorted.forEach((p, i) => { pickRanks[p.id] = i + 1; });
    } else {
      const allRanked = db.prepare(`
        SELECT p.id FROM picks p JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
        WHERE p.mention_count > 0 ORDER BY p.score DESC, p.id ASC
      `).all();
      allRanked.forEach((r, i) => { pickRanks[r.id] = i + 1; });
    }

    // Paywall parity with /api/game: never ship a locked pick's real score or
    // conviction curve to non-paying users — otherwise they sit in the page source
    // (__GAME_DATA__) even though the UI blurs them. The overall #1 and the public
    // tail (rank > max) stay full; historical archive pages are public, so skip them.
    if (!opts.historical && !auth.isPaid(req)) {
      const maxRank = PAID_RANK_MAX();
      for (const p of picks) {
        const r = pickRanks[p.id];
        if (r && r >= 2 && r <= maxRank) { p.score = null; p.timeline = null; }
      }
    }

    // Votes + the viewer's votes — always live (game_votes survives the wipe).
    const voteRows = db.prepare(`
      SELECT pick_slot, COUNT(*) AS total FROM game_votes WHERE espn_game_id = ? GROUP BY pick_slot
    `).all(game.espn_game_id);
    const votes = { home_ml:0, away_ml:0, home_spread:0, away_spread:0, over:0, under:0 };
    for (const v of voteRows) if (v.pick_slot in votes) votes[v.pick_slot] = v.total;

    const userId = req.session?.user?.id;
    const userVote = {};
    if (userId) {
      const uvRows = db.prepare(`SELECT pick_slot FROM game_votes WHERE espn_game_id = ? AND user_id = ?`).all(game.espn_game_id, userId);
      for (const r of uvRows) userVote[r.pick_slot] = true;
    }

    // ESPN stats are re-fetchable for past games, so always pull live.
    const stats = await getFullGameContext(game.espn_game_id, game.sport, game.home_team, game.league_path).catch(() => ({}));

    const pick = (key, liveFn) => (opts[key] !== undefined ? opts[key] : liveFn());
    const lines         = pick('lines',         () => getLinesForGame(game.espn_game_id));
    const publicBetting = pick('publicBetting',  () => getPublicBettingForGame(game.espn_game_id));
    const lineHistory   = pick('lineHistory',    () => getLineHistoryForGame(game.espn_game_id));
    const polymarket    = pick('polymarket',     () => getPolymarketForGame(game.espn_game_id));
    const kalshi        = pick('kalshi',         () => getKalshiForGame(game.espn_game_id));
    const insights      = pick('insights',       () => getLineInsights(game.espn_game_id, game));

    // Strip proprietary scoring columns (channel/weight/bonuses/raw_message) from
    // every pick before it is inlined into the page source (__GAME_DATA__), on
    // historical archive pages too — the score redaction above never covered them.
    const safePicks = publicPicks(picks, { paid: auth.isPaid(req) });

    const payload = {
      game, picks: safePicks, pickRanks, votes, userVote, stats, lines, publicBetting,
      lineHistory, polymarket, kalshi, insights,
      user: req.session?.user || null,
    };

    const away     = game.away_team || 'Away';
    const home     = game.home_team || 'Home';
    const longDate = game.start_time
      ? new Date(game.start_time).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric', timeZone:'America/New_York' })
      : '';
    const title     = `${away} vs. ${home}${longDate ? ' · ' + longDate : ''} · CappingAlpha`;
    const desc      = `${game.sport} matchup: ${away} at ${home}${longDate ? ' on ' + longDate : ''}. See picks, lines, and sentiment on CappingAlpha.`;
    const canonical = `https://cappingalpha.com${makeDetailUrl(game)}`;
    const sportSlug = _sportSlug(game.sport);

    const awayColor = _resolveTeamColor(game, false);
    const homeColor = _resolveTeamColor(game, true);
    res.send(buildDetailPageHtml({ title, desc, canonical, payload, game, away, home, longDate, sportSlug, awayColor, homeColor }));
  } catch (err) {
    console.error('[detail-page] error:', err.message);
    res.status(500).send('Error loading game detail');
  }
}

// /game/:espn_game_id — live games 301 to their slug URL (SEO); historical MVP
// games (post-wipe) render in place from the snapshot + mvp_picks.
app.get('/game/:espn_game_id', async (req, res) => {
  const id = req.params.espn_game_id;
  const live = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(id);
  if (live) return res.redirect(301, makeDetailUrl(live));

  const hist = resolveHistoricalGame(id);
  if (hist) {
    return renderGameDetail(req, res, hist.game, {
      historical:    true,
      picks:         hist.picks,
      lines:         hist.snap ? hist.snap.lines         : null,
      publicBetting: hist.snap ? hist.snap.publicBetting : null,
      lineHistory:   hist.snap ? hist.snap.lineHistory   : null,
      polymarket:    hist.snap ? hist.snap.polymarket    : null,
      kalshi:        hist.snap ? hist.snap.kalshi        : null,
      insights:      hist.snap ? hist.snap.insights      : null,
    });
  }

  // Local dev: the live slate lives on prod (the mirror). When a game isn't in
  // the local DB, pull its data from prod's JSON API and render it with the LOCAL
  // templates, so new detail-page features can be tested on real games. Prod never
  // sets MIRROR_URL, so this branch is inert there.
  if (MIRROR_URL) {
    try {
      const r = await fetch(`${MIRROR_URL}/api/game/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } });
      if (r.ok) {
        const pd = await r.json();
        if (pd && pd.game) {
          return renderGameDetail(req, res, pd.game, {
            historical:    true, // public render (no paywall blanking) + per-game ranks
            picks:         pd.picks || [],
            lines:         pd.lines,
            publicBetting: pd.publicBetting,
            lineHistory:   pd.lineHistory,
            polymarket:    pd.polymarket,
            kalshi:        pd.kalshi,
            insights:      pd.insights,
          });
        }
      }
    } catch (err) { console.warn(`[mirror] detail ${id} failed (${err.message})`); }
  }

  return res.status(404).send('Game not found');
});

// ── Phase 5c: per-sport landing pages (/mlb, /nba, ... /mma) ──────────────────
// Exact paths registered ABOVE the /:sport/:slug detail route. Rendered fresh
// per request (SQLite reads are cheap); only the headlines + Kalshi fetches
// inside buildSportPageHtml are cached and timeout-guarded.
const { buildSportPageHtml } = require('./src/sport_page');
const { SPORT_PAGES } = require('./src/detail_page');
for (const pageDef of SPORT_PAGES) {
  app.get('/' + pageDef.slug, async (req, res) => {
    try {
      res.send(await buildSportPageHtml(pageDef, { user: req.session?.user || null }));
    } catch (err) {
      console.error(`[sport-page] /${pageDef.slug} failed:`, err.message);
      res.status(500).send('Error loading page');
    }
  });
}

app.get('/:sport/:slug', async (req, res) => {
  const { sport, slug } = req.params;

  // Valid sport slugs only — guard against catching arbitrary routes
  const SPORT_SLUGS = new Set(['nba','wnba','mlb','nhl','nfl','ncaamb','ncaaf','tennis','golf','cbb','soccer']);
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
    ncaamb:'CBB', ncaaf:'NCAAF', tennis:'ATP', nba:'NBA', wnba:'WNBA',
    mlb:'MLB', nhl:'NHL', nfl:'NFL', golf:'Golf', cbb:'CBB',
  };
  const sportFilter = SPORT_MAP[sport.toLowerCase()] || sport.toUpperCase();

  // Fuzzy match on team slug vs stored team names
  const game = db.prepare(`
    SELECT * FROM today_games
    WHERE (LOWER(sport) = LOWER(?) OR (? IN ('ATP','WTA') AND sport IN ('ATP','WTA')))
      AND LOWER(REPLACE(REPLACE(REPLACE(home_team,' ',''),'.',''),'-','')) LIKE ?
      AND LOWER(REPLACE(REPLACE(REPLACE(away_team,' ',''),'.',''),'-','')) LIKE ?
      AND DATE(start_time) = ?
    LIMIT 1
  `).get(sportFilter, sportFilter, `%${homeSlug}%`, `%${awaySlug}%`, date)
  // If strict fails, try tennis cross-match (ATP vs WTA same slug)
  || (sportFilter === 'ATP' && db.prepare(`
    SELECT * FROM today_games
    WHERE sport IN ('ATP','WTA')
      AND LOWER(REPLACE(REPLACE(REPLACE(home_team,' ',''),'.',''),'-','')) LIKE ?
      AND LOWER(REPLACE(REPLACE(REPLACE(away_team,' ',''),'.',''),'-','')) LIKE ?
      AND DATE(start_time) = ?
    LIMIT 1
  `).get(`%${homeSlug}%`, `%${awaySlug}%`, date));

  if (!game) return res.status(404).send('Game not found');

  // Local preview: ?final=1 renders the mock game as finished (completed tracker).
  if (isMockId(game.espn_game_id) && req.query.final === '1') game.status = 'post';

  return renderGameDetail(req, res, game);
});

// Terminal error handler — logs the real error server-side and returns a generic
// message so stack traces / internal paths never reach a client. Must be last.
app.use((err, req, res, next) => {
  console.error('[unhandled]', req.method, req.path, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(err && err.status ? err.status : 500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('[CappperBoss] ─────────────────────────────────');
  console.log(`[CappperBoss] Server: http://localhost:${PORT}`);
  console.log('[CappperBoss] Active hours: 5:00AM–1:00AM ET');
  console.log(`[CappperBoss] Next wipe: 4:58AM ET`);
  console.log('[CappperBoss] ─────────────────────────────────');

  // IndexNow: tell Bing/Yandex the core pages are fresh after each deploy.
  // Prod-only (SESSION_SECURE=1) so local dev never pings the live URLs.
  if (process.env.SESSION_SECURE === '1') {
    setTimeout(() => pingIndexNow(corePages()), 8000);
  }
});

// ── Startup: restore today's games if empty (handles restarts mid-day) ────────
// Does NOT call Odds API on restart — that runs on the 5am cron only.
// Golf + tennis always refreshed on startup regardless of today_games state.
(async () => {
  // Always refresh golf tournaments and tennis matches on startup — these are
  // cheap ESPN calls and must be current after any mid-day deploy/restart.
  await fetchTodaysTennisMatches().catch(err => console.error('[startup] fetchTodaysTennisMatches error:', err.message));
  await fetchTennisLines().catch(err => console.error('[startup] fetchTennisLines error:', err.message));
  await fetchTodaysWnbaGames().catch(err => console.error('[startup] fetchTodaysWnbaGames error:', err.message));
  await fetchTodaysSoccerGames().catch(err => console.error('[startup] fetchTodaysSoccerGames error:', err.message));
  await fetchTodaysNcaafGames().catch(err => console.error('[startup] fetchTodaysNcaafGames error:', err.message));
  await fetchGolfTournaments().catch(err => console.error('[startup] fetchGolfTournaments error:', err.message));
  // Forward games (today+2d, ESPN only) so overnight picks for future games can match.
  await fetchForwardGames().catch(err => console.error('[startup] fetchForwardGames error:', err.message));

  // Check for team sport games specifically — tennis/WNBA rows alone don't count,
  // since they're always fetched above and would make gameCount > 0 even when
  // NBA/MLB/NHL games are missing (common after a mid-day restart or outage redeploy).
  const todayStr = new Date().toISOString().slice(0, 10);
  const teamGameCount = db.prepare(
    `SELECT COUNT(*) AS c FROM today_games WHERE sport NOT IN ('ATP','WTA','Golf','WNBA','Soccer') AND date(start_time) = ?`
  ).get(todayStr).c;
  if (teamGameCount === 0) {
    console.log('[startup] no team sport games for today — fetching ESPN games and seeding slots...');
    await fetchTodaysGames().catch(err => console.error('[startup] fetchTodaysGames error:', err.message));
    const { seedPickSlots } = require('./src/lines');
    await seedPickSlots().catch(err => console.error('[startup] seedPickSlots error:', err.message));
  } else {
    console.log(`[startup] today_games has ${teamGameCount} team sport games — skipping seed`);
  }

  // Populate ESPN odds (DraftKings) into today_games + book_lines.
  // Fills any null odds from today's 5am run and seeds pick slots.
  await refreshEspnOdds().catch(err => console.error('[startup] refreshEspnOdds error:', err.message));

  // v3 foundation: make sure capper ratings exist after any restart (DB-only, fast).
  try { recomputeCapperRatings(); } catch (err) { console.error('[startup] recomputeCapperRatings error:', err.message); }

  // Wave-1 scraper warm start (server only): discovery + one poll each so a
  // mid-day restart never leaves the trackers cold until the next cron.
  if (!UI_ONLY) {
    await discoverAnExperts().catch(err => console.error('[startup] discoverAnExperts error:', err.message));
    await refreshPmWallets().catch(err => console.error('[startup] refreshPmWallets error:', err.message));
    await refreshCoversContestants().catch(err => console.error('[startup] refreshCoversContestants error:', err.message));
    pollAnExperts().catch(err => console.error('[startup] pollAnExperts error:', err.message));
    pollPmWallets().catch(err => console.error('[startup] pollPmWallets error:', err.message));
    pollCoversPicks().catch(err => console.error('[startup] pollCoversPicks error:', err.message));
  }

  // Seed slots for every game in today_games (including forward games) — INSERT OR
  // IGNORE, so safe even when today's slots already exist. Picks up forward games
  // that the conditional team-game seed above skipped.
  {
    const { seedPickSlots } = require('./src/lines');
    await seedPickSlots().catch(err => console.error('[startup] seedPickSlots(forward) error:', err.message));
  }

  // Award any completed weekly/monthly leaderboard finishes that aren't recorded
  // yet. Idempotent + self-healing, so a missed cron run is recovered on boot.
  try { finalizeLeaderboardAwards(); } catch (err) { console.error('[startup] finalizeLeaderboardAwards error:', err.message); }

  // Seed dummy member accounts (idempotent) and place their votes on today's 35+
  // picks so the public leaderboard isn't empty. Cron keeps them voting daily.
  try { await seedDummyAccounts(); runDummyVotes(); runDummyComments(); } catch (err) { console.error('[startup] dummy accounts error:', err.message); }

  // Recover any previously-skipped (no_game) messages whose forward game now exists.
  // Gated: rescan runs the reader (paid Haiku fallback if Mac is down), so skip in UI_ONLY.
  if (!process.env.UI_ONLY) {
    scanner.rescanSkipped().catch(err => console.error('[startup] rescanSkipped error:', err.message));
  }

  // Stamp actual_start_at / actual_end_at on any game already live/final at boot.
  stampActualStarts();
  stampActualEnds();
  // Prune anything already past its retention so the board is clean on boot.
  try { pruneStaleGames(); } catch (e) { console.error('[startup] prune error:', e.message); }

  // Re-evaluate any pending MVP picks (covers picks reset by db.js migration on startup)
  await resolveResults().catch(err => console.error('[startup] resolveResults error:', err.message));
  await resolveVotes().catch(err => console.error('[startup] resolveVotes error:', err.message));
  // Populate live game-state immediately so a mid-game restart shows scoreboards.
  await syncLiveSituations().catch(err => console.error('[startup] syncLiveSituations error:', err.message));
  // Void mutually-exclusive same-game MVP picks immediately on load (also runs on
  // the */5 cron) so conflicts like Knicks Win vs Spurs -5.5 settle without waiting.
  try {
    const n = resolveConflictingMvpPicks();
    if (n > 0) console.log(`[startup] Resolved ${n} MVP pick conflicts`);
  } catch (err) { console.error('[startup] resolveConflictingMvpPicks error:', err.message); }

  // Immediately seed public betting % — no API credits, just HTML scrape.
  // Runs unconditionally on startup so data is always fresh after a restart.
  for (const s of ['NBA', 'WNBA', 'NFL', 'MLB', 'NHL', 'NCAAF', 'CBB', 'Soccer']) {
    fetchPublicBetting(s).catch(e => console.error(`[startup] publicBetting ${s}:`, e.message));
  }

  // Seed line history + prediction market caches on startup (free APIs, no credits)
  const preGamesOnStart = db.prepare("SELECT * FROM today_games WHERE status='pre' AND ml_home IS NOT NULL").all();
  syncLineHistory(preGamesOnStart).catch(e => console.error('[startup] syncLineHistory:', e.message));
  syncPolymarketData(preGamesOnStart).catch(e => console.error('[startup] syncPolymarket:', e.message));
  syncKalshiData(preGamesOnStart).catch(e => console.error('[startup] syncKalshi:', e.message));
  // Esports markets are global + self-contained (no today_games dependency). Free APIs.
  syncEsportsMarkets().catch(e => console.error('[startup] syncEsports:', e.message));
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
  stampActualEnds();
  await resolveResults().catch(err => console.error('[cron] pre-wipe resolve error:', err.message));
  await resolveVotes().catch(err => console.error('[cron] pre-wipe resolveVotes error:', err.message));
  // Last-chance MVP snapshot before today_games + caches are wiped.
  try { snapshotStartedMvpGames(); } catch (e) { console.error('[cron] pre-wipe mvp snapshot:', e.message); }
  console.log('[cron] 4:58am — daily reset (per-game prune + operational tables)');
  await runDailyWipe().catch(err => console.error('[cron] wipe error:', err.message));
}, { timezone: 'America/New_York' });

// 5:30am ET — purge raw_messages_archive rows older than 7 days. Runs after the
// 4:58am wipe and 5:00am morning scan so it doesn't fight either.
cron.schedule('30 5 * * *', () => {
  try {
    const r = db.prepare(`DELETE FROM raw_messages_archive WHERE archived_at < datetime('now', '-7 days')`).run();
    if (r.changes) console.log(`[cron] 5:30am — purged ${r.changes} stale archive rows (>7d)`);
  } catch (err) {
    console.error('[cron] archive purge error:', err.message);
  }
}, { timezone: 'America/New_York' });

// 5:10am ET — record any newly-completed weekly/monthly leaderboard finishes.
// Free, DB-only, idempotent → runs even in UI_ONLY so badges stay current locally.
cron.schedule('10 5 * * *', () => {
  try { finalizeLeaderboardAwards(); }
  catch (err) { console.error('[cron] finalizeLeaderboardAwards error:', err.message); }
}, { timezone: 'America/New_York' });

// 5:20am ET — nightly capper ratings recompute (v3 foundation). Free, DB-only,
// idempotent → runs even in UI_ONLY so the local admin leaderboard stays current.
// Runs after the 4:58am final resolve so yesterday's grades are all in.
cron.schedule('20 5 * * *', () => {
  try { recomputeCapperRatings(); }
  catch (err) { console.error('[cron] recomputeCapperRatings error:', err.message); }
}, { timezone: 'America/New_York' });

// ── Wave-1 source scrapers (v3 Phase 3, track-only, all free) ────────────────
// Discovery/refresh at 5:05am ET: AN experts, Polymarket wallet leaderboard,
// Covers contestants. Runs after the 5:00am morning setup so today_games exists.
if (!UI_ONLY) cron.schedule('5 5 * * *', async () => {
  await discoverAnExperts().catch(err => console.error('[cron] discoverAnExperts error:', err.message));
  await refreshPmWallets().catch(err => console.error('[cron] refreshPmWallets error:', err.message));
  await refreshCoversContestants().catch(err => console.error('[cron] refreshCoversContestants error:', err.message));
}, { timezone: 'America/New_York' });

// AN picks: every 10 min active hours, every 30 min overnight (median pick posts
// 6.5h pregame; this captures nearly everything hours early).
if (!UI_ONLY) cron.schedule('*/10 8-23 * * *', () => {
  pollAnExperts().catch(err => console.error('[cron] pollAnExperts error:', err.message));
}, { timezone: 'America/New_York' });
if (!UI_ONLY) cron.schedule('*/30 0-7 * * *', () => {
  pollAnExperts().catch(err => console.error('[cron] pollAnExperts (overnight) error:', err.message));
}, { timezone: 'America/New_York' });

// Polymarket tracked-wallet trades: every 15 min active hours.
if (!UI_ONLY) cron.schedule('*/15 8-23 * * *', () => {
  pollPmWallets().catch(err => console.error('[cron] pollPmWallets error:', err.message));
}, { timezone: 'America/New_York' });

// Covers contestant pick pages: every 30 min active hours; contestant list also
// refreshes at 4:05pm for late-day contest movement.
if (!UI_ONLY) cron.schedule('*/30 8-23 * * *', () => {
  pollCoversPicks().catch(err => console.error('[cron] pollCoversPicks error:', err.message));
}, { timezone: 'America/New_York' });
if (!UI_ONLY) cron.schedule('5 16 * * *', () => {
  refreshCoversContestants().catch(err => console.error('[cron] refreshCoversContestants (4pm) error:', err.message));
}, { timezone: 'America/New_York' });

// Dummy accounts vote on the day's picks for not-yet-started games, then chat on
// the games they bet. Runs a few times a day (idempotent) to catch picks that come
// in after the morning setup, while their games are still pre-game. The extra late
// run (22:00) lets post-game reactions land after the slate finishes. Free, DB-only.
cron.schedule('20 6,10,14,18,22 * * *', () => {
  try { runDummyVotes(); runDummyComments(); }
  catch (err) { console.error('[cron] dummy accounts error:', err.message); }
}, { timezone: 'America/New_York' });

if (!UI_ONLY) cron.schedule('0 5 * * *', async () => {
  console.log('[cron] 5:00am — morning setup: ESPN + Odds + seed slots');
  await fetchTodaysGames().catch(err => console.error('[cron] fetchTodaysGames error:', err.message));
  await fetchTodaysTennisMatches().catch(err => console.error('[cron] fetchTodaysTennisMatches error:', err.message));
  await fetchTennisLines().catch(err => console.error('[cron] fetchTennisLines error:', err.message));
  await fetchTodaysWnbaGames().catch(err => console.error('[cron] fetchTodaysWnbaGames error:', err.message));
  await fetchTodaysSoccerGames().catch(err => console.error('[cron] fetchTodaysSoccerGames error:', err.message));
  await fetchTodaysNcaafGames().catch(err => console.error('[cron] fetchTodaysNcaafGames error:', err.message));
  await fetchGolfTournaments().catch(err => console.error('[cron] fetchGolfTournaments error:', err.message));
  // Forward games (today+2d, ESPN only) before seeding so their slots get created too.
  await fetchForwardGames().catch(err => console.error('[cron] fetchForwardGames error:', err.message));
  await refreshOdds().catch(err => console.error('[cron] refreshOdds error:', err.message));
  await lockMorningLines().catch(err => console.error('[cron] lockMorningLines error:', err.message));
  // Seed initial public betting percentages
  for (const s of Object.keys({ NBA:1, WNBA:1, NFL:1, MLB:1, NHL:1, NCAAF:1, CBB:1, Soccer:1 })) {
    fetchPublicBetting(s).catch(e => console.error(`[publicBetting] 5am ${s}:`, e.message));
  }
  // Seed initial line history + prediction market data
  const morningGames = db.prepare(`SELECT * FROM today_games WHERE status = 'pre'`).all();
  syncLineHistory(morningGames).catch(e => console.error('[cron] 5am syncLineHistory:', e.message));
  syncPolymarketData(morningGames).catch(e => console.error('[cron] 5am syncPolymarket:', e.message));
  syncKalshiData(morningGames).catch(e => console.error('[cron] 5am syncKalshi:', e.message));
  syncEsportsMarkets().catch(e => console.error('[cron] 5am syncEsports:', e.message));
  console.log('[cron] 5:00am — first scan of new cycle (back to 12:30am)');
  await runScan();
  // Recover yesterday's no_game skips now that forward games are fetched + seeded.
  await scanner.rescanSkipped().catch(err => console.error('[cron] 5am rescanSkipped error:', err.message));
}, { timezone: 'America/New_York' });

if (!UI_ONLY) cron.schedule('*/15 * * * *', async () => {
  if (!isActiveHours()) return;
  console.log('[cron] 15-min scan');
  await runScan();
  // Keep tennis start times accurate — they shift all day as the order of play
  // firms up, and the 5am fetch only captures a placeholder. Free (ESPN).
  refreshTennisStartTimes().catch(e => console.error('[cron] refreshTennisStartTimes:', e.message));
  // Free line data syncs — no API credits
  const preGames = db.prepare(`SELECT * FROM today_games WHERE status = 'pre'`).all();
  syncLineHistory(preGames).catch(e => console.error('[cron] syncLineHistory:', e.message));
  // Market volume feeds the Top Games ranking, so sync ALL of today's games
  // (pre/in/post) — finished games carry the day's biggest volume and must keep
  // their rank. Both syncs group calls by sport/tag, so more games != more requests.
  const allBoardGames = db.prepare(`SELECT * FROM today_games`).all();
  syncPolymarketData(allBoardGames).catch(e => console.error('[cron] syncPolymarket:', e.message));
  syncKalshiData(allBoardGames).catch(e => console.error('[cron] syncKalshi:', e.message));
  syncEsportsMarkets().catch(e => console.error('[cron] syncEsports:', e.message));
  fetchTennisLines().catch(e => console.error('[cron] fetchTennisLines:', e.message));
});

if (!UI_ONLY) cron.schedule('0 16 * * *', async () => {
  console.log('[cron] 4pm odds refresh');
  await refreshOdds().catch(err => console.error('[cron] refreshOdds error:', err.message));
  await fetchTennisLines().catch(err => console.error('[cron] fetchTennisLines error:', err.message));
  const { seedPickSlots } = require('./src/lines');
  await seedPickSlots().catch(err => console.error('[cron] seedPickSlots error:', err.message));
  // Refresh public betting percentages
  for (const s of Object.keys({ NBA:1, WNBA:1, NFL:1, MLB:1, NHL:1, NCAAF:1, CBB:1, Soccer:1 })) {
    fetchPublicBetting(s).catch(e => console.error(`[publicBetting] 4pm ${s}:`, e.message));
  }
}, { timezone: 'America/New_York' });

// Smart public betting refresh: every 30 min, hourly cadence unless within 3h of a game start
const _lastPbFetch = {};
cron.schedule('*/30 8-23 * * *', async () => {
  const now = Date.now();
  const THREE_HOURS = 3 * 60 * 60 * 1000;
  for (const sport of ['NBA','WNBA','NFL','MLB','NHL','NCAAF','CBB','Soccer']) {
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

// Hourly (active hours) — refresh DraftKings lines from ESPN (free, no Odds API credits).
// This is the "current line" people see and the line the algorithm captures when a pick
// crosses 35 points, so we keep it as fresh as is reasonable without hammering ESPN.
if (!UI_ONLY) cron.schedule('0 6-23 * * *', async () => {
  console.log('[cron] hourly ESPN DK odds refresh');
  await refreshEspnOdds().catch(err => console.error('[cron] refreshEspnOdds error:', err.message));
}, { timezone: 'America/New_York' });

cron.schedule('*/5 * * * *', () => {
  const resolved = resolveConflictingMvpPicks();
  if (resolved > 0) console.log(`[cron] Resolved ${resolved} MVP pick conflicts`);
});

if (!UI_ONLY) cron.schedule('*/5 * * * *', async () => {
  if (!isActiveHours()) return;
  // Refresh live/final scores for EVERY game on the board, not just games that
  // have a pick. The full-schedule fetchers below are supersets of the old
  // pick-only updaters (updateLiveScores / updateWnbaLiveScores /
  // updateTennisLiveScores): same upsert path, no `mention_count > 0` filter, so
  // un-picked games stop freezing at their 5am score. Free (ESPN), and
  // upsertTodayGame's COALESCE keeps the locked Odds API lines intact; the DK
  // book_lines write is an upsert (no row bloat, prev_ only shifts on real moves).
  // Golf already refreshes all active leaderboards below.
  await fetchTodaysGames().catch(err => console.error('[cron] fetchTodaysGames (live scores) error:', err.message));
  await fetchTodaysWnbaGames().catch(err => console.error('[cron] fetchTodaysWnbaGames (live scores) error:', err.message));
  await fetchTodaysNcaafGames().catch(err => console.error('[cron] fetchTodaysNcaafGames (live scores) error:', err.message));
  await updateSoccerLiveScores().catch(err => console.error('[cron] updateSoccerLiveScores error:', err.message));
  await refreshTennisStartTimes().catch(err => console.error('[cron] refreshTennisStartTimes (live scores) error:', err.message));
  await updateGolfLeaderboards().catch(err => console.error('[cron] updateGolfLeaderboards error:', err.message));
  // Condensed in-game state (baseball bases/outs/half-inning) for live games — free
  // ESPN scoreboard, runs after scores so statuses are fresh.
  await syncLiveSituations().catch(err => console.error('[cron] syncLiveSituations error:', err.message));
  // Stamp actual_start_at the first time any game flips to 'in'. Powers the
  // 5-min-past-actual-start scoring cutoff in storage.js.
  stampActualStarts();
  // Stamp actual_end_at the first time any game flips to 'post'. Powers the
  // per-game prune's grace tail.
  stampActualEnds();
  await resolveResults().catch(err => console.error('[cron] resolveResults error:', err.message));
  await resolveVotes().catch(err => console.error('[cron] resolveVotes error:', err.message));
  await require('./src/user_bets').gradePendingBets().catch(err => console.error('[cron] gradePendingBets error:', err.message));
  // Freeze the detail bundle for any MVP game that just started — the enrichment
  // caches still hold the final pre-game values (market syncs stop at 'pre').
  try { snapshotStartedMvpGames(); } catch (e) { console.error('[cron] mvp snapshot:', e.message); }
  // High-frequency line + market sync for games within 60 min
  const soonGames = db.prepare(`SELECT * FROM today_games WHERE status = 'pre'`).all();
  syncLineHistorySoon(soonGames).catch(e => console.error('[cron] syncLineHistorySoon:', e.message));
  // Polymarket is free with a generous rate limit (4k req/10s), so refresh ALL
  // pre-game volume every 5 min (not just games starting within the hour) — keeps
  // the Top Games ranking moving through the day. Kalshi is rate-limited, so it
  // stays on the lighter "starting soon" cadence here plus the 15-min full sync.
  syncPolymarketData(soonGames).catch(e => console.error('[cron] syncPolymarket 5min:', e.message));
  syncKalshiSoon(soonGames).catch(e => console.error('[cron] syncKalshiSoon:', e.message));
});

// Near-real-time live tick — every 30s while at least one game is in progress.
// ESPN-only (free): refreshes live scores + condensed game state (baseball
// bases/outs/half-inning) so the board, #1 card, and Top Games tiles track close
// to live, AND flips finished games to Final + grades them. Deliberately NOT gated
// by active hours — it's self-bounded by the live check, so a late West-coast game
// that ends after the active window still resolves instead of stranding on a live
// inning. Idles (one cheap query) when nothing is live. In-flight guard prevents overlap.
let _liveTickRunning = false;
if (!UI_ONLY) cron.schedule('*/30 * * * * *', async () => {
  if (_liveTickRunning) return;
  const hasLive = db.prepare("SELECT 1 FROM today_games WHERE status = 'in' LIMIT 1").get();
  if (!hasLive) return;
  _liveTickRunning = true;
  try {
    await fetchTodaysGames();
    await fetchTodaysWnbaGames();
    await fetchTodaysNcaafGames();
    await updateSoccerLiveScores();
    await syncLiveSituations();
    // A game that just flipped to Final needs to settle, not sit on its last inning.
    stampActualEnds();
    await resolveResults();
    await resolveVotes();
    await require('./src/user_bets').gradePendingBets();
  } catch (err) {
    console.error('[cron] live30 error:', err.message);
  } finally {
    _liveTickRunning = false;
  }
}, { timezone: 'America/New_York' });

// Hourly — per-game prune (retire finished games past their cycle clear + grace
// tail) and refresh the forward-game window so games added to ESPN's schedule
// mid-day for tomorrow get picked up. Prune runs always (pure DB hygiene); the
// forward fetch hits ESPN (free) so it's gated to live mode like the other crons.
cron.schedule('0 * * * *', async () => {
  try { pruneStaleGames(); } catch (e) { console.error('[cron] hourly prune error:', e.message); }
  if (!UI_ONLY) {
    await fetchForwardGames().catch(err => console.error('[cron] hourly fetchForwardGames error:', err.message));
    const { seedPickSlots } = require('./src/lines');
    await seedPickSlots().catch(err => console.error('[cron] hourly seedPickSlots error:', err.message));
  }
}, { timezone: 'America/New_York' });
