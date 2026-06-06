// game-detail.js — Client-side module for the standalone game detail page.
// Reads window.__GAME_DATA__ and renders all dynamic content.
// Companion to src/detail_page.js + public/game-detail.css

import { checkAuth, updateNavAuth, isPaying, isViewer,
         openLogin, closeLogin, doLogin, openSignup, closeSignup, doSignup,
         doLogout, showForgotPassword, showLoginForm, doForgotPassword } from '/modules/auth.js';
import { state } from '/modules/state.js';
import { fmtOdds, fmtSpread, PICK_HEAT_COLOR } from '/modules/utils.js';
import { cappingGauge } from '/modules/gauge.js';
import { drawPickTimeline, drawLockedTeaser, destroyPickTimeline } from '/modules/score_timeline.js';

function formatActualStart(actualIso, scheduledIso) {
  if (!actualIso) return '';
  const iso = actualIso.includes('T') ? actualIso : actualIso.replace(' ', 'T') + 'Z';
  const actual    = new Date(iso);
  const scheduled = scheduledIso ? new Date(scheduledIso) : null;
  if (Number.isNaN(actual.getTime())) return '';
  if (scheduled && !Number.isNaN(scheduled.getTime())) {
    if (Math.abs(actual - scheduled) < 60_000) return '';
  }
  const t = actual.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Started ${t} ET`;
}

// Build the bottom-right start-time label shown under the chart. Visible to
// everyone (paid or free), since the start time has no paywall implication.
//   Pre-game:  "Starts 7:00pm ET"
//   In/post:   "Started 7:12pm ET"   (with "(sched 7:00pm)" if delayed >1min)
function formatStartLabel(actualIso, scheduledIso) {
  const fmt = d => d.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit',
  });
  const scheduled = scheduledIso ? new Date(scheduledIso) : null;
  const schedOk = scheduled && !Number.isNaN(scheduled.getTime());
  if (actualIso) {
    const iso = actualIso.includes('T') ? actualIso : actualIso.replace(' ', 'T') + 'Z';
    const actual = new Date(iso);
    if (!Number.isNaN(actual.getTime())) {
      let out = `Started ${fmt(actual)} ET`;
      if (schedOk && Math.abs(actual - scheduled) > 60_000) {
        out += ` <span class="ca-dp-timeline-sched">(sched ${fmt(scheduled)})</span>`;
      }
      return out;
    }
  }
  if (schedOk) return `Starts ${fmt(scheduled)} ET`;
  return '';
}

// Expose auth functions to window (needed by inline onclick handlers in HTML)
Object.assign(window, {
  openLogin, closeLogin, doLogin, openSignup, closeSignup, doSignup,
  doLogout, showForgotPassword, showLoginForm, doForgotPassword,
  setLinesType, selectSlot, doBack,
  selectHistoryTeam, openHistGame, closeHistGame,
});

// ── Constants ─────────────────────────────────────────────────────────────────
const VALID_SLOTS = ['home_ml', 'away_ml', 'home_spread', 'away_spread', 'over', 'under'];
const MVP_THRESHOLD = 50;
const FALLBACK_COLORS = { primary: '#3b82f6', secondary: '#0d1117' };

// Opposite bet side for for/against vote UI
const OPP_SLOT = {
  home_ml: 'away_ml', away_ml: 'home_ml',
  home_spread: 'away_spread', away_spread: 'home_spread',
  over: 'under', under: 'over',
};

// ── State ─────────────────────────────────────────────────────────────────────
let _data        = null;
let _activeSlot  = null;
let _teamColors  = null;
let _linesType   = 'spread';
let _countdownId = null;
let _historyTeam  = 'away';   // 'away' | 'home' — local History toggle
const _historyCache = {};     // `${sport}:${teamId}` → team-history payload
const _playersCache = {};     // `${sport}:${teamId}:${eventId}` → game-players payload

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  _data = window.__GAME_DATA__;
  if (!_data || !_data.game) {
    document.querySelector('.ca-section')?.insertAdjacentHTML('beforebegin',
      '<div style="padding:48px;text-align:center;color:#8892a4;">Game data unavailable.</div>');
    return;
  }

  // Load team colors
  try {
    const r = await fetch('/team_colors.json');
    _teamColors = await r.json();
  } catch (_) { _teamColors = {}; }

  // Auth state. Seed from the server-rendered session first so a logged-in /
  // subscribed user is recognized on first paint (no flash of Login/Get Access,
  // no bogus "upgrade to see picks" prompts), then reconcile against /auth/me.
  if (_data.user) { state.currentUser = _data.user; updateNavAuth(); }
  await checkAuth();

  // Determine initial slot from ?slot= query param, else top-scored
  _activeSlot = resolveInitialSlot();

  // Open the Lines tab on the bet type that has data (matches the active slot).
  // Tennis has no point spread — only ML + O/U games — so the old 'spread'
  // default left tennis showing an empty table (and hid the Polymarket row).
  _linesType = linesTypeForSlot(_activeSlot);
  const _initSport = (_data.game.sport || '').toUpperCase();
  if (_initSport === 'ATP' || _initSport === 'WTA') {
    if (_linesType === 'spread') _linesType = 'ml';
    document.querySelectorAll('.ca-lt-btn[data-type="spread"]').forEach(b => { b.style.display = 'none'; });
  }
  document.querySelectorAll('.ca-lt-btn').forEach(b => b.classList.toggle('active', b.dataset.type === _linesType));

  // Render all dynamic sections
  renderStatusPill();
  renderTeamLogoColors();
  renderTeamMeta();
  renderSlotGrid();
  renderDetailPanel();
  renderLines();
  renderSentiment();
  renderInjuries();
  renderContext();
  renderHistory();
  renderCommunity();

  // Close the player drill-down popup on Escape
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeHistGame(); });

  // Update sidebar/mobile-tabs top offset to clear the sticky header
  updateStickyOffset();
  window.addEventListener('resize', updateStickyOffset);

  // Sticky nav scroll-spy
  initScrollSpy();
  // Mobile section-tab bar: expand/brighten once it pins to the top.
  initStickyTabs();

  // Countdown for pre-game
  if (_data.game.status === 'pre') startCountdown();
}

// ── Back navigation ───────────────────────────────────────────────────────────
function doBack() {
  try {
    if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) {
      history.back();
    } else {
      window.location.href = '/';
    }
  } catch (_) {
    window.location.href = '/';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Public betting % for the active slot
function slotPubPct(slotKey, pb) {
  if (!pb) return null;
  const map = {
    home_ml:     pb.home_ml_pct,
    away_ml:     pb.away_ml_pct,
    home_spread: pb.home_spread_pct,
    away_spread: pb.away_spread_pct,
    over:        pb.over_pct,
    under:       pb.under_pct,
  };
  const v = map[slotKey];
  return (v != null && v > 0) ? Math.round(v) : null;
}

// Update CSS variable used by sidebar/mobile-tabs to clear the sticky header
function updateStickyOffset() {
  const el = document.querySelector('.ca-sticky-top');
  if (!el) return;
  document.documentElement.style.setProperty('--sticky-body-h', el.offsetHeight + 'px');
}

function buildSlots(game) {
  const ou = game.over_under;
  // Show the actual recorded spread instead of the word "Spread" (any sport).
  // Falls back to "—" when no line is posted for the slot.
  const fmtSp = (v) => v == null ? '—' : (v > 0 ? `+${v}` : `${v}`);
  return [
    { key: 'away_ml',     label: teamNick(game.away_team) + ' Win',                   type: 'ml',     team: game.away_team },
    { key: 'home_ml',     label: teamNick(game.home_team) + ' Win',                   type: 'ml',     team: game.home_team },
    { key: 'away_spread', label: `${teamNick(game.away_team)} ${fmtSp(game.spread_away)}`, type: 'spread', team: game.away_team },
    { key: 'home_spread', label: `${teamNick(game.home_team)} ${fmtSp(game.spread_home)}`, type: 'spread', team: game.home_team },
    { key: 'over',        label: `Over${ou != null ? ' ' + ou : ''}`,                 type: 'over',   team: null },
    { key: 'under',       label: `Under${ou != null ? ' ' + ou : ''}`,                type: 'under',  team: null },
  ];
}

function buildPickBySlot(picks) {
  const m = {};
  for (const p of picks) {
    const pt = (p.pick_type || '').toLowerCase();
    const isHome = p.is_home_team === 1 || p.is_home_team === true;
    if (pt === 'ml')     m[isHome ? 'home_ml'     : 'away_ml']     = p;
    if (pt === 'spread') m[isHome ? 'home_spread' : 'away_spread'] = p;
    if (pt === 'over')   m['over']  = p;
    if (pt === 'under')  m['under'] = p;
  }
  return m;
}

function teamNick(name) {
  if (!name) return '?';
  const words = name.trim().split(' ');
  if (words.length <= 1) return name;
  const twoWord = (words[0] + ' ' + words[1]).toLowerCase();
  const TWO_WORD = new Set(['san diego','san francisco','san antonio','san jose','los angeles',
    'new york','new orleans','new england','oklahoma city','kansas city','golden state',
    'las vegas','tampa bay','green bay','salt lake','fort worth','st louis','st. louis']);
  if (TWO_WORD.has(twoWord) && words.length > 2) return words.slice(2).join(' ');
  return words.slice(1).join(' ');
}

function resolveInitialSlot() {
  const picks = _data.picks || [];
  const pickBySlot = buildPickBySlot(picks);

  // ?slot= query param
  const params = new URLSearchParams(location.search);
  const requested = params.get('slot');
  if (requested && VALID_SLOTS.includes(requested)) return requested;

  // Highest-scored slot
  let best = null, bestScore = -1;
  for (const [k, p] of Object.entries(pickBySlot)) {
    if ((p.score || 0) > bestScore) { bestScore = p.score || 0; best = k; }
  }
  return best || 'home_ml';
}

// ── Country flag colors (tennis) ──────────────────────────────────────────────
// Tennis players have no team color, so both sides used to fall back to the same
// blue. Color each player by their country's primary flag color instead, keyed by
// the ESPN 3-letter country code (game.home_country / game.away_country).
const COUNTRY_COLORS = {
  srb:'#C6363C', esp:'#C60B1E', sui:'#D52B1E', usa:'#3C3B6E', gbr:'#012169',
  fra:'#0055A4', ger:'#DD0000', ita:'#0066CC', rus:'#0039A6', gre:'#0D5EAF',
  aut:'#ED2939', arg:'#74ACDF', aus:'#00247D', can:'#D52B1E', chn:'#DE2910',
  jpn:'#BC002D', cro:'#FF0000', pol:'#DC143C', nor:'#BA0C2F', den:'#C8102E',
  bul:'#00966E', bel:'#FDDA24', ned:'#FF6200', kaz:'#00AFCA', cze:'#11457E',
  hun:'#CD2A3E', fin:'#003580', swe:'#006AA7', bra:'#009C3B', chi:'#D52B1E',
  rsa:'#007A4D', tun:'#E70013', ukr:'#0057B7', rou:'#002B7F', slo:'#005DA4',
  svk:'#0B4EA2', lat:'#9E3039', est:'#4891D9', ltu:'#FDB913', geo:'#FF0000',
  por:'#006600', mex:'#006847', col:'#FCD116', per:'#D91023', ind:'#FF9933',
  kor:'#003478', tpe:'#000095', tha:'#241D4F', mda:'#0072CE', mon:'#CE1126',
  bih:'#002395', blr:'#CE1720', moz:'#007168', egy:'#C8102E', isr:'#0038B8',
  lux:'#00A1DE', cyp:'#D57800', new:'#00247D', nzl:'#00247D',
};

function _hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
}
function _rgbToHex(r,g,b) {
  const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2,'0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
// Blend a color toward white by amt (0..1).
function _lighten(hex, amt) {
  const { r,g,b } = _hexToRgb(hex);
  return _rgbToHex(r + (255-r)*amt, g + (255-g)*amt, b + (255-b)*amt);
}
// Euclidean distance in RGB — small = visually similar.
function _colorDist(a, b) {
  const x = _hexToRgb(a), y = _hexToRgb(b);
  return Math.sqrt((x.r-y.r)**2 + (x.g-y.g)**2 + (x.b-y.b)**2);
}
// Blend two hex colors by t (0 = a, 1 = b). t=0.5 → even mix.
function _mixHex(a, b, t = 0.5) {
  const x = _hexToRgb(a), y = _hexToRgb(b);
  return _rgbToHex(x.r + (y.r-x.r)*t, x.g + (y.g-x.g)*t, x.b + (y.b-x.b)*t);
}
// Perceived brightness 0..1.
function _luminance(hex) {
  const { r, g, b } = _hexToRgb(hex);
  return (0.2126*r + 0.7152*g + 0.0722*b) / 255;
}
// Colorfulness (chroma) — high for vivid reds/golds, ~0 for black/white/gray.
function _chroma(hex) {
  const { r, g, b } = _hexToRgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
}
function _rgba(hex, a) {
  const { r, g, b } = _hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
// The team's most vivid color (the one worth glowing): pick the more colorful of
// primary/secondary so we glow Knights gold + Hurricanes red, not their blacks.
// Lift it if it's too dark to register as a glow.
function _vividColor(c) {
  const p = c.primary, s = c.secondary || c.primary;
  let pick = _chroma(s) > _chroma(p) ? s : p;
  if (_luminance(pick) < 0.22) pick = _lighten(pick, 0.28);
  return pick;
}
function _teamGlow(c) {
  const col = _vividColor(c);
  return `0 0 26px 4px ${_rgba(col, 0.55)}, 0 0 9px 1px ${_rgba(col, 0.8)}`;
}
// Make the gauge's two sides easy to tell apart. Two failure modes:
//   1) a primary is so dark (e.g. Spurs black) it vanishes on the dark card, so
//      the disc looks like one color — mix that side 50/50 with its secondary.
//   2) the two primaries are near-identical (e.g. both blue) — mix each 50/50
//      with its secondary, then lighten the home side as a last resort.
function distinctColors(away, home) {
  const lift = (c) => (c.secondary && _luminance(c.primary) < 0.16)
    ? { ...c, primary: _mixHex(c.primary, c.secondary, 0.5) }
    : { ...c };
  const a = lift(away), h = lift(home);
  if (_colorDist(a.primary, h.primary) < 110) {
    if (away.secondary) a.primary = _mixHex(a.primary, away.secondary, 0.5);
    if (home.secondary) h.primary = _mixHex(h.primary, home.secondary, 0.5);
    if (_colorDist(a.primary, h.primary) < 80) h.primary = _lighten(h.primary, 0.4);
  }
  return { away: a, home: h };
}
// Deterministic distinct color (hex) for an unmapped country code, from a palette.
const _FALLBACK_PALETTE = ['#2563EB','#DC2626','#16A34A','#D97706','#7C3AED','#0891B2','#DB2777','#65A30D'];
function _countryFallbackColor(code) {
  if (!code) return FALLBACK_COLORS.primary;
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
  return _FALLBACK_PALETTE[h % _FALLBACK_PALETTE.length];
}
function _countryColor(code) {
  if (!code) return null;
  return COUNTRY_COLORS[code] || _countryFallbackColor(code);
}

// Tennis: resolve both players' country colors, lightening the home side when the
// two are too similar (e.g. two red countries) so the gauges always read as two
// distinct sides.
function tennisColors(game) {
  const awayC = _countryColor(game.away_country);
  const homeC = _countryColor(game.home_country);
  if (!awayC && !homeC) return null;
  let away = awayC || FALLBACK_COLORS.primary;
  let home = homeC || FALLBACK_COLORS.primary;
  if (_colorDist(away, home) < 110) home = _lighten(home, 0.45);
  return {
    away: { primary: away, secondary: '' },
    home: { primary: home, secondary: '' },
  };
}

// ESPN sometimes uses 2-letter abbreviations that differ from the color map's
// standard 3-letter keys (e.g. NBA "SA" → "SAS", "NY" → "NYK"). Without this the
// team falls back to the default blue, which is why glows/gauges read blue.
const ABBR_ALIAS = {
  NBA: { NY: 'NYK', SA: 'SAS', GS: 'GSW', NO: 'NOP', UTAH: 'UTA' },
};

function teamColors(game, isHome) {
  const sport = (game.sport || '').toUpperCase();
  if (sport === 'ATP' || sport === 'WTA') {
    const tc = tennisColors(game);
    if (tc) return isHome ? tc.home : tc.away;
  }
  if (!_teamColors) return FALLBACK_COLORS;
  const abbr   = isHome
    ? (game.home_abbr || game.home_short || '').toUpperCase()
    : (game.away_abbr || game.away_short || '').toUpperCase();
  const bucket = _teamColors[sport] || {};
  const alias  = (ABBR_ALIAS[sport] || {})[abbr] || abbr;
  return bucket[abbr] || bucket[alias] || FALLBACK_COLORS;
}

function slotLineCurrent(slotKey, game) {
  if (slotKey === 'home_ml')     return game.ml_home     != null ? fmtOdds(game.ml_home)       : null;
  if (slotKey === 'away_ml')     return game.ml_away     != null ? fmtOdds(game.ml_away)       : null;
  if (slotKey === 'home_spread') return game.spread_home != null ? fmtSpread(game.spread_home) : null;
  if (slotKey === 'away_spread') return game.spread_away != null ? fmtSpread(game.spread_away) : null;
  if (slotKey === 'over')        return game.over_under  != null ? String(game.over_under)     : null;
  if (slotKey === 'under')       return game.over_under  != null ? String(game.over_under)     : null;
  return null;
}

// ── Tennis score string: "6-4, 7-5" or "6-4, 3-6, 4-2" (away perspective) ───
function _tennisScoreStr(game, liveInProgress) {
  let sets = [];
  try { sets = JSON.parse(game.tennis_score_detail || '[]'); } catch (_) {}
  if (!sets.length) {
    // Fallback: just show sets won
    return `${game.away_score ?? 0}–${game.home_score ?? 0}`;
  }
  // Build "away-home" per set (away listed first to match scoreboard convention)
  return sets.map((s, i) => {
    const isLastSet = i === sets.length - 1;
    const suffix = (liveInProgress && isLastSet) ? '*' : '';
    return `${s.away}-${s.home}${suffix}`;
  }).join(', ');
}

// ── Status pill ───────────────────────────────────────────────────────────────
function renderStatusPill() {
  const pill = document.getElementById('ca-status-pill');
  if (!pill) return;
  const { game } = _data;
  const s = game.status;

  if (s === 'post') {
    pill.className = 'ca-gh-status-pill ca-status-final';
    const sport = (game.sport || '').toUpperCase();
    if (sport === 'ATP' || sport === 'WTA') {
      const scoreStr = _tennisScoreStr(game, false);
      pill.innerHTML = `<span class="ca-num">${scoreStr}</span> Final`;
    } else {
      pill.innerHTML = `<span class="ca-num">${game.away_score ?? 0}–${game.home_score ?? 0}</span> Final`;
    }
  } else if (s === 'in') {
    const sport = (game.sport || '').toUpperCase();
    if (sport === 'ATP' || sport === 'WTA') {
      const scoreStr = _tennisScoreStr(game, true);
      const setLabel = game.period ? `Set ${game.period}` : 'LIVE';
      pill.className = 'ca-gh-status-pill ca-status-live';
      pill.innerHTML = `<span class="ca-num">${scoreStr}</span> · ${setLabel}`;
    } else {
      const period = game.period;
      const clock  = game.clock && sport !== 'MLB' ? ` · ${game.clock}` : '';
      let periodLabel = period ? `P${period}` : 'LIVE';
      if (sport === 'NFL' || sport === 'NCAAF') periodLabel = period ? `Q${period}` : 'LIVE';
      if (sport === 'MLB') periodLabel = period ? `Inn ${period}` : 'LIVE';
      pill.className = 'ca-gh-status-pill ca-status-live';
      pill.innerHTML = `<span class="ca-num">${game.away_score ?? 0}–${game.home_score ?? 0}</span> · ${periodLabel}${clock}`;
    }
  } else {
    pill.className = 'ca-gh-status-pill ca-status-pre';
    const t = new Date(game.start_time);
    const timeStr = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    pill.textContent = `${timeStr} ET`;
  }
}

// ── Team logo circles (fill with team primary color) ─────────────────────────
function renderTeamLogoColors() {
  const { game } = _data;
  const awayC = teamColors(game, false);
  const homeC = teamColors(game, true);
  const awayEl = document.getElementById('ca-logo-away');
  const homeEl = document.getElementById('ca-logo-home');
  // Fill with the team primary + a personalized glow in the team's vivid color.
  if (awayEl) { awayEl.style.background = awayC.primary; awayEl.style.boxShadow = _teamGlow(awayC); }
  if (homeEl) { homeEl.style.background = homeC.primary; homeEl.style.boxShadow = _teamGlow(homeC); }
}

// ── Team meta: season record + last-5 form in the game header ─────────────────
function renderTeamMeta() {
  const { stats } = _data;
  const awayEl = document.getElementById('ca-meta-away');
  const homeEl = document.getElementById('ca-meta-home');

  const fmtForm = form => {
    if (!form || !form.length) return null;
    return form.map(r =>
      `<span style="color:${r === 'W' ? '#22c55e' : '#ef4444'};font-weight:700;">${r}</span>`
    ).join('');
  };

  const buildMeta = (record, form) => {
    const parts = [];
    if (record) parts.push(`<span>${esc(record)}</span>`);
    const formHtml = fmtForm(form);
    if (formHtml) parts.push(formHtml);
    return parts.length ? parts.join(' &nbsp;·&nbsp; ') : '—';
  };

  if (awayEl) awayEl.innerHTML = buildMeta(stats?.awayRecord, stats?.awayForm);
  if (homeEl) homeEl.innerHTML = buildMeta(stats?.homeRecord, stats?.homeForm);
}

// ── Slot chip grid ────────────────────────────────────────────────────────────
function renderSlotGrid() {
  const el = document.getElementById('ca-slot-grid');
  if (!el) return;
  const { game, picks, pickRanks } = _data;
  const SLOTS      = buildSlots(game);
  const pickBySlot = buildPickBySlot(picks || []);
  const total      = SLOTS.length; // always 6

  // Sort slots: picks with scores highest→lowest left→right; no-pick slots at end
  const sortedSlots = [...SLOTS].sort((a, b) => {
    const sA = pickBySlot[a.key]?.score || 0;
    const sB = pickBySlot[b.key]?.score || 0;
    return sB - sA;
  });

  const countEl = document.getElementById('ca-picks-count');
  if (countEl) countEl.textContent = 'Click any pick to see details';

  // Find the rank-1 slot key (used for paywall logic below)
  const rank1SlotKey = (() => {
    for (const [key, p] of Object.entries(pickBySlot)) {
      if (pickRanks && p?.id && pickRanks[p.id] === 1) return key;
    }
    return null;
  })();

  el.innerHTML = sortedSlots.map(slot => {
    const p     = pickBySlot[slot.key];
    const score = p?.score || 0;
    const isMvp = score >= MVP_THRESHOLD;
    const isActive = slot.key === _activeSlot;
    const noPick = !p || score === 0;

    const rank = (pickRanks && p?.id) ? (pickRanks[p.id] || 0) : 0;
    // Lock everything except the #1 pick for non-paying users (includes unpicked pairs)
    const isLocked = !isPaying() && slot.key !== rank1SlotKey;

    // Compact pill, mirroring the game popup ticker: "{team} {bet}" + inline score.
    // slot.label already reads e.g. "Hurricanes Win" / "Under 5.5".
    let scoreHtml;
    if (isLocked) {
      // Identical lock UI regardless of whether there's a pick underneath, so
      // free users can't infer which slots have picks from chip styling.
      scoreHtml = `<span class="ca-slot-pill-score ca-slot-pill-locked"><i class="fa-solid fa-lock"></i></span>`;
    } else if (noPick) {
      scoreHtml = `<span class="ca-slot-pill-score ca-slot-pts--none">—</span>`;
    } else {
      const heat = PICK_HEAT_COLOR(score);
      // For top-tier scores, place the fire as a faded glyph *behind* the number
      // so it adds heat without taking horizontal space.
      scoreHtml = `<span class="ca-slot-pill-score${heat.fire ? ' ca-slot-fire' : ''}" style="color:${heat.color};"><span class="ca-slot-pts-num">${score}</span></span>`;
    }

    // MVP status is premium info — never reveal it on a locked chip. Shown as a
    // subtle gold tint via the .mvp class (matches the popup, which has no pip).
    const showMvp = isMvp && !isLocked;
    return `<div class="ca-slot-chip${isActive ? ' active' : ''}${showMvp ? ' mvp' : ''}${noPick && !isLocked ? ' no-pick' : ''}${isLocked ? ' locked' : ''}"
              onclick="selectSlot('${slot.key}')">
      <span class="ca-slot-pill-label">${slot.label}</span>
      ${scoreHtml}
    </div>`;
  }).join('');

  _applySlotGlow(_activeSlot);
}

// The team color a slot should glow in when selected (over/under have no team).
function _slotGlowColor(slotKey) {
  const { game } = _data;
  if (slotKey === 'home_ml' || slotKey === 'home_spread') return _vividColor(teamColors(game, true));
  if (slotKey === 'away_ml' || slotKey === 'away_spread') return _vividColor(teamColors(game, false));
  return null;
}

// Tint + softly glow the active chip in its team's vivid color (a lighter touch
// than the logo glow). Over/under fall back to the default accent styling.
function _applySlotGlow(activeKey) {
  document.querySelectorAll('.ca-slot-chip').forEach(chip => {
    const onclick  = chip.getAttribute('onclick') || '';
    const isActive = onclick.includes(`'${activeKey}'`);
    const glow = isActive ? _slotGlowColor(activeKey) : null;
    if (isActive && glow) {
      chip.style.borderColor = glow;
      chip.style.background   = _rgba(glow, 0.14);
      chip.style.boxShadow    = `0 0 11px 0 ${_rgba(glow, 0.5)}`;
    } else {
      chip.style.borderColor = '';
      chip.style.background   = '';
      chip.style.boxShadow    = '';
    }
  });
}

// ── Slot switching ────────────────────────────────────────────────────────────
// Map a pick slot key to the matching Lines tab type
function linesTypeForSlot(key) {
  if (key === 'home_ml' || key === 'away_ml') return 'ml';
  if (key === 'over' || key === 'under')      return 'total';
  return 'spread';
}

function selectSlot(key) {
  if (!VALID_SLOTS.includes(key)) return;
  _activeSlot = key;

  // Update chip active state + team-colored glow
  document.querySelectorAll('.ca-slot-chip').forEach(chip => {
    const onclick = chip.getAttribute('onclick') || '';
    chip.classList.toggle('active', onclick.includes(`'${key}'`));
  });
  _applySlotGlow(key);

  // Sync the Lines tab below to the matching bet type
  const desiredLinesType = linesTypeForSlot(key);
  if (desiredLinesType !== _linesType) {
    setLinesType(desiredLinesType);
  }

  renderDetailPanel();
  renderSentiment();
}
window.selectSlot = selectSlot;

// ── Detail panel ─────────────────────────────────────────────────────────────
function renderDetailPanel() {
  const el = document.getElementById('ca-detail-panel');
  if (!el) return;
  const { game, picks, votes, userVote, pickRanks } = _data;
  const SLOTS      = buildSlots(game);
  const pickBySlot = buildPickBySlot(picks || []);
  const slot       = SLOTS.find(s => s.key === _activeSlot);
  const p          = pickBySlot[_activeSlot];

  if (!slot) { el.innerHTML = ''; return; }

  const line = slotLineCurrent(_activeSlot, game);
  const gameStarted = game.status === 'in' || game.status === 'post';
  const gameId      = game.espn_game_id;

  // ── Header ────────────────────────────────────────────────────────────────
  const sideLabel = slot.team ? teamNick(slot.team) : slot.label;
  const isAway    = _activeSlot === 'away_ml' || _activeSlot === 'away_spread';
  const isHome    = _activeSlot === 'home_ml' || _activeSlot === 'home_spread';
  const teamSide  = isAway ? ' · AWAY' : isHome ? ' · HOME' : '';
  const eyebrow   = slot.type.toUpperCase() + teamSide;

  let score = 0, rank = 0, isMvp = false, scoreHidden = false;
  if (p) {
    score = p.score || 0;
    rank  = (pickRanks && p.id) ? (pickRanks[p.id] || 0) : 0;
    isMvp = score >= MVP_THRESHOLD;
    scoreHidden = !isPaying() && rank > 1;
  }

  // Free users see real numbers + MVP/result/rank reveals only for the #1 pick.
  // Everything score-derived is gated behind this so non-#1 picks never leak
  // that they're MVPs (or whether they won) to non-paying users.
  const showRealScore = isPaying() || (p && rank === 1);

  const isGoldMvp   = showRealScore && isMvp && score >= 60;
  const isSilverMvp = showRealScore && isMvp && score < 60;

  // Juice/odds to show inline next to the spread or total line value
  const juice = (() => {
    if (_activeSlot === 'home_spread' || _activeSlot === 'away_spread') {
      return game.spread_home != null ? fmtOdds(-110) : null;
    }
    if (_activeSlot === 'over')  return game.ou_over_odds  != null ? fmtOdds(game.ou_over_odds)  : null;
    if (_activeSlot === 'under') return game.ou_under_odds != null ? fmtOdds(game.ou_under_odds) : null;
    return null; // ML: the line value itself is the odds
  })();

  const resultBadge = showRealScore && p?.result && p.result !== 'pending'
    ? `<div class="ca-dp-result-badge ca-dp-result-${p.result}">${p.result.toUpperCase()}</div>`
    : '';

  const rankBadge = p && rank === 1
    ? `<div class="ca-dp-rank-badge ca-dp-rank-1">#1 Pick</div>`
    : showRealScore && p && rank > 0
      ? `<div class="ca-dp-rank-badge ca-dp-rank-n">#${rank}</div>`
      : '';

  const mvpBadge = isGoldMvp
    ? `<div class="ca-dp-mvp-badge ca-dp-mvp-badge--gold">MVP</div>`
    : isSilverMvp
      ? `<div class="ca-dp-mvp-badge ca-dp-mvp-badge--silver">MVP</div>`
      : '';

  const scoreCls = isGoldMvp ? ' mvp-gold' : isSilverMvp ? ' mvp-silver' : '';
  // Free users see real numbers only for the #1 pick. Everything else (no pick,
  // or ranks 2+) renders the same locked-wrap visual so they can't tell which
  // slots have no pick vs. paywalled picks.
  const scoreEl = showRealScore
    ? (!p
        ? `<div class="ca-dp-score-big ca-num" style="color:var(--text-disabled);opacity:0.55;">0</div>`
        : `<div class="ca-dp-score-big ca-num${scoreCls}">${score}</div>`)
    : `<div class="ca-dp-score-locked-wrap" onclick="openSignup()" title="Full access only">
        <div class="ca-dp-score-big ca-num ca-blurred" aria-hidden="true">88</div>
        <span class="ca-dp-score-lock-mini"><i class="fa-solid fa-lock"></i></span>
      </div>`;

  const hdrMod = isGoldMvp ? ' ca-dp-header--mvp-gold' : isSilverMvp ? ' ca-dp-header--mvp-silver' : '';

  const headerHtml = `<div class="ca-dp-header${hdrMod}">
    <div class="ca-dp-hdr-left">
      <div class="ca-dp-hdr-eyebrow-row">
        ${showRealScore && isMvp ? `<span class="ca-dp-hdr-star">★</span>` : ''}
        <span class="ca-dp-hdr-eyebrow">${esc(eyebrow)}</span>
      </div>
      <div class="ca-dp-hdr-pick-row">
        <span class="ca-dp-hdr-side">${esc(sideLabel)}</span>
        ${line && _activeSlot !== 'over' && _activeSlot !== 'under' ? `<span class="${slot.type === 'ml' ? 'ca-dp-hdr-juice' : 'ca-dp-hdr-line-val'} ca-num">${esc(line)}</span>` : ''}
        ${juice ? `<span class="ca-dp-hdr-juice ca-num">${esc(juice)}</span>` : ''}
      </div>
    </div>
    <div class="ca-dp-hdr-right">
      <div class="ca-dp-hdr-score-label">CappingAlpha Score</div>
      <div class="ca-dp-hdr-score-row">
        ${scoreEl}
        ${mvpBadge}
      </div>
      ${rankBadge}
      ${resultBadge}
    </div>
  </div>`;

  // ── Body: 2-column (conviction curve chart | community vote) ────────────────

  // Col 1: Conviction curve chart. Paywall mirrors score visibility: free users
  // see the real chart only on the #1 pick. For everything else we still render
  // the canvas, but it's blurred behind a lock icon to drive the upgrade.
  const timelineVisible = isPaying() || rank === 1;
  const hasTimeline = !!(p?.timeline && p.timeline.length > 0);
  let pubHtml = `<div class="ca-dp-col-label" style="margin-bottom:8px;">Conviction curve</div>`;
  const wrapMods = [
    hasTimeline ? '' : 'is-empty',
    timelineVisible ? '' : 'is-locked',
  ].filter(Boolean).join(' ');
  const startLabel = formatStartLabel(game?.actual_start_at, game?.start_time);
  pubHtml += `<div class="ca-dp-timeline-wrap${wrapMods ? ' ' + wrapMods : ''}">
    <canvas id="ca-dp-timeline-chart"></canvas>
    ${!timelineVisible ? `
      <div class="ca-dp-timeline-lock-overlay" onclick="openSignup()">
        <i class="fa-solid fa-lock"></i>
        <span>Full access only</span>
      </div>` : ''}
    ${timelineVisible && !hasTimeline ? '<div class="ca-dp-timeline-empty-overlay">Not enough picks yet.</div>' : ''}
  </div>
  <div class="ca-dp-timeline-footer">
    <div class="ca-dp-timeline-teaser">Picks evolve throughout the day. <a href="/#about">Learn how</a></div>
    ${startLabel ? `<div class="ca-dp-timeline-start">${startLabel}</div>` : ''}
  </div>`;

  // Col 3: For/against community vote
  const oppKey       = OPP_SLOT[_activeSlot];
  const SLOTS_FA     = buildSlots(game);
  const thisSlotDef  = SLOTS_FA.find(s => s.key === _activeSlot);
  const oppSlotDef   = SLOTS_FA.find(s => s.key === oppKey);
  const thisLineDisp = slotLineCurrent(_activeSlot, game) || '';
  const oppLineDisp  = oppKey ? (slotLineCurrent(oppKey, game) || '') : '';
  const thisLabel    = thisSlotDef
    ? (thisSlotDef.team ? teamNick(thisSlotDef.team) : thisSlotDef.label.replace(/\s+\d.*/, ''))
    : slot?.label || '';
  const oppLabel     = oppSlotDef
    ? (oppSlotDef.team ? teamNick(oppSlotDef.team) : oppSlotDef.label.replace(/\s+\d.*/, ''))
    : '';
  const thisVotes   = (votes && votes[_activeSlot]) || 0;
  const oppVotes    = (votes && oppKey && votes[oppKey])  || 0;
  const userOnThis  = !!(userVote?.[_activeSlot]);
  const userOnOpp   = !!(userVote?.[oppKey]);

  const mkVcBtn = (slotKey, label, lineVal, voteCount, isActive, disabled) => {
    const cls = `ca-vote-choice${isActive ? ' ca-vote-choice--active' : ''}${disabled ? ' ca-vote-choice--disabled' : ''}`;
    const handler = disabled ? '' : `onclick="handleVoteChoice('${gameId}','${slotKey}')"`;
    return `<div class="${cls}" ${handler}>
      ${isActive ? '<div class="ca-vc-check"><i class="fa-solid fa-check"></i></div>' : ''}
      <div class="ca-vc-label">${esc(label)}</div>
      ${lineVal ? `<div class="ca-vc-line ca-num">${esc(lineVal)}</div>` : ''}
      <div class="ca-vc-votes ca-num">${voteCount} vote${voteCount !== 1 ? 's' : ''}</div>
    </div>`;
  };

  let voteHtml = `<div class="ca-dp-vote-title">Vote your pick</div>`;
  if (isViewer()) {
    voteHtml += `<div class="ca-dp-vote-sub"><a onclick="openSignup()">Make an account</a> to vote on this game.</div>
    <div class="ca-vc-pair">
      ${mkVcBtn(_activeSlot, thisLabel, thisLineDisp, thisVotes, false, true)}
      ${oppKey ? mkVcBtn(oppKey, oppLabel, oppLineDisp, oppVotes, false, true) : ''}
    </div>`;
  } else if (gameStarted) {
    voteHtml += `<div class="ca-dp-vote-sub ca-vote-locked-sub">Voting closed. Game ${game.status === 'post' ? 'ended' : 'started'}.</div>
    <div class="ca-vc-pair">
      ${mkVcBtn(_activeSlot, thisLabel, thisLineDisp, thisVotes, userOnThis, true)}
      ${oppKey ? mkVcBtn(oppKey, oppLabel, oppLineDisp, oppVotes, userOnOpp, true) : ''}
    </div>`;
  } else {
    voteHtml += `<div class="ca-dp-vote-sub">Cast your vote on this game. Voting locks at tip-off.</div>
    <div class="ca-vc-pair">
      ${mkVcBtn(_activeSlot, thisLabel, thisLineDisp, thisVotes, userOnThis, false)}
      ${oppKey ? mkVcBtn(oppKey, oppLabel, oppLineDisp, oppVotes, userOnOpp, false) : ''}
    </div>`;
  }

  destroyPickTimeline();

  el.innerHTML = headerHtml + `<div class="ca-dp-grid">
    <div class="ca-dp-col">${pubHtml}</div>
    <div class="ca-dp-divider"></div>
    <div class="ca-dp-col ca-dp-vote-col">${voteHtml}</div>
  </div>`;

  // Render the chart after innerHTML has settled. Always draw, even when
  // locked or empty, so the chart frame is visible with the overlay. Locked
  // users get a synthetic teaser (no real data on the canvas), not the real
  // curve blurred — that used to be legible through the blur.
  if (typeof Chart !== 'undefined') {
    requestAnimationFrame(() => {
      if (timelineVisible) {
        drawPickTimeline(p?.timeline || [], MVP_THRESHOLD, 'ca-dp-timeline-chart');
      } else {
        const seed = String(gameId || '').split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
        drawLockedTeaser('ca-dp-timeline-chart', MVP_THRESHOLD, seed);
      }
    });
  }

  // Paywall banner
  if (!isPaying() && p && scoreHidden) {
    el.insertAdjacentHTML('beforeend', `
      <div class="ca-dp-unlock-row">
        <span class="ca-dp-unlock-text">Scores beyond #1 are unlocked for members.</span>
        <span class="ca-dp-unlock-link" onclick="openSignup()">Get access, from $1/day</span>
      </div>`);
  }
}

