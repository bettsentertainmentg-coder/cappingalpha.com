// modules/utils.js — Pure helpers and constants (no DOM state deps)

export const LOCK_SVG = `<svg width="11" height="13" viewBox="0 0 11 13" fill="none" style="vertical-align:middle;display:inline-block;"><rect x="1" y="5.5" width="9" height="7" rx="1.5" fill="#64748b"/><path d="M2.5 5.5V3.5a3 3 0 0 1 6 0v2" stroke="#64748b" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>`;

// Tennis racket SVG — frame + string grid + throat + handle, all in currentColor.
// 15x15 viewBox so it matches the visual footprint of Font Awesome sport icons (which render at font-size: 15px).
const TENNIS_RACKET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15" fill="none" class="sport-badge-icon" style="vertical-align:middle;display:inline-block;flex-shrink:0;">
  <ellipse cx="7.5" cy="6.2" rx="5.8" ry="5.8" stroke="currentColor" stroke-width="1.3" fill="none"/>
  <line x1="2.3" y1="3.7" x2="12.7" y2="3.7" stroke="currentColor" stroke-width="0.55" stroke-linecap="round"/>
  <line x1="1.8" y1="6.2" x2="13.2" y2="6.2" stroke="currentColor" stroke-width="0.55" stroke-linecap="round"/>
  <line x1="2.3" y1="8.7" x2="12.7" y2="8.7" stroke="currentColor" stroke-width="0.55" stroke-linecap="round"/>
  <line x1="4.7" y1="0.9" x2="4.7" y2="11.5" stroke="currentColor" stroke-width="0.55" stroke-linecap="round"/>
  <line x1="7.5" y1="0.5" x2="7.5" y2="11.9" stroke="currentColor" stroke-width="0.55" stroke-linecap="round"/>
  <line x1="10.3" y1="0.9" x2="10.3" y2="11.5" stroke="currentColor" stroke-width="0.55" stroke-linecap="round"/>
  <path d="M5.8 11.7 L6.3 12.4 L7.5 12.7 L8.7 12.4 L9.2 11.7" stroke="currentColor" stroke-width="1" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
  <rect x="6.6" y="12.7" width="1.8" height="2.1" rx="0.5" fill="currentColor"/>
