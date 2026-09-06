'use strict';

/**
 * Investigator, trail version.
 *
 * A gene and a question in; an answer with the exact rows it rests on out. The agent knows
 * nothing about the atlas: the adapter gives it a catalog of the release's per-gene tables (each
 * with the atlas's own description and columns), it chooses which tables to read, reads the
 * gene's rows, and answers from those rows only. Every answer must cite a row it was shown, and
 * the citation is checked against the rows before the answer is accepted.
 */

const { jsonCall } = require('../../inference/jsonCall');
const { resolveAgentMode } = require('../../hpa/agentMode');
const { FILES } = require('../../hpa/localData');
const { isMissing } = require('../aso/studyTools');
const { AgentStop, RepairProgress, createAgentControl, fingerprint } = require('../aso/agentControl');

const PLAN_SYSTEM = `You are answering a question about one gene from a database of per-gene tables. You are given the catalog: every table with the database's own description of it and its columns.

Choose which tables to read for this gene. Return JSON: { "understanding": "<what the question asks, in the database's terms>", "reads": [ { "table": "<file name exactly as listed>", "focus": ["<words that identify the rows or columns needed, if the question names a tissue, cell type, cancer, sample group or similar; else empty>"], "where": [ { "column": "<column name>", "op": ">" | ">=" | "<" | "<=" | "=" | "!=" | "contains" | "in" | "is_missing" | "is_present" | "is_numeric" | "is_non_numeric", "value": "<comparison value; omit for unary predicates>" } ], "why": "<one sentence>" } ], "cannot": [ { "requirement": "<part of the question>", "why": "<why no table holds it>" } ] }
Rules:
- Use table names exactly as listed. Read only the sources needed for the requested evidence, preserving each source's measure, unit and scope.
- Focus words narrow a long table to the rows that matter (a cell line name, a tissue) and, in a table with one column per sample, pick which columns are shown; leave the list empty when the question needs the whole table (a maximum, a ranking).
- A threshold or a count ("above 100", "how many … below") is a "where" filter on a column, applied exactly by the database before the rows are shown; the number of matching rows is then reported to you. Never count by eye.
- Use is_missing for null/blank/NA cells; is_present for recorded cells; is_numeric for finite numeric values including zero and negatives; is_non_numeric for present nonnumeric values, excluding missing cells. These four predicates take only column and op, without value. They filter existing source rows; they cannot establish whether an absent row was ever assayed.
- A read may additionally specify columns=[exact source column names], rows=<requested page size>, and offset=<zero-based row offset>. Choose relevant columns for wide tables. These options affect the displayed view, not source filters or coverage counts.
- When no table holds what the question asks, put the requirement in "cannot" rather than reading an unrelated table.`;

const ANSWER_SYSTEM = `You are answering a question about one gene using rows read from the database. Use only what the rows say; nothing from memory.

Return JSON: { "found": true | false, "answer": "<the answer, with the value and its unit or category name>", "value": "<the exact value or category as written in the row, or null>", "entity": "<the tissue, cell type or other row label the value belongs to, or null>", "table": "<exact file name read>", "cited_row": "<the row you used, copied verbatim from the rows shown, or null>", "cited_coverage": null | { "read_id": "<read ID>", "table": "<exact source file>", "metric": "source_rows" | "matching_rows", "value": <exact count> }, "confidence": "high" | "medium" | "low", "notes": ["<source limitations, ties or other requested evidence>"], "need_more": null | { "table": "<file name>", "focus": ["<words naming the rows or columns you still need>"], "where": [ { "column": "...", "op": "...", "value": "..." } ] } }
Rules:
- When supplied, the cited row must be copied exactly from the rows shown; the answer is rejected if it cannot be found among them.
- When citing a row, value must be recorded in that row. You may additionally cite runtime coverage as scope evidence; its count is validated separately from the row value. Both supplied citations must be valid.
- For a source-row count answer, use cited_row=null and cited_coverage with the exact read ID and reported source_rows or matching_rows, including zero matches; value must equal that count. A row count is not a count of nonmissing measurements or distinct entities.
- A maximum, minimum or ranking is read across all rows shown; say so in the notes if only part of the table was shown.
- When a note says rows or columns were left out and the answer needs them, set found to false and fill "need_more" with the table and the focus words or filter that would bring the missing evidence. Request a new source view when needed; previously read evidence remains available.
- need_more filters also support is_missing, is_present, is_numeric and is_non_numeric with column and op only. Missing is null/blank/NA; non_numeric excludes missing cells, and numeric includes zero and negatives.
- need_more can also specify columns, rows and offset for an exact source view. Use explicit columns when their names are known; avoid retrieving unrelated fields.
- If the rows do not contain what the question asks, set found to false and say what is missing. No source rows, no filter matches, and a blank measurement are distinct. A missing record does not establish biological absence or whether an experiment ever occurred. State source/release coverage only; do not invent a reason for missing data.`;

