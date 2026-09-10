// src/tennis_regrade.js
// Repair pass for tennis grades minted off a match that never played out.
//
// Before 2026-07-30, results.js counted sets with its own naive
// `if (home > away) homeSetsWon++`, so a retirement mid-set came back as a
// finished match: Darderi retired trailing 0-3 in set one of ATP 178921 and his
// tracked gold ML graded a LOSS. Anything graded through that path is suspect,
// including rows where the phantom set was ADDED to a real one (a retirement at
// 6-4, 3-0 read as a legitimate 2-0 win).
//
// This module re-derives the truth from ESPN and settles every affected row
// through results.evaluatePick / evaluateVote — the SAME functions live grading
// uses, now carrying the R8 early-end rule. There is deliberately no second
// copy of the grading logic here; this file only supplies corrected inputs.
//
// Re-runnable and idempotent: it only writes rows whose correct result differs
// from what is stored, so a second run reports zero changes.

const axios = require('axios');
const db    = require('./db');
const { countSets } = require('./tennis_score');
const { evaluatePick, evaluateVote, VOID_RETIRED_NOTE } = require('./results');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const TOUR_PATH = { ATP: 'tennis/atp', WTA: 'tennis/wta' };

// ── ESPN scoreboard cache, keyed by tour+date ────────────────────────────────
// One fetch covers every match on that day's board, so a few hundred rows cost
// a few dozen free calls instead of one per row.
const _boards = new Map();

async function loadBoard(path, ymd) {
  const key = `${path}|${ymd}`;
  if (_boards.has(key)) return _boards.get(key);
  let events = [];
  try {
    const resp = await axios.get(`${ESPN_BASE}/${path}/scoreboard?dates=${ymd}`, { timeout: 12000 });
    events = resp.data?.events || [];
  } catch (err) {
    console.warn(`[tennis_regrade] scoreboard ${path} ${ymd} failed: ${err.message}`);
  }
  _boards.set(key, events);
  return events;
}

function ymdShift(dateStr, offsetDays) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Find one match on a tour board and normalize it into the shape evaluatePick
// expects from a today_games row. Tennis start times drift across the date line,
// so probe the stamped day and its neighbours (same rule as results.js).
async function fetchMatchTruth(espnGameId, sport, gameDate) {
  const path = TOUR_PATH[(sport || '').toUpperCase()];
  if (!path) return null;

  const days = [ymdShift(gameDate, 0), ymdShift(gameDate, -1), ymdShift(gameDate, 1)].filter(Boolean);
  for (const ymd of days) {
    for (const ev of await loadBoard(path, ymd)) {
      const groupings = ev.groupings || [{ competitions: ev.competitions || [] }];
      for (const g of groupings) {
        for (const comp of (g.competitions || [])) {
          if (String(comp.id) !== String(espnGameId)) continue;

          const st        = comp.status?.type || {};
          const completed = st.completed === true;
          const stateName = (st.state || '').toLowerCase();
          const statusNm  = (st.name || st.description || '');
          // Postponed / suspended / canceled never settle anything. Leave those
          // rows exactly as they are; they are a different repair (unplayed games).
          if (/postpone|suspend|cancel|delay|rain|abandon/i.test(statusNm)) return null;
          if (!completed && stateName !== 'post') return null;

          const home = comp.competitors?.find(c => c.homeAway === 'home') || comp.competitors?.[0];
          const away = comp.competitors?.find(c => c.homeAway === 'away') || comp.competitors?.[1];
          if (!home || !away) return null;

          const { homeSetsWon, awaySetsWon, setDetails, homeGames, awayGames, numSets } =
            countSets(home.linescores || [], away.linescores || []);

          const homeName = home.athlete?.displayName || home.athlete?.fullName || '';
          const awayName = away.athlete?.displayName || away.athlete?.fullName || '';
          const lastOf   = n => (n || '').trim().split(/\s+/).pop() || null;

          return {
            espn_game_id:        String(comp.id),
            sport:               (sport || '').toUpperCase(),
            status:              'post',
            status_detail:       statusNm || null,
            home_score:          homeSetsWon,
            away_score:          awaySetsWon,
            home_team:           homeName,
            home_short:          lastOf(homeName),
            home_name:           lastOf(homeName),
            home_abbr:           (lastOf(homeName) || '').slice(0, 3).toUpperCase() || null,
            away_team:           awayName,
            away_short:          lastOf(awayName),
            away_name:           lastOf(awayName),
            away_abbr:           (lastOf(awayName) || '').slice(0, 3).toUpperCase() || null,
            tennis_home_games:   homeGames || null,
            tennis_away_games:   awayGames || null,
            tennis_score_detail: numSets > 0 ? JSON.stringify(setDetails) : null,
          };
        }
      }
    }
  }
  return null;
}

