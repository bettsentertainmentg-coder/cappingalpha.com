// src/cycle.js
// Shared cycle-date logic used by the scanner and ESPN fetcher.
// The daily cycle runs from 12:30am ET to 4:58am ET the next day.
// If called before 12:30am ET, the cycle is still "yesterday's".

// ET offset: UTC-5 in EST (Nov–Mar), UTC-4 in EDT (Mar–Nov)
// DST in US: second Sunday in March → first Sunday in November
function getEtOffsetMs() {
  const now = new Date();
  const year = now.getUTCFullYear();
  // Second Sunday in March
  const march = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - march.getUTCDay()) % 7, 7)); // 2am ET = 7am UTC
  // First Sunday in November
  const nov = new Date(Date.UTC(year, 10, 1));
  const dstEnd = new Date(Date.UTC(year, 10, (7 - nov.getUTCDay()) % 7 + 1, 6)); // 2am ET = 6am UTC
  const isDST = now >= dstStart && now < dstEnd;
  return (isDST ? 4 : 5) * 60 * 60 * 1000;
}
const ET_OFFSET_MS = getEtOffsetMs();

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Returns YYYY-MM-DD for the current cycle's start date (in ET).
function getCycleDate() {
  const nowET         = new Date(Date.now() - ET_OFFSET_MS);
  const etHour        = nowET.getUTCHours();
  const etMin         = nowET.getUTCMinutes();
  const currentDateET = nowET.toISOString().slice(0, 10);

  // Before 12:30am ET → still in yesterday's cycle
  const beforeCycleEnd = etHour === 0 && etMin < 30;
  return beforeCycleEnd ? addDays(currentDateET, -1) : currentDateET;
}

// Returns { windowStart, windowEnd } as UTC milliseconds.
// Use explicit UTC midnight + offset math to avoid local-timezone double-counting.
function getCycleWindow() {
  const cycleStartDate = getCycleDate();
  const cycleEndDate   = addDays(cycleStartDate, 1);
  return {
    windowStart: new Date(`${cycleStartDate}T00:00:00Z`).getTime() + 30 * 60 * 1000 + ET_OFFSET_MS,               // 12:30am ET
    windowEnd:   new Date(`${cycleEndDate}T00:00:00Z`).getTime()   + (4 * 3600 + 58 * 60) * 1000 + ET_OFFSET_MS,  // 4:58am ET next day
  };
}

module.exports = { getCycleDate, getCycleWindow, ET_OFFSET_MS };
