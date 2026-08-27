// src/betslip_parse.js — THE BETSLIP READER (pure, no DB, no network, no API cost).
//
// Turns the OCR text of a sportsbook screenshot into structured bets. Two callers
// feed it and both use the same code path:
//   - web  : Tesseract.js in the browser (public/modules/track.js)
//   - phone: Apple Vision / ML Kit in the native shell, which also sends word
//            BLOCKS (bounding boxes) so we can rebuild the visual rows.
//
// Why the parser lives on the server rather than in the app: a book redesigns its
// slip and we fix it with a deploy, not an App Store release. Nothing but TEXT is
// ever posted here — the screenshot stays on the user's device.
//
// Scope, in the order the reader meets them:
//   1. share cards   — the image a book generates for "share my bet" (no stake)
//   2. bet slips     — one bet with wager + to-win
//   3. parlays / SGP — a header plus N legs
//   4. list views    — "My Bets" with several bets stacked
//   5. settled slips — carrying WON / LOST / PUSH / CASHED OUT
//
// It is deliberately RULES-ONLY. No model, no Haiku, no Ollama: betslips are clean
// digital screenshots with a small, stable vocabulary, and a rules parser is the
// thing we can unit-test against fixtures. See docs/BETSLIP_SCAN.md.

'use strict';

// ── Books ─────────────────────────────────────────────────────────────────────
// `tell` strings are matched against the whole lowercased blob. Order matters:
// the first book whose tell appears wins, so put distinctive UI chrome (which
// only ever appears in that book's app) above the bare brand name.
const BOOKS = [
  { key: 'fanduel',    label: 'FanDuel',      tells: ['share in the fanduel community', 'fanduel'] },
  { key: 'draftkings', label: 'DraftKings',   tells: ['draftkings', 'draft kings', 'dk sportsbook'] },
  { key: 'betmgm',     label: 'BetMGM',       tells: ['betmgm', 'bet mgm'] },
  { key: 'caesars',    label: 'Caesars',      tells: ['caesars', 'czr sportsbook'] },
  { key: 'espnbet',    label: 'ESPN BET',     tells: ['espn bet', 'espnbet'] },
  { key: 'fanatics',   label: 'Fanatics',     tells: ['fanatics sportsbook', 'fanatics'] },
  { key: 'bet365',     label: 'bet365',       tells: ['bet365', 'bet 365'] },
  { key: 'hardrock',   label: 'Hard Rock',    tells: ['hard rock bet', 'hardrock'] },
  { key: 'betrivers',  label: 'BetRivers',    tells: ['betrivers', 'bet rivers'] },
  { key: 'pointsbet',  label: 'PointsBet',    tells: ['pointsbet'] },
  { key: 'ballybet',   label: 'Bally Bet',    tells: ['bally bet', 'ballybet'] },
  { key: 'thescore',   label: 'theScore Bet', tells: ['thescore bet', 'thescorebet'] },
  { key: 'novig',      label: 'Novig',        tells: ['novig'] },
  { key: 'prophetx',   label: 'ProphetX',     tells: ['prophet x', 'prophetx'] },
  { key: 'bovada',     label: 'Bovada',       tells: ['bovada'] },
  { key: 'betonline',  label: 'BetOnline',    tells: ['betonline', 'bet online'] },
  { key: 'pinnacle',   label: 'Pinnacle',     tells: ['pinnacle'] },
  { key: 'mybookie',   label: 'MyBookie',     tells: ['mybookie'] },
  { key: 'kalshi',     label: 'Kalshi',       tells: ['kalshi'] },
  { key: 'polymarket', label: 'Polymarket',   tells: ['polymarket'] },
  { key: 'prizepicks', label: 'PrizePicks',   tells: ['prizepicks'] },
  { key: 'underdog',   label: 'Underdog',     tells: ['underdog fantasy', 'underdog'] },
];

function detectBook(lower) {
  for (const b of BOOKS) {
    for (const t of b.tells) if (lower.includes(t)) return { key: b.key, label: b.label };
  }
  return { key: null, label: null };
}

// ── Chrome ────────────────────────────────────────────────────────────────────
// App furniture that is never part of a bet. Dropping it early keeps it from
// being mistaken for a selection (the FanDuel share sheet alone contributes
// "Messages", "WhatsApp", "New Post" and "Copy link", all of which read as
// perfectly good team names to a naive parser).
const CHROME_RE = new RegExp([
  '^(open|settled|my bets|bet ?slip|bets?|all|live|upcoming|history|pending|active)$',
  '^(share|share bet|new post|copy image|copy link|copy|messages?|whatsapp|instagram|facebook|twitter|x|mail|airdrop|save image|more)$',
  '^(more ways to share|share in the .*community|share your bet)$',
  '^(cash ?out|cash out available|edit bet|same game parlay ?\\+?|add to bet ?slip|rebet|bet again|repeat bet)$',
  '^(home|search|promos?|account|profile|balance|deposit|withdraw|help|settings|menu|back|done|close|cancel)$',
  '^(total wagers?|bet id|bet receipt|receipt|reference|ticket|placed on|placed|wagered on)$',
  '^\\$?0?\\.?0*$',                       // "$0.00" balance chips, stray zeros
  '^[0-9]{1,2}:[0-9]{2}\\s*(am|pm)?$',    // the phone's status-bar clock
  '^[+-]?[0-9]{1,3}%$',                   // battery / percentage chips
  '^(5g|4g|lte|wi-?fi)[a-z]*$',
].join('|'), 'i');

// Lines that are pure noise once punctuation is stripped (icons, separators).
function isChrome(line) {
  const t = line.trim();
  if (!t) return true;
  if (CHROME_RE.test(t)) return true;
  // A line with no letters and no digits carries nothing (bullets, rules, arrows).
  if (!/[a-z0-9]/i.test(t)) return true;
  return false;
}

// ── Markets ───────────────────────────────────────────────────────────────────
// A market label is the anchor the whole segmenter hangs off: every book prints
// one under (or beside) each selection, and it is the single most reliable token
// on the slip. Order matters — the spread patterns must be tried before the
// generic total patterns so "Total Points Spread" style labels land correctly.
const MARKETS = [
  { type: 'ml',     re: /^(money\s*linet?|ml|match winner|to win (?:the )?(?:game|match|fight|bout)|winner|match result|full\s*time\s*result|1x2|result)$/i },
  { type: 'spread', re: /^(?:alt(?:ernate)?\s+)?(?:point\s+|puck\s+|run\s+|goal\s+|game\s+|set\s+|map\s+|match\s+)?(?:spread|line|handicap)$/i },
  { type: 'spread', re: /^(run line|puck line|goal line|asian handicap|handicap|spread betting)$/i },
  { type: 'total',  re: /^(?:alt(?:ernate)?\s+)?(?:game\s+|match\s+)?totals?(?:\s+(?:points|runs|goals|games|sets|maps|rounds|corners|kills))?$/i },
  { type: 'total',  re: /^(over\/under|o\/u|over under|total over\/under)$/i },
  { type: 'total',  re: /^(?:team\s+totals?|team total (?:points|runs|goals))$/i },
];

