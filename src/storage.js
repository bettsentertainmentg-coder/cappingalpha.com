// src/storage.js
// Handles all DB writes for picks.
// Finds the pre-seeded slot for each incoming pick and adds points to it.
// Lines are never overwritten — they come from the 6am seed.

const db            = require('./db');
const { scorePick } = require('./scoring');

// ── Capper name normalization + alias resolution ──────────────────────────────
function normalizeCapper(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveCapperName(raw) {
  if (!raw) return raw;
  const norm = normalizeCapper(raw);
  try {
    const alias = db.prepare(
      `SELECT canonical_name FROM capper_aliases WHERE LOWER(REPLACE(REPLACE(REPLACE(alias,' ',''),'_',''),'-','')) = ? LIMIT 1`
    ).get(norm);
    return alias ? alias.canonical_name : raw;
  } catch (_) {
    return raw;
  }
}

// ── Golf pick handler ─────────────────────────────────────────────────────────
function saveGolfPick(pick) {
  const { team, pick_type, vs_player, spread_value, channel, capper_name, sport_record, raw_message } = pick;
  const resolvedCapper = resolveCapperName(capper_name);
  const playerName = team; // team field holds player name for Golf

  // Find which active tournament this player is in
  let espnTournamentId = null;
  try {
    const tournaments = db.prepare(`SELECT * FROM golf_tournaments WHERE status != 'post'`).all();
    for (const t of tournaments) {
      const lb = JSON.parse(t.leaderboard_json || '[]');
      const normPlayer = normalizeCapper(playerName);
      const found = lb.some(entry => {
        const fn = normalizeCapper(entry.player?.fullName || '');
        const ln = normalizeCapper(entry.player?.lastName || '');
        const sn = normalizeCapper(entry.player?.shortName || '');
        return fn === normPlayer || ln === normPlayer || sn === normPlayer ||
               fn.includes(normPlayer) || normPlayer.includes(ln);
      });
      if (found) { espnTournamentId = t.espn_tournament_id; break; }
    }
  } catch (err) {
    console.warn('[storage] golf tournament lookup error:', err.message);
  }

  if (!espnTournamentId) {
    console.log(`[storage] Golf pick for "${playerName}" — no active major found, storing without tournament`);
    espnTournamentId = 'unknown';
  }

  // Dedup: same pick_type + player + tournament (same pick from different posters = update, not insert)
  const existing = db.prepare(`
    SELECT * FROM golf_picks
    WHERE espn_tournament_id = ? AND LOWER(player_name) = LOWER(?) AND pick_type = ?
    LIMIT 1
  `).get(espnTournamentId, playerName, pick_type);

  if (existing) {
    // Check author+channel dedup for the raw message
    if (raw_message?.author && channel) {
      const authorSeen = db.prepare(
        `SELECT id FROM raw_messages_golf WHERE golf_pick_id = ? AND channel = ? AND author = ?`
      ).get(existing.id, channel, raw_message.author);
      if (authorSeen) {
        console.log(`[storage] Skipped golf re-post: ${raw_message.author} already counted`);
        return existing.id;
      }
    }

    // Score: reconstruct all prior mentions
    const priorChannels = db.prepare(`SELECT channel FROM raw_messages_golf WHERE golf_pick_id = ?`).all(existing.id);
    const mentions = [
      ...priorChannels.map(m => ({ channel: m.channel, is_home_team: false, sport: 'Golf' })),
      { channel, is_home_team: false, sport: 'Golf' },
    ];
    const scored = scorePick({ mentions });

    db.prepare(`
      UPDATE golf_picks SET
        score         = ?,
        mention_count = mention_count + 1,
        score_breakdown = ?,
        capper_name   = COALESCE(capper_name, ?)
      WHERE id = ?
    `).run(scored.total, JSON.stringify(scored.breakdown), resolvedCapper ?? null, existing.id);

    saveRawMessageGolf(existing.id, pick);
    return existing.id;
  }

  // New golf pick
  const { scorePick } = require('./scoring');
  const scored = scorePick({ mentions: [{ channel, is_home_team: false, sport: 'Golf' }] });

  const result = db.prepare(`
    INSERT INTO golf_picks
      (espn_tournament_id, capper_name, player_name, vs_player, pick_type, spread_value,
       sport_record, channel, score, score_breakdown, game_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'))
  `).run(
    espnTournamentId,
    resolvedCapper   ?? null,
    playerName,
    vs_player        ?? null,
    pick_type        ?? null,
    spread_value     ?? null,
    sport_record     ?? null,
    channel          ?? null,
    scored.total,
    JSON.stringify(scored.breakdown),
  );

  saveRawMessageGolf(result.lastInsertRowid, pick);
  console.log(`[storage] New golf pick: ${playerName} ${pick_type} (tournament=${espnTournamentId}, score=${scored.total})`);
  return result.lastInsertRowid;
}

function saveRawMessageGolf(golf_pick_id, pick) {
  const { channel, raw_message } = pick;
  if (!raw_message) return;
  db.prepare(`
    INSERT OR IGNORE INTO raw_messages_golf
      (golf_pick_id, channel, message_text, author, message_timestamp, message_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    golf_pick_id,
    channel                 ?? null,
    raw_message.content     ?? null,
    raw_message.author      ?? null,
    raw_message.createdAt ? new Date(raw_message.createdAt).toISOString() : null,
    raw_message.id          ?? null,
  );
}

// ── Normalize common input quirks before matching ────────────────────────────
function normalizeTeam(raw) {
  return (raw || '')
    .toLowerCase()
    .trim()
    .replace(/s$/, ''); // strip trailing 's' — "Thunders" → "Thunder", "Yankees" → "Yankee"
}

// ── Find today's game by any team name variant ────────────────────────────────
function findTodayGame(team) {
  const t  = (team || '').toLowerCase().trim();
  const tn = normalizeTeam(team);

  // Pass 1: exact match on any stored variant
  const exact = db.prepare(`
    SELECT * FROM today_games
    WHERE LOWER(home_team)  = ? OR LOWER(away_team)  = ?
       OR LOWER(home_short) = ? OR LOWER(away_short) = ?
       OR LOWER(home_name)  = ? OR LOWER(away_name)  = ?
       OR LOWER(home_abbr)  = ? OR LOWER(away_abbr)  = ?
    LIMIT 1
  `).get(t, t, t, t, t, t, t, t);
  if (exact) return exact;

  // Pass 2: fuzzy — check if input (or stripped) is contained in any variant, or variant in input
  const all = db.prepare(`SELECT * FROM today_games`).all();
  for (const game of all) {
    const variants = [
      game.home_team, game.away_team,
      game.home_short, game.away_short,
      game.home_name, game.away_name,
      game.home_abbr, game.away_abbr,
    ].filter(Boolean).map(n => n.toLowerCase());

    for (const v of variants) {
      const vn = normalizeTeam(v);
      if (vn === tn || v.includes(tn) || tn.includes(vn) || v.includes(t) || t.includes(v)) {
        return game;
      }
    }
  }

  return null;
}

// ── Resolve the canonical team name (home_team or away_team) from today_games ─
function getCanonicalTeam(game, team) {
  const t  = (team || '').toLowerCase().trim();
  const tn = normalizeTeam(team);

  const homeVariants = [game.home_team, game.home_short, game.home_name, game.home_abbr]
    .filter(Boolean).map(n => n.toLowerCase());

  return homeVariants.some(n => n === t || normalizeTeam(n) === tn || n.includes(tn) || tn.includes(normalizeTeam(n)))
    ? game.home_team
    : game.away_team;
}

// ── Find slot using AI-provided picked_side (home/away) ──────────────────────
function findSlotWithSide(pick, game, picked_side) {
  const isTotal = pick.pick_type === 'over' || pick.pick_type === 'under';
  if (isTotal) {
    return db.prepare(`SELECT * FROM picks WHERE espn_game_id = ? AND pick_type = ? LIMIT 1`)
      .get(game.espn_game_id, pick.pick_type);
  }
  const canonicalTeam = picked_side === 'home' ? game.home_team
                      : picked_side === 'away' ? game.away_team
                      : getCanonicalTeam(game, pick.team);
  return db.prepare(`SELECT * FROM picks WHERE espn_game_id = ? AND LOWER(team) = LOWER(?) AND pick_type = ? LIMIT 1`)
    .get(game.espn_game_id, canonicalTeam, pick.pick_type);
}

// ── Find the pre-seeded pick slot for an incoming pick ────────────────────────
function findSlot(pick, game) {
  const isTotal = pick.pick_type === 'over' || pick.pick_type === 'under';

  if (isTotal) {
    // Over/under: slot is anchored to home team — find by game + pick_type only
    return db.prepare(`
      SELECT * FROM picks
      WHERE espn_game_id = ? AND pick_type = ?
      LIMIT 1
    `).get(game.espn_game_id, pick.pick_type);
  }

  // ML/spread: find by game + canonical team name + pick_type
  const canonicalTeam = getCanonicalTeam(game, pick.team);
  return db.prepare(`
    SELECT * FROM picks
    WHERE espn_game_id = ? AND LOWER(team) = LOWER(?) AND pick_type = ?
    LIMIT 1
  `).get(game.espn_game_id, canonicalTeam, pick.pick_type);
}

// ── Main entry point ──────────────────────────────────────────────────────────
function savePick(pick) {
  // Golf picks go to a separate table — never wiped, tournament-scoped
  if ((pick.sport || '').toLowerCase() === 'golf') {
    return saveGolfPick(pick);
  }

  const { team, espn_game_id: aiGameId, picked_side } = pick;

  // 1. If Haiku identified the game directly, use it — no fuzzy matching needed
  if (aiGameId) {
    const game = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(aiGameId);
    if (game) {
      const slot = findSlotWithSide(pick, game, picked_side);
      if (slot) return updateSlot(slot, pick);
      return insertNewPick({ ...pick, espn_game_id: aiGameId });
    }
  }

  // 2. Fallback: fuzzy match by team name
  const game = findTodayGame(team);
  const slot = game ? findSlot(pick, game) : null;
  if (slot) return updateSlot(slot, pick);

  return insertNewPick({ ...pick, espn_game_id: game?.espn_game_id ?? pick.espn_game_id ?? null });
}

// ── Update a pre-seeded slot with a new mention ───────────────────────────────
function updateSlot(slot, pick) {
  const { channel, sport_record, raw_message } = pick;
  const capper_name = resolveCapperName(pick.capper_name);

  // Skip if this exact Discord message was already counted for this slot
  if (raw_message?.id) {
    const alreadySeen = db.prepare(
      `SELECT id FROM raw_messages WHERE pick_id = ? AND message_id = ?`
    ).get(slot.id, String(raw_message.id));
    if (alreadySeen) return slot.id;
  }

  // Skip if this author already contributed to this pick from this channel (re-post dedup)
  if (raw_message?.author && channel) {
    const authorSeen = db.prepare(
      `SELECT id FROM raw_messages WHERE pick_id = ? AND channel = ? AND author = ?`
    ).get(slot.id, channel, raw_message.author);
    if (authorSeen) {
      console.log(`[storage] Skipped re-post: ${raw_message.author} already counted for pick ${slot.id} in ${channel}`);
      return slot.id;
    }
  }

  // If slot has no spread value yet but reader extracted one, fill it in
  if (slot.spread == null && pick.spread_value != null) {
    const parsed = parseFloat(pick.spread_value);
    if (!isNaN(parsed)) {
      db.prepare(`UPDATE picks SET spread = ? WHERE id = ?`).run(parsed, slot.id);
    }
  }

  // Reconstruct all prior mentions from raw_messages + this new one
  const priorChannels = db.prepare(
    `SELECT channel FROM raw_messages WHERE pick_id = ?`
  ).all(slot.id);

  const isTotal = slot.pick_type === 'over' || slot.pick_type === 'under';
  const mentions = [
    ...priorChannels.map(m => ({
      channel:      m.channel,
      is_home_team: isTotal ? false : slot.is_home_team,
      sport:        slot.sport,
    })),
    { channel, is_home_team: isTotal ? false : slot.is_home_team, sport: slot.sport },
  ];

  const scored = scorePick({ mentions });

  db.prepare(`
    UPDATE picks
    SET score          = ?,
        mention_count  = mention_count + 1,
        score_breakdown = ?,
        channel        = COALESCE(channel, ?),
        capper_name    = COALESCE(capper_name, ?),
        sport_record   = COALESCE(sport_record, ?)
    WHERE id = ?
  `).run(
    scored.total,
    JSON.stringify(scored.breakdown),
    channel       ?? null,
    capper_name   ?? null,
    sport_record  ?? null,
    slot.id
  );

  upsertScoreBreakdown(slot.id, scored);
  saveRawMessage(slot.id, pick);

  if (scored.is_mvp) {
    saveMvpPick({
      team:        slot.team,
      sport:       slot.sport,
      pick_type:   slot.pick_type,
      spread:      slot.spread,
      game_date:   slot.game_date,
      espn_game_id: slot.espn_game_id,
      score:       scored.total,
    });
  }

  if (scored.total >= 35) upsertPickHistory(slot.id, scored);

  return slot.id;
}

// ── Fallback insert for picks with no matching today_games entry ──────────────
function insertNewPick(pick) {
  const {
    team, sport, pick_type, spread_value, channel,
    is_home_team, game_date, sport_record,
    raw_message, espn_game_id = null,
  } = pick;
  const capper_name = resolveCapperName(pick.capper_name);

  // Display line always comes from ESPN locked snapshot — never from Ollama
  const snapshot = espn_game_id ? db.prepare(`
    SELECT original_spread, original_ml, original_ou
    FROM line_snapshots WHERE game_id = ? AND LOWER(team) = LOWER(?)
  `).get(espn_game_id, team) : null;

  const type = (pick_type || '').toLowerCase();
  const spread = (type === 'over' || type === 'under')
    ? (snapshot?.original_ou     ?? (parseFloat(spread_value) || null))
    : (snapshot?.original_spread ?? (parseFloat(spread_value) || null));
  const isTotal2 = (pick_type || '').toLowerCase() === 'over' || (pick_type || '').toLowerCase() === 'under';
  const scored = scorePick({ mentions: [{ channel, is_home_team: isTotal2 ? false : (is_home_team || false), sport }] });

  const result = db.prepare(`
    INSERT INTO picks
      (capper_name, team, pick_type, spread, sport, game_date,
       mention_count, raw_message, score, channel, score_breakdown,
       espn_game_id, is_home_team)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    capper_name   ?? null,
    team,
    pick_type     ?? null,
    spread,
    sport         ?? null,
    game_date     ?? null,
    raw_message?.content ?? null,
    scored.total,
    channel       ?? null,
    JSON.stringify(scored.breakdown),
    espn_game_id,
    is_home_team ? 1 : 0
  );

  const pick_id = result.lastInsertRowid;
  upsertScoreBreakdown(pick_id, scored);
  saveRawMessage(pick_id, pick);

  if (scored.is_mvp) {
    saveMvpPick({ team, sport, pick_type, spread, game_date, espn_game_id, score: scored.total });
  }

  if (scored.total >= 35) upsertPickHistory(pick_id, scored);

  return pick_id;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function saveRawMessage(pick_id, pick) {
  const { channel, raw_message } = pick;
  if (!raw_message) return;
  db.prepare(`
    INSERT OR IGNORE INTO raw_messages
      (pick_id, channel, message_text, author, message_timestamp, message_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    pick_id,
    channel                 ?? null,
    raw_message.content     ?? null,
    raw_message.author      ?? null,
    raw_message.createdAt ? new Date(raw_message.createdAt).toISOString() : null,
    raw_message.id          ?? null
  );
}

function upsertScoreBreakdown(pick_id, scored) {
  const exists = db.prepare(`SELECT id FROM score_breakdown WHERE pick_id = ?`).get(pick_id);

  if (exists) {
    db.prepare(`
      UPDATE score_breakdown
      SET channel_points = ?,
          sport_bonus    = ?,
          home_bonus     = ?,
          total          = ?,
          breakdown_json = ?
      WHERE pick_id = ?
    `).run(
      scored.breakdown.channel_points,
      scored.breakdown.sport_bonus,
      scored.breakdown.home_bonus,
      scored.total,
      JSON.stringify(scored.breakdown),
      pick_id
    );
  } else {
    db.prepare(`
      INSERT INTO score_breakdown
        (pick_id, channel_points, sport_bonus, home_bonus, total, breakdown_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      pick_id,
      scored.breakdown.channel_points,
      scored.breakdown.sport_bonus,
      scored.breakdown.home_bonus,
      scored.total,
      JSON.stringify(scored.breakdown)
    );
  }
}

function saveMvpPick({ team, sport, pick_type, spread, game_date, espn_game_id = null, score }) {
  // Capture odds + team names from today_games at save time
  let ml_odds = null, ou_odds = null, home_team = null, away_team = null;
  if (espn_game_id) {
    const game = db.prepare(
      `SELECT home_team, away_team, ml_home, ml_away, ou_over_odds, ou_under_odds FROM today_games WHERE espn_game_id = ?`
    ).get(espn_game_id);
    if (game) {
      home_team = game.home_team || null;
      away_team = game.away_team || null;
      const type = (pick_type || '').toLowerCase();
      const isHome = (game.home_team || '').toLowerCase() === (team || '').toLowerCase();
      if (type === 'ml')    ml_odds = isHome ? game.ml_home : game.ml_away;
      if (type === 'over')  ou_odds = game.ou_over_odds  ?? null;
      if (type === 'under') ou_odds = game.ou_under_odds ?? null;
    }
  }

  const exists = db.prepare(
    `SELECT id FROM mvp_picks WHERE team = ? AND game_date = ? AND pick_type = ?`
  ).get(team, game_date, pick_type ?? null);

  if (!exists) {
    db.prepare(`
      INSERT INTO mvp_picks (team, sport, pick_type, spread, game_date, espn_game_id, score, ml_odds, ou_odds, home_team, away_team)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(team, sport ?? null, pick_type ?? null, spread ?? null, game_date ?? null, espn_game_id, score, ml_odds, ou_odds, home_team, away_team);
  } else {
    db.prepare(`
      UPDATE mvp_picks
      SET score        = ?,
          espn_game_id = ?,
          ml_odds      = COALESCE(ml_odds, ?),
          ou_odds      = COALESCE(ou_odds, ?),
          home_team    = COALESCE(home_team, ?),
          away_team    = COALESCE(away_team, ?)
      WHERE team = ? AND game_date = ? AND pick_type = ?
    `).run(score, espn_game_id, ml_odds, ou_odds, home_team, away_team, team, game_date, pick_type ?? null);
  }
}

// ── Upsert pick into permanent archive when it first hits ≥35pts ─────────────
// Called live from updateSlot() + insertNewPick() — not at wipe time.
// INSERT OR IGNORE creates the row; UPDATE keeps score/count/messages fresh.
function upsertPickHistory(pick_id, scored) {
  const pick = db.prepare(`SELECT * FROM picks WHERE id = ?`).get(pick_id);
  if (!pick) return;

  const game = pick.espn_game_id
    ? db.prepare(`SELECT home_team, away_team, home_abbr, away_abbr, home_score, away_score FROM today_games WHERE espn_game_id = ?`)
        .get(pick.espn_game_id)
    : null;

  const msgs = db.prepare(
    `SELECT author, channel, message_text FROM raw_messages WHERE pick_id = ? ORDER BY id ASC`
  ).all(pick_id);

  const bd = scored.breakdown || {};

  try {
    db.prepare(`
      INSERT OR IGNORE INTO pick_history
        (pick_id, espn_game_id, sport, game_date,
         home_team, away_team, home_abbr, away_abbr,
         team, pick_type, spread, ml_odds, ou_odds, is_home_team,
         score, mention_count, channel, channel_points, sport_bonus, home_bonus,
         capper_name, messages_json, result, home_score, away_score, first_seen_at)
      VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?)
    `).run(
      pick.id,            pick.espn_game_id ?? null, pick.sport ?? null, pick.game_date ?? null,
      game?.home_team ?? null, game?.away_team ?? null, game?.home_abbr ?? null, game?.away_abbr ?? null,
      pick.team,          pick.pick_type ?? null, pick.spread ?? null,
      pick.original_ml ?? null, pick.original_ou ?? null, pick.is_home_team ?? 0,
      pick.score,         pick.mention_count ?? 1, pick.channel ?? null,
      bd.channel_points ?? null, bd.sport_bonus ?? null, bd.home_bonus ?? null,
      pick.capper_name ?? null, JSON.stringify(msgs), pick.result ?? 'pending',
      game?.home_score ?? null, game?.away_score ?? null, pick.parsed_at ?? null
    );
    // Refresh mutable fields — score/mention_count/messages change on each new mention
    db.prepare(`
      UPDATE pick_history
      SET score = ?, mention_count = ?, messages_json = ?,
          channel_points = ?, sport_bonus = ?, home_bonus = ?
      WHERE pick_id = ?
    `).run(
      pick.score, pick.mention_count ?? 1, JSON.stringify(msgs),
      bd.channel_points ?? null, bd.sport_bonus ?? null, bd.home_bonus ?? null,
      pick.id
    );
  } catch (_) {}
}

module.exports = { savePick };
