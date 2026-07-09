// modules/picks.js — Today's picks table

import { state } from './state.js';
import { isPaying, isViewer, isAccount } from './auth.js';
import { pickLabel, sportBadge, matchupLabel, scoreDisplay, LOCK_SVG, pickSlotKey } from './utils.js?v=2';
import { inlinePaywallHtml, lockedRankingsBoxHtml } from './paywall.js';

export async function loadPicks() {
  try {
    const res = await fetch('/api/picks');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.allPicks = await res.json();
    renderPicks(state.allPicks);
    const refreshEl = document.getElementById('last-refresh');
    if (refreshEl) refreshEl.textContent =
      'Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    // Notify sports tab to refresh if it's loaded
    document.dispatchEvent(new CustomEvent('picksUpdated'));
  } catch (err) {
    const errEl = document.getElementById('picks-body');
    if (errEl) errEl.innerHTML =
      `<div class="empty"><div class="empty-icon">⚠</div><h3>Failed to load picks</h3><p>${err.message}</p></div>`;
  }
}

// globalRanks: optional Map<pick.id, globalRank> — when provided (sports tab),
// paywall visibility is determined by global rank, not local position in the filtered list.
export function renderPicks(picks, targetId = 'picks-body', globalRanks = null) {
  const el = document.getElementById(targetId);
  if (!el) return;

  // Paywall boundary (server is source of truth via /api/config). Free users see
  // rank #1 + the public tail (rank > MAX); ranks 2..MAX are paid-only.
  const MAX = state.CONFIG?.paid_rank_max || 50;

  if (!picks || picks.length === 0) {
    const emptyHtml = `
      <div class="empty">
        <div class="empty-icon">🕐</div>
        <h3>No picks yet today.</h3>
        <p>Check back after 6am ET once the scanner runs.</p>
      </div>`;
    el.innerHTML = isPaying() ? emptyHtml : emptyHtml + inlinePaywallHtml();
    return;
  }

  const activePicks = picks.filter(p => p.result !== 'push');
  const pushPicks   = picks.filter(p => p.result === 'push');

  const makeRow = (p, rank, locked = false) => {
    const score      = p.score || 0;
    const isMvp      = score >= state.CONFIG.mvp_threshold;
    const isGoldMvp  = score >= (state.CONFIG.mvp_display_threshold || state.CONFIG.mvp_threshold);
    const isLive     = p.game_status === 'in';
    const pick       = locked ? `<span class="lock-icon">${LOCK_SVG}</span>` : pickLabel(p);

    const clickable = !locked && p.espn_game_id;
    const slotKey   = clickable ? pickSlotKey(p) : '';
    const destUrl   = clickable
      ? `/game/${p.espn_game_id}${slotKey ? '?slot=' + slotKey : ''}`
      : '';
    const clickAttr = clickable ? ` onclick="window.location.href='${destUrl}'"` : '';
    const cursorStyle = clickable ? ' cursor:pointer;' : '';

    const scoreHidden  = !isPaying() && rank > 1 && rank <= MAX;
    const scoreContent = scoreHidden ? LOCK_SVG : (p.score ?? '—');

    const starColor = isMvp ? 'var(--gold)' : 'inherit';
    const badgeColor = isGoldMvp ? '' : 'background:rgba(160,174,192,0.15);color:#a0aec0;border-color:rgba(160,174,192,0.3);';
    const mvpBadge  = isMvp ? ` <span class="badge-mvp" style="font-size:0.6em;vertical-align:middle;${badgeColor}">CA</span>` : '';
    const starSpan  = rank === 1
      ? (isMvp
          ? `<span style="color:var(--gold);font-weight:700;white-space:nowrap;">#1 ★</span>`
          : `<span class="star-silver" style="font-weight:700;white-space:nowrap;">#1 ★</span>`)
      : '';
    const rankInner = rank === 1 ? `${starSpan}${mvpBadge}` : `${rank}${mvpBadge}`;
    const rankTd    = `<td class="rank ${rank === 1 ? 'rank-1' : ''}">
      ${locked ? `<span class="blurred">${rankInner}</span>` : rankInner}
      <span class="rank-score-mobile${locked ? ' blurred' : ''}">${locked ? '—' : scoreContent}</span>
    </td>`;

    return `
      <tr class="${locked ? 'locked' : ''} ${isMvp ? (isGoldMvp ? 'mvp-row' : 'mvp-row-silver') : ''} ${isLive ? 'live-row' : ''}"${clickAttr} style="${cursorStyle}">
        ${rankTd}
        <td class="matchup-cell${locked ? ' blurred' : ''}">${matchupLabel(p)}${scoreDisplay(p)}</td>
        <td class="${locked ? 'blurred' : ''}">${sportBadge(p.sport)}</td>
        <td class="pick-cell${locked ? ' blurred' : ''}" style="${!locked && p.result === 'win' ? 'color:#4ade80' : !locked && p.result === 'loss' ? 'color:#f87171' : ''}">${pick}</td>
        <td class="score-col ${locked ? 'blurred' : ''}">${scoreContent}</td>
      </tr>`;
  };

  const makePushRow = (p) => {
    const clickable = p.espn_game_id;
    const slotKey   = clickable ? pickSlotKey(p) : '';
    const destUrl   = clickable
      ? `/game/${p.espn_game_id}${slotKey ? '?slot=' + slotKey : ''}`
      : '';
    const clickAttr = clickable ? ` onclick="window.location.href='${destUrl}'"` : '';
    return `
      <tr style="opacity:0.45;${clickable ? 'cursor:pointer;' : ''}"${clickAttr}>
        <td class="rank" style="color:var(--muted);">—<span class="rank-score-mobile">${p.score ?? '—'}</span></td>
        <td class="matchup-cell">${matchupLabel(p)}${scoreDisplay(p)}</td>
        <td>${sportBadge(p.sport)}</td>
        <td class="pick-cell" style="color:var(--muted);">${pickLabel(p)} <span style="font-size:11px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;margin-left:4px;">Push</span></td>
        <td class="score-col" style="color:var(--muted);">${p.score ?? '—'}</td>
      </tr>`;
  };

  const thead = `<div class="table-scroll"><table><thead><tr><th>Rank</th><th>Matchup</th><th>Sport</th><th>Pick</th><th class="score-col">Score</th></tr></thead><tbody>`;

  if (isPaying()) {
    const rows = activePicks.map((p, i) => {
      const rank = globalRanks ? (globalRanks.get(p.id) ?? i + 1) : i + 1;
      return makeRow(p, rank, false);
    });
    el.innerHTML = thead + [...rows, ...pushPicks.map(p => makePushRow(p))].join('') + `</tbody></table></div>`;
    return;
  }

  // Free tier. Show up to 10 ranked rows as a blurred board with a floating
  // "Unlock CappingAlpha" box over them, so visitors see the full slate exists (not
  // a single teaser). #1 stays visible for a logged-in free account; a logged-out
  // visitor has it blurred too (the server withholds every pick from them).
  const acct = isAccount();   // logged-in, unpaid
  const lockedBoard = (rowsHtml) =>
    `<div class="ca-rank-lock-wrap">${thead}${rowsHtml}</tbody></table></div>${lockedRankingsBoxHtml()}</div>`;

  // Sports tab passes globalRanks — the true #1 overall pick is the only unlock.
  if (globalRanks) {
    const gr = p => globalRanks.get(p.id) ?? 999;
    const ordered = [...activePicks].sort((a, b) => gr(a) - gr(b)).slice(0, 10);
    const rows = ordered.map(p => makeRow(p, gr(p), !(acct && gr(p) === 1))).join('');
    el.innerHTML = rows ? lockedBoard(rows) : inlinePaywallHtml();
    return;
  }

  // Main / home rankings list (local ranking). #1 shown for accounts, blurred for
  // logged-out; ranks 2+ always blurred. Capped at 10 (never the full 50).
  const rows = activePicks.slice(0, 10).map((p, i) => makeRow(p, i + 1, i === 0 ? !acct : true)).join('');
  el.innerHTML = rows ? lockedBoard(rows) : inlinePaywallHtml();
}
