// src/auth.js — Authentication router
const express = require('express');
const bcrypt  = require('bcrypt');
const db      = require('./db');

const router     = express.Router();
const SALT_ROUNDS = 12;

// ── Helpers ───────────────────────────────────────────────────────────────────
function userPayload(row) {
  return { id: row.id, email: row.email, tier: row.subscription_tier, username: row.username || null };
}

// ── POST /auth/signup ─────────────────────────────────────────────────────────
router.post('/signup', express.json(), async (req, res) => {
  const { email, password, username } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, and underscores only.' });
  }

  const existingEmail = db.prepare(`SELECT id FROM users WHERE LOWER(email) = LOWER(?)`).get(email);
  if (existingEmail) return res.status(409).json({ error: 'An account with that email already exists.' });

  const existingUsername = db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`).get(username);
  if (existingUsername) return res.status(409).json({ error: 'That username is already taken.' });

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, subscription_tier, username)
    VALUES (?, ?, 'free', ?)
  `).run(email.toLowerCase().trim(), hash, username.trim());

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(result.lastInsertRowid);
  req.session.user = userPayload(user);
  res.json({ success: true, user: userPayload(user) });
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', express.json(), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const user = db.prepare(`SELECT * FROM users WHERE LOWER(email) = LOWER(?)`).get(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

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

  // Non-perma codes are single-use
  if (row.type !== 'perma' && row.activated_by != null) {
    return res.status(409).json({ error: 'This code has already been used.' });
  }

  // Compute expiry
  let expires = null;
  if (row.type === 'day')    expires = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();
  if (row.type === 'week')   expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (row.type === 'annual') expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  // perma → expires stays null

  db.prepare(`UPDATE users SET subscription_tier = 'code', subscription_expires = ? WHERE id = ?`)
    .run(expires, req.session.user.id);

  // Lock single-use codes
  if (row.type !== 'perma') {
    db.prepare(`UPDATE access_codes SET activated_by = ?, activated_at = datetime('now') WHERE id = ?`)
      .run(req.session.user.id, row.id);
  }

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
    res.status(500).json({ error: 'Failed to create checkout session.' });
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

// ── Middleware: require paid tier ─────────────────────────────────────────────
function requirePaid(req, res, next) {
  const u = req.session?.user;
  if (!u || u.tier === 'free') {
    return res.status(403).json({ error: 'Paid subscription required.' });
  }
  next();
}

module.exports = router;
module.exports.requirePaid   = requirePaid;
module.exports.stripeWebhook = stripeWebhook;
