// src/auth.js — Authentication router
const express = require('express');
const bcrypt  = require('bcrypt');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const db      = require('./db');

const router     = express.Router();
const SALT_ROUNDS = 12;

// ── Helpers ───────────────────────────────────────────────────────────────────
function userPayload(row) {
  return { id: row.id, email: row.email, tier: row.subscription_tier, username: row.username || null };
}

// Regenerate the session id on every privilege change (login/signup/Google), so a
// pre-planted session cookie cannot be replayed as the authenticated user
// (session fixation). Stamp the user onto the fresh session and persist it first.
function establishSession(req, res, user) {
  const payload = userPayload(user);
  req.session.regenerate((err) => {
    req.session.user = payload;
    if (err) return res.json({ success: true, user: payload });
    req.session.save(() => res.json({ success: true, user: payload }));
  });
}

// ── POST /auth/signup ─────────────────────────────────────────────────────────
router.post('/signup', express.json(), async (req, res) => {
  const { email, password, username, tos_agreed, public_leaderboard } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  // Validate the email server-side: bounds the length and blocks angle brackets /
  // quotes so it can never carry markup into the admin Users panel (stored XSS).
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@<>"']+@[^\s@<>"']+\.[a-zA-Z]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (typeof password !== 'string' || password.length > 200) return res.status(400).json({ error: 'Password is too long.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, and underscores only.' });
  }
  if (!tos_agreed) return res.status(400).json({ error: 'You must agree to the Terms of Service.' });
  // 18+ age gate (App Review requirement): enforced, not just represented.
  const birthYear = parseInt(req.body?.birth_year, 10);
  const nowYear = new Date().getFullYear();
  if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > nowYear) {
    return res.status(400).json({ error: 'A valid year of birth is required.' });
  }
  if (nowYear - birthYear < 18) return res.status(403).json({ error: 'You must be 18 or older to use CappingAlpha.' });

  const existingEmail = db.prepare(`SELECT id FROM users WHERE LOWER(email) = LOWER(?)`).get(email);
  if (existingEmail) return res.status(409).json({ error: 'An account with that email already exists.' });

  const existingUsername = db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`).get(username);
  if (existingUsername) return res.status(409).json({ error: 'That username is already taken.' });

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, subscription_tier, username, tos_accepted_at, birth_year)
    VALUES (?, ?, 'free', ?, datetime('now'), ?)
  `).run(email.toLowerCase().trim(), hash, username.trim(), birthYear);

  // Leaderboard visibility chosen at signup (default public when omitted).
  const isPublic = public_leaderboard === false ? 0 : 1;
  try {
    db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id, favorite_sports, is_public) VALUES (?, '[]', ?)`)
      .run(result.lastInsertRowid, isPublic);
  } catch (_) {}

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(result.lastInsertRowid);
  establishSession(req, res, user);
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', express.json(), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email or username and password required.' });

  // Accept email OR username. Deleted (tombstoned) rows can never log in.
  const user = db.prepare(`
    SELECT * FROM users WHERE (LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)) AND deleted_at IS NULL
  `).get(email, email);
  if (!user) return res.status(401).json({ error: 'Invalid email/username or password.' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid email/username or password.' });

  establishSession(req, res, user);
});

// ── POST /auth/google — "Continue with Google" (GIS token model) ──────────────
// The browser sends a Google access_token (from google.accounts.oauth2). We
// validate it with Google's tokeninfo endpoint, confirm it was minted for OUR
// client id, then find-or-create the account. No password is set for Google
// accounts (an unusable random hash satisfies the NOT NULL column).
function deriveUsername(email) {
  let base = String(email || '').split('@')[0].replace(/[^a-zA-Z0-9_]/g, '');
  if (base.length < 3) base = (base + 'user');
  base = base.slice(0, 20);
  let candidate = base, n = 0;
  while (db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`).get(candidate)) {
    n += 1;
    const suffix = String(n);
    candidate = base.slice(0, 20 - suffix.length) + suffix;
  }
  return candidate;
}

