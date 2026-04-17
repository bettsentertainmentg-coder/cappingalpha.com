// modules/modal.js — Game detail modal

import { state } from './state.js';
import { isPaying, isAccount, isViewer } from './auth.js';
import { LOCK_SVG, PICK_HEAT_COLOR, fmtOdds, fmtSpread, gameTime } from './utils.js';

// Team primary colors [primary, secondary]
const TEAM_COLORS = {
  // MLB
  'New York Yankees':      ['#003087','#C4CED4'],
  'Boston Red Sox':        ['#BD3039','#0C2340'],
  'Los Angeles Dodgers':   ['#005A9C','#EF3E42'],
  'San Francisco Giants':  ['#FD5A1E','#27251F'],
  'Chicago Cubs':          ['#0E3386','#CC3433'],
  'Chicago White Sox':     ['#27251F','#C4CED4'],
  'Houston Astros':        ['#002D62','#EB6E1F'],
  'Atlanta Braves':        ['#CE1141','#13274F'],
  'Philadelphia Phillies': ['#E81828','#002D72'],
  'New York Mets':         ['#002D72','#FF5910'],
  'St. Louis Cardinals':   ['#C41E3A','#0C2340'],
  'Milwaukee Brewers':     ['#12284B','#FFC52F'],
  'Cincinnati Reds':       ['#C6011F','#000000'],
  'Pittsburgh Pirates':    ['#27251F','#FDB827'],
  'Cleveland Guardians':   ['#E31937','#002B5C'],
  'Detroit Tigers':        ['#0C2340','#FA4616'],
  'Minnesota Twins':       ['#002B5C','#D31145'],
  'Kansas City Royals':    ['#004687','#BD9B60'],
  'Texas Rangers':         ['#003278','#C0111F'],
  'Seattle Mariners':      ['#005C5C','#0C2C56'],
  'Oakland Athletics':     ['#003831','#EFB21E'],
  'Los Angeles Angels':    ['#BA0021','#003263'],
  'San Diego Padres':      ['#2F241D','#FFC425'],
  'Colorado Rockies':      ['#33006F','#C4CED4'],
  'Arizona Diamondbacks':  ['#A71930','#E3D4AD'],
  'Miami Marlins':         ['#00A3E0','#FF6600'],
  'Tampa Bay Rays':        ['#092C5C','#8FBCE6'],
  'Baltimore Orioles':     ['#DF4601','#000000'],
  'Washington Nationals':  ['#AB0003','#14225A'],
  'Toronto Blue Jays':     ['#134A8E','#1D2D5C'],
  // NBA
  'Los Angeles Lakers':    ['#552583','#FDB927'],
  'Boston Celtics':        ['#007A33','#BA9653'],
  'Golden State Warriors': ['#1D428A','#FFC72C'],
  'Miami Heat':            ['#98002E','#F9A01B'],
  'Chicago Bulls':         ['#CE1141','#000000'],
  'Brooklyn Nets':         ['#000000','#FFFFFF'],
  'New York Knicks':       ['#006BB6','#F58426'],
  'Dallas Mavericks':      ['#00538C','#002B5E'],
  'Denver Nuggets':        ['#0E2240','#FEC524'],
  'Phoenix Suns':          ['#1D1160','#E56020'],
  'Milwaukee Bucks':       ['#00471B','#EEE1C6'],
  'Philadelphia 76ers':    ['#006BB6','#ED174C'],
  'Toronto Raptors':       ['#CE1141','#000000'],
  'Atlanta Hawks':         ['#E03A3E','#C1D32F'],
  'Cleveland Cavaliers':   ['#860038','#FDBB30'],
  'Indiana Pacers':        ['#002D62','#FDBB30'],
  'Charlotte Hornets':     ['#1D1160','#00788C'],
  'Orlando Magic':         ['#0077C0','#C4CED3'],
  'Washington Wizards':    ['#002B5C','#E31837'],
  'Detroit Pistons':       ['#C8102E','#006BB6'],
  'Minnesota Timberwolves':['#0C2340','#236192'],
  'Oklahoma City Thunder': ['#007AC1','#EF3B24'],
  'Portland Trail Blazers':['#E03A3E','#000000'],
  'Utah Jazz':             ['#002B5C','#00471B'],
  'Sacramento Kings':      ['#5A2D81','#63727A'],
  'San Antonio Spurs':     ['#C4CED4','#000000'],
  'Houston Rockets':       ['#CE1141','#000000'],
  'Memphis Grizzlies':     ['#5D76A9','#12173F'],
  'New Orleans Pelicans':  ['#0C2340','#C8102E'],
  'Los Angeles Clippers':  ['#C8102E','#1D428A'],
  // NHL
  'Boston Bruins':         ['#FCB514','#000000'],
  'New York Rangers':      ['#0038A8','#CE1126'],
  'Pittsburgh Penguins':   ['#CFC493','#000000'],
  'Chicago Blackhawks':    ['#CF0A2C','#000000'],
  'Montreal Canadiens':    ['#AF1E2D','#192168'],
  'Toronto Maple Leafs':   ['#00205B','#FFFFFF'],
  'Tampa Bay Lightning':   ['#002868','#FFFFFF'],
  'Colorado Avalanche':    ['#6F263D','#236192'],
  'Vegas Golden Knights':  ['#B4975A','#333F48'],
  'Carolina Hurricanes':   ['#CC0000','#000000'],
  'Dallas Stars':          ['#006847','#8F8F8C'],
  'St. Louis Blues':       ['#002F87','#FCB514'],
  'Edmonton Oilers':       ['#041E42','#FF4C00'],
  'Washington Capitals':   ['#041E42','#C8102E'],
  'New York Islanders':    ['#00539B','#F47D30'],
  'Minnesota Wild':        ['#154734','#A6192E'],
  'Philadelphia Flyers':   ['#F74902','#000000'],
  'Florida Panthers':      ['#041E42','#C8102E'],
  'Anaheim Ducks':         ['#F47A38','#B9975B'],
  'Los Angeles Kings':     ['#111111','#A2AAAD'],
  'San Jose Sharks':       ['#006D75','#EA7200'],
  'Seattle Kraken':        ['#001628','#99D9D9'],
  'Vancouver Canucks':     ['#00205B','#00843D'],
  'Calgary Flames':        ['#C8102E','#F1BE48'],
  'Ottawa Senators':       ['#C8102E','#C69214'],
  'Buffalo Sabres':        ['#003399','#FCB514'],
  'Detroit Red Wings':     ['#CE1126','#FFFFFF'],
  'Columbus Blue Jackets': ['#002654','#CE1126'],
  'New Jersey Devils':     ['#CE1126','#000000'],
  'Nashville Predators':   ['#FFB81C','#041E42'],
  'Winnipeg Jets':         ['#041E42','#004C97'],
  'Arizona Coyotes':       ['#8C2633','#E2D6B5'],
};