// ── Vote handler ──────────────────────────────────────────────────────────────
// ── For/against vote ──────────────────────────────────────────────────────────
async function handleVoteChoice(gameId, chosenSlot) {
  const hasChosen = !!_data.userVote?.[chosenSlot];

  if (hasChosen) {
    // Toggle off — remove existing vote
    await doVoteRequest(gameId, chosenSlot, true);
  } else {
    // POST — server automatically removes the opposite slot vote and returns
    // fresh votes + userVote, so one call is enough
    await doVoteRequest(gameId, chosenSlot, false);
  }

  renderDetailPanel();
  renderSentiment();
}
window.handleVoteChoice = handleVoteChoice;

async function doVoteRequest(gameId, slot, isRemoving) {
  try {
    const res = await fetch(`/api/game/${gameId}/vote`, {
      method: isRemoving ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot }),   // server expects `slot`, not `pick_slot`
    });
    if (res.status === 409) { window.location.reload(); return; }
    if (!res.ok) { console.warn('[vote]', res.status); return; }

    if (!_data.userVote) _data.userVote = {};
    if (!_data.votes)    _data.votes    = {};

    if (isRemoving) {
      // DELETE returns { ok: true } — update locally
      delete _data.userVote[slot];
      _data.votes[slot] = Math.max(0, (_data.votes[slot] || 1) - 1);
    } else {
      // POST returns authoritative { votes, userVote } — replace entirely
      // (server already removed the opposing slot, so we must overwrite, not merge)
      const data = await res.json().catch(() => null);
      if (data?.votes)    _data.votes    = data.votes;
      if (data?.userVote) _data.userVote = data.userVote;
    }
  } catch (err) {
    console.warn('[vote] network error:', err);
  }
}

