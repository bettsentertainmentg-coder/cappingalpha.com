// public/modules/home_sidebar.js
// Home page left sidebar: #1 pick card + today's games by sport.
// Also exports loadHeadlines() for the right-column headlines section.

import { state }    from './state.js';
import { isPaying } from './auth.js';
import { gameTime } from './utils.js';

let _sidebarSport = 'MLB';
let _sidebarGames = [];

// ── Orchestrator ──────────────────────────────────────────────────────────────
export async function loadHomeSidebar() {
  await Promise.all([_renderTopPick(), _loadSidebarGames()]);
}

// ── #1 pick card ──────────────────────────────────────────────────────────────
async function _renderTopPick() {
  const el = document.getElementById('ca-top-pick-slot');
  if (!el) return;

  try {
    const res = await fetch('/api/picks/top');
    if (!res.ok) throw new Error('no pick');
    const pick = await res.json();
    if (!pick || !pick.team) throw new Error('empty');

    const score     = pick.score || 0;
    const threshold = state.CONFIG?.mvp_threshold || 50;
    const isGold    = score >= threshold;
    const isSilver  = score >= 35 && score < threshold;

    const tierColor = isGold ? '#FFD700' : isSilver ? '#C0C0C0' : 'var(--muted)';

    const badgeStyle = isGold
      ? 'background:rgba(255,215,0,0.12);color:#FFD700;border:1px solid rgba(255,215,0,0.3);'
      : isSilver
        ? 'background:rgba(192,192,192,0.12);color:#C0C0C0;border:1px solid rgba(192,192,192,0.3);'
        : 'background:var(--surface2);color:var(--muted);border:1px solid rgba(255,255,255,0.1);';

    const matchup = (pick.away_team && pick.home_team)
      ? `${pick.away_short || pick.away_team} @ ${pick.home_short || pick.home_team}`
      : (pick.matchup || '');

    const ctaHtml = isPaying()
      ? `<div class="ca-top-pick-cta-label" style="text-align:left;">Full board unlocked</div>`
      : `<div>
           <div class="ca-top-pick-cta-label">Unlock picks #2–30</div>
           <div class="ca-top-pick-pricing-row">
             <button class="ca-top-pick-price-btn" onclick="startCheckout('day')">$1 / day</button>
             <button class="ca-top-pick-price-btn featured" onclick="startCheckout('week')">$4 / week</button>
             <button class="ca-top-pick-price-btn" onclick="startCheckout('year')">$75 / yr</button>
           </div>
         </div>`;

    el.innerHTML = `
      <div class="ca-top-pick-card">
        <div class="ca-top-pick-header">
          <div class="ca-top-pick-rank-num" style="color:${tierColor};">1</div>
          <span class="ca-top-pick-score" style="${badgeStyle}">${score} pts</span>
        </div>
        <div class="ca-top-pick-team">${pick.team}</div>
        <div class="ca-top-pick-matchup">${matchup}</div>
        ${ctaHtml}
      </div>`;
  } catch (_) {
    el.innerHTML = `<div class="ca-top-pick-card ca-top-pick-empty"><p style="color:var(--muted);font-size:13px;text-align:center;padding:8px 0;">No picks yet today.</p></div>`;
  }
}

// ── Sidebar games ─────────────────────────────────────────────────────────────
async function _loadSidebarGames() {
  const listEl = document.getElementById('ca-sidebar-games-list');
  const tabEl  = document.getElementById('ca-sidebar-sport-tabs');
  if (!listEl) return;

  try {
    const res = await fetch('/api/games');
    if (!res.ok) return;
    _sidebarGames = await res.json();
    if (!_sidebarGames || _sidebarGames.length === 0) {
      listEl.innerHTML = `<div style="padding:12px 16px;color:var(--muted);font-size:13px;">No games today.</div>`;
      return;
    }

    // Build unique display sport labels (ATP+WTA → Tennis)
    const raw = [...new Set(_sidebarGames.map(g => g.sport))].filter(Boolean);
    const displaySports = [...new Set(raw.map(s => (s === 'ATP' || s === 'WTA') ? 'Tennis' : s))];

    // Default to first sport if current selection not available
    if (!displaySports.includes(_sidebarSport)) {
      _sidebarSport = displaySports[0] || 'MLB';
    }

    if (tabEl) {
      tabEl.innerHTML = displaySports.map(s =>
        `<button class="ca-sidebar-sport-tab${s === _sidebarSport ? ' active' : ''}" onclick="setSidebarSport('${s}')">${s}</button>`
      ).join('');
    }

    _renderSidebarGames(_sidebarSport);
  } catch (err) {
    console.warn('[home_sidebar] games load error:', err.message);
  }
}