// Player-prop market labels. These parse as bet_type 'prop': we never auto-grade
// them (no prop feed), so they land as personal bets the user settles by hand.
const PROP_RE = new RegExp([
  'player\\s+(props?|points|rebounds|assists|threes|blocks|steals)',
  '(points|rebounds|assists|threes|blocks|steals|passing|rushing|receiving|receptions)\\s*(\\+|y(?:ar)?ds?|made|o/u)?$',
  'any\\s*time\\s+(td|touchdown)', 'first\\s+(td|touchdown)', 'to\\s+(score|record|hit|throw|get)\\b',
  'strikeouts?', 'home\\s*runs?', 'total\\s+bases', 'hits\\s*\\+?\\s*runs', 'shots\\s+on\\s+goal',
  'double\\s+double', 'triple\\s+double', 'goalscorer', 'to\\s+lift\\s+the', 'method\\s+of\\s+victory',
  'aces', 'games\\s+won', 'sets?\\s+won', 'correct\\s+score', 'both\\s+teams\\s+to\\s+score', 'btts',
].join('|'), 'i');

// A market LABEL never carries a number. The selection does ("Jayson Tatum 25+
// Points", "Over 8.5"), and without this guard the prop pattern swallows the
// selection line as a market and the bet comes back with no selection at all.
// The exceptions are the handful of labels that legitimately contain a digit.
const MARKET_DIGIT_OK = /^(1x2|o\/u|f5|1h|2h|[1-4]q|3\s*-?\s*way)$|^\d(?:st|nd|rd|th)\s+(?:period|quarter|half|inning|set|map)\b/i;

function marketOf(line) {
  // A remove-leg button OCR-fused onto the label ("X Moneyline" on BetRivers)
  // must not hide the market. A real label never starts with a lone glyph.
  line = String(line).replace(/^[xX*>\u2022\u00b7-]\s+/, '');
  const t = line.trim().replace(/[.:•·|]+$/, '').trim();
  if (/\d/.test(t) && !MARKET_DIGIT_OK.test(t)) return null;
  for (const m of MARKETS) if (m.re.test(t)) return m.type;
  // Partial-game markets ("2nd Period 3 Way" on a live slip) grade off a period
  // score we do not track: personal-bet territory, same as the board's F5/1H
  // quarantine. Never a full-game slot.
  if (/^\d(?:st|nd|rd|th)\s+(?:period|quarter|half|inning|set|map)\b/i.test(t)) return 'prop';
  // Futures read as their own thing and never auto-grade.
  if (/^(futures?|outright|(?:division|conference|championship)\s+winner|to win (?:the )?(?:division|conference|championship|title|series|award|mvp)|season)/i.test(t)) return 'future';
  if (PROP_RE.test(t) && t.length <= 60) return 'prop';
  return null;
}

// ── Bet headers ───────────────────────────────────────────────────────────────
// "Straight Bet", "4 Leg Parlay", "Same Game Parlay", "Round Robin".
const STRAIGHT_RE = /^(straight(?:\s+bet)?|single(?:\s+bet)?|solo|standard(?:\s+bet)?)$/i;
// Real headers seen in the wild: "3 Leg Parlay", "Same Game Parlay", "PARLAY
// 6-Bet Parlay" (Hard Rock repeats the word), "Parlay (3 Picks)" (BetRivers).
const PARLAY_RE   = /^(?:parlay\s+)?(?:(\d{1,2})[\s-]*(?:leg|pick|selection|team|bet)s?[\s-]*)?(same\s*game\s*)?(parlay|accumulator|acca|multi|combo|sgp|sgpx?)(?:\s*(?:\+|x)?)?(?:\s*\((\d{1,2})\s*(?:legs?|picks?|bets?|selections?)\))?$/i;
const TEASER_RE   = /^(\d{1,2})?[\s-]*(teaser|pleaser|round\s*robin|if\s*bet|reverse)s?$/i;

function betHeaderOf(line) {
  // FanDuel's SGP chip OCRs into the header text ("SGP] Same Game Parlay",
  // "SGP 7 leg Same Game Parlay+"), and a settled header carries its badge
  // ("8 PICK PARLAY +163384 WON", "Parlay 4 Legs WIN").
  line = String(line)
    .replace(/^\[?sgp\]?\s+(?=same|parlay|\d)/i, '')
    .replace(/\s+(won|win|lost|loss|push|voided?|cashed\s*out)$/i, '');
  const t = line.trim().replace(/[.:\u2022\u00b7|+]+$/, '').trim();
  if (STRAIGHT_RE.test(t)) return { kind: 'straight', legs: 1 };
  if (TEASER_RE.test(t))   return { kind: 'exotic', legs: null, label: t };
  const m = PARLAY_RE.exec(t);
  if (m) {
    const n = parseInt(m[1] || m[4], 10);
    return { kind: 'parlay', legs: Number.isFinite(n) ? n : null, sameGame: !!m[2] || /sgp/i.test(t) };
  }
  // ESPN BET flips the word order: "Parlay 4 Legs".
  const m2 = /^(?:parlay|sgp|same\s*game\s*parlay\+?)\s*\(?(\d{1,2})\s*(?:legs?|picks?|bets?|selections?)\)?$/i.exec(t);
  if (m2) return { kind: 'parlay', legs: parseInt(m2[1], 10), sameGame: /sgp|same/i.test(t) };
  return null;
}

// ── Results ───────────────────────────────────────────────────────────────────
// A settled slip carries its own verdict. We READ it (to tell settled slips apart
// from pending ones and to fill the confirm screen) but we never TRUST it: the
// importer re-grades anything it can match to a real game. See betslip_router.js.
const RESULT_RE = [
  { result: 'win',  re: /^(won|win|winner|cashed|paid|settled\s*[-–]?\s*won|won\s+on\s+\w+)$/i },
  { result: 'loss', re: /^(lost|loss|lose|no\s*win|settled\s*[-–]?\s*lost)$/i },
  { result: 'push', re: /^(push|tie|tied|draw\s*no\s*bet|refund(?:ed)?)$/i },
  { result: 'void', re: /^(void(?:ed)?|cancell?ed|no\s*action|na)$/i },
  { result: 'void', re: /^cash(?:ed)?\s*out$/i },   // cashed out: not a graded W/L
];
function resultOf(line) {
  const t = line.trim().replace(/[.:!\u2022\u00b7|]+$/, '').trim();
  for (const r of RESULT_RE) if (r.re.test(t)) return r.result;
  // The winner tape: a Hard Rock ticket's border is WINNER repeated edge to edge,
  // and OCR clips the outermost tokens ("'WNER WINNER ... WII"), so only a
  // repeated-token test can see it.
  if ((t.match(/winner/gi) || []).length >= 2) return 'win';
  return null;
}

