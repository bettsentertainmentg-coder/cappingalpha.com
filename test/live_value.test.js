// test/live_value.test.js — run: node test/live_value.test.js
const assert = require('node:assert');
const { computeValuePulse } = require('../src/live_value');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// Strong pick down early -> value present (above the dead-band).
const earlyDown = computeValuePulse({ pickWP_now: 0.56, pickWP_pre: 0.65, caScore: 40, gameProgress: 0.11 });
ok(earlyDown.magnitude >= 0.10, 'strong pick down early shows value');

// Cruising (winning more than pre-game) -> ~0 (nothing to recover).
const cruising = computeValuePulse({ pickWP_now: 0.82, pickWP_pre: 0.65, caScore: 40, gameProgress: 0.4 });
ok(cruising.magnitude < 0.10 && cruising.band === 'steady', 'cruising pick = steady ~0');

// Blowout (down big, late) -> ~0 (no resilience, no time).
const blowout = computeValuePulse({ pickWP_now: 0.03, pickWP_pre: 0.5, caScore: 40, gameProgress: 0.9 });
ok(blowout.magnitude < 0.10 && blowout.band === 'steady', 'blowout = steady ~0');

// Walk-off leverage (down 1, bottom 9th) -> does NOT strobe a strong value (little game left).
const walkoff = computeValuePulse({ pickWP_now: 0.40, pickWP_pre: 0.50, caScore: 40, gameProgress: 0.95 });
ok(walkoff.magnitude < 0.10, 'late single-run swing stays in the dead-band');

// Trend: deficit deepening -> building (gold, rising); recovering -> fading (blue).
const s1 = computeValuePulse({ pickWP_now: 0.60, pickWP_pre: 0.66, caScore: 55, gameProgress: 0.15 });
const s2 = computeValuePulse({ pickWP_now: 0.52, pickWP_pre: 0.66, caScore: 55, gameProgress: 0.2, prevMagnitude: s1.magnitude });
ok(s2.trend > 0 && s2.sign === 1 && s2.color === '#FFD700', 'deepening deficit -> building (gold)');
const s3 = computeValuePulse({ pickWP_now: 0.64, pickWP_pre: 0.66, caScore: 55, gameProgress: 0.3, prevMagnitude: s2.magnitude });
ok(s3.trend < 0 && s3.sign === -1 && s3.color === '#3b82f6', 'recovering -> fading (blue)');

// CA conviction nudges but does not dominate: higher CA -> >= magnitude, within a small band.
const lowCA  = computeValuePulse({ pickWP_now: 0.55, pickWP_pre: 0.66, caScore: 35, gameProgress: 0.15 });
const highCA = computeValuePulse({ pickWP_now: 0.55, pickWP_pre: 0.66, caScore: 65, gameProgress: 0.15 });
ok(highCA.target >= lowCA.target, 'higher CA score nudges value up');
ok((highCA.target - lowCA.target) / Math.max(lowCA.target, 1e-6) < 0.6, 'CA nudge stays modest (< ~60%)');

// Magnitude always bounded [0,1].
for (const r of [earlyDown, cruising, blowout, walkoff, s1, s2, s3, lowCA, highCA]) {
  ok(r.magnitude >= 0 && r.magnitude <= 1, 'magnitude bounded [0,1]');
}

console.log(`live_value.test.js: ${n} assertions passed`);
