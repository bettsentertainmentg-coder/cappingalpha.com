// src/mvp_snapshot.js
// Permanent detail snapshot for MVP games. The daily wipe clears today_games and
// every cached enrichment table, so once a game is gone its public-betting %,
// line movement, and prediction-market reads are lost. For MVP picks (which we
// track forever) we freeze that free-but-perishable data at game start.
//
// We deliberately DON'T snapshot anything we can re-fetch live for free — ESPN
// status, scores, box, stats are pulled fresh when the historical page renders.

const db = require('./db');
const { getPublicBettingForGame } = require('./public_betting');
const { getLineHistoryForGame }   = require('./line_history');
const { getPolymarketForGame }    = require('./polymarket');
const { getKalshiForGame }        = require('./kalshi');
const { getLinesForGame }         = require('./lines_scraper');
const { getLineInsights }         = require('./insights');
const { getPickTimeline }         = require('./pick_timeline');
const { MVP_THRESHOLD }           = require('./scoring');

const j = (v) => { try { return JSON.stringify(v ?? null); } catch (_) { return 'null'; } };
const p = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };

// Capture (or refresh) the snapshot for one game. Reads everything that's about
// to be wiped and stores it as JSON. Idempotent — safe to call repeatedly.
function captureSnapshot(espnGameId) {
  const game = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(espnGameId);
  if (!game) return false;

  const picks = db.prepare(`
    SELECT * FROM picks WHERE espn_game_id = ? AND mention_count > 0 ORDER BY score DESC
  `).all(espnGameId);
  for (const pk of picks) {
    try { pk.timeline = getPickTimeline(pk.id); } catch (_) { pk.timeline = []; }
  }

  let publicBetting = null, lineHistory = null, polymarket = null,
      kalshi = null, lines = null, insights = null;
  try { publicBetting = getPublicBettingForGame(espnGameId); } catch (_) {}
  try { lineHistory   = getLineHistoryForGame(espnGameId);   } catch (_) {}
  try { polymarket    = getPolymarketForGame(espnGameId);    } catch (_) {}
  try { kalshi        = getKalshiForGame(espnGameId);        } catch (_) {}
  try { lines         = getLinesForGame(espnGameId);         } catch (_) {}
  try { insights      = getLineInsights(espnGameId, game);   } catch (_) {}

  db.prepare(`
    INSERT INTO mvp_detail_snapshots
      (espn_game_id, captured_at, game_json, picks_json, public_betting, line_history, polymarket, kalshi, lines, insights)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(espn_game_id) DO UPDATE SET
      captured_at    = excluded.captured_at,
      game_json      = excluded.game_json,
      picks_json     = excluded.picks_json,
      public_betting = excluded.public_betting,
      line_history   = excluded.line_history,
      polymarket     = excluded.polymarket,
      kalshi         = excluded.kalshi,
      lines          = excluded.lines,
      insights       = excluded.insights
  `).run(espnGameId, j(game), j(picks), j(publicBetting), j(lineHistory), j(polymarket), j(kalshi), j(lines), j(insights));

  return true;
}

// Snapshot any game that has started and carries an MVP-level pick but hasn't
// been captured yet. Called from the live cron — at first detection of a started
// game the enrichment caches still hold the final pre-game values (the market
// syncs stop at status 'pre'), which is exactly what we want to preserve.
function snapshotStartedMvpGames(threshold = MVP_THRESHOLD) {
  const rows = db.prepare(`
    SELECT DISTINCT tg.espn_game_id
    FROM today_games tg
    JOIN picks pk ON pk.espn_game_id = tg.espn_game_id
    WHERE tg.status IN ('in', 'post')
      AND pk.mention_count > 0
      AND pk.score >= ?
      AND NOT EXISTS (SELECT 1 FROM mvp_detail_snapshots s WHERE s.espn_game_id = tg.espn_game_id)
  `).all(threshold);

  let n = 0;
  for (const r of rows) { if (captureSnapshot(r.espn_game_id)) n++; }
  if (n) console.log(`[mvp_snapshot] captured ${n} MVP game snapshot(s)`);
  return n;
}

// Read a snapshot back, parsed. Returns null if none exists.
function getSnapshot(espnGameId) {
  const row = db.prepare(`SELECT * FROM mvp_detail_snapshots WHERE espn_game_id = ?`).get(espnGameId);
  if (!row) return null;
  return {
    capturedAt:    row.captured_at,
    game:          p(row.game_json),
    picks:         p(row.picks_json) || [],
    publicBetting: p(row.public_betting),
    lineHistory:   p(row.line_history),
    polymarket:    p(row.polymarket),
    kalshi:        p(row.kalshi),
    lines:         p(row.lines),
    insights:      p(row.insights),
  };
}

function hasSnapshot(espnGameId) {
  return !!db.prepare(`SELECT 1 FROM mvp_detail_snapshots WHERE espn_game_id = ?`).get(espnGameId);
}

module.exports = { captureSnapshot, snapshotStartedMvpGames, getSnapshot, hasSnapshot };
