// src/discord_scanner.js — Discord channel scanner via selfbot
// free-plays channel (1.5x, with sport record extraction)
// community-leaks channel (1.0x, pick + team focus, lower trust)
// pod-thread channel (1.25x, between free-plays and community)
// Window: today (ET). Skips messages from previous calendar days.

const { Client } = require('discord.js-selfbot-v13');
const db = require('./db');
const { lookupTodayGame } = require('./espn_live');
const { readMessage, readMessages } = require('./reader');
const { savePick }    = require('./storage');
const { getCycleWindow, ET_OFFSET_MS } = require('./cycle');

const FREE_PLAYS_CHANNEL_ID  = process.env.DISCH1;
const COMMUNITY_CHANNEL_ID   = process.env.DISCH2;
const POD_CHANNEL_ID         = process.env.DISCH3;
const USER_TOKEN              = process.env.DISCORD_USER_TOKEN;

const CHANNELS = [
  { id: FREE_PLAYS_CHANNEL_ID, name: 'free-plays',      weight: 1.5,  extractRecord: true  },
  { id: COMMUNITY_CHANNEL_ID,  name: 'community-leaks', weight: 1.0,  extractRecord: false },
  { id: POD_CHANNEL_ID,        name: 'pod-thread',      weight: 1.25, extractRecord: false },
];

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

    // Valid window: 6:00am ET today → 5:58am ET tomorrow
    // Valid window: 6:00am ET on cycle-start day → 5:58am ET on cycle-end day
    const { windowStart, windowEnd } = getCycleWindow();

    // ── Phase 1: collect all valid messages for batch processing ─────────────
    const validMsgs = [];
    for (const [, msg] of messages) {
      const ts = msg.createdTimestamp;
      if (ts < windowStart || ts >= windowEnd) {
        const msgDateET = new Date(ts - ET_OFFSET_MS).toISOString().slice(0, 16);
        console.log(`[Scanner] Skipped out-of-window message from ${msgDateET} ET`);
        continue;
      }
      // Skip messages with no real text (pure image posts, reactions, etc.)
      if (!msg.content || msg.content.trim().length < 4) continue;
      validMsgs.push({
        content:    msg.content,
        channel:    channelConfig.name,
        author:     msg.author?.username || null,
        id:         msg.id,
        createdAt:  msg.createdAt,
        _msgDateET: new Date(ts - ET_OFFSET_MS).toISOString().slice(0, 10),
        _isSweet16: /sweet\s*1?6|sweet\s+sixteen/i.test(msg.content),
      });
    }

    // ── Phase 2: batch-process — all messages → one API call per 5 messages ──
    const picksByMsg = validMsgs.length > 0
      ? await readMessages(validMsgs)
      : [];

    // ── Phase 3: post-process picks (same logic as before, now index-matched) ─
    for (let i = 0; i < validMsgs.length; i++) {
      const { id, content, author, _msgDateET, _isSweet16 } = validMsgs[i];
      const picks = picksByMsg[i] || [];
      let msgSaved = 0;
      let skipReason = picks.length === 0 ? 'no_pick' : null;

      for (const pick of picks) {
        // Normalize casing
        if (pick.team) pick.team = titleCase(pick.team);

        // Sweet 16 messages are always CBB
        if (_isSweet16 && (pick.sport || '').toUpperCase() !== 'CBB') {
          console.log(`[Scanner] Sweet 16 override: ${pick.team} sport ${pick.sport} → CBB`);
          pick.sport = 'CBB';
        }

        // ESPN lookup — validates team has a game today
        let todayGame = lookupTodayGame(pick.team, _msgDateET);

        // Fallback: if the full string didn't match, try each word individually
        // Handles "CIN Reds" → try "CIN" then "Reds"; "Reds" finds Cincinnati Reds
        if (!todayGame) {
          const words = pick.team.trim().split(/\s+/);
          for (const word of words) {
            if (word.length < 3) continue;
            const g = lookupTodayGame(word, _msgDateET);
            if (g) {
              console.log(`[Scanner] Word fallback: "${pick.team}" matched via "${word}" → ${g.home_team} vs ${g.away_team}`);
              todayGame = g;
              pick.team = word;
              break;
            }
          }
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

        // Augment pick with fields storage.js needs
        pick.is_home_team  = homeMatch;
        pick.game_date     = _msgDateET;
        pick.espn_game_id  = todayGame.espn_game_id || null;

        console.log(`[Scanner] Saving: ${pick.team} (${pick.sport})`);
        savePick(pick);
        saved++;
        msgSaved++;
      }

      // If no picks were saved from this message, record it for later rescan
      if (msgSaved === 0 && skipReason) {
        try {
          db.prepare(`
            INSERT OR IGNORE INTO skipped_messages (message_id, channel, author, content, reason)
            VALUES (?, ?, ?, ?, ?)
          `).run(id, channelConfig.name, author, content, skipReason);
        } catch (_) {}
      }
    }

    // Persist newest message ID so next scan resumes from here
    const newest = newestId(messages) ||
      String((BigInt(Date.now() - 1420070400000) << BigInt(22)));
    setLastMessageId(channelConfig.id, newest);

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
  const { windowStart, windowEnd } = getCycleWindow();

  try {
  for (const row of rows) {
    // Derive original message timestamp from Discord snowflake — skip if outside current cycle
    const msgTs = Number((BigInt(row.message_id) >> 22n) + DISCORD_EPOCH);
    if (msgTs < windowStart || msgTs >= windowEnd) {
      console.log(`[Scanner] rescanSkipped: skipping out-of-cycle message from ${new Date(msgTs).toISOString()}`);
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

      const { getCycleDate } = require('./cycle');
      pick.game_date = getCycleDate();

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
