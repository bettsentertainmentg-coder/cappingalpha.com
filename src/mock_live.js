// src/mock_live.js
// LOCAL-DEV ONLY mock live games (MLB 'mocklive1' + NFL 'mocklive2'), for
// building/previewing the live tracker when no real game is in progress.
//
// SAFETY: gated on UI_ONLY (which is never set on Railway, per CLAUDE.md) and only
// ever writes to the local SQLite DB (data/ is gitignored). Every consumer guards
// on isMockId()/mockActive(), so all of this is inert in production. Disable in dev
// with MOCK_LIVE=0.

const { liveWinProb, gameProgress } = require('./win_prob');
const { computeValuePulse } = require('./live_value');
const { genericProgress, clockHomeWP, anchoredWP } = require('./win_prob_generic');

const MOCK_ID = 'mocklive1';
const HOME = { team: 'Cincinnati Reds',     short: 'Reds',    abbr: 'CIN' };
const AWAY = { team: 'Pittsburgh Pirates',  short: 'Pirates', abbr: 'PIT' };
const PREGAME_HOME_PROB = 0.62;   // home favorite -> a "trailing early" buy-low demo

const MOCK_ID2 = 'mocklive2';
const HOME2 = { team: 'Cincinnati Bengals',   short: 'Bengals',  abbr: 'CIN' };
const AWAY2 = { team: 'Pittsburgh Steelers',  short: 'Steelers', abbr: 'PIT' };
const PREGAME_HOME_PROB2 = 0.58;  // implied by ml_home -150 / ml_away +130 (de-vigged)

function mockActive() {
  return !!process.env.UI_ONLY && process.env.MOCK_LIVE !== '0';
}
function isMockId(id) {
  return mockActive() && (String(id) === MOCK_ID || String(id) === MOCK_ID2);
}

