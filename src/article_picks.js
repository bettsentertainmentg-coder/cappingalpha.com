// src/article_picks.js
// Article-based pick sources (deterministic regex, no AI reader).
// Four sites publish free pregame picks as bylined articles, each in its own
// house format, all verified live 2026-08-26:
//   sportsbookwire  USA TODAY network. Sectioned article; the pick is the CAPS
//                   token with the price: "The value side here is TEXAS (+105)",
//                   "the OVER 8 (-105) is worth a partial-unit play", and a
//                   section with no play says "PASS".
//   thespread       WordPress REST. "The Pick: Orioles Run Line -1",
//                   "The Pick: Rangers Moneyline (+109)", "The Pick: Over 8".
//   sportsbettingdime  WordPress REST. "Pick: Dodgers Runline -1.5 (+115 at
//                   Caesars)", "My Best Bet: Yankees -1.5", "Total: Under 9
//                   runs at -127". Only ~3 of 8 posts a day carry a parseable
//                   game pick; the rest are props roundups.
//   sportsbookreview  A pick table: "Braves ML (+117 via bet365) 1u".
//
// Why regex and not the AI reader: these lines are formulaic, the reader costs
// real money per article on prod, and a mis-read pick corrupts a capper's
// permanent record. Every pattern here is strict and anything ambiguous is
// skipped — a missed pick is free, a wrong one is not.
//
// Player props are dropped everywhere (we cannot grade them against a game
// slot): any pick naming strikeouts, outs, hits, bases, RBIs or "to hit/score"
// is skipped.

