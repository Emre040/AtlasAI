'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { createUuidV7 } = require('../../shared/ids');

const WORKSPACES = '`atlasai`.`aso_workspaces`';
let workspaceRoot = null;

function configureWorkspaceRoot(root) {
  if (!path.isAbsolute(root)) throw new TypeError('Workspace root must be an absolute path.');
  workspaceRoot = root;
}

function resolveWorkspaceRoot() {
  if (!workspaceRoot) throw new Error('ASO workspace storage is not configured.');
  return workspaceRoot;
}

async function ensureWorkspaceDirs(workspaceDir) {
  const artifactsDir = path.join(workspaceDir, 'artifacts');
  await fs.mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  return { artifactsDir };
}

async function createWorkspace(db, {
  visitorId,
  inferenceModelId,
  requestText,
  planJson
}) {
  if (!visitorId || !inferenceModelId) {
    throw new Error('ASO workspace requires visitor and inference model ownership.');
  }

  const publicId = createUuidV7();
  const root = resolveWorkspaceRoot();
  const workspaceDir = path.join(root, publicId.text);
  const logPath = path.join(workspaceDir, 'events.ndjson');
  const now = Date.now();

  const [result] = await db.execute(
    `INSERT INTO ${WORKSPACES} (
       public_id, visitor_id, inference_model_id, workflow_key, status,
       request_text, plan_json, storage_prefix, log_uri,
       created_unix_ms, updated_unix_ms, revision
     ) VALUES (?, ?, ?, 'aso_hpa', 'queued', ?, ?, ?, ?, ?, ?, 1)`,
    [
      publicId.bytes,
      visitorId,
      inferenceModelId,
      requestText,
      planJson ? JSON.stringify(planJson) : null,
      workspaceDir,
      logPath,
      now,
      now
    ]
  );

  try {
    const { artifactsDir } = await ensureWorkspaceDirs(workspaceDir);
    await fs.writeFile(logPath, '', { mode: 0o600, flag: 'wx' });
    await db.execute(
      `UPDATE ${WORKSPACES}
          SET status = 'running', started_unix_ms = ?, updated_unix_ms = ?, revision = revision + 1
        WHERE id = ? AND status = 'queued'`,
      [now, now, result.insertId]
    );
    return {
      id: result.insertId,
      uuid: publicId.text,
      workspaceDir,
      artifactsDir,
      logPath
    };
  } catch (error) {
    const failedAt = Date.now();
    await db.execute(
      `UPDATE ${WORKSPACES}
          SET status = 'failed', error_code = 'workspace_initialization_failed',
              error_message = ?, updated_unix_ms = ?, finished_unix_ms = ?, revision = revision + 1
        WHERE id = ?`,
      [String(error.message || error).slice(0, 65535), failedAt, failedAt, result.insertId]
    );
    throw error;
  }
}

async function updateWorkspace(db, workspaceId, fields = {}) {
  const updates = [];
  const params = [];

  if (fields.status !== undefined) {
    updates.push('status = ?');
    params.push(fields.status);
  }
  if (fields.message !== undefined) {
    updates.push('status_message = ?');
    params.push(fields.message);
  }
  if (fields.planJson !== undefined) {
    updates.push('plan_json = ?');
    params.push(fields.planJson ? JSON.stringify(fields.planJson) : null);
  }
  if (fields.finishedUnixMs !== undefined) {
    updates.push('finished_unix_ms = ?');
    params.push(fields.finishedUnixMs);
  }
  if (fields.errorCode !== undefined) {
    updates.push('error_code = ?');
    params.push(fields.errorCode);
  }
  if (fields.errorMessage !== undefined) {
    updates.push('error_message = ?');
    params.push(fields.errorMessage);
  }
  if (updates.length === 0) return;

  updates.push('updated_unix_ms = ?');
  params.push(Date.now());
  updates.push('revision = revision + 1');
  params.push(workspaceId);
  await db.execute(
    `UPDATE ${WORKSPACES} SET ${updates.join(', ')} WHERE id = ?`,
    params
  );
}

module.exports = {
  configureWorkspaceRoot,
  resolveWorkspaceRoot,
  createWorkspace,
  updateWorkspace
};
