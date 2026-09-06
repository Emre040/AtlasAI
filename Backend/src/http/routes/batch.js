'use strict';

const path = require('path');
const express = require('express');
const crypto = require('crypto');
const orchestrator = require('../../system/orchestrator');
const { reportFigureArtifacts } = require('../../system/aso/reportFigures');
const { inference, getActiveModel } = require('../../inference/gateway');
const { platformConfig } = require('../../policy/config');

/* ---- helpers ---- */

async function chatCompletion(messages) {
  const stream = await inference.chat.completions.create({
    messages,
    stream: true,
    stream_options: { include_usage: true }
  });
  let text = '';
  for await (const part of stream) {
    const delta = part?.choices?.[0]?.delta?.content || '';
    if (delta) text += delta;
  }
  return text.trim();
}

function initToolCallCollector() {
  const calls = [];
  return {
    addFromDelta(deltaTC = []) {
      for (const tc of deltaTC) {
        const i = tc.index ?? 0;
        if (!calls[i]) calls[i] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name = tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    },
    list() { return calls.filter(Boolean); }
  };
}

async function proposeTools(messages) {
  const coll = initToolCallCollector();
  const stream = await inference.chat.completions.create({
    messages: [
      ...messages,
      {
        role: 'system',
        content: `Choose the right tool:
(1) check_inclusion_hpa - ONLY for checking if a SPECIFIC GENE NAME is in previous results
(2) deep_research_hpa - for ANY search
(3) investigator_hpa - for detailed info about one specific gene
(4) dictionary_expert_hpa - for ANY definition, educational, histology, pathology, OR about-HPA question
    USE "question" param (not "topic") for about-HPA questions. USE "topic" param for histology/pathology.
(5) aso_hpa - Autonomous Scientific Orchestrator for MULTI-STEP analysis with charts/figures`
      }
    ],
    stream: true,
    tools: orchestrator.getToolSpecs(),
    tool_choice: 'auto'
  });
  for await (const part of stream) {
    const d = part?.choices?.[0]?.delta;
    if (d?.tool_calls) coll.addFromDelta(d.tool_calls);
  }
  return coll.list();
}

function getSynthesisPrompt(toolName, toolResult) {
  if (toolName === 'dictionary_expert_hpa') {
    const isAbout = toolResult?.result?.mode === 'about';
    if (isAbout) {
      return "The tool retrieved content from HPA about pages. Answer the user's question about the Human Protein Atlas using this content. Be informative and concise. Cite specific details.";
    }
    return "The tool retrieved educational content from the HPA Dictionary. Answer the user's original question using this content as your source. Do NOT just summarize the page.";
  }
  if (toolName === 'investigator_hpa') {
    return "Present the answer field from the result DIRECTLY and COMPLETELY to the user. Do NOT summarize or paraphrase.";
  }
  if (toolName === 'check_inclusion_hpa') {
    return "Give a clear, direct answer about whether the gene is in the results.";
  }
  if (toolName === 'aso_hpa') {
    return "Summarize what was done and the key findings. Keep it concise (3-6 sentences). Highlight the most interesting findings.";
  }
  return "Provide a brief confirmation of the search results. State the count. Do NOT list gene names.";
}

/* ---- run one query through the full pipeline ---- */

async function runQuery(queryText, db, auth) {
  const systemContent = `You are AtlasAI, a helpful assistant for exploring The Human Protein Atlas.

TOOL USAGE RULES:
1. deep_research_hpa: Use for ANY search query
2. check_inclusion_hpa: ONLY when asking if a SPECIFIC GENE NAME is in previous results
3. investigator_hpa: For detailed info about a specific gene
4. dictionary_expert_hpa: For ANY definition, histology, pathology, educational, OR about-HPA question
   USE "question" param (not "topic") for about-HPA questions. USE "topic" param for histology/pathology.
5. aso_hpa: Autonomous Scientific Orchestrator for multi-step analysis with charts/figures

CRITICAL RULES:
- NEVER make up numbers or statistics. ALWAYS use deep_research_hpa.
- NEVER answer definition or histology questions from your own knowledge. ALWAYS use dictionary_expert_hpa.
- If the user asks for charts, plots, expression comparisons, or multi-step analysis, use aso_hpa.`;

  const base = [
    { role: 'system', content: systemContent },
    { role: 'user', content: queryText }
  ];

  // 1. Propose tools
  const toolCalls = await proposeTools(base);

  if (toolCalls.length > 0 && toolCalls[0]?.function?.name) {
    const toolCall = toolCalls[0];
    const toolName = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments || '{}');

    console.log(`[BATCH] selected tool ${toolName}.`);

    // Collect tool steps
    const steps = [];
    const execRes = await inference.withContext(
      { purpose: 'agent', agentKey: toolName },
      () => orchestrator.execute(toolName, args, {
        rawQuery: queryText,
        db,
        visitorId: auth.visitorId,
        onStep: async (payload) => {
          steps.push({
            stage: payload?.stage || 'info',
            label: payload?.label || '',
            message: payload?.message || payload?.stdout || ''
          });
        }
      })
    );

    const toolResult = execRes;

    // Collect metadata
    const metadata = {
      tool: toolName,
      tool_args: args,
      steps,
      result: toolResult?.result || null,
      summary_md: toolResult?.summary_md || null
    };

    // Search URLs
    const searchUrls = toolResult?.result?.result?.search_urls || toolResult?.result?.search_urls || [];
    if (searchUrls.length > 0) metadata.search_urls = searchUrls;

    // Resources (investigator)
    const resources = toolResult?.result?.resources || [];
    if (resources.length > 0) metadata.resources = resources;

    // Dictionary images
    if (toolName === 'dictionary_expert_hpa' && toolResult?.result?.images?.length > 0) {
      metadata.dictionary_images = {
        dictionary_url: toolResult.result.dictionary_url,
        matched_category: toolResult.result.matched_category,
        images: toolResult.result.images,
        related_links: toolResult.result.related_links || []
      };
    }

    // ASO charts
    if (toolName === 'aso_hpa' && toolResult?.result?.artifacts) {
      const chartArtifacts = reportFigureArtifacts(toolResult.result);
      const wsUuid = toolResult.result.workspace_uuid;
      if (chartArtifacts.length > 0 && wsUuid) {
        metadata.aso_charts = chartArtifacts.map(a => ({
          artifact_uuid: a.artifact_uuid,
          url: `/workspaces/${wsUuid}/artifacts/${path.basename(a.storage_uri)}`,
          summary: a.summary
        }));
        metadata.workspace_uuid = wsUuid;
      }
    }

    // Synthesize
    const stylePrompt = getSynthesisPrompt(toolName, toolResult);
    let finalMessages;
    if (!getActiveModel().supportsToolRoleMessages) {
      const payload = toolResult?.summary_md || JSON.stringify(toolResult.result || { status: 'ok' });
      finalMessages = [...base, { role: 'system', content: stylePrompt }, { role: 'user', content: `Tool output:\n${payload}` }];
    } else {
      finalMessages = [
        ...base,
        { role: 'assistant', content: null, tool_calls: [toolCall] },
        { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ status: toolResult?.status || 'ok', summary_md: toolResult?.summary_md || null, result: toolResult?.result || null }) },
        { role: 'system', content: stylePrompt }
      ];
    }
    const response = await chatCompletion(finalMessages);
    return { response, metadata };
  }

  // No tool — direct answer
  const response = await chatCompletion([
    ...base,
    { role: 'system', content: 'Provide a concise, informative answer. Do not mention tools.' }
  ]);
  return { response, metadata: { tool: null } };
}

