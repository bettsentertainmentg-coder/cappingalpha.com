// src/game_match.js
// Sport-aware wrapper around espn_live.lookupTodayGame for the Discord path.
//
// lookupTodayGame resolves a multi-sport name tie with SPORT_PRIORITY
// (CBB > NBA > NHL > WCBB > MLB > NFL). College football is not on that list, so
// it loses every tie: "Tigers" on a Saturday went to the Detroit Tigers, and in
// November "Kansas" goes to the basketball game. expert_data.js then overwrote
// the reader's own sport with the losing row's, so the pick graded against the
// wrong final and the wrong result went on the capper's record. Measured on a
// November Saturday: 18 of 112 college sides wrong.
//
// The reader already names the sport. This wrapper keeps the unconstrained
// lookup as the first answer (so a reader mislabel, NBA for a WNBA pick, still
// lands where the existing WNBA/Soccer guards expect it) and only when that
// answer disagrees with the reader's sport does it search inside that sport,
// ranking candidates by match quality: an exact hit on a stored name beats a
// prefix hit ("Texas" is Texas, not Texas A&M), which beats a substring. A tie
// at the best quality that is not a doubleheader is REFUSED and logged to
// source_skips, never guessed. Adding NCAAF to SPORT_PRIORITY was measured
// zero-sum (it moves the same errors from football onto basketball).

const db = require('./db');
const { lookupTodayGame } = require('./espn_live');

const COLS = ['home_team', 'home_short', 'home_name', 'home_abbr', 'away_team', 'away_short', 'away_name', 'away_abbr'];

function normSport(s) {
  const u = String(s || '').toUpperCase().trim();
  if (!u) return null;
  if (u === 'CFB') return 'NCAAF';
  if (u === 'NCAAB') return 'CBB';
  return u;
}

function startMs(g) {
  const t = Date.parse(g?.start_time || '');
  return Number.isFinite(t) ? t : Infinity;
}

// Quality of one row for the search term: 3 exact on any stored name, 2 the
// term is a leading or trailing word of the full name, 1 substring, 0 none.
function quality(g, s) {
  const vals = COLS.map(c => String(g[c] || '').toLowerCase()).filter(Boolean);
  if (vals.some(v => v === s)) return 3;
  const full = [String(g.home_team || '').toLowerCase(), String(g.away_team || '').toLowerCase()];
  if (full.some(v => v.startsWith(s + ' ') || v.endsWith(' ' + s))) return 2;
  if (vals.some(v => v.includes(s))) return 1;
  return 0;
}

function pairKey(g) {
  return [String(g.home_team || '').toLowerCase(), String(g.away_team || '').toLowerCase()].sort().join('|');
}

// One search inside a sport: every row that matches at all, on the given ET
// day (or any day when messageDate is null, mirroring lookupTodayGame).
function rowsInSport(s, sport, dateIso) {
  const dateClause = dateIso ? ` AND DATE(start_time) = ?` : '';
  const params = [s, s, s, s, s, s, s, s, sport];
  if (dateIso) params.push(dateIso);
  try {
    return db.prepare(`
      SELECT * FROM today_games WHERE (
        LOWER(home_team)  LIKE '%' || ? || '%' OR LOWER(away_team)  LIKE '%' || ? || '%'
        OR LOWER(home_short) LIKE '%' || ? || '%' OR LOWER(away_short) LIKE '%' || ? || '%'
        OR LOWER(home_name)  LIKE '%' || ? || '%' OR LOWER(away_name)  LIKE '%' || ? || '%'
        OR LOWER(home_abbr) = ? OR LOWER(away_abbr) = ?
      ) AND UPPER(sport) = ?${dateClause}
    `).all(...params);
  } catch (_) { return []; }
}

function nextDay(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Returns { game } | { ambiguous: rows } | null (nothing in this sport).
function resolveInSport(term, sport, messageDate) {
  const s = term.toLowerCase().trim();
  if (s.length < 2) return null;
  // Same day windows lookupTodayGame uses: the message date, then the next UTC
  // day (an 8pm ET game is stored on the next UTC date).
  const days = messageDate ? [messageDate, nextDay(messageDate)] : [null];
  for (const day of days) {
    const rows = rowsInSport(s, sport, day);
    if (!rows.length) continue;
    const best = Math.max(...rows.map(g => quality(g, s)));
    if (best === 0) continue;
    const top = rows.filter(g => quality(g, s) === best);
    if (top.length === 1) return { game: top[0] };
    // Doubleheader (same pair twice): nearest unstarted, as everywhere else.
    if (new Set(top.map(pairKey)).size === 1) {
      const now = Date.now();
      const up = top.filter(g => g.status === 'pre' || startMs(g) > now).sort((a, b) => startMs(a) - startMs(b));
      return { game: up[0] || top.sort((a, b) => startMs(a) - startMs(b))[0] };
    }
    return { ambiguous: top };
  }
  return null;
}

function logRefusal(term, sport, rows) {
  const names = rows.map(g => `${g.sport} ${g.away_team} @ ${g.home_team} (${g.espn_game_id})`).join(' | ');
  console.warn(`[game_match] refused Discord pick "${term}" (${sport}): ${rows.length} games fit equally: ${names}`);
  try {
    db.prepare(`
      INSERT INTO source_skips (source, capper, sport, picked, pick_type, line, odds, reason, candidates_json)
      VALUES ('discord', NULL, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(sport, term, 'ambiguous team match inside the reader sport',
      JSON.stringify(rows.map(g => ({ id: g.espn_game_id, sport: g.sport, home: g.home_team, away: g.away_team, start: g.start_time }))));
  } catch (_) {}
}

// The entry point expert_data.js calls in place of lookupTodayGame.
//
//   reader sport unknown  -> the old lookup, untouched
//   reader sport known    -> resolve inside that sport, quality-ranked:
//       one best match        -> that game (this is also what settles "Texas"
//                                among Texas A&M, Texas State and Texas Tech,
//                                since the exact short name outranks a prefix)
//       a tie, not a DH       -> refuse and log
//       nothing in that sport -> if the old lookup found a game in ANOTHER
//                                sport, refuse too: a Tuesday "Tigers -7" from a
//                                football capper must not grade on a Detroit
//                                Tigers game because the football game is not
//                                on the board yet. Otherwise null, as before.
function lookupTodayGameForSport(teamName, messageDate, readerSport) {
  const term = String(teamName || '');
  const want = normSport(readerSport);
  if (!want) return lookupTodayGame(term, messageDate);

  const r = resolveInSport(term, want, messageDate || null);
  if (r && r.game) return r.game;
  if (r && r.ambiguous) { logRefusal(term, want, r.ambiguous); return null; }

  const base = lookupTodayGame(term, messageDate);
  if (!base) return null;
  if (normSport(base.sport) === want) return base;   // only reachable for a term under 2 chars
  console.warn(`[game_match] refused Discord pick "${term}" (${want}): only match is ${base.sport} ${base.away_team} @ ${base.home_team}`);
  try {
    db.prepare(`
      INSERT INTO source_skips (source, capper, sport, picked, pick_type, line, odds, reason, candidates_json)
      VALUES ('discord', NULL, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(want, term, 'no game in the reader sport; only match is another sport',
      JSON.stringify([{ id: base.espn_game_id, sport: base.sport, home: base.home_team, away: base.away_team, start: base.start_time }]));
  } catch (_) {}
  return null;
}

module.exports = { lookupTodayGameForSport, resolveInSport, normSport };
