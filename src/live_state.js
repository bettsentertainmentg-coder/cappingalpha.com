// src/live_state.js
// Per-sport parsers that turn one ESPN scoreboard event into the flat live
// STATE object the tracker serves (/api/game/:id/live). live_tracker.js owns
// the fetch/cache and finds the event; this module owns the shape.
//
// The state stays FLAT (one object, optional per-sport fields) so the existing
// MLB renderer keeps working unchanged and new sports only add keys.

const SPORT_FAMILY = {
  MLB: 'baseball',
  NFL: 'football', NCAAF: 'football',
  NBA: 'basketball', WNBA: 'basketball', CBB: 'basketball', WCBB: 'basketball',
  NHL: 'hockey',
  SOCCER: 'soccer',
  ATP: 'tennis', WTA: 'tennis',
};

const intOr = (v, d = null) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
const athleteName = (o) => o?.athlete?.shortName || o?.athlete?.displayName || null;
const lineOf = (c) => Array.isArray(c?.linescores) ? c.linescores.map(l => intOr(l.value, 0)) : [];

// Map an ESPN team id to 'home' | 'away' | null.
function sideOf(id, homeC, awayC) {
  const s = String(id ?? '');
  if (!s) return null;
  if (s === String(homeC?.team?.id ?? homeC?.id ?? '')) return 'home';
  if (s === String(awayC?.team?.id ?? awayC?.id ?? '')) return 'away';
  return null;
}

// Pull one numeric stat from an ESPN competitor.statistics array.
function statOf(c, name) {
  const s = (c?.statistics || []).find(x => x?.name === name);
  if (!s) return null;
  const v = parseFloat(s.displayValue ?? s.value);
  return Number.isNaN(v) ? null : v;
}

