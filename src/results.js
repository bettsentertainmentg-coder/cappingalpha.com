// src/results.js
// Evaluates win/loss/push for picks whose games have finished.
// Reads final scores from today_games, locked lines from line_snapshots.
// Writes result to picks.result and mvp_picks.result.

const db    = require('./db');
const axios = require('axios');

const OLLAMA_URL   = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'qwen2.5:7b';

// ── Ask Ollama to extract a spread line from a raw message ────────────────────
// Used only when Odds API didn't return a spread for this game.
async function extractSpreadFromMessage(team, pickId) {
  const msgs = db.prepare(
    `SELECT message_text FROM raw_messages WHERE pick_id = ? ORDER BY id ASC LIMIT 5`
  ).all(pickId);
  if (!msgs.length) return null;

  const text = msgs.map(m => m.message_text).join('\n---\n');
  const prompt =
    `You are extracting a sports betting spread line from a message.\n` +
    `Team: ${team}\n` +
    `Extract ONLY the point spread number for this team (e.g. -1.5, +3, -6.5).\n` +
    `Reply with a JSON object like: {"spread": -1.5}\n` +
    `If no spread is mentioned, reply: {"spread": null}\n` +
    `Message:\n${text}`;

  try {
    const res = await axios.post(OLLAMA_URL, {
      model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0.0 },
    }, { timeout: 10000 });

    const raw = (res.data?.response || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(raw);
    const val = parseFloat(parsed?.spread);
    if (!isNaN(val)) {
      console.log(`[results] Ollama extracted spread ${val} for pick ${pickId} (${team})`);
      return val;
    }
  } catch (err) {
    console.warn('[results] Ollama spread extraction failed:', err.message);
  }
  return null;
}

// ── Evaluate a single pick against final scores ───────────────────────────────
function evaluatePick(pick, game) {
  const type = (pick.pick_type || '').toLowerCase();

  // Determine which side was picked
  const homeNames = [game.home_team, game.home_short, game.home_name, game.home_abbr]
    .filter(Boolean).map(n => n.toLowerCase());
  const pickedHome = homeNames.some(n => n === (pick.team || '').toLowerCase());

  const pickedScore = pickedHome ? game.home_score : game.away_score;
  const oppScore    = pickedHome ? game.away_score  : game.home_score;
  const margin      = pickedScore - oppScore;
  const total       = game.home_score + game.away_score;

  // Get locked line
  const snapshot = pick.espn_game_id ? db.prepare(`
    SELECT original_spread, original_ml, original_ou
    FROM line_snapshots WHERE game_id = ? AND LOWER(team) = LOWER(?)
  `).get(pick.espn_game_id, pick.team) : null;

  if (type === 'ml') {
    if (margin > 0) return 'win';
    if (margin < 0) return 'loss';
    return 'push';
  }

  if (type === 'spread') {
    const line = snapshot?.original_spread ?? pick.spread;
    if (line == null) return 'pending';
    const covered = margin + line; // e.g. margin=7, line=-6.5 → 0.5 > 0 = win
    if (covered > 0) return 'win';
    if (covered < 0) return 'loss';
    return 'push';
  }

  if (type === 'over') {
    const ou = snapshot?.original_ou ?? pick.spread;
    if (ou == null) return 'pending';
    if (total > ou) return 'win';
    if (total < ou) return 'loss';
    return 'push';
  }

  if (type === 'under') {
    const ou = snapshot?.original_ou ?? pick.spread;
    if (ou == null) return 'pending';
    if (total < ou) return 'win';
    if (total > ou) return 'loss';
    return 'push';
  }

  if (type === 'nrfi') {
    // Needs first_inning_runs snapshot — only set once inning 2 begins
    if (game.first_inning_runs == null) return 'pending';
    return game.first_inning_runs === 0 ? 'win' : 'loss';
  }

  return 'pending';
}

// ── Fetch final score for a stale game directly from ESPN API ─────────────────
async function fetchGameResult(espnGameId, sport) {
  const sportMap = {
    MLB:   'baseball/mlb',
    NBA:   'basketball/nba',
    NHL:   'hockey/nhl',
    NFL:   'football/nfl',
    CBB:   'basketball/mens-college-basketball',
    NCAAF: 'football/college-football',
  };
  const path = sportMap[(sport || '').toUpperCase()] || 'baseball/mlb';
  try {
    const url  = `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${espnGameId}`;
    const resp = await axios.get(url, { timeout: 8000 });
    const comp = resp.data?.header?.competitions?.[0];
    if (!comp) return null;
    const statusName = (comp.status?.type?.name || '').toLowerCase();
    if (!statusName.includes('final') && !statusName.includes('complete') && statusName !== 'post') return null;
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) return null;
    return {
      status:     'post',
      home_score: parseInt(home.score) || 0,
      away_score: parseInt(away.score) || 0,
      home_team:  home.team?.displayName   || '',
      home_short: home.team?.shortDisplayName || '',
      home_name:  home.team?.name           || '',
      home_abbr:  home.team?.abbreviation   || '',
      away_team:  away.team?.displayName    || '',
    };
  } catch (err) {
    console.warn(`[results] ESPN fetch for game ${espnGameId} failed:`, err.message);
    return null;
  }
}

