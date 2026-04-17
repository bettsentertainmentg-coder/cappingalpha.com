// modules/account.js — My Account tab

import { state } from './state.js';
import { sportBadge, matchupLabel, scoreDisplay, pickLabel, PICK_HEAT_COLOR } from './utils.js';
import { doRedeemCode } from './paywall.js';

const ALL_SPORTS = ['MLB', 'NBA', 'NHL', 'NFL', 'NCAAF', 'CBB', 'ATP', 'WTA'];

export async function loadAccount() {
  const el = document.getElementById('account-content');
  if (!el) return;
  el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div></div>`;

  try {
    const [accountRes, picksRes] = await Promise.all([
      fetch('/api/account'),
      fetch('/api/picks'),
    ]);
    if (accountRes.status === 401) { window.switchTab('home'); window.openLogin(); return; }
    const data      = await accountRes.json();
    const picks     = picksRes.ok ? await picksRes.json() : [];
    renderAccount({ ...data, allPicks: picks });
  } catch (err) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">⚠</div><h3>Failed to load account</h3><p>${err.message}</p></div>`;
  }
}

export async function deleteVote(espn_game_id, slot) {
  try {
    const res = await fetch(`/api/game/${espn_game_id}/vote`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot }),
    });
    if (res.status === 409) { alert('Game has started — vote cannot be removed.'); return; }
    if (!res.ok) return;
    loadAccount();
  } catch (_) {}
}

function voteSlotLabel(v) {
  return {
    home_ml:     `${(v.home_team||'').split(' ').pop()} ML`,
    away_ml:     `${(v.away_team||'').split(' ').pop()} ML`,
    home_spread: `${(v.home_team||'').split(' ').pop()} Spread`,
    away_spread: `${(v.away_team||'').split(' ').pop()} Spread`,
    over:        v.spread ? `Over ${v.spread}` : 'Over',
    under:       v.spread ? `Under ${v.spread}` : 'Under',
  }[v.pick_slot] || v.pick_slot;
}

function voteOdds(v) {
  const slot = v.pick_slot;
  if (slot === 'home_ml') return v.ml_home || null;
  if (slot === 'away_ml') return v.ml_away || null;
  if (slot === 'over')    return v.ou_over_odds  || -115;
  if (slot === 'under')   return v.ou_under_odds || -115;
  return -115;
}

function calcVoteReturn(v, unit) {
  const r = (v.result || '').toLowerCase();
  if (r === 'push' || r === 'pending' || !r) return 0;
  if (r === 'loss') return -unit;
  const odds = voteOdds(v) || -115;
  if (odds < 0) return +(unit * (100 / Math.abs(odds))).toFixed(2);
  return +(unit * (odds / 100)).toFixed(2);
}

let votedChart = null;

export function drawVotedPlGraph(votes, unit = 20) {
  const canvas = document.getElementById('voted-pl-chart');
  const label  = document.getElementById('voted-pl-total');
  if (!canvas) return;

  const resolved = votes.filter(v =>
    v.result === 'win' || v.result === 'loss' || v.result === 'push'
  );

  if (resolved.length === 0) {
    if (label) { label.textContent = '$0.00'; label.className = 'graph-pl-label'; }
    if (votedChart) { votedChart.destroy(); votedChart = null; }
    return;
  }

  let cum = 0;
  const points = resolved.map(v => {
    const ret = calcVoteReturn(v, unit);
    cum = +(cum + ret).toFixed(2);
    return { label: voteSlotLabel(v), cumPL: cum, ret, result: v.result };
  });

  const totalPL = points[points.length - 1].cumPL;
  if (label) {
    label.textContent = (totalPL >= 0 ? '+' : '') + '$' + totalPL.toFixed(2);
    label.className   = 'graph-pl-label ' + (totalPL >= 0 ? 'pos' : 'neg');
  }

  const lineColor = totalPL >= 0 ? '#4ade80' : '#f87171';
  if (votedChart) { votedChart.destroy(); votedChart = null; }

  votedChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: points.map((_, i) => `Pick ${i + 1}`),
      datasets: [{
        label: 'Cumulative P/L',
        data: points.map(p => p.cumPL),
        borderColor: lineColor,
        backgroundColor: lineColor + '18',
        borderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7,
        fill: true,
        tension: 0.2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => points[items[0].dataIndex]?.label || '',
            label: item => {
              const p = points[item.dataIndex];
              const sign = p.ret >= 0 ? '+' : '';
              return [`Cumulative: $${item.raw.toFixed(2)}`, `This pick: ${sign}$${p.ret.toFixed(2)}`];
            },
          },
        },
      },
      scales: {
        x: { display: false },
        y: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#8892a4', callback: v => '$' + v },
        },
      },
    },
  });
}

