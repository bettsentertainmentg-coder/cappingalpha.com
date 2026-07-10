// scripts/odds_adapters.js — additional sportsbook adapters for the CA Odds Engine.
//
// Same contract as the inline adapters in odds_engine.js: each export is an
// async function returning an array of normalized rows (possibly empty):
//   { book, sport, home_team, away_team, ml_home, ml_away,
//     spread_home, spread_away, over_under, ou_over_odds, ou_under_odds }
// Numbers are American odds; spread_home/away are the LINES (e.g. -1.5); null when absent.
// Partial-game rows (F5 = MLB first 5 innings, 1H = first half) add:
//   period: 'F5' | '1H', spread_home_odds, spread_away_odds
// and land in book_lines_period on the site (full-game rows stay in book_lines).
// F5 sources (2026-07-09): pinnacle (period 1, same payload), draftkings
// (category 1626), fanduel (first-5-innings tab), betrivers (per-event
// betoffer), bovada (per-event description, in odds_engine.js). The AN
// aggregator does NOT expose period markets (its ?period= param is ignored —
// verified: identical odds values), so Caesars/BetMGM/bet365/HardRock have no
// F5 path for now.
//
// ZERO paid APIs. Public endpoints only, no logins. The only "key" used is
// Pinnacle's guest API key and FanDuel's _ak app key, both published in the
// books' own public page source (they identify the web app, not an account).
//
// Adapters never throw: every league fetch is try/catch'd and failures are
// console.warn'd (partial rows still returned), so the engine's health board
// surfaces per-book status without a bad book killing the cycle.
//
// Live-test status from this Mac (residential IP), 2026-07-03:
//   betrivers   WORKING  (Kambi CDN, operator rsiusil; 200 on all league paths)
//   pinnacle    WORKING  (guest.api.arcadia.pinnacle.com with public guest key)
//   fanduel     WORKING  (sbapi.nj.sportsbook.fanduel.com content-managed-page)
//   draftkings  WORKING  (sportsbook-nash.draftkings.com; the old US-SB v5 API is 403)
//   caesars     BLOCKED  (api.americanwagering.com -> Akamai 403 even with full browser headers)
//   hardrock    BLOCKED  (api.hardrocksportsbook.com -> Cloudflare 403; odds ship over an
//                         authenticated websocket at mercury.hardrocksportsbook.com)
//   betonline   BLOCKED  (www/api/sports.betonline.ag all Cloudflare 403; no public JSON found)
//   thunderpick BLOCKED  (thunderpick.io Cloudflare 403; api.thunderpick.io does not resolve;
//                         esports-focused anyway, so little overlap with our sports)
//
// Wire-up in odds_engine.js:
//   const extra = require('./odds_adapters');
//   const ADAPTERS = { bovada: fetchBovada, ...extra };
//   (the nash-based draftkings here can replace the inline 403'ing fetchDraftKings)

'use strict';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// American odds parser. Handles numbers, "+108", "-134", and DraftKings'
// Unicode minus sign (U+2212) which breaks parseFloat if left in place.
function american(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/−/g, '-').replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
}

async function getJson(url, extraHeaders = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...extraHeaders },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function emptyRow(book, sport, home, away, startTime) {
  return {
    book, sport, home_team: home, away_team: away,
    // ISO event start when the feed provides it — lets the site's ingest match
    // the RIGHT game when the same pair plays consecutive days (series) or a
    // doubleheader. Null-safe: matching falls back to the legacy rules.
    start_time: startTime || null,
    ml_home: null, ml_away: null, spread_home: null, spread_away: null,
    over_under: null, ou_over_odds: null, ou_under_odds: null,
  };
}

// Normalize a feed timestamp (ISO string or epoch ms) to ISO, else null.
function isoOrNull(v) {
  if (!v) return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = new Date(t);
  // Placeholder dates (FanDuel uses 2099 for non-event attachments) are noise.
  if (d.getUTCFullYear() > 2090) return null;
  return d.toISOString();
}

const rowUsable = (r) => r.ml_home != null || r.spread_home != null || r.over_under != null;

// ── betrivers (Kambi platform) ────────────────────────────────────────────────
// Rush Street's Kambi offering is served from a public CDN. Any state operator
// key works and returns the same national board (rsiusil/rsiuspa/rsiusnj/... all
// 200 with identical events); "betrivers" as operator gets rate-limited (429).
// market=US makes outcomes carry oddsAmerican; line values come as line*1000.
const KAMBI_OPERATOR = 'rsiusil';
const KAMBI_LEAGUES = {
  MLB:   'baseball/mlb',
  NBA:   'basketball/nba',
  WNBA:  'basketball/wnba',
  NHL:   'ice_hockey/nhl',
  NFL:   'american_football/nfl',
  NCAAF: 'american_football/ncaaf',
  CBB:   'basketball/ncaab',
};

