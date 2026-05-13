// local_reader_api.js
// Runs on this Mac. Receives Discord message batches from Railway, processes
// them with local Ollama, and returns extracted picks.
//
// ── Setup ─────────────────────────────────────────────────────────────────────
//   1. Install model:  ollama pull qwen2.5:14b
//   2. Start server:   node local_reader_api.js  (or: pm2 start local_reader_api.js --name local-reader)
//   3. Expose tunnel:  cloudflared tunnel --url http://localhost:3002
//   4. Copy tunnel URL (e.g. https://abc123.trycloudflare.com) into Railway env:
//        LOCAL_READER_URL=https://abc123.trycloudflare.com
//        LOCAL_READER_SECRET=<same value as below>
//
// ── Env vars (set in .env or shell) ───────────────────────────────────────────
//   LOCAL_READER_SECRET   shared secret that Railway sends in x-reader-secret header
//   LOCAL_MODEL           ollama model name (default: qwen2.5:14b)
//   LOCAL_READER_PORT     port to listen on (default: 3002)
//   OLLAMA_BASE_URL       ollama base URL (default: http://localhost:11434)

require('dotenv').config({
  path: require('path').join(process.env.HOME || '/Users/jack', 'Projects/AgentOSO/.env'),
});

const express = require('express');
const axios   = require('axios');
const { RULES, EXTRACT_TOOL } = require('./src/reader_rules');

const app    = express();
app.use(express.json({ limit: '2mb' }));

const SECRET      = process.env.LOCAL_READER_SECRET || '';
const MODEL       = process.env.LOCAL_MODEL        || 'qwen2.5:7b';
const PORT        = parseInt(process.env.LOCAL_READER_PORT || '3002', 10);
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL    || 'http://localhost:11434';
const OLLAMA_URL  = `${OLLAMA_BASE}/v1/chat/completions`;

// Ollama tool schema uses "parameters" key (OpenAI-compatible), not "input_schema"
const OLLAMA_TOOL = {
  type: 'function',
  function: {
    name:        EXTRACT_TOOL.name,
    description: EXTRACT_TOOL.description,
    parameters:  EXTRACT_TOOL.input_schema,
  },
};

// ── Auth middleware ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (SECRET && req.headers['x-reader-secret'] !== SECRET) {
    console.warn('[local-reader] unauthorized request from', req.ip);
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, model: MODEL }));

// ── Core Ollama call ──────────────────────────────────────────────────────────
async function ollamaExtract(instruction, batchBody, gamesContext) {
  const userContent = [gamesContext, instruction, batchBody].filter(Boolean).join('\n\n');

  const response = await axios.post(OLLAMA_URL, {
    model:       MODEL,
    messages: [
      { role: 'system', content: RULES },
      { role: 'user',   content: userContent },
    ],
    tools:       [OLLAMA_TOOL],
    tool_choice: { type: 'function', function: { name: 'extract_picks' } },
    temperature: 0,
    stream:      false,
  }, { timeout: 90_000 }); // 90s — local model is slower than API

  const msg      = response.data?.choices?.[0]?.message;
  const toolCall = (msg?.tool_calls || []).find(tc => tc.function?.name === 'extract_picks');
  if (!toolCall) return null;

  const raw = toolCall.function?.arguments;
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ── POST /extract-batch ───────────────────────────────────────────────────────
// Body: { instruction: string, messages: string[], gamesContext?: string }
// Returns: { picks: [...] }  — same shape as EXTRACT_TOOL output
app.post('/extract-batch', async (req, res) => {
  const { instruction, messages, gamesContext } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.json({ picks: [] });
  }

  const batchBody = messages
    .map((text, i) => `=== Message ${i + 1} ===\n${text}`)
    .join('\n\n');

  try {
    const result = await ollamaExtract(instruction, batchBody, gamesContext || '');
    if (!result?.picks) return res.json({ picks: [] });
    console.log(`[local-reader] batch(${messages.length}) → ${result.picks.filter(p => p.is_pick).length} picks`);
    return res.json(result);
  } catch (err) {
    console.error('[local-reader] ollama error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /extract ─────────────────────────────────────────────────────────────
// Single-message path (used by admin rescan).
// Body: { instruction: string, message: string, gamesContext?: string }
app.post('/extract', async (req, res) => {
  const { instruction, message, gamesContext } = req.body;
  if (!message) return res.json({ picks: [] });

  try {
    const result = await ollamaExtract(instruction, `Message:\n${message}`, gamesContext || '');
    if (!result?.picks) return res.json({ picks: [] });
    console.log(`[local-reader] single → ${result.picks.filter(p => p.is_pick).length} picks`);
    return res.json(result);
  } catch (err) {
    console.error('[local-reader] ollama error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[local-reader] listening on :${PORT}  model=${MODEL}`);
  console.log(`[local-reader] expose with: cloudflared tunnel --url http://localhost:${PORT}`);
});
