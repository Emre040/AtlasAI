'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dictionaryFixture, dictionaryResponse } = require('../helpers/dictionaryFixture');

for (const [label, responseContent, status] of [['successful topic', '["liver"]', 'ok'], ['no matching category', '[]', 'not_found']]) {
  test(`dictionary ${label} exposes exact canonical and existing token accounting`, async () => {
    const f = await dictionaryFixture({ responses: [dictionaryResponse(responseContent, 17, 3)] });
    const result = await f.run({ topic: 'supplied topic' });
    assert.equal(result.status, status); assert.equal(f.requests.length, 1);
    assert.deepEqual(result.tokens, { prompt: 17, completion: 3, total: 20 });
    assert.deepEqual(result.tokenUsage.total, { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 });
  });
}

test('multi-topic dictionary results aggregate actual model calls once', async () => {
  const f = await dictionaryFixture({ responses: [dictionaryResponse('["liver"]', 17, 3), dictionaryResponse('["kidney"]', 31, 5)] });
  const result = await f.run({ topics: ['topic one', 'topic two'] });
  assert.equal(result.status, 'ok'); assert.equal(result.categories.length, 2); assert.equal(f.requests.length, 2);
  assert.deepEqual(result.tokens, { prompt: 48, completion: 8, total: 56 });
  assert.equal(result.tokenUsage.steps.length, 2);
});

test('dictionary source failure retains consumed inference accounting', async () => {
  const f = await dictionaryFixture({ responses: [dictionaryResponse('["liver"]', 17, 3)], scrapeError: true });
  const result = await f.run({ topic: 'topic' });
  assert.equal(result.status, 'error'); assert.equal(result.error, 'source unavailable');
  assert.deepEqual(result.tokens, { prompt: 17, completion: 3, total: 20 });
});

test('a question about the atlas goes to the reader, whose tokens come back in the canonical shape', async () => {
  const f = await dictionaryFixture({ responses: [] });
  const result = await f.run({ question: 'About the source' });
  assert.equal(result.status, 'ok'); assert.equal(result.mode, 'reader'); assert.equal(f.requests.length, 0);
  assert.deepEqual(result.tokens, { prompt: 23, completion: 7, total: 30 });
  assert.equal(result.tokenUsage.total.total_tokens, 30);
});

test('dictionary input validation reports zero actual inference usage', async () => {
  const f = await dictionaryFixture({ responses: [] });
  const result = await f.run({});
  assert.equal(result.status, 'error'); assert.equal(f.requests.length, 0);
  assert.deepEqual(result.tokens, { prompt: 0, completion: 0, total: 0 });
});

test('dictionary does not manufacture valid canonical counts from inconsistent provider totals', async () => {
  const invalid = dictionaryResponse('[]', 17, 3); invalid.usage.total_tokens = 99;
  const f = await dictionaryFixture({ responses: [invalid] });
  await assert.rejects(() => f.run({ topic: 'topic' }), /token total does not match/);
});
