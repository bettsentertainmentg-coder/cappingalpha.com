// src/reader.js
// Receives a raw Discord message, uses Claude Haiku to extract pick data.
// Returns a clean structured pick object or null.
// No DB writes, no scoring, no Discord.
//
// ── To add or change extraction rules: edit the RULES constant below ──────────
// The RULES block is prompt-cached by Anthropic — changes are free and instant.

const Anthropic = require('@anthropic-ai/sdk');
const db        = require('./db');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY_READER,
  defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
});
const MODEL  = 'claude-haiku-4-5-20251001';

// Haiku 4.5 pricing (USD per token)
const PRICE = {
  input:         0.80  / 1_000_000,
  output:        4.00  / 1_000_000,
  cache_write:   1.00  / 1_000_000,  // input + 25% surcharge
  cache_read:    0.08  / 1_000_000,  // 10% of input price
};

const logUsageStmt = db.prepare(`
  INSERT INTO api_usage (model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function logUsage(usage) {
  try {
    const input  = usage.input_tokens              || 0;
    const output = usage.output_tokens             || 0;
    const cwrite = usage.cache_creation_input_tokens || 0;
    const cread  = usage.cache_read_input_tokens   || 0;
    const cost   = (input * PRICE.input) + (output * PRICE.output)
                 + (cwrite * PRICE.cache_write) + (cread * PRICE.cache_read);
    logUsageStmt.run(MODEL, input, output, cwrite, cread, cost);
  } catch (err) {
    console.warn('[reader] usage log error:', err.message);
  }
}

// ── Learned corrections — injected as second system block (not cached) ────────
let _correctionsCache    = null;
let _correctionsCacheTime = 0;
const CORRECTIONS_TTL = 5 * 60 * 1000;

function getCorrectionsBlock() {
  const now = Date.now();
  if (_correctionsCache !== null && (now - _correctionsCacheTime) < CORRECTIONS_TTL) return _correctionsCache;
  try {
    const rows = db.prepare(`
      SELECT message_text, correct_picks, is_no_pick, notes
      FROM reader_corrections ORDER BY created_at DESC LIMIT 10
    `).all();
    if (!rows.length) { _correctionsCache = ''; _correctionsCacheTime = now; return ''; }
    const examples = rows.map(r => {
      const preview = r.message_text.replace(/\n/g, ' ').slice(0, 140);
      if (r.is_no_pick) {
        return `  Msg: "${preview}" → is_pick=false${r.notes ? ' [' + r.notes + ']' : ''}`;
      }
      const picks = JSON.parse(r.correct_picks || '[]');
      const pStr = picks.map(p => {
        let s = `team=${p.team}, pick_type=${p.pick_type}`;
        if (p.sport)         s += `, sport=${p.sport}`;
        if (p.spread != null && p.spread !== '') s += `, spread=${p.spread}`;
        if (p.capper_name)   s += `, capper=${p.capper_name}`;
        return s;
      }).join(' | ');
      return `  Msg: "${preview}" → ${pStr || 'is_pick=false'}${r.notes ? ' [' + r.notes + ']' : ''}`;
    }).join('\n');
    _correctionsCache = `LEARNED CORRECTIONS — override all rules above:\n${examples}`;
    _correctionsCacheTime = now;
    return _correctionsCache;
  } catch (_) { _correctionsCache = ''; _correctionsCacheTime = Date.now(); return ''; }
}

// ── Today's games context — injected per call, not cached in system prompt ────
let _gamesCache     = null;
let _gamesCacheTime = 0;
const GAMES_CACHE_TTL = 5 * 60 * 1000; // 5 min

function getTodaysGamesContext() {
  const now = Date.now();
  if (_gamesCache !== null && (now - _gamesCacheTime) < GAMES_CACHE_TTL) return _gamesCache;
  try {
    const games = db.prepare(`
      SELECT espn_game_id, sport, home_short, away_short, home_abbr, away_abbr
      FROM today_games WHERE status != 'post'
      ORDER BY sport, start_time
    `).all();

    if (!games || games.length === 0) { _gamesCache = ''; _gamesCacheTime = now; return ''; }

    const bySport = {};
    for (const g of games) {
      (bySport[g.sport] = bySport[g.sport] || []).push(g);
    }

    const lines = ["Today's games — match picks to these when confident. Return espn_game_id + picked_side (home/away)."];
    for (const [sport, sg] of Object.entries(bySport)) {
      lines.push(`${sport}: ` + sg.map(g =>
        `${g.away_short}(${g.away_abbr}) @ ${g.home_short}(${g.home_abbr}) [id:${g.espn_game_id}]`
      ).join(', '));
    }

    _gamesCache     = lines.join('\n');
    _gamesCacheTime = now;
    return _gamesCache;
  } catch (err) {
    console.warn('[reader] games context error:', err.message);
    _gamesCache = ''; _gamesCacheTime = Date.now();
    return '';
  }
}

// ── Extraction rules — edit this block to tune pick parsing ──────────────────
// Keep examples concrete. Claude follows instructions precisely — fewer
// examples needed than Ollama, but specifics still help on edge cases.
const RULES = `
You are extracting sports betting picks from Discord messages posted by cappers and people leaking capper messages (handicappers).

PICK TYPE — exactly one of: "ML", "spread", "over", "under", "NRFI"

ML — team wins outright.
  "Padres ML" → ML
  "Royals ML 2u" → ML (2u = unit size, ignore)
  "Stars reg" → ML ("reg" = regulation win = ML)
  "1U Marlins ML" → ML
  "Hurricanes 3way in regulation" → ML ("3way"/"3-way" = win/loss/tie market = ML; "reg"/"regulation" = ML)
  "Guardians Moneyline -130" → Guardians ML (-130 is juice). "Moneyline" spelled out = ML.
  "Athletics Moneyline -140 and Over 9 Runs" → TWO picks: Athletics ML + Athletics over 9.
  A team name alone on its own line with NO spread number and NO over/under indicator → ML.

spread — team name followed by a +/- number under 100.
  "Orioles -1.5" → spread -1.5
  "Orioles -1.5 5u" → spread -1.5 (5u = unit size, ignore)
  "Blue Jays F5 +.5 3u" → spread +0.5 (F5 = first 5 innings, still spread)
  "Suns -10" → spread -10
  "Run Line" in MLB = spread. "Yankees Run Line -1.5 +125" → Yankees spread -1.5 (+125 is juice, ignore).

over — word "over" OR standalone letter "o" BEFORE a number.
  "over 228.5" → over, spread_value=228.5
  "oilers&sharks o6" → team=Oilers, over, 6
  "Marlins / Reds O11" → team=Marlins, over, 11

under — word "under" OR standalone letter "u" BEFORE a number.
  "under 7.5" → under, spread_value=7.5
  "Stars u 5.5" → under, 5.5
  "u 228.5" → under, 228.5

NRFI — No Run First Inning. MLB only. Valid pick type.
  "Diamondbacks NRFI" → team=Diamondbacks, pick_type=NRFI, sport=MLB.
  "Mets NRFI -130" → team=Mets, pick_type=NRFI, sport=MLB. (-130 is juice, ignore)

UNIT SIZE / BET SIZING / STAR RATINGS — ignore completely, extract the pick normally.
  Unit sizes: "5u", "3u", "2u", "0.75u", "1U". Bet percentages: "4%", "10%". Star ratings: "1*", "2*", "3*", "5*".
  "Royals ML 2u" → Royals ML. "Orioles -1.5 5u" → Orioles spread -1.5.
  "4% NHL / Hurricanes 3way" → ignore "4% NHL", extract Hurricanes ML.
  "1* Pirates -139" → Pirates ML (-139 is juice). "3* MLB TOTAL OF WEEK" → section label, not a pick.
  A line containing ONLY a unit size, star rating, or percentage is NOT a pick.

RECORDS — not picks, skip entirely.
  "(16-4)", "MLB 2026: -35.3units", "61-34 NHL", "Overall Record 2-5", "Contest Record 2-5"
  Any line that is purely a win-loss record or unit tally = skip.

CAPPER NAME — appears alone on a line before picks, or as the first line of a message block.
  "Mrbigbets lunch $" → capper_name=Mrbigbets
  "Zapped bets (16-4)" → capper_name=Zapped bets
  "NewYorkSharps 10% Exclusive: ..." → capper_name=NewYorkSharps
  "BataBingBets: (87-39 MLB)..." → capper_name=BataBingBets

MATCHUP FORMAT "Team A / Team B line", "Team A & Team B line", or "Team A vs. Team B line" — first team is the pick.
  "Marlins / Reds under 7.5 3u" → team=Marlins, under, 7.5
  "oilers&sharks o6" → team=Oilers, over, 6
  "Lakers / Warriors +4" → team=Lakers, spread, +4
  "Giants vs. Nationals Over 8 Runs" → team=Giants, over, 8 ("Runs" is a unit word, ignore).
  "Rays vs. Pirates Under 8.5 Runs" → team=Rays, under, 8.5.
  "Kansas City Royals at New York Yankees: F5 Total Under 4.5" → team=Royals, under, 4.5.
  "Team A at Team B" format — first team is AWAY (the pick is still the first team).

TEAM — return exactly as the capper wrote it. The system resolves it.
  3-4 letter abbreviations are valid: "VGK ML" → team=VGK. "TOR +1.5" → team=TOR.
  ALL CAPS is valid: "ROYALS ML" → team=Royals.
  If a city prefix precedes a full nickname ("CIN Reds" → "Reds"), drop the prefix.
  Do not change pluralization: "Thunders" → "Thunder". "Sox" stays "Sox".

SPORT — one of: NBA, CBB, WCBB, NFL, NHL, MLB, NCAAF, ATP, WTA, Golf.
  Determine from team names and context.
  WCBB only if message explicitly says "women" or "WNCAA".
  ATP = men's professional tennis. WTA = women's professional tennis.

TENNIS (ATP/WTA) — "team" is the player's last name or full name as written.
  "Djokovic ML" → team=Djokovic, pick_type=ML, sport=ATP
  "Sinner ML 2u" → team=Sinner, pick_type=ML, sport=ATP
  "Alcaraz -4.5 games" → team=Alcaraz, pick_type=spread, spread_value=-4.5, sport=ATP
  "Swiatek ML" → team=Swiatek, pick_type=ML, sport=WTA
  Player names are NOT capper_name values. Use ATP unless the message explicitly says WTA.

MONEYLINE ODDS vs SPREAD — critical rule:
  abs(number) < 100 → SPREAD. abs(number) >= 100 → ML (do not set spread_value).
  "Suns -10" → spread -10.  "Magic -6.5" → spread -6.5.
  "Brewers +120" → ML.  "Padres -108" → ML.

BETTING JUICE — ignore, extract the pick normally.
  "Knicks -6 -110 @ ProphetX" → Knicks spread -6. "Bulls ML (-115)" → Bulls ML.
  Sportsbook references after "@" (e.g. "@DK", "@FanDuel") are never part of the pick.

EXOTIC BETS — skip entirely.
  YRFI, F5 (first 5 innings standalone), alt lines, same-game parlays → skip.

PLAYER PROPS — skip entirely.
  Skip if subject is a person's individual stat performance, not a team result.
  Signal: player first + last name before a stat ("LeBron u 25.5 PTS" → skip).
  Signal: stat words after the number: outs, strikeouts, Ks, yards, TDs, pts, assists, rebounds, hits.
  "Rhett Lowder (Reds) u 15.5 outs" → skip. "Allen (CLE) O7.5 REB" → skip.

IGNORE: emoji, reactions, "local book", context odds like "(+179)", parlay references, "NOT EXCLUSIVE".
  Also ignore: "Best Bet:" prefix (extract the pick that follows normally).
  Also ignore: pitcher names in parentheses like "(Chandler)" or "(Cease)" in MLB picks.
  Also ignore: game times like "6:45 pm", "8:00 pm" appended to a pick line.
  Also ignore: section headers like "MLB Selections", "UFL Football Selections", "NBA", "MLB" alone on a line — these are sport/section labels, not picks.
  Also ignore: "Action" at the end of a pick line — it is a sportsbook qualifier, not part of the pick.

MONEYLINE ABBREVIATION "MI":
  "MI" means moneyline. Treat identically to "ML".
  "Suns MI" → Suns ML. "Lakers MI" → Lakers ML. "Thunder MI 2u" → Thunder ML.

MULTI-CAPPER BLOCKS — a single Discord message may contain picks from multiple cappers.
  A capper header looks like: emoji + name + optional label.
  "🔮PorterPicks Full Card Thursday" → capper_name=PorterPicks for all picks that follow, until the next capper header.
  "🔮P4D_Picks4Dayzzz" alone on a line → capper_name=P4D_Picks4Dayzzz.
  Emoji prefixes (✅ 🔮 ⚾ 🏀 🏒 🎾 💎 🔥 ✔️ 🟢 etc.) before a name are capper markers — strip the emoji, the text before any space or bracket is the capper handle.
  "Full Card [Day]", "Today's Card", "Card for [Day]", "Full Card" after the name are section labels — ignore, not picks.
  When a new emoji-prefixed capper line appears, switch capper_name for all picks that follow.
  Extract ALL picks from the message, each labeled with their correct capper_name.

EMBEDDED CARDS / TREND CARDS (TrendsCenter and similar bots):
  These bots post embed cards with image attachments and a card title.
  Ignore image attachments entirely. Ignore card titles like "Trends Center", "TrendsCenter Alert".
  Extract the pick ONLY from the plain text description: e.g. "Trends heavily favor the [Team] to cover tonight" → team=[Team], pick type from context.
  "Public money and sharp action on [Team] ML" → team=[Team], pick_type=ML.
  If no clear pick can be identified from plain text alone, return is_pick=false — do not guess.

GOLF (PGA Tour) — sport=Golf. "team" is the player's last name or full name as written.
  Outright tournament winner: "DeChambeau ML" → team=DeChambeau, pick_type=ML, sport=Golf.
  Head-to-head matchup: "Rory -115 over Scheffler" → team=McIlroy, pick_type=h2h, vs_player=Scheffler, sport=Golf.
  "Rory over Scheffler" (no number) → team=McIlroy, pick_type=h2h, vs_player=Scheffler, sport=Golf.
  Top N finish: "Scheffler top 5" → team=Scheffler, pick_type=top5, sport=Golf.
               "Rory top 10" → team=McIlroy, pick_type=top10, sport=Golf.
  Round score prop: "Rory under 67.5" → team=McIlroy, pick_type=under, spread_value=67.5, sport=Golf.
  CRITICAL: "over" in a golf head-to-head ("Rory over Scheffler") means Rory wins the matchup — pick_type=h2h, NOT pick_type=over.
  Only use pick_type=over/under for golf when a numeric score line is present (e.g. "under 67.5 strokes").
  Golf player names are NOT capper names. Use pick context (odds, "over [opponent name]", "top N") to distinguish.
  Do not infer sport=Golf from player names alone — there must be explicit golf context (tournament name, "Masters", "PGA", "top 5 finish", etc.).

GAME MATCHING — When today's games are listed in the message, match each pick to a game.
  Team name is the primary signal. Spread value is a secondary hint only — lines move, so close is fine.
  Return espn_game_id and picked_side when confident. Omit both if the team isn't playing today or uncertain.
  "Yanks ML" → matches Yankees game → espn_game_id + picked_side=away or home depending on matchup.
  Golf picks: do not attempt to match golf picks to today_games — omit espn_game_id for all Golf picks.
`.trim();

// ── Tool schema — Claude always returns this shape; no JSON parsing needed ────
const EXTRACT_TOOL = {
  name: 'extract_picks',
  description: 'Extract all sports betting picks found in a Discord message',
  input_schema: {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        description: 'All picks found. Use [{is_pick:false}] when none.',
        items: {
          type: 'object',
          properties: {
            is_pick:      { type: 'boolean', description: 'true if this is a valid pick' },
            team:         { type: 'string',  description: 'Team name or player name exactly as capper wrote it' },
            pick_type:    { type: 'string',  enum: ['ML', 'spread', 'over', 'under', 'NRFI', 'h2h', 'top5', 'top10'] },
            spread_value: { type: 'number',  description: 'The spread or total number (e.g. -1.5, 8.5). Omit for ML.' },
            sport:        { type: 'string',  enum: ['NBA', 'CBB', 'WCBB', 'NFL', 'NHL', 'MLB', 'NCAAF', 'ATP', 'WTA', 'Golf'] },
            capper_name:  { type: 'string',  description: "The capper's handle or name. Omit if not clear." },
            vs_player:    { type: 'string',  description: 'Opponent player name for golf head-to-head (h2h) picks. Omit for non-golf or non-h2h picks.' },
            sport_record: { type: 'string',  description: 'Win-loss record string e.g. "27-21 CBB". Omit if not present.' },
            espn_game_id: { type: 'string',  description: "The id from today's games list if you matched this pick to a game. Omit if uncertain." },
            picked_side:  { type: 'string',  enum: ['home', 'away'], description: "Whether the picked team is home or away in the matched game. Include when espn_game_id is set." },
          },
          required: ['is_pick'],
        },
      },
    },
    required: ['picks'],
  },
};

// ── Single Claude API call ────────────────────────────────────────────────────
// RULES (system message) is cached — only the instruction + message vary per call.
async function claudeExtract(channelInstruction, messageContent) {
  try {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      system: (() => {
        const blocks = [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral' } }];
        const corrections = getCorrectionsBlock();
        if (corrections) blocks.push({ type: 'text', text: corrections });
        return blocks;
      })(),
      tools:       [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_picks' },  // always use the tool
      messages: [
        {
          role:    'user',
          content: [getTodaysGamesContext(), channelInstruction, `Message:\n${messageContent}`]
            .filter(Boolean).join('\n\n'),
        },
      ],
    });

    if (response.usage) logUsage(response.usage);
    const toolUse = response.content.find(b => b.type === 'tool_use');
    return toolUse?.input ?? null;
  } catch (err) {
    console.warn('[reader:claude] API error:', err.message);
    return null;
  }
}

// ── Channel-specific extractors ───────────────────────────────────────────────
async function extractFreePlaysPick(message) {
  const instruction = `Extract ALL picks from this message. Include capper_name if a handle is present, and sport_record if a win-loss record appears.`;
  const result = await claudeExtract(instruction, message);
  if (!result) return [];
  return Array.isArray(result.picks) ? result.picks : [];
}

async function extractCommunityPick(message) {
  const instruction = [
    'Extract ALL picks from this message. Include capper_name if a handle is present.',
    'IMPORTANT: Ignore any line labeled "Last Play:", "Last pick:", or similar — those are previous picks.',
    'Extract ONLY the current pick (labeled "Today\'s Play:", "POD:", "POD [date]:", or a standalone team/line).',
  ].join(' ');
  const result = await claudeExtract(instruction, message);
  if (!result) return [];
  return Array.isArray(result.picks) ? result.picks : [];
}

// ── Route to the right extractor by channel ───────────────────────────────────
async function extractPicks(content, channelName) {
  if (channelName === 'free-plays')                                      return extractFreePlaysPick(content);
  if (channelName === 'pod-thread' || channelName === 'community-leaks') return extractCommunityPick(content);
  console.warn(`[reader] Unknown channel: ${channelName}`);
  return [];
}

// ── Sanity check: fix pick_type vs spread_value mismatches ───────────────────
// Belt-and-suspenders in case the model returns conflicting type + value.
function correctPickType(parsed) {
  if ((parsed.pick_type || '').toUpperCase() === 'NRFI') return parsed;
  const val = parseFloat(parsed.spread_value);
  if (isNaN(val)) return parsed;
  const abs  = Math.abs(val);
  const type = (parsed.pick_type || '').toLowerCase();
  if (type === 'ml' && abs < 100) {
    console.log(`[reader] Corrected ML→spread for ${parsed.team} (value ${val})`);
    return { ...parsed, pick_type: 'spread' };
  }
  if (type === 'spread' && abs >= 100) {
    console.log(`[reader] Corrected spread→ML for ${parsed.team} (value ${val})`);
    return { ...parsed, pick_type: 'ML', spread_value: null };
  }
  return parsed;
}

// ── Main entry point ──────────────────────────────────────────────────────────
// Receives: { content, channel, author, id, createdAt }
// Returns: array of valid pick objects (empty array if none found)
// Discord pick messages are never legitimately longer than ~1500 chars.
// Truncating before Haiku prevents runaway costs from bot reposts or dumps.
const MAX_MSG_CHARS = 1500;

async function readMessage(msg) {
  const { content, channel, author, id, createdAt } = msg;
  if (!content || content.trim().length < 4) return [];

  const truncated = content.length > MAX_MSG_CHARS
    ? content.slice(0, MAX_MSG_CHARS) + '\n[truncated]'
    : content;

  const picks = await extractPicks(truncated, channel);
  const valid = [];

  for (let parsed of picks) {
    if (!parsed?.is_pick || !parsed.team) continue;
    parsed = correctPickType(parsed);
    valid.push({
      team:         parsed.team,
      sport:        parsed.sport        || null,
      pick_type:    parsed.pick_type    || null,
      spread_value: parsed.spread_value ?? null,
      espn_game_id: parsed.espn_game_id || null,
      picked_side:  parsed.picked_side  || null,
      vs_player:    parsed.vs_player    || null,
      channel,
      capper_name:  parsed.capper_name  || null,
      is_pick:      true,
      raw_message:  { id, content, author, createdAt },
    });
  }

  return valid;
}

module.exports = { readMessage };
