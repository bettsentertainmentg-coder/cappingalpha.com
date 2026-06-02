// src/results.js
// Evaluates win/loss/push for picks whose games have finished.
// Reads final scores from today_games, locked lines from line_snapshots.
// Writes result to picks.result and mvp_picks.result.

const db    = require('./db');
const axios = require('axios');

// ── Evaluate a single pick against final scores ───────────────────────────────
function evaluatePick(pick, game) {
  const type = (pick.pick_type || '').toLowerCase();
  const isTennis = ['atp', 'wta'].includes((game.sport || pick.sport || '').toLowerCase());

  // Tennis sanity guard: a finished tennis match can't end 0-0 on sets AND 0 total games.
  // If we see all zeros, the snapshot is incomplete — refuse to grade, try again later.
  if (isTennis) {
    const noSets   = (game.home_score == null || game.home_score === 0) &&
                     (game.away_score == null || game.away_score === 0);
    const noGames  = (game.tennis_home_games == null || game.tennis_home_games === 0) &&
                     (game.tennis_away_games == null || game.tennis_away_games === 0);
    if (noSets && noGames) return 'pending';
  }

  // Determine which side was picked
  const homeNames = [game.home_team, game.home_short, game.home_name, game.home_abbr]
    .filter(Boolean).map(n => n.toLowerCase());
  const pickedHome = homeNames.some(n => n === (pick.team || '').toLowerCase());

  const pickedScore = pickedHome ? game.home_score : game.away_score;
  const oppScore    = pickedHome ? game.away_score  : game.home_score;
  const margin      = pickedScore - oppScore; // sets for tennis, score diff for other sports

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
    let spreadMargin;
    if (isTennis) {
      // Tennis spread = game handicap — use game totals not sets
      if (game.tennis_home_games == null) return 'pending';
      const hg = game.tennis_home_games, ag = game.tennis_away_games;
      spreadMargin = pickedHome ? (hg - ag) : (ag - hg);
    } else {
      spreadMargin = margin;
    }
    const covered = spreadMargin + line;
    if (covered > 0) return 'win';
    if (covered < 0) return 'loss';
    return 'push';
  }

  if (type === 'over' || type === 'under') {
    const ou = snapshot?.original_ou ?? pick.spread;
    if (ou == null) return 'pending';
    // Tennis O/U = total games in match, not sets
    const total = isTennis
      ? ((game.tennis_home_games ?? 0) + (game.tennis_away_games ?? 0))
      : (game.home_score + game.away_score);
    if (isTennis && game.tennis_home_games == null) return 'pending';
    if (type === 'over')  return total > ou ? 'win' : total < ou ? 'loss' : 'push';
    if (type === 'under') return total < ou ? 'win' : total > ou ? 'loss' : 'push';
  }

  if (type === 'set_ml') {
    // spread_value encodes the set number (1, 2, 3)
    const setNum = Math.round(pick.spread);
    if (!setNum) return 'pending';
    let setDetails;
    try { setDetails = JSON.parse(game.tennis_score_detail || '[]'); } catch { return 'pending'; }
    const set = setDetails[setNum - 1];
    if (!set) return 'pending';
    const homeWon = set.home > set.away;
    const awayWon = set.away > set.home;
    if (pickedHome) return homeWon ? 'win' : awayWon ? 'loss' : 'push';
    return awayWon ? 'win' : homeWon ? 'loss' : 'push';
  }

  if (type === 'nrfi') {
    // Needs first_inning_runs snapshot — only set once inning 2 begins
    if (game.first_inning_runs == null) return 'pending';
    return game.first_inning_runs === 0 ? 'win' : 'loss';
  }

  return 'pending';
}

