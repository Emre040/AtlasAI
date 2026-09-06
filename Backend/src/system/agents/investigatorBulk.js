'use strict';

const { inference } = require('../../inference/gateway');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { FILES } = require('../../hpa/localData');
const { validate } = require('../aso/batchOperations');
const { APPLY_BULK, createBulkTools } = require('./investigatorBulkTools');
const { columnsOf } = require('../aso/studyTools');
const { previewRows, rowPageOptions, cellValue, createViewReader } = require('../aso/observationViews');
const { AgentStop, RepairProgress, createAgentControl, fingerprint } = require('../aso/agentControl');

const SYSTEM = `You are Investigator. Answer the assigned question for the supplied gene list using imported raw source tables. The complete list and prior measurements stay in the tool layer. Discover the relevant sources, inspect their exact columns, and use apply_bulk for the whole list.

The source directory lists every imported source and its access method. inspect_table supplies exact columns, source descriptions, sample rows and relevant category definitions. inspect_input supplies existing input columns when needed for a calculation; do not retrieve prior measurements again. Source schemas and samples are evidence about structure, not about the whole cohort.

Combine all requested per-input measurements, statistics, labels of extrema, simple derived comparisons and ranking in apply_bulk. Preserve ties when reporting extrema, source units, missing values and zero denominators. Distinguish counting source rows, nonmissing measurements and distinct entities. Use the statistic the question requests. Do not redefine the supplied cohort or invent pseudocounts, transformations or biological explanations.

Canonical gene and ensembl identifiers are already retained. In rows mode select entity labels and measurements; omit duplicate source gene columns. Source columns cannot overwrite different inherited values. Scalar aliases keep differently scoped measurements separate.

Full results remain saved. Receipts show new columns, coverage and a preview; inherited input fields remain available. open_result reads other saved rows or columns without repeating source lookups. You do not need to inspect every row to return a complete result. Describe coverage from computed coverage fields; never extrapolate cohort counts from a preview. finish returns result names and a short explanation of the source and limitations; the tables carry numerical result lists.

An explicit open_result may return a text_fragment of a complete saved JSON view. Continue it with view and next_text_offset as text_offset; this cursor is not a row offset. A fragment is not an empty result or a truncated source value. To inspect a particular large cell or nested item, select cell.row, cell.column and an optional exact JSON Pointer path.

Fulfill the question and assigned result. ASO handles figures, correlations, set combinations and counts across cohorts; return necessary measurements and record such explicitly assigned remaining work in remaining_for_aso. Other study tasks are outside this assignment. For unavailable source evidence use not_in_release. A missing record establishes only no record in that source, not biological absence or whether an experiment ever occurred. Preserve source evidence strength and uncertainty.`;

const TOOLS = [APPLY_BULK,
  { type: 'function', function: { name: 'inspect_table', description: 'Inspect exact source columns, descriptions, example rows and category definitions. about selects matching columns; terms requests exact release-defined terms.', parameters: { type: 'object', properties: { table: { type: 'string' }, about: { type: 'string' }, terms: { type: 'array', items: { type: 'string' } } }, required: ['table'] } } },
  { type: 'function', function: { name: 'inspect_input', description: 'Discover inherited input columns without retrieving measurements again. Omit columns for the complete schema only; choose exact columns to inspect a sample of existing values.', parameters: { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' } } } } } },
  { type: 'function', function: { name: 'open_result', description: 'Read an exact saved-result selection by name, or continue its saved JSON text view by view and text_offset. Large selections are paged in transport without dropping cells or rereading sources. Use only one selection mode.', parameters: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'integer', description: 'Requested positive row count; default10. Delivery may span text fragments.' }, offset: { type: 'integer', description: 'Zero-based row offset; default0.' }, columns: { type: 'array', items: { type: 'string' } }, cell: { type: 'object', description: 'Select one cell instead of a row window; path optionally selects its exact nested value.', properties: { row: { type: 'integer' }, column: { type: 'string' }, path: { type: 'string', description: 'JSON Pointer within the cell; omit for the complete cell.' } }, required: ['row', 'column'] }, view: { type: 'string', description: 'Saved view ID from an earlier fragment; use without name or row/cell selectors.' }, text_offset: { type: 'integer', description: 'Returned next_text_offset for view continuation; distinct from row offset.' } } } } },
  { type: 'function', function: { name: 'finish', description: 'Return the named complete result tables without transcribing their rows. Preserve unanswered requirements.', parameters: { type: 'object', properties: {
    results: { type: 'array', items: { type: 'string' } }, answer: { type: 'string' },
    not_in_release: { type: 'array', items: { type: 'object', properties: { requirement: { type: 'string' }, why: { type: 'string' } }, required: ['requirement', 'why'] } },
    remaining_for_aso: { type: 'array', description: 'Work explicitly requested in your question or assigned result that ASO still needs to perform. Do not list other study tasks. This is not missing source data.', items: { type: 'object', properties: { requirement: { type: 'string' }, why: { type: 'string' } }, required: ['requirement', 'why'] } }
  }, required: ['results', 'answer', 'not_in_release'] } } }
];

