#!/usr/bin/env node
// scripts/regrade-tennis.js
// One-shot backfill: regrade tennis picks stuck on 'pending' by fetching
// final scores from ESPN. Use after deploying the tennis grading fixes.
//
//   node scripts/regrade-tennis.js              # dry run, prints what would change
//   node scripts/regrade-tennis.js --apply      # writes updates to pick_history + mvp_picks
//
// Safe to re-run. Only touches rows still in 'pending' state.

const path  = require('path');
const db    = require(path.join(__dirname, '..', 'src', 'db'));
const axios = require('axios');

const APPLY = process.argv.includes('--apply');

const SPORT_PATH = {
  ATP: 'tennis/atp',
  WTA: 'tennis/wta',
};

async function fetchTennisGame(espnGameId, sport, gameDate) {
  const p = SPORT_PATH[(sport || '').toUpperCase()];
  if (!p) return null;

  const dates = [];
  const seen  = new Set();
  function pushDate(s) { if (s && !seen.has(s)) { seen.add(s); dates.push(s); } }
  function toYmd(dateStr, offsetDays = 0) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T12:00:00Z');
    if (isNaN(d)) return null;
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  pushDate(toYmd(gameDate, 0));
  pushDate(toYmd(gameDate, -1));
  pushDate(toYmd(gameDate, 1));

  for (const ymd of dates) {
    try {
      const url  = `https://site.api.espn.com/apis/site/v2/sports/${p}/scoreboard?dates=${ymd}`;
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
            let homeSets = 0, awaySets = 0;
            const details = [];
            for (let i = 0; i < Math.max(homeLs.length, awayLs.length); i++) {
              const h = Number(homeLs[i]?.value) || 0;
              const a = Number(awayLs[i]?.value) || 0;
              details.push({ set: i + 1, home: h, away: a });
              if (h > a) homeSets++;
              else if (a > h) awaySets++;
            }
            const homeGames = homeLs.reduce((s, l) => s + (Number(l.value) || 0), 0);
            const awayGames = awayLs.reduce((s, l) => s + (Number(l.value) || 0), 0);

            return {
              home_team:           homeDisplay,
              away_team:           awayDisplay,
              home_short:          lastName(homeDisplay),
              away_short:          lastName(awayDisplay),
              home_score:          homeSets,
              away_score:          awaySets,
              tennis_home_games:   homeGames,
              tennis_away_games:   awayGames,
              tennis_score_detail: details.length ? JSON.stringify(details) : null,
            };
          }
        }
      }
    } catch (err) {
      console.warn(`  ESPN scoreboard ${ymd} failed: ${err.message}`);
    }
  }
  return null;
}

function lastName(displayName) {
  if (!displayName) return null;
  const parts = displayName.trim().split(/\s+/);
  return parts[parts.length - 1] || null;
}

function gradePick(pick, game) {
  const type     = (pick.pick_type || '').toLowerCase();
  const homeNames = [game.home_team, game.home_short].filter(Boolean).map(n => n.toLowerCase());
  const pickedHome = homeNames.some(n => n === (pick.team || '').toLowerCase());
  const pickedSet  = pickedHome ? game.home_score : game.away_score;
  const oppSet     = pickedHome ? game.away_score : game.home_score;
  const setMargin  = pickedSet - oppSet;
  const homeGames  = game.tennis_home_games || 0;
  const awayGames  = game.tennis_away_games || 0;

  // Sanity: tennis can't end 0-0 / 0 total games
  if (game.home_score === 0 && game.away_score === 0 && homeGames === 0 && awayGames === 0) {
    return null;
  }

  if (type === 'ml') {
    if (setMargin > 0) return 'win';
    if (setMargin < 0) return 'loss';
    return 'push';
  }
  if (type === 'spread') {
    const line = pick.spread;
    if (line == null) return null; // can't grade without a line
    const margin = pickedHome ? (homeGames - awayGames) : (awayGames - homeGames);
    const covered = margin + line;
    if (covered > 0) return 'win';
    if (covered < 0) return 'loss';
    return 'push';
  }
  if (type === 'over' || type === 'under') {
    const ou = pick.spread;
    if (ou == null) return null;
    const total = homeGames + awayGames;
    if (type === 'over')  return total > ou ? 'win' : total < ou ? 'loss' : 'push';
    if (type === 'under') return total < ou ? 'win' : total > ou ? 'loss' : 'push';
  }
  if (type === 'set_ml') {
    const setNum = Math.round(pick.spread);
    if (!setNum) return null;
    let details;
    try { details = JSON.parse(game.tennis_score_detail || '[]'); } catch { return null; }
    const s = details[setNum - 1];
    if (!s) return null;
    const homeWon = s.home > s.away;
    const awayWon = s.away > s.home;
    if (pickedHome) return homeWon ? 'win' : awayWon ? 'loss' : 'push';
    return awayWon ? 'win' : homeWon ? 'loss' : 'push';
  }
  return null;
}

async function main() {
  console.log(`[regrade-tennis] mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const stuck = db.prepare(`
    SELECT id, pick_id, espn_game_id, sport, team, pick_type, spread, is_home_team,
           home_team, away_team, channel, capper_name, game_date
    FROM pick_history
    WHERE result = 'pending'
      AND sport IN ('ATP', 'WTA')
      AND espn_game_id IS NOT NULL
    ORDER BY id
  `).all();

  console.log(`Found ${stuck.length} stuck tennis pick_history rows.`);

  const cache = new Map();
  let regraded = 0, skipped = 0, errors = 0, ungradable = 0;

  for (const ph of stuck) {
    const key = `${ph.espn_game_id}|${ph.sport}|${ph.game_date || ''}`;
    let game;
    if (cache.has(key)) {
      game = cache.get(key);
    } else {
      game = await fetchTennisGame(ph.espn_game_id, ph.sport, ph.game_date);
      cache.set(key, game);
    }

    if (!game) {
      console.log(`  ph#${ph.id} ${ph.team} ${ph.pick_type} (${ph.espn_game_id}) — ESPN no final yet`);
      errors++;
      continue;
    }

    const result = gradePick(ph, game);
    if (!result) {
      console.log(`  ph#${ph.id} ${ph.team} ${ph.pick_type} spread=${ph.spread} — cannot grade (missing line or set number)`);
      ungradable++;
      continue;
    }

    console.log(`  ph#${ph.id} ${ph.team} ${ph.pick_type}${ph.spread != null ? ' ' + ph.spread : ''} → ${result} (${game.home_score}-${game.away_score} sets, ${game.tennis_home_games}-${game.tennis_away_games} games)`);

    if (APPLY) {
      db.prepare(`
        UPDATE pick_history
        SET result = ?, home_score = ?, away_score = ?, resolved_at = datetime('now')
        WHERE id = ? AND result = 'pending'
      `).run(result, game.home_score, game.away_score, ph.id);

      // Mirror into mvp_picks if a matching pending row exists
      db.prepare(`
        UPDATE mvp_picks
        SET result = ?, home_score = ?, away_score = ?
        WHERE espn_game_id = ? AND team = ? AND pick_type IS ? AND result = 'pending'
      `).run(result, game.home_score, game.away_score, ph.espn_game_id, ph.team, ph.pick_type ?? null);
    }
    regraded++;
  }

  console.log(`\nRegraded: ${regraded}`);
  console.log(`Skipped (no final on ESPN): ${errors}`);
  console.log(`Ungradable (missing line/set): ${ungradable}`);
  console.log(APPLY ? '\nApplied to DB.' : '\nDry run only. Re-run with --apply to write changes.');
}

main().catch(err => { console.error(err); process.exit(1); });
