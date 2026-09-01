'use strict';

const express = require('express');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const tarfs = require('tar-fs');
const zlib = require('zlib');
const { resolveWorkspaceRoot } = require('../../system/aso/workspaceStore');
const { buildProvenanceGraph } = require('../../system/aso/provenance');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILENAME_PATTERN = /^[\w.-]+$/;

async function resolveRegularArtifact(expectedRoot, storageUri) {
  const [rootPath, entry] = await Promise.all([
    fsPromises.realpath(expectedRoot),
    fsPromises.lstat(storageUri)
  ]);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Artifact storage entry is not a regular file.');

  const filePath = await fsPromises.realpath(storageUri);
  if (path.dirname(filePath) !== rootPath) {
    throw new Error('Artifact storage path is outside its workspace.');
  }
  return filePath;
}

async function resolveWorkspaceDirectory(workspaceRoot, uuid) {
  const candidate = path.resolve(workspaceRoot, uuid);
  const [rootPath, entry] = await Promise.all([
    fsPromises.realpath(workspaceRoot),
    fsPromises.lstat(candidate)
  ]);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Workspace storage entry is not a directory.');

  const workspacePath = await fsPromises.realpath(candidate);
  if (path.dirname(workspacePath) !== rootPath) {
    throw new Error('Workspace storage path is outside the configured root.');
  }
  return workspacePath;
}

function createRouter({ workspaces }) {
  const router = express.Router();
  const workspaceRoot = resolveWorkspaceRoot();

  router.get('/:uuid/artifacts/:filename', async (req, res, next) => {
    const { uuid, filename } = req.params;
    if (!UUID_PATTERN.test(uuid)) {
      return res.status(400).json({ error: 'Invalid workspace ID' });
    }
    if (!FILENAME_PATTERN.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    try {
      const workspace = await workspaces.findOwned(uuid, req.auth.visitorId);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
      const artifact = await workspaces.findArtifact(workspace.id, filename);
      if (!artifact) return res.status(404).json({ error: 'Artifact not found' });

      const expectedRoot = path.resolve(workspaceRoot, uuid, 'artifacts');
      const filePath = await resolveRegularArtifact(expectedRoot, path.resolve(artifact.storage_uri));
      return res.sendFile(filePath, err => {
        if (err && !res.headersSent) res.status(404).json({ error: 'Artifact not found' });
      });
    } catch (error) {
      if (error instanceof TypeError) return res.status(400).json({ error: 'Invalid workspace ID' });
      if (error?.code === 'ENOENT') return res.status(404).json({ error: 'Artifact not found' });
      return next(error);
    }
  });

  // How the run got to its outputs: artifacts as nodes, derivation links as edges.
  router.get('/:uuid/provenance', async (req, res, next) => {
    const { uuid } = req.params;
    if (!UUID_PATTERN.test(uuid)) {
      return res.status(400).json({ error: 'Invalid workspace ID' });
    }
    try {
      const rows = await workspaces.provenance(uuid, req.auth.visitorId);
      if (!rows) return res.status(404).json({ error: 'Workspace not found' });
      return res.json(await buildProvenanceGraph(rows));
    } catch (error) {
      if (error instanceof TypeError) return res.status(400).json({ error: 'Invalid workspace ID' });
      return next(error);
    }
  });

  router.get('/:uuid/download', async (req, res, next) => {
    const { uuid } = req.params;
    if (!UUID_PATTERN.test(uuid)) {
      return res.status(400).json({ error: 'Invalid workspace ID' });
    }
    let workspace;
    try {
      workspace = await workspaces.findOwned(uuid, req.auth.visitorId);
    } catch (error) {
      if (error instanceof TypeError) return res.status(400).json({ error: 'Invalid workspace ID' });
      return next(error);
    }
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    let workspaceDir;
    try {
      workspaceDir = await resolveWorkspaceDirectory(workspaceRoot, uuid);
    } catch (error) {
      if (error?.code === 'ENOENT') return res.status(404).json({ error: 'Workspace not found' });
      return next(error);
    }
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="workspace-${uuid}.tar.gz"`);
    const pack = tarfs.pack(workspaceDir, {
      ignore: name => {
        const relativePath = path.relative(workspaceDir, name);
        if (relativePath === 'scratch' || relativePath.startsWith('scratch/')) return true;
        try {
          return fs.lstatSync(name).isSymbolicLink();
        } catch {
          return true;
        }
      }
    });
    const gzip = zlib.createGzip();
    pack.pipe(gzip).pipe(res);
    pack.on('error', err => {
      console.error(`[ERROR] Workspace download pack error for ${uuid}:`, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Archive failed' });
    });
    gzip.on('error', err => {
      console.error(`[ERROR] Workspace download gzip error for ${uuid}:`, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Compression failed' });
    });
  });

  return router;
}

module.exports = { createRouter };
