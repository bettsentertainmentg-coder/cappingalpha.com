// game-detail.js — Client-side module for the standalone game detail page.
// Reads window.__GAME_DATA__ and renders all dynamic content.
// Companion to src/detail_page.js + public/game-detail.css

import { checkAuth, updateNavAuth, isPaying, isViewer,
         openLogin, closeLogin, doLogin, openSignup, closeSignup, doSignup,
         doLogout, showForgotPassword, showLoginForm, doForgotPassword } from '/modules/auth.js';
import { state } from '/modules/state.js';
import { fmtOdds, fmtSpread, PICK_HEAT_COLOR } from '/modules/utils.js?v=1';
import { cappingGauge } from '/modules/gauge.js';
import { drawPickTimeline, drawLockedTeaser, destroyPickTimeline } from '/modules/score_timeline.js';
import { mountLiveCommand, unmountLiveCommand } from '/modules/live_tracker.js';

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
let _tfTeam   = 'away';       // 'away' | 'home' — local Team Form toggle
let _tfBlockIdx = 0;          // selected offense/defense block for the active team
let _tfBlockType = null;      // its type (e.g. 'pitching') — preserved across team switches
const _tfCache = {};          // `${sport}:${teamId}` (team) or `T:${sport}:${player}` (tennis)

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
  renderTeamForm();
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

  // The payload status can lag ESPN (it's mirrored from prod in local dev, and on
  // a fresh start the cron hasn't flipped 'pre' -> 'in' yet). Probe the live
  // endpoint and activate the live treatment the moment ESPN says it's in progress.
  _maybeActivateLive();
}

async function _maybeActivateLive() {
  const g = _data && _data.game;
  if (!g || g.status === 'post') return;
  const started = !g.start_time || new Date(g.start_time).getTime() <= Date.now();
  if (g.status === 'in' || !started) return;   // already live, or not started yet
  try {
    const r = await fetch(`/api/game/${encodeURIComponent(g.espn_game_id)}/live`);
    if (!r.ok) return;
    const d = await r.json();
    if (d.state && d.state.status === 'in') {
      g.status = 'in';
      if (d.state.homeScore != null) g.home_score = d.state.homeScore;
      if (d.state.awayScore != null) g.away_score = d.state.awayScore;
      if (d.state.period   != null)  g.period     = d.state.period;
      if (d.state.detail)            g.live_detail = d.state.detail;
      if (_countdownId) { clearInterval(_countdownId); _countdownId = null; }
      renderStatusPill();
      renderDetailPanel();   // re-render: closes votes, minimizes curve, mounts the command bar (MLB)
    }
  } catch (_) {}
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
  _wireSlotScrollbar();
}

// Tiny scroll hint under the chip row — only when the chips overflow (phone /
// tight screens). It tucks into the existing gap so it adds no real height: when
// shown, the row's bottom margin shrinks to make room for the 3px bar.
function _wireSlotScrollbar() {
  const grid = document.getElementById('ca-slot-grid');
  if (!grid) return;
  let bar = grid.nextElementSibling;
  if (!bar || !bar.classList.contains('ca-slot-scrollbar')) {
    bar = document.createElement('div');
    bar.className = 'ca-slot-scrollbar';
    bar.innerHTML = '<span class="ca-slot-scrollthumb"></span>';
    grid.parentNode.insertBefore(bar, grid.nextSibling);
  }
  const thumb = bar.firstElementChild;
  const update = () => {
    const sw = grid.scrollWidth, cw = grid.clientWidth;
    if (sw <= cw + 2) {                 // everything fits → no bar, no extra space
      bar.style.display = 'none';
      grid.style.marginBottom = '';
      return;
    }
    bar.style.display = 'block';
    grid.style.marginBottom = '6px';    // a little breathing room between the chips and the scroll bar
    const wPct = Math.max(14, (cw / sw) * 100);
    thumb.style.width = wPct + '%';
    const maxScroll = sw - cw;
    const pos = maxScroll > 0 ? grid.scrollLeft / maxScroll : 0;
    thumb.style.left = (pos * (100 - wPct)) + '%';
  };
  if (!grid.dataset.sbWired) {
    grid.dataset.sbWired = '1';
    grid.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
  }
  requestAnimationFrame(update);
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
// ── Live game feed (shown in the pick panel once the game has started) ────────
function liveStatusLabel(game) {
  const sport = (game.sport || '').toUpperCase();
  if (game.status === 'post') return 'Final';
  if (sport === 'ATP' || sport === 'WTA') return game.period ? `Set ${game.period}` : 'Live';
  const p = game.period;
  let lbl = p ? `P${p}` : 'Live';
  if (sport === 'NFL' || sport === 'NCAAF' || sport === 'NBA' || sport === 'WNBA' || sport === 'CBB') lbl = p ? `Q${p}` : 'Live';
  else if (sport === 'MLB') lbl = p ? `Inn ${p}` : 'Live';
  const clock = game.clock && sport !== 'MLB' ? ` · ${esc(game.clock)}` : '';
  return lbl + clock;
}

function liveFeedHtml() {
  const { game, stats } = _data;
  const sport = (game.sport || '').toUpperCase();
  const live  = game.status === 'in';
  const awayName = game.away_abbr || game.away_short || teamNick(game.away_team) || 'Away';
  const homeName = game.home_abbr || game.home_short || teamNick(game.home_team) || 'Home';

  let scoreRow;
  if (sport === 'ATP' || sport === 'WTA') {
    scoreRow = `<div class="ca-live-tennis ca-num">${esc(_tennisScoreStr(game, live))}</div>`;
  } else {
    const aS = game.away_score ?? 0, hS = game.home_score ?? 0;
    const aWin = game.status === 'post' && aS > hS;
    const hWin = game.status === 'post' && hS > aS;
    const teamLine = (name, score, win) =>
      `<div class="ca-live-team${win ? ' ca-live-win' : ''}"><span class="ca-live-tname">${esc(name)}</span><span class="ca-live-tscore ca-num">${score}</span></div>`;
    scoreRow = `<div class="ca-live-score">${teamLine(awayName, aS, aWin)}${teamLine(homeName, hS, hWin)}</div>`;
  }

  let leadersHtml = '';
  const L = stats && stats.leaders;
  if (L && ((L.away && L.away.length) || (L.home && L.home.length))) {
    const mk = arr => (arr || []).slice(0, 2).map(x =>
      `<div class="ca-live-leader"><span class="ca-live-lcat">${esc(x.cat)}</span>` +
      `<span class="ca-live-lname">${esc(x.name || '')}</span>` +
      `<span class="ca-live-lval ca-num">${esc(String(x.value))}</span></div>`).join('');
    const aL = mk(L.away), hL = mk(L.home);
    if (aL || hL) leadersHtml = `<div class="ca-live-leaders">` +
      (aL ? `<div class="ca-live-lside"><div class="ca-live-lteam">${esc(awayName)}</div>${aL}</div>` : '') +
      (hL ? `<div class="ca-live-lside"><div class="ca-live-lteam">${esc(homeName)}</div>${hL}</div>` : '') +
      `</div>`;
  }

  const badge = live
    ? `<span class="ca-live-badge ca-live-badge--live">● LIVE</span>`
    : `<span class="ca-live-badge ca-live-badge--final">FINAL</span>`;
  return `<div class="ca-live-feed">
    <div class="ca-live-head">${badge}<span class="ca-live-status">${esc(liveStatusLabel(game))}</span></div>
    ${scoreRow}
    ${leadersHtml}
  </div>`;
}

function userVotesBarHtml() {
  const { game, userVote } = _data;
  const voted = buildSlots(game).filter(s => userVote && userVote[s.key]);
  if (!voted.length) return `<div class="ca-live-votes ca-live-votes--none">You didn't vote on this game.</div>`;
  const chips = voted.map(s => {
    const label = s.team ? teamNick(s.team) : s.label.replace(/\s+\d.*/, '');
    const line  = slotLineCurrent(s.key, game) || '';
    return `<span class="ca-live-vote-chip">${esc(label)}${line ? ` <span class="ca-num">${esc(line)}</span>` : ''}</span>`;
  }).join('');
  return `<div class="ca-live-votes"><span class="ca-live-votes-lbl">Your pick${voted.length > 1 ? 's' : ''}</span>${chips}</div>`;
}

// The tracked-bets list for the live command bar footer (game-level, so it does not
// change as the user flips slots). The footer label is added by the live module.
function liveBetsInlineHtml() {
  const { game, userVote } = _data;
  const voted = buildSlots(game).filter(s => userVote && userVote[s.key]);
  if (!voted.length) return `<span class="ca-live-tag ca-live-tag--none">None tracked</span>`;
  return voted.map(s => {
    const label = s.team ? teamNick(s.team) : s.label.replace(/\s+\d.*/, '');
    const line  = slotLineCurrent(s.key, game) || '';
    return `<span class="ca-live-tag">${esc(label)}${line ? ` <span class="ca-num">${esc(line)}</span>` : ''}</span>`;
  }).join('');
}

// Time label (ET) for the conviction curve axis.
function ccTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
}

