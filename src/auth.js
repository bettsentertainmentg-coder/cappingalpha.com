// src/auth.js — Authentication router
const express = require('express');
const bcrypt  = require('bcrypt');
const crypto  = require('crypto');
const db      = require('./db');

const router     = express.Router();
const SALT_ROUNDS = 12;

// ── Helpers ───────────────────────────────────────────────────────────────────
function userPayload(row) {
  return { id: row.id, email: row.email, tier: row.subscription_tier, username: row.username || null };
}

// ── POST /auth/signup ─────────────────────────────────────────────────────────
router.post('/signup', express.json(), async (req, res) => {
  const { email, password, username, tos_agreed, public_leaderboard } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, and underscores only.' });
  }
  if (!tos_agreed) return res.status(400).json({ error: 'You must agree to the Terms of Service.' });

  const existingEmail = db.prepare(`SELECT id FROM users WHERE LOWER(email) = LOWER(?)`).get(email);
  if (existingEmail) return res.status(409).json({ error: 'An account with that email already exists.' });

  const existingUsername = db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`).get(username);
  if (existingUsername) return res.status(409).json({ error: 'That username is already taken.' });

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, subscription_tier, username, tos_accepted_at)
    VALUES (?, ?, 'free', ?, datetime('now'))
  `).run(email.toLowerCase().trim(), hash, username.trim());

  // Leaderboard visibility chosen at signup (default public when omitted).
  const isPublic = public_leaderboard === false ? 0 : 1;
  try {
    db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id, favorite_sports, is_public) VALUES (?, '[]', ?)`)
      .run(result.lastInsertRowid, isPublic);
  } catch (_) {}

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(result.lastInsertRowid);
  req.session.user = userPayload(user);
  res.json({ success: true, user: userPayload(user) });
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', express.json(), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email or username and password required.' });

  // Accept email OR username
  const user = db.prepare(`
    SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)
  `).get(email, email);
  if (!user) return res.status(401).json({ error: 'Invalid email/username or password.' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid email/username or password.' });

  req.session.user = userPayload(user);
  res.json({ success: true, user: userPayload(user) });
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

  // 1) known google_id  2) same email (link it)  3) brand-new account
  let user = db.prepare(`SELECT * FROM users WHERE google_id = ?`).get(googleId);
  if (!user) {
    const byEmail = db.prepare(`SELECT * FROM users WHERE LOWER(email) = LOWER(?)`).get(email);
    if (byEmail) {
      db.prepare(`UPDATE users SET google_id = ? WHERE id = ?`).run(googleId, byEmail.id);
      user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(byEmail.id);
    }
  }
  if (!user) {
    const username   = deriveUsername(email);
    const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), SALT_ROUNDS);
    const result = db.prepare(`
      INSERT INTO users (email, password_hash, subscription_tier, username, google_id, tos_accepted_at)
      VALUES (?, ?, 'free', ?, ?, datetime('now'))
    `).run(email, randomHash, username, googleId);
    try {
      db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id, favorite_sports) VALUES (?, '[]')`)
        .run(result.lastInsertRowid);
    } catch (_) {}
    user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(result.lastInsertRowid);
    console.log(`[auth] New Google account: ${email} (@${username})`);
  }

  req.session.user = userPayload(user);
  res.json({ success: true, user: userPayload(user) });
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.session?.user) return res.json({ user: null });
  // Re-fetch from DB so subscription_expires is fresh
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.session.user.id);
  if (!row) return res.json({ user: null });
  res.json({
    user: {
      id:                   row.id,
      email:                row.email,
      username:             row.username || null,
      tier:                 row.subscription_tier,
      subscription_expires: row.subscription_expires,
    }
  });
});

