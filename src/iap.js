// src/iap.js — Apple In-App Purchase (StoreKit 2). Direct, no RevenueCat, no Stripe in the app.
//
// Product IDs (exact):
//   com.cappingalpha.app.day   consumable              $1   24 hours from purchase
//   com.cappingalpha.app.week  auto-renewable sub      $5   1 week
//   com.cappingalpha.app.year  auto-renewable sub      $75  1 year
// Week + Year share subscription group "CappingAlpha Unlock". NO introductory offer.
//
// Jack checklist (App Store Connect — this code cannot click Connect):
//   1. Paid Apps agreement, banking, and tax forms (Agreements, Tax, and Banking).
//   2. In-App Purchase capability on App ID com.cappingalpha.app
//      (Xcode Signing & Capabilities → In-App Purchase). Do not add entitlement
//      keys by hand; Xcode owns App.entitlements.
//   3. Subscription group named "CappingAlpha Unlock".
//   4. Create the three products with the IDs and prices above.
//      Use $0.99 / $4.99 / $74.99 only if Apple has no whole-dollar point; prefer $1 / $5 / $75.
//   5. NO introductory offer on the weekly (3-day-free-to-start on $4/week is dead).
//   6. Sandbox tester Apple ID (Users and Access → Sandbox).
//   7. App Store Server Notifications V2 URL:
//        https://cappingalpha.com/api/iap/apple-notifications
//   8. Optional: App Store Connect API key as Railway env
//        APPSTORE_ISSUER_ID, APPSTORE_KEY_ID, APPSTORE_PRIVATE_KEY,
//        APPSTORE_BUNDLE_ID=com.cappingalpha.app
//      JWS verify of StoreKit 2 transactions works WITHOUT this key (x5c against
//      Apple Root CA G3). Notifications V2 payload is also JWS.
//   9. Local Xcode sandbox: Scheme → Run → Options → StoreKit Configuration →
//      Products.storekit. Xcode-signed JWS is accepted only locally, or when
//      APPLE_IAP_ALLOW_XCODE=1. Railway production rejects it unless that flag
//      is explicitly 1. Set APPLE_IAP_ALLOW_XCODE=0 to force-deny everywhere.
//
// Routes (mounted at /api/iap):
//   POST /verify              auth required  { jws }
//   POST /restore             auth required  { jws: [...] } or { transactions: [{ jws }] }
//   POST /apple-notifications no auth        { signedPayload }

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
function userOf(req) {
  if (typeof auth.userOf === 'function') return auth.userOf(req);
  return (req && req.bearerUser) || (req && req.session && req.session.user) || null;
}

const router = express.Router();

const BUNDLE_ID = process.env.APPSTORE_BUNDLE_ID || 'com.cappingalpha.app';
const PRODUCTS = {
  'com.cappingalpha.app.day':  { plan: 'day',  type: 'consumable' },
  'com.cappingalpha.app.week': { plan: 'week', type: 'auto-renewable' },
  'com.cappingalpha.app.year': { plan: 'year', type: 'auto-renewable' },
};
const ENVIRONMENTS = new Set(['Production', 'Sandbox', 'Xcode']);

// Apple Root CA - G3 (https://www.apple.com/certificateauthority/AppleRootCA-G3.cer)
// SHA-256 fingerprint 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;
const APPLE_ROOT_CA_G3_SHA256 = '63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179';