// ── Money ─────────────────────────────────────────────────────────────────────
// Books label the two amounts a dozen ways. `stake` is what leaves the account,
// `toWin` is the profit (NOT the return: "Total Payout" includes the stake and is
// converted below).
const STAKE_LABEL  = /(total\s+wager|wager|risk(?:ing)?|stake|bet\s+amount|amount\s+bet|you\s+bet|bet)\b/i;
const RETURN_LABEL = /(total\s+payout|total\s+return|payout|returns?|paid|collected|total)\b/i;
const PROFIT_LABEL = /(to\s+win|to\s+return|potential\s+win(?:nings)?|profit|winnings)\b/i;

const MONEY_RE = /(?:[$\u00a3\u20ac]|usd\s*)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|\b([0-9][0-9,]*\.[0-9]{2})\b/gi;

function moneysIn(line) {
  const out = [];
  let m; MONEY_RE.lastIndex = 0;
  while ((m = MONEY_RE.exec(line))) {
    const v = parseFloat(String(m[1] || m[2]).replace(/,/g, ''));
    if (Number.isFinite(v)) out.push({ value: v, index: m.index });
  }
  return out;
}

// ── Odds ──────────────────────────────────────────────────────────────────────
// American odds: an explicit sign, three or more digits, NO decimal point.
//
// The decimal rule is what keeps a spread out of the odds field: "-136" is a
// price, "-13.6" is not, and "+1.5" is a line. Four digits are common on parlays
// (+1150) and longshots, so the upper bound is generous.
//
// No lookbehind assertions anywhere in this file: Safari before 16.4 fails to
// PARSE a module containing (?<!...), and public/modules/track.js imports the
// same shapes. Group 1 captures the boundary character instead.
const AM_ODDS_RE = /(^|[^\d.,])([+-]\d{3,8})(?![\d.])/g;
// "EVEN" / "EVENS" / "PK" are even money.
const EVEN_RE = /\b(even|evens|ev|pick\s*'?em|pk)\b/i;
// Fractional odds are unambiguous in shape: 5/2, 11/4, 1/1.
const FRAC_RE = /(^|[^\d.\/])(\d{1,3})\s*\/\s*(\d{1,3})(?![\d.\/])/g;

function americanIn(line) {
  const out = []; let m; AM_ODDS_RE.lastIndex = 0;
  while ((m = AM_ODDS_RE.exec(line))) {
    const v = parseInt(m[2], 10);
    // ±100 is the floor for a real American price; anything smaller is a score or a year.
    // Upper bound is generous on purpose: longshot parlays print real 7-digit
    // prices (a Hard Rock winner ticket read +6576031), and the old 100000 cap
    // threw the one number that identified the bet.
    if (Math.abs(v) >= 100 && Math.abs(v) <= 10000000) out.push({ value: v, index: m.index });
  }
  return out;
}
function fractionalIn(line) {
  const out = []; let m; FRAC_RE.lastIndex = 0;
  while ((m = FRAC_RE.exec(line))) {
    const num = parseInt(m[2], 10), den = parseInt(m[3], 10);
    if (!den || !num) continue;
    const dec = 1 + num / den;
    out.push({ value: decimalToAmerican(dec), index: m.index });
  }
  return out;
}
function decimalToAmerican(d) {
  const x = Number(d);
  if (!Number.isFinite(x) || x <= 1) return null;
  return x >= 2 ? Math.round((x - 1) * 100) : -Math.round(100 / (x - 1));
}
function americanToDecimal(a) {
  const o = Number(a);
  if (!Number.isFinite(o) || o === 0) return null;
  return o < 0 ? 1 + 100 / Math.abs(o) : 1 + o / 100;
}

// Odds implied by a stake and a profit, used when the slip shows the money but the
// price got cropped or misread.
function oddsFromMoney(stake, toWin) {
  if (!(stake > 0) || !(toWin > 0)) return null;
  const ratio = toWin / stake;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const am = ratio >= 1 ? Math.round(ratio * 100) : -Math.round(100 / ratio);
  return Math.abs(am) >= 100 ? am : null;
}

// ── Lines / handicaps ─────────────────────────────────────────────────────────
// A handicap in a selection: "Lakers -4.5", "Over 220.5", "+1.5". Signed values
// under 100, or any value carrying a decimal, are lines rather than prices.
const HANDICAP_RE = /(^|[^\d.,])([+-]\d{1,3}(?:\.\d)?)(?![\d])/g;
const TOTAL_SIDE_RE = /\b(over|under|o|u)\b[\s.:]*\+?([0-9]{1,3}(?:\.[05])?)/i;

function handicapIn(line) {
  const out = []; let m; HANDICAP_RE.lastIndex = 0;
  while ((m = HANDICAP_RE.exec(line))) {
    const raw = m[2];
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) continue;
    // A signed 3-digit integer with no decimal is a price, not a handicap.
    if (!raw.includes('.') && Math.abs(v) >= 100) continue;
    out.push({ value: v, index: m.index, raw });
  }
  return out;
}

// ── Matchups ──────────────────────────────────────────────────────────────────
// "Lorenzo Sonego v James Duckworth", "Lakers @ Celtics", "Arsenal vs Chelsea".
// The separator also tells us who is HOME: "@" and "at" mean the left side is the
// visitor, which is how every US book prints it.
const MATCHUP_RE = /^(.{2,60}?)\s+(@|at|vs\.?|v\.?|versus|-)\s+(.{2,60}?)$/i;

// Trailing furniture that books right-align onto the SAME visual row as the
// matchup ("Toronto Tempo @ Seattle Storm    To Win $13.64", "... 7:30PM ET").
// OCR merges the two columns into one line, so the matchup has to be read out of
// what is left after the tail is cut. Rejecting any line carrying money instead
// (the first cut of this) silently lost the game on every TOTAL in a My Bets list:
// a total's selection is only "Over 174.5", so the matchup is its ONLY way in.
const MATCHUP_TAIL_RE = /\s*(?:to\s+win|to\s+return|potential\s+win(?:nings)?|payout|returns?|total\s+payout|wager|risk|stake|cash\s*out|finished|final|live|settled)\b.*$/i;

function matchupOf(line) {
  let t = line.trim().replace(/[•·|]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  t = t.replace(MATCHUP_TAIL_RE, '').trim();
  t = t.replace(TIME_RE, ' ').replace(DATE_RE, ' ');
  t = t.replace(MONEY_RE, ' ');
  AM_ODDS_RE.lastIndex = 0;
  t = t.replace(AM_ODDS_RE, (all, b) => b);
  t = t.replace(/\b(?:et|est|edt|ct|cst|cdt|mt|pt|pst|pdt)\b/gi, ' ')
       .replace(/\s{2,}/g, ' ').trim();
  const m = MATCHUP_RE.exec(t);
  if (!m) return null;
  const a = m[1].trim(), sep = m[2].toLowerCase(), b = m[3].trim();
  if (!/[a-z]{2}/i.test(a) || !/[a-z]{2}/i.test(b)) return null;
  // "-" only counts as a separator when both halves are wordy (guards "Lakers -4.5").
  if (sep === '-' && (/\d/.test(a) || /\d/.test(b))) return null;
  const awayFirst = sep === '@' || sep === 'at';
  return { a, b, sep, away: awayFirst ? a : null, home: awayFirst ? b : null };
}

// ── Times / dates ─────────────────────────────────────────────────────────────
const TIME_RE = /\b(1[0-2]|0?[1-9]):([0-5][0-9])\s*(am|pm)\b/i;
const DATE_RE = /\b(today|tomorrow|tonight|yesterday|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2})\b/i;

