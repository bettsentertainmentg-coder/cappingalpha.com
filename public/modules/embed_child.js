// public/modules/embed_child.js — runs inside any server page loaded in the
// app's pushed-page stack (public/modules/page_stack.js, ?embed=app). Classic
// script, included in <head> before the page's own scripts so the fetch wrapper
// is in place before the first API call. Inert on the website and when the
// page is not framed.
//
//   - hands the shell's bearer token to every /api/ + /auth/ call (the bundled
//     shell frames cappingalpha.com cross-origin, so there is no cookie); calls
//     made before the token arrives wait for it (1.5s cap)
//   - forwards Back, links that leave the page, and login to the shell
//   - adds the slim top bar (status-bar cover + Back) pages without their own
//     header need; the game page draws its own and skips it
//   - reports ready on load so the shell fades its loader out
(function () {
  var EMBED = false;
  try { EMBED = /[?&]embed=app(?:&|$)/.test(location.search) && window.parent !== window; } catch (e) {}
  if (!EMBED) return;
  window.__caEmbed = true;

  var PARENTS = { 'capacitor://localhost': 1, 'https://localhost': 1, 'http://localhost': 1 };
  PARENTS[location.origin] = 1;
  function post(type, extra) {
    try {
      var m = { type: type };
      if (extra) for (var k in extra) m[k] = extra[k];
      window.parent.postMessage(m, '*');
    } catch (e) {}
  }

  // Bearer handoff.
  var token = null, decided = false, waiters = [];
  function decide(t) {
    if (decided) return;
    decided = true;
    token = t || null;
    var w = waiters; waiters = [];
    w.forEach(function (fn) { fn(); });
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !PARENTS[e.origin]) return;
    var m = e.data;
    if (!m || m.type !== 'ca:embed-auth') return;
    decide(m.token);
  });
  setTimeout(function () { decide(null); }, 1500);
  var orig = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!(url.indexOf('/api/') === 0 || url.indexOf('/auth/') === 0)) return orig(input, init);
    return new Promise(function (resolve, reject) {
      var go = function () {
        try {
          var opts = Object.assign({}, init || {});
          if (token) {
            var h = new Headers(opts.headers || (input instanceof Request ? input.headers : undefined));
            if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + token);
            opts.headers = h;
          }
          orig(input, opts).then(resolve, reject);
        } catch (err) { reject(err); }
      };
      if (decided) go(); else waiters.push(go);
    });
  };
  post('ca:embed-hello');

  // Links leave through the shell: same-origin ones push or switch tabs there,
  // external ones (or target=_blank) open in the system browser.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || href.indexOf('javascript:') === 0) return;
    var u;
    try { u = new URL(href, location.href); } catch (err) { return; }
    e.preventDefault();
    e.stopPropagation();
    if (u.origin !== location.origin || a.target === '_blank') post('ca:embed-nav', { href: u.href, external: true });
    else post('ca:embed-nav', { href: u.pathname + u.search + u.hash });
  }, true);

  window.caEmbedBack = function () { post('ca:embed-back'); };
  function forwardAuthModals() {
    window.openLogin  = function () { post('ca:embed-login'); };
    window.openSignup = function () { post('ca:embed-signup'); };
  }
  forwardAuthModals();

  document.addEventListener('DOMContentLoaded', function () {
    // Module scripts on these pages assign openLogin/openSignup after this
    // script ran; they finish before DOMContentLoaded, so re-assert here.
    forwardAuthModals();
    if (document.querySelector('.ca-game-header')) return;   // the game page has its own header
    var bar = document.createElement('div');
    bar.className = 'ca-embed-bar';
    bar.innerHTML = '<button type="button" class="ca-embed-bar-back" aria-label="Back">' +
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.5 2L3.5 6L7.5 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Back</button>' +
      '<span class="ca-embed-bar-title"></span>';
    var h1 = document.querySelector('h1');
    bar.querySelector('.ca-embed-bar-title').textContent = h1 ? h1.textContent.trim() : '';
    bar.querySelector('button').addEventListener('click', function () { post('ca:embed-back'); });
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.classList.add('ca-embed-has-bar');
  });
  window.addEventListener('load', function () { post('ca:embed-ready'); });
})();
