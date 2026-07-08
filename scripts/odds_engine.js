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
const BOOKS        = (process.env.ODDS_ENGINE_BOOKS || 'bovada,draftkings,fanduel,betrivers,pinnacle,actionnetwork,caesars,hardrock,betonline,thunderpick')
  .split(',').map(s => s.trim().toLowerCase());
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

if (!RELAY_SECRET || !RAILWAY_URL) {
  console.error('[odds-engine] RELAY_SECRET and RAILWAY_URL are required. Exiting.');
  process.exit(1);
}

const american = (v) => {
  if (v === 'EVEN') return 100; // Bovada spells +100 as EVEN
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Adapter: Bovada (public coupon API, all team sports) ──────────────────────
const BOVADA_SPORTS = {
  MLB:    'baseball/mlb',
  NBA:    'basketball/nba',
  WNBA:   'basketball/wnba',
  NHL:    'hockey/nhl',
  NFL:    'football/nfl',
  NCAAF:  'football/college-football',
  CBB:    'basketball/college-basketball',
  // One coupon covers every soccer competition (World Cup included). Soccer
  // markets read "3-Way Moneyline" / "Goal Spread" under "Regulation Time";
  // the parser's regexes cover both shapes, and the Draw outcome matches
  // neither side name so 3-way collapses to home/away prices naturally.
  Soccer: 'soccer',
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
        if (/moneyline/i.test(desc)) { // covers 'Moneyline' and soccer's '3-Way Moneyline'
          if (isHome) row.ml_home = american(price.american);
          else if (isAway) row.ml_away = american(price.american);
        } else if (/point spread|goal spread|spread|runline|puck line/i.test(desc)) {
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

// Soccer coupon hygiene. The soccer coupon is sport-root (every competition in
// one response), which drags in three things the league-scoped coupons never see:
//   1. Promo groups ('Go Ahead Get Paid') — boosted off-market prices that would
//      overwrite the real Bovada line. Promos sit directly under /soccer with no
//      league level, i.e. a 2-element path; real leagues have 3+.
//   2. Esoccer — videogame matches named after real clubs ("Real Madrid (EDEN) vs
//      Bayern Munich (RESISTANCE)") that name-match real fixtures on the board.
//   3. Meetings weeks out — the same two clubs meet again in league/cup, and the
//      later-listed future event would overwrite today's fixture (rows match
//      today_games by name only). Anything starting >40h out can't be on today's
//      board, so it's dropped; live/past events stay (the live board wants them).
//   4. Squad variants — reserve/women/youth sides carry the first team's name
//      ("Sporting Kansas City (R)", "River Plate (W)", "Denmark U19") and play
//      the same days; the board only tracks men's first teams, so their rows
//      would overwrite the real fixture's line.
const SQUAD_VARIANT = /\((?:r|w|b|res|reserves?|am)\)|\b(?:u-?\d{2}|under-?\d{2})\b|\bii\b|\bwomen\b/i;

function soccerEventOk(ev, grp) {
  const path = (ev.path && ev.path.length ? ev.path : grp.path) || [];
  if (path.length < 3) return false;
  if (/esoccer|e-soccer|mins play|gg league/i.test(path[0]?.description || '')) return false;
  if (ev.startTime && ev.startTime - Date.now() > 40 * 3600 * 1000) return false;
  if ((ev.competitors || []).some(c => SQUAD_VARIANT.test(c.name || ''))) return false;
  return true;
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
          if (sport === 'Soccer' && !soccerEventOk(ev, grp)) continue;
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
      // storeEngineBookLines caps each POST at 800 rows and silently drops the
      // rest; a full slate plus the soccer coupon can exceed that. Chunk under
      // the cap so every row is considered.
      let stored = 0, unmatched = 0;
      for (let i = 0; i < all.length; i += 700) {
        const out = await relay('/admin/ingest-book-lines', { rows: all.slice(i, i + 700) });
        stored += out.stored || 0; unmatched += out.unmatched || 0;
      }
      stats.stored = stored; stats.unmatched = unmatched;
      console.log(`[odds-engine] relayed ${all.length} rows -> stored ${stored}, unmatched ${unmatched}`);
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
