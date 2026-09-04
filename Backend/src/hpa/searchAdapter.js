'use strict';

/**
 * The Human Protein Atlas search, presented as a generic filter schema for the trail agent.
 *
 * The agent never sees atlas-specific code: it gets fields with levels and options, the atlas's
 * own definitions (searchDocs.js), a way to canonicalise what it chose, a composer that turns
 * choices into the search URL, and an executor. Any other database with a filter grammar can
 * be plugged in by implementing the same five functions.
 */

const https = require('node:https');
const { hpaSchema } = require('./hpaSchema.js');
const { detailedSearchOptions } = require('./searchOptions.js');
const docs = require('./searchDocs.js');
const { offlineSearch } = require('./offlineSearch');
const { resolveAgentMode } = require('./agentMode');
const { FILES } = require('./localData');

const SEARCH_BASE = 'https://www.proteinatlas.org/search/';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36';

// Free-text, identifier and presentation fields are not filters a question maps to.
const NOT_FILTERS = new Set(['Gene name', 'External id', 'Uniprot keyword', 'Patient ID (IHC)', 'Multiplex tissue (IHC)', 'Sort by', 'Has data',
  'Subcellular location - cell line (ICC)', 'Protein sequence variants', 'Protein interaction', 'Metabolic pathway', 'Structure ipTM']);

function lower(s) { return String(s || '').toLowerCase().trim(); }
function asList(v) { return Array.isArray(v) ? v : v == null ? [] : [v]; }
function notAny(list) { return (list || []).filter(o => lower(o) !== 'any'); }
function encode(v) { return encodeURIComponent(v).replace(/%20/g, '+'); }

// ---- schema -----------------------------------------------------------------------------------

let FIELD_INDEX = null;
function fields() {
  if (FIELD_INDEX) return FIELD_INDEX;
  const out = [];
  for (const [category, byField] of Object.entries(hpaSchema)) {
    for (const [name, spec] of Object.entries(byField || {})) {
      if (NOT_FILTERS.has(name) || !spec?.urlKey || !Array.isArray(spec.levels) || !spec.levels.length) continue;
      const nested = detailedSearchOptions[category]?.[name];
      const level0 = nested ? notAny(Object.keys(nested)) : notAny(spec.levels[0].options);
      if (!level0.length) continue;
      out.push({ name, category, urlKey: spec.urlKey, levels: spec.levels.map(l => ({ label: l.label, multiSelect: l.multiSelect === true })), nested: nested || null, level0, schema: spec, doc: docs.FIELDS[name] || '' });
    }
  }
  FIELD_INDEX = out;
  return out;
}

function field(name) { return fields().find(f => lower(f.name) === lower(name)) || null; }

// Options one level below a partial path (level 0 → the classes; level 1 given a class; …).
function optionsAt(f, path) {
  if (!path.length) return f.level0;
  let node = f.nested;
  if (!node) {
    const level = f.schema.levels[path.length];
    return level ? notAny(level.options) : [];
  }
  for (const value of path) {
    const key = Object.keys(node).find(k => lower(k) === lower(asList(value)[0]));
    if (!key) return [];
    node = node[key];
    if (Array.isArray(node)) return path.indexOf(value) === path.length - 1 ? notAny(node) : [];
    if (!node || typeof node !== 'object') return [];
  }
  return notAny(Object.keys(node));
}

function definition(option) { return docs.OPTIONS[option] || ''; }

// Text for the plan step: every field with its levels and option counts.
function overview() {
  const lines = [`Database: Human Protein Atlas search. A query is a set of filters joined by AND, each optionally negated (NOT). A filter is one field with a value chosen at each of its levels; a level left unset means "any".`,
    `Definitions the atlas gives for its categories are listed with the options when a field is filled in.`, ''];
  let category = null;
  for (const f of fields()) {
    if (f.category !== category) { category = f.category; lines.push(`[${category}]`); }
    const levels = f.levels.map((l, i) => `${i + 1}: ${l.label}${l.multiSelect ? ' (several allowed)' : ''}`).join(', ');
    lines.push(`- "${f.name}": ${f.doc || ''} Levels ${levels}. ${f.level0.length} options at level 1${f.level0.length <= 12 ? ': ' + f.level0.join(', ') : ''}.`);
  }
  return lines.join('\n');
}

// Text for the trail step: the full option tree of one field, with definitions.
function fieldTree(f) {
  const lines = [`Field "${f.name}"${f.doc ? ': ' + f.doc : ''}`];
  f.levels.forEach((l, i) => lines.push(`Level ${i + 1} "${l.label}": ${l.multiSelect ? 'several values allowed' : 'one value'}`));
  const withDefs = list => list.map(o => definition(o) ? `${o} = ${definition(o)}` : o);
  lines.push('', `Level 1 options: ${f.level0.join(' | ')}`);
  if (f.levels.length > 1) {
    const perClass = f.level0.map(c => [c, optionsAt(f, [c])]);
    const distinct = new Set(perClass.map(([, subs]) => JSON.stringify(subs)));
    if (distinct.size === 1) {
      const subs = perClass[0][1];
      if (subs.length) lines.push('', `Level 2 options, the same for every level 1 value:`, ...withDefs(subs).map(s => `  ${s}`));
    } else {
      lines.push('', 'Level 2 options depend on the level 1 value:');
      for (const [c, subs] of perClass) if (subs.length) lines.push(`  ${c} → ${subs.join(' | ')}`);
      const defs = [...new Set(perClass.flatMap(([, subs]) => subs))].filter(definition);
      if (defs.length) lines.push('', 'Definitions:', ...defs.map(o => `  ${o} = ${definition(o)}`));
    }
  }
  if (f.levels.length > 2) {
    const sample = f.level0.find(c => optionsAt(f, [c]).length);
    const sub = sample ? optionsAt(f, [sample])[0] : null;
    const third = sample && sub ? optionsAt(f, [sample, sub]) : [];
    if (third.length) lines.push('', `Level 3 options (same everywhere): ${withDefs(third).join(' | ')}`);
  }
  return lines.join('\n');
}

