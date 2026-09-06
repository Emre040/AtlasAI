'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CapabilityCatalog, LOAD_TOOLS } = require('../../src/system/aso/capabilityCatalog');

const spec = (name, description) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: { artifact: { type: 'string' }, exact_parameter: { type: 'array', items: { type: 'integer' } } }, required: ['artifact'], additionalProperties: false } } });

test('every registered capability is discoverable and loads its original exact native schema', () => {
  const tools = [spec('investigate', 'Read source evidence.'), spec('novel_operation', 'Compare supplied measurements. Requires exact columns.'), spec('another_operation', 'Operate on a saved table')];
  const catalog = new CapabilityCatalog({ tools, coreNames: ['investigate'] });
  assert.deepEqual(catalog.offered(), [tools[0], LOAD_TOOLS]);
  assert.equal(catalog.directory(), 'novel_operation: Compare supplied measurements.\nanother_operation: Operate on a saved table');
  const initialBytes = JSON.stringify(catalog.offered()).length;
  const loaded = catalog.load(['another_operation', 'novel_operation']);
  assert.deepEqual(loaded.loaded, ['another_operation', 'novel_operation']);
  assert.deepEqual(catalog.offered(), [...tools, LOAD_TOOLS]);
  assert.strictEqual(catalog.offered()[1], tools[1]);
  assert.ok(JSON.stringify(catalog.offered()).length > initialBytes);
  assert.deepEqual(catalog.load(['novel_operation', 'novel_operation']).loaded, []);
  assert.deepEqual(catalog.offered(), [...tools, LOAD_TOOLS]);
});

test('invalid discovery requests leave the capability state unchanged', () => {
  const catalog = new CapabilityCatalog({ tools: [spec('core', 'Core.'), spec('known', 'Known.')], coreNames: ['core'] });
  const before = catalog.offered();
  assert.throws(() => catalog.load(['known', 'invented']), /Unknown tools: invented/);
  assert.deepEqual(catalog.offered(), before);
  assert.throws(() => catalog.load('known'), /must be an array/);
  assert.throws(() => catalog.load([null]), /must be an array/);
  assert.throws(() => new CapabilityCatalog({ tools: [spec('one', 'A.'), spec('one', 'B.')] }), /duplicate capability/);
  assert.throws(() => new CapabilityCatalog({ tools: [LOAD_TOOLS] }), /duplicate capability/);
  assert.throws(() => new CapabilityCatalog({ tools: [spec('one', 'A.')], coreNames: ['missing'] }), /Unknown tools/);
});
