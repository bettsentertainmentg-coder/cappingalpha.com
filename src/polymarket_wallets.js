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
        let outcomes = [];
        try { outcomes = typeof mkt.outcomes === 'string' ? JSON.parse(mkt.outcomes) : (mkt.outcomes || []); } catch (_) {}
        map.set(cid, { game, question: mkt.question || '', outcomes });
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

module.exports = { refreshPmWallets, pollPmWallets, resolvePmStance, buildMarketMap, pmDisplayName, classifyMarket };

// CLI: node src/polymarket_wallets.js
if (require.main === module) {
  (async () => {
    await refreshPmWallets();
    await pollPmWallets();
  })();
}
