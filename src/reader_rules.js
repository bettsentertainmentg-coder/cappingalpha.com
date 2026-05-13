// src/reader_rules.js
// Shared between reader.js (Railway/Haiku) and local_reader_api.js (Mac/Ollama).
// Edit RULES here to update both paths simultaneously.

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
  NBA INFORMAL NICKNAMES — expand to the standard name ESPN uses (never return the slang shorthand):
    "Cavs" → "Cavaliers". "Dubs" → "Warriors". "Raps" → "Raptors".
    "Pels" → "Pelicans". "Wiz" → "Wizards". "Clips" → "Clippers".
    "Nugs" → "Nuggets". "Bockers"/"Bockers" → "Knicks". "Grizz" → "Grizzlies".

SPORT — one of: NBA, CBB, WCBB, NFL, NHL, MLB, NCAAF, ATP, WTA, Golf.
  Determine from team names and context.
  WCBB only if message explicitly says "women" or "WNCAA".
  ATP = men's professional tennis. WTA = women's professional tennis.

TENNIS (ATP/WTA) — "team" is the player's last name or full name as written.
  "Djokovic ML" → team=Djokovic, pick_type=ML, sport=ATP
  "Sinner ML 2u" → team=Sinner, pick_type=ML, sport=ATP
  "Alcaraz -4.5 games" → team=Alcaraz, pick_type=spread, spread_value=-4.5, sport=ATP
  "Swiatek ML" → team=Swiatek, pick_type=ML, sport=WTA
  "Alcaraz over 22.5 games" → team=Alcaraz, pick_type=over, spread_value=22.5, sport=ATP
  "under 21.5 total games Sinner" → team=Sinner, pick_type=under, spread_value=21.5, sport=ATP
  SET PICKS — when a capper picks a player to win a specific set:
    "Djokovic to win Set 1" → team=Djokovic, pick_type=set_ml, spread_value=1, sport=ATP
    "Sinner Set 2 ML -130" → team=Sinner, pick_type=set_ml, spread_value=2, sport=ATP
    "take Alcaraz 1st set" → team=Alcaraz, pick_type=set_ml, spread_value=1, sport=ATP
    "Swiatek wins set 3" → team=Swiatek, pick_type=set_ml, spread_value=3, sport=WTA
    Store the set number (1, 2, or 3) in spread_value for set_ml picks.
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
  A capper header looks like: emoji + name + optional label, OR a plain name alone on its own line.
  "🔮PorterPicks Full Card Thursday" → capper_name=PorterPicks for all picks that follow, until the next capper header.
  "🔮P4D_Picks4Dayzzz" alone on a line → capper_name=P4D_Picks4Dayzzz.
  Emoji prefixes (✅ 🔮 ⚾ 🏀 🏒 🎾 💎 🔥 ✔️ 🟢 etc.) before a name are capper markers — strip the emoji, the text before any space or bracket is the capper handle.
  "Full Card [Day]", "Today's Card", "Card for [Day]", "Full Card" after the name are section labels — ignore, not picks.
  When a new emoji-prefixed capper line appears, switch capper_name for all picks that follow.

  PLAIN NAME HEADERS (no emoji) — a line that is just a person/company name with no pick information is also a capper header.
  "Docs Sports" alone on a line → capper_name=Docs Sports for all picks that follow.
  "Hakeem Profit" alone on a line → capper_name=Hakeem Profit.
  "Stephen Nover" alone on a line → capper_name=Stephen Nover.
  If the next line is a sport label ("NBA", "NHL", "MLB") possibly followed by a unit size ("7U", "3*"), that line is context — not a pick. The actual pick is on the line after.

  SEPARATOR LINES — lines consisting only of "=" characters (e.g. "====", "======") are capper block dividers. They mark the end of one capper's section. Treat them like a blank line between blocks.

  Extract ALL picks from the message, each labeled with their correct capper_name.

  MIXED-CONTENT DIGESTS — some capper sections may contain only player props (individual stat lines).
  Skip those sections entirely, but DO NOT return is_pick=false for the whole message.
  Any message that has at least one valid team pick must return those picks.

  Example digest:
    "NickyCashin (17-4 MLB)" → capper header; (17-4 MLB) is a record, not a pick
    "Toronto Blue Jays ML (-125) 1.5U" → valid: team=Blue Jays, ML, capper=NickyCashin
    "Seattle Mariners ML (-140) 1.5U"  → valid: team=Mariners, ML, capper=NickyCashin
    "San Francisco Giants +1.5 (-117) 1.5U" → valid: team=Giants, spread=-1.5, capper=NickyCashin
    "Matthewp07" → capper header
    "Michael Soroka over 4.5 hits allowed" → SKIP — player prop (pitcher first+last + stat)
    "Peter Lambert under 15.5 outs"        → SKIP — player prop
    "Junior Caminero over 1.5 total bases" → SKIP — player prop
    "Donovan Mitchell over 8.5 rebs+asts"  → SKIP — player prop
    "MrBigBets" → capper header
    "Yankees/O's O 9 -110 1u"  → team=Yankees, pick_type=over, spread_value=9 ("O's"=Orioles nickname; "O 9"=over 9; -110 is juice)
    "Rangers ML -134 1u"       → valid: team=Rangers, ML, capper=MrBigBets
    "Guardians -1.5 +128 .5u"  → valid: team=Guardians, spread=-1.5 (+128 is juice, ignore), capper=MrBigBets
    → Return 6 picks total (NickyCashin×3, MrBigBets×3). Matthewp07 section skipped.

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

// ── Tool schema ───────────────────────────────────────────────────────────────
// Used by both Anthropic (reader.js) and Ollama (local_reader_api.js).
// Anthropic uses input_schema; Ollama uses parameters (same shape, different key).
const EXTRACT_TOOL = {
  name: 'extract_picks',
  description: 'Extract all sports betting picks from one or more numbered Discord messages',
  input_schema: {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        description: 'All picks found across all messages. Use [] when none.',
        items: {
          type: 'object',
          properties: {
            message_index: { type: 'integer', description: 'Which message this pick is from (1-based). Use 1 for single messages.' },
            is_pick:      { type: 'boolean' },
            team:         { type: 'string',  description: 'Team or player name as written' },
            pick_type:    { type: 'string',  enum: ['ML', 'spread', 'over', 'under', 'NRFI', 'h2h', 'top5', 'top10', 'set_ml'] },
            spread_value: { type: 'number',  description: 'Spread or total line. Omit for ML.' },
            sport:        { type: 'string',  enum: ['NBA', 'CBB', 'WCBB', 'NFL', 'NHL', 'MLB', 'NCAAF', 'ATP', 'WTA', 'Golf'] },
            capper_name:  { type: 'string',  description: 'Capper handle. Omit if unclear.' },
            vs_player:    { type: 'string',  description: 'Golf h2h opponent only.' },
            sport_record: { type: 'string',  description: 'Record string e.g. "27-21 CBB". Omit if absent.' },
            espn_game_id: { type: 'string',  description: "Game id from today's list if matched. Omit if uncertain." },
            picked_side:  { type: 'string',  enum: ['home', 'away'], description: 'Include with espn_game_id.' },
          },
          required: ['is_pick'],
        },
      },
    },
    required: ['picks'],
  },
};

module.exports = { RULES, EXTRACT_TOOL };
