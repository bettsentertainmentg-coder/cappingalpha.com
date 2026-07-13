// src/push.js — free web push (VAPID) for bet-grade alerts.
//
// Zero marginal cost by design: browsers deliver notifications through Apple's and
// Google's own push endpoints for free; web-push just signs the requests. VAPID
// keys are generated once on first boot and persist in the settings table, so no
// manual env setup is needed. If the web-push dep is ever missing, everything here
// silently no-ops rather than taking the server down.

const db = require('./db');

let webpush = null;
try { webpush = require('web-push'); } catch (_) { /* not installed -> push disabled */ }

let publicKey = null;

function init() {
  if (!webpush) { console.log('[push] web-push not installed; push disabled'); return; }
  let pub  = db.getSetting('vapid_public');
  let priv = db.getSetting('vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey; priv = keys.privateKey;
    db.setSetting('vapid_public', pub);
    db.setSetting('vapid_private', priv);
    console.log('[push] generated VAPID keys (stored in settings)');
  }
  webpush.setVapidDetails('mailto:support@cappingalpha.com', pub, priv);
  publicKey = pub;
}

function getPublicKey() { return publicKey; }

function saveSubscription(userId, sub) {
  if (!sub || !sub.endpoint || typeof sub.endpoint !== 'string' || sub.endpoint.length > 600) return false;
  // Real push endpoints are always https URLs from the browser vendors; reject
  // anything else so the table can't be seeded with junk or odd schemes.
  let u;
  try { u = new URL(sub.endpoint); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, keys_json) VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json
  `).run(userId, sub.endpoint, JSON.stringify(sub.keys || {}));
  // Cap devices per user (newest win) so a scripted caller can't flood the table.
  db.prepare(`
    DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN
      (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 10)
  `).run(userId, userId);
  return true;
}

function removeSubscription(userId, endpoint) {
  db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`).run(userId, endpoint);
}

// Send to every device a user has enabled. Dead endpoints (404/410) self-prune.
async function sendToUser(userId, payload) {
  if (!webpush || !publicKey) return;
  const rows = db.prepare(`SELECT id, endpoint, keys_json FROM push_subscriptions WHERE user_id = ?`).all(userId);
  if (!rows.length) return;
  const body = JSON.stringify(payload);
  for (const r of rows) {
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: JSON.parse(r.keys_json || '{}') }, body);
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) {
        db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(r.id);
      }
    }
  }
}

// ── Notification topics (preference center) ───────────────────────────────────
// Every send routes through sendToUserTopic so the user's per-topic preference
// (user_preferences.notify_prefs JSON) and the paid-tier gate are enforced in
// ONE place. Unset preference = ON: the device-level push subscription is
// already opt-in, so topics are opt-out refinements on top of it.
const TOPICS = {
  grades:     { paid: false, label: 'Bet and pick grades', desc: 'A ping when your tracked bets and voted picks grade.' },
  game_start: { paid: false, label: 'Your game is live',   desc: 'When a game you bet or voted on starts.' },
  top_pick:   { paid: false, label: "Today's #1 pick",     desc: 'Once a day when the top-ranked pick is up.' },
  steam:      { paid: true,  label: 'Line steam',          desc: 'A sharp line move on a game carrying a CA pick.' },
  swing:      { paid: true,  label: 'Live swings',         desc: 'Lead changes in games where you have action.' },
};

// Delivery-channel preference keys stored alongside topics in notify_prefs.
// Web push is per-device (the subscription itself is the opt-in), so it has no
// pref key. channel_email = the user wants email delivery once the email
// sender ships; nothing reads it yet, it just persists the opt-in.
const CHANNEL_PREF_KEYS = ['channel_email'];

// DB-level paid check (no req/session here). Mirrors auth.isPaid: tier not
// 'free' + unexpired (null expiry = lifetime, unparseable fails open).
function isPaidUserId(userId) {
  try {
    const row = db.prepare(`SELECT subscription_tier, subscription_expires FROM users WHERE id = ?`).get(userId);
    if (!row || row.subscription_tier === 'free') return false;
    if (!row.subscription_expires) return true;
    const exp = Date.parse(row.subscription_expires);
    return isNaN(exp) ? true : exp > Date.now();
  } catch (_) { return false; }
}

function userWantsTopic(userId, topic) {
  const def = TOPICS[topic];
  if (!def) return false;
  if (def.paid && !isPaidUserId(userId)) return false;
  try {
    const row = db.prepare(`SELECT notify_prefs FROM user_preferences WHERE user_id = ?`).get(userId);
    const prefs = row && row.notify_prefs ? JSON.parse(row.notify_prefs) : {};
    return prefs[topic] !== false;   // absent = on
  } catch (_) { return true; }
}

async function sendToUserTopic(userId, topic, payload) {
  if (!userWantsTopic(userId, topic)) return;
  return sendToUser(userId, payload);
}

// Once-only send: dedupes on (user, topic, key) via push_log so a cron that
// re-observes the same event (a game still live, the same steam move) can call
// this every pass without double-notifying.
async function sendOnce(userId, topic, dedupeKey, payload) {
  try {
    const r = db.prepare(`INSERT OR IGNORE INTO push_log (user_id, topic, dedupe_key) VALUES (?, ?, ?)`)
      .run(userId, topic, String(dedupeKey));
    if (r.changes === 0) return false;   // already sent
  } catch (_) { return false; }
  await sendToUserTopic(userId, topic, payload);
  return true;
}

// Everyone holding a live device subscription (for broadcast-style topics).
function subscribedUserIds() {
  try {
    return db.prepare(`SELECT DISTINCT user_id FROM push_subscriptions`).all().map(r => r.user_id);
  } catch (_) { return []; }
}

module.exports = {
  init, getPublicKey, saveSubscription, removeSubscription, sendToUser,
  TOPICS, CHANNEL_PREF_KEYS, userWantsTopic, sendToUserTopic, sendOnce, subscribedUserIds, isPaidUserId,
};
