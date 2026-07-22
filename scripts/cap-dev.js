#!/usr/bin/env node
// scripts/cap-dev.js — point the Capacitor shell at a LOCAL dev server (live reload).
//
// Usage:
//   npm run app:dev            -> http://localhost:3013  (iOS SIMULATOR shares the
//                                 Mac's loopback, so localhost just works there)
//   npm run app:dev -- --lan   -> http://<this Mac's Wi-Fi IP>:3013 (physical phone
//                                 on the same Wi-Fi; needs NSAllowsLocalNetworking,
//                                 already set in ios/App/App/Info.plist)
//   npm run app:dev -- 192.168.1.50        -> explicit IP
//   npm run app:dev -- 192.168.1.50 3016   -> explicit IP + port
//
// What it does: writes a server{url,cleartext} block into capacitor.config.json and
// runs `npx cap copy` so both native projects load the dev server instead of the
// bundled public/ copy. Edits to public/ then show up on reload with no rebuild,
// and relative /api/ fetches hit the SAME dev server (native.js deliberately does
// not rewrite them in this mode).
//
// IMPORTANT: this is a dev-only state. Run `npm run app:prod` before any archive,
// TestFlight upload, or store build. A `__DEV_SERVER__` marker is written so the
// state is visible in the config at a glance.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const cfgPath = path.join(__dirname, '..', 'capacitor.config.json');

function lanIp() {
  const ifs = os.networkInterfaces();
  for (const name of ['en0', 'en1']) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  for (const list of Object.values(ifs)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

const args = process.argv.slice(2).filter(Boolean);
let host = 'localhost';
let port = '3013';
if (args[0] === '--lan') {
  const ip = lanIp();
  if (!ip) { console.error('Could not detect a LAN IP. Pass one explicitly: npm run app:dev -- 192.168.x.x'); process.exit(1); }
  host = ip;
  if (args[1]) port = args[1];
} else if (args[0]) {
  host = args[0];
  if (args[1]) port = args[1];
}

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.server = { url: `http://${host}:${port}`, cleartext: true };
cfg.__DEV_SERVER__ = `dev only, added by scripts/cap-dev.js — run "npm run app:prod" before any release build`;
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

execSync('npx cap copy', { stdio: 'inherit', cwd: path.join(__dirname, '..') });

console.log('');
console.log(`  Shell now loads  http://${host}:${port}  (live reload)`);
console.log(`  1. Start the dev server:   npm run app:serve`);
console.log(`  2. Run the app:            npx cap run ios   (or open Xcode: npm run app:ios)`);
console.log(`  Edits to public/ apply on pull-to-refresh / reload. API + login hit the dev server.`);
console.log('');
console.log('  BEFORE ANY RELEASE BUILD:  npm run app:prod');
console.log('');
