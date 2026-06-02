// src/bovada.js
// Free tennis lines from Bovada's public coupon API — game spread, total games,
// moneyline. The Odds API and ESPN carry NO tennis spreads/totals, so this is the
// only source. No auth, no API key, zero Odds API credits.
//
// Populates today_games.spread_home / spread_away / over_under / ou_over_odds /
// ou_under_odds / ml_home / ml_away for ATP + WTA rows only. Team-sport rows
// (owned by the Odds API) are never touched.

const db = require('./db');

const BOVADA_TENNIS_URL =
  'https://www.bovada.lv/services/sports/event/coupon/events/A/description/tennis?marketFilterId=def&lang=en';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const lastNameOf = (name) =>
  (name || '').trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g, '');

// ── Pull the two competitor names + the match-period markets from a Bovada event ─
function parseEvent(ev) {
  const markets = {}; // 'Game Spread' | 'Moneyline' | 'Total' -> outcomes[]
  for (const dg of ev.displayGroups || []) {
    if ((dg.description || '') !== 'Game Lines') continue;
    for (const m of dg.markets || []) {
      // Match period only — skip per-set / first-set variants
      if ((m.period?.description || '') !== 'Match') continue;
      markets[m.description] = m.outcomes || [];
    }
  }
  return markets;
}

// Build a value object oriented to the ESPN game's home/away players.
function orientLines(markets, game) {
  const homeLast = lastNameOf(game.home_team);
  const awayLast = lastNameOf(game.away_team);

  const out = {
    ml_home: null, ml_away: null,
    spread_home: null, spread_away: null,
    over_under: null, ou_over_odds: null, ou_under_odds: null,
  };

  const sideOf = (outcome) => {
    const last = lastNameOf(outcome.description);
    if (last && last === homeLast) return 'home';
    if (last && last === awayLast) return 'away';
    return null;
  };
  const american = (o) => {
    const a = parseFloat(o.price?.american);
    return Number.isFinite(a) ? a : null;
  };
  const handicap = (o) => {
    const h = parseFloat(o.price?.handicap);
    return Number.isFinite(h) ? h : null;
  };

  // Moneyline
  for (const o of markets['Moneyline'] || []) {
    const side = sideOf(o);
    if (side === 'home') out.ml_home = american(o);
    else if (side === 'away') out.ml_away = american(o);
  }

  // Game Spread — each player carries their own signed games handicap
  for (const o of markets['Game Spread'] || []) {
    const side = sideOf(o);
    if (side === 'home') out.spread_home = handicap(o);
    else if (side === 'away') out.spread_away = handicap(o);
  }

  // Total games (Over/Under share one line)
  for (const o of markets['Total'] || []) {
    const d = (o.description || '').toLowerCase();
    const line = handicap(o);
    if (line != null && out.over_under == null) out.over_under = line;
    if (d.startsWith('over'))  out.ou_over_odds  = american(o);
    if (d.startsWith('under')) out.ou_under_odds = american(o);
  }

  return out;
}

// Match a Bovada event to one of our tennis games by both players' last names.
function matchGame(ev, tennisGames) {
  const ml = (ev.displayGroups || [])
    .flatMap(dg => dg.markets || [])
    .find(m => m.description === 'Moneyline');
  const names = (ml?.outcomes || []).map(o => lastNameOf(o.description)).filter(Boolean);
  if (names.length < 2) return null;
  const nameSet = new Set(names);

  return tennisGames.find(g => {
    const h = lastNameOf(g.home_team);
    const a = lastNameOf(g.away_team);
    return h && a && nameSet.has(h) && nameSet.has(a);
  }) || null;
}

// ── Fetch + store tennis lines ────────────────────────────────────────────────
async function fetchTennisLines() {
  let groups;
  try {
    const r = await fetch(BOVADA_TENNIS_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) { console.warn(`[bovada] tennis fetch HTTP ${r.status}`); return 0; }
    groups = await r.json();
  } catch (err) {
    console.warn('[bovada] tennis fetch failed:', err.message);
    return 0;
  }
  if (!Array.isArray(groups)) return 0;

  const tennisGames = db.prepare(
    `SELECT espn_game_id, home_team, away_team FROM today_games WHERE sport IN ('ATP','WTA')`
  ).all();
  if (!tennisGames.length) return 0;

  const update = db.prepare(`
    UPDATE today_games SET
      ml_home       = COALESCE(?, ml_home),
      ml_away       = COALESCE(?, ml_away),
      spread_home   = COALESCE(?, spread_home),
      spread_away   = COALESCE(?, spread_away),
      over_under    = COALESCE(?, over_under),
      ou_over_odds  = COALESCE(?, ou_over_odds),
      ou_under_odds = COALESCE(?, ou_under_odds),
      odds_updated_at = datetime('now')
    WHERE espn_game_id = ? AND sport IN ('ATP','WTA')
  `);

  let updated = 0;
  for (const grp of groups) {
    for (const ev of grp.events || []) {
      const game = matchGame(ev, tennisGames);
      if (!game) continue;
      const markets = parseEvent(ev);
      if (!Object.keys(markets).length) continue;
      const v = orientLines(markets, game);
      // Skip if nothing usable came back
      if (v.spread_home == null && v.over_under == null && v.ml_home == null) continue;
      update.run(
        v.ml_home, v.ml_away,
        v.spread_home, v.spread_away,
        v.over_under, v.ou_over_odds, v.ou_under_odds,
        game.espn_game_id
      );
      updated++;
    }
  }

  if (updated > 0) console.log(`[bovada] tennis lines updated for ${updated} match(es)`);
  return updated;
}

module.exports = { fetchTennisLines };