// ── Lines section ─────────────────────────────────────────────────────────────
// ── Mobile gauge carousel (lazy-susan) ─────────────────────────────────────────
// On phones the WIN/SPREAD/TOTAL gauges become a transform-driven gallery: the
// active gauge sits centered + full-size, neighbors spin away behind it. One
// swipe advances exactly one step and locks. No native scrolling (which was
// getting stuck) — a CSS transform per slide, animated by a transition. The
// active bet type stays in sync with the Lines tab, pick-slot grid, and both
// gauge rows.
const BET_ORDER = ['spread', 'ml', 'total'];

function _isPhone() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches;
}

function _markActiveSlides(type) {
  document.querySelectorAll('.ca-gauge-slide').forEach(s => {
    s.classList.toggle('is-active', s.dataset.bt === type);
  });
}

// Position every slide in a row relative to the active bet type.
function _layoutCarousel(row, type) {
  const activeIdx = BET_ORDER.indexOf(type);
  if (activeIdx < 0) return;
  row.querySelectorAll('.ca-gauge-slide').forEach(s => {
    const off = BET_ORDER.indexOf(s.dataset.bt) - activeIdx;   // -2..+2
    const abs = Math.abs(off);
    const tx    = off * 58;                       // % of slide width
    const rot   = -off * 34;                      // spin away
    const scale = off === 0 ? 1 : 0.74;
    const op    = off === 0 ? 1 : (abs === 1 ? 0.5 : 0.22);
    s.style.transform = `translateX(${tx}%) scale(${scale}) rotateY(${rot}deg)`;
    s.style.opacity   = String(op);
    s.style.zIndex    = String(10 - abs);
    s.classList.toggle('is-active', off === 0);
  });
}

