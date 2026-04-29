// src/detail_page.js — Builds the full HTML for the standalone game detail page.
// Called from the GET /:sport/:slug route in index.js.
// Server-renders: <head> SEO tags, nav, breadcrumb, game header, sidebar.
// Client-renders: slot picker, detail panel, lines, sentiment, injuries, context.

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sportSlugDisplay(sport) {
  const map = { ATP:'Tennis', WTA:'Tennis', CBB:'NCAAMB', NCAAF:'NCAAF',
                NBA:'NBA', MLB:'MLB', NHL:'NHL', NFL:'NFL', Golf:'Golf' };
  return map[(sport||'').toUpperCase()] || sport || 'Sports';
}

function sportBgColor(sport) {
  const map = {
    NBA:'#f97316', MLB:'#22c55e', NHL:'#3b82f6', NFL:'#013369',
    NCAAF:'#1E4A8C', CBB:'#FBA94C', ATP:'#6B46C1', WTA:'#6B46C1',
    Golf:'#16734A', Esports:'#06B6D4',
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
function buildNav() {
  return `<nav>
    <div class="nav-left">
      <a href="/" class="logo" style="text-decoration:none;">Capping<span>Alpha</span></a>
      <div class="nav-tabs">
        <a href="/?tab=mvp"     class="tab-btn" style="text-decoration:none;">MVP Picks</a>
        <a href="/?tab=sports"  class="tab-btn" style="text-decoration:none;">Sports</a>
        <a href="/?tab=esports" class="tab-btn" style="text-decoration:none;">Esports</a>
        <a href="/?tab=about"   class="tab-btn" style="text-decoration:none;">About</a>
      </div>
    </div>
    <div class="nav-actions">
      <span id="nav-user-info" style="display:none;"></span>
      <button class="btn btn-ghost" id="btn-login" onclick="openLogin()">Login</button>
      <button class="btn btn-primary" id="btn-signup" onclick="openSignup()">Get Access</button>
      <a href="/?tab=account" class="tab-btn" id="tab-account" style="display:none;text-decoration:none;border-bottom:none;padding:0 4px;">My Account</a>
      <button class="btn btn-danger" id="btn-logout" style="display:none" onclick="doLogout()">Logout</button>
    </div>
  </nav>`;
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
          I am 18 or older and agree to the <a href="/terms" target="_blank" style="color:var(--accent-brand);">Terms of Service</a>
        </label>
      </div>
      <button class="btn btn-primary btn-block" onclick="doSignup()">Create Account</button>
      <div class="form-footer">Already have an account? <a onclick="closeSignup();openLogin();" style="cursor:pointer;color:var(--accent-brand);">Log in</a></div>
    </div>
  </div>`;
}

// ── Main builder ──────────────────────────────────────────────────────────────
function buildDetailPageHtml({ title, desc, canonical, payload, game, away, home, longDate, sportSlug }) {
  const sport    = game.sport || '';
  const sportBg  = sportBgColor(sport);
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
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${esc(canonical)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Source+Sans+Pro:wght@300;400;600;700;900&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
  <link rel="stylesheet" href="/game-detail.css" />
  <script type="application/ld+json">${jsonLd}</script>
</head>
<body>

${buildNav()}

<div class="ca-page-outer">

<div class="ca-sticky-top">
<!-- Back bar (top-left) -->
<div class="ca-page-back">
  <button class="ca-page-back-btn" onclick="doBack()">
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.5 2L3.5 6L7.5 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Back
  </button>
</div>

<!-- Game Header (compact) -->
<header class="ca-game-header">
  <!-- One-line meta: badge · time · date · venue · status -->
  <div class="ca-gh-meta-row">
    <span class="ca-sport-badge" style="background:${sportBg};">${esc(sportLbl)}</span>
    <span class="ca-gh-meta-text ca-num">${esc(timeStr)} ET</span>
    ${shortDate ? `<span class="ca-gh-sep">·</span><span class="ca-gh-meta-text ca-num">${esc(shortDate)}</span>` : ''}
    ${venue ? `<span class="ca-gh-sep">·</span><span class="ca-gh-meta-text">${esc(venue)}</span>` : ''}
    <div class="ca-gh-status-pill" id="ca-status-pill" style="margin-left:auto;"><!-- JS --></div>
  </div>
  <!-- Teams -->
  <div class="ca-gh-matchup">
    <div class="ca-gh-team ca-gh-away">
      <div class="ca-team-logo-circle" id="ca-logo-away" style="background:${sportBg};">
        <span>${esc((game.away_abbr || game.away_short || away || '?').slice(0,3).toUpperCase())}</span>
      </div>
      <div class="ca-team-info">
        <div class="ca-team-name">${esc(away)}</div>
        <div class="ca-team-record ca-num" id="ca-meta-away">— · Away · —</div>
      </div>
    </div>
    <div class="ca-gh-at">@</div>
    <div class="ca-gh-team ca-gh-home">
      <div class="ca-team-logo-circle" id="ca-logo-home" style="background:${sportBg};">
        <span>${esc((game.home_abbr || game.home_short || home || '?').slice(0,3).toUpperCase())}</span>
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
    <a href="#sentiment" class="ca-sidebar-link"        data-sec="sentiment">Sentiment</a>
    <a href="#injuries"  class="ca-sidebar-link"        data-sec="injuries">Injuries</a>
    <a href="#context"   class="ca-sidebar-link"        data-sec="context">Context</a>
  </aside>

  <!-- Content column -->
  <div class="ca-content">

    <!-- Mobile tabs (<900px) -->
    <div class="ca-mobile-tabs">
      <a href="#picks"     class="ca-mtab active" data-sec="picks">PICKS</a>
      <a href="#lines"     class="ca-mtab"        data-sec="lines">LINES</a>
      <a href="#sentiment" class="ca-mtab"        data-sec="sentiment">SENTIMENT</a>
      <a href="#injuries"  class="ca-mtab"        data-sec="injuries">INJURIES</a>
      <a href="#context"   class="ca-mtab"        data-sec="context">CONTEXT</a>
    </div>

<!-- ── PICKS ─────────────────────────────────────────────────────────────── -->
<section id="picks" class="ca-section">
  <div class="ca-section-header">
    <div>
      <h2 class="ca-section-h2">All picks for this game</h2>
      <div class="ca-section-sub">Click any pick to see details</div>
    </div>
    <div class="ca-section-meta ca-num" id="ca-picks-count"></div>
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
      <button class="ca-lt-btn" data-type="total" onclick="setLinesType('total')">TOTAL</button>
      <button class="ca-lt-btn" data-type="ml" onclick="setLinesType('ml')">ML</button>
    </div>
  </div>
  <div id="ca-lines-table">
    <!-- Rendered by game-detail.js -->
  </div>
</section>

<!-- ── SENTIMENT ─────────────────────────────────────────────────────────── -->
<section id="sentiment" class="ca-section">
  <h2 class="ca-section-h2" style="margin-bottom:16px;">Sentiment</h2>
  <div class="ca-sentiment-cards" id="ca-sentiment-cards">
    <!-- Rendered by game-detail.js -->
  </div>
  <div class="ca-sentiment-footer" id="ca-sentiment-footer">
    <!-- Rendered by game-detail.js -->
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

<!-- Footer (inside content column) -->
<footer class="ca-footer">
  <span class="ca-footer-disclaimer">CappingAlpha never wagers on any game. All scores are hypothetical and for entertainment purposes only.</span>
  <button class="ca-back-top" onclick="window.scrollTo({top:0,behavior:'smooth'})">
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 7.5L5.5 4L9 7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Back to top
  </button>
</footer>

  </div><!-- /.ca-content -->
</div><!-- /.ca-main-grid -->
</div><!-- /.ca-page-outer -->

${buildAuthModals()}

<script>window.__GAME_DATA__ = ${safeJson};</script>
<script type="module" src="/game-detail.js"></script>
</body>
</html>`;
}

module.exports = { buildDetailPageHtml };