export function toggleFavSport(el) {
  el.classList.toggle('active');
}

export async function saveFavSports() {
  const pills  = document.querySelectorAll('#fav-sport-pills .sport-pill');
  const sports = Array.from(pills).filter(p => p.classList.contains('active')).map(p => p.dataset.sport);
  const msgEl  = document.getElementById('fav-saved-msg');

  try {
    const res = await fetch('/api/account/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite_sports: sports }),
    });
    if (res.ok) {
      if (msgEl) { msgEl.style.display = ''; setTimeout(() => { msgEl.style.display = 'none'; }, 2000); }
    }
  } catch (_) {}
}

// ── Access status card — shown instead of code entry if already has access ──
function accessStatusWidget(user) {
  const tier = user.subscription_tier;

  if (tier === 'paid') {
    const exp = user.subscription_expires ? new Date(user.subscription_expires) : null;
    const expStr = exp
      ? exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Active';
    return `
      <div class="access-status-card access-status-paid">
        <div class="access-status-icon">✓</div>
        <div>
          <div class="access-status-label">Active Subscription</div>
          <div class="access-status-val">Renews ${expStr}</div>
        </div>
      </div>`;
  }

  if (tier === 'code') {
    const expires = user.subscription_expires;
    if (!expires) {
      return `
        <div class="access-status-card access-status-code">
          <div class="access-status-icon">∞</div>
          <div>
            <div class="access-status-label">Lifetime Access</div>
            <div class="access-status-val" style="color:var(--gold);">∞ Never expires</div>
          </div>
        </div>`;
    }
    const expDate = new Date(expires);
    const msLeft  = expDate - Date.now();
    const hrs     = Math.max(0, Math.floor(msLeft / 3_600_000));
    const mins    = Math.max(0, Math.floor((msLeft % 3_600_000) / 60_000));
    const days    = Math.floor(hrs / 24);
    const isExpired = msLeft <= 0;
    const isUrgent  = !isExpired && hrs < 24;
    const timeStr   = isExpired ? 'Expired'
      : isUrgent ? `${hrs}h ${mins}m remaining`
      : `${days} day${days !== 1 ? 's' : ''} remaining`;
    const cls = isExpired || isUrgent ? ' urgent' : '';
    const expFmt = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `
      <div class="access-status-card access-status-code${cls}">
        <div class="access-status-icon">⏱</div>
        <div>
          <div class="access-status-label">Access Code Active</div>
          <div class="access-status-val">${timeStr}</div>
          <div class="access-status-expires">Expires ${expFmt}</div>
        </div>
      </div>`;
  }

  // Free user — show code entry form
  return `
    <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">Have a promo code? Enter it below to unlock access.</div>
    <div style="display:flex;gap:8px;">
      <input type="text" id="account-code-input" placeholder="Enter code" autocomplete="off"
             style="flex:1;font-size:13px;"
             onkeydown="if(event.key==='Enter')doRedeemCode('account-code-input','account-code-error')" />
      <button class="btn btn-gold" style="font-size:13px;padding:8px 14px;" onclick="doRedeemCode('account-code-input','account-code-error')">Redeem</button>
    </div>
    <div class="form-error" id="account-code-error" style="margin-top:8px;font-size:12px;"></div>`;
}