// Evolving live state at per-pitch granularity so the value pulse twitches between
// plays (counts + baserunners move the win-prob model) and swings across a full
// buy-low arc: the home favorite (the pick) falls behind 0-3 early (value spikes
// gold), claws back to 3-3 (value neutralizes), takes a 5-3 / 6-4 lead (value goes
// blue — priced up, little left), then loops.
const FRAMES = [
  { detail: 'Top 1st', inning: 1, half: 'top', outs: 0, bases: 0, balls: 0, strikes: 0, home: 0, away: 0, hh: 0, ah: 0, he: 0, ae: 0, bat: 'O. Cruz',       batLine: '0-0',       pit: 'H. Greene',    pitLine: '0.0 IP',            lastPlay: 'Top of the 1st' },
  { detail: 'Top 1st', inning: 1, half: 'top', outs: 0, bases: 0, balls: 0, strikes: 2, home: 0, away: 0, hh: 0, ah: 0, he: 0, ae: 0, bat: 'O. Cruz',       batLine: '0-0',       pit: 'H. Greene',    pitLine: '0.1 IP',            lastPlay: 'Swinging strike, 0-2' },
  { detail: 'Top 1st', inning: 1, half: 'top', outs: 0, bases: 1, balls: 1, strikes: 0, home: 0, away: 0, hh: 0, ah: 1, he: 0, ae: 0, bat: 'B. Reynolds',   batLine: '0-0',       pit: 'H. Greene',    pitLine: '0.1 IP',            lastPlay: 'Cruz singles to right' },
  { detail: 'Top 1st', inning: 1, half: 'top', outs: 0, bases: 3, balls: 3, strikes: 1, home: 0, away: 0, hh: 0, ah: 2, he: 0, ae: 0, bat: 'A. McCutchen', batLine: '0-0',       pit: 'H. Greene',    pitLine: '0.1 IP',            lastPlay: 'Reynolds singles, corners, 3-1' },
  { detail: 'Top 1st', inning: 1, half: 'top', outs: 1, bases: 6, balls: 1, strikes: 2, home: 0, away: 1, hh: 0, ah: 2, he: 0, ae: 0, bat: 'K. Hayes',      batLine: '0-1',       pit: 'H. Greene',    pitLine: '0.2 IP, 1 ER',      lastPlay: 'RBI groundout, PIT 1-0' },
  { detail: 'Top 1st', inning: 1, half: 'top', outs: 1, bases: 6, balls: 2, strikes: 2, home: 0, away: 1, hh: 0, ah: 4, he: 0, ae: 0, bat: 'K. Hayes',      batLine: '0-1',       pit: 'H. Greene',    pitLine: '0.2 IP, 1 ER',      lastPlay: 'Full-count battle, runners aboard' },
  { detail: 'Top 1st', inning: 1, half: 'top', outs: 1, bases: 0, balls: 0, strikes: 0, home: 0, away: 3, hh: 0, ah: 6, he: 0, ae: 0, bat: 'J. Triolo',    batLine: '1-1, 2B',   pit: 'H. Greene',    pitLine: '0.2 IP, 3 ER',      lastPlay: '2-run double, PIT 3-0' },
  { detail: 'Bot 1st', inning: 1, half: 'bot', outs: 0, bases: 1, balls: 2, strikes: 1, home: 0, away: 3, hh: 1, ah: 6, he: 0, ae: 0, bat: 'E. De La Cruz', batLine: '0-0',       pit: 'P. Skenes',    pitLine: '0.0 IP',            lastPlay: 'De La Cruz works the count' },
  { detail: 'Bot 1st', inning: 1, half: 'bot', outs: 0, bases: 6, balls: 1, strikes: 2, home: 1, away: 3, hh: 4, ah: 6, he: 0, ae: 0, bat: 'S. Steer',      batLine: '1-1, RBI',  pit: 'P. Skenes',    pitLine: '0.1 IP, 1 ER',      lastPlay: 'RBI single, CIN 1-3' },
  { detail: 'Bot 2nd', inning: 2, half: 'bot', outs: 1, bases: 4, balls: 2, strikes: 2, home: 2, away: 3, hh: 6, ah: 6, he: 0, ae: 0, bat: 'J. India',     batLine: '1-2, RBI',  pit: 'P. Skenes',    pitLine: '1.1 IP, 2 ER',      lastPlay: 'RBI groundout, CIN 2-3' },
  { detail: 'Bot 3rd', inning: 3, half: 'bot', outs: 2, bases: 2, balls: 1, strikes: 1, home: 2, away: 3, hh: 6, ah: 7, he: 0, ae: 0, bat: 'S. Steer',      batLine: '1-2',       pit: 'P. Skenes',    pitLine: '2.2 IP, 2 ER',      lastPlay: 'Two down, tying run on 2nd' },
  { detail: 'Bot 3rd', inning: 3, half: 'bot', outs: 2, bases: 0, balls: 0, strikes: 0, home: 3, away: 3, hh: 7, ah: 7, he: 0, ae: 0, bat: 'T. Friedl',     batLine: '0-0',       pit: 'P. Skenes',    pitLine: '2.2 IP, 3 ER',      lastPlay: 'RBI single ties it 3-3' },
  { detail: 'Top 4th', inning: 4, half: 'top', outs: 1, bases: 1, balls: 1, strikes: 1, home: 3, away: 3, hh: 7, ah: 8, he: 1, ae: 0, bat: 'O. Cruz',       batLine: '1-2',       pit: 'H. Greene',    pitLine: '3.1 IP, 3 ER',      lastPlay: 'Reached on an error' },
  { detail: 'Bot 5th', inning: 5, half: 'bot', outs: 0, bases: 1, balls: 2, strikes: 0, home: 3, away: 3, hh: 8, ah: 8, he: 1, ae: 1, bat: 'S. Steer',      batLine: '1-3',       pit: 'C. Holderman', pitLine: '0.0 IP',            lastPlay: 'Leadoff single' },
  { detail: 'Bot 5th', inning: 5, half: 'bot', outs: 0, bases: 0, balls: 0, strikes: 0, home: 5, away: 3, hh: 9, ah: 8, he: 1, ae: 1, bat: 'E. De La Cruz', batLine: '2-3, HR',   pit: 'C. Holderman', pitLine: '0.1 IP, 2 ER',      lastPlay: '2-run homer, CIN 5-3' },
  { detail: 'Top 6th', inning: 6, half: 'top', outs: 2, bases: 6, balls: 2, strikes: 2, home: 5, away: 3, hh: 9, ah: 9, he: 1, ae: 1, bat: 'B. Reynolds',   batLine: '2-3',       pit: 'A. Abbott',    pitLine: '0.2 IP',            lastPlay: 'Two on, two out for Reynolds' },
  { detail: 'Top 6th', inning: 6, half: 'top', outs: 2, bases: 5, balls: 0, strikes: 0, home: 5, away: 4, hh: 9, ah: 10, he: 1, ae: 1, bat: 'K. Hayes',     batLine: '0-0',       pit: 'A. Abbott',    pitLine: '0.2 IP, 1 ER',      lastPlay: 'RBI single, PIT within 5-4' },
  { detail: 'Bot 7th', inning: 7, half: 'bot', outs: 1, bases: 0, balls: 0, strikes: 1, home: 5, away: 4, hh: 10, ah: 10, he: 1, ae: 1, bat: 'E. De La Cruz', batLine: '1-3',      pit: 'A. Abbott',    pitLine: '1.2 IP',            lastPlay: 'Reds cling to a 5-4 lead' },
  { detail: 'Bot 8th', inning: 8, half: 'bot', outs: 1, bases: 4, balls: 1, strikes: 2, home: 6, away: 4, hh: 11, ah: 10, he: 1, ae: 1, bat: 'S. Steer',    batLine: '2-4',       pit: 'D. Bednar',    pitLine: '0.1 IP, 1 ER',      lastPlay: 'Insurance run, CIN 6-4' },
];
// NFL mock arc (mocklive2): the home favorite (Bengals) falls behind 0-10, claws
// back to 10-10 at the half, trails 10-17 in the 3rd, and takes the lead late,
// 20-17 (mirrors the mocklive1 value arc). homeLine/awayLine = per-quarter points
// so far. Includes red-zone frames (f9, f15) and scoring lastPlay frames.
const FRAMES2 = [
  { detail: 'Q1 15:00', period: 1, clock: '15:00', home: 0,  away: 0,  homeLine: [0],          awayLine: [0],          down: 1,    distance: 10,   downDistanceText: '1st & 10',   yardLineText: 'PIT 25', possession: 'away', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'Kickoff, touchback' },
  { detail: 'Q1 11:24', period: 1, clock: '11:24', home: 0,  away: 0,  homeLine: [0],          awayLine: [0],          down: 3,    distance: 4,    downDistanceText: '3rd & 4',    yardLineText: 'CIN 38', possession: 'away', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'Warren rushes up the middle for 6 yards' },
  { detail: 'Q1 8:52',  period: 1, clock: '8:52',  home: 0,  away: 3,  homeLine: [0],          awayLine: [3],          down: 1,    distance: 10,   downDistanceText: '1st & 10',   yardLineText: 'CIN 25', possession: 'home', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'C. Boswell 45 yd field goal, PIT 3-0' },
  { detail: 'Q1 4:10',  period: 1, clock: '4:10',  home: 0,  away: 3,  homeLine: [0],          awayLine: [3],          down: 2,    distance: 7,    downDistanceText: '2nd & 7',    yardLineText: 'CIN 45', possession: 'home', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'Burrow completes to Chase for 12' },
  { detail: 'Q1 0:48',  period: 1, clock: '0:48',  home: 0,  away: 3,  homeLine: [0],          awayLine: [3],          down: 1,    distance: 10,   downDistanceText: '1st & 10',   yardLineText: 'PIT 33', possession: 'away', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'CIN punt, fair catch at the 33' },
  { detail: 'Q2 13:05', period: 2, clock: '13:05', home: 0,  away: 10, homeLine: [0, 0],       awayLine: [3, 7],       down: 1,    distance: 10,   downDistanceText: '1st & 10',   yardLineText: 'CIN 30', possession: 'home', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'D. Metcalf 34 yd touchdown pass, PIT 10-0' },
  { detail: 'Q2 9:30',  period: 2, clock: '9:30',  home: 0,  away: 10, homeLine: [0, 0],       awayLine: [3, 7],       down: 3,    distance: 3,    downDistanceText: '3rd & 3',    yardLineText: 'PIT 44', possession: 'home', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'Brown rushes off tackle for 5 yards' },
  { detail: 'Q2 7:42',  period: 2, clock: '7:42',  home: 3,  away: 10, homeLine: [0, 3],       awayLine: [3, 7],       down: 1,    distance: 10,   downDistanceText: '1st & 10',   yardLineText: 'PIT 25', possession: 'away', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'E. McPherson 48 yd field goal, PIT 10-3' },
  { detail: 'Q2 2:00',  period: 2, clock: '2:00',  home: 3,  away: 10, homeLine: [0, 3],       awayLine: [3, 7],       down: 2,    distance: 6,    downDistanceText: '2nd & 6',    yardLineText: 'PIT 41', possession: 'home', isRedZone: false, homeTimeouts: 3, awayTimeouts: 2, lastPlay: 'Two-minute warning' },
  { detail: 'Q2 0:34',  period: 2, clock: '0:34',  home: 3,  away: 10, homeLine: [0, 3],       awayLine: [3, 7],       down: 1,    distance: 8,    downDistanceText: '1st & Goal', yardLineText: 'PIT 8',  possession: 'home', isRedZone: true,  homeTimeouts: 2, awayTimeouts: 2, lastPlay: 'Chase catches 22 yards to the PIT 8' },
  { detail: 'Q2 0:02',  period: 2, clock: '0:02',  home: 10, away: 10, homeLine: [0, 10],      awayLine: [3, 7],       down: null, distance: null, downDistanceText: null,         yardLineText: null,     possession: null,   isRedZone: false, homeTimeouts: 2, awayTimeouts: 2, lastPlay: 'J. Chase 8 yd touchdown pass, tied 10-10' },
  { detail: 'Q3 10:12', period: 3, clock: '10:12', home: 10, away: 17, homeLine: [0, 10, 0],   awayLine: [3, 7, 7],    down: 1,    distance: 10,   downDistanceText: '1st & 10',   yardLineText: 'CIN 30', possession: 'home', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'J. Warren 12 yd touchdown run, PIT 17-10' },
  { detail: 'Q3 5:47',  period: 3, clock: '5:47',  home: 10, away: 17, homeLine: [0, 10, 0],   awayLine: [3, 7, 7],    down: 3,    distance: 2,    downDistanceText: '3rd & 2',    yardLineText: 'PIT 44', possession: 'home', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'Burrow scrambles for 9' },
  { detail: 'Q3 1:20',  period: 3, clock: '1:20',  home: 13, away: 17, homeLine: [0, 10, 3],   awayLine: [3, 7, 7],    down: 1,    distance: 10,   downDistanceText: '1st & 10',   yardLineText: 'PIT 25', possession: 'away', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'E. McPherson 33 yd field goal, PIT 17-13' },
  { detail: 'Q4 12:30', period: 4, clock: '12:30', home: 13, away: 17, homeLine: [0, 10, 3, 0], awayLine: [3, 7, 7, 0], down: 1,    distance: 10,   downDistanceText: '1st & 10',   yardLineText: 'CIN 22', possession: 'home', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'Punt downed at the CIN 22' },
  { detail: 'Q4 8:15',  period: 4, clock: '8:15',  home: 13, away: 17, homeLine: [0, 10, 3, 0], awayLine: [3, 7, 7, 0], down: 2,    distance: 3,    downDistanceText: '2nd & 3',    yardLineText: 'PIT 19', possession: 'home', isRedZone: true,  homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'Higgins catches 16 yards to the PIT 19' },
  { detail: 'Q4 6:58',  period: 4, clock: '6:58',  home: 20, away: 17, homeLine: [0, 10, 3, 7], awayLine: [3, 7, 7, 0], down: 1,    distance: 10,   downDistanceText: '1st & 10',   yardLineText: 'PIT 25', possession: 'away', isRedZone: false, homeTimeouts: 3, awayTimeouts: 3, lastPlay: 'T. Higgins 19 yd touchdown pass, CIN 20-17' },
  { detail: 'Q4 2:14',  period: 4, clock: '2:14',  home: 20, away: 17, homeLine: [0, 10, 3, 7], awayLine: [3, 7, 7, 0], down: 3,    distance: 8,    downDistanceText: '3rd & 8',    yardLineText: 'CIN 41', possession: 'away', isRedZone: false, homeTimeouts: 2, awayTimeouts: 1, lastPlay: 'Incomplete deep left' },
  { detail: 'Q4 0:29',  period: 4, clock: '0:29',  home: 20, away: 17, homeLine: [0, 10, 3, 7], awayLine: [3, 7, 7, 0], down: 1,    distance: 10,   downDistanceText: '1st & 10',   yardLineText: 'CIN 40', possession: 'home', isRedZone: false, homeTimeouts: 2, awayTimeouts: 0, lastPlay: 'Turnover on downs, CIN takes over' },
  { detail: 'Q4 0:02',  period: 4, clock: '0:02',  home: 20, away: 17, homeLine: [0, 10, 3, 7], awayLine: [3, 7, 7, 0], down: null, distance: null, downDistanceText: null,         yardLineText: null,     possession: 'home', isRedZone: false, homeTimeouts: 2, awayTimeouts: 0, lastPlay: 'Burrow kneels, Bengals seal it' },
];

