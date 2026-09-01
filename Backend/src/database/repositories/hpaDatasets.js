'use strict';

const DATASETS = '`atlasai`.`hpa_datasets`';

const COLUMNS = `
  id, catalog_id, hpa_version, resource, dataset_name, description, file_role, file_name, format,
  compression, release_unix_ms, download_url, source_page_url, source_section, link_text,
  local_status, local_path, download_bytes, unpacked_bytes, downloaded_unix_ms, verified_unix_ms,
  last_error, updated_unix_ms, revision
`;

function rowToDataset(row) {
  return {
    id: Number(row.id),
    catalogId: Number(row.catalog_id),
    hpaVersion: row.hpa_version,
    resource: row.resource,
    datasetName: row.dataset_name,
    description: row.description,
    fileRole: row.file_role,
    fileName: row.file_name,
    format: row.format,
    compression: row.compression,
    releaseUnixMs: Number(row.release_unix_ms),
    downloadUrl: row.download_url,
    sourcePageUrl: row.source_page_url,
    sourceSection: row.source_section,
    linkText: row.link_text,
    localStatus: row.local_status,
    localPath: row.local_path,
    downloadBytes: row.download_bytes === null ? null : Number(row.download_bytes),
    unpackedBytes: row.unpacked_bytes === null ? null : Number(row.unpacked_bytes),
    downloadedUnixMs: row.downloaded_unix_ms === null ? null : Number(row.downloaded_unix_ms),
    verifiedUnixMs: row.verified_unix_ms === null ? null : Number(row.verified_unix_ms),
    lastError: row.last_error,
    updatedUnixMs: Number(row.updated_unix_ms),
    revision: Number(row.revision)
  };
}

class HpaDatasetRepository {
  constructor(db) {
    this.db = db;
  }

  async listForVersion(hpaVersion) {
    const [rows] = await this.db.execute(
      `SELECT ${COLUMNS} FROM ${DATASETS} WHERE hpa_version = ? ORDER BY catalog_id`,
      [hpaVersion]
    );
    return rows.map(rowToDataset);
  }

  async listReady(hpaVersion) {
    const [rows] = await this.db.execute(
      `SELECT ${COLUMNS} FROM ${DATASETS} WHERE hpa_version = ? AND local_status = 'ready' ORDER BY catalog_id`,
      [hpaVersion]
    );
    return rows.map(rowToDataset);
  }

  async markDownloading(id) {
    await this.db.execute(
      `UPDATE ${DATASETS} SET local_status = 'downloading', last_error = NULL, updated_unix_ms = ?, revision = revision + 1 WHERE id = ?`,
      [Date.now(), id]
    );
  }

  async markReady(id, { localPath, downloadBytes, downloadSha256, unpackedBytes, downloadedUnixMs }) {
    const now = Date.now();
    await this.db.execute(
      `UPDATE ${DATASETS}
          SET local_status = 'ready', local_path = ?, download_bytes = ?, download_sha256 = ?, unpacked_bytes = ?,
              downloaded_unix_ms = ?, verified_unix_ms = ?, last_error = NULL, updated_unix_ms = ?, revision = revision + 1
        WHERE id = ?`,
      [localPath, downloadBytes, downloadSha256, unpackedBytes, downloadedUnixMs, now, now, id]
    );
  }

  async markVerified(id) {
    const now = Date.now();
    await this.db.execute(
      `UPDATE ${DATASETS} SET verified_unix_ms = ?, updated_unix_ms = ?, revision = revision + 1 WHERE id = ?`,
      [now, now, id]
    );
  }

  async markFailed(id, message) {
    await this.db.execute(
      `UPDATE ${DATASETS} SET local_status = 'failed', last_error = ?, updated_unix_ms = ?, revision = revision + 1 WHERE id = ?`,
      [String(message).slice(0, 512), Date.now(), id]
    );
  }

  async markMissing(id, message) {
    await this.db.execute(
      `UPDATE ${DATASETS}
          SET local_status = 'missing', local_path = NULL, download_bytes = NULL, download_sha256 = NULL, unpacked_bytes = NULL,
              downloaded_unix_ms = NULL, verified_unix_ms = NULL, last_error = ?, updated_unix_ms = ?, revision = revision + 1
        WHERE id = ?`,
      [message === null ? null : String(message).slice(0, 512), Date.now(), id]
    );
  }
}

module.exports = { HpaDatasetRepository };
