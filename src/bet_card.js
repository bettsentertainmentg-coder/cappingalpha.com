// src/bet_card.js — the shareable BET card (1080x1080).
//
// A purpose-built card for one tracked bet, distinct from og_card.js (which
// renders a GAME for a page preview). This one is about the bet: what it is, at
// what price, and how it finished, with the owner's record underneath.
//
// Rendered server side as SVG and rasterized with @resvg/resvg-js so every share
// looks identical everywhere, and so the same PNG can serve two jobs: the file the
// user drops into iMessage / X / Instagram, and the og:image on the share link.
//
// ACCESS: a bet is private, so the URL carries an HMAC of the bet id keyed on
// SESSION_SECRET. Only a link the owner was handed opens the card, and the token
// leaks nothing about any other bet. Nothing here reveals scoring internals: the
// card shows the bet, the price and the result, which is what the owner already
// sees, and never a capper, a channel, or a score.

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');

let Resvg = null;
try { ({ Resvg } = require('@resvg/resvg-js')); } catch (_) { /* disabled -> route falls back */ }

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_FILES = ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf']
  .map(f => path.join(FONT_DIR, f))
  .filter(f => { try { return fs.existsSync(f); } catch (_) { return false; } });

function available() { return !!Resvg && FONT_FILES.length > 0; }