// ── parseLiveState(sport, ev) ──────────────────────────────────────────────────
// ev is a scoreboard event ({ competitions: [comp] }). Tennis callers pass the
// match competition wrapped the same way. Returns the flat state object, or
// null when the event has no competition block.
function parseLiveState(sport, ev) {
  const sp = String(sport || '').toUpperCase();
  const comp = (ev?.competitions || [])[0];
  if (!comp) return null;

  const stType = comp.status?.type || ev?.status?.type || {};
  const status = comp.status || ev?.status || {};
  const competitors = comp.competitors || [];
  const homeC = competitors.find(c => c.homeAway === 'home') || competitors[0];
  const awayC = competitors.find(c => c.homeAway === 'away') || competitors[1];
  const detail = stType.shortDetail || stType.detail || null;
  const sit = comp.situation || {};

  const out = {
    status:    stType.state || null,        // 'pre' | 'in' | 'post'
    detail,
    period:    status.period ?? null,
    clock:     status.displayClock ?? null,
    homeScore: homeC ? (parseInt(homeC.score, 10) || 0) : null,
    awayScore: awayC ? (parseInt(awayC.score, 10) || 0) : null,
    homeAbbr:  homeC?.team?.abbreviation || homeC?.athlete?.shortName || null,
    awayAbbr:  awayC?.team?.abbreviation || awayC?.athlete?.shortName || null,
    lastPlay:  sit.lastPlay?.text || null,
  };

  const family = SPORT_FAMILY[sp];
  if (family && family !== 'tennis') {
    out.homeLine = lineOf(homeC);
    out.awayLine = lineOf(awayC);
  }

  if (family === 'baseball') {
    out.homeHits    = intOr(homeC?.hits);
    out.awayHits    = intOr(awayC?.hits);
    out.homeErrors  = intOr(homeC?.errors);
    out.awayErrors  = intOr(awayC?.errors);
    out.inning      = status.period ?? null;
    out.half        = /bot/i.test(detail || '') ? 'bot' : (/top/i.test(detail || '') ? 'top' : null);
    out.outs        = (typeof sit.outs === 'number') ? sit.outs : null;
    out.bases       = (sit.onFirst ? 1 : 0) | (sit.onSecond ? 2 : 0) | (sit.onThird ? 4 : 0);
    out.balls       = (typeof sit.balls === 'number') ? sit.balls : null;
    out.strikes     = (typeof sit.strikes === 'number') ? sit.strikes : null;
    out.batter      = athleteName(sit.batter);
    out.batterLine  = sit.batter?.summary || null;
    out.pitcher     = athleteName(sit.pitcher);
    out.pitcherLine = sit.pitcher?.summary || null;
    out.dueUp       = Array.isArray(sit.dueUp) ? sit.dueUp.map(athleteName).filter(Boolean).slice(0, 3) : [];
  }

  if (family === 'football') {
    out.down             = (typeof sit.down === 'number' && sit.down > 0) ? sit.down : null;
    out.distance         = (typeof sit.distance === 'number') ? sit.distance : null;
    out.downDistanceText = sit.shortDownDistanceText || sit.downDistanceText || null;
    out.yardLineText     = sit.possessionText || null;
    out.possession       = sideOf(sit.possession, homeC, awayC);
    out.isRedZone        = sit.isRedZone === true;
    out.homeTimeouts     = (typeof sit.homeTimeouts === 'number') ? sit.homeTimeouts : null;
    out.awayTimeouts     = (typeof sit.awayTimeouts === 'number') ? sit.awayTimeouts : null;
  }

  if (family === 'basketball') {
    // ESPN rides a fresh win prob on the last play — the freshest free ml signal
    // between summary refreshes.
    const p = sit.lastPlay?.probability?.homeWinPercentage;
    out.lastPlayHomeWP = (typeof p === 'number' && p >= 0 && p <= 1) ? p : null;
  }

  if (family === 'hockey') {
    // Strength / shots-on-goal come from the free NHL api (nhl_api.js); the
    // endpoint merges them in. Placeholders keep the shape stable.
    out.strength = null;
    out.homeSOG  = null;
    out.awaySOG  = null;
  }

  if (family === 'soccer') {
    out.minute = status.displayClock || null;              // "45'+2'" style
    const poss = statOf(homeC, 'possessionPct');
    out.possessionPct = (poss == null) ? null : { home: poss, away: statOf(awayC, 'possessionPct') ?? Math.round((100 - poss) * 10) / 10 };
    out.shots = { home: statOf(homeC, 'totalShots'), away: statOf(awayC, 'totalShots') };
    out.shotsOnTarget = { home: statOf(homeC, 'shotsOnTarget'), away: statOf(awayC, 'shotsOnTarget') };
    // Compact key-event strip (goals / cards / subs), most recent last.
    const evs = [];
    for (const d of (comp.details || [])) {
      const type = d.scoringPlay ? 'goal'
        : d.redCard ? 'red'
        : d.yellowCard ? 'yellow'
        : /sub/i.test(d.type?.text || '') ? 'sub'
        : d.penaltyKick ? 'pen'
        : null;
      if (!type) continue;
      evs.push({
        min:    d.clock?.displayValue || null,
        type,
        team:   sideOf(d.team?.id, homeC, awayC),
        player: d.athletesInvolved?.[0]?.displayName || d.athletesInvolved?.[0]?.shortName || null,
      });
    }
    out.keyEventsCompact = evs.slice(-8);
  }

  if (family === 'tennis') {
    const hl = homeC?.linescores || [];
    const al = awayC?.linescores || [];
    const n = Math.max(hl.length, al.length);
    const sets = [];
    let homeSets = 0, awaySets = 0;
    for (let i = 0; i < n; i++) {
      const h = intOr(hl[i]?.value, 0), a = intOr(al[i]?.value, 0);
      const winner = hl[i]?.winner === true ? 'home' : (al[i]?.winner === true ? 'away' : (h > a ? 'home' : (a > h ? 'away' : null)));
      sets.push({ home: h, away: a, homeTb: hl[i]?.tiebreak ?? null, awayTb: al[i]?.tiebreak ?? null, winner });
      if (winner === 'home') homeSets++; else if (winner === 'away') awaySets++;
    }
    out.sets = sets;
    // Score = sets won (matches how tennis rows are stored in today_games).
    out.homeScore = homeSets;
    out.awayScore = awaySets;
    if (out.status === 'in' && sets.length) {
      const cur = sets[sets.length - 1];
      out.currentSetGames = { home: cur.home, away: cur.away };
    }
    // Serve indicator — ESPN's `possession` flag on the competitor. Unverified
    // live, so parse defensively and let the client omit when null.
    out.serving = homeC?.possession === true ? 'home' : (awayC?.possession === true ? 'away' : null);
  }

  return out;
}

module.exports = { parseLiveState, SPORT_FAMILY };