function _layoutAllCarousels(type) {
  if (!_isPhone()) return;
  document.querySelectorAll('.ca-senti-gauges').forEach(row => _layoutCarousel(row, type));
}

function _setupCarousels() {
  document.querySelectorAll('.ca-senti-gauges').forEach(row => {
    if (row._cagWired) return;
    row._cagWired = true;
    let x0 = null, y0 = null;
    row.addEventListener('touchstart', e => {
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    row.addEventListener('touchend', e => {
      if (x0 == null || !_isPhone()) { x0 = y0 = null; return; }
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      x0 = y0 = null;
      // Horizontal swipes only — let vertical gestures scroll the page.
      if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy)) return;
      const i  = BET_ORDER.indexOf(_linesType);
      const ni = Math.max(0, Math.min(BET_ORDER.length - 1, i + (dx < 0 ? 1 : -1)));
      if (ni !== i) setLinesType(BET_ORDER[ni]);
    }, { passive: true });
  });
}

// Bring the matching-type pick slots into view so the slot grid "cycles" with
// the bet type too (phones only — it's a horizontal scroller there).
function _syncSlotGrid(type) {
  if (!_isPhone()) return;
  const keys = { ml: ['home_ml','away_ml'], spread: ['home_spread','away_spread'], total: ['over','under'] }[type] || [];
  const grid = document.getElementById('ca-slot-grid');
  if (!grid) return;
  const chips = [...grid.querySelectorAll('.ca-slot-chip')];
  const target = chips.find(c => keys.some(k => (c.getAttribute('onclick') || '').includes(`'${k}'`)));
  if (!target) return;
  const left = target.offsetLeft - (grid.clientWidth - target.offsetWidth) / 2;
  grid.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
}

// Called after each gauge row renders: wire swipe handlers + lay out the slides.
function _afterGaugeRender() {
  _setupCarousels();
  _markActiveSlides(_linesType);
  if (_isPhone()) requestAnimationFrame(() => _layoutAllCarousels(_linesType));
}

