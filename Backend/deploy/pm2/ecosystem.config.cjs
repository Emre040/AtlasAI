'use strict';

const path = require('path');
const backendRoot = path.resolve(__dirname, '..', '..');

module.exports = {
  apps: [
    {
      name: 'atlas-api',
      cwd: backendRoot,
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      time: true,
      min_uptime: '15s',
      max_restarts: 10,
      restart_delay: 1000,
      kill_timeout: 30000,
      max_memory_restart: '4G',
      filter_env: [
        'CLAUDE',
        'CODEX',
        'COPILOT',
        'GEMINI_CLI',
        'GIT_ASKPASS',
        'SSH_',
        'VSCODE'
      ]
    }
  ]
};
