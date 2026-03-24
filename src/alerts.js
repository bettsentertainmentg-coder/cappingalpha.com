// src/alerts.js — Alert system for CappperBoss
// Triggers: SWING, LINE_MOVE, HOT_PICK, DUE

const db = require('./db');
const { WEIGHTS } = require('./value_engine');

let _osoNotify = null;
function setOSONotify(fn) { _osoNotify = fn; }

function sendAlert(message, gameId = null, alertType = 'GENERAL') {
  console.log(`[CappperBoss:alert] ${alertType}: ${message}`);

  db.prepare(`
    INSERT INTO alerts (game_id, alert_type, message, triggered_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(gameId, alertType, message);

  if (_osoNotify) {
    _osoNotify(`🎯 *CappperBoss Alert*\n${message}`).catch(e =>
      console.warn('[CappperBoss:alert] Notify failed:', e.message)
    );
  }
}

// ── SWING: 10+ point swing vs spread ─────────────────────────────────────────
function checkSwing(game, swingData) {
  sendAlert(
    `⚡ SWING: ${game.away_team} @ ${game.home_team}\n` +
    `Score: ${game.home_score}-${game.away_score} | Spread: ${game.spread}\n` +
    `Swing: ${swingData.swing.toFixed(1)} pts vs opening`,
    game.espn_game_id,
    'SWING'
  );
}

// ── LINE_MOVE: spread shifts 2+ pts since pick was recorded ──────────────────
function checkLineMove(pick, currentSpread) {
  if (pick.spread == null || currentSpread == null) return;
  const move = Math.abs(currentSpread - pick.spread);
  if (move < 2) return;

  const favorable = currentSpread < pick.spread;
  sendAlert(
    `📊 LINE MOVE: ${pick.team} (${pick.pick_type})\n` +
    `Opened: ${pick.spread > 0 ? '+' : ''}${pick.spread} → Now: ${currentSpread > 0 ? '+' : ''}${currentSpread}\n` +
    `Direction: ${favorable ? '✅ Favorable' : '⚠️ Against'}`,
    null,
    'LINE_MOVE'
  );
}

// ── HOT_PICK: score > threshold and game within 2 hours ──────────────────────
function checkHotPicks() {
  const { getRankedPicks } = require('./value_engine');
  const picks = getRankedPicks();
  const now = Date.now();
  const windowMs = WEIGHTS.HOT_HOURS_WINDOW * 60 * 60 * 1000;

  for (const pick of picks) {
    if (pick.score <= WEIGHTS.HOT_SCORE_THRESH) continue;
    const gameTime = new Date(pick.game_date).getTime();
    if (gameTime - now <= windowMs && gameTime > now) {
      sendAlert(
        `🔥 HOT PICK: ${pick.team} ${pick.pick_type || ''}\n` +
        `Score: ${pick.score} | Channel: ${pick.channel} | Mentions: ${pick.mention_count}`,
        null,
        'HOT_PICK'
      );
    }
  }
}

// ── DUE: opponent on scoring run, team has a ranked pick with score > 40 ──────
function checkDue(dueData, game) {
  if (!dueData?.is_due) return;

  const { getRankedPicks } = require('./value_engine');
  const picks = getRankedPicks();
  const teamLower = dueData.team.toLowerCase();

  const matchingPick = picks.find(p =>
    p.team.toLowerCase().includes(teamLower) && p.score > 40
  );
  if (!matchingPick) return;

  sendAlert(
    `🎯 DUE ALERT: ${dueData.team} is due — opponents on ${dueData.points_scored_against} unanswered.\n` +
    `Pick score: ${matchingPick.score}. Consider taking ${dueData.team} live.`,
    dueData.game_id,
    'DUE'
  );
}

// ── Get today's alerts ────────────────────────────────────────────────────────
function getTodayAlerts() {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT * FROM alerts
    WHERE date(triggered_at) = ?
    ORDER BY triggered_at DESC
  `).all(today);
}

module.exports = { sendAlert, checkSwing, checkLineMove, checkHotPicks, checkDue, getTodayAlerts, setOSONotify };
