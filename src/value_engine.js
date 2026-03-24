// src/value_engine.js — Composite pick scoring engine
// Tune weights by adjusting the WEIGHTS constants below

const db = require('./db');
const { parseSportRecord } = require('./discord_scanner');

// ── Scoring weights (adjust these to tune the engine) ─────────────────────────
const WEIGHTS = {
  FREE_PLAYS_BASE:        40,   // base score for picks from free-plays channel
  POD_BASE:               30,   // base score for picks from pod-thread channel
  COMMUNITY_BASE:         15,   // base score for picks from community-leaks channel
  SPORT_RECORD_MAX:       30,   // max points from capper's sport record (win rate * 30)
  MENTION_BONUS:          10,   // points per additional mention
  MENTION_MAX:            30,   // cap on total mention bonus
  BOTH_CHANNELS_BONUS:    25,   // bonus if same pick appears in both channels
  RECORD_TRUST_COMMUNITY: 0.5,  // community records worth 50% vs free-plays records
  HOT_SCORE_THRESH:       70,   // minimum score for HOT_PICK alert
  HOT_HOURS_WINDOW:       2,    // hours before game for HOT_PICK alert
};

// ── Parse win rate from sport_record string e.g. "27-21 CBB" ─────────────────
function winRateFromRecord(sportRecord) {
  if (!sportRecord) return null;
  const rec = parseSportRecord(sportRecord);
  if (!rec) return null;
  const total = rec.wins + rec.losses;
  return total > 0 ? rec.wins / total : null;
}

// ── Check if same pick (team+pick_type) exists in both channels ───────────────
function existsInBothChannels(pick) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT channel) as ch_count
    FROM picks
    WHERE team = ? AND pick_type = ?
      AND parsed_at >= datetime('now', '-30 hours')
  `).get(pick.team, pick.pick_type || '');
  return (row?.ch_count ?? 0) >= 2;
}

// ── Score a single pick — returns breakdown object ────────────────────────────
function scorePick(pick) {
  // 1. Base score from channel
  const isFreePlays = pick.channel === 'free-plays';
  const isPod       = pick.channel === 'pod-thread';
  const base = isFreePlays ? WEIGHTS.FREE_PLAYS_BASE
             : isPod       ? WEIGHTS.POD_BASE
             :               WEIGHTS.COMMUNITY_BASE;

  // 2. Sport record component
  const winRate = winRateFromRecord(pick.sport_record);
  let record_bonus = 0;
  if (winRate !== null) {
    record_bonus = winRate * WEIGHTS.SPORT_RECORD_MAX;
    if (!isFreePlays && !isPod) record_bonus *= WEIGHTS.RECORD_TRUST_COMMUNITY;
    record_bonus = Math.round(record_bonus * 10) / 10;
  }

  // 3. Mention bonus (per extra mention beyond the first, capped)
  const extraMentions = Math.max(0, (pick.mention_count || 1) - 1);
  const mention_bonus = Math.min(extraMentions * WEIGHTS.MENTION_BONUS, WEIGHTS.MENTION_MAX);

  // 4. Both channels bonus
  const both_channels_bonus = existsInBothChannels(pick) ? WEIGHTS.BOTH_CHANNELS_BONUS : 0;

  const total = Math.round((base + record_bonus + mention_bonus + both_channels_bonus) * 10) / 10;

  return {
    total,
    base,
    record_bonus,
    mention_bonus,
    both_channels_bonus,
    capper_name: pick.capper_name || null,
    sport_record: pick.sport_record || null,
  };
}

// ── Update score for a single pick in DB ─────────────────────────────────────
function updateScore(pickId) {
  const pick = db.prepare(`SELECT * FROM picks WHERE id = ?`).get(pickId);
  if (!pick) return;
  const breakdown = scorePick(pick);
  db.prepare(`UPDATE picks SET score = ?, score_breakdown = ? WHERE id = ?`)
    .run(breakdown.total, JSON.stringify(breakdown), pickId);
  return breakdown.total;
}

// ── Recalculate scores for all picks in the last 30 hours ────────────────────
function recalculateToday() {
  const picks = db.prepare(`
    SELECT id FROM picks WHERE parsed_at >= datetime('now', '-30 hours')
  `).all();
  for (const { id } of picks) updateScore(id);
  console.log(`[CappperBoss:value] Recalculated ${picks.length} picks (30h window)`);
}

// ── Get ranked picks from the last 30 hours, ordered by score ─────────────────
function getRankedPicks() {
  const picks = db.prepare(`
    SELECT * FROM picks
    WHERE parsed_at >= datetime('now', '-30 hours')
    ORDER BY score DESC
  `).all();

  return picks.map(p => {
    const breakdown = scorePick(p);
    return {
      ...p,
      score: breakdown.total,
      score_breakdown: breakdown,
    };
  }).sort((a, b) => b.score - a.score);
}

module.exports = { scorePick, updateScore, recalculateToday, getRankedPicks, WEIGHTS };
