'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractRequestContext } = require('../../src/http/requestContext/cloudflare');

function request({ remoteAddress = '127.0.0.1', headers = {} } = {}) {
  return {
    method: 'GET',
    protocol: 'https',
    httpVersion: '1.1',
    originalUrl: '/query?one=1&two=2',
    baseUrl: '',
    route: { path: '/query' },
    headers: { host: 'api.example.test', ...headers },
    socket: { remoteAddress },
    res: {
      statusCode: 200,
      getHeader(name) {
        return name === 'content-type' ? 'application/json' : null;
      }
    }
  };
}

test('Cloudflare headers are ignored outside the trusted local tunnel boundary', () => {
  const context = extractRequestContext(request({
    remoteAddress: '198.51.100.20',
    headers: {
      'cf-ray': '0123456789abcdef-arn',
      'cf-connecting-ip': '203.0.113.5',
      'cf-ipcountry': 'SE'
    }
  }), { enrichedHeaders: false, metadataSecret: null }, process.hrtime.bigint());

  assert.equal(context.trustedCloudflare, false);
  assert.equal(context.values.ingress, 'direct');
  assert.equal(context.values.client_ip, '198.51.100.20');
  assert.equal(context.values.cf_ray_id, null);
  assert.equal(context.values.cf_country_code, null);
});

test('trusted tunnel requests parse explicit standard columns without storing a metadata object', () => {
  const context = extractRequestContext(request({
    headers: {
      'cf-ray': '0123456789abcdef-arn',
      'cf-connecting-ip': '203.0.113.5',
      'cf-ipcountry': 'SE',
      'cf-asn': '1257',
      'cf-as-organization': 'Tele2 Sverige AB',
      'cf-visitor': '{"scheme":"https","ignored":"value"}'
    }
  }), { enrichedHeaders: false, metadataSecret: null }, process.hrtime.bigint());

  assert.equal(context.trustedCloudflare, true);
  assert.equal(context.values.cf_ray_colo, 'ARN');
  assert.equal(context.values.cf_country_code, 'SE');
  assert.equal(context.values.cf_asn, 1257);
  assert.equal(context.values.cf_as_organization, 'Tele2 Sverige AB');
  assert.equal(context.values.cf_visitor_scheme, 'https');
  assert.equal(Object.keys(context.values).some(key => /metadata|extra/i.test(key)), false);
});

test('Worker-only fields require the configured timing-safe metadata secret', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const baseHeaders = {
    'cf-ray': '0123456789abcdef-arn',
    'cf-connecting-ip': '203.0.113.5',
    'cf-ipcountry': 'US',
    'x-atlas-cf-country-code': 'SE',
    'x-atlas-cf-bot-score': '12',
    'x-atlas-cf-asn': '1257'
  };
  const rejected = extractRequestContext(request({ headers: baseHeaders }), {
    enrichedHeaders: true,
    metadataSecret: secret
  }, process.hrtime.bigint());
  assert.equal(rejected.enriched, false);
  assert.equal(rejected.values.cf_bot_score, null);

  const accepted = extractRequestContext(request({
    headers: { ...baseHeaders, 'x-atlas-cf-metadata-secret': secret }
  }), { enrichedHeaders: true, metadataSecret: secret }, process.hrtime.bigint());
  assert.equal(accepted.enriched, true);
  assert.equal(accepted.values.cf_country_code, 'SE');
  assert.equal(accepted.values.cf_bot_score, 12);
  assert.equal(accepted.values.cf_asn, 1257);
});
