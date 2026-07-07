#!/usr/bin/env node
// ops/server.js
// Standalone desktop ops console server for CappingAlpha.
//
// COMPLETELY independent of the main site's code: no imports from src/ or
// index.js. It talks to the site the same way a browser would (admin login
// form + session cookie) and gathers local Mac data (pm2, host stats) itself.
//
// Security model: there is NO auth on this app. It binds to 127.0.0.1 only,
// so it is reachable only from this machine. Do not change the bind address
// without adding authentication.
//
// Env (loaded like scripts/pb_relay.js: AgentOSO .env first, local .env as
// non-overriding second):
//   OPS_PORT       — listen port (default 4300)
//   OPS_SITE_URL   — site base URL (default http://localhost:3001;
//                    on ship day this becomes https://cappingalpha.com)
//   ADMIN_PASSWORD — the site's admin panel password (used to log in)

'use strict';

require('dotenv').config({ path: require('path').join(process.env.HOME || '/Users/jack', 'Projects/AgentOSO/.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env'), override: false });

const express = require('express');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.OPS_PORT, 10) || 4300;
const SITE_URL = (process.env.OPS_SITE_URL || 'http://localhost:3001').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TIMEOUT_MS = 10000; // every upstream call gets a 10s ceiling

// ── Site session (browser-style admin login) ─────────────────────────────────
// The site's POST /admin/login expects a urlencoded form body (password=...)
// and answers with a 302: Location /admin on success (plus a session cookie),
// Location /admin/login?error=1 on a wrong password. We keep the cookie in
// memory and re-login whenever a request comes back as a redirect or 401.

let sessionCookie = null;   // e.g. "connect.sid=s%3A..."
let loginInFlight = null;   // dedupe concurrent logins

function extractCookies(res) {
  // Node 18.14+ has getSetCookie(); fall back to the single joined header.
  let raw = [];
  if (typeof res.headers.getSetCookie === 'function') {
    raw = res.headers.getSetCookie();
  } else {
    const one = res.headers.get('set-cookie');
    if (one) raw = [one];
  }
  const pairs = raw.map(c => String(c).split(';')[0].trim()).filter(Boolean);
  return pairs.length ? pairs.join('; ') : null;
}

async function loginOnce() {
  const res = await fetch(SITE_URL + '/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(ADMIN_PASSWORD),
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const location = res.headers.get('location') || '';
  if (location.includes('error')) {
    // Wrong password. Do not retry: it just burns the site's rate limit.
    const err = new Error('admin password rejected by site');
    err.permanent = true;
    throw err;
  }
  if (res.status === 429) throw new Error('site rate-limited the login (429)');
  const cookie = extractCookies(res);
  const redirectedToAdmin = res.status >= 300 && res.status < 400 && /\/admin\/?$/.test(location);
  if (!cookie || !redirectedToAdmin) {
    throw new Error(`unexpected login response (HTTP ${res.status}${location ? ', -> ' + location : ''})`);
  }
  sessionCookie = cookie;
}

async function login() {
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD not set in env');
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
      try {
        await loginOnce();
        return;
      } catch (err) {
        lastErr = err;
        if (err.permanent) break; // wrong password: retrying will not help
      }
    }
    throw lastErr || new Error('login failed');
  })();
  try {
    await loginInFlight;
  } finally {
    loginInFlight = null;
  }
}

// GET a JSON endpoint from the site with the session cookie. If the site
// answers with a redirect (its requireAuth redirects to /admin/login) or a
// 401/403, the session is stale: re-login once and retry.
async function siteGetJson(sitePath, isRetry = false) {
  if (!sessionCookie) await login();
  const res = await fetch(SITE_URL + sitePath, {
    headers: { Cookie: sessionCookie, Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const sessionStale = res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400);
  if (sessionStale) {
    if (isRetry) throw new Error(`still unauthorized after re-login (HTTP ${res.status})`);
    sessionCookie = null;
    await login();
    return siteGetJson(sitePath, true);
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('response was not JSON (HTTP 200)');
  }
}

// Wrap a section fetch so one bad section never sinks the whole summary.
async function section(sitePath) {
  try {
    return await siteGetJson(sitePath);
  } catch (err) {
    return { error: err && err.message ? err.message : 'unknown error' };
  }
}

// Cheap reachability probe: any HTTP answer from /admin/login means the site
// is up, even if the ops endpoints are not deployed yet.
async function probeSite() {
  try {
    const res = await fetch(SITE_URL + '/admin/login', {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { url: SITE_URL, reachable: true, http: res.status, loggedIn: !!sessionCookie };
  } catch (err) {
    return { url: SITE_URL, reachable: false, loggedIn: false, error: err && err.message ? err.message : 'unreachable' };
  }
}

// ── Local Mac data ────────────────────────────────────────────────────────────

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout));
    });
  });
}

