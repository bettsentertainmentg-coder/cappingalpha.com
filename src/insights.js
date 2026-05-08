// src/insights.js
// Rule-based line movement insight chips for the game detail popup.
// Compares ESPN line history (opening) vs current today_games values.
// Pure factual descriptions — no pick recommendations, no directional advice.

const db = require('./db');
const { getLineHistoryForGame } = require('./line_history');

// ── Template library — 58 variations ─────────────────────────────────────────
// Selected deterministically by hashing (espn_game_id + type + magnitude_bucket)
// so the same game always shows the same phrasing.
// Tokens: [team], [X], [open], [cur]

const TEMPLATES = {
  spread_small: [
    'Spread moved [X] pts toward [team] since open',
    '[team] spread crept from [open] to [cur]',
    'Line shifted [X] pts · [team] now at [cur]',
    'Opening spread was [open] · currently sitting at [cur]',
    'Spread ticked [X] pts since this morning\'s open',
    '[team] line moved [open] → [cur] today',
    'Small line move: spread at [cur], opened at [open]',
    'Spread adjustment of [X] pts toward [team] since open',
    'Half-point shift · [team] spread moved [open] → [cur]',
    '[X]-pt move on [team] spread since market opened',
  ],
  spread_medium: [
    'Steam to [team] · spread tightened [X] since open',
    'Spread moved [X] pts · [team] opened at [open], now [cur]',
    '[X]-point line move on [team] since open',
    'Line shifted from [open] to [cur] · [X] pts toward [team]',
    'Spread movement: [team] at [cur] from an open of [open]',
    '[team] spread has moved [X] pts today',
    'Notable spread shift: [team] opened [open], currently [cur]',
    '[X]-pt adjustment on [team] side since market open',
    'Line moved [open] → [cur] today on [team] spread',
    'Spread is [X] pts off the opening number for [team]',
  ],
  spread_large: [
    'Big line move: [team] spread shifted [X] pts since open',
    'Spread moved [open] → [cur] · [X]-pt move on [team]',
    '[X] pts of spread movement toward [team] today',
    'Significant line adjustment: [team] spread at [cur] from [open] open',
    '[team] spread opened [open] · now [cur] · [X]-pt move',
    'Large shift: [X]-pt spread move toward [team] since open',
    '[team] spread moved considerably · [open] open, now [cur]',
    'Spread moved [X] pts · [team] line has seen heavy activity today',
    '[X]-point spread shift since market opened on [team]',
    'One of the larger moves today: [team] spread [open] → [cur]',
  ],
  ou_dropped: [
    'Total dropped [X] since open · [open] → [cur]',
    'Over/under fell [X] pts · opened at [open], sitting at [cur]',
    'Total is down [X] from the opening number of [open]',
    'Line slid from [open] to [cur] on the total',
    'Total has dropped [X] pts today · currently [cur]',
    'Over/under opened [open] · now down to [cur]',
    'Total moved down [X] · [open] open, [cur] current',
    '[X]-pt drop on the total since market opened',
    'Total sits [X] pts below its opening number',
    'O/U line: [open] at open, [cur] now — down [X]',
  ],
  ou_rose: [
    'Total climbed [X] since open · [open] → [cur]',
    'Over/under rose [X] pts · opened [open], now [cur]',
    'Total is up [X] from the opening number of [open]',
    'Line moved up from [open] to [cur] on the total',
    'Total has risen [X] pts today · currently [cur]',
    'Over/under opened [open] · now up to [cur]',
    'Total moved up [X] · [open] open, [cur] current',
    '[X]-pt rise on the total since market opened',
  ],
  ml_home: [
    '[team] win odds moved [X]¢ since open',
    'Win line shifted [X]¢ toward [team] since market opened',
    '[team] opened at [open] · win price now at [cur]',
    'Win odds moved [open] → [cur] on [team] today',
    '[X]¢ movement on [team] win odds since open',
    '[team] win price has adjusted [X]¢ from its open',
  ],
  ml_away: [
    '[team] win odds moved [X]¢ since this morning\'s open',
    'Away win price shifted [X]¢ toward [team]',
    '[team] road win odds: opened [open], now [cur]',
    '[X]¢ win odds adjustment on [team] since market opened',
  ],
};

// Simple deterministic hash: sum of char codes mod n
function pickTemplate(key, espn_game_id, n) {
  let hash = 0;
  const s = (espn_game_id || '') + key;
  for (let i = 0; i < s.length; i++) hash += s.charCodeAt(i);
  return hash % n;
}

function fmt(n) {
  return Math.abs(n).toFixed(1).replace(/\.0$/, '');
}

function fmtLine(n) {
  if (n == null) return '?';
  const v = parseFloat(n);
  if (isNaN(v)) return '?';
  return v > 0 ? `+${v}` : `${v}`;
}

