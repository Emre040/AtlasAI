'use strict';

const path = require('path');
const express = require('express');
const orchestrator = require('../../system/orchestrator');
const { inference, getActiveModel } = require('../../inference/gateway');
const { requireBoolean } = require('../../config/runtime');
const { buildModelHistory } = require('../timeline');

const MAX_QUERY_CHARACTERS = 20_000;
const VERBOSE_DIAGNOSTICS = requireBoolean('ATLAS_VERBOSE_DIAGNOSTICS');
const debugLog = (...args) => {
  if (VERBOSE_DIAGNOSTICS) console.log(...args);
};

function invalidUuid(error) {
  return error instanceof TypeError && error.message === 'Invalid UUID.';
}

/* ---------------- helpers + logging ---------------- */

// Agent steps sometimes carry a JSON document in `message` (ASO does this for every event).
// Store such documents structurally next to the text so the UI does not have to re-parse them.
function structuredDetail(message) {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractSearchUrl(toolResult) {
  const nested = toolResult?.result;
  const urls = nested?.search_urls || toolResult?.search_urls || [];
  if (Array.isArray(urls) && urls.length > 0) return String(urls[0]);
  const single = nested?.search_url || toolResult?.search_url;
  return single ? String(single) : null;
}

function promotedInteger(toolResult, key) {
  const value = toolResult?.result?.[key] ?? toolResult?.[key];
  return Number.isInteger(value) ? value : null;
}

function promotedBoolean(toolResult, key) {
  const value = toolResult?.result?.[key] ?? toolResult?.[key];
  return typeof value === 'boolean' ? value : null;
}

// Parse both reply-marker wire formats used by existing clients.
const REPLY_MARKER_NEW = /^⟪HPA▸GENE:(ENSG\d+):([^⟫]+)⟫\s*/;
const REPLY_MARKER_COMPAT = /^\[\[REPLY:(ENSG\d+):([^\]]+)\]\]\s*/;
function parseReplyContext(text = '') {
  let match = text.match(REPLY_MARKER_NEW);
  let regex = REPLY_MARKER_NEW;
  if (!match) {
    match = text.match(REPLY_MARKER_COMPAT);
    regex = REPLY_MARKER_COMPAT;
  }
  if (match) {
    return {
      ensg: match[1],
      geneName: match[2],
      cleanText: text.replace(regex, '').trim()
    };
  }
  return null;
}

async function streamChatCompletion(request = {}, { onToken } = {}) {
  const { stream_options, ...rest } = request || {};
  const stream = await inference.chat.completions.create({
    ...rest,
    stream: true,
    stream_options: { include_usage: true, ...(stream_options || {}) }
  });

  let fullText = '';
  let cutAtMarkup = false;

  for await (const part of stream) {
    const delta = part?.choices?.[0]?.delta?.content || '';
    if (delta && !cutAtMarkup) {
      const candidate = fullText + delta;
      const markupIndex = findToolCallMarkup(candidate);
      if (markupIndex === -1) {
        fullText = candidate;
        onToken?.(delta);
      } else {
        // The model started writing a tool call as text; keep only what came before it.
        const keep = candidate.slice(0, markupIndex);
        const newText = keep.slice(fullText.length);
        fullText = keep;
        if (newText) onToken?.(newText);
        cutAtMarkup = true;
        console.warn('[STREAM] Dropped tool-call markup emitted as text by', getActiveModel().configKey);
      }
    }
  }

  // Token usage is recorded by the gateway in inference_calls; callers only need the text.
  return { text: fullText };
}

// DeepSeek models on the Chat Completions API sometimes emit their native tool-call markup
// inside `content` when no tools are offered. It is never user-facing text.
const TOOL_CALL_MARKUP = /<[｜|]{1,2}DSML[｜|]{1,2}|<tool_call>|<\|tool_calls?_begin\|>/i;
function findToolCallMarkup(text) {
  const match = TOOL_CALL_MARKUP.exec(text);
  return match ? match.index : -1;
}

const SSE_DEBUG = requireBoolean('HPA_SSE_DEBUG');

function sse(res, obj) {
  try {
    const out = JSON.stringify(obj);
    if (SSE_DEBUG) debugLog('[SSE → client]', out.slice(0, 300));
    res.write(`data: ${out}\n\n`);
  } catch (e) {
    console.error('[SSE error]', e?.message || e);
  }
}
function ssePing(res) {
  try {
    if (SSE_DEBUG) debugLog('[SSE ping]');
    res.write(': ping\n\n');
  } catch {}
}

