// src/covers_contests.js
// Covers.com tracker (wave-1, track-only). Two sweeps, both server-rendered
// HTML with a deterministic parse (no AI); picks land in capper_history via
// source_ingest (source='covers', result='pending'):
//  1. King of Covers contest: top of the current-contest leaderboard ->
//     contestant GUID profile pages.
//  2. Consensus pick leaders: contests.covers.com/consensus/pickleaders ranks
//     every consensus member all-time by units (~133 pages x 50 rows) with
//     their W-L-P record inline. A row links contestant/pendingpicks/<user>/
//     ONLY while that member has pending picks, so the top pages double as a
//     live pending-picks index: crawl covers_leader_pages pages, fetch just
//     the flagged profiles.
// Both profile flavors render the same layout: <h2>SPORT</h2> sections, one
// cmg_contests_pendingpicks table per date ("Chi. Cubs <br/> Baltimore" teams,
// "BAL -110" pick, contest units) — parsePendingSections reads them all.
//
// Contest rules lock picks at game start, so a Pending pick on a started game
// was necessarily posted pregame; postedAt falls back to start-60s in that case.

const https = require('https');
const db = require('./db');
const { recordSourcePick, findGameByTeams, sideOf, gameStartMs } = require('./source_ingest');
const { ensureRegistered, normalizeCapper } = require('./storage');

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

// Covers section label -> our sport label. An unmapped label (CFL, UFC, ...)
// passes through as-is so the game match is still sport-constrained — a CFL
// "Ottawa vs Edmonton" must never fuzzy-hit the NHL pair.
const COVERS_SPORT = {
  MLB: 'MLB', NBA: 'NBA', WNBA: 'WNBA', NFL: 'NFL', NHL: 'NHL',
  NCAAF: 'NCAAF', CFB: 'NCAAF', NCAAB: 'CBB', CBB: 'CBB',
  SOCCER: 'Soccer', TENNIS: 'Tennis', ATP: 'ATP', WTA: 'WTA',
};

