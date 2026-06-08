// src/indexnow.js — IndexNow pings (Bing + Yandex, free, instant).
//
// IndexNow lets us tell search engines "these URLs changed" the moment they do,
// instead of waiting for a crawl. Bing feeds ChatGPT search, so this also helps
// AI answer engines pick up fresh content fast.
//
// The key is published at https://cappingalpha.com/<key>.txt (a static file in
// public/). It is public by design — not a secret — so it lives here, not .env.

const HOST = 'cappingalpha.com';
const KEY  = 'b0cbb161a8dcd6fbf64b775085dc88ef';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;

// Fire-and-forget. Never throws, never blocks the caller. IndexNow returns 200
// or 202 on success; anything else we just log and move on.
async function pingIndexNow(urls) {
  try {
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    if (!list.length) return;
    if (typeof fetch !== 'function') return; // older Node without global fetch

    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: HOST,
        key: KEY,
        keyLocation: KEY_LOCATION,
        urlList: list,
      }),
    });
    if (res.ok || res.status === 202) {
      console.log(`[indexnow] pinged ${list.length} url(s) (${res.status})`);
    } else {
      console.warn(`[indexnow] non-OK ${res.status}`);
    }
  } catch (e) {
    console.warn('[indexnow] ping failed:', e.message);
  }
}

// The stable, indexable URLs worth re-announcing on each deploy / daily refresh.
function corePages() {
  return [
    `https://${HOST}/`,
    `https://${HOST}/results`,
    `https://${HOST}/faq`,
    `https://${HOST}/terms`,
    `https://${HOST}/privacy`,
  ];
}

module.exports = { pingIndexNow, corePages, KEY };
