// PM2 ecosystem — every CappingAlpha process that runs on the Mac, in one file.
// One command brings the whole Mac side up on any machine:
//   pm2 start ecosystem.config.js && pm2 save
// Transfer runbook: docs/MAC_SETUP.md
module.exports = {
  apps: [
    {
      // Local dev instance of the site (UI_ONLY in .env keeps it off paid APIs).
      name: 'capperboss',
      script: 'index.js',
      cwd: __dirname,
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      // Residential-IP relay: ActionNetwork public betting % + Bovada tennis lines.
      name: 'pb-relay',
      script: 'scripts/pb_relay.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 20,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      // CA Odds Engine: public sportsbook odds (Bovada all sports, DraftKings),
      // normalized and relayed to the site every few minutes.
      name: 'odds-engine',
      script: 'scripts/odds_engine.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 20,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      // Marketing Studio (separate repo). Comment this block out on machines
      // that don't have ~/projects/cappingalpha-studio checked out.
      name: 'cappingalpha-studio',
      script: 'server.js',
      cwd: require('path').join(process.env.HOME || '/Users/jack', 'projects/cappingalpha-studio'),
      watch: false,
      autorestart: true,
      restart_delay: 10000,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