let _modalData = null;

function buildSlots(game) {
  return [
    { key: 'home_ml',     label: `${game.home_team?.split(' ').pop() || 'Home'} ML`,     type: 'ml',     team: game.home_team },
    { key: 'away_ml',     label: `${game.away_team?.split(' ').pop() || 'Away'} ML`,     type: 'ml',     team: game.away_team },
    { key: 'home_spread', label: `${game.home_team?.split(' ').pop() || 'Home'} Spread`, type: 'spread', team: game.home_team },
    { key: 'away_spread', label: `${game.away_team?.split(' ').pop() || 'Away'} Spread`, type: 'spread', team: game.away_team },
    { key: 'over',        label: `Over ${game.over_under || ''}`,                        type: 'over',   team: null },
    { key: 'under',       label: `Under ${game.over_under || ''}`,                       type: 'under',  team: null },
  ];
}

function buildPickBySlot(picks) {
  const pickBySlot = {};
  for (const p of picks) {
    const pt = (p.pick_type || '').toLowerCase();
    const isHome = p.is_home_team === 1 || p.is_home_team === true;
    if (pt === 'ml')     pickBySlot[isHome ? 'home_ml'     : 'away_ml']     = p;
    if (pt === 'spread') pickBySlot[isHome ? 'home_spread' : 'away_spread'] = p;
    if (pt === 'over')   pickBySlot['over']  = p;
    if (pt === 'under')  pickBySlot['under'] = p;
  }
  return pickBySlot;
}

export function openGameModal(espn_game_id, clickedType = null, clickedTeam = null) {
  const modal   = document.getElementById('game-modal');
  const content = document.getElementById('game-modal-content');
  modal.classList.remove('hidden');
  content.innerHTML = `<div style="padding:48px;text-align:center;color:var(--muted);">Loading...</div>`;

  fetch(`/api/game/${espn_game_id}`)
    .then(r => r.json())
    .then(data => {
      _modalData = data;
      renderGameModal(data, clickedType, clickedTeam);
    })
    .catch(() => {
      content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--red);">Failed to load game data.</div>`;
    });
}

