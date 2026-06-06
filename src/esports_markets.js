// src/esports_markets.js
// Standalone esports prediction-market scraper. Esports has no ESPN coverage, so
// this never touches today_games / espn_game_id — it owns the esports_markets
// table, the same way Golf owns golf_tournaments / golf_picks.
//
// Two free, no-auth sources:
//   • Kalshi     — KX<GAME>GAME series, team-vs-team "Will X win?" markets.
//   • Polymarket — the 'esports' tag; per-match events titled "Game: A vs B - Tour".
// Powers the Esports tab "Top Games" row via getTopEsportsGames().

const db = require('./db');

// Kalshi per-game match-winner series → fallback display label. Confirmed live:
// KXCS2GAME, KXLOLGAME. The rest follow the same KX<GAME>GAME pattern; series that
// return nothing are silently skipped.
const KALSHI_SERIES = {
  KXCS2GAME:  'CS2',
  KXLOLGAME:  'LoL',
  KXVALGAME:  'Valorant',
  KXDOTAGAME: 'Dota 2',
  KXCODGAME:  'Call of Duty',
};

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_BASE   = 'https://gamma-api.polymarket.com';
const POLY_TAG    = 'esports';

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Normalisation helpers ──────────────────────────────────────────────────────

// Canonicalise a game label from either source to one short display name.
function normGame(raw) {
  const g = (raw || '').trim().toLowerCase();
  if (!g) return 'Esports';
  if (g.startsWith('cs')   || g.includes('counter'))     return 'CS2';
  if (g.startsWith('lol')  || g.includes('league'))      return 'LoL';
  if (g.startsWith('val'))                               return 'Valorant';
  if (g.startsWith('dota'))                              return 'Dota 2';
  if (g.startsWith('cod')  || g.includes('call of duty')) return 'Call of Duty';
  if (g.startsWith('r6')   || g.includes('rainbow'))     return 'R6';
  if (g.includes('overwatch'))                           return 'Overwatch';
  if (g.includes('rocket'))                              return 'Rocket League';
  if (g.includes('apex'))                                return 'Apex';
  if (g.includes('pubg'))                                return 'PUBG';
  return raw.trim();
}

// Strip to alphanumerics for fuzzy de-dup keys.
const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ── Kalshi ─────────────────────────────────────────────────────────────────────

const _MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };

// Kalshi ticker carries the scheduled match time (UTC):
// KXLOLGAME-26JUN091600VTCGL → 2026-06-09T16:00:00Z
function kalshiTickerTime(ticker) {
  const m = (ticker || '').match(/-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const mo = _MONTHS[m[2]];
  if (mo == null) return null;
  const d = new Date(Date.UTC(2000 + +m[1], mo, +m[3], +m[4], +m[5]));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchKalshiSeries(seriesTicker) {
  const url = `${KALSHI_BASE}/events?series_ticker=${seriesTicker}&with_nested_markets=true&limit=100&status=open`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await _sleep(1500 * attempt);
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (r.status === 429) { await _sleep(2000); continue; }
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data?.events) ? data.events : [];
    } catch (_) {
      if (attempt === 2) return [];
    }
  }
  return [];
}

function parseKalshiEvent(ev, gameLabel) {
  const mkts = ev.markets || [];
  if (mkts.length < 2) return null;

  const mid = (m) => {
    const b = parseFloat(m.yes_bid_dollars), a = parseFloat(m.yes_ask_dollars);
    if (isNaN(b) || isNaN(a)) return null;
    return (b + a) / 2;
  };
  const m0 = mkts[0], m1 = mkts[1];
  const p0 = mid(m0), p1 = mid(m1);
  if (p0 == null || p1 == null) return null;

  const teamA = (m0.yes_sub_title || '').trim();
  const teamB = (m1.yes_sub_title || '').trim();
  if (!teamA || !teamB) return null;

  const tot = p0 + p1;
  const probA = tot > 0 ? p0 / tot : 0.5;

  let volume = 0;
  for (const m of mkts) { const v = parseFloat(m.volume_fp); if (!isNaN(v)) volume += v; }

  return {
    source: 'kalshi',
    match_key: 'kalshi:' + (ev.event_ticker || teamA + teamB),
    game: normGame(ev.product_metadata?.competition || gameLabel),
    team_a: teamA, team_b: teamB,
    prob_a: probA, prob_b: 1 - probA,
    volume,
    tournament: null,
    start_time: kalshiTickerTime(ev.event_ticker),
    status: 'pre',
    markets_json: null,
  };
}

async function fetchKalshiEsports() {
  const out = [];
  const series = Object.entries(KALSHI_SERIES);
  for (let i = 0; i < series.length; i++) {
    const [ticker, label] = series[i];
    if (i > 0) await _sleep(400); // be polite — Kalshi rate-limits parallel bursts
    const events = await fetchKalshiSeries(ticker);
    for (const ev of events) {
      const row = parseKalshiEvent(ev, label);
      if (row) out.push(row);
    }
  }
  return out;
}

// ── Polymarket ─────────────────────────────────────────────────────────────────

// Order by 24h volume so the headline matches land in the first page(s) — the
// 'esports' tag is dominated by novelty/futures markets otherwise.
async function fetchPolyEvents(pages = 3) {
  const out = [];
  for (let p = 0; p < pages; p++) {
    try {
      const url = `${POLY_BASE}/events?tag_slug=${POLY_TAG}&active=true&closed=false&limit=100&offset=${p * 100}&order=volume24hr&ascending=false`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) break;
      const evs = await r.json();
      if (!Array.isArray(evs) || !evs.length) break;
      out.push(...evs);
      if (evs.length < 100) break; // last page
    } catch (_) { break; }
  }
  return out;
}