function coverageFor(read) {
  const { reading, rendered } = read;
  const columns = read.entry.columns || [];
  const shownColumns = reading.shownColumns || columns;
  const unrecordedColumns = columns.filter(column => reading.rows.length > 0 && reading.rows.every(row => isMissing(row[column])));
  return { read_id: read.id, table: read.entry.file, source_rows: read.sourceRows, matching_rows: reading.rows.length, shown_rows: rendered.shown, where: read.clauses, focus: read.focus, view: read.view, columns, shown_columns: shownColumns, unrecorded_columns: unrecordedColumns, complete_rows: rendered.shown === reading.rows.length, complete_columns: columns.length > 0 ? shownColumns.length === columns.length : null };
}

function evidenceText(readings) {
  return readings.map(read => {
    const { columns, shown_columns, unrecorded_columns, complete_columns, ...coverage } = coverageFor(read);
    return `READ ${read.id}\nVerified source coverage: ${JSON.stringify(coverage)}\n${read.rendered.text}`;
  }).join('\n\n');
}

function coverageCitation(citation, sources) {
  if (!citation || !['source_rows', 'matching_rows'].includes(citation.metric) || !Number.isSafeInteger(citation.value) || citation.value < 0) return null;
  const matching = sources.filter(source => source.entry.file === citation.table && (!citation.read_id || source.id === citation.read_id));
  if (matching.length !== 1) return null;
  const source = matching[0];
  return coverageFor(source)[citation.metric] === citation.value ? source : null;
}