// Annotated conviction curve (image-2 style, compact): the score steps over time, the
// y-window framed to the data so the line fills the box (no dead space). Each step is
// labelled with the points it added (+35, +5, +10) above and its time below, plus a
// dashed MVP line when it falls in view. Accurate to the pick's real timeline.
function convCurveSvg(timeline) {
  const W = 232, H = 58, padL = 4, padR = 4, padT = 12, padB = 12;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const scores = timeline.map(e => e.score);
  const n = scores.length;
  const smin = Math.min(...scores), smax = Math.max(...scores);
  const padv = Math.max(4, (smax - smin) * 0.18);
  const lo = smin - padv, hi = smax + padv, span = Math.max(1, hi - lo);
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + (1 - (v - lo) / span) * innerH;
  const anchor = (i) => i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
  const baseY = (padT + innerH).toFixed(1);
  const pts = scores.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${x(0).toFixed(1)},${baseY} ${pts} ${x(n - 1).toFixed(1)},${baseY}`;
  const mvp = (MVP_THRESHOLD > lo && MVP_THRESHOLD < hi)
    ? `<line x1="${padL}" y1="${y(MVP_THRESHOLD).toFixed(1)}" x2="${W - padR}" y2="${y(MVP_THRESHOLD).toFixed(1)}" class="ca-cc-mvp"/>` : '';
  const dots = scores.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2" fill="#FFD700"/>`).join('');
  const deltas = timeline.map((e, i) => e.label
    ? `<text x="${x(i).toFixed(1)}" y="${(y(e.score) - 4).toFixed(1)}" class="ca-cc-delta" text-anchor="${anchor(i)}">${esc(e.label)}</text>` : '').join('');
  const times = timeline.map((e, i) => {
    const t = ccTime(e.ts).replace(/\s?[AP]M$/, '');   // compact "8:47", no meridiem
    return t ? `<text x="${x(i).toFixed(1)}" y="${(H - 2).toFixed(1)}" class="ca-cc-time" text-anchor="${anchor(i)}">${esc(t)}</text>` : '';
  }).join('');
  return `<svg class="ca-cc" viewBox="0 0 ${W} ${H}">
    ${mvp}
    <polygon points="${area}" fill="#FFD700" fill-opacity="0.10"/>
    <polyline points="${pts}" fill="none" stroke="#FFD700" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${deltas}${times}
  </svg>`;
}

// Synthetic teaser curve for non-paid users (never the real timeline — same approach
// as the pre-game drawLockedTeaser, so a blurred curve can't be read off the wire).
const CONV_TEASER = [
  { score: 30, label: '+30' }, { score: 35, label: '+5' },
  { score: 45, label: '+10' }, { score: 50, label: '+5' },
];

