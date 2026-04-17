'use strict';

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { client, MODEL, PROVIDER } = require('./llm');
const orchestrator = require('./functions/orchestrator');

const TBL_CONV = process.env.HPA_TBL_CONVERSATIONS;
const TBL_MSG  = process.env.HPA_TBL_MESSAGES;

/* ---------------- helpers + logging ---------------- */

function extractJsonObject(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function safeJsonParse(text = '') {
  const raw = extractJsonObject(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseSearchUrlEntry(text = '') {
  const match = String(text || '').match(/^SEARCH_URL:\s*(.+)$/i);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;

  if (raw.startsWith('{')) {
    const parsed = safeJsonParse(raw);
    const url = parsed?.url || parsed?.search_url;
    const goal = parsed?.goal || null;
    if (url) {
      return {
        url: String(url).trim(),
        goal: goal ? String(goal).trim() : null
      };
    }
  }

  const legacy = raw.match(/^(\S+)(?:\s*\[FOR:\s*(.+?)\])?/i);
  if (!legacy) return null;
  const url = legacy[1]?.trim();
  if (!url) return null;
  const goal = legacy[2]?.trim() || null;
  return { url, goal };
}

function getLastSearchEntry(rows) {
  for (const row of rows || []) {
    const entry = parseSearchUrlEntry(row?.text || '');
    if (entry) return entry;
  }
  return null;
}

function rowsToMessages(rows) {
  // Filter internal tool logs so the next LLM call is not polluted.
  // SEARCH_URL is NOT filtered - we transform it to give AI context about successful searches
  const filteredRows = (rows || []).filter(r => !/^(PRE:|TOOL_|RESOURCES:)/i.test(r.text || ''));

  return filteredRows.reverse().map(r => {
    let content = r.text || '';

    // Transform SEARCH_URL into context for the AI.
    const searchEntry = parseSearchUrlEntry(content);
    if (searchEntry?.url) {
      const goalText = searchEntry.goal || 'unknown query';
      return {
        role: 'assistant',
        content: `[SEARCH COMPLETED for "${goalText}" - I sent the user: ${searchEntry.url}]`
      };
    }

    // Strip reply markers from user messages so AI sees clean text (both new and legacy formats)
    if (r.sender_type === 'user') {
      content = content.replace(/^⟪HPA▸GENE:(ENSG\d+):([^⟫]+)⟫\s*/, '[Regarding gene $2 ($1)] ');
      content = content.replace(/^\[\[REPLY:(ENSG\d+):([^\]]+)\]\]\s*/, '[Regarding gene $2 ($1)] ');
    }
    return r.sender_type === 'user'
      ? { role: 'user', content }
      : { role: 'assistant', content };
  });
}

const roughTokenEstimate = (text = '') => {
  const clean = (text || '').trim();
  if (!clean) return 0;
  return Math.ceil(clean.length / 4);
};

// Parse reply context marker: ⟪HPA▸GENE:ENSG00000121410:A1BG⟫ (new) or [[REPLY:...]] (legacy)
const REPLY_MARKER_NEW = /^⟪HPA▸GENE:(ENSG\d+):([^⟫]+)⟫\s*/;
const REPLY_MARKER_OLD = /^\[\[REPLY:(ENSG\d+):([^\]]+)\]\]\s*/;
function parseReplyContext(text = '') {
  let match = text.match(REPLY_MARKER_NEW);
  let regex = REPLY_MARKER_NEW;
  if (!match) {
    match = text.match(REPLY_MARKER_OLD);
    regex = REPLY_MARKER_OLD;
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
  const stream = await client.chat.completions.create({
    ...rest,
    stream: true,
    stream_options: { include_usage: true, ...(stream_options || {}) }
  });

  let fullText = '';
  let totalTokens = null;

  for await (const part of stream) {
    const delta = part?.choices?.[0]?.delta?.content || '';
    if (delta) {
      fullText += delta;
      onToken?.(delta);
    }
    const usageTokens = part?.usage?.total_tokens;
    if (typeof usageTokens === 'number') totalTokens = usageTokens;
  }

  return { text: fullText, totalTokens };
}

const SSE_DEBUG = process.env.HPA_SSE_DEBUG === 'true';

function sse(res, obj) {
  try {
    const out = JSON.stringify(obj);
    if (SSE_DEBUG) console.log('[SSE → client]', out.slice(0, 300));
    res.write(`data: ${out}\n\n`);
  } catch (e) {
    console.error('[SSE error]', e?.message || e);
  }
}
function ssePing(res) {
  try {
    if (SSE_DEBUG) console.log('[SSE ping]');
    res.write(': ping\n\n');
  } catch {}
}

async function persistMsg(db, conversationId, text, meta = {}) {
  if (!text || !String(text).trim()) return null;
  const { senderType = 'ai', tokenCount = null, aiModel = null } = meta;
  try {
    const snippet = String(text).slice(0, 240);
    console.log('[DB] INSERT ai:', snippet);
    await db.query(
      "INSERT INTO ?? (conversation_uuid, sender_type, text, token_count, ai_model) VALUES (?, ?, ?, ?, ?)",
      [TBL_MSG, conversationId, senderType, String(text).trim(), tokenCount, aiModel]
    );
  } catch (e) {
    console.error('[DB] insert failed:', e?.message || e);
  }
  return true;
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
  console.log('[TOOLS] propose → model');
  const coll = initToolCallCollector();

  const stream = await client.chat.completions.create({
    model: MODEL,
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
  console.log('[TOOLS] proposed:', list.map(t => t?.function?.name));
  return list;
}

/* ---------------- 2) Stream a one-liner preface if tool is used ---------------- */

async function streamPrefaceStrict({ baseMessages, res, db, conversationId, toolName }) {
  const RULES =
    "You have decided to use a tool. In a single, brief, conversational sentence, tell the user what you are about to do.\n" +
    "Examples: 'Of course, I'll start analyzing that.' or 'Certainly, let me begin the research process.'\n" +
    "- Do NOT use the word 'PLAN'.\n" +
    "- Do NOT use markdown or greetings.\n" +
    "- Do NOT provide the final answer.";

  console.log('[PRE] streaming strict preface for tool:', toolName);

  const { text: streamedText, totalTokens } = await streamChatCompletion(
    {
      model: MODEL,
      messages: [
        ...baseMessages,
        { role: 'system', content: RULES },
        { role: 'system', content: `The tool you will call is named: ${toolName}.` }
      ]
    },
    { onToken: (delta) => sse(res, { phase: 'pre', delta }) }
  );

  const text = (streamedText || `Okay, I'll start the process for you.`).trim().replace(/\s+/g, ' ');
  const tokenCount = totalTokens ?? roughTokenEstimate(streamedText || text);
  await persistMsg(db, conversationId, text, { tokenCount, aiModel: MODEL });
  console.log('[PRE] done:', text);
  return text;
}

/* ---------------- 3) Execute a single tool and forward progress ---------------- */

async function runSingleToolAndStream({ toolCall, res, db, conversationId, rawUserQuery, req_cookieId }) {
  const { name } = toolCall.function;
  const args = JSON.parse(toolCall.function.arguments || '{}');

  // Generate a consistent runId for this tool execution (used for grouping in frontend)
  const runId = `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  console.log('[TOOL] start:', name, 'args:', args, 'runId:', runId);
  sse(res, { tool: { name, status: 'started' } });
  // Persist as JSON so we can restore full metadata on reload
  await persistMsg(db, conversationId, `TOOL_EVENT:${JSON.stringify({ toolName: name, runId, status: 'started', stage: 'start' })}`);

  const execRes = await orchestrator.execute(name, args, {
    rawQuery: rawUserQuery,
    db,
    cookieId: req_cookieId,
    onStep: async (payload) => {
      // Show every step to the user and persist as TOOL_EVENT JSON
      console.log('[TOOL] step:', name, payload);
      sse(res, { tool: { name, status: 'progress', step: payload } });

      const s = payload || {};
      // Persist full metadata as JSON for proper reload
      const eventData = {
        toolName: name,
        runId,
        stage: s.stage || 'info',
        label: s.label || '',
        message: s.message || s.stdout || '',
        url: s.url || null,
        visual: s.visual || null
      };
      await persistMsg(db, conversationId, `TOOL_EVENT:${JSON.stringify(eventData)}`);
    }
    // NOTE: Images are sent BEFORE synthesis starts (below), not during tool execution
  });

  const resultMeta = {
    steps: execRes.steps?.length || 0
  };
  sse(res, { tool: { name, status: 'completed', result_meta: resultMeta } });
  // Persist completion as JSON too
  await persistMsg(db, conversationId, `TOOL_EVENT:${JSON.stringify({ toolName: name, runId, status: 'completed', stage: 'complete', steps: resultMeta.steps })}`);

  console.log('[TOOL] finished tool execution. Result:', execRes.result);
  // CRITICAL: Return orchestration result so we can synthesize from actual tool output.
  return execRes;
}

/* ---------------- router factory ---------------- */

exports.createRouter = function(db) {
  const router = express.Router();

  const queryLimiter = rateLimit({
    windowMs: parseInt(process.env.HPA_QUERY_RATE_LIMIT_WINDOW_MS || '120000', 10),
    max: parseInt(process.env.HPA_QUERY_RATE_LIMIT_MAX || '30', 10),
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post('/stream', queryLimiter, async (req, res) => {
    try {
      const { cookieId, conversationId, query } = req.body || {};
      if (!cookieId || !conversationId || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'cookieId, conversationId, and a non-empty query are required.' });
      }

      // Init SSE
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      ssePing(res);

      // Validate conversation
      const [[conv]] = await db.query(
        'SELECT uuid FROM ?? WHERE uuid = ? AND cookie_value = ? LIMIT 1',
        [TBL_CONV, conversationId, cookieId.trim()]
      );
      if (!conv) { sse(res, { error: 'forbidden' }); return res.end(); }

      // Persist user message
      await db.query(
        "INSERT INTO ?? (conversation_uuid, sender_type, text) VALUES (?, 'user', ?)",
        [TBL_MSG, conversationId, query.trim()]
      );

      // Build base conversation for the model
      const [historyRows] = await db.query(
        "SELECT sender_type, text FROM ?? WHERE conversation_uuid = ? ORDER BY id DESC LIMIT 100",
        [TBL_MSG, conversationId]
      );

      // Parse reply context if present (strips [[REPLY:ENSG...:GeneName]] marker)
      const replyContext = parseReplyContext(query.trim());
      console.log('[DEBUG] Raw query bytes:', Buffer.from(query.trim().slice(0, 30)).toString('hex'));
console.log('[DEBUG] replyContext:', replyContext);
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
   - Atlas overviews: "what is the subcellular atlas?", "tell me about the tissue atlas", "how does the single cell atlas work?"
   USE "question" param (not "topic") for about-HPA and atlas overview questions. USE "topic" param for histology/pathology.
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
        console.log('[REPLY] User asking about gene:', replyContext.geneName, replyContext.ensg);
      }

      const base = [
        { role: 'system', content: systemContent },
        ...rowsToMessages(historyRows),
        { role: 'user', content: userQueryForAI }
      ];

      // Ask the model if any tool should be used
      const toolCalls = await proposeTools({ messages: base });
      let finalText = '';
      let finalTokenCount = null;

      if (toolCalls.length > 0 && toolCalls[0]?.function?.name) {
        const toolCall = toolCalls[0];
        const toolName = toolCall.function.name;

        // Pre-message (single sentence)
        await streamPrefaceStrict({ baseMessages: base, res, db, conversationId, toolName });

        // Execute the tool and stream progress (pass the raw user query!)
        const toolResult = await runSingleToolAndStream({
          toolCall, res, db, conversationId, rawUserQuery: query, req_cookieId: cookieId
        });

        // Send investigator resources BEFORE synthesis (so they appear above)
        const resources = toolResult?.result?.resources || [];
        if (resources.length > 0) {
          console.log('[RESOURCES] sending before synthesis:', resources.length, 'resources');
          sse(res, { resources });
          // Persist for reload
          await persistMsg(db, conversationId, `RESOURCES: ${JSON.stringify(resources)}`);
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
          console.log('[DICTIONARY] sending before synthesis:', dictionaryData.images.length, 'images');
          sse(res, { dictionary_images: dictionaryData });
          // Persist for reload
          await persistMsg(db, conversationId, `DICTIONARY_IMAGES: ${JSON.stringify(dictionaryData)}`);
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
            console.log('[ASO] sending', charts.length, 'chart(s) before synthesis');
            sse(res, { aso_charts: charts });
            await persistMsg(db, conversationId, `ASO_CHARTS: ${JSON.stringify(charts)}`);
          }
        }

        // Synthesize final answer from the tool's actual output
        console.log('[SYNTH] after tool; streaming final answer');

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

        // DEBUG: Log what LLM receives for synthesis
        console.log('\n[SYNTHESIS-DEBUG] ========================================');
        console.log('[SYNTHESIS-DEBUG] Tool:', toolName);
        console.log('[SYNTHESIS-DEBUG] System prompt:', styleSystemMessage);
        console.log('[SYNTHESIS-DEBUG] summary_md:', toolResult?.summary_md || 'NOT PROVIDED');
        console.log('[SYNTHESIS-DEBUG] ========================================\n');

        let finalMessages;
        if (PROVIDER === 'gemini') {
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

        const { text, totalTokens } = await streamChatCompletion(
          { model: MODEL, messages: finalMessages },
          { onToken: (delta) => sse(res, { token: delta }) }
        );
        finalText = (text || '').trim();
        finalTokenCount = totalTokens ?? roughTokenEstimate(text || finalText);

        // Send the search URL directly to frontend (not relying on AI to output it)
        const searchUrls = toolResult?.result?.result?.search_urls || toolResult?.result?.search_urls || [];
        if (searchUrls.length > 0) {
          const searchUrl = searchUrls[0];
          // Get the search goal from tool args for context
          const searchGoal = JSON.parse(toolCall.function.arguments || '{}').goal || userQueryForAI;
          console.log('[SEARCH_URL] sending:', searchUrl, 'goal:', searchGoal);
          sse(res, { search_url: searchUrl });
          // Persist with goal context so AI knows what each search was for.
          // NOTE: We keep this as a single line so the frontend can extract just the URL on reload.
          await persistMsg(db, conversationId, `SEARCH_URL: ${searchUrl} [FOR: ${searchGoal}]`);
        }

        // Dictionary images and resources already sent before synthesis (above)

      } else {
        // No tools: answer directly
        console.log('[SYNTH] no tools; streaming final answer');

        const { text, totalTokens } = await streamChatCompletion(
          {
            model: MODEL,
            messages: [
              ...base,
              { role: 'system', content: 'Provide a concise, polite final answer. Do not mention tools or making a plan.' }
            ]
          },
          { onToken: (delta) => sse(res, { token: delta }) }
        );
        finalText = (text || '').trim();
        finalTokenCount = totalTokens ?? roughTokenEstimate(text || finalText);
      }

      const aiText = finalText || "I'm sorry, I couldn't generate a response.";
      const storedTokenCount = aiText ? (finalTokenCount ?? roughTokenEstimate(aiText)) : null;
      await persistMsg(db, conversationId, aiText, { tokenCount: storedTokenCount, aiModel: MODEL });
      await db.query('UPDATE ?? SET updated_at = CURRENT_TIMESTAMP WHERE uuid = ?', [TBL_CONV, conversationId]);

      sse(res, { done: true });
      res.end();
    } catch (err) {
      console.error('[HPA_QUERY_STREAM_ERROR]', err);
      sse(res, { error: 'Internal Server Error' });
      res.end();
    }
  });

  // (Optional) add a non-stream endpoint if needed; mirror the same logic.
  return router;
};
