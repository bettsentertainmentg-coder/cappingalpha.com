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
  if (slotKey === 'over')        return game.over_under  != null ? `o${game.over_under}`        : null;
  if (slotKey === 'under')       return game.over_under  != null ? `u${game.over_under}`        : null;
  return null;
}

// ── Status pill ───────────────────────────────────────────────────────────────
function renderStatusPill() {
  const pill = document.getElementById('ca-status-pill');
  if (!pill) return;
  const { game } = _data;
  const s = game.status;

  if (s === 'post') {
    pill.className = 'ca-gh-status-pill ca-status-final';
    pill.innerHTML = `<span class="ca-num">${game.away_score ?? 0}–${game.home_score ?? 0}</span> Final`;
  } else if (s === 'in') {
    const sport = (game.sport || '').toUpperCase();
    const period = game.period;
    const clock  = game.clock && sport !== 'MLB' ? ` · ${game.clock}` : '';
    let periodLabel = period ? `P${period}` : 'LIVE';
    if (sport === 'NFL' || sport === 'NCAAF') periodLabel = period ? `Q${period}` : 'LIVE';
    if (sport === 'MLB') periodLabel = period ? `Inn ${period}` : 'LIVE';
    pill.className = 'ca-gh-status-pill ca-status-live';
    pill.innerHTML = `<span class="ca-num">${game.away_score ?? 0}–${game.home_score ?? 0}</span> · ${periodLabel}${clock}`;
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
  const countEl    = document.getElementById('ca-picks-count');
  if (countEl) countEl.textContent = `${picks?.length || 0} pick${picks?.length !== 1 ? 's' : ''}`;

  // Sort slots: picks with scores highest→lowest left→right; no-pick slots at end
  const sortedSlots = [...SLOTS].sort((a, b) => {
    const sA = pickBySlot[a.key]?.score || 0;
    const sB = pickBySlot[b.key]?.score || 0;
    return sB - sA;
  });

  el.innerHTML = sortedSlots.map(slot => {
    const p     = pickBySlot[slot.key];
    const score = p?.score || 0;
    const isMvp = score >= MVP_THRESHOLD;
    const isActive = slot.key === _activeSlot;
    const noPick = !p || score === 0;

    // Rank-based paywall: hide score if not paying and slot rank > 1
    const rank = (pickRanks && p?.id) ? (pickRanks[p.id] || 0) : 0;
    const scoreHidden = !isPaying() && rank > 1 && score > 0;

    const lineCurrent = slotLineCurrent(slot.key, game);
    let scoreHtml = '';
    if (noPick) {
      const lineDisplay = lineCurrent || '—';
      scoreHtml = `<span class="ca-slot-score" style="color:var(--text-disabled);">${lineDisplay}</span>
                   <span class="ca-slot-not-rated">Not rated</span>`;
    } else if (scoreHidden) {
      scoreHtml = `<span class="ca-slot-score ca-blurred">${score}</span>
                   <span class="ca-slot-lock"><i class="fa-solid fa-lock" style="font-size:9px;"></i></span>`;
    } else {
      const heat = PICK_HEAT_COLOR(score);
      scoreHtml = `<span class="ca-slot-score" style="color:${heat.color};">${score}pts</span>`;
    }

    return `<div class="ca-slot-chip${isActive ? ' active' : ''}${isMvp ? ' mvp' : ''}${noPick ? ' no-pick' : ''}"
              onclick="selectSlot('${slot.key}')">
      ${isMvp ? `<span class="ca-slot-mvp-pip">MVP</span>` : ''}
      <span class="ca-slot-type">${slot.type.toUpperCase()}</span>
      <span class="ca-slot-label">${slot.label}</span>
      ${scoreHtml}
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
        ${line ? `<span class="ca-dp-hdr-line-val ca-num">${esc(line)}</span>` : ''}
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
    pubHtml += `<div class="ca-pub-arc-wrap">
      <svg viewBox="0 2 100 54" width="110" height="56" style="display:block;margin:0 auto;overflow:visible;">
        <path d="M 6 54 A 44 44 0 0 0 94 54" stroke="var(--border)" stroke-width="9" fill="none" stroke-linecap="round"/>
        <path d="M 6 54 A 44 44 0 0 0 94 54" stroke="${arcColor}" stroke-width="9" fill="none" stroke-linecap="round"
          stroke-dasharray="${arcFill} ${arcLen}"/>
        <text x="50" y="48" text-anchor="middle" dominant-baseline="auto"
          font-family="'JetBrains Mono', monospace" font-size="20" font-weight="900"
          fill="${arcColor}">${pubPct}%</text>
      </svg>
    </div>
    <div class="ca-pub-arc-label">${pubPct}% of bettors (tickets)</div>`;
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
    <div class="ca-dp-col">
      <div class="ca-dp-col-label" style="margin-bottom:8px;">Current lines</div>
      <div class="ca-dp-mini-table">${linesMiniHtml}</div>
    </div>
    <div class="ca-dp-divider"></div>
    <div class="ca-dp-col">${pubHtml}</div>
    <div class="ca-dp-divider"></div>
    <div class="ca-dp-col">${voteHtml}</div>
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
    awayFn = (src) => src?.spread_away != null ? fmtSpread(src.spread_away) : null;
    homeFn = (src) => src?.spread_home != null ? fmtSpread(src.spread_home) : null;
  } else if (_linesType === 'total') {
    awayLabel = 'Over';
    homeLabel = 'Under';
    awayFn = (src) => src?.over_under  != null ? `o${src.over_under} (${fmtOdds(src.ou_over_odds  ?? -110)})` : null;
    homeFn = (src) => src?.over_under  != null ? `u${src.over_under} (${fmtOdds(src.ou_under_odds ?? -110)})` : null;
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
    <div>Book</div><div>${awayLabel}</div><div>${homeLabel}</div><div></div>
  </div>`;

  const rowsHtml = rows.map(r => {
    const awayVal = awayFn(r.src);
    const homeVal = homeFn(r.src);

    // DK delta
    let awayDelta = '', homeDelta = '';
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
        awayDelta = ` <span class="${d > 0 ? 'ca-lt-move-up' : 'ca-lt-move-down'} ca-mv-arrow">(${d > 0 ? '+' : ''}${d})</span>`;
      }
      if (homePrev != null && hCur != null && hCur !== homePrev) {
        const d = hCur - homePrev;
        homeDelta = ` <span class="${d > 0 ? 'ca-lt-move-up' : 'ca-lt-move-down'} ca-mv-arrow">(${d > 0 ? '+' : ''}${d})</span>`;
      }
    }

    return `<div class="ca-lt-row">
      <div class="ca-lt-book">${r.book}</div>
      <div class="ca-lt-val ca-num">${awayVal != null ? awayVal : '<span class="ca-lt-na">—</span>'}${awayDelta}</div>
      <div class="ca-lt-val ca-num">${homeVal != null ? homeVal : '<span class="ca-lt-na">—</span>'}${homeDelta}</div>
      <div></div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="ca-lines-table-wrap">${headerHtml}${rowsHtml}</div>`;
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
      leftLine: `${awayAbbr} ${awaySpread}`, rightLine: `${homeAbbr} ${homeSpread}`,
      pbLeft: pb?.away_spread_pct, pbRight: pb?.home_spread_pct,
    },
    {
      label: 'TOTAL',
      leftKey: 'under',  rightKey: 'over',
      leftName: 'UNDER', rightName: 'OVER',
      leftColors:  { primary: '#475569', secondary: '#e2e8f0' },
      rightColors: { primary: '#22c55e', secondary: '#052e0d' },
      leftLine: `UNDER ${ouLine}`, rightLine: `OVER ${ouLine}`,
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