router.post('/google', express.json(), async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google sign-in is not configured.' });
  const { access_token } = req.body || {};
  if (!access_token) return res.status(400).json({ error: 'Missing Google token.' });

  let info;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(access_token)}`);
    info = await r.json();
    if (!r.ok || info.error) throw new Error(info.error_description || info.error || 'tokeninfo failed');
  } catch (err) {
    console.warn('[auth] Google tokeninfo failed:', err.message);
    return res.status(401).json({ error: 'Could not verify Google sign-in.' });
  }

  // The token must have been issued for this app, or it isn't ours to trust.
  if (info.aud !== process.env.GOOGLE_CLIENT_ID && info.azp !== process.env.GOOGLE_CLIENT_ID) {
    return res.status(401).json({ error: 'Google sign-in token mismatch.' });
  }
  const googleId = info.sub;
  const email    = (info.email || '').toLowerCase().trim();
  if (!googleId || !email) return res.status(400).json({ error: 'Google account is missing an email.' });
  if (info.email_verified === false || info.email_verified === 'false') {
    return res.status(403).json({ error: 'Your Google email is not verified.' });
  }

  // 1) known google_id  2) same email (link it)  3) brand-new account.
  // Tombstoned rows are excluded so a re-signin starts a fresh account.
  let user = db.prepare(`SELECT * FROM users WHERE google_id = ? AND deleted_at IS NULL`).get(googleId);
  if (!user) {
    const byEmail = db.prepare(`SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND deleted_at IS NULL`).get(email);
    if (byEmail) {
      // Pre-hijack defense: signup has no email verification, so this row could be
      // an attacker who squatted the victim's email with a password before the
      // victim ever used Google. Google has verified the address belongs to the
      // person signing in now, so they are the rightful owner. Linking, then
      // invalidating the existing password + burning any reset tokens, evicts a
      // squatter (a legitimate password owner can just reset via their email).
      const deadHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), SALT_ROUNDS);
      db.prepare(`UPDATE users SET google_id = ?, password_hash = ? WHERE id = ?`).run(googleId, deadHash, byEmail.id);
      db.prepare(`DELETE FROM password_reset_tokens WHERE user_id = ?`).run(byEmail.id);
      user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(byEmail.id);
      console.log(`[auth] Linked Google to existing email ${email} (password reset for safety)`);
    }
  }
  if (!user) {
    // Brand-new account: gate creation on the 18+ / ToS consent the client
    // collects after OAuth. Existing users (matched above) are never gated.
    const tosAgreed = req.body?.tos_agreed === true;
    const birthYear = parseInt(req.body?.birth_year, 10);
    const nowYear = new Date().getFullYear();
    const ageOk = Number.isInteger(birthYear) && birthYear >= 1900 && birthYear <= nowYear && (nowYear - birthYear) >= 18;
    if (!tosAgreed || !ageOk) {
      return res.status(428).json({ needs_consent: true, error: 'Please confirm you are 18 or older and agree to the Terms.' });
    }
    const username   = deriveUsername(email);
    const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), SALT_ROUNDS);
    const result = db.prepare(`
      INSERT INTO users (email, password_hash, subscription_tier, username, google_id, tos_accepted_at, birth_year)
      VALUES (?, ?, 'free', ?, ?, datetime('now'), ?)
    `).run(email, randomHash, username, googleId, birthYear);
    try {
      db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id, favorite_sports) VALUES (?, '[]')`)
        .run(result.lastInsertRowid);
    } catch (_) {}
    user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(result.lastInsertRowid);
    console.log(`[auth] New Google account: ${email} (@${username})`);
  }

  establishSession(req, res, user);
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ── DELETE /auth/account — in-app account deletion (Apple 5.1.1(v) / Google) ────
// Session-authed with an explicit confirm. Cancels any live subscription, hard
// purges every child row (SQLite FK enforcement is off, so each table is named),
// then anonymizes + tombstones the users row. stripe_customer_id is kept so the
// first-time-trial guard cannot be reset by delete-and-resubscribe.
router.delete('/account', express.json(), async (req, res) => {
  const sessionUser = req.session?.user;
  if (!sessionUser) return res.status(401).json({ error: 'You must be logged in.' });
  if (req.body?.confirm !== true && req.body?.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Deletion must be confirmed.' });
  }
  const userId = sessionUser.id;
  const row = db.prepare(`SELECT stripe_subscription_id, avatar_path FROM users WHERE id = ?`).get(userId);
  if (!row) { return req.session.destroy(() => res.json({ success: true })); }

  if (row.stripe_subscription_id) {
    try { await stripe.subscriptions.cancel(row.stripe_subscription_id); }
    catch (e) { console.warn('[auth] delete-account: stripe cancel failed:', e.message); }
  }

  const purge = db.transaction(() => {
    db.prepare(`DELETE FROM user_preferences WHERE user_id = ?`).run(userId);
    db.prepare(`UPDATE game_votes SET tail_of_user_id = NULL WHERE tail_of_user_id = ?`).run(userId);
    db.prepare(`UPDATE user_bets  SET tail_of_user_id = NULL WHERE tail_of_user_id = ?`).run(userId);
    db.prepare(`DELETE FROM game_votes WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM game_messages WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM user_bets WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM bet_legs WHERE user_id = ?`).run(userId);
    try { db.prepare(`DELETE FROM bankroll_ledger WHERE user_id = ?`).run(userId); } catch (_) {}
    try { db.prepare(`DELETE FROM dummy_settings WHERE user_id = ?`).run(userId); } catch (_) {}
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(userId);
    try { db.prepare(`DELETE FROM push_log WHERE user_id = ?`).run(userId); } catch (_) {}
    try { db.prepare(`DELETE FROM leaderboard_awards WHERE user_id = ?`).run(userId); } catch (_) {}
    db.prepare(`DELETE FROM follows WHERE follower_id = ? OR followee_id = ?`).run(userId, userId);
    db.prepare(`DELETE FROM social_reactions WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM social_comments WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM social_blocks WHERE blocker_id = ? OR blocked_id = ?`).run(userId, userId);
    db.prepare(`DELETE FROM social_reports WHERE reporter_id = ?`).run(userId);
    db.prepare(`DELETE FROM code_redemptions WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM referral_redemptions WHERE referred_id = ? OR referrer_id = ?`).run(userId, userId);
    db.prepare(`DELETE FROM password_reset_tokens WHERE user_id = ?`).run(userId);
    try { db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.user.id') = ?`).run(userId); } catch (_) {}
    db.prepare(`
      UPDATE users SET
        email = 'deleted+' || id || '@deleted.invalid',
        username = NULL, password_hash = '!', avatar_path = NULL,
        google_id = NULL, referral_code = NULL,
        subscription_tier = 'free', subscription_expires = NULL,
        stripe_subscription_id = NULL, is_dummy = 0,
        deleted_at = datetime('now')
      WHERE id = ?
    `).run(userId);
  });
  try { purge(); }
  catch (e) { console.error('[auth] delete-account purge failed:', e.message); return res.status(500).json({ error: 'Could not delete the account. Please contact support.' }); }

  if (row.avatar_path) {
    try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'avatars', row.avatar_path)); } catch (_) {}
  }
  console.log(`[auth] Account ${userId} deleted (in-app).`);
  req.session.destroy(() => res.json({ success: true }));
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.session?.user) return res.json({ user: null });
  // Re-fetch from DB so subscription_expires is fresh
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.session.user.id);
  if (!row) return res.json({ user: null });
  if (row.deleted_at) { return req.session.destroy(() => res.json({ user: null })); }
  // unit_size rides along so the betslip's default stake is right from the first
  // paint, even if the user never opens the Tracking tab that session.
  const prefs = db.prepare(`SELECT unit_size FROM user_preferences WHERE user_id = ?`).get(row.id);
  res.json({
    user: {
      id:                   row.id,
      email:                row.email,
      username:             row.username || null,
      tier:                 row.subscription_tier,
      subscription_expires: row.subscription_expires,
      unit_size:            prefs && prefs.unit_size != null ? prefs.unit_size : 20,
    }
  });
});

