// src/ncaaf_espn.js
// NCAAF (college football) ESPN fetcher. Writes into today_games exactly like
// wnba_espn.js does for WNBA (espn_live.js is DO NOT TOUCH and does not export
// its upsert helper). Own axios fetch because ESPN's default college-football
// scoreboard returns Top-25 games only: groups=80 (all FBS) + a high limit are
// required on the UNDATED call. (On a DATED call groups is a no-op, verified,
// but it is kept for the one undated path in updateNcaafLiveScores' successor.)
//
// NCAAF is a full team sport: it reuses today_games / picks / mvp_picks and
// gets the +5 sport bonus AND the +5 home bonus (scoring.js already lists it),
// except at NEUTRAL SITES, where lines.js seeds both sides is_home_team = 0.
//
// NEVER send a browser User-Agent to site.api.espn.com. It returns 403 in
// production (Railway) while an unmodified axios request returns 200 from the
// same host in the same second. That one header kept college football off the
// board for an entire season, silently, because the failure was a console.warn.
//
// ODDS: ESPN's college-football SCOREBOARD carries no odds block at all (0 of 68
// events on a real Saturday), unlike WNBA/Soccer. The lines come from ESPN's
// sports.core odds endpoint instead, which does carry full DraftKings numbers
// (spread, total, both moneylines, and the juice on each). Free, no Odds API
// credits, same host family line_history.js already uses.
//
// Called at 5am + startup (fetchTodaysNcaafGames), every 5 min for live scores,
// and fetchForwardNcaafGames keeps a 7-day rolling window so midweek picks for
// a weekend game have a row to match against. Seven days is safe here in a way
// it is not for a daily sport: no college team appears twice in any rolling
// 7-day window (verified across 120 days of the 2026 schedule), so a pick naming
// a school is never ambiguous.

const axios = require('axios');
const db = require('./db');
const { getCycleDate, addDays } = require('./cycle');

const NCAAF_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
const NCAAF_PARAMS = 'groups=80&limit=400';
const CORE_ODDS = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events';

// Books we will accept a line from, best first. Mirrors ca_line.BOOK_PRIORITY.
const ODDS_PROVIDERS = ['DraftKings', 'ESPN BET', 'Caesars Sportsbook', 'Bet365'];

// How many days ahead to keep on the board. College football is weekly, so the
// window has to reach the next playing day from any day of the week.
const FORWARD_DAYS = 7;

async function fetchNcaafScoreboard(dateStr = null) {
  const url = `${NCAAF_SCOREBOARD}?${NCAAF_PARAMS}${dateStr ? `&dates=${dateStr}` : ''}`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data?.events || [];
}

// ── ESPN sports.core odds for one event (free, no key) ────────────────────────
// Returns the same shape parseEspnOdds used to, or null when ESPN has no line
// yet (normal for games more than a few days out).
async function fetchCoreOdds(eventId) {
  try {
    const res = await axios.get(`${CORE_ODDS}/${eventId}/competitions/${eventId}/odds`, { timeout: 10000 });
    const items = res.data?.items || [];
    if (!items.length) return null;
    let it = null;
    for (const name of ODDS_PROVIDERS) {
      it = items.find(x => x.provider?.name === name);
      if (it) break;
    }
    if (!it) it = items[0];

    // ESPN's `spread` is always the HOME spread (verified: "ORE -22.5" on a game
    // where Oregon is away comes back as +22.5).
    const spreadHome = it.spread != null ? parseFloat(it.spread) : null;
    return {
      ml_home:       it.homeTeamOdds?.moneyLine != null ? parseInt(it.homeTeamOdds.moneyLine, 10) : null,
      ml_away:       it.awayTeamOdds?.moneyLine != null ? parseInt(it.awayTeamOdds.moneyLine, 10) : null,
      over_under:    it.overUnder != null ? parseFloat(it.overUnder) : null,
      ou_over_odds:  it.overOdds  != null ? parseInt(it.overOdds, 10)  : null,
      ou_under_odds: it.underOdds != null ? parseInt(it.underOdds, 10) : null,
      spread_home:   spreadHome,
      spread_away:   spreadHome != null ? -spreadHome : null,
      spread_home_odds: it.homeTeamOdds?.spreadOdds != null ? parseInt(it.homeTeamOdds.spreadOdds, 10) : null,
      spread_away_odds: it.awayTeamOdds?.spreadOdds != null ? parseInt(it.awayTeamOdds.spreadOdds, 10) : null,
    };
  } catch (_) {
    return null;
  }
}