function interpolate(template, vars) {
  return template
    .replace(/\[team\]/g, vars.team || '')
    .replace(/\[X\]/g,    vars.X    || '')
    .replace(/\[open\]/g, vars.open != null ? fmtLine(vars.open) : '?')
    .replace(/\[cur\]/g,  vars.cur  != null ? fmtLine(vars.cur)  : '?');
}

// Returns array of insight objects: { type: 'spread'|'ou'|'ml', text: string }
function getLineInsights(espn_game_id, game) {
  if (!game) return [];

  const lh = getLineHistoryForGame(espn_game_id);

  // Opening values: prefer real ESPN history; fall back to picks table (INSERT OR IGNORE = 5am values)
  const allPicks = db.prepare(`SELECT * FROM picks WHERE espn_game_id = ?`).all(espn_game_id);
  const fallbackSpread = allPicks.find(p => p.pick_type === 'spread' && p.is_home_team === 1)?.spread;
  const fallbackMlH    = allPicks.find(p => p.pick_type === 'ML'     && p.is_home_team === 1)?.original_ml;
  const fallbackMlA    = allPicks.find(p => p.pick_type === 'ML'     && p.is_home_team === 0)?.original_ml;
  const fallbackOU     = allPicks.find(p => p.pick_type === 'over')?.spread;

  const openSpreadH = lh?.opening?.spread_home ?? fallbackSpread;
  const openMlH     = lh?.opening?.ml_home     ?? fallbackMlH;
  const openMlA     = lh?.opening?.ml_away     ?? fallbackMlA;
  const openOU      = lh?.opening?.over_under   ?? fallbackOU;

  const curSpreadH = game.spread_home;
  const curMlH     = game.ml_home;
  const curMlA     = game.ml_away;
  const curOU      = game.over_under;

  const homeNick = (game.home_team || '').split(' ').pop() || 'Home';
  const awayNick = (game.away_team || '').split(' ').pop() || 'Away';

  const insights = [];

  // ── Spread ──────────────────────────────────────────────────────────────────
  if (openSpreadH != null && curSpreadH != null) {
    const delta = curSpreadH - openSpreadH;
    if (Math.abs(delta) >= 0.5) {
      // delta < 0 = home more favored; delta > 0 = away more favored
      const isHomeTeam = delta < 0;
      const teamName = isHomeTeam ? homeNick : awayNick;
      const absDelta = Math.abs(delta);
      // Show the featured team's spread (negate for away team perspective)
      const openVal = isHomeTeam ? openSpreadH : -openSpreadH;
      const curVal  = isHomeTeam ? curSpreadH  : -curSpreadH;
      const bucket = absDelta >= 2 ? 'spread_large' : absDelta >= 1 ? 'spread_medium' : 'spread_small';
      const pool = TEMPLATES[bucket];
      const tpl  = pool[pickTemplate(bucket, espn_game_id, pool.length)];
      insights.push({
        type: 'spread',
        text: interpolate(tpl, { team: teamName, X: fmt(absDelta), open: openVal, cur: curVal }),
      });
    }
  }

  // ── O/U ─────────────────────────────────────────────────────────────────────
  if (openOU != null && curOU != null) {
    const delta = curOU - openOU;
    if (Math.abs(delta) >= 0.5) {
      const bucket = delta < 0 ? 'ou_dropped' : 'ou_rose';
      const pool = TEMPLATES[bucket];
      const tpl  = pool[pickTemplate(bucket, espn_game_id, pool.length)];
      insights.push({
        type: 'ou',
        text: interpolate(tpl, { X: fmt(delta), open: openOU, cur: curOU }),
      });
    }
  }

  // ── ML ──────────────────────────────────────────────────────────────────────
  // Use home ML movement as trigger; X = relevant team's actual movement
  if (openMlH != null && curMlH != null) {
    const deltaH = curMlH - openMlH;
    if (Math.abs(deltaH) >= 5) {
      // deltaH < 0 → home ML got more negative → home team attracting more action
      const isHome = deltaH < 0;
      const teamName = isHome ? homeNick : awayNick;
      const openVal  = isHome ? openMlH : openMlA;
      const curVal   = isHome ? curMlH  : curMlA;
      // Use relevant team's delta for X; fall back to home delta if away not available
      const X = (isHome || (openMlA != null && curMlA != null))
        ? Math.round(Math.abs(isHome ? deltaH : (curMlA - openMlA)))
        : Math.round(Math.abs(deltaH));
      const bucket = isHome ? 'ml_home' : 'ml_away';
      const pool = TEMPLATES[bucket];
      const tpl  = pool[pickTemplate(bucket, espn_game_id, pool.length)];
      insights.push({
        type: 'ml',
        text: interpolate(tpl, { team: teamName, X: X + '', open: openVal, cur: curVal }),
      });
    }
  }

  return insights;
}

module.exports = { getLineInsights };