const TZ_RE = /\b(et|est|edt|ct|cst|cdt|mt|mst|mdt|pt|pst|pdt|gmt|utc)\b/i;

function timeHintOf(line) {
  const t = TIME_RE.exec(line);
  const d = DATE_RE.exec(line);
  if (!t && !d) return null;
  const z = TZ_RE.exec(line);
  return {
    time: t ? `${t[1]}:${t[2]}${t[3].toUpperCase()}` : null,
    date: d ? d[0] : null,
    tz: z ? z[1].toUpperCase() : null,
  };
}

// ── OCR repair ────────────────────────────────────────────────────────────────
// Only ever applied INSIDE a token that is already mostly digits, so a team name
// can never be mangled. "O" for zero and "l"/"I" for one are the two confusions
// that actually show up on a dark-mode betslip.
function repairNumeric(text) {
  return String(text).replace(/[+-]?[0-9OolI,.$]{2,}/g, (tok) => {
    const digits = (tok.match(/[0-9]/g) || []).length;
    const letters = (tok.match(/[OolI]/g) || []).length;
    if (!digits || letters > digits) return tok;   // not really a number
    return tok.replace(/O/g, '0').replace(/o/g, '0').replace(/[lI]/g, '1');
  });
}

// The em/en dash and the unicode minus all mean "minus" on a betslip.
function normalizeSigns(text) {
  return String(text)
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, '-')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
}

// OCR reads logo glyphs as their nearest lookalike: ESPN BET's stylized N comes
// back as Cyrillic \u041f ("ESP\u041fBET"), and trademark marks either vanish or
// fuse into words ("Same Game Parlay\u2122" -> "MONEYLINET"). Fold both before
// anything tries to match.
function foldGlyphs(text) {
  return String(text)
    .replace(/[\u2122\u00ae\u00a9]/g, '')
    .replace(/[\u041f\u043f]/g, 'n').replace(/[\u041e\u043e]/g, 'o')
    .replace(/[\u0410\u0430]/g, 'a').replace(/[\u0415\u0435]/g, 'e')
    .replace(/[\u0420\u0440]/g, 'p').replace(/[\u0421\u0441]/g, 'c')
    .replace(/[\u0425\u0445]/g, 'x').replace(/[\u0412\u0432]/g, 'b');
}

function normalizeOcr(text) {
  return repairNumeric(normalizeSigns(foldGlyphs(text)))
    .split('\n')
    .map(l => l.replace(/\s{2,}/g, ' ').trim())
    .filter(l => l.length > 0)
    .join('\n');
}

// ── Blocks -> visual rows ─────────────────────────────────────────────────────
// Apple Vision and ML Kit hand back positioned words. Betslips are two-column
// layouts (selection left, price right), and plain OCR text order splits those
// onto separate lines. Regrouping by vertical overlap puts "Lorenzo Sonego" and
// "-136" back on one row, which is what the selection/odds pairing relies on.
//
// Accepts {text,x,y,w,h} or {text,x,y,width,height} or {text, boundingBox:{...}}.
function linesFromBlocks(blocks) {
  const words = [];
  for (const b of blocks || []) {
    if (!b) continue;
    const bb = b.boundingBox || b.frame || b;
    const x = num(bb.x ?? bb.left ?? bb.minX);
    const y = num(bb.y ?? bb.top ?? bb.minY);
    const w = num(bb.w ?? bb.width ?? ((bb.maxX != null && bb.minX != null) ? bb.maxX - bb.minX : null));
    const h = num(bb.h ?? bb.height ?? ((bb.maxY != null && bb.minY != null) ? bb.maxY - bb.minY : null));
    const text = String(b.text ?? b.string ?? '').trim();
    if (!text || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    words.push({ text, x, y, w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0 });
  }
  if (!words.length) return [];

  // Median height sets the row tolerance, so this works in pixels or in Vision's
  // normalized 0..1 space without being told which.
  const heights = words.map(w => w.h).filter(h => h > 0).sort((a, b) => a - b);
  const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  const tol = (medH > 0 ? medH : spread(words.map(w => w.y)) / 40) * 0.6;

  words.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const w of words) {
    const row = rows.length ? rows[rows.length - 1] : null;
    if (row && Math.abs(w.y - row.y) <= tol) {
      row.words.push(w);
      row.y = (row.y * (row.words.length - 1) + w.y) / row.words.length; // running mean
    } else {
      rows.push({ y: w.y, words: [w] });
    }
  }
  return rows.map(r => r.words.sort((a, b) => a.x - b.x).map(w => w.text).join(' ').replace(/\s{2,}/g, ' ').trim())
             .filter(Boolean);
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }
function spread(arr) { const v = arr.filter(Number.isFinite); return v.length ? Math.max(...v) - Math.min(...v) : 0; }

// ── Line features ─────────────────────────────────────────────────────────────
// Labels frequently share a visual row with a right-aligned price or amount
// ("Straight Bet   -136", "MONEYLINE  -136", "WON  $17.35"). The blocks path
// rebuilds those rows faithfully, so every label test runs against a copy with the
// numbers taken out. Handicaps are LEFT IN: "Over 8.5" has to stay readable.
function bareLabel(text) {
  AM_ODDS_RE.lastIndex = 0;
  return String(text)
    .replace(AM_ODDS_RE, (all, b) => b)
    .replace(MONEY_RE, ' ')
    .replace(/[•·|]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[-–:,.\s]+|[-–:,.\s]+$/g, '')
    .trim();
}