// ── Fetch final score for a stale game directly from ESPN API ─────────────────
const SPORT_PATH = {
  MLB:   'baseball/mlb',
  NBA:   'basketball/nba',
  WNBA:  'basketball/wnba',
  NHL:   'hockey/nhl',
  NFL:   'football/nfl',
  CBB:   'basketball/mens-college-basketball',
  NCAAF: 'football/college-football',
  ATP:   'tennis/atp',
  WTA:   'tennis/wta',
};
const TENNIS_SPORTS = new Set(['ATP', 'WTA']);

async function fetchGameResult(espnGameId, sport, gameDate = null) {
  const sportKey = (sport || '').toUpperCase();
  const path     = SPORT_PATH[sportKey];
  if (!path) return null;  // never silently fall back to MLB

  // Tennis uses scoreboard-by-date (summary endpoint returns 400 for tennis events)
  if (TENNIS_SPORTS.has(sportKey)) {
    return fetchTennisGameByDate(espnGameId, path, gameDate);
  }

  try {
    const url  = `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${espnGameId}`;
    const resp = await axios.get(url, { timeout: 8000 });
    const comp = resp.data?.header?.competitions?.[0];
    if (!comp) return null;
    const statusName = (comp.status?.type?.name || '').toLowerCase();
    const stateName  = (comp.status?.type?.state || '').toLowerCase();
    const isFinal = statusName.includes('final') || statusName.includes('complete')
                 || statusName === 'post'        || stateName === 'post';
    if (!isFinal) return null;

    const home = comp.competitors?.find(c => c.homeAway === 'home') || comp.competitors?.[0];
    const away = comp.competitors?.find(c => c.homeAway === 'away') || comp.competitors?.[1];
    if (!home || !away) return null;

    const homeDisplay = home.team?.displayName || '';
    const awayDisplay = away.team?.displayName || '';

    return {
      status:     'post',
      sport:      sportKey,
      home_score: parseInt(home.score) || 0,
      away_score: parseInt(away.score) || 0,
      home_team:  homeDisplay,
      home_short: home.team?.shortDisplayName || lastNameOf(homeDisplay),
      home_name:  home.team?.name || homeDisplay,
      home_abbr:  home.team?.abbreviation || abbrOf(homeDisplay),
      away_team:  awayDisplay,
      away_short: away.team?.shortDisplayName || lastNameOf(awayDisplay),
      away_name:  away.team?.name || awayDisplay,
      away_abbr:  away.team?.abbreviation || abbrOf(awayDisplay),
    };
  } catch (err) {
    console.warn(`[results] ESPN fetch for game ${espnGameId} (${sportKey}) failed:`, err.message);
    return null;
  }
}

