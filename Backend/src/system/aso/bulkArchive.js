'use strict';

// Validate the complete handoff before writing or exposing any selected result.
function prepareBulkArchive(result) {
  const selected = result.tables || [], retained = result.retained_tables || [], raw = result.raw_sources || [];
  const nodes = [], results = new Map(), sources = new Map();
  for (const [tables, primary] of [[selected, true], [retained, false]]) for (const table of tables) {
    if (typeof table.name !== 'string' || !table.name || results.has(table.name)) throw new Error('Bulk archive requires unique saved result names');
    const node = { table, selected: primary, kind: 'result', parents: [] }; nodes.push(node); results.set(table.name, node);
  }
  for (const table of raw) {
    if (typeof table.source_file !== 'string' || !table.source_file || sources.has(table.source_file)) throw new Error('Bulk archive requires one raw table per exact source file');
    const node = { table, selected: false, kind: 'raw_source', parents: [] }; nodes.push(node); sources.set(table.source_file, node);
  }
  for (const node of nodes) {
    const table = node.table;
    if (!Array.isArray(table.rows) || !Array.isArray(table.columns) || new Set(table.columns).size !== table.columns.length) throw new Error('Bulk archive requires exact table rows and a distinct column schema');
    if (table.record_rows !== undefined && (!Array.isArray(table.record_rows) || table.record_rows.length !== table.rows.length || table.record_rows.some(value => typeof value !== 'boolean'))) throw new Error('Bulk archive has invalid source row coverage');
    const parents = new Set([...(table.operations || []).flatMap(operation => Object.values(operation.inputs || {})), ...(table.reductions || []).flatMap(reduction => [reduction.from, reduction.source_result].filter(value => value !== undefined))]);
    for (const name of parents) {
      if (!results.has(name)) throw new Error(`Bulk archive is missing predecessor result ${name}`);
      node.parents.push(results.get(name));
    }
    for (const lookup of table.provenance || []) if (sources.has(lookup.table)) node.parents.push(sources.get(lookup.table));
    node.parents = [...new Set(node.parents)];
  }
  const ordered = [], visiting = new Set(), visited = new Set();
  function visit(node) {
    if (visiting.has(node)) throw new Error('Bulk archive result ancestry contains a cycle');
    if (visited.has(node)) return;
    visiting.add(node); node.parents.forEach(visit); visiting.delete(node); visited.add(node); ordered.push(node);
  }
  nodes.forEach(visit);
  return { nodes, ordered };
}

module.exports = { prepareBulkArchive };
