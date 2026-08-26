// scripts/pm_calibrate.js
// Admission-threshold calibration for the Polymarket holders screen.
// Sweeps today's mapped game markets exactly like discoverPmHolders does,
// profiles each candidate wallet, grades its settled pregame history OURSELVES
// (on-chain resolution, flat one-unit stakes at the price it actually paid),
// and prints what each proposed threshold set would admit. Measuring first is
// the point: a bar nobody clears is as useless as no bar at all.
//
// Usage: node scripts/pm_calibrate.js [candidateCount]

const db = require('../src/db');
const pm = require('../src/polymarket_wallets');

const N = parseInt(process.argv[2] || '30', 10);

const { unitReturn } = pm; // same flat-stake math the ingest gates on

(async () => {
  const cfg = pm.holdersCfg();
  // Widen the walk so a candidate's record is measured on everything available,
  // not just the 25 rows we would keep.
  const wide = { ...cfg, maxDecisions: 200 };

  const map = await pm.buildMarketMap();
  console.log(`markets mapped: ${map.size}`);
  const tracked = new Set(db.prepare('SELECT wallet FROM pm_wallets').all().map((r) => r.wallet));

  const cands = new Map();
  for (const [cid, entry] of map) {
    const res = await pm.getJson(`https://data-api.polymarket.com/holders?market=${encodeURIComponent(cid)}&limit=5`);
    if (res.status !== 200 || !Array.isArray(res.json)) continue;
    for (const tb of res.json) {
      for (const h of (tb.holders || [])) {
        const w = h.proxyWallet;
        if (!w || tracked.has(w)) continue;
        const price = entry.prices?.[h.outcomeIndex];
        const est = Number.isFinite(price) ? (parseFloat(h.amount) || 0) * price : 0;
        if (est < cfg.minUsd) continue;
        const prev = cands.get(w);
        if (!prev || est > prev.est) cands.set(w, { est, name: (h.displayUsernamePublic && h.name) ? h.name : (h.pseudonym || w.slice(0, 10)) });
      }
    }
  }
  const list = [...cands.entries()].sort((a, b) => b[1].est - a[1].est).slice(0, N);
  console.log(`candidates sized >= $${cfg.minUsd}: ${cands.size} (profiling top ${list.length})\n`);

  const sinceTs = Math.floor(Date.now() / 1000) - cfg.days * 86400;
  const rows = [];
  for (const [wallet, c] of list) {
    const { rows: trades, truncated } = await pm.fetchWalletGameTrades(wallet, sinceTs);
    const ledgers = pm.buildLedgers(trades);
    const { stats } = pm.screenWallet(ledgers, truncated, cfg);
    const hist = await pm.walkWalletHistory(ledgers, wide);
    const graded = hist.rows;
    const w = graded.filter((r) => r.result === 'win').length;
    const l = graded.filter((r) => r.result === 'loss').length;
    const units = graded.reduce((s, r) => s + unitReturn(r.odds, r.result), 0);
    const dec = w + l;
    const entries = hist.pregame + hist.ingame;
    rows.push({
      wallet, name: c.name, est: Math.round(c.est),
      hedge: stats.hedge_pct, cashout: stats.cashout_pct, sell: stats.sell_pct,
      pregame: entries ? +(100 * hist.pregame / entries).toFixed(1) : 100,
      dec, w, l, winPct: dec ? +(100 * w / dec).toFixed(1) : null,
      units: +units.toFixed(2), roi: dec ? +(100 * units / dec).toFixed(1) : null,
    });
    const r = rows[rows.length - 1];
    console.log(`  ${String(r.name).slice(0, 22).padEnd(22)} $${String(r.est).padEnd(7)} hedge ${String(r.hedge).padStart(5)}%  cash ${String(r.cashout).padStart(5)}%  sell ${String(r.sell).padStart(5)}%  pre ${String(r.pregame).padStart(5)}%  rec ${r.w}-${r.l} (${r.winPct ?? '-'}%)  ${r.units >= 0 ? '+' : ''}${r.units}u  roi ${r.roi ?? '-'}%`);
  }

  // What each threshold set would admit.
  const SETS = [
    { label: 'CURRENT (shipped)', hedge: 10, cashout: 25, sell: 20, pregame: 50, minDec: 0, minRoi: null, minWin: null },
    { label: 'A strict behaviour only', hedge: 2, cashout: 10, sell: 8, pregame: 80, minDec: 0, minRoi: null, minWin: null },
    { label: 'B strict + must be profitable', hedge: 2, cashout: 10, sell: 8, pregame: 80, minDec: 10, minRoi: 0, minWin: null },
    { label: 'C strict + profit + 53% win', hedge: 2, cashout: 10, sell: 8, pregame: 80, minDec: 10, minRoi: 0, minWin: 53 },
    { label: 'D zero-tolerance + profit', hedge: 0, cashout: 5, sell: 5, pregame: 90, minDec: 10, minRoi: 0, minWin: null },
  ];
  console.log('\n=== what each threshold set admits (of %d profiled) ===', rows.length);
  for (const s of SETS) {
    const pass = rows.filter((r) => r.hedge <= s.hedge && r.cashout <= s.cashout && r.sell <= s.sell
      && r.pregame >= s.pregame
      && (s.minDec ? r.dec >= s.minDec : true)
      && (s.minRoi === null ? true : (r.roi !== null && r.roi >= s.minRoi))
      && (s.minWin === null ? true : (r.winPct !== null && r.winPct >= s.minWin)));
    const agg = pass.reduce((a, r) => ({ u: a.u + r.units, d: a.d + r.dec, w: a.w + r.w }), { u: 0, d: 0, w: 0 });
    console.log(`  ${s.label.padEnd(30)} admits ${String(pass.length).padStart(2)}  | their combined ${agg.w}-${agg.d - agg.w} (${agg.d ? (100 * agg.w / agg.d).toFixed(1) : '-'}%), ${agg.u >= 0 ? '+' : ''}${agg.u.toFixed(1)}u`);
    if (pass.length) console.log(`     ${pass.map((p) => p.name).slice(0, 8).join(', ')}`);
  }
  process.exit(0);
})().catch((e) => { console.error('calibration failed:', e); process.exit(1); });