function setLinesType(type) {
  _linesType = type;
  document.querySelectorAll('.ca-lt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  renderLines();
  // Keep the gauge carousels (and their highlight) in lock-step with the bet type.
  _markActiveSlides(type);
  _layoutAllCarousels(type);
  _syncSlotGrid(type);
}

function renderLines() {
  const el = document.getElementById('ca-lines-table');
  if (!el) return;
  const { game, lines } = _data;
  const dk = lines?.draftkings;
  const fd = lines?.fanduel;

  let awayLabel, homeLabel, overLabel, underLabel;
  let awayFn, homeFn, overFn, underFn;

  if (_linesType === 'spread') {
    awayLabel = `${teamNick(game.away_team)} Spread`;
    homeLabel = `${teamNick(game.home_team)} Spread`;
    awayFn = (src) => src?.spread_away != null ? `${fmtSpread(src.spread_away)}<span class="ca-lt-odds-sm ca-num"> -110</span>` : null;
    homeFn = (src) => src?.spread_home != null ? `${fmtSpread(src.spread_home)}<span class="ca-lt-odds-sm ca-num"> -110</span>` : null;
  } else if (_linesType === 'total') {
    awayLabel = 'Over';
    homeLabel = 'Under';
    awayFn = (src) => src?.over_under  != null ? `${src.over_under}<span class="ca-lt-odds-sm ca-num"> ${fmtOdds(src.ou_over_odds  ?? -110)}</span>` : null;
    homeFn = (src) => src?.over_under  != null ? `${src.over_under}<span class="ca-lt-odds-sm ca-num"> ${fmtOdds(src.ou_under_odds ?? -110)}</span>` : null;
  } else { // ml
    awayLabel = `${teamNick(game.away_team)} ML`;
    homeLabel = `${teamNick(game.home_team)} ML`;
    awayFn = (src) => src?.ml_away != null ? fmtOdds(src.ml_away) : null;
    homeFn = (src) => src?.ml_home != null ? fmtOdds(src.ml_home) : null;
  }

  // Build delta fn for DK (prev values)
  const delta = (cur, prev) => {
    if (prev == null || cur == null) return '';
    const d = (typeof cur === 'number' && typeof prev === 'number') ? cur - prev : null;
    if (d == null || d === 0) return '';
    const sign = d > 0 ? '+' : '';
    const cls  = d > 0 ? 'ca-lt-move-up' : 'ca-lt-move-down';
    return ` <span class="${cls} ca-mv-arrow ca-num">(${sign}${d})</span>`;
  };

  const buildRowVal = (val, prevVal) => {
    if (val == null) return '<span class="ca-lt-na">—</span>';
    return `<span class="ca-lt-val ca-num">${val}${typeof prevVal !== 'undefined' && prevVal != null && val !== prevVal ? delta(null, null) : ''}</span>`;
  };

  // Get raw number for delta calculation
  const getRawAway = (src) => {
    if (!src) return null;
    if (_linesType === 'spread') return src.spread_away;
    if (_linesType === 'total')  return src.over_under;
    return src.ml_away;
  };
  const getRawHome = (src) => {
    if (!src) return null;
    if (_linesType === 'spread') return src.spread_home;
    if (_linesType === 'total')  return src.over_under;
    return src.ml_home;
  };

  const openGame = {
    spread_away: game.spread_away, spread_home: game.spread_home,
    ml_away: game.ml_away,         ml_home: game.ml_home,
    over_under: game.over_under,   ou_over_odds: game.ou_over_odds, ou_under_odds: game.ou_under_odds,
  };

  const rows = [
    { book: 'Open (ESPN)', src: openGame,     prev: null },
    { book: 'DraftKings',  src: dk,           prev: dk   },
    { book: 'FanDuel',     src: fd,           prev: null },
  ];

  const hasAny = rows.some(r => awayFn(r.src) != null || homeFn(r.src) != null);
  if (!hasAny) {
    el.innerHTML = `<div class="ca-lt-empty">Lines not yet available for this game.</div>`;
    return;
  }

  const headerHtml = `<div class="ca-lt-header-row">
    <div>Market</div><div>${awayLabel}</div><div>${homeLabel}</div><div></div>
  </div>`;

  // Shared helpers for market rows
  const fmtPct  = (p) => `${Math.round(p * 100)}%`;
  const pctCls  = (p) => p > 0.505 ? 'ca-pct-high' : p < 0.495 ? 'ca-pct-low' : 'ca-pct-even';
  const fmtVol  = (v) => !v ? '' : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : '';
  const lineDelta = (curL, prevL) => {
    if (curL == null || prevL == null || curL === prevL) return '';
    const d = +(curL - prevL).toFixed(1);
    return `<span class="${d > 0 ? 'ca-mv-up' : 'ca-mv-down'} ca-mv-arrow">${d > 0 ? '↑' : '↓'}${Math.abs(d)}</span>`;
  };

  // Convert probability to American odds string
  const probToAmerican = (p) => {
    if (p == null || isNaN(p) || p <= 0 || p >= 1) return '';
    if (p >= 0.5) return String(Math.round(-100 * p / (1 - p)));
    return `+${Math.round(100 * (1 - p) / p)}`;
  };

  // Helper: mkt cell — optional line left, big % + implied stacked right
  const mktCell = (lineStr, lineChg, prob) => {
    const line = lineStr ? `<span class="ca-lt-val ca-num">${lineStr}${lineChg || ''}</span>` : '';
    const implied = probToAmerican(prob);
    const pctGroup = `<div class="ca-lt-mkt-pct-group">
      <span class="ca-lt-mkt-pct ${pctCls(prob)}">${fmtPct(prob)}</span>
      ${implied ? `<span class="ca-lt-mkt-implied ca-num">${implied}</span>` : ''}
    </div>`;
    return `<div class="ca-lt-mkt-cell">${line}${pctGroup}</div>`;
  };

  const awayNick = game.away_short || teamNick(game.away_team) || game.away_abbr || 'Away';
  const homeNick = game.home_short || teamNick(game.home_team) || game.home_abbr || 'Home';

  const rowsHtml = rows.map(r => {
    const awayVal = awayFn(r.src);
    const homeVal = homeFn(r.src);

    // DK: arrow deltas + inline blurb for significant line moves
    let awayDelta = '', homeDelta = '', rowBlurb = '';
    if (r.book === 'DraftKings' && dk) {
      const awayPrev = _linesType === 'spread' ? dk.prev_spread_away
                    : _linesType === 'total'   ? dk.prev_over_under
                    : dk.prev_ml_away;
      const homePrev = _linesType === 'spread' ? dk.prev_spread_home
                    : _linesType === 'total'   ? dk.prev_over_under
                    : dk.prev_ml_home;
      const aCur = getRawAway(dk), hCur = getRawHome(dk);
      if (awayPrev != null && aCur != null && aCur !== awayPrev) {
        const d = aCur - awayPrev;
        awayDelta = ` <span class="${d > 0 ? 'ca-mv-up' : 'ca-mv-down'} ca-mv-arrow">${d > 0 ? '↑' : '↓'}${Math.abs(d)}</span>`;
      }
      if (homePrev != null && hCur != null && hCur !== homePrev) {
        const d = hCur - homePrev;
        homeDelta = ` <span class="${d > 0 ? 'ca-mv-up' : 'ca-mv-down'} ca-mv-arrow">${d > 0 ? '↑' : '↓'}${Math.abs(d)}</span>`;
      }
      // Blurb: significant spread/ML move since 5am snapshot
      if (_linesType === 'spread' && aCur != null && awayPrev != null) {
        const mv = Math.abs(aCur - awayPrev);
        if (mv >= 0.5) {
          const dir = aCur > awayPrev ? awayNick : homeNick;
          rowBlurb = `Line moved ${mv % 1 === 0 ? mv : mv.toFixed(1)} pts toward ${dir} since open`;
        }
      } else if (_linesType === 'ml' && aCur != null && awayPrev != null) {
        const mv = Math.abs(aCur - awayPrev);
        if (mv >= 15) {
          const dir = aCur < awayPrev ? awayNick : homeNick; // negative ml = favorite, moving lower = team getting more action
          rowBlurb = `ML shifted ${mv} pts since open`;
        }
      }
    }

    return `<div class="ca-lt-row">
      <div class="ca-lt-book">${r.book}</div>
      <div class="ca-lt-val ca-num">${awayVal != null ? awayVal : '<span class="ca-lt-na">—</span>'}${awayDelta}</div>
      <div class="ca-lt-val ca-num">${homeVal != null ? homeVal : '<span class="ca-lt-na">—</span>'}${homeDelta}</div>
      <div class="ca-lt-row-blurb-cell">${rowBlurb}</div>
    </div>`;
  }).join('');

  // ── Polymarket row ────────────────────────────────────────────────────────────
  let polyHtml = '';
  const pm = _data.polymarket;
  if (pm) {
    try {
      const cur  = typeof pm.markets_json        === 'string' ? JSON.parse(pm.markets_json)        : pm.markets_json;
      const morn = typeof pm.morning_markets_json === 'string' ? JSON.parse(pm.morning_markets_json) : pm.morning_markets_json;

      let awayCell = '', homeCell = '';

      if (_linesType === 'spread' && cur?.spread) {
        const pmLine   = cur.spread.line;
        const mornLine = morn?.spread?.line;
        const lineChg  = lineDelta(pmLine, mornLine);
        const awayStr  = pmLine != null ? (pmLine > 0 ? `−${pmLine}` : `+${Math.abs(pmLine)}`) : '—';
        const homeStr  = pmLine != null ? (pmLine >= 0 ? `+${pmLine}` : `${pmLine}`) : '—';
        awayCell = mktCell(awayStr, lineChg, cur.spread.away_prob);
        homeCell = mktCell(homeStr, lineChg, cur.spread.home_prob);
      } else if (_linesType === 'total' && cur?.total) {
        const pmLine   = cur.total.line;
        const mornLine = morn?.total?.line;
        const lineChg  = lineDelta(pmLine, mornLine);
        const ls = pmLine != null ? `${pmLine}` : '—';
        awayCell = mktCell(`o${ls}`, lineChg, cur.total.over_prob);
        homeCell = mktCell(`u${ls}`, lineChg, cur.total.under_prob);
      } else if (_linesType === 'ml' && cur?.moneyline) {
        awayCell = mktCell('', '', cur.moneyline.away_prob);
        homeCell = mktCell('', '', cur.moneyline.home_prob);
      }

      if (awayCell) {
        // Blurb: significant probability shift since morning (use ML probs as most reliable signal)
        let pmBlurb = '';
        const curAP  = cur?.moneyline?.away_prob;
        const mornAP = morn?.moneyline?.away_prob;
        if (curAP != null && mornAP != null) {
          const d = Math.round((curAP - mornAP) * 100);
          if (Math.abs(d) >= 10) {
            const teamDir = d > 0 ? awayNick : homeNick;
            pmBlurb = `Trending ${Math.abs(d)}pp toward ${teamDir} since open`;
          }
        }

        const vol = fmtVol(pm.volume_usd);
        polyHtml = `<div class="ca-lt-row ca-lt-poly-row">
          <div class="ca-lt-book ca-lt-book--mkt">
            <span>Polymarket</span>
            ${vol ? `<span class="ca-lt-book-vol">${vol}</span>` : ''}
          </div>
          ${awayCell}
          ${homeCell}
          <div class="ca-lt-row-blurb-cell">${pmBlurb}</div>
        </div>`;
      }
    } catch (_) {}
  }

  // ── Kalshi row ────────────────────────────────────────────────────────────────
  let kalshiHtml = '';
  const km = _data.kalshi;
  if (km) {
    try {
      const cur  = typeof km.markets_json         === 'string' ? JSON.parse(km.markets_json)         : km.markets_json;
      const morn = typeof km.morning_markets_json  === 'string' ? JSON.parse(km.morning_markets_json) : km.morning_markets_json;

      let awayCell = '', homeCell = '';

      if (_linesType === 'spread' && cur?.spread) {
        const kmLine   = cur.spread.line;
        const mornLine = morn?.spread?.line;
        const lineChg  = lineDelta(kmLine, mornLine);
        const awayStr  = kmLine != null ? (kmLine > 0 ? `−${kmLine}` : `+${Math.abs(kmLine)}`) : '—';
        const homeStr  = kmLine != null ? (kmLine >= 0 ? `+${kmLine}` : `${kmLine}`) : '—';
        awayCell = mktCell(awayStr, lineChg, cur.spread.away_prob);
        homeCell = mktCell(homeStr, lineChg, cur.spread.home_prob);
      } else if (_linesType === 'total' && cur?.total) {
        const kmLine   = cur.total.line;
        const mornLine = morn?.total?.line;
        const lineChg  = lineDelta(kmLine, mornLine);
        const ls = kmLine != null ? `${kmLine}` : '—';
        awayCell = mktCell(`o${ls}`, lineChg, cur.total.over_prob);
        homeCell = mktCell(`u${ls}`, lineChg, cur.total.under_prob);
      } else if (cur?.moneyline) {
        // ML tab or fallback when no spread/total data
        awayCell = mktCell('', '', cur.moneyline.away_prob);
        homeCell = mktCell('', '', cur.moneyline.home_prob);
      }

      if (awayCell) {
        // Blurb: significant probability shift since morning
        let kalshiBlurb = '';
        const curAP  = cur?.moneyline?.away_prob;
        const mornAP = morn?.moneyline?.away_prob;
        if (curAP != null && mornAP != null) {
          const d = Math.round((curAP - mornAP) * 100);
          if (Math.abs(d) >= 10) {
            const teamDir = d > 0 ? awayNick : homeNick;
            kalshiBlurb = `Win probability shifted ${Math.abs(d)}pp toward ${teamDir} since open`;
          }
        }

        const vol = fmtVol(km.volume_yes);
        kalshiHtml = `<div class="ca-lt-row ca-lt-kalshi-row">
          <div class="ca-lt-book ca-lt-book--mkt">
            <span>Kalshi</span>
            ${vol ? `<span class="ca-lt-book-vol">${vol}</span>` : ''}
          </div>
          ${awayCell}
          ${homeCell}
          <div class="ca-lt-row-blurb-cell">${kalshiBlurb}</div>
        </div>`;
      }
    } catch (_) {}
  }

  el.innerHTML = `<div class="ca-lines-table-wrap">${headerHtml}${rowsHtml}${polyHtml}${kalshiHtml}</div>`;
}

// ── Sentiment + Community: shared bet-type config ─────────────────────────────
// Both renderSentiment() (Public Betting) and renderCommunity() (user votes)
// use the same three bet rows. Defined once, consumed twice.
//
// O/U colors are a non-betting-cliché pair (steel blue + amber): cold vs warm
// without falling into red/green or green/gray.
const OU_COLOR_UNDER = '#4682B4'; // steel blue
const OU_COLOR_OVER  = '#F59E0B'; // amber

// Sport → unit suffix for the over/under line value (e.g. "8.5 runs", "7.5 pts").
const TOTAL_UNIT = {
  MLB:   'runs',
  NHL:   'goals',
  NBA:   'pts',
  NFL:   'pts',
  NCAAF: 'pts',
  CBB:   'pts',
  WCBB:  'pts',
  ATP:   'games',
  WTA:   'games',
  // Golf has no game-level total
};

function _buildBetTypes() {
  const { game } = _data;
  // Pull team palettes, then push them apart if they're near-identical so the
  // gauge's two sides (and which way the needle leans) are easy to read.
  const { away: awayColors, home: homeColors } =
    distinctColors(teamColors(game, false), teamColors(game, true));
  const awayName = game.away_short || teamNick(game.away_team) || game.away_abbr || '';
  const homeName = game.home_short || teamNick(game.home_team) || game.home_abbr || '';
  const spUnit     = ({ ATP: 'games', WTA: 'games' })[(game.sport || '').toUpperCase()];
  const homeSpread = game.spread_home != null
    ? (spUnit ? `${fmtSpread(game.spread_home)} ${spUnit}` : fmtSpread(game.spread_home))
    : null;
  const ouUnit     = TOTAL_UNIT[(game.sport || '').toUpperCase()];
  const ouLine     = game.over_under != null
    ? (ouUnit ? `${game.over_under} ${ouUnit}` : String(game.over_under))
    : null;

  return [
    {
      label:     'SPREAD',
      betLabelColor: '#a78bfa',  // bright violet
      linesType: 'spread',
      leftKey:   'away_spread',  rightKey:   'home_spread',
      leftName:  awayName,       rightName:  homeName,
      leftColor:           awayColors.primary,   rightColor:           homeColors.primary,
      leftColorSecondary:  awayColors.secondary, rightColorSecondary:  homeColors.secondary,
      // Show the home-side line in the center (e.g. -1.5) — matches the line
      // value users actually see on the lines table.
      centerLine: homeSpread,
    },
    {
      label:     'WIN',
      betLabelColor: '#22d3ee',  // bright cyan
      linesType: 'ml',
      leftKey:   'away_ml',     rightKey:   'home_ml',
      leftName:  awayName,      rightName:  homeName,
      leftColor:           awayColors.primary,   rightColor:           homeColors.primary,
      leftColorSecondary:  awayColors.secondary, rightColorSecondary:  homeColors.secondary,
      centerLine: null,
    },
    {
      label:     'TOTAL',
      betLabelColor: '#fbbf24',  // bright amber
      linesType: 'total',
      leftKey:   'under',        rightKey:   'over',
      leftName:  'Under',        rightName:  'Over',
      leftColor: OU_COLOR_UNDER, rightColor: OU_COLOR_OVER,
      // No team secondary for over/under — labels stay clean.
      centerLine: ouLine,
    },
  ];
}

// ── Sentiment section (Public Betting only — Community moved to its own section) ──
function renderSentiment() {
  const cardsEl  = document.getElementById('ca-sentiment-cards');
  const footerEl = document.getElementById('ca-sentiment-footer');
  if (!cardsEl) return;

  const pb = _data.publicBetting || null;
  const betTypes = _buildBetTypes();

  const pbPair = (leftKey, rightKey) => {
    const map = {
      away_ml: pb?.away_ml_pct, home_ml: pb?.home_ml_pct,
      away_spread: pb?.away_spread_pct, home_spread: pb?.home_spread_pct,
      over: pb?.over_pct, under: pb?.under_pct,
    };
    let lp = map[leftKey], rp = map[rightKey];
    // ActionNetwork sometimes returns only one side — fill in the complement.
    if (lp != null && rp == null) rp = 100 - lp;
    else if (rp != null && lp == null) lp = 100 - rp;
    return { leftPct: lp ?? null, rightPct: rp ?? null };
  };

  // The gauge widget owns its own MONEYLINE/SPREAD/TOTAL label now — no extra
  // wrapper here.
  const blocks = betTypes.map(bt => {
    const { leftPct, rightPct } = pbPair(bt.leftKey, bt.rightKey);
    return `<div class="ca-gauge-slide" data-bt="${bt.linesType}">` + cappingGauge({
      betLabel:            bt.label,
      betLabelColor:       bt.betLabelColor,
      leftLabel:           bt.leftName,
      rightLabel:          bt.rightName,
      leftPct,
      rightPct,
      leftColor:           bt.leftColor,
      rightColor:          bt.rightColor,
      leftColorSecondary:  bt.leftColorSecondary,
      rightColorSecondary: bt.rightColorSecondary,
      centerLine:          bt.centerLine,
      size: 'md',
    }) + '</div>';
  }).join('');

  cardsEl.innerHTML = `<div class="ca-senti-gauges">${blocks}</div>`;
  _afterGaugeRender();

  if (footerEl) footerEl.textContent = '';
}

// ── Community section (user votes, with vote buttons) ─────────────────────────
function renderCommunity() {
  const gaugesEl  = document.getElementById('ca-community-gauges');
  const votesEl   = document.getElementById('ca-community-vote-row');
  if (!gaugesEl) return;

  const { game, votes = {}, userVote = {} } = _data;
  const v = votes || {};
  const totalVotes = Object.values(v).reduce((a, b) => a + (b || 0), 0);
  const betTypes = _buildBetTypes();

  const votePair = (leftKey, rightKey) => {
    const lv = v[leftKey]  || 0;
    const rv = v[rightKey] || 0;
    const total = lv + rv;
    if (total === 0) return { leftPct: null, rightPct: null };
    const lp = Math.round((lv / total) * 100);
    return { leftPct: lp, rightPct: 100 - lp };
  };

  // Pre-game games are votable: the gauge chips themselves are the vote buttons.
  const votable = game?.status === 'pre';

  const blocks = betTypes.map(bt => {
    const { leftPct, rightPct } = votePair(bt.leftKey, bt.rightKey);
    return `<div class="ca-gauge-slide" data-bt="${bt.linesType}">` + cappingGauge({
      betLabel:            bt.label,
      betLabelColor:       bt.betLabelColor,
      leftLabel:           bt.leftName,
      rightLabel:          bt.rightName,
      leftPct,
      rightPct,
      leftColor:           bt.leftColor,
      rightColor:          bt.rightColor,
      leftColorSecondary:  bt.leftColorSecondary,
      rightColorSecondary: bt.rightColorSecondary,
      centerLine:          bt.centerLine,
      size: 'md',
      // Voting wired straight into the gauge chips.
      votable,
      leftSlot:  bt.leftKey,            rightSlot:  bt.rightKey,
      leftVoted: !!userVote[bt.leftKey], rightVoted: !!userVote[bt.rightKey],
    }) + '</div>';
  }).join('');

  const totalHdr = totalVotes > 0
    ? `<span class="ca-senti-vote-count ca-num">${totalVotes} vote${totalVotes !== 1 ? 's' : ''}</span>`
    : '';
  gaugesEl.innerHTML = `
    <div class="ca-cmty-sub-hdr">Community votes ${totalHdr}</div>
    ${_buildVoteLead(votable)}
    <div class="ca-senti-gauges">${blocks}</div>`;
  _afterGaugeRender();

  // Button rows removed — the gauge chips are the vote buttons now.
  if (votesEl) votesEl.innerHTML = '';

  // Chat lives below the gauges. Render the shell now, then load messages.
  loadAndRenderChat();
}

// Short encouragement line shown above the community gauges. Pre-game prompts a
// vote (and a sign-in for viewers); once locked it explains voting is closed.
function _buildVoteLead(votable) {
  if (!votable) {
    return `<div class="ca-cmty-vote-lead">Voting is closed for this game. The community picks below are locked in.</div>`;
  }
  if (isViewer()) {
    return `<div class="ca-cmty-vote-lead">
      <strong>Call the game.</strong> Tap a name below a gauge to vote.
      <a onclick="openLogin()" class="ca-cmty-vote-link">Log in</a> or
      <a onclick="openSignup()" class="ca-cmty-vote-link">sign up free</a>
      to vote and track your picks.
    </div>`;
  }
  return `<div class="ca-cmty-vote-lead">
    <strong>Call the game.</strong> Tap a name below any gauge to vote. Tap again to undo.
  </div>`;
}

// Toggle vote handler. If the slot is already voted, remove it (DELETE);
// otherwise cast it (POST). Re-renders the community section either way.
async function castVote(slot) {
  if (!_data?.game?.espn_game_id) return;
  if (isViewer()) { openLogin(); return; }
  const already = !!(_data.userVote && _data.userVote[slot]);
  const method  = already ? 'DELETE' : 'POST';
  try {
    const res = await fetch(`/api/game/${_data.game.espn_game_id}/vote`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ slot }),
    });
    if (res.status === 401) { openLogin(); return; }
    if (res.status === 409) { alert('Voting is closed. Game has started.'); return; }
    if (method === 'DELETE') {
      // DELETE returns { ok }, not fresh tallies — update local state by hand.
      if (_data.userVote) delete _data.userVote[slot];
      if (_data.votes && _data.votes[slot] > 0) _data.votes[slot] -= 1;
    } else {
      const data = await res.json();
      _data.votes    = data.votes;
      _data.userVote = data.userVote;
    }
    renderCommunity();
  } catch (err) {
    console.warn('[community] vote failed:', err);
  }
}
window.castVote = castVote;

