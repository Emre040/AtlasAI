'use strict';

// Evaluates a deep-research search plan (include and exclude axes over HPA search fields)
// against the local HPA release, reproducing the proteinatlas.org/search semantics the bulk
// files can answer. Axes the local files cannot answer are reported back so the caller can run
// the same plan online instead of returning a wrong result.

const { hpaSchema } = require('./hpaSchema');
const { localData, FILES } = require('./localData');

const NOT_DETECTED_BELOW = 1; // proteinatlas.org calls anything under 1 nTPM "not detected"
const SET_TTL_MS = 10 * 60 * 1000;

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function asList(value) {
  if (Array.isArray(value)) return value.map(v => String(v ?? '').trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [String(value).trim()];
}

function isAny(values) {
  return values.length === 0 || values.every(v => lower(v) === 'any');
}

function splitList(text) {
  return String(text || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

// "heart muscle: 234.5;skeletal muscle: 20.0" -> Map('heart muscle' -> 234.5, ...)
function specificEntities(text) {
  const map = new Map();
  for (const part of String(text || '').split(';')) {
    const at = part.lastIndexOf(':');
    if (at < 0) continue;
    map.set(lower(part.slice(0, at)), Number(part.slice(at + 1)));
  }
  return map;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function findSchemaField(fieldName) {
  const wanted = lower(fieldName);
  for (const fields of Object.values(hpaSchema)) {
    for (const [name, field] of Object.entries(fields)) {
      if (lower(name) === wanted || lower(field.urlKey) === wanted) return field;
    }
  }
  return null;
}

// Category fields: the master's specificity and distribution columns, the entity list the gene
// is specific to, and the long-format file with a value per gene and entity (when one exists).
const SPECIFICITY_FIELDS = Object.freeze({
  tissue_category_rna: { spec: 'RNA tissue specificity', dist: 'RNA tissue distribution', specific: 'RNA tissue specific nTPM', long: { file: FILES.tissueConsensus, entity: 'Tissue', value: 'nTPM' } },
  brain_category_rna: { spec: 'RNA brain regional specificity', dist: 'RNA brain regional distribution', specific: 'RNA brain regional specific nTPM', long: { file: FILES.brainRegion, entity: 'Brain region', value: 'nTPM' } },
  mouse_brain_category_rna: { spec: 'RNA mouse brain regional specificity', dist: 'RNA mouse brain regional distribution', specific: 'RNA mouse brain regional specific nTPM', long: null },
  pig_brain_category_rna: { spec: 'RNA pig brain regional specificity', dist: 'RNA pig brain regional distribution', specific: 'RNA pig brain regional specific nTPM', long: null },
  cell_type_category_rna: { spec: 'RNA single cell type specificity', dist: 'RNA single cell type distribution', specific: 'RNA single cell type specific nCPM', long: { file: FILES.singleCellType, entity: 'Cell type', value: 'nCPM' } },
  cell_type_group_category_rna: { spec: 'RNA single cell type group specificity', dist: 'RNA single cell type group distribution', specific: 'RNA single cell type group specific nCPM', long: { file: FILES.singleCellTypeGroup, entity: 'Cell type group', value: 'nCPM' } },
  sc_brain_region_category_rna: { spec: 'RNA single nuclei brain specificity', dist: 'RNA single nuclei brain distribution', specific: 'RNA single nuclei brain specific nCPM', long: { file: FILES.singleNucleiBrain, entity: 'Cluster type', value: 'nCPM' } },
  immune_cell_category_rna: { spec: 'RNA blood cell specificity', dist: 'RNA blood cell distribution', specific: 'RNA blood cell specific nTPM', long: { file: FILES.immuneCell, entity: 'Immune cell', value: 'nTPM' } },
  immune_cell_lineage_category_rna: { spec: 'RNA blood lineage specificity', dist: 'RNA blood lineage distribution', specific: 'RNA blood lineage specific nTPM', long: null },
  cancer_category_rna: { spec: 'RNA cancer specificity', dist: 'RNA cancer distribution', specific: 'RNA cancer specific pTPM', long: null },
  celline_category_rna: { spec: 'RNA cell line specificity', dist: 'RNA cell line distribution', specific: 'RNA cell line specific nTPM', long: null }
});

const TAU_FIELDS = Object.freeze({
  tissue_tau_score: 'RNA tissue specificity score',
  brain_tau_score: 'RNA brain regional specificity score',
  mouse_brain_tau_score: 'RNA mouse brain regional specificity score',
  pig_brain_tau_score: 'RNA pig brain regional specificity score',
  cell_type_tau_score: 'RNA single cell type specificity score',
  cell_type_group_tau_score: 'RNA single cell type group specificity score',
  sc_brain_region_tau_score: 'RNA single nuclei brain specificity score',
  immune_cell_tau_score: 'RNA blood cell specificity score',
  immune_cell_lineage_tau_score: 'RNA blood lineage specificity score',
  celline_tau_score: 'RNA cell line specificity score'
});

const CLUSTER_FIELDS = Object.freeze({
  expressionclustertissue: 'Tissue expression cluster',
  expressionclusterbrain: 'Brain expression cluster',
  expressionclusterblood: 'Blood expression cluster',
  expressionclustersinglecell: 'Single cell expression cluster',
  expressionclustercellline: 'Cell line expression cluster'
});

const EQUALITY_FIELDS = Object.freeze({
  sa_location: 'Secretome location',
  ih_tissue_reliability: 'Reliability (IH)',
  if_reliability: 'Reliability (IF)',
  mb_tissue_reliability: 'Reliability (Mouse Brain)',
  evidence_summary: 'Evidence',
  uniprot_evidence: 'UniProt evidence',
  nextprot_evidence: 'NeXtProt evidence',
  hpa_evidence: 'HPA evidence',
  chromosome: 'Chromosome'
});

const RELIABILITY_SEARCHES = new Set(['enhanced', 'supported', 'approved', 'uncertain']);

function tauBin(text) {
  const match = /^(\d(?:\.\d+)?)-(\d(?:\.\d+)?)$/.exec(String(text || '').trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function countBin(text) {
  const trimmed = String(text || '').trim();
  if (/^\d+$/.test(trimmed)) return [Number(trimmed), Number(trimmed)];
  const range = /^(\d+)-(\d+)$/.exec(trimmed);
  if (range) return [Number(range[1]), Number(range[2])];
  const above = /^>(\d+)$/.exec(trimmed);
  if (above) return [Number(above[1]) + 1, Infinity];
  return null;
}

class OfflineSearch {
  constructor(data = localData) {
    this.data = data;
    this.sets = new Map();
  }

  async cachedSet(key, build) {
    const cached = this.sets.get(key);
    if (cached && Date.now() - cached.at < SET_TTL_MS) return cached.set;
    const set = await build();
    this.sets.set(key, { at: Date.now(), set });
    return set;
  }

  // Genes whose value for one of the entities is below / at least the detection threshold, or
  // whose highest value across all entities is one of them, from a long-format file.
  entityGeneSet(long, entities, kind) {
    const key = JSON.stringify(['entity', long.file, kind, [...entities].sort()]);
    return this.cachedSet(key, async () => {
      const wanted = new Set(entities);
      const set = new Set();
      if (kind === 'highest') {
        const best = new Map();
        for await (const row of this.data.rows(long.file)) {
          const value = number(row[long.value]);
          if (value === null) continue;
          const current = best.get(row.Gene);
          if (!current || value > current.value) best.set(row.Gene, { entity: lower(row[long.entity]), value });
        }
        for (const [gene, top] of best) if (wanted.has(top.entity)) set.add(gene);
        return set;
      }
      for await (const row of this.data.rows(long.file, { where: r => wanted.has(lower(r[long.entity])) })) {
        const value = number(row[long.value]);
        if (value === null) continue;
        if (kind === 'below' ? value < NOT_DETECTED_BELOW : value >= NOT_DETECTED_BELOW) set.add(row.Gene);
      }
      return set;
    });
  }

  // Genes annotated by immunohistochemistry in a tissue (and cell type) at any of the levels.
  ihcGeneSet(tissues, cellTypes, levels) {
    const key = JSON.stringify(['ihc', tissues, cellTypes, levels]);
    return this.cachedSet(key, async () => {
      const tissueSet = new Set(tissues);
      const cellSet = new Set(cellTypes);
      const levelSet = new Set(levels);
      const set = new Set();
      for await (const row of this.data.rows(FILES.tissueIhc)) {
        if (tissueSet.size && !tissueSet.has(lower(row.Tissue)) && !tissueSet.has(lower(row['IHC tissue name']))) continue;
        if (cellSet.size && !cellSet.has(lower(row['Cell type']))) continue;
        if (levelSet.size && !levelSet.has(lower(row.Level))) continue;
        set.add(row.Gene);
      }
      return set;
    });
  }

  async subcellularByEnsembl() {
    const table = await this.data.table(FILES.subcellular);
    if (!table.byEnsembl) {
      Object.defineProperty(table, 'byEnsembl', { value: new Map(table.rows.map(row => [row.Gene, row])) });
    }
    return table.byEnsembl;
  }

  // A row predicate for one axis, or null when the local files cannot answer the field.
  async predicate(axis) {
    const field = findSchemaField(axis.field);
    if (!field) return null;
    const key = field.urlKey;
    const classes = asList(axis.class);
    const subclasses = asList(axis.subclass);
    const anyClass = isAny(classes);
    const anySub = isAny(subclasses);
    if (anyClass && anySub) return () => true;

    if (SPECIFICITY_FIELDS[key]) {
      const cfg = SPECIFICITY_FIELDS[key];
      const entities = anyClass ? [] : classes.map(lower);
      const categories = anySub ? [] : subclasses.map(lower);
      const needsValues = entities.length > 0 && categories.some(c => c === 'not detected' || c === 'is highest expressed' || c.startsWith('detected in'));
      if (needsValues && !cfg.long) return null;
      if (needsValues && !(await this.data.available([cfg.long.file]))) return null;
      const notDetected = needsValues && categories.includes('not detected') ? await this.entityGeneSet(cfg.long, entities, 'below') : null;
      const detected = needsValues && categories.some(c => c.startsWith('detected in')) ? await this.entityGeneSet(cfg.long, entities, 'atLeast') : null;
      const highest = needsValues && categories.includes('is highest expressed') ? await this.entityGeneSet(cfg.long, entities, 'highest') : null;
      return row => {
        const spec = lower(row[cfg.spec]);
        const dist = lower(row[cfg.dist]);
        const listed = specificEntities(row[cfg.specific]);
        const entityListed = entities.length === 0 || entities.some(e => listed.has(e));
        if (categories.length === 0) return entityListed && listed.size > 0;
        return categories.some(category => {
          if (/enriched|enhanced/.test(category)) return spec === category && entityListed;
          if (category.startsWith('low ')) return spec === category;
          if (category === 'not detected in immune cells') return spec === category;
          if (category === 'not detected') {
            return entities.length === 0 ? (spec === 'not detected' || dist === 'not detected') : notDetected.has(row.Ensembl);
          }
          if (category.startsWith('detected in')) {
            return dist === category && (entities.length === 0 || detected.has(row.Ensembl));
          }
          if (category === 'is highest expressed') return entities.length > 0 && highest.has(row.Ensembl);
          return spec === category || dist === category;
        });
      };
    }

    if (TAU_FIELDS[key]) {
      const bins = classes.map(tauBin);
      if (bins.some(b => b === null)) return null;
      const column = TAU_FIELDS[key];
      return row => {
        const value = number(row[column]);
        return value !== null && bins.some(([low, high]) => value >= low && (value < high || (high >= 1 && value <= 1)));
      };
    }

    if (CLUSTER_FIELDS[key]) {
      const column = CLUSTER_FIELDS[key];
      const wanted = classes.map(lower);
      return row => {
        const value = lower(row[column]);
        return wanted.some(w => value === w || value.endsWith(`: ${w}`) || value.includes(w));
      };
    }

    if (EQUALITY_FIELDS[key]) {
      const column = EQUALITY_FIELDS[key];
      const wanted = classes.map(lower);
      return row => wanted.includes(lower(row[column]));
    }

    switch (key) {
      case 'gene_name': {
        const wanted = classes.map(lower);
        return row => wanted.includes(lower(row.Gene)) || splitList(row['Gene synonym']).some(s => wanted.includes(lower(s)));
      }
      case 'external_id': {
        const wanted = classes.map(lower);
        return row => wanted.includes(lower(row.Ensembl)) || splitList(row.Uniprot).some(id => wanted.includes(lower(id)));
      }
      case 'protein_class':
      case 'predicted_location': {
        const wantedClasses = anyClass ? [] : classes.map(lower);
        const wantedSub = anySub ? [] : subclasses.map(lower);
        return row => {
          const listed = splitList(row['Protein class']).map(lower);
          return (wantedClasses.length === 0 || wantedClasses.some(c => listed.includes(c)))
            && (wantedSub.length === 0 || wantedSub.some(s => listed.includes(s)));
        };
      }
      case 'with_antibodies': {
        const yes = classes.some(c => lower(c) === 'yes');
        return row => (String(row.Antibody || '').trim().length > 0) === yes;
      }
      case 'normal_expression': {
        if (!(await this.data.available([FILES.tissueIhc]))) return null;
        const levels = asList(axis.levels ?? axis.expression);
        const set = await this.ihcGeneSet(
          anyClass ? [] : classes.map(lower),
          anySub ? [] : subclasses.map(lower),
          isAny(levels) ? [] : levels.map(lower)
        );
        return row => set.has(row.Ensembl);
      }
      case 'ce_enriched': {
        const tissues = anyClass ? [] : classes.map(lower);
        const cellTypes = anySub ? [] : subclasses.map(lower);
        return row => splitList(row['RNA tissue cell type enrichment']).some(pair => {
          const [tissue, cell] = pair.split(' - ').map(lower);
          return (tissues.length === 0 || tissues.includes(tissue)) && (cellTypes.length === 0 || (cell && cellTypes.includes(cell)));
        });
      }
      case 'subcell_location': {
        const locations = anyClass ? [] : classes.map(lower);
        const searches = anySub ? [] : subclasses.map(lower);
        if (searches.some(s => s.startsWith('ccd protein '))) return null;
        const needsAnnotation = searches.some(s => RELIABILITY_SEARCHES.has(s) || s === 'single cell variation');
        if (needsAnnotation && !(await this.data.available([FILES.subcellular]))) return null;
        const annotations = needsAnnotation ? await this.subcellularByEnsembl() : null;
        const hasLocation = list => locations.length === 0 || locations.some(l => list.includes(l));
        return row => {
          const all = splitList(row['Subcellular location']).map(lower);
          const main = splitList(row['Subcellular main location']).map(lower);
          const additional = splitList(row['Subcellular additional location']).map(lower);
          if (searches.length === 0) return all.length > 0 && hasLocation(all);
          return searches.some(search => {
            if (search === 'main location') return main.length > 0 && hasLocation(main);
            if (search === 'additional location') return additional.length > 0 && hasLocation(additional);
            if (search === 'multilocalizing') return all.length > 1 && hasLocation(all);
            const localizing = /^localizing (\d)$/.exec(search);
            if (localizing) return all.length === Number(localizing[1]) && hasLocation(all);
            if (search === 'cell cycle dependent protein') return lower(row['CCD Protein']) === 'yes' && hasLocation(all);
            if (search === 'cell cycle independent protein') return lower(row['CCD Protein']) === 'no' && hasLocation(all);
            if (search === 'cell cycle dependent transcript') return lower(row['CCD Transcript']) === 'yes' && hasLocation(all);
            if (search === 'cell cycle independent transcript') return lower(row['CCD Transcript']) === 'no' && hasLocation(all);
            const annotation = annotations.get(row.Ensembl);
            if (!annotation) return false;
            if (search === 'single cell variation') {
              const varied = splitList(`${annotation['Single-cell variation intensity']};${annotation['Single-cell variation spatial']}`).map(lower);
              return varied.length > 0 && hasLocation(varied);
            }
            const rated = splitList(annotation[search.charAt(0).toUpperCase() + search.slice(1)]).map(lower);
            return rated.length > 0 && hasLocation(rated);
          });
        };
      }
      case 'prognostic': {
        const master = await this.data.master();
        const cancers = anyClass ? [] : classes.map(lower);
        const prognoses = anySub ? [] : subclasses.map(lower);
        const columns = master.header.filter(c => c.startsWith('Cancer prognostics - '));
        const wantedColumns = cancers.length === 0
          ? columns
          : columns.filter(c => cancers.some(cancer => lower(c).includes(`- ${cancer} (`)));
        if (wantedColumns.length === 0) return null;
        // Cell values read "potential prognostic favorable (p)", "validated prognostic unfavorable (p)"
        // or "unprognostic (p)"; the search option "Favorable - validated prognostic" names the
        // same pair the other way round.
        const wantedValues = prognoses.map(p => {
          const [direction, strength] = p.split(' - ').map(s => s.trim());
          return strength ? `${strength} ${direction}` : direction;
        });
        return row => wantedColumns.some(column => {
          const value = lower(row[column]);
          if (!value || value.startsWith('unprognostic')) return false;
          return wantedValues.length === 0 || wantedValues.some(w => value.startsWith(w));
        });
      }
      case 'num_interactions': {
        if (!anyClass && !classes.every(c => lower(c) === 'consensus')) return null;
        if (anySub) return null;
        const bins = subclasses.map(countBin);
        if (bins.some(b => b === null)) return null;
        return row => {
          const count = number(row.Interactions) ?? 0;
          return bins.some(([low, high]) => count >= low && count <= high);
        };
      }
      default:
        return null;
    }
  }

  // Returns { rows, unsupported }: rows mirror the online JSON result (only meaningful when
  // unsupported is empty); unsupported lists the axes the local release cannot evaluate.
  async evaluate(includeAxes = [], excludeAxes = []) {
    const master = await this.data.master();
    const unsupported = [];
    const includes = [];
    const excludes = [];
    for (const axis of includeAxes) {
      const test = await this.predicate(axis);
      if (test) includes.push(test);
      else unsupported.push({ field: axis.field, class: axis.class, subclass: axis.subclass ?? null, operator: 'AND' });
    }
    for (const axis of excludeAxes) {
      const test = await this.predicate(axis);
      if (test) excludes.push(test);
      else unsupported.push({ field: axis.field, class: axis.class, subclass: axis.subclass ?? null, operator: 'NOT' });
    }
    if (unsupported.length > 0) return { rows: [], unsupported };
    const rows = master.rows.filter(row => includes.every(test => test(row)) && !excludes.some(test => test(row)));
    return { rows, unsupported };
  }
}

const offlineSearch = new OfflineSearch();

module.exports = { OfflineSearch, offlineSearch, specificEntities };
