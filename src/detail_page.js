// src/detail_page.js — Builds the full HTML for the standalone game detail page.
// Called from the GET /:sport/:slug route in index.js.
// Server-renders: <head> SEO tags, nav, breadcrumb, game header, sidebar.
// Client-renders: slot picker, detail panel, lines, sentiment, injuries, context.

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// The per-sport pages behind the nav's Sports dropdown (Phase 5c). Order is the
// dropdown order. `sports` = the today_games sport labels each page aggregates.
const SPORT_PAGES = [
  { slug: 'mlb',    label: 'MLB',      sports: ['MLB'] },
  { slug: 'nba',    label: 'NBA',      sports: ['NBA'] },
  { slug: 'wnba',   label: 'WNBA',     sports: ['WNBA'] },
  { slug: 'nfl',    label: 'NFL',      sports: ['NFL'] },
  { slug: 'nhl',    label: 'NHL',      sports: ['NHL'] },
  { slug: 'ncaaf',  label: 'NCAAF',    sports: ['NCAAF'] },
  { slug: 'cbb',    label: 'CBB',      sports: ['CBB'] },
  { slug: 'tennis', label: 'Tennis',   sports: ['ATP', 'WTA'] },
  { slug: 'golf',   label: 'Golf',     sports: ['Golf'] },
  { slug: 'soccer', label: 'Soccer',   sports: ['Soccer'] },
  { slug: 'mma',    label: 'UFC / MMA', sports: ['MMA', 'Boxing'] },
];

function sportSlugDisplay(sport) {
  const map = { ATP:'Tennis', WTA:'Tennis', CBB:'NCAAMB', NCAAF:'NCAAF',
                NBA:'NBA', MLB:'MLB', NHL:'NHL', NFL:'NFL', GOLF:'Golf',
                WNBA:'WNBA', SOCCER:'Soccer' };
  return map[(sport||'').toUpperCase()] || sport || 'Sports';
}

function sportBgColor(sport) {
  const map = {
    NBA:'#f97316', MLB:'#22c55e', NHL:'#3b82f6', NFL:'#013369',
    NCAAF:'#1E4A8C', CBB:'#FBA94C', ATP:'#6B46C1', WTA:'#6B46C1',
    GOLF:'#16734A', ESPORTS:'#06B6D4', SOCCER:'#34d399', WNBA:'#f472b6',
  };
  return map[(sport||'').toUpperCase()] || '#3b82f6';
}

function longDateStr(startTime) {
  if (!startTime) return '';
  try {
    return new Date(startTime).toLocaleDateString('en-US', {
      weekday:'short', month:'long', day:'numeric', year:'numeric', timeZone:'America/New_York',
    });
  } catch (_) { return ''; }
}

function shortDateStr(startTime) {
  if (!startTime) return '';
  try {
    return new Date(startTime).toLocaleDateString('en-US', {
      month:'short', day:'numeric', year:'numeric', timeZone:'America/New_York',
    });
  } catch (_) { return ''; }
}

function gameTimeStr(startTime) {
  if (!startTime) return '';
  try {
    return new Date(startTime).toLocaleTimeString('en-US', {
      hour:'numeric', minute:'2-digit', timeZone:'America/New_York',
    });
  } catch (_) { return ''; }
}

function buildJsonLd(game, canonical, away, home, longDate) {
  return JSON.stringify({
    '@context':   'https://schema.org',
    '@type':      'SportsEvent',
    'name':       `${esc(away)} vs. ${esc(home)}`,
    'startDate':  game.start_time || '',
    'url':        canonical,
    'sport':      game.sport || '',
    'homeTeam':   { '@type': 'SportsTeam', 'name': home },
    'awayTeam':   { '@type': 'SportsTeam', 'name': away },
    'location':   { '@type': 'Place', 'name': game.venue || '' },
    'description': `${game.sport || ''} matchup: ${away} at ${home} on ${longDate}`,
  });
}

