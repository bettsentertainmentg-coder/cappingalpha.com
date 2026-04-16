// modules/state.js — Shared mutable app state

export const REFRESH_MS = 5 * 60 * 1000;

export const state = {
  currentUser:   null,
  CONFIG:        { mvp_threshold: 50 },
  allPicks:      [],
  mvpData:       null,
  mvpLoaded:     false,
  sportsLoaded:  false,
  esportsLoaded: false,
  activeSport:   'MLB',
  graphDays:     30,
};
