// src/capper_tracker.js — Win/loss record tracker for cappers
// Scans message history for W/L results and builds capper leaderboard

const axios = require('axios');
const { Client } = require('discord.js-selfbot-v13');
const db = require('./db');

const MAIN_CHANNEL_ID      = process.env.DISCORD_CHANNEL_mainplays;
const COMMUNITY_CHANNEL_ID = process.env.DISCORD_CHANNEL_communityplays;
const USER_TOKEN           = process.env.DISCORD_USER_TOKEN;
const OLLAMA_URL           = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL         = 'llama3';

// Regex patterns for quick W/L detection before hitting Ollama
const WIN_PATTERNS  = [/\bW\b/i, /\bwin\b/i, /\bcash(ed)?\b/i, /✅/, /🟢/, /\+[0-9]/];
const LOSS_PATTERNS = [/\bL\b(?!\w)/, /\bloss\b/i, /\blose\b/i, /\bno good\b/i, /❌/, /🔴/];

function looksLikeResult(text) {
  return WIN_PATTERNS.some(p => p.test(text)) || LOSS_PATTERNS.some(p => p.test(text));
}

// ── Ollama result extraction ──────────────────────────────────────────────────
async function extractResult(message) {
  const prompt =
    `Analyze this Discord message for a sports betting result. ` +
    `Return JSON only, no other text:\n` +
    `{"capper_name":"","result":"W"|"L"|null,"team":""}\n` +
    `Only set result if the message clearly indicates a win (W) or loss (L).\n` +
    `Message: ${message}`;

  try {
    const res = await axios.post(OLLAMA_URL, {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1 }
    }, { timeout: 20000 });

    const raw = res.data.response?.trim() || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

// ── Update capper record ──────────────────────────────────────────────────────
function recordResult(capperName, result) {
  if (!capperName || !result) return;

  const existing = db.prepare('SELECT * FROM cappers WHERE name = ?').get(capperName);

  if (existing) {
    const wins   = existing.wins   + (result === 'W' ? 1 : 0);
    const losses = existing.losses + (result === 'L' ? 1 : 0);
    const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
    db.prepare(`
      UPDATE cappers SET wins = ?, losses = ?, win_rate = ?, last_updated = datetime('now')
      WHERE name = ?
    `).run(wins, losses, winRate, capperName);
  } else {
    const wins   = result === 'W' ? 1 : 0;
    const losses = result === 'L' ? 1 : 0;
    db.prepare(`
      INSERT INTO cappers (name, wins, losses, win_rate, last_updated)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(capperName, wins, losses, wins > 0 ? 1 : 0);
  }

  console.log(`[CappperBoss:tracker] ${capperName} → ${result}`);
}

// ── Scan channel history for W/L results ─────────────────────────────────────
async function scanChannelHistory(client, channelId, limit = 500) {
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    let fetched = 0;
    let lastId;

    while (fetched < limit) {
      const batch = await channel.messages.fetch({ limit: Math.min(100, limit - fetched), before: lastId });
      if (batch.size === 0) break;

      for (const [, msg] of batch) {
        if (!msg.content || !looksLikeResult(msg.content)) continue;
        const parsed = await extractResult(msg.content);
        if (parsed?.result && parsed?.capper_name) {
          recordResult(parsed.capper_name, parsed.result);
        }
      }

      fetched += batch.size;
      lastId = batch.last()?.id;
      if (batch.size < 100) break;
    }

    console.log(`[CappperBoss:tracker] Scanned ${fetched} messages from channel ${channelId}`);
  } catch (err) {
    console.error('[CappperBoss:tracker] Scan error:', err.message);
  }
}

// ── Startup history scan using shared client ──────────────────────────────────
async function runStartupScan(discordClient) {
  console.log('[CappperBoss:tracker] Starting W/L history scan (last 500 messages per channel)...');
  await scanChannelHistory(discordClient, MAIN_CHANNEL_ID, 500);
  await scanChannelHistory(discordClient, COMMUNITY_CHANNEL_ID, 500);
  console.log('[CappperBoss:tracker] History scan complete.');
}

// ── Get leaderboard ───────────────────────────────────────────────────────────
function getLeaderboard() {
  return db.prepare(`
    SELECT name, wins, losses, win_rate
    FROM cappers
    WHERE wins + losses > 0
    ORDER BY win_rate DESC, wins DESC
  `).all();
}

// ── Resolve pending bot_picks and jack_picks from today_games scores ──────────
function resolveResults() {
  let resolved = 0;

  for (const table of ['bot_picks', 'jack_picks']) {
    const pending = db.prepare(`SELECT * FROM ${table} WHERE result = 'pending'`).all();

    for (const pick of pending) {
      if (!pick.espn_game_id) continue;

      const game = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(pick.espn_game_id);
      if (!game || game.status !== 'post') continue;

      // Determine which side is the picked team
      const tl = (pick.team || '').toLowerCase();
      const homeNames = [game.home_team, game.home_short, game.home_name, game.home_abbr]
        .filter(Boolean).map(s => s.toLowerCase());
      const isHome = homeNames.some(n => n.includes(tl) || tl.includes(n));

      const pickedScore = isHome ? game.home_score : game.away_score;
      const oppScore    = isHome ? game.away_score  : game.home_score;
      const spread      = pick.spread != null ? parseFloat(pick.spread) : null;
      const pt          = (pick.pick_type || '').toLowerCase();
      const total       = game.home_score + game.away_score;

      let result;
      if (pt === 'ml') {
        result = pickedScore > oppScore ? 'win' : pickedScore < oppScore ? 'loss' : 'push';
      } else if (pt === 'spread' && spread != null) {
        const adjusted = pickedScore + spread;
        result = adjusted > oppScore ? 'win' : adjusted < oppScore ? 'loss' : 'push';
      } else if (pt === 'over' && spread != null) {
        result = total > spread ? 'win' : total < spread ? 'loss' : 'push';
      } else if (pt === 'under' && spread != null) {
        result = total < spread ? 'win' : total > spread ? 'loss' : 'push';
      } else {
        // Not enough info to resolve
        continue;
      }

      db.prepare(`UPDATE ${table} SET result = ? WHERE id = ?`).run(result, pick.id);
      console.log(`[Tracker] ${pick.team} ${pick.pick_type} → ${result.toUpperCase()} (${table})`);
      resolved++;
    }
  }

  if (resolved > 0) console.log(`[Tracker] Resolved ${resolved} pending pick(s)`);
  return resolved;
}

module.exports = { runStartupScan, recordResult, getLeaderboard, resolveResults };