/* ---- auth middleware ---- */

function secretsMatch(provided, expected) {
  if (typeof provided !== 'string') return false;
  const providedHash = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

function requireBatchSecret(expected) {
  return function batchSecret(req, res, next) {
    if (!secretsMatch(req.headers['x-batch-secret'], expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
}

/* ---- router ---- */

exports.createRouter = function({ db, batches, batchSecret }) {
  const router = express.Router();
  router.use(requireBatchSecret(batchSecret));

  // POST /batch — submit queries
  router.post('/', async (req, res) => {
    try {
      const { queries } = req.body || {};
      if (!Array.isArray(queries) || queries.length === 0) {
        return res.status(400).json({ error: 'queries must be a non-empty array of strings' });
      }
      const config = platformConfig();
      if (queries.length > config.batchMaxQueries) {
        return res.status(400).json({ error: `Max ${config.batchMaxQueries} queries per batch` });
      }
      for (let i = 0; i < queries.length; i++) {
        if (typeof queries[i] !== 'string' || !queries[i].trim()) {
          return res.status(400).json({ error: `queries[${i}] must be a non-empty string` });
        }
        if (queries[i].length > config.queryMaxCharacters) {
          return res.status(413).json({ error: `queries[${i}] exceeds the character limit` });
        }
      }

      const normalizedQueries = queries.map(query => query.trim());
      const model = getActiveModel();
      const job = await batches.create(req.auth.visitorId, model.id, normalizedQueries);

      console.log(`[BATCH] created job ${job.publicId} with ${queries.length} queries`);

      // Fire off processing in background (don't await)
      processJob({
        db,
        batches,
        job,
        queries: normalizedQueries,
        auth: req.auth
      }).catch(err => {
        console.error(`[BATCH] job ${job.publicId} fatal error:`, err?.message || err);
      });

      return res.status(202).json({ job_id: job.publicId, total_queries: queries.length, status: 'running' });
    } catch (err) {
      console.error('[BATCH] submit error:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /batch/:jobId — poll status
  router.get('/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;

      const job = await batches.findOwned(jobId, req.auth.visitorId);
      if (!job) return res.status(404).json({ error: 'Job not found' });

      const queryRows = await batches.listQueries(job.id);

      const results = queryRows.map(r => {
        let metadata = null;
        if (r.response_json) {
          try { metadata = typeof r.response_json === 'string' ? JSON.parse(r.response_json) : r.response_json; } catch (_) {}
        }
        return {
          index: r.query_index,
          query: r.query_text,
          status: r.status,
          response: r.response_text || null,
          metadata,
          error: r.error_message || null,
          finished_at: r.finished_unix_ms === null ? null : Number(r.finished_unix_ms)
        };
      });

      return res.json({
        job_id: job.publicId,
        status: job.status,
        total_queries: job.total_queries,
        completed_queries: job.finished_queries,
        created_at: job.createdUnixMs,
        finished_at: job.finishedUnixMs,
        results
      });
    } catch (err) {
      if (err instanceof TypeError && err.message === 'Invalid UUID.') {
        return res.status(400).json({ error: 'invalid_job_id' });
      }
      console.error('[BATCH] poll error:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
};

/* ---- background processing ---- */

async function processJob({ db, batches, job, queries, auth }) {
  // Process a few queries at a time so one job cannot flood the provider.
  const concurrency = platformConfig().batchConcurrency;
  for (let i = 0; i < queries.length; i += concurrency) {
    const chunk = queries.slice(i, i + concurrency);
    const promises = chunk.map((query, offset) => processOneQuery({
      db,
      batches,
      job,
      index: i + offset,
      queryText: query,
      auth
    }));
    await Promise.all(promises);
  }

  await batches.finishJob(job.id);
  console.log(`[BATCH] job ${job.publicId} finished.`);
}

async function processOneQuery({ db, batches, job, index, queryText, auth }) {
  console.log(`[BATCH] job ${job.publicId} query[${index}] starting.`);
  const started = await batches.startQuery(job.id, index);

  try {
    const { response, metadata } = await inference.withContext(
      { purpose: 'batch', batchQueryId: started.id },
      () => runQuery(queryText, db, auth)
    );
    await batches.completeQuery(job.id, index, response, metadata);

    console.log(`[BATCH] job ${job.publicId} query[${index}] completed.`);
  } catch (err) {
    console.error(`[BATCH] job ${job.publicId} query[${index}] failed:`, err.message);
    await batches.failQuery(job.id, index, 'query_failed', String(err.message || err).slice(0, 65535));
  }
}
