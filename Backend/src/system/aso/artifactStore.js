'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { createUuidV7, uuidStringToBuffer } = require('../../shared/ids');

const ARTIFACTS = '`atlasai`.`aso_artifacts`';
const ARTIFACT_LINKS = '`atlasai`.`aso_artifact_links`';

const KIND_CATEGORY = Object.freeze({
  tool_result: 'tool_result',
  dataset: 'dataset',
  gene_list: 'dataset',
  measurement: 'measurement',
  analysis: 'analysis',
  analysis_rank: 'analysis',
  analysis_delta: 'analysis',
  analysis_aggregate: 'analysis',
  analysis_merge: 'analysis',
  analysis_scatter: 'analysis',
  analysis_concat: 'analysis',
  analysis_matrix: 'analysis',
  figure: 'figure',
  summary: 'summary',
  inspection: 'inspection',
  cleaned: 'cleaned'
});

const CONTENT_TYPES = Object.freeze({
  json: 'application/json',
  png: 'image/png',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8',
  parquet: 'application/vnd.apache.parquet',
  txt: 'text/plain; charset=utf-8',
  binary: 'application/octet-stream'
});

function sourceIdsFromProvenance(provenance = {}) {
  const candidates = [];
  if (Array.isArray(provenance.sources)) candidates.push(...provenance.sources);
  if (provenance.source_dataset) candidates.push(provenance.source_dataset);
  if (typeof provenance.source === 'string') candidates.push(provenance.source);

  const unique = new Set();
  for (const candidate of candidates) {
    try {
      uuidStringToBuffer(candidate);
      unique.add(candidate);
    } catch {
      // Non-artifact labels are represented by producer_key, never as a fake FK.
    }
  }
  return [...unique];
}

function producerKey(provenance = {}) {
  if (typeof provenance.tool === 'string' && provenance.tool) return provenance.tool;
  if (typeof provenance.source === 'string') {
    try {
      uuidStringToBuffer(provenance.source);
    } catch {
      return provenance.source;
    }
  }
  return 'aso_hpa';
}

async function registerArtifact(db, {
  workspaceId,
  artifactsDir,
  kind,
  format = 'json',
  schemaJson,
  provenance,
  payload,
  storageUriOverride = null,
  skipWrite = false
}) {
  const category = KIND_CATEGORY[kind];
  if (!category) throw new Error(`Unsupported artifact kind '${kind}'.`);
  if (!CONTENT_TYPES[format]) throw new Error(`Unsupported artifact format '${format}'.`);

  const publicId = createUuidV7();
  const filename = `${publicId.text}.${format}`;
  const artifactPath = storageUriOverride || path.join(artifactsDir, filename);

  if (!skipWrite) {
    if (format === 'json') {
      await fs.writeFile(artifactPath, JSON.stringify(payload ?? {}, null, 2), { mode: 0o600 });
    } else {
      await fs.writeFile(artifactPath, payload ?? '', { mode: 0o600 });
    }
  }

  const contents = await fs.readFile(artifactPath);
  const digest = crypto.createHash('sha256').update(contents).digest();
  const now = Date.now();
  const sources = sourceIdsFromProvenance(provenance);

  const artifactId = await db.transaction(async tx => {
    const [result] = await tx.execute(
      `INSERT INTO ${ARTIFACTS} (
         public_id, workspace_id, kind, type_key, format, status, name,
         producer_key, purpose, storage_uri, content_type, size_bytes,
         sha256, schema_json, created_unix_ms
       ) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publicId.bytes,
        workspaceId,
        category,
        kind,
        format,
        path.basename(artifactPath),
        producerKey(provenance),
        provenance?.purpose || null,
        artifactPath,
        CONTENT_TYPES[format],
        contents.length,
        digest,
        schemaJson ? JSON.stringify(schemaJson) : null,
        now
      ]
    );

    for (let ordinal = 0; ordinal < sources.length; ordinal += 1) {
      const [sourceRows] = await tx.execute(
        `SELECT id FROM ${ARTIFACTS}
          WHERE public_id = ? AND workspace_id = ?
          LIMIT 1`,
        [uuidStringToBuffer(sources[ordinal]), workspaceId]
      );
      if (!sourceRows[0]) throw new Error(`Source artifact '${sources[ordinal]}' does not exist.`);
      await tx.execute(
        `INSERT INTO ${ARTIFACT_LINKS} (
           artifact_id, workspace_id, related_artifact_id, relation, ordinal
         ) VALUES (?, ?, ?, 'derived_from', ?)`,
        [result.insertId, workspaceId, sourceRows[0].id, ordinal]
      );
    }

    await tx.execute(
      `UPDATE \`atlasai\`.\`aso_workspaces\`
          SET artifact_count = artifact_count + 1,
              updated_unix_ms = ?, revision = revision + 1
        WHERE id = ?`,
      [now, workspaceId]
    );
    return result.insertId;
  });

  return {
    id: artifactId,
    artifactUuid: publicId.text,
    storageUri: artifactPath,
    artifactPath
  };
}

module.exports = { registerArtifact };
