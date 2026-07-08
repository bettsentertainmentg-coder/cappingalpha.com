// src/soccer_espn.js
// Soccer fetcher for VERIFIED BET TRACKING. Writes popular-competition matches
// into today_games exactly like wnba_espn.js does for WNBA (espn_live.js is DO
// NOT TOUCH and does not export its upsert helper). This exists so soccer games
// can be tracked verified in the betslip: the odds board, vote slots, and
// grading all read today_games.
//
// Lines: ESPN's embedded DraftKings odds are free (no Odds API credits); the CA
// Odds Engine layers more books into book_lines on top.
//
// Soccer is a full team sport in the capper pick pipeline: the reader emits
// Soccer picks, slots seed like any team sport, and the +5 sport bonus and
// +5 home bonus both apply.
//
// Moneylines here are 3-WAY prices (draw exists). A drawn match grades ml
// picks and votes as LOSSES on both sides, matching how books settle 3-way
// moneylines. Those branches live in results.js (evaluatePick + evaluateVote),
// keyed off sport = 'Soccer'.
//
// Called at 5am + startup (fetchTodaysSoccerGames) and every 5 min during
// active hours (updateSoccerLiveScores).

const db = require('./db');
const { getCycleDate } = require('./cycle');
const { fetchScoreboardForDate, fetchScoreboard } = require('./espn_live');

// Same popular-competition set the betslip schedule offers. World Cup first.
const SOCCER_PATHS = [
  'soccer/fifa.world',
  'soccer/eng.1', 'soccer/usa.1', 'soccer/uefa.champions', 'soccer/uefa.europa',
  'soccer/esp.1', 'soccer/ita.1', 'soccer/ger.1', 'soccer/fra.1',
  'soccer/mex.1', 'soccer/ned.1', 'soccer/por.1', 'soccer/conmebol.america',
];

// ESPN embedded odds (DraftKings). Same shape as wnba_espn.parseEspnOdds; for
// soccer the moneyline prices are the 3-way market's home/away legs and the
// spread is the goal handicap when present.
function parseEspnOdds(comp) {
  const odds = comp.odds?.[0] || {};
  return {
    ml_home:       odds.moneyline?.home?.close?.odds != null ? parseInt(odds.moneyline.home.close.odds, 10) : null,
    ml_away:       odds.moneyline?.away?.close?.odds != null ? parseInt(odds.moneyline.away.close.odds, 10) : null,
    // Third leg of the 3-way market. ESPN usually puts it in drawOdds beside the
    // two team prices; some feeds nest it under moneyline.draw instead.
    ml_draw:       odds.drawOdds?.moneyLine != null ? parseInt(odds.drawOdds.moneyLine, 10)
                 : odds.moneyline?.draw?.close?.odds != null ? parseInt(odds.moneyline.draw.close.odds, 10) : null,
    over_under:    odds.overUnder ?? null,
    ou_over_odds:  odds.total?.over?.close?.odds  != null ? parseInt(odds.total.over.close.odds,  10) : null,
    ou_under_odds: odds.total?.under?.close?.odds != null ? parseInt(odds.total.under.close.odds, 10) : null,
    spread_home:   odds.pointSpread?.home?.close?.line != null ? parseFloat(odds.pointSpread.home.close.line) : null,
    spread_away:   odds.pointSpread?.away?.close?.line != null ? parseFloat(odds.pointSpread.away.close.line) : null,
  };
}