function parsePolyEvent(ev) {
  const title = (ev.title || '').trim();
  const tl = title.toLowerCase();
  if (!tl.includes(' vs ')) return null; // matches only — skip futures / novelty
  if (/champion|winner|retire|map pool|series|to win|qualif|relegat/.test(tl)) return null;

  // game from the "Game: ..." prefix; tournament from the " - tournament" suffix
  let game = null, tournament = null;
  const colon = title.indexOf(':');
  if (colon > 0 && colon < 20) game = title.slice(0, colon); // e.g. "Counter-Strike:" (14)
  const dash = title.lastIndexOf(' - ');
  if (dash > 0) tournament = title.slice(dash + 3).trim();

  // Find the match-winner market: exactly two team-name outcomes (not Yes/No/Over/Under).
  let teamA = null, teamB = null, probA = null;
  const tryMarket = (outcomes, prices) => {
    try {
      const outs = typeof outcomes === 'string' ? JSON.parse(outcomes) : outcomes;
      const prs  = typeof prices   === 'string' ? JSON.parse(prices)   : prices;
      if (!Array.isArray(outs) || outs.length !== 2) return false;
      if (!Array.isArray(prs)  || prs.length  !== 2) return false;
      const o0 = String(outs[0]).trim(), o1 = String(outs[1]).trim();
      if (/^(yes|no|over|under)$/i.test(o0) || /^(yes|no|over|under)$/i.test(o1)) return false;
      const a = parseFloat(prs[0]);
      if (isNaN(a)) return false;
      teamA = o0; teamB = o1; probA = a;
      return true;
    } catch (_) { return false; }
  };
  const markets = Array.isArray(ev.markets) ? ev.markets : [];
  for (const m of markets) { if (tryMarket(m.outcomes, m.outcomePrices)) break; }
  if (teamA == null && (ev.outcomes || ev.outcomePrices)) tryMarket(ev.outcomes, ev.outcomePrices);
  if (teamA == null || teamB == null || probA == null) return null;

  // Skip resolved / decided markets (price pinned to ~1 or ~0).
  if (probA <= 0.02 || probA >= 0.98) return null;

  const volume = parseFloat(ev.volume24hr) || parseFloat(ev.volume) || 0;

  return {
    source: 'polymarket',
    match_key: 'polymarket:' + (ev.id || ev.slug || ev.ticker || title),
    game: normGame(game),
    team_a: teamA, team_b: teamB,
    prob_a: probA, prob_b: 1 - probA,
    volume,
    tournament: tournament || null,
    // Polymarket's gameStartTime is unreliable for esports (carries the market's
    // creation date, not the match time), so we don't expose a time for it.
    start_time: null,
    status: 'live',
    markets_json: null,
  };
}

async function fetchPolymarketEsports() {
  const events = await fetchPolyEvents(4);
  const out = [];
  for (const ev of events) {
    const row = parsePolyEvent(ev);
    if (row) out.push(row);
  }
  return out;
}

// ── Storage + public API ───────────────────────────────────────────────────────

const _store = db.prepare(`
  INSERT INTO esports_markets
    (source, match_key, game, team_a, team_b, prob_a, prob_b, volume, tournament, start_time, status, markets_json, updated_at)
  VALUES
    (@source, @match_key, @game, @team_a, @team_b, @prob_a, @prob_b, @volume, @tournament, @start_time, @status, @markets_json, datetime('now'))
  ON CONFLICT(match_key) DO UPDATE SET
    game       = excluded.game,
    team_a     = excluded.team_a,
    team_b     = excluded.team_b,
    prob_a     = excluded.prob_a,
    prob_b     = excluded.prob_b,
    volume     = excluded.volume,
    tournament = excluded.tournament,
    start_time = excluded.start_time,
    status     = excluded.status,
    updated_at = excluded.updated_at
`);
const _storeMany = db.transaction((rows) => { for (const r of rows) _store.run(r); });

async function syncEsportsMarkets() {
  let rows = [];
  try { rows = rows.concat(await fetchKalshiEsports()); }     catch (e) { console.error('[esports] kalshi:', e.message); }
  try { rows = rows.concat(await fetchPolymarketEsports()); } catch (e) { console.error('[esports] polymarket:', e.message); }

  if (rows.length) _storeMany(rows);

  // Kalshi tickers carry a reliable match time — drop matches that finished.
  const finished = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  db.prepare(`DELETE FROM esports_markets WHERE source = 'kalshi' AND start_time IS NOT NULL AND start_time < ?`).run(finished);
  // Drop anything not refreshed in 2 days (ages out stale Polymarket rows that
  // went inactive and are no longer returned by the fetch, plus a safety net).
  db.prepare(`DELETE FROM esports_markets WHERE updated_at < datetime('now','-2 days')`).run();

  return rows.length;
}

// Top matches across all titles, ranked by volume, with the same match seen on
// both platforms collapsed to its higher-volume copy.
function getTopEsportsGames(limit = 40) {
  const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT * FROM esports_markets
    WHERE start_time IS NULL OR start_time >= ?
    ORDER BY volume DESC, (start_time IS NULL), start_time ASC
  `).all(cutoff);

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    // Collapse the same match seen on both platforms (rows are volume-sorted, so
    // the higher-volume copy wins). Keyed by game + team pair, not source.
    const key = (r.game || '') + '|' + [slug(r.team_a), slug(r.team_b)].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { syncEsportsMarkets, getTopEsportsGames };