// ── POST /auth/redeem-code ────────────────────────────────────────────────────
router.post('/redeem-code', express.json(), (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'You must be logged in to redeem a code.' });

  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'No code provided.' });

  const row = db.prepare(`SELECT * FROM access_codes WHERE LOWER(code) = LOWER(?)`).get(code.trim());
  if (!row) return res.status(401).json({ error: 'Invalid code. Try again.' });

  // ALL codes are single-use
  if (row.activated_by != null) {
    return res.status(409).json({ error: 'This code has already been used.' });
  }

  // Compute expiry
  let expires = null;
  if (row.type === 'day')      expires = new Date(Date.now() + 1   * 24 * 60 * 60 * 1000).toISOString();
  if (row.type === 'week')     expires = new Date(Date.now() + 7   * 24 * 60 * 60 * 1000).toISOString();
  if (row.type === 'annual')   expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  if (row.type === 'lifetime') expires = null; // lifetime = no expiry, single-use

  db.prepare(`UPDATE users SET subscription_tier = 'code', subscription_expires = ? WHERE id = ?`)
    .run(expires, req.session.user.id);

  // Lock the code — always single-use now
  db.prepare(`UPDATE access_codes SET activated_by = ?, activated_at = datetime('now') WHERE id = ?`)
    .run(req.session.user.id, row.id);

  console.log(`[auth] Code "${row.code}" (${row.type}) redeemed by user ${req.session.user.id} (${req.session.user.email || req.session.user.username}), expires: ${expires || 'never'}`);

  req.session.user.tier = 'code';
  res.json({ success: true });
});

// ── Stripe ────────────────────────────────────────────────────────────────────
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  'price_1TMhkAB0ohior8iouVKseqmk': { label: 'Day Pass', mode: 'payment',      hours: 24 },
  'price_1TMhkCB0ohior8iomOMDlrts': { label: 'Weekly',   mode: 'subscription'               },
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
    const session = await stripe.checkout.sessions.create({
      mode:       plan.mode,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata:   { userId: String(user.id) },
      customer_email: user.email,
      success_url: `${baseUrl}/?payment=success`,
      cancel_url:  `${baseUrl}/?payment=cancelled`,
    });
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
        // Day pass — 24h
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        db.prepare(`UPDATE users SET subscription_tier='paid', subscription_expires=? WHERE id=?`).run(expires, userId);
        console.log(`[stripe] Day pass granted to user ${userId}, expires ${expires}`);

      } else if (session.mode === 'subscription') {
        // Weekly or annual — get period end from subscription object
        const sub     = await stripe.subscriptions.retrieve(session.subscription);
        const expires = new Date(sub.current_period_end * 1000).toISOString();
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
      if (!invoice.subscription) return res.json({ received: true });
      const user = db.prepare(`SELECT id FROM users WHERE stripe_subscription_id=?`).get(invoice.subscription);
      if (user) {
        const sub     = await stripe.subscriptions.retrieve(invoice.subscription);
        const expires = new Date(sub.current_period_end * 1000).toISOString();
        db.prepare(`UPDATE users SET subscription_tier='paid', subscription_expires=? WHERE id=?`).run(expires, user.id);
        console.log(`[stripe] Subscription renewed for user ${user.id}, expires ${expires}`);
      }
    }

    if (type === 'customer.subscription.deleted') {
      // Cancelled — downgrade to free
      const sub  = data.object;
      const user = db.prepare(`SELECT id FROM users WHERE stripe_subscription_id=?`).get(sub.id);
      if (user) {
        db.prepare(`
          UPDATE users SET subscription_tier='free', subscription_expires=NULL, stripe_subscription_id=NULL WHERE id=?
        `).run(user.id);
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
  db.prepare(`UPDATE password_reset_tokens SET used = 1 WHERE id = ?`).run(row.id);

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
  if (!u || u.tier === 'free') return false;
  try {
    const row = db.prepare(`SELECT subscription_tier, subscription_expires FROM users WHERE id = ?`).get(u.id);
    if (!row || row.subscription_tier === 'free') return false;
    if (!row.subscription_expires) return true; // lifetime / comp
    const exp = new Date(row.subscription_expires);
    if (isNaN(exp.getTime())) return true;       // unparseable -> fail open, don't lock out
    return exp.getTime() > Date.now();
  } catch (_) {
    return u.tier !== 'free'; // DB error -> fall back to session tier
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
    return res.status(403).json({ error: 'Paid subscription required.' });
  }
  next();
}

module.exports = router;
module.exports.isPaid        = isPaid;
module.exports.isAuthed      = isAuthed;
module.exports.requirePaid   = requirePaid;
module.exports.stripeWebhook = stripeWebhook;
