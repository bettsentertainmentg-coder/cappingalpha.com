#!/usr/bin/env node
// scripts/mlb_restate.js — THE MLB RESTATEMENT REPLAY (Jack 2026-07-23)
//
// Replays every tracked MLB pick of the v4 era (game_date >= 2026-07-09)
// through the NEW in-sport MLB engine with NO LOOKAHEAD: each pick's backers
// are re-laddered from an MLB Wilson pool built only from decisions graded
// strictly BEFORE that pick's game date. Picks whose replayed score misses
// gold (100) are the restatement's retire list.
//
// Engine parity: the ladder/band/gate/cap math is imported from
// src/capper_ratings.js and the stack/floor constants mirror src/scoring_v3.js
// in-sport mode (20+ sport decisions to rank, quarter-peak stack). Market
// signals and side lean score 0 (their inputs are wiped daily — conservative:
// only makes the retro bar harder). Fade points also 0 (cap 8, rare, and the
// fade roster can't be rebuilt as-of).
//
// Usage:
//   node scripts/mlb_restate.js                 # dry run: table + summary
//   ADMIN_PASSWORD=... node scripts/mlb_restate.js --apply   # POST retire list to prod
//
// Data: newest data/capper-server-pull/capper-server-*.json (refresh first via
// scripts/pull-capper-server.js) + live /api/mvp/public for the tracked rows.
// Idempotent: re-running re-derives the same list; --apply only flips flags.

const fs = require('fs');
const path = require('path');
const ratings = require('../src/capper_ratings');

const V4_LIVE = '2026-07-09';
const SITE = process.env.RESTATE_SITE || 'https://cappingalpha.com';
const INSPORT_MIN_DECISIONS = 20; // mirrors scoring_v3.js
const SPORT_TOP_PTS = 20, SPORT_GOOD_PTS = 10; // mirrors capper_ratings.js

