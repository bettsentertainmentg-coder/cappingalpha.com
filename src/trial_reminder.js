// src/trial_reminder.js — Phase 7f: a heads-up push roughly a day before a paid
// period ends. One message covers both cases (trial ending, regular renewal),
// so no first-invoice detection is needed: the copy reads correctly either way.
//
// Called from the 5-min cron in index.js behind an hour === 16 ET gate, so it
// scans about every 5 minutes inside that one hour. push.sendOnce dedupes on
// (user, 'account', subscription id + period-end date), so each period end
// delivers at most one notification no matter how many passes observe it.
// Day passes and access codes never set stripe_subscription_id, so they are
// excluded by the query; only real Stripe subscriptions get the reminder.

const db = require('./db');
const push = require('./push');

const WINDOW_HOURS = 26;

async function runTrialReminders() {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, stripe_subscription_id, subscription_expires FROM users
      WHERE subscription_tier != 'free'
        AND stripe_subscription_id IS NOT NULL
        AND subscription_expires IS NOT NULL
    `).all();
  } catch (_) { return 0; }

  let sent = 0;
  for (const u of rows) {
    const exp = Date.parse(u.subscription_expires);
    if (isNaN(exp)) continue;
    const hoursLeft = (exp - Date.now()) / 36e5;
    if (hoursLeft <= 0 || hoursLeft > WINDOW_HOURS) continue;
    const key = `renew:${u.stripe_subscription_id}:${String(u.subscription_expires).slice(0, 10)}`;
    const ok = await push.sendOnce(u.id, 'account', key, {
      title: 'Your CA Rankings access renews soon',
      body: 'Your trial or current period ends tomorrow. Manage your plan any time in Settings.',
      type: 'account',
      url: '/#settings',
    });
    if (ok) sent++;
  }
  return sent;
}

module.exports = { runTrialReminders };
