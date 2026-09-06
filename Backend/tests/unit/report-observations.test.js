'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { renderReport, OBSERVATIONS_SCHEMA, INTERPRETATIONS_SCHEMA } = require(process.env.ATLASAI_REPORT_MODULE || path.resolve(__dirname, '../../src/system/aso/studyReport'));
const backend = process.env.ATLASAI_BACKEND_ROOT || path.resolve(__dirname, '../..');
const { validate } = require(path.join(backend, 'src/system/aso/batchOperations'));
const { verificationIssues } = require(path.join(backend, 'src/system/aso/summaryEvidence'));
function fixture() {
  const a1 = { id: 'a1', kind: 'data', label: 'Source records', columns: ['identity', 'location', 'measurement', 'category'], rows: [
    { identity: 'ALPHA', location: 'north', measurement: 0, category: '' },
    { identity: 'BETA', location: 'south', measurement: null, category: 'Uncertain' },
    { identity: 'ALPHA', location: 'west', measurement: 375000000, category: 'Observed' }
  ] };
  const a2 = { id: 'a2', kind: 'data', label: 'Computed comparison', columns: ['identity','coefficient'], rows: [{ identity: 'ALPHA', coefficient: 0.5714 }] };
  return { goal: 'Compare the source evidence.', artifacts: [a1,a2], byId: new Map([['a1',a1],['a2',a2]]) };
}
test('observations bind exact identities, dimensions, values and categories from selected saved rows', () => {
  const state=fixture(), before=JSON.stringify(state.artifacts);
  const output=renderReport({ observations:[{ artifact:'a1',row_indices:[2,0,1],columns:['identity','location','measurement','category'] }] },state);
  assert.match(output,/ALPHA \| west \| 375000000 \| Observed/);
  assert.match(output,/ALPHA \| north \| 0 \|  /);
  assert.match(output,/BETA \| south \| — \| Uncertain/);
  assert.ok(output.indexOf('west')<output.indexOf('north'));
  assert.equal(JSON.stringify(state.artifacts),before);
  assert.deepEqual(verificationIssues(output,state),[]);
});
test('observations cannot override a saved value or fabricate an identity, unit or sentence', () => {
  for(const extra of [{value:9},{identity:'BETA'},{unit:'other units'},{text:'an unsupported conclusion'}]) assert.throws(()=>renderReport({observations:[{artifact:'a1',row_indices:[0],columns:['measurement'],...extra}]},fixture()),/values come from the saved records/);
});
test('bad artifact, row and column references fail with precise paths', () => {
  for(const row_indices of [[],[-1],[3],[0.5],['0'],[NaN]]) assert.throws(()=>renderReport({observations:[{artifact:'a1',row_indices,columns:['identity']}]},fixture()),/observations\[0\].row_indices/);
  for(const columns of [[],['invented']]) assert.throws(()=>renderReport({observations:[{artifact:'a1',row_indices:[0],columns}]},fixture()),/observations\[0\].columns/);
  assert.throws(()=>renderReport({observations:[{artifact:'unknown',row_indices:[0],columns:['identity']}]},fixture()),/observations\[0\].artifact/);
});
test('repeated identities and repeated row references are preserved without first-match guessing', () => {
  const output=renderReport({observations:[{artifact:'a1',row_indices:[2,0,2],columns:['identity','location']}]},fixture());
  assert.equal((output.match(/ALPHA \| west/g)||[]).length,2);
  assert.equal((output.match(/ALPHA \| north/g)||[]).length,1);
});
test('interpretation qualifications remain visible and every paragraph receives evidence references', () => {
  const output=renderReport({interpretations:[
    {kind:'inference',text:'The result motivates a comparison.',artifacts:['a2']},
    {kind:'hypothesis',text:'A mechanism could explain the difference.\n\nThis has not been tested.',artifacts:['a1','a2','a1']},
    {kind:'limitation',text:'These records do not identify the cause.',artifacts:['a1']}
  ]},fixture());
  assert.match(output,/\*\*Interpretation:\*\*/); assert.match(output,/\*\*Untested hypothesis:\*\*/); assert.match(output,/\*\*Evidence limitation:\*\*/);
  assert.match(output,/tested\. \(a1, a2\)\./); assert.equal((output.match(/\(a1, a2\)/g)||[]).length,2); assert.equal((output.match(/\*\*Untested hypothesis:\*\*/g)||[]).length,2);
});
test('unknown interpretation kinds and missing evidence are explicit errors', () => {
  for(const entry of [{kind:'fact',text:'claim',artifacts:['a1']},{kind:'inference',text:' ',artifacts:['a1']},{kind:'hypothesis',text:'claim',artifacts:[]},{kind:'limitation',text:'claim',artifacts:['unknown']}]) assert.throws(()=>renderReport({interpretations:[entry]},fixture()),/interpretations\[0\]/);
});
test('reference validation does not pretend to establish the meaning of unrestricted interpretation', () => {
  const output=renderReport({interpretations:[{kind:'inference',text:'A valid citation can still accompany a scientifically wrong claim.',artifacts:['a1']}]},fixture());
  assert.match(output,/scientifically wrong claim/); // The external semantic rubric must still assess this text.
});
test('existing summary and exact-table report format remains available unchanged', () => {
  const output=renderReport({summary:'Existing source limitation (a1).',tables:[{artifact:'a1',columns:['identity','measurement'],rows:1}]},fixture());
  assert.equal(output,'Existing source limitation (a1).\n\nSource records (a1):\n\n| identity | measurement |\n| --- | --- |\n| ALPHA | 0 |\n\nShowing 1 of 3 rows; the full result is saved in a1.');
});
test('native schema rejects model-authored observation fields and accepts structured discussion', () => {
  validate([{artifact:'a1',row_indices:[0],columns:['identity']}],OBSERVATIONS_SCHEMA,'observations');
  validate([{kind:'hypothesis',text:'A possible explanation.',artifacts:['a1']}],INTERPRETATIONS_SCHEMA,'interpretations');
  assert.throws(()=>validate([{artifact:'a1',row_indices:[0],columns:['identity'],value:9}],OBSERVATIONS_SCHEMA,'observations'),/value/);
});