const pullDir = path.join(__dirname, '..', 'data', 'capper-server-pull');
const pullFile = fs.readdirSync(pullDir)
  .filter(f => /^capper-server-.*\.json$/.test(f))
  .map(f => ({ f, m: fs.statSync(path.join(pullDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0];
if (!pullFile) { console.error('No capper-server pull found. Run scripts/pull-capper-server.js first.'); process.exit(1); }
const pull = JSON.parse(fs.readFileSync(path.join(pullDir, pullFile.f)));
console.log(`pull: ${pullFile.f} (${Object.keys(pull.cappers).length} cappers)`);

// Per-capper MLB graded history (chronological) + slot backer index
const capMlb = new Map();   // name -> [{date, win, units}]
const slotBackers = new Map(); // gameId|team|type -> Set(names)
for (const name of Object.keys(pull.cappers)) {
  if (name.startsWith('@src:')) continue;
  for (const p of (pull.cappers[name].picks || [])) {
    if (p.sport !== 'MLB' || !p.game_date) continue;
    const res = (p.result || '').toLowerCase();
    if (res === 'win' || res === 'loss') {
      if (!capMlb.has(name)) capMlb.set(name, []);
      capMlb.get(name).push({ date: p.game_date, win: res === 'win' ? 1 : 0, units: ratings.profit(p) });
    }
    if (p.game_date >= V4_LIVE && p.espn_game_id) {
      const key = `${p.espn_game_id}|${(p.team || '').toLowerCase()}|${(p.pick_type || '').toLowerCase()}`;
      if (!slotBackers.has(key)) slotBackers.set(key, new Set());
      slotBackers.get(key).add(name);
    }
  }
}
for (const rows of capMlb.values()) rows.sort((a, b) => (a.date < b.date ? -1 : 1));

// As-of MLB pool for a given date -> Map(name -> ladder standing), memoized per date.
const poolCache = new Map();
function poolAsOf(date) {
  if (poolCache.has(date)) return poolCache.get(date);
  const members = [];
  for (const [name, rows] of capMlb) {
    let w = 0, dec = 0, u = 0;
    for (const r of rows) { if (r.date >= date) break; w += r.win; dec++; u += r.units; }
    if (dec >= 1) members.push({ key: name, wilson: ratings.wilsonLower(w, dec), winPct: (100 * w) / dec, decisions: dec, w, u });
  }
  ratings.rankPool(members);
  const out = new Map();
  for (const m of members) {
    const band = ratings.bandFor(m.pctile);
    const cap = ratings.capForDecisions(m.decisions);
    const slid = band.key === 'bottom25' ? 0 : ratings.ladderPts(m.pctile);
    const zero = m.winPct <= ratings.HARD_ZERO_WIN;
    const t = Math.min(ratings.gateT(m.w, m.decisions), ratings.moneyGateT(m.u, m.decisions));
    const pts = (zero || band.key === 'bottom25') ? 0
      : ratings.UNRANKED_PTS + t * (Math.min(slid, cap) - ratings.UNRANKED_PTS);
    const bonusRaw = m.wilson > 0 && (m.rank === 1 || m.pctile <= 0.05) ? SPORT_TOP_PTS
                   : m.wilson > 0 && m.pctile <= 0.25 ? SPORT_GOOD_PTS : 0;
    out.set(m.key, {
      pts: +pts.toFixed(1), band: band.key, rank: m.rank, decisions: m.decisions,
      bonus: zero ? 0 : Math.round(t * bonusRaw),
    });
  }
  poolCache.set(date, out);
  return out;
}

// The in-sport score replay: best backer + quarter-peak stack + in-sport bonus.
function replayScore(backerNames, date) {
  const pool = poolAsOf(date);
  const backers = [...backerNames].map(name => {
    const s = pool.get(name);
    if (!s || s.decisions < INSPORT_MIN_DECISIONS || s.pts == null) {
      return { name, pts: ratings.UNRANKED_PTS, band: 'untracked', decisions: s?.decisions ?? 0, bonus: 0 };
    }
    return { name, ...s };
  }).sort((a, b) => b.pts - a.pts);
  const best = backers[0] ?? null;
  let consensus = 0;
  const bandSeen = {};
  for (const b of backers.slice(1)) {
    if (b.pts <= 0 || ['untracked', 'new', 'bottom25'].includes(b.band)) continue;
    if (b.decisions < INSPORT_MIN_DECISIONS) continue;
    const k = bandSeen[b.band] || 0;
    consensus += b.pts / Math.pow(2, Math.floor(k / 2) + 2); // quarter-peak (insport)
    bandSeen[b.band] = k + 1;
  }
  const bonus = best?.bonus ?? 0;
  const total = Math.round((best?.pts ?? ratings.UNRANKED_PTS) + consensus + bonus);
  return { total, best: best?.name ?? null, bestPts: best?.pts ?? ratings.UNRANKED_PTS, stack: Math.round(consensus), bonus, backerCount: backers.length };
}

async function main() {
  const mvpRes = await fetch(`${SITE}/api/mvp/public`);
  if (!mvpRes.ok) { console.error(`GET /api/mvp/public failed: ${mvpRes.status}`); process.exit(1); }
  const mvp = (await mvpRes.json()).picks || [];
  const targets = mvp.filter(p => p.sport === 'MLB' && p.game_date >= V4_LIVE);
  console.log(`tracked MLB rows in the v4 era (resolved+void): ${targets.length}`);

  const keep = [], retire = [];
  for (const p of targets) {
    const key = `${p.espn_game_id}|${(p.team || '').toLowerCase()}|${(p.pick_type || '').toLowerCase()}`;
    const names = slotBackers.get(key) || new Set();
    const r = replayScore(names, p.game_date);
    const row = { id: p.id, date: p.game_date, team: p.team, type: p.pick_type, oldScore: p.score, newScore: r.total, best: r.best, result: p.result };
    if (r.total >= 100) keep.push(row); else retire.push(row);
  }

  const rec = rows => {
    const w = rows.filter(r => r.result === 'win').length, l = rows.filter(r => r.result === 'loss').length;
    const v = rows.filter(r => !['win', 'loss', 'push'].includes(r.result)).length;
    return `${w}-${l}-${rows.filter(r => r.result === 'push').length} (void ${v})${w + l ? ` ${(100 * w / (w + l)).toFixed(1)}%` : ''}`;
  };
  console.log(`\nKEEP   ${keep.length}: ${rec(keep)}`);
  console.log(`RETIRE ${retire.length}: ${rec(retire)}`);
  console.log('\nRetire list:');
  for (const r of retire) console.log(`  #${String(r.id).padEnd(5)} ${r.date} ${String(r.team).padEnd(24)} ${String(r.type).padEnd(6)} ${String(r.oldScore).padStart(3)} -> ${String(r.newScore).padStart(3)}  ${r.result}`);

  const outPath = path.join(pullDir, `mlb-restate-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), keep, retire }, null, 2));
  console.log(`\nsaved -> ${outPath}`);

  if (process.argv.includes('--apply')) {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) { console.error('--apply needs ADMIN_PASSWORD'); process.exit(1); }
    const note = 'restated: pre-rework MLB scoring (2026-07-23 in-sport replay)';
    const resp = await fetch(`${SITE}/admin/api/retire-mvp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-password': pw },
      body: JSON.stringify({ ids: retire.map(r => r.id), retired: 1, note }),
    });
    console.log(`apply: ${resp.status} ${await resp.text()}`);
  } else {
    console.log('\nDry run. Re-run with --apply (ADMIN_PASSWORD set) to retire on the server.');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
