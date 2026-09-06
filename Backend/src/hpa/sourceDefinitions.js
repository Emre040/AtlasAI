'use strict';

// Terms belong to source columns, not to a global vocabulary. Source modalities are
// inferred only from release catalog metadata and explicit column semantics; filenames,
// gene names, row labels and task text never decide a definition's applicability.
const docs = require('./searchDocs');
const HELP = 'https://www.proteinatlas.org/about/help';
const IHC = 'https://www.proteinatlas.org/humanproteome/tissue/method/ih%2Bimaging';
const IF = 'https://www.proteinatlas.org/humanproteome/subcellular/method';
const IHC_LEVELS = {
  'Not detected': 'IHC protein-expression category based on staining intensity and stained-cell fraction. Negative staining or weak staining in less than 25% of cells maps to this category; expert annotation can adjust the score.',
  High: 'IHC expression category: strong staining in at least 25% of cells, subject to expert annotation.',
  Medium: 'IHC expression category: moderate staining in at least 25% of cells, or strong staining in fewer cells, subject to expert annotation.',
  Low: 'IHC expression category: weak staining in at least 25% of cells, or moderate staining in fewer cells, subject to expert annotation.'
};
const IF_RELIABILITY = {
  Enhanced: 'Subcellular IF reliability: enhanced antibody validation with no contradictory localization evidence.',
  Supported: 'Subcellular IF reliability: no enhanced antibody validation, but external literature supports the annotated localization.',
  Approved: 'Subcellular IF reliability: localization partly agrees with external evidence or has not previously been described.',
  Uncertain: 'Subcellular IF reliability: staining conflicts with experimental evidence or RNA expression is not detected.'
};
const IHC_RELIABILITY = {
  Enhanced: 'IHC reliability: at least one antibody has orthogonal or independent-antibody enhanced validation.',
  Supported: 'IHC reliability: staining agrees with applicable RNA/literature evidence or paired-antibody patterns, without meeting enhanced-validation criteria.',
  Approved: 'IHC reliability: partial or conflicting agreement among RNA, literature or paired-antibody evidence.',
  Uncertain: 'IHC reliability: limited antibody specificity or weak/conflicting support from RNA, literature or paired-antibody staining.'
};

const has = (object, key) => Object.hasOwn(object, key);
const known = term => has(docs.OPTIONS, term) || has(IHC_LEVELS, term);
const metadataFields = ['title', 'description', 'resource', 'sourceSection'];
function sourceModalities(entry) {
  const text = metadataFields.map(field => String(entry[field] || '')).join('\n');
  return {
    rna: /\b(?:mRNA|RNA|transcriptomics|transcriptomic)\b/i.test(text),
    ihc: /\bIHC\b|immunohistochem/i.test(text),
    if: /\b(?:IF|ICC)\b|immunofluorescen|subcellular.*locali[sz]ation/i.test(text),
    ms: /\b(?:MS|DVP|proteomics)\b|mass spectrom/i.test(text)
  };
}

function columnContext(entry, column) {
  const modality = sourceModalities(entry);
  const explicitRna = /\b(?:RNA|mRNA|scRNA)\b/i.test(column);
  const explicitIhc = /\bIHC\b|\(IH\)|immunohistochem/i.test(column);
  const explicitIf = /\b(?:IF|ICC)\b|immunofluorescen/i.test(column);
  const only = kind => modality[kind] && Object.entries(modality).every(([key, value]) => key === kind || !value);
  if (/reliability/i.test(column)) {
    if (explicitIhc && !explicitIf) return { scope: 'ihc_reliability' };
    if (explicitIf && !explicitIhc) return { scope: 'if_reliability' };
    if (only('ihc')) return { scope: 'ihc_reliability' };
    if (only('if')) return { scope: 'if_reliability' };
    return null;
  }
  if ((explicitIhc || only('ihc')) && /^(?:Level|Expression level|Protein expression(?: \(IHC\))?|High|Medium|Low|Not detected)$/i.test(column)) return { scope: 'ihc_level' };
  if ((explicitRna || only('rna')) && /specificity|distribution|category|enrichment/i.test(column)) {
    // A threshold stated in nTPM is inapplicable to a differently normalized assay.
    // On a mixed master table, units come only from sibling fields with the same prefix.
    const prefix = column.replace(/\s+(?:specificity(?: score)?|distribution|category|enrichment)$/i, '');
    const units = explicitRna ? (entry.columns || []).filter(name => name.startsWith(`${prefix} `)).join(' ') : [...(entry.columns || []), ...metadataFields.map(field => entry[field] || '')].join(' ');
    return { scope: 'rna_category', ntpm: /\bnTPM\b/.test(units) && !/\b(?:nCPM|pTPM|FPKM|RPKM|TPM)\b/.test(units) };
  }
  if (/secretome|secreted.*location/i.test(column)) return { scope: 'secretome' };
  if (/^(?:Evidence|HPA evidence|UniProt evidence|NeXtProt evidence|Evidence summary)$/.test(column)) return { scope: 'protein_evidence' };
  if (/prognostic/i.test(column)) return { scope: 'prognostic' };
  if (/subcellular|main location|additional location|multilocaliz|single cell variation|^CCD /i.test(column)) return { scope: 'subcellular' };
  return null;
}