const https = require('https');
const db = require('./db');
const { recordSourcePick, findGameByTeams, sideOf } = require('./source_ingest');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'text/html,application/json,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function get(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let u;
    try { u = new URL(url); } catch (_) { return finish({ status: 0, body: '' }); }
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: HEADERS, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(new URL(res.headers.location, url).toString()).then(finish);
      }
      let b = '';
      const end = () => finish({ status: res.statusCode, body: b });
      res.on('data', (c) => { b += c; if (b.length > 8_000_000) res.destroy(); });
      res.on('end', end);
      res.on('close', end);
    });
    req.on('error', () => finish({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); finish({ status: 0, body: '' }); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#8217;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function textOf(html) {
  let t = String(html || '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  return decode(t).replace(/\s+/g, ' ').trim();
}

// A pick mentioning any of these is a player prop, not a game slot.
const PROP_RE = /(strikeout|\bouts\b|\bhits\b|\brbi|bases|home run|to record|to score|receiving|rushing|passing|assists|rebounds|points\b|\bhr\b|anytime)/i;

// Sport is taken from the URL when the site puts it there; otherwise the
// matchup is tested against each candidate league and accepted ONLY if exactly
// one league has that pairing — a bare city pair ("Toronto vs Miami") exists in
// several leagues at once, and guessing is how picks land on the wrong game.
const CANDIDATE_SPORTS = ['MLB', 'NFL', 'NBA', 'WNBA', 'NHL', 'NCAAF', 'CBB', 'Soccer'];

function sportFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (/\/(mlb)\//.test(u)) return 'MLB';
  if (/\/(nfl)\//.test(u)) return 'NFL';
  if (/\/(nba)\//.test(u)) return 'NBA';
  if (/\/(wnba)\//.test(u)) return 'WNBA';
  if (/\/(nhl)\//.test(u)) return 'NHL';
  if (/(college-football|ncaaf|cfb)\//.test(u)) return 'NCAAF';
  if (/(college-basketball|ncaab|cbb)\//.test(u)) return 'CBB';
  if (/\/(soccer|mls|epl)\//.test(u)) return 'Soccer';
  return null;
}

// opts pins the game to the article's own date (see gameDateFrom). Without it a
// column stays in the sitemap for days and was re-filed onto every later game
// of the series: one Reds pick graded three times (THE SERIES GUARD).
function uniqueGame(teamA, teamB, sport, opts) {
  if (sport) return findGameByTeams(teamA, teamB, sport, opts);
  const hits = [];
  for (const s of CANDIDATE_SPORTS) {
    const g = findGameByTeams(teamA, teamB, s, opts);
    if (g) hits.push(g);
    if (hits.length > 1) return null; // ambiguous across leagues — never guess
  }
  return hits[0] || null;
}

// "Dodgers vs Braves Prediction, Picks for August 26" -> '2026-08-26'. The year
// comes from the publish time, and a date that is not within a day before to a
// week after publication is ignored (a stray "May 3" in prose, a look back).
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function gameDateFrom(str, publishedMs) {
  const s = String(str || '').toLowerCase();
  const m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (!m || !publishedMs) return null;
  const mo = MONTHS[m[1]];
  const day = parseInt(m[2], 10);
  if (!mo || day < 1 || day > 31) return null;
  let y = new Date(publishedMs).getUTCFullYear();
  let t = Date.UTC(y, mo - 1, day, 16);
  if (t - publishedMs > 180 * 864e5) { y -= 1; t = Date.UTC(y, mo - 1, day, 16); }
  else if (publishedMs - t > 180 * 864e5) { y += 1; t = Date.UTC(y, mo - 1, day, 16); }
  if (t < publishedMs - 36 * 3600e3 || t > publishedMs + 7 * 864e5) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// "…/rangers-at-white-sox-odds-picks-and-predictions/9145…" or
// "Dodgers vs Braves Prediction August 26: …" -> the two sides.
// A URL is reduced to its slug segment first; leaving the path in produced
// team names like "/ /mlb/dodgers".
const NOISE_RE = /\b(prediction|predictions|pick|picks|odds|betting|bets?|best|props?|preview|analysis|splits|today|and|for|the|vs|at|expert|experts|to|target|why|will|how|is|are|game|matchup|series|mlb|nfl|nba|nhl|wnba|ncaaf|cfb|ncaab|cbb|soccer|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/gi;

function matchupFrom(str) {
  let s = String(str || '').trim();
  if (/^https?:\/\//i.test(s) || s.startsWith('/')) {
    const segs = s.replace(/[?#].*$/, '').split('/').filter(Boolean);
    // Prefer the segment that actually carries the matchup separator.
    s = segs.reverse().find((x) => /-(vs|at)-/.test(x)) || '';
  }
  s = s.toLowerCase().replace(/\.html?$/, '').replace(/[:|–—].*$/, '');
  const parts = s.split(/\s+vs\.?\s+|\s+at\s+|-vs\.?-|-at-/);
  if (parts.length !== 2) return null;
  const clean = (x) => x
    .replace(/[-_]+/g, ' ')
    .replace(/\b\d{1,4}\b/g, ' ')
    .replace(NOISE_RE, ' ')
    .replace(/[^a-z .'&]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const trim = (x) => x.replace(/^[^a-z]+|[^a-z]+$/g, '').trim();
  const a = trim(clean(parts[0])), b = trim(clean(parts[1]));
  return (a && b && a.length > 2 && b.length > 2) ? { a, b } : null;
}

// ── Pick-line parsers, one per house style ──────────────────────────────────
// Each returns [{ pickType, picked, line, odds }]; strict by design.

function parseSportsbookWire(text) {
  const out = [];
  // Totals: "the OVER 8 (-105) is worth", "UNDER 9.5 (+100)"
  for (const m of text.matchAll(/\b(OVER|UNDER)\s+(\d+(?:\.\d+)?)\s*\(([+-]\d{2,4})\)/g)) {
    out.push({ pickType: m[1].toLowerCase(), picked: null, line: parseFloat(m[2]), odds: parseInt(m[3], 10) });
  }
  // Sides: a CAPS team token with a price — "The value side here is TEXAS (+105)"
  for (const m of text.matchAll(/\b([A-Z][A-Z .'&-]{2,24}?)\s*\(([+-]\d{2,4})\)/g)) {
    const name = m[1].trim();
    if (/^(OVER|UNDER|PASS|ET|PM|AM|MLB|NFL|NBA|NHL|WNBA|USA|TV|ESPN|FOX)$/.test(name)) continue;
    out.push({ pickType: 'ml', picked: name, line: null, odds: parseInt(m[2], 10) });
  }
  // Spreads written out: "TEXAS +1.5 (-120)"
  for (const m of text.matchAll(/\b([A-Z][A-Z .'&-]{2,24}?)\s+([+-]\d+(?:\.\d+)?)\s*\(([+-]\d{2,4})\)/g)) {
    out.push({ pickType: 'spread', picked: m[1].trim(), line: parseFloat(m[2]), odds: parseInt(m[3], 10) });
  }
  return out;
}

// Segment terminator note: these house styles put the price in parentheses and
// the LINE carries a decimal ("-1.5"), so a segment must never stop at a bare
// period — that silently turned every "Runline -1.5" into "-1". Stop at a
// sentence break (". ") or a run of whitespace instead.
function parseTheSpread(text) {
  const out = [];
  for (const m of text.matchAll(/The Pick:\s*(.{3,70}?)(?=\s{2,}|\.\s|\s+(?:The Pick|Final Thoughts|Bonus)|$)/g)) {
    const seg = m[1].trim();
    if (PROP_RE.test(seg)) continue;
    const odds = (seg.match(/\(([+-]\d{2,4})\)/) || [])[1];
    const o = odds ? parseInt(odds, 10) : null;
    let mm = seg.match(/^(Over|Under)\s+(\d+(?:\.\d+)?)/i);
    if (mm) { out.push({ pickType: mm[1].toLowerCase(), picked: null, line: parseFloat(mm[2]), odds: o }); continue; }
    mm = seg.match(/^(.+?)\s+(?:Run Line|Puck Line|Spread)\s*([+-]?\d+(?:\.\d+)?)/i);
    if (mm) { out.push({ pickType: 'spread', picked: mm[1].trim(), line: parseFloat(mm[2]), odds: o }); continue; }
    mm = seg.match(/^(.+?)\s+Moneyline/i);
    if (mm) { out.push({ pickType: 'ml', picked: mm[1].trim(), line: null, odds: o }); continue; }
    mm = seg.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*(?:\(|$)/);
    if (mm) out.push({ pickType: 'spread', picked: mm[1].trim(), line: parseFloat(mm[2]), odds: o });
  }
  return out;
}

function parseSbd(text) {
  const out = [];
  // "Pick: Dodgers Runline -1.5 (+115 at Caesars)" / "My Best Bet: Yankees -1.5"
  for (const m of text.matchAll(/(?:^|\s)(?:My\s+)?(?:Best\s+Bet|Pick|Spread Pick|Moneyline Pick)\s*:\s*(.{3,80}?)(?=\s{2,}|\.\s|$)/gi)) {
    const seg = m[1].trim();
    if (PROP_RE.test(seg)) continue;
    const odds = (seg.match(/\(([+-]\d{2,4})/) || [])[1];
    const o = odds ? parseInt(odds, 10) : null;
    let mm = seg.match(/^(Over|Under)\s+(\d+(?:\.\d+)?)/i);
    if (mm) { out.push({ pickType: mm[1].toLowerCase(), picked: null, line: parseFloat(mm[2]), odds: o }); continue; }
    mm = seg.match(/^(.+?)\s+(?:Runline|Run Line|Puck Line|Spread)\s*([+-]?\d+(?:\.\d+)?)/i);
    if (mm) { out.push({ pickType: 'spread', picked: mm[1].trim(), line: parseFloat(mm[2]), odds: o }); continue; }
    mm = seg.match(/^(.+?)\s+(?:ML|Moneyline)\b/i);
    if (mm) { out.push({ pickType: 'ml', picked: mm[1].trim(), line: null, odds: o }); continue; }
    mm = seg.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)/);
    if (mm) out.push({ pickType: 'spread', picked: mm[1].trim(), line: parseFloat(mm[2]), odds: o });
  }
  // "Total: Under 9 runs at -127 via bet365"
  for (const m of text.matchAll(/Total(?:\s+Pick)?\s*:\s*(Over|Under)\s+(\d+(?:\.\d+)?)[^.]{0,30}?(?:at\s*([+-]\d{2,4}))?/gi)) {
    out.push({ pickType: m[1].toLowerCase(), picked: null, line: parseFloat(m[2]), odds: m[3] ? parseInt(m[3], 10) : null });
  }
  return out;
}

function parseSbr(text) {
  const out = [];
  // Table rows: "Braves ML (+117 via bet365 ) 1u", "Pirates -1.5 (-105 via ...)"
  // The team is capped at three capitalised words; an open-ended run swallowed
  // the table header ("Pick Units Notes Braves").
  // Table furniture sits immediately before the first row ("Pick Units Notes
  // Braves ML …"), so strip those words off the front of a captured name.
  const HEADER_RE = /^(?:pick|units?|notes?|bet|odds|book|result|u)\s+/i;
  const tidy = (s) => { let t = String(s).trim(); while (HEADER_RE.test(t)) t = t.replace(HEADER_RE, '').trim(); return t; };
  for (const m of text.matchAll(/((?:[A-Z][A-Za-z.']+(?:\s|$)){1,3}?)\s*(ML|[+-]\d+(?:\.\d+)?)\s*\(([+-]\d{2,4})\s*via/g)) {
    const seg = m[0];
    if (PROP_RE.test(seg)) continue;
    const picked = tidy(m[1]);
    if (!picked) continue;
    if (m[2] === 'ML') out.push({ pickType: 'ml', picked, line: null, odds: parseInt(m[3], 10) });
    else out.push({ pickType: 'spread', picked, line: parseFloat(m[2]), odds: parseInt(m[3], 10) });
  }
  for (const m of text.matchAll(/\b(Over|Under)\s+(\d+(?:\.\d+)?)\s*\(([+-]\d{2,4})\s*via/gi)) {
    if (PROP_RE.test(m[0])) continue;
    out.push({ pickType: m[1].toLowerCase(), picked: null, line: parseFloat(m[2]), odds: parseInt(m[3], 10) });
  }
  return out;
}

// ── Article listers, one per site ───────────────────────────────────────────
async function listWordpress(base, categories, perPage) {
  const items = [];
  const cats = categories && categories.length ? categories : [null];
  const authors = new Map();
  const ures = await get(`${base}/wp-json/wp/v2/users?per_page=100&_fields=id,name,slug`);
  try { for (const u of JSON.parse(ures.body) || []) authors.set(u.id, { name: u.name, slug: u.slug }); } catch (_) {}
  for (const cat of cats) {
    const url = `${base}/wp-json/wp/v2/posts?per_page=${perPage}&_fields=id,date_gmt,link,title,author,content`
      + (cat ? `&categories=${cat}` : '');
    const res = await get(url);
    await sleep(200);
    let posts = [];
    try { posts = JSON.parse(res.body) || []; } catch (_) { continue; }
    if (!Array.isArray(posts)) continue;
    for (const p of posts) {
      const a = authors.get(p.author);
      items.push({
        url: p.link,
        title: decode((p.title || {}).rendered || ''),
        author: a ? a.name : null,
        handle: a ? a.slug : null,
        publishedMs: Date.parse((p.date_gmt || '') + 'Z'),
        text: textOf((p.content || {}).rendered || ''),
      });
    }
  }
  return items;
}

function jsonLdAuthor(html) {
  const m = String(html).match(/"author"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]{2,60})"/);
  const u = String(html).match(/"author"\s*:\s*\{[^}]*?"url"\s*:\s*"([^"]+)"/);
  const slug = u ? String(u[1]).replace(/\/+$/, '').split('/').pop() : null;
  return { name: m ? decode(m[1]) : null, handle: slug };
}
function jsonLdDate(html) {
  const m = String(html).match(/"datePublished"\s*:\s*"([^"]+)"/);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

async function listSportsbookWire() {
  const res = await get('https://sportsbookwire.usatoday.com/news-sitemap.xml');
  if (res.status !== 200) return [];
  const urls = [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  const picks = urls.filter((u) => /odds-picks-and-predictions/.test(u)).slice(0, 14);
  const out = [];
  for (const u of picks) {
    const a = await get(u);
    await sleep(250);
    if (a.status !== 200) continue;
    const who = jsonLdAuthor(a.body);
    out.push({ url: u, title: '', author: who.name, handle: who.handle, publishedMs: jsonLdDate(a.body), text: textOf(a.body) });
  }
  return out;
}

async function listSbr() {
  const out = [];
  for (const sport of ['mlb', 'nfl', 'wnba', 'nba', 'nhl']) {
    const idx = await get(`https://www.sportsbookreview.com/picks/${sport}/`);
    await sleep(200);
    if (idx.status !== 200) continue;
    const slugs = [...new Set([...idx.body.matchAll(/href="(\/picks\/[a-z]+\/[a-z0-9-]+-vs-[a-z0-9-]+-prediction[^"]*)"/g)].map((m) => m[1]))].slice(0, 6);
    for (const s of slugs) {
      const a = await get('https://www.sportsbookreview.com' + s);
      await sleep(250);
      if (a.status !== 200) continue;
      const who = jsonLdAuthor(a.body);
      out.push({ url: 'https://www.sportsbookreview.com' + s, title: '', author: who.name, handle: who.handle, publishedMs: jsonLdDate(a.body), text: textOf(a.body) });
    }
  }
  return out;
}

const SITES = [
  { source: 'sportsbookwire', list: listSportsbookWire, parse: parseSportsbookWire },
  { source: 'sportsbookreview', list: listSbr, parse: parseSbr },
  { source: 'thespread', list: () => listWordpress('https://www.thespread.com', [], 20), parse: parseTheSpread },
  {
    source: 'sportsbettingdime',
    // SportsBettingDime category ids (verified): mlb/nfl/nba/nhl/wnba/cfb.
    list: () => listWordpress('https://www.sportsbettingdime.com', [1119, 1121, 1120, 1199, 122531, 1116], 8),
    parse: parseSbd,
  },
];

async function pollArticlePicks() {
  if (db.getSetting('article_scrape_enabled', '1') !== '1') return 0;
  let total = 0;
  for (const site of SITES) {
    if (db.getSetting(`article_${site.source}_enabled`, '1') !== '1') continue;
    let items = [];
    try { items = await site.list(); } catch (err) { console.warn(`[${site.source}] list failed:`, err.message); continue; }
    let inserted = 0, dupes = 0;
    for (const it of items) {
      if (!it.author) continue; // no byline, no capper
      const mu = matchupFrom(it.title) || matchupFrom(it.url);
      if (!mu) continue;
      // The article's own date: a game date in the title or URL, else the first
      // game of the matchup after it was published. Never a later one.
      const startDate = gameDateFrom(it.title, it.publishedMs) || gameDateFrom(it.url, it.publishedMs);
      const dateOpts = startDate ? { startDate } : (it.publishedMs ? { firstAfterMs: it.publishedMs } : {});
      const game = uniqueGame(mu.a, mu.b, sportFromUrl(it.url),
        { ...dateOpts, source: site.source, capper: it.author, picked: `${mu.a} vs ${mu.b}` });
      if (!game) continue;
      let picks = [];
      try { picks = site.parse(it.text) || []; } catch (_) { continue; }
      // One pick per market kind per article: house style repeats the play in
      // the recap, and an alternate line mentioned in passing is not a second
      // opinion.
      const seen = new Set();
      for (const p of picks) {
        const isTotal = p.pickType === 'over' || p.pickType === 'under';
        const kind = isTotal ? 'total' : p.pickType;
        if (seen.has(kind)) continue;
        const side = isTotal ? null : sideOf(game, p.picked);
        if (!isTotal && !side) continue;
        seen.add(kind);
        const out = recordSourcePick({
          source: site.source,
          capperName: it.author,
          handle: it.handle || it.author,
          game,
          pickType: p.pickType,
          side,
          line: Number.isFinite(p.line) ? p.line : null,
          odds: Number.isFinite(p.odds) ? p.odds : null,
          postedAtMs: it.publishedMs || Date.now(),
          meta: { url: it.url },
        });
        if (out === 'inserted') inserted++;
        else if (out === 'duplicate') dupes++;
      }
    }
    total += inserted;
    if (inserted || dupes) console.log(`[${site.source}] poll: ${inserted} new picks, ${dupes} known from ${items.length} articles`);
  }
  return total;
}

module.exports = {
  pollArticlePicks, matchupFrom, uniqueGame, gameDateFrom,
  parseSportsbookWire, parseTheSpread, parseSbd, parseSbr,
};

// CLI: node src/article_picks.js
if (require.main === module) pollArticlePicks().then(() => process.exit(0));