// ── POST /auth/redeem-code ────────────────────────────────────────────────────
router.post('/redeem-code', express.json(), (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'You must be logged in to redeem a code.' });

  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'No code provided.' });

  const row = db.prepare(`SELECT * FROM access_codes WHERE LOWER(code) = LOWER(?)`).get(code.trim());
  if (!row) {
    // Not an admin code — maybe a member's referral code (give-a-day / get-a-day).
    const referrer = db.prepare(
      `SELECT id, username, email FROM users WHERE referral_code IS NOT NULL AND LOWER(referral_code) = LOWER(?)`
    ).get(code.trim());
    if (referrer) return redeemReferral(req, res, referrer);
    return res.status(401).json({ error: 'Invalid code. Try again.' });
  }

  const userId  = req.session.user.id;
  const maxUses = row.max_uses == null ? 1 : row.max_uses;   // 0 = unlimited

  // Can't redeem the same code twice.
  const mine = db.prepare(`SELECT 1 FROM code_redemptions WHERE code_id = ? AND user_id = ?`).get(row.id, userId);
  if (mine) return res.status(409).json({ error: 'You have already redeemed this code.' });

  // Usage cap (0 = unlimited).
  const used = db.prepare(`SELECT COUNT(*) AS n FROM code_redemptions WHERE code_id = ?`).get(row.id).n;
  if (maxUses > 0 && used >= maxUses) {
    return res.status(409).json({ error: 'This code has reached its usage limit.' });
  }

  // Compute expiry — a custom duration wins, otherwise fall back to the legacy `type`.
  let expires = null;
  if (row.duration_days != null) {
    expires = row.duration_days > 0
      ? new Date(Date.now() + row.duration_days * 24 * 60 * 60 * 1000).toISOString()
      : null; // 0 days = lifetime
  } else {
    if (row.type === 'day')    expires = new Date(Date.now() + 1   * 24 * 60 * 60 * 1000).toISOString();
    if (row.type === 'week')   expires = new Date(Date.now() + 7   * 24 * 60 * 60 * 1000).toISOString();
    if (row.type === 'annual') expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    // lifetime / unknown → null (no expiry)
  }

  // Never shorten access the user already has (e.g. a day code on top of an annual).
  const cur = db.prepare(`SELECT subscription_tier, subscription_expires, stripe_subscription_id FROM users WHERE id = ?`).get(userId);
  const merged = mergedExpiry(cur?.subscription_tier, cur?.subscription_expires, expires);
  // An active recurring Stripe subscriber stays tier 'paid': the cancellation webhook
  // only downgrades 'paid' rows, so flipping them to 'code' here would make their
  // access unrevokable after they cancel. A dated code just extends their expiry.
  // A lifetime code (expires null) intentionally outlives any subscription, and
  // everyone else keeps the existing 'code' behavior.
  const hasLiveSub = cur?.subscription_tier === 'paid' && cur?.stripe_subscription_id != null;
  const newTier = (hasLiveSub && expires != null) ? 'paid' : 'code';
  db.prepare(`UPDATE users SET subscription_tier = ?, subscription_expires = ? WHERE id = ?`)
    .run(newTier, merged, userId);

  // Log the redemption + keep the first-redeemer fields for legacy display / delete gating.
  db.prepare(`INSERT OR IGNORE INTO code_redemptions (code_id, user_id) VALUES (?, ?)`).run(row.id, userId);
  if (row.activated_by == null) {
    db.prepare(`UPDATE access_codes SET activated_by = ?, activated_at = datetime('now') WHERE id = ?`)
      .run(userId, row.id);
  }

  console.log(`[auth] Code "${row.code}" redeemed by user ${userId} (${req.session.user.email || req.session.user.username}), use ${used + 1}/${maxUses === 0 ? '∞' : maxUses}, expires: ${expires || 'never'}`);

  req.session.user.tier = newTier;
  res.json({ success: true });
});

