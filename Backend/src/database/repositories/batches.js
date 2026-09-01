'use strict';

const { createUuidV7, uuidBufferToString, uuidStringToBuffer } = require('../../shared/ids');

const JOBS = '`atlasai`.`batch_jobs`';
const QUERIES = '`atlasai`.`batch_queries`';

class BatchRepository {
  constructor(db) {
    this.db = db;
  }

  async create(visitorId, inferenceModelId, queries) {
    const jobPublicId = createUuidV7();
    const now = Date.now();
    const jobId = await this.db.transaction(async tx => {
      const [jobResult] = await tx.execute(
        `INSERT INTO ${JOBS} (
           public_id, visitor_id, inference_model_id, status,
           total_queries, finished_queries, succeeded_queries, failed_queries,
           created_unix_ms, updated_unix_ms, started_unix_ms, revision
         ) VALUES (?, ?, ?, 'running', ?, 0, 0, 0, ?, ?, ?, 1)`,
        [jobPublicId.bytes, visitorId, inferenceModelId, queries.length, now, now, now]
      );

      for (let index = 0; index < queries.length; index += 1) {
        const queryPublicId = createUuidV7();
        await tx.execute(
          `INSERT INTO ${QUERIES} (
             public_id, job_id, query_index, status, query_text,
             inference_model_id, created_unix_ms, updated_unix_ms
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
          [queryPublicId.bytes, jobResult.insertId, index, queries[index], inferenceModelId, now, now]
        );
      }
      return jobResult.insertId;
    });
    return { id: jobId, publicId: jobPublicId.text, createdUnixMs: now };
  }

  async findOwned(publicId, visitorId) {
    const [rows] = await this.db.execute(
      `SELECT id, public_id, status, total_queries, finished_queries,
              succeeded_queries, failed_queries, created_unix_ms, finished_unix_ms
         FROM ${JOBS}
        WHERE public_id = ? AND visitor_id = ?
        LIMIT 1`,
      [uuidStringToBuffer(publicId), visitorId]
    );
    if (!rows[0]) return null;
    return {
      ...rows[0],
      publicId: uuidBufferToString(rows[0].public_id),
      createdUnixMs: Number(rows[0].created_unix_ms),
      finishedUnixMs: rows[0].finished_unix_ms === null ? null : Number(rows[0].finished_unix_ms)
    };
  }

  async listQueries(jobId) {
    const [rows] = await this.db.execute(
      `SELECT query_index, query_text, status, response_text, response_json,
              error_message, finished_unix_ms
         FROM ${QUERIES}
        WHERE job_id = ?
        ORDER BY query_index`,
      [jobId]
    );
    return rows;
  }

  async startQuery(jobId, queryIndex) {
    const now = Date.now();
    const [result] = await this.db.execute(
      `UPDATE ${QUERIES}
          SET status = 'running', started_unix_ms = ?, updated_unix_ms = ?
        WHERE job_id = ? AND query_index = ? AND status = 'pending'`,
      [now, now, jobId, queryIndex]
    );
    if (result.affectedRows !== 1) throw new Error('Batch query was not pending.');
    const [rows] = await this.db.execute(
      `SELECT id FROM ${QUERIES} WHERE job_id = ? AND query_index = ? LIMIT 1`,
      [jobId, queryIndex]
    );
    return { id: rows[0].id, startedUnixMs: now };
  }

  async completeQuery(jobId, queryIndex, responseText, responseJson) {
    const now = Date.now();
    await this.db.transaction(async tx => {
      const [result] = await tx.execute(
        `UPDATE ${QUERIES}
            SET status = 'completed', response_text = ?, response_json = ?,
                updated_unix_ms = ?, finished_unix_ms = ?
          WHERE job_id = ? AND query_index = ? AND status = 'running'`,
        [responseText, JSON.stringify(responseJson), now, now, jobId, queryIndex]
      );
      if (result.affectedRows !== 1) throw new Error('Batch query was not running.');
      await tx.execute(
        `UPDATE ${JOBS}
            SET finished_queries = finished_queries + 1,
                succeeded_queries = succeeded_queries + 1,
                updated_unix_ms = ?, revision = revision + 1
          WHERE id = ?`,
        [now, jobId]
      );
    });
  }

  async failQuery(jobId, queryIndex, errorCode, errorMessage) {
    const now = Date.now();
    await this.db.transaction(async tx => {
      const [result] = await tx.execute(
        `UPDATE ${QUERIES}
            SET status = 'failed', error_code = ?, error_message = ?,
                updated_unix_ms = ?, finished_unix_ms = ?
          WHERE job_id = ? AND query_index = ? AND status = 'running'`,
        [errorCode, errorMessage, now, now, jobId, queryIndex]
      );
      if (result.affectedRows !== 1) throw new Error('Batch query was not running.');
      await tx.execute(
        `UPDATE ${JOBS}
            SET finished_queries = finished_queries + 1,
                failed_queries = failed_queries + 1,
                updated_unix_ms = ?, revision = revision + 1
          WHERE id = ?`,
        [now, jobId]
      );
    });
  }

  async finishJob(jobId) {
    const now = Date.now();
    const [result] = await this.db.execute(
      `UPDATE ${JOBS}
          SET status = CASE WHEN failed_queries = 0 THEN 'completed' ELSE 'failed' END,
              updated_unix_ms = ?, finished_unix_ms = ?, revision = revision + 1
        WHERE id = ? AND status = 'running' AND finished_queries = total_queries`,
      [now, now, jobId]
    );
    if (result.affectedRows !== 1) throw new Error('Batch job cannot be finalized before every query finishes.');
  }
}

module.exports = { BatchRepository };
