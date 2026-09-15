// src/bettingpros.js
// BettingPros tracker (structured JSON, no AI). Their public web API serves the
// whole community's picks per game: stable user identity, exact post
// timestamps, native moneyline/spread/over/under types, unit sizing, and a
// per-user career history endpoint. Verified 2026-08-26: 600 picks from 182
// distinct cappers on one MLB slate, 94% of them posted before first pitch
// (median 2.8h early), readable while still unscored — so these are genuine
// pregame picks, not a post-game reveal.
//
// Auth: an x-api-key that BettingPros ships in its own public JS bundle. It
// rotates, so it is read from the bundle at boot and cached in settings; a 403
// re-reads it once. No account, no cost.
//
// PRIVACY: user.username is frequently the person's raw EMAIL address. It is
// never read here — identity comes from the profile_url slug ("/u/bettor10803/"
// -> "bettor10803"), which is also what BettingPros shows publicly.

const https = require('https');
const db = require('./db');
const { recordSourcePick, findGameByTeams, findGameByAbbrs, sideOf } = require('./source_ingest');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function req(url, headers = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const u = new URL(url);
    const r = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, timeout: 15000,
    }, (res) => {
      let b = '';
      const end = () => finish({ status: res.statusCode, body: b });
      res.on('data', (c) => { b += c; if (b.length > 12_000_000) res.destroy(); });
      res.on('end', end);
      res.on('close', end);
    });
    r.on('error', () => finish({ status: 0, body: '' }));
    r.on('timeout', () => { r.destroy(); finish({ status: 0, body: '' }); });
  });
}
async function getJson(url, key) {
  const r = await req(url, { 'x-api-key': key });
  try { return { status: r.status, json: JSON.parse(r.body) }; }
  catch (_) { return { status: r.status, json: null }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── API key: read from their public bundle, cache, refresh on 403 ────────────
async function fetchApiKey() {
  const page = await req('https://www.bettingpros.com/mlb/picks/');
  if (page.status !== 200) return null;
  // picks-*.js imports ./api-client-*.js, and the key lives in that chunk.
  const chunk = (page.body.match(/\/dist\/assets\/picks-[A-Za-z0-9_-]+\.js/) || [])[0];
  if (!chunk) return null;
  const picksJs = await req('https://www.bettingpros.com' + chunk);
  const client = (picksJs.body.match(/api-client-[A-Za-z0-9_-]+\.js/) || [])[0];
  if (!client) return null;
  const api = await req('https://www.bettingpros.com/dist/assets/' + client);
  return keyFromChunk(api.body);
}

// The key was an inline literal until 2026-09; the bundle now assigns it to a
// module variable ('"x-api-key":kn') and the literal sits on that name. Read
// both shapes so the next rotation does not strand polling on a stale key.
function keyFromChunk(js) {
  const lit = js.match(/"x-api-key"\s*:\s*[`"']([A-Za-z0-9]{20,60})[`"']/);
  if (lit) return lit[1];
  const ref = js.match(/"x-api-key"\s*:\s*([A-Za-z_$][\w$]*)/);
  if (!ref) return null;
  const v = ref[1].replace(/\$/g, '\\$');
  const m = js.match(new RegExp('(?:^|[^\\w$])' + v + '\\s*=\\s*[`"\']([A-Za-z0-9]{20,60})[`"\']'));
  return m ? m[1] : null;
}

async function apiKey(force = false) {
  if (!force) {
    const cached = db.getSetting('bp_api_key', '');
    if (cached) return cached;
  }
  const key = await fetchApiKey();
  if (key) { db.setSetting('bp_api_key', key); console.log('[bettingpros] api key refreshed from bundle'); }
  return key;
}

// BettingPros sport param -> our today_games label.
const BP_SPORTS = { MLB: 'MLB', NFL: 'NFL', NBA: 'NBA', NHL: 'NHL', WNBA: 'WNBA', NCAAF: 'NCAAF', NCAAB: 'CBB' };

// Their odds field is whatever the bettor recorded, so a slice of it is junk
// (verified: ~5% of singles carry values like +2200 or -6567 on a side).
// Prefer a plausible recorded price, fall back to the market's opening price,
// else no price — spreads and totals still grade at standard juice.
function sanePrice(pick) {
  const cand = [(pick.line || {}).cost, ((pick.selection || {}).opening_line || {}).cost];
  for (const c of cand) {
    const n = parseFloat(c);
    if (Number.isFinite(n) && n !== 0 && Math.abs(n) >= 100 && Math.abs(n) <= 2000) return Math.round(n);
  }
  return null;
}

// ── FULL-GAME MARKETS ONLY (Jack 2026-09-15) ────────────────────────────────
// Their feed serves team totals, quarter/inning lines, drive-result props,
// alternates, futures and "Game Props" with the SAME line.type values as the
// full-game markets ("over", "spread", "moneyline"), and only player props
// carry a player_id. So "Jaguars over 5 +800" and "Steelers over 10" reached
// the ledger as game totals and were graded against the final score. One
// market id per full-game market per sport, learned from their payloads:
const BP_FULL_GAME = {
  NFL:   { 1: 'ml', 2: 'total', 3: 'spread' },
  NBA:   { 127: 'ml', 128: 'total', 129: 'spread' },
  MLB:   { 122: 'ml', 175: 'total', 176: 'spread' },
  NCAAF: { 198: 'ml', 199: 'total', 200: 'spread' },
  NCAAB: { 224: 'ml', 225: 'total', 226: 'spread' },
  WNBA:  { 371: 'ml', 372: 'total', 373: 'spread' },
};
// A sport whose ids are not learned yet (NHL) has to carry one of the exact
// full-game sub-labels instead. Every sport must also pass the label SHAPE: a
// game total reads "Over 44.5", never "Ravens o36.5" or "Total Points - Over".
const BP_FULL_GAME_LABEL = /^(moneyline|money line|spread|puck line|run line|total|total points|total runs|total goals)$/i;
const BP_SHAPE = {
  total:  /^(over|under)\s+\d+(\.\d+)?$/i,
  spread: /^[A-Za-z0-9 .'&()-]+\s[+-]\d+(\.\d+)?$/,
  ml:     /^[A-Za-z0-9 .'&()-]+$/,
};
function fullGameMarket(bpSport, p, pickType) {
  const kind = pickType === 'ml' ? 'ml' : pickType === 'spread' ? 'spread' : 'total';
  const ids = BP_FULL_GAME[bpSport];
  if (ids) {
    if (ids[p.market_id] !== kind) return false;
  } else if (!BP_FULL_GAME_LABEL.test(String(p.sub_label || '').trim())) {
    return false;
  }
  if (!BP_SHAPE[kind].test(String(p.label || '').trim())) return false;
  // a game total names no participant; a team total names one
  if (kind === 'total' && (p.participants || []).length) return false;
  return true;
}

function etDate(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// "2026-08-25 17:10:00" (ET, no zone) -> ms
function bpTimeMs(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  // ET is UTC-4 in season, UTC-5 in winter; cycle.js owns the DST rule.
  const { ET_OFFSET_MS } = require('./cycle');
  return Date.UTC(y, mo - 1, d, h, mi, se) - ET_OFFSET_MS;
}

function participantsOf(ev) {
  const ps = ev.participants || [];
  return ps.map((p) => ({
    abbr: (p.team && p.team.abbreviation) || p.id || null,
    name: p.team ? `${p.team.city || ''} ${p.name || ''}`.trim() : (p.name || ''),
    short: p.name || null,
  })).filter((p) => p.abbr || p.name);
}

function matchGame(ev, sport) {
  const ps = participantsOf(ev);
  if (ps.length !== 2) return null;
  const opts = { source: 'bettingpros', sport, picked: `${ps[0].abbr || ps[0].name} vs ${ps[1].abbr || ps[1].name}` };
  return findGameByAbbrs(ps[0].abbr, ps[1].abbr, sport, opts)
    || findGameByTeams(ps[0].name, ps[1].name, sport, opts)
    || findGameByTeams(ps[0].short, ps[1].short, sport, opts);
}

// ── Poll: sweep today's events per sport, fan out to each event's picks ──────
// Their picks endpoint only answers per event_id (a date-only query returns an
// empty list), so the event sweep is mandatory.
async function pollBettingPros() {
  if (db.getSetting('bp_scrape_enabled', '1') !== '1') return 0;
  let key = await apiKey();
  if (!key) { console.warn('[bettingpros] no api key available'); return 0; }

  const today = etDate(Date.now());
  const minUnits = parseFloat(db.getSetting('bp_min_units', '0'));
  let inserted = 0, dupes = 0, skipped = 0;
  const refusedMarkets = {}; // "NFL m327 Game Props" -> count, for the log line

  for (const [bpSport, ourSport] of Object.entries(BP_SPORTS)) {
    let ev = await getJson(`https://api.bettingpros.com/v3/events?sport=${bpSport}&date=${today}`, key);
    if (ev.status === 403) { // key rotated mid-day
      key = await apiKey(true);
      if (!key) break;
      ev = await getJson(`https://api.bettingpros.com/v3/events?sport=${bpSport}&date=${today}`, key);
    }
    const events = (ev.json && ev.json.events) || [];
    if (!events.length) { await sleep(120); continue; }

    for (const e of events) {
      const game = matchGame(e, ourSport);
      if (!game) continue;
      const res = await getJson(`https://api.bettingpros.com/v3/picks?sport=${bpSport}&event_id=${e.id}&limit=100`, key);
      await sleep(150);
      for (const p of ((res.json && res.json.picks) || [])) {
        // Skip what we cannot grade as one board slot: player props and parlays.
        if (p.player_id) { skipped++; continue; }
        if (Array.isArray(p.parlay) ? p.parlay.length : p.parlay) { skipped++; continue; }

        const type = ((p.line || {}).type || '').toLowerCase();
        const pickType = type === 'moneyline' ? 'ml'
          : type === 'spread' ? 'spread'
          : (type === 'over' || type === 'under') ? type : null;
        if (!pickType) { skipped++; continue; }
        if (!fullGameMarket(bpSport, p, pickType)) {
          skipped++;
          const k = `${bpSport} m${p.market_id} ${p.sub_label || '?'}`;
          refusedMarkets[k] = (refusedMarkets[k] || 0) + 1;
          continue;
        }

        const handle = String((p.user || {}).profile_url || '').replace(/\/+$/, '').split('/').pop();
        if (!handle) { skipped++; continue; }

        const isTotal = pickType === 'over' || pickType === 'under';
        const sel = p.selection || {};
        let side = null;
        if (!isTotal) {
          side = sideOf(game, sel.label) || sideOf(game, sel.short_label) || sideOf(game, sel.participant) || sideOf(game, p.label);
          if (!side) { skipped++; continue; }
        }
        const line = isTotal || pickType === 'spread' ? parseFloat((p.line || {}).line) : null;
        const units = ((p.risk || {}).units != null) ? parseFloat(p.risk.units) : null;
        if (minUnits && units != null && units < minUnits) { skipped++; continue; }

        const out = recordSourcePick({
          source: 'bettingpros',
          capperName: handle,
          handle,
          game,
          pickType,
          side,
          line: Number.isFinite(line) ? line : null,
          odds: sanePrice(p),
          trustPrice: false, // typed in by the bettor; the gate checks it against the board
          postedAtMs: bpTimeMs(p.created || p.published) || Date.now(),
          meta: {
            units,
            industry_expert: !!p.is_industry_expert,
            top_bettor: !!p.is_top_bettor,
            hot_streak: p.hot_streak || null,
          },
        });
        if (out === 'inserted') inserted++;
        else if (out === 'duplicate') dupes++;
      }
    }
  }
  if (inserted || dupes) console.log(`[bettingpros] poll: ${inserted} new picks, ${dupes} known, ${skipped} skipped (props/parlays/other markets/unmatched)`);
  const rk = Object.entries(refusedMarkets).sort((a, b) => b[1] - a[1]);
  if (rk.length) console.log(`[bettingpros] non-full-game markets refused: ${rk.slice(0, 12).map(([k, n]) => `${k} x${n}`).join(', ')}${rk.length > 12 ? ` (+${rk.length - 12} more)` : ''}`);
  return inserted;
}

module.exports = { pollBettingPros, apiKey, sanePrice, fullGameMarket, keyFromChunk };

// CLI: node src/bettingpros.js
if (require.main === module) pollBettingPros().then(() => process.exit(0));
