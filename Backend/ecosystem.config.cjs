'use strict';

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'atlas-api',
      cwd: __dirname,
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
      ],
      env: {
        NODE_ENV: 'production',
        HPA_APP_NAME: 'AtlasAI',
        HPA_PORT: '9000',
        HPA_HOST: '127.0.0.1',
        HPA_ASO_WORKSPACES_DIR: path.join(__dirname, 'workspaces'),
        HPM_SUMMARIES_PATH: path.join(__dirname, 'runtime-data', 'hpm_summaries.json'),
        HPA_SSE_DEBUG: 'false',
        HPA_LOG_LLM_IO: 'false',
        HPA_ASO_LOG_TOOL_STEPS: 'false'
      }
    }
  ]
};