// Canonical spelling of a chosen path, or an error naming what does not exist.
function canonicalize(fieldName, choices) {
  const f = field(fieldName);
  if (!f) return { error: `no field named "${fieldName}"` };
  const path = [];
  for (let level = 0; level < f.levels.length; level++) {
    const wanted = asList(choices[level]).map(String).map(s => s.trim()).filter(s => s && lower(s) !== 'any');
    if (!wanted.length) { path.push(null); continue; }
    // With no level 1 value chosen, a lower level is only meaningful when its options are the
    // same for every level 1 value ("Detected in all" across all cell types).
    let options;
    if (path.length && path[path.length - 1] === null && f.nested) {
      const perClass = f.level0.map(c => JSON.stringify(optionsAt(f, [c])));
      if (new Set(perClass).size !== 1) return { error: `level ${level + 1} of "${f.name}" needs a level ${level} value first` };
      options = optionsAt(f, [f.level0[0]]);
    } else options = optionsAt(f, path.filter(Boolean).map(p => asList(p)[0]));
    const spelled = notAny(f.schema.levels[level]?.options || []);
    const exact = [];
    for (const w of wanted) {
      const hit = options.find(o => lower(o) === lower(w));
      if (!hit) return { error: `"${w}" is not an option at level ${level + 1} of "${f.name}"` };
      const pretty = spelled.find(o => lower(o) === lower(hit)) || hit;
      if (!exact.includes(pretty)) exact.push(pretty);
    }
    if (exact.length > 1 && !f.levels[level].multiSelect) return { error: `level ${level + 1} of "${f.name}" takes one value, got ${exact.length}` };
    path.push(exact.length === 1 ? exact[0] : exact);
  }
  while (path.length && path[path.length - 1] === null) path.pop();
  if (!path.length) return { error: `no value chosen for "${f.name}"` };
  return { field: f.name, urlKey: f.urlKey, path };
}

// ---- query --------------------------------------------------------------------------------------

function segment(filter) {
  const parts = filter.path.map(p => p === null ? null : asList(p).map(encode).join(','));
  // A leading unset level is dropped, as the atlas does ("tissue_category_rna:Detected in all").
  const kept = parts.filter(p => p !== null);
  return `${filter.urlKey}:${kept.join(';')}`;
}

function compose(filters) {
  const include = filters.filter(f => f.operator !== 'NOT').map(segment);
  const exclude = filters.filter(f => f.operator === 'NOT').map(segment);
  if (!include.length && !exclude.length) return null;
  let url = SEARCH_BASE + include.join('+AND+');
  if (exclude.length) url += (include.length ? '+NOT+' : 'NOT+') + exclude.join('+NOT+');
  return url;
}

function describe(filters) {
  return filters.map(f => `${f.operator === 'NOT' ? 'NOT ' : ''}${f.field}: ${f.path.map(p => p === null ? 'any' : asList(p).join(', ')).join(' / ')}`).join(' AND ');
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} from the atlas`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('The atlas returned no JSON')); } });
    }).on('error', reject);
  });
}

function toAxis(filter) {
  const [cls, sub, levels] = filter.path;
  return { field: filter.field, class: cls ?? 'Any', subclass: sub ?? 'Any', levels: levels ?? undefined, operator: filter.operator };
}

// Runs the query: on the local release when it can evaluate every filter, else on the atlas.
async function execute(filters, url, requestedMode) {
  const include = filters.filter(f => f.operator !== 'NOT').map(toAxis);
  const exclude = filters.filter(f => f.operator === 'NOT').map(toAxis);
  const agentMode = await resolveAgentMode(requestedMode, [FILES.master]);
  if (agentMode.mode === 'offline') {
    const local = await offlineSearch.evaluate(include, exclude);
    if (!local.unsupported.length) return { rows: local.rows, mode: 'offline', version: agentMode.hpaVersion };
  }
  const rows = await httpGetJson(`${url}?format=json&download=yes`);
  return { rows: Array.isArray(rows) ? rows : [], mode: 'online', version: null };
}

function summarize(rows) {
  const names = rows.map(r => r.Gene || r.gene || r.Ensembl).filter(Boolean);
  return { count: rows.length, top: names.slice(0, 10) };
}

module.exports = { name: 'Human Protein Atlas search', fields, field, overview, fieldTree, canonicalize, compose, describe, execute, summarize, httpGetJson, sources: docs.SOURCES };