// ── Community chat ────────────────────────────────────────────────────────────
let _chatLoaded = false;

function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t.getTime())) return '';
  const secs = Math.max(0, Math.floor((Date.now() - t.getTime()) / 1000));
  if (secs < 60)    return 'just now';
  if (secs < 3600)  return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

// Absolute timestamp (ET) shown as a tooltip on the relative time.
function fullTime(iso) {
  if (!iso) return '';
  const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) + ' ET';
}

// Color for a vote-annotation chip, by side. Mirrors the gauge/team palette.
function voteChipColor(v) {
  const { game } = _data;
  if (v.side === 'over')  return '#F59E0B';
  if (v.side === 'under') return '#4682B4';
  const c = teamColors(game, v.side === 'home');
  return c.primary;
}

function voteChips(votes) {
  if (!votes || !votes.length) return '';
  return votes.map(v => {
    const color = voteChipColor(v);
    return `<span class="ca-chat-votechip" style="--chip:${color};">${esc(v.label)}</span>`;
  }).join('');
}

async function loadAndRenderChat() {
  const el = document.getElementById('ca-community-chat');
  if (!el) return;
  // Render the shell immediately so the input shows without waiting on the fetch.
  if (!_chatLoaded) el.innerHTML = _chatShell([], true);
  try {
    const res = await fetch(`/api/game/${_data.game.espn_game_id}/chat`);
    const data = await res.json();
    _chatLoaded = true;
    el.innerHTML = _chatShell(data.messages || [], false);
  } catch (err) {
    console.warn('[community] chat load failed:', err);
    el.innerHTML = _chatShell([], false);
  }
}

function _chatShell(messages, loading) {
  const header = `<div class="ca-chat-hdr">Community chat ${messages.length ? `<span class="ca-chat-count">${messages.length}</span>` : ''}</div>`;

  let list;
  if (loading) {
    list = `<div class="ca-chat-empty">Loading chat…</div>`;
  } else if (!messages.length) {
    list = `<div class="ca-chat-empty">No messages yet. Start the conversation.</div>`;
  } else {
    list = messages.map(m => `
      <div class="ca-chat-msg">
        <div class="ca-chat-nametag">
          <span class="ca-chat-user">${esc(m.username)}</span>
          ${voteChips(m.votes)}
          <span class="ca-chat-time" title="${esc(fullTime(m.created_at))}">${timeAgo(m.created_at)}</span>
          ${m.deletable ? `<button class="ca-chat-del" title="Delete (first minute only)" onclick="deleteChatMsg(${m.id})">×</button>` : ''}
        </div>
        <div class="ca-chat-body">${esc(m.message)}</div>
      </div>`).join('');
  }

  let composer;
  if (isViewer()) {
    composer = `<div class="ca-chat-signin">
      <a onclick="openLogin()" class="ca-cmty-vote-link">Log in</a> or
      <a onclick="openSignup()" class="ca-cmty-vote-link">sign up free</a>
      to join the conversation and track your picks.
    </div>`;
  } else {
    composer = `<div class="ca-chat-input-row">
      <input id="ca-chat-input" class="ca-chat-input" type="text" maxlength="500"
             placeholder="Say something about this game…"
             onkeydown="if(event.key==='Enter'){event.preventDefault();postChat();}">
      <button class="ca-chat-send" onclick="postChat()">Post</button>
    </div>`;
  }

  // Composer on top (always sits above the thread), messages below in a
  // scrollable list. Header stays as the section title.
  return header + composer + `<div class="ca-chat-list">${list}</div>`;
}

async function postChat() {
  const input = document.getElementById('ca-chat-input');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;
  input.disabled = true;
  try {
    const res = await fetch(`/api/game/${_data.game.espn_game_id}/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message }),
    });
    if (res.status === 401) { openLogin(); return; }
    if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Could not post.'); return; }
    input.value = '';
    await loadAndRenderChat();
    document.getElementById('ca-chat-input')?.focus();
  } catch (err) {
    console.warn('[community] post failed:', err);
  } finally {
    const fresh = document.getElementById('ca-chat-input');
    if (fresh) fresh.disabled = false;
  }
}
window.postChat = postChat;

async function deleteChatMsg(id) {
  if (!_data?.game?.espn_game_id) return;
  try {
    const res = await fetch(`/api/game/${_data.game.espn_game_id}/chat/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      if (e.expired) alert('This message can no longer be deleted.');
    }
    await loadAndRenderChat();
  } catch (err) {
    console.warn('[community] delete failed:', err);
  }
}
window.deleteChatMsg = deleteChatMsg;

// ── Injuries section ──────────────────────────────────────────────────────────
function renderInjuries() {
  const el = document.getElementById('ca-injuries');
  if (!el) return;
  const { game, stats } = _data;
  const injuries = stats?.injuries;

  const noPlayers = side => !side || !side.players || side.players.length === 0;
  if (!injuries || (noPlayers(injuries.home) && noPlayers(injuries.away))) {
    el.innerHTML = `<div class="ca-inj-empty">No injury report available.</div>`;
    return;
  }

  // Dot class from status string
  const dotCls = status => {
    const s = (status || '').toLowerCase();
    if (s.includes('out'))                              return 'ca-inj-dot--out';
    if (s.includes('doubtful'))                         return 'ca-inj-dot--doubt';
    if (s.includes('gtd') || s.includes('game time'))  return 'ca-inj-dot--gtd';
    if (s.includes('quest'))                            return 'ca-inj-dot--ques';
    if (s.includes('probable'))                         return 'ca-inj-dot--probable';
    return 'ca-inj-dot--default';
  };

  const renderTeam = (side, fallbackAbbr, fallbackShort) => {
    const abbr      = side?.abbr      || fallbackAbbr || '';
    const shortName = side?.shortName || fallbackShort || '';
    const header    = abbr && shortName
      ? `${abbr.toUpperCase()} · ${shortName.toUpperCase()}`
      : (abbr || shortName || 'TEAM').toUpperCase();

    if (noPlayers(side)) {
      return `<div class="ca-inj-team">
        <div class="ca-inj-hdr">${esc(header)}</div>
        <div class="ca-inj-empty-team">None reported</div>
      </div>`;
    }

    const rows = side.players.map(p => {
      const right = [p.status, p.detail].filter(Boolean).join(' · ').toUpperCase();
      return `<div class="ca-inj-row">
        <span class="ca-inj-dot ${dotCls(p.status)}"></span>
        <span class="ca-inj-name">${esc(p.shortName || p.player || '?')}</span>
        <span class="ca-inj-info">${esc(right)}</span>
      </div>`;
    }).join('');

    return `<div class="ca-inj-team">
      <div class="ca-inj-hdr">${esc(header)}</div>
      ${rows}
    </div>`;
  };

  el.innerHTML = renderTeam(injuries.away, game.away_abbr, game.away_short || game.away_team) +
                 renderTeam(injuries.home, game.home_abbr, game.home_short || game.home_team);
}

// ── Context grid ──────────────────────────────────────────────────────────────
function renderContext() {
  const el = document.getElementById('ca-context-grid');
  if (!el) return;
  const { game, stats } = _data;
  const sport = (game.sport || '').toUpperCase();

  const cards = [];

  // Venue
  const venueName = game.venue_name || stats?.venue?.name || null;
  const venueCity = game.venue_city || stats?.venue?.city || null;
  cards.push({ title: 'Venue', val: venueName || '—', sub: venueCity || '' });

  // Surface / Weather (sport-specific)
  if (sport === 'ATP' || sport === 'WTA') {
    cards.push({ title: 'Surface', val: esc(stats?.surface || '—'), sub: esc(stats?.tournament || '') });
  } else if (['MLB', 'NFL', 'NCAAF'].includes(sport)) {
    const w = stats?.weather;
    if (w && w.temp_f != null) {
      cards.push({
        title: 'Weather',
        val:   `${w.temp_f}°F`,
        sub:   [w.condition, w.wind_mph != null ? `${w.wind_mph} mph wind` : ''].filter(Boolean).join(' · '),
      });
    } else {
      cards.push({ title: 'Weather', val: '—', sub: 'Not available' });
    }
  }

  // MLB: probable pitchers — one side-by-side card
  if (sport === 'MLB' && stats?.pitchers?.length) {
    const awayP = stats.pitchers.find(p => p.homeAway === 'away');
    const homeP = stats.pitchers.find(p => p.homeAway === 'home');
    const mkPitcherHtml = (p, side) => {
      if (!p) return `<div class="ca-ctx-pitcher"><div class="ca-ctx-pitcher-name">TBD</div></div>`;
      const stats2 = [p.record, p.era ? `ERA ${p.era}` : null].filter(Boolean).join(' · ');
      return `<div class="ca-ctx-pitcher${side === 'home' ? ' ca-ctx-pitcher--right' : ''}">
        <div class="ca-ctx-pitcher-team">${esc(side.toUpperCase())}</div>
        <div class="ca-ctx-pitcher-name">${esc(p.name || '?')}</div>
        ${stats2 ? `<div class="ca-ctx-pitcher-stats ca-num">${esc(stats2)}</div>` : ''}
        ${p.whip ? `<div class="ca-ctx-pitcher-sub">WHIP ${esc(p.whip)}</div>` : ''}
      </div>`;
    };
    cards.push({ raw: `
      <div class="ca-ctx-title">Pitching Matchup</div>
      <div class="ca-ctx-pitching">
        ${mkPitcherHtml(awayP, 'away')}
        <div class="ca-ctx-pitcher-vs">vs</div>
        ${mkPitcherHtml(homeP, 'home')}
      </div>`, span: true });
  }

  // Where to Watch — TV / streaming / live-TV bundles, with logo chips
  const bc = stats?.broadcasts;
  if (bc && (bc.tv?.length || bc.streaming?.length || bc.bundles?.length)) {
    const chip = e => {
      const name = esc(e?.name || '');
      if (!name) return '';
      const d = e.domain ? esc(e.domain) : '';
      const img = d
        ? `<img src="https://logo.clearbit.com/${d}" alt="" style="height:18px;width:18px;border-radius:4px;object-fit:contain;flex:none;" onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src='https://www.google.com/s2/favicons?domain=${d}&amp;sz=64';}else{this.style.display='none';}">`
        : '';
      return `<span style="display:inline-flex;align-items:center;gap:6px;margin:0 10px 6px 0;">${img}<span>${name}</span></span>`;
    };
    const row = (label, list) => (!list || !list.length) ? '' :
      `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin-top:4px;">
        <span class="ca-ctx-sub" style="min-width:54px;">${label}</span>${list.map(chip).join('')}</div>`;
    cards.push({ raw: `
      <div class="ca-ctx-title">Where to Watch</div>
      ${row('TV', bc.tv)}
      ${row('Stream', bc.streaming)}
      ${row('Live TV', bc.bundles)}`, span: true });
  }

  // NHL: starting goalies — side-by-side card (parallel to MLB pitchers)
  if (sport === 'NHL' && stats?.goalies?.length) {
    const awayG = stats.goalies.find(g => g.homeAway === 'away');
    const homeG = stats.goalies.find(g => g.homeAway === 'home');
    const mk = (g, side) => {
      if (!g) return `<div class="ca-ctx-pitcher"><div class="ca-ctx-pitcher-name">TBD</div></div>`;
      const sub = [g.record, g.savePct ? `SV% ${g.savePct}` : null].filter(Boolean).join(' · ');
      return `<div class="ca-ctx-pitcher${side === 'home' ? ' ca-ctx-pitcher--right' : ''}">
        <div class="ca-ctx-pitcher-team">${esc(side.toUpperCase())}</div>
        <div class="ca-ctx-pitcher-name">${esc(g.name || '?')}</div>
        ${sub ? `<div class="ca-ctx-pitcher-stats ca-num">${esc(sub)}</div>` : ''}
      </div>`;
    };
    cards.push({ raw: `
      <div class="ca-ctx-title">Goalie Matchup</div>
      <div class="ca-ctx-pitching">
        ${mk(awayG, 'away')}
        <div class="ca-ctx-pitcher-vs">vs</div>
        ${mk(homeG, 'home')}
      </div>`, span: true });
  }

  // ESPN win probability (matchup predictor)
  if (stats?.predictor && (stats.predictor.homePct != null || stats.predictor.awayPct != null)) {
    const awayShort = esc(game.away_short || game.away_team?.split(' ').pop() || 'Away');
    const homeShort = esc(game.home_short || game.home_team?.split(' ').pop() || 'Home');
    cards.push({ raw: `
      <div class="ca-ctx-title">ESPN Win Probability</div>
      <div class="ca-ctx-sub" style="margin-top:6px;">${awayShort} <span class="ca-num" style="float:right;">${stats.predictor.awayPct != null ? stats.predictor.awayPct + '%' : '—'}</span></div>
      <div class="ca-ctx-sub" style="margin-top:4px;">${homeShort} <span class="ca-num" style="float:right;">${stats.predictor.homePct != null ? stats.predictor.homePct + '%' : '—'}</span></div>` });
  }

  // Head-to-head season series
  if (stats?.seasonSeries?.summary) {
    cards.push({ title: stats.seasonSeries.title || 'Season Series', val: esc(stats.seasonSeries.summary), sub: '' });
  }

  // Statistical leaders — top performers per team
  if (stats?.leaders && (stats.leaders.home?.length || stats.leaders.away?.length)) {
    const col = (list, label) => {
      if (!list || !list.length) return '';
      const rows = list.slice(0, 3).map(l =>
        `<div class="ca-ctx-sub" style="margin-top:3px;">${esc(l.cat)}: <span style="color:var(--text);">${esc(l.name)}${l.pos ? ` (${esc(l.pos)})` : ''}</span> <span class="ca-num" style="float:right;">${esc(String(l.value))}</span></div>`
      ).join('');
      return `<div style="margin-top:6px;"><div class="ca-ctx-sub" style="font-weight:700;color:var(--text);">${esc(label)}</div>${rows}</div>`;
    };
    const awayLbl = game.away_short || game.away_team?.split(' ').pop() || 'Away';
    const homeLbl = game.home_short || game.home_team?.split(' ').pop() || 'Home';
    cards.push({ raw: `
      <div class="ca-ctx-title">Team Leaders</div>
      ${col(stats.leaders.away, awayLbl)}
      ${col(stats.leaders.home, homeLbl)}`, span: true });
  }

  // Officials
  if (stats?.officials?.length) {
    const names = stats.officials.slice(0, 5).map(o => esc(o.name)).join(', ');
    cards.push({ title: 'Officials', val: `<span style="font-size:13px;font-weight:500;line-height:1.4;">${names}</span>`, sub: '' });
  }

  // Attendance
  if (stats?.attendance) {
    cards.push({ title: 'Attendance', val: Number(stats.attendance).toLocaleString(), sub: '' });
  }

  // ESPN recap / preview headline
  if (stats?.recap?.headline) {
    cards.push({ raw: `
      <div class="ca-ctx-title">${stats.recap.type === 'Recap' ? 'Recap' : 'Preview'}</div>
      <div class="ca-ctx-sub" style="margin-top:6px;line-height:1.45;color:var(--text);">${esc(stats.recap.headline)}</div>`, span: true });
  }

  // Render
  el.innerHTML = cards.map(c => {
    if (c.raw) {
      return `<div class="ca-ctx-card${c.span ? ' ca-ctx-card--span' : ''}">${c.raw}</div>`;
    }
    const valHtml = c.val === null
      ? `<div class="ca-ctx-val ca-coming-soon-val">Coming soon</div>`
      : `<div class="ca-ctx-val ca-num">${c.val}</div>`;
    return `<div class="ca-ctx-card">
      <div class="ca-ctx-title">${c.title}</div>
      ${valHtml}
      ${c.sub ? `<div class="ca-ctx-sub">${c.sub}</div>` : ''}
    </div>`;
  }).join('');
}

