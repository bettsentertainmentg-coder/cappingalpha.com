// src/covers_contests.js
// Covers.com contest tracker (wave-1, track-only). King of Covers leaderboard is
// server-rendered HTML: contestant profile links + a structured Pending Picks
// table per contestant ("Chi. Cubs <br/> Baltimore" teams, "BAL -110" pick,
// contest units, status). Deterministic parse, no AI. Picks land in
// capper_history via source_ingest (source='covers', result='pending').
//
// Contest rules lock picks at game start, so a Pending pick on a started game
// was necessarily posted pregame; postedAt falls back to start-60s in that case.

const https = require('https');
const db = require('./db');
const { recordSourcePick, findGameByTeams, sideOf, gameStartMs } = require('./source_ingest');
const { ensureRegistered } = require('./storage');

const BASE = 'https://contests.covers.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function get(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: HEADERS, timeout: 15000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; if (b.length > 2_000_000) res.destroy(); });
      res.on('end', () => finish({ status: res.statusCode, body: b }));
      // destroy() mid-stream never fires 'end' — 'close' is the safety net
      res.on('close', () => finish({ status: res.statusCode, body: b }));
    });
    req.on('error', () => finish({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); finish({ status: 0, body: '' }); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Contestant discovery (5am + 4pm): top of the KoC leaderboard ─────────────
async function refreshCoversContestants() {
  if (db.getSetting('covers_scrape_enabled', '1') !== '1') return 0;
  const res = await get(`${BASE}/kingofcovers`);
  if (res.status !== 200) { console.warn('[covers] leaderboard fetch failed:', res.status); return 0; }
  const seen = new Map();
  for (const m of res.body.matchAll(/href="(\/kingofcovers\/contestant\/[a-f0-9-]+)"[^>]*>([^<]{1,40})</g)) {
    const path = m[1];
    const name = m[2].trim();
    if (!name || seen.has(path)) continue;
    seen.set(path, name);
    if (seen.size >= parseInt(db.getSetting('covers_max_contestants', '50'), 10)) break;
  }
  const list = [...seen.entries()].map(([path, name]) => ({ path, name }));
  db.setSetting('covers_contestants', JSON.stringify(list));
  for (const c of list) ensureRegistered(c.name, 'covers', c.path.split('/').pop());
  console.log(`[covers] contestant refresh: tracking ${list.length}`);
  return list.length;
}

// Parse one pick cell like "BAL -110", "BAL -1.5 -105", "OVER 8.5 -110".
function parsePickText(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const m = t.match(/^(over|under|o|u|[A-Za-z.'\-\s]{2,20}?)\s+([+-]?\d+(?:\.\d+)?)(?:\s+([+-]\d{2,4}))?$/i);
  if (!m) return null;
  const rawSide = m[1].trim();
  const n1 = parseFloat(m[2]);
  const n2 = m[3] != null ? parseFloat(m[3]) : null;
  const sideWord = rawSide.toLowerCase();
  if (sideWord === 'over' || sideWord === 'o') return { pickType: 'over', picked: null, line: n1, odds: n2 };
  if (sideWord === 'under' || sideWord === 'u') return { pickType: 'under', picked: null, line: n1, odds: n2 };
  // Team pick: one number with |n| >= 100 is ML juice; a small number is a spread line.
  if (n2 == null) {
    if (Math.abs(n1) >= 100) return { pickType: 'ml', picked: rawSide, line: null, odds: n1 };
    return { pickType: 'spread', picked: rawSide, line: n1, odds: null };
  }
  return { pickType: 'spread', picked: rawSide, line: n1, odds: n2 };
}

// ── Poll tracked contestants' pending picks (every 30 min active hours) ───────
async function pollCoversPicks() {
  if (db.getSetting('covers_scrape_enabled', '1') !== '1') return { ingested: 0 };
  let list = [];
  try { list = JSON.parse(db.getSetting('covers_contestants', '[]')); } catch (_) {}
  if (!list.length) return { ingested: 0 };

  let ingested = 0, dupes = 0, errors = 0;
  for (const c of list) {
    const res = await get(BASE + c.path);
    if (res.status !== 200) { errors++; await sleep(250); continue; }

    // Pending Picks table rows: <td>Away <br/> Home</td> ... <td>...<div>PICK</div>...</td>
    const tableM = res.body.match(/cmg_contests_pendingpicks[\s\S]*?<\/table>/);
    if (!tableM) { await sleep(250); continue; }
    const rows = tableM[0].split('<tr>').slice(1);
    for (const row of rows) {
      const teamsM = row.match(/<td>\s*([^<]{2,30}?)\s*<br\s*\/?>\s*([^<]{2,30}?)\s*<\/td>/);
      const pickM  = row.match(/data-market-id="[^"]*"\s*>\s*([^<]{2,40}?)\s*<\/div>/);
      if (!teamsM || !pickM) continue;
      const parsed = parsePickText(pickM[1]);
      if (!parsed) continue;
      const game = findGameByTeams(teamsM[1], teamsM[2]);
      if (!game) continue;
      const side = parsed.picked ? sideOf(game, parsed.picked) : null;
      if (parsed.pickType !== 'over' && parsed.pickType !== 'under' && !side) continue;
      // Contest picks lock at start: a Pending pick on a started game was posted pregame.
      const startMs = gameStartMs(game);
      const now = Date.now();
      const postedAtMs = startMs && now >= startMs ? startMs - 60_000 : now;
      const out = recordSourcePick({
        source: 'covers',
        capperName: c.name,
        handle: c.path.split('/').pop(),
        game,
        pickType: parsed.pickType,
        side,
        line: parsed.line,
        odds: parsed.odds,
        postedAtMs,
        meta: { contest: 'kingofcovers' },
      });
      if (out === 'inserted') ingested++;
      else if (out === 'duplicate') dupes++;
    }
    await sleep(300);
  }
  db.setSetting('covers_last_poll', new Date().toISOString());
  console.log(`[covers] poll: ${ingested} new picks, ${dupes} dupes, ${errors} errors across ${list.length} contestants`);
  return { ingested, dupes, errors };
}

module.exports = { refreshCoversContestants, pollCoversPicks };

// CLI: node src/covers_contests.js
if (require.main === module) {
  (async () => {
    await refreshCoversContestants();
    await pollCoversPicks();
  })();
}