function kambiParseEvent(sport, e) {
  const ev = e.event || {};
  if (!ev.homeName || !ev.awayName) return null;
  const row = emptyRow('betrivers', sport, ev.homeName, ev.awayName, isoOrNull(ev.start));
  for (const bo of e.betOffers || []) {
    if (bo.suspended === true) continue;
    const typeName = (bo.betOfferType && bo.betOfferType.name) || '';
    for (const o of bo.outcomes || []) {
      if (o.status === 'SUSPENDED') continue;
      const odds = american(o.oddsAmerican);
      if (odds == null) continue;
      // participant/label carries the team name; OT_ONE is the home side in
      // Kambi's model (display order is flipped by the AWAY_HOME tag, data isn't).
      const name = o.participant || o.label || '';
      const isHome = name === ev.homeName || (name !== ev.awayName && o.type === 'OT_ONE');
      const isAway = name === ev.awayName || (name !== ev.homeName && o.type === 'OT_TWO');
      if (typeName === 'Match') {
        if (isHome && row.ml_home == null) row.ml_home = odds;
        else if (isAway && row.ml_away == null) row.ml_away = odds;
      } else if (typeName === 'Handicap') {
        const line = o.line != null ? o.line / 1000 : null;
        if (line == null) continue;
        if (isHome && row.spread_home == null) row.spread_home = line;
        else if (isAway && row.spread_away == null) row.spread_away = line;
      } else if (typeName === 'Over/Under') {
        const line = o.line != null ? o.line / 1000 : null;
        if (o.type === 'OT_OVER') {
          if (line != null && row.over_under == null) row.over_under = line;
          if (row.ou_over_odds == null) row.ou_over_odds = odds;
        } else if (o.type === 'OT_UNDER') {
          if (line != null && row.over_under == null) row.over_under = line;
          if (row.ou_under_odds == null) row.ou_under_odds = odds;
        }
      }
    }
  }
  return rowUsable(row) ? row : null;
}

// BetRivers F5 (MLB): the main-board matches.json only carries full-game
// offers; First 5 Innings offers live on each event's betoffer catalog with
// clean criterion labels. One call per game, paced.
const KAMBI_F5_CRITERIA = {
  'Moneyline - First 5 Innings':  'ml',
  'Spread - First 5 Innings':     'spread',
  'Total Runs - First 5 Innings': 'total',
};

function kambiParseF5(ev, betOffers) {
  const row = { ...emptyRow('betrivers', 'MLB', ev.homeName, ev.awayName, isoOrNull(ev.start)), period: 'F5', spread_home_odds: null, spread_away_odds: null };
  // Alt lines arrive as sibling offers with the same criterion; the real main
  // carries the MAIN_LINE tag. Sort mains first so first-wins picks them, with
  // untagged offers as fallback (the F5 moneyline has no MAIN_LINE tag at all).
  const offers = [...(betOffers || [])].sort((a, b) =>
    ((b.tags || []).includes('MAIN_LINE') ? 1 : 0) - ((a.tags || []).includes('MAIN_LINE') ? 1 : 0));
  for (const bo of offers) {
    if (bo.suspended === true) continue;
    const kind = KAMBI_F5_CRITERIA[(bo.criterion && bo.criterion.label) || ''];
    if (!kind) continue;
    for (const o of bo.outcomes || []) {
      if (o.status === 'SUSPENDED') continue;
      const odds = american(o.oddsAmerican);
      if (odds == null) continue;
      const name = o.participant || o.label || '';
      const isHome = name === ev.homeName || (name !== ev.awayName && o.type === 'OT_ONE');
      const isAway = name === ev.awayName || (name !== ev.homeName && o.type === 'OT_TWO');
      const line = o.line != null ? o.line / 1000 : null;
      if (kind === 'ml') {
        if (isHome && row.ml_home == null) row.ml_home = odds;
        else if (isAway && row.ml_away == null) row.ml_away = odds;
      } else if (kind === 'spread') {
        if (line == null) continue;
        if (isHome && row.spread_home == null) { row.spread_home = line; row.spread_home_odds = odds; }
        else if (isAway && row.spread_away == null) { row.spread_away = line; row.spread_away_odds = odds; }
      } else {
        if (o.type === 'OT_OVER') {
          if (line != null && row.over_under == null) row.over_under = line;
          if (row.ou_over_odds == null) row.ou_over_odds = odds;
        } else if (o.type === 'OT_UNDER') {
          if (line != null && row.over_under == null) row.over_under = line;
          if (row.ou_under_odds == null) row.ou_under_odds = odds;
        }
      }
    }
  }
  return rowUsable(row) ? row : null;
}

async function betrivers() {
  const rows = [];
  for (const [sport, path] of Object.entries(KAMBI_LEAGUES)) {
    try {
      const data = await getJson(
        `https://eu-offering-api.kambicdn.com/offering/v2018/${KAMBI_OPERATOR}/listView/${path}/all/all/matches.json?lang=en_US&market=US&useCombined=true`
      );
      const mlbEvents = [];
      for (const e of data.events || []) {
        const row = kambiParseEvent(sport, e);
        if (row) rows.push(row);
        if (sport === 'MLB' && e.event && e.event.id && e.event.homeName) mlbEvents.push(e.event);
      }
      if (sport === 'MLB') {
        for (const ev of mlbEvents.slice(0, 20)) {
          try {
            await sleep(400);
            const full = await getJson(
              `https://eu-offering-api.kambicdn.com/offering/v2018/${KAMBI_OPERATOR}/betoffer/event/${ev.id}.json?lang=en_US&market=US`
            );
            const row = kambiParseF5(ev, full.betOffers);
            if (row) rows.push(row);
          } catch (err) {
            if (!/HTTP 404/.test(err.message)) console.warn(`[betrivers-f5] ${err.message}`);
          }
        }
      }
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) console.warn(`[betrivers] ${sport}: ${err.message}`);
    }
    await sleep(1200);
  }
  return rows;
}

