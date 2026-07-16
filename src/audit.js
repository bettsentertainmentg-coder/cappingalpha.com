// src/audit.js — the grading rule book, enforced (Jack 2026-07-16: "it should
// be a set of relatively simple rules"; he should never have to catch a wrong
// grade on his phone again).
//
// THE RULES it verifies, every 5 minutes, on every graded surface:
//   R1 one game = ONE line per market (display == the captured/locked line)
//   R2 one game = ONE tracked bet per dimension (margin / total)
//   R3 a graded result must equal what the final score + locked line imply
//   R4 a finished game must not leave board picks ungraded for long
//
// FLAG ONLY — this module never mutates picks, results, or history. Each
// violation is stored in audit_flags WITH A FULL ROW SNAPSHOT (detail_json),
// because the daily wipe destroys board rows before a human can autopsy them
// (the Jul 15 "Storm +3.5 rendered green" report died exactly that way).
// audit_flags is never wiped. A flag that stops reproducing is marked
// resolved, not deleted.
//
// Read via GET /admin/api/audit.json (header-auth, admin.js). Runs from the
// tail of results.resolveResults() — the moment grades land is the moment
// they get checked.

const db = require('./db');

const _upsertFlag = db.prepare(`
  INSERT INTO audit_flags (kind, ref_table, ref_id, espn_game_id, summary, detail_json, first_seen, last_seen, resolved)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)
  ON CONFLICT(kind, ref_table, ref_id) DO UPDATE SET
    summary = excluded.summary, detail_json = excluded.detail_json,
    last_seen = datetime('now'), resolved = 0
`);

// Anything currently open that this pass did NOT re-observe gets closed.
function _closeStale(seenKeys) {
  const open = db.prepare(`SELECT id, kind, ref_table, ref_id FROM audit_flags WHERE resolved = 0`).all();
  const close = db.prepare(`UPDATE audit_flags SET resolved = 1, last_seen = datetime('now') WHERE id = ?`);
  for (const f of open) {
    if (!seenKeys.has(`${f.kind}|${f.ref_table}|${f.ref_id}`)) close.run(f.id);
  }
}

const _isTotal  = t => ['over', 'under'].includes((t || '').toLowerCase());
const _isMargin = t => ['ml', 'spread'].includes((t || '').toLowerCase());
// Mirrors mvp.js conflict math (kept tiny on purpose).
const _hasIntBetween = (lo, hi) => (Math.floor(lo) + 1) <= (Math.ceil(hi) - 1);

function _flag(out, kind, table, id, gid, summary, row) {
  out.push({ kind, ref_table: table, ref_id: id, espn_game_id: gid ?? null, summary, detail: row });
}

// R3 for a row whose game data we can reconstruct. Skips (returns null) when
// the recompute can't be trusted: pending/void, missing scores, or a side pick
// whose team string matches neither side (name drift would false-flag).
function _recheckResult(evaluatePick, row, game) {
  const res = (row.result || '').toLowerCase();
  if (!['win', 'loss', 'push'].includes(res)) return null;
  if (game.home_score == null || game.away_score == null) return null;
  const t = (row.pick_type || '').toLowerCase();
  if (!_isTotal(t)) {
    const team = (row.team || '').toLowerCase();
    const names = [game.home_team, game.away_team, game.home_short, game.away_short,
                   game.home_name, game.away_name, game.home_abbr, game.away_abbr]
      .filter(Boolean).map(s => s.toLowerCase());
    if (!names.includes(team)) return null;
  }
  const fresh = evaluatePick(row, game);
  if (fresh === 'pending' || fresh === 'void') return null; // incomplete data — not a verdict
  return fresh === res ? 'ok' : fresh;
}

