// src/og_card.js — dynamic share cards (og:image) for game detail pages.
// Composes a 1200x630 SVG (matchup, score/lines, and the CA pick result once a
// game is final — the share-a-win card) and rasterizes it with @resvg/resvg-js
// (prebuilt napi binary, no gyp build). If the module or fonts are ever
// missing, everything no-ops and the route falls back to the static logo, so
// this can never take a page down. Public-safe by design: pre-game cards show
// market lines only, never a pick side or score; the pick strip appears only
// on finished games whose MVP pick already resolved (public info on /results).

const path = require('path');
const fs = require('fs');
const db = require('./db');

let Resvg = null;
try { ({ Resvg } = require('@resvg/resvg-js')); } catch (_) { /* disabled */ }

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_FILES = ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf']
  .map(f => path.join(FONT_DIR, f))
  .filter(f => { try { return fs.existsSync(f); } catch (_) { return false; } });

function available() { return !!Resvg && FONT_FILES.length > 0; }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtSigned(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return n > 0 ? `+${n}` : `${n}`;
}

function etTime(startTime) {
  try {
    return new Date(startTime).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York',
    }) + ' ET';
  } catch (_) { return ''; }
}

// Team-name font size that keeps long names on the card.
function nameSize(name) {
  const len = (name || '').length;
  if (len <= 14) return 64;
  if (len <= 20) return 52;
  if (len <= 26) return 42;
  return 34;
}

function buildOgSvg(g) {
  const away = g.away_team || 'Away';
  const home = g.home_team || 'Home';
  const sport = (g.sport || '').toUpperCase();
  const status = g.status || 'pre';
  const size = Math.min(nameSize(away), nameSize(home));

  // Middle band: score for live/finished games, market lines pre-game.
  let midLines = [];
  if (status === 'in' || status === 'post') {
    const score = `${g.away_score ?? 0} - ${g.home_score ?? 0}`;
    const tag = status === 'post' ? 'FINAL' : 'LIVE';
    midLines.push({ text: `${tag}  ${score}`, size: 46, fill: status === 'post' ? '#e8edf4' : '#4ade80', weight: 'bold' });
  } else {
    const bits = [];
    const sp = fmtSigned(g.spread_home);
    if (sp != null) bits.push(`${g.home_abbr || 'Home'} ${sp}`);
    if (g.over_under != null) bits.push(`O/U ${g.over_under}`);
    const mlh = fmtSigned(g.ml_home), mla = fmtSigned(g.ml_away);
    if (mlh && mla) bits.push(`ML ${mla} / ${mlh}`);
    if (bits.length) midLines.push({ text: bits.join('  ·  '), size: 34, fill: '#9aa4b2', weight: 'normal' });
    const when = g.start_time ? etTime(g.start_time) : '';
    if (when) midLines.push({ text: when, size: 28, fill: '#6b7684', weight: 'normal' });
  }

  // Share-a-win strip: the tracked pick's result once the game is final.
  let pickStrip = null;
  if (status === 'post') {
    try {
      const mvp = db.prepare(`
        SELECT team, pick_type, spread, result FROM mvp_picks
        WHERE espn_game_id = ? AND result IN ('win', 'loss', 'push')
        ORDER BY score DESC LIMIT 1
      `).get(g.espn_game_id);
      if (mvp) {
        const label = mvp.pick_type === 'over' || mvp.pick_type === 'under'
          ? `${mvp.pick_type.toUpperCase()}${mvp.spread != null ? ' ' + mvp.spread : ''}`
          : `${mvp.team} ${String(mvp.pick_type || '').toUpperCase()}${mvp.pick_type === 'spread' && mvp.spread != null ? ' ' + fmtSigned(mvp.spread) : ''}`;
        const res = mvp.result.toUpperCase();
        const color = mvp.result === 'win' ? '#4ade80' : mvp.result === 'loss' ? '#f87171' : '#9aa4b2';
        pickStrip = { label, res, color };
      }
    } catch (_) {}
  }

  const midSvg = midLines.map((l, i) =>
    `<text x="600" y="${418 + i * 46}" text-anchor="middle" font-family="DejaVu Sans" font-size="${l.size}" font-weight="${l.weight}" fill="${l.fill}">${esc(l.text)}</text>`
  ).join('\n  ');

  const stripSvg = pickStrip ? `
  <rect x="0" y="510" width="1200" height="120" fill="#10151f"/>
  <rect x="0" y="510" width="1200" height="2" fill="#d4af37"/>
  <text x="70" y="583" font-family="DejaVu Sans" font-size="34" font-weight="bold" fill="#d4af37">CA PICK</text>
  <text x="250" y="583" font-family="DejaVu Sans" font-size="34" fill="#e8edf4">${esc(pickStrip.label)}</text>
  <text x="1130" y="583" text-anchor="end" font-family="DejaVu Sans" font-size="40" font-weight="bold" fill="${pickStrip.color}">${esc(pickStrip.res)}</text>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0d1119"/>
  <rect width="1200" height="6" fill="#d4af37"/>
  <text x="70" y="96" font-family="DejaVu Sans" font-size="34" font-weight="bold" fill="#e8edf4">CAPPING<tspan fill="#d4af37">ALPHA</tspan></text>
  ${sport ? `<rect x="1010" y="60" width="120" height="46" rx="8" fill="#1a2230"/><text x="1070" y="92" text-anchor="middle" font-family="DejaVu Sans" font-size="26" font-weight="bold" fill="#9aa4b2">${esc(sport)}</text>` : ''}
  <text x="600" y="220" text-anchor="middle" font-family="DejaVu Sans" font-size="${size}" font-weight="bold" fill="#e8edf4">${esc(away)}</text>
  <text x="600" y="278" text-anchor="middle" font-family="DejaVu Sans" font-size="30" fill="#6b7684">@</text>
  <text x="600" y="348" text-anchor="middle" font-family="DejaVu Sans" font-size="${size}" font-weight="bold" fill="#e8edf4">${esc(home)}</text>
  ${midSvg}
  ${stripSvg}
</svg>`;
}

// Tiny TTL cache: live cards refresh every minute, settled ones hold longer.
const _cache = new Map();   // id -> { png, exp }
const CACHE_MAX = 80;

function renderOgPng(espnGameId) {
  if (!available()) return null;
  const hit = _cache.get(espnGameId);
  if (hit && hit.exp > Date.now()) return hit.png;

  // today_games first; fall back to the permanent MVP archive after the wipe.
  let g = null;
  try { g = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(espnGameId); } catch (_) {}
  if (!g) {
    try {
      const m = db.prepare(`
        SELECT espn_game_id, sport, home_team, away_team, game_date AS start_time,
               home_score, away_score, 'post' AS status,
               NULL AS spread_home, NULL AS over_under, NULL AS ml_home, NULL AS ml_away,
               NULL AS home_abbr
        FROM mvp_picks WHERE espn_game_id = ? ORDER BY score DESC LIMIT 1
      `).get(espnGameId);
      if (m) g = m;
    } catch (_) {}
  }
  if (!g) return null;

  let png = null;
  try {
    const svg = buildOgSvg(g);
    const r = new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } });
    png = r.render().asPng();
  } catch (e) {
    console.warn('[og] render failed:', e.message);
    return null;
  }

  const ttl = g.status === 'in' ? 60_000 : g.status === 'post' ? 3_600_000 : 300_000;
  _cache.set(espnGameId, { png, exp: Date.now() + ttl });
  if (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
  return png;
}

module.exports = { renderOgPng, available };