// ── pinnacle (guest API) ──────────────────────────────────────────────────────
// Pinnacle's own site boots with this guest key (published in their page
// source; identifies the public web client, not an account). Two calls per
// league: /matchups for team names, /markets/straight for prices. Prices are
// already American ints; main lines are isAlternate=false, period 0 = full game.
const PINNACLE_KEY = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';
const PINNACLE_HEADERS = {
  'X-API-Key': PINNACLE_KEY,
  Referer: 'https://www.pinnacle.com/',
  Origin: 'https://www.pinnacle.com',
};
const PINNACLE_LEAGUES = { MLB: 246, NBA: 487, WNBA: 578, NHL: 1456, NFL: 889, NCAAF: 880, CBB: 493 };
// Pinnacle period 1 = the "first half" market family, in the SAME straight
// payload (zero extra calls): F5 (first 5 innings) for baseball, 1H for
// basketball/football. Verified live 2026-07-09: MLB period-1 total sat at
// exactly half the game total, spread was the +-0/0.5 F5 runline. NHL's
// period 1 is a single hockey period — skipped. Period 3 (1st inning) skipped.
const PINNACLE_P1 = { MLB: 'F5', NBA: '1H', WNBA: '1H', NFL: '1H', NCAAF: '1H', CBB: '1H' };

async function pinnacle() {
  const rows = [];
  for (const [sport, leagueId] of Object.entries(PINNACLE_LEAGUES)) {
    try {
      const base = `https://guest.api.arcadia.pinnacle.com/0.1/leagues/${leagueId}`;
      const matchups = await getJson(`${base}/matchups?brandId=0`, PINNACLE_HEADERS);
      await sleep(600);
      const markets = await getJson(`${base}/markets/straight`, PINNACLE_HEADERS);

      // Real games only: props/alt matchups carry type "special" or a parentId.
      const games = new Map(); // matchupId -> row
      for (const m of Array.isArray(matchups) ? matchups : []) {
        if (m.type !== 'matchup' || m.parentId) continue;
        const home = (m.participants || []).find((p) => p.alignment === 'home');
        const away = (m.participants || []).find((p) => p.alignment === 'away');
        if (!home || !away) continue;
        games.set(m.id, emptyRow('pinnacle', sport, home.name, away.name, isoOrNull(m.startTime)));
      }
      const p1 = PINNACLE_P1[sport];
      const gamesP1 = new Map(); // matchupId -> period row
      for (const m of Array.isArray(markets) ? markets : []) {
        if (m.isAlternate) continue;
        let row = null;
        if (m.period === 0) {
          row = games.get(m.matchupId);
        } else if (m.period === 1 && p1) {
          const base2 = games.get(m.matchupId);
          if (base2) {
            row = gamesP1.get(m.matchupId);
            if (!row) {
              row = { ...emptyRow('pinnacle', sport, base2.home_team, base2.away_team, base2.start_time), period: p1, spread_home_odds: null, spread_away_odds: null };
              gamesP1.set(m.matchupId, row);
            }
          }
        }
        if (!row) continue;
        for (const p of m.prices || []) {
          const price = american(p.price);
          if (price == null) continue;
          if (m.type === 'moneyline') {
            if (p.designation === 'home') row.ml_home = price;
            else if (p.designation === 'away') row.ml_away = price;
          } else if (m.type === 'spread') {
            if (p.designation === 'home') { row.spread_home = p.points != null ? p.points : null; if (row.period) row.spread_home_odds = price; }
            else if (p.designation === 'away') { row.spread_away = p.points != null ? p.points : null; if (row.period) row.spread_away_odds = price; }
          } else if (m.type === 'total') {
            if (p.points != null && row.over_under == null) row.over_under = p.points;
            if (p.designation === 'over') row.ou_over_odds = price;
            else if (p.designation === 'under') row.ou_under_odds = price;
          }
        }
      }
      for (const row of games.values()) if (rowUsable(row)) rows.push(row);
      for (const row of gamesP1.values()) if (rowUsable(row)) rows.push(row);
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) console.warn(`[pinnacle] ${sport}: ${err.message}`);
    }
    await sleep(1200);
  }
  return rows;
}

// ── betonline ─────────────────────────────────────────────────────────────────
// Everything (www, sports, api subdomains) sits behind Cloudflare bot
// management that 403s plain HTTP clients regardless of headers; no public
// JSON offering was found as of 2026-07-03. One cheap probe per cycle so the
// health board notices if they ever open up.
async function betonline() {
  try {
    await getJson('https://api.betonline.ag/pub/api/v2/sports', {
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.betonline.ag/sportsbook',
    });
    // If this ever returns 200 the shape is unknown; flag it so we can build the parser.
    console.warn('[betonline] endpoint responded 200; parser not built yet, returning 0 rows');
  } catch (err) {
    console.warn(`[betonline] no working public endpoint yet (${err.message})`);
  }
  return [];
}

