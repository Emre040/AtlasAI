'use strict';

const { inference } = require('../../inference/gateway');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { FILES } = require('../../hpa/localData');
const { validate } = require('../aso/batchOperations');
const { APPLY_BULK, createBulkTools } = require('./investigatorBulkTools');
const { columnsOf } = require('../aso/studyTools');
const { previewRows, rowPageOptions } = require('../aso/observationViews');

const SYSTEM = `You are Investigator. Answer the supplied question for the supplied list of genes using the release's source tables. The tool layer holds the full list; its size does not require one model call per gene. You discover where the data is and apply the same lookup to the whole list.

Use apply_bulk to read exact values. Choose the source table, its gene-matching column, value column, and any tissue/cell/cohort filters from the catalog. Several scalar lookups combine into one result, retaining the input's existing measurements. Request all measurements needed together. A row-mode lookup retains entity labels and raw rows, optionally the top rows per gene. Use explicit aggregates only when requested or needed to represent repeated source measurements; never silently select one repeated row. Simple derived comparisons and requested ranking use apply_bulk's derive and sort options. Missing values and zero denominators stay missing.

The supplied list is already chosen. Do not redefine its biological inclusion criteria. You retrieve source data and compute per-input statistics and requested ranking. ASO owns set combinations, counts across different cohorts, correlations and figures. A union list does not establish which input belongs to which cohort. If the assignment includes such work, return the measurements and identify that work in remaining_for_aso; do not reread sources trying to reconstruct cohort membership. Respect the exact source cohort, unit, evidence strength and requested statistic. A category value is not a measured concentration; a missing table row is not proof of biological absence. When the source cannot establish part of the question, retain that part as not_in_release. Do not add mechanistic explanations absent from the source.

Inspect a source table only if its schema or sample rows are needed to choose the lookup. Use returned source coverage to correct failed or ambiguous lookups. Full results stay in the tool layer. Their receipts give bounded previews; use open_result to inspect other saved rows when needed, without rereading the source. You do not need to see every row to return a complete table. finish names the result tables to return and gives a concise source-supported explanation, without copying lists of values. Return all requested results, including missingness and unanswered requirements. When an assigned plan result is provided, fulfill that result as well as the question: returning raw rows alone does not fulfill requested statistics, comparisons or top rows. Only report unfinished work explicitly present in your question or assigned result.`;

const TOOLS = [APPLY_BULK,
  { type: 'function', function: { name: 'inspect_table', description: 'Inspect exact columns, metadata and a few source rows for one supplied gene before choosing a bulk lookup.', parameters: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] } } },
  { type: 'function', function: { name: 'open_result', description: 'Read a page of a saved apply_bulk result. Use this for rows beyond its preview; do not repeat source lookups to see already returned data.', parameters: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'integer', description: 'Requested page size, 1 to 200; default 10. The byte limit may shorten the page.' }, offset: { type: 'integer', description: 'Zero-based row offset; default 0.' }, columns: { type: 'array', items: { type: 'string' } } }, required: ['name'] } } },
  { type: 'function', function: { name: 'finish', description: 'Return the named complete result tables without transcribing their rows. Preserve unanswered requirements.', parameters: { type: 'object', properties: {
    results: { type: 'array', items: { type: 'string' } }, answer: { type: 'string' },
    not_in_release: { type: 'array', items: { type: 'object', properties: { requirement: { type: 'string' }, why: { type: 'string' } }, required: ['requirement', 'why'] } },
    remaining_for_aso: { type: 'array', description: 'Work explicitly requested in your question or assigned result that ASO still needs to perform. Do not list other study tasks. This is not missing source data.', items: { type: 'object', properties: { requirement: { type: 'string' }, why: { type: 'string' } }, required: ['requirement', 'why'] } }
  }, required: ['results', 'answer', 'not_in_release'] } } }
];

// Only a bounded preview enters inference. The returned result retains every supplied row.
function receipt(table) {
  const details = { name: table.name, rows: table.rows.length, columns: table.columns, coverage: table.coverage, sources: table.provenance, calculations: table.calculations, sort: table.sort, unresolved_inputs: table.unresolved_inputs };
  const selected = table.columns.filter(key => !/_source_rows$|_missing_rows$/.test(key)).slice(0, 12);
  const view = previewRows(table.rows, selected, 2048, table.rows.length <= 40 ? 40 : 2);
  details.preview = { columns: selected, rows: view.rows.map(row => selected.map(key => row[key])), more: view.more, next_offset: view.rows.length };
  return details;
}

