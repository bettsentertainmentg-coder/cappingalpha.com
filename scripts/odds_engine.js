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
//                  Partial-game rows add: period ('F5' = MLB first 5 innings,
//                  '1H' = first half) + spread_home_odds/spread_away_odds (F5
//                  runlines are juice-heavy +-0.5 lines, the odds matter).
//   Site ingest:   POST /admin/ingest-book-lines  -> book_lines table
//                  (rows with a period land in book_lines_period)
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

// opts.period === 'F5' switches the parser onto the First 5 Innings markets
// (same 'Game Lines' group, period.description 'First 5 Innings'); these only
// exist on the per-event description endpoint, not the league coupon.
function bovadaParseEvent(sport, ev, opts = {}) {
  const f5 = opts.period === 'F5';
  const comps = ev.competitors || [];
  const home = comps.find(c => c.home === true), away = comps.find(c => c.home === false);
  if (!home || !away) return null;
  const row = {
    book: 'bovada', sport, home_team: home.name, away_team: away.name,
    // Event start rides on every row so the site can match the RIGHT game when
    // the same two teams play consecutive days (series) or twice in one day.
    start_time: ev.startTime ? new Date(ev.startTime).toISOString() : null,
    ml_home: null, ml_away: null, spread_home: null, spread_away: null,
    over_under: null, ou_over_odds: null, ou_under_odds: null,
  };
  if (f5) { row.period = 'F5'; row.spread_home_odds = null; row.spread_away_odds = null; }
  for (const dg of ev.displayGroups || []) {
    if ((dg.description || '') !== 'Game Lines') continue;
    for (const m of dg.markets || []) {
      const period = m.period || {};
      const wanted = f5
        ? /first\s*5\s*innings/i.test(period.description || '')
        : (period.main === true || /match|game|regulation/i.test(period.description || ''));
      if (!wanted) continue;
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
          if (isHome) { row.spread_home = hc; if (f5) row.spread_home_odds = american(price.american); }
          else if (isAway) { row.spread_away = hc; if (f5) row.spread_away_odds = american(price.american); }
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

async function fetchBovada(opts = {}) {
  const rows = [];
  const mlbLinks = [];
  for (const [sport, path] of Object.entries(BOVADA_SPORTS)) {
    if (opts.sports && !opts.sports.has(sport)) continue;
    try {
      // preMatchOnly=false is load-bearing: without it Bovada omits same-day
      // events entirely (and it also brings in live in-play odds, which the
      // betslip's live board wants anyway).
      const groups = await getJson(`https://www.bovada.lv/services/sports/event/coupon/events/A/description/${path}?marketFilterId=def&preMatchOnly=false&lang=en`);
      if (!Array.isArray(groups)) continue;
      for (const grp of groups) {
        for (const ev of grp.events || []) {
          if (sport === 'Soccer' && !soccerEventOk(ev, grp)) continue;
          if (sport === 'MLB' && ev.link) mlbLinks.push(ev.link);
          const row = bovadaParseEvent(sport, ev);
          if (row) rows.push(row);
        }
      }
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) console.warn(`[bovada] ${sport}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1200)); // polite gap between sports
  }
  // Depth pass (MLB): the per-event description endpoint carries the F5
  // family PLUS pitcher/player props, team totals, and alternate ladders —
  // one call per game covers all of it. Skipped on the hot loop.
  if (!opts.lite) {
    for (const link of mlbLinks.slice(0, 20)) {
      try {
        const detail = await getJson(`https://www.bovada.lv/services/sports/event/v2/events/A/description${link}?lang=en`);
        for (const grp of Array.isArray(detail) ? detail : []) {
          for (const ev of grp.events || []) {
            const row = bovadaParseEvent('MLB', ev, { period: 'F5' });
            if (row) rows.push(row);
            rows.push(...bovadaParseDepth('MLB', ev));
          }
        }
      } catch (err) {
        if (!/HTTP 404/.test(err.message)) console.warn(`[bovada-f5] ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }
  return rows;
}

// ── Bovada per-event depth: props / team totals / alternates ─────────────────
// Parsed from the SAME detail payload the F5 pass downloads. Player props sit
// in the Pitcher/Player Props groups ("Total Strikeouts - Name (TEAM)"),
// team totals + alternate ladders in the Alternate Lines group.
const BOVADA_PROP_MARKETS = [
  [/^total strikeouts/i, 'strikeouts'],
  [/^total hits allowed/i, 'hits_allowed'],
  [/^total bases/i, 'total_bases'],
  [/^total hits/i, 'hits'],
  [/^total doubles/i, 'doubles'],
  [/^total rbis?/i, 'rbis'],
  [/^total runs scored/i, 'runs'],
];

function bovadaParseDepth(sport, ev) {
  const out = [];
  const comps = ev.competitors || [];
  const home = comps.find(c => c.home === true), away = comps.find(c => c.home === false);
  if (!home || !away) return out;
  const startTime = ev.startTime ? new Date(ev.startTime).toISOString() : null;
  const props = new Map();
  const propFor = (entity, market, line) => {
    const key = `${entity}|${market}|${line}`;
    if (!props.has(key)) {
      props.set(key, {
        book: 'bovada', sport, home_team: home.name, away_team: away.name,
        start_time: startTime, entity, market, line, over_odds: null, under_odds: null,
      });
    }
    return props.get(key);
  };
  for (const dg of ev.displayGroups || []) {
    const group = dg.description || '';
    for (const m of dg.markets || []) {
      const period = m.period || {};
      if (!(period.main === true || /game/i.test(period.abbreviation || ''))) continue;
      const desc = m.description || '';
      if (group === 'Pitcher Props' || group === 'Player Props') {
        // "Total Strikeouts - Brandon Sproat (MIL)" -> market + player.
        const dash = desc.indexOf(' - ');
        if (dash === -1) continue;
        const marketHit = BOVADA_PROP_MARKETS.find(([re]) => re.test(desc));
        if (!marketHit) continue;
        const player = desc.slice(dash + 3).replace(/\([A-Z]{2,4}\)\s*$/, '').trim();
        if (!player) continue;
        for (const o of m.outcomes || []) {
          const price = o.price || {};
          const odds = american(price.american);
          const line = american(price.handicap);
          if (odds == null || line == null) continue;
          const row = propFor(player, marketHit[1], line);
          const od = (o.description || '').toLowerCase();
          if (od.startsWith('over')) row.over_odds = odds;
          else if (od.startsWith('under')) row.under_odds = odds;
        }
      } else if (group === 'Alternate Lines') {
        // Team totals: "Total Runs O/U - Milwaukee Brewers". Alternate spread /
        // total ladders: "Spread" / "Total Runs O/U" with laddered handicaps.
        const teamTT = /^total (?:runs|points) o\/u - (.+)$/i.exec(desc);
        for (const o of m.outcomes || []) {
          const price = o.price || {};
          const odds = american(price.american);
          const line = american(price.handicap);
          if (odds == null || line == null) continue;
          const od = (o.description || '').toLowerCase();
          if (teamTT) {
            const row = propFor(teamTT[1].trim(), 'team_total', line);
            if (od.startsWith('over')) row.over_odds = odds;
            else if (od.startsWith('under')) row.under_odds = odds;
          } else if (/^spread$/i.test(desc)) {
            const isHome = (o.description || '') === home.name || o.type === 'H';
            const isAway = (o.description || '') === away.name || o.type === 'A';
            const team = isHome ? home.name : isAway ? away.name : null;
            if (!team) continue;
            propFor(team, 'alt_spread', line).over_odds = odds;
          } else if (/^total(?:\s+runs)?(?:\s+o\/u)?$/i.test(desc)) {
            const row = propFor('', 'alt_total', line);
            if (od.startsWith('over')) row.over_odds = odds;
            else if (od.startsWith('under')) row.under_odds = odds;
          }
        }
      }
    }
  }
  for (const row of props.values()) if (row.over_odds != null || row.under_odds != null) out.push(row);
  return out;
}

// ── Bovada event-lane coupons: sports with no ESPN scoreboard ────────────────
// Same coupon endpoint as the team sports; ML market names differ per sport
// ("Fight Winner", "To Win the Bout"), handled by the parser regex below.
const BOVADA_EVENT_SPORTS = {
  'Esports':      'esports',
  'Table Tennis': 'table-tennis',
  'Cricket':      'cricket',
  'MMA':          'ufc-mma',
  'Boxing':       'boxing',
};

function bovadaParseEventLane(sport, ev, grp) {
  const comps = ev.competitors || [];
  const home = comps.find(c => c.home === true), away = comps.find(c => c.home === false);
  if (!home || !away) return null;
  const row = {
    book: 'bovada', sport, home_team: home.name, away_team: away.name,
    start_time: ev.startTime ? new Date(ev.startTime).toISOString() : null,
    event_lane: true, league: (grp && grp.path && grp.path[0] && grp.path[0].description) || null,
    ml_home: null, ml_away: null, spread_home: null, spread_away: null,
    over_under: null, ou_over_odds: null, ou_under_odds: null,
  };
  for (const dg of ev.displayGroups || []) {
    for (const m of dg.markets || []) {
      const period = m.period || {};
      if (!(period.main === true || /match|game|regulation|bout|fight/i.test(period.description || ''))) continue;
      const desc = m.description || '';
      for (const o of m.outcomes || []) {
        const price = o.price || {};
        const isHome = (o.description || '') === home.name || o.type === 'H';
        const isAway = (o.description || '') === away.name || o.type === 'A';
        if (/moneyline|fight winner|to win the bout|match winner/i.test(desc)) {
          if (isHome) row.ml_home = american(price.american);
          else if (isAway) row.ml_away = american(price.american);
        } else if (/point spread|spread|map handicap|game handicap/i.test(desc)) {
          const hc = american(price.handicap);
          if (isHome) row.spread_home = hc;
          else if (isAway) row.spread_away = hc;
        } else if (/^total/i.test(desc)) {
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

async function fetchBovadaEventLane() {
  const rows = [];
  for (const [sport, path] of Object.entries(BOVADA_EVENT_SPORTS)) {
    try {
      const groups = await getJson(`https://www.bovada.lv/services/sports/event/coupon/events/A/description/${path}?marketFilterId=def&preMatchOnly=false&lang=en`);
      if (!Array.isArray(groups)) continue;
      for (const grp of groups) {
        for (const ev of grp.events || []) {
          const row = bovadaParseEventLane(sport, ev, grp);
          if (row) rows.push(row);
        }
      }
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) console.warn(`[bovada-events] ${sport}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 900));
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

// Chunked relay for one row kind. tolerate404 marks endpoints the deployed
// site may not have yet (they 404 until the next ship — by design, never an
// error loud enough to kill the cycle).
async function relayRows(path, rows, chunk, tolerate404) {
  if (!rows.length) return null;
  try {
    let stored = 0, unmatched = 0, locked = 0;
    for (let i = 0; i < rows.length; i += chunk) {
      const out = await relay(path, { rows: rows.slice(i, i + chunk) });
      stored += out.stored || 0; unmatched += out.unmatched || 0; locked += out.locked || 0;
    }
    return { sent: rows.length, stored, unmatched, locked };
  } catch (err) {
    if (tolerate404 && /HTTP 404/.test(err.message)) {
      console.warn(`[odds-engine] ${path} 404 (site not deployed yet?)`);
      return { sent: rows.length, error: 'HTTP 404' };
    }
    console.error(`[odds-engine] relay ${path} failed:`, err.message);
    return { sent: rows.length, error: err.message.slice(0, 100) };
  }
}

// Hot list source: the last cold sweep's game rows (kept pre-relay).
let lastSweepRows = [];
let cycleRunning = false;
let hotRunning = false;

async function cycle() {
  // In-flight guard: at short intervals an overlapping tick would double
  // per-host request volume and interleave relay POSTs.
  if (cycleRunning) { console.warn('[odds-engine] previous cycle still running — tick skipped'); return; }
  cycleRunning = true;
  try {
    const stats = { interval_min: Math.round(INTERVAL_MS / 60000), adapters: {} };
    // Adapters run in PARALLEL — each book is its own host, so per-host
    // politeness is unchanged and wall clock drops to the slowest adapter.
    // Same-host extras (pinnacle event lane, bovada event lane) run inside
    // their book's task, sequentially, to keep per-host pacing intact.
    const tasks = BOOKS.map(async (book) => {
      const fn = ADAPTERS[book];
      if (!fn) return { book, error: 'unknown adapter' };
      try {
        let rows = await fn();
        if (book === 'pinnacle' && ADAPTERS.pinnacleEvents) {
          try { rows = rows.concat(await ADAPTERS.pinnacleEvents()); }
          catch (err) { console.warn('[pinnacle-events]', err.message); }
          try { if (ADAPTERS.pinnacleTennis) rows = rows.concat(await ADAPTERS.pinnacleTennis()); }
          catch (err) { console.warn('[pinnacle-tennis]', err.message); }
        }
        if (book === 'bovada') {
          try { rows = rows.concat(await fetchBovadaEventLane()); }
          catch (err) { console.warn('[bovada-events]', err.message); }
        }
        return { book, rows };
      } catch (err) {
        return { book, error: err.message.slice(0, 100) };
      }
    });
    const results = await Promise.all(tasks);
    let all = [];
    for (const r of results) {
      if (r.error) stats.adapters[r.book] = { error: r.error };
      else { stats.adapters[r.book] = { rows: r.rows.length }; all = all.concat(r.rows); }
    }
    // Fight-card events (Boxing + MMA fixtures) ride along each cycle.
    try {
      const events = await fetchBovadaEvents();
      if (events.length) {
        const out = await relay('/admin/ingest-engine-events', { events });
        stats.events = { sent: events.length, stored: out.stored };
      }
    } catch (err) {
      stats.events = { error: err.message.slice(0, 100) };
    }

    // LINES LOCK AT GAME START: never relay in-play prices. Rows without a
    // start_time can't be judged here — the site-side ingest guard covers them.
    const now = Date.now();
    const preStart = all.filter(r => {
      const t = r.start_time ? Date.parse(r.start_time) : NaN;
      return isNaN(t) || t > now;
    });
    if (preStart.length < all.length) stats.dropped_started = all.length - preStart.length;
    all = preStart;

    // Split by row kind. Order matters: event-lane rows carry no entity;
    // prop rows carry entity+market; period rows carry period.
    const eventRows  = all.filter(r => r.event_lane);
    const propRows   = all.filter(r => !r.event_lane && r.market !== undefined && r.entity !== undefined);
    const periodRows = all.filter(r => !r.event_lane && r.market === undefined && r.period);
    const gameRows   = all.filter(r => !r.event_lane && r.market === undefined && !r.period);
    lastSweepRows = gameRows;

    const outGame = await relayRows('/admin/ingest-book-lines', gameRows, 700, false);
    if (outGame) {
      stats.stored = outGame.stored; stats.unmatched = outGame.unmatched;
      if (outGame.locked) stats.locked = outGame.locked;
      console.log(`[odds-engine] relayed ${gameRows.length} rows -> stored ${outGame.stored}, unmatched ${outGame.unmatched}`);
    } else {
      console.log('[odds-engine] no rows this cycle');
    }
    stats.period = await relayRows('/admin/ingest-book-lines-period', periodRows, 700, true) || undefined;
    stats.props  = await relayRows('/admin/ingest-book-props', propRows, 1500, true) || undefined;
    stats.event_lines = await relayRows('/admin/ingest-event-lines', eventRows, 500, true) || undefined;
    if (propRows.length || eventRows.length) {
      console.log(`[odds-engine] depth: ${propRows.length} prop rows, ${eventRows.length} event-lane rows`);
    }

    try { await relay('/admin/ingest-heartbeat', { service: 'odds-engine', meta: stats }); }
    catch (err) { console.warn('[odds-engine] heartbeat failed:', err.message); }
  } finally {
    cycleRunning = false;
  }
}

// ── Hot loop: games starting soon get a fast mainline refresh ─────────────────
// Every ODDS_ENGINE_HOT_SEC (default 75s), re-fetch ONLY the one-call league
// boards (opts.lite skips every per-event pass) for the sports that have a
// game starting within 90 minutes, filter to those games, and relay a small
// mainline POST. AN sits out (day-level fan-out). The cold cycle takes
// precedence: hot ticks skip while it runs.
const HOT_INTERVAL_MS = Math.max(45, parseInt(process.env.ODDS_ENGINE_HOT_SEC || '75', 10)) * 1000;
const HOT_WINDOW_MS   = 90 * 60 * 1000;
const HOT_BOOKS = ['bovada', 'draftkings', 'fanduel', 'betrivers', 'pinnacle'];

async function hotCycle() {
  if (cycleRunning || hotRunning) return;
  const now = Date.now();
  const hotKeys = new Set(), hotSports = new Set();
  for (const r of lastSweepRows) {
    if (!r.start_time) continue;
    const t = Date.parse(r.start_time);
    if (t > now && t - now <= HOT_WINDOW_MS) {
      hotKeys.add(`${r.sport}|${r.home_team}|${r.away_team}`);
      hotSports.add(r.sport);
    }
  }
  if (!hotKeys.size) return;
  hotRunning = true;
  try {
    const results = await Promise.all(HOT_BOOKS.map(async (book) => {
      const fn = ADAPTERS[book];
      if (!fn) return [];
      try { return await fn({ lite: true, sports: hotSports }); }
      catch (err) { console.warn(`[odds-engine] hot ${book}:`, err.message); return []; }
    }));
    const cutoff = Date.now();
    const rows = [].concat(...results).filter(r =>
      !r.event_lane && r.market === undefined && !r.period &&
      r.start_time && Date.parse(r.start_time) > cutoff &&
      hotKeys.has(`${r.sport}|${r.home_team}|${r.away_team}`)
    );
    if (!rows.length) return;
    const out = await relayRows('/admin/ingest-book-lines', rows, 700, false);
    if (out && out.stored != null) {
      console.log(`[odds-engine] hot: ${rows.length} rows for ${hotKeys.size} imminent event(s) -> stored ${out.stored}`);
    }
  } finally {
    hotRunning = false;
  }
}

console.log(`[odds-engine] up. books: ${BOOKS.join(', ')} · cold every ${Math.round(INTERVAL_MS / 60000)} min, hot every ${Math.round(HOT_INTERVAL_MS / 1000)}s (T-90 window) -> ${RAILWAY_URL}`);
cycle().catch(e => console.error('[odds-engine] first cycle error:', e.message));
setInterval(() => cycle().catch(e => console.error('[odds-engine] cycle error:', e.message)), INTERVAL_MS);
setInterval(() => hotCycle().catch(e => console.error('[odds-engine] hot cycle error:', e.message)), HOT_INTERVAL_MS);