function featurize(raw) {
  const text = raw.trim();
  const bare = bareLabel(text);
  const f = {
    raw: text,
    bare,
    chrome: isChrome(text) || (bare !== text && bare !== '' && isChrome(bare)),
    market: marketOf(text) || (bare !== text ? marketOf(bare) : null),
    header: betHeaderOf(text) || (bare !== text ? betHeaderOf(bare) : null),
    // Chrome is never a result: the "Cash Out" BUTTON on every open bet matches
    // the cashed-out badge pattern and was voiding pending slips wholesale. The
    // real settled badge reads "Cashed Out", which is not chrome.
    result: (isChrome(text) || (bare !== text && bare !== '' && isChrome(bare)))
      ? null
      : (resultOf(text) || (bare !== text ? resultOf(bare) : null)),
    matchup: matchupOf(text),
    time: timeHintOf(text),
    american: americanIn(text),
    fractional: [],
    handicaps: handicapIn(text),
    moneys: moneysIn(text),
    words: (text.match(/[A-Za-z]{2,}/g) || []).length,
  };
  // A market fused onto its own row-mate by a separator glyph: BetMGM prints
  // "Chargers \u2022 Money Line" (selection first), Caesars "Total Games | Bublik vs
  // Rublev" (matchup after). Neither line matches a bare market test, and both
  // slips died with no bets until this split.
  if (!f.market && /[\u2022\u00b7|]/.test(text)) {
    const segs = text.split(/[\u2022\u00b7|]/).map(x => x.trim()).filter(Boolean);
    if (segs.length >= 2) {
      const RESULT_EDGE = /^(won|win|lost|loss|push|void|voided|cashed\s*out)\s+|\s+(won|win|lost|loss|push|void|voided|cashed\s*out)$/i;
      for (let si = 0; si < segs.length; si++) {
        let mk = marketOf(segs[si]);
        // "Money Line WON": the settled badge shares the fused row's segment with
        // the market label on BetMGM.
        if (!mk) {
          const em = RESULT_EDGE.exec(segs[si]);
          if (em) {
            mk = marketOf(segs[si].replace(RESULT_EDGE, ' ').trim());
            if (mk && !f.result) f.result = resultOf((em[1] || em[2] || '').trim());
          }
        }
        if (!mk) continue;
        f.market = mk;
        const residual = segs.filter((_, j) => j !== si).join(' ').trim();
        const mu = matchupOf(residual);
        if (mu && !f.matchup) f.matchup = mu;
        else if (residual && /[a-z]{2}/i.test(residual)) f.inlineSelection = residual;
        break;
      }
    }
  }

  // Fractional odds only when nothing American is present (a US slip showing
  // "1/2" is almost always a record, e.g. "1/2 legs won").
  if (!f.american.length && /\d\s*\/\s*\d/.test(text) && !/leg|pick|of/i.test(text)) {
    f.fractional = fractionalIn(text);
  }
  if (!f.american.length && !f.fractional.length && EVEN_RE.test(text) && f.words <= 3) {
    f.american = [{ value: 100, index: 0 }];
  }
  f.oddsTokens = f.american.length ? f.american : f.fractional;
  // Money labels present on this line.
  f.stakeLabel  = STAKE_LABEL.test(text) && !PROFIT_LABEL.test(text) && !RETURN_LABEL.test(text);
  f.profitLabel = PROFIT_LABEL.test(text);
  f.returnLabel = RETURN_LABEL.test(text) && !PROFIT_LABEL.test(text);
  // A settled badge fused onto the END of a short row, no separator: "Match
  // Spread WIN" (ESPN BET per-leg), "TOTAL WAGER CASHED OUT" (FanDuel list),
  // "TOTAL WAGER WON ON FANDUEL". Anchored full-line tests cannot see these.
  // "to win" is excluded: that is a market/label phrase, not a verdict.
  if (!f.result && f.words <= 6) {
    const em = /(won\s+on\s+\w+|cashed\s*out|no\s*action|won|win|lost|loss|push|voided?)\s*$/i.exec(text);
    if (em && !/\bto\s+win$/i.test(text)) {
      const badge = resultOf(em[1]);
      if (badge) {
        f.result = badge;
        // The prefix may be the market the badge was stapled to.
        if (!f.market) {
          const prefix = text.slice(0, em.index).trim();
          if (prefix) f.market = marketOf(prefix);
        }
      }
    }
  }

  // A bare money label ("Wager" / "To Win" / "Paid" on its own row, amount on the
  // next) must never be readable as a selection: Hard Rock and BetRivers tickets
  // both print them exactly like that.
  f.bareMoneyLabel = (f.stakeLabel || f.profitLabel || f.returnLabel) && !f.moneys.length && f.words <= 3;
  // A "selection-ish" line: real words, not chrome, not a pure label.
  f.wordy = !f.chrome && f.words >= 1 && !f.market && !f.header && !f.result && !f.bareMoneyLabel;
  return f;
}

// ── Selection cleanup ─────────────────────────────────────────────────────────
// Strip the price and any trailing furniture off a selection line, then pull the
// handicap out of what remains.
function cleanSelection(text) {
  let s = String(text || '').replace(/^[xX*>\u2022\u00b7-]\s+/, '');
  AM_ODDS_RE.lastIndex = 0;
  s = s.replace(AM_ODDS_RE, (all, b) => b);              // drop prices
  s = s.replace(MONEY_RE, ' ');                          // drop dollar amounts
  s = s.replace(/\b(won|lost|push|void|cashed\s*out)\b/gi, ' ');
  s = s.replace(/[•·|]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^[-–:,.\s]+|[-–:,.\s]+$/g, '').trim();
  return s.slice(0, 120);
}

// Split "Lakers -4.5" into a side name and a line; "Over 220.5" into a total side.
function splitSelection(sel, marketType) {
  const out = { side_name: sel, line: null, total_side: null };
  if (!sel) return out;

  const tm = TOTAL_SIDE_RE.exec(sel);
  // Only treat a leading Over/Under as the total side (a team called "Overton"
  // must not qualify, hence the word boundary in the regex plus this check).
  if (tm && /^(over|under|o|u)$/i.test(tm[1])) {
    const side = /^o/i.test(tm[1]) ? 'over' : 'under';
    const val = parseFloat(tm[2]);
    // "Over 220.5" with nothing else is a pure total. "Lakers Team Total Over 110.5"
    // keeps its team as the side name.
    const rest = sel.replace(TOTAL_SIDE_RE, ' ').replace(/\s{2,}/g, ' ').trim();
    out.total_side = side;
    out.line = Number.isFinite(val) ? val : null;
    out.side_name = rest && marketType !== 'total' ? rest : (side === 'over' ? 'Over' : 'Under');
    if (!rest) out.side_name = side === 'over' ? 'Over' : 'Under';
    return out;
  }

  const hs = handicapIn(sel);
  if (hs.length) {
    // The handicap is the LAST signed number on the line (books print the team
    // first). Everything before it is the side name.
    const h = hs[hs.length - 1];
    out.line = h.value;
    out.side_name = sel.slice(0, h.index).trim().replace(/[-–:,.\s]+$/, '') || sel;
  }
  return out;
}