// ── Referral loop (give-3-days / get-3-days) ──────────────────────────────────
// Every account can hold a referral code (generated lazily via
// ensureReferralCode). When a friend confirms a new account with the code, BOTH
// sides get 3 free days (Jack, 2026-07-17). Guards keep it safe: no self-redeem,
// one referral redemption per referred account ever (referral_redemptions has a
// UNIQUE referred_id), and a lifetime cap on the DAYS a referrer can earn (a farm
// of throwaway accounts can't mint unlimited access). The referred side always
// gets its 3 days; only the referrer's reward is capped.
const REFERRAL_GRANT_DAYS   = 3;
const REFERRAL_EARN_CAP     = 30;   // max DAYS a referrer can earn, lifetime (~10 referrals)

function grantAccessDays(userId, days) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const cur = db.prepare(`SELECT subscription_tier, subscription_expires, stripe_subscription_id FROM users WHERE id = ?`).get(userId);
  const merged = mergedExpiry(cur?.subscription_tier, cur?.subscription_expires, expires);
  // Same tier rule as code redemption: a live Stripe subscriber stays 'paid'
  // so the cancellation webhook can still revoke them.
  const hasLiveSub = cur?.subscription_tier === 'paid' && cur?.stripe_subscription_id != null;
  const newTier = hasLiveSub ? 'paid' : 'code';
  db.prepare(`UPDATE users SET subscription_tier = ?, subscription_expires = ? WHERE id = ?`).run(newTier, merged, userId);
  return newTier;
}

