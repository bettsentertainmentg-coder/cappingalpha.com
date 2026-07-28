// src/tennis_photos.js — free tennis player photo resolver + cache.
//
// Cascade per player: ESPN headshot (clean transparent PNG, exists only for the
// biggest names) -> Wikipedia lead image (covers most tour-level players) ->
// nothing (frontend falls back to country flag / initials). Zero cost: an ESPN
// CDN HEAD check + a Wikipedia REST summary, cached in tennis_player_photos
// (misses re-checked after RECHECK_DAYS, hits kept forever). Resolved URLs are
// stamped onto today_games.home_photo/away_photo so every existing payload
// (/api/games, /api/game/:id, the detail page SSR) carries them with no new
// endpoint.
//
// Wrong-person guard: a Wikipedia summary only counts when it is a standard
// article whose description/extract mentions tennis ("Edward Winter" resolves
// to a disambiguation page; "Martin Damm" could be the father). Disambiguation
// pages retry once with the "(tennis)" qualifier.

const axios = require('axios');
const db    = require('./db');

const RECHECK_DAYS = 14;
const WIKI_HEADERS = { 'User-Agent': 'CappingAlpha/1.0 (https://cappingalpha.com; schedule display)' };

const espnHeadshotUrl = id => `https://a.espncdn.com/i/headshots/tennis/players/full/${id}.png`;

async function espnHeadshot(athleteId) {
  if (!athleteId) return null;
  try {
    const res = await axios.head(espnHeadshotUrl(athleteId), { timeout: 6000, validateStatus: () => true });
    if (res.status === 200) return espnHeadshotUrl(athleteId);
  } catch (_) {}
  return null;
}

async function wikiPhoto(name, allowRetry = true) {
  if (!name) return null;
  try {
    const slug = encodeURIComponent(String(name).trim().replace(/ /g, '_'));
    const res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`, {
      timeout: 8000, headers: WIKI_HEADERS, validateStatus: () => true,
    });
    if (res.status !== 200 || !res.data) return null;
    const d = res.data;
    if (d.type === 'disambiguation' && allowRetry) return wikiPhoto(`${name} (tennis)`, false);
    if (d.type !== 'standard') return null;
    const about = `${d.description || ''} ${(d.extract || '').slice(0, 300)}`;
    if (!/tennis/i.test(about)) return null;
    // Thumbnail (~330px) over originalimage — these render as small avatars.
    return (d.thumbnail && d.thumbnail.source) || null;
  } catch (_) { return null; }
}

// Resolve one player, cache-first. Returns { url, fromCache } so callers only
// pace themselves after real network lookups.
async function resolvePlayerPhoto(name, athleteId) {
  if (!name) return { url: null, fromCache: true };
  const row = db.prepare(`SELECT * FROM tennis_player_photos WHERE player_name = ?`).get(name);
  if (row) {
    const ageMs = Date.now() - Date.parse(String(row.checked_at || '').replace(' ', 'T') + 'Z');
    const fresh = !Number.isFinite(ageMs) || ageMs < RECHECK_DAYS * 864e5;
    if (row.photo_url || fresh) return { url: row.photo_url, fromCache: true };
  }
  let url = await espnHeadshot(athleteId);
  let source = url ? 'espn' : null;
  if (!url) { url = await wikiPhoto(name); if (url) source = 'wikipedia'; }
  db.prepare(`
    INSERT INTO tennis_player_photos (player_name, athlete_id, photo_url, source, checked_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(player_name) DO UPDATE SET
      athlete_id = COALESCE(excluded.athlete_id, tennis_player_photos.athlete_id),
      photo_url  = excluded.photo_url,
      source     = excluded.source,
      checked_at = excluded.checked_at
  `).run(name, athleteId != null ? String(athleteId) : null, url, source);
  return { url, fromCache: false };
}

// Stamp cached photo URLs onto today's tennis rows (cheap, pure DB).
function applyPhotos() {
  const rows = db.prepare(`
    SELECT espn_game_id, home_team, away_team, home_photo, away_photo
    FROM today_games WHERE sport IN ('ATP', 'WTA')
  `).all();
  const get = db.prepare(`SELECT photo_url FROM tennis_player_photos WHERE player_name = ?`);
  const upd = db.prepare(`UPDATE today_games SET home_photo = ?, away_photo = ? WHERE espn_game_id = ?`);
  let stamped = 0;
  for (const g of rows) {
    const hp = (get.get(g.home_team) || {}).photo_url || null;
    const ap = (get.get(g.away_team) || {}).photo_url || null;
    if (hp !== g.home_photo || ap !== g.away_photo) { upd.run(hp, ap, g.espn_game_id); stamped++; }
  }
  return stamped;
}

let _syncPromise = null;

// Resolve every player on today's tennis board, then stamp the games. Sequential
// with a polite delay after each real lookup; after day one nearly everything is
// a cache hit, so a typical run is a handful of lookups for new names only.
// Concurrent callers join the in-flight run instead of starting another.
function syncTennisPhotos() {
  if (_syncPromise) return _syncPromise;
  _syncPromise = _runSync().finally(() => { _syncPromise = null; });
  return _syncPromise;
}

async function _runSync() {
  try {
    const rows = db.prepare(`
      SELECT home_team, away_team, home_athlete_id, away_athlete_id
      FROM today_games WHERE sport IN ('ATP', 'WTA')
    `).all();
    const players = new Map();
    for (const g of rows) {
      if (g.home_team && !players.has(g.home_team)) players.set(g.home_team, g.home_athlete_id);
      if (g.away_team && !players.has(g.away_team)) players.set(g.away_team, g.away_athlete_id);
    }
    let looked = 0;
    for (const [name, id] of players) {
      const { fromCache } = await resolvePlayerPhoto(name, id);
      if (!fromCache) { looked++; await new Promise(r => setTimeout(r, 350)); }
    }
    const stamped = applyPhotos();
    if (looked || stamped) console.log(`[tennis_photos] ${players.size} players (${looked} fresh lookups), stamped ${stamped} games`);
  } catch (err) {
    console.warn('[tennis_photos] sync error:', err.message);
  }
}

module.exports = { syncTennisPhotos, applyPhotos, resolvePlayerPhoto };
