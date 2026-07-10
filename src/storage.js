// src/storage.js
// Handles all DB writes for picks.
// Finds the pre-seeded slot for each incoming pick and adds points to it.
// Lines are never overwritten — they come from the 6am seed.

const db            = require('./db');
const { scorePick } = require('./scoring');
const { isPickAcceptable, logLatePick } = require('./pick_cutoff');
const { cycleDateForInstant } = require('./cycle');

// ── Line capture at the archive threshold ────────────────────────────────────
// Read the DraftKings line (from the free book_lines feed) for the side the capper
// picked, and lock it as "the line" the moment a pick qualifies.
// IMPORTANT: this is the PREGAME line. book_lines only ever holds the pregame close
// (ESPN drops odds once a game is 'in', and the write is null-guarded so nothing
// updates during a live game), so if a pick first crosses threshold after the game
// starts, this captures the frozen pregame close — NOT a live in-game price. There is
// no live line source; line_captured_at records exactly when this snapshot was taken.
function liveDkForSide(espn_game_id, team, pick_type) {
  const empty = { ml: null, spread: null, total: null, ou_odds: null };
  if (!espn_game_id) return empty;
  // Source the canonical today_games line (5am-seeded before T-90, the locked T-90
  // snapshot after) so a pick's captured line always matches the CA official line that
  // the rankings + grading use. The T-90 lock (src/ca_line.js) overwrites captured_*
  // on this pick anyway; this keeps a late-archiving pick consistent with an
  // already-locked game.
  const game = db.prepare(
    `SELECT home_team, ml_home, ml_away, spread_home, spread_away, over_under, ou_over_odds, ou_under_odds
     FROM today_games WHERE espn_game_id = ?`
  ).get(espn_game_id);
  if (!game) return empty;
  const isHome = (game.home_team || '').toLowerCase() === (team || '').toLowerCase();
  const type = (pick_type || '').toLowerCase();
  return {
    ml:      type === 'ml'      ? (isHome ? game.ml_home : game.ml_away)         : null,
    spread:  type === 'spread'  ? (isHome ? game.spread_home : game.spread_away) : null,
    total:   (type === 'over' || type === 'under') ? game.over_under             : null,
    ou_odds: type === 'over'    ? game.ou_over_odds : type === 'under' ? game.ou_under_odds : null,
  };
}

// Capture the DK line ONCE, the first time a pick crosses the archive threshold, and lock
// it onto the picks row (this is the pregame close — see liveDkForSide; no live line
// exists). Later mentions return the already-locked line so MVP + pick_history all use the
// same number. Returns { ml, spread, total, ou_odds, at }.
function captureLineAtThreshold(pick_id, espn_game_id, team, pick_type) {
  const row = db.prepare(
    `SELECT captured_ml, captured_spread, captured_total, captured_ou_odds, line_captured_at FROM picks WHERE id = ?`
  ).get(pick_id);
  if (row && row.line_captured_at) {
    return { ml: row.captured_ml, spread: row.captured_spread, total: row.captured_total, ou_odds: row.captured_ou_odds, at: row.line_captured_at };
  }
  const line = liveDkForSide(espn_game_id, team, pick_type);
  const at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(
    `UPDATE picks SET captured_ml = ?, captured_spread = ?, captured_total = ?, captured_ou_odds = ?, line_captured_at = ? WHERE id = ?`
  ).run(line.ml, line.spread, line.total, line.ou_odds, at, pick_id);
  return { ...line, at };
}

