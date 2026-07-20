// src/pick_privacy.js — strips the proprietary scoring model + raw source columns
// from any pick / pick_history / golf_picks row before it leaves the server.
//
// The CA rankings algorithm is a trade secret: which Discord channel a pick came
// from, that channel's weight, and the per-bonus decomposition (sport/home) must
// never reach a client, nor may the raw scanned message. Every pick-serving
// endpoint used to return the raw DB row (SELECT * / p.*) and only redact `score`,
// so these columns leaked. The frontend reads NONE of them, so removing them is
// behavior-preserving for the UI.
//
// capper_name is business-gated, not a model secret: paid users are meant to see
// which capper a pick came from; free/logged-out users are not. Callers pass
// { paid } (from auth.isPaid(req)) so the tier decides.

const MODEL_COLS = [
  'channel', 'channel_weight', 'channel_points',
  'sport_bonus', 'home_bonus',
  // per-channel mention counters reveal the source taxonomy (storage no longer
  // writes them, but old rows still carry them through SELECT p.*)
  'free_plays_mentions', 'community_mentions', 'pod_mentions',
  'raw_message', 'messages_json',
  // v3 internals: the true score + leak state must never ship (leak_target would
  // reveal the real score before the conviction curve finishes ramping).
  'v3_total', 'v3_json', 'score_breakdown', 'sources_json',
  'display_score', 'leak_target', 'leak_started_at', 'leak_window_sec',
];

function publicPick(p, { paid = false } = {}) {
  if (!p || typeof p !== 'object') return p;
  const out = { ...p };
  for (const c of MODEL_COLS) delete out[c];
  if (!paid) delete out.capper_name;
  return out;
}

function publicPicks(arr, opts) {
  return Array.isArray(arr) ? arr.map((p) => publicPick(p, opts)) : arr;
}

module.exports = { publicPick, publicPicks, MODEL_COLS };