// ── Segmentation ──────────────────────────────────────────────────────────────
// One pass over the featurized lines. Legs are built market-first: when a market
// label appears, we look BACKWARD for the nearest unclaimed wordy line (the
// selection) and FORWARD/backward a short distance for the price.
//
// Bets are then assembled from legs: a parlay header claims the next N legs, and
// any leg not claimed by a parlay is its own straight bet. That is what makes a
// "My Bets" list of four singles come back as four bets without needing to know
// anything about the book's row chrome.
function segment(feats) {
  const legs = [];
  const claimed = new Set();

  for (let i = 0; i < feats.length; i++) {
    const f = feats[i];
    if (!f.market) continue;

    // Selection: nearest preceding wordy line not already used by another leg.
    let selIdx = -1;
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      if (claimed.has(j)) break;
      const g = feats[j];
      if (g.chrome || g.header || g.result) continue;
      if (g.matchup) continue;                       // matchups sit near, but are not the pick
      if (g.wordy || g.handicaps.length || g.oddsTokens.length) { selIdx = j; break; }
    }
    // Some books print the market ABOVE the selection. Fall forward if nothing behind.
    if (selIdx < 0) {
      for (let j = i + 1; j < feats.length && j <= i + 2; j++) {
        const g = feats[j];
        if (g.chrome || g.market || g.header) continue;
        if (g.matchup) continue;
        if (g.wordy) { selIdx = j; break; }
      }
    }

    const selLine = f.inlineSelection || (selIdx >= 0 ? feats[selIdx].raw : '');
    if (f.inlineSelection) selIdx = -1;   // nothing external was claimed
    const leg = {
      market: f.market,
      marketLabel: f.raw,
      selectionRaw: selLine,
      odds: null,
      line: null,
      matchup: null,
      time: null,
      result: null,
      at: i,
    };
    if (selIdx >= 0) claimed.add(selIdx);
    claimed.add(i);

    // Price: the selection line first (books right-align it there), then the
    // market line, then the two lines after.
    const oddsFrom = (g) => (g && g.oddsTokens.length ? g.oddsTokens[g.oddsTokens.length - 1].value : null);
    leg.odds = oddsFrom(feats[selIdx]) ?? oddsFrom(f);
    if (leg.odds == null) {
      for (let j = i + 1; j < feats.length && j <= i + 4; j++) {
        if (feats[j].market || feats[j].header) break;
        const v = oddsFrom(feats[j]);
        if (v != null) { leg.odds = v; claimed.add(j); break; }
      }
    }

    // Matchup + start time: scan OUTWARD from the market label and take the nearest
    // UNCLAIMED one. Both matter. On a stacked parlay the windows of adjacent legs
    // overlap, so a first-index scan hands leg 2 the matchup that already belongs to
    // leg 1 (every leg then grades against the wrong game), and without the claim
    // check the same line is reused by all of them.
    const window = [];
    for (let d = 1; d <= 4; d++) { window.push(i + d, i - d); }
    for (const j of window) {
      if (j < 0 || j >= feats.length) continue;
      const g = feats[j];
      if (!leg.matchup && g.matchup && !claimed.has(j)) { leg.matchup = g.matchup; claimed.add(j); }
      if (!leg.time && g.time) leg.time = g.time;
    }
    // Result badge sitting immediately around the leg (per-leg on parlay slips).
    for (let j = i - 2; j <= i + 2; j++) {
      if (j < 0 || j >= feats.length) continue;
      if (feats[j].result && !leg.result) { leg.result = feats[j].result; }
    }
    legs.push(leg);
  }

  return { legs, claimed };
}

// Assemble legs into bets using the headers found in the text.
function assemble(feats, legs) {
  const headers = [];
  feats.forEach((f, i) => {
    if (!f.header) return;
    // A share card prints the combined price ON the header row ("Straight Bet  -136")
    // or immediately under it. Claim it here so a parlay keeps the book's own number
    // instead of our product of the legs, which drifts by a point or two on rounding.
    let odds = f.oddsTokens.length ? f.oddsTokens[f.oddsTokens.length - 1].value : null;
    if (odds == null) {
      for (let j = i + 1; j < feats.length && j <= i + 2; j++) {
        const g = feats[j];
        if (g.market || g.header || g.wordy) break;
        if (g.oddsTokens.length) { odds = g.oddsTokens[g.oddsTokens.length - 1].value; break; }
      }
    }
    headers.push({ ...f.header, odds, at: i });
  });

  const bets = [];
  const used = new Set();

  for (const h of headers) {
    if (h.kind === 'straight') continue;              // handled by the leftover pass
    // Legs belonging to this header: the ones after it, up to the next header.
    const nextAt = headers.filter(x => x.at > h.at).reduce((m, x) => Math.min(m, x.at), Infinity);
    let mine = legs.filter(l => l.at > h.at && l.at < nextAt && !used.has(l));
    // Legs BEFORE the header: a betslip under construction prints the summary at
    // the BOTTOM ("Parlay (3 Picks)  +750" under the picks — BetRivers, and the
    // builder flows on most books), so when nothing follows the header, claim the
    // unclaimed legs above it. Bounded to a short reach so a stray "parlay" word
    // far below an odds grid cannot vacuum up half the screen.
    if (mine.length < 2) {
      const prevAt = headers.filter(x => x.at < h.at).reduce((m, x) => Math.max(m, x.at), -1);
      const back = legs.filter(l => l.at < h.at && l.at > prevAt && h.at - l.at <= 14 && !used.has(l));
      mine = back.concat(mine);
    }
    if (h.legs && mine.length > h.legs) mine = mine.slice(0, h.legs);
    if (mine.length < 2) {
      // EXACTLY ZERO legs plus a price = the settled-ticket shape. ONE leg is
      // different: that is a cropped screenshot of a normal parlay, and inventing
      // a legless parlay NEXT TO the leg (which the leftover pass then also emits
      // as a straight) would mint two bets from one. The one-leg case keeps the
      // old rule: drop the header, let the leg stand as a straight.
      if (mine.length === 1) continue;
      // No legs to claim. When the header carries its OWN price this is still a
      // real bet — the Hard Rock winner ticket is exactly this shape ("PARLAY
      // 6-Bet Parlay / +6576031 / <comma-joined legs> / Wager / $30.11"): the leg
      // summary is one prose line with no market labels, so segmentation finds
      // nothing, and dropping the header threw away a $1.98M settled parlay. A
      // header with no price stays dropped (a bare "Parlay" word is not a bet).
      if ((h.kind === 'parlay' || h.kind === 'exotic') && h.odds != null) {
        bets.push({ kind: h.kind === 'exotic' ? 'exotic' : 'parlay', header: h, legs: [], at: h.at });
      }
      continue;
    }
    mine.forEach(l => used.add(l));
    bets.push({ kind: h.kind === 'exotic' ? 'exotic' : 'parlay', header: h, legs: mine, at: h.at });
  }

  // Leftover legs are straight bets. Each claims the nearest "Straight Bet" header
  // sitting above it, which is where a share card prints the price (the leg itself
  // has none: FanDuel puts "Straight Bet" and "-136" on one row, the selection on
  // the next). A header is claimed at most once.
  const straightHeaders = headers.filter(h => h.kind === 'straight');
  const takenHeaders = new Set();
  for (const l of legs) {
    if (used.has(l)) continue;
    let own = null;
    for (const h of straightHeaders) {
      if (h.at >= l.at || takenHeaders.has(h)) continue;
      // Must be closer to this leg than any other leg is.
      if (legs.some(o => o !== l && o.at > h.at && o.at < l.at)) continue;
      if (!own || h.at > own.at) own = h;
    }
    if (own) takenHeaders.add(own);
    bets.push({ kind: 'straight', header: own, legs: [l], at: own ? own.at : l.at });
  }
  bets.sort((a, b) => a.at - b.at);
  return bets;
}

