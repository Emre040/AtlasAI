const PREFIX = 'x-atlas-cf-';

function assertConfiguration(env) {
  const origin = new URL(env.ATLAS_ORIGIN_URL);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== env.ATLAS_ORIGIN_URL ||
    origin.username ||
    origin.password
  ) {
    throw new Error('ATLAS_ORIGIN_URL must be one HTTPS origin without credentials or a path.');
  }
  if (typeof env.ATLAS_METADATA_SECRET !== 'string' || env.ATLAS_METADATA_SECRET.length < 32) {
    throw new Error('ATLAS_METADATA_SECRET must contain at least 32 characters.');
  }
  return origin;
}

function set(headers, name, value) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'number' && !Number.isFinite(value)) return;
  headers.set(`${PREFIX}${name}`, String(value));
}

function removeForwardedMetadata(headers) {
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(PREFIX)) headers.delete(name);
  }
}

function addTlsClientAuth(headers, tls = {}) {
  const values = {
    'cert-presented': tls.certPresented,
    'cert-revoked': tls.certRevoked,
    'cert-verified': tls.certVerified,
    'cert-issuer-dn': tls.certIssuerDN,
    'cert-subject-dn': tls.certSubjectDN,
    'cert-issuer-dn-rfc2253': tls.certIssuerDNRFC2253,
    'cert-subject-dn-rfc2253': tls.certSubjectDNRFC2253,
    'cert-issuer-dn-legacy': tls.certIssuerDNLegacy,
    'cert-subject-dn-legacy': tls.certSubjectDNLegacy,
    'cert-serial': tls.certSerial,
    'cert-issuer-serial': tls.certIssuerSerial,
    'cert-fingerprint-sha256': tls.certFingerprintSHA256,
    'cert-fingerprint-sha1': tls.certFingerprintSHA1,
    'cert-not-before': tls.certNotBefore,
    'cert-not-after': tls.certNotAfter,
    'cert-ski': tls.certSKI,
    'cert-issuer-ski': tls.certIssuerSKI,
    'cert-rfc9440': tls.certRFC9440,
    'cert-rfc9440-too-large': tls.certRFC9440TooLarge,
    'cert-chain-rfc9440': tls.certChainRFC9440,
    'cert-chain-rfc9440-too-large': tls.certChainRFC9440TooLarge
  };
  for (const [name, value] of Object.entries(values)) {
    set(headers, `tls-client-auth-${name}`, value);
  }
}

function addBotManagement(headers, cf = {}) {
  const bot = cf.botManagement || {};
  const signals = bot.ja4Signals || {};
  set(headers, 'bot-score', bot.score);
  set(headers, 'verified-bot', bot.verifiedBot);
  set(headers, 'bot-signed-agent', bot.signedAgent);
  set(headers, 'verified-bot-category', cf.verifiedBotCategory);
  set(headers, 'bot-js-detection-passed', bot.jsDetection?.passed);
  set(headers, 'bot-corporate-proxy', bot.corporateProxy);
  set(headers, 'bot-static-resource', bot.staticResource);
  set(headers, 'ja3-hash', bot.ja3Hash);
  set(headers, 'ja4', bot.ja4);
  set(headers, 'bot-detection-ids', Array.isArray(bot.detectionIds) ? bot.detectionIds.join(',') : null);

  for (const name of [
    'h2h3_ratio_1h',
    'heuristic_ratio_1h',
    'browser_ratio_1h',
    'cache_ratio_1h',
    'reqs_quantile_1h',
    'ips_quantile_1h',
    'uas_rank_1h',
    'paths_rank_1h',
    'reqs_rank_1h',
    'ips_rank_1h'
  ]) {
    set(headers, `ja4-${name.replaceAll('_', '-')}`, signals[name]);
  }
}

function addRequestMetadata(headers, cf = {}) {
  const values = {
    asn: cf.asn,
    'as-organization': cf.asOrganization,
    colo: cf.colo,
    'country-code': cf.country,
    'continent-code': cf.continent,
    'is-eu-country': cf.isEUCountry,
    city: cf.city,
    region: cf.region,
    'region-code': cf.regionCode,
    'postal-code': cf.postalCode,
    'metro-code': cf.metroCode,
    timezone: cf.timezone,
    latitude: cf.latitude,
    longitude: cf.longitude,
    'http-protocol': cf.httpProtocol,
    'tls-version': cf.tlsVersion,
    'tls-cipher': cf.tlsCipher,
    'client-tcp-rtt-ms': cf.clientTcpRtt,
    'client-quic-rtt-ms': cf.clientQuicRtt,
    'edge-l4-delivery-rate-bytes-per-second': cf.edgeL4?.deliveryRate,
    'request-priority': cf.requestPriority,
    'client-accept-encoding': cf.clientAcceptEncoding,
    'tls-client-ciphers-sha1': cf.tlsClientCiphersSha1,
    'tls-client-extensions-sha1': cf.tlsClientExtensionsSha1,
    'tls-client-extensions-sha1-le': cf.tlsClientExtensionsSha1Le,
    'tls-client-hello-length': cf.tlsClientHelloLength,
    'tls-client-random': cf.tlsClientRandom
  };
  for (const [name, value] of Object.entries(values)) set(headers, name, value);
  addBotManagement(headers, cf);
  addTlsClientAuth(headers, cf.tlsClientAuth);
}

export default {
  async fetch(request, env) {
    const origin = assertConfiguration(env);
    const incomingUrl = new URL(request.url);
    const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, origin);
    const headers = new Headers(request.headers);

    removeForwardedMetadata(headers);
    addRequestMetadata(headers, request.cf);
    headers.set(`${PREFIX}metadata-secret`, env.ATLAS_METADATA_SECRET);

    return fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual'
    });
  }
};
