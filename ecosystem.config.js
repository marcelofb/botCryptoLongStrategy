module.exports = {
  apps: [
    {
      name: 'crypto-bull-bot',
      script: 'src/index.js',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        TZ: 'America/Argentina/Buenos_Aires',
      },
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      time: true,
    },
  ],
};
