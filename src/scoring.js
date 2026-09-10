// src/scoring.js
// Receives a clean pick object, returns score + breakdown
// Point system:
//   free-plays channel:        +35
//   pod-thread channel:        +30
//   community-leaks channel:   +10
//   home team bonus:           +5
//   NBA or CBB sport:          +5
//   MLB sport:                 +5
//   NFL or NCAAF sport:        +5
//   NHL sport:                 +5
//   50+ total = MVP

const MVP_THRESHOLD = 50;

const CHANNEL_POINTS = {
  'free-plays':       35,
  'pod-thread':       30,
  'community-leaks':  10,
};

// Entries must be UPPERCASE — scorePick uppercases the sport before the lookup.
// ('Golf' in title case sat here unmatched: golf picks scored without their +5.)
const SPORT_BONUS_SPORTS = new Set(['NBA', 'CBB', 'MLB', 'NFL', 'NCAAF', 'NHL', 'ATP', 'WTA', 'GOLF', 'SOCCER']);

// Tennis + golf have no home-court/course advantage in betting — suppress home bonus
const NO_HOME_BONUS_SPORTS = new Set(['ATP', 'WTA', 'GOLF']);

function scorePick(pick) {
  const mentions = pick.mentions ?? [pick];

  const channel_points = mentions.reduce((sum, m) => sum + (CHANNEL_POINTS[m.channel] ?? 0), 0);

  // Sport bonus and home bonus apply once, derived from the first mention that has them
  const first = mentions[0] ?? {};
  const sport      = (first.sport || '').toUpperCase();
  const sport_bonus = SPORT_BONUS_SPORTS.has(sport) ? 5 : 0;
  // A neutral-site game (a bowl, a kickoff classic, the playoff) has no host, so
  // the home side earns no venue edge. is_home_team itself stays 1 on that slot:
  // it is the side selector every reader uses, so the flag cannot carry this.
  const neutral     = !!(pick.neutral ?? first.neutral);
  const home_bonus  = (first.is_home_team && !neutral && !NO_HOME_BONUS_SPORTS.has(sport)) ? 5 : 0;

  const total  = channel_points + sport_bonus + home_bonus;
  const is_mvp = total >= MVP_THRESHOLD;

  return {
    total,
    is_mvp,
    breakdown: {
      channel_points,
      sport_bonus,
      home_bonus,
    },
  };
}

module.exports = { scorePick, MVP_THRESHOLD, CHANNEL_POINTS };
