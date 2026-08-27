#!/usr/bin/env node
// scripts/slip_gauntlet.js — run real betslip screenshots through the REAL pipeline.
//
//   node scripts/slip_gauntlet.js <dir-of-images | image...>
//
// For each image: Apple Vision OCR (scripts/vision_ocr.swift — the same engine
// and settings as the iOS app) -> parseBetslip({text, blocks}) -> a compact
// verdict. This is the tool that turns a folder of downloaded example slips from
// other sportsbooks into an audit of exactly what the parser reads off each one.
//
// It writes each OCR result next to the image as <name>.vision.json so a slip
// that exposes a parser bug can be promoted to test/fixtures/ verbatim.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseBetslip } = require('../src/betslip_parse');

const IMG_RE = /\.(png|jpe?g|webp|gif|heic)$/i;

function collect(args) {
  const files = [];
  for (const a of args) {
    const st = fs.existsSync(a) && fs.statSync(a);
    if (!st) { console.error(`skip (missing): ${a}`); continue; }
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(a)) if (IMG_RE.test(f)) files.push(path.join(a, f));
    } else if (IMG_RE.test(a)) files.push(a);
  }
  return files.sort();
}

function fmtOdds(o) { return o == null ? '—' : (o > 0 ? '+' + o : String(o)); }

function main() {
  const files = collect(process.argv.slice(2));
  if (!files.length) { console.error('usage: node scripts/slip_gauntlet.js <dir|images...>'); process.exit(1); }

  const swift = path.join(__dirname, 'vision_ocr.swift');
  console.log(`OCR: Apple Vision (${files.length} image${files.length === 1 ? '' : 's'})...`);
  // One swift invocation for the whole batch — the compile dominates the runtime.
  let out;
  try {
    out = execFileSync('swift', [swift, ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.error('vision_ocr failed:', e.message);
    process.exit(1);
  }

  const results = out.split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));
  const summary = [];

  for (const r of results) {
    const name = path.basename(r.file);
    console.log('\n' + '='.repeat(70));
    console.log(name);
    console.log('='.repeat(70));
    if (r.error) { console.log('  OCR ERROR:', r.error); summary.push({ name, ok: false, why: 'ocr_error' }); continue; }

    // Persist the payload for fixture promotion.
    fs.writeFileSync(r.file.replace(IMG_RE, '') + '.vision.json',
      JSON.stringify({ text: r.text, blocks: r.blocks }, null, 1));

    const parsed = parseBetslip({ text: r.text, blocks: r.blocks });
    console.log(`  book: ${parsed.book || '(none)'}   capture: ${parsed.capture}   warnings: ${parsed.warnings.join(', ') || 'none'}`);
    if (!parsed.bets.length) {
      console.log('  NO BETS READ. OCR text was:');
      console.log(String(r.text).split('\n').map(l => '    | ' + l).join('\n'));
      summary.push({ name, ok: false, why: 'no_bets', book: parsed.book });
      continue;
    }
    parsed.bets.forEach((b, i) => {
      const line = b.line != null ? ` ${b.bet_type === 'spread' && b.line > 0 ? '+' : ''}${b.line}` : '';
      console.log(`  bet ${i + 1}: [${b.bet_type}] ${b.selection}${line}  odds ${fmtOdds(b.odds)}` +
        `${b.stake != null ? `  $${b.stake}` : ''}${b.to_win != null ? ` to win $${b.to_win}` : ''}` +
        `${b.result ? `  result:${b.result.toUpperCase()}` : ''}  conf ${b.confidence}`);
      if (b.matchup) console.log(`         matchup: ${b.matchup.a} ${b.matchup.sep} ${b.matchup.b}`);
      for (const l of b.legs || []) {
        console.log(`         leg: [${l.bet_type}] ${l.selection}${l.line != null ? ' ' + l.line : ''}  ${fmtOdds(l.odds)}${l.result ? '  ' + l.result : ''}`);
      }
    });
    summary.push({ name, ok: true, book: parsed.book, capture: parsed.capture, bets: parsed.bets.length,
                   conf: Math.min(...parsed.bets.map(b => b.confidence)) });
  }

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  for (const s of summary) {
    console.log(`  ${s.ok ? 'OK  ' : 'FAIL'} ${s.name}` +
      (s.ok ? `  ${s.book || '?'} ${s.capture} bets:${s.bets} minConf:${s.conf}` : `  (${s.why})`));
  }
  const fails = summary.filter(s => !s.ok).length;
  console.log(`\n${summary.length - fails}/${summary.length} images produced bets`);
}

main();
