// src/discord_scanner.js — Discord channel scanner via selfbot
// free-plays channel (1.5x, with sport record extraction)
// community-leaks channel (1.0x, pick + team focus, lower trust)
// pod-thread channel (1.25x, between free-plays and community)
// Window: today (ET). Skips messages from previous calendar days.

const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const db = require('./db');
const { lookupTodayGame, fetchTodaysGames } = require('./espn_live');

const FREE_PLAYS_CHANNEL_ID  = process.env.DISCORD_CHANNEL_mainplays;
const COMMUNITY_CHANNEL_ID   = process.env.DISCORD_CHANNEL_communityplays;
const POD_CHANNEL_ID         = process.env.DISCORD_CHANNEL_POD;
const USER_TOKEN              = process.env.DISCORD_USER_TOKEN;
const OLLAMA_URL              = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL            = 'llama3';

const CHANNELS = [
  { id: FREE_PLAYS_CHANNEL_ID, name: 'free-plays',      weight: 1.5,  extractRecord: true  },
  { id: COMMUNITY_CHANNEL_ID,  name: 'community-leaks', weight: 1.0,  extractRecord: false },
  { id: POD_CHANNEL_ID,        name: 'pod-thread',      weight: 1.25, extractRecord: false },
];

// ── Title-case a team name: "LAKERS" → "Lakers", "MIAMI HEAT" → "Miami Heat" ─
function titleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

const client = new Client({ checkUpdate: false });
let clientReady = false;

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