function allowXcode() {
  // Explicit 1/0 always wins. Otherwise Xcode-signed JWS is local-only.
  // Production (Railway) must not accept a self-signed environment=Xcode payload.
  if (process.env.APPLE_IAP_ALLOW_XCODE === '1') return true;
  if (process.env.APPLE_IAP_ALLOW_XCODE === '0') return false;
  return !process.env.RAILWAY_ENVIRONMENT && process.env.NODE_ENV !== 'production';
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function fp256(cert) {
  return String(cert.fingerprint256 || '').replace(/:/g, '').toUpperCase();
}

function verifyAgainstLeaf(jws, leaf, alg) {
  if (alg && alg !== 'ES256') throw new Error('unsupported alg ' + alg);
  const parts = jws.split('.');
  if (parts.length !== 3) throw new Error('invalid jws');
  const signed = Buffer.from(parts[0] + '.' + parts[1]);
  const sig = Buffer.from(parts[2], 'base64url');
  const ok = crypto.verify('sha256', signed, { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  if (!ok) throw new Error('jws signature invalid');
  return b64urlJson(parts[1]);
}

// Full x5c chain to Apple Root CA G3, then ES256 verify of the JWS.
async function verifyAppleJws(jws) {
  if (typeof jws !== 'string') throw new Error('invalid jws');
  const parts = jws.split('.');
  if (parts.length !== 3) throw new Error('invalid jws');
  const header = b64urlJson(parts[0]);
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || !x5c.length) throw new Error('missing x5c');
  const chain = x5c.map((c) => new crypto.X509Certificate(Buffer.from(c, 'base64')));
  const root = new crypto.X509Certificate(APPLE_ROOT_CA_G3_PEM);
  if (fp256(root) !== APPLE_ROOT_CA_G3_SHA256) throw new Error('embedded Apple Root CA G3 mismatch');

  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].verify(chain[i + 1].publicKey)) throw new Error('x5c chain broken');
  }
  const last = chain[chain.length - 1];
  const lastIsRoot = fp256(last) === APPLE_ROOT_CA_G3_SHA256;
  if (!lastIsRoot && !last.verify(root.publicKey)) {
    throw new Error('x5c not rooted at Apple Root CA G3');
  }

  const alg = header.alg || 'ES256';
  return verifyAgainstLeaf(jws, chain[0], alg);
}

// Production/Sandbox must chain to G3. Xcode StoreKit Configuration files are
// signed by a local test cert; accept those only while APPLE_IAP_ALLOW_XCODE != 0.
async function decodeAppleJws(jws) {
  try {
    return await verifyAppleJws(jws);
  } catch (err) {
    if (!allowXcode()) throw err;
    try {
      const header = b64urlJson(jws.split('.')[0]);
      const x5c = header.x5c;
      if (!x5c || !x5c[0]) throw err;
      const leaf = new crypto.X509Certificate(Buffer.from(x5c[0], 'base64'));
      const decoded = await verifyAgainstLeaf(jws, leaf, header.alg || 'ES256');
      if (decoded.environment !== 'Xcode') throw err;
      return decoded;
    } catch (_) {
      throw err;
    }
  }
}