async function getPm2() {
  try {
    const stdout = await execFileP('pm2', ['jlist']);
    // pm2 sometimes prints banner lines before the JSON; start at the first [
    const start = stdout.indexOf('[');
    if (start === -1) return { processes: [], note: 'pm2 jlist returned no JSON' };
    const list = JSON.parse(stdout.slice(start));
    const now = Date.now();
    const processes = (Array.isArray(list) ? list : []).map(p => {
      const env = p && p.pm2_env ? p.pm2_env : {};
      const online = env.status === 'online';
      return {
        name: p && p.name ? p.name : 'unknown',
        status: env.status || 'unknown',
        uptime_ms: online && env.pm_uptime ? Math.max(0, now - env.pm_uptime) : 0,
        restarts: Number.isFinite(env.restart_time) ? env.restart_time : 0,
        memory: p && p.monit && Number.isFinite(p.monit.memory) ? p.monit.memory : null,
      };
    });
    return { processes };
  } catch (err) {
    const missing = err && (err.code === 'ENOENT');
    return {
      processes: [],
      note: missing ? 'pm2 not found on this machine' : `pm2 jlist failed: ${err && err.message ? err.message : 'unknown error'}`,
    };
  }
}

async function getDisk() {
  try {
    const stdout = await execFileP('df', ['-k', '/']);
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) throw new Error('unexpected df output');
    // macOS: Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted-on
    const cols = lines[1].trim().split(/\s+/);
    const totalKb = parseInt(cols[1], 10);
    const availKb = parseInt(cols[3], 10);
    const usedPct = parseInt(String(cols[4]).replace('%', ''), 10);
    if (!Number.isFinite(totalKb) || !Number.isFinite(availKb)) throw new Error('could not parse df output');
    return {
      total_gb: Math.round((totalKb / 1048576) * 10) / 10,
      free_gb: Math.round((availKb / 1048576) * 10) / 10,
      used_pct: Number.isFinite(usedPct) ? usedPct : null,
    };
  } catch (err) {
    return { error: err && err.message ? err.message : 'df failed' };
  }
}

function getHostBasics() {
  const load = os.loadavg().map(n => Math.round(n * 100) / 100);
  return { hostname: os.hostname(), load, cpus: os.cpus().length };
}

// ── HTTP app ──────────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

app.get('/api/summary', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const [site, health, books, cappers, pm2, disk] = await Promise.all([
      probeSite(),
      section('/admin/api/health.json'),
      section('/admin/api/books.json'),
      section('/admin/api/capper-sources.json'),
      getPm2(),
      getDisk(),
    ]);
    res.json({
      generatedAt: new Date().toISOString(),
      site,
      health,
      books,
      cappers,
      pm2,
      host: { ...getHostBasics(), disk },
    });
  } catch (err) {
    // Should not happen (every branch above is caught), but never 500 the UI.
    res.json({
      generatedAt: new Date().toISOString(),
      site: { url: SITE_URL, reachable: false, error: 'summary build failed' },
      health: { error: err && err.message ? err.message : 'unknown' },
      books: { error: err && err.message ? err.message : 'unknown' },
      pm2: { processes: [], note: 'summary build failed' },
      host: { ...getHostBasics(), disk: { error: 'summary build failed' } },
    });
  }
});

// Localhost-only listener: this console has no auth of its own by design.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[ops] console up at http://127.0.0.1:${PORT} (site: ${SITE_URL})`);
});
