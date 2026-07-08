// src/an_experts.js
// Action Network expert tracker (wave-1, track-only). Same zero-cost fetch
// pattern as public_betting.js: public pages + the open web/v1 user API, browser
// headers, no auth. Discovery finds every expert AN exposes; polling ingests
// their pending picks into capper_history via source_ingest (source =
// 'actionnetwork', result = 'pending', zero score influence in this phase).
//
// Cadence (index.js): discovery at 5am + startup; picks every 10 min active
// hours, 30 min overnight. Both settings-gated (an_scrape_enabled).

const https = require('https');
const db = require('./db');
const { recordSourcePick, findGameByAbbrs, findGameByTeams } = require('./source_ingest');
const { ensureRegistered } = require('./storage');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.actionnetwork.com/',
};

const DISCOVERY_PAGES = [
  'https://www.actionnetwork.com/picks',
  'https://www.actionnetwork.com/picks/top-experts',
  ...['nfl', 'mlb', 'nba', 'nhl', 'ncaaf', 'ncaab', 'wnba', 'soccer', 'tennis'].map(l => `https://www.actionnetwork.com/${l}/picks`),
];

function get(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: HEADERS, timeout: 15000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; if (b.length > 6_000_000) res.destroy(); });
      res.on('end', () => finish({ status: res.statusCode, body: b }));
      // destroy() mid-stream never fires 'end' — 'close' is the safety net
      res.on('close', () => finish({ status: res.statusCode, body: b }));
    });
    req.on('error', () => finish({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); finish({ status: 0, body: '' }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deep-scan a parsed JSON tree for expert profile objects. AN's page payloads
// nest them differently per page, so shape-matching beats path-hardcoding.
function collectProfiles(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collectProfiles(item, out, depth + 1);
    return;
  }
  const id = node.user_id ?? node.id;
  if (id && node.username && (node.is_internal_expert !== undefined || node.num_followers !== undefined || node.is_expert !== undefined)) {
    out.set(String(id), {
      user_id: String(id),
      username: String(node.username),
      name: node.name || node.display_name || String(node.username),
      followers: node.num_followers?.total ?? node.num_followers ?? null,
      is_internal: node.is_internal_expert ? 1 : 0,
    });
  }
  for (const k of Object.keys(node)) collectProfiles(node[k], out, depth + 1);
}

// ── Discovery: union expert profiles across all public pages ─────────────────
async function discoverAnExperts() {
  if (db.getSetting('an_scrape_enabled', '1') !== '1') return 0;
  const found = new Map();
  for (const url of DISCOVERY_PAGES) {
    const res = await get(url);
    if (res.status !== 200) { await sleep(200); continue; }
    const m = res.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      try { collectProfiles(JSON.parse(m[1]), found); } catch (_) {}
    }
    await sleep(250);
  }
  let upserts = 0;
  for (const e of found.values()) {
    try {
      db.prepare(`
        INSERT INTO an_experts (user_id, username, name, followers, is_internal, last_seen)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username, name = excluded.name,
          followers = excluded.followers, is_internal = excluded.is_internal,
          last_seen = datetime('now')
      `).run(e.user_id, e.username, e.name, e.followers, e.is_internal);
      ensureRegistered(e.name, 'actionnetwork', e.username);
      upserts++;
    } catch (_) {}
  }
  if (!found.size) {
    // AN's HTML pages sit behind a bot challenge for datacenter IPs (Railway gets
    // a 202 challenge page with no __NEXT_DATA__). The users API is open, so
    // polling works once the table is seeded from the Mac: node scripts/an_relay.js
    console.warn('[an_experts] discovery found 0 experts — pages likely bot-challenged from this host; seed via scripts/an_relay.js');
  }
  console.log(`[an_experts] discovery: ${found.size} experts found, ${upserts} upserted`);
  return upserts;
}

// ── Pick polling: ingest pending picks for today's games ─────────────────────
const TYPE_MAP = {
  ml_home:     ['ml', 'home'],   ml_away:     ['ml', 'away'],
  spread_home: ['spread', 'home'], spread_away: ['spread', 'away'],
  over: ['over', null], under: ['under', null],
  total_over: ['over', null], total_under: ['under', null],
};

async function pollAnExperts() {
  if (db.getSetting('an_scrape_enabled', '1') !== '1') return { ingested: 0 };
  const experts = db.prepare(`SELECT * FROM an_experts ORDER BY last_poll ASC NULLS FIRST`).all();
  if (!experts.length) {
    console.warn('[an_experts] poll skipped: an_experts table is empty (discovery blocked here? seed via scripts/an_relay.js)');
    return { ingested: 0 };
  }

  let ingested = 0, dupes = 0, props = 0, errors = 0;
  for (const ex of experts) {
    const res = await get(`https://api.actionnetwork.com/web/v1/users/${ex.user_id}`);
    if (res.status !== 200) { errors++; await sleep(200); continue; }
    let j;
    try { j = JSON.parse(res.body); } catch (_) { errors++; continue; }

    // Snapshot their AN-side record for the profile popup (display only, never scored)
    try {
      const record = { record: j.record ?? null, pick_stats: j.pick_stats ?? null, league_records: j.league_records ?? j.record?.league_records ?? null };
      db.prepare(`UPDATE an_experts SET record_json = ?, last_poll = datetime('now') WHERE user_id = ?`)
        .run(JSON.stringify(record), ex.user_id);
      db.prepare(`UPDATE capper_source_handles SET meta_json = ? WHERE source = 'actionnetwork' AND handle = ?`)
        .run(JSON.stringify(record), ex.username);
    } catch (_) {}

    for (const p of (j.picks || [])) {
      if (p.result && p.result !== 'pending') continue;
      const mapped = TYPE_MAP[(p.type || '').toLowerCase()];
      if (!mapped) continue; // draw/custom/unknown -> not slot-shaped
      const teams = p.game?.teams || [];
      const game = findGameByAbbrs(teams[0]?.abbr, teams[1]?.abbr)
                || findGameByTeams(teams[0]?.full_name || teams[0]?.display_name, teams[1]?.full_name || teams[1]?.display_name);
      if (!game) continue;
      const postedAtMs = p.created_at ? new Date(p.created_at).getTime() : Date.now();
      const out = recordSourcePick({
        source: 'actionnetwork',
        capperName: ex.name || ex.username,
        handle: ex.username,
        game,
        pickType: mapped[0],
        side: mapped[1],
        line: p.value ?? null,
        odds: p.odds ?? null,
        postedAtMs: p.is_live ? Number.MAX_SAFE_INTEGER : postedAtMs,
        meta: { an_pick_id: p.id, units: p.units ?? null, verified: !!p.verified, is_live: !!p.is_live },
      });
      if (out === 'inserted') ingested++;
      else if (out === 'duplicate') dupes++;
    }

    // Props/exotics: logged for the record + future props page, never scored.
    for (const cp of (j.custom_picks || [])) {
      try {
        const r = db.prepare(`
          INSERT OR IGNORE INTO an_expert_props (an_pick_id, username, play, odds, units, starts_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(String(cp.id ?? ''), ex.username, cp.play ?? null, cp.odds ?? null, cp.units ?? null, cp.starts_at ?? null);
        if (r.changes) props++;
      } catch (_) {}
    }
    await sleep(150);
  }
  db.setSetting('an_last_poll', new Date().toISOString());
  if (errors) db.setSetting('an_error_streak', String(parseInt(db.getSetting('an_error_streak', '0'), 10) + 1));
  else db.setSetting('an_error_streak', '0');
  console.log(`[an_experts] poll: ${ingested} new picks, ${dupes} dupes, ${props} props, ${errors} errors across ${experts.length} experts`);
  return { ingested, dupes, props, errors };
}

module.exports = { discoverAnExperts, pollAnExperts };

// CLI: node src/an_experts.js  (discover + one poll, for manual verification)
if (require.main === module) {
  (async () => {
    await discoverAnExperts();
    await pollAnExperts();
  })();
}
