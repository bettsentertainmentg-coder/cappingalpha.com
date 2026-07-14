// src/sport_page.js — Phase 5c per-sport landing pages (/mlb, /nba, ... /mma).
// One data-driven template shared by all 11 pages. Server-rendered from local
// SQLite on every request (reads are cheap); the only network awaits are the
// cached sport headlines and, on the MMA page, cached Kalshi fight prices, and
// both sit behind a short timeout so a slow fetch can never hang the page.
// Called from the per-slug routes registered in index.js (above /:sport/:slug).

const db = require('./db');
const { buildNav, esc } = require('./detail_page');
const { getLinesForGame } = require('./lines_scraper');
const { americanToDecimal } = require('./odds_math');
const { getSportHeadlines } = require('./headlines');
const { OFFSHORE_BOOKS } = require('./odds_ingest');
const { ET_OFFSET_MS } = require('./cycle');

// ── Small helpers ─────────────────────────────────────────────────────────────

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// YYYY-MM-DD of "now" in ET (ET_OFFSET_MS handles DST).
function etTodayIso() {
  return new Date(Date.now() - ET_OFFSET_MS).toISOString().slice(0, 10);
}

// ET calendar day of a UTC ISO start_time.
function etDayOf(startTime) {
  const t = Date.parse(startTime || '');
  if (!Number.isFinite(t)) return '';
  return new Date(t - ET_OFFSET_MS).toISOString().slice(0, 10);
}

function etTimeStr(startTime) {
  if (!startTime) return '';
  try {
    return new Date(startTime).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    }) + ' ET';
  } catch (_) { return ''; }
}

