#!/usr/bin/env node
// scripts/odds_engine.js — CA Odds Engine (runs on the Mac, not on Railway).
//
// The in-house line feed: fetches PUBLIC sportsbook odds from this Mac's
// residential IP (books geo/bot-block datacenter IPs), normalizes every book
// into one row shape, and relays to the site via HMAC-signed POST — the same
// scheme as pb_relay.js. Zero API credits, no logins, public endpoints only.
//
//   Adapters (v1): Bovada (all team sports), DraftKings (public JSON).
//   Row shape:     { book, sport, home_team, away_team, ml_home, ml_away,
//                    spread_home, spread_away, over_under, ou_over_odds, ou_under_odds }
//   Site ingest:   POST /admin/ingest-book-lines  -> book_lines table
//   Heartbeat:     POST /admin/ingest-heartbeat   -> /admin/health page
//
// Required env vars (in .env):
//   RELAY_SECRET — must match Railway's RELAY_SECRET
//   RAILWAY_URL  — e.g. https://cappingalpha.com
// Optional:
//   ODDS_ENGINE_INTERVAL_MIN — cycle minutes (default 5)
//   ODDS_ENGINE_BOOKS        — comma list to enable (default: bovada,draftkings)
//
// PM2: declared in ecosystem.config.js as 'odds-engine'.

'use strict';

// Same env loading as pb_relay.js: AgentOSO .env first, local .env fills gaps.
require('dotenv').config({ path: require('path').join(process.env.HOME || '/Users/jack', 'Projects/AgentOSO/.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env'), override: false });

const crypto = require('crypto');

const RELAY_SECRET = process.env.RELAY_SECRET;
const RAILWAY_URL  = (process.env.RAILWAY_URL || '').replace(/\/$/, '');
const INTERVAL_MS  = Math.max(2, parseInt(process.env.ODDS_ENGINE_INTERVAL_MIN || '5', 10)) * 60 * 1000;
const BOOKS        = (process.env.ODDS_ENGINE_BOOKS || 'bovada,draftkings,fanduel,betrivers,pinnacle,caesars,hardrock,betonline,thunderpick')
  .split(',').map(s => s.trim().toLowerCase());
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

if (!RELAY_SECRET || !RAILWAY_URL) {
  console.error('[odds-engine] RELAY_SECRET and RAILWAY_URL are required. Exiting.');
  process.exit(1);
}

const american = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Adapter: Bovada (public coupon API, all team sports) ──────────────────────
const BOVADA_SPORTS = {
  MLB:   'baseball/mlb',
  NBA:   'basketball/nba',
  WNBA:  'basketball/wnba',
  NHL:   'hockey/nhl',
  NFL:   'football/nfl',
  NCAAF: 'football/college-football',
  CBB:   'basketball/college-basketball',
};

function bovadaParseEvent(sport, ev) {
  const comps = ev.competitors || [];
  const home = comps.find(c => c.home === true), away = comps.find(c => c.home === false);
  if (!home || !away) return null;
  const row = {
    book: 'bovada', sport, home_team: home.name, away_team: away.name,
    ml_home: null, ml_away: null, spread_home: null, spread_away: null,
    over_under: null, ou_over_odds: null, ou_under_odds: null,
  };
  for (const dg of ev.displayGroups || []) {
    if ((dg.description || '') !== 'Game Lines') continue;
    for (const m of dg.markets || []) {
      const period = m.period || {};
      if (!(period.main === true || /match|game|regulation/i.test(period.description || ''))) continue;
      const desc = m.description || '';
      for (const o of m.outcomes || []) {
        const price = o.price || {};
        const isHome = (o.description || '') === home.name || o.type === 'H';
        const isAway = (o.description || '') === away.name || o.type === 'A';
        if (desc === 'Moneyline') {
          if (isHome) row.ml_home = american(price.american);
          else if (isAway) row.ml_away = american(price.american);
        } else if (/point spread|spread|runline|puck line/i.test(desc)) {
          const hc = american(price.handicap);
          if (isHome) row.spread_home = hc;
          else if (isAway) row.spread_away = hc;
        } else if (desc === 'Total') {
          const line = american(price.handicap);
          if (line != null && row.over_under == null) row.over_under = line;
          const od = (o.description || '').toLowerCase();
          if (od.startsWith('over'))  row.ou_over_odds  = american(price.american);
          if (od.startsWith('under')) row.ou_under_odds = american(price.american);
        }
      }
    }
  }
  const usable = row.ml_home != null || row.spread_home != null || row.over_under != null;
  return usable ? row : null;
}