function _renderSidebarGames(sport) {
  const el = document.getElementById('ca-sidebar-games-list');
  if (!el) return;

  const filtered = _sidebarGames.filter(g => {
    if (sport === 'Tennis') return g.sport === 'ATP' || g.sport === 'WTA';
    return g.sport === sport;
  });

  if (filtered.length === 0) {
    el.innerHTML = `<div style="padding:12px 16px;color:var(--muted);font-size:13px;">No ${sport} games today.</div>`;
    return;
  }

  el.innerHTML = filtered.map(g => {
    const isLive = g.status === 'in';
    const isPost = g.status === 'post';
    let timeOrScore;
    if (isLive) {
      timeOrScore = `<span class="ca-sidebar-live-dot"></span><span style="color:#38bdf8;font-weight:700;font-size:11px;">${g.clock || 'Live'}</span>`;
    } else if (isPost) {
      timeOrScore = `<span style="color:var(--muted);font-size:12px;">${g.away_score ?? 0}–${g.home_score ?? 0} F</span>`;
    } else {
      timeOrScore = `<span style="color:var(--muted);font-size:12px;">${gameTime(g.start_time)}</span>`;
    }

    // /api/games only exposes home_team / away_team — take last word as short name
    const awayFull = g.away_team || 'Away';
    const homeFull = g.home_team || 'Home';
    const away = awayFull.split(' ').pop();
    const home = homeFull.split(' ').pop();

    return `<div class="ca-sidebar-game-row" onclick="openGameModal('${g.espn_game_id}')">
      <span class="ca-sidebar-game-matchup">${away} @ ${home}</span>
      <span class="ca-sidebar-game-time">${timeOrScore}</span>
    </div>`;
  }).join('');
}

export function setSidebarSport(sport) {
  _sidebarSport = sport;
  document.querySelectorAll('.ca-sidebar-sport-tab').forEach(b => {
    b.classList.toggle('active', b.textContent === sport);
  });
  _renderSidebarGames(sport);
}

// ── Headline source badge helpers ─────────────────────────────────────────────
const _HL_COLORS = [
  { bg: 'rgba(99,102,241,0.12)',  color: '#818cf8', border: 'rgba(99,102,241,0.25)'  }, // indigo
  { bg: 'rgba(20,184,166,0.12)',  color: '#2dd4bf', border: 'rgba(20,184,166,0.25)'  }, // teal
  { bg: 'rgba(245,158,11,0.12)',  color: '#fbbf24', border: 'rgba(245,158,11,0.25)'  }, // amber
  { bg: 'rgba(236,72,153,0.12)',  color: '#f472b6', border: 'rgba(236,72,153,0.25)'  }, // pink
  { bg: 'rgba(34,197,94,0.12)',   color: '#4ade80', border: 'rgba(34,197,94,0.25)'   }, // green
  { bg: 'rgba(168,85,247,0.12)',  color: '#c084fc', border: 'rgba(168,85,247,0.25)'  }, // purple
  { bg: 'rgba(14,165,233,0.12)',  color: '#38bdf8', border: 'rgba(14,165,233,0.25)'  }, // sky
  { bg: 'rgba(251,113,133,0.12)', color: '#fb7185', border: 'rgba(251,113,133,0.25)' }, // rose
];

function _sourceShort(name) {
  return name
    .replace(/\.com$|\.net$|\.org$|\.co$/i, '') // strip TLD
    .replace(/\s+Sports$/i, '')                  // "Fox Sports" → "Fox"
    .replace(/\s+News$/i, '')                    // "CBS News" → "CBS" (but keep ESPN)
    .trim() || name;
}

function _sourceBadgeStyle(name) {
  if (name === 'Reddit') return 'background:rgba(255,69,0,0.12);color:#ff4500;border:1px solid rgba(255,69,0,0.25);';
  if (name === 'ESPN')   return 'background:rgba(239,68,68,0.12);color:#f87171;border:1px solid rgba(239,68,68,0.25);';
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
  const c = _HL_COLORS[hash % _HL_COLORS.length];
  return `background:${c.bg};color:${c.color};border:1px solid ${c.border};`;
}

// ── Headlines ─────────────────────────────────────────────────────────────────
export async function loadHeadlines() {
  const el = document.getElementById('ca-headlines-list');
  if (!el) return;

  el.innerHTML = `<div style="padding:16px;color:var(--muted);font-size:13px;">Loading headlines...</div>`;
  try {
    const res = await fetch('/api/headlines');
    if (!res.ok) throw new Error('fetch failed');
    const items = await res.json();
    if (!items || items.length === 0) {
      el.innerHTML = `<div style="padding:16px;color:var(--muted);font-size:13px;">No headlines available.</div>`;
      return;
    }
    el.innerHTML = items.map(h => {
      const label = _sourceShort(h.source);
      const style = _sourceBadgeStyle(h.source);
      return `<a class="ca-headline-row" href="${h.url}" target="_blank" rel="noopener noreferrer">
        <span class="ca-headline-source-badge" style="${style}">${label}</span>
        <span class="ca-headline-title">${h.title}</span>
      </a>`;
    }).join('');
  } catch (_) {
    el.innerHTML = `<div style="padding:16px;color:var(--muted);font-size:13px;">Headlines unavailable.</div>`;
  }
}

window.setSidebarSport = setSidebarSport;