// ── Tennis: pull scoreboard for the game's date, find this match, parse linescores ─
async function fetchTennisGameByDate(espnGameId, path, gameDate) {
  // Try the given date first, then -1d and +1d to handle TZ edges
  const dates = [];
  const seen  = new Set();
  function pushDate(s) {
    if (!s || seen.has(s)) return;
    seen.add(s); dates.push(s);
  }
  function toYmd(dateStr, offsetDays = 0) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T12:00:00Z');
    if (isNaN(d)) return null;
    d.setUTCDate(d.getUTCDate() + offsetDays);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const da = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${da}`;
  }
  pushDate(toYmd(gameDate, 0));
  pushDate(toYmd(gameDate, -1));
  pushDate(toYmd(gameDate, 1));
  if (!dates.length) {
    // No date provided — fall back to today
    const now = new Date();
    pushDate(`${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,'0')}${String(now.getUTCDate()).padStart(2,'0')}`);
  }

  for (const ymd of dates) {
    try {
      const url  = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${ymd}`;
      const resp = await axios.get(url, { timeout: 8000 });
      const events = resp.data?.events || [];
      for (const ev of events) {
        const groupings = ev.groupings || [{ competitions: ev.competitions || [] }];
        for (const g of groupings) {
          for (const comp of (g.competitions || [])) {
            if (String(comp.id) !== String(espnGameId)) continue;
            const statusName = (comp.status?.type?.name || '').toLowerCase();
            const stateName  = (comp.status?.type?.state || '').toLowerCase();
            const isFinal = statusName.includes('final') || statusName.includes('complete')
                         || statusName === 'post'        || stateName === 'post';
            if (!isFinal) return null;

            const home = comp.competitors?.find(c => c.homeAway === 'home') || comp.competitors?.[0];
            const away = comp.competitors?.find(c => c.homeAway === 'away') || comp.competitors?.[1];
            if (!home || !away) return null;

            const homeAth = home.athlete || {};
            const awayAth = away.athlete || {};
            const homeDisplay = homeAth.displayName || homeAth.fullName || home.team?.displayName || '';
            const awayDisplay = awayAth.displayName || awayAth.fullName || away.team?.displayName || '';

            const homeLs = home.linescores || [];
            const awayLs = away.linescores || [];
            const numSets = Math.max(homeLs.length, awayLs.length);
            let homeSetsWon = 0, awaySetsWon = 0;
            const setDetails = [];
            for (let i = 0; i < numSets; i++) {
              const h = Number(homeLs[i]?.value) || 0;
              const a = Number(awayLs[i]?.value) || 0;
              setDetails.push({ set: i + 1, home: h, away: a });
              if (h > a) homeSetsWon++;
              else if (a > h) awaySetsWon++;
            }
            const homeGames = homeLs.reduce((s, l) => s + (Number(l.value) || 0), 0);
            const awayGames = awayLs.reduce((s, l) => s + (Number(l.value) || 0), 0);

            return {
              status:              'post',
              sport:               path === 'tennis/atp' ? 'ATP' : 'WTA',
              home_score:          homeSetsWon,
              away_score:          awaySetsWon,
              home_team:           homeDisplay,
              home_short:          lastNameOf(homeDisplay),
              home_name:           lastNameOf(homeDisplay),
              home_abbr:           abbrOf(homeDisplay),
              away_team:           awayDisplay,
              away_short:          lastNameOf(awayDisplay),
              away_name:           lastNameOf(awayDisplay),
              away_abbr:           abbrOf(awayDisplay),
              tennis_home_games:   homeGames || null,
              tennis_away_games:   awayGames || null,
              tennis_score_detail: numSets > 0 ? JSON.stringify(setDetails) : null,
            };
          }
        }
      }
    } catch (err) {
      console.warn(`[results] tennis scoreboard ${path} ${ymd} failed:`, err.message);
    }
  }
  return null;
}

function lastNameOf(displayName) {
  if (!displayName) return null;
  const parts = displayName.trim().split(/\s+/);
  return parts[parts.length - 1] || null;
}
function abbrOf(displayName) {
  const last = lastNameOf(displayName);
  return last ? last.slice(0, 3).toUpperCase() : null;
}

