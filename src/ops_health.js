// src/ops_health.js — service heartbeats + the data-source health snapshot
// behind /admin/health. Answers one question fast: is anything quietly dead?
//
// Two kinds of signal:
//   1. Heartbeats — Mac-side services (odds engine, pb-relay) POST one per
//      cycle via /admin/ingest-heartbeat. Missing beats mean the Mac process
//      is down, the Mac is off, or its network path to the site is broken.
//   2. Freshness — MAX(timestamp) per data table the crons/relays feed. Stale
//      rows mean the source's fetch is failing even if the process is alive.

const db = require('./db');

function recordHeartbeat(service, meta) {
  const name = String(service || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  if (!name) return false;
  db.prepare(`
    INSERT INTO service_heartbeats (service, last_seen, meta_json)
    VALUES (?, datetime('now'), ?)
    ON CONFLICT(service) DO UPDATE SET last_seen = datetime('now'), meta_json = excluded.meta_json
  `).run(name, JSON.stringify(meta || {}).slice(0, 4000));
  return true;
}

const q = (sql, ...args) => { try { return db.prepare(sql).get(...args); } catch (_) { return null; } };
const qa = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch (_) { return []; } };

// Minutes since a stored UTC datetime string ("YYYY-MM-DD HH:MM:SS"); null when absent.
function ageMin(t) {
  if (!t) return null;
  const ms = Date.parse(String(t).replace(' ', 'T') + (String(t).includes('Z') ? '' : 'Z'));
  return isNaN(ms) ? null : Math.round((Date.now() - ms) / 60000);
}

// One row per data source: what fed it last, how old that is, and what cadence
// is normal. `expectMin` is the yellow line; 3x that is the red line. Sources
// with expectMin null are informational only (on-demand or event-driven).
function getHealthSnapshot() {
  const sources = [];
  const add = (name, lastAt, detail, expectMin, hint) => {
    const age = ageMin(lastAt);
    let status = 'ok';
    if (expectMin != null) {
      if (age == null) status = 'never';
      else if (age > expectMin * 3) status = 'red';
      else if (age > expectMin) status = 'yellow';
    } else if (age == null) status = 'never';
    sources.push({ name, lastAt: lastAt || null, ageMin: age, detail, expectMin, status, hint });
  };

  const bl = q(`SELECT MAX(updated_at) t, COUNT(DISTINCT book) books, COUNT(*) n FROM book_lines`);
  add('Book lines (all books)', bl && bl.t, bl ? `${bl.books} book(s), ${bl.n} rows` : '', 240,
    'Fed by the odds engine, the ESPN DK refresh, and the 5am/4pm Odds API crons.');
  for (const r of qa(`SELECT book, MAX(updated_at) t, COUNT(*) n FROM book_lines GROUP BY book ORDER BY book`)) {
    add(`  book: ${r.book}`, r.t, `${r.n} games`, r.book === 'draftkings' ? 240 : 30,
      r.book === 'draftkings' || r.book === 'fanduel'
        ? 'ESPN refresh (3h) or Odds API (5am/4pm). Odds engine also updates draftkings when its adapter is on.'
        : 'Odds engine adapter. If stale: pm2 logs odds-engine on the Mac.');
  }
  const pb = q(`SELECT MAX(fetched_at) t, COUNT(*) n FROM public_betting`);
  add('Public betting %', pb && pb.t, pb ? `${pb.n} rows` : '', 120,
    'pb-relay on the Mac (hourly) or the on-site scraper. If stale: pm2 logs pb-relay.');
  const lh = q(`SELECT MAX(recorded_at) t, COUNT(*) n FROM line_history`);
  add('Line history (ESPN)', lh && lh.t, lh ? `${lh.n} points today` : '', 60,
    'Free ESPN internal odds sync (15-min cron on the server).');
  const pm = q(`SELECT MAX(updated_at) t, COUNT(*) n FROM polymarket_cache`);
  add('Polymarket', pm && pm.t, pm ? `${pm.n} games cached` : '', 60,
    'Free sync in the 15-min cron. If stale: check server logs for [polymarket].');
  const ka = q(`SELECT MAX(updated_at) t, COUNT(*) n FROM kalshi_cache`);
  add('Kalshi', ka && ka.t, ka ? `${ka.n} games cached` : '', 60,
    'Free sync in the 15-min cron. If stale: check server logs for [kalshi].');
  const es = q(`SELECT MAX(updated_at) t, COUNT(*) n FROM esports_markets`);
  add('Esports markets', es && es.t, es ? `${es.n} rows` : '', 240,
    'Kalshi + Polymarket esports scraper (esports_markets.js).');
  const tg = q(`SELECT MAX(odds_updated_at) t, COUNT(*) n FROM today_games`);
  add('Odds API consensus', tg && tg.t, tg ? `${tg.n} games on the board` : '', 780,
    'Refreshes at 5am and 4pm ET only, by design (free credit budget). Stale overnight is normal.');
  const rm = q(`SELECT MAX(saved_at) t, COUNT(*) n FROM raw_messages`);
  add('Discord scanner', rm && rm.t, rm ? `${rm.n} messages this cycle` : '', null,
    'Event-driven; quiet stretches are normal when cappers are not posting. Prod only.');
  const rc = q(`SELECT created_at t, path, error FROM reader_call_log ORDER BY id DESC LIMIT 1`);
  add('Pick reader', rc && rc.t, rc ? `last path: ${rc.path}${rc.error ? ' (error: ' + String(rc.error).slice(0, 60) + ')' : ''}` : '', null,
    'Only runs when a message needs extracting. Errors here mean reader trouble, not volume.');
  const au = q(`SELECT ROUND(SUM(estimated_cost_usd), 4) c, COUNT(*) n FROM api_usage WHERE created_at >= date('now')`);
  add('Haiku spend today', null, au && au.n ? `$${au.c} across ${au.n} calls` : 'no calls today', null,
    'The one paid path (Discord reader fallback). Watch for surprises.');

  const beats = qa(`SELECT service, last_seen, meta_json FROM service_heartbeats ORDER BY service`).map(b => {
    let meta = {};
    try { meta = JSON.parse(b.meta_json || '{}'); } catch (_) {}
    const age = ageMin(b.last_seen);
    const expect = meta.interval_min || 60;
    return {
      service: b.service, lastSeen: b.last_seen, ageMin: age, meta,
      status: age == null ? 'never' : age > expect * 3 ? 'red' : age > expect * 1.5 ? 'yellow' : 'ok',
    };
  });

  return { sources, heartbeats: beats, generatedAt: new Date().toISOString() };
}

module.exports = { recordHeartbeat, getHealthSnapshot };