// ── caesars ───────────────────────────────────────────────────────────────────
// api.americanwagering.com schedule endpoints are Akamai-guarded: 403 from
// this Mac even with a full browser header set (tested mi/nj/co, 2026-07-03).
// The parse below follows Caesars' known v3 schema (competitions -> events ->
// markets -> selections with price.a) so it lights up if Akamai ever lets a
// plain client through; until then it warns once per cycle and bails early.
const CAESARS_SPORTS = {
  MLB:   ['baseball', /mlb/i],
  NBA:   ['basketball', /\bnba\b/i],
  WNBA:  ['basketball', /wnba/i],
  NHL:   ['icehockey', /nhl/i],
  NFL:   ['americanfootball', /\bnfl\b/i],
  NCAAF: ['americanfootball', /ncaa|college/i],
  CBB:   ['basketball', /ncaa|college/i],
};

function caesarsParseEvent(sport, ev) {
  // Event names are "Away Team at Home Team"; teamData carries home/away when present.
  let home = null, away = null;
  for (const t of ev.teamData || []) {
    if (t.homeTeam === true || /home/i.test(t.teamLocation || '')) home = t.teamName || t.name;
    else away = t.teamName || t.name;
  }
  if (!home || !away) {
    const m = /^(.+?)\s+at\s+(.+)$/i.exec(ev.name || '');
    if (m) { away = m[1].replace(/\|/g, '').trim(); home = m[2].replace(/\|/g, '').trim(); }
  }
  if (!home || !away) return null;
  const row = emptyRow('caesars', sport, home, away);
  for (const mk of ev.markets || []) {
    const name = ((mk.displayName || mk.name || '') + '').replace(/\|/g, '').toLowerCase();
    for (const sel of mk.selections || []) {
      const selName = ((sel.name || '') + '').replace(/\|/g, '').trim();
      const price = sel.price ? american(sel.price.a) : null;
      const line = mk.line != null ? american(mk.line) : (sel.price ? american(sel.price.hcap) : null);
      const isHome = selName === home, isAway = selName === away;
      if (/money\s*line/.test(name)) {
        if (isHome) row.ml_home = price; else if (isAway) row.ml_away = price;
      } else if (/spread|run line|puck line|handicap/.test(name)) {
        if (isHome) row.spread_home = line; else if (isAway) row.spread_away = line;
      } else if (/total/.test(name)) {
        if (line != null && row.over_under == null) row.over_under = line;
        if (/^over/i.test(selName)) row.ou_over_odds = price;
        else if (/^under/i.test(selName)) row.ou_under_odds = price;
      }
    }
  }
  return rowUsable(row) ? row : null;
}

async function caesars() {
  const rows = [];
  const headers = {
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://sportsbook.caesars.com/us/mi/bet/',
    Origin: 'https://sportsbook.caesars.com',
    'X-Platform': 'cordova-desktop',
  };
  for (const [sport, [slug, compRe]] of Object.entries(CAESARS_SPORTS)) {
    try {
      const data = await getJson(
        `https://api.americanwagering.com/regions/us/locations/mi/brands/czr/sb/v3/sports/${slug}/events/schedule`,
        headers
      );
      for (const comp of data.competitions || []) {
        if (!compRe.test(comp.name || '')) continue;
        for (const ev of comp.events || []) {
          const row = caesarsParseEvent(sport, ev);
          if (row) rows.push(row);
        }
      }
    } catch (err) {
      console.warn(`[caesars] ${sport}: ${err.message}`);
      // Akamai blocks are account-wide, not per-sport; do not hammer 6 more times.
      if (/HTTP 403/.test(err.message)) break;
    }
    await sleep(1500);
  }
  return rows;
}

// ── hardrock ──────────────────────────────────────────────────────────────────
// Hard Rock Bet's REST host (api.hardrocksportsbook.com, found in their app
// bundle) is Cloudflare-403 to plain clients, and the actual odds stream is an
// authenticated websocket (mercury.hardrocksportsbook.com). No public JSON
// offering as of 2026-07-03; one cheap probe per cycle keeps the health board honest.
async function hardrock() {
  try {
    await getJson('https://api.hardrocksportsbook.com/sportsbook/v1/api/sports', {
      Referer: 'https://app.hardrock.bet/',
      Origin: 'https://app.hardrock.bet',
    });
    console.warn('[hardrock] endpoint responded 200; parser not built yet, returning 0 rows');
  } catch (err) {
    console.warn(`[hardrock] no working public endpoint yet (${err.message})`);
  }
  return [];
}

// ── thunderpick ───────────────────────────────────────────────────────────────
// Crypto/esports book. Site API paths sit behind a Cloudflare challenge (403)
// and api.thunderpick.io does not resolve publicly (2026-07-03). Their board is
// esports-first anyway, so even a working feed would add few rows for our sports.
async function thunderpick() {
  try {
    await getJson('https://thunderpick.io/api/matches?limit=1', {
      Referer: 'https://thunderpick.io/',
    });
    console.warn('[thunderpick] endpoint responded 200; parser not built yet, returning 0 rows');
  } catch (err) {
    console.warn(`[thunderpick] no working public endpoint yet (${err.message})`);
  }
  return [];
}