// Progress forward through the game at ~8x real time: a ~3h game plays out over ~22
// minutes, advancing one frame at a time (~75s each), then loops to a fresh game. This
// makes it feel like a real game ticking through innings rather than a frantic loop.
const GAME_SPEED   = 8;
const REAL_GAME_MS = 3 * 60 * 60 * 1000;             // baseline ~3h game
const CYCLE_MS     = Math.round(REAL_GAME_MS / GAME_SPEED);   // ~22.5 min compressed

function framesFor(gameId) { return String(gameId) === MOCK_ID2 ? FRAMES2 : FRAMES; }

function currentFrameIndex(frames = FRAMES) {
  const pos = Date.now() % CYCLE_MS;
  return Math.min(frames.length - 1, Math.floor((pos / CYCLE_MS) * frames.length));
}

// Per-inning runs (line score) up to the current frame, derived by replaying the
// cumulative scores so it always sums to the live score. Away bats the top, home the
// bottom, so home only gets a cell once it has batted that inning.
function mockLineScore(idx) {
  const cur = FRAMES[idx] || FRAMES[0];
  const awayInns = cur.inning;
  const homeInns = cur.half === 'bot' ? cur.inning : cur.inning - 1;
  const away = Array(Math.max(0, awayInns)).fill(0);
  const home = Array(Math.max(0, homeInns)).fill(0);
  let pa = 0, ph = 0;
  for (let i = 0; i <= idx; i++) {
    const f = FRAMES[i];
    const da = f.away - pa, dh = f.home - ph;
    if (da > 0 && f.inning - 1 < away.length) away[f.inning - 1] += da;
    if (dh > 0 && f.inning - 1 < home.length) home[f.inning - 1] += dh;
    pa = f.away; ph = f.home;
  }
  return { away, home };
}

