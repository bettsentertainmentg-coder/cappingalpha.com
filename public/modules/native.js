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
//   authHeaders()     - Authorization: Bearer header once a token is stored
//   setToken/getToken - bearer token in Capacitor Preferences (native only)
//   installFetchInterceptor() - routes /api/ + /auth/ fetches to the API base
//                       with the bearer header attached (7b; inert on web)
//   appleSignIn()     - native Sign in with Apple sheet -> { identity_token, user }
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

// ── Fetch interceptor (Phase 7b) ──────────────────────────────────────────────
// Inside the shell, every module still fetches relative paths ('/api/...',
// '/auth/...'). Wrapping window.fetch prepends the API base and attaches the
// bearer token, so no other module needs app-specific fetch code. Inert on web.
let _fetchWrapped = false;
export function installFetchInterceptor() {
  if (_fetchWrapped || !isNative()) return;
  _fetchWrapped = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input
        : (input instanceof URL) ? input.href
        : (input && typeof input.url === 'string') ? input.url : '';
      if (url.startsWith('/api/') || url.startsWith('/auth/')) {
        const t = await getToken();
        if (input instanceof Request) {
          // Rebuild the Request against the API base, keeping method/body/headers.
          const rebuilt = new Request(API_BASE + url, input);
          if (t && !rebuilt.headers.has('Authorization')) {
            rebuilt.headers.set('Authorization', 'Bearer ' + t);
          }
          return origFetch(rebuilt, init);
        }
        const opts = Object.assign({}, init);
        const headers = new Headers(opts.headers || {});
        if (t && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + t);
        opts.headers = headers;
        return origFetch(API_BASE + url, opts);
      }
    } catch (_) { /* fall through to the untouched fetch */ }
    return origFetch(input, init);
  };
}

// ── Sign in with Apple (native only) ──────────────────────────────────────────
// @capacitor-community/apple-sign-in registers as Plugins.SignInWithApple. On
// iOS the native sheet ignores clientId/redirectURI (web-only options), so we
// just ask for email + fullName. Returns { identity_token, user } or null
// (cancelled / unavailable / web).
export async function appleSignIn() {
  if (!isNative()) return null;
  const P = plugin('SignInWithApple');
  if (!P) return null;
  try {
    const result = await P.authorize({ scopes: 'email name' });
    const r = (result && result.response) || {};
    if (!r.identityToken) return null;
    const name = [r.givenName, r.familyName].filter(Boolean).join(' ') || null;
    return { identity_token: r.identityToken, user: { name } };
  } catch (_) {
    return null; // user cancelled or the sheet failed — caller shows a soft error
  }
}

// ── Native push (Phase 7e) ────────────────────────────────────────────────────
// Official @capacitor/push-notifications plugin. register() yields an FCM token
// on Android and the raw APNs token on iOS; the server stores whatever string
// arrives, and once the APNs key is uploaded to the Firebase project the iOS
// tokens route through FCM with no client change. The onboarding soft-ask (7d)
// feature-detects requestPushPermission(), so it lights up automatically.

// Android notification channels, one per topic (the server sets channelId
// `ca_<topic>` on every message). steam/swing are high importance so a line
// move lands as a heads-up alert; everything else stays default importance.
const PUSH_CHANNELS = [
  { id: 'ca_grades',        name: 'Bet and pick grades', importance: 3 },
  { id: 'ca_game_start',    name: 'Game start',          importance: 3 },
  { id: 'ca_top_pick',      name: "Today's #1 pick",     importance: 3 },
  { id: 'ca_steam',         name: 'Line steam',          importance: 4 },
  { id: 'ca_swing',         name: 'Live swings',         importance: 4 },
  { id: 'ca_social_follow', name: 'New followers',       importance: 3 },
  { id: 'ca_social_tail',   name: 'Tails on your picks', importance: 3 },
  { id: 'ca_default',       name: 'General',             importance: 3 },
];