function runGradingAudit() {
  const { evaluatePick } = require('./results'); // lazy — results.js requires us back
  const found = [];

  // ── R3: today's graded board picks vs a fresh recompute ────────────────────
  try {
    const rows = db.prepare(`
      SELECT p.*, tg.home_score, tg.away_score, tg.status, tg.sport,
             tg.home_team, tg.home_short, tg.home_name, tg.home_abbr,
             tg.away_team, tg.away_short, tg.away_name, tg.away_abbr,
             tg.first_inning_runs, tg.tennis_home_games, tg.tennis_away_games, tg.tennis_score_detail
      FROM picks p JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
      WHERE tg.status = 'post' AND p.result IN ('win','loss','push') AND p.mention_count > 0
    `).all();
    for (const r of rows) {
      const fresh = _recheckResult(evaluatePick, r, r);
      if (fresh && fresh !== 'ok') {
        _flag(found, 'result_mismatch', 'picks', r.id, r.espn_game_id,
          `${r.team} ${r.pick_type} ${r.spread ?? ''} graded ${r.result} but final ${r.away_score}-${r.home_score} implies ${fresh}`, r);
      }
    }
  } catch (_) {}

  // ── R3: recent tracked (mvp) rows vs their stored finals ───────────────────
  try {
    const cutoff = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT * FROM mvp_picks
      WHERE game_date >= ? AND result IN ('win','loss','push') AND espn_game_id IS NOT NULL
    `).all(cutoff);
    for (const m of rows) {
      const game = {
        status: 'post', sport: m.sport,
        home_team: m.home_team, away_team: m.away_team,
        home_score: m.home_score, away_score: m.away_score,
      };
      const fresh = _recheckResult(evaluatePick, m, game);
      if (fresh && fresh !== 'ok') {
        _flag(found, 'result_mismatch', 'mvp_picks', m.id, m.espn_game_id,
          `${m.team} ${m.pick_type} ${m.spread ?? ''} graded ${m.result} but stored final ${m.away_score}-${m.home_score} implies ${fresh}`, m);
      }
    }
  } catch (_) {}

  // ── R1: tracked display line must equal the locked capture ─────────────────
  try {
    const rows = db.prepare(`
      SELECT * FROM mvp_picks
      WHERE result != 'void' AND (
        (LOWER(pick_type) IN ('over','under') AND captured_total  IS NOT NULL AND spread IS NOT captured_total) OR
        (LOWER(pick_type) =  'spread'         AND captured_spread IS NOT NULL AND spread IS NOT captured_spread)
      )
    `).all();
    for (const m of rows) {
      _flag(found, 'line_drift', 'mvp_picks', m.id, m.espn_game_id,
        `${m.team} ${m.pick_type} displays ${m.spread} but locked line is ${m.captured_total ?? m.captured_spread}`, m);
    }
  } catch (_) {}

  // ── R2: one tracked bet per game per dimension ──────────────────────────────
  try {
    const games = db.prepare(`
      SELECT espn_game_id FROM mvp_picks
      WHERE espn_game_id IS NOT NULL AND result != 'void'
      GROUP BY espn_game_id HAVING COUNT(*) > 1
    `).all();
    for (const { espn_game_id } of games) {
      const rows = db.prepare(`
        SELECT * FROM mvp_picks WHERE espn_game_id = ? AND result != 'void'
      `).all(espn_game_id);
      const totals = rows.filter(r => _isTotal(r.pick_type));
      const hasOver = totals.some(r => (r.pick_type || '').toLowerCase() === 'over');
      const hasUnder = totals.some(r => (r.pick_type || '').toLowerCase() === 'under');
      // Lines are synced now, so over+under coexisting on one game is a
      // violation regardless of the middle math (one game, one CA total line).
      if (hasOver && hasUnder) {
        _flag(found, 'dimension_dupe', 'mvp_picks_game', espn_game_id, espn_game_id,
          `both total sides tracked: ${totals.map(t => `${t.pick_type} ${t.spread} (#${t.id}, ${t.result})`).join(' vs ')}`, totals);
      }
      const margins = rows.filter(r => _isMargin(r.pick_type));
      for (let i = 0; i < margins.length; i++) {
        for (let j = i + 1; j < margins.length; j++) {
          const a = margins[i], b = margins[j];
          if ((a.team || '').toLowerCase() === (b.team || '').toLowerCase()) continue;
          const la = (a.pick_type || '').toLowerCase() === 'ml' ? 0 : (Number(a.spread) || 0);
          const lb = (b.pick_type || '').toLowerCase() === 'ml' ? 0 : (Number(b.spread) || 0);
          if (!_hasIntBetween(-la, lb)) {
            _flag(found, 'dimension_dupe', 'mvp_picks_pair', `${a.id}-${b.id}`, espn_game_id,
              `conflicting margin bets tracked: ${a.team} ${a.pick_type} ${a.spread} (#${a.id}) vs ${b.team} ${b.pick_type} ${b.spread} (#${b.id})`, [a, b]);
          }
        }
      }
    }
  } catch (_) {}

  // ── R4: finished game with board picks still ungraded 90+ min later ────────
  try {
    const rows = db.prepare(`
      SELECT p.id, p.team, p.pick_type, p.spread, p.espn_game_id, p.result,
             tg.actual_end_at, tg.away_score, tg.home_score
      FROM picks p JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
      WHERE tg.status = 'post' AND p.mention_count > 0 AND p.result = 'pending'
        AND tg.actual_end_at IS NOT NULL
        AND tg.actual_end_at < datetime('now', '-90 minutes')
    `).all();
    for (const r of rows) {
      _flag(found, 'stale_pending', 'picks', r.id, r.espn_game_id,
        `${r.team} ${r.pick_type} ${r.spread ?? ''} still ungraded 90+ min after final ${r.away_score}-${r.home_score}`, r);
    }
  } catch (_) {}

  // ── Persist ─────────────────────────────────────────────────────────────────
  const seen = new Set();
  for (const f of found) {
    try {
      _upsertFlag.run(f.kind, f.ref_table, String(f.ref_id), f.espn_game_id,
        f.summary, JSON.stringify(f.detail));
      seen.add(`${f.kind}|${f.ref_table}|${f.ref_id}`);
    } catch (_) {}
  }
  try { _closeStale(seen); } catch (_) {}

  if (found.length) {
    console.error(`[audit] ${found.length} GRADING RULE VIOLATION(S):`);
    for (const f of found) console.error(`[audit]   ${f.kind} ${f.ref_table}#${f.ref_id}: ${f.summary}`);
  }
  return found.length;
}

function getAuditFlags({ includeResolved = false } = {}) {
  return db.prepare(`
    SELECT * FROM audit_flags ${includeResolved ? '' : 'WHERE resolved = 0'}
    ORDER BY last_seen DESC LIMIT 200
  `).all();
}

module.exports = { runGradingAudit, getAuditFlags };