function frameToState(f, idx) {
  const ls = mockLineScore(idx == null ? currentFrameIndex() : idx);
  return {
    status: 'in', detail: f.detail, period: f.inning, clock: '0:00',
    homeScore: f.home, awayScore: f.away, homeAbbr: HOME.abbr, awayAbbr: AWAY.abbr,
    homeHits: f.hh, awayHits: f.ah, homeErrors: f.he, awayErrors: f.ae,
    homeLine: ls.home, awayLine: ls.away,
    inning: f.inning, half: f.half, outs: f.outs, bases: f.bases, balls: f.balls, strikes: f.strikes,
    batter: f.bat, batterLine: f.batLine, pitcher: f.pit, pitcherLine: f.pitLine,
    dueUp: ['M. Fraelick'], lastPlay: f.lastPlay,
  };
}

// NFL frame -> the flat /live state shape live_state.js produces for football.
function frameToState2(f) {
  return {
    status: 'in', detail: f.detail, period: f.period, clock: f.clock,
    homeScore: f.home, awayScore: f.away, homeAbbr: HOME2.abbr, awayAbbr: AWAY2.abbr,
    homeLine: f.homeLine, awayLine: f.awayLine, lastPlay: f.lastPlay,
    down: f.down, distance: f.distance, downDistanceText: f.downDistanceText,
    yardLineText: f.yardLineText, possession: f.possession, isRedZone: f.isRedZone,
    homeTimeouts: f.homeTimeouts, awayTimeouts: f.awayTimeouts,
  };
}

