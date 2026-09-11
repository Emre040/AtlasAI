'use strict';

// Numbers stated in text: standalone numeric tokens (32.2, 1,234, 1.6E11, −4), never digits
// glued to letters (BRCA1, TP53, Q1). Shared by the report binder and the label guard.
const NUMBER = /(?<![\w.])[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+−]?\d+)?(?![\w])/g;

// Each number with the tolerance its written precision implies: 32.2 binds within 0.05. A number
// written as a percent (70%, 70 percent) is also the fraction 0.70: a cell that holds the fraction
// binds it, within the same written precision.
function statedNumbers(text) {
  const out = [];
  // Every dash a model may write for a minus (hyphens, en and em dashes, the minus sign) is one,
  // and a power of ten written as 5.3 × 10⁻⁷ or 5.3 x 10^-7 is the number 5.3e-7.
  const superscript = ch => '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(ch);
  const source = String(text || '').replace(/[‐-―−]/g, '-')
    .replace(/(\d(?:\.\d+)?)\s*[×x·*]\s*10\s*([⁻⁺]?)([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (m, mantissa, sign, digits) => `${mantissa}e${sign === '⁻' ? '-' : ''}${[...digits].map(superscript).join('')}`)
    .replace(/(\d(?:\.\d+)?)\s*[×x·*]\s*10\s*(?:\^|\*\*)\s*([-+]?\d+)/g, (m, mantissa, exponent) => `${mantissa}e${exponent}`);
  for (const match of source.matchAll(NUMBER)) {
    const clean = match[0].replace(/,/g, '').replaceAll('−', '-');
    const value = Number(clean);
    if (!Number.isFinite(value)) continue;
    const mantissa = clean.split(/[eE]/)[0];
    const exponent = /[eE]/.test(clean) ? Number(clean.split(/[eE]/)[1]) : 0;
    const decimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
    const percent = /^\s*(%|percent\b|per cent\b)/i.test(source.slice(match.index + match[0].length));
    out.push({ raw: match[0], value, tolerance: 0.5 * 10 ** (exponent - decimals), percent });
  }
  return out;
}

module.exports = { NUMBER, statedNumbers };
