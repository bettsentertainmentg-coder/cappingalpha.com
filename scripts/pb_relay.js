#!/usr/bin/env node
// scripts/pb_relay.js
// Scrapes ActionNetwork public betting % from this Mac (residential IP —
// avoids Cloudflare blocks that hit Railway's datacenter IPs) and relays
// the raw data to Railway via HMAC-signed POST.
//
// Required env vars (in .env):
//   RELAY_SECRET   — shared secret, must match Railway's RELAY_SECRET
//                    Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   RAILWAY_URL    — e.g. https://cappingalpha.com
//
// PM2: added to ecosystem.config.js as 'pb-relay'. Starts automatically on
// Mac reboot once you've run: pm2 startup && pm2 save

'use strict';

// Load env same way as index.js: AgentOSO .env first, local .env as override
require('dotenv').config({ path: require('path').join(process.env.HOME || '/Users/jack', 'Projects/AgentOSO/.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env'), override: false });

const https   = require('https');
const http    = require('http');
const crypto  = require('crypto');
const { URL } = require('url');

const RELAY_SECRET     = process.env.RELAY_SECRET;
const RAILWAY_URL      = (process.env.RAILWAY_URL || '').replace(/\/$/, '');
const INGEST_PATH      = '/admin/ingest-public-betting';
const INGEST_TENNIS    = '/admin/ingest-tennis-lines';
const INTERVAL_MS      = 60 * 60 * 1000; // 1 hour
const BOVADA_TENNIS_URL =
  'https://www.bovada.lv/services/sports/event/coupon/events/A/description/tennis?marketFilterId=def&lang=en';

const SPORTS = ['NBA', 'MLB', 'NHL', 'NFL', 'NCAAF', 'CBB'];
const AN_SLUG = {
  NBA: 'nba', NFL: 'nfl', MLB: 'mlb',
  NHL: 'nhl', NCAAF: 'college-football', CBB: 'ncaab',
};

if (!RELAY_SECRET || !RAILWAY_URL) {
  console.error('[pb-relay] RELAY_SECRET and RAILWAY_URL must be set in .env — exiting');
  process.exit(1);
}

// ── Fetch HTML from ActionNetwork ─────────────────────────────────────────────
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://www.actionnetwork.com/',
      },
    }, res => {
      let html = '';
      res.on('data', chunk => { html += chunk; });
      res.on('end', () => resolve(html));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('fetch timeout')); });
  });
}

// ── POST HMAC-signed payload to Railway ──────────────────────────────────────
function postToRailway(payload, ingestPath = INGEST_PATH) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const sig  = crypto.createHmac('sha256', RELAY_SECRET).update(body).digest('hex');
    const url  = new URL(ingestPath, RAILWAY_URL);
    const lib  = url.protocol === 'https:' ? https : http;

    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':       'application/json',
        'Content-Length':     Buffer.byteLength(body),
        'X-Relay-Signature':  sig,
      },
    };

    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('post timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Sleep helper ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Bovada tennis lines (residential IP reaches Bovada; Railway is blocked) ────
// Parses to orientation-agnostic events; Railway matches players to today_games.
const _lastName = (n) => (n || '').trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g, '');
const _american = (o) => { const a = parseFloat(o?.price?.american); return Number.isFinite(a) ? a : null; };
const _handicap = (o) => { const h = parseFloat(o?.price?.handicap); return Number.isFinite(h) ? h : null; };

