// modules/modal.js — Game detail modal

import { state } from './state.js';
import { isPaying, isAccount, isViewer } from './auth.js';
import { LOCK_SVG, PICK_HEAT_COLOR, fmtOdds, fmtSpread, gameTime } from './utils.js?v=3';
import { cappingGauge } from './gauge.js';

// Sport → unit suffix for the over/under total line value.
// Same map used in public/game-detail.js _buildBetTypes().
const TOTAL_UNIT = {
  MLB: 'runs', NHL: 'goals',
  NBA: 'pts',  WNBA: 'pts', NFL: 'pts', NCAAF: 'pts', CBB: 'pts', WCBB: 'pts',
  ATP: 'games', WTA: 'games',
};
// Tennis spread lines from Bovada are a games handicap — label the unit.
const SPREAD_UNIT = { ATP: 'games', WTA: 'games' };
import { drawPickTimeline, destroyPickTimeline } from './score_timeline.js';

function formatActualStart(actualIso, scheduledIso) {
  if (!actualIso) return '';
  // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' UTC with no offset
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
  // WNBA
  'Atlanta Dream':           ['#E31837','#000000'],
  'Chicago Sky':             ['#418FDE','#FFCD00'],
  'Connecticut Sun':         ['#F05023','#0A2240'],
  'Dallas Wings':            ['#0C2340','#C4D600'],
  'Golden State Valkyries':  ['#4B2E83','#000000'],
  'Indiana Fever':           ['#E03A3E','#002D62'],
  'Las Vegas Aces':          ['#000000','#C8102E'],
  'Los Angeles Sparks':      ['#552583','#FDB927'],
  'Minnesota Lynx':          ['#236192','#0C2340'],
  'New York Liberty':        ['#6ECEB2','#000000'],
  'Phoenix Mercury':         ['#201747','#E56020'],
  'Seattle Storm':           ['#2C5234','#FEE11A'],
  'Washington Mystics':      ['#0C2340','#E03A3E'],
};

let _modalData = null;

