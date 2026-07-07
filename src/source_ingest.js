// src/source_ingest.js
// Shared ingestion pipeline for wave-1 structured-data sources (Action Network,
// Polymarket wallets, Covers contests). Track-only: picks land in capper_history
// as result='pending' rows, graded later by results.js exactly like Discord picks.
// They never create board slots and never add score points in this phase.
//
// Rules enforced here (docs/CA_ALGORITHM_V3.md):
//  - Pregame timestamp: a pick counts only when the SOURCE's own timestamp is
//    before game start; anything in-game is recorded with live=1 provenance and
//    stays capper-record-only forever.
//  - Cross-source dedup (HARD RULE): the same canonical capper on the same slot
//    on the same day is ONE row. A duplicate arriving from a second system only
//    appends provenance to sources_json.

const db = require('./db');
const { resolveCapperName, ensureRegistered } = require('./storage');

// Fuzzy today_games matcher by two team names (the proven odds_api.js pattern).
function findGameByTeams(teamA, teamB) {
  const t1 = (teamA || '').toLowerCase();
  const t2 = (teamB || '').toLowerCase();
  if (!t1 || !t2) return null;
  const n1 = t1.split(' ').pop();
  const n2 = t2.split(' ').pop();
  try {
    return db.prepare(`
      SELECT * FROM today_games
      WHERE (
        LOWER(home_team) LIKE '%' || ? || '%' OR LOWER(away_team) LIKE '%' || ? || '%'
        OR LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?
      ) AND (
        LOWER(home_team) LIKE '%' || ? || '%' OR LOWER(away_team) LIKE '%' || ? || '%'
        OR LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?
      )
      LIMIT 1
    `).get(n1, n1, t1, t1, n2, n2, t2, t2);
  } catch (_) { return null; }
}

function findGameByAbbrs(abbrA, abbrB) {
  const a = (abbrA || '').toLowerCase(), b = (abbrB || '').toLowerCase();
  if (!a || !b) return null;
  try {
    return db.prepare(`
      SELECT * FROM today_games
      WHERE (LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?)
        AND (LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?)
      LIMIT 1
    `).get(a, a, b, b);
  } catch (_) { return null; }
}

// Which side of the game a picked name refers to. Returns 'home' | 'away' | null.
function sideOf(game, picked) {
  const p = (picked || '').toLowerCase().trim();
  if (!p) return null;
  const home = [game.home_team, game.home_short, game.home_name, game.home_abbr].filter(Boolean).map(s => s.toLowerCase());
  const away = [game.away_team, game.away_short, game.away_name, game.away_abbr].filter(Boolean).map(s => s.toLowerCase());
  if (home.some(n => n === p || n.includes(p) || p.includes(n))) return 'home';
  if (away.some(n => n === p || n.includes(p) || p.includes(n))) return 'away';
  return null;
}

function gameStartMs(game) {
  if (!game || !game.start_time) return null;
  const iso = game.start_time.includes('T') ? game.start_time : game.start_time.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

// ── Main entry ─────────────────────────────────────────────────────────────────
// pick: { source, capperName, handle, game (today_games row), pickType
//         ('ml'|'spread'|'over'|'under'), side ('home'|'away'|null for totals),
//         line (spread/total number), odds (American), postedAtMs, meta }
// Returns 'inserted' | 'duplicate' | 'skipped:<reason>'.
function recordSourcePick(pick) {
  const { source, game } = pick;
  if (!game || !game.espn_game_id) return 'skipped:no-game';
  const pt = (pick.pickType || '').toLowerCase();
  if (!['ml', 'spread', 'over', 'under'].includes(pt)) return 'skipped:unsupported-type';

  const isTotal = pt === 'over' || pt === 'under';
  if (!isTotal && !pick.side) return 'skipped:no-side';

  // Pregame rule: the SOURCE timestamp decides. In-game entries are still logged
  // (capper record only) but flagged live in provenance.
  const startMs = gameStartMs(game);
  const live = !!(startMs && pick.postedAtMs && pick.postedAtMs >= startMs);

  const team = isTotal ? game.home_team : (pick.side === 'home' ? game.home_team : game.away_team);
  const gameDate = (game.start_time || '').slice(0, 10) || null;

  // Canonical identity (registry-aware, source-scoped handles)
  const { name: canonical } = resolveCapperName(pick.capperName, source);
  ensureRegistered(canonical, source, pick.handle || pick.capperName);

  // Cross-source dedup: same canonical capper + same slot + same game = one row.
  try {
    const existing = db.prepare(`
      SELECT id, source, sources_json FROM capper_history
      WHERE capper_name = ? AND espn_game_id = ? AND LOWER(pick_type) = ?
        AND (LOWER(team) = LOWER(?) OR ? = 1)
      LIMIT 1
    `).get(canonical, game.espn_game_id, pt, team, isTotal ? 1 : 0);
    if (existing) {
      let sources = [];
      try { sources = JSON.parse(existing.sources_json || '[]'); } catch (_) {}
      if (!sources.some(s => s.source === source)) {
        sources.push({ source, at: new Date().toISOString(), live });
        db.prepare(`UPDATE capper_history SET sources_json = ? WHERE id = ?`).run(JSON.stringify(sources), existing.id);
      }
      return 'duplicate';
    }
  } catch (_) {}

  const provenance = JSON.stringify([{ source, at: new Date().toISOString(), live, meta: pick.meta || null }]);
  try {
    db.prepare(`
      INSERT INTO capper_history
        (capper_name, sport, pick_type, team, spread, espn_game_id, game_date,
         channel, score, result, pick_id, odds, source, is_home_team, sources_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?, ?, ?)
    `).run(
      canonical,
      game.sport ?? null,
      pt,
      team,
      pick.line ?? null,
      game.espn_game_id,
      gameDate,
      source,
      pick.odds ?? null,
      source,
      isTotal ? 0 : (pick.side === 'home' ? 1 : 0),
      provenance
    );
    return 'inserted';
  } catch (err) {
    console.warn(`[ingest:${source}] insert failed:`, err.message);
    return 'skipped:insert-error';
  }
}

// American odds from a prediction-market price (0..1).
function americanFromPrice(p) {
  const x = parseFloat(p);
  if (!Number.isFinite(x) || x <= 0 || x >= 1) return null;
  return Math.round(x >= 0.5 ? (-100 * x) / (1 - x) : (100 * (1 - x)) / x);
}

module.exports = { recordSourcePick, findGameByTeams, findGameByAbbrs, sideOf, gameStartMs, americanFromPrice };