async function investigatorTrail(args, ctx = {}, adapter = require('../../hpa/geneDataAdapter')) {
  if (args.points !== undefined || args.genes !== undefined) {
    if (args.gene !== undefined) throw new Error('Supply gene, or a list of points, not both');
    return require('./investigatorBulk')(args, ctx, adapter);
  }
  const { gene: geneQuery, question, mode: requestedMode = 'offline' } = args;
  const { onStep } = ctx;
  const startedAt = Date.now();
  const stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, perStep: {} };
  const readings = [];
  const q = question || `Tell me about ${geneQuery}`;
  await onStep?.({ stage: 'start', message: `Investigator (trail) activated. Gene: ${geneQuery}. Question: "${q}"` });
  try {
    const control = createAgentControl({ ctx, stats, agentKey: 'investigator_hpa' });
    const ask = async (system, user, label) => {
      await control.checkpoint(label, true);
      const result = await jsonCall(system, user, onStep, label, stats);
      await control.checkpoint(`${label}: returned`);
      return result;
    };
    await control.checkpoint('Resolve source');
    const agentMode = await resolveAgentMode(requestedMode, [FILES.master]);
    if (agentMode.mode !== 'offline') throw new Error(`The investigator needs the local release: ${agentMode.note || 'not available'}`);
    const gene = await adapter.resolveGene(geneQuery);
    if (!gene) return { found: false, evidence_status: 'gene_not_in_release', coverage: [], error: `Gene "${geneQuery}" not found in the release`, mode: 'offline' };
    await onStep?.({ stage: 'selection_step', label: 'Resolved', message: `${gene.gene} (${gene.ensembl})` });

    // 1. Which tables, from the catalog.
    await onStep?.({ stage: 'planning_step', label: 'Plan', message: 'Reading the catalog of per-gene tables' });
    const plan = await ask(PLAN_SYSTEM, `Gene: ${gene.gene} (${gene.ensembl})\nQuestion: "${q}"\n\nCatalog:\n${await adapter.overview()}`, 'Plan');
    if (plan.understanding) await onStep?.({ stage: 'reasoning_step', label: 'Understood', message: plan.understanding });
    const cannot = Array.isArray(plan.cannot) ? plan.cannot.filter(c => c && c.requirement) : [];
    for (const c of cannot) await onStep?.({ stage: 'reasoning_step', label: 'Not in the release', message: `${c.requirement}: ${c.why || ''}` });
    const asRead = r => {
      if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.table !== 'string' || !r.table.trim()) throw new Error('A source read needs an exact table name');
      for (const field of ['focus', 'where', 'columns']) if (r[field] !== undefined && !Array.isArray(r[field])) throw new Error(`Read ${r.table}.${field} must be an array`);
      if (r.focus?.some(value => typeof value !== 'string') || r.columns?.some(value => typeof value !== 'string')) throw new Error('Source focus and columns must contain strings');
      if (r.rows !== undefined && (!Number.isSafeInteger(r.rows) || r.rows < 1)) throw new Error('Requested source rows must be a positive integer');
      if (r.offset !== undefined && (!Number.isSafeInteger(r.offset) || r.offset < 0)) throw new Error('Requested source offset must be a nonnegative integer');
      return { table: r.table.trim(), focus: r.focus || [], where: r.where || [], why: r.why || '', view: Object.fromEntries(['columns', 'rows', 'offset'].filter(key => r[key] !== undefined).map(key => [key, r[key]])) };
    };
    const reads = [];
    for (const r of (Array.isArray(plan.reads) ? plan.reads : []).map(asRead)) {
      const e = r.table ? await adapter.entry(r.table) : null;
      if (!e) throw new Error(`Unknown source table ${JSON.stringify(r.table)}; choose an exact catalog entry`);
      reads.push({ ...r, entry: e });
    }
    if (!reads.length) {
      if (cannot.length) return { found: false, evidence_status: 'source_unavailable', coverage: [], error: `The release has no table for: ${cannot.map(c => c.requirement).join('; ')}`, not_in_release: cannot, gene: gene.gene, ensembl: gene.ensembl, mode: 'offline', hpa_version: agentMode.hpaVersion, tokens: tokensOut(stats) };
      throw new Error('No table could be chosen from the catalog.');
    }

    // 2. Read the gene's rows; a filter from the plan is applied exactly before rendering.
    const requestedViews = new Map(), observedViews = new Map();
    const sortedSet = values => [...new Set(values.map(value => fingerprint(value)))].sort();
    const readOne = async r => {
      const requestKey = fingerprint({ table: r.entry.file, where: sortedSet(r.where), focus: sortedSet(r.focus), columns: r.view.columns ? sortedSet(r.view.columns) : null, rows: r.view.rows, offset: r.view.offset || 0 });
      if (requestedViews.has(requestKey)) return false;
      await control.checkpoint('Read source');
      const raw = await adapter.read(gene, r.entry.file);
      await control.checkpoint('Read source: returned');
      const { reading, clauses } = adapter.applyWhere(raw, r.where);
      const rendered = adapter.render(reading, r.focus, r.view);
      const shownColumns = [...reading.shownColumns].sort();
      const evidenceKey = fingerprint({ table: r.entry.file, where: sortedSet(clauses), source_rows: raw.rows.length, matching_rows: reading.rows.length, columns: shownColumns, rows: reading.shownRows.map(row => Object.fromEntries(shownColumns.map(column => [column, row[column]]))) });
      requestedViews.set(requestKey, evidenceKey);
      if (observedViews.has(evidenceKey)) return false;
      observedViews.set(evidenceKey, true);
      await onStep?.({ stage: 'execution_step', label: 'Read', message: `${r.entry.file}: ${rendered.total} rows for ${gene.gene}${clauses.length ? `, ${reading.rows.length} match ${clauses.map(c => `${c.column} ${c.op} ${c.value}`).join(' and ')}` : ''}${rendered.shown < reading.rows.length ? `, ${rendered.shown} shown` : ''}${r.why ? ' — ' + r.why : ''}` });
      readings.push({ ...r, id: `r${readings.length + 1}`, sourceRows: raw.rows.length, clauses, reading, rendered });
      return true;
    };
    for (const r of reads) await readOne(r);

    // 3. Accept exact evidence; continue while repairs acquire evidence or resolve a
    //    validator issue. Repeated states and explicit caller controls stop unfinished work.
    const answerInput = () => `Gene: ${gene.gene} (${gene.ensembl})\nQuestion: "${q}"\n\nRows read:\n${evidenceText(readings)}`;
    let user = answerInput();
    let answer = null;
    let grounded = false;
    let selectedSource = null;
    let selectedCoverage = null;
    let evidenceStatus = 'not_answered';
    let stopReason = null, stopMessage = null;
    const progress = new RepairProgress();
    const repair = (issue, feedback, validated = {}) => {
      try { progress.record({ evidence: observedViews.size, issue, validated }, 'Investigator repeated an unresolved decision without new source evidence'); }
      catch (err) { if (!(err instanceof AgentStop)) throw err; stopReason = err.reason; stopMessage = err.message; return false; }
      user = `${answerInput()}\n\n${feedback}`;
      return true;
    };
    for (;;) {
      answer = await ask(ANSWER_SYSTEM, user, answer ? 'Answer again' : 'Answer');
      if (!answer || typeof answer !== 'object' || typeof answer.found !== 'boolean') {
        evidenceStatus = 'invalid_answer';
        if (!repair('invalid_answer_shape', 'Return the specified answer object with found exactly true or false.')) break;
        continue;
      }
      if (answer.found === false) {
        const more = answer.need_more && typeof answer.need_more === 'object' ? asRead(answer.need_more) : null;
        const e = more?.table ? await adapter.entry(more.table) : null;
        if (more?.table && !e) throw new Error(`Unknown requested source table ${JSON.stringify(more.table)}`);
        if (e) {
          await onStep?.({ stage: 'reasoning_step', label: 'Reading more', message: `${e.file}${more.focus.length ? ' with focus ' + more.focus.join(', ') : ''}${more.where.length ? ' filtered' : ''}` });
          if (await readOne({ ...more, entry: e })) user = answerInput();
          else if (!repair('repeated_source_view', 'That source view is already in the evidence above. Use its exact citation, request evidence not yet available, or state what remains unanswered.')) break;
          continue;
        }
        selectedSource = readings.find(read => read.entry.file === String(answer.table || '').trim()) || null;
        if (String(answer.table || '').trim() && !selectedSource) {
          evidenceStatus = 'invalid_citation';
          if (!repair('unknown_source', 'Your stated source was not read. Name an exact table from the source evidence above, or leave table empty when the requested evidence is unavailable.')) break;
          continue;
        }
        const coverage = selectedSource ? coverageFor(selectedSource) : null;
        evidenceStatus = selectedSource && selectedSource.sourceRows === 0 ? 'no_gene_rows' : selectedSource && selectedSource.reading.rows.length === 0 ? 'no_matching_rows'
          : coverage && coverage.shown_columns.length > 0 && coverage.shown_columns.every(column => coverage.unrecorded_columns.includes(column)) ? 'no_recorded_values'
            : selectedSource && selectedSource.rendered.shown === 0 ? 'no_view_matches' : 'not_answered';
        grounded = ['no_gene_rows', 'no_matching_rows', 'no_recorded_values', 'no_view_matches'].includes(evidenceStatus);
        break;
      }
      const sources = readings.filter(read => read.entry.file === String(answer.table || '').trim());
      const hasRow = answer.cited_row !== undefined && answer.cited_row !== null;
      const hasCoverage = answer.cited_coverage !== undefined && answer.cited_coverage !== null;
      const rowSource = hasRow ? sources.find(source => adapter.cited(source.reading, answer.cited_row, answer.value)) || null : null;
      const coverageSource = hasCoverage ? coverageCitation(answer.cited_coverage, sources) : null;
      const countValueMatches = coverageSource && ['number', 'string'].includes(typeof answer.value) && String(answer.value).trim() !== '' && Number(answer.value) === answer.cited_coverage.value;
      grounded = Boolean(hasRow ? rowSource && (!hasCoverage || coverageSource) : coverageSource && countValueMatches);
      selectedSource = grounded ? hasRow ? rowSource : coverageSource : null;
      selectedCoverage = grounded ? coverageSource : null;
      evidenceStatus = grounded ? hasRow ? 'observed' : 'coverage' : 'invalid_citation';
      if (!grounded) {
        const knownRow = hasRow && sources.some(source => adapter.cited(source.reading, answer.cited_row));
        const issue = !sources.length ? 'unknown_source' : hasRow && !rowSource ? knownRow ? 'invalid_value' : 'invalid_row' : hasCoverage && !coverageSource ? 'invalid_coverage' : !hasRow && coverageSource ? 'invalid_coverage_value' : 'missing_citation';
        const feedback = issue === 'invalid_value' ? 'Your row citation is valid, but the supplied value is not recorded in that row. Return the exact value from that row, or request the evidence the question needs.'
          : issue === 'invalid_coverage' ? 'Your supplied coverage citation does not match a unique source read and its exact runtime count. Correct its read_id, table, metric and value, or omit it when the answer only cites a row. A valid row cannot make an incorrect coverage count valid.'
            : issue === 'invalid_coverage_value' ? 'Your coverage citation is valid, but a coverage-only answer must set value to its exact count and cited_row to null. To answer with a measurement or category, cite the exact shown row and its value instead.'
              : 'Your citation is not verified. The table must exactly name a source read above. Copy a shown row exactly and use a value recorded in it, or set cited_row to null and cite an exact runtime coverage count. Every supplied row and coverage citation must be valid; one cannot substitute for the other. Otherwise set found to false.';
        await onStep?.({ stage: 'reasoning_step', label: 'Citation not verified', message: feedback });
        if (!repair(issue, feedback, sources.length ? { table: sources[0].entry.file, row: knownRow, coverage: Boolean(coverageSource) } : {})) break;
      } else {
        break;
      }
    }
    answer = answer && typeof answer === 'object' ? answer : {};
    const found = answer.found === true && grounded && !stopReason;
    const sourceEntry = selectedSource?.entry;
    const verifiedAnswer = evidenceStatus === 'no_gene_rows' ? `No rows are recorded for ${gene.gene} (${gene.ensembl}) in ${sourceEntry.file} in this release.`
      : evidenceStatus === 'no_matching_rows' ? `${sourceEntry.file} has ${selectedSource.sourceRows} source rows for ${gene.gene}; none match ${JSON.stringify(selectedSource.clauses)}.`
        : evidenceStatus === 'no_recorded_values' ? `${sourceEntry.file} has no recorded values for ${gene.gene} in the selected fields: ${coverageFor(selectedSource).shown_columns.join(', ')}.`
          : evidenceStatus === 'no_view_matches' ? `${sourceEntry.file} has ${selectedSource.reading.rows.length} matching source rows for ${gene.gene}; the selected focus or page shows no rows.`
        : evidenceStatus === 'invalid_citation' ? 'The proposed answer could not be verified against the selected source evidence.' : stopReason ? stopMessage : answer.answer || '';
    for (const note of (found && Array.isArray(answer.notes) ? answer.notes : [])) await onStep?.({ stage: 'reasoning_step', label: 'Note', message: String(note) });
    const finishedAt = Date.now();
    await onStep?.({ stage: found ? 'complete' : 'not_found', label: found ? 'Answer' : 'Not found', message: verifiedAnswer || 'The rows read do not answer the question' });
    await onStep?.({ stage: 'planning_step', label: 'Timer', message: `Total runtime: ${((finishedAt - startedAt) / 1000).toFixed(1)}s` });
    await onStep?.({ stage: 'planning_step', label: 'Token Usage', message: `Input tokens: ${stats.promptTokens} | Output tokens: ${stats.completionTokens} | Total: ${stats.totalTokens}` });
    return {
      found,
      answer: verifiedAnswer,
      evidence_status: evidenceStatus,
      ...(stopReason ? { stop_reason: stopReason, incomplete: true } : {}),
      coverage: readings.map(coverageFor),
      source_section: sourceEntry ? `${sourceEntry.title} (${sourceEntry.file})` : null,
      confidence: found ? (answer.confidence || 'medium') : 'low',
      reasoning: plan.understanding || '',
      extracted_value: found ? answer.value ?? null : null,
      notes: found && Array.isArray(answer.notes) ? answer.notes : [],
      chart_id: sourceEntry ? sourceEntry.file.replace(/\.tsv$/, '') : null,
      exact_label: found ? answer.entity ?? null : null,
      cited_row: found ? answer.cited_row || null : null,
      cited_coverage: found && selectedCoverage ? { ...answer.cited_coverage, read_id: selectedCoverage.id } : null,
      grounded,
      not_in_release: cannot,
      gene: gene.gene,
      ensembl: gene.ensembl,
      baseUrl: adapter.pageUrl(gene),
      mode: 'offline',
      hpa_version: agentMode.hpaVersion,
      pages_fetched: readings.map(r => r.entry.file),
      citations: readings.map(r => ({ page: r.entry.file, title: r.entry.title, url: adapter.pageUrl(gene), rows: r.reading.rows.length, source_rows: r.sourceRows, shown_rows: r.rendered.shown, where: r.clauses, read_id: r.id })),
      tokens: tokensOut(stats),
      validation: { passed: grounded ? 1 : 0, total: 1, checks: [{ check: evidenceStatus === 'coverage' ? 'Cited coverage matches the exact runtime source count' : ['no_gene_rows', 'no_matching_rows', 'no_recorded_values', 'no_view_matches'].includes(evidenceStatus) ? 'Source absence, missing values or view coverage verified in this release' : selectedCoverage ? 'Cited row and value exist in the exact source rows shown, and accompanying coverage matches its runtime count' : 'Cited row and value exist in the exact source rows shown', pass: grounded }] }
    };
  } catch (err) {
    await onStep?.({ stage: 'error', label: 'Error', message: err.message });
    return { found: false, grounded: false, evidence_status: err instanceof AgentStop ? 'incomplete' : 'source_error', ...(err instanceof AgentStop ? { stop_reason: err.reason, incomplete: true } : {}), coverage: readings.map(coverageFor), error: err.message, mode: 'offline', tokens: tokensOut(stats) };
  }
}

function tokensOut(stats) {
  return { total: { prompt: stats.promptTokens, completion: stats.completionTokens, total: stats.totalTokens }, steps: stats.perStep };
}

module.exports = investigatorTrail;
