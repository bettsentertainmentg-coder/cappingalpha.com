// src/wagertalk.js
// WagerTalk free-picks tracker (wave-1 pattern, structured HTML, no AI).
// wagertalk.com/free-sports-picks server-renders every current free play as a
// "pro-card": capper profile slug + display name, sport label, event line
// ("(613) Connecticut Sun at (614) Washington Mystics: Spread"), event start
// time, and the play text ("Connecticut Sun +6.5 (-110)"). These are pregame
// posts from named professional handicappers, so a matched pick lands in
// capper_history AND boards through the normal source gates. Futures and props
// ("NFL Season Wins") have no " at " matchup and no today_games row — skipped.
// The page holds a handful of plays a day (more in football season); one fetch
// per sweep, every 30 min active hours.

const https = require('https');
const db = require('./db');
const { recordSourcePick, findGameByTeams, sideOf } = require('./source_ingest');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
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

// WagerTalk sport label -> ours. Unmapped labels (CFL, KBO, MMA, horse racing)
// return null and the card is skipped.
function wtSport(label) {
  const t = (label || '').toLowerCase();
  if (t.includes('nfl')) return 'NFL';
  if (t.includes('college football')) return 'NCAAF';
  if (t.includes('college basketball') || t.includes('ncaab')) return 'CBB';
  if (t.includes('wnba')) return 'WNBA';
  if (t.includes('nba')) return 'NBA';
  if (t.includes('baseball') && !t.includes('korean') && !t.includes('kbo')) return 'MLB';
  if (t.includes('nhl') || t.includes('hockey')) return 'NHL';
  if (t.includes('tennis')) return 'Tennis';
  if (/soccer|premier|bundesliga|la liga|serie a|ligue|ucl|champions|europa|mls/.test(t)) return 'Soccer';
  return null;
}

// "(613) Connecticut Sun at (614) Washington Mystics: Spread" ->
// { teamA, teamB, market }. Rotation numbers stripped; market is the suffix
// after the last colon when present (Spread / Moneyline / Total ...).
function parseEvent(event) {
  let t = (event || '').replace(/\(\d+\)\s*/g, '').replace(/\s+/g, ' ').trim();
  let market = null;
  const ci = t.lastIndexOf(':');
  if (ci > 0) { market = t.slice(ci + 1).trim().toLowerCase(); t = t.slice(0, ci).trim(); }
  const m = t.split(/\s+at\s+|\s+vs\.?\s+/i);
  if (m.length !== 2) return null;
  return { teamA: m[0].trim(), teamB: m[1].trim(), market };
}

// "Connecticut Sun +6.5 (-110)" / "Over 8.5 (-115)" / "Yankees (-135)".
// The event's market suffix disambiguates a bare "+150"-style number when the
// play line omits parens juice.
function parsePlay(play, market) {
  const t = (play || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  let m = t.match(/^(over|under)\s+([\d.]+)\s*(?:\(([+-]\d{2,4})\))?$/i);
  if (m) return { pickType: m[1].toLowerCase(), picked: null, line: parseFloat(m[2]), odds: m[3] ? parseInt(m[3], 10) : null };
  m = t.match(/^(.+?)\s+(ML|moneyline)\s*(?:\(([+-]\d{2,4})\))?$/i);
  if (m) return { pickType: 'ml', picked: m[1].trim(), line: null, odds: m[3] ? parseInt(m[3], 10) : null };
  m = t.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*(?:\(([+-]\d{2,4})\))?$/);
  if (m) {
    const n = parseFloat(m[2]);
    const juice = m[3] ? parseInt(m[3], 10) : null;
    const isMl = (market && market.includes('money')) || (juice == null && Math.abs(n) >= 100 && Number.isInteger(n));
    if (isMl) return { pickType: 'ml', picked: m[1].trim(), line: null, odds: juice ?? n };
    return { pickType: 'spread', picked: m[1].trim(), line: n, odds: juice };
  }
  m = t.match(/^(.+?)\s*\(([+-]\d{2,4})\)$/);
  if (m) return { pickType: 'ml', picked: m[1].trim(), line: null, odds: parseInt(m[2], 10) };
  return null;
}

function parseCards(html) {
  const out = [];
  for (const c of (html || '').split('<div class="pro-card').slice(1)) {
    const card = c.slice(0, 6000);
    const slug = (card.match(/\/profile\/([a-z0-9-]+)/) || [])[1];
    const name = (card.match(/me-2">([^<]+)<\/a>/) || [])[1];
    const sport = (card.match(/sport-type-text"[^>]*>([^<]+)<\/a>/) || [])[1];
    const event = (card.match(/content-event"[^>]*>([^<]+)</) || [])[1];
    const play = (card.match(/content-play"[^>]*>([^<]+)</) || [])[1];
    if (!slug || !name || !play) continue;
    out.push({ slug, name: name.trim(), sportText: (sport || '').trim(), event: (event || '').trim(), play: play.trim() });
  }
  return out;
}

async function pollWagerTalk() {
  if (db.getSetting('wagertalk_scrape_enabled', '1') !== '1') return 0;
  const res = await get('https://www.wagertalk.com/free-sports-picks');
  if (res.status !== 200 || !res.body) { console.warn('[wagertalk] fetch failed:', res.status); return 0; }

  let inserted = 0, dupes = 0;
  for (const card of parseCards(res.body)) {
    const sport = wtSport(card.sportText);
    if (!sport) continue;
    const ev = parseEvent(card.event);
    if (!ev) continue; // futures/props carry no matchup
    const pick = parsePlay(card.play, ev.market);
    if (!pick) continue;
    const game = findGameByTeams(ev.teamA, ev.teamB, sport);
    if (!game) continue;
    const isTotal = pick.pickType === 'over' || pick.pickType === 'under';
    const side = isTotal ? null : sideOf(game, pick.picked);
    if (!isTotal && !side) continue;
    const r = recordSourcePick({
      source: 'wagertalk',
      capperName: card.name,
      handle: card.slug,
      game,
      pickType: pick.pickType,
      side,
      line: pick.line,
      odds: pick.odds,
      postedAtMs: Date.now(), // observed on the free page — pregame while listed pre-start
      meta: { event: card.event, play: card.play },
    });
    if (r === 'inserted') inserted++;
    else if (r === 'duplicate') dupes++;
  }
  if (inserted) console.log(`[wagertalk] poll: ${inserted} new picks (${dupes} known)`);
  return inserted;
}

module.exports = { pollWagerTalk };