// ── History section ───────────────────────────────────────────────────────────
const HIST_SPORTS = new Set(['NBA', 'WNBA', 'NHL', 'MLB', 'NFL', 'NCAAF', 'CBB']);
// Per-sport team-scoring range for the off/def meters (points/goals/runs for & against).
const HIST_PTS_RANGE = {
  NBA: [95, 130], WNBA: [70, 95], CBB: [55, 90],
  NHL: [1, 6], MLB: [1, 9], NFL: [10, 38], NCAAF: [10, 45],
};
const FRESH_BAND_COLOR = { fresh: '#22c55e', moderate: '#eab308', heavy: '#f97316', overworked: '#ef4444' };

function clampPct(x) { return Math.max(0, Math.min(1, x)); }
function histDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  } catch (_) { return ''; }
}
function histIsTennis() {
  const sport = (_data.game.sport || '').toUpperCase();
  return sport === 'ATP' || sport === 'WTA';
}
function histSportSupported() {
  const sport = (_data.game.sport || '').toUpperCase();
  if (histIsTennis()) return !!(_data.game.home_team && _data.game.away_team);
  if (!HIST_SPORTS.has(sport)) return false;
  return !!(_data.stats && (_data.stats.homeTeamId || _data.stats.awayTeamId));
}
function histTeamId(team) {
  return team === 'home' ? _data.stats?.homeTeamId : _data.stats?.awayTeamId;
}

async function renderHistory() {
  const section = document.getElementById('history');
  if (!section) return;
  if (!histSportSupported()) { section.style.display = 'none'; return; }

  section.style.display = '';
  const navS = document.getElementById('ca-nav-history');
  const navM = document.getElementById('ca-mtab-history');
  if (navS) navS.style.display = '';
  if (navM) navM.style.display = '';

  const { game } = _data;
  const setAbbr = (team, txt) => {
    const el = document.querySelector(`#ca-hist-toggle .ca-hist-tab[data-team="${team}"] .ca-hist-tab-abbr`);
    if (el) el.textContent = txt;
  };
  setAbbr('away', (game.away_abbr || game.away_short || teamNick(game.away_team) || 'AWAY').toUpperCase());
  setAbbr('home', (game.home_abbr || game.home_short || teamNick(game.home_team) || 'HOME').toUpperCase());

  const toggle = document.getElementById('ca-hist-toggle');
  if (toggle && !toggle.dataset.wired) {
    toggle.dataset.wired = '1';
    toggle.querySelectorAll('.ca-hist-tab').forEach(btn =>
      btn.addEventListener('click', () => selectHistoryTeam(btn.dataset.team)));
  }
  await loadAndPaintHistory();
}

async function loadAndPaintHistory() {
  const body = document.getElementById('ca-history-body');
  if (!body) return;
  const sport = (_data.game.sport || '').toUpperCase();

  // Tennis: player-keyed recent matches (ESPN eventlog), not team schedule.
  if (histIsTennis()) {
    const player = _historyTeam === 'home' ? _data.game.home_team : _data.game.away_team;
    if (!player) { body.innerHTML = `<div class="ca-hist-empty">No recent matches on record.</div>`; return; }
    const cacheKey = `T:${sport}:${player}`;
    if (_historyCache[cacheKey]) { paintTennisHistory(_historyCache[cacheKey]); return; }
    body.innerHTML = `<div class="ca-hist-loading">Loading recent matches…</div>`;
    try {
      const url = `/api/tennis-history?player=${encodeURIComponent(player)}&sport=${sport}&date=${encodeURIComponent(_data.game.start_time || '')}`;
      const data = await (await fetch(url)).json();
      if (!data || data.unsupported || data.unavailable || !(data.matches && data.matches.length)) {
        body.innerHTML = `<div class="ca-hist-empty">No recent matches on record.</div>`;
        return;
      }
      _historyCache[cacheKey] = data;
      const stillActive = (_historyTeam === 'home' ? _data.game.home_team : _data.game.away_team) === player;
      if (stillActive) paintTennisHistory(data);
    } catch (_) {
      body.innerHTML = `<div class="ca-hist-empty">Could not load matches.</div>`;
    }
    return;
  }

  const teamId = histTeamId(_historyTeam);
  if (!teamId) { body.innerHTML = `<div class="ca-hist-empty">No recent games on record.</div>`; return; }

  const cacheKey = `${sport}:${teamId}`;
  if (_historyCache[cacheKey]) { paintHistory(_historyCache[cacheKey]); return; }

  body.innerHTML = `<div class="ca-hist-loading">Loading recent games…</div>`;
  try {
    const r = await fetch(`/api/team-history?teamId=${encodeURIComponent(teamId)}&sport=${encodeURIComponent(sport)}`);
    const data = await r.json();
    if (!data || data.unsupported || data.unavailable || !(data.last20 && data.last20.length)) {
      body.innerHTML = `<div class="ca-hist-empty">No recent games on record.</div>`;
      return;
    }
    _historyCache[cacheKey] = data;
    if (histTeamId(_historyTeam) === teamId) paintHistory(data); // user may have toggled mid-fetch
  } catch (_) {
    body.innerHTML = `<div class="ca-hist-empty">Could not load history.</div>`;
  }
}

function selectHistoryTeam(team) {
  if (team !== 'away' && team !== 'home') return;
  if (team === _historyTeam) return;
  _historyTeam = team;
  const toggle = document.getElementById('ca-hist-toggle');
  if (toggle) {
    toggle.querySelectorAll('.ca-hist-tab').forEach(b => b.classList.toggle('active', b.dataset.team === team));
    toggle.classList.toggle('ca-hist-toggle--home', team === 'home');
  }
  const body = document.getElementById('ca-history-body');
  if (body) body.classList.add('ca-hist-fading');
  setTimeout(() => {
    loadAndPaintHistory().finally(() => {
      document.getElementById('ca-history-body')?.classList.remove('ca-hist-fading');
    });
  }, 140);
}

function paintHistory(data) {
  const body = document.getElementById('ca-history-body');
  if (!body) return;
  const sport = (_data.game.sport || '').toUpperCase();
  const col   = teamColors(_data.game, _historyTeam === 'home');
  body.innerHTML =
    histSummaryHtml(data.summary, col, sport) +
    histLast5Html(data.last5, sport) +
    histLast20Html(data.last20) +
    `<div class="ca-hist-caption">Offense and defense shown as points scored and allowed, scaled to a league range. Not possession-adjusted.</div>`;
  _data._histActive = { sport, teamId: histTeamId(_historyTeam), last5: data.last5 };
}

function histSummaryHtml(s, col, sport) {
  if (!s) return '';
  const tile = (val, label) =>
    `<div class="ca-hist-stat"><div class="ca-hist-stat-val ca-num">${val}</div><div class="ca-hist-stat-label">${label}</div></div>`;
  const mColor = s.avgMargin > 0 ? 'var(--accent-win)' : s.avgMargin < 0 ? 'var(--accent-live)' : 'var(--text)';
  const mStr   = s.avgMargin == null ? '—' : (s.avgMargin > 0 ? '+' : '') + s.avgMargin;
  const form   = (s.lastFiveForm || []).map(r =>
    `<span class="ca-hist-formdot ca-hist-formdot--${r === 'W' ? 'w' : 'l'}">${r}</span>`).join('') || '—';
  const forL = sport === 'NHL' ? 'Goals/gm' : sport === 'MLB' ? 'Runs/gm' : 'PPG';
  const oppL = sport === 'NHL' ? 'Opp G/gm' : sport === 'MLB' ? 'Opp R/gm' : 'Opp PPG';
  const totL = sport === 'NHL' ? 'Total goals' : sport === 'MLB' ? 'Total runs' : 'Total pts';
  return `<div class="ca-hist-summary" style="--hist-accent:${esc(col.primary)};">
    ${tile(s.record, `Last ${s.gamesPlayed}`)}
    ${tile(s.ppg ?? '—', forL)}
    ${tile(s.oppPpg ?? '—', oppL)}
    ${tile(`<span style="color:${mColor};">${mStr}</span>`, 'Avg margin')}
    ${tile(s.totalPoints ?? '—', totL)}
    <div class="ca-hist-stat"><div class="ca-hist-formrow">${form}</div><div class="ca-hist-stat-label">Last 5</div></div>
  </div>`;
}

// Whole bar reads green (good) or red (bad) by percentile, matching the MVP
// history win/loss color language. Width carries the magnitude.
function histMeter(tag, pct, raw) {
  const color = pct >= 50 ? '#4ade80' : '#f87171';
  return `<span class="ca-hist-meter"><span class="ca-hist-meter-tag">${tag}</span>` +
    `<span class="ca-hist-meter-track"><span class="ca-hist-meter-fill" style="width:${Math.max(8, pct)}%;background:${color};"></span></span>` +
    `<span class="ca-hist-meter-num ca-num" style="color:${color};">${raw}</span></span>`;
}

function histLast5Html(games, sport) {
  if (!games || !games.length) return `<div class="ca-hist-empty">No recent games.</div>`;
  const [lo, hi] = HIST_PTS_RANGE[sport] || [0, 1];
  const rows = games.map(g => {
    const res  = g.result || '—';
    const vs   = (g.homeAway === 'home' ? 'vs ' : '@ ') + (g.oppAbbr || g.oppName || '');
    const offP = Math.round(clampPct((g.pf - lo) / (hi - lo)) * 100);
    const defP = Math.round(clampPct((hi - g.pa) / (hi - lo)) * 100);
    const lead = (g.leaders || []).slice(0, 1).map(l =>
      `${esc(l.athlete || '')} ${esc(String(l.value))} ${esc((l.cat || '').slice(0, 3).toUpperCase())}`).join('');
    return `<div class="ca-hist-row" onclick="openHistGame('${esc(g.eventId)}')" role="button" tabindex="0">
      <span class="ca-hist-res ca-hist-res--${res === 'W' ? 'w' : 'l'}">${res}</span>
      <span class="ca-hist-date ca-num">${histDate(g.date)}</span>
      <span class="ca-hist-opp">${esc(vs)}</span>
      <span class="ca-hist-score ca-num">${g.pf}-${g.pa}</span>
      <span class="ca-hist-lead">${lead}</span>
      <span class="ca-hist-meters">
        ${histMeter('OFF', offP, g.pf)}
        ${histMeter('DEF', defP, g.pa)}
      </span>
    </div>`;
  }).join('');
  return `<div class="ca-hist-rows-label">Last 5 games (tap a game for the player box score)</div>` +
         `<div class="ca-hist-rows">${rows}</div>`;
}

function histLast20Html(games) {
  if (!games || !games.length) return '';
  const cells = games.map(g => {
    const w = g.result === 'W';
    const m = g.margin == null ? '' : (g.margin > 0 ? '+' + g.margin : g.margin);
    const t = `${g.homeAway === 'home' ? 'vs' : '@'} ${g.oppAbbr || ''} ${g.pf}-${g.pa} (${histDate(g.date)})`;
    return `<span class="ca-hist-mini ca-hist-mini--${w ? 'w' : 'l'}" title="${esc(t)}">${m}</span>`;
  }).join('');
  return `<div class="ca-hist-last20"><div class="ca-hist-last20-label">Last ${games.length} · most recent first</div>` +
         `<div class="ca-hist-minirow">${cells}</div></div>`;
}

// ── Tennis variant (player recent matches, not a team schedule) ───────────────
function lastNameOf(name) { return (name || '').trim().split(' ').pop(); }

function paintTennisHistory(data) {
  const body = document.getElementById('ca-history-body');
  if (!body) return;
  const col = teamColors(_data.game, _historyTeam === 'home');
  body.innerHTML =
    tennisSummaryHtml(data, col) +
    tennisMatchesHtml(data.matches) +
    `<div class="ca-hist-caption">Recent matches via ESPN. Form is recent results; load is sets played plus days rest, not injury risk.</div>`;
}