// Self-contained conviction widget for the live header (per-pick): a bordered bubble
// with the CA-branded annotated curve. No score (already on the far right), no "Learn
// how" (that lives on pre-game cards). Non-paid users get the curve blurred behind a
// lock, exactly like the pre-game conviction chart.
function convictionHeaderHtml(p, timelineVisible, hasTimeline) {
  const head = `<span class="ca-dp-hdr-conv-lbl"><img src="/ca-logo.png" alt="CA" class="ca-dp-hdr-conv-logo" onerror="this.style.display='none'">Conviction</span>`;
  let body;
  if (!timelineVisible) {
    // Non-paid: blurred teaser on EVERY slot (so it never reveals which sides have picks).
    body = `<div class="ca-dp-hdr-conv-graph ca-dp-hdr-conv-graph--locked" onclick="openSignup()" title="Full access only">
      <div class="ca-dp-hdr-conv-blur">${convCurveSvg(CONV_TEASER)}</div>
      <div class="ca-dp-hdr-conv-lockover"><i class="fa-solid fa-lock"></i><span>Full access</span></div>
    </div>`;
  } else if (!p) {
    body = `<div class="ca-dp-hdr-conv-graph ca-dp-hdr-conv-graph--msg">No pick on this side</div>`;
  } else {
    body = (hasTimeline && p.timeline.length > 0)
      ? `<div class="ca-dp-hdr-conv-graph">${convCurveSvg(p.timeline)}</div>`
      : `<div class="ca-dp-hdr-conv-graph ca-dp-hdr-conv-graph--msg">Building...</div>`;
  }
  return `<div class="ca-dp-hdr-conv" title="Conviction curve. A pick's score evolves all day as more cappers weigh in.">
    <div class="ca-dp-hdr-conv-top">${head}</div>
    ${body}
  </div>`;
}

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
    ? `<div class="ca-dp-mvp-badge ca-dp-mvp-badge--gold">CA</div>`
    : isSilverMvp
      ? `<div class="ca-dp-mvp-badge ca-dp-mvp-badge--silver">CA</div>`
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

  // Once live, the conviction curve collapses into a fixed-size graph inside the
  // header (right of the pick name). liveNow drives the command-bar layout for BOTH
  // live ('in') and finished ('post') games — the finished view is the same tracker,
  // completed. The client adapts each cell by the live state's status. Every sport
  // with a live tracker qualifies; Golf keeps the classic layout.
  const LIVE_TRACKER_SPORTS = new Set(['MLB', 'NBA', 'WNBA', 'CBB', 'WCBB', 'NHL', 'NFL', 'NCAAF', 'SOCCER', 'ATP', 'WTA']);
  const liveNow         = ((game.status === 'in') || (game.status === 'post')) && LIVE_TRACKER_SPORTS.has((game.sport || '').toUpperCase());
  const timelineVisible = isPaying() || rank === 1;       // pre-game chart: #1 stays a free reveal
  const convVisible     = isPaying();                     // live conviction: paid only (blurred otherwise, incl. #1)
  const hasTimeline     = !!(p?.timeline && p.timeline.length > 0);

  // Live games drop the bottom paywall banner in favor of a clickable unlock badge in
  // the header (top-right), for logged-out / non-paid users.
  const liveUnlockBadge = (liveNow && !isPaying() && scoreHidden)
    ? `<div class="ca-dp-hdr-unlock" onclick="location.href='/#unlock'" title="Unlock CappingAlpha">
         <span class="ca-dp-hdr-unlock-1"><i class="fa-solid fa-lock"></i> Members only</span>
         <span class="ca-dp-hdr-unlock-2">Unlock full scores + the live value pulse</span>
         <span class="ca-dp-hdr-unlock-3">Get access from $1</span>
       </div>`
    : '';

  const headerHtml = `<div class="ca-dp-header${hdrMod}${liveNow ? ' ca-dp-header--live' : ''}">
    <div class="ca-dp-hdr-lead">
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
      ${liveNow ? convictionHeaderHtml(p, convVisible, hasTimeline) : ''}
    </div>
    ${liveUnlockBadge}
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
  let pubHtml = `<div class="ca-dp-col-label ca-dp-col-label--conv"><img src="/ca-logo.png" alt="CA" class="ca-dp-conv-logo" onerror="this.style.display='none'">Conviction curve</div>`;
  const wrapMods = [
    hasTimeline ? '' : 'is-empty',
    timelineVisible ? '' : 'is-locked',
    game.status === 'in' ? 'is-live' : '',   // minimize the conviction curve once live
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

  // Once the game starts, voting is closed — this column becomes a live game
  // feed (score + status + leaders) with a small bar of the viewer's own votes.
  // The feed is game-level, identical no matter which bet slot is selected.
  let voteHtml;
  if (gameStarted) {
    // Live MLB renders the command bar instead of this grid (handled below), so this
    // branch only runs for finals + non-MLB live games, which keep the feed.
    voteHtml = liveFeedHtml() + userVotesBarHtml();
  } else if (isViewer()) {
    voteHtml = `<div class="ca-dp-vote-title">Track this side</div>` +
      `<div class="ca-dp-vote-sub"><a onclick="openSignup()">Make an account</a> to track a verified pick on this game.</div>
    <div class="ca-vc-pair">
      ${mkVcBtn(_activeSlot, thisLabel, thisLineDisp, thisVotes, false, true)}
      ${oppKey ? mkVcBtn(oppKey, oppLabel, oppLineDisp, oppVotes, false, true) : ''}
    </div>`;
  } else {
    voteHtml = `<div class="ca-dp-vote-title">Track this side <span style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#08260f;background:#22c55e;padding:2px 6px;border-radius:999px;margin-left:6px;vertical-align:middle;">Verified</span></div>` +
      `<div class="ca-dp-vote-sub">One tap tracks it at the current line. Locks at tip-off, graded automatically.</div>
    <div class="ca-vc-pair">
      ${mkVcBtn(_activeSlot, thisLabel, thisLineDisp, thisVotes, userOnThis, false)}
      ${oppKey ? mkVcBtn(oppKey, oppLabel, oppLineDisp, oppVotes, userOnOpp, false) : ''}
    </div>`;
  }

  destroyPickTimeline();

  const isTrackerLive = liveNow;
  const classicBodyHtml = headerHtml +
    `<div class="ca-dp-grid${game.status === 'in' ? ' ca-dp-grid--live' : ''}">
      <div class="ca-dp-col">${pubHtml}</div>
      <div class="ca-dp-divider"></div>
      <div class="ca-dp-col ca-dp-vote-col">${voteHtml}</div>
    </div>`;
  if (isTrackerLive) {
    // Live game: the command bar takes over the body. The conviction curve already
    // lives in the header (per-pick); votes + start time ride in the command bar.
    el.innerHTML = headerHtml +
      `<div id="ca-live-command" class="ca-live-command"></div>`;
  } else {
    el.innerHTML = classicBodyHtml;
  }

  // Render the chart after innerHTML has settled. Always draw, even when
  // locked or empty, so the chart frame is visible with the overlay. Locked
  // users get a synthetic teaser (no real data on the canvas), not the real
  // curve blurred — that used to be legible through the blur. Skipped when live
  // (no chart canvas — the conviction bubble carries it instead).
  if (!isTrackerLive && typeof Chart !== 'undefined') {
    requestAnimationFrame(() => {
      if (timelineVisible) {
        drawPickTimeline(p?.timeline || [], MVP_THRESHOLD, 'ca-dp-timeline-chart');
      } else {
        const seed = String(gameId || '').split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
        drawLockedTeaser('ca-dp-timeline-chart', MVP_THRESHOLD, seed);
      }
    });
  }

  // Live command bar: mount + start the ~12s visibility-gated poll once the game
  // is live; tear it down otherwise. Re-runs on every slot change so the pulse
  // tracks the slot the user is viewing. Votes + start time are game-level, so
  // they ride along unchanged as the slot flips. on404: wiped historical games
  // have no live row — fall back to the classic post-game grid instead of
  // sitting on the loading state.
  if (isTrackerLive) mountLiveCommand({
    gameId, sport: (game.sport || 'MLB').toUpperCase(), activeSlot: _activeSlot,
    teams: {
      awayAbbr: (game.away_abbr || game.away_short || teamNick(game.away_team) || 'AWY').toUpperCase(),
      homeAbbr: (game.home_abbr || game.home_short || teamNick(game.home_team) || 'HOM').toUpperCase(),
      awayName: teamNick(game.away_team) || game.away_short || '',
      homeName: teamNick(game.home_team) || game.home_short || '',
    },
    betsHtml: liveBetsInlineHtml(),
    startLabel,
    on404: () => { el.innerHTML = classicBodyHtml; },
  });
  else unmountLiveCommand();

  // Paywall banner (non-live only — live games show the unlock badge in the header)
  if (!isPaying() && p && scoreHidden && !liveNow) {
    el.insertAdjacentHTML('beforeend', `
      <div class="ca-dp-unlock-row">
        <span class="ca-dp-unlock-text">Scores beyond #1 are unlocked for members.</span>
        <span class="ca-dp-unlock-link" onclick="openSignup()">Get access, from $1</span>
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
    renderDetailPanel();
    renderSentiment();
    return;
  }

  // New vote: open the Track-a-Bet sheet at this exact line (track.js is loaded
  // on this page). The betslip's confirm IS the vote — it writes the same
  // game_votes row, with the user's stake and odds attached. Fallback to the
  // plain vote POST if the module ever fails to load.
  if (window.openTrackForSlot) {
    window.openTrackForSlot(gameId, chosenSlot);
    return;
  }
  await doVoteRequest(gameId, chosenSlot, false);
  renderDetailPanel();
  renderSentiment();
}
window.handleVoteChoice = handleVoteChoice;

// The sheet confirms a track -> reflect it in this page's community counts
// without a reload. Server-side the vote row is already written.
document.addEventListener('ca:tracked', (e) => {
  const { id, slot, verified } = e.detail || {};
  if (!verified || !_data?.game || String(_data.game.espn_game_id) !== String(id)) return;
  if (!_data.votes) _data.votes = {};
  if (!_data.userVote) _data.userVote = {};
  if (!_data.userVote[slot]) {
    _data.votes[slot] = (_data.votes[slot] || 0) + 1;
    _data.userVote[slot] = true;
  }
  renderDetailPanel();
  renderSentiment();
  if (typeof renderCommunity === 'function') renderCommunity();
});

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

  // Every book the odds engine or the crons have stored appears here. Regulated
  // books first; offshore books group after them with a visible tag (their lines
  // are shown as information only, never linked).
  const OFFSHORE = new Set(['bovada', 'betonline', 'mybookie', 'betus', 'thunderpick', 'pinnacle']);
  const BOOK_LABEL = { draftkings: 'DraftKings', fanduel: 'FanDuel', betrivers: 'BetRivers', caesars: 'Caesars', betmgm: 'BetMGM', hardrock: 'Hard Rock', bovada: 'Bovada', betonline: 'BetOnline', pinnacle: 'Pinnacle', thunderpick: 'Thunderpick' };
  const label = (k) => BOOK_LABEL[k] || (k.charAt(0).toUpperCase() + k.slice(1));
  const offTag = `<span class="ca-lt-offshore" title="Offshore book. Line shown for information only.">offshore</span>`;

  const rows = [
    { book: 'Open (ESPN)', src: openGame,     prev: null },
    { book: 'DraftKings',  src: dk,           prev: dk   },
    { book: 'FanDuel',     src: fd,           prev: null },
  ];
  const extraKeys = Object.keys(lines || {}).filter(k => k !== 'draftkings' && k !== 'fanduel');
  for (const k of extraKeys.filter(k => !OFFSHORE.has(k)).sort()) rows.push({ book: label(k), src: lines[k], prev: null });
  for (const k of extraKeys.filter(k => OFFSHORE.has(k)).sort())  rows.push({ book: `${label(k)} ${offTag}`, src: lines[k], prev: null });

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
      // value users actually see on the lines table. centerTeam labels WHICH team
      // that spread belongs to (the home side) so "+1.5" isn't ambiguous.
      centerLine: homeSpread,
      centerTeam: homeName,
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
      centerTeam:          bt.centerTeam,
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
      centerTeam:          bt.centerTeam,
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
const FRESH_BAND_COLOR = { fresh: '#22c55e', moderate: '#eab308', elevated: '#f59e0b', heavy: '#f97316', overworked: '#ef4444' };

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

// Keep a coloured label readable on its pill: stay the team's own colour when it
// has enough contrast, otherwise flip to white / near-black so the active name
// never washes out on the coloured slider.
function _ensureReadable(fg, bg) {
  try {
    if (Math.abs(_luminance(fg) - _luminance(bg)) >= 0.32) return fg;
    return _luminance(bg) > 0.5 ? '#0b0f14' : '#ffffff';
  } catch (_) { return fg; }
}
// Lift a near-black brand colour so it stays legible as a name on the dark toggle.
function _legibleOnDark(hex) {
  try { return _luminance(hex) < 0.42 ? _lighten(hex, 0.42) : hex; } catch (_) { return hex; }
}
// Lift a very dark colour just enough to read as a bold pill fill on the card.
function _vividFill(hex) {
  try { return _luminance(hex) < 0.16 ? _lighten(hex, 0.30) : hex; } catch (_) { return hex; }
}

// Paint the away/home brand colours onto the toggle. Each name takes its own
// side's primary colour; the sliding pill takes the active side's SECONDARY colour
// for team sports, or the player's country colour for tennis (no secondary).
function _histPaintToggle() {
  const toggle = document.getElementById('ca-hist-toggle');
  if (!toggle) return;
  const away = teamColors(_data.game, false);
  const home = teamColors(_data.game, true);
  toggle.style.setProperty('--hist-away-color', _legibleOnDark(away.primary));
  toggle.style.setProperty('--hist-home-color', _legibleOnDark(home.primary));
  _histApplyActivePill();
}

// Set the slider's colour for whichever side is active. Re-run on every switch so
// the pill colour cross-fades as it slides across.
function _histApplyActivePill() {
  const toggle = document.getElementById('ca-hist-toggle');
  if (!toggle) return;
  const col  = teamColors(_data.game, _historyTeam === 'home');
  // Team sports: secondary colour fills the pill. Tennis: the country colour does.
  const pill = col.secondary ? col.secondary : _vividFill(col.primary);
  toggle.style.setProperty('--hist-slider-bg', pill);
  toggle.style.setProperty('--hist-active-text', _ensureReadable(col.primary, pill));
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

  // Players, not teams, for tennis.
  const title = section.querySelector('.ca-section-h2');
  if (title) title.textContent = histIsTennis() ? 'Player history' : 'Team history';

  const setAbbr = (team, txt) => {
    const el = document.querySelector(`#ca-hist-toggle .ca-hist-tab[data-team="${team}"] .ca-hist-tab-abbr`);
    if (el) el.textContent = txt;
  };
  setAbbr('away', (game.away_abbr || game.away_short || teamNick(game.away_team) || 'AWAY').toUpperCase());
  setAbbr('home', (game.home_abbr || game.home_short || teamNick(game.home_team) || 'HOME').toUpperCase());

  _histPaintToggle();

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
    _histApplyActivePill();
    // Brief brightness pop on the pill as it slides + recolours.
    const slider = toggle.querySelector('.ca-hist-toggle-slider');
    if (slider) { slider.classList.remove('ca-hist-pop'); void slider.offsetWidth; slider.classList.add('ca-hist-pop'); }
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
  wireHistTips();
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
    const wl   = res === 'W' ? 'w' : res === 'L' ? 'l' : 'n';
    const vs   = (g.homeAway === 'home' ? 'vs ' : '@ ') + (g.oppAbbr || g.oppName || '');
    const offP = Math.round(clampPct((g.pf - lo) / (hi - lo)) * 100);
    const defP = Math.round(clampPct((hi - g.pa) / (hi - lo)) * 100);
    const lead = (g.leaders || []).slice(0, 1).map(l =>
      `${esc(l.athlete || '')} ${esc(String(l.value))} ${esc((l.cat || '').slice(0, 3).toUpperCase())}`).join('');
    // No W/L chip — the row itself lights up green (win) or red (loss), like the
    // MVP-history rows: the result word + score carry the color.
    return `<div class="ca-hist-row ca-hist-row--${wl}" onclick="openHistGame('${esc(g.eventId)}')" role="button" tabindex="0">
      <span class="ca-hist-res ca-num">${res}</span>
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
    const opp = `${g.homeAway === 'home' ? 'vs ' : '@ '}${g.oppAbbr || g.oppName || ''}`;
    // Data attributes feed the instant custom hover banner (wireHistTips) — faster
    // and richer than a native title tooltip.
    return `<span class="ca-hist-mini ca-hist-mini--${w ? 'w' : 'l'}"` +
      ` data-res="${w ? 'W' : 'L'}" data-opp="${esc(opp)}" data-score="${esc(g.pf + '-' + g.pa)}" data-date="${esc(histDate(g.date))}">${m}</span>`;
  }).join('');
  return `<div class="ca-hist-last20"><div class="ca-hist-last20-label">Last ${games.length} · most recent first</div>` +
         `<div class="ca-hist-minirow">${cells}</div></div>`;
}

// Banner for the Last-20 chips: date, full score, opponent, result. The tooltip is
// a child of its chip row (absolutely positioned), so it scrolls WITH the chips
// instead of floating fixed over the page. It's clamped inside the row so it never
// runs off-screen, and has a speech-bubble arrow pointing at the tapped chip.
function wireHistTips() {
  document.querySelectorAll('.ca-hist-minirow').forEach(row => {
    if (row.dataset.tipWired) return;
    row.dataset.tipWired = '1';

    let tip = row.querySelector(':scope > .ca-hist-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'ca-hist-tip hidden';
      row.appendChild(tip);
    }

    const place = chip => {
      const win = chip.dataset.res === 'W';
      tip.innerHTML =
        `<span class="ca-hist-tip-res ca-hist-tip-res--${win ? 'w' : 'l'}">${win ? 'Win' : 'Loss'}</span>` +
        `<span class="ca-hist-tip-main">${esc(chip.dataset.opp)} <b>${esc(chip.dataset.score)}</b></span>` +
        `<span class="ca-hist-tip-date">${esc(chip.dataset.date)}</span>` +
        `<span class="ca-hist-tip-arrow"></span>`;
      tip.classList.remove('hidden');               // un-hide first so we can measure
      const rowW = row.clientWidth;
      const tipW = tip.offsetWidth, tipH = tip.offsetHeight;
      const cx = chip.offsetLeft + chip.offsetWidth / 2;
      const left = Math.max(2, Math.min(cx - tipW / 2, rowW - tipW - 2));
      const above = chip.offsetTop >= tipH + 10;    // top row → drop the tip below
      const top = above ? chip.offsetTop - tipH - 9 : chip.offsetTop + chip.offsetHeight + 9;
      tip.style.left = left + 'px';
      tip.style.top  = top + 'px';
      tip.classList.toggle('ca-hist-tip--below', !above);
      const arrow = tip.querySelector('.ca-hist-tip-arrow');
      if (arrow) arrow.style.left = Math.max(12, Math.min(cx - left, tipW - 12)) + 'px';
    };

    // Click-driven, state lives in the DOM (no hover race → no double-click glitch).
    // One click on a chip opens its tip + lifts the chip; clicking it again, another
    // chip, or anywhere off closes it.
    row.addEventListener('click', e => {
      const c = e.target.closest('.ca-hist-mini');
      if (!c) return;
      const wasActive = c.classList.contains('ca-hist-mini--active');
      row.querySelectorAll('.ca-hist-mini--active').forEach(x => x.classList.remove('ca-hist-mini--active'));
      tip.classList.add('hidden');
      if (!wasActive) { place(c); c.classList.add('ca-hist-mini--active'); }
    });
  });

  // Global dismiss: any click that isn't on a chip closes open tips + drops chips.
  if (!window.__histTipDismiss) {
    window.__histTipDismiss = true;
    document.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('.ca-hist-mini')) return;
      document.querySelectorAll('.ca-hist-minirow > .ca-hist-tip').forEach(t => t.classList.add('hidden'));
      document.querySelectorAll('.ca-hist-mini--active').forEach(c => c.classList.remove('ca-hist-mini--active'));
    }, true);
  }
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
    const wl  = res === 'W' ? 'w' : res === 'L' ? 'l' : 'n';
    const surf = m.surface ? `<span class="ca-hist-surface">${esc(m.surface)}</span>` : '';
    const tr = [m.tournament, m.round].filter(Boolean).map(esc).join(' · ');
    return `<div class="ca-hist-row ca-hist-row--tennis ca-hist-row--${wl}">
      <span class="ca-hist-res ca-num">${res}</span>
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
  // Our own calculations (Form + Load) lead, right after the player name; the raw
  // box-score stats follow. A separator marks where ESPN's stats begin.
  const head = `<tr><th class="ca-hp-th-name"></th>` +
    `<th class="ca-hp-th-ours">Form</th>` +
    `<th class="ca-tf-th ca-tf-why-th"></th>` +
    `<th class="ca-hp-th-ours">Load</th>` +
    labels.map((l, i) => {
      const tip = HIST_LABEL_TIPS[l];
      return `<th class="ca-num${i === 0 ? ' ca-hp-th-statstart' : ''}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(l)}</th>`;
    }).join('') +
    `</tr>`;
  const rows = blk.rows.slice().sort((a, b) => (b.starter ? 1 : 0) - (a.starter ? 1 : 0))
    .map(r => histPlayerRow(r, labels)).join('');
  return `<div class="ca-hp-blockwrap">` +
    (title ? `<div class="ca-hp-blocktitle">${esc(title)}</div>` : '') +
    `<div class="ca-hp-scroll"><table class="ca-hp-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div></div>`;
}

