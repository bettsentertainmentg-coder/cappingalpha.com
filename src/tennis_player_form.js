// src/tennis_player_form.js
// Tennis (ATP/WTA) recent-match history for the game detail History tab.
// ESPN's athlete *gamelog* is empty for tennis, but the core API *eventlog* is
// populated. We resolve a player by name (ESPN search), pull their eventlog, and
// follow the $ref chain per match for opponent, set score, tournament + round.
// All free, no key, same vendor as the rest of the app. Do not touch espn_live.js.

const axios = require('axios');

const SEARCH_URL = 'https://site.web.api.espn.com/apis/search/v2';
const CORE = 'https://sports.core.api.espn.com/v2/sports/tennis/leagues';
const UA = { 'User-Agent': 'Mozilla/5.0' };

const FETCH_N = 12;   // eventlog items to detail (it is not strictly date-ordered)
const DISPLAY_N = 8;  // matches shown after sorting by date

// Player-id + history caches (recent matches change only when a player plays).
const _idCache = new Map();   // name → athleteId
const _histCache = new Map(); // `${tour}:${id}` → { ts, data }
const TTL_MS = 30 * 60 * 1000;

// Major-tournament → surface (falls back to indoor/outdoor hint).
const SURFACE = {
  // Grand Slams
  'roland garros': 'Clay', 'french open': 'Clay', 'wimbledon': 'Grass',
  'australian open': 'Hard', 'us open': 'Hard',
  // Clay
  'monte carlo': 'Clay', 'madrid': 'Clay', 'rome': 'Clay', 'italian open': 'Clay',
  'barcelona': 'Clay', 'hamburg': 'Clay', 'munich': 'Clay', 'stuttgart': 'Grass',
  'porsche': 'Clay', 'internazionali': 'Clay', 'mutua': 'Clay', 'estoril': 'Clay', 'geneva': 'Clay',
  // Grass
  'halle': 'Grass', "queen's": 'Grass', 'eastbourne': 'Grass', "'s-hertogenbosch": 'Grass',
  // Hard (incl. indoor)
  'indian wells': 'Hard', 'miami': 'Hard', 'qatar': 'Hard', 'doha': 'Hard', 'dubai': 'Hard',
  'cincinnati': 'Hard', 'canadian': 'Hard', 'toronto': 'Hard', 'montreal': 'Hard',
  'shanghai': 'Hard', 'beijing': 'Hard', 'tokyo': 'Hard', 'paris': 'Indoor hard',
  'bnp paribas open': 'Hard', 'western & southern': 'Hard', 'national bank open': 'Hard',
  'atp finals': 'Indoor hard', 'wta finals': 'Indoor hard', 'united cup': 'Hard',
};
function surfaceFor(name, indoor) {
  const n = (name || '').toLowerCase();
  for (const k in SURFACE) if (n.includes(k)) return SURFACE[k];
  return indoor ? 'Indoor' : null;
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function daysBetween(a, b) { return Math.floor(Math.abs(new Date(a) - new Date(b)) / 86400000); }
function bandFor(score) { return score < 30 ? 'fresh' : score < 55 ? 'moderate' : score < 78 ? 'heavy' : 'overworked'; }

async function getRef(url) {
  if (!url) return null;
  try {
    const r = await axios.get(url.replace(/^http:/, 'https:'), { timeout: 7000, headers: UA });
    return r.data;
  } catch (_) { return null; }
}

// ── Resolve a tennis player name → ESPN athlete id ────────────────────────────
async function resolveAthleteId(name) {
  if (!name) return null;
  if (_idCache.has(name)) return _idCache.get(name);
  let id = null;
  try {
    const r = await axios.get(SEARCH_URL, { params: { query: name, limit: 8 }, timeout: 7000, headers: UA });
    const hits = [];
    (function walk(o) {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') {
        if (o.sport === 'tennis' && typeof o.uid === 'string' && o.uid.includes('~a:')) hits.push(o);
        Object.values(o).forEach(walk);
      }
    })(r.data);
    const want = name.toLowerCase();
    const best = hits.find(h => (h.displayName || '').toLowerCase() === want)
              || hits.find(h => (h.displayName || '').toLowerCase().includes(want.split(' ').pop()))
              || hits[0];
    const m = best && String(best.uid).match(/~a:(\d+)/);
    if (m) id = m[1];
  } catch (_) {}
  if (id) _idCache.set(name, id);
  return id;
}

// ── Build the set score "6-4 7-5" from both competitors' linescores ───────────
function buildSetScore(myLs, opLs) {
  const a = (myLs && myLs.items) || [];
  const b = (opLs && opLs.items) || [];
  const n = Math.max(a.length, b.length);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const av = a[i] && a[i].value, bv = b[i] && b[i].value;
    if (av == null && bv == null) continue;
    parts.push(`${av != null ? av : 0}-${bv != null ? bv : 0}`);
  }
  return parts.join(' ');
}