function redeemReferral(req, res, referrer) {
  const userId = req.session.user.id;
  if (referrer.id === userId) {
    return res.status(400).json({ error: 'That is your own referral code. Share it with a friend instead.' });
  }
  const prior = db.prepare(`SELECT 1 FROM referral_redemptions WHERE referred_id = ?`).get(userId);
  if (prior) return res.status(409).json({ error: 'You have already used a referral code.' });

  db.prepare(`INSERT INTO referral_redemptions (referrer_id, referred_id) VALUES (?, ?)`).run(referrer.id, userId);

  const newTier = grantAccessDays(userId, REFERRAL_GRANT_DAYS);

  // Credit the referrer their 3 days back, up to the lifetime DAYS cap. `earned`
  // counts this redemption, so earned*grant is the referrer's total-after-this;
  // grant only while that stays within the cap.
  const earned = db.prepare(`SELECT COUNT(*) AS n FROM referral_redemptions WHERE referrer_id = ?`).get(referrer.id).n;
  if (earned * REFERRAL_GRANT_DAYS <= REFERRAL_EARN_CAP) grantAccessDays(referrer.id, REFERRAL_GRANT_DAYS);

  console.log(`[auth] Referral code of user ${referrer.id} redeemed by user ${userId} (referral #${earned}, +${REFERRAL_GRANT_DAYS}d each)`);
  req.session.user.tier = newTier;
  res.json({ success: true, referral: true });
}

// Lazily mint a user's referral code (8 chars, same alphabet as access codes,
// collision-checked against both tables). Returns the code.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function ensureReferralCode(userId) {
  const cur = db.prepare(`SELECT referral_code FROM users WHERE id = ?`).get(userId);
  if (!cur) return null;
  if (cur.referral_code) return cur.referral_code;
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) code += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
    const clash = db.prepare(`SELECT 1 FROM access_codes WHERE LOWER(code) = LOWER(?)`).get(code)
               || db.prepare(`SELECT 1 FROM users WHERE LOWER(referral_code) = LOWER(?)`).get(code);
    if (clash) continue;
    try {
      db.prepare(`UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL`).run(code, userId);
      return db.prepare(`SELECT referral_code FROM users WHERE id = ?`).get(userId).referral_code;
    } catch (_) { /* unique-index race — retry */ }
  }
  return null;
}

// ── Stripe ────────────────────────────────────────────────────────────────────
// Pin the API version so an SDK bump can't silently move field shapes again
// (the dahlia release relocated current_period_end off the Subscription object).
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-03-25.dahlia' });

// dahlia (Stripe API 2025-03+) moved current_period_end off the Subscription
// object onto each subscription item; read the item first, fall back to the
// legacy top-level field so this works on any account API version.
function subscriptionPeriodEnd(sub) {
  return sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end ?? null;
}
// The invoice's subscription reference likewise moved under parent.subscription_details.
function invoiceSubscriptionId(invoice) {
  const ref = invoice?.parent?.subscription_details?.subscription
           ?? invoice?.subscription
           ?? invoice?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription
           ?? null;
  return typeof ref === 'string' ? ref : (ref?.id ?? null);
}

// Never shorten access a user already paid for. A null expiry on a paying tier means
// lifetime/comp and must never be overwritten with a dated one; otherwise keep the
// later of the current and new expiry. Used by the day-pass grant + code redemption.
function mergedExpiry(curTier, curExpires, newExpires) {
  const paying = curTier && curTier !== 'free';
  if (paying && curExpires == null) return null;   // lifetime — keep it
  if (curExpires == null) return newExpires;        // was free — take the grant
  if (newExpires == null) return null;              // granting lifetime
  const cur = Date.parse(curExpires), nw = Date.parse(newExpires);
  if (isNaN(cur)) return newExpires;
  if (isNaN(nw))  return curExpires;
  return nw > cur ? newExpires : curExpires;        // keep whichever lasts longer
}

const PLANS = {
  'price_1TMhkAB0ohior8iouVKseqmk': { label: 'Day Pass', mode: 'payment',      hours: 24 },
  'price_1TMhkCB0ohior8iomOMDlrts': { label: 'Weekly',   mode: 'subscription', trialDays: 3 },
  'price_1TMhkAB0ohior8iohRBOZKdH': { label: 'Annual',   mode: 'subscription'               },
};

