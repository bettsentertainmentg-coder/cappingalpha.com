// The heavy-price restatement (Jack 2026-07-28): retire every v4-era tracked
// ML bet priced at or past the heavy gate (-300 default), so the record reads
// as if the tracked-bet price gate existed from v4 day one (2026-07-09).
//
// Why: the v4-era ledger's entire deficit traced to heavy-favorite MLs —
// 37-13 (74% wins) and -6.29u at -300 or worse. Removing bets that mostly WON
// is the defensible direction: the displayed win% drops, the P/L honests up.
//
// Same mechanism as scripts/mlb_restate.js: rows are never deleted, the
// retired flag is reversible, retired rows stay visible in the admin MVP panel
// with a RETIRED badge. Public record surfaces already filter retired rows.
//
// Dry run:  node scripts/heavy_restate.js
// Apply:    ADMIN_PASSWORD='...' node scripts/heavy_restate.js --apply
// Optional: RESTATE_SITE=... HEAVY_GATE=-300 V4_LIVE=2026-07-09

const SITE = process.env.RESTATE_SITE || 'https://cappingalpha.com';
const GATE = (() => { const v = parseFloat(process.env.HEAVY_GATE || '-300'); return Number.isFinite(v) && v < 0 ? v : -300; })();
const V4_LIVE = process.env.V4_LIVE || '2026-07-09';

async function main() {
  const mvpRes = await fetch(`${SITE}/api/mvp/public`);
  if (!mvpRes.ok) { console.error(`GET /api/mvp/public failed: ${mvpRes.status}`); process.exit(1); }
  const mvp = (await mvpRes.json()).picks || [];

  const missingOdds = mvp.filter(p => (p.pick_type || '').toLowerCase() === 'ml' && p.game_date >= V4_LIVE && p.ml_odds == null);
  if (missingOdds.length) console.warn(`note: ${missingOdds.length} v4-era ML rows carry no ml_odds and cannot be judged (left untouched)`);

  const retire = mvp.filter(p =>
    (p.pick_type || '').toLowerCase() === 'ml'
    && p.game_date >= V4_LIVE
    && p.ml_odds != null && parseFloat(p.ml_odds) <= GATE
    && !p.retired);

  const w = retire.filter(r => r.result === 'win').length;
  const l = retire.filter(r => r.result === 'loss').length;
  let units = 0;
  for (const r of retire) {
    if (r.result === 'win') units += 100 / Math.abs(parseFloat(r.ml_odds));
    else if (r.result === 'loss') units -= 1;
  }
  console.log(`Heavy-price restatement vs gate ${GATE}, era ${V4_LIVE}+`);
  console.log(`RETIRE ${retire.length}: ${w}-${l}${w + l ? ` (${(100 * w / (w + l)).toFixed(1)}%)` : ''}, ${units >= 0 ? '+' : ''}${units.toFixed(2)}u leaves the record`);
  for (const r of retire) {
    console.log(`  #${String(r.id).padEnd(5)} ${r.game_date} ${String(r.sport || '').padEnd(7)} ${String(r.team).padEnd(26)} ${String(r.ml_odds).padStart(7)}  ${r.result || 'pending'}`);
  }

  if (process.argv.includes('--apply')) {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) { console.error('--apply needs ADMIN_PASSWORD'); process.exit(1); }
    if (!retire.length) { console.log('nothing to retire'); return; }
    const note = `restated: heavy-price gate ${GATE} (tracked-bet ML odds gate, 2026-07-28)`;
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
