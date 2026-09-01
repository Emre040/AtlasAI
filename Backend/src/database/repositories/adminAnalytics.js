'use strict';

const { uuidBufferToString, uuidStringToBuffer } = require('../../shared/ids');
const { sqlLimit } = require('../sql');

class AdminAnalyticsRepository {
  constructor(db) {
    this.db = db;
  }

  async summary() {
    const [[visitors], [conversations], [messages], [runs], [calls]] = await Promise.all([
      this.db.execute('SELECT COUNT(*) AS count FROM `atlasai`.`visitors`'),
      this.db.execute("SELECT COUNT(*) AS count FROM `atlasai`.`conversations` WHERE status <> 'deleted'"),
      this.db.execute('SELECT COUNT(*) AS count FROM `atlasai`.`messages`'),
      this.db.execute("SELECT COUNT(*) AS count, COALESCE(SUM(status = 'failed'), 0) AS failed FROM `atlasai`.`runs`"),
      this.db.execute(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(status = 'failed'), 0) AS failed,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS tokens
           FROM \`atlasai\`.\`inference_calls\``
      )
    ]);
    return {
      visitors: Number(visitors[0].count),
      conversations: Number(conversations[0].count),
      messages: Number(messages[0].count),
      runs: Number(runs[0].count),
      failed_runs: Number(runs[0].failed),
      inference_calls: Number(calls[0].count),
      failed_inference_calls: Number(calls[0].failed),
      input_tokens: Number(calls[0].input_tokens),
      output_tokens: Number(calls[0].output_tokens),
      tokens: Number(calls[0].tokens)
    };
  }

  async geo() {
    const [rows] = await this.db.execute(
      `SELECT COALESCE(cf_country_code, 'UNKNOWN') AS country,
              COUNT(*) AS sessions
         FROM \`atlasai\`.\`request_events\`
        GROUP BY cf_country_code
        ORDER BY sessions DESC, country`
    );
    return rows.map(row => ({ country: row.country, sessions: Number(row.sessions) }));
  }

  async visitors(limit = 50) {
    const rowLimit = sqlLimit(limit, 1000);
    const [rows] = await this.db.execute(
      `SELECT
         v.public_id,
         v.request_count,
         v.last_seen_unix_ms,
         INET6_NTOA(e.client_ip) AS last_ip,
         e.user_agent AS last_user_agent,
         e.cf_country_code AS country,
         CASE WHEN visitor_rule.id IS NULL THEN 0 ELSE 1 END AS block_fingerprint,
         CASE WHEN ip_rule.id IS NULL THEN 0 ELSE 1 END AS block_ip
       FROM \`atlasai\`.\`visitors\` v
       LEFT JOIN \`atlasai\`.\`request_events\` e ON e.id = (
         SELECT re.id
           FROM \`atlasai\`.\`request_events\` re
          WHERE re.visitor_id = v.id
          ORDER BY re.received_unix_ms DESC, re.id DESC
          LIMIT 1
       )
       LEFT JOIN \`atlasai\`.\`access_rules\` visitor_rule
         ON visitor_rule.visitor_id = v.id
        AND visitor_rule.match_type = 'visitor'
        AND visitor_rule.action = 'block'
        AND visitor_rule.status = 'active'
        AND (visitor_rule.expires_unix_ms IS NULL OR visitor_rule.expires_unix_ms > ?)
       LEFT JOIN \`atlasai\`.\`access_rules\` ip_rule
         ON ip_rule.active_match_sha256 = UNHEX(SHA2(CONCAT(_ascii'ip', CHAR(0), e.client_ip), 256))
        AND ip_rule.action = 'block'
        AND (ip_rule.expires_unix_ms IS NULL OR ip_rule.expires_unix_ms > ?)
       ORDER BY v.last_seen_unix_ms DESC, v.id DESC
       LIMIT ${rowLimit}`,
      [Date.now(), Date.now()]
    );
    return rows.map(row => ({
      visitor_id: uuidBufferToString(row.public_id),
      access_count: Number(row.request_count),
      last_seen: Number(row.last_seen_unix_ms),
      last_ip: row.last_ip,
      last_user_agent: row.last_user_agent,
      block_fingerprint: Number(row.block_fingerprint),
      block_ip: Number(row.block_ip),
      country: row.country || 'UNKNOWN'
    }));
  }

  async visitor(publicId) {
    const [rows] = await this.db.execute(
      `SELECT v.id, v.public_id,
              (
                SELECT INET6_NTOA(re.client_ip)
                  FROM \`atlasai\`.\`request_events\` re
                 WHERE re.visitor_id = v.id AND re.client_ip IS NOT NULL
                 ORDER BY re.received_unix_ms DESC, re.id DESC
                 LIMIT 1
              ) AS last_ip
         FROM \`atlasai\`.\`visitors\` v
        WHERE v.public_id = ?
        LIMIT 1`,
      [uuidStringToBuffer(publicId)]
    );
    if (!rows[0]) return null;
    return { id: rows[0].id, publicId, lastIp: rows[0].last_ip };
  }
}

module.exports = { AdminAnalyticsRepository };