// ── fanduel ───────────────────────────────────────────────────────────────────
// The NJ web app's content-managed-page API answers from this residential IP
// with plain fetch + referer. _ak is FanDuel's own public app key from their
// page source. Response: attachments.markets keyed by id, each with runners;
// runner.result.type gives HOME/AWAY/OVER/UNDER, runner.handicap is the line.
const FANDUEL_AK = 'FhMFpcPWXMeyZxOx';
const FANDUEL_PAGES = {
  MLB: 'mlb', NBA: 'nba', WNBA: 'wnba', NHL: 'nhl', NFL: 'nfl', NCAAF: 'ncaaf', CBB: 'ncaab',
};
const FANDUEL_HEADERS = {
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://sportsbook.fanduel.com/',
  Origin: 'https://sportsbook.fanduel.com',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
};

function fanduelRunnerOdds(r) {
  const w = r.winRunnerOdds;
  return w && w.americanDisplayOdds ? american(w.americanDisplayOdds.americanOdds) : null;
}

async function fanduel() {
  const rows = [];
  for (const [sport, pageId] of Object.entries(FANDUEL_PAGES)) {
    try {
      const data = await getJson(
        `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=${pageId}&pbHorizontal=false&_ak=${FANDUEL_AK}&timezone=America%2FNew_York`,
        FANDUEL_HEADERS
      );
      const markets = Object.values((data.attachments || {}).markets || {});
      const fdEvents = (data.attachments || {}).events || {}; // eventId -> { openDate } (event start)
      const byEvent = new Map(); // eventId -> row (built lazily from HOME/AWAY runners)
      const seenType = new Set(); // "eventId|marketType" so alt/dup markets don't overwrite mains
      for (const mk of markets) {
        const type = mk.marketType || '';
        const isML = type === 'MONEY_LINE';
        const isSpread = type === 'MATCH_HANDICAP_(2-WAY)';
        const isTotal = type === 'TOTAL_POINTS_(OVER/UNDER)';
        if (!isML && !isSpread && !isTotal) continue;
        if (mk.marketStatus && mk.marketStatus !== 'OPEN') continue;
        const key = `${mk.eventId}|${type}`;
        if (seenType.has(key)) continue;

        let row = byEvent.get(mk.eventId);
        if (isML || isSpread) {
          const home = (mk.runners || []).find((r) => r.result && r.result.type === 'HOME');
          const away = (mk.runners || []).find((r) => r.result && r.result.type === 'AWAY');
          if (!home || !away) continue;
          if (!row) { row = emptyRow('fanduel', sport, home.runnerName, away.runnerName, isoOrNull(fdEvents[mk.eventId]?.openDate)); byEvent.set(mk.eventId, row); }
          if (isML) {
            row.ml_home = fanduelRunnerOdds(home);
            row.ml_away = fanduelRunnerOdds(away);
          } else {
            row.spread_home = home.handicap != null ? home.handicap : null;
            row.spread_away = away.handicap != null ? away.handicap : null;
          }
        } else {
          // Totals runners carry no team names; attach to the row once ML/spread
          // named the teams. Markets arrive in one payload so two passes suffice.
          if (!row) continue;
          const over = (mk.runners || []).find((r) => r.result && r.result.type === 'OVER');
          const under = (mk.runners || []).find((r) => r.result && r.result.type === 'UNDER');
          if (over) { row.over_under = over.handicap != null ? over.handicap : row.over_under; row.ou_over_odds = fanduelRunnerOdds(over); }
          if (under) { if (row.over_under == null && under.handicap != null) row.over_under = under.handicap; row.ou_under_odds = fanduelRunnerOdds(under); }
        }
        seenType.add(key);
      }
      // Second pass for totals that appeared before the naming market in the map order.
      for (const mk of markets) {
        if ((mk.marketType || '') !== 'TOTAL_POINTS_(OVER/UNDER)') continue;
        const row = byEvent.get(mk.eventId);
        if (!row || row.ou_over_odds != null || row.ou_under_odds != null) continue;
        if (mk.marketStatus && mk.marketStatus !== 'OPEN') continue;
        const over = (mk.runners || []).find((r) => r.result && r.result.type === 'OVER');
        const under = (mk.runners || []).find((r) => r.result && r.result.type === 'UNDER');
        if (over) { if (over.handicap != null) row.over_under = over.handicap; row.ou_over_odds = fanduelRunnerOdds(over); }
        if (under) { if (row.over_under == null && under.handicap != null) row.over_under = under.handicap; row.ou_under_odds = fanduelRunnerOdds(under); }
      }
      for (const row of byEvent.values()) if (rowUsable(row)) rows.push(row);

      // F5 pass (MLB): First 5 Innings markets live on each event's own page
      // under the 'first-5-innings' tab (marketTypes are the 1ST_HALF_* family,
      // named "First 5 Innings ..." for baseball). One call per game, paced.
      if (sport === 'MLB') {
        for (const [eventId, gameRow] of [...byEvent.entries()].slice(0, 20)) {
          try {
            await sleep(400);
            const ep = await getJson(
              `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?eventId=${eventId}&tab=first-5-innings&_ak=${FANDUEL_AK}`,
              FANDUEL_HEADERS
            );
            const row = { ...emptyRow('fanduel', sport, gameRow.home_team, gameRow.away_team, gameRow.start_time), period: 'F5', spread_home_odds: null, spread_away_odds: null };
            for (const mk of Object.values((ep.attachments || {}).markets || {})) {
              const type = mk.marketType || '';
              if (mk.marketStatus && mk.marketStatus !== 'OPEN') continue;
              const home = (mk.runners || []).find((r) => r.result && r.result.type === 'HOME');
              const away = (mk.runners || []).find((r) => r.result && r.result.type === 'AWAY');
              const over = (mk.runners || []).find((r) => r.result && r.result.type === 'OVER');
              const under = (mk.runners || []).find((r) => r.result && r.result.type === 'UNDER');
              if (type === '1ST_HALF_MONEY_LINE') {
                if (home) row.ml_home = fanduelRunnerOdds(home);
                if (away) row.ml_away = fanduelRunnerOdds(away);
              } else if (type === '1ST_HALF_RUN_LINE') {
                if (home) { row.spread_home = home.handicap != null ? home.handicap : null; row.spread_home_odds = fanduelRunnerOdds(home); }
                if (away) { row.spread_away = away.handicap != null ? away.handicap : null; row.spread_away_odds = fanduelRunnerOdds(away); }
              } else if (type === '1ST_HALF_TOTAL_RUNS') {
                if (over) { if (over.handicap != null) row.over_under = over.handicap; row.ou_over_odds = fanduelRunnerOdds(over); }
                if (under) { if (row.over_under == null && under.handicap != null) row.over_under = under.handicap; row.ou_under_odds = fanduelRunnerOdds(under); }
              }
            }
            if (rowUsable(row)) rows.push(row);
          } catch (err) {
            if (!/HTTP 404/.test(err.message)) console.warn(`[fanduel-f5] ${err.message}`);
          }
        }
      }
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) console.warn(`[fanduel] ${sport}: ${err.message}`);
    }
    await sleep(1500);
  }
  return rows;
}