// Parse EVERY pending-picks table on a profile page. The page is sectioned
// <h2>SPORT</h2> then one cmg_contests_pendingpicks table per date (future
// dates included), so a first-table-only parse drops every sport after the
// first. Rows: <td>Away <br/> Home</td> ... <div data-market-id>PICK</div>
// ... <td><div>UNITS</div></td>.
function parsePendingSections(html) {
  const heads = [...html.matchAll(/<h2>\s*([^<]{2,24}?)\s*<\/h2>/g)]
    .map((m) => ({ at: m.index, label: m[1].trim() }));
  const sportAt = (idx) => {
    let label = null;
    for (const h of heads) { if (h.at < idx) label = h.label; else break; }
    return label ? (COVERS_SPORT[label.toUpperCase()] || label) : null;
  };
  const out = [];
  for (const tableM of html.matchAll(/cmg_contests_pendingpicks[\s\S]*?<\/table>/g)) {
    const sport = sportAt(tableM.index);
    for (const row of tableM[0].split('<tr>').slice(1)) {
      const teamsM = row.match(/<td>\s*([^<]{2,30}?)\s*<br\s*\/?>\s*([^<]{2,30}?)\s*<\/td>/);
      if (!teamsM) continue;
      // A row can carry SEVERAL picks on the same game (side + total), one
      // data-market-id div each; the next cell holds one units div per pick
      // in the same order.
      const cells = row.split(/<td>/).slice(1);
      const pickCellIdx = cells.findIndex((c) => c.includes('data-market-id'));
      if (pickCellIdx < 0) continue;
      const pickTexts = [...cells[pickCellIdx].matchAll(/data-market-id="[^"]*"\s*>\s*([^<]{2,40}?)\s*<\/div>/g)].map((m) => m[1]);
      const unitVals = pickCellIdx + 1 < cells.length
        ? [...cells[pickCellIdx + 1].matchAll(/<div>\s*([+-]?\d+(?:\.\d+)?)\s*<\/div>/g)].map((m) => parseFloat(m[1]))
        : [];
      pickTexts.forEach((pt, i) => {
        const parsed = parsePickText(pt);
        if (!parsed) return;
        out.push({ sport, away: teamsM[1], home: teamsM[2], parsed, units: unitVals[i] ?? unitVals[0] ?? null });
      });
    }
  }
  return out;
}

// Ingest every pending pick on one profile page (GUID contestant page or a
// leaders pendingpicks page — identical markup).
function ingestPendingPage(html, capperName, handle, extraMeta) {
  let ingested = 0, dupes = 0;
  for (const p of parsePendingSections(html)) {
    const game = findGameByTeams(p.away, p.home, p.sport);
    if (!game) continue;
    const side = p.parsed.picked ? sideOf(game, p.parsed.picked) : null;
    if (p.parsed.pickType !== 'over' && p.parsed.pickType !== 'under' && !side) continue;
    // Contest picks lock at start: a Pending pick on a started game was posted pregame.
    const startMs = gameStartMs(game);
    const now = Date.now();
    const postedAtMs = startMs && now >= startMs ? startMs - 60_000 : now;
    const out = recordSourcePick({
      source: 'covers',
      capperName,
      handle,
      game,
      pickType: p.parsed.pickType,
      side,
      line: p.parsed.line,
      odds: p.parsed.odds,
      postedAtMs,
      meta: { contest: 'kingofcovers', units: p.units, ...(extraMeta || {}) },
    });
    if (out === 'inserted') ingested++;
    else if (out === 'duplicate') dupes++;
  }
  return { ingested, dupes };
}

// ── Consensus pick leaders sweep ──────────────────────────────────────────────
const leadersUrl = (page) =>
  `${BASE}/consensus/pickleaders/all?orderPickBy=Overall&orderBy=Units&totalPicks=1&pageNum=${page}`;

function parseLeaderRows(html) {
  const rows = [];
  for (const tr of html.split(/<tr[ >]/).slice(1)) {
    const userM = tr.match(/contestant\/AllHistory\/([^/"]+)\//);
    if (!userM) continue;
    let username = userM[1];
    try { username = decodeURIComponent(username); } catch (_) {}
    username = username.trim();
    if (!username) continue;
    const unitsM = tr.match(/sortedCommunityLeadersColumnSelected[^>]*>\s*([+-]?[\d.]+)/);
    const recordM = tr.match(/table--overall[^>]*>\s*(\d+-\d+-\d+)/);
    rows.push({
      username,
      pending: tr.includes('contestant/pendingpicks/'),
      units: unitsM ? parseFloat(unitsM[1]) : null,
      record: recordM ? recordM[1] : null,
    });
  }
  return rows;
}

// Crawl the top covers_leader_pages leaders pages and fetch only members whose
// row carries the pendingpicks flag (skipNames = already swept this poll).
// Their site-side units/record snapshot lands in capper_source_handles
// meta_json — display only, never scored (we grade every pick ourselves).
const LEADER_PROFILE_CAP = 120; // per-poll safety valve on profile fetches
async function pollCoversLeaders(skipNames) {
  const pages = parseInt(db.getSetting('covers_leader_pages', '6'), 10);
  let ingested = 0, dupes = 0, errors = 0, flagged = 0, capped = false;
  for (let page = 1; page <= pages && !capped; page++) {
    const res = await get(leadersUrl(page));
    if (res.status !== 200) { errors++; await sleep(250); continue; }
    for (const r of parseLeaderRows(res.body)) {
      if (!r.pending || skipNames.has(normalizeCapper(r.username))) continue;
      if (flagged >= LEADER_PROFILE_CAP) {
        console.warn(`[covers] leaders: profile cap (${LEADER_PROFILE_CAP}) hit, rest skipped this poll`);
        capped = true;
        break;
      }
      flagged++;
      const prof = await get(`${BASE}/kingofcovers/contestant/pendingpicks/${encodeURIComponent(r.username)}/`);
      if (prof.status !== 200) { errors++; await sleep(300); continue; }
      const out = ingestPendingPage(prof.body, r.username, r.username, { via: 'leaders' });
      ingested += out.ingested;
      dupes += out.dupes;
      if (out.ingested && (r.units != null || r.record)) {
        try {
          db.prepare(`UPDATE capper_source_handles SET meta_json = ? WHERE source = 'covers' AND handle = ?`)
            .run(JSON.stringify({ units: r.units, record: r.record }), r.username);
        } catch (_) {}
      }
      await sleep(300);
    }
    await sleep(250);
  }
  return { ingested, dupes, errors, flagged };
}

// ── Poll: contest contestants + flagged consensus leaders (every 30 min) ──────
async function pollCoversPicks() {
  if (db.getSetting('covers_scrape_enabled', '1') !== '1') return { ingested: 0 };
  let list = [];
  try { list = JSON.parse(db.getSetting('covers_contestants', '[]')); } catch (_) {}

  let ingested = 0, dupes = 0, errors = 0;
  for (const c of list) {
    const res = await get(BASE + c.path);
    if (res.status !== 200) { errors++; await sleep(250); continue; }
    const out = ingestPendingPage(res.body, c.name, c.path.split('/').pop());
    ingested += out.ingested;
    dupes += out.dupes;
    await sleep(300);
  }

  // Leaders sweep skips anyone the contest sweep already covered — the same
  // member's picks would only dedup anyway.
  const swept = new Set(list.map((c) => normalizeCapper(c.name)));
  const lead = await pollCoversLeaders(swept);

  db.setSetting('covers_last_poll', new Date().toISOString());
  console.log(`[covers] poll: ${ingested} contest + ${lead.ingested} leader picks, ${dupes + lead.dupes} dupes, ${errors + lead.errors} errors (${list.length} contestants, ${lead.flagged} flagged leaders)`);
  return {
    ingested: ingested + lead.ingested,
    dupes: dupes + lead.dupes,
    errors: errors + lead.errors,
    flagged: lead.flagged,
  };
}

module.exports = { refreshCoversContestants, pollCoversPicks };

// CLI: node src/covers_contests.js
if (require.main === module) {
  (async () => {
    await refreshCoversContestants();
    await pollCoversPicks();
  })();
}