function buildSlots(game) {
  return [
    { key: 'home_ml',     label: `${game.home_team?.split(' ').pop() || 'Home'} Win`,     type: 'ml',     team: game.home_team },
    { key: 'away_ml',     label: `${game.away_team?.split(' ').pop() || 'Away'} Win`,     type: 'ml',     team: game.away_team },
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
  if (window.posthog) {
    try { posthog.capture('game_opened', { espn_game_id, slot: clickedType || null }); } catch (e) {}
  }
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
  destroyPickTimeline();
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
    const _maxRank     = state.CONFIG?.paid_rank_max || 50;
    const betTypeTop30 = (slotRank > 0 && slotRank <= _maxRank) || (pairedRank > 0 && pairedRank <= _maxRank);
    // The overall #1 pick's score is always visible (free users included).
    const scoreHidden  = !isPaying() && betTypeTop30 && p?.globalRank !== 1;

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
          ${(game.status === 'in' || game.status === 'post') && (game.sport || '').toUpperCase() !== 'GOLF'
            ? `<a class="modal-live-link" href="/game/${encodeURIComponent(game.espn_game_id)}">${game.status === 'in' ? 'Live tracker' : 'Game tracker'} <i class="fa-solid fa-arrow-up-right-from-square"></i></a>`
            : ''}
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

function buildTimelineSection(p, pickRank, hasPick) {
  // Visibility mirrors score paywall: free users see the overall #1 pick only; paid see all.
  const canSeeTimeline = isPaying() || p?.globalRank === 1;
  if (!canSeeTimeline) {
    return `<div class="pick-timeline-section locked">
      <div class="pick-timeline-heading">Conviction curve</div>
      <div class="pick-timeline-locked">${LOCK_SVG} ${isViewer()
        ? `<a onclick="openSignup()" style="color:var(--gold);cursor:pointer;">Create a free account</a> to view`
        : `<a onclick="openCodeEntry()" style="color:var(--gold);cursor:pointer;">Upgrade</a> to view`}</div>
    </div>`;
  }
  const hasTimeline = !!(hasPick && p?.timeline && p.timeline.length > 0);
  if (!hasTimeline) {
    return `<div class="pick-timeline-section">
      <div class="pick-timeline-heading">Conviction curve</div>
      <div class="pick-timeline-canvas-wrap is-empty">
        <canvas id="pick-timeline-chart"></canvas>
        <div class="pick-timeline-empty-overlay">Not enough picks yet.</div>
      </div>
    </div>`;
  }
  return `<div class="pick-timeline-section">
    <div class="pick-timeline-heading">Conviction curve</div>
    <div class="pick-timeline-canvas-wrap"><canvas id="pick-timeline-chart"></canvas></div>
    <div class="pick-timeline-teaser">Picks evolve throughout the day. <a onclick="switchTab('about')" style="color:var(--accent);cursor:pointer;">Learn how</a></div>
  </div>`;
}

function renderPickInfo(data, slotKey, pickBySlot, SLOTS) {
  const el = document.getElementById('pick-info-panel');
  if (!el) return;
  destroyPickTimeline();
  const { game, lines } = data;
  const p    = pickBySlot[slotKey];
  const slot = SLOTS.find(s => s.key === slotKey);
  const startedNote = formatActualStart(game?.actual_start_at, game?.start_time);
  const startedHtml = startedNote
    ? `<div class="pick-started-note">${startedNote}</div>`
    : '';

  // Lines computed up front — shown regardless of whether a pick exists
  let currentLine = '—';
  if (slotKey === 'home_ml')     currentLine = game.ml_home     != null ? fmtOdds(game.ml_home)       : '—';
  if (slotKey === 'away_ml')     currentLine = game.ml_away     != null ? fmtOdds(game.ml_away)       : '—';
  if (slotKey === 'home_spread') currentLine = game.spread_home != null ? fmtSpread(game.spread_home) : '—';
  if (slotKey === 'away_spread') currentLine = game.spread_away != null ? fmtSpread(game.spread_away) : '—';
  if (slotKey === 'over')        currentLine = game.over_under  != null ? `o${game.over_under}`       : '—';
  if (slotKey === 'under')       currentLine = game.over_under  != null ? `u${game.over_under}`       : '—';

  // One extractor for every book: value for this slot + movement badge where
  // prev_* columns exist. The odds engine feeds a dozen books beyond DK/FD;
  // all of them render here now.
  const mvDelta = (cur, prev) => {
    if (prev == null || cur == null || cur === prev) return '';
    const d = cur - prev;
    return ` <span style="color:#94a3b8;font-size:10px;font-weight:500;">${d > 0 ? '+' : ''}${d}</span>`;
  };
  const slotLineFor = (src) => {
    if (!src) return null;
    if (slotKey === 'home_ml')     return src.ml_home     != null ? fmtOdds(src.ml_home)       + mvDelta(src.ml_home,     src.prev_ml_home)     : null;
    if (slotKey === 'away_ml')     return src.ml_away     != null ? fmtOdds(src.ml_away)       + mvDelta(src.ml_away,     src.prev_ml_away)     : null;
    if (slotKey === 'home_spread') return src.spread_home != null ? fmtSpread(src.spread_home) + mvDelta(src.spread_home, src.prev_spread_home) : null;
    if (slotKey === 'away_spread') return src.spread_away != null ? fmtSpread(src.spread_away) + mvDelta(src.spread_away, src.prev_spread_away) : null;
    if (slotKey === 'over')        return src.over_under  != null ? `o${src.over_under} (${fmtOdds(src.ou_over_odds  || -110)})` + mvDelta(src.over_under, src.prev_over_under) : null;
    if (slotKey === 'under')       return src.over_under  != null ? `u${src.over_under} (${fmtOdds(src.ou_under_odds || -110)})` + mvDelta(src.over_under, src.prev_over_under) : null;
    return null;
  };
  const dkLine = slotLineFor(lines?.draftkings) || '—';
  const fdLine = slotLineFor(lines?.fanduel)    || '—';

  // Every other stored book, regulated first then offshore (tagged). Books
  // with no number for this slot are skipped rather than shown as dashes.
  const EXTRA_BOOK_LABELS = {
    betmgm: 'BetMGM', caesars: 'Caesars', betrivers: 'BetRivers', hardrock: 'Hard Rock',
    bet365: 'bet365', espnbet: 'ESPN BET', fanatics: 'Fanatics', circa: 'Circa',
    bovada: 'Bovada', pinnacle: 'Pinnacle', betonline: 'BetOnline', mybookie: 'MyBookie', betus: 'BetUS',
  };
  const OFFSHORE_TAG_BOOKS = new Set(['bovada', 'pinnacle', 'betonline', 'mybookie', 'betus', 'thunderpick']);
  const offshoreTag = ' <span style="font-size:9px;color:#8892a4;border:1px solid #3b4560;border-radius:3px;padding:0 3px;vertical-align:1px;">offshore</span>';
  const extraBookRows = Object.keys(lines || {})
    .filter(k => k !== 'draftkings' && k !== 'fanduel' && lines[k])
    .map(k => ({ k, val: slotLineFor(lines[k]) }))
    .filter(r => r.val)
    .sort((x, y) => ((OFFSHORE_TAG_BOOKS.has(x.k) ? 1 : 0) - (OFFSHORE_TAG_BOOKS.has(y.k) ? 1 : 0)) || x.k.localeCompare(y.k))
    .map(({ k, val }) =>
      `<div class="line-row"><span class="line-book">${EXTRA_BOOK_LABELS[k] || k}${OFFSHORE_TAG_BOOKS.has(k) ? offshoreTag : ''}</span> <span class="line-val">${val}</span></div>`)
    .join('');

  // ── Polymarket row ──────────────────────────────────────────────────────────
  const pmTypeMap = {
    home_ml:'moneyline', away_ml:'moneyline',
    home_spread:'spread', away_spread:'spread',
    over:'total', under:'total',
  };
  let pmLine = '';
  try {
    const pmData = data.polymarket;
    if (pmData?.markets_json) {
      const markets  = JSON.parse(pmData.markets_json || '{}');
      const morning  = pmData.morning_markets_json ? JSON.parse(pmData.morning_markets_json) : null;
      const pmType   = pmTypeMap[slotKey];
      const market   = markets[pmType];
      if (market) {
        const homeNick = game.home_team?.split(' ').pop() || 'Home';
        const awayNick = game.away_team?.split(' ').pop() || 'Away';
        const fmtPct = p => p != null ? Math.round(p * 100) + '%' : '—';
        const deltaBadge = (cur, morn) => {
          if (cur == null || morn == null) return '';
          const d = Math.round((cur - morn) * 100);
          if (d === 0) return '';
          const color = d > 0 ? '#4ade80' : '#f87171';
          return ` <span style="font-size:10px;color:${color};">${d > 0 ? '▲' : '▼'}${Math.abs(d)}%</span>`;
        };

        if (pmType === 'total') {
          const isOver = slotKey === 'over';
          const cur   = isOver ? market.over_prob  : market.under_prob;
          const morn  = morning?.total ? (isOver ? morning.total.over_prob : morning.total.under_prob) : null;
          pmLine = fmtPct(cur) + deltaBadge(cur, morn);
        } else if (pmType === 'spread') {
          const isHome = slotKey === 'home_spread';
          const cur  = isHome ? market.home_prob : market.away_prob;
          const morn = morning?.spread ? (isHome ? morning.spread.home_prob : morning.spread.away_prob) : null;
          pmLine = fmtPct(cur) + ' cover' + deltaBadge(cur, morn);
        } else {
          // moneyline
          const isHome = slotKey === 'home_ml';
          const cur  = isHome ? market.home_prob : market.away_prob;
          const morn = morning?.moneyline ? (isHome ? morning.moneyline.home_prob : morning.moneyline.away_prob) : null;
          pmLine = fmtPct(cur) + ' to win' + deltaBadge(cur, morn);
        }
      }
    }
  } catch (_) {}

  // ── Insight chip ────────────────────────────────────────────────────────────
  const insightSlotMap = {
    home_ml:'ml', away_ml:'ml',
    home_spread:'spread', away_spread:'spread',
    over:'ou', under:'ou',
  };
  const insightType = insightSlotMap[slotKey];
  const matchedInsight = (data.insights || []).find(i => i.type === insightType);
  const insightChip = matchedInsight
    ? `<div style="margin-top:8px;padding:7px 10px;background:#0f2318;border:1px solid #1a4a2e;border-radius:6px;font-size:12px;color:#4ade80;line-height:1.4;">${matchedInsight.text}</div>`
    : '';

  const pmRow = pmLine
    ? `<div class="line-row"><span class="line-book"><img src="https://polymarket.com/favicon.ico" width="13" height="13" style="vertical-align:middle;border-radius:2px;margin-right:5px;" onerror="this.style.display='none'">Polymarket</span> <span class="line-val">${pmLine}</span></div>`
    : '';

  // These odds come from today_games, which is locked at the pregame close (5am/4pm) and
  // never moves once a game starts — we have no live in-game line. So label it "Pregame"
  // (not "Current") for live/finished games rather than implying it's the number right now.
  const started = game.status === 'in' || game.status === 'post';
  const currentLabel = started ? 'Pregame' : 'Current';
  const currentTitle = started ? 'Pregame closing line (no live in-game line available)' : "CappingAlpha's current line";
  const linesHtml = `
    <div class="pick-info-lines">
      <div class="line-row"><span class="line-book" title="${currentTitle}">${currentLabel}</span> <span class="line-val">${currentLine}</span></div>
      <div class="line-row"><span class="line-book"><img src="https://www.draftkings.com/favicon.ico" width="13" height="13" style="vertical-align:middle;border-radius:2px;margin-right:5px;" onerror="this.style.display='none'">DraftKings</span> <span class="line-val">${dkLine}</span></div>
      <div class="line-row"><span class="line-book"><img src="https://www.fanduel.com/favicon.ico" width="13" height="13" style="vertical-align:middle;border-radius:2px;margin-right:5px;" onerror="this.style.display='none'">FanDuel</span> <span class="line-val">${fdLine}</span></div>
      ${extraBookRows}
      ${pmRow}
    </div>${insightChip}`;

  if (!p) {
    // Check if the paired slot (other ML, spread side, or O/U partner) is in the
    // paid range (rank <= paid_rank_max) —
    // if so, this slot should appear locked rather than greyed/empty.
    const SLOT_PAIRS    = { home_ml:'away_ml', away_ml:'home_ml', home_spread:'away_spread', away_spread:'home_spread', over:'under', under:'over' };
    const pairedSlotKey = SLOT_PAIRS[slotKey];
    const pairedPick    = pairedSlotKey ? pickBySlot[pairedSlotKey] : null;
    const pairedRank    = (data.pickRanks && pairedPick?.id) ? (data.pickRanks[pairedPick.id] || 0) : 0;
    const pairIsTop30   = pairedRank > 0 && pairedRank <= (state.CONFIG?.paid_rank_max || 50);

    if (!isPaying() && pairIsTop30) {
      // The adjacent bet type has a top-30 pick — show as locked, not empty
      const lockedBox = `<div class="pick-score-box locked-score">
        <span class="pick-score-brand">Capping<span>Alpha</span> Score</span>
        <span class="score-locked-msg">${isViewer()
          ? `${LOCK_SVG} <a onclick="openSignup()" style="color:var(--gold);cursor:pointer;">Create a free account</a> to see picks`
          : `${LOCK_SVG} <a onclick="openCodeEntry()" style="color:var(--gold);cursor:pointer;">Upgrade</a> to unlock scores`}</span>
      </div>`;
      el.innerHTML = lockedBox + `<div class="pick-info-label">${slot?.label || slotKey}</div>` + startedHtml + linesHtml;
    } else {
      // No pick and no locked pair — show greyed "no value" box with score 0 + lines
      const noValueBox = `<div class="pick-score-box" style="opacity:0.55;">
        <span class="pick-score-brand">Capping<span>Alpha</span> Score</span>
        <span class="pick-info-score" style="color:var(--muted);">0</span>
        <span style="font-size:11px;color:var(--muted);margin-top:4px;display:block;">CappingAlpha doesn't see value in this line right now</span>
      </div>`;
      el.innerHTML = noValueBox + `<div class="pick-info-label">${slot?.label || slotKey}</div>` + startedHtml + linesHtml;
    }
    return;
  }

  const heat  = PICK_HEAT_COLOR(p.score || 0);
  const isMvp = (p.score || 0) >= (state.CONFIG?.mvp_threshold || 75);

  const SLOT_PAIRS     = { home_ml:'away_ml', away_ml:'home_ml', home_spread:'away_spread', away_spread:'home_spread', over:'under', under:'over' };
  const pickRank       = (data.pickRanks && p.id) ? (data.pickRanks[p.id] || 0) : 0;
  const pairedSlotKey  = SLOT_PAIRS[slotKey];
  const pairedPick     = pairedSlotKey ? pickBySlot[pairedSlotKey] : null;
  const pairedRank     = (data.pickRanks && pairedPick?.id) ? (data.pickRanks[pairedPick.id] || 0) : 0;
  const _maxRank2      = state.CONFIG?.paid_rank_max || 50;
  const betTypeIsTop30 = (pickRank > 0 && pickRank <= _maxRank2) || (pairedRank > 0 && pairedRank <= _maxRank2);
  // Free users see the CappingAlpha score for the overall #1 pick only.
  const isOverallTop1  = p.globalRank === 1;
  const showScore      = isPaying() || isOverallTop1 || (isAccount() && !betTypeIsTop30);

  const scoreBoxHtml = showScore
    ? `<div class="pick-score-box${isMvp ? ' mvp' : ''}">
        <span class="pick-score-brand">Capping<span>Alpha</span> Score</span>
        <span class="pick-info-score" style="color:${isMvp ? '#000' : heat.color};">${p.score || 0}${heat.fire ? ' 🔥' : ''}</span>
        ${isMvp ? '<span class="pick-info-mvp" style="background:#000;color:var(--gold);">CA</span>' : ''}
      </div>`
    : `<div class="pick-score-box locked-score">
        <span class="pick-score-brand">Capping<span>Alpha</span> Score</span>
        <span class="score-locked-msg">${isViewer()
          ? `${LOCK_SVG} <a onclick="openSignup()" style="color:var(--gold);cursor:pointer;">Create a free account</a> to see picks`
          : `${LOCK_SVG} <a onclick="openCodeEntry()" style="color:var(--gold);cursor:pointer;">Upgrade</a> to unlock scores`}</span>
      </div>`;

  const timelineSection = buildTimelineSection(p, pickRank, true);

  el.innerHTML = `
    ${scoreBoxHtml}
    <div class="pick-info-label">${slot?.label || slotKey}</div>
    ${startedHtml}
    ${linesHtml}
    ${timelineSection}`;

  if (typeof Chart !== 'undefined' && (isPaying() || p.globalRank === 1)) {
    const mvp = state.CONFIG?.mvp_threshold || 75;
    requestAnimationFrame(() => drawPickTimeline(p?.timeline || [], mvp));
  }
}

function renderGameData(data) {
  const el = document.getElementById('game-data-panel');
  if (!el) return;
  const { game, stats, weather } = data;
  const sport = (game.sport || '').toUpperCase();

  const sections = [];

  const watchSection = buildWatchSection(stats?.broadcasts);

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

  // NHL starting goalies — parallel to MLB pitcher matchup
  if (sport === 'NHL' && stats?.goalies?.length) {
    const away = stats.goalies.find(g => g.homeAway === 'away');
    const home = stats.goalies.find(g => g.homeAway === 'home');
    const card = (g, side) => {
      if (!g) return `<div class="pitcher-card ${side}"><div class="pitcher-name" style="color:var(--muted);">TBD</div></div>`;
      const sub = [g.record, g.savePct ? `SV% ${g.savePct}` : null].filter(Boolean).join(' · ');
      return `<div class="pitcher-card ${side}">
        <div class="pitcher-name">${g.name}</div>
        <div class="pitcher-stats">${sub || '—'}</div>
        <div class="pitcher-team">${g.team || ''}</div>
      </div>`;
    };
    sections.push(`<div>
      <div class="game-data-heading">Starting Goalies</div>
      <div class="pitcher-matchup">
        ${card(away, 'away')}
        <div class="pitcher-vs">vs</div>
        ${card(home, 'home')}
      </div>
    </div>`);
  }

  // ESPN matchup predictor — win probability per side
  if (stats?.predictor && (stats.predictor.homePct != null || stats.predictor.awayPct != null)) {
    const awayShort = game.away_team?.split(' ').pop() || 'Away';
    const homeShort = game.home_team?.split(' ').pop() || 'Home';
    sections.push(`<div>
      <div class="game-data-heading">ESPN Win Probability</div>
      <div class="game-data-row">${awayShort} <span>${stats.predictor.awayPct != null ? stats.predictor.awayPct + '%' : '—'}</span></div>
      <div class="game-data-row">${homeShort} <span>${stats.predictor.homePct != null ? stats.predictor.homePct + '%' : '—'}</span></div>
    </div>`);
  }

  // Head-to-head season series
  if (stats?.seasonSeries?.summary) {
    sections.push(`<div>
      <div class="game-data-heading">Season Series</div>
      <div class="game-data-row" style="font-size:15px;">${stats.seasonSeries.summary}</div>
    </div>`);
  }

  // Statistical leaders (home + away top performers)
  if (stats?.leaders && (stats.leaders.home?.length || stats.leaders.away?.length)) {
    const leaderRows = (list, label) => {
      if (!list || !list.length) return '';
      const rows = list.slice(0, 3).map(l =>
        `<div class="game-data-row">${l.cat} <span>${l.name}${l.pos ? ` (${l.pos})` : ''} · ${l.value}</span></div>`
      ).join('');
      return `<div class="game-data-row" style="font-weight:600;margin-top:4px;">${label}</div>${rows}`;
    };
    const awayShort = game.away_team?.split(' ').pop() || 'Away';
    const homeShort = game.home_team?.split(' ').pop() || 'Home';
    sections.push(`<div>
      <div class="game-data-heading">Team Leaders</div>
      ${leaderRows(stats.leaders.away, awayShort)}
      ${leaderRows(stats.leaders.home, homeShort)}
    </div>`);
  }

  if (weather) {
    sections.push(`<div>
      <div class="game-data-heading">Weather</div>
      <div class="game-data-row" style="font-size:15px;margin-top:4px;">${weather.temp_f}°F</div>
      <div class="game-data-row">${weather.wind_mph} mph wind &nbsp;·&nbsp; ${weather.condition}</div>
    </div>`);
  }

  // Injuries — stats.injuries is { home, away }, each with a players[] list
  const injHome = stats?.injuries?.home?.players || [];
  const injAway = stats?.injuries?.away?.players || [];
  if (injHome.length || injAway.length) {
    const injRows = (list, label) => {
      if (!list || !list.length) return '';
      const rows = list.slice(0, 6).map(p =>
        `<div class="game-data-row">${p.player} <span>${[p.status, p.detail].filter(Boolean).join(' · ')}</span></div>`
      ).join('');
      return `<div class="game-data-row" style="font-weight:600;margin-top:4px;">${label}</div>${rows}`;
    };
    const awayLbl = stats?.injuries?.away?.shortName || game.away_team?.split(' ').pop() || 'Away';
    const homeLbl = stats?.injuries?.home?.shortName || game.home_team?.split(' ').pop() || 'Home';
    sections.push(`<div>
      <div class="game-data-heading">Injuries</div>
      ${injRows(injAway, awayLbl)}
      ${injRows(injHome, homeLbl)}
    </div>`);
  }

  // Officials + attendance
  const metaRows = [];
  if (stats?.officials?.length) {
    metaRows.push(`<div class="game-data-row" style="font-weight:600;margin-top:4px;">Officials</div>`);
    stats.officials.slice(0, 5).forEach(o =>
      metaRows.push(`<div class="game-data-row">${o.name} <span>${o.role || ''}</span></div>`));
  }
  if (stats?.attendance) {
    metaRows.push(`<div class="game-data-row">Attendance <span>${Number(stats.attendance).toLocaleString()}</span></div>`);
  }
  if (metaRows.length) {
    sections.push(`<div>
      <div class="game-data-heading">Game Info</div>
      ${metaRows.join('')}
    </div>`);
  }

  // ESPN recap / preview headline
  if (stats?.recap?.headline) {
    sections.push(`<div>
      <div class="game-data-heading">${stats.recap.type === 'Recap' ? 'Recap' : 'Preview'}</div>
      <div class="game-data-row" style="line-height:1.4;">${stats.recap.headline}</div>
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
    const isTennis = sport === 'ATP' || sport === 'WTA';
    const period = game.game_period
      ? (isTennis ? `Set ${game.game_period}` : `${game.game_period}${sport === 'MLB' ? ' Inn' : sport === 'NHL' ? ' Per' : ''}`)
      : '';
    const clock  = (game.game_clock && !isTennis) ? ` · ${game.game_clock}` : '';
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

  if (watchSection) sections.splice(1, 0, watchSection);

  el.innerHTML = `<div class="game-data-full-header"><span class="game-data-full-title">Game Details</span></div>`
    + `<div class="game-data-full-grid">${sections.join('')}</div>`;
}

// ── Where to Watch — logo + name chips from stats.broadcasts ─────────────────
function broadcastChip(entry) {
  const name = entry?.name || '';
  if (!name) return '';
  const d = entry.domain;
  const img = d
    ? `<img src="https://logo.clearbit.com/${d}" alt="" style="height:18px;width:18px;border-radius:4px;object-fit:contain;flex:none;" onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src='https://www.google.com/s2/favicons?domain=${d}&amp;sz=64';}else{this.style.display='none';}">`
    : '';
  return `<span style="display:inline-flex;align-items:center;gap:6px;margin:0 10px 6px 0;">${img}<span>${name}</span></span>`;
}

function buildWatchSection(b) {
  if (!b) return '';
  const rows = [];
  const addRow = (label, list) => {
    if (!list || !list.length) return;
    rows.push(`<div class="game-data-row" style="display:flex;flex-wrap:wrap;align-items:center;gap:2px;">
      <span style="color:var(--muted);min-width:54px;">${label}</span>${list.map(broadcastChip).join('')}</div>`);
  };
  addRow('TV', b.tv);
  addRow('Stream', b.streaming);
  addRow('Live TV', b.bundles);
  if (!rows.length) return '';
  return `<div>
    <div class="game-data-heading">Where to Watch</div>
    ${rows.join('')}
  </div>`;
}

// Golf modal variant — parses broadcasts_json and uses the golf modal's h3 styling.
function buildGolfWatchHtml(broadcastsJson) {
  let b = null;
  try { b = broadcastsJson ? JSON.parse(broadcastsJson) : null; } catch (_) { return ''; }
  if (!b) return '';
  const rows = [];
  const addRow = (label, list) => {
    if (!list || !list.length) return;
    rows.push(`<div style="display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin-bottom:6px;">
      <span style="color:var(--muted);min-width:54px;font-size:13px;">${label}</span>${list.map(broadcastChip).join('')}</div>`);
  };
  addRow('TV', b.tv);
  addRow('Stream', b.streaming);
  addRow('Live TV', b.bundles);
  if (!rows.length) return '';
  return `<h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px;">Where to Watch</h3>
    <div style="margin-bottom:16px;">${rows.join('')}</div>`;
}

function renderSentiment(data, slotKey, gameStatus, pickBySlot) {
  const el = document.getElementById('sentiment-panel');
  if (!el) return;
  const { game, votes, userVote } = data;

  // Layout: gauge shows LEFT-vs-RIGHT — for ML/spread we put AWAY on the left
  // and HOME on the right (mirrors the standalone page convention), regardless
  // of which slot is active. Active slot determines which key pair drives the %.
  let leftKey, rightKey, leftLabel, rightLabel, leftColor, rightColor,
      leftColorSecondary = '', rightColorSecondary = '',
      centerLine = null, betLabel, betLabelColor;

  if (slotKey === 'over' || slotKey === 'under') {
    leftKey   = 'under';        rightKey   = 'over';
    leftLabel = 'Under';        rightLabel = 'Over';
    // Steel blue + amber — same non-betting-cliché pair as the standalone page.
    leftColor = '#4682B4';      rightColor = '#F59E0B';
    const ouUnit = TOTAL_UNIT[(game.sport || '').toUpperCase()];
    centerLine = game.over_under != null
      ? (ouUnit ? `${game.over_under} ${ouUnit}` : String(game.over_under))
      : null;
    betLabel       = 'TOTAL';
    betLabelColor  = '#fbbf24';
    // No team secondaries on totals — keep labels clean.
  } else {
    const homeColors = TEAM_COLORS[game.home_team] || ['#3b82f6','#6366f1'];
    const awayColors = TEAM_COLORS[game.away_team] || ['#8b5cf6','#a78bfa'];
    leftLabel  = game.away_team?.split(' ').pop() || 'Away';
    rightLabel = game.home_team?.split(' ').pop() || 'Home';
    leftColor           = awayColors[0];
    rightColor          = homeColors[0];
    leftColorSecondary  = awayColors[1] || '';
    rightColorSecondary = homeColors[1] || '';
    if (slotKey === 'home_spread' || slotKey === 'away_spread') {
      leftKey  = 'away_spread';  rightKey = 'home_spread';
      const spUnit = SPREAD_UNIT[(game.sport || '').toUpperCase()];
      centerLine = game.spread_home != null
        ? (spUnit ? `${fmtSpread(game.spread_home)} ${spUnit}` : fmtSpread(game.spread_home))
        : null;
      betLabel       = 'SPREAD';
      betLabelColor  = '#a78bfa';
    } else {
      leftKey  = 'away_ml';      rightKey = 'home_ml';
      betLabel       = 'WIN';
      betLabelColor  = '#22d3ee';
    }
  }

  const leftVotes  = votes[leftKey]  || 0;
  const rightVotes = votes[rightKey] || 0;
  const total = leftVotes + rightVotes;
  const leftPct  = total > 0 ? Math.round((leftVotes / total) * 100) : null;
  const rightPct = leftPct  != null ? 100 - leftPct : null;

  const gaugeHtml = cappingGauge({
    betLabel, betLabelColor,
    leftLabel, rightLabel, leftPct, rightPct,
    leftColor, rightColor,
    leftColorSecondary, rightColorSecondary,
    centerLine,
    size: 'sm',
  });

  const locked = gameStatus === 'in' || gameStatus === 'post';

  let voteSection = '';
  if (locked) {
    voteSection = `<div class="vote-closed">Voting closed. Game started.</div>`;
  } else if (!state.currentUser) {
    voteSection = `<div style="font-size:12px;color:var(--muted);margin-top:8px;"><a onclick="openLogin()" style="color:var(--accent);cursor:pointer;">Log in</a> or <a onclick="openSignup()" style="color:var(--accent);cursor:pointer;">sign up free</a> to track a pick</div>`;
  } else {
    // Vote buttons follow the active slot pair (not necessarily the gauge's home/away axis).
    let aKey, bKey, aLabel, bLabel;
    if (slotKey === 'over' || slotKey === 'under') {
      aKey = 'over';  aLabel = 'Over';  bKey = 'under'; bLabel = 'Under';
    } else if (slotKey === 'home_spread' || slotKey === 'away_spread') {
      aKey = 'home_spread'; aLabel = game.home_team?.split(' ').pop() || 'Home';
      bKey = 'away_spread'; bLabel = game.away_team?.split(' ').pop() || 'Away';
    } else {
      aKey = 'home_ml';     aLabel = game.home_team?.split(' ').pop() || 'Home';
      bKey = 'away_ml';     bLabel = game.away_team?.split(' ').pop() || 'Away';
    }
    const aVoted = userVote && userVote[aKey];
    const bVoted = userVote && userVote[bKey];
    const anyVoted = aVoted || bVoted;
    voteSection = `
      <div class="track-side-cap">
        <span>Track this side</span>
        <span class="track-verified-pill" title="A verified pick is a side tracked on a real game at our recorded line. It grades automatically and is the only kind that counts on the leaderboard. Custom bets are personal only." style="cursor:help;">Verified</span>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="vote-btn${aVoted ? ' voted' : ''}" onclick="voteOnSlot('${game.espn_game_id}','${aKey}')">
          ${aVoted ? '✓ ' : ''}${aLabel}
        </button>
        <button class="vote-btn${bVoted ? ' voted' : ''}" onclick="voteOnSlot('${game.espn_game_id}','${bKey}')">
          ${bVoted ? '✓ ' : ''}${bLabel}
        </button>
      </div>
      <div class="track-side-note">${anyVoted ? 'Tracked. It counts on the leaderboard once the game finishes.' : 'One tap tracks it, locked at the current line, graded automatically.'}</div>`;
  }

  const totalLine = total > 0
    ? `<div class="sentiment-vote-count">${total} vote${total !== 1 ? 's' : ''}</div>`
    : '';

  el.innerHTML = `
    <div class="sentiment-heading">Community Sentiment</div>
    <div class="sentiment-gauge-wrap">
      ${gaugeHtml}
      ${totalLine}
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
    if (res.status === 409) { window.showToast && window.showToast('Voting is closed, the game has started.', 'err'); return; }

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

    const watchHtml = buildGolfWatchHtml(tournament.broadcasts_json);

    content.innerHTML = `
      <div class="modal-header" style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;">
        <div style="flex:1;">
          <div style="font-size:18px;font-weight:700;">${tournament.name}</div>
          ${venue ? `<div style="font-size:13px;color:var(--muted);margin-top:2px;">${venue}</div>` : ''}
          <div style="margin-top:6px;">${statusBadge}</div>
        </div>
        <span class="sport-badge">Golf</span>
      </div>
      ${watchHtml}
      <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px;">Leaderboard</h3>
      ${leaderboardHtml}
      ${picksHtml}
    `;
  } catch (err) {
    content.innerHTML = `<div style="padding:32px;color:var(--muted);text-align:center;">Failed to load tournament data.</div>`;
  }
}

Object.assign(window, { openGameModal, openGolfModal, closeGameModal, selectTickerSlot, voteOnSlot });