function definitionRecord(term, entry, column) {
  if (!entry || !(entry.columns || []).includes(column)) return null;
  const context = columnContext(entry, column);
  if (!context) return null;
  const record = (meaning, sources) => meaning ? { meaning, scope: context.scope, sources } : null;
  if (context.scope === 'ihc_level') return record(has(IHC_LEVELS, term) ? IHC_LEVELS[term] : '', [HELP]);
  if (context.scope === 'if_reliability') return record(has(IF_RELIABILITY, term) ? IF_RELIABILITY[term] : '', [IF]);
  if (context.scope === 'ihc_reliability') return record(has(IHC_RELIABILITY, term) ? IHC_RELIABILITY[term] : '', [IHC, ...docs.SOURCES.filter(source => source.endsWith('/antibodies'))]);
  const meaning = has(docs.OPTIONS, term) ? docs.OPTIONS[term] : '';
  if (!meaning) return null;
  if (context.scope === 'rna_category') {
    if (!/enriched|enhanced|^Low .*specificity$|^Not detected$|^Detected in |^Is highest expressed$|^Tau score$/.test(term)) return null;
    if (/\bnTPM\b/.test(meaning) && !context.ntpm) return null;
    return record(meaning, docs.SOURCES.slice(0, 4));
  }
  if (context.scope === 'secretome' && /^Secretome annotation:/.test(meaning)) return record(meaning, docs.SOURCES);
  if (context.scope === 'protein_evidence' && /^(?:Evidence at |No human protein\/transcript evidence)/.test(term)) return record(meaning, docs.SOURCES);
  if (context.scope === 'prognostic' && /prognostic$/.test(term)) return record(meaning, docs.SOURCES);
  if (context.scope === 'subcellular' && ['Main location', 'Additional location', 'Multilocalizing', 'Single cell variation', 'Cell cycle dependent protein'].includes(term)) return record(meaning, [IF]);
  return null;
}

function sourceDefinitions(entry, rows = [], terms = [], columns = entry.columns) {
  const definitions = {}, unavailable = [], scopes = {}, sources = {};
  const requested = new Set(terms), defined = new Set();
  for (const column of columns) {
    if (!entry.columns.includes(column)) throw new Error(`Definition column ${JSON.stringify(column)} is absent from ${entry.file}`);
    const observed = new Set([column, ...rows.flatMap(row => typeof row[column] === 'string' ? row[column].split(/[,;|]/).map(part => part.trim()) : [])].filter(known));
    for (const term of new Set([...observed, ...requested])) {
      const record = definitionRecord(term, entry, column);
      if (record) {
        if (!has(definitions, column)) definitions[column] = {};
        Object.defineProperty(definitions[column], term, { value: record.meaning, enumerable: true, configurable: true });
        scopes[column] = record.scope;
        sources[record.scope] = record.sources;
        defined.add(term);
      } else if (observed.has(term)) unavailable.push({ column, term, reason: 'No documented definition applies to this source and column; retain the raw term without an inferred threshold or assay meaning.' });
    }
  }
  return {
    definitions,
    ...(Object.keys(definitions).length ? { definition_provenance: { evidence_role: 'General category criteria. A category does not identify which specific validation method was performed for this gene; method-specific claims require separate recorded source evidence.', table: entry.file, ...(entry.sourcePageUrl ? { release_source: entry.sourcePageUrl } : {}), scope_basis: 'Source catalog title/description/resource and exact column semantics; no filename or row-value modality inference.', column_scopes: scopes, documentation: sources } } : {}),
    ...(unavailable.length ? { unavailable_definitions: { sample_term_pairs: unavailable.length, reason: 'No applicable documented source/column scope; raw terms remain unchanged. Request terms with about to inspect a particular column.', ...(unavailable.some(item => requested.has(item.term)) ? { requested: unavailable.filter(item => requested.has(item.term)) } : {}) } } : {}),
    ...(terms.length ? { undefined_terms: [...requested].filter(term => !defined.has(term)) } : {})
  };
}

function definition(term, { entry, column } = {}) { return definitionRecord(term, entry, column)?.meaning || ''; }
module.exports = { sourceDefinitions, definition, definitionRecord, columnContext };
