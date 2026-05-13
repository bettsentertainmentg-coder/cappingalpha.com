// src/reader.js
// Receives a raw Discord message, extracts pick data via local Ollama (Mac)
// or falls back to Claude Haiku API if the Mac is unreachable.
//
// ── To change extraction rules: edit src/reader_rules.js ──────────────────────
// That file is shared with local_reader_api.js (Mac Ollama server).
// Haiku prompt-caches RULES automatically — rule changes are free and instant.

const Anthropic = require('@anthropic-ai/sdk');
const axios     = require('axios');
const db        = require('./db');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY_READER,
});
const MODEL  = 'claude-haiku-4-5-20251001';

// Haiku 4.5 pricing (USD per token)
const PRICE = {
  input:         0.80  / 1_000_000,
  output:        4.00  / 1_000_000,
  cache_write:   1.00  / 1_000_000,
  cache_read:    0.08  / 1_000_000,
};

const logUsageStmt = db.prepare(`
  INSERT INTO api_usage (model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd, reader_path)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const logCallStmt = db.prepare(`
  INSERT INTO reader_call_log (path, msg_count, pick_count, latency_ms, error)
  VALUES (?, ?, ?, ?, ?)
`);

function logUsage(usage, path = 'haiku') {
  try {
    const input  = usage.input_tokens                || 0;
    const output = usage.output_tokens               || 0;
    const cwrite = usage.cache_creation_input_tokens || 0;
    const cread  = usage.cache_read_input_tokens     || 0;
    const cost   = (input * PRICE.input) + (output * PRICE.output)
                 + (cwrite * PRICE.cache_write) + (cread * PRICE.cache_read);
    logUsageStmt.run(MODEL, input, output, cwrite, cread, cost, path);
  } catch (err) {
    console.warn('[reader] usage log error:', err.message);
  }
}

function logCall(path, msgCount, pickCount, latencyMs, error = null) {
  try { logCallStmt.run(path, msgCount, pickCount, latencyMs, error); } catch (_) {}
}

// ── Shared rules + tool schema ────────────────────────────────────────────────
const { RULES, EXTRACT_TOOL } = require('./reader_rules');

// ── Mac local reader (Ollama) — primary path ──────────────────────────────────
// Set LOCAL_READER_URL in Railway env to enable. Falls back to Haiku if unset
// or if the Mac doesn't respond within 30 seconds.
const LOCAL_READER_URL        = (process.env.LOCAL_READER_URL    || '').replace(/\/$/, '');
const LOCAL_READER_SECRET     = process.env.LOCAL_READER_SECRET  || '';
const LOCAL_READER_TIMEOUT_MS = 90_000;

// ── Reader mode — settable from admin panel ───────────────────────────────────
// 'auto' (default): try Mac first, fall back to Haiku
// 'mac':   Mac only — returns null if Mac unavailable (no Haiku fallback)
// 'haiku': Haiku only — skip Mac entirely
function getReaderMode() {
  return db.getSetting('reader_mode', 'auto');
}

async function tryMacReader(endpoint, body) {
  if (!LOCAL_READER_URL) return null;
  const t0 = Date.now();
  try {
    const res = await axios.post(`${LOCAL_READER_URL}${endpoint}`, body, {
      timeout: LOCAL_READER_TIMEOUT_MS,
      headers: LOCAL_READER_SECRET ? { 'x-reader-secret': LOCAL_READER_SECRET } : {},
    });
    const data = res.data ?? null;
    if (data) {
      const picks = Array.isArray(data.picks) ? data.picks.filter(p => p?.is_pick) : [];
      logCall('mac', Array.isArray(body.messages) ? body.messages.length : 1, picks.length, Date.now() - t0);
    }
    return data;
  } catch (err) {
    logCall('mac-fail', Array.isArray(body.messages) ? body.messages.length : 1, 0, Date.now() - t0, err.message.slice(0, 120));
    console.warn('[reader] Mac reader unavailable, falling back to Haiku:', err.message);
    return null;
  }
}

// ── Learned corrections — injected as second system block (not cached) ────────
let _correctionsCache     = null;
let _correctionsCacheTime = 0;
const CORRECTIONS_TTL = 5 * 60 * 1000;

function getCorrectionsBlock() {
  const now = Date.now();
  if (_correctionsCache !== null && (now - _correctionsCacheTime) < CORRECTIONS_TTL) return _correctionsCache;
  try {
    const rows = db.prepare(`
      SELECT message_text, correct_picks, is_no_pick, notes
      FROM reader_corrections ORDER BY created_at DESC LIMIT 10
    `).all();
    if (!rows.length) { _correctionsCache = ''; _correctionsCacheTime = now; return ''; }
    const examples = rows.map(r => {
      const preview = r.message_text.replace(/\n/g, ' ').slice(0, 140);
      if (r.is_no_pick) {
        return `  Msg: "${preview}" → is_pick=false${r.notes ? ' [' + r.notes + ']' : ''}`;
      }
      const picks = JSON.parse(r.correct_picks || '[]');
      const pStr = picks.map(p => {
        let s = `team=${p.team}, pick_type=${p.pick_type}`;
        if (p.sport)                          s += `, sport=${p.sport}`;
        if (p.spread != null && p.spread !== '') s += `, spread=${p.spread}`;
        if (p.capper_name)                    s += `, capper=${p.capper_name}`;
        return s;
      }).join(' | ');
      return `  Msg: "${preview}" → ${pStr || 'is_pick=false'}${r.notes ? ' [' + r.notes + ']' : ''}`;
    }).join('\n');
    _correctionsCache = `LEARNED CORRECTIONS — override all rules above:\n${examples}`;
    _correctionsCacheTime = now;
    return _correctionsCache;
  } catch (_) { _correctionsCache = ''; _correctionsCacheTime = Date.now(); return ''; }
}

// ── Today's games context — injected per call, not cached in system prompt ────
let _gamesCache     = null;
let _gamesCacheTime = 0;
const GAMES_CACHE_TTL = 5 * 60 * 1000;

function getTodaysGamesContext() {
  const now = Date.now();
  if (_gamesCache !== null && (now - _gamesCacheTime) < GAMES_CACHE_TTL) return _gamesCache;
  try {
    const games = db.prepare(`
      SELECT espn_game_id, sport, home_short, away_short, home_abbr, away_abbr
      FROM today_games WHERE status != 'post'
      ORDER BY sport, start_time
    `).all();
    if (!games || games.length === 0) { _gamesCache = ''; _gamesCacheTime = now; return ''; }
    const bySport = {};
    for (const g of games) {
      (bySport[g.sport] = bySport[g.sport] || []).push(g);
    }
    const lines = ["Today's games — match picks to these when confident. Return espn_game_id + picked_side (home/away)."];
    for (const [sport, sg] of Object.entries(bySport)) {
      lines.push(`${sport}: ` + sg.map(g =>
        `${g.away_short}(${g.away_abbr}) @ ${g.home_short}(${g.home_abbr}) [id:${g.espn_game_id}]`
      ).join(', '));
    }
    _gamesCache     = lines.join('\n');
    _gamesCacheTime = now;
    return _gamesCache;
  } catch (err) {
    console.warn('[reader] games context error:', err.message);
    _gamesCache = ''; _gamesCacheTime = Date.now();
    return '';
  }
}

// ── Single extract — tries Mac first (unless mode=haiku), falls back to Haiku ─
async function claudeExtract(channelInstruction, messageContent) {
  const gamesContext = getTodaysGamesContext();
  const mode = getReaderMode();

  // 1. Try Mac (Ollama) if mode allows
  if (mode !== 'haiku') {
    const macResult = await tryMacReader('/extract', {
      instruction:  channelInstruction,
      message:      messageContent,
      gamesContext,
    });
    if (macResult) return macResult;
    if (mode === 'mac') return null; // mac-only, don't fall back
  }

  // 2. Haiku
  const t0 = Date.now();
  try {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      system: (() => {
        const blocks = [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral' } }];
        const corrections = getCorrectionsBlock();
        if (corrections) blocks.push({ type: 'text', text: corrections });
        return blocks;
      })(),
      tools:       [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_picks' },
      messages: [{
        role:    'user',
        content: [gamesContext, channelInstruction, `Message:\n${messageContent}`]
          .filter(Boolean).join('\n\n'),
      }],
    });
    if (response.usage) logUsage(response.usage, mode === 'haiku' ? 'haiku' : 'haiku-fallback');
    const toolUse = response.content.find(b => b.type === 'tool_use');
    const result = toolUse?.input ?? null;
    const picks = Array.isArray(result?.picks) ? result.picks.filter(p => p?.is_pick) : [];
    logCall(mode === 'haiku' ? 'haiku' : 'haiku-fallback', 1, picks.length, Date.now() - t0);
    return result;
  } catch (err) {
    logCall('haiku-error', 1, 0, Date.now() - t0, err.message.slice(0, 120));
    console.warn('[reader:claude] API error:', err.message);
    return null;
  }
}

// ── Batch extract — tries Mac first (unless mode=haiku), falls back to Haiku ──
async function claudeExtractBatch(channelInstruction, batchTexts) {
  const gamesContext = getTodaysGamesContext();
  const mode = getReaderMode();

  // 1. Try Mac (Ollama) if mode allows
  if (mode !== 'haiku') {
    const macResult = await tryMacReader('/extract-batch', {
      instruction:  channelInstruction,
      messages:     batchTexts,
      gamesContext,
    });
    if (macResult) return macResult;
    if (mode === 'mac') return null; // mac-only, don't fall back
  }

  // 2. Haiku
  const batchBody = batchTexts.map((text, i) => `=== Message ${i + 1} ===\n${text}`).join('\n\n');
  const t0 = Date.now();
  try {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 2048,
      system: (() => {
        const blocks = [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral' } }];
        const corrections = getCorrectionsBlock();
        if (corrections) blocks.push({ type: 'text', text: corrections });
        return blocks;
      })(),
      tools:       [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_picks' },
      messages: [{
        role:    'user',
        content: [gamesContext, channelInstruction, batchBody].filter(Boolean).join('\n\n'),
      }],
    });
    if (response.usage) logUsage(response.usage, mode === 'haiku' ? 'haiku' : 'haiku-fallback');
    const toolUse = response.content.find(b => b.type === 'tool_use');
    const result = toolUse?.input ?? null;
    const picks = Array.isArray(result?.picks) ? result.picks.filter(p => p?.is_pick) : [];
    logCall(mode === 'haiku' ? 'haiku' : 'haiku-fallback', batchTexts.length, picks.length, Date.now() - t0);
    return result;
  } catch (err) {
    logCall('haiku-error', batchTexts.length, 0, Date.now() - t0, err.message.slice(0, 120));
    console.warn('[reader:claude] batch error:', err.message);
    return null;
  }
}

// ── Channel-specific extractors ───────────────────────────────────────────────
async function extractFreePlaysPick(message) {
  const instruction = `Extract ALL picks from this message. Include capper_name if a handle is present, and sport_record if a win-loss record appears.`;
  const result = await claudeExtract(instruction, message);
  if (!result) return [];
  return Array.isArray(result.picks) ? result.picks : [];
}

async function extractPodThreadPick(message) {
  const instruction = [
    'Extract ALL picks from this message. Include capper_name if a handle is present.',
    'IMPORTANT: Ignore any line labeled "Last Play:", "Last pick:", or similar — those are previous picks.',
    'Extract ONLY the current pick (labeled "Today\'s Play:", "POD:", "POD [date]:", or a standalone team/line).',
  ].join(' ');
  const result = await claudeExtract(instruction, message);
  if (!result) return [];
  return Array.isArray(result.picks) ? result.picks : [];
}

async function extractCommunityLeaksPick(message) {
  const instruction = `Extract ALL picks from this message. This channel contains digest messages from multiple cappers — extract every pick from every capper block. Include capper_name for each pick (the capper header above the pick). Include sport_record if a win-loss record appears.`;
  const result = await claudeExtract(instruction, message);
  if (!result) return [];
  return Array.isArray(result.picks) ? result.picks : [];
}

// ── Route to the right extractor by channel ───────────────────────────────────
async function extractPicks(content, channelName) {
  if (channelName === 'free-plays')      return extractFreePlaysPick(content);
  if (channelName === 'community-leaks') return extractCommunityLeaksPick(content);
  if (channelName === 'pod-thread')      return extractPodThreadPick(content);
  console.warn(`[reader] Unknown channel: ${channelName}`);
  return [];
}

// ── Batch instruction by channel ──────────────────────────────────────────────
function getBatchInstruction(channelName) {
  const base = 'Extract ALL picks from each numbered message below. Each pick MUST include message_index (1-based integer — which message the pick came from).';
  if (channelName === 'free-plays') {
    return `${base} Include capper_name if a handle is present, and sport_record if a win-loss record appears.`;
  }
  if (channelName === 'community-leaks') {
    return `${base} This channel contains digest messages from multiple cappers — extract every pick from every capper block. Include capper_name for each pick (the capper header above the pick). Include sport_record if a win-loss record appears.`;
  }
  return [
    base,
    'IMPORTANT: Ignore any line labeled "Last Play:", "Last pick:", or similar — those are previous picks.',
    "Extract ONLY the current pick (labeled \"Today's Play:\", \"POD:\", or a standalone team/line).",
  ].join(' ');
}

// ── Sanity check: fix pick_type vs spread_value mismatches ───────────────────
function correctPickType(parsed) {
  if ((parsed.pick_type || '').toUpperCase() === 'NRFI') return parsed;
  const val = parseFloat(parsed.spread_value);
  if (isNaN(val)) return parsed;
  const abs  = Math.abs(val);
  const type = (parsed.pick_type || '').toLowerCase();
  if (type === 'ml' && abs < 100) {
    console.log(`[reader] Corrected ML→spread for ${parsed.team} (value ${val})`);
    return { ...parsed, pick_type: 'spread' };
  }
  if (type === 'spread' && abs >= 100) {
    console.log(`[reader] Corrected spread→ML for ${parsed.team} (value ${val})`);
    return { ...parsed, pick_type: 'ML', spread_value: null };
  }
  return parsed;
}

const BATCH_SIZE   = 1;
const MAX_MSG_CHARS = 1500;

// ── Batch entry point (scanner's main path) ───────────────────────────────────
async function readMessages(msgs) {
  if (!msgs || msgs.length === 0) return [];
  const results     = msgs.map(() => []);
  const channelName = msgs[0]?.channel || '';
  const instruction = getBatchInstruction(channelName);

  for (let start = 0; start < msgs.length; start += BATCH_SIZE) {
    const batch     = msgs.slice(start, start + BATCH_SIZE);
    const batchTexts = batch.map(m =>
      m.content.length > MAX_MSG_CHARS
        ? m.content.slice(0, MAX_MSG_CHARS) + '\n[truncated]'
        : m.content
    );

    const result = await claudeExtractBatch(instruction, batchTexts);
    if (!result?.picks) continue;

    for (const parsed of result.picks) {
      if (!parsed?.is_pick || !parsed.team) continue;
      const localIdx = (parsed.message_index ?? 1) - 1;
      if (localIdx < 0 || localIdx >= batch.length) continue;
      const globalIdx = start + localIdx;
      const corrected = correctPickType(parsed);
      const srcMsg    = msgs[globalIdx];
      results[globalIdx].push({
        team:         corrected.team,
        sport:        corrected.sport        || null,
        pick_type:    corrected.pick_type    || null,
        spread_value: corrected.spread_value ?? null,
        espn_game_id: corrected.espn_game_id || null,
        picked_side:  corrected.picked_side  || null,
        vs_player:    corrected.vs_player    || null,
        channel:      channelName,
        capper_name:  corrected.capper_name  || null,
        is_pick:      true,
        raw_message:  { id: srcMsg.id, content: srcMsg.content, author: srcMsg.author, createdAt: srcMsg.createdAt },
      });
    }
  }
  return results;
}

// ── Single-message entry point (admin rescan) ─────────────────────────────────
async function readMessage(msg) {
  const { content, channel, author, id, createdAt } = msg;
  if (!content || content.trim().length < 4) return [];

  const truncated = content.length > MAX_MSG_CHARS
    ? content.slice(0, MAX_MSG_CHARS) + '\n[truncated]'
    : content;

  const picks = await extractPicks(truncated, channel);
  const valid = [];

  for (let parsed of picks) {
    if (!parsed?.is_pick || !parsed.team) continue;
    parsed = correctPickType(parsed);
    valid.push({
      team:         parsed.team,
      sport:        parsed.sport        || null,
      pick_type:    parsed.pick_type    || null,
      spread_value: parsed.spread_value ?? null,
      espn_game_id: parsed.espn_game_id || null,
      picked_side:  parsed.picked_side  || null,
      vs_player:    parsed.vs_player    || null,
      channel,
      capper_name:  parsed.capper_name  || null,
      is_pick:      true,
      raw_message:  { id, content, author, createdAt },
    });
  }

  return valid;
}

module.exports = { readMessage, readMessages };
