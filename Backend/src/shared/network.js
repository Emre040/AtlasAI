'use strict';

const net = require('node:net');

function ipv4Buffer(ip) {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new TypeError('Invalid IPv4 address.');
  }
  return Buffer.from(octets);
}

function ipv6Buffer(ip) {
  let source = ip.toLowerCase();
  const zoneIndex = source.indexOf('%');
  if (zoneIndex !== -1) source = source.slice(0, zoneIndex);

  const embeddedMatch = source.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embeddedMatch) {
    const ipv4 = ipv4Buffer(embeddedMatch[1]);
    const high = ipv4.readUInt16BE(0).toString(16);
    const low = ipv4.readUInt16BE(2).toString(16);
    source = source.slice(0, -embeddedMatch[1].length) + `${high}:${low}`;
  }

  const halves = source.split('::');
  if (halves.length > 2) throw new TypeError('Invalid IPv6 address.');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new TypeError('Invalid IPv6 address.');
  }
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) {
    throw new TypeError('Invalid IPv6 address.');
  }

  const output = Buffer.alloc(16);
  parts.forEach((part, index) => output.writeUInt16BE(Number.parseInt(part, 16), index * 2));
  return output;
}

function ipToBuffer(value) {
  let ip = String(value || '').trim();
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const family = net.isIP(ip);
  if (family === 4) return ipv4Buffer(ip);
  if (family === 6) return ipv6Buffer(ip);
  throw new TypeError('Invalid IP address.');
}

function maskNetwork(address, prefix) {
  const output = Buffer.from(address);
  const fullBytes = Math.floor(prefix / 8);
  const remainingBits = prefix % 8;
  if (remainingBits && fullBytes < output.length) {
    output[fullBytes] &= (0xff << (8 - remainingBits)) & 0xff;
  }
  for (let index = fullBytes + (remainingBits ? 1 : 0); index < output.length; index += 1) {
    output[index] = 0;
  }
  return output;
}

function cidrValue(address, prefix) {
  const bytes = ipToBuffer(address);
  const bitLength = bytes.length * 8;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bitLength) {
    throw new TypeError('Invalid CIDR prefix.');
  }
  return Buffer.concat([Buffer.from([bytes.length === 4 ? 4 : 6, prefix]), maskNetwork(bytes, prefix)]);
}

function parseCidr(value) {
  const parts = String(value || '').trim().split('/');
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) throw new TypeError('Invalid CIDR.');
  return cidrValue(parts[0], Number(parts[1]));
}

function allCidrValues(ip) {
  const bytes = ipToBuffer(ip);
  const bitLength = bytes.length * 8;
  const values = [];
  for (let prefix = 0; prefix <= bitLength; prefix += 1) {
    values.push(Buffer.concat([
      Buffer.from([bytes.length === 4 ? 4 : 6, prefix]),
      maskNetwork(bytes, prefix)
    ]));
  }
  return values;
}

module.exports = { allCidrValues, ipToBuffer, parseCidr };