// Every tennis game that carries at least one settled row anywhere.
function candidateGames(since) {
  return db.prepare(`
    SELECT espn_game_id, sport, MIN(game_date) AS game_date FROM (
      SELECT espn_game_id, sport, game_date FROM mvp_picks
        WHERE sport IN ('ATP','WTA') AND result IN ('win','loss','push') AND espn_game_id IS NOT NULL AND game_date >= ?
      UNION ALL
      SELECT espn_game_id, sport, game_date FROM pick_history
        WHERE sport IN ('ATP','WTA') AND result IN ('win','loss','push') AND espn_game_id IS NOT NULL AND game_date >= ?
      UNION ALL
      SELECT espn_game_id, sport, game_date FROM capper_history
        WHERE sport IN ('ATP','WTA') AND result IN ('win','loss','push') AND espn_game_id IS NOT NULL AND game_date >= ?
      UNION ALL
      SELECT espn_game_id, sport, DATE(voted_at) AS game_date FROM game_votes
        WHERE sport IN ('ATP','WTA') AND result IN ('win','loss','push') AND espn_game_id IS NOT NULL AND DATE(voted_at) >= ?
    )
    GROUP BY espn_game_id, sport
    ORDER BY game_date DESC
  `).all(since, since, since, since);
}

// A settled row is "wrong" only when the corrected verdict differs. `pending`
// from the evaluator means it could not decide, which is never a reason to
// overwrite an existing grade.
function verdictFor(row, truth) {
  const result = evaluatePick(row, { ...truth, sport: truth.sport || row.sport });
  if (!result || result === 'pending') return null;
  return result === row.result ? null : result;
}

