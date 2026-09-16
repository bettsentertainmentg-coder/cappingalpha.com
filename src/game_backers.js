// src/game_backers.js — WHO IS ON THIS GAME (docs/V2_DATABASE_PLAN.md 7b).
//
// getGameBackers(espn_game_id, { game, paid }) reads capper_history for the
// game (pending + graded rows, never void), applies the same exclusions the
// ratings use (src/capper_v2.js), folds aliases, joins capper_ratings_v2 on
// the SPORT scope and capper_registry for the public name, and returns one row
// per live capper per pick, ordered by money in the sport descending.
// Unqualified cappers never appear by name: only as a count.
//
// Rides GET /api/game/:id and the server-rendered game page as `backers`
// under product_mode v2 (or the admin preview). Pregame rows are paid (free
// users get the counts and a locked flag); finished games are free.

const db = require('./db');
const { buildResolver, isLiveRow } = require('./capper_ratings');
const { implausibleLine } = require('./audit');
const v2 = require('./capper_v2');
const pub = require('./capper_public');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function sideOf(row, game) {
  const pt = String(row.pick_type || '').toLowerCase();
  if (pt === 'over') return 'over';
  if (pt === 'under') return 'under';
  if (row.is_home_team === 1) return 'home';
  if (row.is_home_team === 0) return 'away';
  const t = norm(row.team);
  const homeNames = [game.home_team, game.home_short, game.home_abbr].filter(Boolean).map(norm);
  const awayNames = [game.away_team, game.away_short, game.away_abbr].filter(Boolean).map(norm);
  if (homeNames.some((n) => n && (n === t || n.includes(t) || t.includes(n)))) return 'home';
  if (awayNames.some((n) => n && (n === t || n.includes(t) || t.includes(n)))) return 'away';
  return null;
}

function abbrOf(game, side) {
  const a = side === 'home' ? (game.home_abbr || game.home_short || game.home_team) : (game.away_abbr || game.away_short || game.away_team);
  return String(a || '').slice(0, 4).toUpperCase();
}

function fmtLine(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v > 0 ? `+${v}` : `${v}`;
}

function chipLabel(row, side, game) {
  const pt = String(row.pick_type || '').toLowerCase();
  const line = row.spread != null ? Number(row.spread) : null;
  if (pt === 'over' || pt === 'under') {
    const tot = line != null ? line : (game.over_under != null ? Number(game.over_under) : null);
    return `${pt === 'over' ? 'Over' : 'Under'}${tot != null ? ' ' + tot : ''}`;
  }
  const abbr = abbrOf(game, side);
  if (pt === 'spread') return `${abbr} ${fmtLine(line)}`;
  return `${abbr} ML`;
}

function defaultPrice(row) {
  const pt = String(row.pick_type || '').toLowerCase();
  return (pt === 'over' || pt === 'under') ? -115 : -110;
}

function hoursBefore(savedAt, startIso) {
  if (!savedAt || !startIso) return null;
  const s = Date.parse(String(savedAt).replace(' ', 'T') + (String(savedAt).endsWith('Z') ? '' : 'Z'));
  const g = Date.parse(startIso);
  if (!Number.isFinite(s) || !Number.isFinite(g)) return null;
  return (g - s) / 3600e3;
}

function recordedLabel(h) {
  if (h == null) return 'Recorded before start';
  if (h < 0) return 'Recorded at start';
  if (h < 1) return `Recorded ${Math.max(1, Math.round(h * 60))}m before start`;
  if (h < 48) return `Recorded ${Math.round(h)}h before start`;
  return `Recorded ${Math.round(h / 24)}d before start`;
}

function gameStarted(game) {
  if (!game) return false;
  if (game.status && game.status !== 'pre') return true;
  if (game.actual_start_at) return true;
  return false;
}

