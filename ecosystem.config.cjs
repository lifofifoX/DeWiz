// PM2 Ecosystem Configuration
// https://pm2.keymetrics.io/docs/usage/application-declaration/

module.exports = {
  apps: [{
    name: 'degen-wizard',
    script: 'src/index.js',
    cwd: '/home/degenwizard/discord-trading-bot',

    // Environment
    node_args: '--no-warnings',
    env: {
      NODE_ENV: 'production'
    },

    // Instances and execution mode
    instances: 1,
    exec_mode: 'fork',

    // Restart behavior
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,

    // Memory management - restart if exceeds 500MB
    max_memory_restart: '500M',

    // Logging
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '/home/degenwizard/discord-trading-bot/logs/error.log',
    out_file: '/home/degenwizard/discord-trading-bot/logs/out.log',
    merge_logs: true,
    log_type: 'raw',

    // Graceful shutdown
    kill_timeout: 10000,
    wait_ready: false,
    listen_timeout: 10000
  }]
}