function tennisSummaryHtml(data, col) {
  const f = data.form || {};
  const tile = (val, label) =>
    `<div class="ca-hist-stat"><div class="ca-hist-stat-val ca-num">${val}</div><div class="ca-hist-stat-label">${label}</div></div>`;
  const form = (f.lastFive || []).map(r =>
    `<span class="ca-hist-formdot ca-hist-formdot--${r === 'W' ? 'w' : 'l'}">${r}</span>`).join('') || '—';
  const fr = data.freshness;
  const freshTile = fr && fr.score != null
    ? `<div class="ca-hist-stat"><div>${histLoadCell(fr)}</div><div class="ca-hist-stat-label">Freshness</div></div>`
    : '';
  return `<div class="ca-hist-summary" style="--hist-accent:${esc(col.primary)};">
    ${tile(f.record ?? '—', `Last ${(f.wins || 0) + (f.losses || 0)}`)}
    ${tile(f.winPct != null ? f.winPct + '%' : '—', 'Win rate')}
    <div class="ca-hist-stat"><div class="ca-hist-formrow">${form}</div><div class="ca-hist-stat-label">Last 5</div></div>
    ${freshTile}
  </div>`;
}

function tennisMatchesHtml(matches) {
  if (!matches || !matches.length) return `<div class="ca-hist-empty">No recent matches.</div>`;
  const rows = matches.map(m => {
    const res = m.result || '—';
    const surf = m.surface ? `<span class="ca-hist-surface">${esc(m.surface)}</span>` : '';
    const tr = [m.tournament, m.round].filter(Boolean).map(esc).join(' · ');
    return `<div class="ca-hist-row ca-hist-row--tennis">
      <span class="ca-hist-res ca-hist-res--${res === 'W' ? 'w' : 'l'}">${res}</span>
      <span class="ca-hist-date ca-num">${histDate(m.date)}</span>
      <span class="ca-hist-opp">vs ${esc(lastNameOf(m.opp))}</span>
      <span class="ca-hist-score ca-num">${esc(m.setScore || '—')}</span>
      <span class="ca-hist-tourn">${tr}</span>
      ${surf}
    </div>`;
  }).join('');
  return `<div class="ca-hist-rows-label">Recent matches</div><div class="ca-hist-rows">${rows}</div>`;
}

// ── Player drill-down popup ─────────────────────────────────────────────────────
async function openHistGame(eventId) {
  const active = _data._histActive;
  const modal  = document.getElementById('ca-hist-modal');
  const head   = document.getElementById('ca-hist-modal-head');
  const body   = document.getElementById('ca-hist-modal-body');
  if (!active || !modal || !head || !body) return;

  const g = (active.last5 || []).find(x => String(x.eventId) === String(eventId));
  const teamName = _historyTeam === 'home'
    ? (_data.game.home_short || _data.game.home_team)
    : (_data.game.away_short || _data.game.away_team);
  const title = g
    ? `${esc(teamName)} ${g.homeAway === 'home' ? 'vs' : '@'} ${esc(g.oppName || g.oppAbbr || '')}`
    : 'Player box score';
  head.innerHTML = `<div class="ca-hist-modal-title">${title}</div>` +
    (g ? `<div class="ca-hist-modal-sub ca-num">${g.pf}-${g.pa} · ${histDate(g.date)}</div>` : '');
  body.innerHTML = `<div class="ca-hist-loading">Loading player stats…</div>`;
  modal.classList.remove('hidden');

  const key = `${active.sport}:${active.teamId}:${eventId}`;
  let data = _playersCache[key];
  if (!data) {
    try {
      const r = await fetch(`/api/game-players?event=${encodeURIComponent(eventId)}&teamId=${encodeURIComponent(active.teamId)}&sport=${encodeURIComponent(active.sport)}`);
      data = await r.json();
      _playersCache[key] = data;
    } catch (_) { data = { unavailable: true }; }
  }
  if (modal.classList.contains('hidden')) return; // closed during fetch
  if (!data || data.unsupported || data.unavailable || !(data.blocks && data.blocks.length)) {
    body.innerHTML = `<div class="ca-hist-empty">Box score unavailable.</div>`;
    return;
  }
  body.innerHTML = data.blocks.map(blk => histBlockHtml(blk)).join('');
}

function closeHistGame() {
  document.getElementById('ca-hist-modal')?.classList.add('hidden');
}

const HIST_LABEL_TIPS = {
  'H-AB': 'Hits / At-bats', '#P': 'Pitches seen', '+/-': 'Plus / minus', 'TO': 'Turnovers',
  'OREB': 'Offensive rebounds', 'DREB': 'Defensive rebounds', 'PF': 'Personal fouls',
  'SOG': 'Shots on goal', 'TOI': 'Time on ice', 'IP': 'Innings pitched', 'ER': 'Earned runs',
  'BB': 'Walks', 'K': 'Strikeouts', 'RBI': 'Runs batted in', 'PC-ST': 'Pitches / strikes',
  'AB': 'At-bats', 'FG': 'Field goals', 'FT': 'Free throws', '3PT': '3-pointers',
};
function histBlockHtml(blk) {
  const labels = blk.labels || [];
  const title  = blk.type ? blk.type.charAt(0).toUpperCase() + blk.type.slice(1) : '';
  const head = `<tr><th class="ca-hp-th-name"></th>` +
    labels.map(l => {
      const tip = HIST_LABEL_TIPS[l];
      return `<th class="ca-num"${tip ? ` title="${esc(tip)}"` : ''}>${esc(l)}</th>`;
    }).join('') +
    `<th class="ca-hp-th-sep">Form</th><th>Load</th></tr>`;
  const rows = blk.rows.slice().sort((a, b) => (b.starter ? 1 : 0) - (a.starter ? 1 : 0))
    .map(r => histPlayerRow(r, labels)).join('');
  return `<div class="ca-hp-blockwrap">` +
    (title ? `<div class="ca-hp-blocktitle">${esc(title)}</div>` : '') +
    `<div class="ca-hp-scroll"><table class="ca-hp-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div></div>`;
}

function histPlayerRow(r, labels) {
  const f = r.form || {};
  const cells = labels.map((l, i) => `<td class="ca-num">${esc(r.statsArr[i] ?? '—')}</td>`).join('');
  return `<tr class="ca-hp-row${r.dnp ? ' ca-hp-dnp' : ''}">` +
    `<td class="ca-hp-name">${histNameCell(r, f)}</td>${cells}` +
    `<td class="ca-hp-formcell">${histFormCell(f.hotCold)}</td>` +
    `<td class="ca-hp-loadcell">${histLoadCell(f.freshness)}</td></tr>`;
}

function histNameCell(r, f) {
  const star = r.starter ? `<span class="ca-hp-starter" title="Starter">★</span>` : '';
  const pos  = r.pos ? `<span class="ca-hp-pos">${esc(r.pos)}</span>` : '';
  let scale = '';
  const p = f.primary;
  if (p && p.val != null) {
    const dCls = p.delta == null ? '' : p.delta < 0 ? ' ca-hp-delta--below' : p.delta > 0 ? ' ca-hp-delta--above' : '';
    const dStr = p.delta == null ? '' : `<span class="ca-hp-delta${dCls}">${p.delta > 0 ? '+' : ''}${p.delta} vs avg</span>`;
    scale = `<div class="ca-hp-scale"><span class="ca-hp-scale-lbl">${esc(p.label)}</span>` +
      `<span class="ca-hp-scale-track"><span class="ca-hp-scale-fill" style="width:${p.scalePct}%;"></span></span>` +
      `<span class="ca-hp-scale-val ca-num">${p.val}</span>${dStr}</div>`;
  }
  return `<div class="ca-hp-namerow">${star}<span class="ca-hp-pname">${esc(r.shortName || r.name)}</span>${pos}</div>${scale}`;
}

function histFormCell(hc) {
  if (!hc || !hc.bucket || hc.bucket === 'na') return `<span class="ca-hp-muted">—</span>`;
  const map = { hot: ['HOT', 'hot'], warm: ['Warm', 'warm'], neutral: ['Even', 'neutral'], cool: ['Cool', 'cool'], cold: ['COLD', 'cold'] };
  const [lbl, cls] = map[hc.bucket] || ['—', 'neutral'];
  const arrow = (hc.bucket === 'hot' || hc.bucket === 'warm') ? '▲'
              : (hc.bucket === 'cold' || hc.bucket === 'cool') ? '▼' : '·';
  const tip = `${hc.primaryName} form: recent vs trailing avg${hc.z != null ? ` (z ${hc.z})` : ''}`;
  return `<span class="ca-hist-badge ca-hist-badge--${cls}" title="${esc(tip)}">${arrow} ${lbl}</span>`;
}

function histLoadCell(fr) {
  if (!fr || fr.score == null) return `<span class="ca-hp-muted">${fr && fr.note ? esc(fr.note) : '—'}</span>`;
  const color = FRESH_BAND_COLOR[fr.band] || '#eab308';
  const tip = `Player load ${fr.score}/100${fr.note ? ' · ' + fr.note : ''} (workload and rest, not injury risk)`;
  return `<span class="ca-fresh" title="${esc(tip)}">` +
    `<span class="ca-fresh-track"><span class="ca-fresh-pointer" style="left:${fr.score}%;background:${color};"></span></span>` +
    `<span class="ca-fresh-lbl" style="color:${color};">${fr.score}</span></span>`;
}

// ── Countdown timer ───────────────────────────────────────────────────────────
function startCountdown() {
  if (!_data?.game?.start_time) return;
  const target = new Date(_data.game.start_time).getTime();
  const pill   = document.getElementById('ca-status-pill');
  if (!pill) return;

  function tick() {
    const now  = Date.now();
    const diff = target - now;
    if (diff <= 0) { renderStatusPill(); return; }

    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);

    const timeStr = new Date(target).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    });
    pill.innerHTML = `${timeStr} ET · <span class="ca-num">${h > 0 ? h + 'h ' : ''}${m}m ${String(s).padStart(2,'0')}s</span>`;
  }

  tick();
  _countdownId = setInterval(tick, 1000);
}

// ── Scroll-spy for sidebar + mobile tabs ──────────────────────────────────────
// Sum the heights of the layers actually pinned to the top right now: the nav
// always, the game header only where it stays sticky (desktop), and the mobile
// tab bar when shown. Keeps scroll-spy + click-to-section from hiding content
// behind the sticky layers on both desktop and mobile (header scrolls away).
function _stickyTop() {
  const nav  = document.querySelector('nav');
  const hdr  = document.querySelector('.ca-sticky-top');
  const tabs = document.querySelector('.ca-mobile-tabs');
  let h = nav ? nav.offsetHeight : 56;
  if (hdr && getComputedStyle(hdr).position === 'sticky') h += hdr.offsetHeight;
  if (tabs && getComputedStyle(tabs).display !== 'none') h += tabs.offsetHeight;
  return h;
}

// Toggle the "stuck" state on the mobile tab bar once it pins under the nav, so
// it expands + brightens into a table of contents as you scroll.
function initStickyTabs() {
  const tabs = document.querySelector('.ca-mobile-tabs');
  if (!tabs) return;
  let ticking = false;
  const update = () => {
    ticking = false;
    const navH = document.querySelector('nav')?.offsetHeight || 56;
    tabs.classList.toggle('is-stuck', tabs.getBoundingClientRect().top <= navH + 0.5);
  };
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  window.addEventListener('resize', update);
  update();
}

function initScrollSpy() {
  const allNavLinks = document.querySelectorAll(
    '.ca-sidebar-link[data-sec], .ca-mtab[data-sec]'
  );
  const sections = document.querySelectorAll('.ca-section[id]');
  if (!sections.length || !('IntersectionObserver' in window)) return;

  const navHeight = _stickyTop();

  const setActive = (id) => {
    allNavLinks.forEach(t => t.classList.toggle('active', t.dataset.sec === id));
    // Keep the active mobile tab centered so the TOC visibly cycles as you scroll.
    const bar = document.querySelector('.ca-mobile-tabs');
    const activeM = bar && bar.querySelector('.ca-mtab.active');
    if (bar && activeM && getComputedStyle(bar).display !== 'none') {
      const target = activeM.offsetLeft - (bar.clientWidth - activeM.offsetWidth) / 2;
      bar.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
    }
  };

  // Suppress observer while smooth-scroll is in flight to prevent flicker
  let _suppress = false;
  let _suppressTimer = null;

  const obs = new IntersectionObserver(entries => {
    if (_suppress) return;
    for (const entry of entries) {
      if (entry.isIntersecting) setActive(entry.target.id);
    }
  }, { rootMargin: `-${navHeight + 10}px 0px -60% 0px`, threshold: 0 });

  sections.forEach(s => obs.observe(s));

  allNavLinks.forEach(link => {
    if (!link.dataset.sec) return;
    link.addEventListener('click', e => {
      e.preventDefault();
      const sec = document.getElementById(link.dataset.sec);
      if (!sec) return;
      // Set active immediately on click — don't wait for observer
      setActive(link.dataset.sec);
      // Suppress observer for the scroll animation duration (~600ms)
      _suppress = true;
      clearTimeout(_suppressTimer);
      _suppressTimer = setTimeout(() => { _suppress = false; }, 700);
      // Offset for all sticky layers: nav + sticky game header + mobile tabs
      const stickyOffset = _stickyTop() + 20; // breathing room
      const top = sec.getBoundingClientRect().top + window.scrollY - stickyOffset;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });
}

// ── Tiny HTML escaper (client-side) ──────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init().catch(err => console.error('[game-detail] init error:', err));