// ── draftkings (nash API) ─────────────────────────────────────────────────────
// The classic sportsbook.draftkings.com/sites/US-SB/api/v5 eventgroups API now
// 403s plain clients even with full browser headers. The newer nash content API
// answers 200 from this Mac and uses the same league/eventgroup ids. Selections
// print American odds with a Unicode minus (U+2212); american() normalizes it.
// Offseason leagues (NBA/NHL/CBB in July) return only futures, hence 0 rows.
const DK_NASH_LEAGUES = { MLB: 84240, NBA: 42648, WNBA: 94682, NHL: 42133, NFL: 88808, NCAAF: 87637, CBB: 92483 };
const DK_GAME_MARKETS = new Set(['Moneyline', 'Spread', 'Run Line', 'Puck Line', 'Total']);

function dkNashParse(sport, data) {
  const rows = [];
  const events = new Map(); // eventId -> row
  for (const ev of data.events || []) {
    const home = (ev.participants || []).find((p) => p.venueRole === 'Home');
    const away = (ev.participants || []).find((p) => p.venueRole === 'Away');
    if (!home || !away) continue;
    events.set(ev.id, emptyRow('draftkings', sport, home.name, away.name, isoOrNull(ev.startEventDate)));
  }
  const marketOf = new Map(); // marketId -> { row, kind }
  for (const m of data.markets || []) {
    const row = events.get(m.eventId);
    const typeName = (m.marketType && m.marketType.name) || '';
    if (!row || !DK_GAME_MARKETS.has(typeName) || m.main === false) continue;
    const kind = typeName === 'Moneyline' ? 'ml' : typeName === 'Total' ? 'total' : 'spread';
    marketOf.set(m.id, { row, kind });
  }
  for (const sel of data.selections || []) {
    const mk = marketOf.get(sel.marketId);
    if (!mk) continue;
    const { row, kind } = mk;
    const odds = sel.displayOdds ? american(sel.displayOdds.american) : null;
    const line = sel.points != null ? american(sel.points) : null;
    const side = sel.outcomeType; // Home / Away / Over / Under
    if (kind === 'ml') {
      if (side === 'Home' && row.ml_home == null) row.ml_home = odds;
      else if (side === 'Away' && row.ml_away == null) row.ml_away = odds;
    } else if (kind === 'spread') {
      if (side === 'Home' && row.spread_home == null) row.spread_home = line;
      else if (side === 'Away' && row.spread_away == null) row.spread_away = line;
    } else {
      if (line != null && row.over_under == null) row.over_under = line;
      if (side === 'Over' && row.ou_over_odds == null) row.ou_over_odds = odds;
      else if (side === 'Under' && row.ou_under_odds == null) row.ou_under_odds = odds;
    }
  }
  for (const row of events.values()) if (rowUsable(row)) rows.push(row);
  return rows;
}