</svg>`;

export const SPORT_THEMES = {
  MLB:   { grad: 'linear-gradient(115deg,#15803d 0%,#16a34a 40%,#ea580c 60%,#92400e 100%)', fa: 'fa-solid fa-baseball' },
  NBA:   { grad: 'linear-gradient(160deg,#92622a 0%,#c8873a 45%,#92622a 100%)',             fa: 'fa-solid fa-basketball' },
  WNBA:  { grad: 'linear-gradient(135deg,#c2410c 0%,#ea580c 45%,#fb923c 100%)',             fa: 'fa-solid fa-basketball' },
  NHL:   { grad: 'linear-gradient(135deg,#0c1445 0%,#1e3a8a 50%,#2563eb 100%)',             fa: 'fa-solid fa-hockey-puck' },
  NFL:   { grad: 'linear-gradient(135deg,#14532d 0%,#166534 40%,#15803d 100%)',             fa: 'fa-solid fa-football' },
  CBB:   { grad: 'linear-gradient(135deg,#4c1d95 0%,#6d28d9 50%,#a78bfa 100%)',             fa: 'fa-solid fa-basketball' },
  NCAAF: { grad: 'linear-gradient(135deg,#78350f 0%,#b45309 50%,#fb923c 100%)',             fa: 'fa-solid fa-football' },
  WCBB:  { grad: 'linear-gradient(135deg,#701a75 0%,#a21caf 50%,#e879f9 100%)',             fa: 'fa-solid fa-basketball' },
  ATP:   { grad: 'linear-gradient(135deg,#3d6e00 0%,#72b300 45%,#bedd1a 100%)', label: 'Tennis', svg: TENNIS_RACKET_SVG },
  WTA:   { grad: 'linear-gradient(135deg,#3d6e00 0%,#72b300 45%,#bedd1a 100%)', label: 'Tennis', svg: TENNIS_RACKET_SVG },
  Soccer:{ grad: 'linear-gradient(135deg,#064e3b 0%,#059669 50%,#34d399 100%)',             fa: 'fa-solid fa-futbol' },
  // Esports titles — keys match the labels produced by esports_markets.js normGame()
  'CS2':           { grad: 'linear-gradient(135deg,#1c1c1c 0%,#2d2d2d 40%,#f5a623 100%)', fa: 'fa-solid fa-bomb' },
  'LoL':           { grad: 'linear-gradient(135deg,#0a1628 0%,#091428 50%,#c8aa6e 100%)', fa: 'fa-solid fa-shield-halved' },
  'Valorant':      { grad: 'linear-gradient(135deg,#1a0a0a 0%,#3d0b0b 50%,#ff4655 100%)', fa: 'fa-solid fa-gun' },
  'Dota 2':        { grad: 'linear-gradient(135deg,#0d0d0d 0%,#1a1a1a 50%,#c23c2a 100%)', fa: 'fa-solid fa-dragon' },
  'Call of Duty':  { grad: 'linear-gradient(135deg,#0d1117 0%,#1c2431 50%,#4a5568 100%)', fa: 'fa-solid fa-skull' },
  'R6':            { grad: 'linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%)', fa: 'fa-solid fa-crosshairs' },
  'Overwatch':     { grad: 'linear-gradient(135deg,#0a1f3d 0%,#0d2951 50%,#f99e1a 100%)', fa: 'fa-solid fa-user-astronaut' },
  'Rocket League': { grad: 'linear-gradient(135deg,#0a1628 0%,#1a3d6e 50%,#5b9bd5 100%)', fa: 'fa-solid fa-car' },
  'Apex':          { grad: 'linear-gradient(135deg,#0d1117 0%,#1a1a2e 50%,#cd4400 100%)', fa: 'fa-solid fa-fire' },
  'PUBG':          { grad: 'linear-gradient(135deg,#0a1628 0%,#1c3a5e 50%,#f5c518 100%)', fa: 'fa-solid fa-circle-dot' },
  'Esports':       { grad: 'linear-gradient(135deg,#6d28d9,#7c3aed,#4f46e5)',              fa: 'fa-solid fa-gamepad' },
};

export function sportBadge(sport) {
  const theme = SPORT_THEMES[sport];
  if (!theme) return `<span class="sport-badge-card sport-badge-card--default">${sport || '—'}</span>`;
  const label    = theme.label || sport;
  const iconHtml = theme.svg
    ? theme.svg
    : `<i class="${theme.fa} sport-badge-icon"></i>`;
  return `<span class="sport-badge-card" style="background:${theme.grad}">
    ${iconHtml}
    <span class="sport-badge-label">${label}</span>
  </span>`;
}

export function ratingCell(score, mvp_threshold = 50) {
  if (score >= mvp_threshold) return `<span class="badge-mvp">CA</span>`;
  return `<span class="score-num">${score ?? '—'}</span>`;
}

export function gameTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function scoreDisplay(p) {
  const status = p.game_status;
  const away   = p.game_away_score ?? 0;
  const home   = p.game_home_score ?? 0;
  const result = p.result;

  if (status === 'post') {
    if (result === 'win')
      return `<span style="font-size:0.88em;font-weight:600;color:#4ade80;margin-left:8px;">${away}-${home} Final</span>`;
    if (result === 'loss')
      return `<span style="font-size:0.88em;font-weight:700;color:#f87171;margin-left:8px;">${away}-${home} Final</span>`;
    return `<span style="font-size:0.88em;font-weight:600;color:#8892a4;margin-left:8px;">${away}-${home} Final</span>`;
  }

  if (status === 'in') {
    const sport = (p.sport || '').toUpperCase();
    const clock  = (p.game_clock && sport !== 'MLB') ? ` · ${p.game_clock}` : '';
    const periodLabel = (n) => {
      if (sport === 'MLB') return ` ${n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`} Inn`;
      if (sport === 'NHL' || sport === 'CBB' || sport === 'WCBB') return ` P${n}`;
      if (sport === 'NFL' || sport === 'NCAAF') return ` Q${n}`;
      return ` Q${n}`;
    };
    const period = p.game_period ? periodLabel(p.game_period) : '';
    return `<span style="font-size:0.88em;font-weight:600;color:#38bdf8;margin-left:8px;display:inline-flex;align-items:center;gap:4px;">
      <span style="width:7px;height:7px;border-radius:50%;background:linear-gradient(135deg,#4ade80,#38bdf8);display:inline-block;animation:pulse 1s infinite;flex-shrink:0;"></span>${away}-${home}${period}${clock}
    </span>`;
  }

  return `<span style="font-size:0.75em;color:#8892a4;margin-left:8px;">${gameTime(p.start_time)}</span>`;
}