// ── Capper name normalization + alias resolution ──────────────────────────────
function normalizeCapper(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Ensure a canonical capper exists in the cross-source registry. Cheap
// INSERT OR IGNORE; failures must never break the pick pipeline.
function ensureRegistered(canonicalName, source = 'discord', handle = null) {
  if (!canonicalName) return;
  try {
    db.prepare(`INSERT OR IGNORE INTO capper_registry (canonical_name) VALUES (?)`).run(canonicalName);
    db.prepare(`INSERT OR IGNORE INTO capper_source_handles (source, handle, canonical_name) VALUES (?, ?, ?)`)
      .run(source, handle ?? canonicalName, canonicalName);
  } catch (_) {}
}

// Returns { name, matched }: name is canonical if an alias or registry handle hit,
// raw otherwise. `matched` is 1 when the name was already known, 0 for fresh cappers.
function resolveCapperName(raw, source = 'discord') {
  if (!raw) return { name: raw, matched: 0 };
  const norm = normalizeCapper(raw);
  try {
    const alias = db.prepare(
      `SELECT canonical_name FROM capper_aliases WHERE LOWER(REPLACE(REPLACE(REPLACE(alias,' ',''),'_',''),'-','')) = ? LIMIT 1`
    ).get(norm);
    if (alias) { ensureRegistered(alias.canonical_name, source, raw); return { name: alias.canonical_name, matched: 1 }; }
    // Registry handles layer (cross-source identity — same lookup, any source)
    const handle = db.prepare(
      `SELECT canonical_name FROM capper_source_handles
       WHERE source = ? AND LOWER(REPLACE(REPLACE(REPLACE(handle,' ',''),'_',''),'-','')) = ? LIMIT 1`
    ).get(source, norm);
    if (handle) return { name: handle.canonical_name, matched: 1 };
    ensureRegistered(raw, source, raw);
    return { name: raw, matched: 0 };
  } catch (_) {
    return { name: raw, matched: 0 };
  }
}

// ── Golf pick handler ─────────────────────────────────────────────────────────
function saveGolfPick(pick) {
  const { team, pick_type, vs_player, spread_value, channel, capper_name, sport_record, raw_message } = pick;
  const { name: resolvedCapper, matched: capperMatched } = resolveCapperName(capper_name);
  pick._capperResolved = resolvedCapper;
  pick._capperMatched  = capperMatched;
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
  archiveRawMessage(golf_pick_id, pick, 'discord-golf');
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

// ── Find slot using team name (picked_side from AI is unreliable for home/away) ─
function findSlotWithSide(pick, game, _picked_side) {
  const isTotal = pick.pick_type === 'over' || pick.pick_type === 'under';
  if (isTotal) {
    return db.prepare(`SELECT * FROM picks WHERE espn_game_id = ? AND pick_type = ? LIMIT 1`)
      .get(game.espn_game_id, pick.pick_type);
  }
  // Trust the team name — AI's picked_side guess is often wrong (e.g. home team tagged as away)
  const canonicalTeam = getCanonicalTeam(game, pick.team);
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
  // Partial-game picks (F5 / first half / quarters) have no slot on the
  // full-game board — quarantine them so they never contaminate a full-game
  // line. Logged to skipped_messages (reason 'period_market') so a future
  // partial-game board can rescan them.
  if (pick.period) {
    logPeriodPick(pick);
    return null;
  }

  // Golf picks go to a separate table — never wiped, tournament-scoped
  if ((pick.sport || '').toLowerCase() === 'golf') {
    return saveGolfPick(pick);
  }

  const { team, espn_game_id: aiGameId, picked_side } = pick;

  // 1. If Haiku identified the game directly, use it — no fuzzy matching needed
  if (aiGameId) {
    const game = db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(aiGameId);
    if (game) {
      if (!isPickAcceptable(game)) {
        console.log(`[storage] late pick rejected (>5min past actual start) for ${team} in game ${aiGameId}`);
        logLatePick(pick);
        return null;
      }
      // Attribute the pick to the GAME's cycle date, not the posting date — so an
      // overnight pick for tomorrow's game rides along with that game.
      if (game.start_time) pick.game_date = cycleDateForInstant(game.start_time) ?? pick.game_date;
      const slot = findSlotWithSide(pick, game, picked_side);
      if (slot) return updateSlot(slot, pick);
      return insertNewPick({ ...pick, espn_game_id: aiGameId });
    }
  }

  // 2. Fallback: fuzzy match by team name
  const game = findTodayGame(team);
  if (game && !isPickAcceptable(game)) {
    console.log(`[storage] late pick rejected (>5min past actual start) for ${team} in game ${game.espn_game_id}`);
    logLatePick(pick);
    return null;
  }
  if (game?.start_time) pick.game_date = cycleDateForInstant(game.start_time) ?? pick.game_date;
  const slot = game ? findSlot(pick, game) : null;
  if (slot) return updateSlot(slot, pick);

  return insertNewPick({ ...pick, espn_game_id: game?.espn_game_id ?? pick.espn_game_id ?? null });
}

// A partial-game pick arrived (period F5/1H/other). Record the message so the
// pick is recoverable once partial-game markets are supported on the board.
function logPeriodPick(pick) {
  console.log(`[storage] period pick quarantined (${pick.period}): ${pick.team} ${pick.pick_type ?? ''} ${pick.spread_value ?? ''}`.trim());
  const rm = pick.raw_message;
  if (!rm?.id) return;
  try {
    db.prepare(`
      INSERT OR IGNORE INTO skipped_messages (message_id, channel, author, content, reason)
      VALUES (?, ?, ?, ?, ?)
    `).run(String(rm.id), pick.channel || 'unknown', rm.author || null, rm.content || '', 'period_market');
  } catch (e) {
    console.error('[storage] logPeriodPick failed:', e.message);
  }
}

// ── Update a pre-seeded slot with a new mention ───────────────────────────────
function updateSlot(slot, pick) {
  const { channel, sport_record, raw_message } = pick;
  const { name: capper_name, matched: capperMatched } = resolveCapperName(pick.capper_name, pick.source_scope || 'discord');
  pick._capperResolved = capper_name;
  pick._capperMatched  = capperMatched;

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

  // v3 dual logging: compute the v3 component vector alongside v2 on every
  // mention. Lazy require avoids a startup cycle; failures never break scoring.
  let v3 = null;
  try { v3 = require('./scoring_v3').computeAndLogV3(slot.id); } catch (_) {}
  const v3Live = db.getSetting('scoring_version', 'v2') === 'v3';

  // Thresholds by active scale: v2 uses 35/MVP-50; v3 archives at 50 (every pick
  // worth 50pts+ is tracked in pick_history) and GOLD 100 with the totals gate
  // (only gold is tracked long-term).
  const archives = v3Live ? (v3 && v3.total >= 50) : scored.total >= 35;
  const isMvp    = v3Live ? !!(v3 && v3.total >= 100 && v3.breakdown.totals_gate_ok !== false) : scored.is_mvp;
  const effTotal = v3Live && v3 ? v3.total : scored.total;

  // CA official line — gold trigger: a pick reaching GOLD locks its game's line to the
  // market right now (the other trigger is the T-90 cron). Runs BEFORE the capture so
  // the captured line is the gold-moment line. No-ops if the game already locked (T-90).
  if (isMvp) { try { require('./ca_line').lockCaLineOnGold(slot.espn_game_id); } catch (_) {} }

  // Capture the pick's line from the canonical today_games line (the CA official line
  // once locked; the 5am placeholder before).
  const cap = archives
    ? captureLineAtThreshold(slot.id, slot.espn_game_id, slot.team, slot.pick_type)
    : null;

  if (isMvp) {
    saveMvpPick({
      team:        slot.team,
      sport:       slot.sport,
      pick_type:   slot.pick_type,
      spread:      slot.spread,
      game_date:   slot.game_date,
      espn_game_id: slot.espn_game_id,
      score:       effTotal,
      cap,
      scale:       v3Live ? 'v3' : 'v2',
    });
  }

  if (archives) {
    upsertPickHistory(slot.id, scored, cap, v3Live ? 'v3' : 'v2');
    // The archive row may not have existed when computeAndLogV3 ran above —
    // mirror the v3 total now that it does (calibration series lives here).
    if (v3 && v3.total != null) {
      try { db.prepare(`UPDATE pick_history SET v3_total = ? WHERE pick_id = ?`).run(v3.total, slot.id); } catch (_) {}
    }
  }

  return slot.id;
}

// ── Fallback insert for picks with no matching today_games entry ──────────────
function insertNewPick(pick) {
  const {
    team, sport, pick_type, spread_value, channel,
    is_home_team, game_date, sport_record,
    raw_message, espn_game_id = null,
  } = pick;
  const { name: capper_name, matched: capperMatched } = resolveCapperName(pick.capper_name, pick.source_scope || 'discord');
  pick._capperResolved = capper_name;
  pick._capperMatched  = capperMatched;

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
  let v3 = null;
  try { v3 = require('./scoring_v3').computeAndLogV3(pick_id); } catch (_) {}
  const v3Live = db.getSetting('scoring_version', 'v2') === 'v3';

  const archives = v3Live ? (v3 && v3.total >= 50) : scored.total >= 35;
  const isMvp    = v3Live ? !!(v3 && v3.total >= 100 && v3.breakdown.totals_gate_ok !== false) : scored.is_mvp;
  const effTotal = v3Live && v3 ? v3.total : scored.total;

  // CA official line — gold trigger (see updateSlot): lock the game's line the moment
  // this pick reaches gold, before capturing so cap is the gold-moment line.
  if (isMvp) { try { require('./ca_line').lockCaLineOnGold(espn_game_id); } catch (_) {} }

  const cap = archives
    ? captureLineAtThreshold(pick_id, espn_game_id, team, pick_type)
    : null;

  if (isMvp) {
    saveMvpPick({ team, sport, pick_type, spread, game_date, espn_game_id, score: effTotal, cap, scale: v3Live ? 'v3' : 'v2' });
  }

  if (archives) {
    upsertPickHistory(pick_id, scored, cap, v3Live ? 'v3' : 'v2');
    if (v3 && v3.total != null) {
      try { db.prepare(`UPDATE pick_history SET v3_total = ? WHERE pick_id = ?`).run(v3.total, pick_id); } catch (_) {}
    }
  }

  return pick_id;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function saveRawMessage(pick_id, pick) {
  const { channel, raw_message } = pick;
  if (!raw_message) return;
  db.prepare(`
    INSERT OR IGNORE INTO raw_messages
      (pick_id, channel, message_text, author, message_timestamp, message_id, capper_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    pick_id,
    channel                 ?? null,
    raw_message.content     ?? null,
    raw_message.author      ?? null,
    raw_message.createdAt ? new Date(raw_message.createdAt).toISOString() : null,
    raw_message.id          ?? null,
    pick._capperResolved    ?? pick.capper_name ?? null
  );
  archiveRawMessage(pick_id, pick, pick.source_scope || 'discord');
}

// Mirror writes into the 7-day audit archive so we can debug capper extraction
// after the daily wipe blanks raw_messages. Failures here must never break the
// scan pipeline — the archive is a side log, not a critical path.
function archiveRawMessage(pick_id, pick, source) {
  const { channel, raw_message } = pick;
  if (!raw_message) return;
  try {
    db.prepare(`
      INSERT OR IGNORE INTO raw_messages_archive
        (message_id, channel, author, message_text, message_timestamp,
         source, pick_id, pick_team, pick_type, pick_sport,
         capper_raw, capper_name, capper_matched)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      raw_message.id          ?? null,
      channel                 ?? null,
      raw_message.author      ?? null,
      raw_message.content     ?? null,
      raw_message.createdAt ? new Date(raw_message.createdAt).toISOString() : null,
      source                  ?? 'discord',
      pick_id,
      pick.team               ?? null,
      pick.pick_type          ?? null,
      pick.sport              ?? null,
      pick.capper_name        ?? null,
      pick._capperResolved    ?? pick.capper_name ?? null,
      pick._capperMatched     ?? null,
    );
  } catch (err) {
    console.warn('[storage] archiveRawMessage failed:', err.message);
  }
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

function saveMvpPick({ team, sport, pick_type, spread, game_date, espn_game_id = null, score, cap = null, scale = 'v2' }) {
  // today_games gives team names + the opening line (used as a fallback only).
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
  // Prefer the live line locked the moment the pick crossed 35 (Jack: that's THE tracked
  // line, on the graph + MVP). Fall back to the today_games opening line if the free DK
  // feed had nothing at capture time.
  if (cap) {
    if (cap.ml != null)      ml_odds = cap.ml;
    if (cap.ou_odds != null) ou_odds = cap.ou_odds;
  }
  const capSpread = cap ? cap.spread : null;
  const capTotal  = cap ? cap.total  : null;
  const capAt     = cap ? cap.at     : null;

  const exists = db.prepare(
    `SELECT id FROM mvp_picks WHERE team = ? AND game_date = ? AND pick_type = ?`
  ).get(team, game_date, pick_type ?? null);

  if (!exists) {
    db.prepare(`
      INSERT INTO mvp_picks (team, sport, pick_type, spread, game_date, espn_game_id, score, ml_odds, ou_odds, home_team, away_team, captured_spread, captured_total, line_captured_at, scale_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(team, sport ?? null, pick_type ?? null, spread ?? null, game_date ?? null, espn_game_id, score, ml_odds, ou_odds, home_team, away_team, capSpread, capTotal, capAt, scale);
  } else {
    db.prepare(`
      UPDATE mvp_picks
      SET score        = ?,
          espn_game_id = ?,
          ml_odds      = COALESCE(ml_odds, ?),
          ou_odds      = COALESCE(ou_odds, ?),
          home_team    = COALESCE(home_team, ?),
          away_team    = COALESCE(away_team, ?),
          captured_spread  = COALESCE(captured_spread, ?),
          captured_total   = COALESCE(captured_total, ?),
          line_captured_at = COALESCE(line_captured_at, ?)
      WHERE team = ? AND game_date = ? AND pick_type = ?
    `).run(score, espn_game_id, ml_odds, ou_odds, home_team, away_team, capSpread, capTotal, capAt, team, game_date, pick_type ?? null);
  }
}

// ── Upsert pick into permanent archive when it crosses the archive bar ───────
// (v3: 50pts+, v2: 35pts+). Called live from updateSlot() + insertNewPick() —
// not at wipe time. The caller gates on `archives`; this writer is not gated.
// INSERT OR IGNORE creates the row; UPDATE keeps score/count/messages fresh.
function upsertPickHistory(pick_id, scored, cap = null, scale = 'v2') {
  const pick = db.prepare(`SELECT * FROM picks WHERE id = ?`).get(pick_id);
  if (!pick) return;

  const game = pick.espn_game_id
    ? db.prepare(`SELECT home_team, away_team, home_abbr, away_abbr, home_score, away_score FROM today_games WHERE espn_game_id = ?`)
        .get(pick.espn_game_id)
    : null;

  const msgs = db.prepare(
    `SELECT author, channel, message_text, capper_name FROM raw_messages WHERE pick_id = ? ORDER BY id ASC`
  ).all(pick_id);

  const bd = scored.breakdown || {};

  try {
    db.prepare(`
      INSERT OR IGNORE INTO pick_history
        (pick_id, espn_game_id, sport, game_date,
         home_team, away_team, home_abbr, away_abbr,
         team, pick_type, spread, ml_odds, ou_odds, is_home_team,
         score, mention_count, channel, channel_points, sport_bonus, home_bonus,
         capper_name, messages_json, result, home_score, away_score, first_seen_at,
         live_ml, live_spread, live_total, live_ou_odds, line_captured_at, scale_version)
      VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?)
    `).run(
      pick.id,            pick.espn_game_id ?? null, pick.sport ?? null, pick.game_date ?? null,
      game?.home_team ?? null, game?.away_team ?? null, game?.home_abbr ?? null, game?.away_abbr ?? null,
      pick.team,          pick.pick_type ?? null, pick.spread ?? null,
      pick.original_ml ?? null, pick.original_ou ?? null, pick.is_home_team ?? 0,
      pick.score,         pick.mention_count ?? 1, pick.channel ?? null,
      bd.channel_points ?? null, bd.sport_bonus ?? null, bd.home_bonus ?? null,
      pick.capper_name ?? null, JSON.stringify(msgs), pick.result ?? 'pending',
      game?.home_score ?? null, game?.away_score ?? null, pick.parsed_at ?? null,
      cap?.ml ?? null, cap?.spread ?? null, cap?.total ?? null, cap?.ou_odds ?? null, cap?.at ?? null, scale
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

module.exports = { savePick, normalizeCapper, resolveCapperName, ensureRegistered, captureLineAtThreshold, liveDkForSide, saveMvpPick, upsertPickHistory };