// ── Money assignment ──────────────────────────────────────────────────────────
// Amounts belong to the bet whose span they fall in. A bet's span runs from its
// header (or first leg) to the start of the next bet.
function assignMoney(feats, bets, book) {
  // The app's top bar prints the BOOK NAME next to the ACCOUNT BALANCE
  // ("ESPNBET RG $27.56"), and the first bet's span reaches the top of the
  // screenshot, so the balance read as the wager. Money on a row that carries the
  // book's own tell is chrome.
  const tells = (book && book.key) ? (BOOKS.find(b => b.key === book.key) || {}).tells || [] : [];
  const isBookBar = (f) => tells.some(t => f.raw.toLowerCase().includes(t));
  // A bet OWNS the lines from its own anchor (its header, or its first leg when
  // there is no header) up to the next bet's anchor. The first bet also reaches
  // back to the top of the slip, where a lone amount above the header sometimes
  // sits.
  //
  // The end boundary must NOT be pulled back off the next anchor. It used to be
  // `nextAnchor - 3`, which on a tightly packed My Bets list cut off the tail of
  // the CURRENT bet: "Toronto Tempo @ Seattle Storm  To Win $10.50" fell outside
  // its own bet's span and every To Win in the list came back null.
  const anchorOf = (b) => (b.header ? b.header.at : b.legs[0].at);
  const bounds = bets.map((b, i) => ({
    start: i === 0 ? 0 : anchorOf(b),
    end: i + 1 < bets.length ? anchorOf(bets[i + 1]) : feats.length,
  }));

  bets.forEach((bet, bi) => {
    const { start, end } = bounds[bi];
    let stake = null, toWin = null, ret = null, loose = [];
    const claimedNext = new Set();
    for (let i = start; i < end && i < feats.length; i++) {
      const f = feats[i];
      // Chrome carries money too: the account-balance chip at the top of every
      // book's My Bets screen is "$0.00", and reading it as the wager would put a
      // zero-stake bet in the user's record.
      if (f.chrome || (f.moneys.length && isBookBar(f))) continue;

      // A label on its OWN row with the amount on the NEXT row — how a ticket
      // prints its footer ("Wager" / "$30.11" / "Paid" / "$1,980,043.01" on the
      // Hard Rock winner slip; "Wager" / "10.00" / "To Win" / "75.00" on
      // BetRivers). Same-line labels used to be the only shape we read.
      if (f.bareMoneyLabel && i + 1 < end && i + 1 < feats.length) {
        const g = feats[i + 1];
        if (!g.chrome && g.moneys.length && g.words <= 2) {
          // The bound row can be a COLUMN DUMP ("$700.00 -200 $1,050.00" under a
          // "Stake / Odds / Payout" header row): the stake is the FIRST figure,
          // the payout the LAST, and whatever a label does not claim stays loose
          // so the payout math still happens.
          const vals = g.moneys.map(m => m.value).filter(v => v > 0);
          if (vals.length) {
            if (f.profitLabel && toWin == null) { toWin = vals[vals.length - 1]; vals.pop(); }
            else if (f.stakeLabel && stake == null) { stake = vals[0]; vals.shift(); }
            else if (f.returnLabel && ret == null) { ret = vals[vals.length - 1]; vals.pop(); }
            for (const v of vals) loose.push(v);
            claimedNext.add(i + 1);
          }
        }
        continue;
      }
      if (claimedNext.has(i) || !f.moneys.length) continue;
      const amount = f.moneys[f.moneys.length - 1].value;
      if (!(amount > 0)) continue;
      // A label line carrying TWO amounts is stake-then-result ("Stake £1.00 To
      // Return £2.25", "$10 wins $50.00"): the first number is what was risked.
      const first = f.moneys[0].value;
      if (f.moneys.length >= 2 && first > 0 && first !== amount && stake == null &&
          (f.profitLabel || f.returnLabel)) {
        stake = first;
      }
      if (f.profitLabel && toWin == null) toWin = amount;
      else if (f.stakeLabel && stake == null) stake = amount;
      else if (f.returnLabel && ret == null) ret = amount;
      else if (!f.profitLabel && !f.stakeLabel && !f.returnLabel) {
        // Column dumps put stake AND payout on one unlabeled row; keep them all.
        for (const m of f.moneys) if (m.value > 0) loose.push(m.value);
      }
    }
    // "$25.00 → $47.73" style settled rows: two loose amounts, stake then return.
    if (stake == null && loose.length) stake = loose[0];
    // Column dumps ("$700.00 -200 $1,050.00") land every figure in loose: the
    // largest trailing amount above the stake is the payout.
    if (ret == null && stake != null && loose.length >= 2 && loose[loose.length - 1] > stake) {
      ret = loose[loose.length - 1];
    }
    if (toWin == null && ret != null && stake != null && ret > stake) toWin = +(ret - stake).toFixed(2);
    if (toWin == null && stake == null && loose.length >= 2) { stake = loose[0]; toWin = null; }
    bet.stake = stake;
    bet.toWin = toWin;
    bet.payoutTotal = ret;
    // The span's own result, win > loss > push > void: a settled parlay prints a
    // Void badge on a dropped leg AND the WON banner, and void must not win.
    const spanSeen = new Set();
    for (let i = start; i < end && i < feats.length; i++) if (feats[i].result) spanSeen.add(feats[i].result);
    bet.spanResult = ['win', 'loss', 'push', 'void'].find(r => spanSeen.has(r)) || null;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Parse a betslip screenshot's OCR output.
 *
 * @param {object|string} input  { text, blocks } or a plain text string.
 *        text   : OCR text, newline separated.
 *        blocks : optional positioned words from Vision / ML Kit. When present
 *                 they REPLACE text for line reconstruction (they are strictly
 *                 better: real visual rows instead of OCR reading order).
 * @returns {{book, bookKey, capture, bets, warnings, lines}}
 */
function parseBetslip(input) {
  const opts = typeof input === 'string' ? { text: input } : (input || {});
  const rawText = String(opts.text || '');
  const blockLines = opts.blocks && opts.blocks.length ? linesFromBlocks(opts.blocks) : null;

  const source = blockLines && blockLines.length
    ? normalizeOcr(blockLines.join('\n'))
    : normalizeOcr(rawText);

  const lines = source.split('\n').filter(Boolean);
  const lower = source.toLowerCase();
  const warnings = [];

  const book = detectBook(lower);
  const feats = lines.map(featurize);

  // PLAUSIBILITY GATE. Without this, any image containing the word "Total" reads
  // as a totals bet: a restaurant receipt ("Total 16.50") produced a tracked bet in
  // testing. Demand at least one thing that only ever appears on a betslip before
  // reading anything as a bet. "Total" on its own is deliberately NOT evidence
  // (it is the single most common word on any receipt); "Total Runs" is.
  const AMBIGUOUS_MARKET = /^totals?$/i;
  const hasEvidence = !!book.key
    || feats.some(f => f.header)
    || feats.some(f => f.american.length)
    || feats.some(f => f.matchup)
    || feats.some(f => f.result)
    || feats.some(f => f.market && !AMBIGUOUS_MARKET.test(f.bare));
  if (!hasEvidence) {
    // `no_bet_found` rides along so a caller can key on that one warning for every
    // empty result, whatever the reason.
    return { book: book.label, bookKey: book.key, capture: 'unknown', bets: [], warnings: ['not_a_betslip', 'no_bet_found'], lines };
  }

  const { legs } = segment(feats);
  const bets = assemble(feats, legs);
  assignMoney(feats, bets, book);

  // Slip-wide result, used when a settled row does not repeat its badge per bet.
  // PRECEDENCE, not first-found: a settled parlay with one voided leg shows a
  // Void badge AND the WON banner (FanDuel prints both), and first-found turned a
  // $688 winner into no-action. A decided result always outranks void.
  const seen = new Set(feats.map(f => f.result).filter(Boolean));
  const slipResult = ['win', 'loss', 'push', 'void'].find(r => seen.has(r)) || null;

  const out = bets.map(b => finishBet(b, book, slipResult)).filter(Boolean);
  if (out.length === 1 && !out[0].result && slipResult) out[0].result = slipResult;

  // Capture type is a hint for the UI, not a gate.
  let capture = 'slip';
  if (/more ways to share|share in the .*community|copy image/i.test(source)) capture = 'share_card';
  else if (out.length > 1) capture = 'list';
  else if (out.some(b => b.result)) capture = 'settled';
  if (out.length && out.every(b => b.stake == null) && capture === 'slip') capture = 'share_card';

  if (!out.length) warnings.push('no_bet_found');
  for (const b of out) {
    if (b.odds == null) warnings.push('missing_odds');
    if (b.bet_type === 'parlay' && b.legs.some(l => l.odds == null)) warnings.push('parlay_leg_missing_odds');
  }

  return {
    book: book.label, bookKey: book.key,
    capture,
    bets: out,
    warnings: [...new Set(warnings)],
    lines,
  };
}

// Turn a segmented bet into the shape the API and the app speak.
function finishBet(b, book, slipResult) {
  const legs = b.legs.map(l => {
    const sel = cleanSelection(l.selectionRaw);
    const parts = splitSelection(sel, l.market);
    let betType = l.market;
    if (betType === 'total' && parts.total_side) betType = parts.total_side;   // 'over' | 'under'
    else if (betType === 'total' && !parts.total_side) betType = 'over';       // total with no side read
    return {
      bet_type: betType === 'ml' || betType === 'spread' || betType === 'over' || betType === 'under' ? betType
              : betType === 'future' ? 'future' : 'prop',
      market: l.market,
      market_label: l.marketLabel,
      selection: parts.side_name || sel,
      line: parts.line,
      odds: l.odds,
      matchup: l.matchup,
      start_hint: l.time,
      result: l.result,
    };
  }).filter(l => l.selection || l.odds != null);

  const isHeaderParlay = b.kind === 'parlay' || b.kind === 'exotic';
  // Legless is only meaningful for a header-backed parlay (the settled-ticket
  // shape, where the legs are one prose line segmentation cannot anchor on).
  if (!legs.length && !(isHeaderParlay && b.header && b.header.odds != null)) return null;

  const isParlay = isHeaderParlay || legs.length > 1;
  let odds = null;
  if (isParlay) {
    // Prefer a printed combined price near the header; otherwise multiply the legs.
    odds = b.header && b.header.odds != null ? b.header.odds : null;
    if (odds == null) {
      let dec = 1, n = 0;
      for (const l of legs) { const d = americanToDecimal(l.odds); if (d != null) { dec *= d; n++; } }
      odds = n === legs.length && n > 0 ? decimalToAmerican(dec) : null;
    }
  } else {
    // Leg price first, then the header's (share cards print it there only).
    odds = legs[0].odds ?? (b.header ? b.header.odds ?? null : null);
  }
  if (odds == null) odds = oddsFromMoney(b.stake, b.toWin);

  // A straight bet owns its leg's badge. A PARLAY does not: leg badges belong to
  // the legs (a settled FanDuel SGP prints Void on the dropped leg while the
  // ticket itself says WON), so the parent takes the span banner, falling back to
  // "any leg lost = lost".
  const result = isParlay
    ? (b.spanResult || (legs.some(l => l.result === 'loss') ? 'loss' : null))
    : (legs.find(l => l.result)?.result || b.spanResult || null);

  const bet = {
    bet_type: isParlay ? 'parlay' : legs[0].bet_type,
    // The market LABEL rides along on a straight bet too. betslip_match reads it
    // for the sport hint, and without it "Toronto -1.5 / Run Line" has nothing to
    // separate the Blue Jays from Toronto FC and the Maple Leafs.
    market: isParlay ? 'parlay' : legs[0].market,
    market_label: isParlay ? (b.header ? b.header.label || null : null) : legs[0].market_label,
    selection: isParlay
      ? `${legs.length || (b.header && b.header.legs) || ''}-leg ${b.header && b.header.sameGame ? 'same game parlay' : 'parlay'}`.replace(/^-leg /, '')
      : legs[0].selection,
    line: isParlay ? null : legs[0].line,
    odds,
    stake: b.stake ?? null,
    to_win: b.toWin ?? null,
    payout_total: b.payoutTotal ?? null,
    result,
    book: book.label || null,
    matchup: isParlay ? null : legs[0].matchup,
    start_hint: isParlay ? null : legs[0].start_hint,
    legs: isParlay ? legs : [],
    confidence: 0,
  };
  bet.confidence = scoreConfidence(bet);
  return bet;
}

// 0..1. Drives the app's copy ("looks right" vs "check these numbers") and the
// import endpoint's willingness to auto-match. Deliberately conservative: a bet
// with no price is never above a half.
function scoreConfidence(bet) {
  let s = 0;
  if (bet.selection && bet.selection.length >= 2) s += 0.30;
  if (bet.odds != null) s += 0.30;
  if (bet.matchup) s += 0.15;
  if (bet.stake != null) s += 0.10;
  if (bet.bet_type !== 'prop') s += 0.05;
  if (bet.line != null || bet.bet_type === 'ml' || bet.bet_type === 'parlay') s += 0.10;
  if (bet.bet_type === 'parlay' && bet.legs.every(l => l.odds != null)) s += 0.05;
  return Math.min(1, +s.toFixed(2));
}

module.exports = {
  parseBetslip,
  // exported for tests + the matcher
  linesFromBlocks, normalizeOcr, detectBook, marketOf, betHeaderOf, resultOf,
  matchupOf, americanIn, handicapIn, moneysIn, cleanSelection, splitSelection,
  oddsFromMoney, americanToDecimal, decimalToAmerican, isChrome,
  BOOKS,
};