// ── Token ─────────────────────────────────────────────────────────────────────
function secret() {
  return process.env.SESSION_SECRET || 'ca-bet-card-dev-secret';
}
function tokenFor(betId) {
  return crypto.createHmac('sha256', secret()).update(`bet:${betId}`).digest('hex').slice(0, 24);
}
function tokenValid(betId, token) {
  const want = Buffer.from(tokenFor(betId));
  const got = Buffer.from(String(token || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const fmtOdds = o => (o == null || !Number.isFinite(Number(o)) ? '' : (Number(o) > 0 ? '+' + Number(o) : String(Number(o))));
const money = v => `$${Math.abs(Number(v) || 0).toFixed(2)}`;

// Wrap to a pixel width using an average-advance estimate. DejaVu Sans Bold runs
// about 0.60em average across mixed case, which is close enough for a headline
// that only ever needs two or three lines.
function wrap(text, size, maxWidth, maxLines) {
  const perChar = size * 0.60;
  const max = Math.max(6, Math.floor(maxWidth / perChar));
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (next.length > max && cur) { lines.push(cur); cur = w; } else { cur = next; }
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (!lines.length) return [''];
  // Ellipsize if we ran out of lines with words left over.
  const used = lines.join(' ').split(/\s+/).length;
  if (used < words.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S*$/, '') + '...';
  return lines;
}
function headlineSize(text) {
  const n = String(text || '').length;
  if (n <= 18) return 92;
  if (n <= 28) return 74;
  if (n <= 40) return 60;
  return 50;
}

const RESULT_STYLE = {
  win:     { label: 'WON',     color: '#4ade80' },
  loss:    { label: 'LOST',    color: '#f87171' },
  push:    { label: 'PUSH',    color: '#94a3b8' },
  void:    { label: 'VOID',    color: '#94a3b8' },
  pending: { label: 'ON THE BOARD', color: '#60a5fa' },
};

// ── SVG ───────────────────────────────────────────────────────────────────────
function buildSvg(bet, legs, record, unit) {
  const W = 1080, H = 1080, cx = W / 2;
  const result = String(bet.result || 'pending').toLowerCase();
  const rs = RESULT_STYLE[result] || RESULT_STYLE.pending;
  const settled = result === 'win' || result === 'loss';
  const isParlay = bet.bet_type === 'parlay' && legs.length >= 2;

  // Headline: the bet itself.
  const lineTxt = bet.line != null && bet.bet_type === 'spread'
    ? ` ${Number(bet.line) > 0 ? '+' : ''}${Number(bet.line)}`
    : (bet.line != null && (bet.bet_type === 'over' || bet.bet_type === 'under') ? ` ${Number(bet.line)}` : '');
  const headline = isParlay ? `${legs.length}-Leg Parlay` : `${bet.selection || 'My bet'}${lineTxt}`;
  const hSize = headlineSize(headline);
  const hLines = wrap(headline, hSize, W - 150, 2);

  // Sub line: the matchup, or nothing.
  const sub = isParlay ? '' : [bet.away_team && bet.home_team ? `${bet.away_team} @ ${bet.home_team}` : '', bet.sport || '']
    .filter(Boolean).join('   ·   ');

  let y = 300;
  const parts = [];

  // Result badge.
  parts.push(`<text x="${cx}" y="${y}" font-size="${settled || result === 'pending' ? 78 : 78}" font-weight="bold" fill="${rs.color}" text-anchor="middle" letter-spacing="4">${esc(rs.label)}</text>`);
  y += 110;

  // Headline.
  for (const l of hLines) {
    parts.push(`<text x="${cx}" y="${y}" font-size="${hSize}" font-weight="bold" fill="#ffffff" text-anchor="middle">${esc(l)}</text>`);
    y += hSize + 12;
  }
  y += 8;

  // Matchup / sport.
  if (sub) {
    parts.push(`<text x="${cx}" y="${y}" font-size="34" fill="#8892a4" text-anchor="middle">${esc(sub)}</text>`);
    y += 56;
  }

  // Parlay legs, up to five, then a count.
  if (isParlay) {
    const show = legs.slice(0, 5);
    for (const l of show) {
      const legLine = l.line != null ? ` ${Number(l.line) > 0 && l.bet_type === 'spread' ? '+' : ''}${Number(l.line)}` : '';
      const legTxt = `${l.selection || ''}${legLine}  ${fmtOdds(l.odds)}`;
      const mark = String(l.result || 'pending').toLowerCase();
      const col = mark === 'win' ? '#4ade80' : mark === 'loss' ? '#f87171' : '#cbd5e1';
      parts.push(`<text x="${cx}" y="${y}" font-size="30" fill="${col}" text-anchor="middle">${esc(wrap(legTxt, 30, W - 200, 1)[0])}</text>`);
      y += 44;
    }
    if (legs.length > show.length) {
      parts.push(`<text x="${cx}" y="${y}" font-size="26" fill="#64748b" text-anchor="middle">+${legs.length - show.length} more</text>`);
      y += 40;
    }
    y += 10;
  }

  // The numbers strip: odds pill, then risk -> return.
  const oddsTxt = fmtOdds(bet.odds) || '—';
  const stake = Number(bet.stake) || 0;
  const profit = bet.payout == null ? null : Number(bet.payout);
  y = Math.max(y + 20, 700);

  const pillW = Math.max(190, oddsTxt.length * 34 + 70);
  parts.push(`<rect x="${cx - pillW / 2}" y="${y - 58}" width="${pillW}" height="82" rx="41" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.16)" stroke-width="2"/>`);
  parts.push(`<text x="${cx}" y="${y}" font-size="52" font-weight="bold" fill="#ffffff" text-anchor="middle">${esc(oddsTxt)}</text>`);
  y += 90;

  if (settled && profit != null) {
    const units = unit > 0 ? `${profit >= 0 ? '+' : '-'}${Math.abs(profit / unit).toFixed(2)}u` : '';
    const sign = profit >= 0 ? '+' : '-';
    parts.push(`<text x="${cx}" y="${y}" font-size="76" font-weight="bold" fill="${rs.color}" text-anchor="middle">${esc(sign + money(profit))}</text>`);
    y += 52;
    const detail = [stake > 0 ? `${money(stake)} risk` : null, units, bet.book || null].filter(Boolean).join('   ·   ');
    if (detail) parts.push(`<text x="${cx}" y="${y}" font-size="30" fill="#8892a4" text-anchor="middle">${esc(detail)}</text>`);
  } else {
    const detail = [stake > 0 ? `${money(stake)} to win ${money(americanProfit(bet.odds, stake))}` : null, bet.book || null]
      .filter(Boolean).join('   ·   ');
    if (detail) parts.push(`<text x="${cx}" y="${y}" font-size="32" fill="#cbd5e1" text-anchor="middle">${esc(detail)}</text>`);
  }

  // Footer: record + domain.
  const recTxt = record && (record.w + record.l + record.p) > 0
    ? `${record.w}-${record.l}${record.p ? '-' + record.p : ''} tracked`
    : 'Tracking every bet';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1220"/><stop offset="100%" stop-color="#0f1117"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="${rs.color}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="14" fill="url(#accent)"/>
  <text x="${cx}" y="130" font-size="42" font-weight="bold" fill="#e2e8f0" text-anchor="middle" letter-spacing="1">CappingAlpha</text>
  ${bet.verified ? `<text x="${cx}" y="176" font-size="24" fill="#4ade80" text-anchor="middle" letter-spacing="3">VERIFIED PICK</text>` : ''}
  ${parts.join('\n  ')}
  <line x1="120" y1="${H - 150}" x2="${W - 120}" y2="${H - 150}" stroke="rgba(255,255,255,0.10)" stroke-width="2"/>
  <text x="120" y="${H - 92}" font-size="30" fill="#8892a4">${esc(recTxt)}</text>
  <text x="${W - 120}" y="${H - 92}" font-size="30" font-weight="bold" fill="#64748b" text-anchor="end">cappingalpha.com</text>
</svg>`;
}

// Net profit on a win at American odds (mirror of odds_math.americanProfit; kept
// local so the card module has no reason to reach into the grading path).
function americanProfit(odds, stake) {
  const o = (odds == null || Number.isNaN(parseFloat(odds))) ? -110 : parseFloat(odds);
  const s = Number(stake) || 0;
  return o < 0 ? s * (100 / Math.abs(o)) : s * (o / 100);
}

// ── Render ────────────────────────────────────────────────────────────────────
const _cache = new Map(); // betId -> { png, exp, sig }

function renderBetCardPng(betId) {
  if (!available()) return null;
  const id = Number(betId);
  if (!Number.isFinite(id)) return null;

  let bet = null;
  try { bet = db.prepare(`SELECT * FROM user_bets WHERE id = ?`).get(id); } catch (_) {}
  if (!bet) return null;

  // A pending bet's card changes as the game moves, so cache briefly; a settled
  // one is final and caches for an hour.
  const settled = bet.result && bet.result !== 'pending';
  const sig = `${bet.result}|${bet.payout}|${bet.odds}|${bet.stake}`;
  const hit = _cache.get(id);
  if (hit && hit.exp > Date.now() && hit.sig === sig) return hit.png;

  let legs = [];
  if (bet.bet_type === 'parlay') {
    try { legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ? ORDER BY leg_index, id`).all(id); } catch (_) {}
  }

  let record = null;
  try {
    const r = db.prepare(`
      SELECT SUM(result='win') w, SUM(result='loss') l, SUM(result='push') p
      FROM user_bets WHERE user_id = ? AND result IN ('win','loss','push')
    `).get(bet.user_id);
    if (r) record = { w: r.w || 0, l: r.l || 0, p: r.p || 0 };
  } catch (_) {}

  let unit = 20;
  try {
    const u = db.prepare(`SELECT unit_size FROM user_preferences WHERE user_id = ?`).get(bet.user_id);
    if (u && u.unit_size > 0) unit = u.unit_size;
  } catch (_) {}

  let png = null;
  try {
    const svg = buildSvg(bet, legs, record, unit);
    png = new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } })
      .render().asPng();
  } catch (e) {
    console.warn('[bet_card]', e.message);
    return null;
  }

  _cache.set(id, { png, sig, exp: Date.now() + (settled ? 3600_000 : 120_000) });
  if (_cache.size > 80) _cache.delete(_cache.keys().next().value);
  return png;
}

// The text that rides along with the card. Never names a capper or the scoring.
function shareText(betId) {
  let bet = null;
  try { bet = db.prepare(`SELECT * FROM user_bets WHERE id = ?`).get(Number(betId)); } catch (_) {}
  const site = 'https://cappingalpha.com';
  if (!bet) return `Tracking my bets on CappingAlpha: ${site}`;
  const what = bet.bet_type === 'parlay' ? 'my parlay' : (bet.selection || 'my bet');
  const r = String(bet.result || 'pending').toLowerCase();
  if (r === 'win')  return `Just cashed ${what} on CappingAlpha. Ranked picks and full bet tracking: ${site}`;
  if (r === 'loss') return `${what} did not land. Every bet tracked, win or lose, on CappingAlpha: ${site}`;
  if (r === 'push' || r === 'void') return `${what} pushed. Every bet tracked on CappingAlpha: ${site}`;
  return `I am on ${what}. Ranked picks and full bet tracking on CappingAlpha: ${site}`;
}

module.exports = { renderBetCardPng, tokenFor, tokenValid, shareText, available, buildSvg };