// Collect streamed tool_calls deltas
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

/* ---------------- 1) Ask the model if it wants tools ---------------- */

async function proposeTools({ messages }) {
  debugLog('[TOOLS] propose → model');
  const coll = initToolCallCollector();

  const stream = await inference.chat.completions.create({
    messages: [
      ...messages,
      {
        role: 'system',
content: `Choose the right tool:
(1) check_inclusion_hpa - ONLY for checking if a SPECIFIC GENE NAME is in previous results
(2) deep_research_hpa - for ANY search including:
    - New searches
    - Filtering previous results ("how many of these are in brain", "which ones are kinases")
    - Combining constraints ("liver enriched AND detected in brain")
(3) investigator_hpa - for detailed info about one specific gene
(4) dictionary_expert_hpa - for ANY definition, educational, histology, pathology, OR about-HPA question:
    - "What is X?" questions (e.g., "what is apoptosis", "what are ribosomes")
    - Histology/tissue structure ("show me liver histology", "kidney tissue")
    - Cancer/pathology ("neuroendocrine tumors", "breast cancer histology")
    - Cell biology concepts ("mitochondria", "golgi", "cytoskeleton")
    - About HPA itself: "what is HPA?", "who runs HPA?", "how to download data?", "latest release?", "how to cite?"
    USE "question" param (not "topic") for about-HPA questions. USE "topic" param for histology/pathology.
(5) aso_hpa - Autonomous Scientific Orchestrator for MULTI-STEP analysis with charts/figures:
    - Comparing gene expression across tissues ("compare liver vs kidney enzymes")
    - Generating charts: heatmaps, scatter plots, bar charts, lollipop charts
    - Multi-gene multi-tissue analysis ("expression of TP53, BRCA1, EGFR across 5 tissues")
    - Any request that needs measurements, ranking, and visualization
    - Keywords: "chart", "plot", "heatmap", "scatter", "compare expression", "visualize", "figure"

CRITICAL RULES:
- If user asks to FILTER, COUNT, or REFINE previous results with ANY new constraint, use deep_research_hpa.
- NEVER make up numbers or guess counts - ALWAYS search.
- NEVER answer "what is X" or definition questions yourself - ALWAYS use dictionary_expert_hpa.
- If user asks for charts, plots, comparisons, or multi-step expression analysis, use aso_hpa.` }
    ],
    stream: true,
    tools: orchestrator.getToolSpecs(),
    tool_choice: 'auto'
  });

  for await (const part of stream) {
    const d = part?.choices?.[0]?.delta;
    if (d?.tool_calls) coll.addFromDelta(d.tool_calls);
  }

  const list = coll.list();
  debugLog('[TOOLS] proposed:', list.map(t => t?.function?.name));
  return list;
}

/* ---------------- 2) Stream a one-liner preface if tool is used ---------------- */

async function streamPrefaceStrict({ baseMessages, res, toolName }) {
  const RULES =
    "You have decided to use a tool. In a single, brief, conversational sentence, tell the user what you are about to do.\n" +
    "Examples: 'Of course, I'll start analyzing that.' or 'Certainly, let me begin the research process.'\n" +
    "- Do NOT use the word 'PLAN'.\n" +
    "- Do NOT use markdown or greetings.\n" +
    "- Do NOT provide the final answer.\n" +
    "- Do NOT call or invoke the tool in this reply; it is called for you after this sentence.";

  debugLog('[PRE] streaming strict preface for tool:', toolName);

  const { text: streamedText } = await streamChatCompletion(
    {
      model: getActiveModel().modelId,
      messages: [
        ...baseMessages,
        { role: 'system', content: RULES },
        { role: 'system', content: `The tool you will call is named: ${toolName}.` }
      ]
    },
    { onToken: (delta) => sse(res, { phase: 'pre', delta }) }
  );

  const text = (streamedText || `Okay, I'll start the process for you.`).trim().replace(/\s+/g, ' ');
  debugLog('[PRE] done:', text);
  return text;
}

/* ---------------- 3) Execute a single tool and forward progress ---------------- */