// ── JSON cleaner: strip markdown fences, backticks, whitespace ───────────────
function cleanJson(raw) {
  return raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .replace(/`/g, '')
    .trim();
}

// ── JSON repair: fix trailing commas and unclosed brackets/braces ─────────────
function tryFixJson(str) {
  let s = str;
  // Remove trailing commas before ] or }
  s = s.replace(/,\s*([\]}])/g, '$1');
  // Add missing closing brackets
  const opens  = (s.match(/\[/g) || []).length;
  const closes = (s.match(/\]/g) || []).length;
  if (opens > closes) s += ']'.repeat(opens - closes);
  // Add missing closing braces
  const openBraces  = (s.match(/\{/g) || []).length;
  const closeBraces = (s.match(/\}/g) || []).length;
  if (openBraces > closeBraces) s += '}'.repeat(openBraces - closeBraces);
  return s;
}

// ── Shared Ollama call with strict prompt wrapper ─────────────────────────────
async function ollamaExtract(innerPrompt) {
  const prompt =
    `You must respond with ONLY a valid JSON object, no other text, ` +
    `no markdown, no backticks, no explanation. Just raw JSON.\n` +
    innerPrompt;

  try {
    const res = await axios.post(OLLAMA_URL, {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1 }
    }, { timeout: 20000 });

    const raw = res.data.response?.trim() || '';
    const cleaned = cleanJson(raw);

    // Attempt 1: direct parse
    try { return JSON.parse(cleaned); } catch (_) {}

    // Attempt 2: extract array [...] and wrap as {picks:[...]}
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const arr = JSON.parse(arrayMatch[0]);
        if (Array.isArray(arr)) {
          console.warn('[CappperBoss:ollama] Used array extraction fallback');
          return { picks: arr };
        }
      } catch (_) {}
    }

    // Attempt 3: fix trailing commas / unclosed brackets, then retry
    try {
      const result = JSON.parse(tryFixJson(cleaned));
      console.warn('[CappperBoss:ollama] Used JSON repair fallback');
      return result;
    } catch (_) {}

    // Also try repairing just the extracted object
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        const result = JSON.parse(tryFixJson(objMatch[0]));
        console.warn('[CappperBoss:ollama] Used object-extract + repair fallback');
        return result;
      } catch (_) {}
    }

    console.warn('[CappperBoss:ollama] JSON parse failed after all attempts:', raw.slice(0, 300));
    return null;
  } catch (err) {
    console.warn('[CappperBoss:ollama] Request error:', err.message);
    return null;
  }
}

const WCBB_RULE =
  `- WCBB = women's college basketball; use WCBB ONLY if the message explicitly says "women", "WNCAA", or "women's basketball"\n` +
  `- CRITICAL: "Sweet 16" refers to the NCAA Men's tournament ONLY. Never tag Sweet 16 picks as WCBB or WNCAA. Sweet 16 = CBB always.\n`;

// ── Ollama: free-plays pick extraction — returns array of picks ───────────────
async function extractFreePlaysPick(message) {
  const innerPrompt =
    `Extract ALL sports betting picks from this message. A message may contain multiple picks.\n` +
    `RULES:\n` +
    `- team must be a real sports team name, NOT a person's name, handle, or abbreviation under 3 letters\n` +
    `- sport must be one of: CBB, WCBB, NBA, NFL, NHL, MLB, NCAAF, Tennis\n` +
    WCBB_RULE +
    `- capper_name: Discord username or name of the person posting (if identifiable, else null)\n` +
    `- sport_record: include if a record like "27-21 CBB" is present in the message, otherwise omit\n` +
    `- pick_type: "ML" for moneyline, "spread" for spread/ATS, "over" or "under" for totals\n` +
    `- set is_pick:false for any entry you are not confident is a real betting pick\n` +
    `Response format exactly (always return an array, even for one pick):\n` +
    `{"picks":[{"is_pick":true,"team":"","pick_type":"","spread_value":"","sport":"","sport_record":"","capper_name":""}]}\n` +
    `If no picks found: {"picks":[{"is_pick":false}]}\n` +
    `Message: ${message}`;

  const result = await ollamaExtract(innerPrompt);
  // Normalise: return array of pick objects
  if (!result) return [];
  if (Array.isArray(result.picks)) return result.picks;
  // Fallback: old single-object response shape
  if (result.is_pick !== undefined) return [result];
  return [];
}

// ── Ollama: community pick extraction — returns array of picks ────────────────
async function extractCommunityPick(message) {
  const innerPrompt =
    `Extract ALL sports betting picks from this message. A message may contain multiple picks.\n` +
    `RULES:\n` +
    `- team must be a real sports team name, NOT a person's name, handle, or abbreviation under 3 letters\n` +
    `- sport MUST be one of exactly: CBB, WCBB, NBA, NFL, NHL, MLB, NCAAF, Tennis — never leave it empty\n` +
    `- CBB = college basketball (March Madness, NCAAB, NCAA Tournament etc.)\n` +
    WCBB_RULE +
    `- if you cannot determine the sport with confidence, guess CBB (it is currently March Madness season)\n` +
    `- capper_name: Discord username or name of the person posting (if identifiable, else null)\n` +
    `- pick_type: "ML" for moneyline, "spread" for spread/ATS, "over" or "under" for totals\n` +
    `- set is_pick:false for any entry you are not confident is a real betting pick on a specific team\n` +
    `Response format exactly (always return an array, even for one pick):\n` +
    `{"picks":[{"is_pick":true,"team":"","pick_type":"","spread_value":"","sport":"","capper_name":""}]}\n` +
    `If no picks found: {"picks":[{"is_pick":false}]}\n` +
    `Message: ${message}`;

  const result = await ollamaExtract(innerPrompt);
  if (!result) return [];
  if (Array.isArray(result.picks)) return result.picks;
  if (result.is_pick !== undefined) return [result];
  return [];
}

// ── Ollama: pod-thread pick extraction — returns array of picks ───────────────
// Strips "Last play/POD" sections first; only passes today's POD to Ollama.
async function extractPodPick(message) {
  // Find the today's POD section. Patterns (case-insensitive):
  //   "POD:", "Today's POD:", "TODAYS POD:", "Today POD:"
  // Then strip everything from any "Last play:" / "Last POD:" / "LAST POD:" onward.
  const todayMatch = message.match(
    /(?:today'?s?\s+pod|todays?\s+pod|(?:^|\n)pod)\s*:?\s*([\s\S]+)/im
  );

  if (!todayMatch) {
    // No today's POD section found — check if message is purely a "Last" line
    if (/last\s+(?:play|pod)\s*:/i.test(message)) {
      console.log('[Scanner] Pod message has only Last play/POD — skipping');
    } else {
      console.log('[Scanner] Pod message has no today POD section — skipping');
    }
    return [];
  }

  // Strip anything from "Last play:" or "Last POD:" onward (yesterday's pick)
  let todaySection = todayMatch[1]
    .replace(/last\s+(?:play|pod)\s*:[\s\S]*/i, '')
    .trim();

  if (!todaySection) return [];

  console.log(`[Scanner] Pod today section: "${todaySection}"`);

  const innerPrompt =
    `Extract the betting pick(s) from this Play of the Day message section.\n` +
    `This is TODAY's pick only — the "Last POD/Last play" section has already been removed.\n` +
    `A message may contain multiple picks separated by "/" or newlines.\n` +
    `RULES:\n` +
    `- team must be a real sports team name, NOT a person's name or handle\n` +
    `- sport MUST be one of: CBB, WCBB, NBA, NFL, NHL, MLB, NCAAF, Tennis — never leave it empty\n` +
    `- CBB = college basketball; NHL = hockey; NBA = basketball pros\n` +
    WCBB_RULE +
    `- if sport is in parentheses like "(NBA)", use that\n` +
    `- pick_type: "ML" for moneyline, "spread" for spread/ATS, "over" or "under" for totals\n` +
    `- spread_value: the number after +/- or the total line (e.g. "+2.5", "151.5")\n` +
    `- capper_name: null (pod picks are channel-level, not user-attributed)\n` +
    `- set is_pick:false for any entry you are not confident is a real betting pick\n` +
    `Response format (always an array, even for one pick):\n` +
    `{"picks":[{"is_pick":true,"team":"","pick_type":"","spread_value":"","sport":"","capper_name":null}]}\n` +
    `If no picks found: {"picks":[{"is_pick":false}]}\n` +
    `Section: ${todaySection}`;

  const result = await ollamaExtract(innerPrompt);
  if (!result) return [];
  if (Array.isArray(result.picks)) return result.picks;
  if (result.is_pick !== undefined) return [result];
  return [];
}

// ── Ollama second-pass: validate team is a real team, not a person/handle ─────
async function validatePickWithOllama(parsed, rawMessage) {
  const innerPrompt =
    `You must respond with ONLY valid JSON, no markdown, no backticks.\n\n` +
    `Is this a real sports team name or a person's name/handle?\n` +
    `Team: ${parsed.team}\n` +
    `Original message: ${rawMessage}\n\n` +
    `RULES:\n` +
    `- Do NOT expand or change the team name at all\n` +
    `- Return the team name EXACTLY as given\n` +
    `- Only check: is this a real team or a person/handle?\n` +
    `- A nickname like "Ducks", "Bulls", "Heat" is valid — do not expand it\n` +
    `- A person's name or username is invalid\n\n` +
    `Examples that FAIL: Jimmy Adams, NickyMarino, capperking\n` +
    `Examples that PASS: Ducks, Bulls, Kansas, Texas Tech, Kentucky, Miami, Purdue, New York Islanders, Ottawa Senators, Ottawa, Vegas Golden Knights, Carolina Hurricanes, Tampa Bay Lightning\n\n` +
    `Return ONLY:\n` +
    `{"is_valid":true,"team":"${parsed.team}"}\n` +
    `OR\n` +
    `{"is_valid":false,"reason":"this is a person not a team"}`;

  const result = await ollamaExtract(innerPrompt);
  if (!result) return parsed; // if Ollama fails, pass through unchanged

  if (!result.is_valid) {
    console.log(`[Scanner] Ollama rejected non-team: "${parsed.team}" — ${result.reason || 'not a real team'}`);
    return null;
  }

  // Always keep the original team name — the DB lookup will resolve it
  return parsed;
}

// ── Save raw message linked to a pick — returns true if actually inserted ─────
function saveRawMessage(pickId, channelName, msg) {
  try {
    const messageId = msg.id || null;
    const result = db.prepare(`
      INSERT OR IGNORE INTO raw_messages (pick_id, channel, message_text, author, message_timestamp, message_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      pickId,
      channelName,
      msg.content.slice(0, 2000),
      msg.author?.username || null,
      msg.createdAt ? msg.createdAt.toISOString() : null,
      messageId
    );
    if (result.changes > 0) {
      console.log(`[Scanner] Raw message saved for pick ${pickId} (msg ${messageId})`);
    }
    return result.changes > 0; // false when message_id already existed
  } catch (e) {
    console.error('[Scanner] saveRawMessage failed:', e.message);
    return false;
  }
}

// ── Save pick — deduped by team+game_date, atomic: raw message saves first ─────
function savePick(parsed, msg, channel, gameDate) {
  if (!parsed?.is_pick || !parsed.team) return false;
  if (typeof msg !== 'object') return false; // raw message required

  const rawMessage = msg.content;
  const sport = (parsed.sport || '').toUpperCase();
  const gDate = gameDate || new Date().toISOString().slice(0, 10);
  const pendingReview = parsed.pending_review ? 1 : 0;

  // Parse sport_record string if provided
  let sportRecord = null;
  if (channel.extractRecord && parsed.sport_record) {
    const rec = parseSportRecord(parsed.sport_record);
    sportRecord = rec ? parsed.sport_record : null;
  }

  const isFreePlays = channel.name === 'free-plays';
  const isPod       = channel.name === 'pod-thread';

  // Dedup: same team + game_date within last 48 hours → increment mention_count
  const existing = db.prepare(`
    SELECT id FROM picks
    WHERE team = ? AND game_date = ?
      AND parsed_at >= datetime('now', '-48 hours')
    ORDER BY parsed_at DESC
    LIMIT 1
  `).get(parsed.team, gDate);

  if (existing) {
    // Save raw message first; only increment if it was genuinely new
    const msgSaved = saveRawMessage(existing.id, channel.name, msg);
    if (msgSaved) {
      db.prepare(`
        UPDATE picks SET
          mention_count       = mention_count + 1,
          free_plays_mentions = free_plays_mentions + ?,
          community_mentions  = community_mentions + ?,
          pod_mentions        = pod_mentions + ?
        WHERE id = ?
      `).run(isFreePlays ? 1 : 0, (!isFreePlays && !isPod) ? 1 : 0, isPod ? 1 : 0, existing.id);
      console.log(`[Scanner] Incremented mention for ${parsed.team} (${channel.name})`);
    } else {
      console.log(`[Scanner] Duplicate message skipped for ${parsed.team} (${channel.name})`);
    }
    return msgSaved;
  }

  // New pick — insert pick first to get real pick_id, then insert raw message
  const result = db.prepare(`
    INSERT INTO picks
      (capper_name, team, pick_type, spread, sport, sport_record,
       game_date, mention_count, raw_message, channel, channel_weight,
       free_plays_mentions, community_mentions, pod_mentions, pending_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parsed.capper_name || null,
    parsed.team,
    parsed.pick_type || '',
    parsed.spread_value ?? null,
    sport,
    sportRecord,
    gDate,
    rawMessage.slice(0, 1000),
    channel.name,
    channel.weight,
    isFreePlays ? 1 : 0,
    (!isFreePlays && !isPod) ? 1 : 0,
    isPod ? 1 : 0,
    pendingReview
  );

  saveRawMessage(result.lastInsertRowid, channel.name, msg);

  console.log(`[Scanner] Saved pick: ${parsed.team} (${sport || '?'}) from ${channel.name} — game date: ${gDate}`);
  return true;
}

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

// Return the lexicographically largest (newest) Discord snowflake ID from a Collection
function newestId(messages) {
  let max = null;
  for (const [id] of messages) {
    if (!max || BigInt(id) > BigInt(max)) max = id;
  }
  return max;
}

// ── Scan a single channel (incremental via Discord "after" snowflake) ──────────
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
      // First scan — fetch the 50 most recent messages
      console.log(`[CappperBoss:scanner] First scan — fetching last 50 messages from ${channelConfig.name}`);
      messages = await channel.messages.fetch({ limit: 50 });
    } else {
      // Incremental scan — only messages after the last known ID
      console.log(`[CappperBoss:scanner] Incremental scan — fetching messages after ID ${lastId} from ${channelConfig.name}`);
      messages = await channel.messages.fetch({ after: lastId, limit: 100 });

      if (messages.size === 0) {
        console.log(`[CappperBoss:scanner] ${channelConfig.name}: no new messages`);
        return 0;
      }
    }

    // Compute today's date in ET (UTC-5 standard / UTC-4 DST).
    // Use UTC-5 as a conservative offset — the worst case is a 1-hour
    // overlap around the DST boundary, which is acceptable.
    const etOffsetMs = 5 * 60 * 60 * 1000;
    const todayET = new Date(Date.now() - etOffsetMs).toISOString().slice(0, 10);

    for (const [, msg] of messages) {
      const msgDateET = new Date(msg.createdTimestamp - etOffsetMs).toISOString().slice(0, 10);
      if (msgDateET < todayET) {
        console.log(`[Scanner] Skipped old message from ${msgDateET} (ts ${msg.createdTimestamp})`);
        continue;
      }
      if (msg.attachments.size > 0 || msg.embeds.some(e => e.image || e.thumbnail)) continue;
      if (!msg.content || msg.content.length < 10) continue;

      // Sweet 16 override: force CBB before Ollama extraction even runs
      const isSweet16 = /sweet\s*1?6|sweet\s+sixteen/i.test(msg.content);

      const picks = channelConfig.extractRecord
        ? await extractFreePlaysPick(msg.content)
        : channelConfig.name === 'pod-thread'
          ? await extractPodPick(msg.content)
          : await extractCommunityPick(msg.content);

      for (let parsed of picks) {
        if (!parsed?.is_pick) continue;

        // Normalize team name casing before any lookup or dedup
        if (parsed.team) parsed.team = titleCase(parsed.team);

        parsed = await validatePickWithOllama(parsed, msg.content);
        if (!parsed?.is_pick) continue;

        // Post-processing: Sweet 16 messages are always CBB
        if (isSweet16) {
          if ((parsed.sport || '').toUpperCase() !== 'CBB') {
            console.log(`[Scanner] Sweet 16 override: ${parsed.team} sport ${parsed.sport} → CBB`);
          }
          parsed.sport = 'CBB';
        }

        const sport = (parsed.sport || '').toUpperCase();
        const todayGame = lookupTodayGame(parsed.team, msgDateET);

        if (!todayGame) {
          console.log(`[Scanner] Dropped: ${parsed.team} (${sport}) — no game found today`);
          continue;
        }

        parsed.sport = todayGame.sport;

        // Canonicalize team name to full ESPN name so dedup merges variants
        const tl = parsed.team.toLowerCase();
        const homeMatch =
          (todayGame.home_team  || '').toLowerCase().includes(tl) ||
          (todayGame.home_short || '').toLowerCase().includes(tl) ||
          (todayGame.home_name  || '').toLowerCase().includes(tl);
        const canonical = homeMatch ? todayGame.home_team : todayGame.away_team;
        if (canonical && canonical !== parsed.team) {
          console.log(`[Scanner] Canonical: "${parsed.team}" → "${canonical}"`);
          parsed.team = canonical;
        }

        console.log(`[Scanner] Saving: ${parsed.team} (${parsed.sport})`);
        if (savePick(parsed, msg, channelConfig, msgDateET)) saved++;
      }
    }

    // Persist the newest message ID so next scan knows where to resume.
    // If the channel had no messages, generate a "now" snowflake so we never
    // repeat a first scan (Discord epoch: 1420070400000ms).
    const newest = newestId(messages) ||
      String((BigInt(Date.now() - 1420070400000) << BigInt(22)));
    setLastMessageId(channelConfig.id, newest);

    console.log(`[CappperBoss:scanner] ${channelConfig.name}: ${saved} picks from ${messages.size} new messages`);
  } catch (err) {
    console.error(`[CappperBoss:scanner] Error scanning ${channelConfig.name}:`, err.message, err.stack);
  }

  return saved;
}

// ── Scan all channels — used by cron, init, and manual trigger ────────────────
async function scanAll() {
  if (!clientReady) {
    console.warn('[CappperBoss:scanner] Discord client not ready yet');
    return 0;
  }
  console.log('[CappperBoss:scanner] Starting scan...');
  // Refresh today_games before scanning so late-added ESPN games aren't missed
  await fetchTodaysGames().catch(err =>
    console.warn('[CappperBoss:scanner] fetchTodaysGames error:', err.message)
  );
  let total = 0;
  for (const ch of CHANNELS) total += await scanChannel(ch);
  console.log(`[CappperBoss:scanner] Scan complete. ${total} picks saved.`);
  return total;
}

// ── runScan — alias used by dashboard POST /api/scan ─────────────────────────
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

module.exports = { init, scanAll, scanChannel, runScan, parseSportRecord };
