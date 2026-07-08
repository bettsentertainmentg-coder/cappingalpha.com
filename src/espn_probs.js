// src/espn_probs.js
// ESPN core-API live probabilities: win prob PLUS live spread-cover probability
// and total-over probability per play. This is the data behind ESPN's own live
// cover-probability site, and it is free. Feeds the PAID pulse layer
// (/api/game/:id/live) — never exposed raw to free users.
//
// Verified (live WNBA game, 2026-07): items carry homeWinPercentage /
// awayWinPercentage / tiePercentage / spreadCoverProbHome / spreadPushProb /
// totalOverProb, ordered by sequenceNumber; limit=1000 returns every item in
// one page. NFL/NBA/WNBA verified rich; NCAAF/CBB are try-once with a dead
// flag; MLB carries win prob only (cover/total fields absent entirely);
// NHL/Soccer/Tennis 400 (skipped entirely).
//
// ZERO-FILL HAZARD (found 2026-07-07, WNBA): some games carry the cover/total
// FIELDS but every sample is a literal 0 — the model isn't running, the field
// is a placeholder. Field presence is NOT validity. A real pregame cover/over
// prob is never exactly 0 (a -3.5 favorite covers about half the time), so a
// zero FIRST sample marks that block fake; see the scrub in getCoreProbs.
// Without it the paid pulse layer showed 0%/100% cover reads.

const axios = require('axios');

// sports.core paths (NOTE: 'football', never 'americanfootball').
const CORE_PATH = {
  NFL:   'football/leagues/nfl',
  NCAAF: 'football/leagues/college-football',
  NBA:   'basketball/leagues/nba',
  WNBA:  'basketball/leagues/wnba',
  CBB:   'basketball/leagues/mens-college-basketball',
  MLB:   'baseball/leagues/mlb',
};

const TTL       = 25_000;
const _cache    = new Map();   // gameId -> { ts, data }
const _inflight = new Map();
const _dead     = new Set();   // `${sport}:${gameId}` that 400/404'd — never re-hit

function normItem(it) {
  if (!it) return null;
  const num = (v) => (typeof v === 'number' && !isNaN(v)) ? v : null;
  return {
    homeWin:         num(it.homeWinPercentage),
    tie:             num(it.tiePercentage),
    spreadCoverHome: num(it.spreadCoverProbHome),
    spreadPush:      num(it.spreadPushProb),
    totalOver:       num(it.totalOverProb),
    totalPush:       num(it.totalPushProb),
    secondsLeft:     num(it.secondsLeft),
    seq:             Number(it.sequenceNumber) || 0,
  };
}

// -> { first, latest } (each normItem) | null. first anchors spread/total pulses
// at their pre-game cover/over probability; latest drives the live value.
async function getCoreProbs(sport, gameId) {
  const sp = String(sport || '').toUpperCase();
  const path = CORE_PATH[sp];
  const deadKey = `${sp}:${gameId}`;
  if (!path || _dead.has(deadKey)) return null;

  const key = String(gameId);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  if (_inflight.has(key)) return _inflight.get(key);

  const p = (async () => {
    try {
      const url = `https://sports.core.api.espn.com/v2/sports/${path}/events/${gameId}/competitions/${gameId}/probabilities?limit=1000`;
      const res = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const items = res.data?.items || [];
      if (!items.length) { _cache.set(key, { ts: Date.now(), data: null }); return null; }
      let first = items[0], latest = items[0];
      for (const it of items) {
        const s = Number(it.sequenceNumber) || 0;
        if (s < (Number(first.sequenceNumber) || 0))  first = it;
        if (s >= (Number(latest.sequenceNumber) || 0)) latest = it;
      }
      const data = { first: normItem(first), latest: normItem(latest) };
      // Scrub zero-filled blocks (see header): an exactly-0 pregame sample means
      // the cover/total model isn't running for this game — null the block so the
      // pulse falls back to its approx read instead of shipping 0%/100%. The
      // latest sample keeps an exact 0 only when the FIRST sample proves the
      // model was really running (a real pregame value near 0.5): that is a
      // cover genuinely dead late, not a placeholder.
      for (const [prob, push] of [['spreadCoverHome', 'spreadPush'], ['totalOver', 'totalPush']]) {
        const f = data.first, l = data.latest;
        const firstReal = !!(f && typeof f[prob] === 'number' && f[prob] !== 0);
        if (f && f[prob] === 0) { f[prob] = null; f[push] = null; }
        if (l && l[prob] === 0 && !firstReal) { l[prob] = null; l[push] = null; }
      }
      _cache.set(key, { ts: Date.now(), data });
      return data;
    } catch (e) {
      const code = e.response?.status;
      if (code === 400 || code === 404) { _dead.add(deadKey); return null; }
      const stale = _cache.get(key);               // serve stale on transient error
      return stale ? stale.data : null;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

// Prune (unref so it never holds the process open).
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of _cache) if (now - e.ts > 60 * 60_000) _cache.delete(k);
}, 10 * 60_000).unref();

module.exports = { getCoreProbs };