async function regradeTennis({ since = '2026-07-09', dryRun = true, gameIds = null, maxGames = 400 } = {}) {
  const started = new Date().toISOString();
  let games = candidateGames(since);
  if (Array.isArray(gameIds) && gameIds.length) {
    const want = new Set(gameIds.map(String));
    games = games.filter(g => want.has(String(g.espn_game_id)));
  }
  const truncated = games.length > maxGames;
  if (truncated) games = games.slice(0, maxGames);

  const changes = [];       // every row whose result changes
  const gamesChecked = [];  // per-game audit trail
  let unresolved = 0;

  for (const g of games) {
    const truth = await fetchMatchTruth(g.espn_game_id, g.sport, g.game_date);
    if (!truth) { unresolved++; continue; }

    const endedEarly = Math.max(truth.home_score, truth.away_score) < 2
                    || /retire|walk.?over|default|withdraw|conced/i.test(truth.status_detail || '');
    let touched = 0;

    // ── mvp_picks (the tracked-bet ledger) ──────────────────────────────────
    // Scores are re-synced even when the verdict does not move. A row can hold a
    // correct result beside a stale set score (the grade landed on one payload,
    // the score column was refreshed from another) — that mismatch is exactly
    // what put "LOSS" next to "FINAL 0-0" on Jack's phone, and audit R8b keeps
    // flagging it until the printed number matches the graded one.
    for (const row of db.prepare(
      `SELECT * FROM mvp_picks WHERE espn_game_id = ? AND result IN ('win','loss','push')`
    ).all(g.espn_game_id)) {
      const next       = verdictFor(row, truth);
      const scoreStale = row.home_score !== truth.home_score || row.away_score !== truth.away_score;
      if (!next && !scoreStale) continue;
      const result = next || row.result;
      changes.push({ table: 'mvp_picks', id: row.id, team: row.team, pick_type: row.pick_type,
                     game_date: row.game_date, from: row.result, to: result,
                     was_score: `${row.away_score}-${row.home_score}`,
                     now_score: `${truth.away_score}-${truth.home_score}`,
                     kind: next ? 'result' : 'score_only' });
      touched++;
      if (!dryRun) {
        db.prepare(`
          UPDATE mvp_picks
          SET result = ?, home_score = ?, away_score = ?,
              annotation = CASE
                WHEN ? != 'void' THEN annotation
                WHEN annotation IS NULL OR annotation = '' THEN ?
                WHEN annotation LIKE '%not counted%' THEN annotation
                ELSE annotation || ' | ' || ?
              END
          WHERE id = ?
        `).run(result, truth.home_score, truth.away_score, result, VOID_RETIRED_NOTE, VOID_RETIRED_NOTE, row.id);
      }
    }

    // ── pick_history (permanent archive) ────────────────────────────────────
    for (const row of db.prepare(
      `SELECT * FROM pick_history WHERE espn_game_id = ? AND result IN ('win','loss','push')`
    ).all(g.espn_game_id)) {
      const next       = verdictFor(row, truth);
      const scoreStale = row.home_score !== truth.home_score || row.away_score !== truth.away_score;
      if (!next && !scoreStale) continue;
      const result = next || row.result;
      changes.push({ table: 'pick_history', id: row.id, team: row.team, pick_type: row.pick_type,
                     game_date: row.game_date, from: row.result, to: result,
                     kind: next ? 'result' : 'score_only' });
      touched++;
      if (!dryRun) {
        db.prepare(`UPDATE pick_history SET result = ?, home_score = ?, away_score = ? WHERE id = ?`)
          .run(result, truth.home_score, truth.away_score, row.id);
      }
    }

    // ── capper_history (each capper's own ledger, their own quoted line) ────
    for (const row of db.prepare(
      `SELECT * FROM capper_history WHERE espn_game_id = ? AND result IN ('win','loss','push')`
    ).all(g.espn_game_id)) {
      const next = verdictFor(row, truth);
      if (!next) continue;
      changes.push({ table: 'capper_history', id: row.id, capper: row.capper_name, team: row.team,
                     pick_type: row.pick_type, game_date: row.game_date, from: row.result, to: next });
      touched++;
      if (!dryRun) db.prepare(`UPDATE capper_history SET result = ? WHERE id = ?`).run(next, row.id);
    }

    // ── picks (only present for the current cycle, pre-wipe) ────────────────
    for (const row of db.prepare(
      `SELECT * FROM picks WHERE espn_game_id = ? AND result IN ('win','loss','push')`
    ).all(g.espn_game_id)) {
      const next = verdictFor(row, truth);
      if (!next) continue;
      changes.push({ table: 'picks', id: row.id, team: row.team, pick_type: row.pick_type,
                     from: row.result, to: next });
      touched++;
      if (!dryRun) db.prepare(`UPDATE picks SET result = ? WHERE id = ?`).run(next, row.id);
    }

    // ── game_votes (members' own picks) ─────────────────────────────────────
    for (const row of db.prepare(
      `SELECT * FROM game_votes WHERE espn_game_id = ? AND result IN ('win','loss','push')`
    ).all(g.espn_game_id)) {
      const line = ['over', 'under'].includes(row.pick_slot) ? row.spread
                 : row.pick_slot.endsWith('_spread')          ? row.spread
                 : null;
      const next = evaluateVote(row.pick_slot, line, truth);
      if (!next || next === 'pending' || next === row.result) continue;
      changes.push({ table: 'game_votes', id: row.id, user_id: row.user_id, slot: row.pick_slot,
                     from: row.result, to: next });
      touched++;
      if (!dryRun) db.prepare(`UPDATE game_votes SET result = ? WHERE id = ?`).run(next, row.id);
    }

    // ── today_games: heal the live board row so the page stops showing a
    // corrected grade next to the stale score that produced it.
    if (!dryRun) {
      db.prepare(`
        UPDATE today_games
        SET home_score = ?, away_score = ?, status_detail = COALESCE(?, status_detail),
            tennis_home_games = COALESCE(?, tennis_home_games),
            tennis_away_games = COALESCE(?, tennis_away_games),
            tennis_score_detail = COALESCE(?, tennis_score_detail)
        WHERE espn_game_id = ?
      `).run(truth.home_score, truth.away_score, truth.status_detail,
             truth.tennis_home_games, truth.tennis_away_games, truth.tennis_score_detail,
             g.espn_game_id);
    }

    gamesChecked.push({
      espn_game_id: g.espn_game_id, sport: g.sport, game_date: g.game_date,
      matchup: `${truth.away_team} at ${truth.home_team}`,
      sets: `${truth.away_score}-${truth.home_score}`,
      status: truth.status_detail, ended_early: endedEarly, rows_changed: touched,
    });
  }

  return {
    started, since, dry_run: dryRun,
    games_examined: gamesChecked.length,
    games_unresolved: unresolved,
    truncated,
    rows_changed: changes.length,
    results_changed: changes.filter(c => c.kind !== 'score_only').length,
    scores_only_fixed: changes.filter(c => c.kind === 'score_only').length,
    ended_early_games: gamesChecked.filter(g => g.ended_early),
    changes,
  };
}

module.exports = { regradeTennis, fetchMatchTruth };