async function createPushChannels() {
  if (cap()?.getPlatform?.() !== 'android') return;   // channels are Android-only
  const P = plugin('PushNotifications');
  if (!P) return;
  for (const ch of PUSH_CHANNELS) {
    try { await P.createChannel(ch); } catch (_) {}
  }
}

// Token handler wiring: 'registration' upserts the token to the server (the 7b
// fetch interceptor routes the call to the API base with the bearer header) and
// keeps a local copy so logout can deregister; 'registrationError' logs quietly.
let _pushListenersArmed = false;
function armPushListeners() {
  if (_pushListenersArmed) return;
  const P = plugin('PushNotifications');
  if (!P) return;
  _pushListenersArmed = true;
  try {
    P.addListener('registration', async (token) => {
      const t = token && token.value;
      if (!t) return;
      try { await plugin('Preferences')?.set({ key: 'ca_fcm_token', value: t }); } catch (_) {}
      let version = '';
      try { version = (await plugin('App')?.getInfo?.())?.version || ''; } catch (_) {}
      try {
        await fetch('/api/push/register-device', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fcm_token: t, platform: cap()?.getPlatform?.() || '', app_version: version }),
        });
      } catch (_) {}
    });
    P.addListener('registrationError', (err) => {
      try { console.warn('[native] push registration failed', err && err.error); } catch (_) {}
    });
  } catch (_) {}
}

// The hook the 7d onboarding soft-ask and the Settings card call: system prompt
// (when still undecided) -> on granted, wire listeners + channels + register.
export async function requestPushPermission() {
  if (!isNative()) return false;
  const P = plugin('PushNotifications');
  if (!P) return false;
  try {
    let status = await P.checkPermissions();
    if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
      status = await P.requestPermissions();
    }
    if (status.receive !== 'granted') return false;
    armPushListeners();
    await createPushChannels();
    await P.register();
    return true;
  } catch (_) { return false; }
}

// Logout: drop this device's token server-side. Must run BEFORE the bearer
// token is revoked/cleared — the DELETE needs it.
export async function deregisterPush() {
  if (!isNative()) return;
  try {
    const r = await plugin('Preferences')?.get({ key: 'ca_fcm_token' });
    const t = r && r.value;
    if (!t) return;
    await fetch('/api/push/device', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fcm_token: t }),
    }).catch(() => {});
    try { await plugin('Preferences')?.remove({ key: 'ca_fcm_token' }); } catch (_) {}
  } catch (_) {}
}

// Notification tap -> in-app navigation. app.js registers its callback
// immediately after initNative(): the bridge buffers a cold-start tap and
// replays it once this listener attaches (the official plugin exposes no
// separate launch-notification getter — early registration IS the cold-start
// path). cb receives the payload's data map ({ type, url, ... }), identical to
// what sw.js reads on the web.
export function onNotificationTap(cb) {
  if (!isNative()) return;
  const P = plugin('PushNotifications');
  if (!P) return;
  try {
    P.addListener('pushNotificationActionPerformed', (event) => {
      try { cb((event && event.notification && event.notification.data) || {}); } catch (_) {}
    });
  } catch (_) {}
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

  // Route every /api/ + /auth/ fetch to the API base with the bearer token
  // attached. MUST install before the first checkAuth() fetch in app.js boot.
  installFetchInterceptor();

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

  // Push token refresh: FCM tokens rotate, so when permission was granted on a
  // previous run, silently re-register on every launch to re-upsert the current
  // token (also bumps push_devices.last_seen). Never prompts: requestPushPermission
  // is the only place the system dialog can appear.
  (async () => {
    try {
      const P = plugin('PushNotifications');
      if (!P) return;
      const status = await P.checkPermissions();
      if (status.receive !== 'granted') return;
      armPushListeners();
      await createPushChannels();
      await P.register();
    } catch (_) {}
  })();

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
