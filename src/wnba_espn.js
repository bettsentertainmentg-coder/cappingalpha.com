// src/wnba_espn.js
// WNBA-specific ESPN fetcher. Writes into today_games exactly like espn_live.js
// does for team sports (NBA/MLB/NHL), but lives in its own file because
// espn_live.js is DO NOT TOUCH and does not export its upsert helper.
//
// WNBA is a full team sport: it reuses today_games / picks / mvp_picks, gets the
// +5 sport bonus AND the +5 home bonus (home court applies). Lines come from
// ESPN's embedded DraftKings odds — free, no Odds API credits.
//
// Called at 5am (fetchTodaysWnbaGames) + startup, and every 5 min
// (updateWnbaLiveScores) alongside espn_live.updateLiveScores().

const db = require('./db');
const { getCycleDate } = require('./cycle');
const { fetchScoreboardForDate, fetchScoreboard } = require('./espn_live');

const WNBA_PATH = 'basketball/wnba';

// ── Parse ESPN embedded odds (DraftKings data, free, no API key) ──────────────
// Mirrors parseEspnOdds in espn_live.js.
function parseEspnOdds(comp) {
  const odds = comp.odds?.[0] || {};
  return {
    ml_home:       odds.moneyline?.home?.close?.odds != null ? parseInt(odds.moneyline.home.close.odds, 10) : null,
    ml_away:       odds.moneyline?.away?.close?.odds != null ? parseInt(odds.moneyline.away.close.odds, 10) : null,
    over_under:    odds.overUnder ?? null,
    ou_over_odds:  odds.total?.over?.close?.odds  != null ? parseInt(odds.total.over.close.odds,  10) : null,
    ou_under_odds: odds.total?.under?.close?.odds != null ? parseInt(odds.total.under.close.odds, 10) : null,
    spread_home:   odds.pointSpread?.home?.close?.line != null ? parseFloat(odds.pointSpread.home.close.line) : null,
    spread_away:   odds.pointSpread?.away?.close?.line != null ? parseFloat(odds.pointSpread.away.close.line) : null,
  };
}

// ── Upsert a single WNBA event into today_games ───────────────────────────────
// Mirrors upsertTodayGame in espn_live.js (locks "Current" line at first write).
function upsertWnbaGame(ev) {
  const comp = ev.competitions?.[0] || {};
  const home = comp.competitors?.find(c => c.homeAway === 'home') || {};
  const away = comp.competitors?.find(c => c.homeAway === 'away') || {};
  const state = ev.status?.type?.state || 'pre'; // 'pre', 'in', or 'post'

  const o = parseEspnOdds(comp);

  db.prepare(`
    INSERT INTO today_games (
      espn_game_id, sport, status, period, clock, start_time,
      home_score, away_score,
      home_team, home_short, home_name, home_abbr,
      away_team, away_short, away_name, away_abbr,
      ml_home, ml_away, spread_home, spread_away,
      over_under, ou_over_odds, ou_under_odds, odds_updated_at,
      fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?,
              CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE NULL END,
              datetime('now'))
    ON CONFLICT(espn_game_id) DO UPDATE SET
      status     = excluded.status,
      period     = excluded.period,
      clock      = excluded.clock,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      fetched_at = excluded.fetched_at,
      ml_home       = COALESCE(ml_home,       excluded.ml_home),
      ml_away       = COALESCE(ml_away,       excluded.ml_away),
      spread_home   = COALESCE(spread_home,   excluded.spread_home),
      spread_away   = COALESCE(spread_away,   excluded.spread_away),
      over_under    = COALESCE(over_under,    excluded.over_under),
      ou_over_odds  = COALESCE(ou_over_odds,  excluded.ou_over_odds),
      ou_under_odds = COALESCE(ou_under_odds, excluded.ou_under_odds),
      odds_updated_at = CASE WHEN odds_updated_at IS NULL AND excluded.ml_home IS NOT NULL THEN datetime('now') ELSE odds_updated_at END
  `).run(
    ev.id, 'WNBA', state,
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
    o.ml_home, o.ml_away, o.spread_home, o.spread_away,
    o.over_under, o.ou_over_odds, o.ou_under_odds,
    o.ml_home  // sentinel for odds_updated_at CASE
  );

  // Also write DK book_lines entry (ESPN odds are DraftKings data)
  if (o.ml_home !== null || o.over_under !== null) {
    const { storeEspnDkLines } = require('./lines_scraper');
    storeEspnDkLines(ev.id, o);
  }
}

// ── Fetch today's WNBA games, upsert into today_games ─────────────────────────
async function fetchTodaysWnbaGames() {
  const dateStr = getCycleDate().replace(/-/g, ''); // YYYYMMDD
  try {
    const events = await fetchScoreboardForDate(WNBA_PATH, dateStr);
    for (const ev of events) upsertWnbaGame(ev);
    if (events.length > 0) {
      console.log(`[wnba_espn] today_games: ${events.length} WNBA games upserted`);
    }
    return events.length;
  } catch (err) {
    console.warn('[wnba_espn] fetchTodaysWnbaGames error:', err.message);
    return 0;
  }
}

// ── Update live scores for WNBA games that have picks today ────────────────────
// Mirrors espn_live.updateLiveScores / tennis_espn.updateTennisLiveScores.
async function updateWnbaLiveScores() {
  const topGames = db.prepare(`
    SELECT DISTINCT p.espn_game_id
    FROM picks p
    INNER JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
    WHERE p.game_date = (SELECT MAX(game_date) FROM picks)
      AND p.espn_game_id IS NOT NULL
      AND p.mention_count > 0
      AND tg.sport = 'WNBA'
  `).all().map(r => r.espn_game_id);

  if (!topGames.length) return;

  try {
    const events = await fetchScoreboard(WNBA_PATH);
    for (const ev of events) {
      if (topGames.includes(ev.id)) upsertWnbaGame(ev);
    }
  } catch (err) {
    console.warn('[wnba_espn] updateWnbaLiveScores error:', err.message);
  }
}

module.exports = { fetchTodaysWnbaGames, updateWnbaLiveScores };
