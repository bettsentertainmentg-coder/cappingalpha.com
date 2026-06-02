// broadcasts.js — maps ESPN broadcaster names to a display structure for the
// "Where to Watch" panel. Pure lookup tables + one enrich function. No network calls.
//
// ESPN gives us the actual broadcaster (ESPN, TNT, Peacock, Prime Video, etc).
// ESPN does NOT tell us which live-TV bundles carry a channel, so NETWORK_BUNDLES
// is a small map we maintain. BRAND_DOMAINS feeds the logo CDN in the renderers.

// Broadcaster names that are standalone streaming apps (shown under "Stream",
// never get a bundle list — you watch them in their own app).
const STREAMING_APPS = new Set([
  'Peacock', 'Prime Video', 'Apple TV+', 'Apple TV', 'Max', 'ESPN+',
  'Paramount+', 'MLB.TV', 'NHL.TV', 'Disney+', 'Netflix',
]);

// TV network -> live-TV streaming bundles that carry it.
const NETWORK_BUNDLES = {
  ESPN:    ['YouTube TV', 'Hulu Live', 'Fubo', 'Sling Orange', 'DirecTV Stream'],
  ESPN2:   ['YouTube TV', 'Hulu Live', 'Fubo', 'Sling Orange', 'DirecTV Stream'],
  ESPNU:   ['YouTube TV', 'Hulu Live', 'Fubo', 'Sling Orange', 'DirecTV Stream'],
  ESPNEWS: ['YouTube TV', 'Hulu Live', 'Fubo', 'Sling Orange', 'DirecTV Stream'],
  ABC:     ['YouTube TV', 'Hulu Live', 'Fubo', 'DirecTV Stream'],
  TNT:     ['YouTube TV', 'Hulu Live', 'Sling', 'DirecTV Stream'],
  TBS:     ['YouTube TV', 'Hulu Live', 'Sling', 'DirecTV Stream'],
  truTV:   ['YouTube TV', 'Hulu Live', 'Sling', 'DirecTV Stream'],
  FOX:     ['YouTube TV', 'Hulu Live', 'Fubo', 'Sling Blue', 'DirecTV Stream'],
  FS1:     ['YouTube TV', 'Hulu Live', 'Fubo', 'Sling Blue', 'DirecTV Stream'],
  FS2:     ['YouTube TV', 'Hulu Live', 'Fubo', 'DirecTV Stream'],
  NBC:     ['YouTube TV', 'Hulu Live', 'Fubo', 'DirecTV Stream'],
  NBCSN:   ['YouTube TV', 'Hulu Live', 'Fubo', 'DirecTV Stream'],
  USA:     ['YouTube TV', 'Hulu Live', 'Fubo', 'Sling Blue', 'DirecTV Stream'],
  CBS:     ['YouTube TV', 'Hulu Live', 'Fubo', 'Paramount+'],
  CBSSN:   ['YouTube TV', 'Hulu Live', 'Fubo', 'Paramount+'],
  'MLB Network': ['YouTube TV', 'Fubo', 'DirecTV Stream'],
  'NBA TV':      ['YouTube TV', 'Sling', 'DirecTV Stream'],
  'NHL Network': ['YouTube TV', 'Fubo', 'DirecTV Stream'],
};

// Brand -> domain, used to build a logo URL (logo.clearbit.com/<domain>) in the renderer.
const BRAND_DOMAINS = {
  ESPN: 'espn.com', ESPN2: 'espn.com', ESPNU: 'espn.com', ESPNEWS: 'espn.com', 'ESPN+': 'espn.com',
  ABC: 'abc.com',
  TNT: 'tntdrama.com', TBS: 'tbs.com', truTV: 'trutv.com',
  FOX: 'fox.com', FS1: 'foxsports.com', FS2: 'foxsports.com',
  NBC: 'nbc.com', NBCSN: 'nbcsports.com', USA: 'usanetwork.com', Peacock: 'peacocktv.com',
  CBS: 'cbs.com', CBSSN: 'cbssports.com', 'Paramount+': 'paramountplus.com',
  'Prime Video': 'primevideo.com', 'Apple TV+': 'tv.apple.com', 'Apple TV': 'tv.apple.com',
  Max: 'max.com', 'Disney+': 'disneyplus.com', Netflix: 'netflix.com',
  'MLB Network': 'mlb.com', 'MLB.TV': 'mlb.com',
  'NBA TV': 'nba.com',
  'NHL Network': 'nhl.com', 'NHL.TV': 'nhl.com',
  // Live-TV bundles
  'YouTube TV': 'tv.youtube.com', 'Hulu Live': 'hulu.com', Fubo: 'fubo.tv',
  Sling: 'sling.com', 'Sling Orange': 'sling.com', 'Sling Blue': 'sling.com',
  'DirecTV Stream': 'directv.com',
};

// Normalize ESPN's various shortName spellings to our canonical keys.
function normalizeName(raw) {
  if (!raw) return null;
  let n = String(raw).trim();
  const lower = n.toLowerCase();
  if (lower === 'amazon prime video' || lower === 'amazon' || lower === 'prime') return 'Prime Video';
  if (lower === 'apple tv' || lower === 'appletv') return 'Apple TV+';
  if (lower === 'hbo max' || lower === 'max') return 'Max';
  if (lower === 'tru tv') return 'truTV';
  if (lower === 'nbc sports') return 'NBCSN';
  return n;
}

const toEntry = name => ({ name, domain: BRAND_DOMAINS[name] || null });

// names: array of raw ESPN broadcaster name strings.
// Returns { tv:[{name,domain}], streaming:[...], bundles:[...] } (empty arrays omitted by callers).
function enrichBroadcasts(names) {
  const tv = [];
  const streaming = [];
  const bundleSet = new Set();
  const seen = new Set();

  for (const raw of names || []) {
    const name = normalizeName(raw);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    if (STREAMING_APPS.has(name)) {
      streaming.push(toEntry(name));
    } else {
      tv.push(toEntry(name));
      for (const b of NETWORK_BUNDLES[name] || []) bundleSet.add(b);
    }
  }

  const bundles = [...bundleSet].sort().map(toEntry);
  return { tv, streaming, bundles };
}

module.exports = { enrichBroadcasts, STREAMING_APPS, NETWORK_BUNDLES, BRAND_DOMAINS };
