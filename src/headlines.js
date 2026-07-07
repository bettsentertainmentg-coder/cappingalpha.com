// src/headlines.js
// Fetches sports betting headlines from Google News RSS, Reddit r/sportsbook, ESPN.
// Returns top 20 items: real articles first (by date), Reddit appended after.
// In-memory cache TTL: 30 minutes.

const axios = require('axios');

let _cache    = null;
let _cacheAt  = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;

function _decodeEntities(str) {
  return str
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

// ── Google News RSS ───────────────────────────────────────────────────────────
// Accepts a search query so the per-sport pages can reuse the same fetcher +
// parser. Default query keeps getHeadlines() behavior identical (same URL).
function _newsUrl(query) {
  const q = String(query || '').trim().split(/\s+/).map(encodeURIComponent).join('+');
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

async function _fetchGoogleNews(query = 'sports betting') {
  try {
    const url  = _newsUrl(query);
    const resp = await axios.get(url, { timeout: 8000 });
    const xml  = resp.data || '';
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const block    = m[1];
      const rawTitle = (/<title>([\s\S]*?)<\/title>/.exec(block)  || [])[1] || '';
      const link     = (/<link>([\s\S]*?)<\/link>/.exec(block)    || [])[1]
                    || (/<guid[^>]*>([\s\S]*?)<\/guid>/.exec(block)|| [])[1] || '';
      const pub      = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)|| [])[1] || '';
      // Google News includes publisher in <source> tag
      const sourceTag = (/<source[^>]*>([\s\S]*?)<\/source>/.exec(block) || [])[1] || '';
      if (!rawTitle || !link) continue;

      const decoded = _decodeEntities(rawTitle);

      // Extract actual source: prefer <source> tag, fall back to "Title - Source" suffix
      let source = _decodeEntities(sourceTag).trim();
      let title  = decoded;
      if (!source) {
        const parts = decoded.split(' - ');
        if (parts.length >= 2) {
          source = parts.pop().trim();
          title  = parts.join(' - ').trim();
        } else {
          source = 'News';
        }
      } else {
        // Strip the trailing " - Source" from title if present
        const suffix = ' - ' + source;
        if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
      }

      items.push({
        title,
        url:         link.trim(),
        source,
        publishedAt: pub ? new Date(pub).toISOString() : new Date().toISOString(),
      });
    }
    return items.slice(0, 15);
  } catch (err) {
    console.warn('[headlines] Google News fetch failed:', err.message);
    return [];
  }
}

// ── Reddit r/sportsbook top posts ─────────────────────────────────────────────
async function _fetchReddit() {
  try {
    const url  = 'https://www.reddit.com/r/sportsbook/top.json?t=day&limit=10';
    const resp = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'CappingAlpha/1.0 (sports betting research)' },
    });
    const children = resp.data?.data?.children || [];
    return children.map(c => ({
      title:       c.data.title,
      url:         c.data.url,
      source:      'Reddit',
      publishedAt: new Date(c.data.created_utc * 1000).toISOString(),
    })).filter(h => h.title && h.url);
  } catch (err) {
    console.warn('[headlines] Reddit fetch failed:', err.message);
    return [];
  }
}

// ── ESPN sports news ──────────────────────────────────────────────────────────
async function _fetchEspn() {
  try {
    const url  = 'https://site.api.espn.com/apis/site/v2/sports/news?limit=10';
    const resp = await axios.get(url, { timeout: 8000 });
    const articles = resp.data?.articles || [];
    return articles
      .map(a => ({
        title:       a.headline || a.title || '',
        url:         a.links?.web?.href || a.links?.api?.news?.href || '',
        source:      'ESPN',
        publishedAt: a.published ? new Date(a.published).toISOString() : new Date().toISOString(),
      }))
      .filter(a => a.title && a.url);
  } catch (err) {
    console.warn('[headlines] ESPN fetch failed:', err.message);
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
async function getHeadlines() {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;

  const [google, reddit, espn] = await Promise.all([
    _fetchGoogleNews(),
    _fetchReddit(),
    _fetchEspn(),
  ]);

  // Real articles first (Google News sources + ESPN), sorted by date, then Reddit
  const real = [...google, ...espn]
    .filter(h => h.title && h.url)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 15);

  const redditItems = reddit
    .filter(h => h.title && h.url)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 5);

  const merged = [...real, ...redditItems].slice(0, 20);

  _cache   = merged;
  _cacheAt = Date.now();
  return merged;
}

// ── Per-sport headlines (sport landing pages) ─────────────────────────────────
// Google News only (Reddit/ESPN feeds aren't sport-filterable), parsed by the
// same fetcher. Cached per sport label for 30 minutes.
const SPORT_NEWS_QUERY = {
  'MLB':       'MLB betting news',
  'NBA':       'NBA betting news',
  'WNBA':      'WNBA betting news',
  'NFL':       'NFL betting news',
  'NHL':       'NHL betting news',
  'NCAAF':     'college football betting news',
  'CBB':       'college basketball betting news',
  'Tennis':    'tennis betting news',
  'Golf':      'golf betting news',
  'Soccer':    'soccer betting news',
  'UFC / MMA': 'UFC betting news',
};

const _sportCache = new Map(); // sport label -> { at, items }
const SPORT_CACHE_TTL_MS = 30 * 60 * 1000;

async function getSportHeadlines(sportLabel) {
  const key = String(sportLabel || '').trim();
  const hit = _sportCache.get(key);
  if (hit && Date.now() - hit.at < SPORT_CACHE_TTL_MS) return hit.items;

  const query = SPORT_NEWS_QUERY[key] || `${key} betting news`;
  const items = (await _fetchGoogleNews(query))
    .filter(h => h.title && h.url)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 10);

  _sportCache.set(key, { at: Date.now(), items });
  return items;
}

module.exports = { getHeadlines, getSportHeadlines };
