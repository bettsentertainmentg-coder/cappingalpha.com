#!/usr/bin/env node
// scripts/seed_capper_history.js — load a prod capper export into the LOCAL DB
// so the V2 capper database can be worked on without prod data.
//
//   node scripts/seed_capper_history.js [path/to/full-export.json] [--replace] [--game <espn_game_id>]
//
// Default export: the newest data/capper-server-pull/full-export-*.json in
// the main checkout (or this one). Loads capper_history, capper_aliases and
// capper_source_handles (INSERT OR IGNORE by id / key; --replace wipes the
// three tables first), shims pm_wallets with every polymarket handle in the
// export (LOCAL ONLY: prod's pm_wallets is the straight-bettor screen's
// output), upserts a today_games row per busiest recent game from
// pick_history (status 'pre', starting in three hours) so the game page has a
// real section to render, then runs recomputeCapperV2().
//
// Never run against prod. It refuses when RAILWAY_ENVIRONMENT is set.

const fs = require('fs');
const path = require('path');

if (process.env.RAILWAY_ENVIRONMENT) { console.error('refusing to seed on Railway'); process.exit(1); }

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const gameIdx = args.indexOf('--game');
const onlyGame = gameIdx > 0 ? args[gameIdx + 1] : null;
let file = args.find((a) => a.endsWith('.json'));
if (!file) {
  const dirs = [path.join(__dirname, '..', 'data', 'capper-server-pull'), path.join(__dirname, '..', '..', 'capperboss', 'data', 'capper-server-pull')];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const c = fs.readdirSync(d).filter((f) => /^full-export-\d+\.json$/.test(f)).sort();
    if (c.length) { file = path.join(d, c[c.length - 1]); break; }
  }
}
if (!file || !fs.existsSync(file)) { console.error('no export file found; pass a path'); process.exit(1); }

const db = require('../src/db');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(`[seed] ${file}: ${(data.capper_history || []).length} history rows, ${(data.capper_aliases || []).length} aliases, ${(data.capper_source_handles || []).length} handles`);

const cols = ['id', 'capper_name', 'sport', 'pick_type', 'team', 'spread', 'espn_game_id', 'game_date', 'channel', 'score',
  'result', 'pick_id', 'saved_at', 'odds', 'source', 'is_home_team', 'sources_json', 'score_v2_original'];
const have = new Set(db.prepare(`PRAGMA table_info(capper_history)`).all().map((c) => c.name));
const use = cols.filter((c) => have.has(c));
const ins = db.prepare(`INSERT OR IGNORE INTO capper_history (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`);
const insAlias = db.prepare(`INSERT OR IGNORE INTO capper_aliases (canonical_name, alias) VALUES (?, ?)`);
const insHandle = db.prepare(`INSERT OR IGNORE INTO capper_source_handles (source, handle, canonical_name, meta_json) VALUES (?, ?, ?, ?)`);
const insWallet = db.prepare(`INSERT OR IGNORE INTO pm_wallets (wallet, username) VALUES (?, ?)`);
const insReg = db.prepare(`INSERT OR IGNORE INTO capper_registry (canonical_name) VALUES (?)`);

const tx = db.transaction(() => {
  if (replace) {
    for (const t of ['capper_history', 'capper_aliases', 'capper_source_handles', 'capper_ratings_v2', 'capper_qualifications']) db.exec(`DELETE FROM ${t}`);
    db.exec(`UPDATE capper_registry SET live_at = NULL`);
  }
  let n = 0;
  for (const r of data.capper_history || []) {
    // pick_id collisions with local rows would trip the dedup index; the seed
    // is a calibration copy, so drop pick_id on the way in.
    const row = Object.assign({}, r, { pick_id: null });
    ins.run(...use.map((c) => (row[c] === undefined ? null : row[c])));
    n++;
  }
  for (const a of data.capper_aliases || []) insAlias.run(a.canonical_name, a.alias);
  let wallets = 0;
  for (const h of data.capper_source_handles || []) {
    insHandle.run(h.source, h.handle, h.canonical_name, h.meta_json || null);
    insReg.run(h.canonical_name);
    if (h.source === 'polymarket') { insWallet.run(String(h.handle).toLowerCase(), h.canonical_name); wallets++; }
  }
  console.log(`[seed] inserted ${n} history rows; ${wallets} polymarket wallets shimmed into pm_wallets (local only)`);
});
tx();

// A today_games row per busy recent game so the section renders locally.
const ph = data.pick_history || [];
const byGame = new Map();
for (const r of data.capper_history || []) {
  if (!r.espn_game_id) continue;
  byGame.set(r.espn_game_id, (byGame.get(r.espn_game_id) || 0) + 1);
}
let targets = [...byGame.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
if (onlyGame) targets = [onlyGame];
const phById = new Map();
for (const p of ph) if (!phById.has(p.espn_game_id)) phById.set(p.espn_game_id, p);
const tgCols = new Set(db.prepare(`PRAGMA table_info(today_games)`).all().map((c) => c.name));
const upsert = db.prepare(`
  INSERT INTO today_games (espn_game_id, sport, status, start_time, home_team, away_team, home_abbr, away_abbr, home_short, away_short,
    ml_home, ml_away, spread_home, spread_away, over_under, ou_over_odds, ou_under_odds)
  VALUES (@espn_game_id, @sport, 'pre', @start_time, @home_team, @away_team, @home_abbr, @away_abbr, @home_short, @away_short,
    @ml_home, @ml_away, @spread_home, @spread_away, @over_under, -110, -110)
  ON CONFLICT(espn_game_id) DO UPDATE SET status = 'pre', start_time = excluded.start_time
`);
let seeded = 0;
const start = new Date(Date.now() + 3 * 3600e3).toISOString();
for (const id of targets) {
  const p = phById.get(id);
  if (!p) continue;
  if (!tgCols.has('home_short')) break;
  const rows = (data.capper_history || []).filter((r) => r.espn_game_id === id);
  const spreadRow = rows.find((r) => r.pick_type === 'spread' && r.spread != null);
  const totalRow = rows.find((r) => (r.pick_type === 'over' || r.pick_type === 'under') && r.spread != null);
  const mlHome = rows.find((r) => String(r.pick_type).toLowerCase() === 'ml' && r.is_home_team === 1 && r.odds != null);
  const mlAway = rows.find((r) => String(r.pick_type).toLowerCase() === 'ml' && r.is_home_team === 0 && r.odds != null);
  try {
    upsert.run({
      espn_game_id: id, sport: p.sport, start_time: start, home_team: p.home_team, away_team: p.away_team,
      home_abbr: p.home_abbr, away_abbr: p.away_abbr, home_short: (p.home_team || '').split(' ').pop(), away_short: (p.away_team || '').split(' ').pop(),
      ml_home: mlHome ? mlHome.odds : null, ml_away: mlAway ? mlAway.odds : null,
      spread_home: spreadRow ? (spreadRow.is_home_team ? spreadRow.spread : -spreadRow.spread) : null,
      spread_away: spreadRow ? (spreadRow.is_home_team ? -spreadRow.spread : spreadRow.spread) : null,
      over_under: totalRow ? totalRow.spread : null,
    });
    seeded++;
    console.log(`[seed] today_games <- ${id} ${p.sport} ${p.away_team} @ ${p.home_team} (${byGame.get(id)} capper rows)`);
  } catch (err) { console.warn(`[seed] today_games ${id}: ${err.message}`); }
  if (seeded >= (onlyGame ? 1 : 6)) break;
}

const { recomputeCapperV2 } = require('../src/capper_v2');
console.log(recomputeCapperV2());