function histPlayerRow(r, labels) {
  const f = r.form || {};
  const cells = labels.map((l, i) =>
    `<td class="ca-num${i === 0 ? ' ca-hp-statstart' : ''}">${esc(r.statsArr[i] ?? '—')}</td>`).join('');
  return `<tr class="ca-hp-row${r.dnp ? ' ca-hp-dnp' : ''}">` +
    `<td class="ca-hp-name">${histNameCell(r, f)}</td>` +
    `<td class="ca-hp-formcell">${histFormCell(f.hotCold)}</td>` +
    `<td class="ca-tf-cell ca-tf-why">${tfWhyCell(f.hotCold)}</td>` +
    `<td class="ca-hp-loadcell">${histLoadCell(f.freshness)}</td>` +
    cells + `</tr>`;
}

// ── Mini "heat" gauge: the site's signature half-dome dial, shrunk to a table
// cell. `pct` (0–100) aims the needle. kind='form' runs cold→hot (ice → faded
// fire); kind='load' runs fresh→tired (green → red). A short colored label sits
// under the dial. Null pct renders an empty (greyed) dial.
let _mgUid = 0;
const MG_STOPS = {
  form: [['0%', '#38bdf8'], ['50%', '#8b93a7'], ['78%', '#fb923c'], ['100%', '#ef4444']],
  load: [['0%', '#22c55e'], ['45%', '#eab308'], ['72%', '#f97316'], ['100%', '#ef4444']],
};
function miniHeatGauge({ pct, kind, label, labelColor, tip, muted }) {
  const has = pct != null && Number.isFinite(pct);
  const p   = has ? Math.max(0, Math.min(100, pct)) : 50;
  const deg = Math.max(-90, Math.min(90, (p - 50) * 1.8));
  const uid = `mg${++_mgUid}`;
  const cx = 50, cy = 50, r = 44;
  const disc   = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} Z`;
  const nLen = 33, hw = 2.2, tipHalf = hw + 4, tipY = cy - nLen, tip2 = cy - nLen + 8;
  const needle = `M ${cx} ${tipY} L ${cx + tipHalf} ${tip2} L ${cx + hw} ${tip2} ` +
                 `L ${cx + hw} ${cy - 3} L ${cx - hw} ${cy - 3} L ${cx - hw} ${tip2} L ${cx - tipHalf} ${tip2} Z`;
  const stops = (MG_STOPS[kind] || MG_STOPS.load).map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
  const lbl = label ? `<span class="ca-mg-lbl" style="${labelColor ? `color:${labelColor};` : ''}">${esc(label)}</span>` : '';
  return `<span class="ca-mg${has ? '' : ' ca-mg--empty'}"${tip ? ` title="${esc(tip)}"` : ''}>` +
    `<svg class="ca-mg-svg" viewBox="0 0 100 56" aria-hidden="true">` +
      `<defs><linearGradient id="${uid}" x1="0%" x2="100%" y1="50%" y2="50%">${stops}</linearGradient></defs>` +
      `<path d="${disc}" fill="${has ? `url(#${uid})` : '#1e2330'}"/>` +
      `<path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="rgba(0,0,0,0.3)" stroke-width="1"/>` +
      (has ? `<g transform="rotate(${deg.toFixed(1)} ${cx} ${cy})">` +
        `<path d="${needle}" fill="#0b0e14" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/>` +
        `<circle cx="${cx}" cy="${cy}" r="3.4" fill="#0b0e14" stroke="#ffffff" stroke-width="1"/>` +
        `</g>` : '') +
    `</svg>${lbl}</span>`;
}

function histNameCell(r, f) {
  const star = r.starter ? `<span class="ca-hp-starter" title="Starter">★</span>` : '';
  const pos  = r.pos ? `<span class="ca-hp-pos">${esc(r.pos)}</span>` : '';
  // Under the name: his recognizable season averages going into this game.
  return `<div class="ca-hp-namerow">${star}<span class="ca-hp-pname">${esc(r.shortName || r.name)}</span>${pos}</div>${keyAvgsHtml(r)}`;
}

// Form dial: you're hot or you're cold. The needle leans toward fire (playing
// well vs the player's baseline) or ice (slumping). Label reads HOT / EVEN / COLD.
// Continuous cold→hot tint for the form word + explanation, so a slight lean
// (even-but-warming) reads slightly warm. `dim` = the body-text variant; vivid is
// for the dial word. 0 = cold (ice), 50 = even (grey), 100 = hot (fire).
function _lerpHex(a, b, t) {
  const n = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const ca = n(a), cb = n(b);
  return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
// Multi-stop gradient: deep blue → ice → grey → orange → deep red, so "really hot"
// actually reaches red (and "really cold" deep blue), not just a mild tint.
const FORM_STOPS = {
  vivid: [[0, '#2f6f99'], [28, '#38bdf8'], [50, '#9aa3b4'], [74, '#fb923c'], [100, '#ef4444']],
  dim:   [[0, '#3a6478'], [28, '#4f93b0'], [50, '#8892a4'], [74, '#c46a2a'], [100, '#c0392b']],
};
function _gradAt(stops, pct) {
  const p = Math.max(0, Math.min(100, pct));
  for (let i = 1; i < stops.length; i++) {
    if (p <= stops[i][0]) {
      const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
      return _lerpHex(c0, c1, (p - p0) / (p1 - p0 || 1));
    }
  }
  return stops[stops.length - 1][1];
}
// Steeper z→position so a genuine hot/cold stretch reaches the ends of the dial.
// z 0 = 50 (even/center); z ~±2 maxes out. Was z×16.7 (needed z≈3 — too tame).
function formPct(hc) {
  if (!hc) return 50;
  return hc.z != null ? Math.max(0, Math.min(100, 50 + hc.z * 24))
    : ({ hot: 92, warm: 70, neutral: 50, cool: 30, cold: 8 }[hc.bucket] ?? 50);
}
function formTint(pct, dim) {
  return _gradAt(dim ? FORM_STOPS.dim : FORM_STOPS.vivid, pct);
}

function histFormCell(hc) {
  if (!hc || !hc.bucket || hc.bucket === 'na') {
    return miniHeatGauge({ pct: null, kind: 'form', label: '—', tip: 'Not enough games yet' });
  }
  const pct = formPct(hc);
  // Pitchers read command (K-BB) as sharp ↔ wild; everyone else hot ↔ cold.
  const isPitcher = hc.primaryName === 'K-BB';
  const hi = hc.bucket === 'hot' || hc.bucket === 'warm';
  const lo = hc.bucket === 'cold' || hc.bucket === 'cool';
  let label;
  if (isPitcher) {
    label = ({ hot: 'SHARP', warm: 'SEMI-SHARP', neutral: 'EVEN', cool: 'SEMI-WILD', cold: 'WILD' })[hc.bucket] || 'EVEN';
  } else {
    label = hi ? 'HOT' : lo ? 'COLD' : 'EVEN';
  }
  const color = formTint(pct, false); // continuous tint → "even" leans warm/cool
  const low = hc.n != null && hc.n < 10; // few recent games → noted in tooltip
  const tip = `${hc.primaryName} ${isPitcher ? 'command' : 'form'}: recent vs trailing avg${hc.z != null ? ` (z ${hc.z})` : ''}${low ? ` · limited sample (${hc.n} g)` : ''}`;
  return miniHeatGauge({ pct, kind: 'form', label, labelColor: color, tip });
}

// Load dial: fresh and clean on the left, tired and taxed on the right. Label
// reads the workload band (rest + schedule density, not injury risk).
const LOAD_WORD = { fresh: 'Fresh', moderate: 'Moderate', elevated: 'Elevated', heavy: 'Heavy', overworked: 'Very Heavy' };
function histLoadCell(fr) {
  if (!fr || fr.score == null) {
    return miniHeatGauge({ pct: null, kind: 'load', label: '—', tip: fr && fr.note ? fr.note : 'No load data' });
  }
  const color = FRESH_BAND_COLOR[fr.band] || '#eab308';
  const word  = LOAD_WORD[fr.band] || '';
  const low   = fr.n != null && fr.n < 5; // few recent games → noted in tooltip
  const tip = `Player load ${fr.score}/100${fr.note ? ' · ' + fr.note : ''} (workload and rest, not injury risk)${low ? ` · limited sample (${fr.n} g)` : ''}`;
  return miniHeatGauge({ pct: fr.score, kind: 'load', label: word, labelColor: color, tip });
}

// ── Team Form section (forward-looking: each player's shape going INTO tonight) ─
// Reuses the History tab's dials (Form = hot/cold, Load = fresh/tired) and team
// toggle, but the data is "as of tonight" instead of a past box score. Backend:
// /api/game-form. Tennis renders a single-player card from /api/tennis-history.
function _tfPaintToggle() {
  const toggle = document.getElementById('ca-tf-toggle');
  if (!toggle) return;
  const away = teamColors(_data.game, false);
  const home = teamColors(_data.game, true);
  toggle.style.setProperty('--hist-away-color', _legibleOnDark(away.primary));
  toggle.style.setProperty('--hist-home-color', _legibleOnDark(home.primary));
  _tfApplyActivePill();
}
function _tfApplyActivePill() {
  const toggle = document.getElementById('ca-tf-toggle');
  if (!toggle) return;
  const col  = teamColors(_data.game, _tfTeam === 'home');
  const pill = col.secondary ? col.secondary : _vividFill(col.primary);
  toggle.style.setProperty('--hist-slider-bg', pill);
  toggle.style.setProperty('--hist-active-text', _ensureReadable(col.primary, pill));
}

async function renderTeamForm() {
  const section = document.getElementById('teamform');
  if (!section) return;
  if (!histSportSupported()) { section.style.display = 'none'; return; }

  section.style.display = '';
  const { game } = _data;
  const tennis = histIsTennis();
  // Individual sports (tennis, golf) read "Player Form"; team sports "Team Form".
  const individual = tennis || (game.sport || '').toUpperCase() === 'GOLF';

  const navS = document.getElementById('ca-nav-teamform');
  const navM = document.getElementById('ca-mtab-teamform');
  if (navS) { navS.style.display = ''; navS.textContent = individual ? 'Player Form' : 'Team Form'; }
  if (navM) { navM.style.display = ''; navM.textContent = 'FORM'; }

  const title = document.getElementById('ca-tf-title');
  if (title) title.textContent = individual ? 'Player form' : 'Team form';
  const sub = document.getElementById('ca-tf-sub');
  if (sub) sub.innerHTML = tennis
    ? `Each player's form and load going into this match. <b>Form</b> is recent results; <b>load</b> is matches played and rest, not injury risk.`
    : `Each player's form and load going into tonight's game. <b>Form</b> is recent play vs their own baseline; <b>load</b> is rest and recent workload, not injury risk.`;

  const setAbbr = (team, txt) => {
    const el = document.querySelector(`#ca-tf-toggle .ca-hist-tab[data-team="${team}"] .ca-hist-tab-abbr`);
    if (el) el.textContent = txt;
  };
  setAbbr('away', (game.away_abbr || game.away_short || teamNick(game.away_team) || 'AWAY').toUpperCase());
  setAbbr('home', (game.home_abbr || game.home_short || teamNick(game.home_team) || 'HOME').toUpperCase());

  _tfPaintToggle();

  const toggle = document.getElementById('ca-tf-toggle');
  if (toggle && !toggle.dataset.wired) {
    toggle.dataset.wired = '1';
    toggle.querySelectorAll('.ca-hist-tab').forEach(btn =>
      btn.addEventListener('click', () => selectTeamFormTeam(btn.dataset.team)));
  }
  await loadAndPaintTeamForm();
}

