module.exports = {
  apps: [{
    name: 'claudeclaw',
    script: './bridge.js',
    cwd: '/Users/papa/0Proyectos/ClaudeClaw/Opus46',
    instances: 1,           // un solo proceso, siempre
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    restart_delay: 3000,    // espera 3s antes de reiniciar
    exp_backoff_restart_delay: 100,
    env: {
      NODE_ENV: 'production',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/Users/papa/.pm2/logs/claudeclaw-error.log',
    out_file:   '/Users/papa/.pm2/logs/claudeclaw-out.log',
    merge_logs: true,
  }]
};
