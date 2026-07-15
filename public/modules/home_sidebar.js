// public/modules/home_sidebar.js
// Home page left sidebar: #1 pick card + today's games by sport.
// Also exports loadHeadlines() for the right-column headlines section.

import { isViewer } from './auth.js';
import { gameTime, pickLabel, teamNickname, liveStateHtml, onBoardForSport } from './utils.js?v=3';
import { unlockCtaHtml } from './paywall.js';
import { state } from './state.js';

let _sidebarSport = 'MLB';
let _sidebarGames = [];
let _tpChart      = null;        // CA #1-pick card mini P/L chart

// ── Orchestrator ──────────────────────────────────────────────────────────────
export async function loadHomeSidebar() {
  await Promise.all([_renderTopPick(), _loadSidebarGames()]);
}

// ── #1 pick card ──────────────────────────────────────────────────────────────
// Marquee CA logo + "#1 PICK", today's top team + points, and a mini P/L graph
// that auto-highlights the team's best-performing window by win rate.
async function _renderTopPick() {
  const el = document.getElementById('ca-top-pick-slot');
  if (!el) return;

  // The #1 ranked pick is account-gated. Logged-out visitors see the SAME card at
  // the SAME size — only the pick content (matchup / bet / live / points) is blurred.
  // The P/L graph + record (public data) and "view all rankings" stay clear. The
  // server withholds the pick from them, so we blur a placeholder, not real data.
  const viewer = isViewer();

  try {
    // Today's #1 pick (team + points) and the resolved MVP history (P/L graph) are
    // independent feeds. Logged-out visitors don't get the pick (it's gated), so
    // only the public P/L feed is fetched for them.
    const [pick, mvp] = await Promise.all([
      viewer ? Promise.resolve(null) : fetch('/api/picks/top').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/mvp/public').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    // Logged in but today's #1 isn't posted yet: DON'T collapse the whole widget.
    // Keep the rankings P/L graph + record below (public data, still available) and
    // show a small placeholder where the pick would be. Previously this threw, so the
    // entire rankings card vanished for signed-in users while logged-out visitors
    // still saw it — which read as "the rankings are gone."
    const hasPick = !!(pick && pick.team);
    const noPick  = !viewer && !hasPick;

    const score = viewer ? 65 : (hasPick ? (pick.score || 0) : 0);
    const sport = viewer ? ' · MLB' : (hasPick && pick.sport ? ` · ${pick.sport}` : '');

    // Headline the actual bet (e.g. "Over 8.5", "Knicks Win", "Twins -1.5") rather
    // than a bare team name. Logged-out visitors get blurred placeholders.
    const betText = viewer ? 'Yankees Win' : (hasPick ? (pickLabel(pick) || pick.team || '—') : '');
    const away = (hasPick && pick.away_team) ? teamNickname(pick.away_team, pick.home_team) : '';
    const home = (hasPick && pick.home_team) ? teamNickname(pick.home_team, pick.away_team) : '';
    const matchupText = viewer ? 'New York @ Boston' : ((away && home) ? `${away} @ ${home}` : '');

    // Once the game finishes, results.js writes pick.result (win/loss/push).
    // A win turns the whole card green with a checkmark; loss/push stay honest.
    const result = (viewer || !hasPick) ? '' : (pick.result || '').toLowerCase();
    const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
    const X_SVG     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    let resultBadge = '', cardState = '';
    if (result === 'win')       { resultBadge = `<span class="ca-tp-result-badge win">${CHECK_SVG}WON</span>`;  cardState = ' ca-tp-won'; }
    else if (result === 'loss') { resultBadge = `<span class="ca-tp-result-badge loss">${X_SVG}LOST</span>`;    cardState = ' ca-tp-lost'; }
    else if (result === 'push') { resultBadge = `<span class="ca-tp-result-badge push">PUSH</span>`;            cardState = ' ca-tp-push'; }

    // Live game: one compact line under the bet — glowing blue dot + score + the
    // condensed scoreboard (baseball bases/outs/half-inning; period/clock otherwise).
    // Kept on its own left-aligned line so the card stays its original size and the
    // bet row isn't pushed lopsided. Gate on resultBadge (set only for win/loss/push)
    // — pick.result is 'pending' while live, which is truthy.
    const isLive = hasPick && (pick.game_status || '') === 'in' && !resultBadge;
    let liveLine = '';
    if (isLive) {
      const aScore = pick.game_away_score ?? 0;
      const hScore = pick.game_home_score ?? 0;
      const bb = liveStateHtml(pick);   // baseball diamond/outs/half, or '' otherwise
      let fallback = '';
      if (!bb && pick.game_period) {
        const sp = (pick.sport || '').toUpperCase();
        const n = pick.game_period;
        if (sp === 'MLB') fallback = `${n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th'} Inn`;
        else if (sp === 'ATP' || sp === 'WTA') fallback = `Set ${n}`;
        else if (sp === 'SOCCER') fallback = `H${n}`;
        else if (sp === 'NHL' || sp === 'CBB' || sp === 'WCBB') fallback = `P${n}`;
        else fallback = `Q${n}`;
      }
      const tail = bb || (fallback ? `<span class="bb-half">${fallback}</span>` : '');
      liveLine = `<div class="ca-tp-live-line"><span class="ca-tp-live-dot"></span><span class="ca-tp-live-score">${aScore}-${hScore}</span>${tail}</div>`;
      cardState = ' ca-tp-live';
    }

    // ── P/L block (only when there's enough resolved history) ─────────────────
    const betUnit = parseFloat(state.CONFIG?.bet_unit) || 10;
    const best = _bestWindow(_resolvedMvp(mvp && mvp.picks));
    let plHtml = '', plSeries = null;
    if (best) {
      const s    = plSeries = _series(best.picks, betUnit);
      const sign = s.total >= 0 ? 'pos' : 'neg';
      const amt  = (s.total >= 0 ? '+' : '') + '$' + Math.abs(s.total).toFixed(2);
      const wr   = best.decided ? Math.round(best.winRate * 100) + '%' : '0%';
      plHtml = `
        <div class="ca-tp-pl-head">
          <span class="ca-tp-pl-title" style="text-transform:none;">Rankings ${best.label} P/L</span>
          <span class="graph-pl-label ${sign}">${amt}</span>
        </div>
        <div class="ca-tp-graph-wrap"><canvas id="ca-tp-chart"></canvas></div>
        <div class="ca-tp-betsize">Based on flat $${betUnit} bet size&nbsp;·&nbsp;<span class="ca-tp-track-note">Tracking 100+ points</span></div>
        <div class="ca-tp-record">
          <div><b class="green">${best.wins}</b><span>Wins</span></div>
          <div><b class="red">${best.losses}</b><span>Losses</span></div>
          <div><b>${best.pushes}</b><span>Pushes</span></div>
          <div><b class="gold">${wr}</b><span>Win%</span></div>
        </div>`;
    }

    // The whole card opens the MVP page, so everyone just gets a click-through
    // hint. (No Unlock CTA on this card — it cluttered the #1 Pick widget.)
    const ctaHtml = `<div class="ca-top-pick-cta-label" style="text-align:center;margin-bottom:0;">Click to view all rankings ›</div>`;

    // The pick-content block (matchup / bet / live / points) is identical for
    // everyone; for logged-out visitors it's wrapped in a blur so the card keeps its
    // exact size and layout while the actual pick stays hidden.
    const pickBlock = `
        ${matchupText ? `<div class="ca-tp-matchup">${matchupText}</div>` : ''}
        <div class="ca-tp-team-row"><span class="ca-tp-team">${betText}</span>${resultBadge}</div>
        ${viewer ? `<div class="ca-tp-live-line"><span class="ca-tp-live-dot"></span><span class="ca-tp-live-score">2-0</span><span class="bb-half">Bot 4th</span></div>` : liveLine}
        <div class="ca-tp-sub"><span class="ca-tp-pts">${score} pts</span>${sport}</div>`;
    const pickContent = viewer
      ? `<div style="position:relative;">
          <div style="filter:blur(7px);opacity:0.7;user-select:none;pointer-events:none;" aria-hidden="true">${pickBlock}</div>
          <div onclick="event.stopPropagation();" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:86%;background:var(--surface);border:1px solid var(--border);border-radius:9px;box-shadow:0 10px 26px rgba(0,0,0,0.55);padding:9px 10px 8px;text-align:center;">
            <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:7px;line-height:1.3;">See today's #1 ranked play</div>
            <button class="ca-tp-login-btn" onclick="event.stopPropagation();openLogin()">
              <span class="ucb-lock">&#128274;</span><span class="ucb-open">&#128275;</span>Log in to see it
            </button>
            <div style="margin-top:6px;font-size:10px;color:var(--muted);">No account? <a class="ca-tp-signup-link" onclick="event.stopPropagation();openSignup()">Sign up free</a></div>
          </div>
        </div>`
      : noPick
        ? `<div class="ca-tp-nopick" style="padding:16px 8px;text-align:center;color:var(--muted);font-size:12.5px;line-height:1.45;">No #1 ranked play posted yet today.<br>Check back soon, or view past rankings below.</div>`
        : pickBlock;

    el.innerHTML = `
      <div class="ca-top-pick-card ca-tp-clickable${cardState}" onclick="switchTab('mvp')" title="View CA Rankings ›">
        <div class="ca-tp-brand">
          <img src="/ca-logo.png" alt="CappingAlpha" class="ca-tp-logo"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
          <span class="ca-tp-logo-fallback">CA</span>
          <div class="ca-tp-title"><span class="ca-tp-title-rank">#1</span> <span class="ca-tp-title-pick">Ranked</span></div>
        </div>
        ${pickContent}
        ${plHtml}
        ${ctaHtml}
      </div>`;

    if (plSeries) _drawTpChart(plSeries);
  } catch (_) {
    if (_tpChart) { _tpChart.destroy(); _tpChart = null; }
    el.innerHTML = `<div class="ca-top-pick-card ca-top-pick-empty"><p style="color:var(--muted);font-size:13px;text-align:center;padding:8px 0;">No picks yet today.</p></div>`;
  }
}

// ── #1 pick card: best-window P/L helpers ─────────────────────────────────────
// Mirrors the record/P/L math in mvp.js, kept self-contained so the sidebar card
// doesn't couple to the MVP tab module.
const _TP_RANGES = [
  { key: '1D',  days: 1,        label: '1-Day' },
  { key: '5D',  days: 5,        label: '5-Day' },
  { key: '7D',  days: 7,        label: '7-Day' },
  { key: '21D', days: 21,       label: '21-Day' },
  { key: '1M',  days: 30,       label: '1-Month' },
  { key: '3M',  days: 90,       label: '3-Month' },
  { key: 'ALL', days: Infinity, label: 'All-Time' },
];
const _TP_MIN_SAMPLE = 5;  // a window needs 5+ decided picks before it can win

function _resolvedMvp(picks) {
  // /api/mvp/public already filters to decided, non-voided picks above the
  // display threshold — just guard against anything unexpected slipping in.
  return (picks || []).filter(p =>
    (p.result === 'win' || p.result === 'loss' || p.result === 'push') &&
    !(p.annotation && p.annotation.includes('not counted'))
  );
}

function _filterDays(picks, days) {
  if (!isFinite(days)) return picks.slice();
  if (days === 1) {
    // "1-Day" = the latest board day only. A rolling 24h cutoff spans two board
    // days (yesterday's slate grades into today), same trap as the MVP tab bar.
    let latest = '';
    for (const p of picks) if ((p.game_date || '') > latest) latest = p.game_date;
    return latest ? picks.filter(p => p.game_date === latest) : [];
  }
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutStr = cutoff.toISOString().slice(0, 10);
  return picks.filter(p => (p.game_date || '') >= cutStr);
}

function _windowStats(picks, range) {
  const wins   = picks.filter(p => p.result === 'win').length;
  const losses = picks.filter(p => p.result === 'loss').length;
  const pushes = picks.filter(p => p.result === 'push').length;
  const decided = wins + losses;
  return { ...range, picks, wins, losses, pushes, decided, winRate: decided ? wins / decided : 0 };
}

// Pick the window with the highest win rate that clears the minimum sample.
// Ties go to the larger sample (more credible). Falls back to all-time if no
// sub-window qualifies.
function _bestWindow(resolved) {
  if (!resolved || resolved.length === 0) return null;
  let best = null;
  for (const r of _TP_RANGES) {
    const w = _windowStats(_filterDays(resolved, r.days), r);
    if (w.decided < _TP_MIN_SAMPLE) continue;
    if (!best || w.winRate > best.winRate || (w.winRate === best.winRate && w.decided > best.decided)) {
      best = w;
    }
  }
  if (!best) {
    const all = _windowStats(resolved.slice(), _TP_RANGES[_TP_RANGES.length - 1]);
    return all.decided ? all : null;
  }
  return best;
}

function _tpReturn(pick, unit) {
  const r = (pick.result || '').toLowerCase();
  if (r === 'push' || r === 'pending' || !r) return 0;
  if (r === 'loss') return -unit;
  const type = (pick.pick_type || '').toLowerCase();
  let odds = type === 'ml' ? (pick.ml_odds || -115)
           : (type === 'over' || type === 'under') ? (pick.ou_odds || -115)
           : -115;
  if (!odds) odds = -115;
  return odds < 0 ? +(unit * (100 / Math.abs(odds))).toFixed(2)
                  : +(unit * (odds / 100)).toFixed(2);
}

// Cumulative series for the mini chart. Multiple game-dates plot by day; a
// single date (e.g. a hot 1-day window) plots per pick so the line isn't a dot.
function _series(picks, unit) {
  const sorted = picks.slice().sort((a, b) =>
    (a.saved_at || a.game_date || '').localeCompare(b.saved_at || b.game_date || ''));
  const byDate = {};
  for (const p of sorted) { const d = p.game_date || 'x'; (byDate[d] ||= []).push(p); }
  const dates = Object.keys(byDate).sort();

  let cum = 0; const labels = [], values = [];
  if (dates.length < 2) {
    sorted.forEach((p, i) => { cum += _tpReturn(p, unit); labels.push('P' + (i + 1)); values.push(+cum.toFixed(2)); });
  } else {
    for (const d of dates) {
      cum += byDate[d].reduce((s, p) => s + _tpReturn(p, unit), 0);
      const dt = new Date(d + 'T12:00:00');
      labels.push(dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      values.push(+cum.toFixed(2));
    }
  }
  return { labels, values, total: +cum.toFixed(2) };
}

function _drawTpChart({ labels, values, total }) {
  if (_tpChart) { _tpChart.destroy(); _tpChart = null; }
  const ctx = document.getElementById('ca-tp-chart');
  if (!ctx || typeof Chart === 'undefined') return;

  const color = total >= 0 ? '#22c55e' : '#ef4444';
  _tpChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values, borderColor: color, backgroundColor: color + '22',
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: true, tension: 0.35,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: false,   // redraws on the 30s live refresh must not re-animate (flicker)
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e2330', borderColor: '#252c3b', borderWidth: 1,
          titleColor: '#e2e8f0', bodyColor: '#8892a4', padding: 8, displayColors: false,
          callbacks: { label: c => `$${Number(c.parsed.y).toFixed(2)}` },
        },
      },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
}

// ── Sidebar games ─────────────────────────────────────────────────────────────
async function _loadSidebarGames() {
  const listEl = document.getElementById('ca-sidebar-games-list');
  const tabEl  = document.getElementById('ca-sidebar-sport-tabs');
  if (!listEl) return;

  try {
    const res = await fetch('/api/games?board=1');
    if (!res.ok) return;
    _sidebarGames = await res.json();
    // Keep today's board (tennis gets a ~10h lookahead for early global slates). The
    // ?board=1 server filter handles this in prod, but local dev mirrors /api GETs
    // from prod (possibly older code), so scope here too — idempotent when matched.
    _sidebarGames = (_sidebarGames || []).filter(g => onBoardForSport(g.start_time, g.sport));
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
      // Compact for the narrow sidebar: score + half-inning ("0-3 · Top 6th") for
      // baseball, else score + clock. The full diamond lives on the wider surfaces.
      const score  = `${g.away_score ?? 0}-${g.home_score ?? 0}`;
      const detail = ((g.sport || '').toUpperCase() === 'MLB' && g.live_detail) ? g.live_detail
                   : (g.clock && g.clock !== '0:00') ? g.clock : 'Live';
      timeOrScore = `<span class="ca-sidebar-live-dot"></span><span style="color:#38bdf8;font-weight:700;font-size:11px;">${score} · ${detail}</span>`;
    } else if (isPost) {
      timeOrScore = `<span style="color:var(--muted);font-size:12px;">${g.away_score ?? 0}–${g.home_score ?? 0} F</span>`;
    } else {
      timeOrScore = `<span style="color:var(--muted);font-size:12px;">${gameTime(g.start_time)}</span>`;
    }

    // /api/games only exposes home_team / away_team — take last word as short name
    const awayFull = g.away_team || 'Away';
    const homeFull = g.home_team || 'Home';
    let away = awayFull.split(' ').pop();
    let home = homeFull.split(' ').pop();
    // Exact-same tails ("National All-Stars" vs "American All-Stars") — the
    // lead part of each name is the only part that identifies the team.
    if (away.toLowerCase() === home.toLowerCase()) {
      away = awayFull.split(' ').slice(0, -1).join(' ') || away;
      home = homeFull.split(' ').slice(0, -1).join(' ') || home;
    }

    return `<div class="ca-sidebar-game-row" onclick="window.location.href='/game/${g.espn_game_id}'">
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
