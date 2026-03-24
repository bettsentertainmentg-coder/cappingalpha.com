// src/dashboard.js — Express dashboard on port 3001

const express = require('express');
const path    = require('path');
const db      = require('./db');
const { getRankedPicks, recalculateToday } = require('./value_engine');
const { getMonitoredGames, lookupTodayGame } = require('./espn_live');
const { runScan } = require('./discord_scanner');
const { getTodayAlerts }    = require('./alerts');

const app = express();
app.use(express.json());

// ── API routes ────────────────────────────────────────────────────────────────

// ── Enrich a pick with its today_game row (synchronous DB lookup) ─────────────
function enrichPickWithGame(pick) {
  const row = lookupTodayGame(pick.team);
  if (!row) return null;

  const search = (pick.team || '').toLowerCase().trim();
  const homeNames = [row.home_team, row.home_short, row.home_name, row.home_abbr]
    .filter(Boolean).map(n => n.toLowerCase());
  const isHome = homeNames.some(n =>
    n === search || n.startsWith(search + ' ') || n.endsWith(' ' + search)
  );

  const pickedScore = isHome ? row.home_score : row.away_score;
  const oppScore    = isHome ? row.away_score : row.home_score;
  const pickedTeam  = isHome ? row.home_team  : row.away_team;
  const oppTeam     = isHome ? row.away_team  : row.home_team;

  let covered = null;
  if (row.status === 'post') {
    const margin = pickedScore - oppScore;
    if (pick.pick_type === 'ML') covered = margin > 0;
    else if (pick.pick_type === 'spread' && pick.spread != null) covered = margin > -pick.spread;
    else covered = margin > 0;
  }

  return {
    espn_game_id: row.espn_game_id,
    home_team:    row.home_team,
    away_team:    row.away_team,
    home_score:   row.home_score,
    away_score:   row.away_score,
    status:       row.status,
    period:       row.period,
    clock:        row.clock,
    start_time:   row.start_time,
    picked_team:  pickedTeam,
    opp_team:     oppTeam,
    picked_score: pickedScore,
    opp_score:    oppScore,
    covered,
  };
}