export function matchupLabel(p) {
  if (p.away_team && p.home_team) return `${p.away_team} @ ${p.home_team}`;
  return p.team || '—';
}

const TWO_WORD_CITIES = new Set([
  'san diego','san francisco','san antonio','san jose','los angeles',
  'new york','new orleans','new england','oklahoma city','kansas city',
  'golden state','las vegas','tampa bay','green bay','salt lake',
  'fort worth','st louis','st. louis',
]);

export function teamNickname(name) {
  if (!name) return '';
  const words = name.trim().split(' ');
  if (words.length <= 1) return name;
  const twoWordCity = (words[0] + ' ' + words[1]).toLowerCase();
  if (TWO_WORD_CITIES.has(twoWordCity) && words.length > 2) return words.slice(2).join(' ');
  return words.slice(1).join(' ');
}

export function pickLabel(p) {
  const type   = (p.pick_type || '').toLowerCase();
  const spread = p.spread != null ? p.spread : null;
  const nick   = teamNickname(p.team);
  const isTennis = ['ATP', 'WTA'].includes((p.sport || '').toUpperCase());
  // Tennis lines need a unit. Totals + game spreads are games; set_spread is sets.
  const totalUnit = isTennis ? ' games' : '';

  if (type === 'nrfi') return `${nick} NRFI`;
  if (type === 'over' || type === 'under') {
    const total = spread != null ? Math.abs(parseFloat(spread)) : null;
    const label = type === 'over' ? 'Over' : 'Under';
    return total ? `${label} ${total}${totalUnit}` : label;
  }
  const spreadFmt = spread != null ? (spread > 0 ? `+${spread}` : `${spread}`) : null;
  if (type === 'ml') return nick ? `${nick} Win` : 'Win';
  if (type === 'set_spread') {
    const lbl = spreadFmt != null ? `${spreadFmt} sets` : 'Set Spread';
    return nick ? `${nick} ${lbl}` : lbl;
  }
  if (type === 'spread') {
    const unit = isTennis ? ' games' : '';
    const lbl = spreadFmt != null ? `${spreadFmt}${unit}` : 'Spread';
    return nick ? `${nick} ${lbl}` : lbl;
  }
  if (nick) return spreadFmt ? `${nick} ${spreadFmt}` : nick;
  return (spreadFmt ? `${p.pick_type} ${spreadFmt}` : p.pick_type) || '—';
}

export function PICK_HEAT_COLOR(score) {
  if (!score || score === 0) return { color: '#4a5568', fire: false };
  if (score < 35)  return { color: '#ca8a04', fire: false };
  if (score < 50)  return { color: '#C0C0C0', fire: false }; // silver tier
  if (score < 80)  return { color: '#ea580c', fire: false };
  if (score < 95)  return { color: '#dc2626', fire: false };
  return { color: '#dc2626', fire: true };
}

export function fmtOdds(n) {
  if (n == null) return '—';
  return n > 0 ? `+${n}` : String(n);
}

export function fmtSpread(n) {
  if (n == null) return '—';
  return n > 0 ? `+${n}` : String(n);
}

