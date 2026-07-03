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

module.exports = { init, getPublicKey, saveSubscription, removeSubscription, sendToUser };
