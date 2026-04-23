module.exports = {
  apps: [{
    name: 'love-diary',
    script: 'server.js',
    cwd: '/www/wwwroot/106.52.180.78_520',

    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '200M',

    min_uptime: 5000,
    max_restarts: 10,
    restart_delay: 3000,

    listen_timeout: 10000,
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,

    env: {
      NODE_ENV: 'production',
      PORT: 520
    },

    error_file: '/www/wwwroot/106.52.180.78_520/logs/error.log',
    out_file: '/www/wwwroot/106.52.180.78_520/logs/out.log',
    pid_file: '/www/wwwroot/106.52.180.78_520/logs/pid.log',

    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
};