// ── Nav HTML (matches main app nav; tab-btn links instead of switchTab calls) ──
// Server-renders the correct logged-in/out state from the session so a subscribed
// user never sees Login/Get Access (or a flash of them) before client JS runs.
function buildNav(user) {
  const on     = !!user;
  // Paying comes from a FRESH DB read, never the session snapshot: the session
  // tier is stamped at login and goes stale the moment a code redemption or
  // Stripe webhook changes it (a paid member was still shown "Unlock
  // CappingAlpha" here). Mirrors auth.isPaid: tier not 'free' + unexpired
  // (null expiry = lifetime; unparseable fails open).
  let paying = false;
  if (on) {
    try {
      const row = require('./db').prepare(`SELECT subscription_tier, subscription_expires FROM users WHERE id = ?`).get(user.id);
      if (row && row.subscription_tier !== 'free') {
        if (!row.subscription_expires) paying = true;
        else {
          const exp = Date.parse(row.subscription_expires);
          paying = isNaN(exp) ? true : exp > Date.now();
        }
      }
    } catch (_) {
      paying = !!(user.tier && user.tier !== 'free');   // DB error -> session fallback
    }
  }
  const acct   = on ? esc(user.username || user.email || '') : '';
  const hide   = 'display:none;';
  // Logo styling is inlined so it always matches the main nav (22px) — the detail
  // page has no .logo CSS of its own, so otherwise it renders small.
  const logoStyle = 'text-decoration:none;font-size:22px;font-weight:700;letter-spacing:-0.3px;color:#e2e8f0;display:inline-flex;align-items:center;white-space:nowrap;';
  // Tabs deep-link to the SPA via hash so they actually switch (the old /?tab=
  // links just landed on home). Leaderboard included to match the main bar.
  const tab = (h, l) => `<a href="/#${h}" class="tab-btn" style="text-decoration:none;">${l}</a>`;
  // Avatar dropdown — matches the SPA's account menu so the top-right is consistent
  // when you land on a detail page (and the dropdown still works here).
  const initialsOf = (s) => {
    s = String(s || '').trim(); if (!s) return '?';
    const p = s.replace(/[_-]+/g, ' ').split(/\s+/).filter(Boolean);
    return (p.length >= 2 ? (p[0][0] + p[1][0]) : s.slice(0, 2)).toUpperCase();
  };
  // Exact same palette + hash + sizing as public/modules/utils.js avatarFor(), so
  // the detail-page avatar is identical to the SPA nav avatar (color AND size).
  const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#d97706', '#16a34a', '#0891b2', '#0d9488', '#4f46e5', '#9333ea', '#c026d3'];
  const avatarBg = (s) => { s = String(s || 'user'); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; };
  const nm = on ? (user.username || user.email || '') : '';
  const ddItem = (href, icon, label, extra = '') => `<a ${href ? `href="${href}"` : ''} ${extra} style="display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:8px;font-size:14px;color:#e2e8f0;text-decoration:none;cursor:pointer;"><i class="${icon}" style="width:16px;text-align:center;color:#8892a4;"></i> ${label}</a>`;
  const navAccount = on ? `
    <div style="position:relative;" id="ca-acct">
      <button onclick="event.stopPropagation();var d=document.getElementById('ca-acct-dd');d.style.display=d.style.display==='block'?'none':'block';" aria-label="Account menu" style="background:none;border:none;padding:0;cursor:pointer;border-radius:50%;display:inline-flex;">
        <span style="width:30px;height:30px;border-radius:50%;background:${avatarBg(nm)};color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0;letter-spacing:.01em;">${initialsOf(nm)}</span>
      </button>
      <div id="ca-acct-dd" style="display:none;position:absolute;top:calc(100% + 8px);right:0;min-width:210px;background:#171b24;border:1px solid #252c3b;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.45);padding:6px;z-index:200;">
        <div style="padding:8px 12px 10px;border-bottom:1px solid #252c3b;margin-bottom:6px;font-weight:700;font-size:14px;color:#e2e8f0;">@${esc(nm)}</div>
        ${ddItem('/#tracking', 'fa-solid fa-chart-line', 'My Tracking')}
        ${ddItem('/#settings', 'fa-solid fa-gear', 'Settings')}
        ${ddItem('/#about', 'fa-regular fa-circle-question', 'Support')}
        <div style="height:1px;background:#252c3b;margin:6px 4px;"></div>
        <a onclick="doLogout()" style="display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:8px;font-size:14px;color:#ef4444;cursor:pointer;"><i class="fa-solid fa-arrow-right-from-bracket" style="width:16px;text-align:center;color:#ef4444;"></i> Logout</a>
      </div>
    </div>
    <script>document.addEventListener('click',function(e){var dd=document.getElementById('ca-acct-dd'),w=document.getElementById('ca-acct');if(dd&&w&&!w.contains(e.target))dd.style.display='none';});</script>` : '';
  return `<nav>
    <div class="nav-left">
      <button class="ca-hamburger" aria-label="Menu" onclick="document.getElementById('ca-detail-menu').classList.toggle('open')">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><rect y="3" width="20" height="2" rx="1"/><rect y="9" width="20" height="2" rx="1"/><rect y="15" width="20" height="2" rx="1"/></svg>
      </button>
      <a href="/" class="logo" style="${logoStyle}">Capping<span style="color:#3b82f6;">Alpha</span></a>
      <div class="nav-tabs">
        ${tab('mvp', `<img src="/ca-logo.png" alt="CA" class="ca-pick-logo" onerror="this.style.display='none'">Rankings`)}
        <div class="nav-about-wrap" id="ca-sports-nav">
          <button class="tab-btn" id="ca-sports-btn" aria-haspopup="true" aria-expanded="false" onclick="caToggleSportsMenu(event)">Sports<span class="tab-caret">&#9662;</span></button>
          <div class="about-dropdown hidden" id="ca-sports-dd" role="menu">
            ${SPORT_PAGES.map(s => `<a class="about-dropdown-item" role="menuitem" href="/${s.slug}">${s.label}</a>`).join('\n            ')}
          </div>
        </div>
        ${tab('esports', 'Esports')}
        ${tab('leaderboard', 'Leaderboard')}
        <div class="nav-about-wrap" id="ca-about-nav">
          <button class="tab-btn" id="ca-about-btn" aria-haspopup="true" aria-expanded="false" onclick="caToggleAboutMenu(event)">About<span class="tab-caret">&#9662;</span></button>
          <div class="about-dropdown hidden" id="ca-about-dd" role="menu">
            <a class="about-dropdown-item" role="menuitem" href="/#about">About</a>
            <a class="about-dropdown-item" role="menuitem" href="/faq">FAQ</a>
            <a class="about-dropdown-item" role="menuitem" href="/tools">Betting Calculators</a>
          </div>
        </div>
      </div>
    </div>
    <div class="nav-actions">
      <button class="btn" id="btn-unlock" style="${paying ? hide : ''}" onclick="location.href='/#unlock'">Unlock CappingAlpha</button>
      <button class="btn btn-ghost" id="btn-login" onclick="openLogin()" style="${on ? hide : ''}">Login</button>
      ${navAccount}
    </div>
  </nav>
  <!-- Mobile dropdown menu (matches the home hamburger) -->
  <div id="ca-detail-menu" class="ca-detail-menu">
    <a href="/">Home</a>
    <a href="/#mvp">CA Rankings</a>
    ${SPORT_PAGES.map(s => `<a href="/${s.slug}" style="padding-left:26px;">${s.label}</a>`).join('\n    ')}
    <a href="/#esports">Esports</a>
    <a href="/#leaderboard">Leaderboard</a>
    <a href="/#about">About</a>
    <a href="/faq">FAQ</a>
    <a href="/tools">Betting Calculators</a>
    <a href="/#account">My Account</a>
  </div>
  <script>
    // About nav dropdown: click toggles, outside click + Escape close (same
    // behavior as the SPA nav's About menu in index.html).
    function caToggleAboutMenu(e) {
      if (e) e.stopPropagation();
      var dd  = document.getElementById('ca-about-dd');
      var btn = document.getElementById('ca-about-btn');
      if (!dd) return;
      var willOpen = dd.classList.contains('hidden');
      dd.classList.toggle('hidden', !willOpen);
      if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    }
    function caCloseAboutMenu() {
      var dd  = document.getElementById('ca-about-dd');
      var btn = document.getElementById('ca-about-btn');
      if (dd) dd.classList.add('hidden');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
    function caToggleSportsMenu(e) {
      if (e) e.stopPropagation();
      caCloseAboutMenu();
      var dd  = document.getElementById('ca-sports-dd');
      var btn = document.getElementById('ca-sports-btn');
      if (!dd) return;
      var willOpen = dd.classList.contains('hidden');
      dd.classList.toggle('hidden', !willOpen);
      if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    }
    function caCloseSportsMenu() {
      var dd  = document.getElementById('ca-sports-dd');
      var btn = document.getElementById('ca-sports-btn');
      if (dd) dd.classList.add('hidden');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
    document.addEventListener('click', function (e) {
      var w = document.getElementById('ca-about-nav');
      if (!(w && w.contains(e.target))) caCloseAboutMenu();
      var sw = document.getElementById('ca-sports-nav');
      if (!(sw && sw.contains(e.target))) caCloseSportsMenu();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { caCloseAboutMenu(); caCloseSportsMenu(); } });
  </script>`;
}

