'use strict';

const { uuidStringToBuffer } = require('../../shared/ids');

const WORKSPACES = '`atlasai`.`aso_workspaces`';
const ARTIFACTS = '`atlasai`.`aso_artifacts`';

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
}

module.exports = { WorkspaceRepository };