const EMPTY_ODDS = {
  ml_home: null, ml_away: null, over_under: null, ou_over_odds: null, ou_under_odds: null,
  spread_home: null, spread_away: null, spread_home_odds: null, spread_away_odds: null,
};

// ESPN publishes unfilled bowl slots as literal "TBD at TBD" rows (40 of them in
// the week of 2026-12-26). They are not games: they would seed six pick slots
// each and pollute every matcher. /api/games already strips TBD for tennis
// brackets; this keeps them out of today_games in the first place.
function isPlaceholder(home, away) {
  const bad = s => !s || String(s).trim().toUpperCase() === 'TBD';
  return bad(home?.team?.displayName) || bad(away?.team?.displayName);
}

// ── Upsert a single NCAAF event into today_games ──────────────────────────────
function upsertNcaafGame(ev, odds = null) {
  const comp = ev.competitions?.[0] || {};
  const home = comp.competitors?.find(c => c.homeAway === 'home') || {};
  const away = comp.competitors?.find(c => c.homeAway === 'away') || {};
  if (!home.team || !away.team) return false;
  if (isPlaceholder(home, away)) return false;
  const state = ev.status?.type?.state || 'pre';

  // A neutral-site game has no home team, so there is no home-field edge to pay
  // for. 1.2% of the regular season and effectively all of bowl season.
  const neutral = comp.neutralSite ? 1 : 0;

  const o = odds || EMPTY_ODDS;

  db.prepare(`
    INSERT INTO today_games (
      espn_game_id, sport, status, period, clock, start_time,
      home_score, away_score,
      home_team, home_short, home_name, home_abbr,
      away_team, away_short, away_name, away_abbr,
      neutral_site,
      ml_home, ml_away, spread_home, spread_away,
      spread_home_odds, spread_away_odds,
      over_under, ou_over_odds, ou_under_odds, odds_updated_at,
      fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?,
              CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE NULL END,
              datetime('now'))
    ON CONFLICT(espn_game_id) DO UPDATE SET
      status     = excluded.status,
      period     = excluded.period,
      clock      = excluded.clock,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      fetched_at = excluded.fetched_at,
      neutral_site  = excluded.neutral_site,
      ml_home       = COALESCE(ml_home,       excluded.ml_home),
      ml_away       = COALESCE(ml_away,       excluded.ml_away),
      spread_home   = COALESCE(spread_home,   excluded.spread_home),
      spread_away   = COALESCE(spread_away,   excluded.spread_away),
      spread_home_odds = COALESCE(spread_home_odds, excluded.spread_home_odds),
      spread_away_odds = COALESCE(spread_away_odds, excluded.spread_away_odds),
      over_under    = COALESCE(over_under,    excluded.over_under),
      ou_over_odds  = COALESCE(ou_over_odds,  excluded.ou_over_odds),
      ou_under_odds = COALESCE(ou_under_odds, excluded.ou_under_odds),
      odds_updated_at = CASE WHEN odds_updated_at IS NULL AND excluded.ml_home IS NOT NULL THEN datetime('now') ELSE odds_updated_at END
  `).run(
    ev.id, 'NCAAF', state,
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
    neutral,
    o.ml_home, o.ml_away, o.spread_home, o.spread_away,
    o.spread_home_odds, o.spread_away_odds,
    o.over_under, o.ou_over_odds, o.ou_under_odds,
    o.ml_home  // sentinel for odds_updated_at CASE
  );

  // The game row is the thing that matters. A book_lines write failing must never
  // cost us the game, and on a Saturday it must never cost us the other 79.
  if (o.ml_home !== null || o.over_under !== null) {
    try {
      const { storeEspnDkLines } = require('./lines_scraper');
      storeEspnDkLines(ev.id, o);
    } catch (err) {
      console.error('[ncaaf_espn] storeEspnDkLines failed for', ev.id, err.message);
    }
  }
  return true;
}

