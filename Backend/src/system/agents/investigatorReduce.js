'use strict';

const { aggregate, join, select, columnsOf, withColumns, isMissing, AGGREGATE_METRICS } = require('../aso/studyTools');
const { decodeArguments } = require('../aso/toolArguments');
const { validate } = require('../aso/batchOperations');

const S = { type: 'string' };
const REDUCE_RESULT = { type: 'function', function: {
  name: 'reduce_result',
  description: 'Reduce a saved rows-mode result through ordered grouped stages without rereading sources. Every stage retains gene/ensembl identity and is saved by name. count counts eligible input rows at that stage, numeric_count counts numeric values; counts from earlier stages must be propagated explicitly with sum. Raw source coverage stays separate. Missing grouping identifiers remain visible unknown groups, not verified independent samples. Raw and intermediate tables remain available to open_result and finish.',
  parameters: { type: 'object', properties: {
    from: { type: 'string', description: 'Existing apply_bulk rows-mode result or a previous reduce_result stage.' },
    stages: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string', description: 'Unique saved name for this stage output.' },
      group_by_columns: { type: 'array', items: S, description: 'Exact additional grouping columns. gene and ensembl always partition the result; an empty list gives one group per supplied identity.' },
      measures: { type: 'array', items: { type: 'object', properties: {
        column: { type: 'string', description: 'Exact predecessor column to summarize; may be omitted only for count.' },
        metrics: { type: 'array', items: { type: 'string', enum: AGGREGATE_METRICS } },
        as: { type: 'object', additionalProperties: S, description: 'Optional exact metric-to-output-column map. Use unique aliases when multiple measures would collide.' }
      }, required: ['metrics'] } }
    }, required: ['name', 'group_by_columns', 'measures'] } }
  }, required: ['from', 'stages'] }
} };

const IDS = ['gene', 'ensembl'];
const COUNT_METRICS = new Set(['count', 'numeric_count', 'zero', 'missing', 'distinct']);
const tuple = (row, columns) => JSON.stringify(columns.map(column => row[column] === undefined ? null : row[column]));

function exactColumn(columns, name, kind) {
  if (!columns.includes(name)) throw new Error(`reduce_result: unknown ${kind} column ${JSON.stringify(name)}; inspect the predecessor result schema`);
  return name;
}

function eligible(table) {
  if (!Array.isArray(table.record_rows) || table.record_rows.length !== table.rows.length || table.record_rows.some(value => typeof value !== 'boolean')) throw new Error('reduce_result requires a rows-mode source result or a reduction with authoritative record_rows metadata');
  return withColumns(table.rows.filter((row, index) => table.record_rows[index]), table.columns);
}

