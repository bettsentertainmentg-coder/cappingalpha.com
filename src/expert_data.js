// src/expert_data.js — expert data source ingestion (channel scanner via selfbot)
// free-plays channel (1.5x, with sport record extraction)
// community-leaks channel (1.0x, pick + team focus, lower trust)
// pod-thread channel (1.25x, between free-plays and community)
// Window: today (ET). Skips messages from previous calendar days.

const { Client } = require('discord.js-selfbot-v13');
const db = require('./db');
const { lookupTodayGame } = require('./espn_live');
const { readMessage, readMessages } = require('./reader');
const { savePick }    = require('./storage');
const { getCycleWindow, cycleDateForInstant, ET_OFFSET_MS } = require('./cycle');

const FREE_PLAYS_CHANNEL_ID  = process.env.DISCH1;
const COMMUNITY_CHANNEL_ID   = process.env.DISCH2;
const POD_CHANNEL_ID         = process.env.DISCH3;
const USER_TOKEN              = process.env.DISCORD_USER_TOKEN;

const CHANNELS = [
  { id: FREE_PLAYS_CHANNEL_ID, name: 'free-plays',      weight: 1.5,  extractRecord: true  },
  { id: COMMUNITY_CHANNEL_ID,  name: 'community-leaks', weight: 1.0,  extractRecord: false },
  { id: POD_CHANNEL_ID,        name: 'pod-thread',      weight: 1.25, extractRecord: false },
];

// Fast lookup for the live messageCreate listener: channel ID → config
const CHANNEL_BY_ID = new Map(CHANNELS.filter(c => c.id).map(c => [c.id, c]));

// ── WNBA disambiguation ───────────────────────────────────────────────────────
// WNBA cities overlap with NBA (Atlanta, Phoenix, Dallas, etc.). lookupTodayGame
// matches by team name only, so a bare city could wrongly match a WNBA game when
// no NBA game exists that day. Only accept a WNBA game match when the message
// explicitly signals WNBA — the word "WNBA" or a WNBA team nickname. NBA-vs-WNBA
// same-city conflicts already resolve to NBA via espn_live SPORT_PRIORITY.
const WNBA_SIGNAL = /\b(wnba|aces|liberty|storm|dream|sky|sun|wings|valkyries|fever|sparks|lynx|mercury|mystics)\b/i;
function isWnbaSignaled(readerSport, text) {
  return (readerSport || '').toUpperCase() === 'WNBA' || WNBA_SIGNAL.test(text || '');
}

// ── Title-case a team name: "LAKERS" → "Lakers", "MIAMI HEAT" → "Miami Heat" ─
function titleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ── Sport record parser: "27-21 CBB" → { wins:27, losses:21, sport:'CBB' } ──
function parseSportRecord(text) {
  const match = text.match(/(\d+)-(\d+)\s*([A-Z]{2,5})/);
  if (!match) return null;
  return {
    wins: parseInt(match[1], 10),
    losses: parseInt(match[2], 10),
    sport_label: match[3],
    raw: match[0],
  };
}

const client = new Client({ checkUpdate: false });
let clientReady = false;

// ── scanner_state helpers ─────────────────────────────────────────────────────
function getLastMessageId(channelId) {
  const row = db.prepare(
    `SELECT last_message_id FROM scanner_state WHERE channel_id = ?`
  ).get(channelId);
  return row?.last_message_id || null;
}

function setLastMessageId(channelId, messageId) {
  db.prepare(`
    INSERT INTO scanner_state (channel_id, last_message_id, last_scanned_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET
      last_message_id = excluded.last_message_id,
      last_scanned_at = excluded.last_scanned_at
  `).run(channelId, messageId);
  console.log(`[Scanner] State saved: channel ${channelId} → last_message_id ${messageId}`);
}

