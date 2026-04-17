'use strict';

const path = require('path');
const fs = require('fs/promises');
const { v4: uuidv4 } = require('uuid');

const ARTIFACT_TABLE = 'hpa_agent_artifacts';

async function registerArtifact(db, {
  workspaceUuid,
  artifactsDir,
  kind,
  format = 'json',
  schemaJson,
  metadataJson,
  payload,
  storageUriOverride = null,
  skipWrite = false
}) {
  const artifactUuid = uuidv4();
  const filename = `${artifactUuid}.${format}`;
  const artifactPath = storageUriOverride || path.join(artifactsDir, filename);

  if (!skipWrite) {
    if (format === 'json') {
      const jsonOut = payload ? JSON.stringify(payload, null, 2) : '{}';
      await fs.writeFile(artifactPath, jsonOut);
    } else if (payload) {
      await fs.writeFile(artifactPath, payload);
    } else {
      await fs.writeFile(artifactPath, '');
    }
  }

  const storageUri = artifactPath;

  await db.query(
    `INSERT INTO ${ARTIFACT_TABLE}
      (workspace_uuid, artifact_uuid, kind, format, schema_json, storage_uri, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
    , [
      workspaceUuid,
      artifactUuid,
      kind || 'unknown',
      format,
      schemaJson ? JSON.stringify(schemaJson) : null,
      storageUri,
      metadataJson ? JSON.stringify(metadataJson) : null
    ]
  );

  return { artifactUuid, storageUri, artifactPath };
}

module.exports = { registerArtifact };