function renderAccount(data) {
  const el = document.getElementById('account-content');
  const { user, favoriteSports, votes, allPicks } = data;

  const tierLabel = user.subscription_tier === 'free'
    ? `<span class="tier-badge tier-free">Free</span>`
    : `<span class="tier-badge tier-paid">${user.subscription_tier}</span>`;

  const memberSince = user.created_at
    ? new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : '—';

  const pillsHtml = ALL_SPORTS.map(s => `
    <div class="sport-pill${favoriteSports.includes(s) ? ' active' : ''}"
         data-sport="${s}" onclick="toggleFavSport(this)">${s}</div>
  `).join('');

  let favPicksHtml = '';
  if (!favoriteSports.length) {
    favPicksHtml = `<div style="padding:16px 20px 12px;font-size:13px;color:var(--muted);">Select sports above and save to see today's top picks here.</div>`;
  } else {
    const filtered = (allPicks || []).filter(p => favoriteSports.includes((p.sport || '').toUpperCase()));
    if (!filtered.length) {
      favPicksHtml = `<div style="padding:16px 20px 12px;font-size:13px;color:var(--muted);">No picks today for ${favoriteSports.join(', ')}.</div>`;
    } else {
      const rows = filtered.slice(0, 10).map(p => {
        const heat = PICK_HEAT_COLOR(p.score || 0);
        const isPush = p.result === 'push';
        const resultColor = p.result === 'win' ? '#4ade80' : p.result === 'loss' ? '#f87171' : 'var(--muted)';
        const resultLabel = p.result === 'win' ? 'W' : p.result === 'loss' ? 'L' : p.result === 'push' ? 'P' : '—';
        const clickAttr = p.espn_game_id
          ? `onclick="openGameModal('${p.espn_game_id}','${p.pick_type}','${(p.team||'').replace(/'/g,"\\'")}')"`
          : '';
        return `<div style="display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid var(--border);font-size:13px;${p.espn_game_id?'cursor:pointer;':''}${isPush?'opacity:0.45;':''}" ${clickAttr}>
          <div style="flex:1;font-weight:600;">${matchupLabel(p)}
            <div style="font-size:11px;color:var(--muted);font-weight:400;">${scoreDisplay(p)}</div>
          </div>
          <div>${sportBadge(p.sport)}</div>
          <div style="color:var(--muted);font-size:12px;width:90px;">${pickLabel(p)}</div>
          <div style="color:${heat.color};font-weight:700;width:36px;text-align:right;">${p.score ?? '—'}${heat.fire ? ' 🔥' : ''}</div>
          <div style="color:${resultColor};font-weight:700;width:24px;text-align:right;">${resultLabel}</div>
        </div>`;
      }).join('');
      favPicksHtml = rows;
    }
  }

  const resolvedVotes = votes.filter(v => v.result === 'win' || v.result === 'loss' || v.result === 'push');
  const unit    = 20;
  const totalPL = +resolvedVotes.reduce((s, v) => s + calcVoteReturn(v, unit), 0).toFixed(2);
  const wins    = resolvedVotes.filter(v => v.result === 'win').length;
  const losses  = resolvedVotes.filter(v => v.result === 'loss').length;
  const pushes  = resolvedVotes.filter(v => v.result === 'push').length;
  const decided = wins + losses;
  const winPct  = decided > 0 ? Math.round((wins / decided) * 100) : null;

  const votesHtml = votes.length === 0
    ? `<div style="padding:28px 20px;color:var(--muted);font-size:14px;">No votes cast yet. Click any pick row or schedule game to vote.</div>`
    : votes.map(v => {
        const matchup   = v.home_team ? `${v.away_team} @ ${v.home_team}` : `Game ${v.espn_game_id}`;
        const slotLabel = voteSlotLabel(v);
        const canDelete = v.status === 'pre';

        const statusStr = v.status === 'in'   ? `<span style="color:#38bdf8;font-size:12px;">LIVE ${v.away_score}–${v.home_score}</span>`
                        : v.status === 'post'  ? `<span style="color:var(--muted);font-size:12px;">Final ${v.away_score}–${v.home_score}</span>`
                        : v.start_time         ? `<span style="color:var(--muted);font-size:12px;">${new Date(v.start_time).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',hour12:true})}</span>`
                        : '';

        const score     = v.score != null ? v.score : '—';
        const heatColor = v.score ? PICK_HEAT_COLOR(v.score).color : 'var(--muted)';
        const isPush    = v.result === 'push';

        const resultStr = v.result === 'win'  ? `<span class="result-win">W</span>`
                        : v.result === 'loss' ? `<span class="result-loss">L</span>`
                        : v.result === 'push' ? `<span class="result-push">P</span>`
                        : `<span style="color:var(--muted);">—</span>`;

        const openAttr = v.espn_game_id && v.home_team
          ? `onclick="openGameModal('${v.espn_game_id}','${v.pick_type || ''}','${(v.team||'').replace(/'/g,"\\'")}')"`
          : '';

        const deleteBtn = canDelete
          ? `<button onclick="event.stopPropagation(); deleteVote('${v.espn_game_id}','${v.pick_slot}')"
               style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;margin-left:8px;flex-shrink:0;"
               title="Remove vote">✕</button>`
          : '';

        return `
          <div class="voted-pick-row${isPush ? '" style="opacity:0.45;' : '"'}" ${openAttr} style="${v.espn_game_id && v.home_team ? 'cursor:pointer;' : ''}${isPush ? 'opacity:0.45;' : ''}">
            <div class="voted-pick-matchup">
              <div>${matchup} ${v.sport ? sportBadge(v.sport) : ''}</div>
              <div class="voted-pick-sub">${statusStr}</div>
            </div>
            <div class="voted-pick-slot" style="display:flex;align-items:center;">${slotLabel}${deleteBtn}</div>
            <div class="voted-pick-score" style="color:${heatColor};">${score}</div>
            <div class="voted-pick-result">${resultStr}</div>
          </div>`;
      }).join('');

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:300px 1fr;gap:24px;align-items:start;">

      <!-- Left column: account info + sport prefs -->
      <div>
        <div class="card" style="margin-bottom:20px;">
          <div class="card-header"><span class="card-title">Account</span></div>
          <div style="padding:4px 20px 12px;">
            <div class="account-info-row">
              <span class="account-info-label">Email</span>
              <span class="account-info-val" style="font-size:13px;">${user.email}</span>
            </div>
            <div class="account-info-row">
              <span class="account-info-label">Plan</span>
              <span class="account-info-val">${tierLabel}</span>
            </div>
            <div class="account-info-row">
              <span class="account-info-label">Member since</span>
              <span class="account-info-val">${memberSince}</span>
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:20px;">
          <div class="card-header">
            <span class="card-title">${user.subscription_tier === 'free' ? 'Access Code' : 'Access Status'}</span>
          </div>
          <div style="padding:14px 20px 18px;">
            ${accessStatusWidget(user)}
          </div>
        </div>

        <div class="card">
          <div class="card-header"><span class="card-title">Favorite Sports</span></div>
          <div style="padding:16px 20px 18px;">
            <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">Pick your sports to filter your personal feed.</div>
            <div class="sport-pill-grid" id="fav-sport-pills">${pillsHtml}</div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:12px;">
              <button class="sport-pill-save" onclick="saveFavSports()">Save</button>
              <span class="sport-pill-saved" id="fav-saved-msg" style="display:none;">Saved!</span>
            </div>
          </div>
          ${favPicksHtml
            ? `<div style="border-top:1px solid var(--border);">
                 <div style="padding:10px 20px 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);">Today's Top Picks</div>
                 ${favPicksHtml}
               </div>`
            : ''}
        </div>
      </div>

      <!-- Right column: P/L graph + voted picks -->
      <div>
        <div class="graph-card" style="margin-bottom:20px;">
          <div class="graph-header">
            <span class="graph-title">My Voted Picks P/L</span>
            <div style="display:flex;align-items:center;gap:16px;">
              <div class="unit-input-row">
                <span>Unit</span>
                <input type="number" id="voted-unit-size" value="20" min="1" max="10000"
                       onchange="drawVotedPlGraph(window._accountVotes || [], parseFloat(this.value)||20)"
                       style="width:72px;" />
              </div>
              <div>
                <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px;">ALL-TIME P/L</div>
                <div class="graph-pl-label${totalPL >= 0 ? ' pos' : ' neg'}" id="voted-pl-total">${totalPL >= 0 ? '+' : ''}$${Math.abs(totalPL).toFixed(2)}</div>
              </div>
            </div>
          </div>
          <div class="graph-canvas-wrap">
            <canvas id="voted-pl-chart"></canvas>
          </div>
          <div style="display:flex;gap:24px;margin-top:14px;flex-wrap:wrap;">
            <div class="record-item"><div class="record-val green">${wins}</div><div class="record-label">Wins</div></div>
            <div class="record-item"><div class="record-val red">${losses}</div><div class="record-label">Losses</div></div>
            <div class="record-item"><div class="record-val">${pushes}</div><div class="record-label">Pushes</div></div>
            <div class="record-item"><div class="record-val gold">${winPct !== null ? winPct + '%' : '—'}</div><div class="record-label">Win Rate</div></div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">My Votes</span>
            <span style="font-size:12px;color:var(--muted);">Pre-game votes can be removed</span>
          </div>
          ${votes.length > 0 ? `
          <div style="display:flex;align-items:center;padding:8px 20px 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);background:var(--surface2);border-bottom:1px solid var(--border);">
            <span style="flex:1;">Game</span>
            <span style="flex:0 0 130px;">My Vote</span>
            <span style="flex:0 0 56px;text-align:right;">Score</span>
            <span style="flex:0 0 56px;text-align:right;">Result</span>
          </div>` : ''}
          <div id="voted-picks-list">${votesHtml}</div>
        </div>
      </div>

    </div>`;

  window._accountVotes = votes;
  requestAnimationFrame(() => drawVotedPlGraph(votes, unit));
}

Object.assign(window, { deleteVote, toggleFavSport, saveFavSports, drawVotedPlGraph });