// Home win prob for one NFL frame via the generic clock-sport engine.
function nflFrameWP(f, pregameHomeProb) {
  const prog = genericProgress('NFL', f.period, f.clock);
  return { prog, home: anchoredWP(clockHomeWP('football', f.home, f.away, prog), pregameHomeProb, prog) };
}

function mockLiveState(gameId = MOCK_ID) {
  if (String(gameId) === MOCK_ID2) {
    const idx = currentFrameIndex(FRAMES2);
    return frameToState2(FRAMES2[idx] || FRAMES2[0]);
  }
  const idx = currentFrameIndex();
  return frameToState(FRAMES[idx] || FRAMES[0], idx);
}

// Completed-game snapshot (status 'post') for previewing the finished tracker — open
// the live URL with ?final=1. Final score + full line score, no live situation.
function mockFinalState(gameId = MOCK_ID) {
  if (String(gameId) === MOCK_ID2) {
    const f = FRAMES2[FRAMES2.length - 1];
    return {
      status: 'post', detail: 'Final', period: f.period, clock: null,
      homeScore: f.home, awayScore: f.away, homeAbbr: HOME2.abbr, awayAbbr: AWAY2.abbr,
      homeLine: f.homeLine, awayLine: f.awayLine,
      down: null, distance: null, downDistanceText: null, yardLineText: null,
      possession: null, isRedZone: false, homeTimeouts: null, awayTimeouts: null,
      lastPlay: f.lastPlay, winner: f.home > f.away ? 'home' : (f.away > f.home ? 'away' : null),
    };
  }
  const i = FRAMES.length - 1, f = FRAMES[i], ls = mockLineScore(i);
  return {
    status: 'post', detail: 'Final', period: f.inning, clock: null,
    homeScore: f.home, awayScore: f.away, homeAbbr: HOME.abbr, awayAbbr: AWAY.abbr,
    homeHits: f.hh, awayHits: f.ah, homeErrors: f.he, awayErrors: f.ae,
    homeLine: ls.home, awayLine: ls.away,
    inning: f.inning, half: f.half, outs: 2, bases: null, balls: null, strikes: null,
    batter: null, batterLine: null, pitcher: null, pitcherLine: null, dueUp: [],
    lastPlay: f.lastPlay, winner: f.home > f.away ? 'home' : (f.away > f.home ? 'away' : null),
  };
}

// Shared value-arc builder: replays frames 0..lastIdx through the real win-prob +
// value engine (sequential EMA). MLB frames use the baseball model; NFL frames use
// the generic clock-sport engine (genericProgress + clockHomeWP + anchoredWP).
function _pulseArc(gameId, lastIdx, pregameHomeProb, caScore, mvpThreshold, side, publicPct) {
  const frames = framesFor(gameId);
  const nfl = String(gameId) === MOCK_ID2;
  const pre = side === 'away' ? 1 - pregameHomeProb : pregameHomeProb;
  let prev = null;
  const out = [];
  const end = Math.min(lastIdx, frames.length - 1);
  for (let i = 0; i <= end; i++) {
    const f = frames[i];
    let now, gp, p;
    if (nfl) {
      const wp = nflFrameWP(f, pregameHomeProb);
      now = side === 'away' ? 1 - wp.home : wp.home;
      gp = wp.prog;
      p = f.period;   // carry the quarter for the x-axis
    } else {
      const st = frameToState(f, i);
      now = liveWinProb(st, pregameHomeProb, side);
      gp = gameProgress(st);
      p = f.inning;   // carry the inning for the x-axis
    }
    const trailing = side === 'home' ? (f.home < f.away) : (f.away < f.home);
    const pulse = computeValuePulse({
      pickWP_now: now, pickWP_pre: pre, caScore, trailing, publicPct,
      gameProgress: gp, prevMagnitude: prev, mvpThreshold,
    });
    prev = pulse.magnitude;
    out.push({ v: pulse.magnitude, p });
  }
  return out;
}

// The complete value arc across every frame (for the finished view).
function mockFullPulseHistory(pregameHomeProb, caScore, mvpThreshold, side = 'home', publicPct = null, gameId = MOCK_ID) {
  return _pulseArc(gameId, framesFor(gameId).length - 1, pregameHomeProb, caScore, mvpThreshold, side, publicPct);
}

// Full value arc from the first frame through the current one, run through the real
// win-prob + value engine (sequential EMA) so the sparkline shows how value built.
function mockPulseHistory(pregameHomeProb, caScore, mvpThreshold, side = 'home', publicPct = null, gameId = MOCK_ID) {
  const idx = Math.max(1, currentFrameIndex(framesFor(gameId)));   // always >= 2 points so the chart draws
  return _pulseArc(gameId, idx, pregameHomeProb, caScore, mvpThreshold, side, publicPct);
}

