// src/mock_live.js
// LOCAL-DEV ONLY mock live MLB game, for building/previewing the live tracker when
// no real game is in progress.
//
// SAFETY: gated on UI_ONLY (which is never set on Railway, per CLAUDE.md) and only
// ever writes to the local SQLite DB (data/ is gitignored). Every consumer guards
// on isMockId()/mockActive(), so all of this is inert in production. Disable in dev
// with MOCK_LIVE=0.

const { liveWinProb, gameProgress } = require('./win_prob');
const { computeValuePulse } = require('./live_value');

const MOCK_ID = 'mocklive1';
const HOME = { team: 'Cincinnati Reds',     short: 'Reds',    abbr: 'CIN' };
const AWAY = { team: 'Pittsburgh Pirates',  short: 'Pirates', abbr: 'PIT' };
const PREGAME_HOME_PROB = 0.62;   // home favorite -> a "trailing early" buy-low demo

function mockActive() {
  return !!process.env.UI_ONLY && process.env.MOCK_LIVE !== '0';
}
function isMockId(id) { return mockActive() && String(id) === MOCK_ID; }

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
const FRAME_SECS = 7;

function currentFrameIndex() {
  return Math.floor(((Date.now() / 1000) % (FRAMES.length * FRAME_SECS)) / FRAME_SECS);
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

function mockLiveState() {
  const idx = currentFrameIndex();
  return frameToState(FRAMES[idx] || FRAMES[0], idx);
}

// Full value arc from the first frame through the current one, run through the real
// win-prob + value engine (sequential EMA) so the sparkline shows how value built.
function mockPulseHistory(pregameHomeProb, caScore, mvpThreshold) {
  const idx = currentFrameIndex();
  let prev = null;
  const out = [];
  for (let i = 0; i <= idx; i++) {
    const st = frameToState(FRAMES[i], i);
    const now = liveWinProb(st, pregameHomeProb, 'home');   // mock pick is the home ML
    const pulse = computeValuePulse({
      pickWP_now: now, pickWP_pre: pregameHomeProb, caScore,
      gameProgress: gameProgress(st), prevMagnitude: prev, mvpThreshold,
    });
    prev = pulse.magnitude;
    out.push({ v: pulse.magnitude, p: FRAMES[i].inning });   // carry the inning for the x-axis
  }
  return out;
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
    console.log(`[mock_live] installed mock live MLB game id=${MOCK_ID} (UI_ONLY dev only — never deploys)`);
  } catch (e) {
    console.warn('[mock_live] install failed:', e.message);
  }
}

module.exports = { MOCK_ID, isMockId, mockActive, mockLiveState, mockPulseHistory, installMockLive };
