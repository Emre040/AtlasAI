'use strict';

// Native JSON scalar values stay typed through every tool transport.
const SCALAR_SCHEMA = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] };

module.exports = { SCALAR_SCHEMA };