// Upsert the mock game + a CA pick + a high-volume market row into the LOCAL DB so
// it surfaces through the normal detail-page / Top Games / pick routes. Idempotent.
function installMockLive(db) {
  if (!mockActive()) return;
  const startTime = new Date(Date.now() - 75 * 60 * 1000).toISOString();   // ~75 min ago (today)
  const snap = FRAMES[7]; // representative "down early" snapshot for the tile + first paint
  try {
    db.prepare(`
      INSERT INTO today_games (espn_game_id, sport, status, period, clock, start_time,
        home_score, away_score, home_team, home_short, home_name, home_abbr,
        away_team, away_short, away_name, away_abbr)
      VALUES (@id,'MLB','in',@period,'0:00',@start,@home,@away,@hteam,@hshort,@hteam,@habbr,@ateam,@ashort,@ateam,@aabbr)
      ON CONFLICT(espn_game_id) DO UPDATE SET status='in', period=@period, home_score=@home, away_score=@away, start_time=@start
    `).run({ id: MOCK_ID, period: snap.inning, start: startTime, home: snap.home, away: snap.away,
      hteam: HOME.team, hshort: HOME.short, habbr: HOME.abbr, ateam: AWAY.team, ashort: AWAY.short, aabbr: AWAY.abbr });
    db.prepare(`UPDATE today_games SET live_detail=?, live_outs=?, live_bases=? WHERE espn_game_id=?`)
      .run(snap.detail, snap.outs, snap.bases, MOCK_ID);
    db.prepare(`DELETE FROM raw_messages WHERE pick_id IN (SELECT id FROM picks WHERE espn_game_id=?)`).run(MOCK_ID);
    db.prepare(`DELETE FROM picks WHERE espn_game_id=?`).run(MOCK_ID);
    const info = db.prepare(`
      INSERT INTO picks (capper_name, team, pick_type, sport, game_date, mention_count, score, channel, espn_game_id, is_home_team, original_ml)
      VALUES ('MockCapper', @team, 'ml', 'MLB', date('now'), 3, 55, 'free-plays', @id, 1, -150)
    `).run({ team: HOME.team, id: MOCK_ID });
    // Seed channel mentions so the conviction curve has a real shape (free-plays +35,
    // then community-leaks +10; home +5 and MLB +5 auto-stagger in => final 55).
    const pickId = info.lastInsertRowid;
    const tip = new Date(startTime).getTime();
    const ts = (h) => new Date(tip - h * 60 * 60 * 1000).toISOString();
    const insMsg = db.prepare(`INSERT INTO raw_messages (pick_id, channel, message_text, author, message_timestamp) VALUES (?,?,?,?,?)`);
    insMsg.run(pickId, 'free-plays',      'Reds ML',       'MockCapper', ts(3));
    insMsg.run(pickId, 'community-leaks', 'Reds ML again', 'MockLeak',   ts(2));
    // A second pick on the away side (rank 2, score 35) so the non-paid blurred
    // conviction is demonstrable: view "Pirates Win" while logged out.
    const info2 = db.prepare(`
      INSERT INTO picks (capper_name, team, pick_type, sport, game_date, mention_count, score, channel, espn_game_id, is_home_team, original_ml)
      VALUES ('MockFade', @team, 'ml', 'MLB', date('now'), 1, 35, 'pod-thread', @id, 0, 130)
    `).run({ team: AWAY.team, id: MOCK_ID });
    insMsg.run(info2.lastInsertRowid, 'pod-thread', 'Pirates ML', 'MockFade', ts(2.5));
    const mj = JSON.stringify({ moneyline: { home_prob: PREGAME_HOME_PROB, away_prob: 1 - PREGAME_HOME_PROB } });
    db.prepare(`
      INSERT INTO polymarket_cache (espn_game_id, markets_json, morning_markets_json, volume_usd, updated_at)
      VALUES (@id,@mj,@mj,9999999,datetime('now'))
      ON CONFLICT(espn_game_id) DO UPDATE SET markets_json=@mj, morning_markets_json=@mj, volume_usd=9999999, updated_at=datetime('now')
    `).run({ id: MOCK_ID, mj });
    // Public betting (game start): the public leans on the Reds (home favorite). Feeds
    // the value pulse conviction blend (CA + line + public).
    db.prepare(`
      INSERT INTO public_betting (espn_game_id, home_ml_pct, away_ml_pct, home_ml_money_pct, away_ml_money_pct)
      VALUES (@id, 61, 39, 64, 36)
      ON CONFLICT(espn_game_id) DO UPDATE SET home_ml_pct=61, away_ml_pct=39
    `).run({ id: MOCK_ID });
    console.log(`[mock_live] installed mock live MLB game id=${MOCK_ID} (UI_ONLY dev only — never deploys)`);
  } catch (e) {
    console.warn('[mock_live] install failed:', e.message);
  }

  // Second mock game: NFL (mocklive2), for eyeballing the football renderer.
  try {
    const startTime2 = new Date(Date.now() - 75 * 60 * 1000).toISOString();
    const snap2 = FRAMES2[7]; // representative "down 3-10" snapshot for the tile + first paint
    db.prepare(`
      INSERT INTO today_games (espn_game_id, sport, status, period, clock, start_time,
        home_score, away_score, home_team, home_short, home_name, home_abbr,
        away_team, away_short, away_name, away_abbr,
        ml_home, ml_away, spread_home, over_under)
      VALUES (@id,'NFL','in',@period,@clock,@start,@home,@away,@hteam,@hshort,@hteam,@habbr,@ateam,@ashort,@ateam,@aabbr,
        -150, 130, -3, 44.5)
      ON CONFLICT(espn_game_id) DO UPDATE SET status='in', period=@period, clock=@clock,
        home_score=@home, away_score=@away, start_time=@start,
        ml_home=-150, ml_away=130, spread_home=-3, over_under=44.5
    `).run({ id: MOCK_ID2, period: snap2.period, clock: snap2.clock, start: startTime2,
      home: snap2.home, away: snap2.away,
      hteam: HOME2.team, hshort: HOME2.short, habbr: HOME2.abbr,
      ateam: AWAY2.team, ashort: AWAY2.short, aabbr: AWAY2.abbr });
    db.prepare(`UPDATE today_games SET live_detail=? WHERE espn_game_id=?`).run(snap2.detail, MOCK_ID2);
    db.prepare(`DELETE FROM raw_messages WHERE pick_id IN (SELECT id FROM picks WHERE espn_game_id=?)`).run(MOCK_ID2);
    db.prepare(`DELETE FROM picks WHERE espn_game_id=?`).run(MOCK_ID2);
    const info3 = db.prepare(`
      INSERT INTO picks (capper_name, team, pick_type, sport, game_date, mention_count, score, channel, espn_game_id, is_home_team, original_ml)
      VALUES ('MockCapper', @team, 'ml', 'NFL', date('now'), 2, 55, 'free-plays', @id, 1, -150)
    `).run({ team: HOME2.team, id: MOCK_ID2 });
    const tip2 = new Date(startTime2).getTime();
    const ts2 = (h) => new Date(tip2 - h * 60 * 60 * 1000).toISOString();
    const insMsg2 = db.prepare(`INSERT INTO raw_messages (pick_id, channel, message_text, author, message_timestamp) VALUES (?,?,?,?,?)`);
    insMsg2.run(info3.lastInsertRowid, 'free-plays',      'Bengals ML',       'MockCapper', ts2(4));
    insMsg2.run(info3.lastInsertRowid, 'community-leaks', 'Bengals ML again', 'MockLeak',   ts2(1.5));
    // Public betting: the public leans on the Bengals (home favorite), which feeds the
    // value pulse conviction blend, same as the MLB mock.
    db.prepare(`
      INSERT INTO public_betting (espn_game_id, home_ml_pct, away_ml_pct, home_ml_money_pct, away_ml_money_pct)
      VALUES (@id, 58, 42, 62, 38)
      ON CONFLICT(espn_game_id) DO UPDATE SET home_ml_pct=58, away_ml_pct=42
    `).run({ id: MOCK_ID2 });
    console.log(`[mock_live] installed mock live NFL game id=${MOCK_ID2} (UI_ONLY dev only, never deploys)`);
  } catch (e) {
    console.warn('[mock_live] install (NFL) failed:', e.message);
  }
}

