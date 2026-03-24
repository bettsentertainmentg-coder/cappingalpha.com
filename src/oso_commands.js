// src/oso_commands.js — OSO integration commands for CappperBoss

const axios = require('axios');
const db = require('./db');
const { scanAll } = require('./discord_scanner');
const { getRankedPicks, recalculateToday } = require('./value_engine');
const { fetchLiveGames, pollGame } = require('./espn_live');

const OLLAMA_URL   = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'llama3';

async function ollamaParse(prompt) {
  try {
    const res = await axios.post(OLLAMA_URL, {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1 }
    }, { timeout: 20000 });
    const match = res.data.response?.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

// ── handlePicksQuery ──────────────────────────────────────────────────────────
// Trigger: "what are the picks"

async function handlePicksQuery() {
  console.log('[CappperBoss:oso] handlePicksQuery triggered');

  await scanAll();
  recalculateToday();

  const picks = getRankedPicks();
  if (picks.length === 0) return '📭 No picks in the last 30 hours.';

  const top5 = picks.slice(0, 5);
  const lines = [`🎯 *CappperBoss — Top Picks (last 30h)*\n`];

  top5.forEach((p, i) => {
    const spread = p.spread != null ? ` (${p.spread > 0 ? '+' : ''}${p.spread})` : '';
    const record = p.sport_record ? ` | Record: ${p.sport_record}` : '';
    lines.push(
      `${i + 1}. *${p.team}* ${p.pick_type || ''}${spread}\n` +
      `   Score: ${p.score} | Source: ${p.channel} | Mentions: ${p.mention_count}${record}`
    );
  });

  return lines.join('\n');
}

// ── handleLetsGetBetting ──────────────────────────────────────────────────────
// Trigger: "lets get betting [sport/teams]"

async function handleLetsGetBetting(userMessage) {
  console.log('[CappperBoss:oso] handleLetsGetBetting:', userMessage);

  const parsed = await ollamaParse(
    `Parse this sports betting request and return JSON only, no other text:\n` +
    `{"sport":"nfl"|"nba"|"ncaab"|"nhl"|"mlb","teams":["team1","team2"]}\n` +
    `Use short sport codes. If sport unclear, guess from team names.\n` +
    `Message: ${userMessage}`
  );

  if (!parsed?.sport) {
    return `⚠️ Couldn't parse sport. Try: "lets get betting on NFL Cowboys vs Eagles"`;
  }

  const games = await fetchLiveGames(parsed.sport);
  if (games.length === 0) {
    return `📭 No active ${parsed.sport.toUpperCase()} games on ESPN right now.`;
  }

  let targets = games;
  if (parsed.teams?.length > 0) {
    const terms = parsed.teams.map(t => t.toLowerCase());
    targets = games.filter(g =>
      terms.some(t => g.home_team.toLowerCase().includes(t) || g.away_team.toLowerCase().includes(t))
    );
    if (targets.length === 0) targets = games.slice(0, 3);
  }

  const monitored = [];
  for (const game of targets) {
    await pollGame(game.espn_game_id, parsed.sport);
    monitored.push(`• ${game.away_team} @ ${game.home_team} (${game.status})`);
  }

  return (
    `✅ *CappperBoss — Monitoring ${parsed.sport.toUpperCase()}*\n\n` +
    monitored.join('\n') + '\n\n' +
    `Polling every 60s. Alerts via Telegram on:\n` +
    `• 10+ pt swing vs spread\n• Line moves 2+ pts\n• Hot pick (score > 70)\n• Team "due" after scoring run`
  );
}

// ── handleMyPick ──────────────────────────────────────────────────────────────
// Trigger: "i'm taking [pick]"

async function handleMyPick(userMessage) {
  console.log('[CappperBoss:oso] handleMyPick:', userMessage);

  const parsed = await ollamaParse(
    `Extract a sports betting pick from this message. Return JSON only, no other text:\n` +
    `{"team":"","pick_type":"","spread_value":null,"sport":""}\n` +
    `pick_type: "ML" for moneyline, "spread" for spread, "over/under" for totals.\n` +
    `Message: ${userMessage}`
  );

  if (!parsed?.team) {
    return `⚠️ Couldn't parse your pick. Try: "I'm taking Cowboys -3.5"`;
  }

  db.prepare(`
    INSERT INTO personal_picks (team, pick_type, spread, sport, game_date, result)
    VALUES (?, ?, ?, ?, date('now'), 'pending')
  `).run(
    parsed.team,
    parsed.pick_type || '',
    parsed.spread_value ?? null,
    parsed.sport || ''
  );

  const spread = parsed.spread_value != null
    ? ` ${parsed.spread_value > 0 ? '+' : ''}${parsed.spread_value}`
    : '';

  return `✅ Logged: *${parsed.team}*${spread} ${parsed.pick_type || ''} — tracking this one.`;
}

// ── handlePickResult ──────────────────────────────────────────────────────────
// Trigger: "that won" / "that lost" / "that pushed"

async function handlePickResult(userMessage) {
  console.log('[CappperBoss:oso] handlePickResult:', userMessage);

  const lower = userMessage.toLowerCase();
  let result;
  if (/\bwon\b|\bwin\b|\bw\b|cash(ed)?/.test(lower))    result = 'W';
  else if (/\blost\b|\blose\b|\bl\b/.test(lower))        result = 'L';
  else if (/\bpush(ed)?\b|\btie\b/.test(lower))          result = 'push';
  else return `⚠️ Couldn't detect W/L/push from: "${userMessage}"`;

  // Update most recent pending pick
  const pending = db.prepare(`
    SELECT id, team, pick_type, spread FROM personal_picks
    WHERE result = 'pending'
    ORDER BY noted_at DESC
    LIMIT 1
  `).get();

  if (!pending) return `⚠️ No pending personal picks found.`;

  db.prepare(`UPDATE personal_picks SET result = ? WHERE id = ?`).run(result, pending.id);

  // Build updated record
  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN result = 'W' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN result = 'L' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN result = 'push' THEN 1 ELSE 0 END) as pushes
    FROM personal_picks
    WHERE result != 'pending'
  `).get();

  const spread = pending.spread != null ? ` ${pending.spread > 0 ? '+' : ''}${pending.spread}` : '';
  return (
    `${result === 'W' ? '✅' : result === 'L' ? '❌' : '➡️'} ` +
    `${pending.team}${spread} marked *${result}*\n` +
    `Your record: *${stats.wins}W-${stats.losses}L-${stats.pushes}P*`
  );
}

module.exports = { handlePicksQuery, handleLetsGetBetting, handleMyPick, handlePickResult };
