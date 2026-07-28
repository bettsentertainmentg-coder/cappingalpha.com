// src/cappertek.js
// CapperTek tracker (wave-1 pattern, structured HTML, no AI).
// Roster: leaderboard.asp is server-rendered with every handicapper active in
// the last 30 days (~200+) — handle, pick volume, avg odds, W-L-P, units, ROI.
// Picks: xAjaxPicksTabLastPicks.asp?shs=<handle> returns each capper's latest
// picks with sport, matchup, game date, side, line and juice in deterministic
// markup. THE CATCH (verified 2026-07-16): the free tier masks a pick's side
// until 30 MINUTES AFTER the game starts, so a revealed pick is almost always
// in-game by the time we can read it — recordSourcePick flags it live and it
// builds the capper's graded record WITHOUT ever earning board points. The rare
// pick a capper gives away free pregame arrives unmasked early and boards
// through the normal source gates on its own. Site-graded results/units ride
// along as display-only meta; results.js grades everything against ESPN finals.
// Cadence: roster at startup + 5:05am; picks every 30 min active hours.

const https = require('https');
const db = require('./db');
const { recordSourcePick, findGameByTeams, sideOf } = require('./source_ingest');
const { ensureRegistered } = require('./storage');

const BASE = 'https://www.cappertek.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-Requested-With': 'XMLHttpRequest',
};

