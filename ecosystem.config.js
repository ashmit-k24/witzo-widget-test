module.exports = {
  apps: [
    {
      name: 'witzo-ai-backend',
      script: './dist/server.js',
      instances: 'max', // Use all available CPU cores
      exec_mode: 'cluster', // Enable cluster mode for horizontal scaling
      watch: false, // Disable in production (enable in dev if needed)
      max_memory_restart: '1G', // Restart if memory exceeds 1GB
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
      // Advanced PM2 options for better performance
      instance_var: 'INSTANCE_ID',
      merge_logs: true, // Merge logs from all instances
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',

      // Auto-restart settings
      autorestart: true,
      max_restarts: 10, // Max restarts within min_uptime
      min_uptime: '10s', // Minimum uptime before considering restart
      restart_delay: 4000, // Delay between restarts (ms)

      // Graceful shutdown
      kill_timeout: 10000, // Wait 10s for graceful shutdown
      listen_timeout: 10000, // Wait 10s for app to be ready

      // Health monitoring
      exp_backoff_restart_delay: 100,
    },
    {
      name: 'witzo-scraper-worker',
      script: './dist/workers/scraperWorker.js',
      instances: 2, // Run 2 dedicated scraper worker instances
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '2G', // Higher memory limit for scraping tasks
      env: {
        NODE_ENV: 'production',
        WORKER_TYPE: 'scraper',
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
      kill_timeout: 30000, // 30s for scraping jobs to complete
      merge_logs: true,
      error_file: './logs/scraper-error.log',
      out_file: './logs/scraper-out.log',
    },
  ],

  // PM2 deploy configuration (optional)
  deploy: {
    production: {
      user: 'node',
      host: 'your-production-server.com',
      ref: 'origin/main',
      repo: 'git@github.com:yourusername/witzo-ai-automation-chatbot.git',
      path: '/var/www/witzo-ai',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
    },
  },
};
