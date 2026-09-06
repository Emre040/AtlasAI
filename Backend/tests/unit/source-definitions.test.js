'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { sourceDefinitions, definition } = require('../../src/hpa/sourceDefinitions');
const adapter = require('../../src/hpa/geneDataAdapter');
const backend = process.env.ATLASAI_BACKEND_ROOT || path.resolve(__dirname, '../..');
const ihc = { file: 'unfamiliar_assay.tsv', key: 'ensembl', title: 'Normal tissue IHC protein expression', description: 'Protein expression profiles in human tissues from IHC tissue microarrays, including expression level and reliability.', hpaVersion: 'fixture-release', sourcePageUrl: 'https://www.proteinatlas.org/about/download', columns: ['Gene', 'Tissue', 'Level', 'Reliability'] };
const raw = [{ Gene: 'ENSG00000000111', Tissue: 'High', Level: 'Not detected', Reliability: 'Enhanced' }];
const rna = { file: 'not_a_special_filename.tsv', key: 'ensembl', title: 'RNA expression', description: 'RNA classification from nTPM measurements.', columns: ['Gene', 'Category', 'nTPM', 'Quality'] };
const call = (name, args, id) => ({ choices: [{ message: { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 0, completion_tokens: 0 } });
async function isolated(relative, stubs) {
  const filename = require.resolve(path.join(backend, relative));
  const loaded = new Module(filename, module);loaded.filename = filename;loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = request => Object.hasOwn(stubs, request) ? stubs[request] : original(request);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);return loaded.exports;
}

test('IHC definitions use authoritative assay meaning and retain exact column/source provenance', () => {
  const result = sourceDefinitions(ihc, raw);
  assert.match(result.definitions.Level['Not detected'], /weak staining.*25%/);
  assert.doesNotMatch(result.definitions.Level['Not detected'], /nTPM|mRNA/);
  assert.match(result.definitions.Reliability.Enhanced, /IHC reliability/);
  assert.equal(result.definitions.Tissue, undefined, 'A tissue named High is not an IHC expression category');
  assert.equal(result.unavailable_definitions.sample_term_pairs, 1);
  assert.match(result.definition_provenance.evidence_role, /General category criteria/);
  assert.match(result.definition_provenance.evidence_role, /separate recorded source evidence/);
  assert.equal(result.definition_provenance.column_scopes.Level, 'ihc_level');
  assert.ok(result.definition_provenance.documentation.ihc_level.includes('https://www.proteinatlas.org/about/help'));
});

test('filename and row values never assign a modality', () => {
  const renamed = sourceDefinitions({ ...ihc, file: 'rna_tissue_consensus.tsv' }, raw);
  assert.match(renamed.definitions.Level['Not detected'], /IHC/);
  const metadataAbsent = sourceDefinitions({ file: 'normal_ihc_data.tsv', columns: ihc.columns }, raw, ['Not detected']);
  assert.deepEqual(metadataAbsent.definitions, {});assert.deepEqual(metadataAbsent.undefined_terms, ['Not detected']);
  assert.equal(definition('Not detected'), '', 'Unscoped global lookup must not claim a default assay');
});

test('RNA category threshold remains available only with matching units and cannot leak into Quality', () => {
  const result = sourceDefinitions(rna, [{ Gene: 'ENSG1', Category: 'Not detected', nTPM: '0', Quality: 'Approved' }]);
  assert.match(result.definitions.Category['Not detected'], /1 nTPM/);
  assert.equal(result.definitions.Quality, undefined);
  for (const unit of ['nCPM', 'pTPM', 'FPKM']) {
    const source = { ...rna, description: `RNA categories using ${unit}.`, columns: ['Gene', 'Category', unit] };
    const projected = sourceDefinitions(source, [{ Category: 'Not detected' }], ['Not detected']);
    assert.deepEqual(projected.definitions, {});assert.deepEqual(projected.undefined_terms, ['Not detected']);
  }
});

test('MS, DVP, unknown and mixed-assay Level columns do not borrow RNA or IHC definitions', () => {
  for (const metadata of [
    { title: 'Mass spectrometry protein abundance', description: 'MS intensity data' },
    { title: 'DVP protein data', description: 'Proteomics measurements' },
    { title: 'Combined IHC and RNA evidence', description: 'Different assays in one table' },
    { title: 'New source', description: '' }
  ]) {
    const result = sourceDefinitions({ ...ihc, ...metadata }, raw, ['Not detected', 'High', 'Approved']);
    assert.deepEqual(result.definitions, {});
    assert.ok(result.unavailable_definitions.requested.some(item => item.column === 'Level' && item.term === 'Not detected'));
  }
});

test('a mixed master table resolves identical labels independently for explicit source columns', () => {
  const entry = { file: 'mixed_master.tsv', title: 'Mixed source annotations', columns: ['RNA tissue distribution', 'RNA tissue specific nTPM', 'Protein tissue distribution', 'Reliability (IH)', 'Reliability (IF)'] };
  const result = sourceDefinitions(entry, [{ 'RNA tissue distribution': 'Not detected', 'Protein tissue distribution': 'Not detected', 'Reliability (IH)': 'Approved', 'Reliability (IF)': 'Approved' }]);
  assert.match(result.definitions['RNA tissue distribution']['Not detected'], /1 nTPM/);
  assert.equal(result.definitions['Protein tissue distribution'], undefined);
  assert.notEqual(result.definitions['Reliability (IH)'].Approved, result.definitions['Reliability (IF)'].Approved);
  assert.match(result.definitions['Reliability (IF)'].Approved, /Subcellular IF/);
  assert.equal(result.definitions['Not detected'], undefined, 'No ambiguous flat label definition exists');
});

test('selected-column projection bounds meanings; requested unknown/prototype terms stay explicit', () => {
  const result = sourceDefinitions(ihc, raw, ['Not detected', 'not documented', 'constructor', '__proto__'], ['Level']);
  assert.deepEqual(Object.keys(result.definitions), ['Level']);
  assert.deepEqual(result.undefined_terms, ['not documented', 'constructor', '__proto__']);
  assert.equal(result.definitions.Reliability, undefined);
});

test('single Investigator source render exposes scoped definitions while keeping exact citation rows', () => {
  const reading = { entry: ihc, rows: raw };
  const rendered = adapter.render(reading, [], { columns: ['Level'] });
  assert.match(rendered.text, /IHC protein-expression category/);assert.doesNotMatch(rendered.text, /1 nTPM/);
  assert.deepEqual(reading.shownRows, raw);assert.deepEqual(reading.shownColumns, ['Level']);
  assert.equal(adapter.cited(reading, 'Not detected', 'Not detected'), true);
});

test('single Investigator overview no longer presents unscoped global categories', async () => {
  const local = require('../../src/hpa/localData');
  const isolatedAdapter = await isolated('src/hpa/geneDataAdapter.js', { './localData': { ...local, localData: { async refreshRegistry() { return new Map(); } } } });
  const overview = await isolatedAdapter.overview();
  assert.doesNotMatch(overview, /mRNA below|1 nTPM|^High:/m);assert.match(overview, /definitions accompany source reads/);
});

test('wide-source unknown meanings produce a count, with details only for explicitly requested terms', () => {
  const columns = Array.from({ length: 600 }, (_, i) => `Quality ${i}`);
  const entry = { file: 'new_annotations.tsv', title: 'Unknown assay metadata', columns };
  const row = Object.fromEntries(columns.map(column => [column, 'Supported']));
  const result = sourceDefinitions(entry, [row]);
  assert.deepEqual(result.definitions, {});
  assert.equal(result.unavailable_definitions.sample_term_pairs, 600);
  assert.deepEqual(Object.keys(result.unavailable_definitions), ['sample_term_pairs', 'reason']);
  assert.doesNotMatch(JSON.stringify(result), /Quality 599/);
  const requested = sourceDefinitions(entry, [row], ['Supported'], ['Quality 599']);
  assert.deepEqual(requested.undefined_terms, ['Supported']);
  assert.equal(requested.unavailable_definitions.requested[0].column, 'Quality 599');
});