// Return the lexicographically largest (newest) Discord snowflake ID
function newestId(messages) {
  let max = null;
  for (const [id] of messages) {
    if (!max || BigInt(id) > BigInt(max)) max = id;
  }
  return max;
}

// ── Process a single Discord message: extract picks, validate, save ───────────
// Shared by the batch scanner (scanChannel) and the live messageCreate listener.
// Returns the number of picks saved from this message.
async function processMessage(msg, channelConfig, window) {
  const { windowStart, windowEnd } = window || getCycleWindow();
  const ts = msg.createdTimestamp;
  if (ts < windowStart || ts >= windowEnd) {
    const outET = new Date(ts - ET_OFFSET_MS).toISOString().slice(0, 16);
    console.log(`[Scanner] Skipped out-of-window message from ${outET} ET`);
    return 0;
  }
  const msgDateET = new Date(ts - ET_OFFSET_MS).toISOString().slice(0, 10);
  // Skip messages with no real text (pure image posts, reactions, etc.)
  // Threshold is 4 to allow short picks like "VGK ML" (6 chars)
  if (!msg.content || msg.content.trim().length < 4) return 0;

  const isSweet16 = /sweet\s*1?6|sweet\s+sixteen/i.test(msg.content);

  // reader.js handles extraction
  const picks = await readMessage({
    content:   msg.content,
    channel:   channelConfig.name,
    author:    msg.author?.username || null,
    id:        msg.id,
    createdAt: msg.createdAt,
  });

  // Track whether this message produced any saved picks
  let msgSaved = 0;
  let skipReason = picks.length === 0 ? 'no_pick' : null;

  for (const pick of picks) {
    // Normalize casing
    if (pick.team) pick.team = titleCase(pick.team);

    // Sweet 16 messages are always CBB
    if (isSweet16 && (pick.sport || '').toUpperCase() !== 'CBB') {
      console.log(`[Scanner] Sweet 16 override: ${pick.team} sport ${pick.sport} → CBB`);
      pick.sport = 'CBB';
    }

    // ESPN lookup — validates team has a game today
    let todayGame = lookupTodayGame(pick.team, msgDateET);

    // Fallback: if the full string didn't match, try each word individually
    // Handles "CIN Reds" → try "CIN" then "Reds"; "Reds" finds Cincinnati Reds
    if (!todayGame) {
      const words = pick.team.trim().split(/\s+/);
      for (const word of words) {
        if (word.length < 3) continue;
        const g = lookupTodayGame(word, msgDateET);
        if (g) {
          console.log(`[Scanner] Word fallback: "${pick.team}" matched via "${word}" → ${g.home_team} vs ${g.away_team}`);
          todayGame = g;
          pick.team = word;
          break;
        }
      }
    }

    // WNBA guard: reject a WNBA game match unless the message explicitly
    // signaled WNBA (keyword or team nickname). Capture the reader's own sport
    // before it gets overwritten by the ESPN label below.
    if (todayGame && todayGame.sport === 'WNBA' && !isWnbaSignaled(pick.sport, msg.content)) {
      console.log(`[Scanner] WNBA guard: "${pick.team}" matched a WNBA game but no WNBA signal — rejecting`);
      todayGame = null;
    }

    if (!todayGame) {
      console.log(`[Scanner] Dropped: ${pick.team} (${pick.sport}) — no game found today`);
      skipReason = 'no_game';
      continue;
    }

    // Use ESPN's canonical sport label
    pick.sport = todayGame.sport;

    // Canonicalize team name to full ESPN display name for consistent dedup
    const tl = pick.team.toLowerCase();
    const homeMatch =
      (todayGame.home_team  || '').toLowerCase().includes(tl) ||
      (todayGame.home_short || '').toLowerCase().includes(tl) ||
      (todayGame.home_name  || '').toLowerCase().includes(tl);
    const canonical = homeMatch ? todayGame.home_team : todayGame.away_team;
    if (canonical && canonical !== pick.team) {
      console.log(`[Scanner] Canonical: "${pick.team}" → "${canonical}"`);
      pick.team = canonical;
    }

    // Augment pick with fields storage.js needs. Attribute to the GAME's cycle
    // date (from its start_time), not the message date — so an overnight pick for
    // tomorrow's game rides with that game instead of being dated to today.
    pick.is_home_team  = homeMatch;
    pick.game_date     = (todayGame.start_time ? cycleDateForInstant(todayGame.start_time) : null) || msgDateET;
    pick.espn_game_id  = todayGame.espn_game_id || null;

    console.log(`[Scanner] Saving: ${pick.team} (${pick.sport})`);
    savePick(pick);
    msgSaved++;
  }

  // If no picks were saved from this message, record it for later rescan
  if (msgSaved === 0 && skipReason) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO skipped_messages (message_id, channel, author, content, reason)
        VALUES (?, ?, ?, ?, ?)
      `).run(msg.id, channelConfig.name, msg.author?.username || null, msg.content, skipReason);
    } catch (_) {}
  }

  return msgSaved;
}

// ── Scan a single channel (incremental via Discord "after" snowflake) ─────────
async function scanChannel(channelConfig) {
  if (!channelConfig.id) {
    console.warn(`[CappperBoss:scanner] No channel ID for ${channelConfig.name}`);
    return 0;
  }

  console.log(`[Scanner] Scanning channel: ${channelConfig.id} (${channelConfig.name})`);

  const lastId = getLastMessageId(channelConfig.id);
  let saved = 0;

  try {
    const channel = await client.channels.fetch(channelConfig.id);
    let messages;

    if (!lastId) {
      // Build a snowflake ID for 6am ET today — fetch forward from there in batches of 100
      const { getCycleWindow } = require('./cycle');
      const { Collection } = require('discord.js-selfbot-v13');
      const DISCORD_EPOCH = 1420070400000n;
      const windowStartMs = BigInt(getCycleWindow().windowStart);
      const startSnowflake = String((windowStartMs - DISCORD_EPOCH) << 22n);

      console.log(`[CappperBoss:scanner] First scan — fetching all messages since cycle start from ${channelConfig.name}`);
      messages = new Collection();
      let after = startSnowflake;

      for (let i = 0; i < 20; i++) { // up to 2000 messages
        const batch = await channel.messages.fetch({ limit: 100, after });
        if (batch.size === 0) break;
        batch.forEach((msg, id) => messages.set(id, msg));
        after = String(batch.reduce((max, _, id) => BigInt(id) > BigInt(max) ? id : max, after));
        if (batch.size < 100) break;
      }
      console.log(`[CappperBoss:scanner] First scan — fetched ${messages.size} messages from ${channelConfig.name}`);
    } else {
      console.log(`[CappperBoss:scanner] Incremental scan — fetching messages after ID ${lastId} from ${channelConfig.name}`);
      messages = await channel.messages.fetch({ after: lastId, limit: 100 });
      if (messages.size === 0) {
        console.log(`[CappperBoss:scanner] ${channelConfig.name}: no new messages`);
        return 0;
      }
    }

    // Valid window: 6:00am ET on cycle-start day → 5:58am ET on cycle-end day
    const window = getCycleWindow();

    for (const [, msg] of messages) {
      saved += await processMessage(msg, channelConfig, window);
    }

    // Persist newest message ID so next scan resumes from here. Forward-only:
    // the live messageCreate listener may have already advanced state past this
    // scan's window, and we must never regress it (would cause needless re-reads).
    const newest = newestId(messages) ||
      String((BigInt(Date.now() - 1420070400000) << BigInt(22)));
    const curId = getLastMessageId(channelConfig.id);
    if (!curId || BigInt(newest) > BigInt(curId)) setLastMessageId(channelConfig.id, newest);

    console.log(`[CappperBoss:scanner] ${channelConfig.name}: ${saved} picks from ${messages.size} new messages`);
  } catch (err) {
    console.error(`[CappperBoss:scanner] Error scanning ${channelConfig.name}:`, err.message, err.stack);
  }

  return saved;
}

// ── Shared scan state — readable by index.js and admin.js via getScanState() ──
const scanState = {
  scanning:   false,
  lastScanAt: null,
  lastSaved:  null,
  error:      null,
};

function getScanState() { return scanState; }

// ── Global scan lock — prevents concurrent scans from cron, admin, and startup ─
let scanRunning = false;

// ── Scan all channels ─────────────────────────────────────────────────────────
async function scanAll() {
  if (!clientReady) {
    console.warn('[CappperBoss:scanner] Discord client not ready yet');
    return 0;
  }
  if (scanRunning) {
    console.warn('[CappperBoss:scanner] Scan already in progress — skipping');
    return 0;
  }
  scanRunning = true;
  scanState.scanning = true;
  scanState.error    = null;
  try {
    console.log('[CappperBoss:scanner] Starting scan...');
    let total = 0;
    for (const ch of CHANNELS) total += await scanChannel(ch);
    console.log(`[CappperBoss:scanner] Scan complete. ${total} picks saved.`);
    scanState.lastSaved  = total;
    scanState.lastScanAt = new Date().toISOString();
    return total;
  } catch (err) {
    scanState.error = err.message;
    throw err;
  } finally {
    scanRunning        = false;
    scanState.scanning = false;
  }
}

const runScan = scanAll;

// ── Live (event-driven) message processing ────────────────────────────────────
// messageCreate fires the instant a pick is posted. Messages are pushed to a
// serial queue so bursts are never dropped and the reader is never hammered
// concurrently. Each processed message advances scanner_state, so the periodic
// scanAll() cron becomes a free safety net (finds nothing new in steady state,
// only catches messages missed during gateway disconnects).
const liveQueue = [];
let liveDraining = false;

async function drainLiveQueue() {
  if (liveDraining) return;
  liveDraining = true;
  try {
    while (liveQueue.length) {
      const { msg, cfg } = liveQueue.shift();
      try {
        const saved = await processMessage(msg, cfg);
        // Advance scanner_state forward-only so the periodic scan won't re-read this
        const lastId = getLastMessageId(cfg.id);
        if (!lastId || BigInt(msg.id) > BigInt(lastId)) setLastMessageId(cfg.id, msg.id);
        if (saved > 0) scanState.lastSaved = saved;
        scanState.lastScanAt = new Date().toISOString();
      } catch (err) {
        console.error('[CappperBoss:scanner] live process error:', err.message);
      }
    }
  } finally {
    liveDraining = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  if (!USER_TOKEN) {
    console.error('[CappperBoss:scanner] DISCORD_USER_TOKEN not set');
    return;
  }

  client.on('ready', async () => {
    clientReady = true;
    console.log(`[CappperBoss:scanner] Discord ready as ${client.user.tag}`);
    await scanAll();
  });

  // Event-driven instant picks: process each new message the moment it lands.
  client.on('messageCreate', (msg) => {
    const cfg = CHANNEL_BY_ID.get(msg.channelId);
    if (!cfg) return; // not one of our scanned channels
    if (!msg.content || msg.content.trim().length < 4) return;
    liveQueue.push({ msg, cfg });
    drainLiveQueue();
  });

  client.on('error', (err) => console.error('[CappperBoss:discord]', err.message));
  client.login(USER_TOKEN).catch(err =>
    console.error('[CappperBoss:scanner] Login failed:', err.message)
  );
}

// ── Reset in-memory scanner state and trigger a fresh full scan ───────────────
// Clears the scanner_state table entries from memory so every channel
// re-fetches from scratch on the next scanAll() call.
async function resetState() {
  db.prepare(`DELETE FROM scanner_state`).run();
  db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'scanner_state'`).run();
  console.log('[Scanner] State reset — triggering fresh scan');
  return scanAll();
}