export function closeGameModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('game-modal').classList.add('hidden');
  document.getElementById('game-modal-content').innerHTML = '';
  _modalData = null;
}

export function renderGameModal(data, clickedType, clickedTeam) {
  const { game, picks, votes, userVote } = data;
  const content = document.getElementById('game-modal-content');

  const matchup = `${game.away_team || '?'} @ ${game.home_team || '?'}`;
  let statusStr = '';
  if (game.status === 'post') {
    statusStr = `<span style="color:var(--muted);font-size:13px;">${game.away_score}–${game.home_score} Final</span>`;
  } else if (game.status === 'in') {
    statusStr = `<span class="game-score-live">${game.away_score}–${game.home_score} LIVE</span>`;
  } else {
    statusStr = `<span class="game-time">${gameTime(game.start_time)}</span>`;
  }

  const SLOTS      = buildSlots(game);
  const pickBySlot = buildPickBySlot(picks);

  // Determine initial active slot
  let activeSlot = null;
  if (clickedType && clickedTeam) {
    const ct = clickedType.toLowerCase();
    if (ct === 'over' || ct === 'under') {
      activeSlot = ct;
    } else {
      const nick     = (clickedTeam || '').split(' ').pop().toLowerCase();
      const homeNick = (game.home_team || '').split(' ').pop().toLowerCase();
      const isHome   = nick === homeNick;
      if (ct === 'ml')     activeSlot = isHome ? 'home_ml'     : 'away_ml';
      if (ct === 'spread') activeSlot = isHome ? 'home_spread' : 'away_spread';
    }
  }
  if (!activeSlot) {
    let best = null, bestScore = -1;
    for (const [k, p] of Object.entries(pickBySlot)) {
      if ((p.score || 0) > bestScore) { bestScore = p.score || 0; best = k; }
    }
    activeSlot = best || 'home_ml';
  }

  const sorted = [...SLOTS].sort((a, b) => {
    if (a.key === activeSlot) return -1;
    if (b.key === activeSlot) return  1;
    return ((pickBySlot[b.key]?.score || 0) - (pickBySlot[a.key]?.score || 0));
  });

  const TICKER_PAIRS = { home_ml:'away_ml', away_ml:'home_ml', home_spread:'away_spread', away_spread:'home_spread', over:'under', under:'over' };

  const tickerHtml = sorted.map(slot => {
    const p     = pickBySlot[slot.key];
    const score = p?.score || 0;
    const heat  = PICK_HEAT_COLOR(score);
    const isActive = slot.key === activeSlot;

    const slotRank   = (data.pickRanks && p?.id) ? (data.pickRanks[p.id] || 0) : 0;
    const pairedKey  = TICKER_PAIRS[slot.key];
    const pairedP    = pairedKey ? pickBySlot[pairedKey] : null;
    const pairedRank = (data.pickRanks && pairedP?.id) ? (data.pickRanks[pairedP.id] || 0) : 0;
    const betTypeTop30 = (slotRank > 0 && slotRank <= 30) || (pairedRank > 0 && pairedRank <= 30);
    const scoreHidden  = !isPaying() && betTypeTop30;

    const chipScore = scoreHidden
      ? `<span class="chip-score">${LOCK_SVG}</span>`
      : `<span class="chip-score" style="color:${heat.color};">${score > 0 ? score : '—'}${heat.fire ? ' 🔥' : ''}</span>`;

    return `<div class="ticker-chip${isActive ? ' active' : ''}${score === 0 && !betTypeTop30 ? ' zero' : ''}"
      onclick="selectTickerSlot('${slot.key}')">
      <span class="chip-label">${slot.label}</span>
      ${chipScore}
    </div>`;
  }).join('');

  content.innerHTML = `
    <div class="game-modal-header">
      <div>
        <div class="game-modal-title">${matchup}</div>
        <div class="game-modal-meta">
          <span class="sport-badge">${game.sport || ''}</span>
          ${statusStr}
        </div>
      </div>
    </div>
    <div class="game-ticker">${tickerHtml}</div>
    <div class="game-modal-body">
      <div class="game-modal-left">
        <div id="pick-info-panel"></div>
      </div>
      <div class="game-modal-right">
        <div id="sentiment-panel"></div>
      </div>
    </div>
    <div id="game-data-panel" class="game-data-full"></div>`;

  renderPickInfo(data, activeSlot, pickBySlot, SLOTS);
  renderGameData(data);
  renderSentiment(data, activeSlot, game.status, pickBySlot);
}

