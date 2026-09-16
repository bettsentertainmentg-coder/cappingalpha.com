// src/tennis_score.js
// ONE definition of how an ESPN tennis scoreboard turns into sets, games, and a
// verdict on whether the match actually finished. EVERY reader of ESPN tennis
// linescores imports from here — the live fetcher (tennis_espn.js), the
// grader's own re-fetch (results.js), and the repair tooling — so no two of
// them can ever disagree about who won a set.
//
// Why this file exists (2026-07-30): results.js counted sets with a naive
// `if (home > away) homeSetsWon++`, which credits a whole set to whoever merely
// LEADS an unfinished one. Luciano Darderi retired trailing 0-3 in set one of
// ATP 178921; that counter read the partial set as "1-0 Svrcina" and graded a
// tracked gold ML as a LOSS. tennis_espn.js had held the correct rule since
// Jul 14 and wrote the true 0-0 back to the same row minutes later, which is
// why the page ended up showing a LOSS next to a "FINAL 0-0" panel. Two
// counters, one truth: there is now only one counter.

// A set is finished at 6+ games with a 2-game lead, or 7-6 (tiebreak).
// Super tiebreaks played in place of a deciding set (10-8) pass the first clause.
function setDone(games, opp) {
  return (games >= 6 && games - opp >= 2) || (games === 7 && opp === 6);
}

// Sets won, games won, and per-set detail from ESPN's two linescore arrays.
// ESPN's per-set `winner` flag wins when present; setDone is the fallback for
// feeds that omit it. A set still in progress belongs to NOBODY — that is the
// whole point of this module.
function countSets(homeLinescores, awayLinescores) {
  const home = Array.isArray(homeLinescores) ? homeLinescores : [];
  const away = Array.isArray(awayLinescores) ? awayLinescores : [];
  const numSets = Math.max(home.length, away.length);

  let homeSetsWon = 0, awaySetsWon = 0;
  const setDetails = [];
  for (let i = 0; i < numSets; i++) {
    const h = Number(home[i]?.value) || 0;
    const a = Number(away[i]?.value) || 0;
    setDetails.push({ set: i + 1, home: h, away: a });
    if (home[i]?.winner === true || setDone(h, a)) homeSetsWon++;
    else if (away[i]?.winner === true || setDone(a, h)) awaySetsWon++;
  }

  const homeGames = home.reduce((s, l) => s + (Number(l?.value) || 0), 0);
  const awayGames = away.reduce((s, l) => s + (Number(l?.value) || 0), 0);

  return { homeSetsWon, awaySetsWon, setDetails, homeGames, awayGames, numSets };
}

// ── Did the match actually finish? ───────────────────────────────────────────
// Two separate ESPN concepts, deliberately kept apart:
//
//   NOT FINAL  (postponed / suspended / canceled / delayed) — the match is not
//              over at all. Handled by the callers' own status gate, which
//              holds the row out of 'post' so nothing grades. Not this file.
//
//   ENDED EARLY (retired / walkover / defaulted / withdrawn) — ESPN reports
//              completed:true and a winner, but the match never played out.
//              Gradeable as final for display, yet no book settles a side
//              market on it. That is what these helpers detect.
const ENDED_EARLY_RE = /retire|walk.?over|walkover|default|withdraw|conced/i;

// True when ESPN's status name/description says the match stopped early.
// Accepts 'STATUS_RETIRED', 'Retired', 'Walkover', etc.
function endedEarlyStatus(statusName) {
  return ENDED_EARLY_RE.test(String(statusName || ''));
}

// The structural backstop, and the more important of the two checks: a real
// completed match ALWAYS has a winner holding at least 2 completed sets (every
// tour format is best-of-3 or best-of-5). So a 'final' whose leader holds fewer
// than 2 sets did not play out, whatever ESPN calls it. This catches retirements
// even when the status string is missing, stale, or a name we have never seen —
// the failure mode that produced the Darderi grade cannot recur behind a new
// label.
const SETS_TO_WIN_MINIMUM = 2;

// Does this scoreboard show a match somebody actually WON?
// `sets` = { homeSetsWon, awaySetsWon }.
function hasMatchWinner(sets) {
  const h = Number(sets?.homeSetsWon) || 0;
  const a = Number(sets?.awaySetsWon) || 0;
  return Math.max(h, a) >= SETS_TO_WIN_MINIMUM;
}

// Classification used by the AUDIT and the repair pass: this match did not play
// out, by status or by structure.
//
// Grading deliberately does NOT collapse these two signals into one action.
// An explicit status is a fact about the match, so it voids. A failed structural
// check with a "final" status is a fact about the PAYLOAD — ESPN tennis
// occasionally flips a live match to completed carrying a partial linescore —
// so grading holds those pending and re-checks, rather than burning a void onto
// a match that is still being played.
function matchEndedEarly(sets, statusName) {
  return endedEarlyStatus(statusName) || !hasMatchWinner(sets);
}

module.exports = {
  setDone,
  countSets,
  endedEarlyStatus,
  hasMatchWinner,
  matchEndedEarly,
  ENDED_EARLY_RE,
  SETS_TO_WIN_MINIMUM,
};