function parseBovadaEvent(ev) {
  const markets = {};
  for (const dg of ev.displayGroups || []) {
    if ((dg.description || '') !== 'Game Lines') continue;
    for (const m of dg.markets || []) {
      if ((m.period?.description || '') !== 'Match') continue;
      markets[m.description] = m.outcomes || [];
    }
  }
  const ml = markets['Moneyline'] || [];
  if (ml.length < 2) return null;
  const players = ml.map(o => ({ name: o.description, ml: _american(o), spread: null }));
  for (const o of markets['Game Spread'] || []) {
    const p = players.find(p => _lastName(p.name) === _lastName(o.description));
    if (p) p.spread = _handicap(o);
  }
  let over_under = null, ou_over_odds = null, ou_under_odds = null;
  for (const o of markets['Total'] || []) {
    const d = (o.description || '').toLowerCase();
    const line = _handicap(o);
    if (line != null && over_under == null) over_under = line;
    if (d.startsWith('over'))  ou_over_odds  = _american(o);
    if (d.startsWith('under')) ou_under_odds = _american(o);
  }
  const usable = players.some(p => p.spread != null || p.ml != null) || over_under != null;
  if (!usable) return null;
  return { players, over_under, ou_over_odds, ou_under_odds };
}

async function relayTennis() {
  let groups;
  try {
    const r = await fetch(BOVADA_TENNIS_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { console.warn(`[pb-relay] bovada tennis HTTP ${r.status}`); return; }
    groups = await r.json();
  } catch (err) {
    console.error('[pb-relay] bovada tennis fetch:', err.message);
    return;
  }
  if (!Array.isArray(groups)) return;

  const lines = [];
  for (const grp of groups) {
    for (const ev of grp.events || []) {
      const parsed = parseBovadaEvent(ev);
      if (parsed) lines.push(parsed);
    }
  }
  if (!lines.length) { console.log('[pb-relay] tennis: 0 parsed events'); return; }

  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(3000 * attempt);
    result = await postToRailway({ lines }, INGEST_TENNIS);
    if (result.status === 200) break;
  }
  if (result.status === 200) {
    const r = JSON.parse(result.body);
    console.log(`[pb-relay] tennis: ${lines.length} parsed → ${r.stored} stored on Railway`);
  } else {
    console.error(`[pb-relay] tennis: Railway returned ${result.status} — ${result.body.slice(0, 200)}`);
  }
}

// ── One full scrape + relay cycle ─────────────────────────────────────────────
async function run() {
  console.log(`[pb-relay] ${new Date().toISOString()} — scrape cycle start`);
  let totalStored = 0;

  for (const sport of SPORTS) {
    const slug = AN_SLUG[sport];
    if (!slug) continue;

    try {
      const html = await fetchHtml(`https://www.actionnetwork.com/${slug}/public-betting`);

      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{.+?\})<\/script>/s);
      if (!m) {
        console.warn(`[pb-relay] ${sport}: no __NEXT_DATA__ in response`);
        continue;
      }

      const nextData = JSON.parse(m[1]);
      const games    = nextData?.props?.pageProps?.scoreboardResponse?.games;

      if (!Array.isArray(games) || games.length === 0) {
        console.log(`[pb-relay] ${sport}: 0 games (off-season or no data)`);
        continue;
      }

      // Retry up to 2 times on non-200 (handles transient 502/413)
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(3000 * attempt);
        result = await postToRailway({ sport, games });
        if (result.status === 200) break;
      }

      if (result.status === 200) {
        const r = JSON.parse(result.body);
        console.log(`[pb-relay] ${sport}: ${games.length} scraped → ${r.stored} stored on Railway`);
        totalStored += r.stored || 0;
      } else {
        console.error(`[pb-relay] ${sport}: Railway returned ${result.status} after retries — ${result.body.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[pb-relay] ${sport}: ${err.message}`);
    }

    // Polite gap between sports — don't hammer ActionNetwork
    await sleep(2000);
  }

  console.log(`[pb-relay] cycle done — ${totalStored} total games stored`);

  // Bovada tennis lines — same residential-IP relay (Railway is geo-blocked by Bovada)
  await relayTennis();
}

// Run immediately on startup, then every hour
run().catch(err => console.error('[pb-relay] run error:', err.message));
setInterval(() => run().catch(err => console.error('[pb-relay] run error:', err.message)), INTERVAL_MS);
