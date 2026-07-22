#!/usr/bin/env node
// scripts/cap-prod.js — restore the Capacitor shell to its RELEASE state:
// bundled public/ assets, production API (https://cappingalpha.com via
// native.js), no dev server. Safe to run any time; idempotent.
//
// Run this before every archive / TestFlight upload / store build.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const cfgPath = path.join(__dirname, '..', 'capacitor.config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const wasDev = !!(cfg.server && cfg.server.url) || !!cfg.__DEV_SERVER__;
delete cfg.__DEV_SERVER__;
cfg.server = { androidScheme: 'https', iosScheme: 'https' };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

execSync('npx cap copy', { stdio: 'inherit', cwd: path.join(__dirname, '..') });

console.log('');
console.log(wasDev
  ? '  Dev server removed. Shell is back to RELEASE state (bundled assets + production API).'
  : '  Shell already in RELEASE state (bundled assets + production API).');
console.log('');
