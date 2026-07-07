// src/kalshi_events.js
// Kalshi reference prices for events that live OUTSIDE today_games: fight cards
// (UFC/MMA + boxing) and race winners (F1 + NASCAR). Those rows are custom-only
// in the betslip (no odds board), so the custom form shows these as tappable
// reference prices instead of a blank odds field. Free public API, no key.
//
// Unlike src/kalshi.js (per-game sync into kalshi_cache, wiped daily), this is a
// lightweight in-memory feed: fetched on demand, cached ~10 min, nothing stored.

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

// kind 'fight' = 2 outcomes, de-vigged pair. kind 'race' = winner field (30+
// outcomes), raw market mids, top of the board only.
const SERIES = [
  { ticker: 'KXUFCFIGHT',    kind: 'fight', sport: 'MMA' },
  { ticker: 'KXBOXINGFIGHT', kind: 'fight', sport: 'Boxing' },
  { ticker: 'KXF1RACE',      kind: 'race',  sport: 'F1' },
  { ticker: 'KXNASCARRACE',  kind: 'race',  sport: 'NASCAR' },
];

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 10 * 60 * 1000;

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

function probToAmerican(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

// Mid yes-price of a market; null when the order book is empty (bid 0 / ask 1),
// same no-information rule as src/kalshi.js.
function midOf(m) {
  const bid = parseFloat(m.yes_bid_dollars), ask = parseFloat(m.yes_ask_dollars);
  if (isNaN(bid) || isNaN(ask)) return null;
  if (bid === 0 && ask === 1) return null;
  return (bid + ask) / 2;
}

function normalizeEvent(ev, def) {
  const outcomes = [];
  for (const m of ev.markets || []) {
    const name = (m.yes_sub_title || '').trim();
    const mid = midOf(m);
    if (!name || mid == null) continue;
    outcomes.push({ name, prob: mid });
  }
  if (def.kind === 'fight') {
    if (outcomes.length !== 2) return null;
    const tot = outcomes[0].prob + outcomes[1].prob;
    if (!(tot > 0)) return null;
    for (const o of outcomes) { o.prob = o.prob / tot; o.american = probToAmerican(o.prob); }
  } else {
    // Race winner field: keep the raw market price per driver (the field sums
    // over 100% with vig, which is how the market actually quotes), best first.
    outcomes.sort((a, b) => b.prob - a.prob);
    outcomes.length = Math.min(outcomes.length, 12);
    for (const o of outcomes) o.american = probToAmerican(o.prob);
  }
  if (!outcomes.length || outcomes.some(o => o.american == null)) return null;
  return {
    kind: def.kind,
    sport: def.sport,
    title: ev.title || '',
    ticker: ev.event_ticker || '',
    outcomes,
  };
}

async function fetchSeriesEvents(ticker) {
  const url = `${BASE_URL}/events?series_ticker=${ticker}&with_nested_markets=true&limit=100&status=open`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data?.events) ? data.events : [];
  } catch (_) { return []; }
}

// All open Kalshi fight/race events, normalized. Cached; concurrent callers
// share one in-flight fetch.
let _inflight = null;
async function getKalshiEventOdds() {
  if (_cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const out = [];
    for (let i = 0; i < SERIES.length; i++) {
      if (i > 0) await _sleep(300);
      const evs = await fetchSeriesEvents(SERIES[i].ticker);
      for (const ev of evs) {
        const n = normalizeEvent(ev, SERIES[i]);
        if (n) out.push(n);
      }
    }
    _cache = out; _cacheAt = Date.now();
    _inflight = null;
    return out;
  })();
  return _inflight;
}

module.exports = { getKalshiEventOdds };