function fmtOdds(o) {
  if (o == null || isNaN(parseFloat(o))) return null;
  const n = parseFloat(o);
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtSpread(v) {
  if (v == null || isNaN(parseFloat(v))) return null;
  const n = parseFloat(v);
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtShortDate(d) {
  if (!d) return '';
  try {
    return new Date(String(d).slice(0, 10) + 'T12:00:00Z')
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  } catch (_) { return String(d).slice(0, 10); }
}

function relTime(iso) {
  const ms = Date.now() - Date.parse(iso || '');
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60)  return `${Math.max(m, 1)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Book display names — the ONE helper every rendered book name routes ──────
// through (future hook: swap a plain name for an affiliate link per book).
// Offshore books carry the same small tag vocabulary as the game detail page.
const BOOK_LABEL = {
  draftkings: 'DraftKings', fanduel: 'FanDuel', betrivers: 'BetRivers',
  caesars: 'Caesars', betmgm: 'BetMGM', hardrock: 'Hard Rock', bet365: 'bet365',
  bovada: 'Bovada', betonline: 'BetOnline', pinnacle: 'Pinnacle',
  thunderpick: 'Thunderpick', mybookie: 'MyBookie', betus: 'BetUS',
};
function bookNameHtml(bookKey) {
  const key  = String(bookKey || '').toLowerCase();
  const name = BOOK_LABEL[key] || (key.charAt(0).toUpperCase() + key.slice(1));
  const tag  = OFFSHORE_BOOKS.has(key)
    ? ` <span class="sp-offshore" title="Offshore book. Line shown for information only.">offshore</span>`
    : '';
  return esc(name) + tag;
}

// ── Per-sport copy (house style: no em dashes, humble tone) ───────────────────
const INFO = {
  mlb: {
    tagline: 'Daily MLB picks, line shopping, and market data through the full season.',
    body: 'CappingAlpha scans capper picks every day of the MLB season and scores each one against the live board. Schedules and scores come from ESPN, betting lines come from The Odds API and a nightly odds engine, and public betting splits come from ActionNetwork. Moneylines, run lines, and totals are all tracked, and probable pitchers plus weather show up on every game page.',
  },
  nba: {
    tagline: 'NBA picks ranked nightly, with line movement and public betting context.',
    body: 'Every NBA slate gets the full treatment: capper picks are extracted, scored, and ranked, then matched to live ESPN scores. We track moneylines, spreads, and totals across several books, along with DraftKings line movement and prediction market prices from Polymarket and Kalshi. Home teams get a small scoring bonus since home court tends to matter in the NBA.',
  },
  wnba: {
    tagline: 'WNBA coverage with the same pick tracking as the men\'s game.',
    body: 'WNBA games run through the same pipeline as every other league: picks are scored, ranked, and settled against final scores from ESPN. Lines come from ESPN\'s free DraftKings feed rather than a paid odds service. One scoring quirk: WNBA picks get the home bonus but no sport bonus, so they tend to score slightly lower than NBA picks from the same channel.',
  },
  nfl: {
    tagline: 'NFL picks, spreads, and totals tracked from the opening line to kickoff.',
    body: 'During the season, NFL picks are pulled daily, scored, and ranked against the board. We follow moneylines, spreads, and totals across multiple books, plus public betting percentages and line history so you can see where the market moved. Weather from OpenMeteo shows on outdoor games, which can matter for totals.',
  },
  nhl: {
    tagline: 'NHL picks and puck lines, scored and settled every night.',
    body: 'NHL coverage runs nightly through the regular season and playoffs. Picks are extracted from tracked cappers, scored on our point system, and settled automatically when ESPN marks the game final. Moneylines, puck lines, and totals are compared across books so the strongest available price is easy to spot.',
  },
  ncaaf: {
    tagline: 'College football picks and lines across the FBS slate.',
    body: 'College football Saturdays produce big pick volume, and every play gets scored and ranked the same way as the pros. We track moneylines, spreads, and totals, plus public betting splits on the bigger games. Lines can move fast in college markets, so the line history on each game page is worth a look before kickoff.',
  },
  cbb: {
    tagline: 'College basketball picks through the regular season and the tournament.',
    body: 'College hoops picks are extracted daily, matched to the ESPN slate, and scored on the same point system as every other sport. Moneylines, spreads, and totals are tracked across books. With hundreds of teams, market prices can vary more than in pro sports, which makes line shopping especially useful here.',
  },
  tennis: {
    tagline: 'ATP and WTA picks from the biggest tournaments, tracked match by match.',
    body: 'Tennis coverage includes ATP and WTA events at the top tiers only: Grand Slams, Masters and 1000s, 500s, and the Finals. Picks are matched to players rather than teams, and moneylines and totals are the main markets since spreads are rarely posted. Tennis picks get no home bonus, since home court advantage does not really apply on tour.',
  },
  golf: {
    tagline: 'Tournament golf picks with live leaderboards each week.',
    body: 'Golf picks are tracked per player across each week\'s tournaments, including head-to-head and matchup bets. Leaderboards refresh from ESPN throughout every round. There are no home teams in golf, so no home bonus applies; picks are scored on their source and the sport bonus. We do not pull betting lines for golf, so the focus here is the picks and the leaderboard.',
  },
  soccer: {
    tagline: 'Soccer picks and three-way lines across the top competitions.',
    body: 'Soccer coverage spans the major leagues and tournaments on ESPN\'s board, including World Cup matches when they run. A key difference from American sports: soccer moneylines are three-way, so a draw loses both team sides. That makes soccer moneyline records read a bit differently, and it is worth keeping in mind when comparing prices.',
  },
  mma: {
    tagline: 'Fight cards, moneylines, and market prices for UFC, MMA, and boxing.',
    body: 'Fight coverage combines ESPN\'s UFC schedule with cards relayed by our odds engine, including boxing and non-UFC promotions. Fighter moneylines are the main market, with reference prices from Kalshi\'s prediction markets shown alongside. Like tennis and golf, there is no home team in a fight, so no home bonus applies.',
  },
};

// ── Data readers ──────────────────────────────────────────────────────────────

// Today's (ET) games for the page's sport labels. today_games also carries
// forward days (forward_games.js), so filter to the ET day in JS.
function todaysGames(sports) {
  const ph = sports.map(() => '?').join(',');
  const today = etTodayIso();
  return db.prepare(
    `SELECT * FROM today_games WHERE sport IN (${ph}) ORDER BY start_time ASC, id ASC`
  ).all(...sports).filter(g => etDayOf(g.start_time) === today);
}

// Golf: current + upcoming tournaments with their leaderboards.
function golfTournaments() {
  return db.prepare(
    `SELECT * FROM golf_tournaments WHERE status IN ('pre', 'in')
     ORDER BY CASE status WHEN 'in' THEN 0 ELSE 1 END, start_date ASC`
  ).all();
}

// MMA/Boxing: odds-engine fight rows inside today's ET window. Same windowing as
// track_schedule.js engineEventsFor: start_time is UTC ISO, so an 11:30pm ET
// fight lands on the next UTC date; match on the ET day's UTC window instead.
function engineFightsToday() {
  const dayIso = etTodayIso();
  try {
    const dayStartMs = Date.parse(`${dayIso}T00:00:00Z`) + ET_OFFSET_MS;
    const startUtc = new Date(dayStartMs).toISOString();
    const endUtc   = new Date(dayStartMs + 24 * 3600 * 1000).toISOString();
    return db.prepare(
      `SELECT sport, home_team, away_team, start_time FROM engine_events
       WHERE start_time >= ? AND start_time < ? ORDER BY start_time ASC`
    ).all(startUtc, endUtc);
  } catch (_) { return []; }
}

// MVP picks + all-time record for the page's sports (case-insensitive labels).
function mvpForSports(sports) {
  const ph = sports.map(() => '?').join(',');
  const picks = db.prepare(
    `SELECT * FROM mvp_picks WHERE sport COLLATE NOCASE IN (${ph})
     ORDER BY game_date DESC, saved_at DESC LIMIT 8`
  ).all(...sports);
  const rows = db.prepare(
    `SELECT result, COUNT(*) AS c FROM mvp_picks
     WHERE sport COLLATE NOCASE IN (${ph}) AND result IN ('win', 'loss', 'push')
     GROUP BY result`
  ).all(...sports);
  const record = { win: 0, loss: 0, push: 0 };
  for (const r of rows) record[r.result] = r.c;
  return { picks, record };
}

// ── Line shopping board ───────────────────────────────────────────────────────

// Best moneyline for one side across all stored books (highest decimal odds).
function bestMl(lines, side) {
  let best = null;
  for (const [book, src] of Object.entries(lines || {})) {
    if (!src) continue;
    const dec = americanToDecimal(src[side]);
    if (dec == null) continue;
    if (!best || dec > best.dec) best = { book, dec, american: src[side] };
  }
  return best;
}

// Best home spread across books. book_lines stores no per-book spread juice, so
// "best" here is the most favorable number of points for the home side.
function bestSpreadHome(lines) {
  let best = null;
  for (const [book, src] of Object.entries(lines || {})) {
    if (!src || src.spread_home == null || isNaN(parseFloat(src.spread_home))) continue;
    const value = parseFloat(src.spread_home);
    if (!best || value > best.value) best = { book, value };
  }
  return best;
}

// Best Over price across books (highest decimal juice). Books that carry a total
// but no stored juice only serve as a fallback when nothing has juice.
function bestOver(lines) {
  let best = null, lineOnly = null;
  for (const [book, src] of Object.entries(lines || {})) {
    if (!src || src.over_under == null || isNaN(parseFloat(src.over_under))) continue;
    const dec = americanToDecimal(src.ou_over_odds);
    if (dec != null) {
      if (!best || dec > best.dec) best = { book, dec, line: src.over_under, american: src.ou_over_odds };
    } else if (!lineOnly) {
      lineOnly = { book, line: src.over_under, american: null };
    }
  }
  return best || lineOnly;
}

function buildBoard(games) {
  // Board capped at 15 rows. Games with no stored lines don't count against the
  // cap (a big tennis slate often has lines only on its featured matches).
  const rows = [];
  for (const g of games) {
    if (rows.length >= 15) break;
    const lines = getLinesForGame(g.espn_game_id);
    const mlHome = bestMl(lines, 'ml_home');
    const mlAway = bestMl(lines, 'ml_away');
    const spread = bestSpreadHome(lines);
    const over   = bestOver(lines);
    if (!mlHome && !mlAway && !spread && !over) continue;
    rows.push({ game: g, mlHome, mlAway, spread, over });
  }
  return rows;
}

// ── Section renderers ─────────────────────────────────────────────────────────

function gamesSectionHtml(label, games) {
  const rows = games.map(g => {
    const status = (g.status || 'pre').toLowerCase();
    let right;
    if (status === 'in') {
      right = `<span class="sp-live">LIVE</span> <span class="ca-num">${esc(g.away_score ?? 0)}-${esc(g.home_score ?? 0)}</span>`;
    } else if (status === 'post') {
      right = `<span class="ca-num">${esc(g.away_score ?? '')}-${esc(g.home_score ?? '')}</span> <span class="sp-final">Final</span>`;
    } else {
      right = `<span class="ca-num">${esc(etTimeStr(g.start_time))}</span>`;
    }
    const mlAway = fmtOdds(g.ml_away);
    const mlHome = fmtOdds(g.ml_home);
    const oddsLine = (mlAway || mlHome)
      ? `<div class="sp-odds ca-num">${esc(g.away_short || g.away_team || '')} ${esc(mlAway || '—')} · ${esc(g.home_short || g.home_team || '')} ${esc(mlHome || '—')}</div>`
      : '';
    return `<a class="sp-game-row" href="/game/${esc(g.espn_game_id)}">
      <div class="sp-game-main">
        <div class="sp-matchup">${esc(g.away_team || 'Away')} @ ${esc(g.home_team || 'Home')}</div>
        ${oddsLine}
      </div>
      <div class="sp-game-status">${right}</div>
    </a>`;
  }).join('\n');

  const body = games.length
    ? `<div class="sp-games">${rows}</div>`
    : `<div class="sp-empty">No ${esc(label)} games on the board today.</div>`;

  return `<section class="sp-section">
    <h2 class="sp-h2">Today's games</h2>
    ${body}
  </section>`;
}

function golfSectionHtml(tournaments) {
  if (!tournaments.length) {
    return `<section class="sp-section">
      <h2 class="sp-h2">This week's tournaments</h2>
      <div class="sp-empty">No golf tournaments on the board right now.</div>
    </section>`;
  }
  const cards = tournaments.map(t => {
    let leaders = [];
    try { leaders = (JSON.parse(t.leaderboard_json || '[]') || []).slice(0, 5); } catch (_) {}
    const live = (t.status || '') === 'in';
    const place = [t.course, t.city].filter(Boolean).join(', ');
    const dates = [fmtShortDate(t.start_date), fmtShortDate(t.end_date)].filter(Boolean).join(' to ');
    const lb = leaders.length ? `<table class="sp-table sp-golf-lb">
      <thead><tr><th>Pos</th><th>Player</th><th>Score</th><th>Thru</th></tr></thead>
      <tbody>${leaders.map((p, i) => `<tr>
        <td class="ca-num">${esc(p.position && p.position !== '—' ? p.position : i + 1)}</td>
        <td>${esc(p.player?.fullName || p.player?.shortName || '')}</td>
        <td class="ca-num">${esc(p.score ?? '')}</td>
        <td class="ca-num">${esc(p.thru ?? '')}</td>
      </tr>`).join('\n')}</tbody>
    </table>` : '';
    return `<div class="sp-card">
      <div class="sp-card-title">${esc(t.name)} ${live ? '<span class="sp-live">LIVE</span>' : '<span class="sp-soon">Upcoming</span>'}</div>
      <div class="sp-card-sub">${esc(place)}${place && dates ? ' · ' : ''}${esc(dates)}</div>
      ${lb}
    </div>`;
  }).join('\n');
  return `<section class="sp-section">
    <h2 class="sp-h2">This week's tournaments</h2>
    ${cards}
  </section>`;
}

function mmaSectionHtml(engineFights, kalshiFights) {
  const fightRows = engineFights.map(f => `<div class="sp-game-row sp-static">
    <div class="sp-game-main">
      <div class="sp-matchup">${esc(f.away_team)} vs ${esc(f.home_team)}</div>
      <div class="sp-odds">${esc(f.sport)}</div>
    </div>
    <div class="sp-game-status"><span class="ca-num">${esc(etTimeStr(f.start_time))}</span></div>
  </div>`).join('\n');

  const kalshiRows = kalshiFights.map(ev => {
    const [a, b] = ev.outcomes;
    return `<div class="sp-game-row sp-static">
      <div class="sp-game-main">
        <div class="sp-matchup">${esc(a.name)} <span class="ca-num">${esc(fmtOdds(a.american) || '')}</span> vs ${esc(b.name)} <span class="ca-num">${esc(fmtOdds(b.american) || '')}</span></div>
        ${ev.title ? `<div class="sp-odds">${esc(ev.title)}</div>` : ''}
      </div>
      <div class="sp-game-status"><span class="sp-soon">${esc(ev.sport)}</span></div>
    </div>`;
  }).join('\n');

  const parts = [];
  parts.push(engineFights.length
    ? `<div class="sp-games">${fightRows}</div>`
    : `<div class="sp-empty">No fights on the board today.</div>`);
  if (kalshiFights.length) {
    parts.push(`<h3 class="sp-h3">Fight prices (Kalshi prediction market)</h3>
    <div class="sp-games">${kalshiRows}</div>`);
  }
  return `<section class="sp-section">
    <h2 class="sp-h2">Today's fights</h2>
    ${parts.join('\n')}
  </section>`;
}

function boardSectionHtml(board) {
  if (!board.length) return '';
  const cell = (best, valueHtml) => best
    ? `<div class="sp-best">${valueHtml}<span class="sp-book">${bookNameHtml(best.book)}</span></div>`
    : '<span class="sp-dash">—</span>';
  const rows = board.map(({ game: g, mlHome, mlAway, spread, over }) => `<tr>
    <td class="sp-board-game"><a href="/game/${esc(g.espn_game_id)}">${esc(g.away_short || g.away_team || '')} @ ${esc(g.home_short || g.home_team || '')}</a></td>
    <td>${cell(mlHome, mlHome ? `<span class="ca-num">${esc(fmtOdds(mlHome.american))}</span>` : '')}</td>
    <td>${cell(mlAway, mlAway ? `<span class="ca-num">${esc(fmtOdds(mlAway.american))}</span>` : '')}</td>
    <td>${cell(spread, spread ? `<span class="ca-num">${esc(fmtSpread(spread.value))}</span>` : '')}</td>
    <td>${cell(over, over ? `<span class="ca-num">o${esc(over.line)}${over.american != null ? ' ' + esc(fmtOdds(over.american)) : ''}</span>` : '')}</td>
  </tr>`).join('\n');
  return `<section class="sp-section">
    <h2 class="sp-h2">Line shopping</h2>
    <div class="sp-note">Best available price per market across every book we track. Offshore books are shown for information only.</div>
    <div class="sp-scroll"><table class="sp-table sp-board">
      <thead><tr><th>Game</th><th>Home ML</th><th>Away ML</th><th>Spread (home)</th><th>Total (over)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

// Selection label for an MVP row, modeled on results_page.js pickStr.
function mvpPickStr(p) {
  const type = (p.pick_type || '').toLowerCase();
  const team = p.team || '';
  const spread = p.spread != null ? p.spread : null;
  const spreadFmt = spread != null ? (spread > 0 ? `+${spread}` : `${spread}`) : null;
  if (type === 'over' || type === 'under') {
    const total = spread != null ? Math.abs(parseFloat(spread)) : null;
    const lbl = type === 'over' ? 'Over' : 'Under';
    return total != null ? `${lbl} ${total}` : lbl;
  }
  if (type === 'ml') return team ? `${team} ML` : 'Moneyline';
  if (type === 'spread' || type === 'set_spread') {
    return team ? `${team} ${spreadFmt || ''}`.trim() : (spreadFmt || 'Spread');
  }
  if (team) return spreadFmt ? `${team} ${spreadFmt}` : team;
  return p.pick_type || '—';
}

function mvpSectionHtml(label, slug, picks, record) {
  if (!picks.length && slug === 'mma') return '';
  const decided = record.win + record.loss;
  const recordStr = `${record.win}-${record.loss}${record.push ? `-${record.push}` : ''}`;
  const rateStr = decided > 0 ? ` (${Math.round((record.win / decided) * 100)}% on decided picks)` : '';
  const recordLine = (record.win + record.loss + record.push) > 0
    ? `<div class="sp-note">All-time ${esc(label)} MVP record: <strong class="ca-num">${esc(recordStr)}</strong>${esc(rateStr)}</div>`
    : '';
  const body = picks.length
    ? `<div class="sp-scroll"><table class="sp-table">
      <thead><tr><th>Date</th><th>Pick</th><th>Type</th><th>Result</th></tr></thead>
      <tbody>${picks.map(p => {
        const r = (p.result || 'pending').toLowerCase();
        const pillCls = r === 'win' ? 'win' : r === 'loss' ? 'loss' : r === 'push' ? 'push' : 'pending';
        const pillTxt = r === 'pending' ? 'PENDING' : r.toUpperCase();
        return `<tr>
          <td class="ca-num">${esc(fmtShortDate(p.game_date || p.saved_at))}</td>
          <td class="sp-pick">${esc(mvpPickStr(p))}</td>
          <td>${esc((p.pick_type || '').toUpperCase())}</td>
          <td><span class="sp-pill ${pillCls}">${pillTxt}</span></td>
        </tr>`;
      }).join('\n')}</tbody>
    </table></div>`
    : `<div class="sp-empty">MVP picks for ${esc(label)} appear here once they hit the board.</div>`;
  return `<section class="sp-section">
    <h2 class="sp-h2">Recent MVP picks</h2>
    ${recordLine}
    ${body}
  </section>`;
}

function infoSectionHtml(label, info) {
  return `<section class="sp-section">
    <h2 class="sp-h2">How CappingAlpha covers ${esc(label)}</h2>
    <p class="sp-info">${esc(info.body)}</p>
  </section>`;
}

function headlinesSectionHtml(label, headlines) {
  if (!headlines.length) return '';
  const items = headlines.slice(0, 6).map(h => `<a class="sp-headline" href="${esc(h.url)}" target="_blank" rel="noopener nofollow">
    <div class="sp-headline-title">${esc(h.title)}</div>
    <div class="sp-headline-meta">${esc(h.source || 'News')}${relTime(h.publishedAt) ? ' · ' + esc(relTime(h.publishedAt)) : ''}</div>
  </a>`).join('\n');
  return `<section class="sp-section">
    <h2 class="sp-h2">${esc(label)} betting headlines</h2>
    <div class="sp-headlines">${items}</div>
  </section>`;
}

// ── Auth modals (same markup as the detail page, so /modules/auth.js works) ───
// The "Sign up" link routes straight to the unlock page: openSignup() depends on
// the SPA's switchTab, which doesn't exist here.
function authModalsHtml() {
  return `
  <div id="login-modal" class="modal-overlay hidden" onclick="if(event.target===this)closeLogin()">
    <div class="modal-card">
      <button class="modal-close" onclick="closeLogin()">&#x2715;</button>
      <h2>Log In</h2>
      <div class="form-error" id="login-error"></div>
      <div id="login-form-inner">
        <div class="form-group"><label>Email or Username</label><input type="text" id="login-email" autocomplete="username" /></div>
        <div class="form-group"><label>Password</label><input type="password" id="login-password" autocomplete="current-password" /></div>
        <button class="btn btn-primary btn-block" onclick="doLogin()">Log In</button>
        <div class="form-footer" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;">
          <span>Don't have an account? <a href="/#unlock" style="cursor:pointer;color:var(--accent-brand);">Sign up</a></span>
          <a onclick="showForgotPassword()" style="cursor:pointer;color:var(--accent-brand);">Forgot password?</a>
        </div>
      </div>
      <div id="login-forgot-inner" style="display:none;">
        <div class="form-group"><label>Your account email</label><input type="email" id="forgot-email" autocomplete="email" /></div>
        <div class="form-success" id="forgot-success" style="color:var(--accent-win);font-size:13px;margin-bottom:10px;display:none;">Check your email for a reset link.</div>
        <button class="btn btn-primary btn-block" onclick="doForgotPassword()">Send Reset Link</button>
        <div class="form-footer"><a onclick="showLoginForm()" style="cursor:pointer;color:var(--accent-brand);">Back to log in</a></div>
      </div>
    </div>
  </div>
  <div id="signup-modal" class="modal-overlay hidden" onclick="if(event.target===this)closeSignup()">
    <div class="modal-card">
      <button class="modal-close" onclick="closeSignup()">&#x2715;</button>
      <h2>Create Account</h2>
      <div class="form-error" id="signup-error"></div>
      <div class="form-footer">Accounts are created on the <a href="/#unlock" style="color:var(--accent-brand);">unlock page</a>.</div>
    </div>
  </div>`;
}

// ── Page-specific CSS (nav/buttons/modals come from game-detail.css) ─────────
const PAGE_CSS = `
.sp-wrap { max-width: 960px; margin: 0 auto; padding: 30px 16px 80px; }
.sp-hero h1 { font-size: 27px; font-weight: 800; letter-spacing: -0.3px; line-height: 1.25; }
.sp-hero-date { color: var(--text-tertiary); font-size: 13px; margin-top: 6px; }
.sp-tagline { color: var(--text-secondary); margin-top: 10px; max-width: 660px; font-size: 15px; }
.sp-section { margin-top: 38px; }
.sp-h2 { font-size: 17px; font-weight: 700; margin-bottom: 12px; }
.sp-h3 { font-size: 14px; font-weight: 700; margin: 18px 0 10px; color: var(--text-secondary); }
.sp-note { color: var(--text-tertiary); font-size: 13px; margin-bottom: 12px; }
.sp-empty { color: var(--muted); font-size: 14px; padding: 18px 0; }
.sp-games { display: flex; flex-direction: column; gap: 8px; }
.sp-game-row { display: flex; align-items: center; gap: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; text-decoration: none; color: var(--text); }
a.sp-game-row:hover { border-color: var(--accent); }
.sp-game-row.sp-static { cursor: default; }
.sp-game-main { min-width: 0; }
.sp-matchup { font-weight: 600; font-size: 14.5px; }
.sp-odds { color: var(--text-tertiary); font-size: 12.5px; margin-top: 3px; }
.sp-game-status { margin-left: auto; flex-shrink: 0; font-size: 13px; color: var(--text-secondary); display: flex; align-items: center; gap: 7px; }
.sp-live { color: var(--accent-live); font-weight: 800; font-size: 10.5px; letter-spacing: .06em; }
.sp-final { color: var(--text-tertiary); font-size: 12px; font-weight: 700; }
.sp-soon { color: var(--text-tertiary); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.sp-scroll { overflow-x: auto; }
.sp-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.sp-table thead th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-tertiary); padding: 9px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.sp-table tbody td { padding: 10px 10px; border-bottom: 1px solid var(--border-tertiary); color: var(--text-secondary); vertical-align: top; }
.sp-board-game a { color: var(--text); font-weight: 600; text-decoration: none; white-space: nowrap; }
.sp-board-game a:hover { color: var(--accent); }
.sp-best { display: flex; flex-direction: column; gap: 2px; }
.sp-book { font-size: 11px; color: var(--text-tertiary); }
.sp-dash { color: var(--text-disabled); }
.sp-offshore { display: inline-block; margin-left: 5px; padding: 1px 6px; border: 1px solid var(--text-disabled); border-radius: 4px; font-size: 9px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--text-tertiary); vertical-align: middle; }
.sp-pick { font-weight: 600; color: var(--text); }
.sp-pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: .04em; }
.sp-pill.win { background: rgba(34,197,94,.14); color: var(--green); }
.sp-pill.loss { background: rgba(239,68,68,.14); color: var(--red); }
.sp-pill.push { background: rgba(136,146,164,.16); color: var(--muted); }
.sp-pill.pending { background: rgba(59,130,246,.12); color: var(--accent); }
.sp-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.sp-card-title { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sp-card-sub { color: var(--text-tertiary); font-size: 12.5px; margin-top: 3px; }
.sp-golf-lb { margin-top: 12px; }
.sp-info { color: var(--text-secondary); max-width: 720px; line-height: 1.65; }
.sp-headlines { display: flex; flex-direction: column; gap: 4px; }
.sp-headline { display: block; padding: 10px 12px; border-radius: 8px; text-decoration: none; }
.sp-headline:hover { background: var(--surface); }
.sp-headline-title { color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.4; }
.sp-headline-meta { color: var(--text-tertiary); font-size: 12px; margin-top: 2px; }
.sp-footer { margin-top: 56px; border-top: 1px solid var(--border); padding-top: 18px; color: var(--text-tertiary); font-size: 12px; line-height: 1.7; }
.sp-footer a { color: var(--text-tertiary); }
.sp-footer a:hover { color: var(--accent); }
`;

// ── Main builder ──────────────────────────────────────────────────────────────

async function buildSportPageHtml(pageDef, opts = {}) {
  const { slug, label, sports } = pageDef;
  const user = opts.user || null;
  const info = INFO[slug] || { tagline: `${label} coverage on CappingAlpha.`, body: '' };
  const isGolf = slug === 'golf';
  const isMma  = slug === 'mma';

  // ── Gather data (SQLite is synchronous; only headlines/Kalshi await) ──
  const games = (!isGolf && !isMma) ? todaysGames(sports) : [];
  const board = (!isGolf && !isMma) ? buildBoard(games) : [];
  const tournaments = isGolf ? golfTournaments() : [];
  const engineFights = isMma ? engineFightsToday() : [];

  let kalshiFights = [];
  if (isMma) {
    try {
      const { getKalshiEventOdds } = require('./kalshi_events');
      const all = await withTimeout(getKalshiEventOdds().catch(() => []), 2500, []);
      kalshiFights = (all || []).filter(e => e.kind === 'fight' && Array.isArray(e.outcomes) && e.outcomes.length === 2);
    } catch (_) { kalshiFights = []; }
  }

  const { picks: mvpPicks, record } = mvpForSports(sports);
  const headlines = await withTimeout(getSportHeadlines(label).catch(() => []), 2500, []);

  // ── SEO ──
  const title = `${label} Betting Picks, Lines and Odds · CappingAlpha`;
  const desc = `${label} betting on CappingAlpha: today's slate, line shopping across the books we track, MVP pick history, and the latest ${label} betting headlines. ${info.tagline}`;
  const canonical = `https://cappingalpha.com/${slug}`;
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description: desc,
    url: canonical,
    isPartOf: { '@type': 'WebSite', name: 'CappingAlpha', url: 'https://cappingalpha.com/' },
    publisher: { '@type': 'Organization', name: 'CappingAlpha', url: 'https://cappingalpha.com/' },
  });

  const todayLong = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  });

  // ── Sections ──
  const sections = [];
  if (isGolf)      sections.push(golfSectionHtml(tournaments));
  else if (isMma)  sections.push(mmaSectionHtml(engineFights, kalshiFights));
  else             sections.push(gamesSectionHtml(label, games));
  if (!isGolf && !isMma) sections.push(boardSectionHtml(board));
  sections.push(mvpSectionHtml(label, slug, mvpPicks, record));
  sections.push(infoSectionHtml(label, info));
  sections.push(headlinesSectionHtml(label, headlines));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${esc(title)}</title>
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <meta property="og:site_name" content="CappingAlpha" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:image" content="https://cappingalpha.com/ca-logo.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="https://cappingalpha.com/ca-logo.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Sans+Pro:wght@300;400;600;700;900&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
  <link rel="stylesheet" href="/game-detail.css?v=2" />
  <style>${PAGE_CSS}</style>
  <script type="application/ld+json">${jsonLd}</script>
</head>
<body>

${buildNav(user)}

<div class="sp-wrap">
  <header class="sp-hero">
    <h1>${esc(label)} Betting Picks, Lines and Odds</h1>
    <div class="sp-hero-date ca-num">${esc(todayLong)} (ET)</div>
    <p class="sp-tagline">${esc(info.tagline)}</p>
  </header>

  ${sections.filter(Boolean).join('\n\n  ')}

  <footer class="sp-footer">
    <div>CappingAlpha never wagers on any game. All scores are hypothetical and for entertainment purposes only.</div>
    <div><a href="/">Home</a> · <a href="/results">Track Record</a> · <a href="/faq">FAQ</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></div>
  </footer>
</div>

${authModalsHtml()}

<script type="module">
  import { openLogin, closeLogin, doLogin, openSignup, closeSignup, doSignup,
           doLogout, showForgotPassword, showLoginForm, doForgotPassword } from '/modules/auth.js';
  Object.assign(window, { openLogin, closeLogin, doLogin, openSignup, closeSignup,
                          doSignup, doLogout, showForgotPassword, showLoginForm, doForgotPassword });
</script>
</body>
</html>`;
}

module.exports = { buildSportPageHtml };