// ── Auth modals (copied from index.html) ─────────────────────────────────────
function buildAuthModals() {
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
          <span>Don't have an account? <a onclick="closeLogin();openSignup();" style="cursor:pointer;color:var(--accent-brand);">Sign up</a></span>
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
      <div class="form-group">
        <label>Username</label>
        <input type="text" id="signup-username" autocomplete="username" maxlength="20" placeholder="e.g. sharpbettor99" />
        <small style="color:var(--text-tertiary);font-size:12px;">3–20 chars, letters/numbers/underscores only</small>
      </div>
      <div class="form-group"><label>Email</label><input type="email" id="signup-email" autocomplete="email" /></div>
      <div class="form-group"><label>Password</label><input type="password" id="signup-password" autocomplete="new-password" /></div>
      <div class="form-group"><label>Confirm Password</label><input type="password" id="signup-confirm" autocomplete="new-password" /></div>
      <div class="form-group" style="display:flex;align-items:flex-start;gap:10px;">
        <input type="checkbox" id="signup-tos" style="margin-top:3px;flex-shrink:0;" />
        <label for="signup-tos" style="font-size:13px;color:var(--text-tertiary);cursor:pointer;">
          I am 18 or older and agree to the <a href="/terms" target="_blank" style="color:var(--accent-brand);">Terms of Service</a> and <a href="/privacy" target="_blank" style="color:var(--accent-brand);">Privacy Policy</a>
        </label>
      </div>
      <button class="btn btn-primary btn-block" onclick="doSignup()">Create Account</button>
      <div class="form-footer">Already have an account? <a onclick="closeSignup();openLogin();" style="cursor:pointer;color:var(--accent-brand);">Log in</a></div>
    </div>
  </div>`;
}

// ── Main builder ──────────────────────────────────────────────────────────────
function buildDetailPageHtml({ title, desc, canonical, payload, game, away, home, longDate, sportSlug, awayColor, homeColor }) {
  const sport    = game.sport || '';
  const sportBg  = sportBgColor(sport);
  // Server-rendered team-circle colours (resolved from team_colors.json in
  // index.js). Fall back to the sport colour when unknown (e.g. tennis players),
  // where the client fills the real colour after hydration.
  const awayBg   = awayColor || sportBg;
  const homeBg   = homeColor || sportBg;
  const sportLbl = sportSlugDisplay(sport);
  const timeStr  = gameTimeStr(game.start_time);
  const shortDate = shortDateStr(game.start_time);
  const venue    = game.venue_name ? `${game.venue_name}${game.venue_city ? ', ' + game.venue_city : ''}` : '';
  const venueStr = venue ? ` · ${esc(venue)}` : '';

  const safeJson = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  const jsonLd = buildJsonLd(game, canonical, away, home, longDate);

  // Breadcrumb sport link (tennis is combined ATP+WTA)
  const sportLinkSlug = (sport === 'ATP' || sport === 'WTA') ? 'tennis' : sportSlug;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:image" content="https://cappingalpha.com/og/game/${encodeURIComponent(game.espn_game_id)}.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="https://cappingalpha.com/og/game/${encodeURIComponent(game.espn_game_id)}.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Sans+Pro:wght@300;400;600;700;900&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
  <link rel="stylesheet" href="/game-detail.css" />
  <link rel="stylesheet" href="/gauge.css" />
  <link rel="stylesheet" href="/track-sheet.css" />
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script type="application/ld+json">${jsonLd}</script>
</head>
<body>

${buildNav(payload.user)}

<div class="ca-page-outer">

<div class="ca-sticky-top">

<!-- Game Header (compact) -->
<header class="ca-game-header">
  <!-- One-line meta: back · badge · time · date · venue · status -->
  <div class="ca-gh-meta-row">
    <button class="ca-page-back-btn" onclick="doBack()">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.5 2L3.5 6L7.5 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Back
    </button>
    <span class="ca-gh-sep">·</span>
    <span class="ca-sport-badge" style="background:${sportBg};">${esc(sportLbl)}</span>
    ${shortDate ? `<span class="ca-gh-sep">·</span><span class="ca-gh-meta-text ca-num">${esc(shortDate)}</span>` : ''}
    <div class="ca-gh-status-pill" id="ca-status-pill"><!-- JS --></div>
    ${venue ? `<span class="ca-gh-sep">·</span><span class="ca-gh-meta-text ca-gh-venue">${esc(venue)}</span>` : ''}
  </div>
  <!-- Teams -->
  <div class="ca-gh-matchup">
    <div class="ca-gh-team ca-gh-away">
      <div class="ca-team-logo-circle" id="ca-logo-away" style="background:${awayBg};">
        ${game.away_flag
          ? `<img class="ca-flag-img" src="${esc(game.away_flag)}" alt="${esc(game.away_country || '')}" loading="lazy">`
          : `<span>${esc((game.away_abbr || game.away_short || away || '?').slice(0,3).toUpperCase())}</span>`}
      </div>
      <div class="ca-team-info">
        <div class="ca-team-name">${esc(away)}</div>
        <div class="ca-team-record ca-num" id="ca-meta-away">— · Away · —</div>
      </div>
    </div>
    <div class="ca-gh-at">@</div>
    <div class="ca-gh-team ca-gh-home">
      <div class="ca-team-logo-circle" id="ca-logo-home" style="background:${homeBg};">
        ${game.home_flag
          ? `<img class="ca-flag-img" src="${esc(game.home_flag)}" alt="${esc(game.home_country || '')}" loading="lazy">`
          : `<span>${esc((game.home_abbr || game.home_short || home || '?').slice(0,3).toUpperCase())}</span>`}
      </div>
      <div class="ca-team-info">
        <div class="ca-team-name">${esc(home)}</div>
        <div class="ca-team-record ca-num" id="ca-meta-home">— · Home · —</div>
      </div>
    </div>
  </div>
</header>
</div><!-- /.ca-sticky-top -->

<!-- Main grid: sidebar + content -->
<div class="ca-main-grid">

  <!-- Sidebar (>=900px) -->
  <aside class="ca-sidebar">
    <a href="#picks"     class="ca-sidebar-link active" data-sec="picks">Picks</a>
    <a href="#lines"     class="ca-sidebar-link"        data-sec="lines">Lines</a>
    <a href="#sentiment" class="ca-sidebar-link"        data-sec="sentiment">Public Betting</a>
    <a href="#teamform"  class="ca-sidebar-link" id="ca-nav-teamform" data-sec="teamform" style="display:none;">Team Form</a>
    <a href="#history"   class="ca-sidebar-link" id="ca-nav-history" data-sec="history" style="display:none;">History</a>
    <a href="#injuries"  class="ca-sidebar-link"        data-sec="injuries">Injuries</a>
    <a href="#context"   class="ca-sidebar-link"        data-sec="context">Context</a>
    <a href="#community" class="ca-sidebar-link"        data-sec="community">Community</a>
  </aside>

  <!-- Content column -->
  <div class="ca-content">

    <!-- Mobile tabs (<900px) -->
    <div class="ca-mobile-tabs">
      <a href="#picks"     class="ca-mtab active" data-sec="picks">PICKS</a>
      <a href="#lines"     class="ca-mtab"        data-sec="lines">LINES</a>
      <a href="#sentiment" class="ca-mtab"        data-sec="sentiment">BETTING</a>
      <a href="#teamform"  class="ca-mtab" id="ca-mtab-teamform" data-sec="teamform" style="display:none;">FORM</a>
      <a href="#history"   class="ca-mtab" id="ca-mtab-history" data-sec="history" style="display:none;">HISTORY</a>
      <a href="#injuries"  class="ca-mtab"        data-sec="injuries">INJURIES</a>
      <a href="#context"   class="ca-mtab"        data-sec="context">CONTEXT</a>
      <a href="#community" class="ca-mtab"        data-sec="community">COMMUNITY</a>
    </div>

<!-- ── PICKS ─────────────────────────────────────────────────────────────── -->
<section id="picks" class="ca-section">
  <div class="ca-section-header ca-section-header--picks">
    <h2 class="ca-section-h2">Picks For This Game</h2>
    <div class="ca-section-meta" id="ca-picks-count"></div>
  </div>
  <div class="ca-slot-grid" id="ca-slot-grid">
    <!-- Rendered by game-detail.js -->
  </div>
  <div class="ca-detail-panel" id="ca-detail-panel">
    <!-- Rendered by game-detail.js -->
  </div>
</section>

<!-- ── LINES ─────────────────────────────────────────────────────────────── -->
<section id="lines" class="ca-section">
  <div class="ca-section-header">
    <h2 class="ca-section-h2">Lines · all bet types</h2>
    <div class="ca-lines-toggle" id="ca-lines-toggle">
      <button class="ca-lt-btn active" data-type="spread" onclick="setLinesType('spread')">SPREAD</button>
      <button class="ca-lt-btn" data-type="ml" onclick="setLinesType('ml')">WIN</button>
      <button class="ca-lt-btn" data-type="total" onclick="setLinesType('total')">TOTAL</button>
    </div>
  </div>
  <div id="ca-lines-table">
    <!-- Rendered by game-detail.js -->
  </div>
</section>

<!-- ── PUBLIC BETTING (section id stays 'sentiment' so anchors keep working) ─ -->
<section id="sentiment" class="ca-section">
  <h2 class="ca-section-h2" style="margin-bottom:16px;">Public Betting</h2>
  <div class="ca-sentiment-cards" id="ca-sentiment-cards">
    <!-- Rendered by game-detail.js -->
  </div>
  <div class="ca-sentiment-footer" id="ca-sentiment-footer">
    <!-- Rendered by game-detail.js -->
  </div>
</section>


<!-- ── TEAM FORM (forward-looking player form/load; revealed by JS) ───────── -->
<section id="teamform" class="ca-section ca-tf-section" style="display:none;">
  <div class="ca-section-header ca-hist-header">
    <h2 class="ca-section-h2" id="ca-tf-title" style="margin:0;">Team form</h2>
    <div class="ca-hist-toggle" id="ca-tf-toggle">
      <button class="ca-hist-tab active" data-team="away" type="button"><span class="ca-hist-tab-abbr">AWAY</span></button>
      <button class="ca-hist-tab" data-team="home" type="button"><span class="ca-hist-tab-abbr">HOME</span></button>
      <span class="ca-hist-toggle-slider" aria-hidden="true"></span>
    </div>
  </div>
  <div class="ca-tf-sub" id="ca-tf-sub"></div>
  <div class="ca-tf-body" id="ca-tf-body">
    <!-- Rendered by game-detail.js renderTeamForm() -->
  </div>
</section>

<!-- ── HISTORY (basketball/team sports; revealed by JS) ──────────────────── -->
<section id="history" class="ca-section ca-history-section" style="display:none;">
  <div class="ca-section-header ca-hist-header">
    <h2 class="ca-section-h2" style="margin:0;">Team history</h2>
    <div class="ca-hist-toggle" id="ca-hist-toggle">
      <button class="ca-hist-tab active" data-team="away" type="button"><span class="ca-hist-tab-abbr">AWAY</span></button>
      <button class="ca-hist-tab" data-team="home" type="button"><span class="ca-hist-tab-abbr">HOME</span></button>
      <span class="ca-hist-toggle-slider" aria-hidden="true"></span>
    </div>
  </div>
  <div class="ca-hist-body" id="ca-history-body">
    <!-- Rendered by game-detail.js renderHistory() -->
  </div>
</section>

<!-- ── INJURIES ──────────────────────────────────────────────────────────── -->
<section id="injuries" class="ca-section">
  <h2 class="ca-section-h2" style="margin-bottom:14px;">Injury report</h2>
  <div class="ca-two-col" id="ca-injuries">
    <!-- Rendered by game-detail.js -->
  </div>
</section>

<!-- ── CONTEXT ───────────────────────────────────────────────────────────── -->
<section id="context" class="ca-section">
  <h2 class="ca-section-h2" style="margin-bottom:14px;">Game context</h2>
  <div class="ca-context-grid" id="ca-context-grid">
    <!-- Rendered by game-detail.js -->
  </div>
</section>

<!-- ── COMMUNITY ─────────────────────────────────────────────────────────── -->
<section id="community" class="ca-section">
  <h2 class="ca-section-h2" style="margin-bottom:14px;">Community</h2>
  <div id="ca-community-gauges">
    <!-- Rendered by game-detail.js -->
  </div>
  <div id="ca-community-vote-row">
    <!-- Rendered by game-detail.js -->
  </div>
  <div id="ca-community-chat" class="ca-chat">
    <!-- Rendered by game-detail.js -->
  </div>
</section>

<!-- Footer (inside content column) -->
<footer class="ca-footer">
  <span class="ca-footer-disclaimer">CappingAlpha never wagers on any game. All scores are hypothetical and for entertainment purposes only.</span>
  <button class="ca-back-top" onclick="window.scrollTo({top:0,behavior:'smooth'})">
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 7.5L5.5 4L9 7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Back to top
  </button>
  <span class="ca-footer-version">v3.1.0</span>
</footer>

  </div><!-- /.ca-content -->
</div><!-- /.ca-main-grid -->
</div><!-- /.ca-page-outer -->

${buildAuthModals()}

<!-- Player drill-down popup (History tab) -->
<div id="ca-hist-modal" class="ca-hist-modal hidden" onclick="if(event.target===this)closeHistGame()">
  <div class="ca-hist-modal-card">
    <button class="ca-hist-modal-close" onclick="closeHistGame()">&#x2715;</button>
    <div class="ca-hist-modal-head" id="ca-hist-modal-head"></div>
    <div class="ca-hist-modal-body" id="ca-hist-modal-body"></div>
  </div>
</div>

<script>window.__GAME_DATA__ = ${safeJson};</script>
<script type="module" src="/game-detail.js?v=4"></script>
<!-- Track-a-Bet sheet: voting on this page opens the betslip at the tapped line.
     Loaded after game-detail.js so track.js's window globals (showToast etc.) win. -->
<script type="module" src="/modules/track.js?v=43"></script>
</body>
</html>`;
}

// buildNav + esc + SPORT_PAGES are shared with src/sport_page.js so the sport
// pages carry the exact same top nav (including the Sports dropdown) for free.
module.exports = { buildDetailPageHtml, buildNav, esc, SPORT_PAGES };
