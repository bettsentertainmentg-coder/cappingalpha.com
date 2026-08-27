// src/betslip_match.js — match a parsed betslip bet to a real game + pick slot.
//
// PURE. Takes the bets from betslip_parse.js and an array of today_games rows and
// returns, per bet, the game it belongs to and which of the six slots it is. That
// slot is what lets a scanned screenshot ride the EXACT same path as a bet placed
// inside the app: /api/game/:id/vote when it verifies, /api/bets when it does not.
//
// Deliberately NOT reusing storage.findTodayGame: that matcher is tuned for short
// pick strings from the Discord reader and does raw substring containment both
// ways, which on OCR text will happily match "X" (the share-sheet icon) to any
// team whose name contains an x. Everything here is token-scored and thresholded.

'use strict';

// ── Name normalization ────────────────────────────────────────────────────────
const STOPWORDS = new Set(['fc', 'sc', 'afc', 'cf', 'ac', 'the', 'club', 'city', 'utd']);

function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function norm(s) {
  return stripAccents(String(s || ''))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function tokens(s) {
  return norm(s).split(' ').filter(t => t && !STOPWORDS.has(t));
}
// "Yankees" and "Yankee" are the same team; so are "Reds"/"Red".
function stem(t) { return t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t; }

// ── Name similarity, 0..1 ─────────────────────────────────────────────────────
// Scores a candidate NAME (from the slip) against a stored VARIANT (from the game
// row). The asymmetry matters: the slip's "Los Angeles Lakers" should score 1.0
// against the stored short name "Lakers", but the bare share-sheet word "X" must
// not score against anything.
function nameScore(candidate, variant) {
  const c = norm(candidate), v = norm(variant);
  if (!c || !v) return 0;
  if (c === v) return 1;

  const ct = tokens(c).map(stem), vt = tokens(v).map(stem);
  if (!ct.length || !vt.length) return 0;

  // An abbreviation on the slip ("LAL") against the stored abbr.
  if (ct.length === 1 && vt.length === 1 && ct[0].length <= 4 && vt[0].length <= 4) {
    return ct[0] === vt[0] ? 0.95 : 0;
  }
  // A single short token from the slip is too weak to match on its own unless it
  // IS one of the variant's tokens ("Sonego" vs "Lorenzo Sonego", "Lakers" vs
  // "Los Angeles Lakers"). Two-letter tokens never match.
  const overlap = ct.filter(t => vt.includes(t));
  if (!overlap.length) return 0;
  if (overlap.every(t => t.length <= 2)) return 0;

  // Jaccard over the smaller side, so a long stored name is not punished for the
  // extra city words the slip left out.
  const denom = Math.min(ct.length, vt.length);
  const base = overlap.length / denom;

  // A full containment of the shorter token list is the strong case.
  const shorter = ct.length <= vt.length ? ct : vt;
  const longer  = ct.length <= vt.length ? vt : ct;
  const contained = shorter.every(t => longer.includes(t));

  // The LAST token carries the identity in both team names ("...Lakers") and
  // player names ("Lorenzo Sonego"), so agreeing on it is worth a bump.
  const lastAgrees = ct[ct.length - 1] === vt[vt.length - 1];

  let s = base * 0.75;
  if (contained) s = Math.max(s, 0.88);
  if (lastAgrees) s = Math.max(s, contained ? 0.92 : 0.78);
  return Math.min(0.98, s);
}

// Every stored spelling of one side of a game.
function sideVariants(game, side) {
  const p = side === 'home' ? 'home' : 'away';
  return [game[`${p}_team`], game[`${p}_short`], game[`${p}_name`], game[`${p}_abbr`]]
    .filter(v => v != null && String(v).trim() !== '');
}
function scoreSide(name, game, side) {
  let best = 0;
  for (const v of sideVariants(game, side)) best = Math.max(best, nameScore(name, v));
  return best;
}

// ── Sport hints from the market label ─────────────────────────────────────────
// "Total Runs" is only ever baseball; "Puck Line" is only ever hockey. A soft
// boost, never a filter, because a mislabeled hint must not lose a real match.
// This is what keeps an MLS Toronto off an MLB Toronto (the city-overlap trap
// that already has guards in reader_rules.js).
const SPORT_HINTS = [
  { re: /\b(run line|total runs|first 5|f5|innings?|strikeouts?)\b/i, sports: ['MLB'] },
  // "Puck line" is hockey and nothing else. "Total goals" is shared with soccer,
  // so the two must not be lumped together: a shared hint cannot break a tie.
  { re: /\bpuck line\b/i,                                             sports: ['NHL'] },
  { re: /\b(goal line|both teams to score|btts|match result|1x2|corners)\b/i, sports: ['Soccer'] },
  { re: /\btotal goals?\b/i,                                          sports: ['NHL', 'Soccer'] },
  { re: /\b(total (?:games|sets)|aces)\b/i,                           sports: ['ATP', 'WTA'] },
  { re: /\b(total (?:maps|kills|rounds))\b/i,                         sports: ['Esports'] },
  { re: /\b(touchdowns?|passing yards|rushing yards|receptions?)\b/i,  sports: ['NFL', 'NCAAF'] },
  { re: /\b(rebounds?|assists?|threes|three pointers)\b/i,             sports: ['NBA', 'WNBA', 'CBB'] },
];
function sportHint(bet) {
  const hay = [bet.market_label, bet.selection, ...(bet.legs || []).map(l => l.market_label)]
    .filter(Boolean).join(' ');
  for (const h of SPORT_HINTS) if (h.re.test(hay)) return h.sports;
  return null;
}

// ── Slot ──────────────────────────────────────────────────────────────────────
function slotFor(betType, side) {
  if (betType === 'over')  return 'over';
  if (betType === 'under') return 'under';
  if (betType === 'ml')     return side === 'home' ? 'home_ml' : side === 'away' ? 'away_ml' : null;
  if (betType === 'spread') return side === 'home' ? 'home_spread' : side === 'away' ? 'away_spread' : null;
  return null; // prop / parlay / future are never slot-gradable
}

// ── Start-time agreement ──────────────────────────────────────────────────────
// A slip prints a local kick time ("6:14PM ET"). When two games otherwise tie
// (a doubleheader, a team playing twice in the window), the clock breaks it.
function startAgrees(hint, game) {
  if (!hint || !hint.time || !game.start_time) return null;
  const m = /^(\d{1,2}):(\d{2})(AM|PM)$/i.exec(hint.time);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  const mins = h * 60 + parseInt(m[2], 10);
  // today_games.start_time is UTC; the slip is in the phone's local zone, which we
  // do not know. Compare against ET (what every US book prints) and let a wide
  // window absorb the rest.
  const d = new Date(String(game.start_time).includes('T')
    ? game.start_time : String(game.start_time).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return null;
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const gameMins = et.getHours() * 60 + et.getMinutes();
  let diff = Math.abs(gameMins - mins);
  if (diff > 720) diff = 1440 - diff;      // wrap midnight
  return diff <= 20;
}

// ── The matcher ───────────────────────────────────────────────────────────────
const MATCH_MIN   = 0.62;  // below this we do not claim a game
const AMBIG_DELTA = 0.06;  // two candidates this close = ask the user

/**
 * Match one parsed bet to a game.
 *
 * @param {object} bet    a bet from parseBetslip()
 * @param {Array}  games  today_games rows (id + name variants + sport + start_time)
 * @returns {{game, espn_game_id, side, slot, sport, score, ambiguous, alternatives}}
 */
function matchBet(bet, games) {
  const empty = { game: null, espn_game_id: null, side: null, slot: null, sport: null, score: 0, ambiguous: false, alternatives: [] };
  if (!bet || !Array.isArray(games) || !games.length) return empty;

  const isTotal = bet.bet_type === 'over' || bet.bet_type === 'under';
  const hints = sportHint(bet);

  // Names we can match on. For a total the selection is just "Over", so the
  // matchup line is the ONLY way in — which is why the parser works so hard to
  // keep it.
  const selName = isTotal ? null : (bet.selection || null);
  const mu = bet.matchup || null;

  const scored = [];
  for (const g of games) {
    let score = 0, side = null;

    // B. The selection names one side. Done first so the matchup below can act as
    //    CONFIRMATION on top of it rather than competing with it.
    if (selName) {
      const h = scoreSide(selName, g, 'home'), a = scoreSide(selName, g, 'away');
      const best = Math.max(h, a);
      if (best > 0) {
        side = h >= a ? 'home' : 'away';
        score = best;
      }
    }

    // A. The matchup line names BOTH sides, which is the strongest evidence on the
    //    slip. It has to be able to out-rank a name-only match, so it adds on top
    //    instead of being max()'d in: a player on two games in the same window
    //    scores 1.0 on the selection alone for both, and a max() cannot separate
    //    them. Live board, 2026-08-26: "Jacob Fearnley v Jurij Rodionov" tied with
    //    a different, already-finished Fearnley match and lost the coin flip.
    //
    //    It also cuts the other way. When the slip names an opponent this game does
    //    NOT have, that is evidence against, so a confirmed-selection-but-wrong-
    //    opponent candidate is pushed below one whose pair agrees.
    if (mu) {
      const aHome = scoreSide(mu.a, g, 'home'), aAway = scoreSide(mu.a, g, 'away');
      const bHome = scoreSide(mu.b, g, 'home'), bAway = scoreSide(mu.b, g, 'away');
      const straight = (aAway + bHome) / 2;   // "away @ home", the US convention
      const flipped  = (aHome + bAway) / 2;
      const pair = Math.max(straight, flipped);
      if (pair > 0.55) {
        // Standalone strength when the selection gave us nothing: a total's
        // selection is just "Over", so the matchup is the ONLY way in.
        score = score > 0 ? score + 0.45 * pair : 0.6 + pair * 0.4;
      } else if (score > 0) {
        score -= 0.15;
      }
    }

    if (score <= 0) continue;

    // C. Sport hint agreement.
    if (hints) {
      const sp = String(g.sport || '');
      // A wrong-sport hit must be able to LOSE to a right-sport near-miss: "Toronto"
      // matches Toronto FC exactly (1.0) and the Blue Jays partially (0.88), so the
      // penalty has to outweigh that gap when the market says baseball.
      score += hints.includes(sp) ? 0.08 : -0.16;
    }

    // D. Start time agreement (only when we can read one).
    const t = startAgrees(bet.start_hint, g);
    if (t === true) score += 0.08;
    else if (t === false) score -= 0.12;

    // NOT clamped to 1 here: the matchup bonus above deliberately pushes a
    // two-sided confirmation past a name-only match, and clamping would throw that
    // separation away before the sort. Clamped only when reported.
    scored.push({ game: g, score: Math.max(0, score), side });
  }

  if (!scored.length) return empty;
  scored.sort((x, y) => y.score - x.score);
  const top = scored[0];
  if (top.score < MATCH_MIN) {
    return { ...empty, alternatives: scored.slice(0, 3).map(s => ({ espn_game_id: s.game.espn_game_id, score: +Math.min(1, s.score).toFixed(3) })) };
  }

  // Resolve the side once the game is known. When the selection did not name a
  // side (a total), fall back to the matchup's own home/away when it had an "@".
  let side = top.side;
  if (!isTotal && !side && mu) {
    const aHome = scoreSide(mu.a, top.game, 'home');
    const aAway = scoreSide(mu.a, top.game, 'away');
    side = aHome >= aAway ? 'home' : 'away';
  }
  if (isTotal) side = bet.bet_type;   // 'over' | 'under'

  const runnerUp = scored[1];
  const ambiguous = !!runnerUp && (top.score - runnerUp.score) < AMBIG_DELTA;

  return {
    game: top.game,
    espn_game_id: top.game.espn_game_id,
    side: isTotal ? null : side,
    slot: slotFor(bet.bet_type, side),
    sport: top.game.sport || null,
    score: +Math.min(1, top.score).toFixed(3),
    ambiguous,
    alternatives: scored.slice(1, 4).map(s => ({ espn_game_id: s.game.espn_game_id, score: +Math.min(1, s.score).toFixed(3) })),
  };
}

// Match every bet in a parse result, including parlay legs (each leg needs its own
// game so the parlay can auto-grade off bet_legs).
function matchAll(parsed, games) {
  const bets = (parsed && parsed.bets) || [];
  return bets.map(bet => {
    const m = matchBet(bet, games);
    const legs = (bet.legs || []).map(l => matchBet(l, games));
    return { ...m, legs };
  });
}

module.exports = {
  matchBet, matchAll,
  // exported for tests
  norm, tokens, nameScore, scoreSide, slotFor, sportHint, startAgrees,
  MATCH_MIN, AMBIG_DELTA,
};
