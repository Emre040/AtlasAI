'use strict';

const { sourceDefinitions } = require('../../hpa/sourceDefinitions');

const { inference } = require('../../inference/gateway');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { FILES } = require('../../hpa/localData');
const { validate } = require('../aso/batchOperations');
const { APPLY_BULK, createBulkTools } = require('./investigatorBulkTools');
const { decodeArguments } = require('../aso/toolArguments');
const { columnsOf } = require('../aso/studyTools');
const { previewRows, rowPageOptions, cellValue, createViewReader } = require('../aso/observationViews');
const { AgentStop, RepairProgress, createAgentControl, fingerprint } = require('../aso/agentControl');

const SYSTEM = `You are Investigator. Find the imported source evidence that answers the assigned question. The supplied list stays in the tools; you know its size and do not need to read or copy every gene.

Use the source directory to locate relevant tables. inspect_table establishes exact source columns and meanings; these remain in ACTIVE CONTRACTS. Once the mapping is clear, apply_bulk retrieves the assigned evidence for the entire supplied list. Return one source relation with the requested dimensions and measurements; ASO derives other presentations from it. Use scalar summaries when the assignment requests them. Independent source lookups can share a response. Keep assays, units, missing values, zeros, repeated records and ties distinct. Canonical gene and ensembl identifiers are retained automatically.

Your tools investigate sources and retrieve evidence. ASO owns study planning, calculations across saved tables, figures and the final report. Follow the question's exact source constraints and exclusions. If an assigned calculation needs other tools, return its underlying measurements and name the unfinished calculation once. Do not expand the assignment into the rest of the study.

ACTIVE CONTRACTS retain the exact input schema, inspected source definitions, saved result schemas and computed coverage. Use them directly; returning a table requires neither reopening its values nor inspecting already-known input columns. Use open_result or inspect_input when a decision or requested interpretation needs values. Detailed tool bodies and rows are archived after one delivery and remain retrievable by call or result name. Source samples illustrate shape, not complete coverage or category domains.

For retrieval assignments, finish with results only. Add answer only for explicitly requested interpretation or a necessary limitation absent from the structured coverage. Do not transcribe retrieved measurements. Missing records and missing values describe source coverage, not biological absence, assay history or cause. Category definitions do not establish a particular experimental method. unavailable_requirements names assigned outputs lacking source evidence; unfinished_requirements names assigned work still to do. Omit both when the assignment is answered.`;

