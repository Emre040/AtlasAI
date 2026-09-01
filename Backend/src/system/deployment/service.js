'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const ACTIVE_STATES = new Set(['queued', 'running', 'succeeded']);

function secretMatches(expected, supplied) {
  if (typeof supplied !== 'string') return false;
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  const suppliedDigest = crypto.createHash('sha256').update(supplied).digest();
  return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

function validatePayload(payload, repository) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('Deployment payload must be a JSON object.'), {
      status: 400,
      code: 'invalid_deployment_payload'
    });
  }
  if (payload.repository !== repository || payload.ref !== 'refs/heads/main') {
    throw Object.assign(new Error('Deployment repository or ref is not allowed.'), {
      status: 403,
      code: 'deployment_target_not_allowed'
    });
  }
  if (typeof payload.sha !== 'string' || !SHA_PATTERN.test(payload.sha)) {
    throw Object.assign(new Error('Deployment SHA must be a full lowercase Git SHA.'), {
      status: 400,
      code: 'invalid_deployment_sha'
    });
  }
  return payload.sha;
}

class DeploymentService {
  constructor({ secret, repository, repositoryRoot, scriptPath, spawnProcess = spawn }) {
    if (!/^[a-f0-9]{64}$/.test(secret)) {
      throw new Error('Deployment secret must be a 256-bit lowercase hexadecimal value.');
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error('Deployment repository must use the owner/repository format.');
    }
    if (!path.isAbsolute(repositoryRoot) || !path.isAbsolute(scriptPath)) {
      throw new Error('Deployment repository and script paths must be absolute.');
    }
    try {
      if (!fs.statSync(scriptPath).isFile()) throw new Error('not a file');
      fs.accessSync(scriptPath, fs.constants.R_OK);
    } catch {
      throw new Error('Deployment script must be a readable file.');
    }
    this.secret = secret;
    this.repository = repository;
    this.repositoryRoot = repositoryRoot;
    this.scriptPath = scriptPath;
    this.spawnProcess = spawnProcess;
    this.statusRoot = path.join(repositoryRoot, '.deploy', 'status');
  }

  isAuthorized(suppliedSecret) {
    return secretMatches(this.secret, suppliedSecret);
  }

  statusPath(sha) {
    if (!SHA_PATTERN.test(sha)) return null;
    return path.join(this.statusRoot, `${sha}.json`);
  }

  readStatus(sha) {
    const filePath = this.statusPath(sha);
    if (!filePath) return null;
    try {
      const status = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (status.sha !== sha || typeof status.state !== 'string') return null;
      return status;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  writeStatus(sha, state) {
    fs.mkdirSync(this.statusRoot, { recursive: true, mode: 0o700 });
    const status = {
      sha,
      state,
      updated_unix_ms: Date.now()
    };
    const filePath = this.statusPath(sha);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    return status;
  }

  queue(payload) {
    const sha = validatePayload(payload, this.repository);
    const existing = this.readStatus(sha);
    if (existing && ACTIVE_STATES.has(existing.state)) {
      return { status: existing, queued: false };
    }

    const status = this.writeStatus(sha, 'queued');
    const childEnvironment = Object.fromEntries(Object.entries({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      LANG: process.env.LANG,
      PM2_HOME: process.env.PM2_HOME,
      ATLAS_DEPLOY_REPOSITORY_ROOT: this.repositoryRoot,
      ATLAS_DEPLOY_STATUS_ROOT: this.statusRoot
    }).filter(([, value]) => typeof value === 'string' && value !== ''));
    let child;
    try {
      // Double fork: the launcher shell backgrounds the release script under setsid and exits at
      // once, so the script is reparented to init before it reaches `pm2 delete atlas-api`.
      // A plain detached child keeps this process as its parent and PM2's tree-kill would take
      // the release script down together with the API it is replacing (2026-09-01 outage).
      child = this.spawnProcess('/usr/bin/env', [
        'bash',
        '-c',
        'setsid nohup bash "$0" "$1" </dev/null >/dev/null 2>&1 &',
        this.scriptPath,
        sha
      ], {
        cwd: this.repositoryRoot,
        detached: true,
        stdio: 'ignore',
        env: childEnvironment
      });
    } catch (error) {
      this.writeStatus(sha, 'failed');
      throw error;
    }

    child.once('error', () => {
      try {
        this.writeStatus(sha, 'failed');
      } catch (error) {
        console.error('[DEPLOY_ERROR] Failed to persist spawn failure:', error.message);
      }
    });
    child.unref();
    return { status, queued: true };
  }
}

module.exports = {
  DeploymentService,
  secretMatches,
  validatePayload
};
