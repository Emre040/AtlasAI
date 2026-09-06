'use strict';

// Access to the HPA bulk files of the active release on local disk. The registry mirrors
// hpa_datasets for platform_config.active_hpa_version (refreshed in the background); tables are
// parsed from TSV on first use and cached in memory keyed by file identity.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { HpaDatasetRepository } = require('../database/repositories/hpaDatasets');
const { platformConfig } = require('../policy/config');

const REGISTRY_REFRESH_MS = 60_000;
const NEWLINE = 0x0a;
const TAB = 0x09;

// Decode HPA's quoted cells, including embedded tabs and escaped quote characters.
function parseCells(line) {
  const text = line.replace(/\r$/, '');
  if (!text.includes('"')) return text.split('\t');
  const cells = []; let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && (quoted || cell === '')) {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === '\t' && !quoted) { cells.push(cell); cell = ''; }
    else cell += c;
  }
  if (quoted) throw new Error('Unterminated quoted TSV cell');
  cells.push(cell);
  return cells;
}

function parseHeader(line) {
  return parseCells(line.replace(/^﻿/, ''));
}

function parseLine(header, line) {
  const cells = parseCells(line);
  const row = {};
  for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] === undefined ? '' : cells[i];
  return row;
}

// Datasets the offline agents rely on, by role. File names come from hpa_datasets.file_name
// with the compression suffix removed (the sync script extracts them under those names).
const FILES = Object.freeze({
  master: 'proteinatlas.tsv',
  xml: 'proteinatlas.xml',
  tissueConsensus: 'rna_tissue_consensus.tsv',
  tissueIhc: 'normal_ihc_data.tsv',
  brainRegion: 'rna_brain_region_hpa.tsv',
  singleCellType: 'rna_single_cell_type.tsv',
  singleCellTypeGroup: 'rna_single_cell_type_group.tsv',
  singleNucleiBrain: 'rna_single_nuclei_cluster_type.tsv',
  immuneCell: 'rna_immune_cell.tsv',
  cellLine: 'rna_celline.tsv',
  subcellular: 'subcellular_location.tsv',
  interactions: 'interaction_consensus.tsv',
  cancerPrognostics: 'cancer_prognostic_data.tsv'
});

class LocalData {
  constructor() {
    this.root = null;
    this.db = null;
    this.datasets = null;
    this.registry = new Map();
    this.registryLoadedAt = 0;
    this.refreshing = null;
    this.tables = new Map();
    this.indexes = new Map();
    this.indexLoads = new Map();
    this.classificationTables = new Map();
    this.classificationLoads = new Map();
    this.unreachable = new Set();
  }

  configure({ root, db }) {
    this.root = root;
    this.db = db;
    this.datasets = new HpaDatasetRepository(db);
  }

  get configured() {
    return this.root !== null && this.datasets !== null;
  }

