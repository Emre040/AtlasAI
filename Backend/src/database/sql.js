'use strict';

function sqlLimit(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`SQL row limit must be an integer between 1 and ${maximum}.`);
  }
  return String(value);
}

module.exports = { sqlLimit };
