module.exports = {
  apps: [{
    name: 'capperboss',
    script: 'index.js',
    cwd: '/Users/jack/Projects/capperboss',
    watch: false,
    restart_delay: 5000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