async function runSingleToolAndStream({
  toolCall,
  res,
  db,
  runs,
  conversation,
  userMessage,
  preambleText,
  callContext,
  rawUserQuery,
  visitorId
}) {
  const { name } = toolCall.function;
  const args = JSON.parse(toolCall.function.arguments || '{}');

  // The run row is the identity the frontend groups by, live and after reload.
  const run = await runs.create({
    conversationId: conversation.id,
    visitorId,
    requestMessageId: userMessage.id,
    requestEventId: callContext.requestEventId,
    inferenceModelId: getActiveModel().id,
    toolKey: name,
    toolCallId: toolCall.id || null,
    argumentsJson: args,
    preambleText
  });
  let sequence = 0;
  const persistEvent = event => runs.addEvent(run.id, sequence++, event);

  debugLog('[TOOL] started:', name, 'run:', run.publicId);
  sse(res, { tool: { name, status: 'started', run_id: run.publicId } });
  await persistEvent({ eventKind: 'started', stage: 'start' });

  // Long tool phases (ASO investigator batches, chart rendering) can stay silent for minutes;
  // Cloudflare closes a response that sends nothing for 100 s, so keep the stream warm.
  const keepalive = setInterval(() => ssePing(res), 20_000);
  let execRes;
  try {
    execRes = await inference.withContext(
      { ...callContext, purpose: 'agent', runId: run.id, agentKey: name },
      () => orchestrator.execute(name, args, {
        rawQuery: rawUserQuery,
        db,
        visitorId,
        onStep: async (payload) => {
          sse(res, { tool: { name, status: 'progress', run_id: run.publicId, step: payload } });
          const s = payload || {};
          const message = s.message ?? s.stdout ?? null;
          await persistEvent({
            eventKind: 'progress',
            stage: s.stage || 'info',
            label: s.label || null,
            message: message === null ? null : String(message),
            url: s.url || null,
            visual: s.visual || null,
            detail: structuredDetail(message)
          });
        }
        // NOTE: Images are sent BEFORE synthesis starts (below), not during tool execution
      })
    );
  } catch (error) {
    clearInterval(keepalive);
    const errorMessage = String(error?.message || error).slice(0, 65535);
    await persistEvent({ eventKind: 'failed', stage: 'error', label: 'Error', message: errorMessage });
    await runs.complete(run.id, { status: 'failed', stepCount: Math.max(sequence - 2, 0), errorMessage });
    sse(res, { tool: { name, status: 'failed', run_id: run.publicId, error: errorMessage } });
    throw error;
  }
  clearInterval(keepalive);

  const toolResult = execRes.result && typeof execRes.result === 'object' ? execRes.result : {};
  const failed = toolResult.status === 'error';
  const resultMeta = { steps: execRes.steps?.length || 0 };
  const errorMessage = failed ? String(toolResult.error || 'Tool failed.').slice(0, 65535) : null;
  await persistEvent({
    eventKind: failed ? 'failed' : 'completed',
    stage: 'complete',
    label: failed ? 'Failed' : 'Complete',
    message: errorMessage,
    detail: { steps: resultMeta.steps }
  });
  await runs.complete(run.id, {
    status: failed ? 'failed' : 'completed',
    stepCount: resultMeta.steps,
    searchUrl: extractSearchUrl(toolResult),
    rowsFound: promotedInteger(toolResult, 'rows_found'),
    validationPassed: promotedBoolean(toolResult, 'validation_passed'),
    attempts: promotedInteger(toolResult, 'attempts'),
    workspaceId: toolResult.workspace_uuid ? await runs.findWorkspaceId(toolResult.workspace_uuid) : null,
    result: toolResult,
    summaryMd: toolResult.summary_md || null,
    errorMessage
  });
  sse(res, { tool: { name, status: 'completed', run_id: run.publicId, result_meta: resultMeta } });

  debugLog('[TOOL] completed:', name, 'run:', run.publicId);
  // CRITICAL: Return orchestration result so we can synthesize from actual tool output.
  return { execRes, run };
}

/* ---------------- router factory ---------------- */

