#!/usr/bin/env node
// Pull the server's capper leaderboard + per-capper pick history to the Mac.
//
// The server is canonical for capper_history (local only has data through the
// last full DB copy). This logs into the admin panel, discovers every capper on
// the live leaderboard, and saves each one's row-level detail JSON for local
// analysis / calibration. Read-only: login + GETs, no admin actions.
//
// Usage: ADMIN_PASSWORD='...' node scripts/pull-capper-server.js
// Output: data/capper-server-pull/capper-server-<stamp>.json (+ latest.json)

const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = process.env.CA_BASE_URL || 'https://cappingalpha.com';
const PW = process.env.ADMIN_PASSWORD;
if (!PW) {
  console.error('ADMIN_PASSWORD env var required (the Railway admin password).');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, '..', 'data', 'capper-server-pull');
fs.mkdirSync(OUT_DIR, { recursive: true });

function request(method, url, { headers = {}, body = null, cookie = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. Login — capture the session cookie
  const form = 'password=' + encodeURIComponent(PW);
  const login = await request('POST', `${BASE}/admin/login`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    body: form,
  });
  const setCookie = login.headers['set-cookie'] || [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const loc = login.headers.location || '';
  if (!cookie || loc.includes('error')) {
    console.error('Login failed (wrong ADMIN_PASSWORD for the server?). Redirect:', loc || login.status);
    process.exit(1);
  }
  console.log('Logged in.');

  // 2. Dashboard — discover capper names from the leaderboard rows
  const dash = await request('GET', `${BASE}/admin/dashboard?tab=cappers`, { cookie });
  if (dash.status !== 200) {
    console.error('Dashboard fetch failed:', dash.status);
    process.exit(1);
  }
  const names = [...new Set([...dash.body.matchAll(/data-capper="([^"]+)"/g)].map((m) => m[1]))]
    .map((n) => n.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
  console.log(`Found ${names.length} cappers on the server leaderboard.`);

  // 3. Per-capper detail JSON (row-level pick history)
  const cappers = {};
  let done = 0;
  for (const name of names) {
    try {
      const res = await request('GET', `${BASE}/admin/api/capper-detail/${encodeURIComponent(name)}`, { cookie });
      cappers[name] = res.status === 200 ? JSON.parse(res.body) : { error: res.status };
    } catch (e) {
      cappers[name] = { error: e.message };
    }
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${names.length}...`);
    await sleep(150);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const payload = { pulled_at: new Date().toISOString(), base: BASE, capper_count: names.length, cappers };
  const outFile = path.join(OUT_DIR, `capper-server-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(payload));
  fs.writeFileSync(path.join(OUT_DIR, 'latest.json'), JSON.stringify(payload));
  fs.writeFileSync(path.join(OUT_DIR, 'dashboard-latest.html'), dash.body);

  const rowCount = Object.values(cappers).reduce((s, c) => s + (Array.isArray(c.picks) ? c.picks.length : 0), 0);
  console.log(`Saved ${names.length} cappers, ${rowCount} pick rows -> ${outFile}`);

  // 4. Board pick archive (public /api/pick-history, every pick that scored 35+).
  //    No offset pagination, so slice by sport x result (each slice capped at 500).
  const SPORTS = ['MLB', 'NBA', 'WNBA', 'NFL', 'NCAAF', 'CBB', 'NHL', 'Soccer', 'ATP', 'WTA'];
  const RESULTS = ['win', 'loss', 'push', 'pending'];
  const seenIds = new Set();
  const boardRows = [];
  for (const sport of [...SPORTS, null]) {
    for (const result of RESULTS) {
      const qs = new URLSearchParams({ limit: '500', result });
      if (sport) qs.set('sport', sport);
      try {
        const res = await request('GET', `${BASE}/api/pick-history?${qs}`);
        if (res.status !== 200) continue;
        for (const row of JSON.parse(res.body)) {
          if (seenIds.has(row.id)) continue;
          seenIds.add(row.id);
          boardRows.push(row);
        }
      } catch (_) {}
      await sleep(100);
    }
  }
  const boardPayload = { pulled_at: new Date().toISOString(), base: BASE, rows: boardRows };
  fs.writeFileSync(path.join(OUT_DIR, `pick-history-${stamp}.json`), JSON.stringify(boardPayload));
  fs.writeFileSync(path.join(OUT_DIR, 'pick-history-latest.json'), JSON.stringify(boardPayload));
  console.log(`Saved ${boardRows.length} board picks (35+ archive) -> pick-history-${stamp}.json`);
})();
