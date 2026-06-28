// src/implied_lines.js — derive a usable betting line from our FREE prediction-market
// caches (Polymarket, then Kalshi) for games that have no sportsbook line (e.g. a lot of
// tennis). Win-probabilities -> American odds. Used by /api/game/:id (display) and the
// vote endpoint (so a side tracked off this line is locked + graded at that number).
//
// Separate from the capper scoring pipeline; reads only the cached market tables.

const db = require('./db');

// Win probability -> American moneyline. 0.71 -> -245, 0.29 -> +245.
function probToAmerican(p) {
  const x = Number(p);
  if (!Number.isFinite(x) || x <= 0 || x >= 1) return null;
  return x >= 0.5 ? Math.round(-(x / (1 - x)) * 100) : Math.round(((1 - x) / x) * 100);
}

function parseMarkets(row) {
  if (!row || !row.markets_json) return null;
  try { return JSON.parse(row.markets_json); } catch (_) { return null; }
}

// Returns an odds object shaped like the today_games odds columns (so callers can drop it
// straight in), plus a `source` tag, or null if no market is cached for the game.
// Polymarket is preferred (usually deeper volume); Kalshi is the fallback.
function impliedLineForGame(espn_game_id) {
  if (!espn_game_id) return null;
  let m = parseMarkets(db.prepare(`SELECT markets_json FROM polymarket_cache WHERE espn_game_id = ?`).get(espn_game_id));
  let source = m ? 'polymarket' : null;
  if (!m) {
    m = parseMarkets(db.prepare(`SELECT markets_json FROM kalshi_cache WHERE espn_game_id = ?`).get(espn_game_id));
    source = m ? 'kalshi' : null;
  }
  if (!m) return null;

  const ml  = m.moneyline || {};
  const sp  = m.spread    || {};
  const tot = m.total     || {};
  const out = {
    source,
    ml_home: probToAmerican(ml.home_prob),
    ml_away: probToAmerican(ml.away_prob),
    spread_home: sp.line != null ? Number(sp.line) : null,
    spread_away: sp.line != null ? -Number(sp.line) : null,
    over_under: tot.line != null ? Number(tot.line) : null,
    ou_over_odds:  probToAmerican(tot.over_prob),
    ou_under_odds: probToAmerican(tot.under_prob),
  };
  // Nothing usable derived -> treat as no line.
  if (out.ml_home == null && out.ml_away == null && out.over_under == null && out.spread_home == null) return null;
  return out;
}

module.exports = { impliedLineForGame, probToAmerican };
