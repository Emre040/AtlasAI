'use strict';

const path = require('path');
const fs = require('fs/promises');
const { v4: uuidv4 } = require('uuid');

const WORKSPACE_TABLE = 'hpa_agent_workspaces';

function resolveWorkspaceRoot() {
  const envRoot = process.env.HPA_ASO_WORKSPACES_DIR;
  if (envRoot && envRoot.trim()) return envRoot.trim();
  // Default to backend/workspaces
  return path.join(__dirname, '..', '..', 'workspaces');
}

async function ensureWorkspaceDirs(workspaceDir) {
  const artifactsDir = path.join(workspaceDir, 'artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });
  return { artifactsDir };
}

async function createWorkspace(db, { cookieValue, requestText, planJson }) {
  const uuid = uuidv4();
  const root = resolveWorkspaceRoot();
  const workspaceDir = path.join(root, uuid);
  const { artifactsDir } = await ensureWorkspaceDirs(workspaceDir);
  const logPath = path.join(workspaceDir, 'log.ndjson');

  // Initialize log file
  await fs.writeFile(logPath, '');

  await db.query(
    `INSERT INTO ${WORKSPACE_TABLE}
      (uuid, cookie_value, status, request_text, plan_json, workspace_dir, log_path, started_at)
     VALUES (?, ?, 'running', ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [
      uuid,
      cookieValue || null,
      requestText || null,
      planJson ? JSON.stringify(planJson) : null,
      workspaceDir,
      logPath
    ]
  );

  return { uuid, workspaceDir, artifactsDir, logPath };
}

async function updateWorkspace(db, uuid, fields = {}) {
  const updates = [];
  const params = [];

  if (fields.status) { updates.push('status = ?'); params.push(fields.status); }
  if (fields.message !== undefined) { updates.push('message = ?'); params.push(fields.message); }
  if (fields.planJson !== undefined) { updates.push('plan_json = ?'); params.push(fields.planJson ? JSON.stringify(fields.planJson) : null); }
  if (fields.finishedAt) { updates.push('finished_at = ?'); params.push(fields.finishedAt); }
  updates.push('updated_at = UTC_TIMESTAMP()');

  if (!updates.length) return;

  params.push(uuid);
  await db.query(
    `UPDATE ${WORKSPACE_TABLE} SET ${updates.join(', ')} WHERE uuid = ?`,
    params
  );
}

module.exports = {
  resolveWorkspaceRoot,
  createWorkspace,
  updateWorkspace
};