// Which of these games still need an odds lookup: pregame, and missing a line.
// Started games are skipped (lines lock at start) and so are games we already
// priced, so a full Saturday costs a handful of requests, not eighty.
function needsOdds(ids) {
  if (!ids.length) return new Set();
  const ph = ids.map(() => '?').join(',');
  const have = db.prepare(
    `SELECT espn_game_id FROM today_games
      WHERE espn_game_id IN (${ph}) AND (ml_home IS NOT NULL OR over_under IS NOT NULL)`
  ).all(...ids).map(r => r.espn_game_id);
  return new Set(ids.filter(id => !have.includes(id)));
}

// Fetch odds a few at a time so a big slate never opens 80 sockets at once.
async function fetchOddsFor(events, wanted) {
  const out = new Map();
  const todo = events.filter(e => wanted.has(e.id) && e.status?.type?.state === 'pre');
  const BATCH = 6;
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const got = await Promise.all(slice.map(e => fetchCoreOdds(e.id)));
    slice.forEach((e, k) => { if (got[k]) out.set(e.id, got[k]); });
  }
  return out;
}

// ── Fetch one day's NCAAF games, upsert into today_games ──────────────────────
// withOdds is off on the 5-min live pass (scores only) and on for the 5am /
// startup / odds-refresh passes.
async function fetchNcaafForDate(dateStr, { withOdds = false, label = 'today' } = {}) {
  const events = await fetchNcaafScoreboard(dateStr);
  if (!events.length) return 0;

  let odds = new Map();
  if (withOdds) {
    const wanted = needsOdds(events.map(e => e.id));
    if (wanted.size) odds = await fetchOddsFor(events, wanted);
  }

  let n = 0, failed = 0, skipped = 0;
  for (const ev of events) {
    try {
      if (upsertNcaafGame(ev, odds.get(ev.id) || null)) n++;
      else skipped++;
    } catch (err) {
      failed++;
      console.error('[ncaaf_espn] upsert failed for', ev.id, ev.name, err.message);
    }
  }
  console.log(
    `[ncaaf_espn] ${label} ${dateStr}: ${n} games upserted` +
    (odds.size ? `, ${odds.size} priced` : '') +
    (skipped ? `, ${skipped} placeholder rows skipped` : '') +
    (failed ? `, ${failed} FAILED` : '')
  );
  return n;
}

// ── Today ─────────────────────────────────────────────────────────────────────
async function fetchTodaysNcaafGames({ withOdds = true } = {}) {
  const dateStr = getCycleDate().replace(/-/g, ''); // YYYYMMDD, ET game day
  try {
    return await fetchNcaafForDate(dateStr, { withOdds, label: 'today' });
  } catch (err) {
    // console.error, not warn: this failing silently is exactly how college
    // football stayed off the board for a season.
    console.error('[ncaaf_espn] fetchTodaysNcaafGames FAILED:', err.message);
    return 0;
  }
}

// ── Forward window: today+1 .. today+FORWARD_DAYS ─────────────────────────────
// Runs on the 5am pass only. Its own loop rather than espn_live's TODAY_SPORTS
// because espn_live.js is do-not-touch and NCAAF needs a longer window than the
// daily sports do.
async function fetchForwardNcaafGames(daysAhead = FORWARD_DAYS) {
  const base = getCycleDate();
  let total = 0;
  for (let d = 1; d <= daysAhead; d++) {
    const dateStr = addDays(base, d).replace(/-/g, '');
    try {
      total += await fetchNcaafForDate(dateStr, { withOdds: true, label: `+${d}d` });
    } catch (err) {
      console.error(`[ncaaf_espn] fetchForwardNcaafGames(+${d}d) FAILED:`, err.message);
    }
  }
  if (total) console.log(`[ncaaf_espn] forward window complete: ${total} games over ${daysAhead}d`);
  return total;
}

// fetchNcaafForDate is exported so a specific game day can be backfilled or
// verified directly (the two callers above only ever ask for today or today+N).
module.exports = { fetchTodaysNcaafGames, fetchForwardNcaafGames, fetchNcaafForDate };