// ── Parse one eventlog item (the match) into a row ────────────────────────────
async function parseMatch(item, athleteId, eventCache) {
  const comp = await getRef(item.competition && item.competition.$ref);
  if (!comp) return null;
  const cs = comp.competitors || [];
  const mine = cs.find(c => String(c.id) === String(athleteId));
  const opp  = cs.find(c => String(c.id) !== String(athleteId));
  if (!mine || !opp) return null;

  const round  = (comp.round && (comp.round.displayName || comp.round.description || comp.round.abbreviation)) || null;
  const indoor = comp.venue && comp.venue.indoor;
  const bestOf = (comp.format && comp.format.regulation && comp.format.regulation.periods === 5) ? 5 : 3;
  const result = mine.winner === true ? 'W' : mine.winner === false ? 'L' : null;

  // tournament name (dedupe identical event refs across a player's run)
  const evRef = item.event && item.event.$ref;
  let evP = eventCache.get(evRef);
  if (!evP) { evP = getRef(evRef); eventCache.set(evRef, evP); }

  const [oppAth, myLs, opLs, ev] = await Promise.all([
    getRef(opp.athlete && opp.athlete.$ref),
    getRef(mine.linescores && mine.linescores.$ref),
    getRef(opp.linescores && opp.linescores.$ref),
    evP,
  ]);

  const oppName = (oppAth && (oppAth.displayName || oppAth.shortName)) || null;
  if (!oppName || /^bye$/i.test(oppName)) return null; // skip byes / walkovers w/o opponent

  const setScore = buildSetScore(myLs, opLs);
  const tournament = (ev && (ev.name || ev.shortName)) || null;
  return {
    date: comp.date || null,
    opp: oppName,
    result,
    setScore,
    tournament,
    round,
    surface: surfaceFor(tournament, indoor),
    bestOf,
    setsPlayed: ((myLs && myLs.items) || []).length,
  };
}

// ── Form (recent W/L) + freshness (sets load + rest) ──────────────────────────
function buildForm(matches) {
  const played = matches.filter(m => m.result);
  const w = played.filter(m => m.result === 'W').length;
  const l = played.filter(m => m.result === 'L').length;
  const lastFive = played.slice(0, 5).map(m => m.result);
  const recentWins = lastFive.filter(r => r === 'W').length;
  const rate = lastFive.length ? recentWins / lastFive.length : 0;
  const bucket = lastFive.length < 3 ? 'na'
    : rate >= 0.8 ? 'hot' : rate >= 0.6 ? 'warm' : rate >= 0.4 ? 'neutral' : rate >= 0.2 ? 'cool' : 'cold';
  return { wins: w, losses: l, record: `${w}-${l}`, winPct: played.length ? Math.round(w / played.length * 100) : null, lastFive, bucket };
}

function buildFreshness(matches, gameDate) {
  const prior = matches.filter(m => m.date && (!gameDate || new Date(m.date) < new Date(gameDate)));
  if (!prior.length) return { score: 6, band: 'fresh', note: 'No recent matches' };
  const last = prior[0];
  const ref = gameDate ? new Date(gameDate) : new Date(last.date);
  const restDays = Math.max(0, daysBetween(ref, last.date) - 1);
  const within = prior.filter(m => (ref - new Date(m.date)) / 86400000 <= 12);
  const setsLoad = within.reduce((s, m) => s + (m.setsPlayed || 0), 0);
  const fAcute = clamp((setsLoad - 4) / (18 - 4), 0, 1);
  const fRest  = restDays === 0 ? 1.0 : restDays === 1 ? 0.55 : restDays === 2 ? 0.25 : 0;
  const fLast  = clamp(((last.setsPlayed || 0) - 2) / (5 - 2), 0, 1);
  const score = clamp(100 * (0.50 * fAcute + 0.35 * fRest + 0.15 * fLast), 0, 100);
  const note = restDays === 0 ? 'Played yesterday' : restDays >= 3 ? 'Well rested' : (setsLoad >= 12 ? 'Heavy recent load' : null);
  return { score: Math.round(score), band: bandFor(score), restDays, note };
}

// ── Public: a player's recent tennis history ──────────────────────────────────
async function getTennisHistory(playerName, sport, gameDate) {
  const tour = (sport || '').toUpperCase() === 'WTA' ? 'wta' : 'atp';
  const athleteId = await resolveAthleteId(playerName);
  if (!athleteId) return null;

  const key = `${tour}:${athleteId}`;
  const cached = _histCache.get(key);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return { ...cached.data, freshness: buildFreshness(cached.data.matches, gameDate) };
  }

  let items;
  try {
    const r = await axios.get(`${CORE}/${tour}/athletes/${athleteId}/eventlog`, { timeout: 7000, headers: UA });
    items = ((r.data && r.data.events && r.data.events.items) || []).filter(it => it.played);
  } catch (_) { return null; }
  if (!items.length) return null;

  // The eventlog is not reliably date-ordered, so detail a wider window then
  // sort by date and keep the most recent.
  const recent = items.slice(-FETCH_N);
  const eventCache = new Map();
  const matches = (await Promise.all(recent.map(it => parseMatch(it, athleteId, eventCache).catch(() => null))))
    .filter(Boolean)
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, DISPLAY_N);
  if (!matches.length) return null;

  const data = { sport: (sport || '').toUpperCase(), player: playerName, athleteId, matches, form: buildForm(matches) };
  _histCache.set(key, { ts: Date.now(), data });
  return { ...data, freshness: buildFreshness(matches, gameDate) };
}

module.exports = { getTennisHistory };
