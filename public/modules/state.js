// modules/state.js — Shared mutable app state

export const REFRESH_MS = 5 * 60 * 1000;

export const state = {
  currentUser:   null,
  CONFIG:        { mvp_threshold: 50 },
  allPicks:      [],
  mvpData:       null,
  homeMvpPicks:  null,
  mvpLoaded:     false,
  mvpLoadedPaid: null,   // tier the CA Picks tab last rendered for (true=paid view, false=public/limited). Lets us re-sync after auth resolves.
  sportsLoaded:  false,
  esportsLoaded: false,
  leaderboardLoaded: false,
  leaderboardWindow: 'week',
  leaderboardView:   'board', // 'board' | 'friends'
  activeSport:   'MLB',
  graphDays:     Infinity,
};