// ── Vote payout math — single source of truth ─────────────────────────────────
// Shared by account.js (P/L graph) and the leaderboard (units/ROI). American odds:
// negative → unit*(100/|odds|), positive → unit*(odds/100). Loss = -unit; push /
// pending / unresolved = 0. Spreads default to -115 (no spread juice is stored).
export function voteOdds(v) {
  const slot = v.pick_slot;
  if (slot === 'home_ml') return v.ml_home || null;
  if (slot === 'away_ml') return v.ml_away || null;
  if (slot === 'over')    return v.ou_over_odds  || -115;
  if (slot === 'under')   return v.ou_under_odds || -115;
  return -115;
}

export function calcVoteReturn(v, unit) {
  const r = (v.result || '').toLowerCase();
  if (r === 'push' || r === 'pending' || !r) return 0;
  if (r === 'loss') return -unit;
  const odds = voteOdds(v) || -115;
  if (odds < 0) return +(unit * (100 / Math.abs(odds))).toFixed(2);
  return +(unit * (odds / 100)).toFixed(2);
}

// ── Generated avatar ──────────────────────────────────────────────────────────
// Deterministic initials avatar from a username (used when no photo is uploaded).
// Returns an <img>/<div> markup string sized to `size` px.
const AVATAR_COLORS = [
  '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#d97706',
  '#16a34a', '#0891b2', '#0d9488', '#4f46e5', '#9333ea', '#c026d3',
];

function avatarHue(name) {
  const s = String(name || 'user');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function avatarInitials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.replace(/[_-]+/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

// avatarFor(username, size, avatarUrl) → markup. If avatarUrl is set, renders the
// uploaded photo; otherwise a colored initials circle. Always renders something.
export function avatarFor(username, size = 40, avatarUrl = null) {
  const px = `${size}px`;
  if (avatarUrl) {
    return `<img src="${avatarUrl}" alt="" style="width:${px};height:${px};border-radius:50%;object-fit:cover;flex-shrink:0;background:#1a2030;" />`;
  }
  const bg = avatarHue(username);
  const fs = Math.round(size * 0.42);
  return `<div style="width:${px};height:${px};border-radius:50%;background:${bg};color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:${fs}px;flex-shrink:0;letter-spacing:.01em;">${avatarInitials(username)}</div>`;
}

// ── Live in-game state (condensed per-sport scoreboards) ──────────────────────
// Baseball bases diamond from a bitmask (1 = on first, 2 = on second, 4 = on
// third). Inline SVG: 2B top, 1B right, 3B left. Occupied bases light up gold.
// NOTE: the fill MUST be a literal colour — `fill="var(--green)"` does not resolve
// as an SVG presentation attribute, so runners rendered invisible (the bug where
// "2 on base" never showed).
export function basesDiamond(bases = 0) {
  const fill = b => (bases & b) ? '#facc15' : 'transparent';   // lit gold = runner on
  const s = 4;
  const base = (cx, cy, b) =>
    `<polygon points="${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}" fill="${fill(b)}" stroke="#64748b" stroke-width="1.1"/>`;
  return `<svg class="bb-diamond" width="26" height="18" viewBox="0 0 26 18" aria-hidden="true">${base(13, 5.5, 2)}${base(19.5, 10.5, 1)}${base(6.5, 10.5, 4)}</svg>`;
}

// Outs as two dots (0..2 during live play). Empty between innings (outs == null).
export function outsDots(outs) {
  if (outs == null) return '';
  const dot = on => `<span class="bb-out${on ? ' on' : ''}"></span>`;
  return `<span class="bb-outs" title="${outs} out">${dot(outs >= 1)}${dot(outs >= 2)}</span>`;
}

// Condensed live state for a game/pick object. Baseball → bases diamond + outs +
// half-inning ("Bot 5th"); returns '' for other sports or before any detail has
// synced, so callers fall back to their own period/clock string.
export function liveStateHtml(g) {
  const sport  = (g.sport || '').toUpperCase();
  const detail = g.game_live_detail ?? g.live_detail ?? null;
  if (sport === 'MLB' && detail) {
    const outs  = g.game_live_outs  ?? g.live_outs  ?? null;
    const bases = g.game_live_bases ?? g.live_bases ?? 0;
    return `<span class="bb-state">${basesDiamond(bases)}${outsDots(outs)}<span class="bb-half">${detail}</span></span>`;
  }
  return '';
}