function isoFromAppleMs(ms) {
  if (ms == null || ms === '') return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

// Same merge rule as src/auth.js (not exported): never shorten a longer plan;
// a null expiry on a paying tier is lifetime and must not be overwritten.
function mergedExpiry(curTier, curExpires, newExpires) {
  const paying = curTier && curTier !== 'free';
  if (paying && curExpires == null) return null;
  if (curExpires == null) return newExpires;
  if (newExpires == null) return null;
  const cur = Date.parse(curExpires), nw = Date.parse(newExpires);
  if (isNaN(cur)) return newExpires;
  if (isNaN(nw)) return curExpires;
  return nw > cur ? newExpires : curExpires;
}

function expiresFromTx(tx, product) {
  if (product.type === 'consumable') {
    const bought = Number(tx.purchaseDate);
    const start = Number.isFinite(bought) ? bought : Date.now();
    return new Date(start + 24 * 60 * 60 * 1000).toISOString();
  }
  return isoFromAppleMs(tx.expiresDate);
}

function grantEntitlement(userId, expiresAt) {
  const cur = db.prepare(`SELECT subscription_tier, subscription_expires, stripe_subscription_id FROM users WHERE id = ?`).get(userId);
  const merged = mergedExpiry(cur?.subscription_tier, cur?.subscription_expires, expiresAt);
  const hasLiveStripe = cur?.subscription_tier === 'paid' && cur?.stripe_subscription_id != null;
  let tier = 'paid';
  if (cur?.subscription_tier === 'code' && cur.subscription_expires == null) tier = 'code';
  else if (hasLiveStripe) tier = 'paid';
  db.prepare(`UPDATE users SET subscription_tier = ?, subscription_expires = ? WHERE id = ?`).run(tier, merged, userId);
  try {
    db.prepare(`UPDATE users SET subscription_store = ? WHERE id = ?`).run(hasLiveStripe ? 'stripe' : 'apple', userId);
  } catch (_) {}
  return { tier, expires: merged };
}

function stillHasOtherAccess(user) {
  if (!user) return false;
  if (user.subscription_tier === 'code' && user.subscription_expires == null) return true;
  if (user.subscription_tier === 'paid' && user.stripe_subscription_id) return true;
  if (user.subscription_expires && Date.parse(user.subscription_expires) > Date.now()) {
    if (user.subscription_tier && user.subscription_tier !== 'free' && user.subscription_store !== 'apple') return true;
  }
  return false;
}

function userAccessRow(userId) {
  try {
    return db.prepare(`SELECT subscription_tier, subscription_expires, stripe_subscription_id, subscription_store FROM users WHERE id = ?`).get(userId);
  } catch (_) {
    return db.prepare(`SELECT subscription_tier, subscription_expires, stripe_subscription_id FROM users WHERE id = ?`).get(userId);
  }
}

function revokeAppleIfIdle(userId) {
  const cur = userAccessRow(userId);
  if (stillHasOtherAccess(cur)) return false;
  db.prepare(`UPDATE users SET subscription_tier = 'free', subscription_expires = NULL WHERE id = ? AND subscription_tier = 'paid'`).run(userId);
  try { db.prepare(`UPDATE users SET subscription_store = NULL WHERE id = ? AND subscription_store = 'apple'`).run(userId); } catch (_) {}
  return true;
}

function upsertTx({ originalTransactionId, userId, productId, purchasedAt, expiresAt, status, environment, raw }) {
  db.prepare(`
    INSERT INTO apple_transactions (
      original_transaction_id, user_id, product_id, purchased_at, expires_at, status, environment, last_notification_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(original_transaction_id) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, apple_transactions.user_id),
      product_id = excluded.product_id,
      purchased_at = excluded.purchased_at,
      expires_at = excluded.expires_at,
      status = excluded.status,
      environment = excluded.environment,
      last_notification_at = datetime('now'),
      raw_json = excluded.raw_json
  `).run(
    originalTransactionId,
    userId,
    productId,
    purchasedAt,
    expiresAt,
    status,
    environment,
    JSON.stringify(raw || null)
  );
}

function assertTx(tx) {
  if (!tx || typeof tx !== 'object') throw new Error('empty transaction');
  if (tx.bundleId !== BUNDLE_ID) throw new Error('bundleId mismatch');
  const product = PRODUCTS[tx.productId];
  if (!product) throw new Error('unknown productId');
  if (tx.environment && !ENVIRONMENTS.has(tx.environment)) throw new Error('unknown environment');
  if (tx.environment === 'Xcode' && !allowXcode()) throw new Error('Xcode IAP disabled');
  const originalTransactionId = String(tx.originalTransactionId || '');
  if (!originalTransactionId) throw new Error('missing originalTransactionId');
  return { product, originalTransactionId };
}

function applyVerifiedTx(userId, tx, status) {
  const { product, originalTransactionId } = assertTx(tx);
  const purchasedAt = isoFromAppleMs(tx.purchaseDate) || new Date().toISOString();
  const expiresAt = expiresFromTx(tx, product);
  upsertTx({
    originalTransactionId,
    userId,
    productId: tx.productId,
    purchasedAt,
    expiresAt,
    status: status || 'active',
    environment: tx.environment || null,
    raw: tx,
  });
  const grant = grantEntitlement(userId, expiresAt);
  return { productId: tx.productId, originalTransactionId, ...grant };
}

function collectJwsList(body) {
  if (!body || typeof body !== 'object') return [];
  if (typeof body.jws === 'string') return [body.jws];
  if (Array.isArray(body.jws)) return body.jws.filter((s) => typeof s === 'string');
  if (Array.isArray(body.transactions)) {
    return body.transactions.map((t) => (typeof t === 'string' ? t : t && t.jws)).filter((s) => typeof s === 'string');
  }
  return [];
}

function requireUser(req, res) {
  const u = userOf(req);
  if (!u) {
    res.status(401).json({ error: 'Login required' });
    return null;
  }
  return u;
}

router.post('/verify', async (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  const jws = req.body && req.body.jws;
  if (!jws || typeof jws !== 'string') return res.status(400).json({ error: 'Missing jws' });
  try {
    const tx = await decodeAppleJws(jws);
    const out = applyVerifiedTx(u.id, tx, 'active');
    console.log(`[iap] verify user ${u.id} ${out.productId} expires ${out.expires}`);
    res.json({ ok: true, ...out });
  } catch (err) {
    console.warn('[iap] verify failed:', err.message);
    res.status(400).json({ error: 'Could not verify purchase.' });
  }
});

router.post('/restore', async (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  const list = collectJwsList(req.body);
  if (!list.length) return res.status(400).json({ error: 'No transactions to restore.' });
  const restored = [];
  const errors = [];
  for (const jws of list) {
    try {
      const tx = await decodeAppleJws(jws);
      restored.push(applyVerifiedTx(u.id, tx, 'active'));
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (!restored.length) {
    console.warn('[iap] restore failed for user', u.id, errors.slice(0, 3));
    return res.status(400).json({ error: 'Could not restore purchases.' });
  }
  const latest = restored.reduce((a, b) => {
    const ae = a.expires ? Date.parse(a.expires) : 0;
    const be = b.expires ? Date.parse(b.expires) : 0;
    return be > ae ? b : a;
  });
  console.log(`[iap] restore user ${u.id} n=${restored.length} expires ${latest.expires}`);
  res.json({ ok: true, restored: restored.length, ...latest });
});

const GRANT_TYPES = new Set(['DID_RENEW', 'SUBSCRIBED', 'OFFER_REDEEMED', 'ONE_TIME_CHARGE', 'RENEWAL_EXTENDED', 'REFUND_REVERSED']);
const REVOKE_TYPES = new Set(['EXPIRED', 'REFUND', 'REVOKE', 'GRACE_PERIOD_EXPIRED']);

async function handleNotification(signedPayload) {
  const note = await decodeAppleJws(signedPayload);
  const type = note.notificationType || '';
  if (type === 'TEST') return { ok: true, type };

  let tx = null;
  const signedTx = note.data && note.data.signedTransactionInfo;
  if (signedTx) tx = await decodeAppleJws(signedTx);

  const originalTransactionId = tx ? String(tx.originalTransactionId || '') : null;
  const row = originalTransactionId
    ? db.prepare(`SELECT * FROM apple_transactions WHERE original_transaction_id = ?`).get(originalTransactionId)
    : null;
  const userId = row && row.user_id;

  if (tx && originalTransactionId) {
    const product = PRODUCTS[tx.productId];
    const purchasedAt = isoFromAppleMs(tx.purchaseDate) || (row && row.purchased_at) || new Date().toISOString();
    const expiresAt = product ? expiresFromTx(tx, product) : isoFromAppleMs(tx.expiresDate);
    const status = REVOKE_TYPES.has(type) ? String(type).toLowerCase() : 'active';
    upsertTx({
      originalTransactionId,
      userId: userId || null,
      productId: tx.productId,
      purchasedAt,
      expiresAt,
      status,
      environment: (tx.environment || (note.data && note.data.environment) || null),
      raw: { notificationType: type, subtype: note.subtype || null, tx },
    });
    if (userId && GRANT_TYPES.has(type) && product) {
      grantEntitlement(userId, expiresAt);
    } else if (userId && REVOKE_TYPES.has(type)) {
      revokeAppleIfIdle(userId);
    }
  } else if (userId && REVOKE_TYPES.has(type)) {
    revokeAppleIfIdle(userId);
  }

  console.log(`[iap] notification ${type}${note.subtype ? '/' + note.subtype : ''} orig=${originalTransactionId || '—'} user=${userId || '—'}`);
  return { ok: true, type };
}

router.post('/apple-notifications', async (req, res) => {
  const signedPayload = req.body && req.body.signedPayload;
  if (!signedPayload || typeof signedPayload !== 'string') {
    return res.status(400).json({ error: 'Missing signedPayload' });
  }
  try {
    const out = await handleNotification(signedPayload);
    res.json(out);
  } catch (err) {
    console.warn('[iap] notification rejected:', err.message);
    res.status(400).json({ error: 'Invalid notification' });
  }
});

module.exports = router;
module.exports.PRODUCTS = PRODUCTS;
module.exports.BUNDLE_ID = BUNDLE_ID;
