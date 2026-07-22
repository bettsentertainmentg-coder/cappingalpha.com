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
  // Native transport status: one boot line, so a prod deploy without the
  // Firebase project yet is visibly (and safely) web-push only.
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.log('[push] FIREBASE_SERVICE_ACCOUNT not set; native app push disabled (web push unaffected)');
  }
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
  // Allowlist the real browser push services so the server can't be pointed at an
  // arbitrary internal host (the send path POSTs to this URL — SSRF hardening).
  const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)mozilla\.com$/, /(^|\.)windows\.com$/, /(^|\.)apple\.com$/];
  if (!PUSH_HOSTS.some((re) => re.test(u.hostname)) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return false;
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

// ── Native app push (FCM) — second transport under the same topic gates ───────
// firebase-admin initializes lazily from FIREBASE_SERVICE_ACCOUNT: either a path
// to the service-account JSON file or the JSON itself inline. When the env var is
// absent (Jack has not created the Firebase project yet) every native send
// no-ops, so this is fully safe to deploy ahead of the Firebase setup.
let _fbMessaging = null;
let _fbTried = false;

function initFirebase() {
  if (_fbTried) return _fbMessaging;
  _fbTried = true;
  const src = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!src) return null;   // boot already logged the one-liner in init()
  try {
    // firebase-admin v14 is modular: app + messaging come from subpath exports.
    const { initializeApp, cert } = require('firebase-admin/app');
    const { getMessaging } = require('firebase-admin/messaging');
    const creds = src.startsWith('{')
      ? JSON.parse(src)
      : JSON.parse(require('fs').readFileSync(src, 'utf8'));
    const app = initializeApp({ credential: cert(creds) });
    _fbMessaging = getMessaging(app);
    console.log('[push] firebase-admin initialized; native app push enabled');
  } catch (e) {
    console.warn('[push] firebase-admin init failed; native app push disabled:', e.message);
    _fbMessaging = null;
  }
  return _fbMessaging;
}

// steam/swing land as heads-up alerts (Android channel importance is set
// client-side in native.js; the per-message priority rides along here).
const HIGH_PRIORITY_TOPICS = new Set(['steam', 'swing']);

// Send one payload to a batch of FCM tokens. The data{} map mirrors the
// web-push payload (type, url, plus ids) so a native tap and a sw.js
// notification click share semantics. Tokens FCM reports dead or malformed
// self-prune, exactly like the web-push 404/410 prune.
async function sendToFcmTokens(tokens, payload) {
  const messaging = initFirebase();
  if (!messaging || !Array.isArray(tokens) || !tokens.length) return;
  const data = {};
  for (const k of ['type', 'url', 'tag', 'espn_game_id']) {
    if (payload[k] != null) data[k] = String(payload[k]);
  }
  const high = HIGH_PRIORITY_TOPICS.has(payload.type || '');
  const message = {
    tokens,
    notification: { title: payload.title || 'CappingAlpha', body: payload.body || '' },
    data,
    android: {
      priority: high ? 'high' : 'normal',
      notification: { channelId: payload.type ? `ca_${payload.type}` : 'ca_default' },
    },
    apns: {
      headers: { 'apns-priority': high ? '10' : '5' },
      payload: { aps: { alert: { title: payload.title || 'CappingAlpha', body: payload.body || '' }, sound: 'default' } },
    },
  };
  try {
    const res = await messaging.sendEachForMulticast(message);
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-argument') {
        try { db.prepare(`DELETE FROM push_devices WHERE fcm_token = ?`).run(tokens[i]); } catch (_) {}
      }
    });
  } catch (_) { /* a delivery failure must never break the caller */ }
}

// Register/refresh a device token. Reassignment on conflict is deliberate: a
// shared phone that signs into a second account delivers to its current owner,
// mirroring the web-push endpoint upsert.
function saveDevice(userId, body) {
  const { fcm_token, platform, app_version } = body || {};
  if (typeof fcm_token !== 'string') return false;
  const token = fcm_token.trim();
  if (!token || token.length >= 512 || /\s/.test(token)) return false;
  const plat = (platform === 'ios' || platform === 'android') ? platform : null;
  const ver = typeof app_version === 'string' ? app_version.slice(0, 32) : null;
  db.prepare(`
    INSERT INTO push_devices (user_id, platform, fcm_token, app_version, last_seen)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(fcm_token) DO UPDATE SET
      user_id = excluded.user_id, platform = excluded.platform,
      app_version = excluded.app_version, last_seen = datetime('now')
  `).run(userId, plat, token, ver);
  // Cap devices per user (newest win) — same flood guard as web subscriptions.
  db.prepare(`
    DELETE FROM push_devices WHERE user_id = ? AND id NOT IN
      (SELECT id FROM push_devices WHERE user_id = ? ORDER BY id DESC LIMIT 10)
  `).run(userId, userId);
  return true;
}