function selectTeamFormTeam(team) {
  if (team !== 'away' && team !== 'home') return;
  if (team === _tfTeam) return;
  _tfTeam = team;
  // keep the current stat group (Batting/Pitching) — paintTeamForm re-resolves it by type
  const toggle = document.getElementById('ca-tf-toggle');
  if (toggle) {
    toggle.querySelectorAll('.ca-hist-tab').forEach(b => b.classList.toggle('active', b.dataset.team === team));
    toggle.classList.toggle('ca-hist-toggle--home', team === 'home');
    _tfApplyActivePill();
    const slider = toggle.querySelector('.ca-hist-toggle-slider');
    if (slider) { slider.classList.remove('ca-hist-pop'); void slider.offsetWidth; slider.classList.add('ca-hist-pop'); }
  }
  const body = document.getElementById('ca-tf-body');
  if (body) body.classList.add('ca-hist-fading');
  setTimeout(() => {
    loadAndPaintTeamForm().finally(() => {
      document.getElementById('ca-tf-body')?.classList.remove('ca-hist-fading');
    });
  }, 140);
}

function tfOppId(team) {
  return team === 'home' ? _data.stats?.awayTeamId : _data.stats?.homeTeamId;
}

async function loadAndPaintTeamForm() {
  const body = document.getElementById('ca-tf-body');
  if (!body) return;
  const sport = (_data.game.sport || '').toUpperCase();

  if (histIsTennis()) { await loadTennisForm(body, sport); return; }

  const teamId = histTeamId(_tfTeam);
  if (!teamId) { body.innerHTML = `<div class="ca-hist-empty">No player data on record.</div>`; return; }

  const cacheKey = `${sport}:${teamId}`;
  if (_tfCache[cacheKey]) { paintTeamForm(_tfCache[cacheKey]); return; }

  body.innerHTML = `<div class="ca-hist-loading">Loading player form…</div>`;
  try {
    const oppId = tfOppId(_tfTeam) || '';
    const url = `/api/game-form?event=${encodeURIComponent(_data.game.espn_game_id)}` +
      `&teamId=${encodeURIComponent(teamId)}&sport=${encodeURIComponent(sport)}` +
      `&date=${encodeURIComponent(_data.game.start_time || '')}&oppId=${encodeURIComponent(oppId)}`;
    const data = await (await fetch(url)).json();
    if (!data || data.unsupported || data.unavailable || !(data.blocks && data.blocks.length)) {
      body.innerHTML = `<div class="ca-hist-empty">No player form on record yet.</div>`;
      return;
    }
    _tfCache[cacheKey] = data;
    if (histTeamId(_tfTeam) === teamId) paintTeamForm(data); // user may have toggled mid-fetch
  } catch (_) {
    body.innerHTML = `<div class="ca-hist-empty">Could not load player form.</div>`;
  }
}

