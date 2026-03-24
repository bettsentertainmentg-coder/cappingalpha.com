// CappperBoss — Sports betting intelligence agent
// Reads env from ~/Projects/AgentOSO/.env

require('dotenv').config({
  path: require('path').join(process.env.HOME || '/Users/jack', 'Projects/AgentOSO/.env')
});

const cron    = require('node-cron');
const scanner = require('./src/discord_scanner');
const tracker = require('./src/capper_tracker');
const { resolveResults } = tracker;
const { recalculateToday } = require('./src/value_engine');
const { checkHotPicks }    = require('./src/alerts');
const dashboard = require('./src/dashboard');
const db        = require('./src/db');
const { fetchTodaysGames } = require('./src/espn_live');

// ── Active hours window (Eastern Time) ───────────────────────────────────────
const ACTIVE_START = 10; // 10:00 AM ET
const ACTIVE_END   = 25; // 1:00 AM ET next day (25 = 24 + 1)

// Returns the current hour in ET as a 0–23 number,
// then maps "after midnight but before ACTIVE_END" to 24+h so the
// window [ACTIVE_START, ACTIVE_END) is a single numeric comparison.
function etHour() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  const h = parseInt(etStr, 10); // 0–23
  // Hours 0–ACTIVE_END-24 (i.e. midnight–1AM) map to 24–25 so they fall
  // inside the window when compared against ACTIVE_END.
  return h < (ACTIVE_END - 24) ? h + 24 : h;
}

function isActiveHours() {
  const h = etHour();
  return h >= ACTIVE_START && h < ACTIVE_END;
}

// ── Validate env ──────────────────────────────────────────────────────────────
const required = ['DISCORD_USER_TOKEN', 'DISCORD_CHANNEL_mainplays', 'DISCORD_CHANNEL_communityplays', 'DISCORD_CHANNEL_POD'];
const missing  = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[CappperBoss] Missing env vars: ${missing.join(', ')}`);
  console.error(`[CappperBoss] Add them to ~/Projects/AgentOSO/.env`);
  process.exit(1);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
console.log('[CappperBoss] ─────────────────────────────────');
console.log('[CappperBoss] Starting up...');

// Dashboard always starts regardless of active hours
dashboard.start(3001);

// Discord scanner — connects and waits; initial scan gated below
scanner.init();

// ── Startup: resolve any pending results, then scan if in active hours ────────
resolveResults();

if (isActiveHours()) {
  console.log('[Scheduler] Active window started — scanning begins');
  fetchTodaysGames().catch(err => console.error('[CappperBoss] fetchTodaysGames error:', err.message));
  // scanner.init() triggers its own initial scanAll via the 'ready' event,
  // so no explicit scanAll() call needed here.
} else {
  console.log('[Scheduler] Waiting for active window (10AM ET) to begin scanning');
}

// ── Cron: scan Discord every 15 minutes (active hours only) ──────────────────
cron.schedule('*/15 * * * *', async () => {
  resolveResults();
  if (!isActiveHours()) {
    console.log('[Scheduler] Outside active hours, skipping scan');
    return;
  }
  console.log('[CappperBoss:cron] 15-min scan triggered');
  await scanner.scanAll();
  recalculateToday();
  checkHotPicks();
});

// ── Cron: ESPN refresh every 60 minutes (active hours only) ──────────────────
cron.schedule('0 * * * *', () => {
  if (!isActiveHours()) return;
  fetchTodaysGames().catch(err => console.error('[CappperBoss] fetchTodaysGames error:', err.message));
});

// ── Cron: recalculate scores every hour (always) ─────────────────────────────
cron.schedule('30 * * * *', () => {
  recalculateToday();
});

// ── Cron: purge expired picks and raw messages every hour (always) ────────────
cron.schedule('15 * * * *', () => {
  const { changes: rawDel } = db.prepare(
    `DELETE FROM raw_messages WHERE saved_at < datetime('now', '-30 hours')`
  ).run();
  const { changes: pickDel } = db.prepare(
    `DELETE FROM picks WHERE parsed_at < datetime('now', '-30 hours')`
  ).run();
  if (pickDel > 0 || rawDel > 0) {
    console.log(`[CappperBoss:cleanup] Purged ${pickDel} picks, ${rawDel} raw messages (>30h old)`);
  }
});

// ── Cron: daily reset at 6:00 AM ET ──────────────────────────────────────────
cron.schedule('0 6 * * *', async () => {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

  const { changes: picksCleared } = db.prepare(
    `DELETE FROM picks WHERE game_date < ?`
  ).run(todayET);

  const { changes: gamesCleared } = db.prepare(
    `DELETE FROM today_games WHERE DATE(start_time) < ?`
  ).run(todayET);

  const { changes: liveCleared } = db.prepare(
    `DELETE FROM live_games WHERE status = 'post' OR status LIKE '%Final%'`
  ).run();

  console.log(`[CappperBoss:daily] Reset complete — cleared ${picksCleared} yesterday's picks, ${gamesCleared} stale games, ${liveCleared} finished live games`);

  fetchTodaysGames().catch(err => console.error('[CappperBoss:daily] fetchTodaysGames error:', err.message));
}, { timezone: 'America/New_York' });

// ── Cron: log active window transitions at boundary hours ─────────────────────
cron.schedule('0 10 * * *', () => {
  console.log('[Scheduler] Active window started — scanning begins');
}, { timezone: 'America/New_York' });

cron.schedule('0 1 * * *', () => {
  console.log('[Scheduler] Active window ended — resuming at 10AM ET');
}, { timezone: 'America/New_York' });

console.log('[CappperBoss] Dashboard: http://localhost:3001');
console.log('[CappperBoss] Discord scanning every 15 minutes (10AM–1AM ET)');
console.log('[CappperBoss] Picks purged hourly (>30h window)');
console.log(`[CappperBoss] Active hours: ${ACTIVE_START}:00–${ACTIVE_END - 24}:00 AM ET`);
console.log('[CappperBoss] ─────────────────────────────────');