// POST /auth/create-checkout-session
router.post('/create-checkout-session', express.json(), async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'You must be logged in to purchase.' });

  const { priceId } = req.body || {};
  const plan = PLANS[priceId];
  if (!plan) return res.status(400).json({ error: 'Invalid plan.' });

  try {
    const baseUrl = process.env.SITE_URL || 'http://localhost:3001';
    const params = {
      mode:       plan.mode,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata:   { userId: String(user.id) },
      customer_email: user.email,
      success_url: `${baseUrl}/?payment=success`,
      cancel_url:  `${baseUrl}/?payment=cancelled`,
    };
    // Intro trial (weekly plan): first-time subscribers only. stripe_customer_id
    // is stamped on the first completed subscription and never cleared (the
    // cancel webhook only nulls stripe_subscription_id), so it's the durable
    // "has subscribed before" marker — cancel-and-resubscribe can't re-trial.
    // A past day pass doesn't disqualify (that path never sets the customer id).
    if (plan.trialDays && plan.mode === 'subscription') {
      const row = db.prepare(`SELECT stripe_customer_id FROM users WHERE id = ?`).get(user.id);
      if (!row?.stripe_customer_id) {
        params.subscription_data = { trial_period_days: plan.trialDays };
      }
    }
    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe] checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session.', detail: err.message });
  }
});

// POST /auth/stripe-webhook — raw body required; registered in index.js before express.json()
async function stripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('[stripe] webhook signature error:', err.message);
    return res.status(400).send('Webhook Error');
  }

  const { type, data } = event;

  try {
    if (type === 'checkout.session.completed') {
      const session = data.object;
      const userId  = session.metadata?.userId;
      if (!userId) return res.json({ received: true });

      if (session.mode === 'payment') {
        // Day pass — only grant on a confirmed-paid checkout (never on an
        // incomplete/failed/processing session).
        if (session.payment_status !== 'paid') {
          console.warn(`[stripe] day-pass session for user ${userId} not paid (payment_status=${session.payment_status}) — skipping grant`);
          return res.json({ received: true });
        }
        const cur = db.prepare(`SELECT subscription_tier, subscription_expires FROM users WHERE id=?`).get(userId);
        const newExp  = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const expires = mergedExpiry(cur?.subscription_tier, cur?.subscription_expires, newExp); // never shorten a longer plan
        // Keep a lifetime/code grant's tier; only lift a free user to 'paid'.
        const tier = (cur?.subscription_tier && cur.subscription_tier !== 'free') ? cur.subscription_tier : 'paid';
        db.prepare(`UPDATE users SET subscription_tier=?, subscription_expires=? WHERE id=?`).run(tier, expires, userId);
        console.log(`[stripe] Day pass granted to user ${userId}, expires ${expires}`);

      } else if (session.mode === 'subscription') {
        // Weekly or annual — get period end from subscription object
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        // Only grant for an active/trialing subscription.
        if (!['active', 'trialing'].includes(sub.status)) {
          console.warn(`[stripe] subscription ${session.subscription} for user ${userId} status=${sub.status} — skipping grant`);
          return res.json({ received: true });
        }
        const periodEnd = subscriptionPeriodEnd(sub);
        if (!periodEnd) {
          console.error(`[stripe] no current_period_end on subscription ${session.subscription} for user ${userId} — grant skipped`);
          return res.json({ received: true });
        }
        const newExp  = new Date(periodEnd * 1000).toISOString();
        const cur     = db.prepare(`SELECT subscription_tier, subscription_expires FROM users WHERE id=?`).get(userId);
        const expires = mergedExpiry(cur?.subscription_tier, cur?.subscription_expires, newExp);
        db.prepare(`
          UPDATE users SET subscription_tier='paid', subscription_expires=?,
            stripe_customer_id=?, stripe_subscription_id=? WHERE id=?
        `).run(expires, session.customer, session.subscription, userId);
        console.log(`[stripe] Subscription granted to user ${userId}, expires ${expires}`);
      }
    }

    if (type === 'invoice.payment_succeeded') {
      // Subscription renewal — extend expiry
      const invoice = data.object;
      const subId = invoiceSubscriptionId(invoice);
      if (!subId) return res.json({ received: true });
      const user = db.prepare(`SELECT id, subscription_tier, subscription_expires FROM users WHERE stripe_subscription_id=?`).get(subId);
      if (user) {
        const sub     = await stripe.subscriptions.retrieve(subId);
        const periodEnd = subscriptionPeriodEnd(sub);
        if (!periodEnd) return res.json({ received: true });
        const newExp  = new Date(periodEnd * 1000).toISOString();
        const expires = mergedExpiry(user.subscription_tier, user.subscription_expires, newExp); // never shorten a code-extended expiry
        db.prepare(`UPDATE users SET subscription_tier='paid', subscription_expires=? WHERE id=?`).run(expires, user.id);
        console.log(`[stripe] Subscription renewed for user ${user.id}, expires ${expires}`);
      }
    }

    if (type === 'customer.subscription.deleted') {
      // Cancelled — clear the dead subscription id, and downgrade to free ONLY if the
      // user's current access came from THIS subscription ('paid'). A separately
      // redeemed code/lifetime grant ('code') must survive the cancellation.
      const sub  = data.object;
      const user = db.prepare(`SELECT id FROM users WHERE stripe_subscription_id=?`).get(sub.id);
      if (user) {
        db.prepare(`UPDATE users SET subscription_tier='free', subscription_expires=NULL WHERE id=? AND subscription_tier='paid'`).run(user.id);
        db.prepare(`UPDATE users SET stripe_subscription_id=NULL WHERE id=?`).run(user.id);
        console.log(`[stripe] Subscription cancelled for user ${user.id}`);
      }
    }
  } catch (err) {
    console.error('[stripe] webhook handler error:', err.message);
  }

  res.json({ received: true });
}

