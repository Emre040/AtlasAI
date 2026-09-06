'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReport } = require('../../src/system/aso/studyReport');

test('a zero-row preview does not claim that a populated source has no matching rows', () => {
  const artifact = { id:'a1',kind:'data',label:'Observed values',rows:[{gene:'ZERO',value:0},{gene:'MISSING',value:null}],columns:['gene','value'] };
  const state = {byId:new Map([['a1',artifact]])};
  const preview = renderReport({tables:[{artifact:'a1',columns:['gene','value'],rows:0}]},state);
  assert.match(preview,/No rows shown \(a1\)/);
  assert.doesNotMatch(preview,/No matching rows/);
  assert.match(preview,/Showing 0 of 2 rows; the full result is saved in a1/);
  assert.equal(artifact.rows.length,2,'preview must not mutate source rows');
  const emptyState = {byId:new Map([['a1',{...artifact,rows:[]}]])};
  assert.match(renderReport({tables:[{artifact:'a1',columns:['gene','value'],rows:0}]},emptyState),/No matching rows \(a1\)/);
});
