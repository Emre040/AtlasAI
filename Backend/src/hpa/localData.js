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

// HPA quotes cells that contain separators; a bare cell is returned as is.
function unquote(cell) {
  if (cell.length >= 2 && cell.charCodeAt(0) === 34 && cell.charCodeAt(cell.length - 1) === 34) {
    return cell.slice(1, -1).replace(/""/g, '"');
  }
  return cell;
}

function parseHeader(line) {
  return line.replace(/^﻿/, '').split('\t').map(unquote);
}

function parseLine(header, line) {
  const cells = line.split('\t');
  const row = {};
  for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] === undefined ? '' : unquote(cells[i]);
  return row;
}

// Datasets the offline agents rely on, by role. File names come from hpa_datasets.file_name
// with the compression suffix removed (the sync script extracts them under those names).
const FILES = Object.freeze({
  master: 'proteinatlas.tsv',
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
      // directory is shared between releases through a link); otherwise the agents stay online.
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
  async *rows(fileName, { where = null } = {}) {
    const dataset = await this.describe(fileName);
    if (!dataset) throw new Error(`HPA dataset '${fileName}' is not available offline.`);
    const stream = fs.createReadStream(this.filePath(fileName), { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let header = null;
    for await (const line of lines) {
      if (header === null) {
        header = parseHeader(line);
        continue;
      }
      if (line.length === 0) continue;
      const row = parseLine(header, line);
      if (where && !where(row)) continue;
      yield row;
    }
  }

  // Long-format files (one row per gene and entity) are sorted by gene, so a byte-range index
  // built in one pass lets a single gene's rows be read without scanning the file again.
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
    const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
    for await (const chunk of stream) {
      const buffer = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      let lineStart = 0;
      for (let i = buffer.indexOf(NEWLINE); i !== -1; i = buffer.indexOf(NEWLINE, lineStart)) {
        const absolute = offset + lineStart;
        if (header === null) {
          header = parseHeader(buffer.toString('utf8', lineStart, i));
        } else if (i > lineStart) {
          const nextTab = buffer.indexOf(TAB, lineStart);
          const tab = nextTab === -1 || nextTab > i ? i : nextTab;
          const key = buffer.toString('ascii', lineStart, tab);
          if (key !== current) {
            if (current !== null) ranges.set(current, { start: currentStart, end: absolute });
            current = key;
            currentStart = absolute;
          }
        }
        lineStart = i + 1;
      }
      leftover = buffer.subarray(lineStart);
      offset += lineStart;
    }
    if (current !== null) ranges.set(current, { start: currentStart, end: stat.size });
    const index = Object.freeze({ header: header || [], ranges });
    this.indexes.set(fileName, { identity, index });
    return index;
  }

  async geneRows(fileName, ensembl) {
    const index = await this.geneIndex(fileName);
    const range = index.ranges.get(ensembl);
    if (!range) return [];
    const handle = await fsp.open(this.filePath(fileName), 'r');
    try {
      const buffer = Buffer.alloc(range.end - range.start);
      await handle.read(buffer, 0, buffer.length, range.start);
      return buffer.toString('utf8').split('\n').filter(line => line.length > 0).map(line => parseLine(index.header, line));
    } finally {
      await handle.close();
    }
  }

  // Whole table, parsed once per file identity (size and mtime) and kept in memory.
  async table(fileName) {
    const dataset = await this.describe(fileName);
    if (!dataset) throw new Error(`HPA dataset '${fileName}' is not available offline.`);
    const stat = await fsp.stat(this.filePath(fileName));
    const identity = `${fileName}:${stat.size}:${stat.mtimeMs}`;
    const cached = this.tables.get(fileName);
    if (cached && cached.identity === identity) return cached.table;
    const rows = [];
    let header = null;
    for await (const row of this.rows(fileName)) {
      if (header === null) header = Object.keys(row);
      rows.push(row);
    }
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

module.exports = { localData, LocalData, FILES };