async function fetchBovada() {
  const rows = [];
  for (const [sport, path] of Object.entries(BOVADA_SPORTS)) {
    try {
      // preMatchOnly=false is load-bearing: without it Bovada omits same-day
      // events entirely (and it also brings in live in-play odds, which the
      // betslip's live board wants anyway).
      const groups = await getJson(`https://www.bovada.lv/services/sports/event/coupon/events/A/description/${path}?marketFilterId=def&preMatchOnly=false&lang=en`);
      if (!Array.isArray(groups)) continue;
      for (const grp of groups) {
        for (const ev of grp.events || []) {
          const row = bovadaParseEvent(sport, ev);
          if (row) rows.push(row);
        }
      }
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) console.warn(`[bovada] ${sport}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1200)); // polite gap between sports
  }
  return rows;
}

// ── Bovada event feed: sports ESPN has no scoreboard for ─────────────────────
// Boxing and non-UFC MMA cards exist on Bovada but not on ESPN's free API, so the
// engine relays the EVENTS themselves (who fights whom, when) and the betslip's
// game picker lists them as custom-only entries.
const EVENT_FEEDS = { Boxing: 'boxing', MMA: 'ufc-mma' };

async function fetchBovadaEvents() {
  const events = [];
  for (const [sport, path] of Object.entries(EVENT_FEEDS)) {
    try {
      const groups = await getJson(`https://www.bovada.lv/services/sports/event/coupon/events/A/description/${path}?marketFilterId=def&preMatchOnly=false&lang=en`);
      if (!Array.isArray(groups)) continue;
      for (const grp of groups) {
        for (const ev of grp.events || []) {
          const parts = String(ev.description || '').split(/\s+vs\.?\s+/i);
          if (parts.length !== 2) continue;
          events.push({
            sport,
            away_team: parts[0].trim().slice(0, 80),
            home_team: parts[1].trim().slice(0, 80),
            start_time: ev.startTime ? new Date(ev.startTime).toISOString() : null,
          });
        }
      }
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) console.warn(`[bovada-events] ${sport}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  return events;
}

// ── Adapter: DraftKings (public eventgroups JSON) ─────────────────────────────
// Group ids drift when DK reshuffles; failures are visible on /admin/health.
const DK_GROUPS = { MLB: 84240, NBA: 42648, NHL: 42133, NFL: 88808, WNBA: 94682, CBB: 92483, NCAAF: 87637 };

function dkParse(sport, data) {
  const rows = [];
  const eg = data && data.eventGroup;
  if (!eg) return rows;
  const events = new Map(); // eventId -> row skeleton
  for (const ev of eg.events || []) {
    if (!ev.teamName1 || !ev.teamName2) continue;
    // DK convention: name is "Away @ Home"; teamName1 = away, teamName2 = home.
    events.set(String(ev.eventId), {
      book: 'draftkings', sport, home_team: ev.teamName2, away_team: ev.teamName1,
      ml_home: null, ml_away: null, spread_home: null, spread_away: null,
      over_under: null, ou_over_odds: null, ou_under_odds: null,
    });
  }
  for (const cat of eg.offerCategories || []) {
    if (!/game lines/i.test(cat.name || '')) continue;
    for (const sub of cat.offerSubcategoryDescriptors || []) {
      for (const offers of (sub.offerSubcategory && sub.offerSubcategory.offers) || []) {
        for (const offer of offers || []) {
          const row = events.get(String(offer.eventId));
          if (!row) continue;
          const label = (offer.label || '').toLowerCase();
          for (const oc of offer.outcomes || []) {
            const odds = american(oc.oddsAmerican);
            const line = oc.line != null ? parseFloat(oc.line) : null;
            const isHome = oc.label === row.home_team;
            const isAway = oc.label === row.away_team;
            if (label === 'moneyline') {
              if (isHome) row.ml_home = odds; else if (isAway) row.ml_away = odds;
            } else if (label === 'spread') {
              if (isHome) row.spread_home = line; else if (isAway) row.spread_away = line;
            } else if (label === 'total') {
              if (line != null && row.over_under == null) row.over_under = line;
              const ol = (oc.label || '').toLowerCase();
              if (ol === 'over')  row.ou_over_odds  = odds;
              if (ol === 'under') row.ou_under_odds = odds;
            }
          }
        }
      }
    }
  }
  for (const row of events.values()) {
    if (row.ml_home != null || row.spread_home != null || row.over_under != null) rows.push(row);
  }
  return rows;
}

async function fetchDraftKings() {
  const rows = [];
  for (const [sport, gid] of Object.entries(DK_GROUPS)) {
    try {
      const data = await getJson(`https://sportsbook.draftkings.com/sites/US-SB/api/v5/eventgroups/${gid}?format=json`);
      rows.push(...dkParse(sport, data));
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) console.warn(`[draftkings] ${sport}: ${err.message}`);
    }
  }
  return rows;
}

