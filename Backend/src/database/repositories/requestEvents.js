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
// Known only once the response has been sent; NULL while the request is in flight.
const RESPONSE_COLUMNS = ['response_status', 'response_body_bytes', 'response_content_type', 'duration_us'];

class RequestEventRepository {
  constructor(db) {
    this.db = db;
  }

  // Inserts the request as soon as it arrives so runs and inference calls made while serving it
  // can reference the row. `finish` fills in the response columns and the visitor later.
  async begin(context, receivedUnixMs) {
    const publicId = createUuidV7();
    const fields = {
      public_id: publicId.bytes,
      visitor_id: null,
      auth_session_id: null,
      ...context.values,
      received_unix_ms: receivedUnixMs
    };
    for (const name of RESPONSE_COLUMNS) fields[name] = null;
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
      return { id: result.insertId, publicId: publicId.text };
    });
  }

  async finish(requestEventId, context, auth = null) {
    const values = context.values;
    return this.db.transaction(async tx => {
      // route_key is only known once Express has matched the route, so it is filled here.
      await tx.execute(
        `UPDATE ${REQUEST_EVENTS}
            SET response_status = ?, response_body_bytes = ?, response_content_type = ?,
                duration_us = ?, route_key = ?, visitor_id = ?, auth_session_id = ?
          WHERE id = ?`,
        [
          values.response_status ?? null,
          values.response_body_bytes ?? null,
          values.response_content_type ?? null,
          values.duration_us ?? null,
          values.route_key ?? null,
          auth?.visitorId || null,
          auth?.sessionId || null,
          requestEventId
        ]
      );
      if (auth?.visitorId) {
        await tx.execute(
          `UPDATE ${VISITORS}
              SET last_seen_unix_ms = GREATEST(last_seen_unix_ms, ?),
                  request_count = request_count + 1,
                  revision = revision + 1
            WHERE id = ?`,
          [values.received_unix_ms, auth.visitorId]
        );
      }
    });
  }
}

module.exports = { RequestEventRepository };
