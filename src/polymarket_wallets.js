// src/polymarket_wallets.js
// Polymarket pro-wallet tracker (wave-1, track-only). Tracks the top sports
// traders (on-chain P/L, the most verifiable bettors anywhere) and records
// their pregame entries on today's game markets as picks via source_ingest
// (source='polymarket', result='pending'). Zero score influence in this phase.
//
// Endpoints are public and free (no auth), but unofficial: every call fails
// soft and the CA Ops panel surfaces silence. The leaderboard path is probed
// from a candidate list once and cached in settings (pm_lb_endpoint).
//
// Wallet seeding rule (docs/CA_ALGORITHM_V3.md): wallets seed ZERO resume
// points. Their on-chain P/L is display-only context; leaderboard selection is
// itself the quality filter, and only picks WE grade build their record.

const https = require('https');
const db = require('./db');
const { recordSourcePick, findGameByTeams, sideOf, americanFromPrice, removeSourceEntry, findPendingOpposite } = require('./source_ingest');
const { ensureRegistered } = require('./storage');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'application/json',
};

function getJson(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: HEADERS, timeout: 15000 }, (res) => {
      let b = '';
      const parse = () => { try { finish({ status: res.statusCode, json: JSON.parse(b) }); } catch (_) { finish({ status: res.statusCode, json: null }); } };
      res.on('data', (c) => { b += c; if (b.length > 8_000_000) res.destroy(); });
      res.on('end', parse);
      // destroy() mid-stream never fires 'end' — 'close' is the safety net
      res.on('close', parse);
    });
    req.on('error', () => finish({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); finish({ status: 0, json: null }); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Wallet discovery (5am): leaderboard endpoints, probed then cached ─────────
const LB_CANDIDATES = [
  'https://lb-api.polymarket.com/leaderboard?window=all&limit=50&rankType=pnl',
  'https://lb-api.polymarket.com/leaderboard?window=1m&limit=50',
  'https://data-api.polymarket.com/leaderboard?window=all&limit=50',
  'https://data-api.polymarket.com/v1/leaderboard?window=all&limit=50',
  'https://data-api.polymarket.com/leaderboard/rankings?limit=50',
];

function parseLbEntries(json) {
  const arr = Array.isArray(json) ? json : (json?.leaderboard || json?.rankings || json?.data || []);
  if (!Array.isArray(arr)) return [];
  return arr.map((e) => ({
    wallet: e.proxyWallet || e.wallet || e.address || e.user || null,
    username: e.userName || e.username || e.name || e.pseudonym || null,
    pnl: parseFloat(e.amount ?? e.pnl ?? e.profit ?? NaN),
    volume: parseFloat(e.volume ?? e.vol ?? NaN),
  })).filter(e => e.wallet);
}

async function refreshPmWallets() {
  if (db.getSetting('pm_scrape_enabled', '1') !== '1') return 0;
  const cached = db.getSetting('pm_lb_endpoint', '');
  const candidates = cached ? [cached, ...LB_CANDIDATES.filter(c => c !== cached)] : LB_CANDIDATES;

  let entries = [];
  for (const url of candidates) {
    const res = await getJson(url);
    if (res.status === 200 && res.json) {
      const parsed = parseLbEntries(res.json);
      if (parsed.length) { entries = parsed; db.setSetting('pm_lb_endpoint', url); break; }
    }
    await sleep(200);
  }
  if (!entries.length) { console.warn('[pm_wallets] no leaderboard endpoint answered; wallet set unchanged'); return 0; }

  let upserts = 0;
  for (const e of entries.slice(0, parseInt(db.getSetting('pm_max_wallets', '50'), 10))) {
    try {
      db.prepare(`
        INSERT INTO pm_wallets (wallet, username, pnl, volume, meta_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(wallet) DO UPDATE SET
          username = COALESCE(excluded.username, username),
          pnl = excluded.pnl, volume = excluded.volume, meta_json = excluded.meta_json
      `).run(e.wallet, e.username, Number.isFinite(e.pnl) ? e.pnl : null,
             Number.isFinite(e.volume) ? e.volume : null, JSON.stringify(e));
      ensureRegistered(pmDisplayName(e), 'polymarket', e.wallet);
      upserts++;
    } catch (_) {}
  }
  console.log(`[pm_wallets] leaderboard refresh: ${upserts} wallets tracked`);
  return upserts;
}

function pmDisplayName(w) {
  return w.username || ('PM ' + String(w.wallet).slice(2, 8));
}

// ── Market map: conditionId -> today_games row (rebuilt per poll, cheap) ──────
const SPORT_TAGS = ['mlb', 'nba', 'wnba', 'nhl', 'nfl', 'cfb', 'soccer', 'tennis'];
// today_games sport label per tag ('Tennis' blends ATP+WTA in the matcher).
const TAG_SPORT = { mlb: 'MLB', nba: 'NBA', wnba: 'WNBA', nhl: 'NHL', nfl: 'NFL', cfb: 'NCAAF', soccer: 'Soccer', tennis: 'Tennis' };
const SKIP_Q = /(1h |half|1st |inning|series|champion|mvp|rebounds|assists|total games|to score|anytime)/i;

async function buildMarketMap() {
  const map = new Map(); // conditionId -> { game, question, outcomes }
  for (const tag of SPORT_TAGS) {
    const res = await getJson(`https://gamma-api.polymarket.com/events?tag_slug=${tag}&active=true&closed=false&limit=100&order=volume&ascending=false`);
    if (res.status !== 200 || !Array.isArray(res.json)) { await sleep(150); continue; }
    for (const ev of res.json) {
      // Event title is usually "Away vs. Home" or "Team A vs Team B"
      const title = ev.title || '';
      const parts = title.split(/\s+(?:vs\.?|@)\s+/i);
      if (parts.length !== 2) continue;
      // Constrain the match to the tag's sport — a bare city pair ("Toronto vs
      // Miami") exists in several leagues at once.
      const game = findGameByTeams(parts[0], parts[1], TAG_SPORT[tag] || null);
      if (!game) continue;
      for (const mkt of (ev.markets || [])) {
        const cid = mkt.conditionId || mkt.condition_id;
        if (!cid || SKIP_Q.test(mkt.question || '')) continue;
        let outcomes = [], prices = [];
        try { outcomes = typeof mkt.outcomes === 'string' ? JSON.parse(mkt.outcomes) : (mkt.outcomes || []); } catch (_) {}
        try { prices = (typeof mkt.outcomePrices === 'string' ? JSON.parse(mkt.outcomePrices) : (mkt.outcomePrices || [])).map(parseFloat); } catch (_) {}
        map.set(cid, { game, question: mkt.question || '', outcomes, prices });
      }
    }
    await sleep(150);
  }
  return map;
}

function classifyMarket(question) {
  const q = (question || '').toLowerCase();
  if (q.includes('o/u') || (q.includes('over') && q.includes('under'))) return 'total';
  if (q.match(/[+-]\d+\.?\d*/)) return 'spread';
  return 'ml';
}

// ── Net stance for a wallet in one market (flips and hedges) ─────────────────
// A wallet trading in and out of a market can hold BOTH outcome tokens; every
// qualifying BUY used to mint an independent pick, so an afternoon flip put
// the same wallet on both MLs of one game (the Jul 13 Sparks/Dream red alert).
// The positions API is the source of truth: for a binary market with total
// cost C and share counts Sa/Sb, net-if-a-wins = Sa - C, so the larger share
// count IS the directional side. Within 10% the wallet is hedged/flat.
// classify(outcomeName) maps a position row onto the same side key as the
// trade being ingested ('home'/'away' or 'over'/'under'). Returns
// { side } | { flat: true } | null (API unavailable — caller falls back to
// latest-trade-wins).
async function resolvePmStance(wallet, conditionId, classify) {
  const res = await getJson(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(wallet)}&market=${encodeURIComponent(conditionId)}`);
  if (res.status !== 200 || !Array.isArray(res.json)) return null;
  const sized = new Map(); // side key -> total shares
  for (const p of res.json) {
    const key = classify(p.outcome || '');
    const size = parseFloat(p.size);
    if (!key || !Number.isFinite(size) || size <= 0) continue;
    sized.set(key, (sized.get(key) || 0) + size);
  }
  const entries = [...sized.entries()].sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { flat: true }; // fully exited — no stance
  if (entries.length === 1) return { side: entries[0][0] };
  const [top, second] = entries;
  if (second[1] / top[1] >= 0.9) return { flat: true }; // hedged within 10%
  return { side: top[0] };
}

// ── Poll tracked wallets' trades (every 15 min active hours) ──────────────────
async function pollPmWallets() {
  if (db.getSetting('pm_scrape_enabled', '1') !== '1') return { ingested: 0 };
  const wallets = db.prepare(`SELECT * FROM pm_wallets`).all();
  if (!wallets.length) return { ingested: 0 };

  const map = await buildMarketMap();
  if (!map.size) { console.log('[pm_wallets] no game markets mapped (offseason or gamma quiet)'); return { ingested: 0 }; }

  const minUsd = parseFloat(db.getSetting('pm_min_usd', '200'));
  let ingested = 0, dupes = 0, errors = 0;
  for (const w of wallets) {
    const res = await getJson(`https://data-api.polymarket.com/trades?user=${encodeURIComponent(w.wallet)}&limit=100&takerOnly=false`);
    if (res.status !== 200 || !Array.isArray(res.json)) { errors++; await sleep(200); continue; }
    let maxTs = w.last_trade_ts || 0;
    // Conviction sizing state (logged-only): the wallet's usual game-market
    // notional, EMA over every mapped BUY. Ratio is taken BEFORE folding the
    // current trade in, so it reads "vs their usual until now".
    let nAvg = w.notional_avg ?? null, nN = w.notional_n ?? 0;
    for (const t of res.json) {
      const ts = parseInt(t.timestamp ?? t.ts ?? 0, 10);
      const tsMs = ts > 1e12 ? ts : ts * 1000;
      if (!ts || (w.last_trade_ts && ts <= w.last_trade_ts)) continue;
      if ((t.side || '').toUpperCase() !== 'BUY') { maxTs = Math.max(maxTs, ts); continue; }
      const cid = t.conditionId || t.condition_id || t.market;
      const entry = cid ? map.get(cid) : null;
      maxTs = Math.max(maxTs, ts);
      if (!entry) continue;
      const price = parseFloat(t.price);
      const size = parseFloat(t.size);
      const notional = Number.isFinite(price) && Number.isFinite(size) ? price * size : 0;
      // size_ratio: this bet vs the wallet's usual (needs 5+ prior trades to mean
      // anything). ZERO points at launch — logged into provenance for the backtest
      // to judge whether oversized entries actually hit more often.
      const sizeRatio = (nN >= 5 && nAvg > 0 && notional > 0) ? +(notional / nAvg).toFixed(2) : null;
      if (notional > 0) { nAvg = nAvg == null ? notional : nAvg * 0.8 + notional * 0.2; nN++; }
      if (notional < minUsd) continue;

      const outcomeName = t.outcome || entry.outcomes[t.outcomeIndex ?? -1] || null;
      const kind = classifyMarket(entry.question);
      let pickType = 'ml', side = null, line = null;
      if (kind === 'ml') {
        side = sideOf(entry.game, outcomeName);
        if (!side) continue;
      } else if (kind === 'total') {
        const on = (outcomeName || '').toLowerCase();
        pickType = on.startsWith('over') ? 'over' : on.startsWith('under') ? 'under' : null;
        if (!pickType) continue;
        const lm = entry.question.match(/(\d+(?:\.\d+)?)/);
        line = lm ? parseFloat(lm[1]) : null;
      } else {
        pickType = 'spread';
        side = sideOf(entry.game, outcomeName);
        if (!side) continue;
        const lm = entry.question.match(/([+-]\d+(?:\.\d+)?)/);
        line = lm ? parseFloat(lm[1]) : null;
      }

      // Flip/hedge guard: if this wallet already has a PENDING entry on the
      // OPPOSITE side of this game+market kind, this BUY is a position change,
      // not an independent pick. Resolve the wallet's NET stance from the
      // positions API and keep at most ONE side. API down → latest trade wins.
      const canonical = pmDisplayName(w);
      const isTotalKind = pickType === 'over' || pickType === 'under';
      const team = isTotalKind ? entry.game.home_team
        : (side === 'home' ? entry.game.home_team : entry.game.away_team);
      const opposite = findPendingOpposite({ canonical, espn_game_id: entry.game.espn_game_id, pickType, team });
      if (opposite) {
        const classify = (outcome) => {
          if (isTotalKind) {
            const o = (outcome || '').toLowerCase();
            return o.startsWith('over') ? 'over' : o.startsWith('under') ? 'under' : null;
          }
          return sideOf(entry.game, outcome);
        };
        const newKey = isTotalKind ? pickType : side;
        const oppKey = isTotalKind ? (pickType === 'over' ? 'under' : 'over')
          : (opposite.is_home_team ? 'home' : 'away');
        const stance = await resolvePmStance(w.wallet, cid, classify);
        if (stance && stance.flat) {
          removeSourceEntry({ canonical, espn_game_id: entry.game.espn_game_id, pickType: opposite.pick_type, team: opposite.team });
          console.log(`[pm_wallets] ${canonical} hedged flat on ${entry.game.espn_game_id} ${pickType} — withdrew both sides`);
          continue;
        }
        if (stance && stance.side === oppKey) { continue; } // net stance unchanged — ignore this buy
        // net stance is the NEW side (or API unavailable → latest trade wins)
        removeSourceEntry({ canonical, espn_game_id: entry.game.espn_game_id, pickType: opposite.pick_type, team: opposite.team });
        console.log(`[pm_wallets] ${canonical} flipped to ${newKey} on ${entry.game.espn_game_id} ${pickType} — withdrew the ${oppKey} entry`);
      }

      const out = recordSourcePick({
        source: 'polymarket',
        capperName: canonical,
        handle: w.wallet,
        game: entry.game,
        pickType,
        side,
        line,
        odds: americanFromPrice(price),
        postedAtMs: tsMs,
        meta: { notional_usd: Math.round(notional), price, question: entry.question.slice(0, 80), size_ratio: sizeRatio },
      });
      if (out === 'inserted') ingested++;
      else if (out === 'duplicate') dupes++;
    }
    if (maxTs > (w.last_trade_ts || 0) || nN !== (w.notional_n ?? 0)) {
      try {
        db.prepare(`UPDATE pm_wallets SET last_trade_ts = ?, notional_avg = ?, notional_n = ? WHERE wallet = ?`)
          .run(Math.max(maxTs, w.last_trade_ts || 0), nAvg, nN, w.wallet);
      } catch (_) {}
    }
    await sleep(200);
  }
  db.setSetting('pm_last_poll', new Date().toISOString());
  console.log(`[pm_wallets] poll: ${ingested} new picks, ${dupes} dupes, ${errors} errors across ${wallets.length} wallets (${map.size} markets mapped)`);
  return { ingested, dupes, errors };
}

// ── Holders discovery (2026-07-30): market-first wallet discovery ─────────────
// The leaderboard path finds famous wallets and hopes they bet sports; this
// walks today's mapped game markets and asks who has real money on them
// (data-api /holders). Every candidate must pass a STRAIGHT-BETTOR screen over
// its recent game trades (Jack's rule 2026-07-30: no hedgers betting both
// sides, no early cash-outs, no micro-trade churners — conviction bettors who
// take a position and ride it to settlement). Admitted wallets get a CAPPED
// history backfill: their most recent settled PREGAME entries, graded against
// the on-chain resolution, at most pm_backfill_max_decisions rows. The cap is
// the balance Jack asked for — 25 keeps a jump-started wallet inside the
// 10-29-decision volume cap (points capped at 70) until it earns live picks
// with us, so history helps a wallet get ranked but can never crown it.

const GAME_SLUG = /-\d{4}-\d{2}-\d{2}$/; // dated event slugs are single games
const SLUG_SPORT = {
  mlb: 'MLB', nba: 'NBA', wnba: 'WNBA', nhl: 'NHL', nfl: 'NFL', cfb: 'NCAAF', cbb: 'CBB',
  atp: 'ATP', wta: 'WTA',
  epl: 'Soccer', laliga: 'Soccer', seriea: 'Soccer', bundesliga: 'Soccer', ligue1: 'Soccer',
  ucl: 'Soccer', uel: 'Soccer', mls: 'Soccer', ligamx: 'Soccer',
};
const slugSport = (slug) => SLUG_SPORT[(slug || '').split('-')[0]] || null;

function holdersCfg() {
  return {
    minUsd: parseFloat(db.getSetting('pm_min_usd', '200')),
    maxNew: parseInt(db.getSetting('pm_holders_max_new', '10'), 10),
    days: parseInt(db.getSetting('pm_backfill_days', '90'), 10),
    maxDecisions: parseInt(db.getSetting('pm_backfill_max_decisions', '25'), 10),
    hedgePct: parseFloat(db.getSetting('pm_screen_hedge_pct', '10')),
    cashoutPct: parseFloat(db.getSetting('pm_screen_cashout_pct', '25')),
    sellPct: parseFloat(db.getSetting('pm_screen_sell_pct', '20')),
    pregamePct: parseFloat(db.getSetting('pm_screen_pregame_pct', '50')),
  };
}

// Page a wallet's trade history back to sinceTs (seconds). Returns dated-game
// rows only. `truncated` means the page cap hit before reaching sinceTs — a
// wallet with that much churn is disqualified by volume alone.
async function fetchWalletGameTrades(wallet, sinceTs) {
  const rows = [];
  let offset = 0, truncated = false;
  for (let page = 0; page < 30; page++) {
    const res = await getJson(`https://data-api.polymarket.com/trades?user=${encodeURIComponent(wallet)}&limit=100&offset=${offset}&takerOnly=false`);
    if (res.status !== 200 || !Array.isArray(res.json) || !res.json.length) break;
    let oldest = Infinity;
    for (const t of res.json) {
      const ts = parseInt(t.timestamp ?? 0, 10);
      oldest = Math.min(oldest, ts || Infinity);
      if (ts >= sinceTs && GAME_SLUG.test(t.eventSlug || t.slug || '')) rows.push(t);
    }
    offset += res.json.length;
    if (oldest < sinceTs || res.json.length < 100) break;
    if (page === 29) truncated = true;
    await sleep(150);
  }
  return { rows, truncated };
}

// Per-market ledgers from raw trades: shares/cost per outcome, trade count,
// first buy timestamp. Everything the screen and the backfill both read.
function buildLedgers(rows) {
  const led = new Map(); // cid -> ledger
  for (const t of rows) {
    const cid = t.conditionId;
    if (!cid) continue;
    let L = led.get(cid);
    if (!L) { L = { slug: t.eventSlug || t.slug || '', title: t.title || '', trades: 0, sells: 0, out: new Map() }; led.set(cid, L); }
    L.trades++;
    if ((t.side || '').toUpperCase() !== 'BUY') L.sells++;
    const idx = t.outcomeIndex ?? -1;
    let o = L.out.get(idx);
    if (!o) { o = { name: t.outcome || '', bought: 0, sold: 0, cost: 0, firstBuyTs: null }; L.out.set(idx, o); }
    const size = parseFloat(t.size), price = parseFloat(t.price);
    if (!Number.isFinite(size) || size <= 0) continue;
    if ((t.side || '').toUpperCase() === 'BUY') {
      o.bought += size;
      if (Number.isFinite(price)) o.cost += size * price;
      const ts = parseInt(t.timestamp ?? 0, 10);
      if (ts && (!o.firstBuyTs || ts < o.firstBuyTs)) o.firstBuyTs = ts;
    } else {
      o.sold += size;
    }
  }
  return led;
}

function ledgerShape(L, minUsd) {
  const outs = [...L.out.values()];
  const totalCost = outs.reduce((s, o) => s + o.cost, 0);
  const bought = outs.reduce((s, o) => s + o.bought, 0);
  const sold = outs.reduce((s, o) => s + o.sold, 0);
  const costs = outs.map(o => o.cost).filter(c => c > 0).sort((a, b) => b - a);
  return {
    qualifies: totalCost >= minUsd,
    hedged: costs.length >= 2 && costs[1] / costs[0] > 0.2,
    cashedOut: bought > 0 && sold >= bought * 0.5,
    trades: L.trades,
    sells: L.sells,
    totalCost,
  };
}

// The straight-bettor screen, one metric per concern Jack named:
//   bet both sides      -> hedge_pct   (markets where both outcomes were bought)
//   cash out early      -> cashout_pct (markets where >=half the shares were sold pre-resolution)
//   in-and-out trading  -> sell_pct    (share of fills that are SELLS — a straight bettor holds to settlement)
// Fills-per-market is deliberately NOT a metric: the API reports fills, not
// orders, so one big order legging into the book looks like many "trades" and
// would punish size instead of churn. A truncated history (30+ pages of fills)
// is screened on the window we saw, not auto-failed, for the same reason.
// A wallet with no qualifying history passes by default (nothing bad is known;
// its backfill will simply be tiny).
function screenWallet(ledgers, truncated, cfg) {
  const shapes = [...ledgers.values()].map(L => ledgerShape(L, cfg.minUsd)).filter(s => s.qualifies);
  const n = shapes.length;
  const fills = shapes.reduce((s, x) => s + x.trades, 0);
  const stats = {
    markets: n,
    hedge_pct: n ? +(100 * shapes.filter(s => s.hedged).length / n).toFixed(1) : 0,
    cashout_pct: n ? +(100 * shapes.filter(s => s.cashedOut).length / n).toFixed(1) : 0,
    sell_pct: fills ? +(100 * shapes.reduce((s, x) => s + x.sells, 0) / fills).toFixed(1) : 0,
    fills,
    truncated,
  };
  const pass = stats.hedge_pct <= cfg.hedgePct
    && stats.cashout_pct <= cfg.cashoutPct
    && stats.sell_pct <= cfg.sellPct;
  return { pass, stats };
}

// Walk a candidate's most recent settled game markets (newest first, capped
// event lookups) and grade the straight pregame entries against the on-chain
// resolution. Returns the graded rows WITHOUT inserting, plus the
// pregame/in-game entry split — the split is the fourth screen metric: a
// wallet that mostly enters after the game starts is live-trading the odds
// (Jack's exclusion), and under the pregame rule it would produce almost no
// board picks anyway. espn_game_id and is_home_team stay NULL on backfill
// rows (historical games are not on the board, and the side-lean query
// already excludes NULL home flags). Never touches the board.
async function walkWalletHistory(ledgers, cfg) {
  const candidates = [...ledgers.entries()]
    .map(([cid, L]) => ({ cid, L, shape: ledgerShape(L, cfg.minUsd) }))
    .filter(c => c.shape.qualifies && !c.shape.hedged && !c.shape.cashedOut && slugSport(c.L.slug))
    .sort((a, b) => {
      const ta = Math.min(...[...a.L.out.values()].map(o => o.firstBuyTs || Infinity));
      const tb = Math.min(...[...b.L.out.values()].map(o => o.firstBuyTs || Infinity));
      return tb - ta; // newest first
    });

  const rows = [];
  let pregame = 0, ingame = 0, lookups = 0;
  const evCache = new Map();
  const seen = new Set(); // one decision per game + market kind — alt lines (o185.5 + o184.5 + o183.5) are ONE opinion, not three
  for (const c of candidates) {
    if (rows.length >= cfg.maxDecisions || lookups >= 40) break;
    let ev = evCache.get(c.L.slug);
    if (ev === undefined) {
      const res = await getJson(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(c.L.slug)}`);
      ev = (res.status === 200 && Array.isArray(res.json) && res.json[0]) ? res.json[0] : null;
      evCache.set(c.L.slug, ev);
      lookups++;
      await sleep(150);
    }
    if (!ev) continue;
    const mkt = (ev.markets || []).find(m => (m.conditionId || m.condition_id) === c.cid);
    if (!mkt || !mkt.closed) continue;
    let prices = [];
    try { prices = (typeof mkt.outcomePrices === 'string' ? JSON.parse(mkt.outcomePrices) : (mkt.outcomePrices || [])).map(parseFloat); } catch (_) {}
    if (!prices.some(p => p === 1)) continue; // unresolved or voided — no grade
    // gamma prints '2026-07-27 18:35:00+00' — the bare '+00' offset is NaN to
    // V8's Date until it reads '+00:00'.
    const startIso = mkt.gameStartTime || null;
    let startMs = null;
    if (startIso) {
      let t = String(startIso).replace(' ', 'T');
      if (/[+-]\d{2}$/.test(t)) t += ':00';
      const ms = new Date(t).getTime();
      startMs = Number.isFinite(ms) ? ms : null;
    }
    if (!startMs) continue;

    // The wallet's side: the outcome it still held (net shares) at settlement.
    const held = [...c.L.out.entries()]
      .map(([idx, o]) => ({ idx, o, net: o.bought - o.sold }))
      .filter(x => x.net > 0)
      .sort((a, b) => b.net - a.net)[0];
    if (!held || !held.o.firstBuyTs) continue;
    if (held.o.firstBuyTs * 1000 >= startMs) { ingame++; continue; } // in-game entry — live trader signal, and an honest resume is pregame only

    const kind = classifyMarket(mkt.question || '');
    let pickType = 'ml', line = null, team = held.o.name;
    if (kind === 'total') {
      const on = (held.o.name || '').toLowerCase();
      pickType = on.startsWith('over') ? 'over' : on.startsWith('under') ? 'under' : null;
      if (!pickType) continue;
      const lm = (mkt.question || '').match(/(\d+(?:\.\d+)?)/);
      line = lm ? parseFloat(lm[1]) : null;
      team = (c.L.title || '').split(/\s+vs\.?\s+/i)[0] || c.L.title;
    } else if (kind === 'spread') {
      pickType = 'spread';
      const lm = (mkt.question || '').match(/([+-]\d+(?:\.\d+)?)/);
      line = lm ? parseFloat(lm[1]) : null;
    }
    const dupeKey = `${c.L.slug}|${pickType}`;
    if (seen.has(dupeKey)) continue;
    seen.add(dupeKey);
    pregame++;

    const won = prices[held.idx] === 1;
    const avgPrice = held.o.cost / held.o.bought;
    rows.push({
      sport: slugSport(c.L.slug),
      pickType, team, line,
      gameDate: (startIso || '').slice(0, 10) || null,
      result: won ? 'win' : 'loss',
      odds: americanFromPrice(avgPrice),
      provenance: JSON.stringify([{
        source: 'polymarket', at: new Date().toISOString(), backfill: true,
        meta: { slug: c.L.slug, notional_usd: Math.round(held.o.cost), price: +avgPrice.toFixed(3) },
      }]),
    });
  }
  return { rows, pregame, ingame };
}

function insertBackfillRows(canonical, rows) {
  const ins = db.prepare(`
    INSERT INTO capper_history
      (capper_name, sport, pick_type, team, spread, espn_game_id, game_date,
       channel, score, result, pick_id, odds, source, is_home_team, sources_json)
    VALUES (?, ?, ?, ?, ?, NULL, ?, 'polymarket', NULL, ?, NULL, ?, 'polymarket', NULL, ?)
  `);
  let n = 0;
  for (const r of rows) {
    try { ins.run(canonical, r.sport, r.pickType, r.team, r.line, r.gameDate, r.result, r.odds, r.provenance); n++; } catch (_) {}
  }
  return n;
}

// Walk today's mapped game markets, screen the biggest holders, admit the
// straight bettors. Runs at 5:05am + startup, after the leaderboard refresh.
async function discoverPmHolders() {
  if (db.getSetting('pm_scrape_enabled', '1') !== '1') return 0;
  if (db.getSetting('pm_holders_enabled', '1') !== '1') return 0;
  const cfg = holdersCfg();

  const map = await buildMarketMap();
  if (!map.size) { console.log('[pm_holders] no game markets mapped'); return 0; }

  // Candidate sweep: top holders of each side of each mapped market, sized by
  // estimated notional (shares x current outcome price).
  const candidates = new Map(); // wallet -> { estUsd, username }
  const tracked = new Set(db.prepare(`SELECT wallet FROM pm_wallets`).all().map(r => r.wallet));
  let rejected = {};
  try { rejected = JSON.parse(db.getSetting('pm_holders_rejected', '{}')); } catch (_) {}
  const retryMs = 45 * 86400 * 1000;

  for (const [cid, entry] of map) {
    const res = await getJson(`https://data-api.polymarket.com/holders?market=${encodeURIComponent(cid)}&limit=5`);
    await sleep(120);
    if (res.status !== 200 || !Array.isArray(res.json)) continue;
    for (const tokenBlock of res.json) {
      for (const h of (tokenBlock.holders || [])) {
        const w = h.proxyWallet;
        if (!w || tracked.has(w)) continue;
        if (rejected[w] && Date.now() - rejected[w] < retryMs) continue;
        const price = entry.prices?.[h.outcomeIndex];
        const estUsd = Number.isFinite(price) ? (parseFloat(h.amount) || 0) * price : 0;
        if (estUsd < cfg.minUsd) continue;
        const prev = candidates.get(w);
        const username = (h.displayUsernamePublic && h.name) ? h.name : (h.pseudonym || null);
        if (!prev || estUsd > prev.estUsd) candidates.set(w, { estUsd, username });
      }
    }
  }

  // Screen down the size-ranked list until the day's admit quota fills — the
  // biggest holders are often market-maker types the screen exists to refuse,
  // so refusals must not eat the quota. Screening is itself capped (5x) to
  // bound API load.
  const picks = [...candidates.entries()].sort((a, b) => b[1].estUsd - a[1].estUsd).slice(0, cfg.maxNew * 5);
  let admitted = 0, refused = 0, backfilled = 0;
  const sinceTs = Math.floor(Date.now() / 1000) - cfg.days * 86400;
  for (const [wallet, c] of picks) {
    if (admitted >= cfg.maxNew) break;
    const { rows, truncated } = await fetchWalletGameTrades(wallet, sinceTs);
    const ledgers = buildLedgers(rows);
    const { pass, stats } = screenWallet(ledgers, truncated, cfg);
    if (!pass) {
      refused++;
      rejected[wallet] = Date.now();
      console.log(`[pm_holders] refused ${wallet.slice(0, 10)}: hedge ${stats.hedge_pct}% cashout ${stats.cashout_pct}% sells ${stats.sell_pct}% (${stats.markets} mkts)`);
      continue;
    }
    // Fourth screen metric needs the settled-market walk: pregame entry share.
    // A wallet that mostly enters after the game starts is live-trading the
    // odds — refused, and it would produce almost no board picks anyway.
    const hist = await walkWalletHistory(ledgers, cfg);
    const entries = hist.pregame + hist.ingame;
    stats.pregame_pct = entries ? +(100 * hist.pregame / entries).toFixed(1) : 100;
    if (stats.pregame_pct < cfg.pregamePct) {
      refused++;
      rejected[wallet] = Date.now();
      console.log(`[pm_holders] refused ${wallet.slice(0, 10)}: only ${stats.pregame_pct}% pregame entries (${entries} settled) — live trader`);
      continue;
    }
    const walletRow = { wallet, username: c.username };
    try {
      db.prepare(`
        INSERT INTO pm_wallets (wallet, username, meta_json)
        VALUES (?, ?, ?)
        ON CONFLICT(wallet) DO NOTHING
      `).run(wallet, c.username, JSON.stringify({ discovery: 'holders', est_usd: Math.round(c.estUsd), screen: stats, screen_at: new Date().toISOString() }));
    } catch (_) { continue; }
    ensureRegistered(pmDisplayName(walletRow), 'polymarket', wallet);
    const n = insertBackfillRows(pmDisplayName(walletRow), hist.rows);
    backfilled += n;
    admitted++;
    console.log(`[pm_holders] admitted ${pmDisplayName(walletRow)} ($${Math.round(c.estUsd)} on today's board, ${stats.markets} mkts screened, ${stats.pregame_pct}% pregame, ${n} graded picks backfilled)`);
  }
  // Prune the rejection cache so it never grows unbounded.
  for (const [w, ts] of Object.entries(rejected)) if (Date.now() - ts > retryMs * 2) delete rejected[w];
  db.setSetting('pm_holders_rejected', JSON.stringify(rejected));
  console.log(`[pm_holders] discovery: ${admitted} admitted, ${refused} refused, ${backfilled} picks backfilled (${map.size} markets swept)`);
  return admitted;
}

module.exports = { refreshPmWallets, pollPmWallets, resolvePmStance, buildMarketMap, pmDisplayName, classifyMarket, discoverPmHolders };

// CLI: node src/polymarket_wallets.js
if (require.main === module) {
  (async () => {
    await refreshPmWallets();
    await discoverPmHolders();
    await pollPmWallets();
  })();
}
