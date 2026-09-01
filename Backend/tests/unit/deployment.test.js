'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DeploymentService,
  secretMatches,
  validatePayload
} = require('../../src/system/deployment/service');

const secret = 'a'.repeat(64);
const repository = 'Emre040/AtlasAI';
const sha = 'b'.repeat(40);

test('deployment secret comparison rejects absent and incorrect values', () => {
  assert.equal(secretMatches(secret, secret), true);
  assert.equal(secretMatches(secret, 'c'.repeat(64)), false);
  assert.equal(secretMatches(secret, undefined), false);
});

test('deployment payload permits only the configured repository and main ref', () => {
  assert.equal(validatePayload({ repository, ref: 'refs/heads/main', sha }, repository), sha);
  assert.throws(
    () => validatePayload({ repository: 'other/repository', ref: 'refs/heads/main', sha }, repository),
    error => error.code === 'deployment_target_not_allowed'
  );
  assert.throws(
    () => validatePayload({ repository, ref: 'refs/heads/feature', sha }, repository),
    error => error.code === 'deployment_target_not_allowed'
  );
  assert.throws(
    () => validatePayload({ repository, ref: 'refs/heads/main', sha: 'short' }, repository),
    error => error.code === 'invalid_deployment_sha'
  );
});

test('queue persists one exact SHA and does not launch it twice', t => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-deploy-test-'));
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  const scriptPath = path.join(repositoryRoot, 'deploy.sh');
  fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\n');
  const calls = [];
  const spawnProcess = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.unref = () => {};
    return child;
  };
  const service = new DeploymentService({
    secret,
    repository,
    repositoryRoot,
    scriptPath,
    spawnProcess
  });

  const first = service.queue({ repository, ref: 'refs/heads/main', sha });
  const second = service.queue({ repository, ref: 'refs/heads/main', sha });
  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(service.readStatus(sha), first.status);
  assert.equal(calls[0][2].env.ATLAS_DEPLOY_REPOSITORY_ROOT, repositoryRoot);
  assert.equal('HPA_DB_PASS' in calls[0][2].env, false);
  // The launcher must double-fork under setsid so PM2 cannot kill the release script.
  assert.equal(calls[0][0], '/usr/bin/env');
  assert.deepEqual(calls[0][1].slice(0, 2), ['bash', '-c']);
  assert.match(calls[0][1][2], /^setsid nohup bash "\$0" "\$1" .*&$/);
  assert.deepEqual(calls[0][1].slice(3), [scriptPath, sha]);
  assert.equal(calls[0][2].detached, true);
});