function paintTeamForm(data) {
  const body = document.getElementById('ca-tf-body');
  if (!body) return;
  const blocks = data.blocks || [];
  // Keep the user on the same stat group (e.g. Pitching) when they switch teams.
  if (_tfBlockType) {
    const i = blocks.findIndex(b => b.type === _tfBlockType);
    if (i >= 0) _tfBlockIdx = i;
  }
  if (_tfBlockIdx >= blocks.length) _tfBlockIdx = 0;
  const injMap = tfInjuryMap(_tfTeam);
  const blk = blocks[_tfBlockIdx];
  // Toggle on the left, team chips (ATS/O-U + travel) on the right of one row.
  const toggle = tfBlockToggleHtml(blocks);
  const chips  = tfTeamChips(data);
  const controls = (toggle || chips)
    ? `<div class="ca-tf-controls">${toggle || '<span></span>'}<div class="ca-tf-teamchips">${chips}</div></div>`
    : '';
  body.innerHTML =
    controls +
    (blk ? tfBlockTable(blk, injMap) : `<div class="ca-hist-empty">No players to show.</div>`) +
    `<div class="ca-hist-caption">Form is recent production vs the player's own baseline. Load blends rest and recent workload (not injury risk). Splits use recent games only.</div>`;

  body.querySelectorAll('.ca-tf-blocktab').forEach(b => b.addEventListener('click', () => {
    const i = parseInt(b.dataset.idx, 10);
    if (i === _tfBlockIdx) return;
    _tfBlockIdx = i;
    _tfBlockType = (blocks[i] || {}).type || null;
    paintTeamForm(data);
  }));
}