export function selectTickerSlot(slotKey) {
  if (!_modalData) return;
  const { game, picks } = _modalData;
  const pickBySlot = buildPickBySlot(picks);
  const SLOTS      = buildSlots(game);

  renderPickInfo(_modalData, slotKey, pickBySlot, SLOTS);
  renderSentiment(_modalData, slotKey, _modalData.game.status, pickBySlot);

  document.querySelectorAll('.ticker-chip').forEach(chip => {
    const onclickVal = chip.getAttribute('onclick') || '';
    chip.classList.toggle('active', onclickVal.includes(`'${slotKey}'`));
  });
}

function renderPickInfo(data, slotKey, pickBySlot, SLOTS) {
  const el = document.getElementById('pick-info-panel');
  if (!el) return;
  const { game, lines } = data;
  const p    = pickBySlot[slotKey];
  const slot = SLOTS.find(s => s.key === slotKey);

  // Lines computed up front — shown regardless of whether a pick exists
  let currentLine = '—';
  if (slotKey === 'home_ml')     currentLine = game.ml_home     != null ? fmtOdds(game.ml_home)       : '—';
  if (slotKey === 'away_ml')     currentLine = game.ml_away     != null ? fmtOdds(game.ml_away)       : '—';
  if (slotKey === 'home_spread') currentLine = game.spread_home != null ? fmtSpread(game.spread_home) : '—';
  if (slotKey === 'away_spread') currentLine = game.spread_away != null ? fmtSpread(game.spread_away) : '—';
  if (slotKey === 'over')        currentLine = game.over_under  != null ? `o${game.over_under}`       : '—';
  if (slotKey === 'under')       currentLine = game.over_under  != null ? `u${game.over_under}`       : '—';

  const dk = lines?.draftkings;
  const fd = lines?.fanduel;
  let dkLine = '—', fdLine = '—';
  if (dk) {
    if (slotKey === 'home_ml')     dkLine = dk.ml_home     != null ? fmtOdds(dk.ml_home)       : '—';
    if (slotKey === 'away_ml')     dkLine = dk.ml_away     != null ? fmtOdds(dk.ml_away)       : '—';
    if (slotKey === 'home_spread') dkLine = dk.spread_home != null ? fmtSpread(dk.spread_home) : '—';
    if (slotKey === 'away_spread') dkLine = dk.spread_away != null ? fmtSpread(dk.spread_away) : '—';
    if (slotKey === 'over')        dkLine = dk.over_under  != null ? `o${dk.over_under} (${fmtOdds(dk.ou_over_odds  || -110)})` : '—';
    if (slotKey === 'under')       dkLine = dk.over_under  != null ? `u${dk.over_under} (${fmtOdds(dk.ou_under_odds || -110)})` : '—';
  }
  if (fd) {
    if (slotKey === 'home_ml')     fdLine = fd.ml_home     != null ? fmtOdds(fd.ml_home)       : '—';
    if (slotKey === 'away_ml')     fdLine = fd.ml_away     != null ? fmtOdds(fd.ml_away)       : '—';
    if (slotKey === 'home_spread') fdLine = fd.spread_home != null ? fmtSpread(fd.spread_home) : '—';
    if (slotKey === 'away_spread') fdLine = fd.spread_away != null ? fmtSpread(fd.spread_away) : '—';
    if (slotKey === 'over')        fdLine = fd.over_under  != null ? `o${fd.over_under} (${fmtOdds(fd.ou_over_odds  || -110)})` : '—';
    if (slotKey === 'under')       fdLine = fd.over_under  != null ? `u${fd.over_under} (${fmtOdds(fd.ou_under_odds || -110)})` : '—';
  }

  const linesHtml = `
    <div class="pick-info-lines">
      <div class="line-row"><span class="line-book">Current</span> <span class="line-val">${currentLine}</span></div>
      <div class="line-row"><span class="line-book"><img src="https://www.draftkings.com/favicon.ico" width="13" height="13" style="vertical-align:middle;border-radius:2px;margin-right:5px;" onerror="this.style.display='none'">DraftKings</span> <span class="line-val">${dkLine}</span></div>
      <div class="line-row"><span class="line-book"><img src="https://www.fanduel.com/favicon.ico" width="13" height="13" style="vertical-align:middle;border-radius:2px;margin-right:5px;" onerror="this.style.display='none'">FanDuel</span> <span class="line-val">${fdLine}</span></div>
    </div>`;

  if (!p) {
    // Check if the paired slot (other ML, spread side, or O/U partner) is top 30 —
    // if so, this slot should appear locked rather than greyed/empty.
    const SLOT_PAIRS    = { home_ml:'away_ml', away_ml:'home_ml', home_spread:'away_spread', away_spread:'home_spread', over:'under', under:'over' };
    const pairedSlotKey = SLOT_PAIRS[slotKey];
    const pairedPick    = pairedSlotKey ? pickBySlot[pairedSlotKey] : null;
    const pairedRank    = (data.pickRanks && pairedPick?.id) ? (data.pickRanks[pairedPick.id] || 0) : 0;
    const pairIsTop30   = pairedRank > 0 && pairedRank <= 30;

    if (!isPaying() && pairIsTop30) {
      // The adjacent bet type has a top-30 pick — show as locked, not empty
      const lockedBox = `<div class="pick-score-box locked-score">
        <span class="pick-score-brand">Capping<span>Alpha</span> Score</span>
        <span class="score-locked-msg">${isViewer()
          ? `${LOCK_SVG} <a onclick="openSignup()" style="color:var(--gold);cursor:pointer;">Create a free account</a> to see picks`
          : `${LOCK_SVG} <a onclick="openCodeEntry()" style="color:var(--gold);cursor:pointer;">Upgrade</a> to unlock scores`}</span>
      </div>`;
      el.innerHTML = lockedBox + `<div class="pick-info-label">${slot?.label || slotKey}</div>` + linesHtml;
    } else {
      // No pick and no locked pair — show greyed "no value" box with score 0 + lines
      const noValueBox = `<div class="pick-score-box" style="opacity:0.55;">
        <span class="pick-score-brand">Capping<span>Alpha</span> Score</span>
        <span class="pick-info-score" style="color:var(--muted);">0</span>
        <span style="font-size:11px;color:var(--muted);margin-top:4px;display:block;">CappingAlpha doesn't see value in this line right now</span>
      </div>`;
      el.innerHTML = noValueBox + `<div class="pick-info-label">${slot?.label || slotKey}</div>` + linesHtml;
    }
    return;
  }

  const heat  = PICK_HEAT_COLOR(p.score || 0);
  const isMvp = (p.score || 0) >= (state.CONFIG?.mvp_threshold || 50);

  const SLOT_PAIRS     = { home_ml:'away_ml', away_ml:'home_ml', home_spread:'away_spread', away_spread:'home_spread', over:'under', under:'over' };
  const pickRank       = (data.pickRanks && p.id) ? (data.pickRanks[p.id] || 0) : 0;
  const pairedSlotKey  = SLOT_PAIRS[slotKey];
  const pairedPick     = pairedSlotKey ? pickBySlot[pairedSlotKey] : null;
  const pairedRank     = (data.pickRanks && pairedPick?.id) ? (data.pickRanks[pairedPick.id] || 0) : 0;
  const betTypeIsTop30 = (pickRank > 0 && pickRank <= 30) || (pairedRank > 0 && pairedRank <= 30);
  const showScore      = isPaying() || (isAccount() && !betTypeIsTop30);

  const scoreBoxHtml = showScore
    ? `<div class="pick-score-box${isMvp ? ' mvp' : ''}">
        <span class="pick-score-brand">Capping<span>Alpha</span> Score</span>
        <span class="pick-info-score" style="color:${isMvp ? '#000' : heat.color};">${p.score || 0}${heat.fire ? ' 🔥' : ''}</span>
        ${isMvp ? '<span class="pick-info-mvp" style="background:#000;color:var(--gold);">MVP</span>' : ''}
      </div>`
    : `<div class="pick-score-box locked-score">
        <span class="pick-score-brand">Capping<span>Alpha</span> Score</span>
        <span class="score-locked-msg">${isViewer()
          ? `${LOCK_SVG} <a onclick="openSignup()" style="color:var(--gold);cursor:pointer;">Create a free account</a> to see picks`
          : `${LOCK_SVG} <a onclick="openCodeEntry()" style="color:var(--gold);cursor:pointer;">Upgrade</a> to unlock scores`}</span>
      </div>`;

  el.innerHTML = `
    ${scoreBoxHtml}
    <div class="pick-info-label">${slot?.label || slotKey}</div>
    ${linesHtml}`;
}