// ── Static /live/feed payloads for the mock games ──────────────────────────────
// Same shape as espn_summary.getFeed so the tracker tabs render without ESPN.
// NFL: drives-style plays derived from FRAMES2 (scoring detected by score delta),
// a synthetic ~40-point win-prob series matching the frame arc, current drive,
// leaders, and team stats. MLB is simpler: win-prob series + at-bat result plays.
const HS_NFL = (id) => `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`;
const HS_MLB = (id) => `https://a.espncdn.com/i/headshots/mlb/players/full/${id}.png`;

function _nflMockPlays() {
  const out = [];
  let ph = 0, pa = 0;
  FRAMES2.forEach((f, i) => {
    const dh = f.home - ph, da = f.away - pa;
    ph = f.home; pa = f.away;
    const scoring = dh > 0 || da > 0;
    out.push({
      id: `mock2-${i}`, period: f.period, clock: f.clock,
      team: scoring ? (dh > 0 ? 'home' : 'away') : f.possession,
      text: f.lastPlay, scoring, scoreValue: scoring ? (dh || da) : null,
      homeScore: f.home, awayScore: f.away,
    });
  });
  return out;
}

function _nflMockWinprob() {
  // ~2 points per frame (frame + interpolated midpoint) => ~37 synthetic points.
  const series = [];
  const rd = (x, m) => Math.round(x * m) / m;
  for (let i = 0; i < FRAMES2.length; i++) {
    const f = FRAMES2[i];
    const wp = nflFrameWP(f, PREGAME_HOME_PROB2);
    series.push({ x: rd(wp.prog, 1000), home: rd(wp.home * 100, 10) });
    const n = FRAMES2[i + 1];
    if (n) {
      const nprog = genericProgress('NFL', n.period, n.clock);
      const mid = (wp.prog + nprog) / 2;
      const mwp = anchoredWP(clockHomeWP('football', f.home, f.away, mid), PREGAME_HOME_PROB2, mid);
      series.push({ x: rd(mid, 1000), home: rd(mwp * 100, 10) });
    }
  }
  const plays = _nflMockPlays();
  const scoring = plays.filter(p => p.scoring).map((p, j) => {
    const f = FRAMES2[parseInt(p.id.slice(6), 10)];
    const wp = nflFrameWP(f, PREGAME_HOME_PROB2);
    return { x: rd(wp.prog, 1000), team: p.team, text: p.text.slice(0, 90), period: p.period, clock: p.clock };
  });
  return {
    source: 'model',
    latestHome: series.length ? series[series.length - 1].home / 100 : null,
    series, scoring,
  };
}

