// public/modules/native.js — Capacitor capability shim (Phase 7a).
//
// The ONLY file that talks to the native bridge. Everything here no-ops on the
// plain web so the same public/ tree serves cappingalpha.com, the PWA, and the
// app shell. There is no bundler: plugins are reached through the
// window.Capacitor.Plugins globals the native runtime injects, never imported.
//
// What lives here:
//   isNative()        - platform test every other module can use
//   apiUrl(path)      - prepends the API base inside the app (bundled shell talks
//                       to cappingalpha.com; on web, paths stay relative)
//   authHeaders()     - Authorization: Bearer header once a token is stored (7b
//                       wires the server side; storage side is ready now)
//   setToken/getToken - bearer token in Capacitor Preferences (native only)
//   haptic(kind)      - tap feedback: 'light' | 'medium' | 'success' | 'selection'
//   initNative()      - boot: splash handoff, status bar, external-link routing,
//                       deep-link handling. Called once from app.js.

const API_BASE = 'https://cappingalpha.com';

const cap = () => window.Capacitor;
const plugin = (name) => cap()?.Plugins?.[name];

export function isNative() {
  try { return !!cap()?.isNativePlatform?.(); } catch (_) { return false; }
}

export function apiUrl(path) {
  return isNative() ? API_BASE + path : path;
}

// ── Bearer token (7b wires /auth issuance; storage is ready now) ──
let _token = null;

export async function getToken() {
  if (!isNative()) return null;
  if (_token !== null) return _token || null;
  try {
    const r = await plugin('Preferences')?.get({ key: 'ca_token' });
    _token = (r && r.value) || '';
  } catch (_) { _token = ''; }
  return _token || null;
}

export async function setToken(t) {
  _token = t || '';
  if (!isNative()) return;
  try {
    const P = plugin('Preferences');
    if (t) await P?.set({ key: 'ca_token', value: t });
    else await P?.remove({ key: 'ca_token' });
  } catch (_) {}
}

export async function authHeaders() {
  const t = await getToken();
  return t ? { Authorization: 'Bearer ' + t } : {};
}

// ── Haptics: no-ops without a bridge or on devices without an engine ──
export function haptic(kind = 'light') {
  if (!isNative()) return;
  const H = plugin('Haptics');
  if (!H) return;
  try {
    if (kind === 'success')        H.notification({ type: 'SUCCESS' });
    else if (kind === 'selection') H.selectionChanged();
    else if (kind === 'medium')    H.impact({ style: 'MEDIUM' });
    else                           H.impact({ style: 'LIGHT' });
  } catch (_) {}
}

// ── External links: system browser, never trapped in the webview ──
export async function openExternal(url) {
  if (isNative() && plugin('Browser')) {
    try { await plugin('Browser').open({ url }); return; } catch (_) {}
  }
  window.open(url, '_blank', 'noopener');
}

// Splash handoff: app.js calls this after the first meaningful paint. Guarded so
// a throw anywhere in boot can never strand the user on the splash forever —
// initNative() also arms a worst-case timer.
let _splashHidden = false;
export function hideSplash() {
  if (_splashHidden || !isNative()) return;
  _splashHidden = true;
  try { plugin('SplashScreen')?.hide({ fadeOutDuration: 200 }); } catch (_) {}
}

export function initNative() {
  if (!isNative()) return;

  // Splash safety net: if boot throws before the first-paint hide fires, drop the
  // splash anyway rather than hanging the app on it.
  setTimeout(hideSplash, 6000);

  // Status bar over the dark chrome. (Capacitor 8 SystemBars when present,
  // legacy StatusBar as fallback.)
  try {
    const SB = plugin('SystemBars') || plugin('StatusBar');
    SB?.setStyle?.({ style: 'DARK' });
    SB?.setBackgroundColor?.({ color: '#0f1117' });
  } catch (_) {}

  // Any absolute link that leaves cappingalpha.com opens in the system browser
  // instead of navigating the webview away from the app shell.
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href^="http"]') : null;
    if (!a) return;
    let host = '';
    try { host = new URL(a.href).hostname; } catch (_) { return; }
    if (host === 'cappingalpha.com' || host === 'www.cappingalpha.com') return;
    e.preventDefault();
    openExternal(a.href);
  }, true);

  // Deep links back into the app (Stripe return, notification taps later).
  try {
    plugin('App')?.addListener?.('appUrlOpen', (data) => {
      try {
        const u = new URL(data.url);
        if (u.searchParams.get('payment')) {
          window.location.href = '/?payment=' + u.searchParams.get('payment');
        }
      } catch (_) {}
    });
  } catch (_) {}
}