function renderGameData(data) {
  const el = document.getElementById('game-data-panel');
  if (!el) return;
  const { game, stats, weather } = data;
  const sport = (game.sport || '').toUpperCase();

  const sections = [];

  if (sport === 'ATP' || sport === 'WTA') {
    const tourName = stats?.tournament || null;
    const surface  = stats?.surface    || null;
    const rows = [];
    if (tourName) rows.push(`<div class="game-data-row" style="font-size:15px;font-weight:600;">${tourName}</div>`);
    if (surface)  rows.push(`<div class="game-data-row">Surface: ${surface}</div>`);
    if (rows.length) {
      sections.push(`<div>
        <div class="game-data-heading">Tournament</div>
        ${rows.join('')}
      </div>`);
    }
  }

  if (sport === 'MLB') {
    const away = stats?.pitchers?.find(p => p.homeAway === 'away') || stats?.pitchers?.[0];
    const home = stats?.pitchers?.find(p => p.homeAway === 'home') || stats?.pitchers?.[1];
    const pitcherCard = (p, side) => {
      if (!p) return `<div class="pitcher-card ${side}"><div class="pitcher-name" style="color:var(--muted);">TBD</div></div>`;
      return `<div class="pitcher-card ${side}">
        <div class="pitcher-name">${p.name || 'TBD'}</div>
        <div class="pitcher-stats">${p.record || '—'} · ERA ${p.era || '—'}</div>
        <div class="pitcher-team">${p.team || ''}</div>
      </div>`;
    };
    sections.push(`<div>
      <div class="game-data-heading">Probable Starters</div>
      <div class="pitcher-matchup">
        ${pitcherCard(away, 'away')}
        <div class="pitcher-vs">vs</div>
        ${pitcherCard(home, 'home')}
      </div>
    </div>`);
  }

  if (weather) {
    sections.push(`<div>
      <div class="game-data-heading">Weather</div>
      <div class="game-data-row" style="font-size:15px;margin-top:4px;">${weather.temp_f}°F</div>
      <div class="game-data-row">${weather.wind_mph} mph wind &nbsp;·&nbsp; ${weather.condition}</div>
    </div>`);
  }

  if (stats?.injuries?.length) {
    const rows = stats.injuries.slice(0, 8).map(inj =>
      `<div class="game-data-row">${inj.player} <span>${inj.team ? inj.team.split(' ').pop() : ''} · ${inj.status || ''}</span></div>`
    ).join('');
    sections.push(`<div>
      <div class="game-data-heading">Injuries</div>
      ${rows}
    </div>`);
  }

  let scoreStr = '';
  if (game.status === 'post') {
    scoreStr = `<div class="gd-score-line gd-final">
      <div class="gd-team-score">${game.away_team?.split(' ').pop() || '?'}<span>${game.away_score}</span></div>
      <div class="gd-sep">–</div>
      <div class="gd-team-score">${game.home_team?.split(' ').pop() || '?'}<span>${game.home_score}</span></div>
    </div>
    <div class="gd-badge" style="margin-top:6px;">Final</div>`;
  } else if (game.status === 'in') {
    const period = game.game_period ? `${game.game_period}${sport === 'MLB' ? ' Inn' : sport === 'NHL' ? ' Per' : ''}` : '';
    const clock  = game.game_clock ? ` · ${game.game_clock}` : '';
    scoreStr = `<div class="gd-score-line gd-live">
      <div class="gd-team-score">${game.away_team?.split(' ').pop() || '?'}<span>${game.away_score}</span></div>
      <div class="gd-sep">–</div>
      <div class="gd-team-score">${game.home_team?.split(' ').pop() || '?'}<span>${game.home_score}</span></div>
    </div>
    <div class="gd-badge gd-badge-live" style="margin-top:6px;">LIVE${period ? ' · ' + period : ''}${clock}</div>`;
  } else {
    scoreStr = `<div class="game-data-row" style="font-size:15px;font-weight:600;">${gameTime(game.start_time || '')}</div>
    <div class="game-data-row" style="margin-top:4px;">${game.away_team?.split(' ').pop() || '?'} @ ${game.home_team?.split(' ').pop() || '?'}</div>`;
  }
  sections.unshift(`<div>
    <div class="game-data-heading">Score &amp; Outcome</div>
    ${scoreStr}
  </div>`);

  el.innerHTML = `<div class="game-data-full-header"><span class="game-data-full-title">Game Details</span></div>`
    + `<div class="game-data-full-grid">${sections.join('')}</div>`;
}

