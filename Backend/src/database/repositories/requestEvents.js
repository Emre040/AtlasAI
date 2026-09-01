'use strict';

const { createUuidV7 } = require('../../shared/ids');

const REQUEST_EVENTS = '`atlasai`.`request_events`';
const BOT_DETECTIONS = '`atlasai`.`request_event_bot_detections`';
const VISITORS = '`atlasai`.`visitors`';
const IP_COLUMNS = new Set([
  'client_ip',
  'cf_connecting_ip',
  'cf_connecting_ipv6',
  'cf_pseudo_ipv4',
  'cf_true_client_ip'
]);

class RequestEventRepository {
  constructor(db) {
    this.db = db;
  }

  async record(context, auth = null) {
    const publicId = createUuidV7();
    const fields = {
      public_id: publicId.bytes,
      visitor_id: auth?.visitorId || null,
      auth_session_id: auth?.sessionId || null,
      ...context.values
    };
    const entries = Object.entries(fields);
    const columns = entries.map(([name]) => `\`${name}\``).join(', ');
    const placeholders = entries
      .map(([name]) => IP_COLUMNS.has(name) ? 'INET6_ATON(?)' : '?')
      .join(', ');
    const params = entries.map(([, value]) => value);

    return this.db.transaction(async tx => {
      const [result] = await tx.execute(
        `INSERT INTO ${REQUEST_EVENTS} (${columns}) VALUES (${placeholders})`,
        params
      );

      for (const detectionId of context.botDetectionIds) {
        await tx.execute(
          `INSERT INTO ${BOT_DETECTIONS} (request_event_id, detection_id) VALUES (?, ?)`,
          [result.insertId, detectionId]
        );
      }

      if (auth?.visitorId) {
        await tx.execute(
          `UPDATE ${VISITORS}
              SET last_seen_unix_ms = GREATEST(last_seen_unix_ms, ?),
                  request_count = request_count + 1,
                  revision = revision + 1
            WHERE id = ?`,
          [context.values.received_unix_ms, auth.visitorId]
        );
      }
      return { id: result.insertId, publicId: publicId.text };
    });
  }
}

module.exports = { RequestEventRepository };