// ── Rescan skipped messages — re-runs all saved skipped messages through reader ─
// Useful after fixing reader.js rules to pick up previously missed messages.
async function rescanSkipped() {
  if (scanRunning) {
    console.warn('[Scanner] rescanSkipped: scan in progress — skipping');
    return 0;
  }
  const rows = db.prepare(`SELECT * FROM skipped_messages ORDER BY skipped_at`).all();
  if (!rows.length) {
    console.log('[Scanner] rescanSkipped: no skipped messages on record');
    return 0;
  }

  scanRunning = true;
  console.log(`[Scanner] rescanSkipped: processing ${rows.length} skipped messages`);
  let recovered = 0;

  const DISCORD_EPOCH = 1420070400000n;
  // Look back 3 days (not just the current cycle window) so a "no_game" skip from
  // yesterday can re-match once its forward game gets fetched. Matches the prune's
  // 3-day grace for unmatched picks.
  const RESCAN_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
  const minTs = Date.now() - RESCAN_LOOKBACK_MS;

  try {
  for (const row of rows) {
    // Derive original message timestamp from Discord snowflake — skip if too old
    const msgTs = Number((BigInt(row.message_id) >> 22n) + DISCORD_EPOCH);
    if (msgTs < minTs) {
      console.log(`[Scanner] rescanSkipped: skipping stale message from ${new Date(msgTs).toISOString()}`);
      continue;
    }

    const picks = await readMessage({
      content:   row.content,
      channel:   row.channel,
      author:    row.author,
      id:        row.message_id,
      createdAt: new Date(msgTs),
    });

    let msgSaved = 0;
    for (let pick of picks) {
      if (pick.team) pick.team = titleCase(pick.team);

      let todayGame = lookupTodayGame(pick.team, null);
      if (!todayGame) {
        const words = pick.team.trim().split(/\s+/);
        for (const word of words) {
          if (word.length < 3) continue;
          const g = lookupTodayGame(word, null);
          if (g) { todayGame = g; pick.team = word; break; }
        }
      }

      // WNBA guard (same as processMessage): require an explicit WNBA signal.
      if (todayGame && todayGame.sport === 'WNBA' && !isWnbaSignaled(pick.sport, row.content)) {
        continue;
      }
      if (!todayGame) continue;

      pick.sport = todayGame.sport;
      const tl = pick.team.toLowerCase();
      const homeMatch =
        (todayGame.home_team  || '').toLowerCase().includes(tl) ||
        (todayGame.home_short || '').toLowerCase().includes(tl) ||
        (todayGame.home_name  || '').toLowerCase().includes(tl);
      const canonical = homeMatch ? todayGame.home_team : todayGame.away_team;
      if (canonical) pick.team = canonical;
      pick.is_home_team = homeMatch;
      pick.espn_game_id = todayGame.espn_game_id || null;

      // Attribute to the game's cycle date (storage.js re-derives this too).
      const { getCycleDate } = require('./cycle');
      pick.game_date = (todayGame.start_time ? cycleDateForInstant(todayGame.start_time) : null) || getCycleDate();

      savePick(pick);
      msgSaved++;
      recovered++;
    }

    // If pick was recovered, remove from skipped_messages
    if (msgSaved > 0) {
      db.prepare(`DELETE FROM skipped_messages WHERE message_id = ?`).run(row.message_id);
    }

    // Small delay between Ollama calls to avoid overwhelming the queue
    await new Promise(r => setTimeout(r, 500));
  }
  } finally {
    scanRunning = false;
  }

  console.log(`[Scanner] rescanSkipped: recovered ${recovered} picks`);
  return recovered;
}

module.exports = { init, scanAll, scanChannel, runScan, parseSportRecord, resetState, getScanState, rescanSkipped };