exports.createRouter = function({ db, conversations, runs }) {
  const router = express.Router();

  router.post('/stream', async (req, res, next) => {
    try {
      const { conversationId, query } = req.body || {};
      if (!conversationId || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'conversation_id_and_query_required' });
      }
      if (query.length > MAX_QUERY_CHARACTERS) {
        return res.status(413).json({ error: 'query_too_large' });
      }

      const conversation = await conversations.findOwned(conversationId, req.auth.visitorId);
      if (!conversation) return res.status(404).json({ error: 'conversation_not_found' });

      // Init SSE
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      ssePing(res);

      // Context before this turn, then the user message itself.
      const [historyRows, conversationRuns] = await Promise.all([
        conversations.history(conversation.id),
        runs.listForConversation(conversation.id)
      ]);
      const userMessage = await conversations.addMessage(conversation.id, 'user', query.trim());
      const callContext = {
        conversationId: conversation.id,
        requestEventId: Number.isInteger(req.requestEventId) ? req.requestEventId : null,
        callIds: []
      };

      // Parse reply context if present (strips [[REPLY:ENSG...:GeneName]] marker)
      const replyContext = parseReplyContext(query.trim());
      const userQueryForAI = replyContext ? replyContext.cleanText : query.trim();

      // Build system message with optional gene context
let systemContent = `You are AtlasAI, a helpful assistant for exploring The Human Protein Atlas.

TOOL USAGE RULES:
1. deep_research_hpa: Use for ANY search query including:
   - New searches ("find liver-enriched genes")
   - Filtering/refining previous results ("how many of these are in brain", "which ones are not detected in heart")
   - When filtering, COMBINE the original criteria with the new constraint
2. check_inclusion_hpa: ONLY when asking if a SPECIFIC GENE NAME (like BRCA1) is in previous results
3. investigator_hpa: For detailed info about a specific gene
4. dictionary_expert_hpa: For ANY definition, histology, pathology, educational, OR about-HPA question:
   - "What is X?" questions about biological concepts, tissues, or cell structures
   - Histology requests ("show me liver histology", "what does kidney tissue look like")
   - Cancer/pathology topics ("neuroendocrine tumors", "lung cancer histology")
   - Cell biology terms ("mitochondria", "golgi apparatus", "endoplasmic reticulum")
   - About HPA itself: "what is HPA?", "who runs HPA?", "how to download data?", "latest release?", "how to cite?"
   USE "question" param (not "topic") for about-HPA questions. USE "topic" param for histology/pathology.
5. aso_hpa: Autonomous Scientific Orchestrator for multi-step analysis with charts/figures:
   - Comparing gene expression across tissues ("compare liver vs kidney enzymes")
   - Generating charts: heatmaps, scatter plots, bar charts, lollipop charts
   - Multi-gene multi-tissue analysis ("expression of TP53, BRCA1, EGFR across 5 tissues")
   - Any request needing measurements, ranking, and visualization

CRITICAL RULES:
- NEVER make up numbers or statistics. If the user asks "how many" or wants to filter results, you MUST use deep_research_hpa to get the actual count.
- NEVER answer definition or histology questions from your own knowledge. ALWAYS use dictionary_expert_hpa for topics like "what is X", tissue structure, cancer types, or cell biology concepts.
- If the user asks for charts, plots, expression comparisons, or multi-step analysis, use aso_hpa.`;


      if (replyContext) {
        systemContent += `\n\nIMPORTANT CONTEXT: The user is asking specifically about the gene ${replyContext.geneName} (${replyContext.ensg}). Focus your response on this gene. You can find detailed information at https://www.proteinatlas.org/${replyContext.ensg}`;
        debugLog('[REPLY] User asking about gene:', replyContext.geneName, replyContext.ensg);
      }

      const base = [
        { role: 'system', content: systemContent },
        ...buildModelHistory(historyRows, conversationRuns),
        { role: 'user', content: userQueryForAI }
      ];

      // Ask the model if any tool should be used
      const toolCalls = await inference.withContext(
        { ...callContext, purpose: 'router' },
        () => proposeTools({ messages: base })
      );
      let finalText = '';
      let finalCallId = null;
      let run = null;

      if (toolCalls.length > 0 && toolCalls[0]?.function?.name) {
        const toolCall = toolCalls[0];
        const toolName = toolCall.function.name;

        // Pre-message (single sentence)
        const preambleText = await inference.withContext(
          { ...callContext, purpose: 'preface' },
          () => streamPrefaceStrict({ baseMessages: base, res, toolName })
        );

        // Execute the tool and stream progress (pass the raw user query!)
        const toolRun = await runSingleToolAndStream({
          toolCall,
          res,
          db,
          runs,
          conversation,
          userMessage,
          preambleText,
          callContext,
          rawUserQuery: query,
          visitorId: req.auth.visitorId
        });
        run = toolRun.run;
        const toolResult = toolRun.execRes;

        // Send investigator resources BEFORE synthesis (so they appear above)
        const resources = toolResult?.result?.resources || [];
        if (resources.length > 0) {
          debugLog('[RESOURCES] sending before synthesis:', resources.length, 'resources');
          sse(res, { resources });
        }

        // Send dictionary images BEFORE synthesis (so they appear as answer starts)
        const dictionaryResult = toolResult?.result;
        if (toolName === 'dictionary_expert_hpa' && dictionaryResult?.images?.length > 0) {
          const dictionaryData = {
            dictionary_url: dictionaryResult.dictionary_url,
            matched_category: dictionaryResult.matched_category,
            category_type: dictionaryResult.category_type,
            isMultiTopic: dictionaryResult.isMultiTopic || false,
            categories: dictionaryResult.categories || [],
            images: dictionaryResult.images,
            related_links: dictionaryResult.related_links || []
          };
          debugLog('[DICTIONARY] sending before synthesis:', dictionaryData.images.length, 'images');
          sse(res, { dictionary_images: dictionaryData });
        }

        // Send ASO chart artifacts BEFORE synthesis (so images appear above text)
        if (toolName === 'aso_hpa' && toolResult?.result?.artifacts) {
          const chartArtifacts = (toolResult.result.artifacts || []).filter(a => a.kind === 'figure');
          const wsUuid = toolResult.result.workspace_uuid;
          if (chartArtifacts.length > 0 && wsUuid) {
            const charts = chartArtifacts.map(a => ({
              artifact_uuid: a.artifact_uuid,
              url: `/workspaces/${wsUuid}/artifacts/${path.basename(a.storage_uri)}`,
              summary: a.summary
            }));
            debugLog('[ASO] sending', charts.length, 'chart(s) before synthesis');
            sse(res, { aso_charts: charts });
          }
        }

        // Synthesize final answer from the tool's actual output
        debugLog('[SYNTH] after tool; streaming final answer');

        // Different synthesis styles based on tool type
        let styleSystemMessage;
if (toolName === 'dictionary_expert_hpa') {
  const isAboutMode = toolResult?.result?.mode === 'about';
  if (isAboutMode) {
    // Receptionist mode: answer about HPA itself
    styleSystemMessage =
      "The tool retrieved content from HPA about pages. " +
      "Your job is to ANSWER THE USER'S QUESTION about the Human Protein Atlas using this content. " +
      "Be informative and concise. Cite specific details (names, dates, versions, URLs) from the content. " +
      "If the content includes download links or instructions, present them clearly. " +
      "Do NOT make up information beyond what the content provides.";
  } else {
    // Dictionary mode: histology/pathology
    styleSystemMessage =
      "The tool retrieved educational content from the HPA Dictionary. " +
      "Your job is to ANSWER THE USER'S ORIGINAL QUESTION using this content as your source. " +
      "Do NOT just summarize the page - directly address what they asked. " +
      "Examples: " +
      "- If they asked 'what is glioma?' → Explain what glioma is using the content. " +
      "- If they asked 'show me liver histology' → Describe the liver's histological features. " +
      "- If they asked 'what cells are in the kidney?' → Answer about kidney cell types from the content. " +
      "Mention that tissue images are displayed below for visual reference. " +
      "Keep your answer focused and relevant to their question.";
  }
} else if (toolName === 'investigator_hpa') {
          // For investigator: Present the comprehensive answer directly
          styleSystemMessage =
            "The tool has returned comprehensive information about the gene. " +
            "Present the answer field from the result DIRECTLY and COMPLETELY to the user. " +
            "Do NOT summarize or paraphrase - output the full detailed answer as-is. " +
            "You may add a brief intro like 'Here's what I found about [gene]:' but then present ALL the data. " +
            "The user wants to see all the specific values, numbers, and details.";
        } else if (toolName === 'check_inclusion_hpa') {
          // For inclusion check: Clear yes/no answer with follow-up suggestion
          styleSystemMessage =
            "The tool checked if a gene is in a search result. Give a clear, direct answer: " +
            "If included: 'Yes, [GENE] ([description]) is included in those results.' Then ask: 'Would you like a detailed summary of [GENE] or have a specific question about it?' " +
            "If not included: 'No, [GENE] is not in those [count] results.' " +
            "Keep the answer brief but always offer the follow-up when found.";
        } else if (toolName === 'aso_hpa') {
          // For ASO: Summarize the scientific analysis and reference charts
          styleSystemMessage =
            "The Autonomous Scientific Orchestrator (ASO) completed a multi-step analysis. " +
            "Summarize what was done and the key findings from the result. " +
            "If charts/figures were generated, mention them — they are displayed as images above your text. " +
            "Reference specific chart numbers (e.g., 'As shown in Chart 1…'). " +
            "Keep it concise (3-6 sentences) but informative. Highlight the most interesting findings. " +
            "Do NOT list raw gene names or data tables.";
        } else {
          // For deep_research and others: Brief confirmation style
          styleSystemMessage =
            "Provide a brief confirmation of the search results. State the count of results. " +
            "Example: 'I found 267 liver-enriched genes! The results are displayed below.' " +
            "Keep it to 1-3 short sentences. " +
            "IMPORTANT: If the tool output mentions 'Limitations' or filters that couldn't be matched, " +
            "you MUST briefly tell the user what was approximated (e.g., 'Note: HPA doesn't have a specific filter for X, so I used Y instead.'). " +
            "Do NOT list gene names. No links needed. " +
            "If zero results, explain that the specific filter combination returned no matches and suggest adjusting the query.";
        }

        let finalMessages;
        if (!getActiveModel().supportsToolRoleMessages) {
          // Gemini OpenAI-compat does not reliably accept tool_call/tool role messages.
          const toolPayload = toolResult?.summary_md || JSON.stringify(toolResult.result || { status: 'ok', message: 'Tool executed successfully.' });
          finalMessages = [
            ...base,
            { role: 'system', content: styleSystemMessage },
            { role: 'user', content: `Tool output:\n${toolPayload}` }
          ];
        } else {
          // Standard OpenAI tool-call synthesis
          // IMPORTANT: Only include the single tool call we actually executed (not all proposed calls)
          finalMessages = [
            ...base,
            {
              role: 'assistant',
              content: null, // per spec when tool_calls present
              tool_calls: [toolCall]         // only echo the executed tool call
            },
            {
              role: 'tool',
              tool_call_id: toolCall.id,     // link to the tool call id
              content: JSON.stringify({
                status: toolResult?.status || 'ok',
                summary_md: toolResult?.summary_md || null,
                result: toolResult?.result || null
              }),
            },
            { role: 'system', content: styleSystemMessage }
          ];
        }

        const { text } = await inference.withContext(
          { ...callContext, purpose: 'synthesis', runId: run.id },
          () => streamChatCompletion(
            { messages: finalMessages },
            { onToken: (delta) => sse(res, { token: delta }) }
          )
        );
        finalText = (text || '').trim();
        finalCallId = callContext.callIds.at(-1) ?? null;

        // Send the search URL directly to frontend (not relying on AI to output it).
        // It is stored on the run, so reloads read it from there.
        const searchUrls = toolResult?.result?.result?.search_urls || toolResult?.result?.search_urls || [];
        if (searchUrls.length > 0) {
          sse(res, { search_url: searchUrls[0] });
        }

        // Dictionary images and resources already sent before synthesis (above)

      } else {
        // No tools: answer directly
        debugLog('[SYNTH] no tools; streaming final answer');

        const { text } = await inference.withContext(
          { ...callContext, purpose: 'answer' },
          () => streamChatCompletion(
            {
              messages: [
                ...base,
                { role: 'system', content: 'Provide a concise, polite final answer. Do not mention tools or making a plan.' }
              ]
            },
            { onToken: (delta) => sse(res, { token: delta }) }
          )
        );
        finalText = (text || '').trim();
        finalCallId = callContext.callIds.at(-1) ?? null;
      }

      const aiText = finalText || "I'm sorry, I couldn't generate a response.";
      const assistantMessage = await conversations.addMessage(conversation.id, 'assistant', aiText, {
        parentMessageId: userMessage.id,
        inferenceCallId: finalCallId
      });
      if (run) await runs.setResponseMessage(run.id, assistantMessage.id);
      await conversations.touch(conversation.id);

      sse(res, { done: true });
      res.end();
    } catch (err) {
      if (!res.headersSent && invalidUuid(err)) {
        return res.status(400).json({ error: 'invalid_conversation_id' });
      }
      console.error('[HPA_QUERY_STREAM_ERROR]', err?.code || err?.message || String(err));
      if (!res.headersSent) return next(err);
      sse(res, { error: 'Internal Server Error' });
      res.end();
    }
  });

  // (Optional) add a non-stream endpoint if needed; mirror the same logic.
  return router;
};
