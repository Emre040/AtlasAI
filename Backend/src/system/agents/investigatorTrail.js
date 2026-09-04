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

const MAX_TABLES = 3;

const PLAN_SYSTEM = `You are answering a question about one gene from a database of per-gene tables. You are given the catalog: every table with the database's own description of it and its columns.

Choose which tables to read for this gene. Return JSON: { "understanding": "<what the question asks, in the database's terms>", "reads": [ { "table": "<file name exactly as listed>", "focus": ["<words that identify the rows or columns needed, if the question names a tissue, cell type, cancer, sample group or similar; else empty>"], "where": [ { "column": "<column name>", "op": ">" | ">=" | "<" | "<=" | "=" | "!=" | "contains", "value": "<value>" } ], "why": "<one sentence>" } ], "cannot": [ { "requirement": "<part of the question>", "why": "<why no table holds it>" } ] }
Rules:
- Use table names exactly as listed. At most three tables; prefer the one whose description and columns match the question's measure and unit.
- Focus words narrow a long table to the rows that matter (a cell line name, a tissue) and, in a table with one column per sample, pick which columns are shown; leave the list empty when the question needs the whole table (a maximum, a ranking).
- A threshold or a count ("above 100", "how many … below") is a "where" filter on a column, applied exactly by the database before the rows are shown; the number of matching rows is then reported to you. Never count by eye.
- When no table holds what the question asks, put the requirement in "cannot" rather than reading an unrelated table.`;

const ANSWER_SYSTEM = `You are answering a question about one gene using rows read from the database. Use only what the rows say; nothing from memory.

Return JSON: { "found": true | false, "answer": "<the answer, with the value and its unit or category name>", "value": "<the exact value or category as written in the row, or null>", "entity": "<the tissue, cell type or other row label the value belongs to, or null>", "table": "<file name the row came from>", "cited_row": "<the row you used, copied verbatim from the rows shown>", "confidence": "high" | "medium" | "low", "notes": ["<anything a careful reader should know: ties, near-misses, other rows worth mentioning>"], "need_more": null | { "table": "<file name>", "focus": ["<words naming the rows or columns you still need>"], "where": [ { "column": "...", "op": "...", "value": "..." } ] } }
Rules:
- The cited row must be copied exactly from the rows shown; the answer is rejected if it cannot be found among them.
- A maximum, minimum or ranking is read across all rows shown; say so in the notes if only part of the table was shown.
- When a note says rows or columns were left out and the answer needs them, do not answer from the part shown: set found to false and fill "need_more" with the table and the focus words or filter that would bring the missing rows or columns. You get one more read.
- If the rows do not contain what the question asks, set found to false and say what is missing.`;