// ── PUT /auth/username ────────────────────────────────────────────────────────
router.put('/username', express.json(), async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not logged in.' });
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, and underscores only.' });
  }

  const row = db.prepare(`SELECT username, username_changed_at FROM users WHERE id = ?`).get(req.session.user.id);
  if (row.username_changed_at) {
    const lastChange = new Date(row.username_changed_at + 'Z');
    const daysSince  = (Date.now() - lastChange.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 30) {
      const daysLeft = Math.ceil(30 - daysSince);
      return res.status(429).json({ error: `You can change your username again in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.` });
    }
  }

  const taken = db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?`).get(username, req.session.user.id);
  if (taken) return res.status(409).json({ error: 'That username is already taken.' });

  db.prepare(`UPDATE users SET username = ?, username_changed_at = datetime('now') WHERE id = ?`)
    .run(username.trim(), req.session.user.id);
  req.session.user.username = username.trim();
  res.json({ success: true, username: username.trim() });
});

// ── POST /auth/forgot-password ────────────────────────────────────────────────
router.post('/forgot-password', express.json(), async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  // Always respond OK so we don't leak whether email exists
  const user = db.prepare(`SELECT id, email FROM users WHERE LOWER(email) = LOWER(?)`).get(email);
  if (!user) return res.json({ success: true });

  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  db.prepare(`INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)`)
    .run(user.id, token, expires);

  const baseUrl   = process.env.SITE_URL || 'http://localhost:3001';
  const resetLink = `${baseUrl}/auth/reset-password/${token}`;

  try {
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'CappingAlpha <noreply@cappingalpha.com>',
        to:      [user.email],
        subject: 'Reset your CappingAlpha password',
        html:    `
          <p>You requested a password reset for your CappingAlpha account.</p>
          <p><a href="${resetLink}" style="background:#16a34a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Reset Password</a></p>
          <p>This link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>
        `,
      }),
    });
  } catch (err) {
    console.error('[auth] Resend error:', err.message);
  }

  res.json({ success: true });
});

// ── GET /auth/reset-password/:token ──────────────────────────────────────────
router.get('/reset-password/:token', (req, res) => {
  const { token } = req.params;
  const row = db.prepare(`
    SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now')
  `).get(token);

  if (!row) {
    return res.status(400).send(`<!DOCTYPE html><html><head><title>Link Expired</title>
      <style>body{font-family:sans-serif;max-width:420px;margin:80px auto;text-align:center;color:#1f2937;}
      a{color:#16a34a;}</style></head>
      <body><h2>Link expired or already used</h2>
      <p>Please <a href="/">request a new reset link</a>.</p></body></html>`);
  }

  res.send(`<!DOCTYPE html><html><head><title>Reset Password — CappingAlpha</title>
    <style>
      *{box-sizing:border-box;}
      body{font-family:sans-serif;max-width:420px;margin:80px auto;padding:0 16px;color:#1f2937;background:#f9fafb;}
      h2{margin-bottom:24px;}
      label{display:block;font-size:13px;font-weight:600;margin-bottom:6px;}
      input{width:100%;padding:10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;margin-bottom:16px;}
      button{width:100%;padding:11px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;}
      .err{color:#dc2626;font-size:13px;margin-bottom:12px;display:none;}
    </style></head>
    <body>
      <h2>Reset your password</h2>
      <div class="err" id="err"></div>
      <form id="f">
        <label>New password</label>
        <input type="password" id="pw" minlength="8" required placeholder="At least 8 characters">
        <label>Confirm password</label>
        <input type="password" id="pw2" required placeholder="Repeat password">
        <button type="submit">Set new password</button>
      </form>
      <script>
        document.getElementById('f').addEventListener('submit', async e => {
          e.preventDefault();
          const err = document.getElementById('err');
          const pw = document.getElementById('pw').value;
          const pw2 = document.getElementById('pw2').value;
          err.style.display = 'none';
          if (pw !== pw2) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }
          const r = await fetch('/auth/reset-password', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ token: ${JSON.stringify(token)}, password: pw })
          });
          const data = await r.json();
          if (data.success) {
            document.body.innerHTML = '<h2 style="margin-top:80px;text-align:center;">Password updated!</h2><p style="text-align:center;"><a href="/">Sign in</a></p>';
          } else {
            err.textContent = data.error || 'Something went wrong.';
            err.style.display = 'block';
          }
        });
      </script>
    </body></html>`);
});

// ── POST /auth/reset-password ─────────────────────────────────────────────────
router.post('/reset-password', express.json(), async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const row = db.prepare(`
    SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now')
  `).get(token);
  if (!row) return res.status(400).json({ error: 'This reset link has expired or already been used.' });

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, row.user_id);
  // Burn every outstanding reset token for this user, not just the one used, and
  // evict all their active sessions so a reset actually ends a compromise.
  db.prepare(`UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?`).run(row.user_id);
  try { db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.user.id') = ?`).run(row.user_id); } catch (_) {}

  res.json({ success: true });
});