function renderSentiment(data, slotKey, gameStatus, pickBySlot) {
  const el = document.getElementById('sentiment-panel');
  if (!el) return;
  const { game, votes, userVote } = data;

  let aKey, bKey, aLabel, bLabel, aColor, bColor;
  if (slotKey === 'over' || slotKey === 'under') {
    aKey = 'over';  aLabel = 'Over';  aColor = '#16a34a';
    bKey = 'under'; bLabel = 'Under'; bColor = '#dc2626';
  } else {
    const homeColors = TEAM_COLORS[game.home_team] || ['#3b82f6','#6366f1'];
    const awayColors = TEAM_COLORS[game.away_team] || ['#8b5cf6','#a78bfa'];
    aKey = 'home_ml';  aLabel = game.home_team?.split(' ').pop() || 'Home';  aColor = homeColors[0];
    bKey = 'away_ml';  bLabel = game.away_team?.split(' ').pop() || 'Away';  bColor = awayColors[0];
    if (slotKey === 'home_spread' || slotKey === 'away_spread') {
      aKey = 'home_spread'; bKey = 'away_spread';
    }
  }

  const aVotes = votes[aKey] || 0;
  const bVotes = votes[bKey] || 0;
  const total  = aVotes + bVotes;
  const aPct   = total > 0 ? Math.round((aVotes / total) * 100) : 50;
  const bPct   = total > 0 ? 100 - aPct : 50;

  const locked = gameStatus === 'in' || gameStatus === 'post';

  let voteSection = '';
  if (locked) {
    voteSection = `<div class="vote-closed">Voting closed — game started</div>`;
  } else if (!state.currentUser) {
    voteSection = `<div style="font-size:12px;color:var(--muted);margin-top:8px;"><a onclick="openLogin()" style="color:var(--accent);cursor:pointer;">Log in</a> or <a onclick="openSignup()" style="color:var(--accent);cursor:pointer;">sign up free</a> to vote</div>`;
  } else {
    const aVoted = userVote && userVote[aKey];
    const bVoted = userVote && userVote[bKey];
    voteSection = `
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="vote-btn${aVoted ? ' voted' : ''}" onclick="voteOnSlot('${game.espn_game_id}','${aKey}')">
          ${aVoted ? '✓ ' : ''}${aLabel}
        </button>
        <button class="vote-btn${bVoted ? ' voted' : ''}" onclick="voteOnSlot('${game.espn_game_id}','${bKey}')">
          ${bVoted ? '✓ ' : ''}${bLabel}
        </button>
      </div>`;
  }

  el.innerHTML = `
    <div class="sentiment-heading">Community Sentiment</div>
    <div class="sentiment-gauge-wrap">
      <div class="sentiment-gauge-teams">
        <span style="font-weight:600;">${aLabel}</span>
        <span style="font-weight:600;">${bLabel}</span>
      </div>
      <div class="sentiment-gauge">
        <div class="sentiment-gauge-a" style="width:${aPct}%;background:${aColor};"></div>
        <div class="sentiment-gauge-b" style="flex:1;background:${bColor};"></div>
      </div>
      <div class="sentiment-gauge-pcts">
        <span style="color:${aColor};">${aPct}%</span>
        <span>${total} vote${total !== 1 ? 's' : ''}</span>
        <span style="color:${bColor};">${bPct}%</span>
      </div>
    </div>
    ${voteSection}`;
}

