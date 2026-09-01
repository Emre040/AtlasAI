'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const RAY_PATTERN = /^([0-9a-f]{16,64})(?:-([a-z]{3}))?$/i;

function header(req, name, maxLength = 65535) {
  const value = req.headers?.[name];
  if (value === undefined || value === null) return null;
  const text = Array.isArray(value) ? value.join(',') : String(value);
  return text.slice(0, maxLength);
}

function normalizedIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return null;
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  const zoneIndex = ip.indexOf('%');
  if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

function isLoopback(value) {
  const ip = normalizedIp(value);
  return ip === '::1' || ip?.startsWith('127.') === true;
}

function integer(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d+$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function decimal(value, { min, max }) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function boolean(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', '?1'].includes(normalized)) return 1;
  if (['0', 'false', 'no', 'off', '?0'].includes(normalized)) return 0;
  return null;
}

function hexDigest(value, bytes) {
  const normalized = String(value || '').replaceAll(':', '').trim();
  return new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(normalized)
    ? Buffer.from(normalized, 'hex')
    : null;
}

function hexText(value, characters) {
  const normalized = String(value || '').trim().toLowerCase();
  return new RegExp(`^[0-9a-f]{${characters}}$`).test(normalized) ? normalized : null;
}

function code(value, characters) {
  const normalized = String(value || '').trim().toUpperCase();
  return new RegExp(`^[A-Z0-9]{${characters}}$`).test(normalized) ? normalized : null;
}

function printableAscii(value, maxLength) {
  const normalized = String(value || '').trim();
  return normalized && normalized.length <= maxLength && /^[\x20-\x7e]+$/.test(normalized)
    ? normalized
    : null;
}

function unixMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (/^\d+$/.test(String(value))) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function trustedSecret(provided, expected) {
  if (!provided || !expected) return false;
  const actualHash = crypto.createHash('sha256').update(String(provided), 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function parseRay(value) {
  const match = String(value || '').trim().match(RAY_PATTERN);
  if (!match) return { id: null, colo: null };
  return { id: match[1].toLowerCase(), colo: match[2]?.toUpperCase() || null };
}

function parseVisitorScheme(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed?.scheme === 'http' || parsed?.scheme === 'https' ? parsed.scheme : null;
  } catch {
    return null;
  }
}

function parsePort(value) {
  return integer(value, { min: 1, max: 65535 });
}

function parseHost(req) {
  const rawHost = header(req, 'host', 512) || '';
  try {
    const url = new URL(`http://${rawHost}`);
    return {
      host: url.hostname.slice(0, 255),
      port: parsePort(url.port) || null
    };
  } catch {
    return { host: rawHost.slice(0, 255), port: null };
  }
}

function parseRequestUrl(req) {
  const raw = String(req.originalUrl || req.url || '/');
  const question = raw.indexOf('?');
  const path = question === -1 ? raw : raw.slice(0, question);
  const queryString = question === -1 ? '' : raw.slice(question + 1);
  return {
    path,
    queryParameterCount: [...new URLSearchParams(queryString).keys()].length,
    queryStringBytes: Buffer.byteLength(queryString, 'utf8')
  };
}

function routeKey(req) {
  const routePath = req.route?.path;
  if (typeof routePath !== 'string') return null;
  return `${req.baseUrl || ''}${routePath}`.slice(0, 128);
}

function detectionIds(value) {
  if (!value) return [];
  const ids = new Set();
  for (const part of String(value).split(',')) {
    const parsed = integer(part.trim(), { min: 1 });
    if (parsed !== null) ids.add(parsed);
  }
  return [...ids];
}

function extractRequestContext(req, config, startedAt) {
  const socketIp = normalizedIp(req.socket?.remoteAddress);
  const ray = parseRay(header(req, 'cf-ray', 128));
  const connectingIp = normalizedIp(header(req, 'cf-connecting-ip', 128));
  const trustedCloudflare = isLoopback(socketIp) && Boolean(ray.id && connectingIp);
  const enriched = trustedCloudflare && config.enrichedHeaders && trustedSecret(
    header(req, 'x-atlas-cf-metadata-secret', 512),
    config.metadataSecret
  );
  const worker = (name, maxLength) => enriched
    ? header(req, `x-atlas-cf-${name}`, maxLength)
    : null;
  const standard = (name, maxLength) => trustedCloudflare ? header(req, name, maxLength) : null;
  const cloudflare = (workerName, standardName, maxLength) => enriched
    ? worker(workerName, maxLength)
    : standard(standardName, maxLength);
  const forwardedFor = trustedCloudflare ? header(req, 'x-forwarded-for') : null;
  const host = parseHost(req);
  const parsedUrl = parseRequestUrl(req);
  const requestScheme = req.protocol === 'https' ? 'https' : 'http';
  const responseLength = integer(resHeader(req, 'content-length'));
  const requestLength = integer(header(req, 'content-length'));
  const elapsedUs = Number((process.hrtime.bigint() - startedAt) / 1000n);

  const values = {
    received_unix_ms: Date.now(),
    ingress: trustedCloudflare ? 'cloudflare' : (isLoopback(socketIp) ? 'internal' : 'direct'),
    request_method: req.method,
    request_scheme: requestScheme,
    request_protocol: `HTTP/${req.httpVersion}`.slice(0, 32),
    request_host: host.host,
    request_port: host.port || (requestScheme === 'https' ? 443 : 80),
    route_key: routeKey(req),
    request_path: parsedUrl.path,
    query_parameter_count: parsedUrl.queryParameterCount,
    query_string_bytes: parsedUrl.queryStringBytes,
    request_body_bytes: requestLength,
    request_content_type: header(req, 'content-type', 255),
    request_content_encoding: header(req, 'content-encoding', 128),
    response_status: req.res?.statusCode || null,
    response_body_bytes: responseLength,
    response_content_type: resHeader(req, 'content-type', 255),
    duration_us: elapsedUs,
    client_ip: trustedCloudflare ? connectingIp : socketIp,
    trusted_proxy_hops: forwardedFor ? forwardedFor.split(',').length : 0,
    x_forwarded_proto: standard('x-forwarded-proto', 32),
    x_forwarded_host: standard('x-forwarded-host', 255),
    x_forwarded_port: parsePort(standard('x-forwarded-port', 16)),
    cf_connecting_ip: connectingIp,
    cf_connecting_ipv6: normalizedIp(standard('cf-connecting-ipv6', 128)),
    cf_pseudo_ipv4: normalizedIp(standard('cf-pseudo-ipv4', 128)),
    cf_true_client_ip: normalizedIp(standard('true-client-ip', 128)),
    cf_connecting_o2o: boolean(standard('cf-connecting-o2o', 16)),
    cf_ray_id: trustedCloudflare ? ray.id : null,
    cf_ray_colo: trustedCloudflare ? ray.colo : null,
    cf_worker_colo: code(worker('colo', 3), 3),
    cf_visitor_scheme: parseVisitorScheme(standard('cf-visitor', 128)),
    cf_worker: standard('cf-worker', 255),
    cf_cdn_loop: standard('cdn-loop', 255),
    cf_ew_via: standard('cf-ew-via', 255),
    cf_country_code: code(cloudflare('country-code', 'cf-ipcountry', 2), 2),
    cf_continent_code: code(cloudflare('continent-code', 'cf-ipcontinent', 2), 2),
    cf_is_eu_country: boolean(worker('is-eu-country', 16)),
    cf_city: cloudflare('city', 'cf-ipcity', 128),
    cf_region: cloudflare('region', 'cf-region', 128),
    cf_region_code: cloudflare('region-code', 'cf-region-code', 32),
    cf_postal_code: cloudflare('postal-code', 'cf-postal-code', 32),
    cf_metro_code: cloudflare('metro-code', 'cf-metro-code', 16),
    cf_timezone: cloudflare('timezone', 'cf-timezone', 64),
    cf_latitude: decimal(cloudflare('latitude', 'cf-iplatitude', 32), { min: -90, max: 90 }),
    cf_longitude: decimal(cloudflare('longitude', 'cf-iplongitude', 32), { min: -180, max: 180 }),
    cf_asn: integer(cloudflare('asn', 'cf-asn', 32), { min: 1 }),
    cf_as_organization: cloudflare('as-organization', 'cf-as-organization', 255),
    cf_http_protocol: worker('http-protocol', 32),
    cf_tls_version: worker('tls-version', 32),
    cf_tls_cipher: worker('tls-cipher', 128),
    cf_client_tcp_rtt_ms: integer(worker('client-tcp-rtt-ms', 32)),
    cf_client_quic_rtt_ms: integer(worker('client-quic-rtt-ms', 32)),
    cf_edge_l4_delivery_rate_bytes_per_second: integer(worker('edge-l4-delivery-rate-bytes-per-second', 32)),
    cf_request_priority: worker('request-priority', 128),
    cf_client_accept_encoding: worker('client-accept-encoding', 255),
    cf_tls_client_ciphers_sha1_base64: worker('tls-client-ciphers-sha1', 64),
    cf_tls_client_extensions_sha1_base64: worker('tls-client-extensions-sha1', 128),
    cf_tls_client_extensions_sha1_le_base64: worker('tls-client-extensions-sha1-le', 64),
    cf_tls_client_hello_length_bytes: integer(worker('tls-client-hello-length', 32)),
    cf_tls_client_random: worker('tls-client-random', 128),
    cf_tls_client_auth_cert_presented: boolean(cloudflare('tls-client-auth-cert-presented', 'cf-cert-presented', 16)),
    cf_tls_client_auth_cert_revoked: boolean(cloudflare('tls-client-auth-cert-revoked', 'cf-cert-revoked', 16)),
    cf_tls_client_auth_cert_verified: cloudflare('tls-client-auth-cert-verified', 'cf-cert-verified'),
    cf_tls_client_auth_cert_issuer_dn: cloudflare('tls-client-auth-cert-issuer-dn', 'cf-cert-issuer-dn'),
    cf_tls_client_auth_cert_subject_dn: cloudflare('tls-client-auth-cert-subject-dn', 'cf-cert-subject-dn'),
    cf_tls_client_auth_cert_issuer_dn_rfc2253: cloudflare('tls-client-auth-cert-issuer-dn-rfc2253', 'cf-cert-issuer-dn-rfc2253'),
    cf_tls_client_auth_cert_subject_dn_rfc2253: cloudflare('tls-client-auth-cert-subject-dn-rfc2253', 'cf-cert-subject-dn-rfc2253'),
    cf_tls_client_auth_cert_issuer_dn_legacy: cloudflare('tls-client-auth-cert-issuer-dn-legacy', 'cf-cert-issuer-dn-legacy'),
    cf_tls_client_auth_cert_subject_dn_legacy: cloudflare('tls-client-auth-cert-subject-dn-legacy', 'cf-cert-subject-dn-legacy'),
    cf_tls_client_auth_cert_serial: cloudflare('tls-client-auth-cert-serial', 'cf-cert-serial', 512),
    cf_tls_client_auth_cert_issuer_serial: cloudflare('tls-client-auth-cert-issuer-serial', 'cf-cert-issuer-serial', 512),
    cf_tls_client_auth_cert_fingerprint_sha256: hexDigest(cloudflare('tls-client-auth-cert-fingerprint-sha256', 'cf-cert-fingerprint-sha256', 128), 32),
    cf_tls_client_auth_cert_fingerprint_sha1: hexDigest(cloudflare('tls-client-auth-cert-fingerprint-sha1', 'cf-cert-fingerprint-sha1', 64), 20),
    cf_tls_client_auth_cert_not_before_unix_ms: unixMs(cloudflare('tls-client-auth-cert-not-before', 'cf-cert-not-before', 128)),
    cf_tls_client_auth_cert_not_after_unix_ms: unixMs(cloudflare('tls-client-auth-cert-not-after', 'cf-cert-not-after', 128)),
    cf_tls_client_auth_cert_ski: cloudflare('tls-client-auth-cert-ski', 'cf-cert-ski', 512),
    cf_tls_client_auth_cert_issuer_ski: cloudflare('tls-client-auth-cert-issuer-ski', 'cf-cert-issuer-ski', 512),
    cf_tls_client_auth_cert_rfc9440: worker('tls-client-auth-cert-rfc9440'),
    cf_tls_client_auth_cert_rfc9440_too_large: boolean(worker('tls-client-auth-cert-rfc9440-too-large', 16)),
    cf_tls_client_auth_cert_chain_rfc9440: worker('tls-client-auth-cert-chain-rfc9440'),
    cf_tls_client_auth_cert_chain_rfc9440_too_large: boolean(worker('tls-client-auth-cert-chain-rfc9440-too-large', 16)),
    cf_bot_score: integer(cloudflare('bot-score', 'cf-bot-score', 8), { min: 1, max: 99 }),
    cf_verified_bot: boolean(cloudflare('verified-bot', 'cf-verified-bot', 16)),
    cf_signed_agent: boolean(worker('bot-signed-agent', 16)),
    cf_verified_bot_category: worker('verified-bot-category', 128),
    cf_js_detection_passed: boolean(worker('bot-js-detection-passed', 16)),
    cf_corporate_proxy: boolean(worker('bot-corporate-proxy', 16)),
    cf_static_resource: boolean(worker('bot-static-resource', 16)),
    cf_ja3_hash: hexText(cloudflare('ja3-hash', 'cf-ja3-hash', 32), 32),
    cf_ja4_fingerprint: printableAscii(cloudflare('ja4', 'cf-ja4', 128), 128),
    cf_ja4_h2h3_ratio_1h: decimal(worker('ja4-h2h3-ratio-1h', 64), { min: 0, max: 1 }),
    cf_ja4_heuristic_ratio_1h: decimal(worker('ja4-heuristic-ratio-1h', 64), { min: 0, max: 1 }),
    cf_ja4_browser_ratio_1h: decimal(worker('ja4-browser-ratio-1h', 64), { min: 0, max: 1 }),
    cf_ja4_cache_ratio_1h: decimal(worker('ja4-cache-ratio-1h', 64), { min: 0, max: 1 }),
    cf_ja4_reqs_quantile_1h: decimal(worker('ja4-reqs-quantile-1h', 64), { min: 0, max: 1 }),
    cf_ja4_ips_quantile_1h: decimal(worker('ja4-ips-quantile-1h', 64), { min: 0, max: 1 }),
    cf_ja4_uas_rank_1h: integer(worker('ja4-uas-rank-1h', 32)),
    cf_ja4_paths_rank_1h: integer(worker('ja4-paths-rank-1h', 32)),
    cf_ja4_reqs_rank_1h: integer(worker('ja4-reqs-rank-1h', 32)),
    cf_ja4_ips_rank_1h: integer(worker('ja4-ips-rank-1h', 32)),
    cf_exposed_credential_check: integer(standard('exposed-credential-check', 8), { min: 1, max: 4 }),
    cf_malicious_uploads_detection: integer(standard('malicious-uploads-detection', 8), { min: 1, max: 3 }),
    user_agent: header(req, 'user-agent'),
    accept: header(req, 'accept'),
    accept_language: header(req, 'accept-language'),
    accept_encoding: header(req, 'accept-encoding'),
    referer: header(req, 'referer'),
    origin: header(req, 'origin'),
    sec_fetch_site: header(req, 'sec-fetch-site', 32),
    sec_fetch_mode: header(req, 'sec-fetch-mode', 32),
    sec_fetch_dest: header(req, 'sec-fetch-dest', 32),
    sec_fetch_user: header(req, 'sec-fetch-user', 16),
    sec_ch_ua: header(req, 'sec-ch-ua'),
    sec_ch_ua_full_version: header(req, 'sec-ch-ua-full-version', 128),
    sec_ch_ua_full_version_list: header(req, 'sec-ch-ua-full-version-list'),
    sec_ch_ua_platform: header(req, 'sec-ch-ua-platform', 128),
    sec_ch_ua_platform_version: header(req, 'sec-ch-ua-platform-version', 128),
    sec_ch_ua_mobile: boolean(header(req, 'sec-ch-ua-mobile', 16)),
    sec_ch_ua_model: header(req, 'sec-ch-ua-model', 255),
    sec_ch_ua_arch: header(req, 'sec-ch-ua-arch', 64),
    sec_ch_ua_bitness: header(req, 'sec-ch-ua-bitness', 32),
    sec_ch_ua_wow64: boolean(header(req, 'sec-ch-ua-wow64', 16)),
    do_not_track: boolean(header(req, 'dnt', 16)),
    global_privacy_control: boolean(header(req, 'sec-gpc', 16)),
    traceparent: header(req, 'traceparent', 256),
    tracestate: header(req, 'tracestate')
  };

  return {
    values,
    botDetectionIds: detectionIds(worker('bot-detection-ids')),
    trustedCloudflare,
    enriched
  };
}

function resHeader(req, name, maxLength = 65535) {
  const value = req.res?.getHeader?.(name);
  if (value === undefined || value === null) return null;
  return String(value).slice(0, maxLength);
}

module.exports = {
  extractRequestContext,
  normalizedIp,
  parseRay,
  trustedSecret
};