async function investigatorTrail({ gene: geneQuery, question, mode: requestedMode = 'offline' }, { onStep } = {}, adapter = require('../../hpa/geneDataAdapter')) {
  const startedAt = Date.now();
  const stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, perStep: {} };
  const q = question || `Tell me about ${geneQuery}`;
  await onStep?.({ stage: 'start', message: `Investigator (trail) activated. Gene: ${geneQuery}. Question: "${q}"` });
  try {
    const agentMode = await resolveAgentMode(requestedMode, [FILES.master]);
    if (agentMode.mode !== 'offline') throw new Error(`The investigator needs the local release: ${agentMode.note || 'not available'}`);
    const gene = await adapter.resolveGene(geneQuery);
    if (!gene) return { found: false, error: `Gene "${geneQuery}" not found in the release`, mode: 'offline' };
    await onStep?.({ stage: 'selection_step', label: 'Resolved', message: `${gene.gene} (${gene.ensembl})` });

    // 1. Which tables, from the catalog.
    await onStep?.({ stage: 'planning_step', label: 'Plan', message: 'Reading the catalog of per-gene tables' });
    const plan = await jsonCall(PLAN_SYSTEM, `Gene: ${gene.gene} (${gene.ensembl})\nQuestion: "${q}"\n\nCatalog:\n${await adapter.overview()}`, onStep, 'Plan', stats);
    if (plan.understanding) await onStep?.({ stage: 'reasoning_step', label: 'Understood', message: plan.understanding });
    const cannot = Array.isArray(plan.cannot) ? plan.cannot.filter(c => c && c.requirement) : [];
    for (const c of cannot) await onStep?.({ stage: 'reasoning_step', label: 'Not in the release', message: `${c.requirement}: ${c.why || ''}` });
    const asRead = r => ({ table: String(r?.table || '').trim(), focus: Array.isArray(r?.focus) ? r.focus.map(String).filter(Boolean) : [], where: Array.isArray(r?.where) ? r.where : [], why: r?.why || '' });
    const reads = [];
    for (const r of (Array.isArray(plan.reads) ? plan.reads : []).slice(0, MAX_TABLES).map(asRead)) {
      const e = r.table ? await adapter.entry(r.table) : null;
      if (!e) { await onStep?.({ stage: 'reasoning_step', label: 'Unknown table', message: r.table }); continue; }
      reads.push({ ...r, entry: e });
    }
    if (!reads.length) {
      if (cannot.length) return { found: false, error: `The release has no table for: ${cannot.map(c => c.requirement).join('; ')}`, not_in_release: cannot, gene: gene.gene, ensembl: gene.ensembl, mode: 'offline', hpa_version: agentMode.hpaVersion, tokens: tokensOut(stats) };
      throw new Error('No table could be chosen from the catalog.');
    }

    // 2. Read the gene's rows; a filter from the plan is applied exactly before rendering.
    const readings = [];
    const readOne = async r => {
      const raw = await adapter.read(gene, r.entry.file);
      let { reading, clauses } = adapter.applyWhere(raw, r.where);
      // A filter that matches nothing (two equalities on one column, a misspelt value) must not
      // hide the table: fall back to the unfiltered rows and let the answer step see them.
      if (clauses.length && !reading.rows.length && raw.rows.length) {
        await onStep?.({ stage: 'reasoning_step', label: 'Filter matched nothing', message: `${r.entry.file}: ${clauses.map(c => `${c.column} ${c.op} ${c.value}`).join(' and ')}; showing all ${raw.rows.length} rows instead` });
        reading = raw; clauses = [];
      }
      const rendered = adapter.render(reading, r.focus);
      await onStep?.({ stage: 'execution_step', label: 'Read', message: `${r.entry.file}: ${rendered.total} rows for ${gene.gene}${clauses.length ? `, ${reading.rows.length} match ${clauses.map(c => `${c.column} ${c.op} ${c.value}`).join(' and ')}` : ''}${rendered.shown < reading.rows.length ? `, ${rendered.shown} shown` : ''}${r.why ? ' — ' + r.why : ''}` });
      readings.push({ ...r, reading, rendered });
    };
    for (const r of reads) await readOne(r);

    // 3. Answer from the rows, with a citation that must exist; one more read if the model says
    //    the rows it needs were left out, one retry if the citation is not among the rows shown.
    let user = `Gene: ${gene.gene} (${gene.ensembl})\nQuestion: "${q}"\n\nRows read:\n${readings.map(r => r.rendered.text).join('\n\n')}`;
    let answer = null;
    let grounded = false;
    let extraRead = false;
    for (let attempt = 0; attempt < 3 && !grounded; attempt++) {
      answer = await jsonCall(ANSWER_SYSTEM, user, onStep, attempt ? 'Answer again' : 'Answer', stats);
      if (answer.found === false) {
        const more = answer.need_more && typeof answer.need_more === 'object' ? asRead(answer.need_more) : null;
        const e = more?.table && !extraRead ? await adapter.entry(more.table) : null;
        if (e) {
          extraRead = true;
          await onStep?.({ stage: 'reasoning_step', label: 'Reading more', message: `${e.file}${more.focus.length ? ' with focus ' + more.focus.join(', ') : ''}${more.where.length ? ' filtered' : ''}` });
          await readOne({ ...more, entry: e });
          user = `Gene: ${gene.gene} (${gene.ensembl})\nQuestion: "${q}"\n\nRows read:\n${readings.map(r => r.rendered.text).join('\n\n')}`;
          continue;
        }
        grounded = true;
        break;
      }
      const source = readings.find(r => r.entry.file === String(answer.table || '').trim()) || readings[0];
      grounded = Boolean(source) && adapter.cited(source.reading, answer.cited_row, answer.value);
      if (!grounded) {
        await onStep?.({ stage: 'reasoning_step', label: 'Citation not found', message: `"${String(answer.cited_row || '').slice(0, 120)}" is not among the rows shown; asking again` });
        user += `\n\nYour previous answer cited a row that is not among the rows shown. Copy the row exactly as it appears above, or set found to false.`;
      }
    }
    const found = answer.found === true && grounded;
    for (const note of (Array.isArray(answer.notes) ? answer.notes : []).slice(0, 4)) await onStep?.({ stage: 'reasoning_step', label: 'Note', message: String(note) });
    const finishedAt = Date.now();
    await onStep?.({ stage: found ? 'complete' : 'not_found', label: found ? 'Answer' : 'Not found', message: answer.answer || 'The rows read do not answer the question' });
    await onStep?.({ stage: 'planning_step', label: 'Timer', message: `Total runtime: ${((finishedAt - startedAt) / 1000).toFixed(1)}s` });
    await onStep?.({ stage: 'planning_step', label: 'Token Usage', message: `Input tokens: ${stats.promptTokens} | Output tokens: ${stats.completionTokens} | Total: ${stats.totalTokens}` });
    const sourceEntry = readings.find(r => r.entry.file === String(answer.table || '').trim())?.entry || readings[0].entry;
    return {
      found,
      answer: answer.answer || '',
      source_section: `${sourceEntry.title} (${sourceEntry.file})`,
      confidence: found ? (answer.confidence || 'medium') : 'low',
      reasoning: plan.understanding || '',
      extracted_value: answer.value ?? null,
      notes: Array.isArray(answer.notes) ? answer.notes : [],
      chart_id: sourceEntry.file.replace(/\.tsv$/, ''),
      exact_label: answer.entity ?? null,
      cited_row: answer.cited_row || null,
      grounded,
      not_in_release: cannot,
      gene: gene.gene,
      ensembl: gene.ensembl,
      baseUrl: adapter.pageUrl(gene),
      mode: 'offline',
      hpa_version: agentMode.hpaVersion,
      pages_fetched: readings.map(r => r.entry.file),
      citations: readings.map(r => ({ page: r.entry.file, title: r.entry.title, url: adapter.pageUrl(gene), rows: r.rendered.total })),
      tokens: tokensOut(stats),
      validation: { passed: found ? 1 : 0, total: 1, checks: [{ check: 'Cited row exists in the rows read', pass: grounded }] }
    };
  } catch (err) {
    await onStep?.({ stage: 'error', label: 'Error', message: err.message });
    return { found: false, error: err.message, mode: 'offline', tokens: tokensOut(stats) };
  }
}

function tokensOut(stats) {
  return { total: { prompt: stats.promptTokens, completion: stats.completionTokens, total: stats.totalTokens }, steps: stats.perStep };
}

module.exports = investigatorTrail;