  async refreshRegistry(force = false) {
    if (!this.configured) return this.registry;
    if (!force && Date.now() - this.registryLoadedAt < REGISTRY_REFRESH_MS) return this.registry;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const version = platformConfig().activeHpaVersion;
      const ready = await this.datasets.listReady(version);
      const next = new Map();
      // A row is only usable when its file is actually reachable from this process (the data
      // directory is shared between releases through a link); an offline request fails if needed data is missing.
      for (const dataset of ready) {
        try {
          await fsp.access(this.filePath(dataset.localPath));
          next.set(dataset.localPath, dataset);
          this.unreachable.delete(dataset.localPath);
        } catch {
          if (!this.unreachable.has(dataset.localPath)) {
            this.unreachable.add(dataset.localPath);
            console.error('[HPA_LOCAL_DATA_UNREACHABLE]', this.filePath(dataset.localPath));
          }
        }
      }
      this.registry = next;
      this.registryLoadedAt = Date.now();
      return next;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  // True when offline agents are enabled and every named file is ready for the active release.
  async available(fileNames) {
    if (!this.configured || !platformConfig().offlineAgentsEnabled) return false;
    const registry = await this.refreshRegistry();
    return fileNames.every(name => registry.has(name));
  }

  async missing(fileNames) {
    if (!this.configured) return [...fileNames];
    const registry = await this.refreshRegistry();
    return fileNames.filter(name => !registry.has(name));
  }

  async describe(fileName) {
    const registry = await this.refreshRegistry();
    return registry.get(fileName) || null;
  }

  filePath(fileName) {
    return path.join(this.root, fileName);
  }

  // Streams a TSV row by row as objects keyed by header. `where` filters rows before they are
  // materialized so large files are never fully held in memory.
  async *rows(fileName, { where = null, onHeader = null } = {}) {
    const dataset = await this.describe(fileName);
    if (!dataset) throw new Error(`HPA dataset '${fileName}' is not available offline.`);
    const stream = fs.createReadStream(this.filePath(fileName), { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let header = null;
    for await (const line of lines) {
      if (header === null) {
        header = parseHeader(line);
        onHeader?.(header);
        continue;
      }
      if (line.length === 0) continue;
      const row = parseLine(header, line);
      if (where && !where(row)) continue;
      yield row;
    }
  }

  // Build byte ranges directly from the raw file. A gene can occupy multiple disjoint blocks;
  // importing a release never requires sorting, rewriting, or precomputing its measurements.
  async geneIndex(fileName) {
    const dataset = await this.describe(fileName);
    if (!dataset) throw new Error(`HPA dataset '${fileName}' is not available offline.`);
    const filePath = this.filePath(fileName);
    const stat = await fsp.stat(filePath);
    const identity = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    const cached = this.indexes.get(fileName);
    if (cached && cached.identity === identity) return cached.index;
    if (this.indexLoads.has(identity)) return this.indexLoads.get(identity);
    const pending = this.buildGeneIndex(fileName, filePath, stat, identity);
    this.indexLoads.set(identity, pending);
    try { return await pending; }
    finally { this.indexLoads.delete(identity); }
  }

  async buildGeneIndex(fileName, filePath, stat, identity) {
    const ranges = new Map();
    let header = null;
    let current = null;
    let currentStart = 0;
    let offset = 0;
    let leftover = Buffer.alloc(0);
    const closeRange = end => {
      if (current === null) return;
      if (!ranges.has(current)) ranges.set(current, []);
      ranges.get(current).push({ start: currentStart, end });
    };
    const visitLine = (buffer, start, end, absolute) => {
      if (end > start && buffer[end - 1] === 0x0d) end--;
      if (header === null) { header = parseHeader(buffer.toString('utf8', start, end)); return; }
      if (end <= start) return;
      const nextTab = buffer.indexOf(TAB, start);
      const tab = nextTab === -1 || nextTab > end ? end : nextTab;
      const key = buffer[start] === 34 ? parseCells(buffer.toString('utf8', start, end))[0] : buffer.toString('utf8', start, tab);
      if (key !== current) { closeRange(absolute); current = key; currentStart = absolute; }
    };
    const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
    for await (const chunk of stream) {
      const buffer = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      let lineStart = 0;
      for (let i = buffer.indexOf(NEWLINE); i !== -1; i = buffer.indexOf(NEWLINE, lineStart)) {
        visitLine(buffer, lineStart, i, offset + lineStart);
        lineStart = i + 1;
      }
      leftover = buffer.subarray(lineStart);
      offset += lineStart;
    }
    if (leftover.length) visitLine(leftover, 0, leftover.length, offset);
    closeRange(stat.size);
    const index = Object.freeze({ header: header || [], ranges });
    this.indexes.set(fileName, { identity, index });
    return index;
  }

  async geneRows(fileName, ensembl) {
    const index = await this.geneIndex(fileName);
    const ranges = index.ranges.get(ensembl);
    if (!ranges) return Object.defineProperty([], 'columns', { value: index.header, configurable: true });
    const handle = await fsp.open(this.filePath(fileName), 'r');
    try {
      const rows = [];
      for (const range of ranges) {
        const buffer = Buffer.alloc(range.end - range.start);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, range.start + offset);
          if (!bytesRead) throw new Error(`HPA dataset '${fileName}' changed while reading its indexed rows`);
          offset += bytesRead;
        }
        for (const line of buffer.toString('utf8').split('\n')) if (line.replace(/\r$/, '').length) rows.push(parseLine(index.header, line));
      }
      return Object.defineProperty(rows, 'columns', { value: index.header, configurable: true });
    } finally {
      await handle.close();
    }
  }

  // Whole table, parsed once per file identity (size and mtime) and kept in memory.
  async table(fileName) {
    const dataset = await this.describe(fileName);
    if (!dataset) throw new Error(`HPA dataset '${fileName}' is not available offline.`);
    const stat = await fsp.stat(this.filePath(fileName));
    const identity = `${this.filePath(fileName)}:${stat.size}:${stat.mtimeMs}`;
    const cached = this.tables.get(fileName);
    if (cached && cached.identity === identity) return cached.table;
    const rows = [];
    let header = null;
    for await (const row of this.rows(fileName, { onHeader: value => { header = value; } })) {
      rows.push(row);
    }
    Object.defineProperty(rows, 'columns', { value: header || [], configurable: true });
    // Left extensible so callers can attach lazily built indexes (see master()).
    const table = { fileName, header: header || [], rows, dataset };
    this.tables.set(fileName, { identity, table });
    return table;
  }

  // The master gene table with indexes by Ensembl id and upper-cased gene name / synonym.
  async master() {
    const table = await this.table(FILES.master);
    if (!table.byEnsembl) {
      const byEnsembl = new Map();
      const byName = new Map();
      for (const row of table.rows) {
        byEnsembl.set(row.Ensembl, row);
        const name = (row.Gene || '').toUpperCase();
        if (name && !byName.has(name)) byName.set(name, row);
      }
      for (const row of table.rows) {
        for (const synonym of (row['Gene synonym'] || '').split(',')) {
          const key = synonym.trim().toUpperCase();
          if (key && !byName.has(key)) byName.set(key, row);
        }
      }
      Object.defineProperty(table, 'byEnsembl', { value: byEnsembl });
      Object.defineProperty(table, 'byName', { value: byName });
    }
    return table;
  }

  // Hierarchical classifications are exported in XML, beyond the TSV's broad classes.
  // Cache decoded metadata by raw-file identity and active release, just like TSV tables.
  async proteinClasses() {
    const fileName = FILES.xml;
    const dataset = await this.describe(fileName);
    if (!dataset) throw new Error(`HPA dataset '${fileName}' is not available offline.`);
    const filePath = this.filePath(fileName);
    const stat = await fsp.stat(filePath);
    const identity = `${dataset.hpaVersion}:${filePath}:${stat.size}:${stat.mtimeMs}`;
    const cached = this.classificationTables.get(fileName);
    if (cached?.identity === identity) return cached.table;
    if (this.classificationLoads.has(identity)) return this.classificationLoads.get(identity);
    const pending = (async () => {
      const { readProteinClasses } = require('./proteinClasses');
      const table = { ...await readProteinClasses(filePath), fileName, dataset };
      const after = await fsp.stat(filePath);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error(`HPA dataset '${fileName}' changed while reading its classifications`);
      this.classificationTables.set(fileName, { identity, table });
      return table;
    })();
    this.classificationLoads.set(identity, pending);
    try { return await pending; }
    finally { this.classificationLoads.delete(identity); }
  }

  // Resolves a symbol, synonym, or Ensembl id to the master row, like the online search does.
  async resolveGene(query) {
    return (await this.resolveGenes([query]))[0];
  }

  // Resolve a supplied list against one master-table snapshot, preserving input order.
  async resolveGenes(queries) {
    const master = await this.master();
    return queries.map(query => {
      const key = String(query || '').trim().toUpperCase();
      if (!key) return null;
      const row = master.byEnsembl.get(key) || master.byName.get(key);
      return row ? { gene: row.Gene, ensembl: row.Ensembl, row } : null;
    });
  }
}

const localData = new LocalData();

module.exports = { localData, LocalData, FILES, parseHeader, parseLine, parseCells };
