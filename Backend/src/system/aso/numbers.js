'use strict';

// Numbers stated in text: standalone numeric tokens (32.2, 1,234, 1.6E11, −4), never digits
// glued to letters (BRCA1, TP53, Q1). Shared by the report binder and the label guard.
const NUMBER = /(?<![\w.])[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+−]?\d+)?(?![\w])/g;

// Each number with the tolerance its written precision implies: 32.2 binds within 0.05.
function statedNumbers(text) {
  const out = [];
  for (const match of String(text || '').matchAll(NUMBER)) {
    const clean = match[0].replace(/,/g, '').replaceAll('−', '-');
    const value = Number(clean);
    if (!Number.isFinite(value)) continue;
    const mantissa = clean.split(/[eE]/)[0];
    const exponent = /[eE]/.test(clean) ? Number(clean.split(/[eE]/)[1]) : 0;
    const decimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
    out.push({ raw: match[0], value, tolerance: 0.5 * 10 ** (exponent - decimals) });
  }
  return out;
}

module.exports = { NUMBER, statedNumbers };