async function investigatorBulk({ genes, question, mode = 'offline' }, ctx = {}, adapter = require('../../hpa/geneDataAdapter')) {
  const started = Date.now();
  const stats = { prompt: 0, completion: 0, total: 0 };
  const results = new Map();
  let release, resolved = [];
  const { onStep } = ctx;
  const emit = (stage, label, message) => onStep?.({ stage, label, message });
  try {
    if (!Array.isArray(genes) || !genes.length || genes.some(gene => typeof gene !== 'string' || !gene.trim())) throw new Error('Bulk Investigator requires a nonempty array of gene names');
    if (typeof question !== 'string' || !question.trim()) throw new Error('Bulk Investigator requires a question');
    if (ctx.inputRows && ctx.inputRows.length !== genes.length) throw new Error('Bulk input rows do not match the supplied list');
    release = await resolveAgentMode(mode, [FILES.master]);
    if (release.mode !== 'offline') throw new Error('Bulk Investigator requires the local release');
    await emit('start', 'Bulk Investigator', `${genes.length} supplied genes. Question: ${question}`);
    resolved = await adapter.resolveGenes(genes);
    const ops = createBulkTools({ supplied: genes, resolved, inputRows: ctx.inputRows, adapter });
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Supplied list: ${genes.length} genes; ${resolved.filter(Boolean).length} resolved in this release. The full list is held by apply_bulk.${ctx.inputRows ? `\nExisting input columns retained by apply_bulk: ${JSON.stringify(columnsOf(ctx.inputRows))}. These columns are available to derive expressions; do not retrieve them again.` : ''}\nQuestion: ${question}${ctx.studyTask ? `\nAssigned plan result: ${ctx.studyTask}` : ''}\n\nCatalog:\n${await adapter.overview()}` }];
    for (let turn = 1; turn <= 8; turn++) {
      if (turn === 7) messages.push({ role: 'user', content: 'Two model turns remain. Return the completed result tables with finish. State unfinished work in remaining_for_aso or unavailable source evidence in not_in_release. Do not repeat completed lookups.' });
      const response = await inference.chat.completions.create({ messages, tools: TOOLS, temperature: 0, ...(ctx.reasoningEffort ? { reasoning_effort: ctx.reasoningEffort } : {}) });
      const usage = response.usage || {};
      stats.prompt += usage.prompt_tokens || 0; stats.completion += usage.completion_tokens || 0; stats.total = stats.prompt + stats.completion;
      const message = { ...response.choices?.[0]?.message, role: 'assistant' };
      messages.push(message);
      const calls = message.tool_calls || [];
      if (!calls.length) { messages.push({ role: 'user', content: 'Use apply_bulk to obtain the requested evidence, or finish with the requirements that cannot be answered.' }); continue; }
      for (const call of calls) {
        let result;
        try {
          const name = call.function.name;
          const spec = TOOLS.find(tool => tool.function.name === name);
          if (!spec) throw new Error(`Unknown Investigator tool ${name}`);
          const args = JSON.parse(call.function.arguments);
          validate(args, spec.function.parameters, name);
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
            const sample = gene ? (await adapter.read(gene, entry.file)).rows.slice(0, 2) : [];
            result = { table: entry.file, description: entry.description, columns: entry.columns, bytes: entry.bytes, ...(Buffer.byteLength(JSON.stringify(sample)) <= 4096 ? { sample } : { sample_omitted: 'Rows exceed preview size; exact columns are listed.' }) };
          } else if (name === 'open_result') {
            const table = results.get(args.name);
            if (!table) throw new Error(`No saved result ${args.name}; available: ${[...results.keys()].join(', ')}`);
            const { rows, offset } = rowPageOptions(args);
            const columns = args.columns || table.columns.slice(0, 12);
            if (!columns.length || columns.some(key => !table.columns.includes(key))) throw new Error(`Choose result columns from ${table.columns.join(', ')}`);
            const view = previewRows(table.rows.slice(offset, offset + rows), columns, 4096);
            result = { name: table.name, columns, rows: view.rows.map(row => columns.map(key => row[key])), offset, total: table.rows.length, more: offset + view.rows.length < table.rows.length, next_offset: offset + view.rows.length };
          } else {
            if (args.results.some(name => !results.has(name))) throw new Error('finish results must name existing apply_bulk outputs');
            if (!args.results.length && !args.not_in_release.length && !args.remaining_for_aso?.length) throw new Error('Return result tables or explain which requirements remain unanswered');
            const tables = [...new Set(args.results)].map(name => results.get(name));
            await emit('complete', 'Bulk answer', args.answer);
            return { bulk: true, found: tables.length > 0, status: args.not_in_release.length || args.remaining_for_aso?.length ? 'partial' : 'ok', answer: args.answer, tables, not_in_release: args.not_in_release, remaining_for_aso: args.remaining_for_aso || [], input_count: genes.length, unresolved_inputs: resolved.filter(gene => !gene).length, mode: 'offline', hpa_version: release.hpaVersion, tokens: { total: stats }, seconds: (Date.now() - started) / 1000 };
          }
        } catch (error) {
          result = { error: error.message };
          await emit('reasoning_step', 'Correct bulk lookup', error.message);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error('Bulk Investigator did not finish within eight turns');
  } catch (error) {
    await emit('error', 'Bulk Investigator', error.message);
    if (results.size) return { bulk: true, found: true, status: 'partial', error: error.message, answer: 'Investigator stopped before completing its assignment. Completed lookup tables are retained; their existence does not establish that every requirement was fulfilled.', tables: [...results.values()], not_in_release: [], remaining_for_aso: [{ requirement: ctx.studyTask || question, why: error.message }], input_count: genes.length, unresolved_inputs: resolved.filter(gene => !gene).length, mode: 'offline', hpa_version: release.hpaVersion, tokens: { total: stats }, seconds: (Date.now() - started) / 1000 };
    return { bulk: true, found: false, error: error.message, mode: 'offline', tokens: { total: stats } };
  }
}

module.exports = investigatorBulk;