// ── Paid-tier check ───────────────────────────────────────────────────────────
// Single source of truth for "is this request from a paying user". A logged-in
// user counts as paid when their tier is anything other than 'free' AND their
// access hasn't lapsed. The session `tier` can be stale (a one-time day pass or a
// missed Stripe webhook would otherwise read as paid forever), so re-check the DB
// and honor subscription_expires. NULL expiry = lifetime / comp access.
function isPaid(req) {
  const u = req?.session?.user;
  if (!u) return false;
  // The DB is authoritative, NOT the session tier. A just-completed Stripe webhook
  // updates the DB row but the in-memory session still says 'free', so short-
  // circuiting on u.tier would lock a paying customer out until they re-login. Always
  // read the row and sync the session tier back so /auth/me + the client stay fresh.
  try {
    const row = db.prepare(`SELECT subscription_tier, subscription_expires FROM users WHERE id = ?`).get(u.id);
    if (!row || row.subscription_tier === 'free') { u.tier = 'free'; return false; }
    if (u.tier !== row.subscription_tier) u.tier = row.subscription_tier; // reflect the grant in-session
    if (!row.subscription_expires) return true;  // lifetime / comp
    const exp = new Date(row.subscription_expires);
    if (isNaN(exp.getTime())) return true;        // unparseable -> fail open, don't lock out
    if (exp.getTime() > Date.now()) return true;
    u.tier = 'free';                              // expired -> reflect the downgrade in-session
    return false;
  } catch (_) {
    return !!u.tier && u.tier !== 'free'; // DB error -> fall back to session tier
  }
}

// True for any logged-in user (free account, code, or paid). The #1 ranked pick
// is gated on this — logged-out visitors must create an account to see it.
function isAuthed(req) {
  return !!req?.session?.user;
}

// ── Middleware: require paid tier ─────────────────────────────────────────────
function requirePaid(req, res, next) {
  if (!isPaid(req)) {
    // A 403 on a paid endpoint is always worth a trace: it's either an expired
    // grant (expected) or a session/cookie problem (a paying user locked out).
    const u = req?.session?.user;
    console.warn(`[paywall] 403 ${req.path} — ${u ? `user ${u.id} (${u.email || 'no email'}) tier ${u.tier}` : 'no session'}`);
    return res.status(403).json({ error: 'Paid subscription required.' });
  }
  next();
}

module.exports = router;
module.exports.isPaid             = isPaid;
module.exports.isAuthed           = isAuthed;
module.exports.requirePaid        = requirePaid;
module.exports.stripeWebhook      = stripeWebhook;
module.exports.ensureReferralCode = ensureReferralCode;
