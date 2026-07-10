// src/admin.js — Password-protected admin panel
const express = require('express');
const axios   = require('axios');
const db      = require('./db');
const scanner = require('./expert_data');
const { getCycleDate, cycleDateForInstant, addDays, ET_OFFSET_MS } = require('./cycle');
const { MVP_THRESHOLD } = require('./scoring');
const { reseedFromExisting } = require('./lines');
const { rescanSkipped }      = require('./expert_data');
const { storePublicBettingGames } = require('./public_betting');
const { storeTennisLines } = require('./bovada');
const { storeEngineBookLines, storeEngineEvents, OFFSHORE_BOOKS } = require('./odds_ingest');
const { recordHeartbeat, getHealthSnapshot, getBookReceptions } = require('./ops_health');
const { normalizeCapper } = require('./storage');
const dummyAccounts = require('./dummy_accounts');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const router = express.Router();

// Generates a random 7-8 character alphanumeric code (uppercase, no ambiguous chars)
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  const len   = Math.random() < 0.5 ? 7 : 8;
  let code = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) code += chars[bytes[i] % chars.length];
  return code;
}

const NUKE_TABLES = [
  'score_breakdown',
  'raw_messages',
  'picks',
  'scanner_state',
  'skipped_messages',
];

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.admin) return next();
  res.redirect('/admin/login');
}

// Constant-time password compare. Hash both sides to a fixed length first so
// timingSafeEqual never throws on length mismatch and no length is leaked.
function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

// Rate limit admin login: 10 attempts per IP per 15 min (user login has the same).
const _adminLoginAttempts = new Map();
function adminLoginRateLimit(req, res, next) {
  const ip  = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const WINDOW = 15 * 60 * 1000;
  const MAX = 10;
  const recent = (_adminLoginAttempts.get(ip) || []).filter(t => now - t < WINDOW);
  if (recent.length >= MAX) {
    return res.status(429).send('Too many attempts. Try again in 15 minutes.');
  }
  recent.push(now);
  _adminLoginAttempts.set(ip, recent);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of _adminLoginAttempts) {
    const keep = arr.filter(t => now - t < 15 * 60 * 1000);
    if (keep.length) _adminLoginAttempts.set(ip, keep); else _adminLoginAttempts.delete(ip);
  }
}, 60 * 60 * 1000).unref?.();