// ── Relay (HMAC-signed, same scheme as pb_relay.js) ───────────────────────────
async function relay(path, payload) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', RELAY_SECRET).update(body).digest('hex');
  const r = await fetch(RAILWAY_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Signature': sig },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`relay ${path} HTTP ${r.status}`);
  return r.json().catch(() => ({}));
}

// scripts/odds_adapters.js carries the researched per-book adapters (betrivers,
// pinnacle, fanduel, the working nash-API draftkings, plus honest blocked stubs
// for caesars/hardrock/betonline/thunderpick). Its draftkings replaces the inline
// v5 one, which the books 403.
const ADAPTERS = { bovada: fetchBovada, draftkings: fetchDraftKings, ...require('./odds_adapters') };

async function cycle() {
  const stats = { interval_min: Math.round(INTERVAL_MS / 60000), adapters: {} };
  let all = [];
  for (const book of BOOKS) {
    const fn = ADAPTERS[book];
    if (!fn) { stats.adapters[book] = 'unknown adapter'; continue; }
    try {
      const rows = await fn();
      all = all.concat(rows);
      stats.adapters[book] = { rows: rows.length };
    } catch (err) {
      stats.adapters[book] = { error: err.message.slice(0, 120) };
    }
  }
  // Fight-card events (Boxing + MMA) ride along each cycle.
  try {
    const events = await fetchBovadaEvents();
    if (events.length) {
      const out = await relay('/admin/ingest-engine-events', { events });
      stats.events = { sent: events.length, stored: out.stored };
    }
  } catch (err) {
    stats.events = { error: err.message.slice(0, 120) };
  }

  try {
    if (all.length) {
      const out = await relay('/admin/ingest-book-lines', { rows: all });
      stats.stored = out.stored; stats.unmatched = out.unmatched;
      console.log(`[odds-engine] relayed ${all.length} rows -> stored ${out.stored}, unmatched ${out.unmatched}`);
    } else {
      console.log('[odds-engine] no rows this cycle');
    }
  } catch (err) {
    stats.relay_error = err.message.slice(0, 120);
    console.error('[odds-engine] relay failed:', err.message);
  }
  try { await relay('/admin/ingest-heartbeat', { service: 'odds-engine', meta: stats }); }
  catch (err) { console.warn('[odds-engine] heartbeat failed:', err.message); }
}

console.log(`[odds-engine] up. books: ${BOOKS.join(', ')} · every ${Math.round(INTERVAL_MS / 60000)} min -> ${RAILWAY_URL}`);
cycle().catch(e => console.error('[odds-engine] first cycle error:', e.message));
setInterval(() => cycle().catch(e => console.error('[odds-engine] cycle error:', e.message)), INTERVAL_MS);
