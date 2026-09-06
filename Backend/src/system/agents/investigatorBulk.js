'use strict';

const { sourceDefinitions } = require('../../hpa/sourceDefinitions');

const { inference } = require('../../inference/gateway');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { FILES } = require('../../hpa/localData');
const { validate } = require('../aso/batchOperations');
const { APPLY_BULK, createBulkTools } = require('./investigatorBulkTools');
const { REDUCE_RESULT, createResultReducer } = require('./investigatorReduce');
const { SAVED_TOOLS, RUN_RESULTS, createSavedOperations } = require('./investigatorResults');
const { CapabilityCatalog } = require('../aso/capabilityCatalog');
const { decodeArguments } = require('../aso/toolArguments');
const { columnsOf } = require('../aso/studyTools');
const { previewRows, rowPageOptions, cellValue, createViewReader } = require('../aso/observationViews');
const { AgentStop, RepairProgress, createAgentControl, fingerprint } = require('../aso/agentControl');

const SYSTEM = `You are Investigator. Answer the assigned question for the supplied gene list using imported raw source tables. The complete list and prior measurements stay in the tool layer. Discover the relevant sources, inspect their exact columns, and use apply_bulk for the whole list. Match the requested scope; additional assays require an explicit comparison request or a documented source gap.

The source directory lists every imported source and its access method. inspect_table supplies exact columns, source descriptions, sample rows and relevant category definitions. inspect_input supplies existing input columns when needed for a calculation; do not retrieve prior measurements again. Source schemas and samples are evidence about structure, not about the whole cohort. Definitions are keyed by exact source column and explain general category criteria. A category alone does not identify which specific validation method was performed for a gene; report such methods only when a separate source record states them.

Combine all requested per-input measurements, statistics, labels of extrema, simple derived comparisons and ranking in apply_bulk. For assigned comparisons of saved sources, load the registered table operations listed in the directory. Join exact keys, fill only explicitly justified missing columns, compute grouped correlations, classify and rank the saved results without rereading sources. Use run for dependent operations once their schemas are known. These operations retain the supplied assignment scope; they do not discover new biological cohorts. For nested summaries within each input, retrieve raw rows once and use reduce_result: each explicit grouped stage consumes the previous saved result and keeps gene identity. Its count counts eligible predecessor rows; carry original record counts through later stages explicitly with sum. Missing grouping identifiers are unknown groups, not verified independent samples. Every raw and intermediate result remains available. Preserve ties when reporting extrema, source units, missing values and zero denominators. Distinguish counting source rows, nonmissing measurements and distinct entities. Use the statistic the question requests. Do not redefine the supplied cohort or invent pseudocounts, transformations or biological explanations.

Canonical gene and ensembl identifiers are already retained. In rows mode select entity labels and measurements; omit duplicate source gene columns. Source columns cannot overwrite different inherited values. Scalar aliases keep differently scoped measurements separate.

Full results remain saved. Receipts show new columns, coverage and a preview; inherited input fields remain available. open_result with schema=true discovers every saved-result column; its row and cell selections read saved values without repeating source lookups. inspect_input describes only original input fields, not fields created in saved results. You do not need to inspect every row to return a complete result. Describe coverage from computed coverage fields; never extrapolate cohort counts from a preview. finish returns result names and unresolved requirements. Omit answer unless requested interpretation or necessary source limitations add to the tables.

An explicit open_result may return a text_fragment of a complete saved JSON view. Continue it with view and next_text_offset as text_offset; this cursor is not a row offset. A fragment is not an empty result or a truncated source value. To inspect a particular large cell or nested item, select cell.row, cell.column and an optional exact JSON Pointer path.

Assess completion only against Question and Assigned plan result. The original study context constrains this work; it does not add assigned deliverables. ASO coordinates cohort discovery, figures and the final report. Use your registered tool catalog for assigned data operations. When an explicitly assigned output requires an operation absent from that catalog, return the supported saved results and list that output in unfinished_requirements; repeated row inspection cannot replace the unavailable operation. List only assigned outputs that remain unfulfilled, not other parent work.

Verified no-record coverage, missing source fields and measured zero are answered observations when the assignment asks for the recorded evidence and its limits. Keep them in result tables and coverage; do not classify them as unavailable_requirements merely because a value or record is absent. An interpretation of that observed absence can state its exact source scope. If an explicitly requested measurement or conclusion cannot be answered because the necessary source evidence is unavailable, list that unanswerable output in unavailable_requirements. A missing record does not establish biological absence, an experimental history or its cause. Omit both requirement lists when all assigned outputs are answered. Preserve source evidence strength and uncertainty.`;