// DK F5 (MLB): category 1626 "1st X Innings" on the same nash API. Its markets
// mix the main line and alternates inside ONE market (main=true), so each side
// carries several (points, odds) selections; the true main line is the pair
// with the most balanced juice (|home odds + away odds| smallest).
const DK_F5_CATEGORY = 1626;
const DK_F5_TYPES = {
  '1st 5 Innings':              'ml',
  'Run Line - 1st 5 Innings':   'spread',
  'Total Runs - 1st 5 Innings': 'total',
};

// Balance = closest implied probabilities on the two sides (a -110/-110 main
// line scores ~0). Summing American odds is WRONG here: it scores a skewed
// -180/+140 alt line as more "balanced" than the true -110/-110 main.
const impliedProb = (odds) => (odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100));

function pickBalancedPair(sideA, sideB, matchPoints) {
  let best = null;
  for (const a of sideA) {
    for (const b of sideB) {
      if (!matchPoints(a, b)) continue;
      if (a.odds == null || b.odds == null) continue;
      const skew = Math.abs(impliedProb(a.odds) - impliedProb(b.odds));
      if (!best || skew < best.skew) best = { a, b, skew };
    }
  }
  return best;
}

function dkNashParseF5(data) {
  const rows = [];
  const events = new Map(); // eventId -> { row, sels: {kind: {Home:[],Away:[],Over:[],Under:[]}} }
  for (const ev of data.events || []) {
    const home = (ev.participants || []).find((p) => p.venueRole === 'Home');
    const away = (ev.participants || []).find((p) => p.venueRole === 'Away');
    if (!home || !away) continue;
    events.set(ev.id, {
      row: { ...emptyRow('draftkings', 'MLB', home.name, away.name, isoOrNull(ev.startEventDate)), period: 'F5', spread_home_odds: null, spread_away_odds: null },
      sels: { ml: {}, spread: {}, total: {} },
    });
  }
  const marketOf = new Map(); // marketId -> { entry, kind }
  for (const m of data.markets || []) {
    const entry = events.get(m.eventId);
    const kind = DK_F5_TYPES[(m.marketType && m.marketType.name) || ''];
    if (!entry || !kind || m.main === false) continue;
    marketOf.set(m.id, { entry, kind });
  }
  for (const sel of data.selections || []) {
    const mk = marketOf.get(sel.marketId);
    if (!mk) continue;
    const bucket = mk.entry.sels[mk.kind];
    const side = sel.outcomeType; // Home / Away / Over / Under
    if (!side) continue;
    (bucket[side] = bucket[side] || []).push({
      points: sel.points != null ? american(sel.points) : null,
      odds: sel.displayOdds ? american(sel.displayOdds.american) : null,
    });
  }
  for (const { row, sels } of events.values()) {
    const mlH = (sels.ml.Home || [])[0], mlA = (sels.ml.Away || [])[0];
    if (mlH) row.ml_home = mlH.odds;
    if (mlA) row.ml_away = mlA.odds;
    const sp = pickBalancedPair(sels.spread.Home || [], sels.spread.Away || [],
      (h, a) => h.points != null && a.points != null && h.points === -a.points);
    if (sp) {
      row.spread_home = sp.a.points; row.spread_home_odds = sp.a.odds;
      row.spread_away = sp.b.points; row.spread_away_odds = sp.b.odds;
    }
    const tot = pickBalancedPair(sels.total.Over || [], sels.total.Under || [],
      (o, u) => o.points != null && o.points === u.points);
    if (tot) {
      row.over_under = tot.a.points;
      row.ou_over_odds = tot.a.odds; row.ou_under_odds = tot.b.odds;
    }
    if (rowUsable(row)) rows.push(row);
  }
  return rows;
}

async function draftkings() {
  const rows = [];
  const H = { Referer: 'https://sportsbook.draftkings.com/', Origin: 'https://sportsbook.draftkings.com' };
  for (const [sport, leagueId] of Object.entries(DK_NASH_LEAGUES)) {
    try {
      const data = await getJson(
        `https://sportsbook-nash.draftkings.com/api/sportscontent/dkusoh/v1/leagues/${leagueId}`,
        H
      );
      rows.push(...dkNashParse(sport, data));
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) console.warn(`[draftkings] ${sport}: ${err.message}`);
    }
    if (sport === 'MLB') {
      try {
        await sleep(600);
        const cdata = await getJson(
          `https://sportsbook-nash.draftkings.com/api/sportscontent/dkusoh/v1/leagues/${leagueId}/categories/${DK_F5_CATEGORY}`,
          H
        );
        rows.push(...dkNashParseF5(cdata));
      } catch (err) {
        if (!/HTTP 404/.test(err.message)) console.warn(`[draftkings-f5] ${err.message}`);
      }
    }
    await sleep(1200);
  }
  return rows;
}