// ── Shared HTML shell ─────────────────────────────────────────────────────────
function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — CapperBoss Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e2e8f0; font-size: 14px; padding: 24px; }
    h1 { font-size: 22px; margin-bottom: 20px; }
    h2 { font-size: 16px; color: #8892a4; margin: 28px 0 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; background: #171b24; border: 1px solid #252c3b; border-radius: 8px; overflow: hidden; margin-bottom: 8px; }
    th { text-align: left; padding: 9px 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #8892a4; background: #1e2330; border-bottom: 1px solid #252c3b; }
    td { padding: 10px 12px; border-bottom: 1px solid #252c3b; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) td { background: #1a1f2e; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; }
    .mvp  { background: rgba(255,215,0,0.15); color: #FFD700; border: 1px solid rgba(255,215,0,0.3); }
    .match-ok  { background: rgba(34,197,94,0.15);  color: #4ade80; border: 1px solid rgba(34,197,94,0.3); }
    .match-new { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.3); }
    .raw-row td { background: #171b24 !important; font-size: 12px; color: #64748b; font-style: italic; word-break: break-word; }
    .btn { padding: 8px 18px; border-radius: 6px; border: none; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
    .btn-nuke { background: #ef4444; color: #fff; font-size: 16px; padding: 12px 32px; }
    .btn-nuke:hover { background: #dc2626; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .nuke-box { background: #1a0a0a; border: 1px solid #7f1d1d; border-radius: 10px; padding: 24px; margin-top: 32px; }
    .nuke-box p { margin-bottom: 16px; color: #fca5a5; }
    input[type=password], input[type=text], input[type=number], input[type=date], select { background: #1e2330; border: 1px solid #252c3b; color: #e2e8f0; padding: 10px 14px; border-radius: 6px; font-size: 14px; font-family: inherit; }
    .login-box { max-width: 360px; margin: 80px auto; background: #171b24; border: 1px solid #252c3b; border-radius: 10px; padding: 32px; }
    .login-box h1 { margin-bottom: 24px; }
    .form-row { margin-bottom: 16px; }
    label { display: block; margin-bottom: 6px; color: #8892a4; font-size: 13px; }
    .error { color: #ef4444; margin-bottom: 14px; font-size: 13px; }
    .empty { color: #8892a4; padding: 24px; text-align: center; }
    /* ── Tab bar ── */
    .atabs { display:flex; gap:2px; margin-bottom:28px; background:#171b24; border:1px solid #252c3b; border-radius:10px; padding:4px; flex-wrap:wrap; align-items:center; }
    .atab { background:none; border:none; color:#8892a4; font-family:inherit; font-size:13px; font-weight:600; padding:9px 20px; border-radius:8px; cursor:pointer; transition:background .12s,color .12s; white-space:nowrap; }
    .atab:hover { background:#252c3b; color:#e2e8f0; }
    .atab.active { background:#252c3b; color:#e2e8f0; }
    .atab.gold { color:#a08020; }
    .atab.gold.active { background:rgba(255,215,0,0.12); color:#FFD700; }
    .atab-logout { margin-left:auto; color:#64748b; font-size:12px; text-decoration:none; padding:8px 12px; border-radius:6px; }
    .atab-logout:hover { color:#e2e8f0; background:#1e2330; text-decoration:none; }
    .apanel { display:none; }
    .apanel.active { display:block; }
    /* ── Users ── */
    .users-search-bar { display:flex; gap:10px; margin-bottom:20px; }
    .users-search-bar input { flex:1; max-width:380px; }
    .users-results-note { color:#8892a4; font-size:13px; margin-bottom:12px; }
    .btn-sm { padding:4px 10px; font-size:12px; border-radius:5px; border:none; font-family:inherit; font-weight:600; cursor:pointer; }
    .btn-grant { background:#1d4ed8; color:#fff; }
    .btn-revoke { background:#7f1d1d; color:#fca5a5; }
    /* ── Code gen ── */
    .code-gen-card { background:#171b24; border:1px solid #252c3b; border-radius:10px; padding:22px; max-width:480px; margin-bottom:28px; }
    .code-gen-card h3 { font-size:15px; font-weight:700; margin-bottom:16px; color:#e2e8f0; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

// ── GET /admin/login ──────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  res.send(page('Login', `
    <div class="login-box">
      <h1>Admin Login</h1>
      ${req.query.error ? '<p class="error">Incorrect password.</p>' : ''}
      <form method="POST" action="/admin/login">
        <div class="form-row">
          <label>Password</label>
          <input type="password" name="password" autofocus />
        </div>
        <button class="btn btn-primary" type="submit">Log in</button>
      </form>
    </div>`));
});

// ── POST /admin/login ─────────────────────────────────────────────────────────
router.post('/login', adminLoginRateLimit, express.urlencoded({ extended: false }), (req, res) => {
  const correct = process.env.ADMIN_PASSWORD;
  if (!correct) return res.status(500).send('ADMIN_PASSWORD not set in env.');
  if (req.body.password && safeEqual(req.body.password, correct)) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

// ── GET /admin/logout ─────────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ── GET /admin/preview — live phone-UI mirror ─────────────────────────────────
// Renders the actual public site inside a phone-sized iframe. Because the iframe
// reports a real phone-width viewport to the inner document, every mobile media
// query fires exactly as it does on a phone — this is a 1:1 mirror of the live UI
// with zero upkeep (no hand-maintained mockup to drift out of sync).
// ── GET /admin/playbook — the owner's playbook, served fresh from docs/ ───────
// Embedded as the last dashboard tab (iframe). Reading from disk on each request
// means the tab always shows the latest committed playbook, no restart needed.
router.get('/playbook', requireAuth, (_req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ALGO_PLAYBOOK.html'), 'utf8');
    res.type('html').send('<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body>' + html + '</body></html>');
  } catch (err) {
    res.status(500).type('html').send('<p style="font-family:sans-serif;padding:24px;">Could not read docs/ALGO_PLAYBOOK.html: ' + escHtml(String(err.message || err)) + '</p>');
  }
});

router.get('/preview', requireAuth, (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Phone UI Preview — CapperBoss</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0b0d12;color:#e2e8f0;min-height:100vh;padding:22px;}
  .pv-bar{display:flex;align-items:center;gap:14px;margin-bottom:8px;flex-wrap:wrap;}
  .pv-title{font-weight:800;font-size:18px;}
  .pv-title b{color:#3b82f6;}
  .pv-note{font-size:12px;color:#8892a4;max-width:420px;}
  .pv-sizes{display:flex;gap:6px;}
  .pv-size{font-size:12px;font-weight:700;color:#8892a4;background:#171b24;border:1px solid #252c3b;border-radius:6px;padding:6px 11px;cursor:pointer;font-family:inherit;}
  .pv-size.active{color:#fff;background:#3b82f6;border-color:#3b82f6;}
  .pv-reload{font-size:12px;font-weight:700;color:#8892a4;background:#171b24;border:1px solid #252c3b;border-radius:6px;padding:6px 11px;cursor:pointer;font-family:inherit;}
  .pv-reload:hover{color:#e2e8f0;border-color:#3b82f6;}
  .pv-back{margin-left:auto;font-size:13px;color:#8892a4;text-decoration:none;border:1px solid #252c3b;padding:7px 14px;border-radius:7px;}
  .pv-back:hover{color:#e2e8f0;border-color:#3b82f6;}
  .pv-stage{display:flex;justify-content:center;padding:24px 0 60px;}
  .phone{position:relative;width:390px;height:844px;background:#000;border-radius:46px;padding:13px;box-shadow:0 0 0 2px #2a2f3a,0 30px 80px rgba(0,0,0,.6);transition:width .15s,height .15s;}
  .phone-notch{position:absolute;top:13px;left:50%;transform:translateX(-50%);width:150px;height:26px;background:#000;border-radius:0 0 16px 16px;z-index:2;}
  .phone-screen{width:100%;height:100%;border-radius:34px;overflow:hidden;background:#0f1117;}
  .phone-screen iframe{width:100%;height:100%;border:0;display:block;}
  .pv-dim{font-size:11px;color:#5b647a;text-align:center;margin-top:10px;}
</style></head>
<body>
  <div class="pv-bar">
    <div class="pv-title">Capping<b>Alpha</b> &middot; Phone Preview</div>
    <span class="pv-note">Live site, real data &mdash; a 1:1 mirror of the phone UI. Hit Reload after you change anything.</span>
    <div class="pv-sizes" id="pv-sizes"></div>
    <button class="pv-reload" onclick="document.getElementById('pv-frame').contentWindow.location.reload()">&#8635; Reload</button>
    <a class="pv-back" href="/admin/dashboard">&larr; Admin</a>
  </div>
  <div class="pv-stage">
    <div class="phone" id="phone">
      <div class="phone-notch"></div>
      <div class="phone-screen"><iframe id="pv-frame" src="/" title="Phone preview"></iframe></div>
    </div>
  </div>
  <div class="pv-dim" id="pv-dim"></div>
  <script>
    var SIZES=[{label:'iPhone 14',w:390,h:844},{label:'iPhone SE',w:375,h:667},{label:'Pixel 7',w:412,h:915},{label:'iPhone 15 Pro Max',w:430,h:932}];
    var phone=document.getElementById('phone'),bar=document.getElementById('pv-sizes'),dim=document.getElementById('pv-dim');
    function setSize(i){var s=SIZES[i];phone.style.width=s.w+'px';phone.style.height=s.h+'px';dim.textContent=s.label+' \\u2014 '+s.w+' \\u00d7 '+s.h;Array.prototype.forEach.call(bar.children,function(b,j){b.classList.toggle('active',j===i);});}
    SIZES.forEach(function(s,i){var b=document.createElement('button');b.className='pv-size';b.textContent=s.label;b.onclick=function(){setSize(i);};bar.appendChild(b);});
    setSize(0);
  </script>
</body></html>`);
});

// ── GET /admin → dashboard ────────────────────────────────────────────────────
router.get('/', requireAuth, (_req, res) => res.redirect('/admin/dashboard'));

// ── GET /admin/dashboard — unified 4-tab dashboard ───────────────────────────
router.get('/dashboard', requireAuth, (req, res) => {
  const activeTab = req.query.tab || 'picks';
  const today = getCycleDate();
  const v3Now = db.getSetting('scoring_version', 'v2') === 'v3';
  const MVP_LINE = v3Now ? 100 : MVP_THRESHOLD; // gold line on the active scale
  const mvpDisplayThreshold = v3Now ? 100 : parseInt(db.getSetting('mvp_display_threshold', 50), 10);
  const betUnit = parseFloat(db.getSetting('bet_unit', 10)) || 10;

  // ── Picks panel ─────────────────────────────────────────────────────────────
  // Membership must be a SUPERSET of the public board or the counts diverge
  // (an overnight pick can carry yesterday's game_date stamp while its game
  // plays today — the public board is game-anchored and shows it; a strict
  // game_date filter here hid it). Board day rolls at the ~5am wipe, same as
  // /api/picks. No p.score > 0 filter: wave-1 picks can carry v2 score 0.
  const nowET = new Date(Date.now() - ET_OFFSET_MS);
  let boardDate = nowET.toISOString().slice(0, 10);
  if (nowET.getUTCHours() < 5) boardDate = addDays(boardDate, -1);
  const picks = db.prepare(`
    SELECT p.*,
           sb.channel_points, sb.sport_bonus, sb.home_bonus, sb.total AS sb_total,
           sb.breakdown_json, sb.v3_total, sb.v3_json,
           COALESCE(tg1.home_team, tg2.home_team) AS home_team,
           COALESCE(tg1.away_team, tg2.away_team) AS away_team,
           COALESCE(tg1.start_time, tg2.start_time) AS start_time
    FROM picks p
    LEFT JOIN score_breakdown sb ON sb.pick_id = p.id
    LEFT JOIN today_games tg1 ON tg1.espn_game_id = p.espn_game_id
    LEFT JOIN today_games tg2 ON (LOWER(tg2.home_team) = LOWER(p.team) OR LOWER(tg2.away_team) = LOWER(p.team))
    WHERE p.mention_count > 0
    GROUP BY p.id
    ORDER BY ${v3Now ? 'sb.v3_total DESC, p.score DESC' : 'p.score DESC'}
  `).all().filter(p =>
    // public-board rule (game-anchored) OR stamped-today orphans (admin-only visibility)
    (p.start_time && cycleDateForInstant(p.start_time) === boardDate) || p.game_date === today
  );

  const dummyAccountsList = (() => { try { return dummyAccounts.listDummyAccounts(); } catch (_) { return []; } })();

  const rawMessages = db.prepare(`SELECT * FROM raw_messages ORDER BY pick_id, saved_at`).all();
  const rawByPick = {};
  for (const rm of rawMessages) {
    if (!rawByPick[rm.pick_id]) rawByPick[rm.pick_id] = [];
    rawByPick[rm.pick_id].push(rm);
  }

  // Build a normalized lookup of every known capper (canonical + alias).
  // A pick whose capper_name normalizes to a hit = "matched"; miss = "new".
  // Lets admins spot fresh cappers that should be aliased to an existing one.
  let knownCapperSet;
  try {
    const aliasRows = db.prepare(`SELECT canonical_name, alias FROM capper_aliases`).all();
    knownCapperSet = new Set();
    for (const r of aliasRows) {
      if (r.canonical_name) knownCapperSet.add(normalizeCapper(r.canonical_name));
      if (r.alias)          knownCapperSet.add(normalizeCapper(r.alias));
    }
    // Also include canonical names already attached to historical picks — they're
    // de-facto "known" cappers even without an explicit alias row.
    const histNames = db.prepare(`SELECT DISTINCT capper_name FROM capper_history WHERE capper_name IS NOT NULL`).all();
    for (const r of histNames) knownCapperSet.add(normalizeCapper(r.capper_name));
  } catch (_) {
    knownCapperSet = new Set();
  }

  // Clickable capper name → opens the shared capper-detail popup (a page-level
  // overlay that works from any tab). Source entities (@src:...) have no profile
  // page, so they render as plain muted text. extraHtml is appended inside the link.
  const capperLink = (name, extraHtml = '', style = '') => {
    const nm = String(name == null ? '' : name);
    const body = `${escHtml(nm)}${extraHtml}`;
    if (!nm || nm.startsWith('@src:')) return `<span style="color:#8892a4;${style}">${body}</span>`;
    // Name travels via a data attribute (never inlined into the onclick JS) so
    // quotes/backslashes in scraped handles can't break out of the handler.
    return `<span data-capper="${escHtml(nm)}" onclick="event.stopPropagation();showCapperDetail(this.getAttribute('data-capper'))" style="color:#93c5fd;cursor:pointer;${style}">${body}</span>`;
  };

  const pickRowsHtml = picks.map((p, i) => {
    // v3 (live): show the real WEIGHTED score + tiers. Admin is internal, so it
    // sees the true v3 total (not the public leak-aware display). v2: raw score.
    let bd = null;
    try { bd = p.v3_json ? JSON.parse(p.v3_json) : null; } catch (_) {}
    const v3score = p.v3_total != null ? Math.round(p.v3_total) : null;
    const shownScore = v3Now ? (v3score != null ? v3score : (p.score ?? '—')) : (p.score ?? '—');
    // Reconcile with the public board: while the leak ramp runs, members see a
    // lower climbing number. Show it next to the true score so admin and the
    // live site never LOOK out of sync (they converge when the ramp finishes).
    let publicNote = '';
    if (v3Now && p.leak_target != null) {
      try {
        const disp = require('./scoring_v3').effectiveDisplayScore(p);
        if (disp !== (v3score ?? disp)) {
          publicNote = `<div style="font-size:10px;font-weight:600;color:#f59e0b;" title="The conviction curve is still climbing on the public board. Members currently see this lower number; it reaches the true score before game start.">public ${disp}↗</div>`;
        }
      } catch (_) {}
    }
    const isGold   = v3Now ? (v3score != null && v3score >= 100) : ((p.score || 0) >= MVP_LINE);
    const isSilver = v3Now && v3score != null && v3score >= 75 && v3score < 100;
    const tierBadge = isGold
      ? '<span class="badge mvp">GOLD</span>'
      : isSilver ? '<span class="badge" style="background:#3a3f4b;color:#c0c0c0;">silver</span>' : '';

    const raws  = rawByPick[p.id] || [];
    const matchBadge = p.capper_name
      ? (knownCapperSet.has(normalizeCapper(p.capper_name))
          ? '<span class="badge match-ok">matched</span>'
          : '<span class="badge match-new">new</span>')
      : '<span style="color:#3b4560;font-size:11px;">—</span>';

    // Per-capper v3 contribution: the advocate carries the resume points, every
    // other named capper carries its applied consensus join points.
    const contrib = {};
    if (bd) {
      if (bd.advocate && !String(bd.advocate).startsWith('@src:')) {
        contrib[bd.advocate] = (contrib[bd.advocate] || 0) + (bd.resume || 0);
      }
      for (const j of (bd.joiners || [])) contrib[j.name] = (contrib[j.name] || 0) + (j.applied || 0);
    }

    // Drill-down: the full v3 aggregation (every component + who added what),
    // then each raw mention with its capper, points, and arrival time.
    const v3Panel = (v3Now && bd) ? (() => {
      const row = (label, pts, extra = '') => (pts != null)
        ? `<tr><td style="padding:2px 10px 2px 0;color:#b7c0d0;">${label}${extra ? ` <span style="color:#6b7488;">${extra}</span>` : ''}</td><td style="text-align:right;font-weight:600;color:#e5e9f0;">+${pts}</td></tr>`
        : '';
      const joinRows = (bd.joiners || []).filter(j => (j.applied || 0) > 0)
        .map(j => `<tr><td style="padding:1px 10px 1px 18px;color:#8892a4;">↳ ${capperLink(j.name)} <span style="color:#6b7488;">(solo worth +${j.pts})</span></td><td style="text-align:right;color:#b7c0d0;">+${j.applied}</td></tr>`).join('');
      const mkt = bd.market || {};
      const mktExtra = [mkt.edge_pts ? `edge +${mkt.edge_pts}` : '', mkt.steam_pts ? `steam +${mkt.steam_pts}` : '', mkt.contrarian_pts ? `contrarian +${mkt.contrarian_pts}` : ''].filter(Boolean).join(' · ');
      const fadeFrom = (bd.fade_in && bd.fade_in.from || []).map(f => `${capperLink(f.capper)} +${f.pts}`).join(', ');
      return `
      <div style="padding:8px 12px;background:#12151d;border-radius:6px;margin-bottom:8px;">
        <div style="font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">v3 score aggregation → <b style="color:${isGold ? '#FFD700' : isSilver ? '#c0c0c0' : '#e5e9f0'};">${v3score}</b> ${isGold ? 'GOLD' : isSilver ? 'silver' : ''}</div>
        <table style="width:auto;margin:0;border:none;font-size:12px;">
          ${(bd.base || 0) > 0 ? row('Base (legacy)', bd.base) : ''}
          ${row('Best backer', bd.resume, bd.advocate
            ? `· ${capperLink(bd.advocate)}${bd.advocate_band ? ` <span style="color:#6b7488;">[${escHtml(String(bd.advocate_band))}${bd.advocate_rank ? ` · #${bd.advocate_rank}` : ''}]</span>` : ''}`
            : '· untracked capper (flat)')}
          ${row('Backer stack', bd.consensus)}
          ${joinRows}
          ${(bd.sport_pct && bd.sport_pct.pts) ? row('Sport rank bonus', bd.sport_pct.pts, bd.sport_pct.rank ? `· #${bd.sport_pct.rank} in sport` : '') : ''}
          ${row('Market signals', (bd.market && bd.market.pts) || 0, mktExtra)}
          ${row('Side lean', (bd.lean && bd.lean.pts) || 0, bd.lean && bd.lean.side ? `· ${escHtml(bd.lean.side)}` : '')}
          ${row('Sport bonus', bd.sport_bonus)}
          ${row('Fade points', (bd.fade_in && bd.fade_in.pts) || 0, fadeFrom)}
          ${(bd.conflict_offset || 0) > 0 ? row('Conflict offset', bd.conflict_offset) : ''}
          <tr><td style="padding-top:5px;border-top:1px solid #2a2f3b;color:#e5e9f0;font-weight:700;">Total</td><td style="padding-top:5px;border-top:1px solid #2a2f3b;text-align:right;font-weight:700;color:${isGold ? '#FFD700' : '#e5e9f0'};">${v3score}</td></tr>
        </table>
      </div>`;
    })() : '';

    const _capSeen = new Set();
    const mentionRows = raws.map(rm => {
      // Per-message attribution ONLY — never fall back to the pick's primary capper,
      // which made every mention look like the same capper when the reader failed to
      // catch a distinct leaked capper on that message. Unattributed = reader miss.
      const cap = rm.capper_name;
      // A capper's points apply ONCE no matter how many messages they posted; show
      // the pts chip on their first message only and mark later ones as repeats,
      // so two mentions never read as double-counted.
      const isRepeat = cap && _capSeen.has(cap);
      if (cap) _capSeen.add(cap);
      const pts = cap && contrib[cap] != null
        ? (isRepeat
            ? `<span style="color:#6b7488;font-size:11px;" title="Same capper posted this pick more than once. Their points counted once, on the first message.">repeat · counted once</span> · `
            : `<span style="color:#a08020;font-weight:600;">+${contrib[cap]} pts</span> · `)
        : '';
      const who = cap
        ? `${capperLink(cap, '', 'font-weight:700;')} · `
        : `<span style="color:#8892a4;font-style:italic;" title="The reader did not attribute a capper to this message">unattributed</span> · `;
      return `<tr class="raw-row"><td colspan="9">
        ${who}${pts}<strong>${escHtml(rm.channel || '')}</strong>
        ${rm.author ? `· <em>${escHtml(rm.author)}</em>` : ''}
        ${rm.message_timestamp ? `· <span style="color:#8892a4;">${rm.message_timestamp.slice(0, 16)}</span>` : ''}
        <br><span style="color:#c8cfdb;">${escHtml(rm.message_text || '')}</span>
      </td></tr>`;
    }).join('');

    // Every capper who added points to this pick, deduped to one clickable chip
    // each — points contributed (consensus/resume, plus any fade points routed in
    // from a fade-active capper on the opposite slot) and, for Discord mentions,
    // when they came in. Source entities (@src:...) render as plain text.
    const involvedHtml = (() => {
      if (!v3Now || !bd) return '';
      const whenFor = (name) => {
        const rm = raws.find(r => (r.capper_name || p.capper_name) === name && r.message_timestamp);
        return rm ? rm.message_timestamp.slice(0, 16) : null;
      };
      const inv = new Map();
      const bump = (name, key, pts) => {
        if (!name) return;
        if (!inv.has(name)) inv.set(name, { pts: 0, fade: 0, when: whenFor(name) });
        inv.get(name)[key] += (pts || 0);
      };
      for (const [name, pts] of Object.entries(contrib)) bump(name, 'pts', pts);
      for (const f of (bd.fade_in && bd.fade_in.from || [])) bump(f.capper, 'fade', f.pts);
      if (!inv.size) return '';
      const chips = [...inv.entries()]
        .sort((a, b) => (b[1].pts + b[1].fade) - (a[1].pts + a[1].fade))
        .map(([name, info]) => {
          const parts = [];
          if (info.pts)  parts.push(`+${info.pts}`);
          if (info.fade) parts.push(`+${info.fade} fade`);
          const ptsHtml  = parts.length ? ` <span style="color:#a08020;font-weight:600;">${parts.join(' · ')} pts</span>` : '';
          const whenHtml = info.when ? ` <span style="color:#6b7488;">@ ${info.when}</span>` : '';
          return capperLink(name, `${ptsHtml}${whenHtml}`,
            'display:inline-block;background:#1a1f2b;border:1px solid #2a3040;border-radius:12px;padding:2px 9px;font-size:12px;');
        }).join(' ');
      return `<div style="margin-bottom:8px;">
        <div style="font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px;">Cappers involved</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${chips}</div>
      </div>`;
    })();

    // Two columns: the v3 score aggregation on the left (narrow), the capper info
    // (involved cappers + raw mentions) fills the space to the right of it.
    const capperCol = `
      ${involvedHtml}
      ${raws.length ? `<table style="margin:0;border:none;border-radius:0;width:100%;"><tbody>${mentionRows}</tbody></table>` : ''}`;
    const rawRowsHtml = (v3Panel || raws.length)
      ? `<tr class="raw-row" id="msgs-${p.id}" style="display:none;"><td colspan="9" style="padding:8px 10px;">
          <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">
            ${v3Panel ? `<div style="flex:0 0 auto;">${v3Panel}</div>` : ''}
            <div style="flex:1 1 320px;min-width:280px;">${capperCol}</div>
          </div>
        </td></tr>`
      : '';
    const msgBtn = (v3Panel || raws.length)
      ? `<button onclick="toggleMsgs(${p.id},this)" style="background:#252c3b;border:1px solid #3b4560;color:#8892a4;border-radius:4px;padding:2px 7px;font-size:11px;cursor:pointer;">details ▾</button>`
      : '<span style="color:#3b4560;font-size:11px;">—</span>';

    // Breakdown cell: v3 component summary (live) or the v2 channel breakdown.
    const breakdown = (v3Now && bd)
      ? `base ${bd.base}${bd.resume ? ` · rez +${bd.resume}` : ''}${bd.consensus ? ` · cons +${bd.consensus}` : ''}${(bd.market && bd.market.pts) ? ` · mkt +${bd.market.pts}` : ''}${bd.sport_bonus ? ` · sport +${bd.sport_bonus}` : ''}${(bd.fade_in && bd.fade_in.pts) ? ` · fade +${bd.fade_in.pts}` : ''}`
      : (p.channel_points != null ? `ch:${p.channel_points} sport:${p.sport_bonus} home:${p.home_bonus} = ${p.sb_total}` : '—');

    const matchup = (p.away_team && p.home_team)
      ? `${escHtml(p.away_team)} @ ${escHtml(p.home_team)}` : `<em>${escHtml(p.team)}</em>`;
    const timeStr = p.start_time
      ? new Date(p.start_time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }) : '';
    const pickType = (p.pick_type || '').toLowerCase();
    const spreadDisplay = (pickType === 'over' || pickType === 'under')
      ? (p.spread != null ? Math.abs(parseFloat(p.spread)) : '')
      : (p.spread != null ? p.spread : '');
    const scoreColor = isGold ? '#FFD700' : isSilver ? '#c0c0c0' : '#e5e9f0';
    const hasDetail = !!(v3Panel || raws.length);
    const rowOpen = hasDetail ? ` style="cursor:pointer;" onclick="toggleMsgs(${p.id}, this.querySelector('.msg-toggle button'))"` : '';
    return `<tr${rowOpen}>
      <td><strong>${i + 1}</strong> <span style="font-size:10px;color:#3b4560;">#${p.id}</span></td>
      <td><strong>${matchup}</strong>${timeStr ? `<span style="font-size:11px;color:#8892a4;margin-left:6px;">${timeStr}</span>` : ''}</td>
      <td>${escHtml(p.sport || '—')}</td>
      <td>${escHtml(p.team || '—')} ${escHtml(p.pick_type || '')} ${spreadDisplay}</td>
      <td>${matchBadge}</td>
      <td>${p.mention_count}</td>
      <td style="font-weight:700;color:${scoreColor};">${shownScore} ${tierBadge}${publicNote}</td>
      <td><small>${breakdown}</small></td>
      <td onclick="event.stopPropagation()"><span class="msg-toggle">${msgBtn}</span></td>
    </tr>${rawRowsHtml}`;
  }).join('');

  const picksTableHtml = picks.length
    ? `<table><thead><tr><th>#</th><th>Team</th><th>Sport</th><th>Pick</th><th>Match</th><th>Mentions</th><th>Score</th><th>Breakdown</th><th>Details</th></tr></thead><tbody>${pickRowsHtml}</tbody></table>`
    : '<div class="empty">No picks today.</div>';

  // ── Codes panel ──────────────────────────────────────────────────────────────
  const codes = db.prepare(`
    SELECT ac.*, u.email AS activated_email, u.username AS activated_username,
           (SELECT COUNT(*) FROM code_redemptions r WHERE r.code_id = ac.id) AS use_count
    FROM access_codes ac
    LEFT JOIN users u ON u.id = ac.activated_by
    ORDER BY ac.created_at DESC
  `).all();

  // Access length granted on redemption (custom duration wins, else the legacy type).
  const codeDurationLabel = (c) => {
    if (c.duration_days != null) return c.duration_days > 0 ? `${c.duration_days} day${c.duration_days === 1 ? '' : 's'}` : 'Lifetime';
    const map = { day: '1 day', week: '7 days', annual: '1 year', lifetime: 'Lifetime' };
    return map[c.type] || escHtml(c.type || '—');
  };

  const codeRows = codes.map(c => {
    const maxUses   = c.max_uses == null ? 1 : c.max_uses;   // 0 = unlimited
    const uses      = c.use_count || 0;
    const unlimited = maxUses === 0;
    const isMulti   = unlimited || maxUses > 1;
    const full      = !unlimited && uses >= maxUses;

    let status = 'Unused', statusColor = '#8892a4';
    if (uses > 0) {
      if (full) { status = 'Full';   statusColor = '#ef4444'; }
      else      { status = 'Active'; statusColor = '#16a34a'; }
    }

    const usesLabel = `${uses} / ${unlimited ? '∞' : maxUses}`;

    // Who redeemed: single-use shows the one user inline; multi-use links to the popup.
    let redeemedBy;
    if (isMulti) {
      redeemedBy = uses > 0
        ? `<span style="color:#93c5fd;">${uses} user${uses === 1 ? '' : 's'} &#9656;</span>`
        : '<span style="color:#8892a4;">—</span>';
    } else {
      redeemedBy = `<span style="color:#8892a4;">${escHtml(c.activated_username || c.activated_email || '—')}</span>`;
    }

    // Multi-use codes are manageable even after use; single-use only while unredeemed.
    const canDelete = uses === 0 || isMulti;
    const deleteBtn = canDelete
      ? `<button class="btn-sm btn-revoke" onclick="event.stopPropagation();deleteCode(${c.id})">Delete</button>`
      : '';

    // Row click opens the "who used it" popup, but only when the user limit is over 1.
    const rowAttrs  = isMulti ? ` style="cursor:pointer;" title="See who redeemed this code" onclick="showCodeUsers(${c.id})"` : '';
    const createdAt = c.created_at ? c.created_at.slice(0, 16).replace('T', ' ') : '—';

    return `<tr${rowAttrs}>
      <td style="font-family:monospace;letter-spacing:1px;font-size:13px;">${escHtml(c.code)}</td>
      <td style="font-size:12px;">${codeDurationLabel(c)}</td>
      <td style="color:#64748b;font-size:12px;">${escHtml(c.notes || '—')}</td>
      <td style="font-size:12px;font-weight:600;color:#c8d3e0;">${usesLabel}</td>
      <td style="font-size:12px;">${redeemedBy}</td>
      <td><span style="color:${statusColor};font-weight:600;font-size:12px;">${status}</span></td>
      <td style="color:#8892a4;font-size:12px;">${createdAt}</td>
      <td onclick="event.stopPropagation()">${deleteBtn}</td>
    </tr>`;
  }).join('');

  const codesTableHtml = codes.length
    ? `<table><thead><tr><th>Code</th><th>Duration</th><th>Name</th><th>Uses</th><th>Redeemed By</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>${codeRows}</tbody></table>`
    : '<div class="empty">No codes generated yet.</div>';

  // ── MVP panel ─────────────────────────────────────────────────────────────────
  const mvps = db.prepare(`
    SELECT m.*,
           COALESCE(tg1.home_team, tg2.home_team) AS home_team,
           COALESCE(tg1.away_team, tg2.away_team) AS away_team
    FROM mvp_picks m
    LEFT JOIN today_games tg1 ON tg1.espn_game_id = m.espn_game_id
    LEFT JOIN today_games tg2 ON tg1.espn_game_id IS NULL
                              AND (LOWER(tg2.home_team) = LOWER(m.team) OR LOWER(tg2.away_team) = LOWER(m.team))
    ORDER BY m.saved_at DESC LIMIT 200
  `).all();

  const resultBadge = r => {
    const map = { win: '#16a34a', loss: '#ef4444', push: '#8892a4', pending: '#f59e0b' };
    const color = map[(r || 'pending').toLowerCase()] || '#8892a4';
    return `<span class="badge" style="background:${color}22;color:${color};border:1px solid ${color}44;">${(r || 'pending').toUpperCase()}</span>`;
  };

  const sports    = [...new Set(mvps.map(m => m.sport).filter(Boolean))].sort();
  const pickTypes = [...new Set(mvps.map(m => (m.pick_type || '').toLowerCase()).filter(Boolean))].sort();

  const mvpRowsHtml = mvps.map(m => {
    const matchup = (m.away_team && m.home_team)
      ? `${escHtml(m.away_team)} @ ${escHtml(m.home_team)}` : escHtml(m.team || '—');
    const pt = (m.pick_type || '').toLowerCase();
    const sp = (pt === 'over' || pt === 'under')
      ? (m.spread != null ? Math.abs(parseFloat(m.spread)) : '')
      : (m.spread != null ? m.spread : '');
    const scoreStr  = m.home_score != null ? `${m.away_score}–${m.home_score}` : '—';
    const savedDate = m.saved_at ? m.saved_at.slice(0, 10) : m.game_date || '—';
    return `<tr class="mvp-row" style="cursor:pointer;" onclick="openMvp(${m.id})"
      data-date="${savedDate}" data-sport="${escHtml((m.sport||'').toLowerCase())}"
      data-pick-type="${escHtml(pt)}" data-result="${escHtml((m.result||'pending').toLowerCase())}"
      data-score="${m.score ?? 0}">
      <td>${m.id}</td><td>${matchup}</td>
      <td>${escHtml(m.sport || '—')}</td>
      <td>${escHtml(m.pick_type || '—')} <span style="color:#8892a4;">${sp}</span></td>
      <td>${m.score ?? '—'} <span class="badge mvp">MVP</span></td>
      <td>${scoreStr}</td>
      <td>${resultBadge(m.result)}</td>
      <td style="color:#8892a4;font-size:12px;">${savedDate}</td>
    </tr>`;
  }).join('');

  const sportOpts  = sports.map(s => `<option value="${escHtml(s.toLowerCase())}">${escHtml(s)}</option>`).join('');
  const ptOpts     = pickTypes.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');

  const mvpTableHtml = mvps.length
    ? `<table id="mvp-table">
        <thead><tr><th>ID</th><th>Matchup</th><th style="cursor:pointer;" data-col="sport">Sport &#x21D5;</th><th style="cursor:pointer;" data-col="pick-type">Pick &#x21D5;</th><th style="cursor:pointer;" data-col="score">Score &#x21D5;</th><th>Final</th><th style="cursor:pointer;" data-col="result">Result &#x21D5;</th><th style="cursor:pointer;" data-col="date">Date &#x21D5;</th></tr></thead>
        <tbody id="mvp-tbody">${mvpRowsHtml}</tbody>
      </table>
      <div id="mvp-empty" style="display:none;" class="empty">No picks match filters.</div>
      <div id="mvp-count" style="color:#8892a4;font-size:12px;margin-top:6px;"></div>`
    : '<div class="empty">No MVP picks on record.</div>';

  // ── AI Usage panel ───────────────────────────────────────────────────────────
  // The SDK's usage.input_tokens does NOT include tool schema tokens that Anthropic
  // charges for. Observed ratio: Anthropic bills ~2.5x the SDK-reported cost.
  // OVERHEAD_MULTIPLIER corrects for this in the "Billed Est." display.
  const OVERHEAD_MULTIPLIER = 2.5;

  const todayStr  = new Date().toISOString().slice(0, 10);
  const monthStr  = new Date().toISOString().slice(0, 7);
  const usageToday = db.prepare(`
    SELECT COUNT(*) AS calls,
           SUM(input_tokens) AS input, SUM(output_tokens) AS output,
           SUM(cache_creation_tokens) AS cwrite, SUM(cache_read_tokens) AS cread,
           SUM(estimated_cost_usd) AS cost
    FROM api_usage WHERE DATE(created_at) = ?
  `).get(todayStr) || {};
  const usageMonth = db.prepare(`
    SELECT COUNT(*) AS calls,
           SUM(input_tokens) AS input, SUM(output_tokens) AS output,
           SUM(cache_creation_tokens) AS cwrite, SUM(cache_read_tokens) AS cread,
           SUM(estimated_cost_usd) AS cost
    FROM api_usage WHERE strftime('%Y-%m', created_at) = ?
  `).get(monthStr) || {};
  const usageLifetime = db.prepare(`
    SELECT COUNT(*) AS calls, SUM(estimated_cost_usd) AS cost FROM api_usage
  `).get() || {};
  const usageDays = db.prepare(`
    SELECT DATE(created_at) AS day, COUNT(*) AS calls,
           SUM(input_tokens) AS input, SUM(output_tokens) AS output,
           SUM(cache_creation_tokens) AS cwrite, SUM(cache_read_tokens) AS cread,
           SUM(estimated_cost_usd) AS cost
    FROM api_usage
    GROUP BY day ORDER BY day DESC LIMIT 14
  `).all();

  // Monthly projection based on daily run rate
  const nowDate       = new Date();
  const daysElapsed   = nowDate.getDate();
  const daysInMonth   = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0).getDate();
  const monthCostSdk  = usageMonth.cost || 0;
  const dailyRateSdk  = daysElapsed > 0 ? monthCostSdk / daysElapsed : 0;
  const projectedSdk  = dailyRateSdk * daysInMonth;
  const projectedBilled = projectedSdk * OVERHEAD_MULTIPLIER;

  const fmtCost  = v => v != null ? '$' + Number(v).toFixed(4) : '$0.0000';
  const fmtTok   = v => v != null ? Number(v).toLocaleString() : '0';
  const statCard = (label, val, sub = '') =>
    `<div style="background:#171b24;border:1px solid #252c3b;border-radius:8px;padding:16px 20px;min-width:140px;">
       <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8892a4;margin-bottom:6px;">${label}</div>
       <div style="font-size:20px;font-weight:700;">${val}</div>
       ${sub ? `<div style="font-size:11px;color:#64748b;margin-top:4px;">${sub}</div>` : ''}
     </div>`;

  const usageDayRows = usageDays.map(d =>
    `<tr>
       <td>${d.day}</td>
       <td>${d.calls}</td>
       <td>${fmtTok(d.input)}</td>
       <td>${fmtTok(d.output)}</td>
       <td>${fmtTok(d.cwrite)}</td>
       <td>${fmtTok(d.cread)}</td>
       <td style="color:#8892a4;">${fmtCost(d.cost)}</td>
       <td style="color:#fbbf24;font-weight:600;">${fmtCost((d.cost || 0) * OVERHEAD_MULTIPLIER)}</td>
     </tr>`
  ).join('') || `<tr><td colspan="8" class="empty">No data yet — usage is logged after the first Claude API call.</td></tr>`;

  const usagePanelHtml = `
    <h1>AI Usage <small style="font-size:13px;color:#8892a4;font-weight:400;">Claude Haiku — reader.js</small></h1>
    <div style="background:#1a1200;border:1px solid #78350f;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#fbbf24;">
      <strong>Billing note:</strong> The SDK only reports user/system message tokens — Anthropic also charges for tool schema tokens (~2.5x total).
      "SDK Est." below is what the code tracks. "Billed Est." corrects for the overhead. Verify at
      <a href="https://console.anthropic.com" target="_blank" style="color:#fbbf24;">console.anthropic.com</a>.
    </div>
    <h2 style="margin-top:0;">Today</h2>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px;">
      ${statCard('API Calls', usageToday.calls || 0)}
      ${statCard('Input Tokens', fmtTok(usageToday.input))}
      ${statCard('Output Tokens', fmtTok(usageToday.output))}
      ${statCard('Cache Writes', fmtTok(usageToday.cwrite))}
      ${statCard('Cache Reads', fmtTok(usageToday.cread))}
      ${statCard('SDK Est.', fmtCost(usageToday.cost), 'reported by SDK')}
      ${statCard('Billed Est.', fmtCost((usageToday.cost || 0) * OVERHEAD_MULTIPLIER), 'approx. Anthropic charge')}
    </div>
    <h2>This Month</h2>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px;">
      ${statCard('API Calls', usageMonth.calls || 0)}
      ${statCard('Input Tokens', fmtTok(usageMonth.input))}
      ${statCard('Output Tokens', fmtTok(usageMonth.output))}
      ${statCard('Cache Writes', fmtTok(usageMonth.cwrite))}
      ${statCard('Cache Reads', fmtTok(usageMonth.cread))}
      ${statCard('SDK Est.', fmtCost(monthCostSdk), 'reported by SDK')}
      ${statCard('Billed Est.', fmtCost(monthCostSdk * OVERHEAD_MULTIPLIER), 'approx. Anthropic charge')}
      ${statCard('Projected Month', fmtCost(projectedBilled), `day ${daysElapsed}/${daysInMonth} · ${fmtCost(dailyRateSdk * OVERHEAD_MULTIPLIER)}/day`)}
    </div>
    <h2>Last 14 Days</h2>
    <table>
      <thead><tr><th>Date</th><th>Calls</th><th>Input Tokens</th><th>Output Tokens</th><th>Cache Writes</th><th>Cache Reads</th><th>SDK Est.</th><th style="color:#fbbf24;">Billed Est.</th></tr></thead>
      <tbody>${usageDayRows}</tbody>
    </table>
    <p style="color:#8892a4;font-size:12px;margin-top:12px;">
      Pricing: input $0.80/M · output $4.00/M · cache write $1.00/M · cache read $0.08/M (Haiku 4.5).
      Billed Est. applies ${OVERHEAD_MULTIPLIER}x multiplier for tool schema overhead.
    </p>
    <p style="color:#8892a4;font-size:12px;margin-top:4px;">Lifetime: ${usageLifetime.calls || 0} calls · ${fmtCost(usageLifetime.cost)} SDK est. · ${fmtCost((usageLifetime.cost || 0) * OVERHEAD_MULTIPLIER)} billed est.</p>
  `;

  // ── Cappers panel data (from capper_history — permanent, cross-day tracking) ──
  let allHistoryRows = [];
  try {
    allHistoryRows = db.prepare(`SELECT * FROM capper_history ORDER BY saved_at DESC`).all();
  } catch (_) {}

  const allAliases = (() => {
    try { return db.prepare(`SELECT * FROM capper_aliases ORDER BY canonical_name`).all(); }
    catch (_) { return []; }
  })();

  // Build alias lookup: normalized alias → canonical name
  const aliasMap = new Map();
  for (const a of allAliases) {
    aliasMap.set((a.alias || '').toLowerCase().replace(/[^a-z0-9]/g, ''), a.canonical_name);
  }
  function resolveCapperDisplay(name) {
    if (!name) return name;
    const normFn = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // Follow alias chains to the final canonical (cycle-guarded) — merges can
    // point at names that are themselves aliases and must still fold to one row.
    let cur = aliasMap.get(normFn(name)) || name;
    for (let hops = 0; hops < 5; hops++) {
      const next = aliasMap.get(normFn(cur));
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  }

  // Profit on one resolved pick at a given stake, using stored American odds.
  // Missing odds fall back to standard juice so the bet still contributes.
  function pickProfit(result, odds, pickType, stake) {
    const r = (result || '').toLowerCase();
    if (r === 'loss') return -stake;
    if (r !== 'win')  return 0; // push / pending / void
    let o = (odds == null || isNaN(parseFloat(odds))) ? null : parseFloat(odds);
    if (o == null) {
      const pt = (pickType || '').toLowerCase();
      o = (pt === 'over' || pt === 'under') ? -115 : -110;
    }
    return o > 0 ? stake * (o / 100) : stake * (100 / Math.abs(o));
  }

  // Aggregate per capper from capper_history
  const capperMap = new Map();
  for (const row of allHistoryRows) {
    if (!row.capper_name) continue;
    const display = resolveCapperDisplay(row.capper_name);
    if (!capperMap.has(display)) {
      capperMap.set(display, { wins: 0, losses: 0, pushes: 0, pending: 0, money: 0, sports: {}, srcs: new Set() });
    }
    const c = capperMap.get(display);
    c.srcs.add(row.source || 'discord');
    const r = (row.result || '').toLowerCase();
    if (r === 'win')       c.wins++;
    else if (r === 'loss') c.losses++;
    else if (r === 'push') c.pushes++;
    else                   c.pending++;
    const profit = pickProfit(r, row.odds, row.pick_type, betUnit);
    c.money += profit;
    const s = row.sport || 'Unknown';
    if (!c.sports[s]) c.sports[s] = { wins: 0, losses: 0, pushes: 0, money: 0 };
    if (r === 'win')       c.sports[s].wins++;
    else if (r === 'loss') c.sports[s].losses++;
    else if (r === 'push') c.sports[s].pushes++;
    c.sports[s].money += profit;
  }

  // Find top sports by resolved pick volume (for column headers)
  const sportTotals = {};
  for (const [, c] of capperMap) {
    for (const [s, rec] of Object.entries(c.sports)) {
      if (s === 'Unknown') continue;
      sportTotals[s] = (sportTotals[s] || 0) + rec.wins + rec.losses + rec.pushes;
    }
  }
  const allSports = Object.entries(sportTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([s]) => s);

  // v3 ratings context (materialized nightly): rating number, tier, fade, sources
  const ratingsMap = new Map();
  try {
    for (const r of db.prepare(`SELECT * FROM capper_ratings WHERE scope = 'overall'`).all()) {
      ratingsMap.set(r.canonical_name, r);
    }
  } catch (_) {}

  // Source Feed: every pick recorded by the wave-1 scrapers (no message scanner),
  // newest first. Provenance meta (units, notional, live, contest) rides in
  // sources_json. today_games enriches the matchup while the game is still on board.
  let sourceFeed = [];
  try {
    sourceFeed = db.prepare(`
      SELECT ch.*, tg.home_team AS g_home, tg.away_team AS g_away, tg.status AS g_status
      FROM capper_history ch
      LEFT JOIN today_games tg ON tg.espn_game_id = ch.espn_game_id
      WHERE ch.source != 'discord'
      ORDER BY ch.saved_at DESC, ch.id DESC
      LIMIT 400
    `).all();
  } catch (_) {}

  // Sort: the Wilson ranking IS the leaderboard (rank 1 first, unranked last,
  // then by volume). Every capper's percentile position decides what their
  // picks are worth, so the default view is that ranking.
  const sortedCappers = [...capperMap.entries()]
    .map(([name, c]) => {
      const total = c.wins + c.losses + c.pushes;
      // Win% is over decided picks only (pushes excluded) — the same convention as
      // the member leaderboard, capper ratings, and the public record pages.
      const decided = c.wins + c.losses;
      const winPct = decided > 0 ? Math.round((c.wins / decided) * 100) : null;
      const units  = c.wins - c.losses;
      const r = ratingsMap.get(name) || null;
      const srcUnion = new Set([...(c.srcs || []), ...(r?.sources ? r.sources.split(',') : [])]);
      return { name, ...c, total, winPct, units,
               rating: r ? (r.resume_points ?? 0) : null,
               tier: r?.tier ?? null, fade: r?.fade ?? null,
               wilson: r?.wilson ?? null, wrank: r?.wilson_rank ?? null,
               pctile: r?.percentile ?? null, band: r?.band ?? 'new',
               pts: r?.pts ?? null, stackAdd: r?.stack_add ?? null,
               decisionsR: r?.decisions ?? decided,
               srcList: [...srcUnion].sort() };
    })
    .filter(c => c.total > 0 || c.pending > 0)
    .sort((a, b) => (a.wrank ?? 1e9) - (b.wrank ?? 1e9)
      || (b.wins + b.losses + b.pushes) - (a.wins + a.losses + a.pushes)
      || (b.winPct ?? -1) - (a.winPct ?? -1));

  // ── Suggested merges: fuzzy-match similar capper names for one-click aliasing ─
  function _normCap(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function _lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i), cur = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev; prev = cur; cur = tmp;
    }
    return prev[n];
  }
  function _simScore(a, b) {
    const na = _normCap(a), nb = _normCap(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const short = Math.min(na.length, nb.length), long = Math.max(na.length, nb.length);
    let s = 1 - _lev(na, nb) / long;
    if (short >= 4 && (na.includes(nb) || nb.includes(na))) s = Math.max(s, 0.9);
    return s;
  }
  const _capNames = sortedCappers.map(c => ({ name: c.name, picks: c.total + c.pending }));
  const _allSuggestions = [];
  for (let i = 0; i < _capNames.length; i++) {
    for (let j = i + 1; j < _capNames.length; j++) {
      const A = _capNames[i], B = _capNames[j];
      const score = _simScore(A.name, B.name);
      if (score >= 0.6) {
        const [al, cn] = A.picks <= B.picks ? [A, B] : [B, A]; // smaller volume → alias
        _allSuggestions.push({ alias: al.name, aliasPicks: al.picks, canon: cn.name, canonPicks: cn.picks, score });
      }
    }
  }
  _allSuggestions.sort((a, b) => b.score - a.score);
  const _seenAlias = new Set();
  const topSuggestions = _allSuggestions.filter(s => {
    if (_seenAlias.has(s.alias)) return false;
    _seenAlias.add(s.alias);
    return true;
  }).slice(0, 30);

  const suggestionsHtml = topSuggestions.length ? `
    <table id="alias-suggestions">
      <thead><tr><th>Recorded name</th><th>Picks</th><th>Looks like</th><th>Confidence</th><th></th></tr></thead>
      <tbody>${topSuggestions.map(s => {
        const pct  = Math.round(s.score * 100);
        const conf = pct >= 85 ? '#16a34a' : pct >= 70 ? '#f59e0b' : '#8892a4';
        return `<tr>
          <td style="font-weight:600;">${escHtml(s.alias)}</td>
          <td style="color:#8892a4;font-size:12px;">${s.aliasPicks}</td>
          <td>${escHtml(s.canon)} <span style="color:#8892a4;font-size:12px;">(${s.canonPicks} picks)</span></td>
          <td style="color:${conf};font-weight:700;">${pct}%</td>
          <td style="white-space:nowrap;">
            <button class="btn-sm btn-primary" data-canon="${escHtml(s.canon)}" data-alias="${escHtml(s.alias)}" onclick="quickMerge(this)">Match</button>
            <button class="btn-sm" onclick="this.closest('tr').remove()">Not a match</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>` : `<p class="empty" style="font-size:13px;">No likely duplicates left to review.</p>`;

  const capperNameOptions = sortedCappers.map(c => `<option value="${escHtml(c.name)}"></option>`).join('');

  const sportHeaders = allSports.map(s => `<th data-type="num" onclick="sortCapperLB(this)" style="white-space:nowrap;cursor:pointer;user-select:none;">${escHtml(s)}</th>`).join('');
  const sortable = (label, type, title) =>
    `<th data-type="${type}"${title ? ` title="${title}"` : ''} onclick="sortCapperLB(this)" style="cursor:pointer;user-select:none;">${label}</th>`;

  // v3 chips: source labels (multi-source cappers show every system they appear in)
  const SRC_CHIP = {
    discord:       ['DC', '#5865F2', 'Discord scanner (free-plays / pod-thread / community-leaks)'],
    actionnetwork: ['AN', '#16a34a', 'Action Network expert. Picks pulled from their public feed, graded by us. Pregame picks join the board through the normal resume scoring.'],
    polymarket:    ['PM', '#8b5cf6', 'Polymarket pro wallet. Real positions from a top-P/L trader; entries before game start count as picks.'],
    covers:        ['CV', '#f59e0b', 'Covers.com contest player. Contest picks are platform-graded and lock at game start.'],
    telegram:      ['TG', '#0ea5e9', 'Telegram channel (wave 2, not live yet)'],
    reddit:        ['RD', '#f97316', 'Reddit (wave 2, not live yet)'],
  };
  const srcChips = (list) => (list || []).map(s => {
    const [label, color, tip] = SRC_CHIP[s] || [s.slice(0, 2).toUpperCase(), '#8892a4', s];
    return `<span title="${escHtml(tip)}" style="background:${color}22;color:${color};border:1px solid ${color}44;border-radius:3px;padding:0 4px;font-size:9px;font-weight:800;letter-spacing:0.5px;margin-right:4px;">${label}</span>`;
  }).join('');
  // Status column chips: tier + fade, each with a plain-language tooltip that
  // explains what the badge means and how it is computed.
  const TIER_TIPS = {
    proven:   ['PROVEN', '#16a34a', '50 or more graded picks with a positive shrunk ROI. The rating formula trusts this capper the most.'],
    rated:    ['RATED', '#0ea5e9', '25 or more graded picks. Enough volume for a meaningful rating; still building toward Proven.'],
    building: ['BUILDING', '#8892a4', '10 to 24 graded picks. Rating exists but is heavily shrunk toward breakeven until volume grows.'],
    tracking: ['TRACKING', '#3b4560', 'Under 10 graded picks. Nearly all rating credit is withheld until we see more.'],
  };
  const FADE_TIPS = {
    watch:  ['FADE WATCH', '#f59e0b', 'Bottom 25% of the Wilson ranking with a win rate of 45% or under across 5+ decisions. Their picks contribute 0 points.'],
    active: ['FADE ACTIVE', '#ef4444', 'Bottom 25% of the Wilson ranking with a win rate of 40% or under across 15+ decisions. Their picks ADD points to the opposite side, scaled by their volume in that sport.'],
  };
  // Percentile band chips (the Wilson ladder). Label = the band, tooltip = what
  // a pick from this capper is worth before the volume cap.
  const BAND_META = {
    'top1':     ['TOP 1%',  '#FFD700', 'Top 1% of the Wilson ranking. Picks worth 95 down to 76 points across the band.'],
    '1-5':      ['1-5%',    '#f59e0b', 'Points 75 down to 66.'],
    '5-15':     ['5-15%',   '#16a34a', 'Points 65 down to 51.'],
    '15-25':    ['15-25%',  '#0ea5e9', 'Points 50 down to 41.'],
    '25-35':    ['25-35%',  '#8b5cf6', 'Points 40 down to 31.'],
    '35-45':    ['35-45%',  '#8892a4', 'Points 30 down to 21.'],
    '45-75':    ['45-75%',  '#5c6577', 'Points 20 down to 11.'],
    'bottom25': ['BTM 25%', '#ef4444', 'Bottom 25% of the ranking. Picks contribute 0 points; fade rules may apply.'],
    'new':      ['NEW',     '#3b4560', 'No graded decisions yet. Picks are worth the flat 10 points.'],
  };
  // Rows written before the 2026-07-09 top-1% ladder change may still carry the
  // old band keys until the next recompute rewrites them — render them mapped.
  const LEGACY_BANDS = { 'top3': 'top1', '3-5': '1-5' };
  const bandChip = (band) => {
    const [label, color, tip] = BAND_META[band] || BAND_META[LEGACY_BANDS[band]] || BAND_META['new'];
    return `<span title="${escHtml(tip)}" style="background:${color}22;color:${color};border:1px solid ${color}44;border-radius:3px;padding:1px 5px;font-size:9px;font-weight:800;">${label}</span>`;
  };
  const statusChips = (c) => {
    const chips = [];
    const t = TIER_TIPS[c.tier];
    if (t && (c.tier === 'proven' || c.tier === 'rated')) {
      chips.push(`<span title="${escHtml(t[2])}" style="background:${t[1]}22;color:${t[1]};border:1px solid ${t[1]}44;border-radius:3px;padding:1px 5px;font-size:9px;font-weight:800;">${t[0]}</span>`);
    }
    if (c.fade && FADE_TIPS[c.fade]) {
      const f = FADE_TIPS[c.fade];
      chips.push(`<span title="${escHtml(f[2])}" style="background:${f[1]}22;color:${f[1]};border:1px solid ${f[1]}44;border-radius:3px;padding:1px 5px;font-size:9px;font-weight:800;">${f[0]}</span>`);
    }
    if (!chips.length && t) {
      chips.push(`<span title="${escHtml(t[2])}" style="color:${t[1]};font-size:9px;font-weight:700;">${t[0]}</span>`);
    }
    return chips.join(' ') || '<span style="color:#3b4560;">—</span>';
  };

  // Source filter chips: one per system that has cappers on the board, with counts.
  const srcCounts = {};
  for (const c of sortedCappers) for (const s of (c.srcList || [])) srcCounts[s] = (srcCounts[s] || 0) + 1;
  const srcFilterChips = Object.keys(SRC_CHIP)
    .filter(s => srcCounts[s])
    .map(s => {
      const [label, color] = SRC_CHIP[s];
      return `<button class="btn-sm src-filter-btn" data-src="${s}" onclick="filterCapperSrc('${s}', this)"
        style="border:1px solid ${color}44;color:${color};background:${color}11;">${label} · ${srcCounts[s]}</button>`;
    }).join(' ');

  const bandCounts = {};
  for (const c of sortedCappers) bandCounts[c.band] = (bandCounts[c.band] || 0) + 1;
  const bandFilterChips = Object.keys(BAND_META)
    .filter(b => bandCounts[b])
    .map(b => {
      const [label, color] = BAND_META[b];
      return `<button class="btn-sm band-filter-btn" data-band="${b}" onclick="filterCapperBand('${b}', this)"
        style="border:1px solid ${color}44;color:${color};background:${color}11;">${label} · ${bandCounts[b]}</button>`;
    }).join(' ');
  const fadeCount = sortedCappers.filter(c => c.fade).length;

  const capperLeaderboardHtml = sortedCappers.length ? `
    <p style="color:#8892a4;font-size:12px;margin-bottom:10px;">Ranked by the Wilson score interval (99% lower bound on win rate): the ranking that decides what every capper's picks are worth. Click a column to sort (click again to reverse). Click any row for the full capper profile. <button class="btn-sm" style="margin-left:8px;" onclick="recomputeRatings(this)">Recompute ratings</button></p>
    <div style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
      <span style="color:#8892a4;font-size:11px;font-weight:700;letter-spacing:0.5px;">SOURCE</span>
      <button class="btn-sm src-filter-btn active" data-src="all" onclick="filterCapperSrc('all', this)"
        style="border:1px solid #3b4560;color:#e6e9f0;">All · ${sortedCappers.length}</button>
      ${srcFilterChips}
      <input id="capper-search" type="text" placeholder="Search cappers..." oninput="searchCappers(this.value)"
        style="margin-left:auto;padding:5px 10px;background:#0d1017;border:1px solid #2a3142;border-radius:6px;color:#e6e9f0;font-size:13px;min-width:200px;">
    </div>
    <div style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
      <span style="color:#8892a4;font-size:11px;font-weight:700;letter-spacing:0.5px;">BAND</span>
      <button class="btn-sm band-filter-btn active" data-band="all" onclick="filterCapperBand('all', this)"
        style="border:1px solid #3b4560;color:#e6e9f0;">All</button>
      ${bandFilterChips}
      ${fadeCount ? `<button class="btn-sm band-filter-btn" data-band="fade" onclick="filterCapperBand('fade', this)"
        style="border:1px solid #ef444444;color:#ef4444;background:#ef444411;">FADE · ${fadeCount}</button>` : ''}
    </div>
    <div style="overflow-x:auto;">
    <table id="capper-leaderboard">
      <thead><tr>
        ${sortable('#', 'num')}${sortable('Capper', 'str')}${sortable('Rank', 'num', 'Position in the all-capper Wilson ranking (99% lower bound on win rate over graded decisions). This rank decides the points below.')}${sortable('Wilson', 'num', 'The 99% Wilson lower bound itself: the worst-case win rate the record still supports. Volume raises it, thin perfection does not.')}${sortable('Band', 'str', 'Percentile band on the points ladder. Hover a chip for the point range.')}${sortable('Pts/Pick', 'num', 'What the next pick from this capper is worth as the best backer, after the band slide and the volume cap (under 10 decisions caps at 50, 10-29 at 70, 30+ uncapped).')}${sortable('Status', 'str', 'Tier and fade badges. Hover any badge for what it means and how it is computed.')}${sortable('Record', 'num')}${sortable('Win%', 'num')}${sortable('Units', 'num')}
        ${sortable('Money ($' + betUnit + '/u)', 'num', 'Odds-weighted profit/loss at the unit size below')}
        ${sportHeaders}
        ${sortable('Pending', 'num')}
      </tr></thead>
      <tbody>${sortedCappers.map((c, i) => {
        const wpColor    = c.winPct === null ? '#8892a4' : c.winPct >= 55 ? '#16a34a' : c.winPct >= 50 ? '#f59e0b' : '#ef4444';
        const unitColor  = c.units > 0 ? '#16a34a' : c.units < 0 ? '#ef4444' : '#8892a4';
        const unitStr    = (c.units > 0 ? '+' : '') + c.units;
        const moneyColor = c.money > 0.005 ? '#16a34a' : c.money < -0.005 ? '#ef4444' : '#8892a4';
        const moneyStr   = (c.money >= 0 ? '+$' : '-$') + Math.abs(c.money).toFixed(0);
        const pushStr    = c.pushes > 0 ? `-<span style="color:#8892a4;">${c.pushes}</span>` : '';
        const sportCols  = allSports.map(s => {
          const sr = c.sports[s];
          if (!sr || (sr.wins + sr.losses + sr.pushes) === 0) return `<td data-sv="-9999" style="color:#3b4560;">—</td>`;
          const sdecided = sr.wins + sr.losses;
          const swp    = sdecided > 0 ? Math.round((sr.wins / sdecided) * 100) : null;
          const sc     = swp === null ? '#8892a4' : swp >= 55 ? '#16a34a' : swp >= 50 ? '#f59e0b' : '#ef4444';
          const smColor = sr.money > 0.005 ? '#16a34a' : sr.money < -0.005 ? '#ef4444' : '#8892a4';
          const smStr   = (sr.money >= 0 ? '+$' : '-$') + Math.abs(sr.money).toFixed(0);
          return `<td data-sv="${sr.money}" style="font-size:12px;white-space:nowrap;"><span style="color:${sc};">${sr.wins}-${sr.losses}</span><br><span style="color:${smColor};font-size:10px;font-weight:600;">${smStr}</span></td>`;
        }).join('');
        const fadeRow = c.fade ? 'box-shadow:inset 3px 0 0 #ef4444;' : '';
        const capNote = c.pts != null && c.decisionsR < 30 && c.band !== 'bottom25' && c.band !== 'new' && !c.fade
          ? `<span title="Volume cap: under 10 decisions caps at 50 points, 10-29 at 70. Uncapped at 30." style="color:#f59e0b;font-size:9px;font-weight:700;"> CAP</span>` : '';
        const ptsColor = c.pts == null ? '#3b4560' : c.pts >= 76 ? '#FFD700' : c.pts >= 51 ? '#16a34a' : c.pts > 0 ? '#8892a4' : '#ef4444';
        return `<tr class="capper-row" style="cursor:pointer;${fadeRow}" data-capper="${escHtml(c.name)}" data-sources="${escHtml((c.srcList || []).join(','))}" data-band="${escHtml(c.band || 'new')}" data-fade="${c.fade ? 1 : 0}" onclick="showCapperDetail(this.getAttribute('data-capper'))">
          <td data-sv="${i}" style="color:#8892a4;font-size:12px;">${i + 1}</td>
          <td data-sv="${escHtml(c.name.toLowerCase())}" style="font-weight:600;">
            <div style="white-space:nowrap;">${escHtml(c.name)}</div>
            <div style="margin-top:2px;line-height:1;">${srcChips(c.srcList)}</div>
          </td>
          <td data-sv="${c.wrank != null ? -c.wrank : -99999}" style="color:${c.wrank != null && c.wrank <= 10 ? '#FFD700' : '#8892a4'};font-weight:700;">${c.wrank != null ? '#' + c.wrank : '—'}</td>
          <td data-sv="${c.wilson ?? -1}" style="color:#b7c0d0;font-size:12px;">${c.wilson != null ? c.wilson.toFixed(3) : '—'}</td>
          <td data-sv="${escHtml(c.band || 'new')}" style="white-space:nowrap;">${bandChip(c.band)}</td>
          <td data-sv="${c.pts ?? -1}" style="color:${ptsColor};font-weight:700;white-space:nowrap;">${c.pts != null ? Math.round(c.pts) : '—'}${capNote}</td>
          <td data-sv="${c.fade ? (c.fade === 'active' ? 4 : 3) : (c.tier === 'proven' ? 2 : c.tier === 'rated' ? 1 : 0)}" style="white-space:nowrap;">${statusChips(c)}</td>
          <td data-sv="${c.wins}"><span style="color:#16a34a;font-weight:700;">${c.wins}</span>-<span style="color:#ef4444;font-weight:700;">${c.losses}</span>${pushStr}</td>
          <td data-sv="${c.winPct ?? -1}" style="color:${wpColor};font-weight:700;">${c.winPct !== null ? c.winPct + '%' : '—'}</td>
          <td data-sv="${c.units}" style="color:${unitColor};font-weight:700;">${c.total > 0 ? unitStr : '—'}</td>
          <td data-sv="${c.money}" style="color:${moneyColor};font-weight:700;">${c.total > 0 ? moneyStr : '—'}</td>
          ${sportCols}
          <td data-sv="${c.pending || 0}" style="color:#8892a4;font-size:12px;">${c.pending || 0}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    </div>` : `<p class="empty">No capper history yet. Picks appear here after games resolve and results are written.</p>`;

  // Duplicate alerts: today's picks where 2+ distinct cappers called same slot
  const dupAlerts = (() => {
    try {
      return db.prepare(`
        SELECT espn_game_id, team, pick_type, sport,
               GROUP_CONCAT(DISTINCT capper_name) as cappers,
               COUNT(DISTINCT capper_name) as capper_count
        FROM picks
        WHERE capper_name IS NOT NULL AND date(parsed_at) = date('now') AND espn_game_id IS NOT NULL
        GROUP BY espn_game_id, team, pick_type
        HAVING capper_count >= 2
        ORDER BY capper_count DESC
      `).all();
    } catch (_) { return []; }
  })();

  const dupAlertsHtml = dupAlerts.length ? `
    <table>
      <thead><tr><th>Team</th><th>Type</th><th>Sport</th><th>Cappers</th><th>Count</th></tr></thead>
      <tbody>${dupAlerts.map(d => `<tr>
        <td style="font-weight:600;">${d.team}</td>
        <td>${d.pick_type || '—'}</td>
        <td>${d.sport || '—'}</td>
        <td style="font-size:12px;color:#8892a4;">${d.cappers}</td>
        <td style="font-weight:700;color:#f59e0b;">${d.capper_count}</td>
      </tr>`).join('')}</tbody>
    </table>` : `<p class="empty">No duplicate capper picks today.</p>`;

  const aliasTableHtml = allAliases.length ? `
    <table>
      <thead><tr><th>Canonical Name</th><th>Alias</th><th>Created</th><th></th></tr></thead>
      <tbody>${allAliases.map(a => `<tr>
        <td style="font-weight:600;">${a.canonical_name}</td>
        <td style="color:#8892a4;">${a.alias}</td>
        <td style="color:#8892a4;font-size:12px;">${(a.created_at || '').slice(0, 10)}</td>
        <td><button class="btn-sm btn-revoke" onclick="deleteAlias(${a.id})">Delete</button></td>
      </tr>`).join('')}</tbody>
    </table>` : `<p class="empty" style="font-size:13px;">No aliases defined yet.</p>`;

  // ── Messages panel data ───────────────────────────────────────────────────────
  const recentRaw = db.prepare(`
    SELECT rm.id, rm.pick_id, rm.channel, rm.author,
           rm.message_text,
           rm.saved_at,
           p.team, p.pick_type, p.sport, p.spread, p.score, p.capper_name, p.result
    FROM raw_messages rm
    LEFT JOIN picks p ON p.id = rm.pick_id
    ORDER BY rm.saved_at DESC LIMIT 300
  `).all();

  const recentSkipped = db.prepare(`
    SELECT id, message_id, channel, author,
           content, reason, skipped_at
    FROM skipped_messages ORDER BY skipped_at DESC LIMIT 300
  `).all();

  const savedCorrections = (() => {
    try { return db.prepare(`SELECT * FROM reader_corrections ORDER BY created_at DESC LIMIT 100`).all(); }
    catch (_) { return []; }
  })();

  // ── Reader stats ──────────────────────────────────────────────────────────────
  const readerMode = db.getSetting('reader_mode', 'auto');
  // ── Cycle / retention settings ─────────────────────────────────────────────────
  const cycleClearHour = db.getSetting('cycle_clear_hour', '04:58');
  const graceHours     = db.getSetting('post_game_grace_hours', '4');
  const readerTodayRows = (() => {
    try {
      return db.prepare(`
        SELECT path,
               COUNT(*) AS calls,
               SUM(msg_count) AS msgs,
               SUM(pick_count) AS picks,
               ROUND(AVG(latency_ms)) AS avg_ms
        FROM reader_call_log
        WHERE DATE(created_at) = DATE('now')
        GROUP BY path ORDER BY calls DESC
      `).all();
    } catch (_) { return []; }
  })();
  const readerRecentLog = (() => {
    try {
      return db.prepare(`
        SELECT path, msg_count, pick_count, latency_ms, error, created_at
        FROM reader_call_log ORDER BY id DESC LIMIT 40
      `).all();
    } catch (_) { return []; }
  })();
  const localReaderUrl = (process.env.LOCAL_READER_URL || '').replace(/\/$/, '');

  // ── CA Ops Receptions: per-book line freshness + Mac heartbeats ──────────────
  const receptions = (() => { try { return getBookReceptions(); } catch (_) { return { books: [], beats: [] }; } })();
  const recAge = (m) => m == null ? 'never'
    : m < 60 ? `${m}m ago`
    : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m ago`
    : `${Math.floor(m / 1440)}d ago`;
  const recDot = (m) => m == null ? '#64748b' : m <= 60 ? '#4ade80' : m <= 360 ? '#facc15' : '#ef4444';
  const recRowsHtml = receptions.books.map(b => `
    <tr>
      <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${recDot(b.ageMin)};margin-right:8px;"></span><b>${b.book}</b></td>
      <td style="white-space:nowrap;">${b.last_at || '—'}</td>
      <td>${recAge(b.ageMin)}</td>
      <td>${b.games_today || 0}</td>
      <td>${b.sports_today || '—'}</td>
      <td>${b.rows_total}</td>
    </tr>`).join('');
  const beatRowsHtml = receptions.beats.map(b => `
    <tr>
      <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${recDot(b.ageMin)};margin-right:8px;"></span><b>${b.service}</b></td>
      <td style="white-space:nowrap;">${b.last_seen || '—'}</td>
      <td>${recAge(b.ageMin)}</td>
    </tr>`).join('');

  // ── Active tab helper ─────────────────────────────────────────────────────────
  const ta = n => activeTab === n ? ' active' : '';

  res.send(page('Dashboard', `
    <div style="display:flex;align-items:center;margin-bottom:20px;">
      <span class="logo">CappingAlpha Admin</span>
    </div>

    <div class="atabs">
      <button class="atab${ta('picks')}" data-tab="picks" onclick="adminTab('picks')">Today's Picks</button>
      <button class="atab${ta('cappers')}" data-tab="cappers" onclick="adminTab('cappers')">Cappers</button>
      <button class="atab${ta('messages')}" data-tab="messages" onclick="adminTab('messages')">Messages</button>
      <button class="atab${ta('sourcefeed')}" data-tab="sourcefeed" onclick="adminTab('sourcefeed')">Source Feed</button>
      <button class="atab gold${ta('mvp')}" data-tab="mvp" onclick="adminTab('mvp')">MVP History</button>
      <button class="atab${ta('history')}" data-tab="history" onclick="adminTab('history');phAutoLoad()">Pick History</button>
      <button class="atab${ta('codes')}" data-tab="codes" onclick="adminTab('codes')">Access Codes</button>
      <button class="atab${ta('users')}" data-tab="users" onclick="adminTab('users')">Users</button>
      <button class="atab${ta('usage')}" data-tab="usage" onclick="adminTab('usage')">AI Usage</button>
      <button class="atab${ta('archive')}" data-tab="archive" onclick="adminTab('archive');archiveLoad()">Archive (7d)</button>
      <button class="atab${ta('reader')}" data-tab="reader" onclick="adminTab('reader');readerPing()">Reader</button>
      <button class="atab${ta('dummy')}" data-tab="dummy" onclick="adminTab('dummy')">Dummy Accounts</button>
      <button class="atab${ta('receptions')}" data-tab="receptions" onclick="adminTab('receptions')">CA Ops Receptions</button>
      <button class="atab${ta('playbook')}" data-tab="playbook" onclick="adminTab('playbook')">Playbook</button>
      <a href="/admin/preview" class="atab" style="color:#3b82f6;text-decoration:none;">UI Preview</a>
      <a href="/admin/logout" class="atab-logout">Log out</a>
    </div>

    <!-- PLAYBOOK PANEL -->
    <div class="apanel${ta('playbook')}" id="panel-playbook">
      <h1>The CappingAlpha Score: Owner's Playbook</h1>
      <p style="color:#8892a4;font-size:13px;margin:-6px 0 12px;">The full interactive playbook, served live from docs/ALGO_PLAYBOOK.html. <a href="/admin/playbook" target="_blank" style="color:#3b82f6;">Open in its own tab</a></p>
      <iframe src="/admin/playbook" loading="lazy" title="Owner's Playbook"
        style="width:100%;height:calc(100vh - 210px);min-height:520px;border:1px solid #252c3b;border-radius:10px;background:#fff;"></iframe>
    </div>

    <!-- CA OPS RECEPTIONS PANEL -->
    <div class="apanel${ta('receptions')}" id="panel-receptions">
      <h1>CA Ops Receptions</h1>
      <p style="color:#8892a4;font-size:13px;margin:-6px 0 16px;">When each book's lines last landed in book_lines and what they cover on today's board. Green = under 1h, yellow = under 6h, red = older. Timestamps are UTC. Whole-system view lives at <a href="/admin/health" style="color:#3b82f6;">/admin/health</a>.</p>
      <table>
        <thead><tr><th>Book</th><th>Last received (UTC)</th><th>Age</th><th>Games today</th><th>Sports today</th><th>Rows total</th></tr></thead>
        <tbody>${recRowsHtml || `<tr><td colspan="6" style="color:#8892a4;">No book lines stored yet.</td></tr>`}</tbody>
      </table>
      <h2 style="margin-top:24px;">Mac service heartbeats</h2>
      <p style="color:#8892a4;font-size:13px;margin:-4px 0 12px;">One beat per cycle from the Mac-side relays (odds engine, pb-relay). A stale beat means the process is down or its network path to the site is broken.</p>
      <table>
        <thead><tr><th>Service</th><th>Last beat (UTC)</th><th>Age</th></tr></thead>
        <tbody>${beatRowsHtml || `<tr><td colspan="3" style="color:#8892a4;">No heartbeats recorded yet.</td></tr>`}</tbody>
      </table>
    </div>

    <!-- PICKS PANEL -->
    <div class="apanel${ta('picks')}" id="panel-picks">
      <h1>Today's Picks <small style="font-size:14px;color:#8892a4;font-weight:400;">${today}</small></h1>
      ${picksTableHtml}
      <div class="nuke-box" style="display:flex;gap:24px;align-items:flex-start;">
        <div>
          <h2 style="margin-top:0;color:#ef4444;">Actions</h2>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button class="btn btn-nuke" onclick="confirmAction('nuke')">NUKE &amp; RESCAN</button>
            <button class="btn btn-primary" onclick="confirmAction('scan')">Scan Now</button>
            <button class="btn" style="background:#7c3aed;color:#fff;" onclick="confirmAction('rescan')">Rescan From 6am</button>
            <button class="btn" style="background:#0f766e;color:#fff;" onclick="confirmAction('skipped')" id="btn-skipped">Rescan Skipped</button>
            <button class="btn" style="background:#b45309;color:#fff;" onclick="confirmAction('odds')" id="btn-odds">Refresh Odds Now</button>
            <button class="btn" style="background:#1d4ed8;color:#fff;" onclick="confirmAction('fetch-games')" id="btn-fetch-games">Re-fetch Today's Games</button>
          </div>
        </div>
        <div id="scan-status" style="flex:1;background:#0f1117;border:1px solid #252c3b;border-radius:8px;padding:16px;min-height:80px;display:flex;align-items:center;">
          <span style="color:#8892a4;font-size:13px;">Loading scan status...</span>
        </div>
      </div>
    </div>

    <!-- CODES PANEL -->
    <div class="apanel${ta('codes')}" id="panel-codes">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-bottom:28px;">
        <div>
          <h1 style="margin-bottom:6px;">Access Codes</h1>
          <p style="color:#8892a4;font-size:13px;margin:0;max-width:420px;">Create named codes with a custom access length and a user limit. Codes with a limit over 1 are clickable in the table to see who redeemed them.</p>
        </div>
        <!-- Create code -->
        <div style="background:#171b24;border:1px solid #252c3b;border-radius:10px;padding:18px 20px;min-width:340px;">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8892a4;margin-bottom:12px;">Create Code</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
            <div>
              <label style="display:block;font-size:11px;color:#8892a4;margin-bottom:4px;">NAME</label>
              <input type="text" id="cc-name" placeholder="auto if blank" style="font-size:13px;padding:7px 10px;width:150px;text-transform:uppercase;" />
            </div>
            <div>
              <label style="display:block;font-size:11px;color:#8892a4;margin-bottom:4px;">DURATION</label>
              <select id="cc-duration" onchange="ccDurToggle()" style="font-size:13px;padding:7px 10px;">
                <option value="1">1 Day</option>
                <option value="7" selected>7 Days</option>
                <option value="30">30 Days</option>
                <option value="365">1 Year</option>
                <option value="0">Lifetime</option>
                <option value="custom">Custom…</option>
              </select>
            </div>
            <div id="cc-dur-custom-wrap" style="display:none;">
              <label style="display:block;font-size:11px;color:#8892a4;margin-bottom:4px;">DAYS</label>
              <input type="number" id="cc-dur-custom" min="1" value="14" style="font-size:13px;padding:7px 10px;width:80px;" />
            </div>
            <div>
              <label style="display:block;font-size:11px;color:#8892a4;margin-bottom:4px;">USER LIMIT</label>
              <input type="number" id="cc-maxuses" min="0" value="1" style="font-size:13px;padding:7px 10px;width:80px;" />
              <div style="font-size:10px;color:#64748b;margin-top:3px;">0 = unlimited</div>
            </div>
            <div>
              <label style="display:block;font-size:11px;color:#8892a4;margin-bottom:4px;">COUNT</label>
              <input type="number" id="cc-count" min="1" max="50" value="1" style="font-size:13px;padding:7px 10px;width:70px;" />
              <div style="font-size:10px;color:#64748b;margin-top:3px;">blank name only</div>
            </div>
            <div>
              <label style="display:block;font-size:11px;color:#8892a4;margin-bottom:4px;">NOTES</label>
              <input type="text" id="cc-notes" placeholder="optional label" style="font-size:13px;padding:7px 10px;width:130px;" />
            </div>
            <button class="btn btn-primary" style="font-size:13px;padding:8px 16px;" onclick="createCode()">Create</button>
          </div>
          <div id="cc-result" style="margin-top:12px;font-size:12px;color:#8892a4;display:none;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8892a4;margin-bottom:6px;">Created codes</div>
            <div id="cc-codes" style="font-family:monospace;line-height:2;letter-spacing:1px;"></div>
          </div>
        </div>
      </div>

      <h2>All Codes (${codes.length})</h2>
      ${codesTableHtml}
    </div>

    <!-- USERS PANEL -->
    <div class="apanel${ta('users')}" id="panel-users">
      <h1>Users</h1>
      <div class="users-search-bar">
        <input type="text" id="user-q" placeholder="Search username or email..." />
        <button class="btn btn-primary" onclick="searchUsers()">Search</button>
      </div>
      <div id="user-results"><p style="color:#8892a4;">Enter a username or email to search.</p></div>
    </div>

    <!-- DUMMY ACCOUNTS PANEL -->
    <div class="apanel${ta('dummy')}" id="panel-dummy">
      <h1>Dummy Accounts</h1>
      <p style="color:#8892a4;max-width:860px;">Seed members with editable <strong>personalities</strong>. They auto-bet the day's picks and chat on the games they bet, so the leaderboard and game pages aren't empty. They look like real accounts and build a record as games resolve (no backfill). Each personality is independently tunable below: bet volume, which sports, how much comes from the CA rankings, whether they fade the MVPs, and how/when they comment.</p>
      ${dummyAccountsList.length === 0
        ? '<p style="color:#8892a4;">No dummy accounts yet — they seed on the next server start.</p>'
        : `<div style="display:flex;flex-direction:column;gap:14px;margin-top:14px;">
          ${dummyAccountsList.map(d => {
            const inp = 'padding:5px 7px;border-radius:6px;border:1px solid #252c3b;background:#0f1218;color:#e2e8f0;font-size:13px;';
            const lbl = 'display:block;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;';
            const grp = 'display:flex;flex-direction:column;';
            const card = 'background:#11141b;border:1px solid #252c3b;border-radius:10px;padding:14px 16px;';
            const rec = `${d.total_votes} bets · ${d.wins}-${d.losses}${d.pushes ? '-' + d.pushes : ''} <span style="color:#64748b;">(${d.pending} pend)</span> · ${d.comment_count} comments`;
            return `<div style="${card}">
              <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;margin-bottom:12px;">
                <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;">
                  <div style="${grp}"><label style="${lbl}">Username</label><input id="dn-${d.id}" value="${escHtml(d.username)}" maxlength="20" style="${inp}width:150px;" /></div>
                  <div style="${grp}"><label style="${lbl}">Personality</label><input id="dpers-${d.id}" value="${escHtml(d.personality || '')}" maxlength="60" placeholder="e.g. The Fader" style="${inp}width:180px;" /></div>
                  <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#cbd5e1;padding-bottom:6px;"><input type="checkbox" id="dact-${d.id}" ${d.active ? 'checked' : ''} /> Active</label>
                  <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#cbd5e1;padding-bottom:6px;"><input type="checkbox" id="dpub-${d.id}" ${d.is_public ? 'checked' : ''} /> On board</label>
                </div>
                <div style="text-align:right;"><div style="font-size:12px;color:#8892a4;margin-bottom:6px;white-space:nowrap;">${rec}</div><button class="btn-sm btn-primary" onclick="saveDummy(${d.id})">Save</button></div>
              </div>

              <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin:4px 0 8px;border-top:1px solid #1c2230;padding-top:10px;">Betting</div>
              <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;">
                <div style="${grp}"><label style="${lbl}">Picks / day</label><span style="white-space:nowrap;"><input id="dmin-${d.id}" type="number" min="0" max="50" value="${d.min_picks}" style="${inp}width:52px;" /> – <input id="dmax-${d.id}" type="number" min="0" max="50" value="${d.max_picks}" style="${inp}width:52px;" /></span></div>
                <div style="${grp}"><label style="${lbl}">Picks / week (0 = no cap)</label><span style="white-space:nowrap;"><input id="dminw-${d.id}" type="number" min="0" max="300" value="${d.min_week}" style="${inp}width:56px;" /> – <input id="dmaxw-${d.id}" type="number" min="0" max="300" value="${d.max_week}" style="${inp}width:56px;" /></span></div>
                <div style="${grp}"><label style="${lbl}">% from rankings</label><input id="drank-${d.id}" type="number" min="0" max="100" value="${d.ranking_pct}" style="${inp}width:64px;" /></div>
                <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#cbd5e1;padding-bottom:6px;"><input type="checkbox" id="dfade-${d.id}" ${d.fade_mvp ? 'checked' : ''} /> Fade the MVPs</label>
                <div style="${grp};flex:1;min-width:180px;"><label style="${lbl}">Bet sports (blank = all)</label><input id="dsp-${d.id}" value="${escHtml((d.sports || []).join(', '))}" placeholder="all" style="${inp}width:100%;" /></div>
              </div>

              <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px;border-top:1px solid #1c2230;padding-top:10px;">Comments</div>
              <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;">
                <div style="${grp}"><label style="${lbl}">Comment % / game</label><input id="dcpct-${d.id}" type="number" min="0" max="100" value="${d.comment_pct}" style="${inp}width:64px;" /></div>
                <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#cbd5e1;padding-bottom:6px;"><input type="checkbox" id="dcpre-${d.id}" ${d.comment_pre ? 'checked' : ''} /> Pre-game</label>
                <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#cbd5e1;padding-bottom:6px;"><input type="checkbox" id="dcpost-${d.id}" ${d.comment_post ? 'checked' : ''} /> Post-game</label>
                <div style="${grp};flex:1;min-width:180px;"><label style="${lbl}">Comment sports (blank = all)</label><input id="dcsp-${d.id}" value="${escHtml((d.comment_sports || []).join(', '))}" placeholder="all" style="${inp}width:100%;" /></div>
              </div>
              <div style="${grp};margin-top:12px;"><label style="${lbl}">Comment pool — one per line. Tokens: {team} = the side they bet, {sport}. Blank = shared defaults. Post-game uses generic reactions.</label><textarea id="dcomm-${d.id}" rows="3" placeholder="Locked in on {team} tonight." style="${inp}width:100%;resize:vertical;font-family:inherit;">${escHtml((d.comments || []).join('\n'))}</textarea></div>
            </div>`; }).join('')}
        </div>`}
      <p id="dummy-msg" style="color:#8892a4;font-size:13px;margin-top:12px;"></p>
    </div>

    <!-- MVP PANEL -->
    <div class="apanel${ta('mvp')}" id="panel-mvp">
      <h1>MVP History <small style="font-size:14px;color:#8892a4;font-weight:400;">All-time (score &ge; ${mvpDisplayThreshold})</small></h1>
      <div style="background:#1a1f2e;border:1px solid #2a3a5c;border-radius:8px;padding:16px 20px;margin-bottom:20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <span style="font-size:12px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;">Display Threshold</span>
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="number" id="threshold-input" value="${mvpDisplayThreshold}" min="0" max="200" step="5"
            style="width:80px;background:#0f1117;border:1px solid #3b4560;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-size:14px;font-weight:700;text-align:center;" />
          <span style="color:#8892a4;font-size:13px;">pts minimum</span>
        </div>
        <button onclick="saveThreshold()" style="background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:7px 18px;font-size:13px;font-weight:600;cursor:pointer;">Save &amp; Apply</button>
        <span id="threshold-status" style="font-size:12px;color:#8892a4;"></span>
        <span style="margin-left:auto;font-size:11px;color:#3b4560;">Changes what shows on the public MVP page and chart. Save threshold = ${MVP_THRESHOLD} pts (unchanged).</span>
      </div>
      <div style="background:#1a1f2e;border:1px solid #2a3a5c;border-radius:8px;padding:16px 20px;margin-bottom:20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <span style="font-size:12px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;">Bet Size</span>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="color:#8892a4;font-size:13px;">$</span>
          <input type="number" id="bet-unit-input" value="${betUnit}" min="1" max="10000" step="1"
            style="width:80px;background:#0f1117;border:1px solid #3b4560;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-size:14px;font-weight:700;text-align:center;" />
          <span style="color:#8892a4;font-size:13px;">flat unit</span>
        </div>
        <button onclick="saveBetUnit()" style="background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:7px 18px;font-size:13px;font-weight:600;cursor:pointer;">Save &amp; Apply</button>
        <span id="bet-unit-status" style="font-size:12px;color:#8892a4;"></span>
        <span style="margin-left:auto;font-size:11px;color:#3b4560;">Sets the hypothetical bet size shown on the #1 pick card and used for all MVP P/L math.</span>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;background:#171b24;border:1px solid #252c3b;border-radius:8px;padding:14px 16px;">
        <div><label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Date</label>
          <input type="date" id="f-date" oninput="applyFilters()" style="background:#0f1117;border:1px solid #252c3b;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-size:13px;width:150px;" /></div>
        <div><label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Sport</label>
          <select id="f-sport" onchange="applyFilters()" style="background:#0f1117;border:1px solid #252c3b;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-size:13px;"><option value="">All</option>${sportOpts}</select></div>
        <div><label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Pick Type</label>
          <select id="f-type" onchange="applyFilters()" style="background:#0f1117;border:1px solid #252c3b;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-size:13px;"><option value="">All</option>${ptOpts}</select></div>
        <div><label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Result</label>
          <select id="f-result" onchange="applyFilters()" style="background:#0f1117;border:1px solid #252c3b;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-size:13px;">
            <option value="">All</option><option value="win">Win</option><option value="loss">Loss</option><option value="push">Push</option><option value="pending">Pending</option>
          </select></div>
        <div><label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Min Score</label>
          <input type="number" id="f-minscore" oninput="applyFilters()" placeholder="50" min="0" style="background:#0f1117;border:1px solid #252c3b;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-size:13px;width:90px;" /></div>
        <div><label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Max Score</label>
          <input type="number" id="f-maxscore" oninput="applyFilters()" placeholder="any" min="0" style="background:#0f1117;border:1px solid #252c3b;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-size:13px;width:90px;" /></div>
        <div><label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Sort By</label>
          <select id="f-sort" onchange="applyFilters()" style="background:#0f1117;border:1px solid #252c3b;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-size:13px;">
            <option value="date-desc">Date (newest)</option><option value="date-asc">Date (oldest)</option>
            <option value="score-desc">Score (high)</option><option value="score-asc">Score (low)</option>
            <option value="result-asc">Result A-Z</option>
          </select></div>
        <button onclick="clearFilters()" style="background:#252c3b;border:1px solid #3b4560;color:#8892a4;border-radius:6px;padding:7px 14px;font-size:12px;cursor:pointer;align-self:flex-end;">Clear</button>
      </div>
      ${mvpTableHtml}
      <div id="mvp-modal" onclick="closeModal(event)" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:100;overflow-y:auto;">
        <div id="mvp-panel" onclick="event.stopPropagation()" style="background:#171b24;border:1px solid #252c3b;border-radius:12px;max-width:700px;margin:40px auto;padding:32px;position:relative;">
          <button onclick="closePanel()" style="position:absolute;top:16px;right:16px;background:none;border:none;color:#8892a4;font-size:20px;cursor:pointer;">&#x2715;</button>
          <div id="mvp-content">Loading...</div>
        </div>
      </div>
    </div>

    <!-- AI USAGE PANEL -->
    <div class="apanel${ta('usage')}" id="panel-usage">
      ${usagePanelHtml}
    </div>

    <!-- CAPPERS PANEL -->
    <div class="apanel${ta('cappers')}" id="panel-cappers">
      <h1>Capper Leaderboard <small style="font-size:13px;color:#8892a4;font-weight:400;">All-time &middot; stored permanently</small></h1>
      ${capperLeaderboardHtml}

      <h2 style="margin-top:28px;">Today's Duplicate Picks</h2>
      <p style="color:#8892a4;font-size:13px;margin-bottom:12px;">Picks where 2+ different cappers called the exact same slot today.</p>
      ${dupAlertsHtml}

      <h2 style="margin-top:28px;">Suggested Matches</h2>
      <p style="color:#8892a4;font-size:13px;margin-bottom:12px;">Names that look like duplicates. Hit <strong>Match</strong> to merge the recorded name into the larger one, or <strong>Not a match</strong> to dismiss it.</p>
      ${suggestionsHtml}

      <h2 style="margin-top:28px;">Merge Two Names</h2>
      <p style="color:#8892a4;font-size:13px;margin-bottom:12px;">Pick the variant you saw recorded and the main name it should roll into. Start typing to autocomplete from real recorded names.</p>
      <datalist id="capper-names">${capperNameOptions}</datalist>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
        <div>
          <label style="display:block;margin-bottom:4px;font-size:12px;color:#8892a4;">Recorded / variant name</label>
          <input type="text" id="alias-alias" list="capper-names" placeholder="e.g. Doc Sports" style="width:220px;" />
        </div>
        <span style="color:#8892a4;padding-bottom:8px;">&rarr; merges into &rarr;</span>
        <div>
          <label style="display:block;margin-bottom:4px;font-size:12px;color:#8892a4;">Main (canonical) name</label>
          <input type="text" id="alias-canonical" list="capper-names" placeholder="e.g. Docs Sports" style="width:220px;" />
        </div>
        <button class="btn btn-primary" onclick="addAlias()">Merge</button>
      </div>
      <p id="alias-msg" style="font-size:13px;color:#8892a4;margin-top:8px;"></p>

      <h2 style="margin-top:28px;">Current Aliases</h2>
      <p style="color:#8892a4;font-size:13px;margin-bottom:12px;">Every variant currently linked to a main name. Delete to unlink.</p>
      ${aliasTableHtml}
    </div>

    <!-- MESSAGES PANEL -->
    <div class="apanel${ta('sourcefeed')}" id="panel-sourcefeed">
      <h1>Source Feed</h1>
      <p style="color:#8892a4;font-size:12px;margin-bottom:14px;">Every pick recorded by the structured-data scrapers (no message scanner): Action Network experts, Polymarket wallets, Covers contests. Track-only rows, graded like everything else. Newest first, last 400.</p>
      <div style="margin-bottom:14px;display:flex;gap:10px;align-items:center;">
        <input type="text" id="feed-search" placeholder="Filter by capper, team, or sport..." oninput="filterFeedTable()" style="max-width:380px;flex:1;" />
        <select id="feed-src-filter" onchange="filterFeedTable()" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px;">
          <option value="">All sources</option>
          <option value="actionnetwork">Action Network</option>
          <option value="polymarket">Polymarket</option>
          <option value="covers">Covers</option>
        </select>
        <span style="color:#8892a4;font-size:12px;">${sourceFeed.length} picks recorded</span>
      </div>
      ${sourceFeed.length ? `
      <table id="feed-table">
        <thead><tr><th>Time in</th><th>Source</th><th>Capper</th><th>Sport</th><th>Bet recorded</th><th>Game</th><th>Extra</th><th>Result</th></tr></thead>
        <tbody>
          ${sourceFeed.map(r => {
            const ts = (r.saved_at || '').slice(0, 16).replace('T', ' ');
            const SRC = { actionnetwork: ['AN', '#16a34a'], polymarket: ['PM', '#8b5cf6'], covers: ['CV', '#f59e0b'] };
            const [srcLabel, srcColor] = SRC[r.source] || [r.source, '#8892a4'];
            const srcChip = `<span style="background:${srcColor}22;color:${srcColor};border:1px solid ${srcColor}44;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:800;">${srcLabel}</span>`;
            const pt = (r.pick_type || '').toUpperCase();
            const lineStr = r.spread != null ? ' ' + (r.pick_type === 'over' || r.pick_type === 'under' ? Math.abs(r.spread) : (r.spread > 0 ? '+' + r.spread : r.spread)) : '';
            const oddsStr = (r.odds != null && !isNaN(parseFloat(r.odds))) ? ' @ ' + (parseFloat(r.odds) > 0 ? '+' + Math.round(r.odds) : Math.round(r.odds)) : '';
            const bet = `<span style="font-weight:600;">${escHtml(r.team || '—')}</span> <span style="color:#8892a4;">${pt}${lineStr}${oddsStr}</span>`;
            const game = r.g_home ? `${escHtml(r.g_away || '')} @ ${escHtml(r.g_home || '')}` : `<span style="color:#8892a4;">${escHtml(r.game_date || '—')}</span>`;
            let extra = [];
            try {
              const prov = JSON.parse(r.sources_json || '[]');
              const m = prov[0]?.meta || {};
              if (m.units != null) extra.push(m.units + 'u');
              if (m.notional_usd != null) extra.push('$' + m.notional_usd);
              if (m.verified) extra.push('verified');
              if (m.is_live || prov[0]?.live) extra.push('<span style="color:#f59e0b;">live</span>');
              if (m.contest) extra.push(escHtml(m.contest));
              if (prov.length > 1) extra.push(prov.length + ' systems');
            } catch (_) {}
            const rl = (r.result || 'pending').toLowerCase();
            const rColor = { win: '#16a34a', loss: '#ef4444', push: '#8892a4', pending: '#f59e0b' }[rl] || '#8892a4';
            return `<tr class="feed-row" data-src="${escHtml(r.source || '')}" data-text="${escHtml(((r.capper_name || '') + ' ' + (r.team || '') + ' ' + (r.sport || '')).toLowerCase())}">
              <td style="font-size:11px;color:#8892a4;white-space:nowrap;">${ts}</td>
              <td>${srcChip}</td>
              <td style="font-size:12px;font-weight:600;white-space:nowrap;cursor:pointer;color:#93c5fd;" data-capper="${escHtml(r.capper_name || '')}" onclick="showCapperDetail(this.getAttribute('data-capper'))">${escHtml(r.capper_name || '—')}</td>
              <td style="font-size:12px;color:#8892a4;">${escHtml(r.sport || '—')}</td>
              <td style="font-size:12px;">${bet}</td>
              <td style="font-size:12px;">${game}</td>
              <td style="font-size:11px;color:#8892a4;">${extra.join(' · ') || '—'}</td>
              <td><span style="background:${rColor}22;color:${rColor};border:1px solid ${rColor}44;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700;">${rl.toUpperCase()}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : '<div class="empty">No source picks recorded yet. The scrapers write here as they run (server only).</div>'}
    </div>

    <div class="apanel${ta('messages')}" id="panel-messages">
      <h1>Messages</h1>
      <div style="display:flex;gap:4px;margin-bottom:20px;background:#171b24;border:1px solid #252c3b;border-radius:8px;padding:4px;width:fit-content;">
        <button class="atab active" id="msec-btn-recorded" onclick="showMsgSection('recorded')">Recorded <span style="background:#252c3b;border-radius:4px;padding:1px 6px;font-size:11px;margin-left:4px;">${recentRaw.length}</span></button>
        <button class="atab" id="msec-btn-skipped" onclick="showMsgSection('skipped')">Skipped <span style="background:#252c3b;border-radius:4px;padding:1px 6px;font-size:11px;margin-left:4px;">${recentSkipped.length}</span></button>
        <button class="atab" id="msec-btn-corrections" onclick="showMsgSection('corrections')">Corrections <span style="background:#252c3b;border-radius:4px;padding:1px 6px;font-size:11px;margin-left:4px;">${savedCorrections.length}</span></button>
      </div>

      <!-- search bar shared -->
      <div style="margin-bottom:14px;display:flex;gap:10px;align-items:center;">
        <input type="text" id="msg-search" placeholder="Filter by author, channel, or text..." oninput="filterMsgTable()" style="max-width:380px;flex:1;" />
        <select id="msg-ch-filter" onchange="filterMsgTable()" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px;">
          <option value="">All channels</option>
          <option value="free-plays">free-plays</option>
          <option value="community-leaks">community-leaks</option>
          <option value="pod-thread">pod-thread</option>
        </select>
      </div>

      <!-- RECORDED -->
      <div id="msec-recorded">
        ${recentRaw.length ? `
        <table id="raw-table">
          <thead><tr><th>Time</th><th>Channel</th><th>Author</th><th>Message</th><th>Team Extracted</th><th>Capper Extracted</th><th></th></tr></thead>
          <tbody>
            ${recentRaw.map(r => {
              const ts   = (r.saved_at || '').slice(0, 16).replace('T', ' ');
              const prev = escHtml((r.message_text || '').replace(/\n/g, ' ').slice(0, 60));
              const teamInfo = r.team
                ? `${escHtml(r.team)} ${escHtml(r.pick_type || '')}${r.spread != null ? ' ' + r.spread : ''} · ${escHtml(r.sport || '')} · ${r.score ?? '—'}pts`
                : '<span style="color:#3b4560;">no team extracted</span>';
              const capperInfo = r.capper_name
                ? `<span style="font-size:12px;">${escHtml(r.capper_name)}</span> ${knownCapperSet.has(normalizeCapper(r.capper_name)) ? '<span class="badge match-ok">matched</span>' : '<span class="badge match-new">new</span>'}`
                : '<span style="color:#3b4560;">no capper extracted</span>';
              // All click data goes through data-* attrs (HTML-safe) so apostrophes
              // and JSON double-quotes can't break the JS string literal that used
              // to live inline in onclick="…".
              const correctBtn = r.pick_id
                ? `<button class="btn-sm btn-primary" data-pick-id="${r.pick_id}" data-capper="${escHtml(r.capper_name || '')}" onclick="event.stopPropagation();correctCapperFromBtn(this)">Correct</button>`
                : '<span style="color:#3b4560;font-size:11px;">—</span>';
              return `<tr class="msg-row" data-ch="${escHtml(r.channel || '')}" data-author="${escHtml(r.author || '')}" data-text="${prev.toLowerCase()}">
                <td style="font-size:11px;color:#8892a4;white-space:nowrap;">${ts}</td>
                <td><span style="font-size:11px;color:#8892a4;">${escHtml(r.channel || '—')}</span></td>
                <td style="font-size:12px;">${escHtml(r.author || '—')}</td>
                <td style="font-size:12px;max-width:240px;word-break:break-word;cursor:pointer;color:#93c5fd;" onclick="showMsg(${r.id},'raw')" title="Click to view full message">${prev}${(r.message_text || '').length > 60 ? '…' : ''}</td>
                <td style="font-size:12px;">${teamInfo}</td>
                <td class="capper-cell" data-pick-id="${r.pick_id || ''}">${capperInfo}</td>
                <td>${correctBtn}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>` : '<div class="empty">No recorded messages yet.</div>'}
      </div>

      <!-- SKIPPED -->
      <div id="msec-skipped" style="display:none;">
        ${recentSkipped.length ? `
        <table id="skip-table">
          <thead><tr><th>Time</th><th>Channel</th><th>Author</th><th>Message</th><th>Reason</th><th></th></tr></thead>
          <tbody>
            ${recentSkipped.map(s => {
              const ts   = (s.skipped_at || '').slice(0, 16).replace('T', ' ');
              const prev = escHtml((s.content || '').replace(/\n/g, ' ').slice(0, 60));
              return `<tr class="msg-row" data-ch="${escHtml(s.channel || '')}" data-author="${escHtml(s.author || '')}" data-text="${prev.toLowerCase()}">
                <td style="font-size:11px;color:#8892a4;white-space:nowrap;">${ts}</td>
                <td><span style="font-size:11px;color:#8892a4;">${escHtml(s.channel || '—')}</span></td>
                <td style="font-size:12px;">${escHtml(s.author || '—')}</td>
                <td style="font-size:12px;max-width:280px;word-break:break-word;cursor:pointer;color:#93c5fd;" onclick="showMsg(${s.id},'skip')" title="Click to view full message">${prev}${(s.content || '').length > 60 ? '…' : ''}</td>
                <td><span style="font-size:11px;color:#f59e0b;">${escHtml(s.reason || '—')}</span></td>
                <td><button class="btn-sm btn-primary" data-msg="${escHtml(s.content || '')}" data-channel="${escHtml(s.channel || '')}" data-author="${escHtml(s.author || '')}" onclick="openCorrModal(this.getAttribute('data-msg'),this.getAttribute('data-channel'),this.getAttribute('data-author'),'skipped',null)">Correct</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>` : '<div class="empty">No skipped messages yet.</div>'}
      </div>

      <!-- CORRECTIONS -->
      <div id="msec-corrections" style="display:none;">
        <p style="color:#8892a4;font-size:13px;margin-bottom:12px;">Top 25 by most recent are injected into every Haiku call automatically. No redeploy needed.</p>
        ${savedCorrections.length ? `
        <table>
          <thead><tr><th>Date</th><th>Source</th><th>Message</th><th>Correct Extraction</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            ${savedCorrections.map(c => {
              const picks = JSON.parse(c.correct_picks || '[]');
              const pStr = c.is_no_pick ? '<em style="color:#8892a4;">not a pick</em>'
                : picks.map(p => `${escHtml(p.team || '')} ${escHtml(p.pick_type || '')}${p.sport ? ' · ' + escHtml(p.sport) : ''}`).join('<br>');
              const prev = escHtml((c.message_text || '').replace(/\n/g, ' ').slice(0, 70));
              return `<tr>
                <td style="font-size:11px;color:#8892a4;">${(c.created_at || '').slice(0, 10)}</td>
                <td><span style="font-size:11px;color:#8892a4;">${escHtml(c.source || '—')}</span></td>
                <td style="font-size:12px;max-width:220px;word-break:break-word;">${prev}…</td>
                <td style="font-size:12px;">${pStr}</td>
                <td style="font-size:11px;color:#8892a4;max-width:160px;">${escHtml(c.notes || '—')}</td>
                <td><button class="btn-sm btn-revoke" onclick="deleteCorrection(${c.id})">Delete</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>` : '<div class="empty">No corrections saved yet.</div>'}
      </div>
    </div>

    <!-- ARCHIVE PANEL (7-day rolling log of scanned messages that produced a pick) -->
    <div class="apanel${ta('archive')}" id="panel-archive">
      <h1>Message Archive <small style="font-size:14px;color:#8892a4;font-weight:400;">Last 7 days &middot; every scanned message that produced a pick</small></h1>
      <p style="color:#8892a4;font-size:13px;margin-bottom:16px;">Lets you audit capper-name extraction after the daily raw_messages wipe. Filter by capper, channel, or date to debug missed matches.</p>

      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;background:#171b24;border:1px solid #252c3b;border-radius:8px;padding:14px 16px;">
        <div>
          <label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Capper</label>
          <input type="text" id="ar-capper" placeholder="any" oninput="archiveLoad()" style="font-size:13px;padding:6px 10px;width:160px;" />
        </div>
        <div>
          <label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Channel</label>
          <select id="ar-channel" onchange="archiveLoad()" style="font-size:13px;padding:6px 10px;">
            <option value="">All</option>
            <option value="free-plays">free-plays</option>
            <option value="community-leaks">community-leaks</option>
            <option value="pod-thread">pod-thread</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Match</label>
          <select id="ar-match" onchange="archiveLoad()" style="font-size:13px;padding:6px 10px;">
            <option value="">All</option>
            <option value="matched">matched</option>
            <option value="new">new</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">From</label>
          <input type="date" id="ar-from" onchange="archiveLoad()" style="font-size:13px;padding:6px 10px;" />
        </div>
        <div>
          <label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">To</label>
          <input type="date" id="ar-to" onchange="archiveLoad()" style="font-size:13px;padding:6px 10px;" />
        </div>
        <button onclick="archiveClear()" style="background:#252c3b;border:1px solid #3b4560;color:#8892a4;border-radius:6px;padding:7px 14px;font-size:12px;cursor:pointer;">Clear</button>
        <span id="ar-count" style="margin-left:auto;color:#8892a4;font-size:12px;"></span>
      </div>

      <div id="ar-body"><div class="empty">Loading…</div></div>
    </div>

    <!-- PICK HISTORY PANEL -->
    <div class="apanel${ta('history')}" id="panel-history">
      <h1>Pick History <small style="font-size:14px;color:#8892a4;font-weight:400;">All picks &ge;35 pts &mdash; permanent archive</small></h1>

      <!-- Filters -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center;">
        <select id="ph-sport" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px;">
          <option value="">All Sports</option>
          <option value="MLB">MLB</option>
          <option value="NBA">NBA</option>
          <option value="WNBA">WNBA</option>
          <option value="NHL">NHL</option>
          <option value="NFL">NFL</option>
          <option value="NCAAF">NCAAF</option>
          <option value="CBB">CBB</option>
          <option value="Tennis">Tennis (ATP + WTA)</option>
          <option value="ATP">ATP</option>
          <option value="WTA">WTA</option>
        </select>
        <select id="ph-result" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px;">
          <option value="">All Results</option>
          <option value="win">Win</option>
          <option value="loss">Loss</option>
          <option value="push">Push</option>
          <option value="pending">Pending</option>
        </select>
        <select id="ph-type" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px;">
          <option value="">All Types</option>
          <option value="ml">Win</option>
          <option value="spread">Spread</option>
          <option value="over">Over</option>
          <option value="under">Under</option>
        </select>
        <span style="color:#8892a4;font-size:12px;white-space:nowrap;">Pts</span>
        <input type="number" id="ph-pts-min" placeholder="min" oninput="phFilter()" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:8px 10px;border-radius:6px;font-size:13px;width:72px;" title="Minimum points (e.g. 35)" />
        <span style="color:#8892a4;font-size:12px;">to</span>
        <input type="number" id="ph-pts-max" placeholder="max" oninput="phFilter()" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:8px 10px;border-radius:6px;font-size:13px;width:72px;" title="Maximum points (e.g. 45)" />
        <span style="color:#8892a4;font-size:12px;white-space:nowrap;">From</span>
        <input type="date" id="ph-date-from" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px;" title="Start date (leave blank for all time)" />
        <span style="color:#8892a4;font-size:12px;">to</span>
        <input type="date" id="ph-date-to" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px;" title="End date (leave blank for all time)" />
        <input type="text" id="ph-search" placeholder="Search team or capper..." oninput="phFilter()" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px;min-width:200px;" />
        <select id="ph-limit" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px;">
          <option value="100">100 rows</option>
          <option value="250">250 rows</option>
          <option value="500" selected>500 rows</option>
        </select>
        <button class="btn btn-primary" onclick="phLoad()">Load</button>
        <span id="ph-count" style="color:#8892a4;font-size:13px;"></span>
      </div>

      <!-- Record summary strip (appears after load) -->
      <div id="ph-record" style="display:none;background:#171b24;border:1px solid #252c3b;border-radius:8px;padding:12px 18px;margin-bottom:16px;display:none;gap:24px;flex-wrap:wrap;">
        <span style="font-size:13px;color:#8892a4;">Filtered: </span>
        <span style="font-size:13px;color:#16a34a;font-weight:700;" id="ph-rec-w">0W</span>
        <span style="font-size:13px;color:#ef4444;font-weight:700;" id="ph-rec-l">0L</span>
        <span style="font-size:13px;color:#f59e0b;font-weight:700;" id="ph-rec-p">0P</span>
        <span style="font-size:13px;color:#8892a4;" id="ph-rec-rate"></span>
      </div>

      <div id="ph-table-wrap">
        <p class="empty">Select filters and click Load.</p>
      </div>
    </div>

    <!-- ACTION CONFIRM MODAL -->
    <div id="action-modal" onclick="if(event.target===this)closeActionModal()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:300;align-items:center;justify-content:center;">
      <div style="background:#171b24;border:1px solid #252c3b;border-radius:12px;max-width:480px;width:90%;padding:28px;position:relative;">
        <button onclick="closeActionModal()" style="position:absolute;top:14px;right:16px;background:none;border:none;color:#8892a4;font-size:20px;cursor:pointer;">&#x2715;</button>
        <h2 id="action-modal-title" style="margin-bottom:14px;font-size:18px;">Confirm Action</h2>
        <p id="action-modal-body" style="color:#c8d3e0;font-size:14px;margin-bottom:12px;line-height:1.6;"></p>
        <div style="background:#0f1117;border:1px solid #b45309;border-radius:6px;padding:10px 14px;margin-bottom:18px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#f59e0b;margin-bottom:4px;">API Cost</div>
          <p id="action-modal-cost" style="color:#fbbf24;font-size:13px;margin:0;line-height:1.5;"></p>
        </div>
        <div id="action-modal-typed-row" style="margin-bottom:16px;">
          <label id="action-modal-confirm-label" style="display:block;font-size:12px;font-weight:700;color:#ef4444;margin-bottom:6px;letter-spacing:.05em;"></label>
          <input type="text" id="action-modal-typed" placeholder="NUKE" style="width:100%;font-size:14px;border-color:#7f1d1d;color:#fca5a5;" />
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button onclick="closeActionModal()" style="padding:9px 20px;border-radius:6px;border:1px solid #252c3b;background:none;color:#8892a4;font-family:inherit;font-size:14px;cursor:pointer;">Cancel</button>
          <button id="action-modal-btn" style="padding:9px 20px;border-radius:6px;border:none;color:#fff;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;">Confirm</button>
        </div>
      </div>
    </div>

    <!-- READER PANEL -->
    <div class="apanel${ta('reader')}" id="panel-reader">
      <h1>Reader <small style="font-size:13px;color:#8892a4;font-weight:400;">Extraction path control &amp; performance</small></h1>

      <!-- Status + Mode -->
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:28px;align-items:flex-start;">
        <!-- Mac status card -->
        <div style="background:#171b24;border:1px solid #252c3b;border-radius:10px;padding:18px 22px;min-width:240px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8892a4;margin-bottom:10px;">Mac Reader (Ollama)</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <span id="reader-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#64748b;"></span>
            <span id="reader-status-text" style="font-size:14px;font-weight:600;color:#8892a4;">Checking...</span>
          </div>
          <div id="reader-model-line" style="font-size:12px;color:#64748b;"></div>
          <div id="reader-url-line" style="font-size:11px;color:#374151;margin-top:4px;word-break:break-all;">${escHtml(localReaderUrl || '(LOCAL_READER_URL not set)')}</div>
          <button onclick="readerPing()" style="margin-top:12px;padding:5px 14px;border-radius:6px;border:1px solid #252c3b;background:#1e2330;color:#8892a4;font-family:inherit;font-size:12px;cursor:pointer;">Ping</button>
        </div>

        <!-- Mode toggle -->
        <div style="background:#171b24;border:1px solid #252c3b;border-radius:10px;padding:18px 22px;min-width:260px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8892a4;margin-bottom:12px;">Extraction Mode</div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${['auto','mac','haiku'].map(m => `
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:8px 12px;border-radius:6px;border:1px solid ${readerMode===m?'#3b82f6':'#252c3b'};background:${readerMode===m?'rgba(59,130,246,0.08)':'transparent'};" id="reader-mode-label-${m}">
              <input type="radio" name="reader-mode" value="${m}" ${readerMode===m?'checked':''} onchange="setReaderMode('${m}')" style="accent-color:#3b82f6;" />
              <div>
                <div style="font-size:13px;font-weight:600;color:#e2e8f0;">${m === 'auto' ? 'Auto (Mac → Haiku fallback)' : m === 'mac' ? 'Mac only (no Haiku fallback)' : 'Haiku only (skip Mac)'}</div>
                <div style="font-size:11px;color:#64748b;">${m === 'auto' ? 'Default — tries Mac first, falls back if unreachable' : m === 'mac' ? 'Local only — returns no picks if Mac is down' : 'Always use Claude API — ignores Mac'}</div>
              </div>
            </label>`).join('')}
          </div>
          <p id="reader-mode-msg" style="font-size:12px;color:#8892a4;margin-top:8px;"></p>
        </div>

        <!-- Cycle / retention -->
        <div style="background:#171b24;border:1px solid #252c3b;border-radius:10px;padding:18px 22px;min-width:260px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8892a4;margin-bottom:12px;">Cycle / Retention</div>
          <div style="display:flex;flex-direction:column;gap:10px;">
            <label style="font-size:12px;color:#e2e8f0;">Daily clear (ET, HH:MM)
              <input id="cycle-clear-hour" type="text" value="${escHtml(cycleClearHour)}" placeholder="04:58"
                style="margin-top:4px;width:100%;padding:6px 8px;border-radius:6px;border:1px solid #252c3b;background:#0f1218;color:#e2e8f0;" />
            </label>
            <label style="font-size:12px;color:#e2e8f0;">Late-game grace (hours past end)
              <input id="cycle-grace-hours" type="number" min="0" max="24" step="0.5" value="${escHtml(graceHours)}"
                style="margin-top:4px;width:100%;padding:6px 8px;border-radius:6px;border:1px solid #252c3b;background:#0f1218;color:#e2e8f0;" />
            </label>
            <button onclick="saveCycleSettings()"
              style="padding:7px 12px;border-radius:6px;border:1px solid #3b82f6;background:rgba(59,130,246,0.12);color:#e2e8f0;cursor:pointer;font-size:13px;">Save</button>
          </div>
          <div style="font-size:11px;color:#64748b;margin-top:8px;">Finished games stay until the clear time the morning after their game day, plus the grace tail.</div>
          <p id="cycle-settings-msg" style="font-size:12px;color:#8892a4;margin-top:6px;"></p>
        </div>
      </div>

      <!-- Today's stats -->
      <h2 style="margin-top:0;">Today's Call Breakdown</h2>
      ${(() => {
        if (!readerTodayRows.length) return '<div class="empty">No calls logged today yet.</div>';
        const pathLabel = p => p === 'mac' ? 'Mac (Ollama)' : p === 'haiku' ? 'Haiku (direct)' : p === 'haiku-fallback' ? 'Haiku (fallback)' : p === 'mac-fail' ? 'Mac (failed)' : p;
        const pathColor = p => p === 'mac' ? '#34d399' : p === 'haiku' ? '#60a5fa' : p === 'haiku-fallback' ? '#fbbf24' : p === 'mac-fail' ? '#ef4444' : '#8892a4';
        return `<table style="margin-bottom:24px;">
          <thead><tr><th>Path</th><th>Calls</th><th>Messages</th><th>Picks Found</th><th>Avg Latency</th></tr></thead>
          <tbody>${readerTodayRows.map(r => `<tr>
            <td><span style="color:${pathColor(r.path)};font-weight:600;">${pathLabel(r.path)}</span></td>
            <td>${r.calls}</td><td>${r.msgs || 0}</td><td>${r.picks || 0}</td>
            <td style="color:#8892a4;">${r.avg_ms ? r.avg_ms + 'ms' : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>`;
      })()}

      <!-- Recent call log -->
      <h2>Recent Calls (last 40)</h2>
      ${(() => {
        if (!readerRecentLog.length) return '<div class="empty">No calls logged yet.</div>';
        const pathLabel = p => p === 'mac' ? 'Mac' : p === 'haiku' ? 'Haiku' : p === 'haiku-fallback' ? 'Haiku↩' : p === 'mac-fail' ? 'Mac✗' : p;
        const pathColor = p => p === 'mac' ? '#34d399' : p === 'haiku' ? '#60a5fa' : p === 'haiku-fallback' ? '#fbbf24' : p === 'mac-fail' ? '#ef4444' : '#8892a4';
        return `<table>
          <thead><tr><th>Time</th><th>Path</th><th>Msgs</th><th>Picks</th><th>Latency</th><th>Error</th></tr></thead>
          <tbody>${readerRecentLog.map(r => `<tr>
            <td style="color:#64748b;font-size:12px;">${(r.created_at||'').slice(11,19)}</td>
            <td><span style="font-weight:600;color:${pathColor(r.path)};">${pathLabel(r.path)}</span></td>
            <td>${r.msg_count}</td>
            <td>${r.pick_count}</td>
            <td style="color:#8892a4;">${r.latency_ms != null ? r.latency_ms + 'ms' : '—'}</td>
            <td style="color:#ef4444;font-size:11px;max-width:300px;word-break:break-word;">${r.error ? escHtml(r.error) : ''}</td>
          </tr>`).join('')}</tbody>
        </table>`;
      })()}
    </div>

    <!-- CORRECTION MODAL -->
    <div id="corr-modal" onclick="closeCorrModal(event)" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:200;overflow-y:auto;">
      <div onclick="event.stopPropagation()" style="background:#171b24;border:1px solid #252c3b;border-radius:12px;max-width:640px;margin:40px auto;padding:28px;position:relative;">
        <button onclick="closeCorrModal()" style="position:absolute;top:14px;right:16px;background:none;border:none;color:#8892a4;font-size:20px;cursor:pointer;">&#x2715;</button>
        <h2 style="font-size:15px;margin-bottom:12px;">Add Correction</h2>
        <div style="background:#0f1117;border:1px solid #252c3b;border-radius:6px;padding:12px;margin-bottom:16px;font-size:12px;color:#8892a4;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;" id="corr-msg-preview"></div>
        <input type="hidden" id="corr-msg-full" /><input type="hidden" id="corr-channel" /><input type="hidden" id="corr-author" /><input type="hidden" id="corr-source" />
        <div style="display:flex;gap:16px;margin-bottom:14px;align-items:center;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="radio" name="corr-type" value="pick" checked onchange="toggleCorrType('pick')" /> Has picks
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="radio" name="corr-type" value="nopick" onchange="toggleCorrType('nopick')" /> Not a pick (should be skipped)
          </label>
        </div>
        <div id="corr-picks-section">
          <div id="corr-pick-rows"></div>
          <button onclick="addCorrPickRow()" style="background:#252c3b;border:1px solid #3b4560;color:#8892a4;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;margin-bottom:14px;">+ Add another pick</button>
        </div>
        <div style="margin-bottom:14px;">
          <label style="display:block;font-size:11px;color:#8892a4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Notes (what was wrong / what pattern to learn)</label>
          <textarea id="corr-notes" rows="2" placeholder="e.g. ✅ before name = capper header, not a pick" style="width:100%;background:#0f1117;border:1px solid #252c3b;color:#e2e8f0;padding:8px 10px;border-radius:6px;font-size:13px;font-family:inherit;resize:vertical;"></textarea>
        </div>
        <div style="display:flex;gap:10px;align-items:center;">
          <button onclick="submitCorrection()" class="btn btn-primary">Save Correction</button>
          <span id="corr-status" style="font-size:13px;color:#8892a4;"></span>
        </div>
      </div>
    </div>

    <!-- CAPPER DETAIL MODAL -->
    <div id="capper-modal" onclick="if(event.target===this)document.getElementById('capper-modal').style.display='none'" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:250;align-items:center;justify-content:center;">
      <div onclick="event.stopPropagation()" style="background:#171b24;border:1px solid #252c3b;border-radius:12px;max-width:720px;width:92%;max-height:85vh;padding:28px;position:relative;display:flex;flex-direction:column;overflow:hidden;">
        <button onclick="document.getElementById('capper-modal').style.display='none'" style="position:absolute;top:14px;right:16px;background:none;border:none;color:#8892a4;font-size:20px;cursor:pointer;z-index:1;">&#x2715;</button>
        <div id="capper-modal-content" style="overflow-y:auto;flex:1;">Loading...</div>
      </div>
    </div>

    <!-- CODE REDEMPTIONS MODAL -->
    <div id="code-users-modal" onclick="if(event.target===this)closeCodeUsers()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:260;align-items:center;justify-content:center;">
      <div onclick="event.stopPropagation()" style="background:#171b24;border:1px solid #252c3b;border-radius:12px;max-width:640px;width:92%;max-height:85vh;padding:28px;position:relative;display:flex;flex-direction:column;overflow:hidden;">
        <button onclick="closeCodeUsers()" style="position:absolute;top:14px;right:16px;background:none;border:none;color:#8892a4;font-size:20px;cursor:pointer;z-index:1;">&#x2715;</button>
        <div id="code-users-content" style="overflow-y:auto;flex:1;">Loading...</div>
      </div>
    </div>

    <!-- Message full-text viewer modal -->
    <div id="msg-view-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:2000;align-items:center;justify-content:center;" onclick="if(event.target===this)closeMsgView()">
      <div style="background:#171b24;border:1px solid #252c3b;border-radius:12px;padding:24px;max-width:640px;width:92%;max-height:80vh;display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div id="msg-view-meta" style="font-size:12px;color:#8892a4;"></div>
          <button onclick="closeMsgView()" style="background:none;border:none;color:#8892a4;font-size:20px;cursor:pointer;line-height:1;">×</button>
        </div>
        <pre id="msg-view-body" style="background:#0f1117;border:1px solid #252c3b;border-radius:8px;padding:14px;font-size:13px;line-height:1.6;color:#e2e8f0;white-space:pre-wrap;word-break:break-word;overflow-y:auto;max-height:55vh;margin:0;font-family:inherit;"></pre>
      </div>
    </div>

    <script>
      // ── Message lookup maps (full text, safe JSON) ────────────────────────────
      const SKIP_MSGS = ${JSON.stringify(Object.fromEntries(recentSkipped.map(s => [s.id, { text: s.content || '', author: s.author || '', channel: s.channel || '', reason: s.reason || '' }]))).replace(/<\/script>/gi, '<\\/script>')};
      const RAW_MSGS  = ${JSON.stringify(Object.fromEntries(recentRaw.map(r => [r.id, { text: r.message_text || '', author: r.author || '', channel: r.channel || '' }]))).replace(/<\/script>/gi, '<\\/script>')};

      function showMsg(id, table) {
        const m = table === 'skip' ? SKIP_MSGS[id] : RAW_MSGS[id];
        if (!m) return;
        document.getElementById('msg-view-meta').textContent =
          (m.author || '—') + ' · ' + (m.channel || '—') + (m.reason ? ' · reason: ' + m.reason : '');
        document.getElementById('msg-view-body').textContent = m.text;
        document.getElementById('msg-view-modal').style.display = 'flex';
      }
      function closeMsgView() { document.getElementById('msg-view-modal').style.display = 'none'; }

      // ── Tab switching ──────────────────────────────────────────────────────────
      function adminTab(name) {
        document.querySelectorAll('.atab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
        document.querySelectorAll('.apanel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
        history.replaceState(null, '', '/admin/dashboard?tab=' + name);
      }

      // ── Dummy accounts ──────────────────────────────────────────────────────────
      async function saveDummy(id) {
        const msg = document.getElementById('dummy-msg');
        const v = (p) => document.getElementById(p + '-' + id).value;
        const c = (p) => document.getElementById(p + '-' + id).checked;
        const body = {
          id,
          username:       (v('dn') || '').trim(),
          personality:    v('dpers'),
          min_picks:      v('dmin'),
          max_picks:      v('dmax'),
          min_week:       v('dminw'),
          max_week:       v('dmaxw'),
          ranking_pct:    v('drank'),
          fade_mvp:       c('dfade'),
          sports:         v('dsp'),
          comment_pct:    v('dcpct'),
          comment_pre:    c('dcpre'),
          comment_post:   c('dcpost'),
          comment_sports: v('dcsp'),
          comments:       v('dcomm'),
          active:         c('dact'),
          is_public:      c('dpub'),
        };
        try {
          const r = await fetch('/admin/api/dummy/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
          const d = await r.json();
          msg.textContent = d.ok ? ('Saved @' + body.username) : (d.error || 'Save failed');
          msg.style.color = d.ok ? '#22c55e' : '#f87171';
        } catch (_) { msg.textContent = 'Network error'; msg.style.color = '#f87171'; }
      }

      // ── Correct (= set capper) on a recorded row ────────────────────────────
      // Data comes via data-* attrs on the button so apostrophes and JSON
      // can't break the inline attribute. Just updates picks + history +
      // registers the name in capper_aliases so the matched/new badge flips
      // to green on the next render — no reader-corrections flow.
      async function correctCapperFromBtn(btn) {
        const pickId  = parseInt(btn.dataset.pickId, 10);
        const current = btn.dataset.capper || '';
        if (!pickId) { alert('No pick linked to this message.'); return; }
        const name = window.prompt('Capper name for this pick (e.g. WestBestServer):', current);
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        try {
          const r = await fetch('/admin/api/pick/' + pickId + '/capper', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ capper_name: trimmed }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'Failed');
          // Update the capper cell on the same row (same pickId) so the badge
          // flips immediately and the next click pre-fills with the new name.
          btn.dataset.capper = trimmed;
          const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
          const row  = btn.closest('tr');
          const cell = row && row.querySelector('.capper-cell');
          if (cell) {
            cell.innerHTML = '<span style="font-size:12px;">' + esc(trimmed) + '</span> '
              + '<span class="badge match-ok">matched</span>';
          }
        } catch (err) {
          alert('Failed to set capper: ' + (err.message || err));
        }
      }

      // ── Archive panel ──────────────────────────────────────────────────────────
      let _archiveTimer = null;
      function archiveLoad() {
        clearTimeout(_archiveTimer);
        _archiveTimer = setTimeout(_archiveFetch, 180);
      }
      function archiveClear() {
        ['ar-capper','ar-from','ar-to'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        const ch = document.getElementById('ar-channel'); if (ch) ch.value = '';
        const m  = document.getElementById('ar-match');   if (m)  m.value  = '';
        archiveLoad();
      }
      async function _archiveFetch() {
        const body = document.getElementById('ar-body');
        if (!body) return;
        body.innerHTML = '<div class="empty">Loading…</div>';
        const params = new URLSearchParams();
        const capper = document.getElementById('ar-capper')?.value.trim();
        const channel = document.getElementById('ar-channel')?.value;
        const match   = document.getElementById('ar-match')?.value;
        const from    = document.getElementById('ar-from')?.value;
        const to      = document.getElementById('ar-to')?.value;
        if (capper)  params.set('capper', capper);
        if (channel) params.set('channel', channel);
        if (match)   params.set('match', match);
        if (from)    params.set('from', from);
        if (to)      params.set('to', to);
        try {
          const r = await fetch('/admin/api/archive?' + params.toString());
          const j = await r.json();
          const rows = j.rows || [];
          document.getElementById('ar-count').textContent = rows.length + ' message' + (rows.length === 1 ? '' : 's');
          if (!rows.length) { body.innerHTML = '<div class="empty">No archived messages match.</div>'; return; }
          body.innerHTML = '<table><thead><tr>' +
            '<th>Time</th><th>Channel</th><th>Author</th><th>Capper</th><th>Match</th><th>Pick</th><th>Message</th>' +
            '</tr></thead><tbody>' +
            rows.map(_archiveRow).join('') +
            '</tbody></table>';
        } catch (err) {
          body.innerHTML = '<div class="empty" style="color:#ef4444;">Failed to load archive: ' + (err?.message || err) + '</div>';
        }
      }
      function _archiveRow(r) {
        const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const ts  = r.message_timestamp ? r.message_timestamp.slice(0, 16).replace('T', ' ') : (r.archived_at || '').slice(0, 16).replace('T', ' ');
        const matchCell = r.capper_matched === 1 ? '<span class="badge match-ok">matched</span>'
                       : r.capper_matched === 0 ? '<span class="badge match-new">new</span>'
                       : '<span style="color:#3b4560;font-size:11px;">—</span>';
        const pick = [r.pick_team, r.pick_type, r.pick_sport ? '(' + r.pick_sport + ')' : ''].filter(Boolean).map(esc).join(' ');
        const msg  = esc(r.message_text || '').slice(0, 240);
        return '<tr>' +
          '<td><small>' + esc(ts) + '</small></td>' +
          '<td>' + esc(r.channel || '—') + '</td>' +
          '<td><em>' + esc(r.author || '—') + '</em></td>' +
          '<td>' + esc(r.capper_name || r.capper_raw || '—') + '</td>' +
          '<td>' + matchCell + '</td>' +
          '<td>' + (pick || '<span style="color:#3b4560;">—</span>') + '</td>' +
          '<td><span style="font-size:12px;color:#cbd5e1;">' + msg + (r.message_text && r.message_text.length > 240 ? '…' : '') + '</span></td>' +
          '</tr>';
      }

      // ── Reader panel ───────────────────────────────────────────────────────────
      async function readerPing() {
        const dot  = document.getElementById('reader-dot');
        const txt  = document.getElementById('reader-status-text');
        const mdl  = document.getElementById('reader-model-line');
        if (!dot) return;
        dot.style.background = '#64748b';
        txt.textContent = 'Pinging...';
        mdl.textContent = '';
        try {
          const r = await fetch('/admin/api/reader-health');
          const d = await r.json();
          if (d.ok) {
            dot.style.background = '#34d399';
            txt.style.color = '#34d399';
            txt.textContent = 'Online';
            mdl.textContent = 'Model: ' + (d.model || 'unknown');
          } else {
            dot.style.background = '#ef4444';
            txt.style.color = '#ef4444';
            txt.textContent = d.error || 'Offline';
          }
        } catch (e) {
          dot.style.background = '#ef4444';
          txt.style.color = '#ef4444';
          txt.textContent = 'Unreachable';
        }
      }

      async function setReaderMode(mode) {
        const msg = document.getElementById('reader-mode-msg');
        try {
          const r = await fetch('/admin/api/reader-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
          });
          const d = await r.json();
          if (d.ok) {
            msg.textContent = 'Saved.';
            msg.style.color = '#34d399';
            // Update label borders
            ['auto','mac','haiku'].forEach(m => {
              const lbl = document.getElementById('reader-mode-label-' + m);
              if (lbl) {
                lbl.style.borderColor = m === mode ? '#3b82f6' : '#252c3b';
                lbl.style.background  = m === mode ? 'rgba(59,130,246,0.08)' : 'transparent';
              }
            });
          } else {
            msg.textContent = d.error || 'Failed to save';
            msg.style.color = '#ef4444';
          }
        } catch (e) {
          msg.textContent = 'Error: ' + e.message;
          msg.style.color = '#ef4444';
        }
        setTimeout(() => { if (msg) msg.textContent = ''; }, 3000);
      }

      // ── Cycle / retention settings ──────────────────────────────────────────────
      async function saveCycleSettings() {
        const msg = document.getElementById('cycle-settings-msg');
        const clear_hour  = document.getElementById('cycle-clear-hour').value.trim();
        const grace_hours = document.getElementById('cycle-grace-hours').value.trim();
        try {
          const r = await fetch('/admin/api/cycle-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clear_hour, grace_hours }),
          });
          const d = await r.json();
          msg.textContent = d.ok ? 'Saved.' : (d.error || 'Failed to save');
          msg.style.color = d.ok ? '#34d399' : '#ef4444';
        } catch (e) {
          msg.textContent = 'Error: ' + e.message;
          msg.style.color = '#ef4444';
        }
        setTimeout(() => { if (msg) msg.textContent = ''; }, 3000);
      }

      // ── MVP threshold ──────────────────────────────────────────────────────────
      async function saveThreshold() {
        const val = parseInt(document.getElementById('threshold-input').value, 10);
        const status = document.getElementById('threshold-status');
        if (isNaN(val) || val < 0 || val > 200) {
          status.textContent = 'Invalid value (0–200).';
          status.style.color = '#ef4444';
          return;
        }
        status.textContent = 'Saving...';
        status.style.color = '#8892a4';
        const r = await fetch('/admin/mvp-threshold', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threshold: val }),
        });
        const d = await r.json();
        if (d.ok) {
          status.textContent = 'Saved. Reload to see updated table.';
          status.style.color = '#16a34a';
        } else {
          status.textContent = 'Error: ' + (d.error || 'unknown');
          status.style.color = '#ef4444';
        }
      }

      // ── Bet size (flat unit) ────────────────────────────────────────────────────
      async function saveBetUnit() {
        const val = parseFloat(document.getElementById('bet-unit-input').value);
        const status = document.getElementById('bet-unit-status');
        if (isNaN(val) || val < 1 || val > 10000) {
          status.textContent = 'Invalid value (1–10000).';
          status.style.color = '#ef4444';
          return;
        }
        status.textContent = 'Saving...';
        status.style.color = '#8892a4';
        const r = await fetch('/admin/bet-unit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unit: val }),
        });
        const d = await r.json();
        if (d.ok) {
          status.textContent = 'Saved. Reload the public site to see it.';
          status.style.color = '#16a34a';
        } else {
          status.textContent = 'Error: ' + (d.error || 'unknown');
          status.style.color = '#ef4444';
        }
      }

      // ── Picks panel ────────────────────────────────────────────────────────────
      function toggleMsgs(id, btn) {
        const row = document.getElementById('msgs-' + id);
        if (!row) return;
        const open = row.style.display !== 'none';
        row.style.display = open ? 'none' : '';
        if (btn) btn.textContent = btn.textContent.replace(open ? '▴' : '▾', open ? '▾' : '▴');
      }

      // ── Action confirm modal ───────────────────────────────────────────────────
      const ACTION_INFO = {
        nuke: {
          title: 'NUKE & RESCAN',
          color: '#ef4444',
          body: 'Deletes all picks, raw messages, and score breakdowns for today. Preserves today_games, lines, MVP history, and users. Then immediately triggers a fresh scan back to 6am.',
          cost: 'Uses Haiku API credits (~$0.007/msg SDK, ~$0.018/msg billed) to re-read all Discord messages since 6am. 50 messages ≈ $0.90 billed.',
          confirm: 'TYPE "NUKE" TO CONFIRM',
          typed: true,
        },
        scan: {
          title: 'Scan Now',
          color: '#3b82f6',
          body: 'Runs an incremental Discord scan — only fetches messages since the last scan.',
          cost: 'Uses Haiku API credits for any new messages found (typically <$0.01).',
          confirm: null,
          typed: false,
        },
        rescan: {
          title: 'Rescan From 6am',
          color: '#7c3aed',
          body: 'Clears scanner state and re-reads ALL Discord messages since 6am. Picks that already exist will be deduplicated — no double-counting.',
          cost: 'Uses Haiku API credits (~$0.018/msg billed) for all messages since 6am. 50 messages ≈ $0.90 billed.',
          confirm: null,
          typed: false,
        },
        skipped: {
          title: 'Rescan Skipped',
          color: '#0f766e',
          body: 'Re-runs all previously skipped messages through the current reader rules. Useful after updating the RULES prompt or adding corrections.',
          cost: 'Uses Haiku API credits (~$0.018/msg billed). 15 skipped messages ≈ $0.27 billed.',
          confirm: null,
          typed: false,
        },
        odds: {
          title: 'Refresh Odds Now',
          color: '#b45309',
          body: "Fetches fresh ML/spread/O/U lines from The Odds API for all of today's games and reseeds pick slots.",
          cost: 'Costs Odds API credits — each sport uses 1 credit (≈4–6 credits total). You have ~500/month free.',
          confirm: null,
          typed: false,
        },
        'fetch-games': {
          title: "Re-fetch Today's Games",
          color: '#1d4ed8',
          body: "Re-fetches today's ESPN game schedule for all team sports + tennis, then reseeds pick slots. Use this after a redeploy when picks are landing in 'skipped' due to missing games.",
          cost: 'Free — ESPN API only, no credits used.',
          confirm: null,
          typed: false,
        },
      };

      function confirmAction(key) {
        const info = ACTION_INFO[key];
        if (!info) return;
        document.getElementById('action-modal-title').textContent = info.title;
        document.getElementById('action-modal-title').style.color = info.color;
        document.getElementById('action-modal-body').textContent  = info.body;

        // For Rescan Skipped, show live count and calculated cost
        let costText = info.cost;
        if (key === 'skipped') {
          const badge = document.querySelector('#msec-btn-skipped span') || document.querySelector('[onclick*="skipped"] span');
          const n = badge ? parseInt(badge.textContent, 10) : null;
          if (n != null && !isNaN(n)) {
            const billed = (n * 0.018).toFixed(2);
            costText = 'Uses Haiku API credits \u2014 ' + n + ' skipped message' + (n !== 1 ? 's' : '') + ' \u00d7 ~$0.018/msg billed = ~$' + billed + '.';
          }
        }
        document.getElementById('action-modal-cost').textContent = costText;
        const typedRow = document.getElementById('action-modal-typed-row');
        const typedInput = document.getElementById('action-modal-typed');
        if (info.typed) {
          typedRow.style.display = '';
          typedInput.value = '';
          document.getElementById('action-modal-confirm-label').textContent = info.confirm;
        } else {
          typedRow.style.display = 'none';
        }
        document.getElementById('action-modal-btn').textContent = info.title;
        document.getElementById('action-modal-btn').style.background = info.color;
        document.getElementById('action-modal-btn').onclick = () => executeAction(key, info);
        document.getElementById('action-modal').style.display = 'flex';
      }
      function closeActionModal() {
        document.getElementById('action-modal').style.display = 'none';
      }
      async function executeAction(key, info) {
        if (info.typed) {
          const val = document.getElementById('action-modal-typed').value.trim().toUpperCase();
          if (val !== 'NUKE') { alert('Type NUKE exactly to confirm.'); return; }
        }
        closeActionModal();
        if (key === 'nuke') {
          const btn = document.querySelector('.btn-nuke');
          btn.disabled = true; btn.textContent = 'Nuking...';
          await fetch('/admin/nuke', { method: 'POST' });
          btn.disabled = false; btn.textContent = 'NUKE & RESCAN';
          pollStatus();
        } else if (key === 'scan') {
          await fetch('/admin/scan-now', { method: 'POST' });
          pollStatus();
        } else if (key === 'rescan') {
          showStatus('scanning', 'Rescanning from 6am...');
          await fetch('/admin/rescan-from-start', { method: 'POST' });
          pollStatus();
        } else if (key === 'skipped') {
          const btn = document.getElementById('btn-skipped');
          btn.disabled = true; btn.textContent = 'Rescanning...';
          const res = await fetch('/admin/rescan-skipped', { method: 'POST' });
          const data = await res.json();
          btn.disabled = false; btn.textContent = 'Rescan Skipped';
          if (data.queued === 0) alert('No skipped messages on record.');
          else { showStatus('scanning', \`Processing \${data.queued} skipped messages...\`); pollStatus(); }
        } else if (key === 'odds') {
          const btn = document.getElementById('btn-odds');
          btn.disabled = true; btn.textContent = 'Refreshing...';
          const res = await fetch('/admin/refresh-odds', { method: 'POST' });
          const data = await res.json();
          btn.disabled = false; btn.textContent = 'Refresh Odds Now';
          alert(data.ok ? 'Done: ' + data.updated + ' games updated, slots reseeded.' : 'Error: ' + data.error);
        } else if (key === 'fetch-games') {
          const btn = document.getElementById('btn-fetch-games');
          btn.disabled = true; btn.textContent = 'Fetching...';
          await fetch('/admin/fetch-games', { method: 'POST' });
          setTimeout(() => { btn.disabled = false; btn.textContent = "Re-fetch Today's Games"; }, 15000);
          showStatus('scanning', "Fetching today's games + seeding slots (takes ~10s)...");
        }
      }

      // ── Code creator ───────────────────────────────────────────────────────────
      function ccDurToggle() {
        const v = document.getElementById('cc-duration').value;
        document.getElementById('cc-dur-custom-wrap').style.display = v === 'custom' ? '' : 'none';
      }

      async function createCode() {
        const name   = document.getElementById('cc-name').value.trim().toUpperCase();
        const durSel = document.getElementById('cc-duration').value;
        let durationDays = durSel === 'custom'
          ? parseInt(document.getElementById('cc-dur-custom').value, 10)
          : parseInt(durSel, 10);
        if (isNaN(durationDays) || durationDays < 0) durationDays = 0;
        let maxUses = parseInt(document.getElementById('cc-maxuses').value, 10);
        if (isNaN(maxUses) || maxUses < 0) maxUses = 1;
        let count = parseInt(document.getElementById('cc-count').value, 10);
        if (isNaN(count) || count < 1) count = 1;
        const notes = document.getElementById('cc-notes').value.trim();

        const res = await fetch('/admin/generate-codes-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: name || undefined, durationDays, maxUses, count, notes }),
        });
        const data = await res.json();
        if (!data.ok) { alert('Error: ' + (data.error || 'unknown')); return; }
        const resultEl = document.getElementById('cc-result');
        const codesEl  = document.getElementById('cc-codes');
        codesEl.innerHTML = data.codes.map(c =>
          \`<div style="display:flex;align-items:center;gap:12px;">
            <span style="color:#e2e8f0;font-size:14px;">\${c}</span>
            <button onclick="navigator.clipboard.writeText('\${c}').then(()=>this.textContent='Copied!').catch(()=>{})"
              style="background:none;border:1px solid #252c3b;color:#8892a4;border-radius:4px;padding:1px 8px;font-size:11px;cursor:pointer;">Copy</button>
          </div>\`
        ).join('');
        resultEl.style.display = '';
        // reload after 2.5s so table updates
        setTimeout(() => location.reload(), 2500);
      }

      async function deleteCode(id) {
        if (!confirm('Delete this code? Users who already redeemed it keep their access.')) return;
        const res  = await fetch('/admin/delete-code/' + id, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (data && data.ok === false) { alert('Error: ' + (data.error || 'could not delete')); return; }
        location.reload();
      }

      // ── Who-used-this-code popup ───────────────────────────────────────────────
      async function showCodeUsers(id) {
        const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const modal   = document.getElementById('code-users-modal');
        const content = document.getElementById('code-users-content');
        content.innerHTML = 'Loading...';
        modal.style.display = 'flex';
        try {
          const res  = await fetch('/admin/api/code-users/' + id);
          const data = await res.json();
          if (!data.ok) { content.innerHTML = 'Could not load redemptions.'; return; }
          const limit = data.maxUses === 0 ? '∞' : data.maxUses;
          const users = data.users || [];
          const rows = users.map((u, i) => {
            const who  = u.username || u.email || ('user #' + u.id);
            const when = u.redeemed_at ? u.redeemed_at.slice(0, 16).replace('T', ' ') : '—';
            const exp  = u.subscription_expires ? u.subscription_expires.slice(0, 10) : 'never';
            return \`<tr>
              <td style="color:#8892a4;">\${i + 1}</td>
              <td style="color:#e2e8f0;font-weight:600;">\${esc(who)}</td>
              <td style="color:#8892a4;font-size:12px;">\${esc(u.email || '—')}</td>
              <td style="color:#8892a4;font-size:12px;">\${when}</td>
              <td style="color:#8892a4;font-size:12px;">\${esc(u.subscription_tier || '—')} · \${exp}</td>
            </tr>\`;
          }).join('');
          content.innerHTML = \`
            <h2 style="margin:0 0 4px;font-size:18px;font-family:monospace;letter-spacing:1px;">\${esc(data.code)}</h2>
            <p style="color:#8892a4;font-size:13px;margin:0 0 16px;">\${users.length} / \${limit} redemptions</p>
            \${users.length
              ? \`<table style="width:100%;"><thead><tr><th>#</th><th>User</th><th>Email</th><th>Redeemed</th><th>Access</th></tr></thead><tbody>\${rows}</tbody></table>\`
              : '<p style="color:#8892a4;">No one has redeemed this code yet.</p>'}
          \`;
        } catch (e) { content.innerHTML = 'Could not load redemptions.'; }
      }
      function closeCodeUsers() { document.getElementById('code-users-modal').style.display = 'none'; }

      function showStatus(type, msg) {
        const el = document.getElementById('scan-status');
        if (type === 'scanning') {
          el.innerHTML = \`<div style="display:flex;align-items:center;gap:10px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#3b82f6;animation:pulse 1s infinite;"></span>
            <strong style="color:#e2e8f0;">\${msg}</strong></div>\`;
        }
      }
      function renderStatus(s) {
        const el = document.getElementById('scan-status');
        if (!el) return;
        if (s.scanning) {
          el.innerHTML = \`<div><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#3b82f6;animation:pulse 1s infinite;"></span>
            <strong style="color:#e2e8f0;">Scanning Discord...</strong></div>
            <div style="font-size:12px;color:#8892a4;">Reading channels and extracting picks</div></div>\`;
        } else if (s.error) {
          el.innerHTML = \`<div style="color:#ef4444;font-size:13px;">Error: \${s.error}</div>\`;
        } else if (s.lastScanAt) {
          const t = new Date(s.lastScanAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
          el.innerHTML = \`<div><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#4ade80;"></span>
            <strong style="color:#e2e8f0;">All caught up</strong></div>
            <div style="font-size:12px;color:#8892a4;">Last scan: \${t} &nbsp;·&nbsp; \${s.lastSaved ?? 0} new pick\${s.lastSaved !== 1 ? 's' : ''} saved</div></div>\`;
        } else {
          el.innerHTML = '<span style="color:#8892a4;font-size:13px;">No scan has run yet today.</span>';
        }
      }
      let pollTimer = null;
      async function pollStatus() {
        clearTimeout(pollTimer);
        try {
          const res = await fetch('/admin/scan-status');
          const s   = await res.json();
          renderStatus(s);
          if (s.scanning) pollTimer = setTimeout(pollStatus, 1500);
        } catch (_) {}
      }
      pollStatus();
      setInterval(pollStatus, 10000);

      // ── Users panel ────────────────────────────────────────────────────────────
      document.getElementById('user-q').addEventListener('keydown', e => { if (e.key === 'Enter') searchUsers(); });

      async function searchUsers() {
        const q = document.getElementById('user-q').value.trim();
        if (!q) { document.getElementById('user-results').innerHTML = '<p style="color:#8892a4;">Enter a username or email to search.</p>'; return; }
        document.getElementById('user-results').innerHTML = '<p style="color:#8892a4;">Searching...</p>';
        try {
          const res  = await fetch('/admin/api/users?q=' + encodeURIComponent(q));
          const data = await res.json();
          renderUserResults(data.users, data.q);
        } catch (_) {
          document.getElementById('user-results').innerHTML = '<p style="color:#ef4444;">Search failed.</p>';
        }
      }

      function renderUserResults(users, q) {
        const el = document.getElementById('user-results');
        if (!users.length) { el.innerHTML = \`<p style="color:#8892a4;">No results for "\${q}".</p>\`; return; }
        el.innerHTML = \`<p class="users-results-note">\${users.length} result\${users.length !== 1 ? 's' : ''} for "\${q}"</p>
          <table><thead><tr><th>ID</th><th>Username</th><th>Email</th><th>Tier</th><th>Expires</th><th>Actions</th></tr></thead>
          <tbody>\${users.map(userRowHtml).join('')}</tbody></table>\`;
      }

      function userRowHtml(u) {
        const now = Date.now();
        const expired = u.subscription_expires && new Date(u.subscription_expires).getTime() < now;
        const tierColor = u.subscription_tier === 'free' ? '#8892a4' : (expired ? '#ef4444' : '#16a34a');
        const tierLabel = u.subscription_tier === 'free' ? 'Free' : (expired ? u.subscription_tier + ' (expired)' : u.subscription_tier);
        const expiresStr = u.subscription_expires ? u.subscription_expires.slice(0, 16).replace('T', ' ') : '—';
        return \`<tr>
          <td style="color:#8892a4;font-size:12px;">\${u.id}</td>
          <td>\${u.username || '—'}</td>
          <td style="color:#8892a4;">\${u.email}</td>
          <td><span style="color:\${tierColor};font-weight:600;">\${tierLabel}</span></td>
          <td style="color:#8892a4;font-size:12px;">\${expiresStr}</td>
          <td style="white-space:nowrap;">
            <select id="tier-\${u.id}" style="background:#0f1117;border:1px solid #252c3b;color:#e2e8f0;padding:4px 8px;border-radius:4px;font-size:12px;">
              <option value="day">Day (24h)</option><option value="week">Week (7d)</option>
              <option value="annual">Annual (365d)</option><option value="lifetime">Lifetime</option>
            </select>
            <button class="btn-sm btn-grant" style="margin-left:4px;" onclick="grantAccess(\${u.id})">Grant</button>
            <button class="btn-sm btn-revoke" style="margin-left:4px;" onclick="revokeAccess(\${u.id})">Revoke</button>
          </td>
        </tr>\`;
      }

      async function grantAccess(userId) {
        const tier = document.getElementById('tier-' + userId).value;
        await fetch('/admin/api/grant', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ user_id: userId, tier }) });
        searchUsers();
      }
      async function revokeAccess(userId) {
        if (!confirm('Revoke access for this user?')) return;
        await fetch('/admin/api/revoke', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ user_id: userId }) });
        searchUsers();
      }

      // ── MVP panel ──────────────────────────────────────────────────────────────
      function openMvp(id) {
        document.getElementById('mvp-modal').style.display = 'block';
        document.getElementById('mvp-content').innerHTML = '<div style="color:#8892a4;text-align:center;padding:32px;">Loading...</div>';
        fetch('/admin/mvp-detail/' + id).then(r => r.json()).then(renderMvpDetail)
          .catch(() => { document.getElementById('mvp-content').innerHTML = '<div style="color:#ef4444;">Error loading details.</div>'; });
      }
      async function setMvpResult(id, result) {
        const res = await fetch('/admin/mvp-result/' + id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ result }),
        });
        const data = await res.json();
        if (data.ok) { openMvp(id); location.reload(); }
        else alert('Error: ' + (data.error || 'Unknown'));
      }
      function closePanel() { document.getElementById('mvp-modal').style.display = 'none'; }
      function closeModal(e) { if (e.target === document.getElementById('mvp-modal')) closePanel(); }

      function renderMvpDetail(d) {
        const m = d.mvp, pick = d.pick, messages = d.messages || [], breakdown = d.breakdown;
        const rc = { win:'#16a34a', loss:'#ef4444', push:'#8892a4', pending:'#f59e0b' }[(m.result||'pending').toLowerCase()] || '#8892a4';
        const matchup = (m.away_team && m.home_team) ? \`\${m.away_team} @ \${m.home_team}\` : m.team;
        const pt = (m.pick_type || '').toLowerCase();
        const sp = (pt === 'over' || pt === 'under') ? (m.spread != null ? Math.abs(parseFloat(m.spread)) : '') : (m.spread != null ? m.spread : '');
        const finalScore = m.home_score != null ? \`\${m.away_score}–\${m.home_score}\` : 'Pending';

        let breakdownHtml = '';
        if (breakdown) {
          const bj = breakdown.breakdown_json ? JSON.parse(breakdown.breakdown_json) : null;
          breakdownHtml = \`<div style="margin-bottom:20px;">
            <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#8892a4;letter-spacing:0.5px;margin-bottom:10px;">Score Calculation</div>
            <div style="background:#0f1117;border:1px solid #252c3b;border-radius:8px;padding:16px;font-family:monospace;font-size:13px;">
              <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1e2330;"><span style="color:#8892a4;">Channel points</span><span>+\${breakdown.channel_points}</span></div>
              <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1e2330;"><span style="color:#8892a4;">Sport bonus</span><span>+\${breakdown.sport_bonus}</span></div>
              <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1e2330;"><span style="color:#8892a4;">Home team bonus</span><span>+\${breakdown.home_bonus}</span></div>
              <div style="display:flex;justify-content:space-between;padding:6px 0 0;font-weight:700;"><span style="color:#FFD700;">Total score</span><span style="color:#FFD700;">\${breakdown.total} pts</span></div>
              \${bj ? \`<div style="margin-top:10px;padding-top:10px;border-top:1px solid #1e2330;color:#64748b;font-size:11px;">\${JSON.stringify(bj)}</div>\` : ''}
            </div></div>\`;
        }

        function calcPayout(odds, stake) {
          if (odds == null) return null;
          const o = parseFloat(odds); if (isNaN(o)) return null;
          const profit = o > 0 ? stake * (o / 100) : stake * (100 / Math.abs(o));
          return { profit: profit.toFixed(2), payout: (stake + profit).toFixed(2) };
        }
        const STAKE = 20;
        let betOdds = null, oddsLabel = '';
        if (pt === 'ml') { betOdds = m.ml_odds ?? (pick ? pick.original_ml : null); oddsLabel = 'Win'; }
        else if (pt === 'over' || pt === 'under') { betOdds = m.ou_odds ?? -115; oddsLabel = pt.charAt(0).toUpperCase() + pt.slice(1) + (sp ? ' ' + sp : ''); }
        else if (pt === 'spread') { betOdds = -115; oddsLabel = 'Spread ' + (sp || ''); }
        const calc = calcPayout(betOdds, STAKE);
        const oddsStr = betOdds != null ? (betOdds > 0 ? '+' + betOdds : betOdds) : '—';
        const rl = (m.result || 'pending').toLowerCase();
        let pc = '#e2e8f0', pl = calc ? '+$' + calc.profit : '—', payout = calc ? '$' + calc.payout : '—';
        if (rl === 'win') pc = '#16a34a';
        else if (rl === 'loss') { pc = '#ef4444'; pl = '-$' + STAKE.toFixed(2); payout = '$0.00'; }
        else if (rl === 'push') { pc = '#8892a4'; pl = '$0.00'; payout = '$' + STAKE.toFixed(2); }

        const betHtml = \`<div style="margin-bottom:20px;">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#8892a4;letter-spacing:0.5px;margin-bottom:10px;">$20 Unit Bet</div>
          <div style="background:#0f1117;border:1px solid #252c3b;border-radius:8px;padding:16px;font-family:monospace;font-size:13px;">
            <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1e2330;"><span style="color:#8892a4;">Pick</span><span>\${oddsLabel || m.pick_type || '—'}</span></div>
            <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1e2330;"><span style="color:#8892a4;">Odds</span><span>\${oddsStr}</span></div>
            <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1e2330;"><span style="color:#8892a4;">Stake</span><span>$\${STAKE.toFixed(2)}</span></div>
            <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1e2330;"><span style="color:#8892a4;">Profit</span><span style="color:\${pc};font-weight:700;">\${pl}</span></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0 0;font-weight:700;"><span style="color:#8892a4;">Total payout</span><span style="color:\${pc};">\${payout}</span></div>
            \${rl === 'pending' ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #1e2330;color:#64748b;font-size:11px;">Projected — result still pending</div>' : ''}
          </div></div>\`;

        const chColor = { 'free-plays': '#3b82f6', 'pod-thread': '#8b5cf6', 'community-leaks': '#f59e0b' };
        const msgHtml = messages.length
          ? messages.map(msg => {
              const cc = chColor[msg.channel || ''] || '#8892a4';
              const ts = msg.message_timestamp ? new Date(msg.message_timestamp).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '';
              return \`<div style="background:#0f1117;border:1px solid #252c3b;border-radius:8px;padding:14px;margin-bottom:8px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
                  <span style="background:\${cc}22;color:\${cc};border:1px solid \${cc}44;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;">#\${msg.channel}</span>
                  \${msg.author ? \`<span style="color:#e2e8f0;font-weight:600;font-size:13px;">\${msg.author}</span>\` : ''}
                  \${ts ? \`<span style="color:#64748b;font-size:12px;margin-left:auto;">\${ts} ET</span>\` : ''}
                </div>
                <div style="color:#cbd5e1;font-size:13px;line-height:1.5;white-space:pre-wrap;">\${msg.message_text || ''}</div>
              </div>\`;
            }).join('')
          : '<div style="color:#8892a4;padding:12px 0;">No raw messages on record.</div>';

        const firstSeen = messages.length && messages[0].message_timestamp
          ? new Date(messages[0].message_timestamp).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
          : (m.saved_at ? new Date(m.saved_at).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '—');

        document.getElementById('mvp-content').innerHTML = \`
          <div style="margin-bottom:20px;">
            <div style="font-size:20px;font-weight:700;margin-bottom:4px;">\${matchup}</div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
              <span style="color:#8892a4;">\${m.sport || ''}</span>
              <span>\${m.pick_type || ''} \${sp}</span>
              \${m.ml_odds ? \`<span style="color:#8892a4;font-size:12px;">ML \${m.ml_odds > 0 ? '+' : ''}\${m.ml_odds}</span>\` : ''}
              <span style="background:\${rc}22;color:\${rc};border:1px solid \${rc}44;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;">\${(m.result||'pending').toUpperCase()}</span>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
            <div style="background:#0f1117;border:1px solid #252c3b;border-radius:8px;padding:12px;text-align:center;">
              <div style="color:#8892a4;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Score</div>
              <div style="font-size:22px;font-weight:700;color:#FFD700;">\${m.score}</div>
            </div>
            <div style="background:#0f1117;border:1px solid #252c3b;border-radius:8px;padding:12px;text-align:center;">
              <div style="color:#8892a4;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Final Score</div>
              <div style="font-size:22px;font-weight:700;">\${finalScore}</div>
            </div>
            <div style="background:#0f1117;border:1px solid #252c3b;border-radius:8px;padding:12px;text-align:center;">
              <div style="color:#8892a4;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Bet Placed</div>
              <div style="font-size:12px;line-height:1.4;">\${firstSeen}</div>
            </div>
          </div>
          \${breakdownHtml}\${betHtml}
          <div style="margin-bottom:20px;">
            <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#8892a4;letter-spacing:0.5px;margin-bottom:10px;">Override Result</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              \${['win','loss','push','pending'].map(r => {
                const colors = { win:'#16a34a', loss:'#ef4444', push:'#8892a4', pending:'#f59e0b' };
                const c = colors[r];
                const active = (m.result || 'pending').toLowerCase() === r;
                return \`<button onclick="setMvpResult(\${m.id}, '\${r}')" style="padding:6px 14px;border-radius:6px;border:1px solid \${c}44;background:\${active ? c + '33' : '#0f1117'};color:\${c};font-size:13px;cursor:pointer;font-weight:\${active ? '700' : '400'};">\${r.charAt(0).toUpperCase() + r.slice(1)}\${active ? ' ✓' : ''}</button>\`;
              }).join('')}
            </div>
          </div>
          <div>
            <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#8892a4;letter-spacing:0.5px;margin-bottom:10px;">Cappers & Messages (\${messages.length})</div>
            \${msgHtml}
          </div>\`;
      }

      let sortCol = 'date', sortDir = 'desc';
      function applyFilters() {
        const fDate = document.getElementById('f-date').value;
        const fSport = document.getElementById('f-sport').value;
        const fType = document.getElementById('f-type').value;
        const fResult = document.getElementById('f-result').value;
        const fMin = parseFloat(document.getElementById('f-minscore').value) || 0;
        const fMaxRaw = document.getElementById('f-maxscore').value;
        const fMax = fMaxRaw !== '' ? parseFloat(fMaxRaw) : Infinity;
        const [sc, sd] = document.getElementById('f-sort').value.split('-');
        sortCol = sc; sortDir = sd;
        const tbody = document.getElementById('mvp-tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr.mvp-row'));
        rows.forEach(row => {
          const show =
            (!fDate   || row.dataset.date  === fDate) &&
            (!fSport  || row.dataset.sport === fSport) &&
            (!fType   || (row.dataset.pickType || row.getAttribute('data-pick-type')) === fType) &&
            (!fResult || row.dataset.result === fResult) &&
            (parseFloat(row.dataset.score) || 0) >= fMin &&
            (parseFloat(row.dataset.score) || 0) <= fMax;
          row.style.display = show ? '' : 'none';
        });
        const visible = rows.filter(r => r.style.display !== 'none');
        visible.sort((a, b) => {
          if (sortCol === 'score') {
            const av = parseFloat(a.dataset.score), bv = parseFloat(b.dataset.score);
            return sortDir === 'asc' ? av - bv : bv - av;
          }
          const av = sortCol === 'date' ? a.dataset.date : sortCol === 'result' ? a.dataset.result : sortCol === 'sport' ? a.dataset.sport : a.getAttribute('data-pick-type');
          const bv = sortCol === 'date' ? b.dataset.date : sortCol === 'result' ? b.dataset.result : sortCol === 'sport' ? b.dataset.sport : b.getAttribute('data-pick-type');
          return sortDir === 'asc' ? (av||'').localeCompare(bv||'') : (bv||'').localeCompare(av||'');
        });
        visible.forEach(r => tbody.appendChild(r));
        const countEl = document.getElementById('mvp-count');
        const emptyEl = document.getElementById('mvp-empty');
        if (countEl) countEl.textContent = visible.length + ' of ' + rows.length + ' picks';
        if (emptyEl) emptyEl.style.display = visible.length === 0 ? '' : 'none';
      }
      function clearFilters() {
        ['f-date','f-sport','f-type','f-result','f-minscore','f-maxscore'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        document.getElementById('f-sort').value = 'date-desc';
        applyFilters();
      }
      applyFilters();

      // ── Cappers panel ──────────────────────────────────────────────────────────
      // One-click merge from a Suggested Match row. Stays in place (no reload)
      // so the page doesn't jump to the top while working through the list.
      async function quickMerge(btn) {
        const canonical = btn.getAttribute('data-canon');
        const alias     = btn.getAttribute('data-alias');
        if (!canonical || !alias) return;
        btn.disabled = true; btn.textContent = 'Merging...';
        try {
          const res  = await fetch('/admin/capper-alias', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ canonical, alias }) });
          const data = await res.json();
          if (data.ok) {
            const row = btn.closest('tr');
            if (row) {
              row.style.transition = 'opacity .2s';
              row.style.opacity = '0.4';
              const act = row.lastElementChild;
              if (act) act.innerHTML = '<span style="color:#16a34a;font-size:12px;font-weight:700;">✓ Merged</span>';
            }
            return;
          }
          btn.disabled = false; btn.textContent = 'Match';
          alert('Error: ' + (data.error || 'Could not merge'));
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Match';
          alert('Network error while merging.');
        }
      }

      async function addAlias() {
        const canonical = document.getElementById('alias-canonical').value.trim();
        const alias     = document.getElementById('alias-alias').value.trim();
        const msg       = document.getElementById('alias-msg');
        if (!canonical || !alias) { msg.textContent = 'Fill in both names.'; msg.style.color = '#ef4444'; return; }
        if (canonical.toLowerCase() === alias.toLowerCase()) { msg.textContent = 'The two names are the same.'; msg.style.color = '#ef4444'; return; }
        const res  = await fetch('/admin/capper-alias', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ canonical, alias }) });
        const data = await res.json();
        if (data.ok) {
          msg.textContent = '✓ Merged "' + alias + '" into "' + canonical + '". It updates on the leaderboard next refresh.';
          msg.style.color = '#16a34a';
          document.getElementById('alias-canonical').value = '';
          document.getElementById('alias-alias').value = '';
        } else {
          msg.textContent = 'Error: ' + (data.error || 'Unknown error');
          msg.style.color = '#ef4444';
        }
      }
      async function deleteAlias(id) {
        if (!confirm('Delete this alias?')) return;
        await fetch('/admin/capper-alias/' + id, { method: 'DELETE' });
        location.reload();
      }

      // ── Click-to-sort the capper leaderboard ───────────────────────────────────
      let capperSort = { col: -1, dir: -1 };
      let _capFilter = { src: 'all', band: 'all', q: '' };
      function applyCapperFilters() {
        const table = document.getElementById('capper-leaderboard');
        if (!table) return;
        const q = _capFilter.q.trim().toLowerCase();
        let shown = 0;
        Array.from(table.tBodies[0].rows).forEach(r => {
          const srcs = (r.getAttribute('data-sources') || '').split(',');
          const name = (r.getAttribute('data-capper') || '').toLowerCase();
          const band = r.getAttribute('data-band') || 'new';
          const okSrc = _capFilter.src === 'all' || srcs.includes(_capFilter.src);
          const okBand = _capFilter.band === 'all'
            || (_capFilter.band === 'fade' ? r.getAttribute('data-fade') === '1' : band === _capFilter.band);
          const okQ = !q || name.includes(q);
          const show = okSrc && okBand && okQ;
          r.style.display = show ? '' : 'none';
          if (show) { shown++; r.cells[0].textContent = shown; } // re-rank visible rows
        });
      }
      function filterCapperSrc(src, btn) {
        document.querySelectorAll('.src-filter-btn').forEach(b => {
          b.classList.remove('active');
          b.style.boxShadow = '';
        });
        btn.classList.add('active');
        btn.style.boxShadow = 'inset 0 -2px 0 currentColor';
        _capFilter.src = src;
        applyCapperFilters();
      }
      function filterCapperBand(band, btn) {
        document.querySelectorAll('.band-filter-btn').forEach(b => {
          b.classList.remove('active');
          b.style.boxShadow = '';
        });
        btn.classList.add('active');
        btn.style.boxShadow = 'inset 0 -2px 0 currentColor';
        _capFilter.band = band;
        applyCapperFilters();
      }
      function searchCappers(v) { _capFilter.q = v || ''; applyCapperFilters(); }

      function sortCapperLB(th) {
        const table = document.getElementById('capper-leaderboard');
        if (!table) return;
        const tbody = table.tBodies[0];
        const col   = th.cellIndex;
        const type  = th.getAttribute('data-type') || 'num';
        // First click: text ascending (A->Z), numbers descending (best first).
        // Re-clicking the same column reverses direction.
        const dir = capperSort.col === col ? -capperSort.dir : (type === 'str' ? 1 : -1);
        capperSort = { col, dir };
        const rows = Array.from(tbody.rows);
        rows.sort((a, b) => {
          const av = a.cells[col] ? a.cells[col].getAttribute('data-sv') || '' : '';
          const bv = b.cells[col] ? b.cells[col].getAttribute('data-sv') || '' : '';
          const cmp = type === 'str'
            ? String(av).localeCompare(String(bv))
            : (parseFloat(av) || 0) - (parseFloat(bv) || 0);
          return cmp * dir;
        });
        rows.forEach(r => tbody.appendChild(r));
        // Re-rank the visible rows so # stays sequential under any sort/filter.
        let shown = 0;
        rows.forEach(r => { if (r.style.display !== 'none') { shown++; r.cells[0].textContent = shown; } });
        // Update arrow indicators on the headers.
        table.querySelectorAll('thead th').forEach(h => {
          h.textContent = h.textContent.replace(/\s*[▲▼]$/, '');
        });
        th.textContent = th.textContent + (dir < 0 ? ' ▼' : ' ▲');
      }

      async function showCapperDetail(name) {
        const modal   = document.getElementById('capper-modal');
        const content = document.getElementById('capper-modal-content');
        modal.style.display = 'flex';
        content.innerHTML = '<div style="color:#8892a4;text-align:center;padding:40px;">Loading...</div>';
        try {
          const resp = await fetch('/admin/api/capper-detail/' + encodeURIComponent(name));
          const raw  = await resp.text();
          let data;
          try { data = JSON.parse(raw); }
          catch (_) { throw new Error('Non-JSON response (HTTP ' + resp.status + '): ' + raw.slice(0, 200)); }
          if (!resp.ok || (data && data.error)) throw new Error((data && data.error) || ('HTTP ' + resp.status));
          renderCapperDetail(name, data);
        } catch (e) {
          console.error('[capper-detail load]', name, e);
          const msg = String((e && e.message) || e).replace(/</g, '&lt;').replace(/>/g, '&gt;');
          content.innerHTML = '<div style="color:#ef4444;padding:16px;">Error loading capper detail.<br><span style="color:#8892a4;font-size:12px;">' + msg + '</span></div>';
        }
      }

      async function recomputeRatings(btn) {
        if (btn) { btn.disabled = true; btn.textContent = 'Recomputing...'; }
        try {
          await fetch('/admin/api/recompute-ratings', { method: 'POST' });
          location.reload();
        } catch (_) {
          if (btn) { btn.disabled = false; btn.textContent = 'Recompute ratings'; }
        }
      }

      // Scan button: re-resolve finished games, then re-render with fresh data.
      async function scanCapper(name, btn) {
        if (btn) { btn.disabled = true; btn.textContent = 'Scanning...'; }
        try {
          const data = await fetch('/admin/api/capper-scan/' + encodeURIComponent(name), { method: 'POST' }).then(r => r.json());
          renderCapperDetail(name, data);
        } catch (_) {
          if (btn) { btn.disabled = false; btn.textContent = 'Scan & Update'; }
          alert('Scan failed. Try again.');
        }
      }

      function renderCapperDetail(name, data) {
        const content = document.getElementById('capper-modal-content');
        try {
          const picks = data.picks || [];
          const MVP   = data.mvpThreshold  || 50;
          const HIGH  = data.highThreshold || 35;
          const wins    = picks.filter(p => p.result === 'win').length;
          const losses  = picks.filter(p => p.result === 'loss').length;
          const pushes  = picks.filter(p => p.result === 'push').length;
          const pending = picks.filter(p => p.result !== 'win' && p.result !== 'loss' && p.result !== 'push').length;
          // Decided-only win% — matches the cappers table and the public record pages.
          const decided = wins + losses;
          const winPct  = decided > 0 ? Math.round((wins / decided) * 100) : null;
          const units   = wins - losses;
          const unit    = parseFloat(data.unit) || 10;
          const wpColor = winPct === null ? '#8892a4' : winPct >= 55 ? '#16a34a' : winPct >= 50 ? '#f59e0b' : '#ef4444';
          const rColor  = { win: '#16a34a', loss: '#ef4444', push: '#8892a4', pending: '#f59e0b' };

          // Profit on one resolved pick at the configured unit, using stored odds.
          function pickProfit(result, odds, pickType, stake) {
            const r = (result || '').toLowerCase();
            if (r === 'loss') return -stake;
            if (r !== 'win')  return 0;
            let o = (odds == null || isNaN(parseFloat(odds))) ? null : parseFloat(odds);
            if (o == null) {
              const pt = (pickType || '').toLowerCase();
              o = (pt === 'over' || pt === 'under') ? -115 : -110;
            }
            return o > 0 ? stake * (o / 100) : stake * (100 / Math.abs(o));
          }
          const money = (v) => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
          const moneyColor = (v) => v > 0.005 ? '#16a34a' : v < -0.005 ? '#ef4444' : '#8892a4';
          const scoreColor = (s) => s == null ? '#8892a4' : s >= MVP ? '#FFD700' : s >= HIGH ? '#f59e0b' : '#8892a4';

          let totalMoney = 0;
          const sportAgg = {}; // sport -> { wins, losses, pushes, money }
          const mvpList = [];  // picks that became MVPs (50+)
          const highList = []; // strong picks 35-49 (not MVP)
          let pickRows = '';
          for (const p of picks) {
            const c    = rColor[(p.result || 'pending').toLowerCase()] || '#8892a4';
            const date = p.game_date || (p.saved_at || '').slice(0, 10);
            const pt   = p.pick_type || '';
            const sp   = (pt === 'over' || pt === 'under')
              ? (p.spread != null ? Math.abs(parseFloat(p.spread)) : '')
              : (p.spread != null ? p.spread : '');
            const pickDesc = pt + (sp !== '' ? ' ' + sp : '');
            const rl   = (p.result || 'pending').toLowerCase();
            const prof = pickProfit(rl, p.odds, pt, unit);
            const settled = rl === 'win' || rl === 'loss' || rl === 'push';
            if (settled) totalMoney += prof;
            const oddsStr = (p.odds != null && !isNaN(parseFloat(p.odds)))
              ? (parseFloat(p.odds) > 0 ? '+' + p.odds : '' + p.odds) : '\u2014';
            const profStr = settled
              ? '<span style="color:' + moneyColor(prof) + ';font-weight:600;">' + money(prof) + '</span>'
              : '<span style="color:#8892a4;">\u2014</span>';

            const s = p.sport || 'Unknown';
            if (!sportAgg[s]) sportAgg[s] = { wins: 0, losses: 0, pushes: 0, money: 0 };
            if (rl === 'win')       sportAgg[s].wins++;
            else if (rl === 'loss') sportAgg[s].losses++;
            else if (rl === 'push') sportAgg[s].pushes++;
            if (settled) sportAgg[s].money += prof;

            const scoreNum = (p.score != null && !isNaN(parseFloat(p.score))) ? Math.round(parseFloat(p.score)) : null;
            if (p.is_mvp) mvpList.push(p);
            else if (scoreNum != null && scoreNum >= HIGH) highList.push(p);
            const star = p.is_mvp ? ' \u2605' : '';
            const scoreCell = scoreNum != null
              ? '<span style="color:' + scoreColor(scoreNum) + ';font-weight:700;">' + scoreNum + star + '</span>'
              : '<span style="color:#3b4560;">\u2014</span>';

            pickRows +=
              '<tr>'
              + '<td style="font-size:11px;color:#8892a4;white-space:nowrap;">' + date + '</td>'
              + '<td style="font-weight:600;">' + (p.team || '\u2014') + '</td>'
              + '<td style="color:#8892a4;font-size:12px;">' + (p.sport || '\u2014') + '</td>'
              + '<td style="font-size:12px;">' + (pickDesc || '\u2014') + '</td>'
              + '<td style="font-size:11px;color:#8892a4;">' + oddsStr + '</td>'
              + '<td style="font-size:11px;color:#8892a4;">' + (p.channel || '\u2014') + '</td>'
              + '<td style="text-align:right;font-size:12px;">' + scoreCell + '</td>'
              + '<td><span style="background:' + c + '22;color:' + c + ';border:1px solid ' + c + '44;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700;">' + (p.result || 'pending').toUpperCase() + '</span></td>'
              + '<td style="font-size:12px;text-align:right;">' + profStr + '</td>'
              + '</tr>';
          }
          const unitStr    = (units >= 0 ? '+' : '') + units;
          const pushStr    = pushes > 0 ? ' - ' + pushes + 'P' : '';
          const wpStr      = winPct !== null ? '<span style="color:' + wpColor + ';font-size:16px;font-weight:700;">' + winPct + '%</span>' : '';
          const pendingStr = pending > 0 ? '<span style="color:#f59e0b;font-size:13px;">' + pending + ' pending</span>' : '';

          // Per-sport breakdown (record + money + in-sport Wilson standing + the
          // sport rank bonus a pick gets when this capper is its best backer).
          const sportRatingMap = {};
          for (const sr of (data.sportRatings || [])) sportRatingMap[sr.sport] = sr;
          const sportRows = Object.entries(sportAgg)
            .filter(([s]) => s !== 'Unknown')
            .sort((a, b) => (b[1].wins + b[1].losses + b[1].pushes) - (a[1].wins + a[1].losses + a[1].pushes))
            .map(([s, a]) => {
              const sr = sportRatingMap[s] || null;
              const rankStr = sr && sr.wilson_rank != null
                ? '#' + sr.wilson_rank + (sr.percentile != null ? ' <span style="color:#8892a4;font-size:10px;">(top ' + Math.max(1, Math.round(sr.percentile * 100)) + '%)</span>' : '')
                : '—';
              const bonus = sr ? (sr.sport_bonus_pts || 0) : 0;
              const bColor = bonus >= 20 ? '#FFD700' : bonus >= 10 ? '#16a34a' : '#3b4560';
              return '<tr>'
              + '<td style="font-weight:600;">' + s + '</td>'
              + '<td><span style="color:#16a34a;">' + a.wins + '</span>-<span style="color:#ef4444;">' + a.losses + '</span>' + (a.pushes ? '-' + a.pushes + 'P' : '') + '</td>'
              + '<td style="text-align:right;color:' + moneyColor(a.money) + ';font-weight:600;">' + money(a.money) + '</td>'
              + '<td style="text-align:right;font-weight:700;">' + rankStr + '</td>'
              + '<td style="text-align:right;color:' + bColor + ';font-weight:700;">' + (bonus ? '+' + bonus : '—') + '</td>'
              + '</tr>';
            }).join('');
          const sportTableHtml = sportRows
            ? '<div style="margin-bottom:18px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#8892a4;letter-spacing:0.5px;margin-bottom:8px;">By Sport ($' + unit + '/unit)</div>'
              + '<table style="width:auto;min-width:400px;"><thead><tr><th>Sport</th><th>Record</th><th style="text-align:right;">Money</th><th style="text-align:right;" title="Wilson rank inside this sport pool">Sport rank</th><th style="text-align:right;" title="Bonus a pick gets when this capper is its best backer: +20 sport #1 or top 5%, +10 top 25%">Bonus</th></tr></thead><tbody>'
              + sportRows + '</tbody></table></div>'
            : '';

          // Compact list for the MVP / 35+ sections.
          function miniList(arr) {
            return '<div style="overflow-y:auto;max-height:220px;border:1px solid #1e2330;border-radius:8px;">'
              + '<table><thead><tr><th>Date</th><th>Team</th><th>Sport</th><th>Pick</th><th style="text-align:right;">Score</th><th>Result</th></tr></thead><tbody>'
              + arr.map(p => {
                  const c    = rColor[(p.result || 'pending').toLowerCase()] || '#8892a4';
                  const date = p.game_date || (p.saved_at || '').slice(0, 10);
                  const pt   = p.pick_type || '';
                  const sp   = (pt === 'over' || pt === 'under') ? (p.spread != null ? Math.abs(parseFloat(p.spread)) : '') : (p.spread != null ? p.spread : '');
                  const pickDesc = pt + (sp !== '' ? ' ' + sp : '');
                  const sc = (p.score != null) ? Math.round(parseFloat(p.score)) : '—';
                  return '<tr>'
                    + '<td style="font-size:11px;color:#8892a4;white-space:nowrap;">' + date + '</td>'
                    + '<td style="font-weight:600;">' + (p.team || '—') + '</td>'
                    + '<td style="color:#8892a4;font-size:12px;">' + (p.sport || '—') + '</td>'
                    + '<td style="font-size:12px;">' + (pickDesc || '—') + '</td>'
                    + '<td style="text-align:right;font-weight:700;color:' + scoreColor(p.score) + ';">' + sc + '</td>'
                    + '<td><span style="background:' + c + '22;color:' + c + ';border:1px solid ' + c + '44;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700;">' + (p.result || 'pending').toUpperCase() + '</span></td>'
                    + '</tr>';
                }).join('')
              + '</tbody></table></div>';
          }
          const mvpSectionHtml = mvpList.length
            ? '<div style="margin-bottom:18px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#FFD700;letter-spacing:0.5px;margin-bottom:8px;">★ MVP Picks (' + MVP + '+ pts) — ' + mvpList.length + '</div>' + miniList(mvpList) + '</div>'
            : '';
          const highSectionHtml = highList.length
            ? '<div style="margin-bottom:18px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#f59e0b;letter-spacing:0.5px;margin-bottom:8px;">Strong Picks (' + HIGH + '–' + (MVP - 1) + ' pts) — ' + highList.length + '</div>' + miniList(highList) + '</div>'
            : '';

          const tableHtml  = picks.length
            ? '<div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#8892a4;letter-spacing:0.5px;margin-bottom:8px;">All Picks</div>'
              + '<div style="overflow-y:auto;max-height:420px;">'
              + '<table><thead><tr><th>Date</th><th>Team</th><th>Sport</th><th>Pick</th><th>Odds</th><th>Channel</th><th style="text-align:right;">Score</th><th>Result</th><th style="text-align:right;">Profit</th></tr></thead>'
              + '<tbody>' + pickRows + '</tbody></table></div>'
            : '<p style="color:#8892a4;padding:16px 0;">No pick history on record yet.</p>';

          const mvpChip  = '<span style="background:#FFD70022;color:#FFD700;border:1px solid #FFD70044;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;">★ ' + mvpList.length + ' MVP</span>';
          const highChip = '<span style="background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b44;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;">' + highList.length + ' @ ' + HIGH + '+</span>';

          // ── v3 profile extensions: ratings, chips, equity curve, type table, fade ──
          const rating = data.rating || null;
          const SRC_COLORS = { discord:['DC','#5865F2'], actionnetwork:['AN','#16a34a'], polymarket:['PM','#8b5cf6'], covers:['CV','#f59e0b'], telegram:['TG','#0ea5e9'], reddit:['RD','#f97316'] };
          const chip = (label, color) => '<span style="background:' + color + '22;color:' + color + ';border:1px solid ' + color + '44;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:800;">' + label + '</span>';
          let headerChips = '';
          if (rating) {
            if (rating.fade) headerChips += chip(rating.fade === 'active' ? 'FADE ACTIVE' : 'FADE WATCH', '#ef4444');
            else if (rating.tier === 'proven') headerChips += chip('PROVEN', '#16a34a');
            else if (rating.tier === 'rated')  headerChips += chip('RATED', '#0ea5e9');
            // Wilson standing: rank + percentile band + what a pick is worth today
            if (rating.wilson_rank != null) {
              const pc = rating.percentile != null ? ' · top ' + Math.max(1, Math.round(rating.percentile * 100)) + '%' : '';
              headerChips += ' ' + chip('RANK #' + rating.wilson_rank + pc, rating.wilson_rank <= 10 ? '#FFD700' : '#0ea5e9');
            } else {
              headerChips += ' ' + chip('UNRANKED', '#3b4560');
            }
            const pv = rating.pts != null ? Math.round(rating.pts) : 10;
            headerChips += ' ' + chip('PTS/PICK ' + pv, pv >= 76 ? '#FFD700' : pv >= 51 ? '#16a34a' : '#8892a4');
            if (rating.wilson != null) headerChips += ' ' + chip('WILSON ' + Number(rating.wilson).toFixed(3), '#8892a4');
            for (const s of (rating.sources || '').split(',').filter(Boolean)) {
              const sc = SRC_COLORS[s] || [s.slice(0,2).toUpperCase(), '#8892a4'];
              headerChips += ' ' + chip(sc[0], sc[1]);
            }
          }

          // Resume points per sport (what a pick would earn TODAY)
          const sportPts = {};
          for (const sr of (data.sportRatings || [])) sportPts[sr.sport] = sr.resume_points;

          // Equity curve: cumulative units over graded picks, oldest first (inline SVG)
          function equityCurveSvg() {
            const graded = picks.filter(p => ['win','loss','push'].includes((p.result||'').toLowerCase()))
              .slice().sort((a,b) => ((a.game_date||a.saved_at||'') < (b.game_date||b.saved_at||'') ? -1 : 1));
            if (graded.length < 3) return '';
            let run = 0; const pts = [0];
            for (const p of graded) { run += pickProfit((p.result||'').toLowerCase(), p.odds, p.pick_type, 1); pts.push(run); }
            const W = 560, H = 120, PAD = 6;
            const min = Math.min(0, ...pts), max = Math.max(0, ...pts);
            const x = (i) => PAD + (W - 2*PAD) * (i / (pts.length - 1));
            const y = (v) => max === min ? H/2 : PAD + (H - 2*PAD) * (1 - (v - min) / (max - min));
            const path = pts.map((v,i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
            const zero = y(0).toFixed(1);
            const endColor = run >= 0 ? '#16a34a' : '#ef4444';
            return '<div style="margin-bottom:18px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#8892a4;letter-spacing:0.5px;margin-bottom:8px;">Equity curve (units, all graded picks)</div>'
              + '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px;height:' + H + 'px;background:#0e1118;border:1px solid #1e2330;border-radius:8px;">'
              + '<line x1="0" y1="' + zero + '" x2="' + W + '" y2="' + zero + '" stroke="#3b4560" stroke-dasharray="3,3" stroke-width="1"/>'
              + '<path d="' + path + '" fill="none" stroke="' + endColor + '" stroke-width="2"/>'
              + '</svg>'
              + '<div style="font-size:11px;color:#8892a4;margin-top:4px;">Ends at <span style="color:' + endColor + ';font-weight:700;">' + (run>=0?'+':'') + run.toFixed(1) + 'u</span> over ' + graded.length + ' graded picks</div></div>';
          }

          // Monthly win% bars
          function monthlyBarsSvg() {
            const byMonth = {};
            for (const p of picks) {
              const rl = (p.result||'').toLowerCase();
              if (rl !== 'win' && rl !== 'loss') continue;
              const m = (p.game_date || p.saved_at || '').slice(0, 7);
              if (!m) continue;
              (byMonth[m] ||= { w:0, n:0 });
              byMonth[m].n++; if (rl === 'win') byMonth[m].w++;
            }
            const months = Object.keys(byMonth).sort();
            if (months.length < 2) return '';
            const W = 560, H = 90, bw = Math.min(70, (W - 20) / months.length - 10);
            let bars = '';
            months.forEach((m, i) => {
              const pct = byMonth[m].w / byMonth[m].n;
              const h = Math.max(3, (H - 30) * pct);
              const xPos = 10 + i * (bw + 10);
              const color = pct >= 0.55 ? '#16a34a' : pct >= 0.5 ? '#f59e0b' : '#ef4444';
              bars += '<rect x="' + xPos + '" y="' + (H - 20 - h) + '" width="' + bw + '" height="' + h + '" rx="3" fill="' + color + '66" stroke="' + color + '"/>'
                + '<text x="' + (xPos + bw/2) + '" y="' + (H - 24 - h) + '" text-anchor="middle" font-size="10" fill="' + color + '">' + Math.round(pct*100) + '% (' + byMonth[m].n + ')</text>'
                + '<text x="' + (xPos + bw/2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="9" fill="#8892a4">' + m.slice(2) + '</text>';
            });
            return '<div style="margin-bottom:18px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#8892a4;letter-spacing:0.5px;margin-bottom:8px;">Monthly win%</div>'
              + '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px;height:' + H + 'px;background:#0e1118;border:1px solid #1e2330;border-radius:8px;">' + bars + '</svg></div>';
          }

          // Per bet type WITHIN sport (from the materialized ratings)
          const typeRows = (data.typeRatings || []).filter(t => t.picks >= 3).map(t => {
            const u = Number(t.units) || 0, b = Number(t.blend) || 0;
            return '<tr>'
            + '<td style="font-weight:600;">' + (t.sport || '—') + '</td>'
            + '<td style="color:#8892a4;">' + (t.pick_type || '—').toUpperCase() + '</td>'
            + '<td><span style="color:#16a34a;">' + (t.wins || 0) + '</span>-<span style="color:#ef4444;">' + (t.losses || 0) + '</span>' + (t.pushes ? '-' + t.pushes + 'P' : '') + '</td>'
            + '<td style="text-align:right;color:' + (u > 0 ? '#16a34a' : u < 0 ? '#ef4444' : '#8892a4') + ';font-weight:600;">' + (u >= 0 ? '+' : '') + u.toFixed(1) + 'u</td>'
            + '<td style="text-align:right;color:' + (b > 0 ? '#16a34a' : '#ef4444') + ';font-size:11px;">' + (b > 0 ? '+' : '') + (b * 100).toFixed(1) + '%</td>'
            + '</tr>'; }).join('');
          const typeTableHtml = typeRows
            ? '<div style="margin-bottom:18px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#8892a4;letter-spacing:0.5px;margin-bottom:8px;">By bet type within sport</div>'
              + '<table style="width:auto;min-width:340px;"><thead><tr><th>Sport</th><th>Type</th><th>Record</th><th style="text-align:right;">Units</th><th style="text-align:right;" title="Shrunk ROI blend used by scoring and fades">Blend</th></tr></thead><tbody>'
              + typeRows + '</tbody></table></div>'
            : '';

          // Fade panel: which sport/type combos would trigger opposite-slot points
          let fadePanelHtml = '';
          if (rating && rating.fade) {
            const badTypes = (data.typeRatings || []).filter(t => t.blend < 0 && t.picks >= 3)
              .sort((a, b) => a.blend - b.blend).slice(0, 6)
              .map(t => (t.sport || '?') + ' ' + (t.pick_type || '?').toUpperCase() + ' (' + t.wins + '-' + t.losses + ', ' + (t.blend*100).toFixed(1) + '%)')
              .join(' · ');
            fadePanelHtml = '<div style="margin-bottom:18px;padding:12px;border:1px solid #ef444455;border-radius:8px;background:#ef44440d;">'
              + '<div style="font-size:12px;font-weight:800;color:#ef4444;letter-spacing:0.5px;margin-bottom:6px;">' + (rating.fade === 'active' ? 'FADE ACTIVE — opposite slots gain points when this capper posts' : 'FADE WATCH — their picks contribute 0 points') + '</div>'
              + '<div style="font-size:12px;color:#c7cbd6;">Bottom 25% of the Wilson ranking'
              + (rating.wilson_rank != null ? ' (#' + rating.wilson_rank + ')' : '')
              + ' at ' + (rating.win_pct != null ? rating.win_pct : '—') + '% over ' + (rating.decisions ?? rating.picks) + ' decisions.'
              + (badTypes ? '<br>Bleeding spots: ' + badTypes : '') + '</div></div>';
          }

          content.innerHTML =
            '<div style="margin-bottom:20px;">'
            + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px;">'
            + '<div style="font-size:20px;font-weight:700;">' + name + ' <span style="margin-left:6px;">' + headerChips + '</span></div>'
            + '<button class="btn-sm btn-primary" onclick="scanCapper(' + JSON.stringify(name).replace(/"/g, '&quot;') + ', this)">Scan &amp; Update</button>'
            + '</div>'
            + '<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;">'
            + '<span style="font-size:18px;"><span style="color:#16a34a;font-weight:700;">' + wins + 'W</span> - <span style="color:#ef4444;font-weight:700;">' + losses + 'L</span>' + pushStr + '</span>'
            + wpStr
            + '<span style="color:' + (units >= 0 ? '#16a34a' : '#ef4444') + ';font-weight:700;">' + unitStr + ' units</span>'
            + '<span style="color:' + moneyColor(totalMoney) + ';font-weight:700;">' + money(totalMoney) + ' <span style="color:#8892a4;font-weight:400;font-size:12px;">($' + unit + '/u)</span></span>'
            + mvpChip
            + highChip
            + pendingStr
            + '</div></div>'
            + fadePanelHtml
            + equityCurveSvg()
            + monthlyBarsSvg()
            + mvpSectionHtml
            + highSectionHtml
            + sportTableHtml
            + typeTableHtml
            + tableHtml;
        } catch (e) {
          console.error('[capper-detail render]', name, e);
          const msg = String((e && e.message) || e).replace(/</g, '&lt;').replace(/>/g, '&gt;');
          content.innerHTML = '<div style="color:#ef4444;padding:16px;">Error rendering capper detail.<br><span style="color:#8892a4;font-size:12px;">' + msg + '</span></div>';
        }
      }

      // ── Source Feed tab ─────────────────────────────────────────────────────────
      function filterFeedTable() {
        const q   = (document.getElementById('feed-search').value || '').toLowerCase();
        const src = document.getElementById('feed-src-filter').value || '';
        document.querySelectorAll('#feed-table .feed-row').forEach(row => {
          const okSrc = !src || row.getAttribute('data-src') === src;
          const okQ   = !q || (row.getAttribute('data-text') || '').includes(q);
          row.style.display = okSrc && okQ ? '' : 'none';
        });
      }

      // ── Messages tab ───────────────────────────────────────────────────────────
      function showMsgSection(name) {
        ['recorded','skipped','corrections'].forEach(s => {
          document.getElementById('msec-' + s).style.display = s === name ? '' : 'none';
          const btn = document.getElementById('msec-btn-' + s);
          if (btn) btn.classList.toggle('active', s === name);
        });
      }

      function filterMsgTable() {
        const q   = (document.getElementById('msg-search').value || '').toLowerCase();
        const ch  = document.getElementById('msg-ch-filter').value;
        document.querySelectorAll('.msg-row').forEach(row => {
          const matchQ  = !q  || row.dataset.text?.includes(q) || row.dataset.author?.toLowerCase().includes(q);
          const matchCh = !ch || row.dataset.ch === ch;
          row.style.display = matchQ && matchCh ? '' : 'none';
        });
      }

      function openCorrModal(msgText, channel, author, source, existingPickJson) {
        document.getElementById('corr-msg-preview').textContent = msgText;
        document.getElementById('corr-msg-full').value  = msgText;
        document.getElementById('corr-channel').value   = channel;
        document.getElementById('corr-author').value    = author;
        document.getElementById('corr-source').value    = source;
        document.getElementById('corr-notes').value     = '';
        document.getElementById('corr-status').textContent = '';
        document.querySelectorAll('input[name=corr-type]')[0].checked = true;
        toggleCorrType('pick');
        document.getElementById('corr-pick-rows').innerHTML = '';
        // Pre-fill from existing pick if available
        let pre = null;
        try { pre = existingPickJson ? JSON.parse(existingPickJson) : null; } catch(_){}
        addCorrPickRow(pre);
        document.getElementById('corr-modal').style.display = '';
      }
      function closeCorrModal(e) {
        if (!e || e.target === document.getElementById('corr-modal')) {
          document.getElementById('corr-modal').style.display = 'none';
        }
      }
      function toggleCorrType(t) {
        document.getElementById('corr-picks-section').style.display = t === 'pick' ? '' : 'none';
      }
      function removePickRow(btn) { btn.closest('div[style]').remove(); }
      function addCorrPickRow(pre) {
        const container = document.getElementById('corr-pick-rows');
        const idx = container.children.length;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px;padding:10px;background:#0f1117;border:1px solid #252c3b;border-radius:6px;';
        row.innerHTML = \`
          <div><label style="display:block;font-size:10px;color:#8892a4;margin-bottom:3px;">TEAM / PLAYER</label>
            <input type="text" class="corr-team" placeholder="e.g. Hornets" value="\${pre?.team||''}" style="width:130px;background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:6px 8px;border-radius:5px;font-size:13px;" /></div>
          <div><label style="display:block;font-size:10px;color:#8892a4;margin-bottom:3px;">PICK TYPE</label>
            <select class="corr-type-sel" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:6px 8px;border-radius:5px;font-size:13px;">
              \${['ML','spread','over','under','NRFI','h2h','top5','top10'].map(t=>\`<option value="\${t}" \${pre?.pick_type===t?'selected':''}>\${t === 'ML' ? 'Win' : t}</option>\`).join('')}
            </select></div>
          <div><label style="display:block;font-size:10px;color:#8892a4;margin-bottom:3px;">SPORT</label>
            <select class="corr-sport" style="background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:6px 8px;border-radius:5px;font-size:13px;">
              \${['','NBA','MLB','NHL','NFL','CBB','NCAAF','ATP','WTA','Golf'].map(s=>\`<option value="\${s}" \${pre?.sport===s?'selected':''}>\${s||'—'}</option>\`).join('')}
            </select></div>
          <div><label style="display:block;font-size:10px;color:#8892a4;margin-bottom:3px;">SPREAD</label>
            <input type="number" class="corr-spread" placeholder="e.g. -1.5" value="\${pre?.spread??''}" step="0.5" style="width:80px;background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:6px 8px;border-radius:5px;font-size:13px;" /></div>
          <div><label style="display:block;font-size:10px;color:#8892a4;margin-bottom:3px;">CAPPER</label>
            <input type="text" class="corr-capper" placeholder="optional" value="\${pre?.capper_name||''}" style="width:110px;background:#1e2330;border:1px solid #252c3b;color:#e2e8f0;padding:6px 8px;border-radius:5px;font-size:13px;" /></div>
          \${idx > 0 ? '<button onclick="removePickRow(this)" style="background:#7f1d1d;color:#fca5a5;border:none;border-radius:5px;padding:6px 10px;font-size:11px;cursor:pointer;align-self:flex-end;">Remove</button>' : ''}
        \`;
        container.appendChild(row);
      }

      async function submitCorrection() {
        const isNoPick = document.querySelector('input[name=corr-type]:checked').value === 'nopick';
        const picks = [];
        if (!isNoPick) {
          document.querySelectorAll('#corr-pick-rows > div').forEach(row => {
            const team = row.querySelector('.corr-team').value.trim();
            if (!team) return;
            picks.push({
              team,
              pick_type: row.querySelector('.corr-type-sel').value,
              sport:     row.querySelector('.corr-sport').value || null,
              spread:    row.querySelector('.corr-spread').value !== '' ? parseFloat(row.querySelector('.corr-spread').value) : null,
              capper_name: row.querySelector('.corr-capper').value.trim() || null,
            });
          });
          if (!picks.length) { document.getElementById('corr-status').textContent = 'Add at least one pick or select "Not a pick".'; return; }
        }
        const status = document.getElementById('corr-status');
        status.textContent = 'Saving...'; status.style.color = '#8892a4';
        const r = await fetch('/admin/correction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message_text:  document.getElementById('corr-msg-full').value,
            channel:       document.getElementById('corr-channel').value,
            author:        document.getElementById('corr-author').value,
            source:        document.getElementById('corr-source').value,
            is_no_pick:    isNoPick ? 1 : 0,
            correct_picks: picks,
            notes:         document.getElementById('corr-notes').value.trim(),
          }),
        });
        const d = await r.json();
        if (d.ok) { status.textContent = 'Saved! Active on next reader call.'; status.style.color = '#16a34a'; setTimeout(() => location.reload(), 1200); }
        else { status.textContent = 'Error: ' + (d.error || 'unknown'); status.style.color = '#ef4444'; }
      }

      async function deleteCorrection(id) {
        if (!confirm('Delete this correction?')) return;
        await fetch('/admin/correction/' + id, { method: 'DELETE' });
        location.reload();
      }
      // ── Pick History tab ───────────────────────────────────────────────────────
      let _phData  = [];
      let _phLoaded = false;

      function phEsc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }
      function phFmtOdds(n) { return n == null ? '—' : (n > 0 ? '+' : '') + n; }

      function phAutoLoad() {
        if (!_phLoaded) phLoad();
      }

      async function phLoad() {
        const sport  = document.getElementById('ph-sport').value;
        const result = document.getElementById('ph-result').value;
        const limit  = document.getElementById('ph-limit').value;
        const wrap   = document.getElementById('ph-table-wrap');
        const countEl = document.getElementById('ph-count');

        wrap.innerHTML = '<p class="empty">Loading...</p>';
        countEl.textContent = '';

        let url = '/api/pick-history?limit=' + limit;
        if (sport)  url += '&sport='  + encodeURIComponent(sport);
        if (result) url += '&result=' + encodeURIComponent(result);

        try {
          const r = await fetch(url);
          _phData   = await r.json();
          _phLoaded = true;
          phFilter();
        } catch (err) {
          wrap.innerHTML = \`<p class="empty" style="color:#ef4444;">Error: \${phEsc(err.message)}</p>\`;
        }
      }

      function phFilter() {
        if (!_phLoaded) return;
        const q       = (document.getElementById('ph-search').value || '').toLowerCase().trim();
        const type    = document.getElementById('ph-type').value.toLowerCase();
        const dateFrom = document.getElementById('ph-date-from').value;
        const dateTo   = document.getElementById('ph-date-to').value;
        const ptsMin   = parseFloat(document.getElementById('ph-pts-min').value);
        const ptsMax   = parseFloat(document.getElementById('ph-pts-max').value);

        const filtered = _phData.filter(p => {
          if (type && (p.pick_type || '').toLowerCase() !== type) return false;
          const sc = Number(p.score);
          if (!isNaN(ptsMin) && sc < ptsMin) return false;
          if (!isNaN(ptsMax) && sc > ptsMax) return false;
          const d = (p.game_date || '').slice(0, 10);
          if (dateFrom && d < dateFrom) return false;
          if (dateTo   && d > dateTo)   return false;
          if (q) {
            const hay = [p.team, p.capper_name, p.home_team, p.away_team]
              .map(v => (v || '').toLowerCase()).join(' ');
            if (!hay.includes(q)) return false;
          }
          return true;
        });

        phRender(filtered);
      }

      function phRender(rows) {
        const wrap    = document.getElementById('ph-table-wrap');
        const countEl = document.getElementById('ph-count');
        const recEl   = document.getElementById('ph-record');

        if (!rows.length) {
          wrap.innerHTML = '<p class="empty">No picks match these filters.</p>';
          countEl.textContent = '';
          recEl.style.display = 'none';
          return;
        }

        // W/L/P summary
        let wins = 0, losses = 0, pushes = 0;
        for (const p of rows) {
          if (p.result === 'win')  wins++;
          else if (p.result === 'loss') losses++;
          else if (p.result === 'push') pushes++;
        }
        const decided = wins + losses;
        const wr = decided > 0 ? Math.round(wins / decided * 100) + '%' : '—';
        document.getElementById('ph-rec-w').textContent = wins + ' W';
        document.getElementById('ph-rec-l').textContent = losses + ' L';
        document.getElementById('ph-rec-p').textContent = pushes + ' P';
        document.getElementById('ph-rec-rate').textContent = wr + ' win rate';
        recEl.style.display = 'flex';

        countEl.textContent = rows.length + ' picks';

        const rColor = r => r === 'win' ? '#16a34a' : r === 'loss' ? '#ef4444' : r === 'push' ? '#f59e0b' : '#64748b';
        const rLabel = r => ({ win:'WIN', loss:'LOSS', push:'PUSH', void:'VOID' })[r] || 'PEND';
        const chShort = ch => ch === 'free-plays' ? 'free' : ch === 'pod-thread' ? 'pod' : ch === 'community-leaks' ? 'leaks' : (ch || '—');
        const chColor = ch => ch === 'free-plays' ? '#f59e0b' : ch === 'pod-thread' ? '#a78bfa' : '#64748b';

        wrap.innerHTML = \`<div style="overflow-x:auto;">
          <table id="ph-table">
            <thead><tr>
              <th>Date</th>
              <th>Sport</th>
              <th>Matchup</th>
              <th>Picked</th>
              <th>Type</th>
              <th>Line</th>
              <th>Pts</th>
              <th>Channel</th>
              <th>Result</th>
              <th>Final</th>
            </tr></thead>
            <tbody>
              \${rows.map(p => {
                const date     = (p.game_date || '').slice(0, 10);
                const matchup  = p.home_team && p.away_team
                  ? phEsc(p.away_team) + ' @ ' + phEsc(p.home_team)
                  : phEsc(p.team || '—');
                const typeStr  = (p.pick_type || '').toLowerCase();
                const line     = typeStr === 'over' || typeStr === 'under'
                  ? (p.spread != null ? 'O/U ' + p.spread : '—')
                  : typeStr === 'spread'
                  ? (p.spread != null ? (p.spread > 0 ? '+' : '') + p.spread : '—')
                  : phFmtOdds(p.ml_odds);
                const final    = p.home_score != null && p.away_score != null
                  ? p.home_score + '–' + p.away_score
                  : '—';
                const scoreTxt = p.score >= ${v3Now ? 100 : 60}
                  ? \`<span style="color:#FFD700;font-weight:700;">\${p.score}</span>\`
                  : p.score >= ${v3Now ? 75 : 50}
                  ? \`<span style="color:#b0bcd4;font-weight:700;">\${p.score}</span>\`
                  : p.score;
                return \`<tr>
                  <td style="font-size:11px;color:#8892a4;white-space:nowrap;">\${phEsc(date)}</td>
                  <td><span class="badge" style="background:#1e2330;color:#8892a4;font-size:10px;">\${phEsc(p.sport || '—')}</span></td>
                  <td style="font-size:12px;">\${matchup}</td>
                  <td style="font-weight:600;font-size:13px;">\${phEsc(p.team || '—')}</td>
                  <td style="font-size:11px;text-transform:uppercase;color:#8892a4;">\${phEsc(p.pick_type || '—')}</td>
                  <td style="font-size:12px;font-weight:600;">\${phEsc(line)}</td>
                  <td style="font-size:13px;">\${scoreTxt}</td>
                  <td style="font-size:11px;color:\${chColor(p.channel)};">\${phEsc(chShort(p.channel))}</td>
                  <td><span style="color:\${rColor(p.result)};font-weight:700;font-size:12px;">\${rLabel(p.result)}</span></td>
                  <td style="font-size:12px;color:#8892a4;">\${phEsc(final)}</td>
                </tr>\`;
              }).join('')}
            </tbody>
          </table>
        </div>\`;
      }

      // Auto-load archive panel on direct navigation (?tab=archive) — the tab
      // button onclick handler only fires on click, so direct nav needs a kick.
      if (${JSON.stringify(activeTab)} === 'archive') archiveLoad();
    </script>
    <style>@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }</style>
  `));
});

// ── POST /admin/nuke ──────────────────────────────────────────────────────────
// ── POST /admin/capper-alias ──────────────────────────────────────────────────
router.post('/correction', requireAuth, express.json(), (req, res) => {
  const { message_text, channel, author, source, is_no_pick, correct_picks, notes } = req.body || {};
  if (!message_text) return res.json({ ok: false, error: 'message_text required' });
  try {
    db.prepare(`
      INSERT INTO reader_corrections (message_text, channel, author, source, is_no_pick, correct_picks, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      message_text.trim(),
      channel || null,
      author  || null,
      source  || 'recorded',
      is_no_pick ? 1 : 0,
      JSON.stringify(correct_picks || []),
      notes || null,
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.delete('/correction/:id', requireAuth, (req, res) => {
  try {
    db.prepare(`DELETE FROM reader_corrections WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post('/mvp-threshold', requireAuth, express.json(), (req, res) => {
  const val = parseInt(req.body?.threshold, 10);
  if (isNaN(val) || val < 0 || val > 200) return res.json({ ok: false, error: 'Must be 0–200' });
  db.setSetting('mvp_display_threshold', val);
  res.json({ ok: true, threshold: val });
});

router.post('/bet-unit', requireAuth, express.json(), (req, res) => {
  const val = parseFloat(req.body?.unit);
  if (isNaN(val) || val < 1 || val > 10000) return res.json({ ok: false, error: 'Must be 1–10000' });
  db.setSetting('bet_unit', val);
  res.json({ ok: true, unit: val });
});

router.post('/capper-alias', requireAuth, express.json(), (req, res) => {
  const { canonical, alias } = req.body || {};
  if (!canonical || !alias) return res.json({ ok: false, error: 'Both canonical and alias are required' });
  try {
    let canon = canonical.trim();
    const al = alias.trim();
    // Flatten the target: if the requested canonical is itself an alias, chase
    // the chain so this row points straight at the final identity.
    const normK = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (let hops = 0; hops < 5; hops++) {
      const hit = db.prepare(`SELECT canonical_name FROM capper_aliases`).all()
        .find(r => normK(r.alias) === normK(canon));
      if (!hit || hit.canonical_name === canon) break;
      canon = hit.canonical_name;
    }
    if (normK(canon) === normK(al)) return res.json({ ok: false, error: 'That would merge a capper into itself' });
    db.prepare(`INSERT OR REPLACE INTO capper_aliases (canonical_name, alias) VALUES (?, ?)`)
      .run(canon, al);
    // Collapse chains: anything that pointed AT the merged name now points at
    // the final canonical, so no alias row targets a name that is itself an alias.
    db.prepare(`UPDATE capper_aliases SET canonical_name = ? WHERE canonical_name = ?`).run(canon, al);
    // Drop degenerate self-rows a collapse can produce.
    db.prepare(`DELETE FROM capper_aliases WHERE canonical_name = alias`).run();

    // A merge must propagate NOW, not at the next nightly recompute. Otherwise
    // today's board keeps showing the old name AND (worse) scoring goes stale:
    // after a recompute folds the alias's history into the canonical pool, the
    // alias name has no ratings row left, so its mentions score as untracked.
    // 1. Rename the alias on today's live tables (display + scoring lookups).
    const rmUpd = db.prepare(`UPDATE raw_messages SET capper_name = ? WHERE capper_name = ?`).run(canon, al).changes;
    const pkUpd = db.prepare(`UPDATE picks SET capper_name = ? WHERE capper_name = ?`).run(canon, al).changes;
    // 2. Repoint source handles so future scraper picks write the canonical name.
    let handleUpd = 0;
    try { handleUpd = db.prepare(`UPDATE capper_source_handles SET canonical_name = ? WHERE canonical_name = ?`).run(canon, al).changes; } catch (_) {}
    // 3. Re-rank (combined record = new Wilson position) + rescore the board so
    //    every pick the merged capper touches carries the right points.
    let rescored = 0;
    try {
      require('./capper_ratings').recomputeCapperRatings();
      const { computeAndLogV3 } = require('./scoring_v3');
      for (const p of db.prepare(`SELECT id FROM picks WHERE mention_count > 0`).all()) {
        try { if (computeAndLogV3(p.id)) rescored++; } catch (_) {}
      }
    } catch (err) {
      console.warn('[capper-alias] recompute/rescore after merge failed:', err.message);
    }
    res.json({ ok: true, renamed_mentions: rmUpd, renamed_picks: pkUpd, handles: handleUpd, rescored });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── DELETE /admin/capper-alias/:id ───────────────────────────────────────────
router.delete('/capper-alias/:id', requireAuth, (req, res) => {
  try {
    db.prepare(`DELETE FROM capper_aliases WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post('/nuke', requireAuth, async (_req, res) => {
  for (const table of NUKE_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
  }
  console.log('[admin] Nuke complete — reseeding slots from existing odds data');
  await reseedFromExisting();
  scanner.resetState().catch(err => console.error('[admin] resetState error:', err.message));
  res.json({ success: true });
});

// ── POST /admin/refresh-odds — manual Odds API pull + reseed ─────────────────
router.post('/refresh-odds', requireAuth, async (_req, res) => {
  try {
    const { refreshOdds }      = require('./odds_api');
    const { seedPickSlots }    = require('./lines');
    const updated = await refreshOdds();
    await seedPickSlots();
    res.json({ ok: true, updated });
  } catch (err) {
    console.error('[admin] refresh-odds error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /admin/rescan-from-start ─────────────────────────────────────────────
router.post('/rescan-from-start', requireAuth, (_req, res) => {
  db.prepare(`DELETE FROM scanner_state`).run();
  scanner.scanAll().catch(err => console.error('[admin] rescan error:', err.message));
  res.json({ ok: true });
});

// ── POST /admin/rescan-skipped ────────────────────────────────────────────────
router.post('/rescan-skipped', requireAuth, (_req, res) => {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM skipped_messages`).get().c;
  rescanSkipped().catch(err => console.error('[admin] rescanSkipped error:', err.message));
  res.json({ ok: true, queued: count });
});

// ── POST /admin/fetch-games — re-fetch ESPN schedule + seed slots ─────────────
router.post('/fetch-games', requireAuth, (_req, res) => {
  res.json({ ok: true });
  (async () => {
    const { fetchTodaysGames } = require('./espn_live');
    const { fetchTodaysTennisMatches } = require('./tennis_espn');
    const { seedPickSlots } = require('./lines');
    await fetchTodaysGames();
    await fetchTodaysTennisMatches();
    await seedPickSlots();
    console.log('[admin] fetch-games: done');
  })().catch(err => console.error('[admin] fetch-games error:', err.message));
});

// ── GET /admin/mvp → redirect ─────────────────────────────────────────────────
router.get('/mvp', requireAuth, (_req, res) => res.redirect('/admin/dashboard?tab=mvp'));

// ── GET /admin/mvp-detail/:id — JSON for modal ────────────────────────────────
router.post('/mvp-result/:id', requireAuth, express.json(), (req, res) => {
  const { result } = req.body;
  const valid = ['win', 'loss', 'push', 'pending', 'void'];
  if (!valid.includes(result)) return res.json({ ok: false, error: 'Invalid result' });
  db.prepare(`UPDATE mvp_picks SET result = ?, annotation = NULL WHERE id = ?`)
    .run(result, req.params.id);
  res.json({ ok: true });
});

router.get('/mvp-detail/:id', requireAuth, (req, res) => {
  const mvp = db.prepare(`
    SELECT m.*,
           COALESCE(tg1.home_team, tg2.home_team) AS home_team,
           COALESCE(tg1.away_team, tg2.away_team) AS away_team
    FROM mvp_picks m
    LEFT JOIN today_games tg1 ON tg1.espn_game_id = m.espn_game_id
    LEFT JOIN today_games tg2 ON tg1.espn_game_id IS NULL
                              AND (LOWER(tg2.home_team) = LOWER(m.team) OR LOWER(tg2.away_team) = LOWER(m.team))
    WHERE m.id = ?
  `).get(req.params.id);
  if (!mvp) return res.status(404).json({ error: 'Not found' });

  let pick = null;
  if (mvp.espn_game_id) {
    pick = db.prepare(`SELECT * FROM picks WHERE espn_game_id = ? AND LOWER(team) = LOWER(?) AND LOWER(pick_type) = LOWER(?) LIMIT 1`)
      .get(mvp.espn_game_id, mvp.team, mvp.pick_type || '');
  }
  if (!pick) {
    pick = db.prepare(`SELECT * FROM picks WHERE LOWER(team) = LOWER(?) AND LOWER(pick_type) = LOWER(?) AND game_date = ? LIMIT 1`)
      .get(mvp.team, mvp.pick_type || '', mvp.game_date || '');
  }
  const messages  = pick ? db.prepare(`SELECT * FROM raw_messages WHERE pick_id = ? ORDER BY message_timestamp ASC, saved_at ASC`).all(pick.id) : [];
  const breakdown = pick ? db.prepare(`SELECT * FROM score_breakdown WHERE pick_id = ? LIMIT 1`).get(pick.id) : null;
  res.json({ mvp, pick, messages, breakdown });
});

// ── GET /admin/game-detail/:espn_game_id — full debug payload ─────────────────
router.get('/game-detail/:espn_game_id', requireAuth, (req, res) => {
  const { espn_game_id } = req.params;
  const game = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(espn_game_id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const picks   = db.prepare(`SELECT * FROM picks WHERE espn_game_id = ? AND mention_count > 0 ORDER BY score DESC`).all(espn_game_id);
  const pickIds = picks.map(p => p.id);

  const rawMessages = {}, scoreBreakdowns = {}, cappers = {};
  if (pickIds.length) {
    const ph = pickIds.map(() => '?').join(',');
    db.prepare(`SELECT * FROM raw_messages WHERE pick_id IN (${ph}) ORDER BY saved_at ASC`).all(...pickIds)
      .forEach(m => { if (!rawMessages[m.pick_id]) rawMessages[m.pick_id] = []; rawMessages[m.pick_id].push(m); });
    db.prepare(`SELECT * FROM score_breakdown WHERE pick_id IN (${ph})`).all(...pickIds)
      .forEach(bd => { scoreBreakdowns[bd.pick_id] = bd; });
    db.prepare(`SELECT pick_id, author, channel, COUNT(*) AS count FROM raw_messages WHERE pick_id IN (${ph}) AND author IS NOT NULL GROUP BY pick_id, author, channel`).all(...pickIds)
      .forEach(r => { if (!cappers[r.pick_id]) cappers[r.pick_id] = []; cappers[r.pick_id].push({ author: r.author, channel: r.channel, count: r.count }); });
  }
  res.json({ game, picks, rawMessages, scoreBreakdowns, cappers });
});

// ── GET /admin/codes → redirect ───────────────────────────────────────────────
router.get('/codes', requireAuth, (_req, res) => res.redirect('/admin/dashboard?tab=codes'));

// ── POST /admin/generate-code (form POST, legacy) ─────────────────────────────
router.post('/generate-code', requireAuth, express.urlencoded({ extended: false }), (req, res) => {
  const { type, notes } = req.body;
  const validTypes = ['day', 'week', 'annual', 'lifetime'];
  if (!validTypes.includes(type)) return res.status(400).send('Invalid code type.');
  const code = (req.body.code || '').trim().toUpperCase() || generateCode();
  try {
    db.prepare(`INSERT INTO access_codes (code, type, notes) VALUES (?, ?, ?)`).run(code, type, notes || null);
  } catch (_) {
    return res.status(409).send('Code already exists: ' + code);
  }
  res.redirect('/admin/dashboard?tab=codes');
});

// ── POST /admin/generate-codes-batch — JSON code creator ─────────────────────
// Accepts a custom name OR a batch count, a duration in days (0 = lifetime), and a
// user limit (0 = unlimited). Legacy callers may still pass a `type` instead of days.
router.post('/generate-codes-batch', requireAuth, express.json(), (req, res) => {
  const body = req.body || {};
  const { type, notes } = body;
  const { code, count = 1, durationDays, maxUses } = body;

  // Resolve access length in days. New callers send durationDays; legacy send `type`.
  // Either way we store duration_days so every surface renders uniformly.
  const TYPE_DAYS = { day: 1, week: 7, annual: 365, lifetime: 0 };
  let dd;
  if (durationDays != null && durationDays !== '') {
    dd = parseInt(durationDays, 10);
    if (isNaN(dd) || dd < 0) return res.status(400).json({ ok: false, error: 'Invalid duration.' });
  } else if (type != null) {
    if (!(type in TYPE_DAYS)) return res.status(400).json({ ok: false, error: 'Invalid code type.' });
    dd = TYPE_DAYS[type];
  } else {
    return res.status(400).json({ ok: false, error: 'A duration is required.' });
  }
  const label = dd === 0 ? 'lifetime' : 'custom';

  // User limit: 0 = unlimited, >= 1 = capped.
  let mu = parseInt(maxUses, 10);
  if (isNaN(mu) || mu < 0) mu = 1;

  const insert = db.prepare(`INSERT INTO access_codes (code, type, notes, max_uses, duration_days) VALUES (?, ?, ?, ?, ?)`);
  const codes  = [];

  const custom = (code || '').trim().toUpperCase();
  if (custom) {
    // Custom-named code → single insert, must be unique.
    if (db.prepare(`SELECT id FROM access_codes WHERE LOWER(code) = LOWER(?)`).get(custom)) {
      return res.status(409).json({ ok: false, error: 'Code already exists: ' + custom });
    }
    insert.run(custom, label, notes || null, mu, dd);
    codes.push(custom);
  } else {
    const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 50);
    for (let i = 0; i < n; i++) {
      let gen, tries = 0;
      do { gen = generateCode(); tries++; } while (tries < 10 && db.prepare(`SELECT id FROM access_codes WHERE code = ?`).get(gen));
      insert.run(gen, label, notes || null, mu, dd);
      codes.push(gen);
    }
  }
  console.log(`[admin] Created ${codes.length} code(s) (${dd === 0 ? 'lifetime' : dd + 'd'}, limit ${mu === 0 ? '∞' : mu}): ${codes.join(', ')}`);
  res.json({ ok: true, codes });
});

// ── DELETE /admin/delete-code/:id ─────────────────────────────────────────────
// Single-use codes are locked once redeemed (preserves the record). Multi-use /
// unlimited codes stay deletable; removing one just stops further redemptions —
// users who already redeemed keep the access already granted to them.
router.delete('/delete-code/:id', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT ac.id, ac.max_uses,
           (SELECT COUNT(*) FROM code_redemptions r WHERE r.code_id = ac.id) AS use_count
    FROM access_codes ac WHERE ac.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  const maxUses = row.max_uses == null ? 1 : row.max_uses;
  const isMulti = maxUses === 0 || maxUses > 1;
  if (!isMulti && row.use_count > 0) {
    return res.status(409).json({ ok: false, error: 'Cannot delete a used single-use code.' });
  }
  db.prepare(`DELETE FROM code_redemptions WHERE code_id = ?`).run(row.id);
  db.prepare(`DELETE FROM access_codes WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

// ── GET /admin/api/code-users/:id — who redeemed a multi-use code ─────────────
router.get('/api/code-users/:id', requireAuth, (req, res) => {
  const code = db.prepare(`SELECT id, code, max_uses FROM access_codes WHERE id = ?`).get(req.params.id);
  if (!code) return res.status(404).json({ ok: false, error: 'Not found' });
  const users = db.prepare(`
    SELECT r.redeemed_at, u.id, u.username, u.email, u.subscription_tier, u.subscription_expires
    FROM code_redemptions r
    LEFT JOIN users u ON u.id = r.user_id
    WHERE r.code_id = ?
    ORDER BY r.redeemed_at ASC
  `).all(code.id);
  res.json({ ok: true, code: code.code, maxUses: code.max_uses == null ? 1 : code.max_uses, users });
});

// ── GET /admin/api/users — JSON for AJAX search ───────────────────────────────
router.get('/api/users', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ users: [], q });
  const users = db.prepare(`
    SELECT id, email, username, subscription_tier, subscription_expires, created_at
    FROM users
    WHERE LOWER(username) LIKE LOWER(?) OR LOWER(email) LIKE LOWER(?)
    ORDER BY created_at DESC LIMIT 50
  `).all(`%${q}%`, `%${q}%`);
  res.json({ users, q });
});

// ── Dummy accounts — combined editor (name, range, sports, active, board) ─────
router.post('/api/dummy/save', requireAuth, express.json(), (req, res) => {
  const { id, ...fields } = req.body || {};
  res.json(dummyAccounts.saveDummyAccount(parseInt(id, 10), fields));
});

// ── POST /admin/api/grant — JSON endpoint ────────────────────────────────────
router.post('/api/grant', requireAuth, express.json(), (req, res) => {
  const { user_id, tier } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  let expires = null;
  if (tier === 'day')    expires = new Date(Date.now() + 1   * 24 * 60 * 60 * 1000).toISOString();
  if (tier === 'week')   expires = new Date(Date.now() + 7   * 24 * 60 * 60 * 1000).toISOString();
  if (tier === 'annual') expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const tierName = tier === 'lifetime' ? 'lifetime' : tier;
  db.prepare(`UPDATE users SET subscription_tier = ?, subscription_expires = ? WHERE id = ?`).run(tierName, expires, user_id);
  res.json({ success: true });
});

// ── POST /admin/api/revoke — JSON endpoint ───────────────────────────────────
router.post('/api/revoke', requireAuth, express.json(), (req, res) => {
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  db.prepare(`UPDATE users SET subscription_tier = 'free', subscription_expires = NULL WHERE id = ?`).run(user_id);
  res.json({ success: true });
});

// ── GET /admin/users → redirect ───────────────────────────────────────────────
router.get('/users', requireAuth, (_req, res) => res.redirect('/admin/dashboard?tab=users'));

// ── POST /admin/grant-access — form fallback ─────────────────────────────────
router.post('/grant-access', requireAuth, express.urlencoded({ extended: false }), (req, res) => {
  const { user_id, tier } = req.body;
  if (!user_id) return res.status(400).send('Missing user_id');
  let expires = null;
  if (tier === 'day')    expires = new Date(Date.now() + 1   * 24 * 60 * 60 * 1000).toISOString();
  if (tier === 'week')   expires = new Date(Date.now() + 7   * 24 * 60 * 60 * 1000).toISOString();
  if (tier === 'annual') expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`UPDATE users SET subscription_tier = ?, subscription_expires = ? WHERE id = ?`)
    .run(tier === 'lifetime' ? 'lifetime' : tier, expires, user_id);
  res.redirect('/admin/dashboard?tab=users');
});

// ── POST /admin/revoke-access — form fallback ────────────────────────────────
router.post('/revoke-access', requireAuth, express.urlencoded({ extended: false }), (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).send('Missing user_id');
  db.prepare(`UPDATE users SET subscription_tier = 'free', subscription_expires = NULL WHERE id = ?`).run(user_id);
  res.redirect('/admin/dashboard?tab=users');
});


// ── GET /admin/export-capper-history — channel-complete capper data pull ─────
// Header-auth (x-admin-password) so local calibration scripts can pull the full
// row-level history the public pick-history endpoint deliberately strips.
// Read-only. v3 Phase 1 (docs/CA_ALGORITHM_V3.md).
router.get('/export-capper-history', adminLoginRateLimit, (req, res) => {
  const pw = req.headers['x-admin-password'];
  if (!pw || !process.env.ADMIN_PASSWORD || !safeEqual(pw, process.env.ADMIN_PASSWORD)) {
    return res.status(401).send('Unauthorized');
  }
  try {
    const rows = db.prepare(`SELECT * FROM capper_history ORDER BY id ASC`).all();
    const pickHistory = db.prepare(`SELECT * FROM pick_history ORDER BY id ASC`).all();
    const aliases = db.prepare(`SELECT * FROM capper_aliases`).all();
    const handles = (() => {
      try { return db.prepare(`SELECT * FROM capper_source_handles`).all(); } catch (_) { return []; }
    })();
    res.json({ exported_at: new Date().toISOString(), capper_history: rows, pick_history: pickHistory, capper_aliases: aliases, capper_source_handles: handles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/api/an-experts-import — seed AN experts from the Mac relay ───
// Action Network's HTML pages are bot-challenged from datacenter IPs (Railway),
// so discovery cannot run on prod; the open users API works fine, so polling
// can. scripts/an_relay.js runs discovery on the Mac and POSTs the roster here.
// Header-auth like import-mvp. Upsert-only, safe to re-run.
router.post('/api/an-experts-import', adminLoginRateLimit, express.json({ limit: '1mb' }), (req, res) => {
  const pw = req.headers['x-admin-password'];
  if (!pw || !process.env.ADMIN_PASSWORD || !safeEqual(pw, process.env.ADMIN_PASSWORD)) {
    return res.status(401).send('Unauthorized');
  }
  const experts = req.body;
  if (!Array.isArray(experts)) return res.status(400).send('Expected JSON array');
  const { ensureRegistered } = require('./storage');
  let upserts = 0;
  for (const e of experts) {
    if (!e || !e.user_id || !e.username) continue;
    try {
      db.prepare(`
        INSERT INTO an_experts (user_id, username, name, followers, is_internal, last_seen)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username, name = excluded.name,
          followers = excluded.followers, is_internal = excluded.is_internal,
          last_seen = datetime('now')
      `).run(String(e.user_id), String(e.username), e.name || String(e.username), e.followers ?? null, e.is_internal ? 1 : 0);
      ensureRegistered(e.name || String(e.username), 'actionnetwork', String(e.username));
      upserts++;
    } catch (_) {}
  }
  const total = db.prepare(`SELECT COUNT(*) n FROM an_experts`).get().n;
  console.log(`[an_experts] import: ${upserts} upserted via relay (${total} total)`);
  res.json({ upserted: upserts, total });
});

// ── POST /admin/api/recompute-ratings — on-demand capper ratings refresh ─────
router.post('/api/recompute-ratings', requireAuth, (_req, res) => {
  try {
    const { recomputeCapperRatings } = require('./capper_ratings');
    res.json(recomputeCapperRatings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/api/capper-sources.json — CA Ops capper pipeline health ────────
// Consumed by the desktop ops console (ops/server.js). One JSON with: per-source
// ingestion health, ratings summary, fade list, and the drift-monitor skeleton
// (v2 tracked-tier trailing record until the v3 tiers go live). v3 Phase 2.
router.get('/api/capper-sources.json', requireAuth, (_req, res) => {
  const one = (sql, ...args) => { try { return db.prepare(sql).get(...args); } catch (_) { return null; } };
  const all = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch (_) { return []; } };
  try {
    const sourceRows = all(`
      SELECT source, COUNT(*) rows_total,
             SUM(CASE WHEN saved_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) rows_24h,
             MAX(saved_at) last_write
      FROM capper_history GROUP BY source ORDER BY rows_total DESC
    `);
    // A source that has never written a row must still show up (as zero) — an
    // absent line is exactly how the AN discovery block went unnoticed.
    const EXPECTED_SOURCES = ['discord', 'actionnetwork', 'polymarket', 'covers'];
    const sources = [
      ...sourceRows,
      ...EXPECTED_SOURCES.filter(s => !sourceRows.some(r => r.source === s))
        .map(s => ({ source: s, rows_total: 0, rows_24h: 0, last_write: null })),
    ];
    const discordToday = one(`
      SELECT COUNT(*) picks_today,
             SUM(CASE WHEN capper_name IS NOT NULL AND capper_name != '' THEN 1 ELSE 0 END) with_capper
      FROM picks
    `);
    const unresolved24h = one(`
      SELECT COUNT(*) n FROM raw_messages_archive
      WHERE archived_at >= datetime('now','-1 day') AND (capper_matched IS NULL OR capper_matched = 0)
        AND capper_raw IS NOT NULL AND capper_raw != ''
    `);
    const ratings = one(`
      SELECT COUNT(*) cappers,
             SUM(CASE WHEN tier IN ('rated','proven') THEN 1 ELSE 0 END) rated,
             SUM(CASE WHEN tier = 'proven' THEN 1 ELSE 0 END) proven,
             SUM(CASE WHEN fade = 'watch'  THEN 1 ELSE 0 END) fade_watch,
             SUM(CASE WHEN fade = 'active' THEN 1 ELSE 0 END) fade_active,
             MAX(computed_at) computed_at
      FROM capper_ratings WHERE scope = 'overall' AND tier != 'entity'
    `);
    const fadeList = all(`
      SELECT canonical_name, fade, picks, ROUND(units, 1) units, ROUND(blend * 100, 1) blend_pct
      FROM capper_ratings WHERE scope = 'overall' AND fade IS NOT NULL ORDER BY blend ASC LIMIT 8
    `);
    // Drift: trailing 30d record of the publicly tracked tier. Scale-aware:
    // after the v3 flip + history rescale the tier line is 100 on every row.
    const tierLine = db.getSetting('scoring_version', 'v2') === 'v3' ? 100 : 65;
    const drift = one(`
      SELECT SUM(result='win') w, SUM(result='loss') l
      FROM pick_history
      WHERE score >= ${tierLine} AND result IN ('win','loss') AND game_date >= date('now','-30 days')
    `);
    const registry = one(`SELECT (SELECT COUNT(*) FROM capper_registry) cappers, (SELECT COUNT(*) FROM capper_source_handles) handles`);
    res.json({
      generatedAt: new Date().toISOString(),
      sources, discordToday, unresolved24h: unresolved24h?.n ?? 0,
      ratings, fadeList, registry,
      drift: { window: '30d', tier: 'v2-65plus', wins: drift?.w ?? 0, losses: drift?.l ?? 0,
               alarm: (drift?.w ?? 0) + (drift?.l ?? 0) >= 20 && (drift?.w ?? 0) / Math.max(1, (drift?.w ?? 0) + (drift?.l ?? 0)) < 0.524 },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/import-mvp — import MVP picks from JSON (use after redeploy) ─
router.post('/import-mvp', adminLoginRateLimit, express.json({ limit: '5mb' }), (req, res) => {
  const pw = req.headers['x-admin-password'];
  if (!pw || !process.env.ADMIN_PASSWORD || !safeEqual(pw, process.env.ADMIN_PASSWORD)) {
    return res.status(401).send('Unauthorized');
  }
  const picks = req.body;
  if (!Array.isArray(picks)) return res.status(400).send('Expected JSON array');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO mvp_picks
      (id, team, sport, pick_type, spread, original_line, game_date, score, result, saved_at,
       espn_game_id, home_score, away_score, ml_odds, annotation, ou_odds)
    VALUES
      (@id, @team, @sport, @pick_type, @spread, @original_line, @game_date, @score, @result, @saved_at,
       @espn_game_id, @home_score, @away_score, @ml_odds, @annotation, @ou_odds)
  `);
  db.transaction(rows => rows.forEach(r => insert.run(r)))(picks);
  const count = db.prepare('SELECT COUNT(*) as n FROM mvp_picks').get().n;
  res.json({ imported: picks.length, total: count });
});

// ── PATCH /admin/patch-mvp — update specific fields on an MVP pick by id ─────
router.post('/patch-mvp', adminLoginRateLimit, express.json(), (req, res) => {
  const pw = req.headers['x-admin-password'];
  if (!pw || !process.env.ADMIN_PASSWORD || !safeEqual(pw, process.env.ADMIN_PASSWORD)) {
    return res.status(401).send('Unauthorized');
  }
  const { id, spread, result, home_score, away_score, ml_odds, ou_odds, annotation } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const VALID_RESULTS = ['win', 'loss', 'push', 'pending'];
  if (result && !VALID_RESULTS.includes(result)) return res.status(400).json({ error: 'invalid result' });
  const sets = [], vals = [];
  if (spread      !== undefined) { sets.push('spread = ?');      vals.push(spread); }
  if (result      !== undefined) { sets.push('result = ?');      vals.push(result); }
  if (home_score  !== undefined) { sets.push('home_score = ?');  vals.push(home_score); }
  if (away_score  !== undefined) { sets.push('away_score = ?');  vals.push(away_score); }
  if (ml_odds     !== undefined) { sets.push('ml_odds = ?');     vals.push(ml_odds); }
  if (ou_odds     !== undefined) { sets.push('ou_odds = ?');     vals.push(ou_odds); }
  // annotation: pass null to CLEAR a stale void note — the public P/L excludes
  // any row whose annotation says "not counted", so un-voiding a pick isn't
  // complete until its annotation is wiped.
  if (annotation  !== undefined) { sets.push('annotation = ?');  vals.push(annotation); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(id);
  const info = db.prepare(`UPDATE mvp_picks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  if (info.changes === 0) return res.status(404).json({ error: `no pick with id ${id}` });
  const row = db.prepare('SELECT * FROM mvp_picks WHERE id = ?').get(id);
  res.json({ ok: true, pick: row });
});

// Build the full capper-detail payload (used by the modal GET + the scan POST).
// Resolves aliases both directions, then flags picks that reached MVP / 35+.
function buildCapperDetail(name) {
  let allNames = [name];
  try {
    const aliases = db.prepare(`SELECT alias FROM capper_aliases WHERE canonical_name = ?`).all(name);
    allNames = [name, ...aliases.map(a => a.alias)];
  } catch (_) {}

  // Other direction: if `name` is itself an alias, find canonical + siblings
  try {
    const norm = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const canonical = db.prepare(
      `SELECT canonical_name FROM capper_aliases WHERE LOWER(REPLACE(REPLACE(REPLACE(alias,' ',''),'_',''),'-','')) = ? LIMIT 1`
    ).get(norm);
    if (canonical) {
      const siblings = db.prepare(`SELECT alias FROM capper_aliases WHERE canonical_name = ?`).all(canonical.canonical_name);
      allNames = [canonical.canonical_name, ...siblings.map(a => a.alias)];
    }
  } catch (_) {}

  const ph    = allNames.map(() => '?').join(',');
  const picks = db.prepare(
    `SELECT * FROM capper_history WHERE capper_name IN (${ph}) ORDER BY saved_at DESC LIMIT 300`
  ).all(...allNames);

  // Cross-reference mvp_picks so a pick that became a tracked MVP is flagged even
  // if its stored score is missing. score >= MVP_THRESHOLD is the primary signal.
  const mvpKey = (gid, team, pt) => (gid || '') + '|' + (team || '').toLowerCase() + '|' + (pt || '').toLowerCase();
  const mvpSet = new Set();
  const mvpScores = new Map();
  try {
    for (const r of db.prepare(`SELECT espn_game_id, team, pick_type, score FROM mvp_picks`).all()) {
      const k = mvpKey(r.espn_game_id, r.team, r.pick_type);
      mvpSet.add(k);
      if (r.score != null) mvpScores.set(k, r.score);
    }
  } catch (_) {}
  const v3Now = db.getSetting('scoring_version', 'v2') === 'v3';
  // v3: capper_history.score can carry the raw v2 stamp (older grade-time
  // writes) or go stale after a post-grade rescore. Overlay the archived v3
  // total (pick_history is refreshed by every rescore), then the tracked MVP
  // score, so the profile lists show the number the pick actually reached
  // (France ML rendered 40 while the pick sat at 144).
  if (v3Now) {
    const v3Map = new Map();
    try {
      for (const r of db.prepare(
        `SELECT pick_id, game_date, v3_total FROM pick_history WHERE v3_total IS NOT NULL AND pick_id IS NOT NULL`
      ).all()) {
        v3Map.set(r.pick_id + '|' + (r.game_date || ''), r.v3_total);
      }
    } catch (_) {}
    for (const p of picks) {
      p.score = v3Map.get(p.pick_id + '|' + (p.game_date || ''))
             ?? mvpScores.get(mvpKey(p.espn_game_id, p.team, p.pick_type))
             ?? p.score;
    }
  }
  const mvpLine  = v3Now ? 100 : MVP_THRESHOLD;
  const highLine = v3Now ? 55  : 35;
  for (const p of picks) {
    p.is_mvp  = (p.score != null && p.score >= mvpLine) || mvpSet.has(mvpKey(p.espn_game_id, p.team, p.pick_type));
    p.is_high = p.score != null && p.score >= highLine; // includes gold
  }

  const unit = parseFloat(db.getSetting('bet_unit', 10)) || 10;

  // v3 Phase 2: ratings + registry context for the expanded profile popup.
  const canonicalName = allNames[0];
  let rating = null, sportRatings = [], typeRatings = [], handles = [];
  try {
    rating       = db.prepare(`SELECT * FROM capper_ratings WHERE canonical_name = ? AND scope = 'overall'`).get(canonicalName) || null;
    sportRatings = db.prepare(`SELECT * FROM capper_ratings WHERE canonical_name = ? AND scope LIKE 'sport:%' ORDER BY picks DESC`).all(canonicalName);
    typeRatings  = db.prepare(`SELECT * FROM capper_ratings WHERE canonical_name = ? AND scope LIKE 'type:%' ORDER BY sport, picks DESC`).all(canonicalName);
    handles      = db.prepare(`SELECT source, handle, meta_json FROM capper_source_handles WHERE canonical_name = ?`).all(canonicalName);
  } catch (_) {}

  return { name, picks, unit, mvpThreshold: mvpLine, highThreshold: highLine, rating, sportRatings, typeRatings, handles };
}

// ── GET /admin/api/capper-detail/:name — JSON for capper detail modal ────────
router.get('/api/capper-detail/:name', requireAuth, (req, res) => {
  try {
    res.json(buildCapperDetail(decodeURIComponent(req.params.name)));
  } catch (err) {
    console.error('[admin/capper-detail]', req.params.name, (err && err.stack) || err);
    res.status(500).json({ error: 'capper-detail failed: ' + ((err && err.message) || err) });
  }
});

// ── POST /admin/api/capper-scan/:name — resolve finished games, return fresh detail ─
router.post('/api/capper-scan/:name', requireAuth, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  try {
    const { resolveResults } = require('./results');
    await resolveResults(); // settles any newly-finished games into capper_history
  } catch (err) {
    console.error('[admin] capper-scan resolve error:', err.message);
  }
  res.json(buildCapperDetail(name));
});

// ── POST /admin/ingest-public-betting — relay from Mac (HMAC-signed) ─────────
// Mac Mini scrapes ActionNetwork (residential IP) and POSTs here hourly.
// Body: { sport: "MLB", games: [...] }  (raw ActionNetwork games array)
// Header: X-Relay-Signature: <hmac-sha256-hex>
// Note: global express.json() pre-parses the body, so we re-stringify for HMAC.
// The relay also JSON.stringifies, so both sides produce identical bytes.
router.post('/ingest-public-betting', (req, res) => {
    const secret = process.env.RELAY_SECRET;
    if (!secret) return res.status(500).send('RELAY_SECRET not configured');

    // Re-serialize parsed body — relay sent JSON.stringify(payload) so key order matches
    const canonical = JSON.stringify(req.body);
    const sig        = req.headers['x-relay-signature'] || '';
    const expected   = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    const sigBuf     = Buffer.from(sig.length === 64 ? sig : '', 'hex');
    const expBuf     = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).send('Invalid signature');
    }

    const { sport, games } = req.body;
    const VALID_SPORTS = ['NBA', 'NFL', 'MLB', 'NHL', 'NCAAF', 'CBB', 'Soccer'];
    if (!VALID_SPORTS.includes(sport) || !Array.isArray(games)) {
      return res.status(400).send('Invalid payload');
    }

    try {
      const stored = storePublicBettingGames(sport, games);
      console.log(`[relay] public betting ${sport}: stored ${stored}/${games.length}`);
      res.json({ stored });
    } catch (err) {
      console.error('[relay] ingest error:', err.message);
      res.status(500).send('Store failed');
    }
  }
);

// ── POST /admin/ingest-tennis-lines — Bovada relay from Mac (HMAC-signed) ─────
// Bovada geo/bot-blocks Railway's datacenter IP, so the Mac (residential IP)
// fetches Bovada tennis lines and POSTs them here. Same HMAC scheme as
// /admin/ingest-public-betting. Body: { lines: [ { players:[{name,ml,spread}], over_under, ... } ] }
router.post('/ingest-tennis-lines', (req, res) => {
    const secret = process.env.RELAY_SECRET;
    if (!secret) return res.status(500).send('RELAY_SECRET not configured');

    const canonical = JSON.stringify(req.body);
    const sig        = req.headers['x-relay-signature'] || '';
    const expected   = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    const sigBuf     = Buffer.from(sig.length === 64 ? sig : '', 'hex');
    const expBuf     = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).send('Invalid signature');
    }

    const { lines } = req.body;
    if (!Array.isArray(lines)) return res.status(400).send('Invalid payload');

    try {
      const stored = storeTennisLines(lines);
      console.log(`[relay] tennis lines: stored ${stored}/${lines.length}`);
      res.json({ stored });
    } catch (err) {
      console.error('[relay] tennis ingest error:', err.message);
      res.status(500).send('Store failed');
    }
  }
);

// ── POST /admin/ingest-book-lines — CA Odds Engine relay from Mac (HMAC) ──────
// scripts/odds_engine.js fetches public sportsbook odds on the Mac (residential
// IP) and POSTs normalized rows here. Same HMAC scheme as ingest-public-betting.
router.post('/ingest-book-lines', (req, res) => {
    const secret = process.env.RELAY_SECRET;
    if (!secret) return res.status(500).send('RELAY_SECRET not configured');

    const canonical = JSON.stringify(req.body);
    const sig        = req.headers['x-relay-signature'] || '';
    const expected   = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    const sigBuf     = Buffer.from(sig.length === 64 ? sig : '', 'hex');
    const expBuf     = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).send('Invalid signature');
    }

    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).send('Invalid payload');

    try {
      const out = storeEngineBookLines(rows);
      console.log(`[relay] book lines: stored ${out.stored}/${rows.length} (${out.unmatched} unmatched)`);
      res.json(out);
    } catch (err) {
      console.error('[relay] book-lines ingest error:', err.message);
      res.status(500).send('Store failed');
    }
  }
);

// ── POST /admin/ingest-book-lines-period — partial-game lines (F5/1H, HMAC) ───
// Deliberately a SEPARATE endpoint from ingest-book-lines: an engine newer than
// the server then gets a 404 for period rows instead of an old server storing
// F5 numbers as full-game lines (which the CA line lock reads). The store
// itself routes by row.period into book_lines_period.
router.post('/ingest-book-lines-period', (req, res) => {
    const secret = process.env.RELAY_SECRET;
    if (!secret) return res.status(500).send('RELAY_SECRET not configured');

    const canonical = JSON.stringify(req.body);
    const sig        = req.headers['x-relay-signature'] || '';
    const expected   = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    const sigBuf     = Buffer.from(sig.length === 64 ? sig : '', 'hex');
    const expBuf     = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).send('Invalid signature');
    }

    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.some(r => !r || !r.period)) {
      return res.status(400).send('Invalid payload');
    }

    try {
      const out = storeEngineBookLines(rows);
      console.log(`[relay] period book lines: stored ${out.stored}/${rows.length} (${out.unmatched} unmatched)`);
      res.json(out);
    } catch (err) {
      console.error('[relay] period book-lines ingest error:', err.message);
      res.status(500).send('Store failed');
    }
  }
);

// ── POST /admin/ingest-engine-events — Boxing/MMA cards from the engine (HMAC) ─
router.post('/ingest-engine-events', (req, res) => {
    const secret = process.env.RELAY_SECRET;
    if (!secret) return res.status(500).send('RELAY_SECRET not configured');

    const canonical = JSON.stringify(req.body);
    const sig        = req.headers['x-relay-signature'] || '';
    const expected   = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    const sigBuf     = Buffer.from(sig.length === 64 ? sig : '', 'hex');
    const expBuf     = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).send('Invalid signature');
    }

    const { events } = req.body;
    if (!Array.isArray(events)) return res.status(400).send('Invalid payload');
    try {
      const out = storeEngineEvents(events);
      res.json(out);
    } catch (err) {
      console.error('[relay] engine-events ingest error:', err.message);
      res.status(500).send('Store failed');
    }
  }
);

// ── JSON APIs for the desktop ops console ─────────────────────────────────────
router.get('/api/health.json', requireAuth, (_req, res) => {
  try { res.json(getHealthSnapshot()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Per-book coverage: which sports, how many games, how fresh, which markets.
router.get('/api/books.json', requireAuth, (_req, res) => {
  try {
    const ageMin = (t) => {
      if (!t) return null;
      const ms = Date.parse(String(t).replace(' ', 'T') + 'Z');
      return isNaN(ms) ? null : Math.round((Date.now() - ms) / 60000);
    };
    const books = db.prepare(`
      SELECT book, COUNT(*) total_games, MAX(updated_at) newest,
             ROUND(100.0 * SUM(ml_home IS NOT NULL) / COUNT(*)) ml_pct,
             ROUND(100.0 * SUM(spread_home IS NOT NULL) / COUNT(*)) spread_pct,
             ROUND(100.0 * SUM(over_under IS NOT NULL) / COUNT(*)) total_pct
      FROM book_lines GROUP BY book ORDER BY book
    `).all().map(b => ({
      book: b.book,
      offshore: OFFSHORE_BOOKS.has(b.book),
      total_games: b.total_games,
      newest: b.newest,
      ageMin: ageMin(b.newest),
      markets: { ml_pct: b.ml_pct, spread_pct: b.spread_pct, total_pct: b.total_pct },
      sports: db.prepare(`
        SELECT tg.sport, COUNT(*) games, MAX(bl.updated_at) newest
        FROM book_lines bl JOIN today_games tg USING (espn_game_id)
        WHERE bl.book = ? GROUP BY tg.sport ORDER BY tg.sport
      `).all(b.book).map(s => ({ sport: s.sport, games: s.games, newest: s.newest, ageMin: ageMin(s.newest) })),
    }));
    res.json({ books, generatedAt: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// One matrix cell drilled down: every game this book has lines for in this
// sport, with the lines themselves, movement, and when each row last updated
// (updated_at IS the moment the row was stored on the CA site).
router.get('/api/book-cell.json', requireAuth, (req, res) => {
  try {
    const book  = String(req.query.book  || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
    const sport = String(req.query.sport || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    if (!book || !sport) return res.status(400).json({ error: 'book and sport required' });
    const ageMin = (t) => {
      if (!t) return null;
      const ms = Date.parse(String(t).replace(' ', 'T') + 'Z');
      return isNaN(ms) ? null : Math.round((Date.now() - ms) / 60000);
    };
    const rows = db.prepare(`
      SELECT bl.*, tg.home_team, tg.away_team, tg.home_abbr, tg.away_abbr,
             tg.start_time, tg.status
      FROM book_lines bl JOIN today_games tg USING (espn_game_id)
      WHERE bl.book = ? AND UPPER(tg.sport) = UPPER(?)
      ORDER BY tg.start_time
    `).all(book, sport);
    let f5Ids = new Set();
    try {
      f5Ids = new Set(db.prepare(
        `SELECT espn_game_id FROM book_lines_period WHERE book = ? AND period = 'F5'`
      ).all(book).map(r => r.espn_game_id));
    } catch (_) {}
    res.json({
      book, sport,
      games: rows.map(r => ({
        espn_game_id: r.espn_game_id,
        matchup: `${r.away_abbr || r.away_team} @ ${r.home_abbr || r.home_team}`,
        start_time: r.start_time,
        status: r.status,
        ml_home: r.ml_home, ml_away: r.ml_away,
        spread_home: r.spread_home, spread_away: r.spread_away,
        over_under: r.over_under, ou_over_odds: r.ou_over_odds, ou_under_odds: r.ou_under_odds,
        prev: {
          ml_home: r.prev_ml_home ?? null, ml_away: r.prev_ml_away ?? null,
          spread_home: r.prev_spread_home ?? null, spread_away: r.prev_spread_away ?? null,
          over_under: r.prev_over_under ?? null,
        },
        f5: f5Ids.has(r.espn_game_id),
        updated_at: r.updated_at,
        ageMin: ageMin(r.updated_at),
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /admin/ingest-heartbeat — Mac service check-ins (HMAC) ───────────────
// Body: { service: 'odds-engine', meta: { interval_min, cycle stats... } }
router.post('/ingest-heartbeat', (req, res) => {
    const secret = process.env.RELAY_SECRET;
    if (!secret) return res.status(500).send('RELAY_SECRET not configured');

    const canonical = JSON.stringify(req.body);
    const sig        = req.headers['x-relay-signature'] || '';
    const expected   = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    const sigBuf     = Buffer.from(sig.length === 64 ? sig : '', 'hex');
    const expBuf     = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).send('Invalid signature');
    }

    const ok = recordHeartbeat(req.body.service, req.body.meta);
    if (!ok) return res.status(400).send('Invalid service name');
    res.json({ ok: true });
  }
);

// ── GET /admin/health — every data source + Mac service on one page ───────────
router.get('/health', requireAuth, (_req, res) => {
  const snap = getHealthSnapshot();
  const dot = (s) => ({
    ok:    '<span class="badge match-ok">OK</span>',
    yellow:'<span class="badge match-new">STALE</span>',
    red:   '<span class="badge" style="background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.3);">DOWN</span>',
    never: '<span class="badge" style="background:#252c3b;color:#8892a4;border:1px solid #252c3b;">NO DATA</span>',
  }[s] || s);
  const fmtAge = (m) => m == null ? '—' : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;

  const beatRows = snap.heartbeats.length
    ? snap.heartbeats.map(b => `<tr>
        <td>${dot(b.status)}</td><td><b>${b.service}</b></td>
        <td>${fmtAge(b.ageMin)}</td>
        <td style="font-size:12px;color:#8892a4;">${Object.entries(b.meta).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ').slice(0, 220) || '—'}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="empty">No heartbeats yet. Mac services check in here once they run with RELAY_SECRET set.</td></tr>`;

  const srcRows = snap.sources.map(s => `<tr>
      <td>${dot(s.status)}</td><td>${s.name.startsWith('  ') ? '&nbsp;&nbsp;&nbsp;' + s.name.trim() : `<b>${s.name}</b>`}</td>
      <td>${fmtAge(s.ageMin)}</td>
      <td>${s.detail || '—'}</td>
      <td style="font-size:12px;color:#8892a4;">${s.hint || ''}</td>
    </tr>`).join('');

  res.send(page('Health', `
    <h1>Source Health <a href="/admin/dashboard" style="font-size:13px;font-weight:400;margin-left:14px;">back to dashboard</a></h1>
    <p style="color:#8892a4;margin-bottom:20px;">Auto-refreshes every 60 seconds. Yellow = past its normal cadence. Red = 3x past it, treat as down.</p>
    <h2>Mac services (heartbeats)</h2>
    <table><tr><th></th><th>Service</th><th>Last check-in</th><th>Last cycle</th></tr>${beatRows}</table>
    <h2>Data sources (freshness)</h2>
    <table><tr><th></th><th>Source</th><th>Last data</th><th>Detail</th><th>If stale</th></tr>${srcRows}</table>
    <p style="color:#64748b;font-size:12px;margin-top:14px;">Generated ${snap.generatedAt}</p>
    <script>setTimeout(() => location.reload(), 60000);</script>
  `));
});

// ── GET /admin/api/reader-health ──────────────────────────────────────────────
router.get('/api/reader-health', requireAuth, async (_req, res) => {
  const url = (process.env.LOCAL_READER_URL || '').replace(/\/$/, '');
  if (!url) return res.json({ ok: false, error: 'LOCAL_READER_URL not set' });
  try {
    const r = await axios.get(`${url}/health`, { timeout: 8000 });
    res.json({ ok: true, model: r.data?.model || null });
  } catch (err) {
    res.json({ ok: false, error: err.message.slice(0, 80) });
  }
});

// ── GET /admin/api/archive — last 7d of scanned-and-extracted messages ───────
// Filters: capper (substring, case-insensitive), channel (exact), match
// (matched|new), from / to dates (YYYY-MM-DD on archived_at).
// Returns up to 500 rows so the panel stays responsive.
router.get('/api/archive', requireAuth, (req, res) => {
  const { capper = '', channel = '', match = '', from = '', to = '' } = req.query;
  const where = [`archived_at >= datetime('now', '-7 days')`];
  const args  = [];
  if (capper)  { where.push(`(LOWER(capper_name) LIKE ? OR LOWER(capper_raw) LIKE ?)`); args.push('%' + capper.toLowerCase() + '%', '%' + capper.toLowerCase() + '%'); }
  if (channel) { where.push(`channel = ?`);        args.push(channel); }
  if (match === 'matched') where.push(`capper_matched = 1`);
  if (match === 'new')     where.push(`capper_matched = 0`);
  if (from) { where.push(`date(archived_at) >= ?`); args.push(from); }
  if (to)   { where.push(`date(archived_at) <= ?`); args.push(to);   }
  try {
    const rows = db.prepare(`
      SELECT id, message_id, channel, author, message_text, message_timestamp,
             source, pick_id, pick_team, pick_type, pick_sport,
             capper_raw, capper_name, capper_matched, archived_at
      FROM raw_messages_archive
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT 500
    `).all(...args);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/api/pick/:id/capper ───────────────────────────────────────────
// Quick manual capper assignment for a recorded pick. Used when the message
// has no extracted capper (e.g. someone posting their own picks under a
// Discord handle that doesn't appear in-message) and we want to attribute it.
// Updates everywhere the capper_name lives, and registers the name in
// capper_aliases so the matched/new badge picks it up on next render.
router.post('/api/pick/:id/capper', requireAuth, express.json(), (req, res) => {
  const pickId = parseInt(req.params.id, 10);
  const capper = (req.body?.capper_name || '').trim();
  if (!pickId)  return res.status(400).json({ ok: false, error: 'Missing pick id' });
  if (!capper)  return res.status(400).json({ ok: false, error: 'Missing capper_name' });
  try {
    db.prepare(`UPDATE picks SET capper_name = ? WHERE id = ?`).run(capper, pickId);
    try { db.prepare(`UPDATE pick_history SET capper_name = ? WHERE pick_id = ?`).run(capper, pickId); } catch (_) {}
    try { db.prepare(`UPDATE capper_history SET capper_name = ? WHERE pick_id = ?`).run(capper, pickId); } catch (_) {}
    try { db.prepare(`UPDATE raw_messages_archive SET capper_name = ?, capper_matched = 1 WHERE pick_id = ?`).run(capper, pickId); } catch (_) {}
    // Self-alias so resolveCapperName() recognizes this name on future picks.
    try { db.prepare(`INSERT OR IGNORE INTO capper_aliases (canonical_name, alias) VALUES (?, ?)`).run(capper, capper); } catch (_) {}
    res.json({ ok: true, capper_name: capper, matched: 1 });
  } catch (err) {
    console.error('[admin] set capper failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /admin/api/reader-mode ───────────────────────────────────────────────
router.post('/api/reader-mode', requireAuth, express.json(), (req, res) => {
  const { mode } = req.body || {};
  if (!['auto', 'mac', 'haiku'].includes(mode)) return res.json({ ok: false, error: 'Invalid mode' });
  db.setSetting('reader_mode', mode);
  console.log(`[admin] reader_mode set to ${mode}`);
  res.json({ ok: true, mode });
});

// ── POST /admin/api/cycle-settings ────────────────────────────────────────────
// Tunes the per-game retention: daily clear hour (ET, HH:MM) + late-game grace.
router.post('/api/cycle-settings', requireAuth, express.json(), (req, res) => {
  const { clear_hour, grace_hours } = req.body || {};
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(clear_hour || ''))) {
    return res.json({ ok: false, error: 'Clear hour must be HH:MM (24h ET)' });
  }
  const grace = parseFloat(grace_hours);
  if (!Number.isFinite(grace) || grace < 0 || grace > 24) {
    return res.json({ ok: false, error: 'Grace hours must be 0–24' });
  }
  db.setSetting('cycle_clear_hour', clear_hour);
  db.setSetting('post_game_grace_hours', String(grace));
  console.log(`[admin] cycle settings set: clear=${clear_hour} grace=${grace}h`);
  res.json({ ok: true, clear_hour, grace_hours: grace });
});

// ── HTML escape helper ────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