// Only a bounded preview enters inference. The returned result retains every supplied row.
function resultColumns(table) {
  return [...new Set(['gene', 'ensembl', ...table.created_columns])].filter(key => table.columns.includes(key));
}

function receipt(table) {
  const columns = resultColumns(table);
  const details = { name: table.name, rows: table.rows.length, columns, column_count: table.columns.length, inherited_columns: { count: table.columns.filter(key => !columns.includes(key)).length, inspect: 'inspect_input' }, coverage: table.coverage, sources: [...new Set(table.provenance.map(source => source.table))], unresolved_inputs: table.unresolved_inputs };
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

function sourceDefinitions(adapter, entry, sample, terms = []) {
  const candidates = new Set([...terms, ...entry.columns, ...sample.flatMap(row => Object.values(row).flatMap(value => String(value ?? '').split(/[,;|]/).map(part => part.trim())))]);
  return Object.fromEntries([...candidates].map(term => [term, adapter.definition(term)]).filter(([, definition]) => definition));
}

async function investigatorBulk({ genes, question, mode = 'offline' }, ctx = {}, adapter = require('../../hpa/geneDataAdapter')) {
  const started = Date.now();
  const stats = { prompt: 0, completion: 0, total: 0 };
  const results = new Map();
  const views = createViewReader({ budgetBytes: ctx.resultBytes === undefined ? 4096 : ctx.resultBytes, archive: ctx.viewArchive });
  let release, resolved = [];
  const { onStep } = ctx;
  const emit = (stage, label, message) => onStep?.({ stage, label, message });
  try {
    const control = createAgentControl({ ctx, stats: { get totalTokens() { return stats.total; } }, agentKey: 'investigator_hpa' });
    const progress = new RepairProgress(), completedCalls = new Map();
    let evidenceRevision = 0;
    if (!Array.isArray(genes) || !genes.length || genes.some(gene => typeof gene !== 'string' || !gene.trim())) throw new Error('Bulk Investigator requires a nonempty array of gene names');
    if (typeof question !== 'string' || !question.trim()) throw new Error('Bulk Investigator requires a question');
    if (ctx.inputRows && ctx.inputRows.length !== genes.length) throw new Error('Bulk input rows do not match the supplied list');
    await control.checkpoint('Resolve bulk sources');
    release = await resolveAgentMode(mode, [FILES.master]);
    if (release.mode !== 'offline') throw new Error('Bulk Investigator requires the local release');
    await emit('start', 'Bulk Investigator', `${genes.length} supplied genes. Question: ${question}`);
    resolved = await adapter.resolveGenes(genes);
    const ops = createBulkTools({ supplied: genes, resolved, inputRows: ctx.inputRows, adapter });
    const inputColumns = [...new Set(['gene', 'ensembl', ...(ctx.inputRows ? columnsOf(ctx.inputRows) : [])])];
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Supplied list: ${genes.length} genes; ${resolved.filter(Boolean).length} resolved in this release. The full list is held by apply_bulk.${ctx.inputRows ? `\nExisting input: ${inputColumns.length} columns retained by apply_bulk. inspect_input discovers their exact names and prior values if needed.` : ''}\nQuestion: ${question}${ctx.studyTask ? `\nAssigned plan result: ${ctx.studyTask}` : ''}\n\nComplete source directory (inspect_table for exact schemas and definitions):\n${sourceDirectory(await adapter.catalog())}` }];
    for (;;) {
      await control.checkpoint('Bulk decision', true);
      const response = await inference.chat.completions.create({ messages, tools: TOOLS, temperature: 0, ...(ctx.reasoningEffort ? { reasoning_effort: ctx.reasoningEffort } : {}) });
      const usage = response.usage || {};
      stats.prompt += usage.prompt_tokens || 0; stats.completion += usage.completion_tokens || 0; stats.total = stats.prompt + stats.completion;
      await control.checkpoint('Bulk decision: returned');
      const message = { ...response.choices?.[0]?.message, role: 'assistant' };
      messages.push(message);
      const calls = message.tool_calls || [];
      if (!calls.length) {
        progress.record({ issue: 'no_tool_call', evidenceRevision }, 'Investigator repeated a response without a source action or a validated finish');
        messages.push({ role: 'user', content: 'Use apply_bulk to obtain the requested evidence, or finish with the requirements that cannot be answered.' }); continue;
      }
      for (const call of calls) {
        let result;
        let requestKey = fingerprint(call.function);
        await control.checkpoint('Bulk tool');
        try {
          const name = call.function.name;
          const spec = TOOLS.find(tool => tool.function.name === name);
          if (!spec) throw new Error(`Unknown Investigator tool ${name}`);
          const args = JSON.parse(call.function.arguments);
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
          if (name === 'apply_bulk') {
            if (results.has(args.name)) throw new Error(`Result ${args.name} already exists; choose a new name for a revised lookup`);
            await emit('execution_step', 'apply_bulk', `${args.name}: ${args.lookups.length} lookups across ${genes.length} genes`);
            const table = await ops.applyBulk(args);
            results.set(table.name, table);
            result = receipt(table);
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
            const view = previewRows(raw, columns, 2048);
            const sample = view.rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
            const definitions = sourceDefinitions(adapter, { ...entry, columns }, sample, args.terms);
            result = { table: entry.file, description: entry.description, columns, column_count: entry.columns.length, key: entry.key, ...(entry.why ? { access_note: entry.why } : {}), sample: { gene: gene?.gene, columns, rows: sample.map(row => columns.map(column => row[column])), more: view.more }, definitions, ...(args.terms ? { undefined_terms: args.terms.filter(term => !definitions[term]) } : {}) };
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
              if (['name', 'rows', 'offset', 'columns', 'cell'].some(key => args[key] !== undefined)) throw new Error('A view continuation takes only view and text_offset');
              result = views.read(args);
            } else {
              if (args.text_offset !== undefined) throw new Error('text_offset requires a saved view; offset selects table rows');
              const table = results.get(args.name);
              if (!table) throw new Error(`No saved result ${args.name}; available: ${[...results.keys()].join(', ')}`);
              let selection;
              if (args.cell !== undefined) {
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
            if (args.results.some(name => !results.has(name))) throw new Error('finish results must name existing apply_bulk outputs');
            if (!args.results.length && !args.not_in_release.length && !args.remaining_for_aso?.length) throw new Error('Return result tables or explain which requirements remain unanswered');
            const tables = [...new Set(args.results)].map(name => results.get(name));
            await emit('complete', 'Bulk answer', args.answer);
            return { bulk: true, found: tables.length > 0, status: args.not_in_release.length || args.remaining_for_aso?.length ? 'partial' : 'ok', answer: args.answer, tables, not_in_release: args.not_in_release, remaining_for_aso: args.remaining_for_aso || [], input_count: genes.length, unresolved_inputs: resolved.filter(gene => !gene).length, mode: 'offline', hpa_version: release.hpaVersion, tokens: { total: stats }, seconds: (Date.now() - started) / 1000 };
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
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
  } catch (error) {
    await emit('error', 'Bulk Investigator', error.message);
    const stop = error instanceof AgentStop ? { stop_reason: error.reason, incomplete: true } : {};
    if (results.size) return { bulk: true, found: true, status: 'partial', ...stop, error: error.message, answer: 'Investigator stopped before completing its assignment. Completed lookup tables are retained; their existence does not establish that every requirement was fulfilled.', tables: [...results.values()], not_in_release: [], remaining_for_aso: [{ requirement: ctx.studyTask || question, why: error.message }], input_count: genes.length, unresolved_inputs: resolved.filter(gene => !gene).length, mode: 'offline', hpa_version: release.hpaVersion, tokens: { total: stats }, seconds: (Date.now() - started) / 1000 };
    return { bulk: true, found: false, status: 'incomplete', ...stop, error: error.message, mode: 'offline', tokens: { total: stats } };
  }
}

module.exports = investigatorBulk;