// ── ActionNetwork aggregator: the books whose own walls we cannot climb ───────
// AN's public scoreboard API (the same unauthenticated JSON their site loads, and
// the same legal lane as our hourly public-betting scrape) carries per-book
// markets with explicit home/away sides. This is how Caesars, BetMGM, and bet365
// get in despite their Akamai/Cloudflare walls. Books we fetch DIRECTLY (bovada,
// pinnacle, betrivers, fanduel, draftkings) are skipped here so the fresher
// first-party feed always wins.
const AN_LEAGUES = { MLB: 'mlb', NBA: 'nba', WNBA: 'wnba', NHL: 'nhl', NFL: 'nfl', NCAAF: 'ncaaf', CBB: 'ncaab' };
const AN_TARGET_BOOKS = [
  [/caesars/i, 'caesars'],
  [/betmgm/i, 'betmgm'],
  [/bet365/i, 'bet365'],
  [/hard ?rock/i, 'hardrock'],
  [/betonline/i, 'betonline'],
];

let _anBookMap = null; // book_id -> our book key, discovered from AN's own catalog
async function anBookMap() {
  if (_anBookMap) return _anBookMap;
  const r = await fetch('https://www.actionnetwork.com/mlb/odds', {
    headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`catalog HTTP ${r.status}`);
  const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>({.+?})<\/script>/s);
  if (!m) throw new Error('catalog: no NEXT_DATA');
  const all = JSON.parse(m[1])?.props?.pageProps?.allBooks || {};
  const map = {};
  for (const b of Object.values(all)) {
    const name = b.display_name || '';
    for (const [re, key] of AN_TARGET_BOOKS) {
      if (re.test(name)) { map[b.id] = key; break; }
    }
  }
  _anBookMap = map;
  return map;
}

// The scoreboard is one day per call; ?date=YYYYMMDD selects the day (verified
// live 2026-07-09: tomorrow returns a different 15-game slate). Fetching today
// plus the next AN_DAYS_AHEAD days is what lets the walled books (Caesars,
// BetMGM, bet365, HardRock) cover the multi-day board like DK/FD do.
const AN_DAYS_AHEAD = 2;

function anDateParam(offsetDays) {
  // AN's date param follows the US schedule day — compute in ET (DST-exact).
  const d = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d).replace(/-/g, '');
}

async function actionnetwork() {
  const rows = [];
  let map;
  try { map = await anBookMap(); }
  catch (err) { console.warn(`[actionnetwork] ${err.message}`); return rows; }
  const ids = Object.keys(map);
  if (!ids.length) { console.warn('[actionnetwork] no target books in catalog'); return rows; }

  for (const [sport, league] of Object.entries(AN_LEAGUES)) {
    const seenGames = new Set(); // game id, across the date fan-out
    for (let day = 0; day <= AN_DAYS_AHEAD; day++) {
      try {
        const r = await fetch(`https://api.actionnetwork.com/web/v2/scoreboard/${league}?period=game&bookIds=${ids.join(',')}&date=${anDateParam(day)}`, {
          headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) { console.warn(`[actionnetwork] ${sport} day+${day}: HTTP ${r.status}`); continue; }
        const j = await r.json();
        for (const g of j.games || []) {
          if (seenGames.has(g.id)) continue;
          seenGames.add(g.id);
          const home = (g.teams || []).find(t => t.id === g.home_team_id);
          const away = (g.teams || []).find(t => t.id === g.away_team_id);
          if (!home || !away) continue;
          // One market blob per requested book: dedupe multi-state variants of the
          // same brand (Caesars NJ + Caesars NV, etc.) so one row per book survives.
          const seen = new Set();
          for (const [bookId, mkt] of Object.entries(g.markets || {})) {
            const book = map[bookId];
            if (!book || seen.has(book)) continue;
            const ev = (mkt && mkt.event) || {};
            const row = {
              book, sport, home_team: home.full_name, away_team: away.full_name,
              start_time: isoOrNull(g.start_time),
              ml_home: null, ml_away: null, spread_home: null, spread_away: null,
              over_under: null, ou_over_odds: null, ou_under_odds: null,
            };
            for (const o of ev.moneyline || []) {
              if (o.period !== 'event') continue;
              if (o.side === 'home') row.ml_home = american(o.odds);
              else if (o.side === 'away') row.ml_away = american(o.odds);
            }
            for (const o of ev.spread || []) {
              if (o.period !== 'event') continue;
              if (o.side === 'home') row.spread_home = o.value != null ? parseFloat(o.value) : null;
              else if (o.side === 'away') row.spread_away = o.value != null ? parseFloat(o.value) : null;
            }
            for (const o of ev.total || []) {
              if (o.period !== 'event') continue;
              if (o.value != null && row.over_under == null) row.over_under = parseFloat(o.value);
              if (o.side === 'over') row.ou_over_odds = american(o.odds);
              else if (o.side === 'under') row.ou_under_odds = american(o.odds);
            }
            if (row.ml_home != null || row.spread_home != null || row.over_under != null) {
              rows.push(row);
              seen.add(book);
            }
          }
        }
      } catch (err) {
        console.warn(`[actionnetwork] ${sport} day+${day}: ${err.message}`);
      }
      await sleep(900);
    }
  }
  return rows;
}

module.exports = { betrivers, pinnacle, betonline, caesars, hardrock, thunderpick, fanduel, draftkings, actionnetwork };