function getGameBackers(espn_game_id, { game, paid = false } = {}) {
  game = game || db.prepare(`SELECT * FROM today_games WHERE espn_game_id = ?`).get(espn_game_id);
  if (!game) return null;
  const sport = v2.sportScope(game.sport);
  const bar = v2.barSettings();
  const resolve = buildResolver();
  const pmOk = v2.pmScreenedCanonicals(resolve);
  const live = v2.getLiveSet();
  const started = gameStarted(game);
  const freePending = db.getSetting('v2_free_pending', '0') === '1';
  const locked = !started && !paid && !freePending;

  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, capper_name, sport, pick_type, team, spread, espn_game_id, game_date, result, odds, source,
             sources_json, saved_at, is_home_team
      FROM capper_history
      WHERE espn_game_id = ? AND result IN ('pending', 'win', 'loss', 'push') AND capper_name IS NOT NULL
      ORDER BY saved_at ASC, id ASC
    `).all(espn_game_id);
  } catch (_) { rows = []; }

  const regStmt = db.prepare(`SELECT * FROM capper_registry WHERE canonical_name = ?`);
  const seen = new Map();          // canonical|side|type -> row (earliest kept)
  const unqualified = new Set();
  const perCapperSides = new Map();
  for (const r of rows) {
    if (isLiveRow(r)) continue;
    if (v2.corruptPrice(r.odds)) continue;
    try { if (implausibleLine(r)) continue; } catch (_) {}
    const canonical = resolve(r.capper_name, r.source);
    if (r.source === 'polymarket' && !pmOk.has(canonical)) continue;
    if (!live.has(canonical)) { unqualified.add(canonical); continue; }
    const reg = regStmt.get(canonical);
    if (reg && reg.hidden) continue;
    const side = sideOf(r, game);
    if (!side) continue;
    const pt = String(r.pick_type || '').toLowerCase();
    const key = `${canonical}|${side}|${pt}`;
    if (seen.has(key)) continue;
    r.canonical = canonical; r.side = side; r.reg = reg;
    seen.set(key, r);
    const sides = perCapperSides.get(canonical) || new Set();
    sides.add(side); perCapperSides.set(canonical, sides);
  }

  const srcCountStmt = db.prepare(`SELECT source, COUNT(*) n FROM capper_history WHERE capper_name = ? AND result IN ('win','loss','push') GROUP BY source`);
  const cappers = [];
  for (const r of seen.values()) {
    const rating = v2.getRating(r.canonical, `sport:${sport}`, 'all');
    const srcCounts = {};
    try { for (const s of srcCountStmt.all(r.capper_name)) srcCounts[s.source || 'discord'] = s.n; } catch (_) {}
    if (!Object.keys(srcCounts).length) srcCounts[r.source || 'discord'] = 1;
    const p = pub.publicCapper(r.reg || { canonical_name: r.canonical, name_mode: 'auto' }, srcCounts);
    const wins = rating ? rating.wins : 0, losses = rating ? rating.losses : 0, pushes = rating ? rating.pushes : 0;
    const graded = rating ? rating.graded : 0;
    const units = rating ? rating.units : 0;
    const chips = [];
    if (graded < 20) chips.push({ kind: 'sample', text: 'Small sample' });
    if (rating && rating.streak_len >= bar.streakMin && rating.streak_kind) {
      chips.push({ kind: 'streak', dir: rating.streak_kind, text: `${sport} ${rating.streak_kind}${rating.streak_len}` });
    }
    if (rating && rating.season_top_money) chips.push({ kind: 'season_money', units: rating.season_units });
    if (rating && rating.season_top_record) chips.push({ kind: 'season_record', w: rating.season_wins, l: rating.season_losses, p: rating.season_pushes });
    const h = hoursBefore(r.saved_at, game.start_time);
    const sides = perCapperSides.get(r.canonical) || new Set();
    const both = (sides.has('home') && sides.has('away')) || (sides.has('over') && sides.has('under'));
    cappers.push({
      name: p.name, slug: p.slug, initials: p.initials, source: p.source, source_cls: p.source_cls,
      record: `${wins}-${losses}${pushes ? '-' + pushes : ''}`, wins, losses, pushes, graded,
      units: +units.toFixed(2), roi: rating && rating.roi != null ? +(rating.roi * 100).toFixed(1) : null,
      recorded: recordedLabel(h), recorded_hours: h != null ? +h.toFixed(2) : null,
      side: r.side, pick_type: String(r.pick_type || '').toLowerCase(), chip: chipLabel(r, r.side, game),
      line: r.spread != null ? Number(r.spread) : null,
      price: r.odds != null ? Number(r.odds) : null, price_default: defaultPrice(r),
      result: r.result === 'pending' ? null : r.result,
      both_sides: both, chips,
      profile_href: `/capper/${encodeURIComponent(p.slug)}?sport=${encodeURIComponent(sport)}`,
    });
  }
  cappers.sort((a, b) => (b.units - a.units) || ((b.wins / Math.max(1, b.wins + b.losses)) - (a.wins / Math.max(1, a.wins + a.losses))) || (b.graded - a.graded));

  const counts = { all: cappers.length, away: 0, home: 0, over: 0, under: 0 };
  for (const c of cappers) counts[c.side] = (counts[c.side] || 0) + 1;

  return {
    sport,
    sport_label: sport === 'Tennis' ? 'Tennis' : sport,
    away_abbr: abbrOf(game, 'away'), home_abbr: abbrOf(game, 'home'),
    counts, unqualified: unqualified.size,
    frozen: started, graded: game.status === 'post',
    locked,
    cappers: locked ? [] : cappers,
    stake: v2.STAKE,
  };
}

module.exports = { getGameBackers, sideOf, chipLabel, recordedLabel };
