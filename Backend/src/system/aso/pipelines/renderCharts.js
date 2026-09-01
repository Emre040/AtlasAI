'use strict';

// Renders chart artifacts for ASO reports.

const path = require('path');
const { spawn } = require('child_process');

function runPython(specPath, outDir) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'render_charts.py');
    const child = spawn('python3', [scriptPath, specPath, outDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => stdout += d.toString());
    child.stderr.on('data', (d) => stderr += d.toString());
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(stderr || `render_charts exited ${code}`));
      try {
        const payload = JSON.parse(stdout.trim() || '{}');
        resolve(payload);
      } catch (e) {
        reject(new Error(`render_charts parse error: ${e.message}`));
      }
    });
  });
}

async function renderCharts(specPath, outDir) {
  return runPython(specPath, outDir);
}

module.exports = { renderCharts };
