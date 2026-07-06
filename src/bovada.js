// src/bovada.js
// Free tennis lines from Bovada's public coupon API — game spread, total games,
// moneyline. The Odds API and ESPN carry NO tennis spreads/totals, so this is the
// only source. No auth, no API key, zero Odds API credits.
//
// Bovada geo/bot-blocks datacenter IPs (Railway gets nothing), so in production the
// lines are fetched on the Mac (residential IP) and relayed to Railway via
// POST /admin/ingest-tennis-lines, exactly like the public-betting relay. The split
// below keeps fetch (Mac) and store (Railway) separate so both paths share the parser:
//   - fetchBovadaTennisRaw()  — fetch + parse to orientation-agnostic events (no DB)
//   - storeTennisLines(events) — match to today_games + UPDATE (DB; runs on Railway)
//   - fetchTennisLines()       — fetch + store in one call (direct path; works locally)

const db = require('./db');

const BOVADA_TENNIS_URL =
  'https://www.bovada.lv/services/sports/event/coupon/events/A/description/tennis?marketFilterId=def&lang=en';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const lastNameOf = (name) =>
  (name || '').trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g, '');

const americanOf = (o) => {
  const a = parseFloat(o?.price?.american);
  return Number.isFinite(a) ? a : null;
};
const handicapOf = (o) => {
  const h = parseFloat(o?.price?.handicap);
  return Number.isFinite(h) ? h : null;
};

// ── Parse one Bovada event → orientation-agnostic line bundle ─────────────────
// Returns { players: [{ name, ml, spread }], over_under, ou_over_odds, ou_under_odds }
// Home/away is NOT assigned here — that happens in storeTennisLines against today_games.
function parseEvent(ev) {
  const markets = {}; // 'Game Spread' | 'Moneyline' | 'Total' -> outcomes[]
  for (const dg of ev.displayGroups || []) {
    if ((dg.description || '') !== 'Game Lines') continue;
    for (const m of dg.markets || []) {
      if ((m.period?.description || '') !== 'Match') continue; // skip per-set variants
      markets[m.description] = m.outcomes || [];
    }
  }

  const mlOutcomes = markets['Moneyline'] || [];
  if (mlOutcomes.length < 2) return null;

  const players = mlOutcomes.map(o => ({ name: o.description, ml: americanOf(o), spread: null }));

  for (const o of markets['Game Spread'] || []) {
    const p = players.find(p => lastNameOf(p.name) === lastNameOf(o.description));
    if (p) p.spread = handicapOf(o);
  }

  let over_under = null, ou_over_odds = null, ou_under_odds = null;
  for (const o of markets['Total'] || []) {
    const d = (o.description || '').toLowerCase();
    const line = handicapOf(o);
    if (line != null && over_under == null) over_under = line;
    if (d.startsWith('over'))  ou_over_odds  = americanOf(o);
    if (d.startsWith('under')) ou_under_odds = americanOf(o);
  }

  const usable = players.some(p => p.spread != null || p.ml != null) || over_under != null;
  if (!usable) return null;
  return { players, over_under, ou_over_odds, ou_under_odds };
}

// ── Fetch + parse Bovada tennis (no DB) — runs on the Mac relay ───────────────
async function fetchBovadaTennisRaw() {
  let groups;
  try {
    const r = await fetch(BOVADA_TENNIS_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) { console.warn(`[bovada] tennis fetch HTTP ${r.status}`); return []; }
    groups = await r.json();
  } catch (err) {
    console.warn('[bovada] tennis fetch failed:', err.message);
    return [];
  }
  if (!Array.isArray(groups)) return [];

  const events = [];
  for (const grp of groups) {
    for (const ev of grp.events || []) {
      const parsed = parseEvent(ev);
      if (parsed) events.push(parsed);
    }
  }
  return events;
}

// ── Match parsed events to today_games tennis rows + UPDATE — runs on Railway ──
function storeTennisLines(events) {
  if (!Array.isArray(events) || !events.length) return 0;

  const tennisGames = db.prepare(
    `SELECT espn_game_id, home_team, away_team FROM today_games WHERE sport IN ('ATP','WTA')`
  ).all();
  if (!tennisGames.length) return 0;

  const update = db.prepare(`
    UPDATE today_games SET
      ml_home       = COALESCE(?, ml_home),
      ml_away       = COALESCE(?, ml_away),
      spread_home   = COALESCE(?, spread_home),
      spread_away   = COALESCE(?, spread_away),
      over_under    = COALESCE(?, over_under),
      ou_over_odds  = COALESCE(?, ou_over_odds),
      ou_under_odds = COALESCE(?, ou_under_odds),
      odds_updated_at = datetime('now')
    WHERE espn_game_id = ? AND sport IN ('ATP','WTA')
  `);

  // Also record Bovada as a per-book row so the betslip's book picker and the
  // game-detail lines table show it. Tennis is not in the odds engine's sport
  // list, so without this the only per-book entry a tennis game ever gets is the
  // prediction-market implied line (which is why the confirm slide showed only
  // Polymarket). Same book_lines shape the odds engine uses.
  const upsertBook = db.prepare(`
    INSERT INTO book_lines
      (espn_game_id, book, ml_home, ml_away, spread_home, spread_away,
       over_under, ou_over_odds, ou_under_odds, updated_at)
    VALUES (?, 'bovada', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(espn_game_id, book) DO UPDATE SET
      ml_home       = COALESCE(excluded.ml_home, ml_home),
      ml_away       = COALESCE(excluded.ml_away, ml_away),
      spread_home   = COALESCE(excluded.spread_home, spread_home),
      spread_away   = COALESCE(excluded.spread_away, spread_away),
      over_under    = COALESCE(excluded.over_under, over_under),
      ou_over_odds  = COALESCE(excluded.ou_over_odds, ou_over_odds),
      ou_under_odds = COALESCE(excluded.ou_under_odds, ou_under_odds),
      updated_at    = datetime('now')
  `);

  let updated = 0;
  for (const ev of events) {
    const names = (ev.players || []).map(p => lastNameOf(p.name)).filter(Boolean);
    if (names.length < 2) continue;
    const nameSet = new Set(names);

    const game = tennisGames.find(g => {
      const h = lastNameOf(g.home_team), a = lastNameOf(g.away_team);
      return h && a && nameSet.has(h) && nameSet.has(a);
    });
    if (!game) continue;

    const homeP = ev.players.find(p => lastNameOf(p.name) === lastNameOf(game.home_team));
    const awayP = ev.players.find(p => lastNameOf(p.name) === lastNameOf(game.away_team));
    if (!homeP || !awayP) continue;
    if (homeP.spread == null && ev.over_under == null && homeP.ml == null) continue;

    update.run(
      homeP.ml, awayP.ml,
      homeP.spread, awayP.spread,
      ev.over_under, ev.ou_over_odds, ev.ou_under_odds,
      game.espn_game_id
    );
    try {
      upsertBook.run(
        game.espn_game_id,
        homeP.ml, awayP.ml,
        homeP.spread, awayP.spread,
        ev.over_under, ev.ou_over_odds, ev.ou_under_odds
      );
    } catch (_) { /* book_lines is best-effort; the today_games update is the source of truth */ }
    updated++;
  }

  if (updated > 0) console.log(`[bovada] tennis lines stored for ${updated} match(es)`);
  return updated;
}

// ── Direct fetch + store (works locally; on Railway the fetch returns [] when blocked) ─
async function fetchTennisLines() {
  const events = await fetchBovadaTennisRaw();
  return storeTennisLines(events);
}

module.exports = { fetchTennisLines, fetchBovadaTennisRaw, storeTennisLines };
