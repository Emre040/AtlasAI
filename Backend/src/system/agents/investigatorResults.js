'use strict';

const { TABLE_OPERATIONS, executeTableOperation, withRowMask } = require('../aso/tableOperations');
const { columnsOf, withColumns } = require('../aso/studyTools');
const { executeBatch, validate, ARGUMENTS_SCHEMA } = require('../aso/batchOperations');
const { decodeArguments } = require('../aso/toolArguments');

const RESULT = { type: 'string', description: 'New saved result name. Existing results cannot be overwritten; names beginning @ are reserved for batch references.' };
const SAVED_TOOLS = [...TABLE_OPERATIONS.values()].map(operation => ({ type: 'function', function: {
  name: operation.name,
  description: `${operation.description} Returns a saved table. Inputs are existing result names only; no source reread.`,
  parameters: { ...operation.parameters, properties: { ...operation.parameters.properties, result: RESULT }, required: [...operation.parameters.required, 'result'] }
} }));
const RUN_RESULTS = { type: 'function', function: {
  name: 'run',
  description: 'Execute dependent registered saved-result operations in one request. Use @step_id only in artifact/a/b handles. Give each step a new result name. Return the requested step receipts; raw and all completed intermediates remain saved. No source lookup, agent call or custom code.',
  parameters: { type: 'object', properties: {
    steps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, tool: { type: 'string' }, args: ARGUMENTS_SCHEMA }, required: ['id', 'tool', 'args'] } },
    outputs: { type: 'array', items: { type: 'string' }, description: 'Step IDs whose resulting receipts should be returned.' }
  }, required: ['steps', 'outputs'] }
} };
const SPECS = new Map(SAVED_TOOLS.map(tool => [tool.function.name, tool.function]));
const inputKeys = operation => Object.entries(TABLE_OPERATIONS.get(operation).parameters.properties).filter(([, schema]) => schema['x-artifact-reference']).map(([key]) => key);
const unique = items => [...new Map(items.map(item => [JSON.stringify(item), item])).values()];

function sourceMask(table) {
  if (table.record_rows === undefined) return null;
  if (!Array.isArray(table.record_rows) || table.record_rows.length !== table.rows.length || table.record_rows.some(value => typeof value !== 'boolean')) throw new Error(`Invalid record_rows metadata in ${table.name}`);
  return table.record_rows;
}

function createSavedOperations({ results, release, inputColumns = [], checkpoint = async () => {} }) {
  const pending = new Map();
  function newName(name) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('@')) throw new Error('Saved operation result needs a nonempty name that does not start with @');
    if (results.has(name)) throw new Error(`Result ${name} already exists; choose a new result name`);
  }
  function table(name) {
    const value = results.get(name);
    if (!value) throw new Error(`No saved result ${name}; available: ${[...results.keys()].join(', ')}`);
    if (!Array.isArray(value.rows) || !Array.isArray(value.columns)) throw new Error(`${name} is not a saved table`);
    if (value.execution?.status === 'partial') throw new Error(`${name} contains partially executed rows; repair its execution first`);
    sourceMask(value);
    return value;
  }
  function transform(name, args) {
    newName(args.result);
    const keys = inputKeys(name), parents = Object.fromEntries(keys.map(key => [key, table(args[key])]));
    const inputs = Object.fromEntries(keys.map(key => [key, withRowMask(withColumns([...parents[key].rows], parents[key].columns), sourceMask(parents[key]), parents[key].row_kind || (parents[key].reductions?.length ? 'reduced_group' : sourceMask(parents[key]) ? 'source_record' : 'input_table_row'))]));
    const out = executeTableOperation(name, args, inputs);
    const rawRows = out.rows, mask = out.meta?.record_rows;
    const columns = columnsOf(rawRows);
    const rows = withColumns(rawRows.map(row => Object.fromEntries(columns.map(column => [column, row[column] === undefined ? null : row[column]]))), columns);
    const parentList = [...new Set(Object.values(parents))];
    const operationArgs = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'result'));
    const operation = { tool: name, result: args.result, inputs: Object.fromEntries(keys.map(key => [key, parents[key].name])), args: operationArgs,
      input_rows: Object.fromEntries(keys.map(key => [key, parents[key].rows.length])), output_rows: rows.length,
      result_kind: 'table', ...Object.fromEntries(Object.entries(out.meta || {}).filter(([key]) => key !== 'record_rows')), ...(release === undefined ? {} : { hpa_version: release }) };
    const inherited = new Set(inputColumns);
    const value = { name: args.result, rows, columns,
      created_columns: out.meta?.ordering_columns || columns.filter(column => !inherited.has(column)),
      provenance: unique(parentList.flatMap(parent => parent.provenance || [])),
      coverage: unique(parentList.flatMap(parent => parent.coverage || [])),
      unresolved_inputs: Math.max(0, ...parentList.map(parent => parent.unresolved_inputs || 0)),
      calculations: unique(parentList.flatMap(parent => parent.calculations || [])),
      operations: [...unique(parentList.flatMap(parent => parent.operations || [])), operation],
      row_kind: out.meta?.row_kind || 'derived_result_row', ...(mask ? { record_rows: mask } : {}),
      classifications: unique([...parentList.flatMap(parent => parent.classifications || []), ...(out.meta?.classifications || [])]),
      fills: unique([...parentList.flatMap(parent => parent.fills || []), ...(out.meta?.fills || [])]),
      // Keep exact stage ancestry even after a join. The operation records which
      // parent supplied each input; raw and stage tables remain independently saved.
      reductions: unique(parentList.flatMap(parent => parent.reductions || []))
    };
    results.set(value.name, value); pending.delete(value.name);
    return value;
  }
  async function execute(name, raw) {
    const spec = SPECS.get(name);
    if (!spec) throw new Error(`${name} is not a registered saved-result operation`);
    const args = decodeArguments(raw, spec.parameters, name);
    validate(args, spec.parameters, name);
    newName(args.result);
    await checkpoint(`Saved operation ${name}`);
    try { return transform(name, args); }
    catch (error) {
      pending.set(args.result, { requirement: `Complete saved operation output ${args.result}`, why: `${name} failed: ${error.message}; repair using the same result name` });
      throw error;
    }
  }
  return {
    unfinished: () => [...pending.values()],
    execute,
    async run(raw) {
      const args = decodeArguments(raw, RUN_RESULTS.function.parameters, 'run');
      validate(args, RUN_RESULTS.function.parameters, 'run');
      const targets = new Map();
      for (const step of args.steps) {
        const spec = SPECS.get(step.tool);
        if (!spec) throw new Error(`${step.tool} is not a registered saved-result operation`);
        const value = decodeArguments(step.args, spec.parameters, step.tool);
        newName(value.result);
        if ([...targets.values()].includes(value.result)) throw new Error(`Duplicate batch result name ${value.result}`);
        targets.set(step.id, value.result);
      }
      const result = await executeBatch(args, { specifications: SPECS, concurrency: Math.max(1, args.steps.length), execute: async (name, operationArgs) => {
        const value = await execute(name, operationArgs);
        return { ok: true, artifact: { id: value.name }, table: value };
      } });
      for (const step of result.steps) if (['failed', 'blocked'].includes(step.status)) {
        const target = targets.get(step.id);
        pending.set(target, { requirement: `Complete saved operation output ${target}`, why: `${step.tool} ${step.status}: ${step.error}; retain completed results and repair using the same result name` });
      }
      return { ...result, unfinished_requirements: [...pending.values()] };
    }
  };
}

module.exports = { SAVED_TOOLS, RUN_RESULTS, createSavedOperations };
