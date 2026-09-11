'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tempWorkspace } = require('../helpers/deskStudyFixture');
const { DuckStore } = require('../../src/hpa/duckStore');

const A = 'Gene\tGene name\tTissue\tnTPM\nENSG1\tEGFR\tliver\t32.2\nENSG1\tEGFR\tlung\t14.1\nENSG2\tERBB2\tliver\t\nENSG3\tMET\theart\t0.5\n';
const B = 'Tissue\tOrgan\nliver\tLiver & Gallbladder\nlung\tLung\n';
const dataset = (file, at) => ({ localPath: file, unpackedBytes: null, downloadedUnixMs: at });

test('the release database is built from the files, kept in step with them, and answers reads', async t => {
  const root = await tempWorkspace(t);
  await fs.writeFile(path.join(root, 'a.tsv'), A);
  await fs.writeFile(path.join(root, 'b.tsv'), B);
  const store = new DuckStore();
  t.after(() => store.close());
  const log = [];
  const meta = await store.ensure({ root, version: 'test', datasets: [dataset('a.tsv', 1), dataset('b.tsv', 1)], log: m => log.push(m) });
  assert.deepEqual(Object.keys(meta.tables).sort(), ['a.tsv', 'b.tsv']);
  assert.equal(meta.tables['a.tsv'].rows, 4);
  assert.deepEqual(meta.tables['a.tsv'].columns, ['Gene', 'Gene name', 'Tissue', 'nTPM']);
  // The profile is the row profiler's card, from queries over every row.
  const tissue = meta.tables['a.tsv'].profile.find(c => c.column === 'Tissue');
  assert.equal(tissue.kind, 'text');
  assert.deepEqual([...tissue.observed_values].sort(), ['heart', 'liver', 'lung']);
  assert.equal(tissue.distinct, '3');
  const ntpm = meta.tables['a.tsv'].profile.find(c => c.column === 'nTPM');
  assert.equal(ntpm.kind, 'number');
  assert.equal(ntpm.min, 0.5);
  assert.equal(ntpm.max, 32.2);
  assert.equal(ntpm.blank_pct, 25);
  // Reads: by key values, by a narrowing filter, first rows, size.
  const byGene = await store.rowsBy('a.tsv', 'Gene', ['ENSG1', 'ENSG9']);
  assert.deepEqual(byGene.get('ENSG1').map(r => r.Tissue), ['liver', 'lung']);
  assert.deepEqual(byGene.get('ENSG9'), []);
  assert.deepEqual(byGene.get('ENSG1')[0], { Gene: 'ENSG1', 'Gene name': 'EGFR', Tissue: 'liver', nTPM: '32.2' });
  assert.equal((await store.rowsBy('a.tsv', 'Gene', ['ENSG2'])).get('ENSG2')[0].nTPM, '', 'a missing cell is the empty string the file readers give');
  const liver = [];
  for await (const row of store.rows('a.tsv', { where: [{ column: 'Tissue', values: ['Liver'] }] })) liver.push(row['Gene name']);
  assert.deepEqual(liver, ['EGFR', 'ERBB2'], 'case aside, as the row filter matches');
  const half = [];
  for await (const row of store.rows('a.tsv', { where: [{ column: 'nTPM', values: ['0.50'] }] })) half.push(row['Gene name']);
  assert.deepEqual(half, ['MET'], 'the same number, as the row filter matches');
  assert.deepEqual(await store.sample('b.tsv', 1), [{ Tissue: 'liver', Organ: 'Liver & Gallbladder' }]);
  assert.equal(store.rowCount('b.tsv'), 2);
  // The same files are the same build: nothing is built again, and the file is opened read-only.
  const builds = log.filter(m => m.startsWith('building')).length;
  assert.equal(builds, 1);
  const first = meta.file;
  await store.ensure({ root, version: 'test', datasets: [dataset('a.tsv', 1), dataset('b.tsv', 1)], log: m => log.push(m) });
  assert.equal(log.filter(m => m.startsWith('building')).length, 1);
  assert.equal(store.file, first);
  await assert.rejects(store.all('CREATE TABLE x AS SELECT 1'), /read-only/i, 'a server never writes the build it reads');
  // A changed file, or one that left the release, is a new build; the old one is swept away.
  await fs.writeFile(path.join(root, 'a.tsv'), `${A}ENSG4\tALB\tliver\t99\n`);
  const next = await store.ensure({ root, version: 'test', datasets: [dataset('a.tsv', 2)], log: m => log.push(m) });
  assert.equal(log.filter(m => m.startsWith('building')).length, 2);
  assert.notEqual(next.file, first);
  assert.equal(next.tables['a.tsv'].rows, 5);
  assert.equal(next.tables['b.tsv'], undefined);
  assert.equal(store.has('b.tsv'), false);
  assert.throws(() => store.rowCount('b.tsv'), /b\.tsv is not in the release database/);
  const stored = JSON.parse(await fs.readFile(path.join(root, 'hpa-test.duckdb.json'), 'utf8'));
  assert.equal(stored.tables['a.tsv'].rows, 5);
  assert.equal(stored.file, next.file);
  assert.equal(stored.hpa_version, 'test');
  const files = (await fs.readdir(root)).filter(name => name.endsWith('.duckdb')).sort();
  assert.deepEqual(files, [next.file], 'only the current build remains');
});