app.get('/api/picks', (req, res) => {
  try {
    const picks = getRankedPicks();
    const enriched = picks.map(p => ({ ...p, game: enrichPickWithGame(p) }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scan', async (req, res) => {
  try {
    const newPicks = await runScan();
    recalculateToday();
    res.json({ status: 'complete', new_picks: newPicks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pick/:id/messages', (req, res) => {
  console.log(`[CappperBoss:dashboard] GET /api/pick/${req.params.id}/messages`);
  try {
    const pickId = parseInt(req.params.id, 10);
    if (isNaN(pickId)) return res.status(400).json({ error: 'Invalid pick id' });
    const messages = db.prepare(`
      SELECT id, channel, message_text, author, message_timestamp, saved_at
      FROM raw_messages
      WHERE pick_id = ?
      ORDER BY message_timestamp ASC
    `).all(pickId);
    console.log(`[CappperBoss:dashboard] Returning ${messages.length} messages for pick ${pickId}`);
    res.json(messages);
  } catch (err) {
    console.error(`[CappperBoss:dashboard] /api/pick/${req.params.id}/messages error:`, err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/live', (req, res) => {
  try {
    res.json(getMonitoredGames());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts', (req, res) => {
  try {
    res.json(getTodayAlerts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cappers', (req, res) => {
  try {
    // Derive capper stats from picks in last 30 days
    const cappers = db.prepare(`
      SELECT
        capper_name as name,
        COUNT(*) as picks,
        ROUND(AVG(score), 1) as avg_score,
        MAX(score) as best_score
      FROM picks
      WHERE capper_name IS NOT NULL AND capper_name != ''
        AND parsed_at >= datetime('now', '-30 days')
      GROUP BY capper_name
      ORDER BY avg_score DESC, picks DESC
    `).all();
    res.json(cappers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/review', (req, res) => {
  try {
    const picks = db.prepare(`
      SELECT p.*, r.message_text as raw_msg_text
      FROM picks p
      LEFT JOIN raw_messages r ON r.pick_id = p.id
      WHERE p.pending_review = 1
      ORDER BY p.parsed_at DESC
    `).all();
    res.json(picks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pick/:id/review', (req, res) => {
  try {
    const pickId = parseInt(req.params.id, 10);
    if (isNaN(pickId)) return res.status(400).json({ error: 'Invalid pick id' });
    const { sport, action } = req.body;
    if (!['confirm', 'discard'].includes(action)) {
      return res.status(400).json({ error: 'action must be confirm or discard' });
    }
    if (action === 'discard') {
      db.prepare(`DELETE FROM raw_messages WHERE pick_id = ?`).run(pickId);
      db.prepare(`DELETE FROM picks WHERE id = ?`).run(pickId);
      return res.json({ status: 'discarded' });
    }
    // confirm
    if (!sport) return res.status(400).json({ error: 'sport required for confirm' });
    db.prepare(`UPDATE picks SET sport = ?, pending_review = 0 WHERE id = ?`)
      .run(sport.toUpperCase(), pickId);
    res.json({ status: 'confirmed', sport: sport.toUpperCase() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CappperBot picks ──────────────────────────────────────────────────────────

function qualifiesForBot(pick) {
  const fp  = pick.free_plays_mentions || 0;
  const cm  = pick.community_mentions  || 0;
  const pod = pick.pod_mentions        || 0;
  const mc  = pick.mention_count       || 1;
  return mc >= 3 || (pod >= 1 && (cm >= 1 || fp >= 1));
}

app.get('/api/bot/picks', (req, res) => {
  try {
    const ranked = getRankedPicks();
    const qualified = ranked.filter(qualifiesForBot).slice(0, 10);

    // Deduplicate: if two picks share the same espn_game_id, keep higher-scored only
    const seenGame = new Map();
    const deduped = [];
    for (const p of qualified) {
      const game = enrichPickWithGame(p);
      const gid = game?.espn_game_id || null;
      if (gid && seenGame.has(gid)) continue;
      if (gid) seenGame.set(gid, true);
      deduped.push({ ...p, game });
    }

    // Auto-add new qualifying picks to bot_picks — skip any pick_id already seen
    // (including soft-deleted ones, so removed picks stay removed)
    for (const p of deduped) {
      const exists = db.prepare(`SELECT id FROM bot_picks WHERE pick_id = ?`).get(p.id);
      if (!exists) {
        db.prepare(`
          INSERT INTO bot_picks (pick_id, team, sport, pick_type, spread, game_date, espn_game_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(p.id, p.team, p.sport, p.pick_type, p.spread, p.game_date, p.game?.espn_game_id || null);
      }
    }

    // Return only non-deleted bot_picks with current game info
    const botPicks = db.prepare(`SELECT * FROM bot_picks WHERE deleted = 0 ORDER BY added_at DESC`).all();
    res.json(botPicks.map(bp => ({ ...bp, game: enrichPickWithGame(bp) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/bot/pick/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    db.prepare(`UPDATE bot_picks SET deleted = 1 WHERE id = ?`).run(id);
    res.json({ status: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bot/record', (req, res) => {
  try {
    const row = db.prepare(`
      SELECT
        SUM(result = 'win')  as wins,
        SUM(result = 'loss') as losses,
        SUM(result = 'push') as pushes
      FROM bot_picks WHERE deleted = 0
    `).get();
    res.json({ wins: row.wins || 0, losses: row.losses || 0, pushes: row.pushes || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Jack's picks ──────────────────────────────────────────────────────────────

app.post('/api/jack/pick/:id', (req, res) => {
  try {
    const pickId = parseInt(req.params.id, 10);
    if (isNaN(pickId)) return res.status(400).json({ error: 'Invalid pick id' });

    const pick = db.prepare(`SELECT * FROM picks WHERE id = ?`).get(pickId);
    if (!pick) return res.status(404).json({ error: 'Pick not found' });

    const game = enrichPickWithGame(pick);
    if (game && game.status !== 'pre') {
      return res.status(400).json({ error: 'Game is not pre-game' });
    }

    // Idempotent: don't add the same pick twice
    const existing = db.prepare(`SELECT id FROM jack_picks WHERE pick_id = ?`).get(pickId);
    if (existing) return res.json({ status: 'already_tracked', id: existing.id });

    const result = db.prepare(`
      INSERT INTO jack_picks (pick_id, team, sport, pick_type, spread, game_date, espn_game_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(pickId, pick.team, pick.sport, pick.pick_type, pick.spread, pick.game_date, game?.espn_game_id || null);

    res.json({ status: 'tracked', id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jack/pick/:id/result', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { result } = req.body;
    if (!['win', 'loss', 'push'].includes(result)) {
      return res.status(400).json({ error: 'result must be win, loss, or push' });
    }
    db.prepare(`UPDATE jack_picks SET result = ? WHERE id = ?`).run(result, id);
    res.json({ status: 'updated', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jack/picks', (req, res) => {
  try {
    const picks = db.prepare(`SELECT * FROM jack_picks ORDER BY noted_at DESC`).all();
    res.json(picks.map(jp => ({ ...jp, game: enrichPickWithGame(jp) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jack/record', (req, res) => {
  try {
    const row = db.prepare(`
      SELECT
        SUM(result = 'win')  as wins,
        SUM(result = 'loss') as losses,
        SUM(result = 'push') as pushes
      FROM jack_picks
    `).get();
    res.json({ wins: row.wins || 0, losses: row.losses || 0, pushes: row.pushes || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Serve dashboard HTML ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard.html'));
});

function start(port = 3001) {
  app.listen(port, () => {
    console.log(`[CappperBoss:dashboard] Running at http://localhost:${port}`);
  });
}

module.exports = { start };
