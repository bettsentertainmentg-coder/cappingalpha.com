# CappperBoss

Sports betting intelligence — Discord scanner + live ESPN data + value scoring.

## Setup

Env variables are read from `~/Projects/AgentOSO/.env`. Add these:

```
DISCORD_USER_TOKEN=your_discord_user_token
DISCORD_CHANNEL_mainplays=channel_id_here
DISCORD_CHANNEL_communityplays=channel_id_here
```

## Start

```bash
node index.js
```

Dashboard runs at **http://localhost:3001**

## How it works

1. Connects to Discord via self-bot token on startup
2. Scans `mainplays` and `communityplays` channels every 30 minutes
3. Sends each message to Ollama (llama3) to extract structured picks
4. Scores picks using win rate, mention count, channel weight, and line movement
5. Polls ESPN live scores for monitored games every 60 seconds
6. Fires Telegram alerts via OSO on swings, line moves, or hot picks

## OSO Trigger Phrases

```
"what are the picks"     → handlePicksQuery()   — scans fresh + returns top 5 scored picks
"lets get betting [...]" → handleLetsGetBetting() — starts ESPN live polling + alert monitoring
```

Called by OSO internally. Can also run standalone:

```bash
node -e "require('./src/oso_commands').handlePicksQuery().then(console.log)"
node -e "require('./src/oso_commands').handleLetsGetBetting('nfl cowboys eagles').then(console.log)"
```

## Adjusting Scoring Weights

Edit the `WEIGHTS` constants at the top of `src/value_engine.js`:

```js
const WEIGHTS = {
  WIN_RATE_MAX:      40,   // capper win_rate contribution (max 40 pts)
  MENTION_PER_COUNT: 5,    // points per mention
  MENTION_MAX:       30,   // cap on mention score
  LINE_MOVE_FAVOR:   30,   // spread moved favorably
  LINE_MOVE_NEUTRAL: 15,   // unclear line movement
  LINE_MOVE_AGAINST: -10,  // spread moved against pick
  CHANNEL_MAIN:      1.5,  // mainplays multiplier
  CHANNEL_COMMUNITY: 1.0,  // communityplays multiplier
  HOT_SCORE_THRESH:  70,   // minimum score for HOT_PICK alert
  HOT_HOURS_WINDOW:  2,    // hours before game for HOT_PICK
};
```

## Adjusting Channel Priorities

Channel weights are defined in `src/discord_scanner.js`:

```js
const CHANNELS = [
  { id: MAIN_CHANNEL_ID,      name: 'mainplays',      weight: 1.5 },
  { id: COMMUNITY_CHANNEL_ID, name: 'communityplays', weight: 1.0 },
];
```

Increase a channel's `weight` to give its picks more scoring power.

## Database

SQLite at `data/capper.db`. Tables:
- `picks` — all extracted picks with scores
- `cappers` — win/loss records per capper
- `alerts` — fired alert history
- `live_games` — monitored ESPN games with live scores
