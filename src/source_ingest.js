// src/source_ingest.js
// Shared ingestion pipeline for wave-1 structured-data sources (Action Network,
// Polymarket wallets, Covers contests). Picks land in capper_history as
// result='pending' rows, graded later by results.js exactly like Discord picks.
// Under v3 (scoring_version='v3' + source_board_points='1') a PREGAME pick also
// lands on the board as a mention — same flat base + advocate resume + consensus
// mechanics as a Discord pick, with channel = the source name so the
// '@src:<source>' entity earns advocate points through its own graded record.
// No fiat baseline: a source's weight is exactly what its resume has earned.
//
// Rules enforced here (docs/CA_ALGORITHM_V3.md):
//  - Pregame timestamp: a pick counts only when the SOURCE's own timestamp is
//    before game start; anything in-game is recorded with live=1 provenance and
//    stays capper-record-only forever (never a board mention).
//  - Cross-source dedup (HARD RULE): the same canonical capper on the same slot
//    on the same day is ONE row. A duplicate arriving from a second system only
//    appends provenance to sources_json (and never a second board mention).

const db = require('./db');
const { resolveCapperName, ensureRegistered, savePick } = require('./storage');

// Multi-match resolver: a doubleheader (same two teams twice today) or a
// cross-sport city collision (Toronto/Miami/Dallas exist in 3+ leagues) makes
// the team-name match return several games. A source's pending pick is for the
// upcoming game, so prefer the nearest one that hasn't started; if every
// candidate has already started, the pick is genuinely ambiguous — return null
// and drop it rather than guess (a game-2 pick graded on game 1's final is
// exactly the corruption this blocks).
function resolveGameMatches(rows) {
  if (!rows || rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  const now = Date.now();
  const upcoming = rows
    .filter(g => {
      if (g.status === 'pre') return true;
      const start = gameStartMs(g);
      return start != null && start > now;
    })
    .sort((a, b) => (gameStartMs(a) || Infinity) - (gameStartMs(b) || Infinity));
  return upcoming.length ? upcoming[0] : null;
}

// Fuzzy today_games matcher by two team names (the proven odds_api.js pattern).
// sport (optional) constrains the match to one league — pass it whenever the
// caller knows it ('Tennis' blends ATP+WTA); without it a bare city pair can
// hit the wrong sport's game.
function findGameByTeams(teamA, teamB, sport) {
  const t1 = (teamA || '').toLowerCase();
  const t2 = (teamB || '').toLowerCase();
  if (!t1 || !t2) return null;
  const n1 = t1.split(' ').pop();
  const n2 = t2.split(' ').pop();
  try {
    let sql = `
      SELECT * FROM today_games
      WHERE (
        LOWER(home_team) LIKE '%' || ? || '%' OR LOWER(away_team) LIKE '%' || ? || '%'
        OR LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?
      ) AND (
        LOWER(home_team) LIKE '%' || ? || '%' OR LOWER(away_team) LIKE '%' || ? || '%'
        OR LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?
      )`;
    const params = [n1, n1, t1, t1, n2, n2, t2, t2];
    if (sport) {
      if (String(sport).toLowerCase() === 'tennis') sql += ` AND UPPER(sport) IN ('ATP','WTA')`;
      else { sql += ` AND UPPER(sport) = UPPER(?)`; params.push(sport); }
    }
    return resolveGameMatches(db.prepare(sql).all(...params));
  } catch (_) { return null; }
}

function findGameByAbbrs(abbrA, abbrB, sport) {
  const a = (abbrA || '').toLowerCase(), b = (abbrB || '').toLowerCase();
  if (!a || !b) return null;
  try {
    let sql = `
      SELECT * FROM today_games
      WHERE (LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?)
        AND (LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?)`;
    const params = [a, a, b, b];
    if (sport) {
      if (String(sport).toLowerCase() === 'tennis') sql += ` AND UPPER(sport) IN ('ATP','WTA')`;
      else { sql += ` AND UPPER(sport) = UPPER(?)`; params.push(sport); }
    }
    return resolveGameMatches(db.prepare(sql).all(...params));
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
  let historyId = null;
  try {
    const r = db.prepare(`
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
    historyId = r.lastInsertRowid;
  } catch (err) {
    console.warn(`[ingest:${source}] insert failed:`, err.message);
    return 'skipped:insert-error';
  }

  // Board mention (v3 only, pregame only, settings-gated). savePick runs the
  // full pipeline: slot match, mention count, v2+v3 scoring, leak, MVP/archive
  // gates. Dedup is double-walled: the capper_history check above (one push per
  // capper per slot) and updateSlot's message_id / author+channel checks.
  // Gates: source_board_points is the master switch; source_board_<source>
  // (e.g. source_board_polymarket) turns one system off on its own.
  if (!live
      && db.getSetting('scoring_version', 'v2') === 'v3'
      && db.getSetting('source_board_points', '1') === '1'
      && db.getSetting(`source_board_${source}`, '1') === '1') {
    try {
      savePick({
        team,
        // Board slot convention (lines.js): 'ML' uppercase, spread/over/under lowercase
        pick_type: pt === 'ml' ? 'ML' : pt,
        sport: game.sport ?? null,
        spread_value: pick.line ?? null,
        capper_name: canonical,
        espn_game_id: game.espn_game_id,
        game_date: gameDate,
        channel: source,
        is_home_team: isTotal ? 0 : (pick.side === 'home' ? 1 : 0),
        source_scope: source,
        raw_message: {
          id: `src:${source}:${historyId}`,
          author: canonical,
          content: `[${source}] ${canonical}: ${team} ${pt}${pick.line != null ? ' ' + pick.line : ''}${pick.odds != null ? ' @' + pick.odds : ''}`,
          createdAt: pick.postedAtMs || Date.now(),
        },
      });
    } catch (err) {
      console.warn(`[ingest:${source}] board mention failed:`, err.message);
    }
  }
  return 'inserted';
}

// American odds from a prediction-market price (0..1).
function americanFromPrice(p) {
  const x = parseFloat(p);
  if (!Number.isFinite(x) || x <= 0 || x >= 1) return null;
  return Math.round(x >= 0.5 ? (-100 * x) / (1 - x) : (100 * (1 - x)) / x);
}

module.exports = { recordSourcePick, findGameByTeams, findGameByAbbrs, sideOf, gameStartMs, americanFromPrice };