// ── Evaluate all picks for finished games ─────────────────────────────────────
async function resolveResults() {
  let resolved = 0;

  // ── Pass 1: picks still in today's picks table ────────────────────────────
  const picks = db.prepare(`
    SELECT p.*, tg.home_score, tg.away_score, tg.status,
           tg.home_team, tg.home_short, tg.home_name, tg.home_abbr,
           tg.away_team, tg.first_inning_runs
    FROM picks p
    JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
    WHERE tg.status = 'post'
      AND (p.result = 'pending' OR (p.pick_type = 'NRFI' AND p.result != 'win' AND p.result != 'loss'))
      AND p.mention_count > 0
  `).all();

  for (const pick of picks) {
    const type = (pick.pick_type || '').toLowerCase();
    if (type === 'spread' && pick.spread == null) {
      const extracted = await extractSpreadFromMessage(pick.team, pick.id);
      if (extracted != null) {
        db.prepare(`UPDATE picks SET spread = ? WHERE id = ?`).run(extracted, pick.id);
        pick.spread = extracted;
      }
    }

    const result = evaluatePick(pick, pick);
    if (result === 'pending') continue;

    db.prepare(`UPDATE picks SET result = ? WHERE id = ?`).run(result, pick.id);

    // ── Write to capper_history (permanent capper tracking, survives daily wipe) ─
    if (pick.capper_name) {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO capper_history
            (capper_name, sport, pick_type, team, spread, espn_game_id, game_date, channel, score, result, pick_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          pick.capper_name,
          pick.sport        ?? null,
          pick.pick_type    ?? null,
          pick.team         ?? null,
          pick.spread       ?? null,
          pick.espn_game_id ?? null,
          pick.game_date    ?? null,
          pick.channel      ?? null,
          pick.score        ?? null,
          result,
          pick.id
        );
      } catch (_) {}
    }

    // Match mvp_picks by team + game_date + pick_type to avoid cross-type clobber
    // Never overwrite a voided pick — conflict resolver already settled it
    const mvp = db.prepare(
      `SELECT id FROM mvp_picks WHERE team = ? AND game_date = ? AND pick_type = ? AND result != 'void'`
    ).get(pick.team, pick.game_date, pick.pick_type ?? null);

    if (mvp) {
      // Never overwrite score — the original MVP score is what qualified it
      db.prepare(`UPDATE mvp_picks SET result = ?, home_score = ?, away_score = ? WHERE id = ?`)
        .run(result, pick.home_score, pick.away_score, mvp.id);
    }

    resolved++;
  }

  // ── Pass 2: mvp_picks pending but game is still in today_games (picks wiped) ─
  const directMvps = db.prepare(`
    SELECT m.*, tg.home_score, tg.away_score, tg.status,
           tg.home_team, tg.home_short, tg.home_name, tg.home_abbr,
           tg.away_team, tg.first_inning_runs
    FROM mvp_picks m
    JOIN today_games tg ON tg.espn_game_id = m.espn_game_id
    WHERE tg.status = 'post' AND m.result = 'pending'
  `).all();

  for (const mvp of directMvps) {
    const result = evaluatePick(mvp, mvp);
    if (result === 'pending') continue;
    db.prepare(`UPDATE mvp_picks SET result = ?, home_score = ?, away_score = ? WHERE id = ?`)
      .run(result, mvp.home_score, mvp.away_score, mvp.id);
    resolved++;
  }

  // ── Pass 3: truly stale mvp_picks — game no longer in today_games ────────
  const staleMvps = db.prepare(`
    SELECT m.* FROM mvp_picks m
    LEFT JOIN today_games tg ON tg.espn_game_id = m.espn_game_id
    WHERE m.result = 'pending' AND tg.espn_game_id IS NULL AND m.espn_game_id IS NOT NULL
  `).all();

  for (const mvp of staleMvps) {
    const gameData = await fetchGameResult(mvp.espn_game_id, mvp.sport);
    if (!gameData) continue;
    const result = evaluatePick(mvp, gameData);
    if (result === 'pending') continue;
    db.prepare(`UPDATE mvp_picks SET result = ?, home_score = ?, away_score = ? WHERE id = ?`)
      .run(result, gameData.home_score, gameData.away_score, mvp.id);
    resolved++;
  }

  if (resolved > 0) console.log(`[results] Resolved ${resolved} pick results`);
  return resolved;
}

module.exports = { resolveResults };
