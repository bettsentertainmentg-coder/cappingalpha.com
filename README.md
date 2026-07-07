# CapperBoss

Sports betting picks ranked daily. The Seeking Alpha for sports gambling.

## Start
pm2 start ecosystem.config.js

## Dashboard
http://localhost:3001

## How it works
1. At 5am ET: ESPN games loaded, odds fetched, lines locked
2. Cappers tracked across systems all day: Discord scanner (instant, event-driven), Action Network experts, Polymarket pro wallets, Covers contest players
3. Each pick is extracted, deduped to one canonical capper, scored, and ranked
4. Top pick is free (account required). Full list requires $1/day, $4/week, or $75/year
5. At 4:58am ET: results finalized, daily reset for the next day
6. Gold MVP picks are saved permanently for transparency; capper records build forever

## Scoring
Two engines behind the scoring_version setting: v2 (channel points, prod today) and
v3 (the 100-point rework: capper resumes drive points, gold MVP at 100+, silver at
75-99, live locally). Spec: docs/CA_ALGORITHM_V3.md

## Env vars (in ~/Projects/AgentOSO/.env)
DISCORD_USER_TOKEN=
DISCORD_CHANNEL_mainplays=
DISCORD_CHANNEL_communityplays=
DISCORD_CHANNEL_POD=
STRIPE_SECRET_KEY=
ADMIN_PASSWORD=
