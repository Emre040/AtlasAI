'use strict';

// Loads a module with some of its requires replaced, so the study loop and the Investigator can
// run against a scripted model and an in-memory database.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const BACKEND = path.resolve(__dirname, '../..');

async function loadWithStubs(relative, stubs) {
  const filename = require.resolve(path.join(BACKEND, relative));
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : realRequire(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  return loaded.exports;
}

let callId = 0;
const call = (name, args) => ({ id: `test_${++callId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (...tool_calls) => ({ choices: [{ message: { role: 'assistant', tool_calls } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });

// A small database: one per-gene table, one reference table, three genes.
const GENES = [{ gene: 'EGFR', ensembl: 'ENSG1' }, { gene: 'ERBB2', ensembl: 'ENSG2' }, { gene: 'MET', ensembl: 'ENSG3' }];
const CONSENSUS = { file: 'rna_tissue_consensus.tsv', key: 'ensembl', title: 'Consensus tissue RNA', description: 'Consensus nTPM per tissue', columns: ['Gene', 'Gene name', 'Tissue', 'nTPM'], hpaVersion: 'test' };
const TISSUES = { file: 'tissues.tsv', key: 'lookup', title: 'Tissue lookup', description: 'Tissue to organ', columns: ['Tissue', 'Organ'], hpaVersion: 'test' };
const ROWS = {
  ENSG1: [{ Gene: 'ENSG1', 'Gene name': 'EGFR', Tissue: 'liver', nTPM: '32.2' }, { Gene: 'ENSG1', 'Gene name': 'EGFR', Tissue: 'lung', nTPM: '14.1' }, { Gene: 'ENSG1', 'Gene name': 'EGFR', Tissue: 'heart', nTPM: '0.0' }],
  ENSG2: [{ Gene: 'ENSG2', 'Gene name': 'ERBB2', Tissue: 'liver', nTPM: '30.7' }, { Gene: 'ENSG2', 'Gene name': 'ERBB2', Tissue: 'lung', nTPM: '34.1' }],
  ENSG3: [{ Gene: 'ENSG3', 'Gene name': 'MET', Tissue: 'liver', nTPM: '' }]
};
function fakeAdapter(overrides = {}) {
  return {
    identity: () => ({ database: 'Test Atlas', entity: 'gene', keys: ['gene', 'ensembl'], key_description: 'symbol and id' }),
    access: e => e.key === 'lookup' ? 'reference table' : 'rows per gene',
    async *rows(e) { if (e === CONSENSUS) { for (const g of GENES) for (const r of ROWS[g.ensembl]) yield r; } else { yield { Tissue: 'liver', Organ: 'Liver & Gallbladder' }; yield { Tissue: 'lung', Organ: 'Lung' }; } },
    keysOf(e, row) { return { gene: row['Gene name'] || null, ensembl: row.Gene || null }; },
    async entities() { return GENES; },
    async catalog() { return [CONSENSUS, TISSUES]; },
    async entry(name) { return [CONSENSUS, TISSUES].find(e => e.file === name || e.file === `${name}.tsv`) || null; },
    async resolveGenes(names) { return names.map(n => GENES.find(g => g.gene === n.toUpperCase() || g.ensembl === n) || null); },
    async resolveGene(n) { return GENES.find(g => g.gene === n.toUpperCase() || g.ensembl === n) || null; },
    async readMany(genes, file) { const byGene = new Map(); for (const g of genes) byGene.set(g.ensembl, file === CONSENSUS.file ? ROWS[g.ensembl] || [] : []); return { entry: CONSENSUS, byGene }; },
    async read(gene, file) { return { entry: CONSENSUS, rows: file === CONSENSUS.file ? ROWS[gene.ensembl] || [] : [] }; },
    async profile(e) { return { rows: 6, capped: false, columns: e.columns.map(c => c === 'nTPM' ? { column: c, kind: 'number', blank_pct: 17, distinct: '5', min: 0, max: 34.1, examples: [] } : { column: c, kind: 'text', blank_pct: 0, distinct: '3', observed_values: c === 'Tissue' ? ['liver', 'lung', 'heart'] : null, full_examples: c === 'Gene' ? ['ENSG1', 'ENSG2'] : ['x'], examples: c === 'Gene' ? ['ENSG1', 'ENSG2'] : ['x'] }) }; },
    async sample(e) { return e === CONSENSUS ? ROWS.ENSG1.slice(0, 2) : [{ Tissue: 'liver', Organ: 'Liver & Gallbladder' }]; },
    async holds(e, column, values) { const wanted = new Set(values.map(v => String(v).trim().toLowerCase())); let n = 0; for await (const row of this.rows(e)) if (wanted.has(String(row[column] ?? '').trim().toLowerCase())) n++; return n; },
    async textHits(e, column, word, limit = 4) { const needle = String(word).toLowerCase(); let rows = 0; const values = new Set(); for await (const row of this.rows(e)) { const cell = String(row[column] ?? ''); if (cell.toLowerCase().includes(needle)) { rows++; if (values.size < limit) values.add(cell); } } return { rows, values: [...values] }; },
    isEntityId(value) { return /^ENSG/.test(String(value || '')); },
    definition: () => null,
    ...overrides
  };
}

async function tempWorkspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-study-'));
  await fs.mkdir(path.join(directory, 'artifacts'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

module.exports = { loadWithStubs, call, response, fakeAdapter, tempWorkspace, CONSENSUS, TISSUES, ROWS, GENES };