function removeDevice(userId, fcmToken) {
  if (typeof fcmToken !== 'string' || !fcmToken) return;
  db.prepare(`DELETE FROM push_devices WHERE user_id = ? AND fcm_token = ?`).run(userId, fcmToken);
}

// ── Quiet hours ───────────────────────────────────────────────────────────────
// notify_prefs.quiet = { start: 'HH:MM', end: 'HH:MM', tz: 'America/Chicago' }.
// While the user's local time sits inside [start, end) — windows may span
// midnight — nothing is delivered on any transport. The sendOnce dedupe row
// still lands first, so a quiet-hours alert is skipped, not queued for later.
function inQuietHours(prefs) {
  const q = prefs && prefs.quiet;
  if (!q || typeof q !== 'object') return false;
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!HHMM.test(q.start || '') || !HHMM.test(q.end || '') || q.start === q.end) return false;
  let now;
  try {
    now = new Intl.DateTimeFormat('en-GB', {
      timeZone: q.tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date());
  } catch (_) { return false; }   // unknown tz = fail open (deliver)
  return q.start < q.end
    ? (now >= q.start && now < q.end)
    : (now >= q.start || now < q.end);
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
  social_follow: { paid: false, label: 'New followers',    desc: 'When a member starts following you.' },
  social_tail:   { paid: false, label: 'Tails on your picks', desc: 'When a member tails one of your picks.' },
  account:       { paid: false, label: 'Account and trial', desc: 'A reminder before your trial or current period renews, plus subscription notices.' },
};

// Delivery-channel preference keys stored alongside topics in notify_prefs.
// Web push is per-device (the subscription itself is the opt-in), so it has no
// pref key. channel_email = the user wants email delivery once the email
// sender ships; nothing reads it yet, it just persists the opt-in.
// channel_apppush = native app push to the user's registered devices (absent =
// on; the device-level permission prompt was already the opt-in).
const CHANNEL_PREF_KEYS = ['channel_email', 'channel_apppush'];

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

function getNotifyPrefs(userId) {
  try {
    const row = db.prepare(`SELECT notify_prefs FROM user_preferences WHERE user_id = ?`).get(userId);
    return row && row.notify_prefs ? JSON.parse(row.notify_prefs) : {};
  } catch (_) { return {}; }
}

function userWantsTopic(userId, topic) {
  const def = TOPICS[topic];
  if (!def) return false;
  if (def.paid && !isPaidUserId(userId)) return false;
  return getNotifyPrefs(userId)[topic] !== false;   // absent = on
}

// The single delivery gate. Everything above the transport fork — paid topic,
// notify_prefs, quiet hours, and the sendOnce dedupe in the caller — applies to
// ALL devices, so a user with a browser subscription and a phone token gets one
// logical send fanned out to every device. Returns false when gated/skipped.
async function sendToUserTopic(userId, topic, payload) {
  if (!userWantsTopic(userId, topic)) return false;
  const prefs = getNotifyPrefs(userId);
  if (inQuietHours(prefs)) return false;
  // type rides in the payload so a sw.js notification click and a native tap
  // route identically (data.type -> in-app navigation, data.url as fallback).
  const body = { ...payload, type: payload.type || topic };
  await sendToUser(userId, body);
  // Native fork: same logical send, second transport. channel_apppush (absent
  // = on) is the account-level phone opt-out, alongside channel_email.
  if (prefs.channel_apppush !== false) {
    try {
      const tokens = db.prepare(`SELECT fcm_token FROM push_devices WHERE user_id = ?`).all(userId).map(r => r.fcm_token);
      await sendToFcmTokens(tokens, body);
    } catch (_) {}
  }
  return true;
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
  saveDevice, removeDevice, sendToFcmTokens, inQuietHours,
  TOPICS, CHANNEL_PREF_KEYS, userWantsTopic, sendToUserTopic, sendOnce, subscribedUserIds, isPaidUserId,
};
