// src/live_situation.js
// Condensed in-game state for live games (baseball bases/outs/half-inning, etc.),
// pulled from ESPN's free scoreboard endpoint. One call per active sport covers
// every live game of that sport, so this is cheap and ESPN-only (no paid APIs).
//
// Writes into today_games.live_detail / live_outs / live_bases. Deliberately
// separate from espn_live.js (which is do-not-touch and only captures the score +
// period). espn_live's upsert never touches these columns, so the two coexist.
//
// Extensible: add a sport to SCOREBOARD + a parser branch to support more game
// states (football down/distance, etc.). MLB is the first.

const db    = require('./db');
const axios = require('axios');

// ESPN free scoreboard per sport. Returns every game today with a `situation`
// block (bases/outs) and status.type.shortDetail ("Bot 5th") for live games.
const SCOREBOARD = {
  MLB: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
};

// Parse one ESPN competition into { detail, outs, bases } for the given sport, or
// null when there's no meaningful live state to store.
function parseSituation(sport, comp) {
  const stType = comp.status?.type || {};
  if (stType.state !== 'in') return null;
  const detail = stType.shortDetail || stType.detail || null;

  if (sport === 'MLB') {
    const sit = comp.situation || {};
    const bases = (sit.onFirst ? 1 : 0) | (sit.onSecond ? 2 : 0) | (sit.onThird ? 4 : 0);
    const outs  = (typeof sit.outs === 'number') ? sit.outs : null;
    return { detail, outs, bases };
  }

  // Other sports: keep the half/period detail text, no bases/outs.
  return { detail, outs: null, bases: null };
}

async function syncLiveSituations() {
  // Stale guard: clear live-state for anything no longer in progress so a final
  // game never lingers as "Bot 5th".
  db.prepare(`
    UPDATE today_games SET live_detail = NULL, live_outs = NULL, live_bases = NULL
    WHERE status != 'in'
      AND (live_detail IS NOT NULL OR live_outs IS NOT NULL OR live_bases IS NOT NULL)
  `).run();

  const liveSports = db.prepare(`SELECT DISTINCT sport FROM today_games WHERE status = 'in'`)
    .all().map(r => (r.sport || '').toUpperCase());
  if (!liveSports.length) return 0;

  const upd = db.prepare(`
    UPDATE today_games SET live_detail = ?, live_outs = ?, live_bases = ?
    WHERE espn_game_id = ? AND status = 'in'
  `);

  let updated = 0;
  for (const sport of liveSports) {
    const url = SCOREBOARD[sport];
    if (!url) continue;   // sport not wired for situation yet — leaves period/clock fallback
    let events;
    try {
      const res = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      events = res.data?.events || [];
    } catch (e) {
      console.warn(`[live_situation] ${sport} scoreboard fetch failed:`, e.message);
      continue;
    }
    for (const ev of events) {
      const comp = (ev.competitions || [])[0];
      if (!comp) continue;
      const s = parseSituation(sport, comp);
      if (!s) continue;
      const r = upd.run(s.detail, s.outs, s.bases, String(ev.id));
      if (r.changes) updated++;
    }
  }

  if (updated) console.log(`[live_situation] updated ${updated} live game(s)`);
  return updated;
}

module.exports = { syncLiveSituations };
