// src/pick_cutoff.js
// THE START-OF-MATCH LOCK. Jack's rule 2: "picks are tallied up throughout the
// day. EVERYTHING STOPS AT THE START OF THE MATCH."
//
// One helper answers "has this game started?" and every gate in the product
// calls it: board mentions (storage.savePick), tracked-bet creation
// (storage.saveMvpPick), and the boot record-sync migration (index.js).
//
// Before 2026-07-30 this rule was enforced on scraper sources (source_ingest's
// live gate) and on the capper ranking pool, but NOT on the Discord path and
// NOT on the tracked-bet INSERT. 48 of 457 v4-era tracked bets were created
// after their game started; 8 of them outscored the legitimate pregame bet and
// voided it. See docs/RANKINGS_AUDIT_2026_07_30.md.

const db = require('./db');

// ZERO. Jack 2026-07-31: "NOTHING IS TRACKED PAST THAT EVEN IF A CAPPER POSTS
// AT ANY POINT AFTER THAT." There used to be a 5-minute grace here to absorb
// clock skew, and it was a hole: a mention landing inside it still added points
// to a game already in progress. First pitch is now detected within 30 seconds
// (the start watcher in index.js), so there is no skew left to forgive.
const GRACE_MS = 0;

// Sports whose scheduled start time is an ESTIMATE, not a commitment. ESPN
// lists tennis as "not before" and matches routinely go off 30-90 minutes late
// because the previous match on court ran long. For these the clock proves
// nothing — only a status flip, a stamped start, or a live score does.
// Everything else runs to a published schedule, so a passed start time is
// itself proof (and is the backstop when the ESPN status poll lags).
const LOOSE_START_SPORTS = new Set(['ATP', 'WTA', 'Tennis', 'Golf']);

function _ms(ts) {
  if (!ts) return NaN;
  // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' in UTC with no offset.
  // Convert to ISO so new Date() parses it as UTC, not local time.
  const iso = String(ts).includes('T') ? String(ts) : String(ts).replace(' ', 'T') + 'Z';
  return new Date(iso).getTime();
}

// Has this game actually begun? Conservative by design: when in doubt about a
// loose-start sport we say NO (the pick stays eligible) and rely on the
// 30-second start watcher to flip the status within half a minute of first
// serve. For fixed-schedule sports we say YES once the clock passes, because
// there the schedule is real and the status poll is the thing that lags.
function hasGameStarted(game, nowMs = Date.now()) {
  if (!game) return false;
  // 1. ESPN says it is no longer pregame. The strongest signal we have.
  const status = (game.status || '').toLowerCase();
  if (status && status !== 'pre') return true;
  // 2. We stamped a real first-pitch/first-serve time (game_start_tracker).
  if (game.actual_start_at && !Number.isNaN(_ms(game.actual_start_at))) return true;
  // 3. Live play is on the board even though the status has not caught up.
  //
  // SCORE ONLY. `period` is NOT a start signal and must never be added back:
  // ESPN reports period as the period that is NEXT, not the number played, so a
  // pregame MLB game and a pregame tennis match both sit at period = 1 before a
  // ball is thrown. Trusting it judged 45 of 84 pregame games on the board as
  // "already started" on 2026-07-31, which silently blocked EVERY tracked bet
  // on them: Jessica Pegula ML scored 319 on 14 fully-pregame mentions, won,
  // and never reached the record. Verified on the same board: 0 of 84 pregame
  // games carry a nonzero score, so the score check below is safe on its own.
  if ((game.home_score ?? 0) > 0 || (game.away_score ?? 0) > 0) return true;
  // 4. Schedule backstop, fixed-schedule sports only.
  const sport = game.sport || '';
  if (LOOSE_START_SPORTS.has(sport)) return false;
  const startMs = _ms(game.start_time);
  return Number.isFinite(startMs) && startMs <= nowMs;
}

// Board-mention gate. A mention landing after the start is not scoring
// information, it is commentary on a game already in progress, so it must not
// move a pick's total. The 5-minute grace absorbs clock skew between the
// poster and our stamp; it is NOT licence to create a tracked bet (saveMvpPick
// gates on hasGameStarted with no grace).
function isPickAcceptable(game) {
  if (!game) return true;
  return !hasGameStarted(game);
}

function logLatePick(pick) {
  const rm = pick.raw_message;
  if (!rm?.id) return;
  try {
    db.prepare(`
      INSERT OR IGNORE INTO skipped_messages
        (message_id, channel, author, content, reason)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      String(rm.id),
      pick.channel ?? null,
      rm.author ?? null,
      rm.content ?? '',
      'late_post_start'
    );
  } catch (err) {
    console.warn('[pickCutoff] logLatePick error:', err.message);
  }
}

module.exports = {
  isPickAcceptable, hasGameStarted, logLatePick,
  parseGameTs: _ms, GRACE_MS, LOOSE_START_SPORTS,
};
