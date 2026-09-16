// src/capper_public.js — how a capper is NAMED in public (docs/V2_DATABASE_PLAN.md 5c).
//
// Every capper row that leaves the server goes through publicCapper(). Rules:
//   - Public platforms show their platform name on the badge: Polymarket,
//     Action Network, Covers, WagerTalk, the column outlets.
//   - Discord is always "Community" and always aliased. BettingPros cappers are
//     aliased from day one (their terms ban commercial use of the identity).
//   - name_mode 'auto' = alias when EVERY source of the capper is an aliased
//     source, else public. 'public' / 'alias' are admin overrides.
//   - Aliases come from src/alias_pool.json (handle-style fake names), assigned
//     once, never reused, stored only in capper_registry.alias_name. Admin
//     shows them with a FAKE badge; the real name never leaves the server.
//   - A capper on Discord AND a public source shows under the public source.
//   - Polymarket wallets show the handle, else the shortened address.
//   - hidden = 1 removes the capper from every public reader.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const ALIASED_SOURCES = new Set(['discord', 'bettingpros']);

// Badge label + color class per source. cls drives .src-<cls> in the CSS
// contract: pm violet, an green, cv red, cm grey (Community), ot grey (other
// public outlets, tinted like Community).
const PLATFORM = {
  polymarket:        { label: 'Polymarket',     cls: 'pm' },
  actionnetwork:     { label: 'Action Network', cls: 'an' },
  covers:            { label: 'Covers',         cls: 'cv' },
  wagertalk:         { label: 'WagerTalk',      cls: 'ot' },
  cbs:               { label: 'CBS Sports',     cls: 'ot' },
  thespread:         { label: 'The Spread',     cls: 'ot' },
  sportsbookwire:    { label: 'SportsbookWire', cls: 'ot' },
  sportsbookreview:  { label: 'SBR',            cls: 'ot' },
  sportsbettingdime: { label: 'SBD',            cls: 'ot' },
};
const COMMUNITY = { label: 'Community', cls: 'cm' };

let _pool = null;
function aliasPool() {
  if (_pool) return _pool;
  try { _pool = JSON.parse(fs.readFileSync(path.join(__dirname, 'alias_pool.json'), 'utf8')); }
  catch (_) { _pool = []; }
  return _pool;
}

function slugify(name) {
  const base = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || 'capper';
}

function isWallet(s) { return /^0x[0-9a-f]{40}/i.test(String(s || '')); }
// 0x99F0...9495, whatever suffix the ingest appended after the 40 hex chars.
function shortWallet(s) { s = String(s); return `${s.slice(0, 6)}...${s.slice(38, 42)}`; }

function initialsOf(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  if (isWallet(s)) return s.slice(2, 4).toUpperCase();
  const parts = s.replace(/[_.-]+/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  // CamelCase handle: VeryLucky888 -> VL
  const caps = s.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return (caps[0] + caps[1]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

// Which source the badge names. Public sources win over aliased ones; among
// public sources the one with the most rows.
function primarySource(sourceCounts) {
  const entries = Object.entries(sourceCounts || {}).filter(([, n]) => n > 0);
  if (!entries.length) return 'discord';
  const pub = entries.filter(([s]) => !ALIASED_SOURCES.has(s)).sort((a, b) => b[1] - a[1]);
  if (pub.length) return pub[0][0];
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

function resolveNameMode(reg, sourceCounts) {
  const mode = (reg && reg.name_mode) || 'auto';
  if (mode === 'public' || mode === 'alias') return mode;
  const sources = Object.keys(sourceCounts || {}).filter((s) => (sourceCounts[s] || 0) > 0);
  if (!sources.length) return 'alias';
  return sources.every((s) => ALIASED_SOURCES.has(s)) ? 'alias' : 'public';
}

// Pick an unused pseudonym for a capper. Random over the pool, skipping names
// already held by any registry row. Returns null when the pool is exhausted.
function pickAlias(usedSet) {
  const pool = aliasPool();
  if (!pool.length) return null;
  const start = Math.floor(Math.random() * pool.length);
  for (let i = 0; i < pool.length; i++) {
    const n = pool[(start + i) % pool.length];
    if (!usedSet.has(n)) { usedSet.add(n); return n; }
  }
  return null;
}

// The public shape. reg = capper_registry row (may be null), sourceCounts =
// { source: rows } for this capper. Never returns the canonical name when the
// capper is aliased.
function publicCapper(reg, sourceCounts) {
  const canonical = reg ? reg.canonical_name : '';
  const mode = resolveNameMode(reg, sourceCounts);
  const src = (reg && reg.primary_source) || primarySource(sourceCounts);
  let name;
  let badge;
  if (mode === 'alias') {
    name = (reg && reg.alias_name) || 'Community member';
    badge = COMMUNITY;
  } else {
    name = (reg && reg.display_name) || canonical;
    if (isWallet(name)) name = shortWallet(name);
    badge = PLATFORM[src] || COMMUNITY;
  }
  return {
    name,
    slug: (reg && reg.slug) || slugify(mode === 'alias' ? name : canonical),
    initials: initialsOf(name),
    source: badge.label,
    source_cls: badge.cls,
    aliased: mode === 'alias',
  };
}

module.exports = {
  ALIASED_SOURCES, PLATFORM, COMMUNITY,
  publicCapper, primarySource, resolveNameMode, pickAlias, slugify, initialsOf, isWallet, shortWallet, aliasPool,
};
