// game-detail.js — Client-side module for the standalone game detail page.
// Reads window.__GAME_DATA__ and renders all dynamic content.
// Companion to src/detail_page.js + public/game-detail.css

import { checkAuth, isPaying, isViewer,
         openLogin, closeLogin, doLogin, openSignup, closeSignup, doSignup,
         doLogout, showForgotPassword, showLoginForm, doForgotPassword } from '/modules/auth.js';
import { fmtOdds, fmtSpread, PICK_HEAT_COLOR } from '/modules/utils.js';

// Expose auth functions to window (needed by inline onclick handlers in HTML)
Object.assign(window, {
  openLogin, closeLogin, doLogin, openSignup, closeSignup, doSignup,
  doLogout, showForgotPassword, showLoginForm, doForgotPassword,
  setLinesType, selectSlot, doBack,
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

  // Auth state
  await checkAuth();

  // Determine initial slot from ?slot= query param, else top-scored
  _activeSlot = resolveInitialSlot();

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

  // Update sidebar/mobile-tabs top offset to clear the sticky header
  updateStickyOffset();
  window.addEventListener('resize', updateStickyOffset);

  // Sticky nav scroll-spy
  initScrollSpy();

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
  return [
    { key: 'away_ml',     label: teamNick(game.away_team) + ' Win',      type: 'ml',     team: game.away_team },
    { key: 'home_ml',     label: teamNick(game.home_team) + ' Win',      type: 'ml',     team: game.home_team },
    { key: 'away_spread', label: teamNick(game.away_team) + ' Spread',   type: 'spread', team: game.away_team },
    { key: 'home_spread', label: teamNick(game.home_team) + ' Spread',   type: 'spread', team: game.home_team },
    { key: 'over',        label: `Over${ou != null ? ' ' + ou : ''}`,    type: 'over',   team: null },
    { key: 'under',       label: `Under${ou != null ? ' ' + ou : ''}`,   type: 'under',  team: null },
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

function teamColors(game, isHome) {
  if (!_teamColors) return FALLBACK_COLORS;
  const sport  = (game.sport || '').toUpperCase();
  const abbr   = isHome
    ? (game.home_abbr || game.home_short || '').toUpperCase()
    : (game.away_abbr || game.away_short || '').toUpperCase();
  const bucket = _teamColors[sport] || {};
  return bucket[abbr] || FALLBACK_COLORS;
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
  if (awayEl) { awayEl.style.background = awayC.primary; }
  if (homeEl) { homeEl.style.background = homeC.primary; }
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

    // Type label — use WIN instead of ML
    const typeLabel = (slot.type === 'ml') ? 'WIN'
      : (slot.type === 'over' || slot.type === 'under') ? 'TOTAL'
      : slot.type.toUpperCase();

    // Pick identification line: abbr + formatted line value
    const abbr = (() => {
      if (slot.key === 'home_ml' || slot.key === 'home_spread')
        return (game.home_abbr || game.home_short || '').toUpperCase() || teamNick(game.home_team);
      if (slot.key === 'away_ml' || slot.key === 'away_spread')
        return (game.away_abbr || game.away_short || '').toUpperCase() || teamNick(game.away_team);
      return null;
    })();

    const lineVal = slotLineCurrent(slot.key, game);
    let pickIdent = '';
    if (slot.key === 'over')  pickIdent = game.over_under != null ? `Over ${game.over_under}` : 'Over';
    else if (slot.key === 'under') pickIdent = game.over_under != null ? `Under ${game.over_under}` : 'Under';
    else if (slot.type === 'ml') pickIdent = abbr || '—';
    else pickIdent = abbr && lineVal ? `${abbr} ${lineVal}` : (lineVal || abbr || '—');


    // Score area
    let scoreAreaHtml = '';
    if (isLocked) {
      // Lock icon for all non-#1 chips — blur score if has one, else just icon
      if (noPick) {
        scoreAreaHtml = `<div class="ca-slot-score-area">
          <span class="ca-slot-lock-solo"><i class="fa-solid fa-lock"></i></span>
        </div>`;
      } else {
        scoreAreaHtml = `<div class="ca-slot-score-area">
          <div class="ca-slot-locked-wrap">
            <span class="ca-slot-pts ca-blurred" aria-hidden="true">${score}</span>
            <span class="ca-slot-lock-overlay"><i class="fa-solid fa-lock"></i></span>
          </div>
        </div>`;
      }
    } else if (noPick) {
      scoreAreaHtml = `<div class="ca-slot-score-area">
        <span class="ca-slot-pts ca-slot-pts--none">—</span>
        <span class="ca-slot-not-rated">Not rated</span>
      </div>`;
    } else {
      const heat = PICK_HEAT_COLOR(score);
      scoreAreaHtml = `<div class="ca-slot-score-area">
        <span class="ca-slot-pts" style="color:${heat.color};">${score}</span>
      </div>`;
    }

    return `<div class="ca-slot-chip${isActive ? ' active' : ''}${isMvp ? ' mvp' : ''}${noPick && !isLocked ? ' no-pick' : ''}${isLocked ? ' locked' : ''}"
              onclick="selectSlot('${slot.key}')">
      ${isMvp ? `<span class="ca-slot-mvp-pip">MVP</span>` : ''}
      <span class="ca-slot-type">${typeLabel}</span>
      <span class="ca-slot-label">${pickIdent}</span>
      ${scoreAreaHtml}
    </div>`;
  }).join('');
}

// ── Slot switching ────────────────────────────────────────────────────────────
function selectSlot(key) {
  if (!VALID_SLOTS.includes(key)) return;
  _activeSlot = key;

  // Update chip active state
  document.querySelectorAll('.ca-slot-chip').forEach(chip => {
    const onclick = chip.getAttribute('onclick') || '';
    chip.classList.toggle('active', onclick.includes(`'${key}'`));
  });

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

  const isGoldMvp   = isMvp && score >= 60;
  const isSilverMvp = isMvp && score < 60;

  // Juice/odds to show inline next to the spread or total line value
  const juice = (() => {
    if (_activeSlot === 'home_spread' || _activeSlot === 'away_spread') {
      return game.spread_home != null ? fmtOdds(-110) : null;
    }
    if (_activeSlot === 'over')  return game.ou_over_odds  != null ? fmtOdds(game.ou_over_odds)  : null;
    if (_activeSlot === 'under') return game.ou_under_odds != null ? fmtOdds(game.ou_under_odds) : null;
    return null; // ML: the line value itself is the odds
  })();

  const resultBadge = p?.result && p.result !== 'pending'
    ? `<div class="ca-dp-result-badge ca-dp-result-${p.result}">${p.result.toUpperCase()}</div>`
    : '';

  const rankBadge = p && rank === 1
    ? `<div class="ca-dp-rank-badge ca-dp-rank-1">#1 Pick Today</div>`
    : p && rank > 0
      ? `<div class="ca-dp-rank-badge ca-dp-rank-n">#${rank}</div>`
      : '';

  const mvpBadge = isGoldMvp
    ? `<div class="ca-dp-mvp-badge ca-dp-mvp-badge--gold">MVP</div>`
    : isSilverMvp
      ? `<div class="ca-dp-mvp-badge ca-dp-mvp-badge--silver">MVP</div>`
      : '';

  const scoreCls = isGoldMvp ? ' mvp-gold' : isSilverMvp ? ' mvp-silver' : '';
  const scoreEl = !p
    ? `<div class="ca-dp-score-big ca-num" style="color:var(--text-disabled);">—</div>`
    : scoreHidden
      ? `<div class="ca-dp-score-big ca-num ca-blurred">${score}</div>`
      : `<div class="ca-dp-score-big ca-num${scoreCls}">${score}</div>`;

  const hdrMod = isGoldMvp ? ' ca-dp-header--mvp-gold' : isSilverMvp ? ' ca-dp-header--mvp-silver' : '';

  const headerHtml = `<div class="ca-dp-header${hdrMod}">
    <div class="ca-dp-hdr-left">
      <div class="ca-dp-hdr-eyebrow-row">
        ${isMvp ? `<span class="ca-dp-hdr-star">★</span>` : ''}
        <span class="ca-dp-hdr-eyebrow">${esc(eyebrow)}</span>
      </div>
      <div class="ca-dp-hdr-pick-row">
        <span class="ca-dp-hdr-side">${esc(sideLabel)}</span>
        ${line && _activeSlot !== 'over' && _activeSlot !== 'under' ? `<span class="${slot.type === 'ml' ? 'ca-dp-hdr-juice' : 'ca-dp-hdr-line-val'} ca-num">${esc(line)}</span>` : ''}
        ${juice ? `<span class="ca-dp-hdr-juice ca-num">${esc(juice)}</span>` : ''}
      </div>
    </div>
    <div class="ca-dp-hdr-right">
      ${p ? `<div class="ca-dp-hdr-score-label">CappingAlpha Score</div>` : ''}
      <div class="ca-dp-hdr-score-row">
        ${scoreEl}
        ${mvpBadge}
      </div>
      ${rankBadge}
      ${resultBadge}
    </div>
  </div>`;

  // ── Body: 3-column (lines mini | public betting | vote) ──────────────────

  // Col 1: Lines mini-table
  const lineRows = [
    { book: 'Open', val: line },
    { book: 'DraftKings', val: (() => {
        const dk = _data.lines?.draftkings;
        return dk ? slotLineCurrent(_activeSlot, dk) : null;
      })() },
    { book: 'FanDuel', val: (() => {
        const fd = _data.lines?.fanduel;
        return fd ? slotLineCurrent(_activeSlot, fd) : null;
      })() },
  ].filter(r => r.val != null);

  const linesMiniHtml = lineRows.length
    ? lineRows.map(r => `<div class="ca-dp-mini-row">
        <span class="ca-dp-mini-book">${r.book}</span>
        <span class="ca-dp-mini-val ca-num">${r.val}</span>
      </div>`).join('')
    : `<div style="font-size:12px;color:var(--text-disabled);">No lines available</div>`;

  // Col 2: Public betting — real % for this exact slot
  const pb = _data.publicBetting;
  const pubPct = slotPubPct(_activeSlot, pb);
  let pubHtml = `<div class="ca-dp-col-label" style="margin-bottom:8px;">Public Betting</div>`;
  if (pubPct != null) {
    const arcR   = 44;
    const arcLen = +(Math.PI * arcR).toFixed(1);
    const arcFill = +((pubPct / 100) * arcLen).toFixed(1);
    const arcColor = pubPct >= 60 ? '#22c55e' : pubPct >= 40 ? '#f59e0b' : '#ef4444';
    pubHtml += `<div class="ca-pub-num" style="color:${arcColor};">${pubPct}%</div>
    <div class="ca-pub-bar-track">
      <div class="ca-pub-bar-fill" style="width:${pubPct}%;background:${arcColor};"></div>
    </div>
    <div class="ca-pub-bar-label">${pubPct}% of bettors (tickets)</div>`;
  } else {
    pubHtml += `<div style="font-size:12px;color:var(--text-disabled);padding-top:6px;">No data available</div>`;
  }

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

  let voteHtml = `<div class="ca-dp-col-label" style="margin-bottom:8px;">Community Vote</div>`;
  if (isViewer()) {
    voteHtml += `<div class="ca-vote-login"><a onclick="openLogin()">Log in</a> to vote.</div>`;
    voteHtml += `<div class="ca-vc-pair" style="margin-top:8px;">
      ${mkVcBtn(_activeSlot, thisLabel, thisLineDisp, thisVotes, false, true)}
      ${oppKey ? mkVcBtn(oppKey, oppLabel, oppLineDisp, oppVotes, false, true) : ''}
    </div>`;
  } else if (gameStarted) {
    voteHtml += `<div class="ca-vote-locked">Voting closed — game ${game.status === 'post' ? 'ended' : 'started'}.</div>`;
    voteHtml += `<div class="ca-vc-pair" style="margin-top:8px;">
      ${mkVcBtn(_activeSlot, thisLabel, thisLineDisp, thisVotes, userOnThis, true)}
      ${oppKey ? mkVcBtn(oppKey, oppLabel, oppLineDisp, oppVotes, userOnOpp, true) : ''}
    </div>`;
  } else {
    voteHtml += `<div class="ca-vc-pair">
      ${mkVcBtn(_activeSlot, thisLabel, thisLineDisp, thisVotes, userOnThis, false)}
      ${oppKey ? mkVcBtn(oppKey, oppLabel, oppLineDisp, oppVotes, userOnOpp, false) : ''}
    </div>
    <div class="ca-dp-vote-heading" style="margin-top:8px;">Voting locks at tip-off</div>`;
  }

  el.innerHTML = headerHtml + `<div class="ca-dp-grid">
    <div class="ca-dp-col">${pubHtml}</div>
    <div class="ca-dp-divider"></div>
    <div class="ca-dp-col">${voteHtml}</div>
  </div>
  <div class="ca-dp-lines-row">
    <div class="ca-dp-col">
      <div class="ca-dp-col-label" style="margin-bottom:8px;">Current lines</div>
      <div class="ca-dp-mini-table">${linesMiniHtml}</div>
    </div>
  </div>`;

  // Paywall banner
  if (!isPaying() && p && scoreHidden) {
    el.insertAdjacentHTML('beforeend', `
      <div class="ca-dp-unlock-row">
        <span class="ca-dp-unlock-text">Scores beyond #1 are unlocked for members.</span>
        <span class="ca-dp-unlock-link" onclick="openSignup()">Get access — from $1/day</span>
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
function setLinesType(type) {
  _linesType = type;
  document.querySelectorAll('.ca-lt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  renderLines();
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

// ── Sentiment section ─────────────────────────────────────────────────────────
function renderSentiment() {
  const cardsEl  = document.getElementById('ca-sentiment-cards');
  const footerEl = document.getElementById('ca-sentiment-footer');
  if (!cardsEl) return;

  const { game, picks, votes, publicBetting } = _data;
  const pickBySlot = buildPickBySlot(picks || []);
  const v  = votes || {};
  const pb = publicBetting || null;

  const awayColors = teamColors(game, false);
  const homeColors = teamColors(game, true);
  // Use mascot/nickname (away_short = "Lakers", "Rockets") for bar labels
  const awayName = game.away_short || teamNick(game.away_team) || game.away_abbr || '';
  const homeName = game.home_short || teamNick(game.home_team) || game.home_abbr || '';
  // Keep abbr for spread header lines (shorter)
  const awayAbbr = (game.away_abbr || game.away_short || '').toUpperCase();
  const homeAbbr = (game.home_abbr || game.home_short || '').toUpperCase();

  // Line value strings for headers
  const awayML     = game.ml_away     != null ? fmtOdds(game.ml_away)       : '—';
  const homeML     = game.ml_home     != null ? fmtOdds(game.ml_home)       : '—';
  const awaySpread = game.spread_away != null ? fmtSpread(game.spread_away) : '—';
  const homeSpread = game.spread_home != null ? fmtSpread(game.spread_home) : '—';
  const ouLine     = game.over_under  != null ? game.over_under             : '—';

  // Bet type definitions
  const betTypes = [
    {
      label: 'MONEYLINE',
      leftKey: 'away_ml',     rightKey: 'home_ml',
      leftName: awayName,     rightName: homeName,
      leftColors: awayColors, rightColors: homeColors,
      leftLine: awayML,       rightLine: homeML,
      pbLeft: pb?.away_ml_pct, pbRight: pb?.home_ml_pct,
    },
    {
      label: 'SPREAD',
      leftKey: 'away_spread',  rightKey: 'home_spread',
      leftName: awayName,      rightName: homeName,
      leftColors: awayColors,  rightColors: homeColors,
      leftLine: awaySpread,    rightLine: homeSpread,
      pbLeft: pb?.away_spread_pct, pbRight: pb?.home_spread_pct,
    },
    {
      label: 'TOTAL',
      leftKey: 'under',  rightKey: 'over',
      leftName: 'UNDER', rightName: 'OVER',
      leftColors:  { primary: '#475569', secondary: '#e2e8f0' },
      rightColors: { primary: '#22c55e', secondary: '#052e0d' },
      leftLine: '', rightLine: '',
      centerLine: ouLine !== '—' ? String(ouLine) : null,
      pbLeft: pb?.under_pct, pbRight: pb?.over_pct,
    },
  ];

  // Render one gradient bar block (used in both columns)
  function renderBar(bt, leftPct, rightPct, leftCount, rightCount, isPublic) {
    const noData = leftPct == null || rightPct == null;
    const lPct   = noData ? 50 : leftPct;
    const rPct   = noData ? 50 : rightPct;
    const lColor = noData ? '#1e2736' : bt.leftColors.primary;
    const rColor = noData ? '#1e2736' : bt.rightColors.primary;
    const lText  = noData ? 'transparent' : bt.leftColors.secondary;
    const rText  = noData ? 'transparent' : bt.rightColors.secondary;

    // Soft gradient blend zone ±12% around the split point
    const BLEND  = 12;
    const bs     = Math.max(0, lPct - BLEND);
    const be     = Math.min(100, lPct + BLEND);
    const bg     = noData
      ? lColor
      : `linear-gradient(to right, ${lColor} 0%, ${lColor} ${bs}%, ${rColor} ${be}%, ${rColor} 100%)`;

    const lCountStr = leftCount  != null ? ` (${leftCount})` : '';
    const rCountStr = rightCount != null ? ` (${rightCount})` : '';

    const tick = noData ? '' : `<div class="ca-senti-split-tick" style="left:${lPct}%;"></div>`;

    return `
      <div class="ca-senti-bar-outer" style="background:${bg};">
        <span class="ca-senti-seg-lbl" style="color:${lText};">${bt.leftName}</span>
        ${tick}
        <span class="ca-senti-seg-lbl" style="color:${rText};">${bt.rightName}</span>
      </div>
      <div class="ca-senti-bar-foot${isPublic ? ' ca-senti-bar-foot--pub' : ''}">
        <span class="ca-num">${noData ? '—' : lPct + '%'}${lCountStr}</span>
        ${bt.centerLine ? `<span class="ca-senti-center-val ca-num">${bt.centerLine}</span>` : ''}
        <span class="ca-num">${noData ? '—' : rPct + '%'}${rCountStr}</span>
      </div>`;
  }

  // Render one column's worth of bet blocks
  function renderColumn(isPublic) {
    return betTypes.map(bt => {
      // Header line values
      const header = `
        <div class="ca-senti-bet-hdr">
          <span class="ca-senti-line ca-num">${bt.leftLine}</span>
          <span class="ca-senti-bet-label">${bt.label}</span>
          <span class="ca-senti-line ca-num">${bt.rightLine}</span>
        </div>`;

      let leftPct, rightPct, leftCount, rightCount;

      if (isPublic) {
        let lp = bt.pbLeft  != null ? bt.pbLeft  : null;
        let rp = bt.pbRight != null ? bt.pbRight : null;
        // AN sometimes returns only one side — fill in the complement
        if (lp != null && rp == null) rp = 100 - lp;
        else if (rp != null && lp == null) lp = 100 - rp;
        leftPct = lp; rightPct = rp;
        leftCount = null; rightCount = null;
      } else {
        const lVotes = v[bt.leftKey]  || 0;
        const rVotes = v[bt.rightKey] || 0;
        const total  = lVotes + rVotes;
        leftPct    = total > 0 ? Math.round(lVotes / total * 100) : null;
        rightPct   = leftPct != null ? 100 - leftPct : null;
        leftCount  = lVotes;
        rightCount = rVotes;
      }

      return `
        <div class="ca-senti-bet-block">
          ${header}
          ${renderBar(bt, leftPct, rightPct, leftCount, rightCount, isPublic)}
        </div>`;
    }).join('');
  }

  const totalVotes = Object.values(v).reduce((a, b) => a + b, 0);

  cardsEl.innerHTML = `
    <div class="ca-senti-split">
      <div class="ca-senti-col">
        <div class="ca-senti-col-hdr">PUBLIC BETTING</div>
        ${renderColumn(true)}
      </div>
      <div class="ca-senti-vdivider"></div>
      <div class="ca-senti-col">
        <div class="ca-senti-col-hdr">COMMUNITY <span class="ca-senti-vote-count ca-num">${totalVotes} vote${totalVotes !== 1 ? 's' : ''}</span></div>
        ${renderColumn(false)}
      </div>
    </div>`;

  if (footerEl) footerEl.textContent = '';
}

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
function initScrollSpy() {
  const allNavLinks = document.querySelectorAll(
    '.ca-sidebar-link[data-sec], .ca-mtab[data-sec]'
  );
  const sections = document.querySelectorAll('.ca-section[id]');
  if (!sections.length || !('IntersectionObserver' in window)) return;

  const navHeight = (document.querySelector('nav')?.offsetHeight || 56) +
                    (document.querySelector('.ca-sticky-top')?.offsetHeight || 0) +
                    (document.querySelector('.ca-mobile-tabs')?.offsetHeight || 0);

  const setActive = (id) => {
    allNavLinks.forEach(t => t.classList.toggle('active', t.dataset.sec === id));
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
      const stickyOffset = (document.querySelector('nav')?.offsetHeight || 56)
                         + (document.querySelector('.ca-sticky-top')?.offsetHeight || 0)
                         + (document.querySelector('.ca-mobile-tabs')?.offsetHeight || 0)
                         + 20; // breathing room
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
