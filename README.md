# CapperBoss

Sports betting picks ranked daily. The Seeking Alpha for sports gambling.

## Start
pm2 start ecosystem.config.js

## Dashboard
http://localhost:3001

## How it works
1. At 6am ET: ESPN games loaded, lines locked
2. Discord scanner reads picks from 3 channels all day
3. Each pick is extracted, scored, and ranked
4. Top pick is free. Full list requires $1/day or $75/year
5. At 5:58am ET: everything resets for the next day
6. MVP picks (35+ points) saved permanently for transparency

## Env vars (in ~/Projects/AgentOSO/.env)
DISCORD_USER_TOKEN=
DISCORD_CHANNEL_mainplays=
DISCORD_CHANNEL_communityplays=
DISCORD_CHANNEL_POD=
STRIPE_SECRET_KEY=
ADMIN_PASSWORD=