// Build a name → {status, detail} map from the injuries already in the payload,
// so the Status column needs no extra fetch.
function tfInjuryMap(team) {
  const inj = _data.stats?.injuries?.[team];
  const map = {};
  (inj?.players || []).forEach(p => {
    if (p.player)    map[p.player.toLowerCase()]    = { status: p.status, detail: p.detail };
    if (p.shortName) map[p.shortName.toLowerCase()] = { status: p.status, detail: p.detail };
  });
  return map;
}

// Team-level chips (ATS / O-U trend + travel), shown to the right of the
// Batting/Pitching toggle so they don't take their own stacked row.
function tfTeamChips(data) {
  const b = data.betting;
  const chips = [];
  if (b && b.ats) { const { w, l, p, n } = b.ats; chips.push(
    `<span class="ca-tf-trendchip"><span class="ca-tf-trendlbl">ATS · last ${n}</span><span class="ca-tf-trendval ca-num">${w}-${l}${p ? '-' + p : ''}</span></span>`); }
  if (b && b.ou)  { const { over, under, push, n } = b.ou; chips.push(
    `<span class="ca-tf-trendchip"><span class="ca-tf-trendlbl">O/U · last ${n}</span><span class="ca-tf-trendval ca-num">${over}-${under}${push ? '-' + push : ''}</span></span>`); }
  if (data.travel) chips.push(
    `<span class="ca-tf-trendchip"><span class="ca-tf-trendlbl">Travel</span><span class="ca-tf-trendval">${esc(data.travel)}</span></span>`);
  return chips.join('');
}

function tfBlockLabel(b) {
  const t = (b.type || '').toString();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Players';
}
function tfBlockToggleHtml(blocks) {
  if (!blocks || blocks.length < 2) return '';
  const tabs = blocks.map((b, i) =>
    `<button type="button" class="ca-tf-blocktab${i === _tfBlockIdx ? ' active' : ''}" data-idx="${i}">${esc(tfBlockLabel(b))}</button>`
  ).join('');
  return `<div class="ca-tf-blocktoggle">${tabs}</div>`;
}