// ── Evaluate all picks for finished games ─────────────────────────────────────
async function resolveResults() {
  let resolved = 0;

  // ── Pass 1: picks still in today's picks table ────────────────────────────
  const picks = db.prepare(`
    SELECT p.*, tg.home_score, tg.away_score, tg.status, tg.sport,
           tg.home_team, tg.home_short, tg.home_name, tg.home_abbr,
           tg.away_team, tg.first_inning_runs,
           tg.tennis_home_games, tg.tennis_away_games, tg.tennis_score_detail
    FROM picks p
    JOIN today_games tg ON tg.espn_game_id = p.espn_game_id
    WHERE tg.status = 'post'
      AND (p.result = 'pending' OR (p.pick_type = 'NRFI' AND p.result != 'win' AND p.result != 'loss'))
      AND p.mention_count > 0
  `).all();

  for (const pick of picks) {
    const result = evaluatePick(pick, pick);
    if (result === 'pending') continue;

    db.prepare(`UPDATE picks SET result = ? WHERE id = ?`).run(result, pick.id);

    // ── Mirror result into pick_history (permanent archive) ──────────────────
    try {
      db.prepare(`
        UPDATE pick_history
        SET result = ?, home_score = ?, away_score = ?, resolved_at = datetime('now')
        WHERE pick_id = ? AND result = 'pending'
      `).run(result, pick.home_score ?? null, pick.away_score ?? null, pick.id);
    } catch (_) {}

    // ── Persist result into game_votes so voted P/L history survives daily wipe ─
    const slot = pick.pick_type === 'ml'     && pick.is_home_team ? 'home_ml'
               : pick.pick_type === 'ml'                          ? 'away_ml'
               : pick.pick_type === 'spread' && pick.is_home_team ? 'home_spread'
               : pick.pick_type === 'spread'                      ? 'away_spread'
               : pick.pick_type === 'over'                        ? 'over'
               : pick.pick_type === 'under'                       ? 'under'
               : null;
    if (slot) {
      db.prepare(`UPDATE game_votes SET result = ?, score = ? WHERE espn_game_id = ? AND pick_slot = ?`)
        .run(result, pick.score ?? null, pick.espn_game_id, slot);
    }

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
    SELECT m.*, tg.sport AS sport, tg.home_score, tg.away_score, tg.status,
           tg.home_team, tg.home_short, tg.home_name, tg.home_abbr,
           tg.away_team, tg.first_inning_runs,
           tg.tennis_home_games, tg.tennis_away_games, tg.tennis_score_detail
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
    const gameData = await fetchGameResult(mvp.espn_game_id, mvp.sport, mvp.game_date);
    if (!gameData) continue;
    const result = evaluatePick(mvp, gameData);
    if (result === 'pending') continue;
    db.prepare(`UPDATE mvp_picks SET result = ?, home_score = ?, away_score = ? WHERE id = ?`)
      .run(result, gameData.home_score, gameData.away_score, mvp.id);
    resolved++;
  }

  // ── Pass 4: stale pick_history — permanent archive whose source pick was wiped ─
  // Same shape as Pass 3, but for pick_history. Fetches ESPN once per unique game
  // (cached in-loop) and grades every pending row attached to that game.
  const stalePh = db.prepare(`
    SELECT ph.* FROM pick_history ph
    LEFT JOIN today_games tg ON tg.espn_game_id = ph.espn_game_id
    WHERE ph.result = 'pending'
      AND ph.espn_game_id IS NOT NULL
      AND tg.espn_game_id IS NULL
  `).all();

  const gameCache = new Map();   // espn_game_id -> gameData | null
  for (const ph of stalePh) {
    const key = `${ph.espn_game_id}|${ph.sport || ''}|${ph.game_date || ''}`;
    let gameData;
    if (gameCache.has(key)) {
      gameData = gameCache.get(key);
    } else {
      gameData = await fetchGameResult(ph.espn_game_id, ph.sport, ph.game_date);
      gameCache.set(key, gameData);
    }
    if (!gameData) continue;
    const result = evaluatePick(ph, gameData);
    if (result === 'pending') continue;
    db.prepare(`
      UPDATE pick_history
      SET result = ?, home_score = ?, away_score = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(result, gameData.home_score, gameData.away_score, ph.id);
    // Mirror into mvp_picks if a matching MVP row exists and isn't already settled
    try {
      db.prepare(`
        UPDATE mvp_picks
        SET result = ?, home_score = ?, away_score = ?
        WHERE espn_game_id = ? AND team = ? AND pick_type IS ? AND result = 'pending'
      `).run(
        result,
        gameData.home_score,
        gameData.away_score,
        ph.espn_game_id,
        ph.team,
        ph.pick_type ?? null
      );
    } catch (_) {}
    resolved++;
  }

  if (resolved > 0) console.log(`[results] Resolved ${resolved} pick results`);
  return resolved;
}

module.exports = { resolveResults };