function reduceStage(input, stage, release) {
  const columns = input.columns;
  IDS.forEach(name => exactColumn(columns, name, 'identity'));
  if (new Set(stage.group_by_columns).size !== stage.group_by_columns.length) throw new Error('reduce_result grouping columns must be distinct');
  const groups = [...new Set([...IDS, ...stage.group_by_columns.map(name => exactColumn(columns, name, 'grouping'))])];
  if (!stage.measures.length) throw new Error('reduce_result needs at least one measure');
  const source = eligible(input);
  for (const row of source) for (const key of groups) {
    const value = row[key];
    if (value !== null && value !== undefined && (typeof value === 'object' || typeof value === 'number' && !Number.isFinite(value))) throw new Error(`reduce_result grouping column ${JSON.stringify(key)} must contain finite scalar values`);
  }
  const aliases = new Set(groups), measures = [];
  const previousOutputs = new Map((input.reductions?.at(-1)?.outputs || []).map(output => [output.column, output]));
  for (const measure of stage.measures) {
    if (!measure.metrics.length || new Set(measure.metrics).size !== measure.metrics.length) throw new Error('reduce_result metrics must be a nonempty distinct selection');
    if (measure.column !== undefined) exactColumn(columns, measure.column, 'measurement');
    if (measure.column === undefined && measure.metrics.some(metric => metric !== 'count')) throw new Error('reduce_result requires column for every metric except count');
    for (const key of Object.keys(measure.as || {})) if (!measure.metrics.includes(key)) throw new Error(`reduce_result alias ${JSON.stringify(key)} is not a requested metric`);
    const names = measure.metrics.map(metric => Object.hasOwn(measure.as || {}, metric) ? measure.as[metric] : metric);
    for (const name of names) {
      if (aliases.has(name)) throw new Error(`reduce_result output column ${JSON.stringify(name)} collides; supply explicit unique aliases`);
      aliases.add(name);
    }
    const outputs = measure.metrics.map((metric, i) => ({ column: names[i], metric, input_column: measure.column === undefined ? null : measure.column,
      quantity: COUNT_METRICS.has(metric) || metric === 'sum' && previousOutputs.get(measure.column)?.quantity === 'count' ? 'count' : 'measurement' }));
    measures.push({ ...measure, names, outputs });
  }
  let key = '__reduction_group';
  while (aliases.has(key) || columns.includes(key)) key += '_';
  const occupied = new Set([...columns, ...aliases, ...AGGREGATE_METRICS]), groupNames = new Map();
  for (const name of groups) {
    let internal = name;
    if (AGGREGATE_METRICS.includes(name)) {
      internal = '__reduction_label';
      while (occupied.has(internal)) internal += '_';
      occupied.add(internal);
    }
    groupNames.set(name, internal);
  }
  const groupRename = Object.fromEntries([...groupNames].filter(([name, internal]) => name !== internal));
  const groupedSource = Object.keys(groupRename).length ? select(source, columns, groupRename) : source;
  const internalGroups = groups.map(name => groupNames.get(name));
  let combined;
  for (const measure of measures) {
    const column = groupNames.get(measure.column) || measure.column;
    const rows = aggregate(groupedSource, { group_by_columns: internalGroups, ...(column === undefined ? {} : { column }), metrics: measure.metrics });
    const renamed = select(rows, [...internalGroups, ...measure.metrics], Object.fromEntries([
      ...groups.map(name => [groupNames.get(name), name]),
      ...measure.metrics.map((metric, i) => [metric, measure.names[i]])
    ]));
    const seen = new Set();
    const keyed = withColumns(renamed.map(row => {
      const value = tuple(row, groups);
      if (seen.has(value)) throw new Error('reduce_result aggregate produced a duplicate group tuple');
      seen.add(value); return { ...row, [key]: value };
    }), [...columnsOf(renamed), key]);
    if (!combined) combined = keyed;
    else {
      // Both sides represent the same aggregate groups, including unknown identifiers.
      // The internal exact tuple key is an aggregation identity, not a source entity join.
      const right = withColumns(keyed.map(row => Object.fromEntries([key, ...measure.names].map(name => [name, row[name]]))), [key, ...measure.names]);
      const joined = join(combined, right, 'inner', null, [key]);
      if (joined.length !== combined.length || joined.length !== keyed.length) throw new Error('reduce_result measures did not produce identical group tuples');
      combined = joined;
    }
  }
  let rows = select(combined, [...groups, ...measures.flatMap(measure => measure.names)]);
  const reducedIdentities = new Set(rows.map(row => tuple(row, IDS)));
  const inputs = new Map();
  for (const row of input.rows) if (!inputs.has(tuple(row, IDS))) inputs.set(tuple(row, IDS), row);
  const recordRows = rows.map(() => true);
  for (const [identity, sourceRow] of inputs) if (!reducedIdentities.has(identity)) {
    const absent = Object.fromEntries([...groups.map(name => [name, IDS.includes(name) ? sourceRow[name] : null]),
      ...measures.flatMap(measure => measure.outputs.map(output => [output.column, output.quantity === 'count' ? 0 : null]))]);
    rows.push(absent); recordRows.push(false);
  }
  rows = withColumns(rows, [...groups, ...measures.flatMap(measure => measure.names)]);
  const missingGrouping = Object.fromEntries(stage.group_by_columns.filter(name => !IDS.includes(name)).map(name => [name, source.filter(row => isMissing(row[name])).length]));
  const reduction = {
    name: stage.name, from: input.name, source_result: input.reductions?.[0]?.source_result || input.name,
    group_by_columns: groups, measures: stage.measures, outputs: measures.flatMap(measure => measure.outputs),
    input_row_kind: input.reductions?.length ? 'reduced_group' : 'source_record',
    input_rows: source.length, input_placeholders: input.rows.length - source.length,
    output_groups: recordRows.filter(Boolean).length, absent_identities: recordRows.filter(value => !value).length,
    missing_grouping_key_rows: missingGrouping,
    count_semantics: 'count counts eligible predecessor rows, including groups with unknown identifiers; it is not proof of identifiable independent samples',
    ...(release === undefined ? {} : { hpa_version: release })
  };
  return { name: stage.name, rows, columns: columnsOf(rows), created_columns: columnsOf(rows).filter(name => !IDS.includes(name)),
    record_rows: recordRows, provenance: input.provenance, coverage: input.coverage,
    unresolved_inputs: input.unresolved_inputs, calculations: input.calculations || [],
    ...(input.classifications ? { classifications: input.classifications } : {}),
    reductions: [...(input.reductions || []), reduction] };
}

function createResultReducer({ results, release }) {
  const pending = new Map();
  return {
    unfinished: () => [...pending.values()],
    reduce(raw) {
      const args = decodeArguments(raw, REDUCE_RESULT.function.parameters, 'reduce_result');
      validate(args, REDUCE_RESULT.function.parameters, 'reduce_result');
      if (!args.stages.length) throw new Error('reduce_result requires at least one stage');
      const names = args.stages.map(stage => stage.name);
      if (names.some(name => !name.trim() || results.has(name)) || new Set(names).size !== names.length) throw new Error('reduce_result stage names must be new and distinct; resume from a saved intermediate using from');
      let input = results.get(args.from);
      if (!input) throw new Error(`No saved result ${args.from}`);
      eligible(input);
      const completed = [];
      for (const [index, stage] of args.stages.entries()) {
        try {
          const result = reduceStage(input, stage, release);
          results.set(stage.name, result); completed.push(result); pending.delete(stage.name); input = result;
        } catch (error) {
          for (const remaining of args.stages.slice(index)) pending.set(remaining.name, {
            requirement: `Complete saved reduction output ${remaining.name}`,
            why: `${stage.name} failed: ${error.message}; resume from ${input.name} and keep the unproduced stage names; those named outputs remain pending`
          });
          return { status: 'partial', completed, failed_stage: stage.name, error: error.message, resume_from: input.name, unfinished_requirements: [...pending.values()] };
        }
      }
      return { status: 'completed', completed, unfinished_requirements: [...pending.values()] };
    }
  };
}

module.exports = { REDUCE_RESULT, createResultReducer };