function tfBlockTable(blk, injMap) {
  // The 4th column is ERA — MLB pitchers only. Hitters and other sports don't get
  // one (recent production already shows in the name cell; usage Trend is redundant
  // with Load). So those tables are Name · Form · Load · Splits · Status.
  const isMlb = (_data.game.sport || '').toUpperCase() === 'MLB';
  const isBat = blk.role === 'batter';
  const has4  = isMlb && blk.role === 'pitcher';
  const cols  = (has4 ? 6 : 5) + 1; // +1 for the "Why" explanation column

  const sorted = blk.rows.slice().sort((a, b) => (b.starter ? 1 : 0) - (a.starter ? 1 : 0));
  const grp = label => `<tr class="ca-tf-grouprow"><td colspan="${cols}">${esc(label)}</td></tr>`;
  let body;
  if (blk.hasGameStarter) {
    const sp   = sorted.filter(r => r.gameStarter);
    const rest = sorted.filter(r => !r.gameStarter);
    body = grp('Starting pitcher') + sp.map(r => tfPlayerRow(r, injMap, has4)).join('') +
      (rest.length ? grp('Bullpen') + rest.map(r => tfPlayerRow(r, injMap, has4)).join('') : '');
  } else {
    body = sorted.map(r => tfPlayerRow(r, injMap, has4)).join('');
  }

  const nameHdr = (isMlb && isBat)
    ? `<span class="ca-tf-lineuptag${blk.lineupConfirmed ? ' is-confirmed' : ''}" title="${blk.lineupConfirmed ? 'Posted lineup for tonight' : 'Lineup not posted yet (showing last game order)'}">${blk.lineupConfirmed ? 'Lineup confirmed' : 'Projected order'}</span>`
    : '';
  const col4Hdr = has4 ? `<th class="ca-tf-th">ERA</th>` : '';
  const head = `<tr>` +
    `<th class="ca-hp-th-name">${nameHdr}</th>` +
    `<th class="ca-hp-th-ours">Form</th>` +
    `<th class="ca-tf-th ca-tf-why-th"></th>` +
    `<th class="ca-hp-th-ours">Load</th>` +
    col4Hdr +
    `<th class="ca-tf-th">Splits</th>` +
    `<th class="ca-tf-th">Status</th>` +
    `</tr>`;
  return `<div class="ca-hp-scroll"><table class="ca-hp-table ca-tf-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function tfPlayerRow(r, injMap, has4) {
  // 4th column = ERA (MLB pitchers only).
  const col4 = has4 ? `<td class="ca-tf-cell">${tfRecentCell(r.recent)}</td>` : '';
  return `<tr class="ca-hp-row">` +
    `<td class="ca-hp-name">${tfNameCell(r)}</td>` +
    `<td class="ca-hp-formcell">${histFormCell(r.form)}</td>` +
    `<td class="ca-tf-cell ca-tf-why">${tfWhyCell(r.form)}</td>` +
    `<td class="ca-hp-loadcell">${histLoadCell(r.load)}</td>` +
    col4 +
    `<td class="ca-tf-cell">${tfSplitCell(r.splits)}</td>` +
    `<td class="ca-tf-cell">${tfStatusCell(r, injMap)}</td>` +
    `</tr>`;
}

// Plain explanation of the Form reading (from the engine's `reasons`), tinted to
// the form level (hot → orange, warm → amber, cold → ice, etc.).
function tfWhyCell(hc) {
  const reasons = (hc && hc.reasons) || [];
  if (!reasons.length) return `<span class="ca-tf-dash">—</span>`;
  const color = formTint(formPct(hc), true); // dim continuous tint, matches the lean
  return `<span class="ca-tf-why-text" style="color:${color}">${reasons.map(esc).join(' ')}</span>`;
}

function tfRecentCell(rec) {
  if (!rec || !rec.text) return `<span class="ca-tf-dash" title="Not enough recent games yet">—</span>`;
  const tone = ['hot', 'cold', 'good', 'bad'].includes(rec.tone) ? rec.tone : 'neutral';
  // ERA window varies by role (≈3 starts vs ≈10 relief outings), so show its game
  // count per cell. Hitter notes are uniformly last-5 (shown once in the header).
  const gp = rec.n ? ` <span class="ca-tf-recentsub">(${rec.n} GP)</span>` : '';
  return `<span class="ca-tf-recentnote ca-tf-recentnote--${tone}">${esc(rec.text)}</span>${gp}`;
}

// Recognizable season averages under a name (bases/gm · AVG for hitters, etc.).
function keyAvgsHtml(r) {
  const ks = r.keyAvgs || [];
  if (!ks.length) return '';
  const items = ks.map(a =>
    `<span class="ca-tf-kavg"><span class="ca-tf-kavg-val ca-num">${esc(a.val)}</span> <span class="ca-tf-kavg-lbl">${esc(a.label)}</span></span>`
  ).join('<span class="ca-tf-kavg-sep">·</span>');
  return `<div class="ca-tf-recent">${items}</div>`;
}

function tfNameCell(r) {
  // Batting-order number for hitters; nothing otherwise (no starter star).
  const badge = r.lineupSpot
    ? `<span class="ca-tf-spot" title="Lineup spot">${r.lineupSpot}</span>`
    : '';
  const pos  = r.pos ? `<span class="ca-hp-pos">${esc(r.pos)}</span>` : '';
  return `<div class="ca-hp-namerow">${badge}<span class="ca-hp-pname">${esc(r.shortName || r.name)}</span>${pos}</div>${keyAvgsHtml(r)}`;
}

function tfTrendCell(u) {
  if (!u || u.recent == null) return `<span class="ca-tf-dash" title="Not enough recent appearances for a workload trend">—</span>`;
  const arrow = u.dir === 'up' ? '▲' : u.dir === 'down' ? '▼' : '▬';
  const cls   = u.dir === 'up' ? 'up' : u.dir === 'down' ? 'down' : 'flat';
  const tip   = `${u.unit} recent ${u.recent}${u.prior != null ? ' vs ' + u.prior + ' before' : ''}`;
  return `<span class="ca-tf-trend ca-tf-trend--${cls}" title="${esc(tip)}">` +
    `<span class="ca-tf-arrow">${arrow}</span> <span class="ca-num">${esc(String(u.recent))}</span> <span class="ca-tf-unit">${esc(u.unit)}</span></span>`;
}

// Splits read as "average <stat> in this player's home vs road games, and vs
// tonight's opponent." Stat label is shown so the numbers are self-explanatory;
// the opponent's real abbreviation replaces a generic "opp".
function tfSplitCell(s) {
  if (!s) return `<span class="ca-tf-dash">—</span>`;
  const g = _data.game;
  const oppAbbr = (_tfTeam === 'home'
    ? (g.away_abbr || g.away_short || teamNick(g.away_team))
    : (g.home_abbr || g.home_short || teamNick(g.home_team))) || 'opp';
  const lines = [];
  if ((s.home && s.home.avg != null) || (s.away && s.away.avg != null)) {
    const h = s.home && s.home.avg != null ? s.home.avg : '—';
    const r = s.away && s.away.avg != null ? s.away.avg : '—';
    lines.push(`<span class="ca-tf-split-ha" title="Average ${esc(s.label)} in home vs road games">Home ${h} · Road ${r}</span>`);
  }
  if (s.vsOpp && s.vsOpp.avg != null) {
    lines.push(`<span class="ca-tf-split-opp" title="Average ${esc(s.label)} vs ${esc(oppAbbr)} (${s.vsOpp.n} game${s.vsOpp.n === 1 ? '' : 's'})">vs ${esc(oppAbbr)} ${s.vsOpp.avg}</span>`);
  }
  if (!lines.length) return `<span class="ca-tf-dash">—</span>`;
  return `<div class="ca-tf-splits"><span class="ca-tf-split-stat">${esc(s.label)}</span>${lines.join('')}</div>`;
}

const TF_INJ_SHORT = {
  'Out': 'OUT', 'Doubtful': 'DOUBT', 'Questionable': 'QUEST', 'Probable': 'PROB',
  'Day-To-Day': 'DTD', 'Game Time Decision': 'GTD', 'Injured Reserve': 'IR', 'Suspension': 'SUSP',
};
function tfInjClass(s) {
  s = (s || '').toLowerCase();
  if (s.includes('out') || s.includes('reserve') || s === 'ir' || s.includes('doubt') || s.includes('susp')) return 'out';
  if (s.includes('quest') || s.includes('day') || s.includes('game time') || s.includes('gtd')) return 'quest';
  if (s.includes('prob')) return 'prob';
  return 'quest';
}
function tfShorten(s, n) { s = (s || '').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }

// Status = availability going in. A short code chip (OUT / QUEST / Back / Active)
// with a one-line note beneath it, and the full picture on hover. When ESPN still
// lists the player we show the reason; for someone already back in the lineup ESPN
// drops them, so we describe the absence we can see (games sat / days off).
function tfStatusChip(cls, code, note, tip) {
  const noteHtml = note ? `<div class="ca-tf-statusnote">${esc(note)}</div>` : '';
  return `<div class="ca-tf-statuswrap"${tip ? ` title="${esc(tip)}"` : ''}>` +
    `<span class="ca-tf-status ca-tf-status--${cls}">${esc(code)}</span>${noteHtml}</div>`;
}
function tfStatusCell(r, injMap) {
  const inj = injMap[(r.name || '').toLowerCase()] || injMap[(r.shortName || '').toLowerCase()];
  const a = r.absence;

  if (inj && inj.status) {
    const cls    = tfInjClass(inj.status);
    const code   = TF_INJ_SHORT[inj.status] || inj.status.toUpperCase();
    const reason = inj.detail ? tfShorten(inj.detail, 26) : '';
    const sat    = a && a.missed ? `sat ${a.missed} of last 10` : '';
    const note   = [reason, sat].filter(Boolean).join(' · ');
    const tip    = [inj.status, inj.detail,
      a && a.missed ? `missed ${a.missed} of last 10 team games` : '',
      a && a.daysSince != null ? `${a.daysSince}d since last game` : ''].filter(Boolean).join(' · ');
    return tfStatusChip(cls, code, note, tip);
  }

  if (a && a.layoff) {
    return tfStatusChip('back', 'Back', `${a.daysSince}d off`,
      `Returned after a layoff — ${a.daysSince} days since last game`);
  }
  if (a && a.missed) {
    const code = a.playedLast ? 'Back' : 'Out';
    const note = `sat ${a.missed} of last 10`;
    const tip  = `Missed ${a.missed} of last 10 team games${a.daysSince != null ? ` · ${a.daysSince}d since last game` : ''}`;
    return tfStatusChip(a.playedLast ? 'back' : 'out', code, note, tip);
  }
  return tfStatusChip('ok', 'Active', '', '');
}

// Tennis: a single-player card (the toggle switches which player). Form derived
// from recent win rate; load is the same freshness dial used everywhere else.
function tfTennisHotCold(f) {
  if (!f || f.winPct == null) return null;
  const wp = f.winPct;
  const bucket = wp >= 70 ? 'hot' : wp >= 58 ? 'warm' : wp >= 43 ? 'neutral' : wp >= 30 ? 'cool' : 'cold';
  return { bucket, z: null, recent: null, baseline: null, n: (f.wins || 0) + (f.losses || 0), primaryName: 'W%' };
}
async function loadTennisForm(body, sport) {
  const player = _tfTeam === 'home' ? _data.game.home_team : _data.game.away_team;
  if (!player) { body.innerHTML = `<div class="ca-hist-empty">No player data on record.</div>`; return; }
  const cacheKey = `T:${sport}:${player}`;
  if (_tfCache[cacheKey]) { paintTennisForm(_tfCache[cacheKey], player); return; }
  body.innerHTML = `<div class="ca-hist-loading">Loading player form…</div>`;
  try {
    const url = `/api/tennis-history?player=${encodeURIComponent(player)}&sport=${sport}&date=${encodeURIComponent(_data.game.start_time || '')}`;
    const data = await (await fetch(url)).json();
    if (!data || data.unsupported || data.unavailable || !data.form) {
      body.innerHTML = `<div class="ca-hist-empty">No player form on record.</div>`;
      return;
    }
    _tfCache[cacheKey] = data;
    const stillActive = (_tfTeam === 'home' ? _data.game.home_team : _data.game.away_team) === player;
    if (stillActive) paintTennisForm(data, player);
  } catch (_) {
    body.innerHTML = `<div class="ca-hist-empty">Could not load player form.</div>`;
  }
}
function paintTennisForm(data, player) {
  const body = document.getElementById('ca-tf-body');
  if (!body) return;
  const f  = data.form || {};
  const fr = data.freshness;
  const last5 = (f.lastFive || []).map(r =>
    `<span class="ca-hist-formdot ca-hist-formdot--${r === 'W' ? 'w' : 'l'}">${r}</span>`).join('') || '—';
  const formGauge = histFormCell(tfTennisHotCold(f));
  const loadGauge = fr && fr.score != null ? histLoadCell(fr)
    : miniHeatGauge({ pct: null, kind: 'load', label: '—', tip: 'No load data' });
  body.innerHTML =
    `<div class="ca-tf-tennis">` +
      `<div class="ca-tf-tennis-name">${esc(lastNameOf(player))}</div>` +
      `<div class="ca-tf-tennis-dials">` +
        `<div class="ca-tf-tennis-dial"><div class="ca-tf-tennis-diallbl">Form</div>${formGauge}</div>` +
        `<div class="ca-tf-tennis-dial"><div class="ca-tf-tennis-diallbl">Load</div>${loadGauge}</div>` +
      `</div>` +
      `<div class="ca-tf-tennis-stats">` +
        `<div class="ca-hist-stat"><div class="ca-hist-stat-val ca-num">${f.record ?? '—'}</div><div class="ca-hist-stat-label">Last ${(f.wins || 0) + (f.losses || 0)}</div></div>` +
        `<div class="ca-hist-stat"><div class="ca-hist-stat-val ca-num">${f.winPct != null ? f.winPct + '%' : '—'}</div><div class="ca-hist-stat-label">Win rate</div></div>` +
        `<div class="ca-hist-stat"><div class="ca-hist-formrow">${last5}</div><div class="ca-hist-stat-label">Last 5</div></div>` +
      `</div>` +
    `</div>` +
    `<div class="ca-hist-caption">Form is recent results; load is matches played plus days rest, not injury risk.</div>`;
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