function mockLiveFeed(gameId = MOCK_ID) {
  if (String(gameId) === MOCK_ID2) {
    const plays = _nflMockPlays();
    const scoringPlays = plays.filter(p => p.scoring).map(p => ({ ...p, type: p.scoreValue >= 6 ? 'TD' : 'FG' }));
    return {
      sport: 'NFL', status: 'in',
      winprob: _nflMockWinprob(),
      plays, scoringPlays,
      drive: { team: 'home', desc: '4 plays, 12 yards, 1:45', start: 'CIN 40' },
      leaders: {
        home: [
          { cat: 'Passing Yards', value: '24/33, 287 YDS, 2 TD',      name: 'J. Burrow',  pos: 'QB', headshot: HS_NFL(3915511) },
          { cat: 'Rushing Yards', value: '18 CAR, 74 YDS',            name: 'C. Brown',   pos: 'RB', headshot: HS_NFL(4429275) },
          { cat: 'Receiving Yards', value: '9 REC, 124 YDS, 1 TD',    name: 'J. Chase',   pos: 'WR', headshot: HS_NFL(4362628) },
        ],
        away: [
          { cat: 'Passing Yards', value: '19/31, 224 YDS, 1 TD, 1 INT', name: 'R. Wilson',  pos: 'QB', headshot: HS_NFL(14881) },
          { cat: 'Rushing Yards', value: '14 CAR, 68 YDS, 1 TD',        name: 'J. Warren',  pos: 'RB', headshot: HS_NFL(4569609) },
          { cat: 'Receiving Yards', value: '6 REC, 98 YDS, 1 TD',       name: 'D. Metcalf', pos: 'WR', headshot: HS_NFL(4047650) },
        ],
      },
      teamStats: {
        home: [
          { label: 'Total Yards', value: '361' }, { label: 'Passing', value: '287' },
          { label: 'Rushing', value: '74' },      { label: '1st Downs', value: '21' },
          { label: '3rd Down', value: '7-13' },   { label: 'Turnovers', value: '0' },
          { label: 'Possession', value: '31:12' },
        ],
        away: [
          { label: 'Total Yards', value: '318' }, { label: 'Passing', value: '224' },
          { label: 'Rushing', value: '94' },      { label: '1st Downs', value: '17' },
          { label: '3rd Down', value: '5-12' },   { label: 'Turnovers', value: '1' },
          { label: 'Possession', value: '28:48' },
        ],
      },
    };
  }

  // MLB mock: win-prob series across the frame arc + at-bat result plays.
  const rd = (x, m) => Math.round(x * m) / m;
  const n = FRAMES.length;
  const series = FRAMES.map((f, i) => {
    const st = frameToState(f, i);
    return { x: rd(n > 1 ? i / (n - 1) : 1, 1000), home: rd(liveWinProb(st, PREGAME_HOME_PROB, 'home') * 100, 10) };
  });
  let ph = 0, pa = 0;
  const plays = FRAMES.map((f, i) => {
    const dh = f.home - ph, da = f.away - pa;
    ph = f.home; pa = f.away;
    const scoring = dh > 0 || da > 0;
    return {
      id: `mock1-${i}`, period: f.inning, clock: null,
      team: scoring ? (dh > 0 ? 'home' : 'away') : (f.half === 'bot' ? 'home' : 'away'),
      text: f.lastPlay, scoring, scoreValue: scoring ? (dh || da) : null,
      homeScore: f.home, awayScore: f.away, half: f.half,
    };
  }).filter((p, i) => p.scoring || i % 3 === 0);   // keep results, thin the filler
  const scoringPlays = plays.filter(p => p.scoring);
  return {
    sport: 'MLB', status: 'in',
    winprob: {
      source: 'model',
      latestHome: series.length ? series[series.length - 1].home / 100 : null,
      series,
      scoring: plays.filter(p => p.scoring).map(p => ({
        x: series[Math.min(parseInt(p.id.slice(6), 10), series.length - 1)].x,
        team: p.team, text: p.text.slice(0, 90), period: p.period, clock: null,
      })),
    },
    plays, scoringPlays, drive: null,
    leaders: {
      home: [
        { cat: 'Batting', value: '2-3, HR, 2 RBI', name: 'E. De La Cruz', pos: 'SS', headshot: HS_MLB(4917694) },
        { cat: 'Pitching', value: '5.0 IP, 4 ER',  name: 'H. Greene',     pos: 'P',  headshot: HS_MLB(41263) },
      ],
      away: [
        { cat: 'Batting', value: '2-3, 2B',        name: 'B. Reynolds',   pos: 'CF', headshot: HS_MLB(39909) },
        { cat: 'Pitching', value: '4.2 IP, 3 ER',  name: 'P. Skenes',     pos: 'P',  headshot: HS_MLB(5108398) },
      ],
    },
    teamStats: {
      home: [
        { label: 'Hits', value: '11' }, { label: 'Runs', value: '6' },
        { label: 'Home Runs', value: '1' }, { label: 'Strikeouts', value: '7' },
        { label: 'Left on Base', value: '5' },
      ],
      away: [
        { label: 'Hits', value: '10' }, { label: 'Runs', value: '4' },
        { label: 'Home Runs', value: '0' }, { label: 'Strikeouts', value: '9' },
        { label: 'Left on Base', value: '7' },
      ],
    },
  };
}

module.exports = { MOCK_ID, MOCK_ID2, isMockId, mockActive, mockLiveState, mockFinalState, mockPulseHistory, mockFullPulseHistory, installMockLive, mockLiveFeed };
