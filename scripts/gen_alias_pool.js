#!/usr/bin/env node
// scripts/gen_alias_pool.js — generate the pseudonym pool for aliased cappers
// (docs/V2_DATABASE_PLAN.md 5c). Handle-style names only (BlueLinePicks,
// RiverCityRick), never a realistic first-and-last name, never derived from the
// real name. Deterministic (seeded) so re-running never reshuffles a shipped
// pool; the output is committed as src/alias_pool.json and assignment happens
// in src/capper_v2.js (random unused name, stored only in capper_registry).
//
//   node scripts/gen_alias_pool.js            # rewrites src/alias_pool.json
//   node scripts/gen_alias_pool.js --count 2000

const fs = require('fs');
const path = require('path');

const A = ['Blue', 'River', 'Night', 'Iron', 'Lucky', 'Quiet', 'Steady', 'Copper', 'Harbor', 'Cedar',
  'Silver', 'Granite', 'Maple', 'Prairie', 'Summit', 'Coastal', 'Velvet', 'Rapid', 'Amber', 'Cobalt',
  'Frost', 'Ember', 'Thunder', 'Meadow', 'Canyon', 'Glacier', 'Atlas', 'Delta', 'Echo', 'Falcon',
  'Harvest', 'Juniper', 'Lantern', 'Marble', 'Nova', 'Orbit', 'Pioneer', 'Quarry', 'Ridge', 'Saddle',
  'Timber', 'Umber', 'Valley', 'Willow', 'Zephyr', 'Beacon', 'Crimson', 'Drift', 'Ivory', 'Kestrel'];
const B = ['Line', 'City', 'Owl', 'Fox', 'Hawk', 'Ledger', 'Slip', 'Ticket', 'Chalk', 'Fade',
  'Angle', 'Bench', 'Corner', 'Dugout', 'Edge', 'Field', 'Glove', 'Hoop', 'Ice', 'Jersey',
  'Keeper', 'Lane', 'Mound', 'Net', 'Oval', 'Pitch', 'Rally', 'Sideline', 'Track', 'Wing',
  'Rick', 'Mo', 'Jo', 'Sal', 'Ace', 'Duke', 'Rex', 'Bo', 'Lou', 'Vic'];
const C = ['Picks', 'Bets', 'Plays', 'Wagers', 'Slips', 'Cards', 'Angles', 'Sheets', 'Locks', 'Sides',
  'Totals', 'Dogs', 'Chalk', 'Units', 'Books', 'Lines', 'Edges', 'Calls', 'Reads', 'Boards'];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function generate(count = 1500) {
  const r = rng(20260916);
  const out = new Set();
  let guard = 0;
  while (out.size < count && guard++ < count * 50) {
    const a = A[Math.floor(r() * A.length)];
    const b = B[Math.floor(r() * B.length)];
    const shape = r();
    let name;
    if (shape < 0.45) name = a + b + C[Math.floor(r() * C.length)];
    else if (shape < 0.75) name = a + b + String(Math.floor(r() * 90) + 10);
    else if (shape < 0.9) name = a + b + String(Math.floor(r() * 900) + 100);
    else name = a + C[Math.floor(r() * C.length)] + String(Math.floor(r() * 90) + 10);
    if (name.length > 16) continue;           // never truncated on a row
    out.add(name);
  }
  return [...out];
}

if (require.main === module) {
  const idx = process.argv.indexOf('--count');
  const count = idx > 0 ? parseInt(process.argv[idx + 1], 10) || 1500 : 1500;
  const names = generate(count);
  const dest = path.join(__dirname, '..', 'src', 'alias_pool.json');
  fs.writeFileSync(dest, JSON.stringify(names, null, 0) + '\n');
  console.log(`wrote ${names.length} names to ${dest}`);
}

module.exports = { generate };