function upsertSoccerGame(ev, leaguePath = null) {
  const comp = ev.competitions?.[0] || {};
  const home = comp.competitors?.find(c => c.homeAway === 'home') || {};
  const away = comp.competitors?.find(c => c.homeAway === 'away') || {};
  if (!home.team || !away.team) return;
  const state = ev.status?.type?.state || 'pre';

  const o = parseEspnOdds(comp);

  db.prepare(`
    INSERT INTO today_games (
      espn_game_id, sport, status, period, clock, start_time,
      home_score, away_score,
      home_team, home_short, home_name, home_abbr,
      away_team, away_short, away_name, away_abbr,
      league_path,
      ml_home, ml_away, ml_draw, spread_home, spread_away,
      over_under, ou_over_odds, ou_under_odds, odds_updated_at,
      fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?,
              ?, ?, ?, ?, ?, ?, ?, ?,
              CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE NULL END,
              datetime('now'))
    ON CONFLICT(espn_game_id) DO UPDATE SET
      status     = excluded.status,
      period     = excluded.period,
      clock      = excluded.clock,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      fetched_at = excluded.fetched_at,
      league_path = COALESCE(excluded.league_path, league_path),
      ml_home       = COALESCE(ml_home,       excluded.ml_home),
      ml_away       = COALESCE(ml_away,       excluded.ml_away),
      ml_draw       = COALESCE(ml_draw,       excluded.ml_draw),
      spread_home   = COALESCE(spread_home,   excluded.spread_home),
      spread_away   = COALESCE(spread_away,   excluded.spread_away),
      over_under    = COALESCE(over_under,    excluded.over_under),
      ou_over_odds  = COALESCE(ou_over_odds,  excluded.ou_over_odds),
      ou_under_odds = COALESCE(ou_under_odds, excluded.ou_under_odds),
      odds_updated_at = CASE WHEN odds_updated_at IS NULL AND excluded.ml_home IS NOT NULL THEN datetime('now') ELSE odds_updated_at END
  `).run(
    ev.id, 'Soccer', state,
    ev.status?.period || null,
    ev.status?.displayClock || null,
    ev.date || null,
    parseInt(home.score || 0, 10),
    parseInt(away.score || 0, 10),
    home.team?.displayName || null,
    home.team?.shortDisplayName || null,
    home.team?.name || null,
    home.team?.abbreviation || null,
    away.team?.displayName || null,
    away.team?.shortDisplayName || null,
    away.team?.name || null,
    away.team?.abbreviation || null,
    leaguePath,
    o.ml_home, o.ml_away, o.ml_draw, o.spread_home, o.spread_away,
    o.over_under, o.ou_over_odds, o.ou_under_odds,
    o.ml_home
  );

  if (o.ml_home !== null || o.over_under !== null) {
    const { storeEspnDkLines } = require('./lines_scraper');
    storeEspnDkLines(ev.id, o);
  }
}

async function fetchTodaysSoccerGames() {
  const dateStr = getCycleDate().replace(/-/g, '');
  let total = 0;
  for (const path of SOCCER_PATHS) {
    try {
      const events = await fetchScoreboardForDate(path, dateStr);
      for (const ev of events) { upsertSoccerGame(ev, path); total++; }
    } catch (err) {
      console.warn(`[soccer_espn] ${path}:`, err.message);
    }
  }
  if (total > 0) console.log(`[soccer_espn] today_games: ${total} soccer matches upserted`);
  return total;
}

// Refresh every soccer match still on the board that hasn't gone final, so
// tracked bets flip live and grade the moment matches end. ESPN is free; a
// handful of scoreboard calls per cycle costs nothing.
//
// Refresh-only: the undated scoreboard endpoint returns an out-of-season
// competition's LAST played round (old Champions League semis, last year's
// Copa America, ...), so upserting everything it returns would drag stale
// finished matches onto the board. Only matches already on the board are
// updated here; new matches enter via the dated fetch (5am + startup).
async function updateSoccerLiveScores() {
  const open = db.prepare(
    `SELECT COUNT(*) n FROM today_games WHERE sport = 'Soccer' AND status != 'post'`
  ).get();
  if (!open || open.n === 0) return;
  const onBoard = new Set(
    db.prepare(`SELECT espn_game_id FROM today_games WHERE sport = 'Soccer'`).all()
      .map(r => String(r.espn_game_id))
  );
  for (const path of SOCCER_PATHS) {
    try {
      const events = await fetchScoreboard(path);
      for (const ev of events) {
        if (onBoard.has(String(ev.id))) upsertSoccerGame(ev, path);
      }
    } catch (_) { /* per-competition failures are fine */ }
  }
}

module.exports = { fetchTodaysSoccerGames, updateSoccerLiveScores, SOCCER_PATHS };