export async function voteOnSlot(espn_game_id, slot) {
  try {
    const res = await fetch(`/api/game/${espn_game_id}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot }),
    });
    if (res.status === 401) { window.openLogin(); return; }
    if (res.status === 409) { alert('Voting is now closed — game has started.'); return; }

    const data = await res.json();
    if (!_modalData) return;
    _modalData.votes    = data.votes;
    _modalData.userVote = data.userVote;

    const pickBySlot = buildPickBySlot(_modalData.picks);
    const SLOTS      = buildSlots(_modalData.game);

    const activeChip = document.querySelector('.ticker-chip.active');
    const currentSlot = activeChip
      ? (() => {
          const m = (activeChip.getAttribute('onclick') || '').match(/'([^']+)'/);
          return m ? m[1] : slot;
        })()
      : slot;

    renderPickInfo(_modalData, currentSlot, pickBySlot, SLOTS);
    renderSentiment(_modalData, currentSlot, _modalData.game.status, pickBySlot);
  } catch (err) {
    console.error('[vote] error:', err);
  }
}

// ── Golf tournament modal ─────────────────────────────────────────────────────
async function openGolfModal(tournamentId) {
  const modal   = document.getElementById('game-modal');
  const content = document.getElementById('game-modal-content');
  modal.classList.remove('hidden');
  content.innerHTML = `<div style="padding:48px;text-align:center;color:var(--muted);">Loading tournament...</div>`;

  try {
    const data = await fetch(`/api/golf/${tournamentId}`).then(r => r.json());
    const { tournament, picks } = data;
    const lb = (() => { try { return JSON.parse(tournament.leaderboard_json || '[]'); } catch (_) { return []; } })();

    const statusBadge = tournament.status === 'in'
      ? `<span style="color:#4ade80;font-size:12px;font-weight:700;">● Round ${tournament.current_round} Live</span>`
      : tournament.status === 'post'
        ? `<span style="color:var(--muted);font-size:12px;">Final</span>`
        : `<span style="color:var(--muted);font-size:12px;">Upcoming</span>`;

    const leaderboardHtml = lb.length ? `
      <div class="table-scroll" style="margin-bottom:16px;">
        <table>
          <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Thru</th></tr></thead>
          <tbody>
            ${lb.slice(0, 50).map(p => `
              <tr>
                <td style="font-weight:700;color:var(--muted);font-size:12px;">${p.position}</td>
                <td>${p.player?.fullName || '—'}</td>
                <td style="font-weight:700;color:${String(p.score).startsWith('-') ? '#4ade80' : '#f87171'};">${p.score}</td>
                <td style="color:var(--muted);font-size:12px;">${p.thru || '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : `<p style="color:var(--muted);padding:16px 0;">Leaderboard updates when tournament is live.</p>`;

    const pickTypeLabel = t => {
      if (t === 'h2h')   return 'H2H';
      if (t === 'top5')  return 'Top 5';
      if (t === 'top10') return 'Top 10';
      return t ? t.toUpperCase() : '—';
    };

    const picksHtml = picks.length ? `
      <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:16px 0 8px;">Capper Picks</h3>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Rank</th><th>Player</th><th>Pick</th><th>Capper</th><th class="score-col">Score</th></tr></thead>
          <tbody>
            ${picks.map((p, i) => `
              <tr>
                <td class="rank">${i + 1}</td>
                <td><strong>${p.player_name}</strong>${p.vs_player ? `<br><span style="font-size:11px;color:var(--muted);">vs ${p.vs_player}</span>` : ''}</td>
                <td class="pick-cell" style="${p.result === 'win' ? 'color:#4ade80' : p.result === 'loss' ? 'color:#f87171' : ''}">${pickTypeLabel(p.pick_type)}</td>
                <td style="color:var(--muted);font-size:12px;">${p.capper_name || '—'}</td>
                <td class="score-col">${p.score ?? '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '';

    const venue = [tournament.course, tournament.city, tournament.state].filter(Boolean).join(' · ');

    content.innerHTML = `
      <div class="modal-header" style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;">
        <div style="flex:1;">
          <div style="font-size:18px;font-weight:700;">${tournament.name}</div>
          ${venue ? `<div style="font-size:13px;color:var(--muted);margin-top:2px;">${venue}</div>` : ''}
          <div style="margin-top:6px;">${statusBadge}</div>
        </div>
        <span class="sport-badge">Golf</span>
      </div>
      <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px;">Leaderboard</h3>
      ${leaderboardHtml}
      ${picksHtml}
    `;
  } catch (err) {
    content.innerHTML = `<div style="padding:32px;color:var(--muted);text-align:center;">Failed to load tournament data.</div>`;
  }
}

Object.assign(window, { openGameModal, openGolfModal, closeGameModal, selectTickerSlot, voteOnSlot });
