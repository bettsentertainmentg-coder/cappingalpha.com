// modules/picks.js — Today's picks table

import { state } from './state.js';
import { isPaying, isViewer, isAccount } from './auth.js';
import { pickLabel, sportBadge, matchupLabel, scoreDisplay, LOCK_SVG } from './utils.js';
import { inlinePaywallHtml } from './paywall.js';

export async function loadPicks() {
  try {
    const res = await fetch('/api/picks');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.allPicks = await res.json();
    renderPicks(state.allPicks);
    document.getElementById('last-refresh').textContent =
      'Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    // Notify sports tab to refresh if it's loaded
    document.dispatchEvent(new CustomEvent('picksUpdated'));
  } catch (err) {
    document.getElementById('picks-body').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠</div><h3>Failed to load picks</h3><p>${err.message}</p></div>`;
  }
}

// globalRanks: optional Map<pick.id, globalRank> — when provided (sports tab),
// paywall visibility is determined by global rank, not local position in the filtered list.
export function renderPicks(picks, targetId = 'picks-body', globalRanks = null) {
  const el = document.getElementById(targetId);

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
    const isMvp  = (p.score || 0) >= state.CONFIG.mvp_threshold;
    const isLive = p.game_status === 'in';
    const pick   = locked ? `<span class="lock-icon">${LOCK_SVG}</span>` : pickLabel(p);

    const clickable = !locked && p.espn_game_id;
    const clickAttr = clickable
      ? ` onclick="openGameModal('${p.espn_game_id}','${p.pick_type}','${(p.team||'').replace(/'/g,"\\'")}')"`
      : '';
    const cursorStyle = clickable ? ' cursor:pointer;' : '';

    const scoreHidden  = !isPaying() && rank > 1 && rank <= 30;
    const scoreContent = scoreHidden ? LOCK_SVG : (p.score ?? '—');

    const mvpBadge  = isMvp ? ' <span class="badge-mvp" style="font-size:0.6em;vertical-align:middle;">MVP</span>' : '';
    const rankInner = rank === 1 ? `★${mvpBadge}` : `${rank}${mvpBadge}`;
    const rankTd    = `<td class="rank ${rank === 1 ? 'rank-1' : ''}">
      ${locked ? `<span class="blurred">${rankInner}</span>` : rankInner}
      <span class="rank-score-mobile${locked ? ' blurred' : ''}">${locked ? '' : scoreContent}</span>
    </td>`;

    return `
      <tr class="${locked ? 'locked' : ''} ${isMvp ? 'mvp-row' : ''} ${isLive ? 'live-row' : ''}"${clickAttr} style="${cursorStyle}">
        ${rankTd}
        <td class="matchup-cell${locked ? ' blurred' : ''}">${matchupLabel(p)}${scoreDisplay(p)}</td>
        <td class="${locked ? 'blurred' : ''}">${sportBadge(p.sport)}</td>
        <td class="pick-cell${locked ? ' blurred' : ''}" style="${!locked && p.result === 'win' ? 'color:#4ade80' : !locked && p.result === 'loss' ? 'color:#f87171' : ''}">${pick}</td>
        <td class="score-col ${locked ? 'blurred' : ''}">${scoreContent}</td>
      </tr>`;
  };

  const makePushRow = (p) => {
    const clickable = p.espn_game_id;
    const clickAttr = clickable
      ? ` onclick="openGameModal('${p.espn_game_id}','${p.pick_type}','${(p.team||'').replace(/'/g,"\\'")}')"`
      : '';
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

  const pubTableOpen = `<div class="table-scroll"><table><thead><tr><th>Rank</th><th>Matchup</th><th>Sport</th><th>Pick</th><th class="score-col">Score</th></tr></thead><tbody>`;
  const pubTableClose = `</tbody></table></div>`;

  // Free user — sports tab passes globalRanks so only the true #1 overall pick is unlocked
  if (globalRanks) {
    const gr = p => globalRanks.get(p.id) ?? 999;
    const rank1 = activePicks.find(p => gr(p) === 1);
    const rank2 = activePicks.find(p => gr(p) === 2);
    const publicPicks = activePicks.filter(p => gr(p) > 30);
    const hasLocked   = activePicks.some(p => gr(p) >= 2 && gr(p) <= 30);

    const topRows = [
      rank1 ? makeRow(rank1, 1, false) : '',
      rank2 ? makeRow(rank2, 2, true)  : '',
    ].join('');

    const publicSection = (publicPicks.length || pushPicks.length)
      ? pubTableOpen
        + publicPicks.map(p => makeRow(p, gr(p), false)).join('')
        + pushPicks.map(p => makePushRow(p)).join('')
        + pubTableClose
      : '';

    if (!topRows && !publicSection) {
      el.innerHTML = `
        <div class="empty">
          <div class="empty-icon">🕐</div>
          <h3>No picks yet today.</h3>
          <p>Check back after 6am ET once the scanner runs.</p>
        </div>` + inlinePaywallHtml();
      return;
    }

    el.innerHTML =
      (topRows ? thead + topRows + `</tbody></table></div>` : '') +
      ((topRows || hasLocked) ? inlinePaywallHtml() : '') +
      publicSection;
    return;
  }

  // Free user — main picks tab (no globalRanks, local ranking)
  const row1 = activePicks[0] ? makeRow(activePicks[0], 1, false) : '';
  const row2 = activePicks[1] ? makeRow(activePicks[1], 2, true)  : '';

  const publicPicks   = activePicks.slice(30);
  const publicRows    = publicPicks.map((p, i) => makeRow(p, 31 + i, false));
  const publicSection = (publicRows.length || pushPicks.length)
    ? pubTableOpen
      + publicRows.join('') + pushPicks.map(p => makePushRow(p)).join('')
      + pubTableClose
    : '';

  el.innerHTML =
    thead + row1 + row2 + `</tbody></table></div>` +
    inlinePaywallHtml() +
    publicSection;
}
