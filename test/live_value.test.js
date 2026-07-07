// test/live_value.test.js — run: node test/live_value.test.js
// Tests the CURRENT contract: computeValuePulse returns a SIGNED value in
// [-100, +100] (magnitude is an alias), with sign/color/label bands and
// adaptive EMA smoothing.
const assert = require('node:assert');
const { computeValuePulse } = require('../src/live_value');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// Strong pick trailing but alive -> positive value, gold, comeback wording.
const earlyDown = computeValuePulse({ pickWP_now: 0.42, pickWP_pre: 0.62, caScore: 55, gameProgress: 0.2, trailing: true });
ok(earlyDown.value > 12, 'strong pick down early shows positive value');
ok(earlyDown.sign === 1 && earlyDown.color === '#FFD700', 'buy-low spot is gold');
ok(/comeback/i.test(earlyDown.label), 'trailing pick reads as comeback');

// Same spot but NOT trailing (e.g. tied) -> never uses "comeback" wording.
const tiedDown = computeValuePulse({ pickWP_now: 0.42, pickWP_pre: 0.62, caScore: 55, gameProgress: 0.2, trailing: false });
ok(!/comeback/i.test(tiedDown.label), 'non-trailing pick never reads comeback');

// Cruising favorite (priced up past its lock) -> negative swing pulls value down.
const cruising = computeValuePulse({ pickWP_now: 0.85, pickWP_pre: 0.62, caScore: 55, gameProgress: 0.5 });
ok(cruising.value < earlyDown.value, 'cruising pick shows less value than a live buy-low');

// Hopeless pick late -> negative value (blue).
const blowout = computeValuePulse({ pickWP_now: 0.04, pickWP_pre: 0.55, caScore: 55, gameProgress: 0.9, trailing: true });
ok(blowout.value < -12 && blowout.sign === -1 && blowout.color === '#3b82f6', 'hopeless spot goes negative (blue)');

// Conviction: higher CA -> higher target, but modest.
const lowCA  = computeValuePulse({ pickWP_now: 0.5, pickWP_pre: 0.55, caScore: 35, gameProgress: 0.3 });
const highCA = computeValuePulse({ pickWP_now: 0.5, pickWP_pre: 0.55, caScore: 65, gameProgress: 0.3 });
ok(highCA.target > lowCA.target, 'higher CA score nudges target up');
ok(highCA.target - lowCA.target < 25, 'CA nudge stays modest');

// EMA continuity: small moves smooth (alpha 0.6). The pick stays fully alive
// (WP >= 0.5) so the deepening deficit reads as a growing buy-low.
const a = computeValuePulse({ pickWP_now: 0.62, pickWP_pre: 0.70, caScore: 55, gameProgress: 0.3 });
const b = computeValuePulse({ pickWP_now: 0.55, pickWP_pre: 0.70, caScore: 55, gameProgress: 0.32, prevMagnitude: a.value });
ok(Math.abs(b.value - a.value) < Math.abs(b.target - a.value), 'small move is smoothed toward target');
ok(b.trend > 0, 'deepening deficit (still alive) trends up');

// ...big jumps catch up fast (adaptive alpha 0.85 beyond a 25pt jump): a healthy
// buy-low spot collapsing to near-dead in one poll.
const calm  = computeValuePulse({ pickWP_now: 0.45, pickWP_pre: 0.62, caScore: 55, gameProgress: 0.4 });
const shock = computeValuePulse({ pickWP_now: 0.06, pickWP_pre: 0.62, caScore: 55, gameProgress: 0.45, trailing: true, prevMagnitude: calm.value });
const gap   = shock.target - calm.value;
ok(Math.abs(gap) > 25, 'test setup: the shock is a big jump');
ok(Math.abs(shock.value - calm.value) >= Math.abs(gap) * 0.8, 'big swing catches up in one poll (fast alpha)');

// Bounds + shape.
for (const r of [earlyDown, tiedDown, cruising, blowout, lowCA, highCA, a, b, calm, shock]) {
  ok(r.value >= -100 && r.value <= 100, 'value bounded [-100, 100]');
  ok(r.magnitude === r.value, 'magnitude aliases the signed value');
  ok(typeof r.label === 'string' && r.label.length > 0, 'label present');
  ok([-1, 0, 1].includes(r.sign), 'sign is -1/0/1');
}

console.log(`live_value.test.js: ${n} assertions passed`);