const TOOLS = [APPLY_BULK,
  { type: 'function', function: { name: 'inspect_table', description: 'Inspect exact source columns, descriptions, example rows and category definitions. about matches column names only and projects their sample fields; it never filters tissues, genes or other row values. Use apply_bulk.where for row predicates. terms requests category meanings scoped to the selected columns; unsupported scopes are reported explicitly.', parameters: { type: 'object', properties: { table: { type: 'string' }, about: { type: 'string' }, terms: { type: 'array', items: { type: 'string' } } }, required: ['table'] } } },
  { type: 'function', function: { name: 'inspect_input', description: 'Discover inherited input columns without retrieving measurements again. Omit columns for the complete schema only; choose exact columns to inspect a sample of existing values.', parameters: { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' } } } } } },
  { type: 'function', function: { name: 'open_result', description: 'Inspect saved evidence: select a result by name, retrieve an archived tool body by call, or continue a view with text_offset. Use one selection mode. Exact cells are preserved and large views are paged without source rereads.', parameters: { type: 'object', properties: { call: { type: 'string', description: 'archived_call ID from a previous tool response. Use alone to retrieve its exact body.' }, name: { type: 'string' }, schema: { type: 'boolean', description: 'true returns the complete saved-result column schema without row values; use with name only.' }, rows: { type: 'integer', description: 'Requested positive row count; default10. Delivery may span text fragments.' }, offset: { type: 'integer', description: 'Zero-based row offset; default0.' }, columns: { type: 'array', items: { type: 'string' } }, cell: { type: 'object', description: 'Select one cell instead of a row window; path optionally selects its exact nested value.', properties: { row: { type: 'integer' }, column: { type: 'string' }, path: { type: 'string', description: 'JSON Pointer within the cell; omit for the complete cell.' } }, required: ['row', 'column'] }, view: { type: 'string', description: 'Saved view ID from an earlier fragment; use without name or row/cell selectors.' }, text_offset: { type: 'integer', description: 'Returned next_text_offset for view continuation; distinct from row offset.' } } } } },
  { type: 'function', function: { name: 'finish', description: 'Return named result tables and the completion status of your assignment only. answer is optional for requested interpretation or necessary limitations; do not transcribe rows.', parameters: { type: 'object', properties: {
    results: { type: 'array', items: { type: 'string' } }, answer: { type: 'string', description: 'Optional requested interpretation or source limitation; omit when tables and structured requirements suffice.' },
    unavailable_requirements: { type: 'array', description: 'Explicitly assigned outputs that cannot be answered because required source evidence is unavailable. Omit when none. Verified no-record coverage and missing fields returned as requested observations are answered evidence, not unavailable requirements. An unsupported source-dependent conclusion remains unavailable even when its raw observations are returned.', items: { type: 'object', properties: { requirement: { type: 'string' }, why: { type: 'string' } }, required: ['requirement', 'why'] } },
    unfinished_requirements: { type: 'array', description: 'Unfulfilled outputs explicitly requested in Question or Assigned plan result, including assigned operations absent from your registered tool catalog. Return supported saved outputs and identify unsupported work here. Omit when none. Other parent work is outside the assignment; unavailable source evidence belongs in unavailable_requirements.', items: { type: 'object', properties: { requirement: { type: 'string' }, why: { type: 'string' } }, required: ['requirement', 'why'] } }
  }, required: ['results'] } } }
];

// Execution receipts describe saved results. Values enter inference only through
// an explicit read, while the returned result retains every supplied row.
function resultColumns(table) {
  return [...new Set(['gene', 'ensembl', ...table.created_columns])].filter(key => table.columns.includes(key));
}

function receipt(table, inputColumns = []) {
  const columns = table.columns;
  const details = { ...(Array.isArray(table.record_rows) ? { row_coverage: { all: table.rows.length, records: table.record_rows.filter(Boolean).length, placeholders: table.record_rows.filter(value => !value).length, semantics: table.row_kind || 'source_record' } } : {}), name: table.name, status: table.execution?.status || 'completed', rows: table.rows.length, columns, column_count: columns.length, inherited_columns: columns.filter(key => inputColumns.includes(key) && !table.created_columns.includes(key)), lookups: table.provenance, coverage: table.coverage, unresolved_inputs: table.unresolved_inputs };
  return details;
}

function sourceDirectory(entries) {
  return entries.map(entry => {
    const access = ['master', 'ensembl', 'name', 'scan'].includes(entry.key) ? 'bulk lookup' : entry.key === 'lookup' ? 'reference table' : entry.key;
    return `${entry.file} | ${entry.title || entry.file} | ${access}${entry.why ? `: ${entry.why}` : ''}`;
  }).join('\n');
}


async function investigatorBulk({ genes, question, mode = 'offline' }, ctx = {}, adapter = require('../../hpa/geneDataAdapter')) {
  const started = Date.now();
  const stats = { prompt: 0, completion: 0, total: 0 };
  const results = new Map();
  const sourceEvidence = [];
  const views = createViewReader({ budgetBytes: ctx.resultBytes === undefined ? 4096 : ctx.resultBytes, archive: ctx.viewArchive });
  let release, ops, resolved = [];
  const { onStep } = ctx;
  const emit = (stage, label, message) => onStep?.({ stage, label, message });
  try {
    const control = createAgentControl({ ctx, stats: { get totalTokens() { return stats.total; } }, agentKey: 'investigator_hpa' });
    const progress = new RepairProgress(), completedCalls = new Map();
    let evidenceRevision = 0;
    if (!Array.isArray(genes) || !genes.length && ctx.inputTable === undefined || genes.some(gene => typeof gene !== 'string' || !gene.trim())) throw new Error('Bulk Investigator requires a nonempty array of gene names unless an empty input table is supplied');
    if (typeof question !== 'string' || !question.trim()) throw new Error('Bulk Investigator requires a question');
    if (ctx.studyGoal !== undefined && typeof ctx.studyGoal !== 'string') throw new Error('Original study request must be text');
    if (ctx.inputRows && ctx.inputRows.length !== genes.length) throw new Error('Bulk input rows do not match the supplied list');
    let inputTable;
    if (ctx.inputTable !== undefined) {
      if (ctx.inputRows !== undefined) throw new Error('Supply inputTable or inputRows, not both');
      inputTable = structuredClone(ctx.inputTable);
      if (!inputTable || !Array.isArray(inputTable.rows) || !Array.isArray(inputTable.columns) || inputTable.columns.some(column => typeof column !== 'string') || new Set(inputTable.columns).size !== inputTable.columns.length) throw new Error('inputTable requires exact rows and a distinct column schema');
      if (!inputTable.source || typeof inputTable.source.id !== 'string' || typeof inputTable.source.uuid !== 'string') throw new Error('inputTable requires its source artifact ID and UUID');
      if (inputTable.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || typeof (row.ensembl || row.gene) !== 'string' || !(row.ensembl || row.gene).trim())) throw new Error('inputTable rows must retain gene identifiers');
      if (inputTable.record_rows !== undefined && (!Array.isArray(inputTable.record_rows) || inputTable.record_rows.length !== inputTable.rows.length || inputTable.record_rows.some(value => typeof value !== 'boolean'))) throw new Error('inputTable has invalid source row coverage');
      const queries = [...new Set(inputTable.rows.map(row => row.ensembl || row.gene))];
      genes = queries;
    }
    await control.checkpoint('Resolve bulk sources');
    release = await resolveAgentMode(mode, [FILES.master]);
    if (release.mode !== 'offline') throw new Error('Bulk Investigator requires the local release');
    resolved = await adapter.resolveGenes(genes);
    if (inputTable) {
      const identities = new Set(), supplied = [], uniqueResolved = [];
      for (const [index, gene] of resolved.entries()) {
        if (gene && identities.has(gene.ensembl)) continue;
        if (gene) identities.add(gene.ensembl);
        supplied.push(genes[index]); uniqueResolved.push(gene);
      }
      genes = supplied; resolved = uniqueResolved;
      results.set('input', { name: 'input', rows: inputTable.rows, columns: inputTable.columns, created_columns: inputTable.columns,
        input_source: inputTable.source, provenance: [], coverage: [], calculations: [], unresolved_inputs: resolved.filter(gene => !gene).length,
        ...Object.fromEntries(['record_rows', 'row_kind', 'execution'].filter(key => inputTable[key] !== undefined).map(key => [key, inputTable[key]])) });
    }
    await emit('start', 'Bulk Investigator', `${inputTable ? `${inputTable.rows.length} input table rows; ${genes.length} unique lookup entities` : `${genes.length} supplied genes`}. Question: ${question}`);
    ops = createBulkTools({ supplied: genes, resolved, inputRows: inputTable ? undefined : ctx.inputRows, adapter });
    const inputColumns = inputTable ? inputTable.columns : [...new Set(['gene', 'ensembl', ...(ctx.inputRows ? columnsOf(ctx.inputRows) : [])])];
    const inputSource = inputTable ? { ...inputTable.source, meta: { ...inputTable.source?.meta } } : null;
    if (inputSource) delete inputSource.meta.hpa_version;
    const inputContract = { ...(inputTable ? { name: 'input', source: inputSource } : {}), rows: inputTable ? inputTable.rows.length : genes.length, columns: inputColumns, lookup_entities: genes.length, resolved_entities: resolved.filter(Boolean).length,
      ...(inputTable?.record_rows ? { record_rows: inputTable.record_rows.filter(Boolean).length, placeholder_rows: inputTable.record_rows.filter(value => !value).length } : {}) };
    const sourceContracts = new Map();
    const assignment = `INPUT (original rows retained; full lookup list held by tools)\n${JSON.stringify(inputContract)}\n\nComplete source directory (inspect_table for exact schemas and definitions):\n${sourceDirectory(await adapter.catalog())}\n\nASSIGNMENT\nQuestion: ${question}`;
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: assignment }];
    const callBodies = new Map(), archived = new Map();
    let delivered = 0;
    const record = (call, value) => {
      const content = JSON.stringify(value);
      callBodies.set(call.id, content);
      const handle = { archived_call: call.id,
        ...Object.fromEntries(['name', 'table', 'status'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) };
      archived.set(call.id, value.error ? content : JSON.stringify(handle));
      // Contracts already carry this metadata in the current request. Deliver only
      // source examples here; exact tool bodies remain addressable by call ID.
      const deliveredContent = !value.error && call.function.name === 'inspect_table' ? JSON.stringify({ ...handle, ...(value.sample ? { sample: value.sample } : {}) })
        : !value.error && call.function.name === 'apply_bulk' ? JSON.stringify(handle) : content;
      messages.push({ role: 'tool', tool_call_id: call.id, content: deliveredContent });
    };
    for (;;) {
      await control.checkpoint('Bulk decision', true);
      const offered = TOOLS;
      messages[1] = { role: 'user', content: `${assignment}\n\nACTIVE CONTRACTS (authoritative metadata; values remain in saved results)\n${JSON.stringify({ sources: [...sourceContracts.values()], results: [...results.values()].filter(table => table.name !== 'input').map(table => receipt(table, inputColumns)) })}` };
      const active = messages.map((message, index) => index < delivered && message.role === 'tool'
        ? { ...message, content: archived.get(message.tool_call_id) } : message);
      const response = await inference.chat.completions.create({ messages: active, tools: offered, temperature: 0, ...(ctx.reasoningEffort ? { reasoning_effort: ctx.reasoningEffort } : {}) });
      delivered = messages.length;
      const usage = response.usage || {};
      stats.prompt += usage.prompt_tokens || 0; stats.completion += usage.completion_tokens || 0; stats.total = stats.prompt + stats.completion;
      await control.checkpoint('Bulk decision: returned');
      const message = { ...response.choices?.[0]?.message, role: 'assistant' };
      messages.push(message);
      const calls = message.tool_calls || [];
      if (!calls.length) {
        progress.record({ issue: 'no_tool_call', evidenceRevision }, 'Investigator repeated a response without a source action or a validated finish');
        messages.push({ role: 'user', content: 'Locate the required source, retrieve its evidence, or finish with the assigned requirements that cannot be answered.' }); continue;
      }
      for (const call of calls) {
        let result;
        let requestKey = fingerprint(call.function);
        await control.checkpoint('Bulk tool');
        try {
          const name = call.function.name;
          const spec = offered.find(tool => tool.function.name === name);
          if (!spec) throw new Error(`Investigator has no ${name} tool. Retrieve source evidence with apply_bulk; ASO handles operations across saved tables.`);
          const args = decodeArguments(JSON.parse(call.function.arguments), spec.function.parameters, name);
          validate(args, spec.function.parameters, name);
          // Result labels do not make an identical source computation new evidence.
          const identity = name === 'apply_bulk' ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'name')) : args;
          requestKey = fingerprint({ name, args: identity });
          if (completedCalls.has(requestKey)) {
            progress.record({ issue: 'repeated_completed_call', evidenceRevision, requestKey }, 'Investigator repeated a completed operation without new evidence');
            result = { already_available: true, ...completedCalls.get(requestKey), message: 'Use the existing tool receipt or open_result; this operation has already completed.' };
            record(call, result);
            continue;
          }
          if (name === 'apply_bulk') {
            if (results.has(args.name)) throw new Error(`Result ${args.name} already exists; choose a new name for a revised lookup`);
            await emit('execution_step', 'apply_bulk', `${args.name}: ${args.lookups.length} lookups across ${genes.length} genes`);
            const table = await ops.applyBulk(args);
            results.set(table.name, table);
            result = receipt(table, inputColumns);
            await emit('selection_step', 'Bulk result', `${table.name}: ${table.rows.length} rows; ${JSON.stringify(table.coverage)}`);
          } else if (name === 'inspect_table') {
            if (results.has(args.table)) throw new Error(`${args.table} is a saved result; read it with open_result`);
            const entry = await adapter.entry(args.table);
            if (!entry) throw new Error(`No table ${args.table}`);
            const gene = resolved.find(Boolean);
            const columns = args.about ? entry.columns.filter(column => column.toLowerCase().includes(args.about.toLowerCase())) : entry.columns;
            if (args.about && !columns.length) throw new Error(`No columns matching ${JSON.stringify(args.about)} in ${entry.file}; inspect without about for the complete schema`);
            const readable = !['stream', 'unreadable'].includes(entry.key);
            const raw = gene && readable ? (await adapter.read(gene, entry.file)).rows : [];
            const view = previewRows(raw, columns, 2048, 2);
            const sample = view.rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
            const definitions = sourceDefinitions(entry, sample, args.terms, columns);
            result = { table: entry.file, description: entry.description, columns, column_count: entry.columns.length, key: entry.key, ...(entry.why ? { access_note: entry.why } : {}), sample: { gene: gene?.gene, columns, rows: sample.map(row => columns.map(column => row[column])), more: view.more }, ...definitions };
            const contract = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'sample'));
            sourceContracts.set(fingerprint({ table: entry.file, columns, terms: args.terms || [] }), contract);
            sourceEvidence.push({ read_id: `source_${sourceEvidence.length + 1}`, hpa_version: release.hpaVersion, request: args, ...result });
          } else if (name === 'inspect_input') {
            const columns = args.columns || inputColumns;
            if (columns.some(column => !inputColumns.includes(column))) throw new Error(`Unknown input columns; inspect_input without columns returns the exact schema`);
            result = { columns, column_count: inputColumns.length, rows: inputTable ? inputTable.rows.length : genes.length, ...(inputTable ? { name: 'input' } : {}) };
            if (args.columns) {
              const input = inputTable ? inputTable.rows : resolved.map((gene, index) => ({ ...ctx.inputRows?.[index], gene: gene ? gene.gene : genes[index], ensembl: gene ? gene.ensembl : null }));
              const view = previewRows(input, columns, 2048, 2);
              result.sample = { columns, rows: view.rows.map(row => columns.map(column => row[column])), more: view.more };
            }
          } else if (name === 'open_result') {
            if (args.call !== undefined) {
              if (Object.keys(args).some(key => key !== 'call')) throw new Error('An archived call selection takes only call');
              if (!callBodies.has(args.call)) throw new Error(`No archived tool call ${args.call}`);
              result = JSON.parse(callBodies.get(args.call));
            } else if (args.view !== undefined) {
              if (['name', 'schema', 'rows', 'offset', 'columns', 'cell'].some(key => args[key] !== undefined)) throw new Error('A view continuation takes only view and text_offset');
              result = views.read(args);
            } else {
              if (args.text_offset !== undefined) throw new Error('text_offset requires a saved view; offset selects table rows');
              const table = results.get(args.name);
              if (!table) throw new Error(`No saved result ${args.name}; available: ${[...results.keys()].join(', ')}`);
              let selection;
              if (args.schema === true) {
                if (['rows', 'offset', 'columns', 'cell'].some(key => args[key] !== undefined)) throw new Error('A schema selection takes name and schema=true only');
                selection = { name: table.name, columns: table.columns, column_count: table.columns.length, rows: table.rows.length, row_kind: table.row_kind || 'input_table_row' };
              } else if (args.cell !== undefined) {
                if (['rows', 'offset', 'columns'].some(key => args[key] !== undefined)) throw new Error('A cell selection cannot also select a row window');
                selection = { name: table.name, cell: args.cell, value: cellValue(table.rows, table.columns, args.cell) };
              } else {
                const { rows, offset } = rowPageOptions(args);
                const columns = args.columns || resultColumns(table);
                if (!columns.length || columns.some(key => !table.columns.includes(key))) throw new Error(`Choose result columns from ${table.columns.join(', ')}`);
                const selected = table.rows.slice(offset, offset + rows);
                selection = { name: table.name, columns, rows: selected.map(row => columns.map(key => row[key] === undefined ? null : row[key])), offset, total: table.rows.length, more: offset + selected.length < table.rows.length, next_offset: offset + selected.length };
              }
              result = views.open(selection, { source: `open_result ${table.name}`, refs: [table.name] });
            }
            if (ctx.viewDirectory) await views.archive.flush(ctx.viewDirectory);
          } else {
            if (args.results.some(name => !results.has(name))) throw new Error('finish results must name existing saved outputs');
            const unfinished = [...(args.unfinished_requirements || [])];
            const unavailable = args.unavailable_requirements === undefined ? [] : args.unavailable_requirements;
            if (!args.results.length && !unavailable.length && !unfinished.length) throw new Error('Return result tables or explain which requirements remain unanswered');
            const tables = [...new Set(args.results)].map(name => results.get(name));
            for (const table of tables.filter(table => table.execution?.status === 'partial')) unfinished.push({ requirement: `Complete execution of ${table.name}`, why: 'The selected source table has incomplete execution; its retained rows are supporting evidence.' });
            const retained_tables = [...results.values()].filter(table => !args.results.includes(table.name));
            const raw_sources = ops.completedSourceReads();
            const answer = args.answer === undefined ? '' : args.answer;
            await emit('complete', 'Bulk answer', answer || `Returned ${tables.length} saved result tables`);
            return { bulk: true, found: tables.length > 0, status: unavailable.length || unfinished.length ? 'partial' : 'ok', answer, tables, retained_tables, raw_sources, source_evidence: sourceEvidence, not_in_release: unavailable, remaining_for_aso: unfinished, input_count: genes.length, unresolved_inputs: resolved.filter(gene => !gene).length, mode: 'offline', hpa_version: release.hpaVersion, tokens: { total: stats }, seconds: (Date.now() - started) / 1000 };
          }
          completedCalls.set(requestKey, { tool: name, previous_call_id: call.id, ...(name === 'apply_bulk' ? { name: result.name } : {}) });
          evidenceRevision++;
        } catch (error) {
          if (error instanceof AgentStop) throw error;
          progress.record({ issue: 'rejected_call', evidenceRevision, requestKey, error: error.message }, 'Investigator repeated a rejected operation without resolving its error');
          result = { error: error.message };
          await emit('reasoning_step', 'Correct bulk lookup', error.message);
        }
        await control.checkpoint('Bulk tool: returned');
        record(call, result);
      }
    }
  } catch (error) {
    await emit('error', 'Bulk Investigator', error.message);
    const stop = error instanceof AgentStop ? { stop_reason: error.reason, incomplete: true } : {};
    if (results.size) return { bulk: true, found: true, status: 'partial', ...stop, error: error.message, answer: 'Investigator stopped before completing its assignment. Completed lookup tables are retained; their existence does not establish that every requirement was fulfilled.', tables: [...results.values()], retained_tables: [], raw_sources: ops?.completedSourceReads() || [], source_evidence: sourceEvidence, not_in_release: [], remaining_for_aso: [{ requirement: ctx.studyTask || question, why: error.message }], input_count: genes.length, unresolved_inputs: resolved.filter(gene => !gene).length, mode: 'offline', hpa_version: release.hpaVersion, tokens: { total: stats }, seconds: (Date.now() - started) / 1000 };
    return { bulk: true, found: false, status: 'incomplete', ...stop, error: error.message, remaining_for_aso: [{ requirement: ctx.studyTask || question, why: error.message }], tables: [], retained_tables: [], raw_sources: ops?.completedSourceReads() || [], source_evidence: sourceEvidence, mode: 'offline', tokens: { total: stats } };
  }
}

module.exports = investigatorBulk;
