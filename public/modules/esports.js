// modules/esports.js — Esports tab

import { sportBadge } from './utils.js?v=4';

const ESPORTS_GAMES = [
  { rank: 1,  name: 'Rainbow Six Siege',   short: 'R6S',  genre: 'Tactical FPS',  grad: 'linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%)',   icon: 'fa-solid fa-crosshairs',      color: '#38bdf8' },
  { rank: 2,  name: 'Counter-Strike 2',    short: 'CS2',  genre: 'Tactical FPS',  grad: 'linear-gradient(135deg,#1c1c1c 0%,#2d2d2d 40%,#f5a623 100%)',   icon: 'fa-solid fa-bomb',            color: '#f5a623' },
  { rank: 3,  name: 'Valorant',            short: 'VAL',  genre: 'Tactical FPS',  grad: 'linear-gradient(135deg,#1a0a0a 0%,#3d0b0b 50%,#ff4655 100%)',   icon: 'fa-solid fa-gun',             color: '#ff4655' },
  { rank: 4,  name: 'League of Legends',   short: 'LoL',  genre: 'MOBA',          grad: 'linear-gradient(135deg,#0a1628 0%,#091428 50%,#c8aa6e 100%)',   icon: 'fa-solid fa-shield-halved',   color: '#c8aa6e' },
  { rank: 5,  name: 'Dota 2',             short: 'DOTA', genre: 'MOBA',          grad: 'linear-gradient(135deg,#0d0d0d 0%,#1a1a1a 50%,#c23c2a 100%)',   icon: 'fa-solid fa-dragon',          color: '#c23c2a' },
  { rank: 6,  name: 'Overwatch 2',        short: 'OW2',  genre: 'Hero Shooter',  grad: 'linear-gradient(135deg,#0a1f3d 0%,#0d2951 50%,#f99e1a 100%)',   icon: 'fa-solid fa-user-astronaut',  color: '#f99e1a' },
  { rank: 7,  name: 'Rocket League',      short: 'RL',   genre: 'Sports',        grad: 'linear-gradient(135deg,#0a1628 0%,#1a3d6e 50%,#5b9bd5 100%)',   icon: 'fa-solid fa-car',             color: '#5b9bd5' },
  { rank: 8,  name: 'Call of Duty',       short: 'CDL',  genre: 'FPS',           grad: 'linear-gradient(135deg,#0d1117 0%,#1c2431 50%,#4a5568 100%)',   icon: 'fa-solid fa-skull',           color: '#718096' },
  { rank: 9,  name: 'Apex Legends',       short: 'APEX', genre: 'Battle Royale', grad: 'linear-gradient(135deg,#0d1117 0%,#1a1a2e 50%,#cd4400 100%)',   icon: 'fa-solid fa-fire',            color: '#cd4400' },
  { rank: 10, name: 'PUBG Esports',       short: 'PUBG', genre: 'Battle Royale', grad: 'linear-gradient(135deg,#0a1628 0%,#1c3a5e 50%,#f5c518 100%)',   icon: 'fa-solid fa-circle-dot',      color: '#f5c518' },
];

function unlockEsports() {
  const panel = document.getElementById('panel-esports');
  if (panel) panel.classList.add('unlocked');
}

// Easter egg: click the construction helmet 5 times to preview/edit the page.
// Stays unlocked for the session so a refresh keeps it open.
function wireHelmetUnlock() {
  if (sessionStorage.getItem('esportsUnlocked') === '1') {
    unlockEsports();
    return;
  }
  const helmet = document.getElementById('esports-helmet');
  if (!helmet || helmet.dataset.wired) return;
  helmet.dataset.wired = '1';
  let clicks = 0;
  helmet.addEventListener('click', () => {
    clicks += 1;
    if (clicks >= 5) {
      sessionStorage.setItem('esportsUnlocked', '1');
      unlockEsports();
    }
  });
}

export function renderEsports() {
  wireHelmetUnlock();
  loadTopGames();
  const grid = document.getElementById('esports-grid');
  if (!grid) return;

  grid.innerHTML = ESPORTS_GAMES.map(g => `
    <div class="esports-card" style="background:${g.grad};">
      <div class="esports-card-rank"># ${g.rank}</div>
      <div style="font-size:22px;margin-bottom:8px;color:${g.color};"><i class="${g.icon}"></i></div>
      <div class="esports-card-name">${g.name}</div>
      <div class="esports-card-sub">${g.genre} &middot; ${g.short}</div>
      <span class="esports-card-badge">Coming Soon</span>
    </div>`).join('');
}

// ── Top Games row (scraped from Kalshi + Polymarket via /api/esports/top) ──────
// Renders the SAME tile shell as the home page "Today's Top Games" strip
// (.ca-top-games-row / .ca-tg-*) so restyling that component restyles this too.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Trim common org suffixes so brand names fit the shared 186px tile.
function shortTeam(name) {
  return String(name || '').trim().replace(/\s+(esports?|gaming|team|club|academy|fc|gg)$/i, '');
}

function fmtMoney(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
  return '$' + Math.round(n);
}
function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(Math.round(n));
}
function fmtVol(r) {
  if (!r.volume) return '—';
  return r.source === 'polymarket' ? fmtMoney(r.volume) : fmtCount(r.volume);
}

// Esports matches span multiple days, so include the date (ET) — gameTime() is time-only.
function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  if (d.getTime() <= Date.now()) return 'Live';
  const date = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
  return `${date}, ${time}`;
}

// One match tile, structurally identical to home_top.js _gameTile (shared CSS).
function matchTile(r) {
  const probA   = Math.round((r.prob_a || 0) * 100);
  const probB   = Math.round((r.prob_b || 0) * 100);
  const aFav    = probA >= probB;
  const src     = r.source === 'polymarket' ? 'Polymarket' : 'Kalshi';
  const when    = fmtWhen(r.start_time);
  const left    = when ? `${fmtVol(r)} vol · ${when}` : `${fmtVol(r)} vol`;
  const row = (team, prob, fav) => `<div class="ca-tg-team${fav ? ' ca-tg-team-win' : ''}">
      <span class="ca-tg-abbr">${esc((shortTeam(team) || '?').slice(0, 3).toUpperCase())}</span>
      <span class="ca-tg-tname">${esc(shortTeam(team))}</span>
      <span class="ca-tg-tscore">${prob}%</span>
    </div>`;
  return `<div class="ca-tg-tile" style="cursor:default;" title="${esc(r.team_a)} vs ${esc(r.team_b)}">
    <div class="ca-tg-head">
      ${sportBadge(r.game || 'Esports')}
      <span class="ca-tg-corner"><span class="ca-tg-src">${src}</span></span>
    </div>
    <div class="ca-tg-teams">
      ${row(r.team_a, probA, aFav)}
      ${row(r.team_b, probB, !aFav)}
    </div>
    <div class="ca-tg-foot">
      <span class="ca-tg-time">${left}</span>
    </div>
  </div>`;
}

export async function loadTopGames() {
  const el = document.getElementById('esports-top-row');
  if (!el) return;
  el.innerHTML = `<div class="ca-top-games-empty">Loading top games...</div>`;
  try {
    const res  = await fetch('/api/esports/top');
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      el.innerHTML = `<div class="ca-top-games-empty">No esports matches live right now. Check back soon.</div>`;
      return;
    }
    el.innerHTML = rows.map(matchTile).join('');
  } catch (_) {
    el.innerHTML = `<div class="ca-top-games-empty">Couldn't load esports matches.</div>`;
  }
}
