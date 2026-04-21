// src/admin.js — Password-protected admin panel
const express = require('express');
const db      = require('./db');
const scanner = require('./discord_scanner');
const { getCycleDate } = require('./cycle');
const { MVP_THRESHOLD } = require('./scoring');
const { reseedFromExisting } = require('./lines');
const { rescanSkipped }      = require('./discord_scanner');
const crypto  = require('crypto');

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
router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const correct = process.env.ADMIN_PASSWORD;
  if (!correct) return res.status(500).send('ADMIN_PASSWORD not set in env.');
  if (req.body.password === correct) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

// ── GET /admin/logout ─────────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ── GET /admin → dashboard ────────────────────────────────────────────────────
router.get('/', requireAuth, (_req, res) => res.redirect('/admin/dashboard'));

// ── GET /admin/dashboard — unified 4-tab dashboard ───────────────────────────
router.get('/dashboard', requireAuth, (req, res) => {
  const activeTab = req.query.tab || 'picks';
  const today = getCycleDate();
  const mvpDisplayThreshold = parseInt(db.getSetting('mvp_display_threshold', 50), 10);

  // ── Picks panel ─────────────────────────────────────────────────────────────
  const picks = db.prepare(`
    SELECT p.*,
           sb.channel_points, sb.sport_bonus, sb.home_bonus, sb.total AS sb_total,
           sb.breakdown_json,
           COALESCE(tg1.home_team, tg2.home_team) AS home_team,
           COALESCE(tg1.away_team, tg2.away_team) AS away_team,
           COALESCE(tg1.start_time, tg2.start_time) AS start_time
    FROM picks p
    LEFT JOIN score_breakdown sb ON sb.pick_id = p.id
    LEFT JOIN today_games tg1 ON tg1.espn_game_id = p.espn_game_id
    LEFT JOIN today_games tg2 ON (LOWER(tg2.home_team) = LOWER(p.team) OR LOWER(tg2.away_team) = LOWER(p.team))
    WHERE p.game_date = ? AND p.mention_count > 0 AND p.score > 0
    GROUP BY p.id
    ORDER BY p.score DESC
  `).all(today);

  const rawMessages = db.prepare(`SELECT * FROM raw_messages ORDER BY pick_id, saved_at`).all();
  const rawByPick = {};
  for (const rm of rawMessages) {
    if (!rawByPick[rm.pick_id]) rawByPick[rm.pick_id] = [];
    rawByPick[rm.pick_id].push(rm);
  }

  const pickRowsHtml = picks.map((p, i) => {
    const isMvp = (p.score || 0) >= MVP_THRESHOLD;
    const raws  = rawByPick[p.id] || [];
    const rawRowsHtml = raws.length
      ? `<tr class="raw-row" id="msgs-${p.id}" style="display:none;"><td colspan="8" style="padding:0;">
          <table style="margin:0;border:none;border-radius:0;"><tbody>
            ${raws.map(rm => `<tr class="raw-row"><td colspan="8">
              <strong>${escHtml(rm.channel)}</strong>
              ${rm.author ? `· <em>${escHtml(rm.author)}</em>` : ''}
              ${rm.message_timestamp ? `· ${rm.message_timestamp.slice(0, 16)}` : ''}
              <br>${escHtml(rm.message_text || '')}
            </td></tr>`).join('')}
          </tbody></table></td></tr>`
      : '';
    const msgBtn = raws.length
      ? `<button onclick="toggleMsgs(${p.id},this)" style="background:#252c3b;border:1px solid #3b4560;color:#8892a4;border-radius:4px;padding:2px 7px;font-size:11px;cursor:pointer;">${raws.length} msg${raws.length > 1 ? 's' : ''} ▾</button>`
      : '<span style="color:#3b4560;font-size:11px;">—</span>';
    const breakdown = p.channel_points != null
      ? `ch:${p.channel_points} sport:${p.sport_bonus} home:${p.home_bonus} = ${p.sb_total}` : '—';
    const matchup = (p.away_team && p.home_team)
      ? `${escHtml(p.away_team)} @ ${escHtml(p.home_team)}` : `<em>${escHtml(p.team)}</em>`;
    const timeStr = p.start_time
      ? new Date(p.start_time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }) : '';
    const pickType = (p.pick_type || '').toLowerCase();
    const spreadDisplay = (pickType === 'over' || pickType === 'under')
      ? (p.spread != null ? Math.abs(parseFloat(p.spread)) : '')
      : (p.spread != null ? p.spread : '');
    return `<tr>
      <td><strong>${i + 1}</strong> <span style="font-size:10px;color:#3b4560;">#${p.id}</span></td>
      <td><strong>${matchup}</strong>${timeStr ? `<span style="font-size:11px;color:#8892a4;margin-left:6px;">${timeStr}</span>` : ''}</td>
      <td>${escHtml(p.sport || '—')}</td>
      <td>${escHtml(p.team || '—')} ${escHtml(p.pick_type || '')} ${spreadDisplay}</td>
      <td>${p.mention_count}</td>
      <td>${p.score ?? '—'} ${isMvp ? '<span class="badge mvp">MVP</span>' : ''}</td>
      <td><small>${breakdown}</small></td>
      <td>${msgBtn}</td>
    </tr>${rawRowsHtml}`;
  }).join('');

  const picksTableHtml = picks.length
    ? `<table><thead><tr><th>#</th><th>Team</th><th>Sport</th><th>Pick</th><th>Mentions</th><th>Score</th><th>Breakdown</th><th>Messages</th></tr></thead><tbody>${pickRowsHtml}</tbody></table>`
    : '<div class="empty">No picks today.</div>';

  // ── Codes panel ──────────────────────────────────────────────────────────────
  const codes = db.prepare(`
    SELECT ac.*, u.email AS activated_email, u.username AS activated_username
    FROM access_codes ac
    LEFT JOIN users u ON u.id = ac.activated_by
    ORDER BY ac.created_at DESC
  `).all();

  const nowMs = Date.now();
  const codeRows = codes.map(c => {
    let status = 'Unused', statusColor = '#8892a4';
    if (c.activated_by != null) {
      const expired = c.expires_at && new Date(c.expires_at).getTime() < nowMs;
      if (c.type === 'lifetime') { status = 'Lifetime (used)'; statusColor = '#FFD700'; }
      else if (expired)          { status = 'Expired';         statusColor = '#ef4444'; }
      else                       { status = 'Active';          statusColor = '#16a34a'; }
    }
    const activatedBy = c.activated_username || c.activated_email || '—';
    const expiresAt   = c.expires_at ? c.expires_at.slice(0, 16).replace('T', ' ') : (c.type === 'lifetime' ? 'Never' : '—');
    return `<tr>
      <td style="font-family:monospace;letter-spacing:1px;font-size:13px;">${escHtml(c.code)}</td>
      <td style="font-size:12px;">${escHtml(c.type)}</td>
      <td style="color:#64748b;font-size:12px;">${escHtml(c.notes || '—')}</td>
      <td><span style="color:${statusColor};font-weight:600;font-size:12px;">${status}</span></td>
      <td style="color:#8892a4;font-size:12px;">${escHtml(activatedBy)}</td>
      <td style="color:#8892a4;font-size:12px;">${escHtml(c.activated_at ? c.activated_at.slice(0, 16).replace('T', ' ') : '—')}</td>
      <td style="color:#8892a4;font-size:12px;">${escHtml(expiresAt)}</td>
      <td>${c.activated_by == null ? `<button class="btn-sm btn-revoke" onclick="deleteCode(${c.id})">Delete</button>` : ''}</td>
    </tr>`;
  }).join('');

  const codesTableHtml = codes.length
    ? `<table><thead><tr><th>Code</th><th>Type</th><th>Notes</th><th>Status</th><th>Activated By</th><th>Activated At</th><th>Expires</th><th></th></tr></thead><tbody>${codeRows}</tbody></table>`
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

  const fmtCost  = v => v != null ? '$' + (v).toFixed(5) : '$0.00000';
  const fmtTok   = v => v != null ? Number(v).toLocaleString() : '0';
  const statCard = (label, val) =>
    `<div style="background:#171b24;border:1px solid #252c3b;border-radius:8px;padding:16px 20px;min-width:140px;">
       <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8892a4;margin-bottom:6px;">${label}</div>
       <div style="font-size:20px;font-weight:700;">${val}</div>
     </div>`;

  const usageDayRows = usageDays.map(d =>
    `<tr>
       <td>${d.day}</td>
       <td>${d.calls}</td>
       <td>${fmtTok(d.input)}</td>
       <td>${fmtTok(d.output)}</td>
       <td>${fmtTok(d.cwrite)}</td>
       <td>${fmtTok(d.cread)}</td>
       <td>${fmtCost(d.cost)}</td>
     </tr>`
  ).join('') || `<tr><td colspan="7" class="empty">No data yet — usage is logged after the first Claude API call.</td></tr>`;

  const usagePanelHtml = `
    <h1>AI Usage <small style="font-size:13px;color:#8892a4;font-weight:400;">Claude Haiku — reader.js</small></h1>
    <h2 style="margin-top:0;">Today</h2>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px;">
      ${statCard('API Calls', usageToday.calls || 0)}
      ${statCard('Input Tokens', fmtTok(usageToday.input))}
      ${statCard('Output Tokens', fmtTok(usageToday.output))}
      ${statCard('Cache Writes', fmtTok(usageToday.cwrite))}
      ${statCard('Cache Reads', fmtTok(usageToday.cread))}
      ${statCard('Est. Cost', fmtCost(usageToday.cost))}
    </div>
    <h2>This Month</h2>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px;">
      ${statCard('API Calls', usageMonth.calls || 0)}
      ${statCard('Input Tokens', fmtTok(usageMonth.input))}
      ${statCard('Output Tokens', fmtTok(usageMonth.output))}
      ${statCard('Cache Writes', fmtTok(usageMonth.cwrite))}
      ${statCard('Cache Reads', fmtTok(usageMonth.cread))}
      ${statCard('Est. Cost', fmtCost(usageMonth.cost))}
    </div>
    <h2>Last 14 Days</h2>
    <table>
      <thead><tr><th>Date</th><th>Calls</th><th>Input Tokens</th><th>Output Tokens</th><th>Cache Writes</th><th>Cache Reads</th><th>Est. Cost</th></tr></thead>
      <tbody>${usageDayRows}</tbody>
    </table>
    <p style="color:#8892a4;font-size:12px;margin-top:12px;">
      Pricing: input $0.80/M · output $4.00/M · cache write $1.00/M · cache read $0.08/M (Haiku 4.5).
      Verify against <a href="https://console.anthropic.com" target="_blank" style="color:#3b82f6;">console.anthropic.com</a>.
    </p>
    <p style="color:#8892a4;font-size:12px;margin-top:4px;">Lifetime: ${usageLifetime.calls || 0} calls · ${fmtCost(usageLifetime.cost)} total</p>
  `;

  // ── Cappers panel data ────────────────────────────────────────────────────────
  const allCapperPicks = db.prepare(`
    SELECT capper_name, sport, result
    FROM picks
    WHERE capper_name IS NOT NULL AND capper_name != '' AND result IS NOT NULL
  `).all();

  // Also include golf picks
  let golfCapperPicks = [];
  try {
    golfCapperPicks = db.prepare(`
      SELECT capper_name, 'Golf' as sport, result
      FROM golf_picks
      WHERE capper_name IS NOT NULL AND capper_name != '' AND result IS NOT NULL
    `).all();
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
    const norm = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return aliasMap.get(norm) || name;
  }

  // Aggregate per capper
  const capperMap = new Map();
  for (const row of [...allCapperPicks, ...golfCapperPicks]) {
    if (!row.capper_name) continue;
    const display = resolveCapperDisplay(row.capper_name);
    if (!capperMap.has(display)) capperMap.set(display, { wins: 0, losses: 0, pushes: 0, pending: 0, sports: {} });
    const c = capperMap.get(display);
    const r = (row.result || '').toLowerCase();
    if (r === 'win')    c.wins++;
    else if (r === 'loss')  c.losses++;
    else if (r === 'push')  c.pushes++;
    else                    c.pending++;
    const s = row.sport || 'Unknown';
    c.sports[s] = (c.sports[s] || 0) + 1;
  }

  // Sort: most total resolved picks first, then by win%
  const sortedCappers = [...capperMap.entries()]
    .map(([name, c]) => {
      const total = c.wins + c.losses + c.pushes;
      const winPct = total > 0 ? Math.round((c.wins / total) * 100) : null;
      // Sort sports by volume
      const sortedSports = Object.entries(c.sports).sort((a, b) => b[1] - a[1]);
      return { name, ...c, total, winPct, sortedSports };
    })
    .sort((a, b) => (b.wins + b.losses + b.pushes) - (a.wins + a.losses + a.pushes) || (b.winPct ?? -1) - (a.winPct ?? -1));

  const capperLeaderboardHtml = sortedCappers.length ? `
    <table>
      <thead><tr><th>#</th><th>Capper</th><th>W</th><th>L</th><th>Push</th><th>Win%</th><th>Pending</th><th>Top Sports</th></tr></thead>
      <tbody>${sortedCappers.map((c, i) => {
        const wpColor = c.winPct === null ? '#8892a4' : c.winPct >= 55 ? '#16a34a' : c.winPct >= 50 ? '#f59e0b' : '#ef4444';
        const sportTags = c.sortedSports.slice(0, 3).map(([s, n]) =>
          `<span class="badge" style="background:rgba(59,130,246,0.12);color:#3b82f6;border:1px solid rgba(59,130,246,0.2);margin-right:3px;">${s} <span style="opacity:.7;">${n}</span></span>`
        ).join('');
        return `<tr>
          <td style="color:#8892a4;font-size:12px;">${i + 1}</td>
          <td style="font-weight:600;">${c.name}</td>
          <td style="color:#16a34a;font-weight:700;">${c.wins}</td>
          <td style="color:#ef4444;font-weight:700;">${c.losses}</td>
          <td style="color:#8892a4;">${c.pushes}</td>
          <td style="color:${wpColor};font-weight:700;">${c.winPct !== null ? c.winPct + '%' : '—'}</td>
          <td style="color:#8892a4;font-size:12px;">${c.pending || 0}</td>
          <td>${sportTags}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>` : `<p class="empty">No capper picks with resolved results yet.</p>`;

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

  // ── Active tab helper ─────────────────────────────────────────────────────────
  const ta = n => activeTab === n ? ' active' : '';

  res.send(page('Dashboard', `
    <div style="display:flex;align-items:center;margin-bottom:20px;">
      <span class="logo">CappingAlpha Admin</span>
    </div>

    <div class="atabs">
      <button class="atab${ta('picks')}" data-tab="picks" onclick="adminTab('picks')">Today's Picks</button>
      <button class="atab${ta('codes')}" data-tab="codes" onclick="adminTab('codes')">Access Codes</button>
      <button class="atab${ta('users')}" data-tab="users" onclick="adminTab('users')">Users</button>
      <button class="atab gold${ta('mvp')}" data-tab="mvp" onclick="adminTab('mvp')">MVP History</button>
      <button class="atab${ta('usage')}" data-tab="usage" onclick="adminTab('usage')">AI Usage</button>
      <button class="atab${ta('cappers')}" data-tab="cappers" onclick="adminTab('cappers')">Cappers</button>
      <button class="atab${ta('messages')}" data-tab="messages" onclick="adminTab('messages')">Messages</button>
      <a href="/admin/logout" class="atab-logout">Log out</a>
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
          <p style="color:#8892a4;font-size:13px;margin:0;">All codes are single-use. Hand out to users for direct access.</p>
        </div>
        <!-- Quick batch generator -->
        <div style="background:#171b24;border:1px solid #252c3b;border-radius:10px;padding:18px 20px;min-width:320px;">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8892a4;margin-bottom:12px;">Quick Generate</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
            <div>
              <label style="display:block;font-size:11px;color:#8892a4;margin-bottom:4px;">TYPE</label>
              <select id="qgen-type" style="font-size:13px;padding:7px 10px;">
                <option value="day">1 Day</option>
                <option value="week" selected>7 Days</option>
                <option value="annual">1 Year</option>
                <option value="lifetime">Lifetime</option>
              </select>
            </div>
            <div>
              <label style="display:block;font-size:11px;color:#8892a4;margin-bottom:4px;">COUNT</label>
              <select id="qgen-count" style="font-size:13px;padding:7px 10px;">
                <option value="1">1</option>
                <option value="3">3</option>
                <option value="5">5</option>
                <option value="8" selected>8</option>
                <option value="10">10</option>
              </select>
            </div>
            <div>
              <label style="display:block;font-size:11px;color:#8892a4;margin-bottom:4px;">NOTES</label>
              <input type="text" id="qgen-notes" placeholder="optional label" style="font-size:13px;padding:7px 10px;width:130px;" />
            </div>
            <button class="btn btn-primary" style="font-size:13px;padding:8px 16px;" onclick="quickGenerate()">Generate</button>
          </div>
          <div id="qgen-result" style="margin-top:12px;font-size:12px;color:#8892a4;display:none;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8892a4;margin-bottom:6px;">Generated codes</div>
            <div id="qgen-codes" style="font-family:monospace;line-height:2;letter-spacing:1px;"></div>
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
      <h1>Capper Leaderboard</h1>

      <h2>All-Time Record (resolved picks only)</h2>
      ${capperLeaderboardHtml}

      <h2 style="margin-top:28px;">Today's Duplicate Picks</h2>
      <p style="color:#8892a4;font-size:13px;margin-bottom:12px;">Picks where 2+ different cappers called the exact same slot today.</p>
      ${dupAlertsHtml}

      <h2 style="margin-top:28px;">Alias Manager</h2>
      <p style="color:#8892a4;font-size:13px;margin-bottom:12px;">Link variant capper handles to a canonical name for unified tracking.</p>
      ${aliasTableHtml}
      <div style="margin-top:16px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
        <div>
          <label style="display:block;margin-bottom:4px;font-size:12px;color:#8892a4;">Canonical Name</label>
          <input type="text" id="alias-canonical" placeholder="e.g. PorterPicks" style="width:200px;" />
        </div>
        <div>
          <label style="display:block;margin-bottom:4px;font-size:12px;color:#8892a4;">Alias (variant spelling)</label>
          <input type="text" id="alias-alias" placeholder="e.g. Porter Picks" style="width:200px;" />
        </div>
        <button class="btn btn-primary" onclick="addAlias()">Add Alias</button>
      </div>
      <p id="alias-msg" style="font-size:13px;color:#8892a4;margin-top:8px;"></p>
    </div>

    <!-- MESSAGES PANEL -->
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
          <thead><tr><th>Time</th><th>Channel</th><th>Author</th><th>Message</th><th>Pick Extracted</th><th></th></tr></thead>
          <tbody>
            ${recentRaw.map(r => {
              const ts   = (r.saved_at || '').slice(0, 16).replace('T', ' ');
              const prev = escHtml((r.message_text || '').replace(/\n/g, ' ').slice(0, 60));
              const pickInfo = r.team
                ? `${escHtml(r.team)} ${escHtml(r.pick_type || '')}${r.spread != null ? ' ' + r.spread : ''} · ${escHtml(r.sport || '')} · ${r.score ?? '—'}pts`
                : '<span style="color:#3b4560;">no pick linked</span>';
              const msgEsc = escHtml(r.message_text || '').replace(/'/g, '&#39;');
              const pickEsc = JSON.stringify({ team: r.team, pick_type: r.pick_type, sport: r.sport, spread: r.spread, capper_name: r.capper_name }).replace(/'/g, '&#39;');
              return `<tr class="msg-row" data-ch="${escHtml(r.channel || '')}" data-author="${escHtml(r.author || '')}" data-text="${prev.toLowerCase()}">
                <td style="font-size:11px;color:#8892a4;white-space:nowrap;">${ts}</td>
                <td><span style="font-size:11px;color:#8892a4;">${escHtml(r.channel || '—')}</span></td>
                <td style="font-size:12px;">${escHtml(r.author || '—')}</td>
                <td style="font-size:12px;max-width:280px;word-break:break-word;cursor:pointer;color:#93c5fd;" onclick="showMsg(${r.id},'raw')" title="Click to view full message">${prev}${(r.message_text || '').length > 60 ? '…' : ''}</td>
                <td style="font-size:12px;">${pickInfo}</td>
                <td><button class="btn-sm btn-primary" onclick="event.stopPropagation();openCorrModal('${msgEsc}','${escHtml(r.channel || '')}','${escHtml(r.author || '')}','recorded','${pickEsc}')">Correct</button></td>
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
              const msgEsc = escHtml(s.content || '').replace(/'/g, '&#39;');
              return `<tr class="msg-row" data-ch="${escHtml(s.channel || '')}" data-author="${escHtml(s.author || '')}" data-text="${prev.toLowerCase()}">
                <td style="font-size:11px;color:#8892a4;white-space:nowrap;">${ts}</td>
                <td><span style="font-size:11px;color:#8892a4;">${escHtml(s.channel || '—')}</span></td>
                <td style="font-size:12px;">${escHtml(s.author || '—')}</td>
                <td style="font-size:12px;max-width:280px;word-break:break-word;cursor:pointer;color:#93c5fd;" onclick="showMsg(${s.id},'skip')" title="Click to view full message">${prev}${(s.content || '').length > 60 ? '…' : ''}</td>
                <td><span style="font-size:11px;color:#f59e0b;">${escHtml(s.reason || '—')}</span></td>
                <td><button class="btn-sm btn-primary" onclick="openCorrModal('${msgEsc}','${escHtml(s.channel || '')}','${escHtml(s.author || '')}','skipped',null)">Correct</button></td>
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

      // ── Picks panel ────────────────────────────────────────────────────────────
      function toggleMsgs(id, btn) {
        const row = document.getElementById('msgs-' + id);
        const open = row.style.display !== 'none';
        row.style.display = open ? 'none' : '';
        btn.textContent = btn.textContent.replace(open ? '▴' : '▾', open ? '▾' : '▴');
      }

      // ── Action confirm modal ───────────────────────────────────────────────────
      const ACTION_INFO = {
        nuke: {
          title: 'NUKE & RESCAN',
          color: '#ef4444',
          body: 'Deletes all picks, raw messages, and score breakdowns for today. Preserves today_games, lines, MVP history, and users. Then immediately triggers a fresh scan back to 6am.',
          cost: 'Uses Haiku API credits (~$0.01–0.05) to re-read all Discord messages since 6am.',
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
          cost: 'Uses Haiku API credits for all messages since 6am (~$0.01–0.05 depending on volume).',
          confirm: null,
          typed: false,
        },
        skipped: {
          title: 'Rescan Skipped',
          color: '#0f766e',
          body: 'Re-runs all previously skipped messages through the current reader rules. Useful after updating the RULES prompt or adding corrections.',
          cost: 'Uses Haiku API credits — one call per skipped message (can be $0.01–0.10+ if many messages).',
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
      };

      function confirmAction(key) {
        const info = ACTION_INFO[key];
        if (!info) return;
        document.getElementById('action-modal-title').textContent = info.title;
        document.getElementById('action-modal-title').style.color = info.color;
        document.getElementById('action-modal-body').textContent  = info.body;
        document.getElementById('action-modal-cost').textContent  = info.cost;
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
        }
      }

      // ── Quick code generator ───────────────────────────────────────────────────
      async function quickGenerate() {
        const type  = document.getElementById('qgen-type').value;
        const count = parseInt(document.getElementById('qgen-count').value, 10);
        const notes = document.getElementById('qgen-notes').value.trim();
        const res   = await fetch('/admin/generate-codes-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, count, notes }),
        });
        const data = await res.json();
        if (!data.ok) { alert('Error: ' + (data.error || 'unknown')); return; }
        const resultEl = document.getElementById('qgen-result');
        const codesEl  = document.getElementById('qgen-codes');
        codesEl.innerHTML = data.codes.map(c =>
          \`<div style="display:flex;align-items:center;gap:12px;">
            <span style="color:#e2e8f0;font-size:14px;">\${c}</span>
            <button onclick="navigator.clipboard.writeText('\${c}').then(()=>this.textContent='Copied!').catch(()=>{})"
              style="background:none;border:1px solid #252c3b;color:#8892a4;border-radius:4px;padding:1px 8px;font-size:11px;cursor:pointer;">Copy</button>
          </div>\`
        ).join('');
        resultEl.style.display = '';
        // reload after 3s so table updates
        setTimeout(() => location.reload(), 3000);
      }

      async function deleteCode(id) {
        if (!confirm('Delete this unused code?')) return;
        await fetch('/admin/delete-code/' + id, { method: 'DELETE' });
        location.reload();
      }

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
        if (pt === 'ml') { betOdds = m.ml_odds ?? (pick ? pick.original_ml : null); oddsLabel = 'Moneyline'; }
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
      async function addAlias() {
        const canonical = document.getElementById('alias-canonical').value.trim();
        const alias     = document.getElementById('alias-alias').value.trim();
        const msg       = document.getElementById('alias-msg');
        if (!canonical || !alias) { msg.textContent = 'Both fields are required.'; msg.style.color = '#ef4444'; return; }
        const res  = await fetch('/admin/capper-alias', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ canonical, alias }) });
        const data = await res.json();
        if (data.ok) {
          msg.textContent = 'Alias added. Reload the page to see updated leaderboard.';
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
              \${['ML','spread','over','under','NRFI','h2h','top5','top10'].map(t=>\`<option value="\${t}" \${pre?.pick_type===t?'selected':''}>\${t}</option>\`).join('')}
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

router.post('/capper-alias', requireAuth, express.json(), (req, res) => {
  const { canonical, alias } = req.body || {};
  if (!canonical || !alias) return res.json({ ok: false, error: 'Both canonical and alias are required' });
  try {
    db.prepare(`INSERT OR REPLACE INTO capper_aliases (canonical_name, alias) VALUES (?, ?)`)
      .run(canonical.trim(), alias.trim());
    res.json({ ok: true });
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

// ── POST /admin/generate-codes-batch — JSON batch generator ──────────────────
router.post('/generate-codes-batch', requireAuth, express.json(), (req, res) => {
  const { type, count = 1, notes } = req.body || {};
  const validTypes = ['day', 'week', 'annual', 'lifetime'];
  if (!validTypes.includes(type)) return res.status(400).json({ ok: false, error: 'Invalid code type.' });
  const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 20);
  const insert = db.prepare(`INSERT INTO access_codes (code, type, notes) VALUES (?, ?, ?)`);
  const codes = [];
  for (let i = 0; i < n; i++) {
    let code, tries = 0;
    do { code = generateCode(); tries++; } while (tries < 10 && db.prepare(`SELECT id FROM access_codes WHERE code = ?`).get(code));
    insert.run(code, type, notes || null);
    codes.push(code);
  }
  console.log(`[admin] Generated ${n} ${type} codes: ${codes.join(', ')}`);
  res.json({ ok: true, codes });
});

// ── DELETE /admin/delete-code/:id ─────────────────────────────────────────────
router.delete('/delete-code/:id', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT id, activated_by FROM access_codes WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  if (row.activated_by != null) return res.status(409).json({ ok: false, error: 'Cannot delete a used code.' });
  db.prepare(`DELETE FROM access_codes WHERE id = ?`).run(row.id);
  res.json({ ok: true });
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


// ── POST /admin/import-mvp — import MVP picks from JSON (use after redeploy) ─
router.post('/import-mvp', express.json({ limit: '5mb' }), (req, res) => {
  const pw = req.headers['x-admin-password'];
  if (pw !== process.env.ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
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

// ── HTML escape helper ────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