function get(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: HEADERS, timeout: 15000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; if (b.length > 3_000_000) res.destroy(); });
      res.on('end', () => finish({ status: res.statusCode, body: b }));
      res.on('close', () => finish({ status: res.statusCode, body: b }));
    });
    req.on('error', () => finish({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); finish({ status: 0, body: '' }); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CapperTek sport label -> ours. NCAAB is their college-hoops label; their NBA
// bucket can carry WNBA matchups, so the NBA path falls back to a WNBA match.
// Golf/MMA/Boxing/Other have no full-game pipeline here — skipped.
const CT_SPORT = {
  MLB: 'MLB', NBA: 'NBA', NFL: 'NFL', NCAAF: 'NCAAF', NCAAB: 'CBB',
  NHL: 'NHL', SOCCER: 'Soccer',
};

// ── Roster: leaderboard.asp (30-day active handicappers) ─────────────────────
// Row shape (tags vary, cells stable): a picks.asp?shs=<handle> link followed by
// pick count, avg odds, "W-L-P (pct%)", units, roi%.
async function refreshCappertekRoster() {
  if (db.getSetting('cappertek_scrape_enabled', '1') !== '1') return 0;
  const res = await get(`${BASE}/leaderboard.asp`);
  if (res.status !== 200 || !res.body) { console.warn('[cappertek] leaderboard fetch failed:', res.status); return 0; }

  const roster = [];
  const seen = new Set();
  // Split at each profile link; the stat cells for that capper follow before the next link.
  const parts = res.body.split(/href="picks\.asp\?shs=/).slice(1);
  for (const part of parts) {
    const handle = decodeURIComponent((part.match(/^([^"&]+)"/) || [])[1] || '').trim();
    if (!handle || seen.has(handle)) continue;
    const text = part.slice(0, 6000).replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    const m = text.match(/(\d+)\s+([+-]\d+)\s+(\d+)-(\d+)-(\d+)\s*\((\d+(?:\.\d+)?)%\)\s+([+-][\d.]+)\s+([+-][\d.]+)%/);
    if (!m) continue; // nav/footer links carry no stat run
    seen.add(handle);
    roster.push({
      handle,
      picks30: parseInt(m[1], 10),
      avg_odds: parseInt(m[2], 10),
      w: parseInt(m[3], 10), l: parseInt(m[4], 10), p: parseInt(m[5], 10),
      win_pct: parseFloat(m[6]),
      units: parseFloat(m[7]),
      roi: parseFloat(m[8]),
    });
  }
  if (!roster.length) { console.warn('[cappertek] leaderboard parsed 0 rows'); return 0; }

  db.setSetting('cappertek_cappers', JSON.stringify(roster.map(r => r.handle)));
  const upd = db.prepare(`UPDATE capper_source_handles SET meta_json = ? WHERE source = 'cappertek' AND handle = ?`);
  roster.forEach((r, i) => {
    ensureRegistered(r.handle, 'cappertek', r.handle);
    // Site-graded 30d record — display only, never scored (we grade every pick ourselves).
    try {
      upd.run(JSON.stringify({
        rank: i + 1, span: '30d', picks: r.picks30, avg_odds: r.avg_odds,
        record: `${r.w}-${r.l}-${r.p}`, win_pct: r.win_pct, units: r.units, roi: r.roi,
      }), r.handle);
    } catch (_) {}
  });
  console.log(`[cappertek] roster refresh: ${roster.length} handicappers`);
  return roster.length;
}

// ── Pick text parse ──────────────────────────────────────────────────────────
// Forms seen live: "TEXAS RANGERS (+112)" (ML), "BALTIMORE ORIOLES -1.5 (+131)"
// (spread), "UNDER 8.5 (-116)" / "OVER 2.5 (+133)" (total),
// "(MONEYLINE) MUCHOVA (-130)", "(SPREAD) SINNER -2.5 SETS (-173)" (tennis).
function parseCtPick(raw) {
  let t = (raw || '').replace(/\s+/g, ' ').trim();
  if (!t || /will be revealed/i.test(t)) return null;
  t = t.replace(/^\((MONEYLINE|SPREAD|TOTAL)\)\s*/i, '');
  let m = t.match(/^(OVER|UNDER)\s+([\d.]+)\s*\(([+-]\d{2,4})\)$/i);
  if (m) return { pickType: m[1].toLowerCase(), picked: null, line: parseFloat(m[2]), odds: parseInt(m[3], 10) };
  m = t.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)(?:\s+SETS?)?\s*\(([+-]\d{2,4})\)$/i);
  if (m) return { pickType: 'spread', picked: m[1].trim(), line: parseFloat(m[2]), odds: parseInt(m[3], 10) };
  m = t.match(/^(.+?)\s*\(([+-]\d{2,4})\)$/);
  if (m) return { pickType: 'ml', picked: m[1].trim(), line: null, odds: parseInt(m[2], 10) };
  return null;
}

// One feed row -> { sportLabel, matchup, dateText, ctResult, ctUnits, pickText }.
function parseFeedRows(html) {
  const out = [];
  for (const row of (html || '').split('<tr>').slice(1)) {
    const head = row.match(/<small[^>]*>\s*(?:&nbsp;)*([A-Z]+):(?:&nbsp;|\s)*([\s\S]*?)\s*\((\d{1,2}\/\d{1,2}\/\d{4})\)\s*<\/small>/);
    if (!head) continue;
    const badge = row.match(/class="badge bg-\w+"[^>]*>\s*([WLP])\s*</);
    const units = row.match(/<span class="text-(?:success|danger)"><strong>([+-][\d.]+)<\/strong><\/span>/);
    const pickM = row.match(/<strong><img[^>]*>\s*([^<]+?)\s*<\/strong>/);
    out.push({
      sportLabel: head[1].toUpperCase(),
      matchup: head[2].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(),
      dateText: head[3],
      ctResult: badge ? badge[1] : null,
      ctUnits: units ? parseFloat(units[1]) : null,
      pickText: pickM ? pickM[1] : null,
    });
  }
  return out;
}

// ET calendar date of a ms timestamp as M/D/YYYY (matches the feed's date text).
function etDate(ms) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(ms));
  const g = (t) => p.find(x => x.type === t).value;
  return `${g('month')}/${g('day')}/${g('year')}`;
}

// Tennis rows name the tournament, not both players — match by the picked
// player alone, tour-constrained; ambiguity (two same-named players) drops it.
function findTennisGame(playerName, tour) {
  const p = (playerName || '').toLowerCase().trim();
  if (!p) return null;
  const last = p.split(' ').pop();
  try {
    let sql = `SELECT * FROM today_games WHERE (LOWER(home_team) LIKE '%' || ? || '%' OR LOWER(away_team) LIKE '%' || ? || '%')`;
    const params = [last, last];
    if (tour === 'ATP' || tour === 'WTA') { sql += ` AND UPPER(sport) = ?`; params.push(tour); }
    else sql += ` AND UPPER(sport) IN ('ATP','WTA')`;
    const rows = db.prepare(sql).all(...params);
    return rows.length === 1 ? rows[0] : null;
  } catch (_) { return null; }
}

function gameForRow(row, pick) {
  if (row.sportLabel === 'TENNIS') {
    const tour = /\bWTA\b/i.test(row.matchup) ? 'WTA' : (/\bATP\b/i.test(row.matchup) ? 'ATP' : null);
    if (!pick.picked) return null; // tennis totals carry no player name to match on
    return findTennisGame(pick.picked, tour);
  }
  const sport = CT_SPORT[row.sportLabel];
  if (!sport) return null;
  const teams = row.matchup.split(/\s+VS\.?\s+/i);
  if (teams.length !== 2) return null;
  let game = findGameByTeams(teams[0], teams[1], sport);
  if (!game && sport === 'NBA') game = findGameByTeams(teams[0], teams[1], 'WNBA');
  return game;
}

// ── Picks sweep: per-capper latest-picks feed ────────────────────────────────
async function pollCappertekPicks() {
  if (db.getSetting('cappertek_scrape_enabled', '1') !== '1') return 0;
  let handles = [];
  try { handles = JSON.parse(db.getSetting('cappertek_cappers', '[]')); } catch (_) {}
  if (!handles.length) return 0;
  const cap = parseInt(db.getSetting('cappertek_max_cappers', '120'), 10);
  handles = handles.slice(0, cap);

  let fetched = 0, inserted = 0, dupes = 0;
  for (const handle of handles) {
    const res = await get(`${BASE}/xAjaxPicksTabLastPicks.asp?shs=${encodeURIComponent(handle)}`);
    await sleep(400);
    if (res.status !== 200 || !res.body) continue;
    fetched++;
    for (const row of parseFeedRows(res.body)) {
      const pick = parseCtPick(row.pickText);
      if (!pick) continue;
      const game = gameForRow(row, pick);
      if (!game) continue;
      // The feed keeps weeks of history and series rematch often — only the row
      // whose printed date matches this game's ET start date belongs to it.
      const startIso = (game.start_time || '').includes('T') ? game.start_time : (game.start_time || '').replace(' ', 'T') + 'Z';
      const startMs = new Date(startIso).getTime();
      if (!Number.isFinite(startMs) || row.dateText !== etDate(startMs)) continue;
      const isTotal = pick.pickType === 'over' || pick.pickType === 'under';
      const side = isTotal ? null : sideOf(game, pick.picked);
      if (!isTotal && !side) continue;
      const r = recordSourcePick({
        source: 'cappertek',
        capperName: handle,
        handle,
        game,
        pickType: pick.pickType,
        side,
        line: pick.line,
        odds: pick.odds,
        postedAtMs: Date.now(), // observed at reveal — in-game for masked picks, so record-only
        meta: { ct_result: row.ctResult, ct_units: row.ctUnits },
      });
      if (r === 'inserted') inserted++;
      else if (r === 'duplicate') dupes++;
    }
  }
  if (inserted) console.log(`[cappertek] poll: ${inserted} new picks (${dupes} known) from ${fetched} feeds`);
  return inserted;
}

module.exports = { refreshCappertekRoster, pollCappertekPicks };
