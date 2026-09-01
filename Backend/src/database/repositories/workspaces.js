'use strict';

const { uuidStringToBuffer } = require('../../shared/ids');

const WORKSPACES = '`atlasai`.`aso_workspaces`';
const ARTIFACTS = '`atlasai`.`aso_artifacts`';
const ARTIFACT_LINKS = '`atlasai`.`aso_artifact_links`';

class WorkspaceRepository {
  constructor(db) {
    this.db = db;
  }

  async findOwned(publicId, visitorId) {
    const [rows] = await this.db.execute(
      `SELECT id, storage_prefix
         FROM ${WORKSPACES}
        WHERE public_id = ? AND visitor_id = ?
        LIMIT 1`,
      [uuidStringToBuffer(publicId), visitorId]
    );
    return rows[0] || null;
  }

  // Artifacts are registered only after their file exists, so a row is always servable.
  async findArtifact(workspaceId, filename) {
    const [rows] = await this.db.execute(
      `SELECT id, storage_uri, content_type, size_bytes, sha256
         FROM ${ARTIFACTS}
        WHERE workspace_id = ? AND name = ?
        LIMIT 1`,
      [workspaceId, filename]
    );
    return rows[0] || null;
  }

  // Everything the provenance graph needs: the workspace header, its artifacts, and the links
  // between them, in creation order.
  async provenance(publicId, visitorId) {
    const [workspaces] = await this.db.execute(
      `SELECT w.id, w.public_id, w.status, w.request_text, w.plan_json, w.artifact_count, w.status_message,
              w.created_unix_ms, w.started_unix_ms, w.finished_unix_ms, m.config_key AS model_config_key
         FROM ${WORKSPACES} w
         JOIN \`atlasai\`.\`inference_models\` m ON m.id = w.inference_model_id
        WHERE w.public_id = ? AND w.visitor_id = ?
        LIMIT 1`,
      [uuidStringToBuffer(publicId), visitorId]
    );
    const workspace = workspaces[0];
    if (!workspace) return null;
    const [artifacts] = await this.db.execute(
      `SELECT id, public_id, kind, type_key, format, name, producer_key, purpose, storage_uri, content_type,
              size_bytes, schema_json, created_unix_ms
         FROM ${ARTIFACTS}
        WHERE workspace_id = ?
        ORDER BY id`,
      [workspace.id]
    );
    const [links] = await this.db.execute(
      `SELECT artifact_id, related_artifact_id, relation, ordinal
         FROM ${ARTIFACT_LINKS}
        WHERE workspace_id = ?
        ORDER BY artifact_id, relation, ordinal`,
      [workspace.id]
    );
    return { workspace, artifacts, links };
  }
}

module.exports = { WorkspaceRepository };
