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
  NHL:   { grad: 'linear-gradient(135deg,#0c1445 0%,#1e3a8a 50%,#2563eb 100%)',             fa: 'fa-solid fa-hockey-puck' },
  NFL:   { grad: 'linear-gradient(135deg,#14532d 0%,#166534 40%,#15803d 100%)',             fa: 'fa-solid fa-football' },
  CBB:   { grad: 'linear-gradient(135deg,#4c1d95 0%,#6d28d9 50%,#a78bfa 100%)',             fa: 'fa-solid fa-basketball' },
  NCAAF: { grad: 'linear-gradient(135deg,#78350f 0%,#b45309 50%,#fb923c 100%)',             fa: 'fa-solid fa-football' },
  WCBB:  { grad: 'linear-gradient(135deg,#701a75 0%,#a21caf 50%,#e879f9 100%)',             fa: 'fa-solid fa-basketball' },
  ATP:   { grad: 'linear-gradient(135deg,#3d6e00 0%,#72b300 45%,#bedd1a 100%)', label: 'Tennis', svg: TENNIS_RACKET_SVG },
  WTA:   { grad: 'linear-gradient(135deg,#3d6e00 0%,#72b300 45%,#bedd1a 100%)', label: 'Tennis', svg: TENNIS_RACKET_SVG },
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
  if (score >= mvp_threshold) return `<span class="badge-mvp">MVP</span>`;
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

  if (type === 'nrfi') return `${nick} NRFI`;
  if (type === 'over' || type === 'under') {
    const total = spread != null ? Math.abs(parseFloat(spread)) : null;
    const label = type === 'over' ? 'Over' : 'Under';
    return total ? `${label} ${total}` : label;
  }
  const spreadFmt = spread != null ? (spread > 0 ? `+${spread}` : `${spread}`) : null;
  if (type === 'ml') return nick ? `${nick} Win` : 'Win';
  if (type === 'spread') return nick ? `${nick} ${spreadFmt ?? 'Spread'}` : (spreadFmt ?? 'Spread');
  if (nick) return spreadFmt ? `${nick} ${spreadFmt}` : nick;
  return (spreadFmt ? `${p.pick_type} ${spreadFmt}` : p.pick_type) || '—';
}

export function PICK_HEAT_COLOR(score) {
  if (!score || score === 0) return { color: '#4a5568', fire: false };
  if (score < 50)  return { color: '#ca8a04', fire: false };
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
