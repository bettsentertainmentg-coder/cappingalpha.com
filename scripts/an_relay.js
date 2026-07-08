#!/usr/bin/env node
// Action Network discovery relay (Mac -> prod).
//
// WHY: AN's HTML pages sit behind a bot challenge for datacenter IPs, so
// discoverAnExperts() finds nothing on Railway (202 challenge page, no
// __NEXT_DATA__). The open users API IS reachable from Railway, so the server
// can poll picks fine — it just can't build the expert roster. This script runs
// discovery from the Mac (residential IP, works) and POSTs the roster to prod's
// header-auth import endpoint. Same relay pattern as Bovada / pb-relay.
//
// Usage: ADMIN_PASSWORD='...' node scripts/an_relay.js
//        (password also fetchable via `railway variables --kv`)
// Cron:  pm2 start scripts/an_relay.js --name an-relay --no-autorestart \
//          --cron-restart="10 5 * * *"        # daily, just after prod's 5:05am discovery slot
//
// Side effect: discovery also refreshes the LOCAL an_experts table (useful for
// local board testing). Roster churn is low; a daily push is plenty.

const https = require('https');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const BASE = process.env.CA_BASE_URL || 'https://cappingalpha.com';
const PW = process.env.ADMIN_PASSWORD;
if (!PW) {
  console.error('ADMIN_PASSWORD env var required (the Railway admin password).');
  process.exit(1);
}

(async () => {
  const db = require('../src/db');
  const { discoverAnExperts } = require('../src/an_experts');

  const upserted = await discoverAnExperts();
  const experts = db.prepare(`SELECT user_id, username, name, followers, is_internal FROM an_experts`).all();
  console.log(`[an_relay] local discovery: ${upserted} upserted, ${experts.length} in table`);
  if (!experts.length) {
    console.error('[an_relay] nothing to push — discovery found no experts from this machine either.');
    process.exit(1);
  }

  const body = JSON.stringify(experts);
  const u = new URL(`${BASE}/admin/api/an-experts-import`);
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-admin-password': PW,
      },
    }, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  console.log(`[an_relay] push -> ${res.status} ${res.body}`);
  process.exit(res.status === 200 ? 0 : 1);
})().catch((err) => { console.error('[an_relay] error:', err.message); process.exit(1); });
