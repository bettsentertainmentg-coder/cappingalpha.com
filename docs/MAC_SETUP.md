# Mac Services: Setup and Transfer Runbook

Everything CappingAlpha runs on the Mac Mini, and how to bring it all up on a new Mac, computer, or server with one command. The site itself lives on Railway; the Mac side exists because sportsbooks and ActionNetwork block datacenter IPs, so fetching happens here on a residential IP and gets relayed to the site with an HMAC-signed POST.

## What runs on the Mac

| Service | Code | What it does | Cadence |
|---|---|---|---|
| odds-engine | scripts/odds_engine.js | CA Odds Engine: public Bovada (all sports) + DraftKings odds, normalized, relayed to book_lines on the site | Every 5 min |
| pb-relay | scripts/pb_relay.js | ActionNetwork public betting % + Bovada tennis lines relay | Hourly |
| ops-app | ops/server.js | Desktop ops console backend; the "CA Ops" app on the Desktop opens its UI (127.0.0.1:4300) | Always on |
| capperboss | index.js | Local dev instance of the site (UI_ONLY, prod mirror) | Always on |
| cappingalpha-studio | ~/projects/cappingalpha-studio | Marketing Studio (shorts from real picks), port 4100 | Always on |
| MVP backup | scripts/backup-mvp.sh | Pulls the server's MVP history to the Mac as a backup | Manual (run after big days or redeploys) |

Not part of CappingAlpha (leave alone during transfers): agent-oso, dealboss, moneymoves, tradedesk.

Every relay service reports a heartbeat to the site each cycle. Check `/admin/health` on the site: if a Mac service stops checking in, it shows STALE, then DOWN.

## Fresh machine setup

1. Install Node 20+ and pm2: `npm install -g pm2`
2. Clone the repo to `~/projects/capperboss` (keep this path if possible; the studio block in ecosystem.config.js assumes `~/projects/`)
3. Copy `.env` from the old machine into the repo root (see the checklist below). This file is gitignored and never travels with the repo
4. Optional: clone `cappingalpha-studio` to `~/projects/cappingalpha-studio` (or comment its block out of ecosystem.config.js)
5. Run: `bash scripts/mac-setup.sh`
6. Make pm2 survive reboots: run the `pm2 startup` command it prints, then `pm2 save`
7. Open `/admin/health` on the site and confirm odds-engine and pb-relay check in within a few minutes

## Env var checklist (.env in the repo root)

| Variable | Needed by | Notes |
|---|---|---|
| RELAY_SECRET | odds-engine, pb-relay | Must match Railway's RELAY_SECRET |
| RAILWAY_URL | odds-engine, pb-relay | https://cappingalpha.com |
| ODDS_ENGINE_INTERVAL_MIN | odds-engine | Optional, default 5 |
| ODDS_ENGINE_BOOKS | odds-engine | Optional, default bovada,draftkings |
| UI_ONLY=1 | capperboss (local dev) | Keeps the local instance off paid APIs |
| MIRROR_PROD | capperboss (local dev) | Optional; proxies read-only GETs to prod for real data |
| ADMIN_PASSWORD | backup-mvp.sh, ops-app | Must match Railway's |
| OPS_SITE_URL | ops-app | Which site the console reads: http://localhost:3001 now, https://cappingalpha.com after ship |

To recreate the Desktop icon on a new Mac:

    osacompile -o ~/Desktop/"CA Ops.app" -e 'do shell script "open -na \"Google Chrome\" --args --app=http://127.0.0.1:4300"'

Gotcha from the old machine: on the current Mac Mini, ALL of these vars actually live in `~/Projects/AgentOSO/.env` and the repo's own `.env` is empty. pb_relay.js and odds_engine.js read the AgentOSO file first, then the local `.env` for anything missing. On a new machine you do not need AgentOSO at all: put every var straight into `capperboss/.env` and the same code finds them there. When migrating, copy the values out of `~/Projects/AgentOSO/.env`.

## Until the bet-tracking branch ships

Production does not have the /admin/ingest-book-lines and /admin/ingest-heartbeat routes until the big ship, so odds-engine and ops-app currently run pointed at the LOCAL instance (RAILWAY_URL / OPS_SITE_URL = http://localhost:3001 in their pm2 env). On ship day, repoint BOTH at production:

    1. Add to .env: OPS_SITE_URL=https://cappingalpha.com
    2. pm2 delete odds-engine ops-app
    3. pm2 start ecosystem.config.js --only odds-engine --only ops-app
    4. pm2 save

odds-engine picks RAILWAY_URL back up from .env (cappingalpha.com); ops-app reads the new OPS_SITE_URL. Both start feeding from and reporting on the live site.

## Day-to-day

- `pm2 list` shows everything; `pm2 logs odds-engine` (or pb-relay) tails a service
- After editing a Mac service: `pm2 restart odds-engine` (or the service name)
- `/admin/health` on the site is the single pane of glass: Mac heartbeats on top, every data source's freshness below, with a "what to check" hint per row