const TOOLS = [APPLY_BULK, REDUCE_RESULT,
  { type: 'function', function: { name: 'inspect_table', description: 'Inspect exact source columns, descriptions, example rows and category definitions. about matches column names only and projects their sample fields; it never filters tissues, genes or other row values. Use apply_bulk.where for row predicates. terms requests category meanings scoped to the selected columns; unsupported scopes are reported explicitly.', parameters: { type: 'object', properties: { table: { type: 'string' }, about: { type: 'string' }, terms: { type: 'array', items: { type: 'string' } } }, required: ['table'] } } },
  { type: 'function', function: { name: 'inspect_input', description: 'Discover inherited input columns without retrieving measurements again. Omit columns for the complete schema only; choose exact columns to inspect a sample of existing values.', parameters: { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' } } } } } },
  { type: 'function', function: { name: 'open_result', description: 'Read an exact saved-result selection by name, request its complete column schema with schema=true, or continue its saved JSON text view by view and text_offset. Large selections are paged in transport without dropping cells or rereading sources. Use only one selection mode.', parameters: { type: 'object', properties: { name: { type: 'string' }, schema: { type: 'boolean', description: 'true returns the complete saved-result column schema without row values; use with name only.' }, rows: { type: 'integer', description: 'Requested positive row count; default10. Delivery may span text fragments.' }, offset: { type: 'integer', description: 'Zero-based row offset; default0.' }, columns: { type: 'array', items: { type: 'string' } }, cell: { type: 'object', description: 'Select one cell instead of a row window; path optionally selects its exact nested value.', properties: { row: { type: 'integer' }, column: { type: 'string' }, path: { type: 'string', description: 'JSON Pointer within the cell; omit for the complete cell.' } }, required: ['row', 'column'] }, view: { type: 'string', description: 'Saved view ID from an earlier fragment; use without name or row/cell selectors.' }, text_offset: { type: 'integer', description: 'Returned next_text_offset for view continuation; distinct from row offset.' } } } } },
  { type: 'function', function: { name: 'finish', description: 'Return named result tables and the completion status of your assignment only. answer is optional for requested interpretation or necessary limitations; do not transcribe rows.', parameters: { type: 'object', properties: {
    results: { type: 'array', items: { type: 'string' } }, answer: { type: 'string', description: 'Optional requested interpretation or source limitation; omit when tables and structured requirements suffice.' },
    unavailable_requirements: { type: 'array', description: 'Explicitly assigned outputs that cannot be answered because required source evidence is unavailable. Omit when none. Verified no-record coverage and missing fields returned as requested observations are answered evidence, not unavailable requirements. An unsupported source-dependent conclusion remains unavailable even when its raw observations are returned.', items: { type: 'object', properties: { requirement: { type: 'string' }, why: { type: 'string' } }, required: ['requirement', 'why'] } },
    unfinished_requirements: { type: 'array', description: 'Unfulfilled outputs explicitly requested in Question or Assigned plan result, including assigned operations absent from your registered tool catalog. Return supported saved outputs and identify unsupported work here. Omit when none. Other parent work is outside the assignment; unavailable source evidence belongs in unavailable_requirements.', items: { type: 'object', properties: { requirement: { type: 'string' }, why: { type: 'string' } }, required: ['requirement', 'why'] } }
  }, required: ['results'] } } }
];

// Only a bounded preview enters inference. The returned result retains every supplied row.
function resultColumns(table) {
  return [...new Set(['gene', 'ensembl', ...table.created_columns])].filter(key => table.columns.includes(key));
}

function receipt(table, inputColumns = []) {
  const columns = resultColumns(table);
  const operation = table.operations?.at(-1);
  const details = { ...(operation ? { operation: Object.fromEntries(['tool', 'inputs', 'input_rows', 'output_rows', 'result_kind', 'aggregation_rows'].filter(key => operation[key] !== undefined).map(key => [key, operation[key]])) } : {}), ...(table.fills?.length ? { fills: table.fills.map(({ columns, affected_cells, total_affected_cells }) => ({ columns, affected_cells, total_affected_cells })) } : {}), ...(Array.isArray(table.record_rows) ? { row_coverage: { all: table.rows.length, records: table.record_rows.filter(Boolean).length, placeholders: table.record_rows.filter(value => !value).length, semantics: table.row_kind || 'source_record' } } : {}), name: table.name, rows: table.rows.length, columns, column_count: table.columns.length, inherited_columns: { count: table.columns.filter(key => !columns.includes(key) && inputColumns.includes(key)).length, inspect: 'inspect_input' }, omitted_columns: { count: table.columns.filter(key => !columns.includes(key)).length, inspect: { tool: 'open_result', name: table.name, schema: true } }, row_kind: table.row_kind || 'input_table_row', coverage: table.coverage, ...(table.reductions?.length ? { reduction: table.reductions.at(-1), raw_result: table.reductions[0].source_result } : {}), sources: [...new Set(table.provenance.map(source => source.table))], unresolved_inputs: table.unresolved_inputs };
  const selected = columns.filter(key => !/_source_rows$|_missing_rows$/.test(key));
  const view = previewRows(table.rows, selected, 2048);
  details.preview = { columns: selected, rows: view.rows.map(row => selected.map(key => row[key])), more: view.more, next_offset: view.rows.length };
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
  let release, reducer, saved, resolved = [];
  const { onStep } = ctx;
  const emit = (stage, label, message) => onStep?.({ stage, label, message });
  try {
    const control = createAgentControl({ ctx, stats: { get totalTokens() { return stats.total; } }, agentKey: 'investigator_hpa' });
    const progress = new RepairProgress(), completedCalls = new Map();
    let evidenceRevision = 0;
    if (!Array.isArray(genes) || !genes.length || genes.some(gene => typeof gene !== 'string' || !gene.trim())) throw new Error('Bulk Investigator requires a nonempty array of gene names');
    if (typeof question !== 'string' || !question.trim()) throw new Error('Bulk Investigator requires a question');
    if (ctx.studyGoal !== undefined && typeof ctx.studyGoal !== 'string') throw new Error('Original study request must be text');
    if (ctx.inputRows && ctx.inputRows.length !== genes.length) throw new Error('Bulk input rows do not match the supplied list');
    await control.checkpoint('Resolve bulk sources');
    release = await resolveAgentMode(mode, [FILES.master]);
    if (release.mode !== 'offline') throw new Error('Bulk Investigator requires the local release');
    reducer = createResultReducer({ results, release: release.hpaVersion });
    await emit('start', 'Bulk Investigator', `${genes.length} supplied genes. Question: ${question}`);
    resolved = await adapter.resolveGenes(genes);
    const ops = createBulkTools({ supplied: genes, resolved, inputRows: ctx.inputRows, adapter });
    const inputColumns = [...new Set(['gene', 'ensembl', ...(ctx.inputRows ? columnsOf(ctx.inputRows) : [])])];
    const inheritedColumnCount = inputColumns.filter(column => !['gene', 'ensembl'].includes(column)).length;
    const inputShape = inheritedColumnCount ? `Input schema: gene and ensembl identifiers plus ${inheritedColumnCount} inherited columns retained by apply_bulk. inspect_input discovers their exact names and prior values if needed.` : 'Input schema: gene and ensembl identifiers only. There are no inherited measurements or other input columns.';
    saved = createSavedOperations({ results, release: release.hpaVersion, inputColumns, checkpoint: phase => control.checkpoint(phase) });
    const capabilities = new CapabilityCatalog({ tools: [...TOOLS, ...SAVED_TOOLS, RUN_RESULTS], coreNames: TOOLS.map(tool => tool.function.name) });
    const originalRequest = ctx.studyGoal !== undefined && ctx.studyGoal !== question ? `Original study context (constraints only; not additional assigned deliverables):\n${ctx.studyGoal}\nEnd of original study context.\n\n` : '';
    const messages = [{ role: 'system', content: `${SYSTEM}\n\nAdditional saved-result capabilities (load_tools exposes exact schemas):\n${capabilities.directory()}` }, { role: 'user', content: `Supplied list: ${genes.length} genes; ${resolved.filter(Boolean).length} resolved in this release. The full list is held by apply_bulk.\n${inputShape}\n\nComplete source directory (inspect_table for exact schemas and definitions):\n${sourceDirectory(await adapter.catalog())}\n\n${originalRequest}ASSIGNMENT\nQuestion: ${question}${ctx.studyTask ? `\nAssigned plan result: ${ctx.studyTask}` : ''}` }];
    for (;;) {
      await control.checkpoint('Bulk decision', true);
      const offered = capabilities.offered();
      const response = await inference.chat.completions.create({ messages, tools: offered, temperature: 0, ...(ctx.reasoningEffort ? { reasoning_effort: ctx.reasoningEffort } : {}) });
      const usage = response.usage || {};
      stats.prompt += usage.prompt_tokens || 0; stats.completion += usage.completion_tokens || 0; stats.total = stats.prompt + stats.completion;
      await control.checkpoint('Bulk decision: returned');
      const message = { ...response.choices?.[0]?.message, role: 'assistant' };
      messages.push(message);
      const calls = message.tool_calls || [];
      if (!calls.length) {
        progress.record({ issue: 'no_tool_call', evidenceRevision }, 'Investigator repeated a response without a source action or a validated finish');
        messages.push({ role: 'user', content: 'Use a registered evidence operation, load an available saved-result capability, or finish with the assigned requirements that cannot be answered.' }); continue;
      }
      for (const call of calls) {
        let result;
        let requestKey = fingerprint(call.function);
        await control.checkpoint('Bulk tool');
        try {
          const name = call.function.name;
          const spec = offered.find(tool => tool.function.name === name);
          if (!spec) throw new Error(`Investigator tool ${name} is not loaded; load its exact schema with load_tools`);
          const args = decodeArguments(JSON.parse(call.function.arguments), spec.function.parameters, name);
          validate(args, spec.function.parameters, name);
          // Result labels do not make an identical source computation new evidence.
          const identity = name === 'apply_bulk' ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'name')) : args;
          requestKey = fingerprint({ name, args: identity });
          if (completedCalls.has(requestKey)) {
            progress.record({ issue: 'repeated_completed_call', evidenceRevision, requestKey }, 'Investigator repeated a completed operation without new evidence');
            result = { already_available: true, ...completedCalls.get(requestKey), message: 'Use the existing tool receipt or open_result; this operation has already completed.' };
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
            continue;
          }
          if (name === 'load_tools') {
            result = capabilities.load(args.names);
          } else if (SAVED_TOOLS.some(tool => tool.function.name === name)) {
            const table = await saved.execute(name, args);
            result = receipt(table, inputColumns);
            await emit('selection_step', 'Saved result', `${name}: ${table.name}, ${table.rows.length} rows`);
          } else if (name === 'run') {
            const batch = await saved.run(args);
            result = { ...batch, outputs: batch.outputs.map(output => ({ id: output.id, ...receipt(output.table, inputColumns) })) };
            await emit('selection_step', 'Saved operations', `${batch.status}: ${batch.steps.map(step => `${step.id} ${step.status}`).join(', ')}`);
          } else if (name === 'apply_bulk') {
            if (results.has(args.name)) throw new Error(`Result ${args.name} already exists; choose a new name for a revised lookup`);
            await emit('execution_step', 'apply_bulk', `${args.name}: ${args.lookups.length} lookups across ${genes.length} genes`);
            const table = await ops.applyBulk(args);
            results.set(table.name, table);
            result = receipt(table, inputColumns);
            await emit('selection_step', 'Bulk result', `${table.name}: ${table.rows.length} rows; ${JSON.stringify(table.coverage)}`);
          } else if (name === 'reduce_result') {
            const reduced = reducer.reduce(args);
            result = { ...reduced, completed: reduced.completed.map(table => receipt(table, inputColumns)) };
            await emit('selection_step', 'Reduced results', `${reduced.status}: ${reduced.completed.map(table => table.name).join(', ')}`);
          } else if (name === 'inspect_table') {
            if (results.has(args.table)) throw new Error(`${args.table} is a saved result; read it with open_result`);
            const entry = await adapter.entry(args.table);
            if (!entry) throw new Error(`No table ${args.table}`);
            const gene = resolved.find(Boolean);
            const columns = args.about ? entry.columns.filter(column => column.toLowerCase().includes(args.about.toLowerCase())) : entry.columns;
            if (args.about && !columns.length) throw new Error(`No columns matching ${JSON.stringify(args.about)} in ${entry.file}; inspect without about for the complete schema`);
            const readable = !['stream', 'unreadable'].includes(entry.key);
            const raw = gene && readable ? (await adapter.read(gene, entry.file)).rows : [];
            const view = previewRows(raw, columns, 2048);
            const sample = view.rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
            const definitions = sourceDefinitions(entry, sample, args.terms, columns);
            result = { table: entry.file, description: entry.description, columns, column_count: entry.columns.length, key: entry.key, ...(entry.why ? { access_note: entry.why } : {}), sample: { gene: gene?.gene, columns, rows: sample.map(row => columns.map(column => row[column])), more: view.more }, ...definitions };
            sourceEvidence.push({ read_id: `source_${sourceEvidence.length + 1}`, hpa_version: release.hpaVersion, request: args, ...result });
          } else if (name === 'inspect_input') {
            const columns = args.columns || inputColumns;
            if (columns.some(column => !inputColumns.includes(column))) throw new Error(`Unknown input columns; inspect_input without columns returns the exact schema`);
            result = { columns, column_count: inputColumns.length, rows: genes.length };
            if (args.columns) {
              const input = resolved.map((gene, index) => ({ ...ctx.inputRows?.[index], gene: gene ? gene.gene : genes[index], ensembl: gene ? gene.ensembl : null }));
              const view = previewRows(input, columns, 2048);
              result.sample = { columns, rows: view.rows.map(row => columns.map(column => row[column])), more: view.more };
            }
          } else if (name === 'open_result') {
            if (args.view !== undefined) {
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
            const unfinished = [...(args.unfinished_requirements || []), ...reducer.unfinished(), ...saved.unfinished()];
            const unavailable = args.unavailable_requirements === undefined ? [] : args.unavailable_requirements;
            if (!args.results.length && !unavailable.length && !unfinished.length) throw new Error('Return result tables or explain which requirements remain unanswered');
            const tables = [...new Set(args.results)].map(name => results.get(name));
            const answer = args.answer === undefined ? '' : args.answer;
            await emit('complete', 'Bulk answer', answer || `Returned ${tables.length} saved result tables`);
            return { bulk: true, found: tables.length > 0, status: unavailable.length || unfinished.length ? 'partial' : 'ok', answer, tables, source_evidence: sourceEvidence, not_in_release: unavailable, remaining_for_aso: unfinished, input_count: genes.length, unresolved_inputs: resolved.filter(gene => !gene).length, mode: 'offline', hpa_version: release.hpaVersion, tokens: { total: stats }, seconds: (Date.now() - started) / 1000 };
          }
          completedCalls.set(requestKey, { tool: name, previous_call_id: call.id, ...(name === 'apply_bulk' ? { name: result.name } : name === 'reduce_result' ? { names: result.completed.map(table => table.name), status: result.status } : {}) });
          evidenceRevision++;
        } catch (error) {
          if (error instanceof AgentStop) throw error;
          progress.record({ issue: 'rejected_call', evidenceRevision, requestKey, error: error.message }, 'Investigator repeated a rejected operation without resolving its error');
          result = { error: error.message };
          await emit('reasoning_step', 'Correct bulk lookup', error.message);
        }
        await control.checkpoint('Bulk tool: returned');
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
  } catch (error) {
    await emit('error', 'Bulk Investigator', error.message);
    const stop = error instanceof AgentStop ? { stop_reason: error.reason, incomplete: true } : {};
    if (results.size) return { bulk: true, found: true, status: 'partial', ...stop, error: error.message, answer: 'Investigator stopped before completing its assignment. Completed lookup tables are retained; their existence does not establish that every requirement was fulfilled.', tables: [...results.values()], source_evidence: sourceEvidence, not_in_release: [], remaining_for_aso: [{ requirement: ctx.studyTask || question, why: error.message }], input_count: genes.length, unresolved_inputs: resolved.filter(gene => !gene).length, mode: 'offline', hpa_version: release.hpaVersion, tokens: { total: stats }, seconds: (Date.now() - started) / 1000 };
    return { bulk: true, found: false, status: 'incomplete', ...stop, error: error.message, source_evidence: sourceEvidence, mode: 'offline', tokens: { total: stats } };
  }
}

module.exports = investigatorBulk;
