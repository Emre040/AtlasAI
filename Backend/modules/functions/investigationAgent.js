'use strict';

/**
 * HPA Investigation Agent - Pure Reasoning + Grep
 * IMPROVED: Added accumulated notes + goal validation
 */

const OpenAI = require('openai');

const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
const baseURL = process.env.GEMINI_BASE_URL || process.env.OPENAI_BASE_URL;
const openai = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey });

const MODEL = process.env.HPA_MODEL;

// -----------------------------
// Small helpers
// -----------------------------

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function isInsideTag(html, pos, tagName) {
  const open = `<${tagName}`;
  const close = `</${tagName}>`;
  const lastOpen = html.lastIndexOf(open, pos);
  if (lastOpen === -1) return false;
  const lastClose = html.lastIndexOf(close, pos);
  return lastClose < lastOpen;
}

function nearestOpenTag(html, pos, tagName) {
  const open = `<${tagName}`;
  const idx = html.lastIndexOf(open, pos);
  if (idx === -1) return null;
  const end = html.indexOf('>', idx);
  if (end === -1) return null;
  const raw = html.slice(idx, Math.min(end + 1, idx + 350));
  return raw.replace(/\s+/g, ' ').trim();
}

function buildLineStarts(html) {
  const starts = [0];
  for (let i = 0; i < html.length; i++) {
    if (html.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function windowAround(line, matchIndex, termLen, beforeChars = 220, afterChars = 260) {
  const start = clamp(matchIndex - beforeChars, 0, line.length);
  const end = clamp(matchIndex + termLen + afterChars, 0, line.length);
  let snippet = line.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < line.length) snippet = snippet + '…';
  return snippet;
}

// -----------------------------
// Grep-like search
// -----------------------------
function grepHtml(html, lineStarts, term, opts) {
  const {
    ignore_case = true,
    before = 0,
    after = 0,
    max_matches = 10,
    start_line = 1,
  } = opts || {};

  const lines = html.split('\n');
  const needle = ignore_case ? term.toLowerCase() : term;
  const startIdx = clamp((start_line || 1) - 1, 0, lines.length - 1);

  const matches = [];
  let nextStartLine = null;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const hay = ignore_case ? line.toLowerCase() : line;
    const idx = hay.indexOf(needle);
    if (idx === -1) continue;

    const charPos = (lineStarts[i] ?? 0) + idx;
    const inScript = isInsideTag(html, charPos, 'script');
    const inStyle = isInsideTag(html, charPos, 'style');
    const nearestTable = nearestOpenTag(html, charPos, 'table');
    const nearestDiv = nearestOpenTag(html, charPos, 'div');

    const b = clamp(before, 0, 50);
    const a = clamp(after, 0, 50);
    const ctxStart = clamp(i - b, 0, lines.length - 1);
    const ctxEnd = clamp(i + a, 0, lines.length - 1);

    const focusedMatchLine = windowAround(line, idx, term.length);
    const ctxLines = [];
    for (let j = ctxStart; j <= ctxEnd; j++) {
      if (j === i) {
        ctxLines.push(`${j + 1}: ${focusedMatchLine}`);
      } else {
        const l = lines[j];
        const trimmed = l.length > 500 ? (l.slice(0, 500) + '…') : l;
        ctxLines.push(`${j + 1}: ${trimmed}`);
      }
    }

    matches.push({
      match_no: matches.length + 1,
      line: i + 1,
      char_pos: charPos,
      in_script: inScript,
      in_style: inStyle,
      nearest_table_open: nearestTable,
      nearest_div_open: nearestDiv,
      context: ctxLines.join('\n'),
    });

    if (matches.length >= max_matches) {
      nextStartLine = i + 2;
      break;
    }
  }

  return {
    term,
    start_line: startIdx + 1,
    max_matches,
    found: matches.length,
    truncated: nextStartLine !== null,
    next_start_line: nextStartLine,
    matches,
  };
}

// -----------------------------
// Fetch helpers
// -----------------------------
async function fetchJson(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HPAAgent/grep/1.0', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HPAAgent/grep/1.0', 'Accept': 'text/html' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function callLLM(messages) {
  const res = await openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const content = res.choices?.[0]?.message?.content || '{}';
  const parsed = safeJsonParse(content) || { raw: content };
  const usage = res.usage || {};
  return { parsed, usage, raw: content };
}

function formatGrepForLLM(grepResult, pageName, url) {
  const header = [
    `GREP RESULT`,
    `page: ${pageName || 'main'}`,
    `url: ${url}`,
    `term: ${grepResult.term}`,
    `found: ${grepResult.found}`,
    `start_line: ${grepResult.start_line}`,
    `truncated: ${grepResult.truncated}`,
    `next_start_line: ${grepResult.next_start_line ?? 'null'}`,
    ``,
  ].join('\n');

  if (!grepResult.matches.length) {
    return header + `NO MATCHES`;
  }

  const blocks = grepResult.matches.map(m => {
    return [
      `--- MATCH ${m.match_no} ---`,
      `line: ${m.line}`,
      `char_pos: ${m.char_pos}`,
      `in_script: ${m.in_script}`,
      `nearest_table_open: ${m.nearest_table_open || 'null'}`,
      `nearest_div_open: ${m.nearest_div_open || 'null'}`,
      `context:\n${m.context}`,
    ].join('\n');
  });

  return header + blocks.join('\n\n');
}

// -----------------------------
// Goal decomposition helper
// -----------------------------
function decomposeGoal(question) {
  const q = question.toLowerCase();
  const subtasks = [];
  const pagesRequested = [];

  // Detect explicit page requests
  const pageKeywords = {
    'cancer': 'cancer',
    'subcellular': 'subcellular',
    'tissue': 'tissue',
    'brain': 'brain',
    'single cell': 'single+cell',
    'cell line': 'cell+line',
    'blood': 'blood',
    'structure': 'structure',
    'interaction': 'interaction',
  };

  for (const [keyword, page] of Object.entries(pageKeywords)) {
    if (q.includes(keyword)) {
      pagesRequested.push(page);
      subtasks.push(`Get ${keyword} information`);
    }
  }

  // Detect "both X and Y" or "X and Y pages" patterns
  const bothPattern = /both\s+(?:the\s+)?(\w+)\s+(?:page\s+)?and\s+(?:the\s+)?(\w+)/i;
  const bothMatch = question.match(bothPattern);
  if (bothMatch) {
    // Ensure both are in the list
    const page1 = bothMatch[1].toLowerCase();
    const page2 = bothMatch[2].toLowerCase();
    if (pageKeywords[page1] && !pagesRequested.includes(pageKeywords[page1])) {
      pagesRequested.push(pageKeywords[page1]);
      subtasks.push(`Get ${page1} information`);
    }
    if (pageKeywords[page2] && !pagesRequested.includes(pageKeywords[page2])) {
      pagesRequested.push(pageKeywords[page2]);
      subtasks.push(`Get ${page2} information`);
    }
  }

  return { subtasks, pagesRequested };
}

// -----------------------------
// Main handler (exported)
// -----------------------------
async function investigationAgent(args, ctx = {}) {
  const { gene, question } = args;
  const onStep = ctx.onStep || (() => {});
  const maxSteps = args.max_steps || 25; // Increased for multi-page queries

  if (!gene) {
    return { found: false, error: 'No gene provided' };
  }

  const q = question || `Tell me about ${gene}`;

  // Resolve gene
  let searchData;
  try {
    searchData = await fetchJson(`https://www.proteinatlas.org/search/${encodeURIComponent(gene)}?format=json&download=yes`);
  } catch (err) {
    return { found: false, error: `Gene search failed: ${err.message}` };
  }

  if (!Array.isArray(searchData) || !searchData.length) {
    return { found: false, error: 'Gene not found in HPA' };
  }

  const geneRow = searchData.find(g => (g.Gene || '').toUpperCase() === gene.toUpperCase()) || searchData[0];
  const ensembl = geneRow.Ensembl;
  const geneName = geneRow.Gene;
  const baseUrl = `https://www.proteinatlas.org/${ensembl}-${geneName}`;

  onStep({ stage: 'selection_step', label: 'Resolved', message: `${geneName} (${ensembl})`, url: baseUrl });

  const PAGES = {
    '': '',
    tissue: '/tissue',
    brain: '/brain',
    'single+cell': '/single+cell',
    subcellular: '/subcellular',
    cancer: '/cancer',
    blood: '/blood',
    'cell+line': '/cell+line',
    structure: '/structure',
    interaction: '/interaction',
  };

  const PAGE_LABELS = {
    '': 'Summary',
    'main': 'Summary',
    tissue: 'Tissue',
    brain: 'Brain',
    'single+cell': 'Single Cell',
    subcellular: 'Subcellular',
    cancer: 'Cancer',
    blood: 'Blood',
    'cell+line': 'Cell Line',
    structure: 'Structure',
    interaction: 'Interaction',
  };

  const pageCache = new Map();

  function pageKey(name) {
    return (name || '').trim();
  }

  async function gotoPage(name) {
    const key = pageKey(name);
    if (!(key in PAGES)) {
      return { ok: false, msg: `Unknown page "${name}". Allowed: ${Object.keys(PAGES).join(', ')}` };
    }

    if (!pageCache.has(key)) {
      const url = baseUrl + PAGES[key];
      const html = await fetchText(url);
      const lineStarts = buildLineStarts(html);
      pageCache.set(key, { html, lineStarts, url });
    }

    const { html, url } = pageCache.get(key);
    return { ok: true, page: key, url, size_kb: (html.length / 1024).toFixed(1) };
  }

  // Conversation state
  let currentPage = null;
  let lastObservation = `No page loaded yet. Choose a page using action=GOTO.`;

  // ========== NEW: Accumulated notes - persists across steps ==========
  const accumulatedNotes = [];

  // ========== NEW: Goal tracking ==========
  const { subtasks, pagesRequested } = decomposeGoal(q);
  const pagesVisitedWithData = new Set(); // Pages where we actually found data

  const system = {
    role: 'system',
    content:
`You are navigating Human Protein Atlas (HPA) pages using only raw HTML and grep-like search.

QUESTION: "${q}"

${pagesRequested.length > 0 ? `
⚠️ REQUIRED PAGES TO CHECK: ${pagesRequested.join(', ')}
You MUST visit ALL of these pages and gather data from each before answering.
` : ''}

You must operate like a human doing:
- curl -s URL | grep -i TERM | head -N
- grep -i -B5 -A5 TERM
- Ctrl+F Next (use start_line=next_start_line from previous grep)

Available pages:
${Object.keys(PAGES).map(k => (k === '' ? '"" (main)' : k)).join(', ')}

PAGE HINTS:
- cell+line: ALL cell line expression data (nTPM), including cancer cell lines grouped by cancer type
- cancer: TCGA tumor data, prognostic markers, NOT cell line data
- interaction: protein-protein interactions (BioPlex, IntAct, BioGrid, OpenCell)
- structure: protein variants, isoforms, sequence info
- tissue/brain/blood: tissue expression data
- subcellular: localization within cells (nucleus, cytoplasm, membrane, etc.)

CRITICAL - TAKE NOTES:
When you find useful data on a page, use action=NOTE to save it BEFORE moving to another page.
Notes persist across all steps. Your accumulated notes will be shown in observations.

CRITICAL - VALIDATION BEFORE ANSWERING:
Before using action=ANSWER, use action=VALIDATE to check if you've addressed all parts of the question.
The validator will tell you what's missing.

FOR GENERAL QUESTIONS ("tell me about", "summary", "what is this gene"):
- The main page navigation tooltips (title= attributes in atlas_nav div) contain summary info
- For a general overview, synthesize info from these navigation tooltips

IMPORTANT - KEEP FIGHTING:
- If a search returns NO MATCHES, try a DIFFERENT page or a DIFFERENT search term
- Try partial terms (e.g., if "NCE-G 111" fails, try just "NCE" or "brain cancer")
- Try at least 3 different pages before giving up
- Only ANSWER "not found" after exhausting options

You MUST NOT GUESS. Only answer if the value is present in a GREP match context you saw.

Return JSON ONLY with this shape:
{
  "reasoning": "short step-by-step reasoning",
  "action": "GOTO" | "GREP" | "NOTE" | "VALIDATE" | "ANSWER",
  "page": "interaction | brain | ... | \\"\\\" (for main)  (only if GOTO)",
  "term": "string (only if GREP)",
  "ignore_case": true/false (optional, GREP),
  "before": number (optional, GREP),
  "after": number (optional, GREP),
  "max_matches": number (optional, GREP),
  "start_line": number (optional, GREP),
  "note": "string - key finding to save (only if NOTE)",
  "note_source": "page name and line numbers (only if NOTE)",
  "answer": "string - comprehensive answer using ALL accumulated notes (only if ANSWER)",
  "citation": "string (only if ANSWER)"
}`
  };

  const messages = [system];
  const visitedPages = [];

  for (let step = 1; step <= maxSteps; step++) {
    // Include accumulated notes in observation
    let notesSection = '';
    if (accumulatedNotes.length > 0) {
      notesSection = `\n\n=== ACCUMULATED NOTES (${accumulatedNotes.length}) ===\n` +
        accumulatedNotes.map((n, i) => `[${i+1}] ${n.note} (from: ${n.source})`).join('\n') +
        '\n=== END NOTES ===';
    }

    // Include pages still needed
    let pagesNeededSection = '';
    if (pagesRequested.length > 0) {
      const stillNeeded = pagesRequested.filter(p => !pagesVisitedWithData.has(p));
      if (stillNeeded.length > 0) {
        pagesNeededSection = `\n\n⚠️ PAGES STILL NEEDED: ${stillNeeded.join(', ')}`;
      }
    }

    messages.push({ role: 'user', content: lastObservation + notesSection + pagesNeededSection });

    onStep({ stage: 'planning_step', label: 'Analyzing', message: `Processing data...` });

    const { parsed, usage } = await callLLM(messages);

    if (!parsed || typeof parsed !== 'object') {
      return { found: false, error: 'Bad JSON from model' };
    }

    const reasoning = (parsed.reasoning || '').trim();
    const action = (parsed.action || '').trim().toUpperCase();

    const ACTION_LABELS = {
      'GOTO': 'Navigate',
      'GREP': 'Search',
      'NOTE': 'Save Note',
      'VALIDATE': 'Validate',
      'ANSWER': 'Conclude'
    };
    const actionLabel = ACTION_LABELS[action] || action;

    onStep({ stage: 'reasoning_step', label: actionLabel, message: reasoning });

    messages.push({ role: 'assistant', content: JSON.stringify(parsed) });

    if (action === 'GOTO') {
      const page = parsed.page === '""' ? '' : (parsed.page || '');
      const r = await gotoPage(page);
      if (!r.ok) {
        lastObservation = `GOTO failed: ${r.msg}`;
        continue;
      }
      currentPage = r.page;
      visitedPages.push({ page: currentPage || 'main', url: r.url });

      const pageLabel = PAGE_LABELS[currentPage] || PAGE_LABELS[''] || 'Summary';
      onStep({ stage: 'execution_step', label: `Navigate`, message: pageLabel, url: r.url });

      lastObservation = `Loaded page "${currentPage || 'main'}" (${r.size_kb} KB)\nURL: ${r.url}\nNow you can GREP for terms.`;
      continue;
    }

    if (action === 'GREP') {
      if (currentPage === null) {
        lastObservation = `No page loaded. You must GOTO a page first.`;
        continue;
      }
      const term = (parsed.term || '').trim();
      if (!term) {
        lastObservation = `GREP requires a non-empty term.`;
        continue;
      }

      const searchPageLabel = PAGE_LABELS[currentPage] || PAGE_LABELS[''] || 'Summary';
      onStep({ stage: 'execution_step', label: `Search`, message: `"${term}" on ${searchPageLabel}`, visual: 'scan' });

      const ignore_case = (typeof parsed.ignore_case === 'boolean') ? parsed.ignore_case : true;
      const before = Number.isFinite(parsed.before) ? parsed.before : 0;
      const after = Number.isFinite(parsed.after) ? parsed.after : 0;
      const max_matches = Number.isFinite(parsed.max_matches) ? parsed.max_matches : 10;
      const start_line = Number.isFinite(parsed.start_line) ? parsed.start_line : 1;

      const { html, lineStarts, url } = pageCache.get(currentPage);
      const grepResult = grepHtml(html, lineStarts, term, {
        ignore_case,
        before,
        after,
        max_matches: clamp(max_matches, 1, 25),
        start_line: clamp(start_line, 1, 1_000_000),
      });

      const foundMsg = grepResult.found > 0
        ? `Found ${grepResult.found} match${grepResult.found > 1 ? 'es' : ''} for "${term}"`
        : `No matches for "${term}"`;
      onStep({ stage: grepResult.found > 0 ? 'selection_step' : 'reasoning_step', label: 'Results', message: foundMsg });

      lastObservation = formatGrepForLLM(grepResult, currentPage, url);
      continue;
    }

    // ========== NEW: NOTE action ==========
    if (action === 'NOTE') {
      const note = (parsed.note || '').trim();
      const noteSource = (parsed.note_source || currentPage || 'unknown').trim();

      if (!note) {
        lastObservation = `NOTE requires a non-empty note string.`;
        continue;
      }

      accumulatedNotes.push({ note, source: noteSource });

      // Mark this page as having provided data
      if (currentPage !== null) {
        pagesVisitedWithData.add(currentPage);
      }

      onStep({ stage: 'selection_step', label: 'Note Saved', message: `Saved: "${note.slice(0, 80)}${note.length > 80 ? '...' : ''}"` });

      lastObservation = `Note saved (${accumulatedNotes.length} total). Continue searching or use VALIDATE before ANSWER.`;
      continue;
    }

    // ========== NEW: VALIDATE action ==========
    if (action === 'VALIDATE') {
      const issues = [];

      // Check if all required pages were visited with data
      if (pagesRequested.length > 0) {
        const stillNeeded = pagesRequested.filter(p => !pagesVisitedWithData.has(p));
        if (stillNeeded.length > 0) {
          issues.push(`Missing data from required pages: ${stillNeeded.join(', ')}`);
        }
      }

      // Check if we have any notes
      if (accumulatedNotes.length === 0) {
        issues.push(`No notes saved. You must save findings using NOTE before answering.`);
      }

      if (issues.length === 0) {
        onStep({ stage: 'selection_step', label: 'Validated', message: 'All requirements met ✓' });
        lastObservation = `VALIDATION PASSED ✓\nYou have:\n- ${accumulatedNotes.length} notes saved\n- Data from: ${Array.from(pagesVisitedWithData).join(', ') || 'none'}\n\nYou may now ANSWER.`;
      } else {
        onStep({ stage: 'reasoning_step', label: 'Validation Failed', message: issues.join('; ') });
        lastObservation = `VALIDATION FAILED ✗\nIssues:\n${issues.map(i => '- ' + i).join('\n')}\n\nFix these before answering.`;
      }
      continue;
    }

    if (action === 'ANSWER') {
      // ========== NEW: Auto-validate before answering ==========
      const stillNeeded = pagesRequested.filter(p => !pagesVisitedWithData.has(p));
      if (stillNeeded.length > 0) {
        onStep({ stage: 'reasoning_step', label: 'Blocked', message: `Cannot answer yet - missing: ${stillNeeded.join(', ')}` });
        lastObservation = `CANNOT ANSWER YET.\nYou still need to get data from: ${stillNeeded.join(', ')}\nUse GOTO and GREP on those pages, then NOTE your findings.`;
        continue;
      }

      const ans = (parsed.answer || '').trim();
      const citation = (parsed.citation || '').trim();

      onStep({ stage: 'complete', label: 'Answer Found', message: ans });

      const resources = visitedPages.map(p => ({
        label: PAGE_LABELS[p.page] || PAGE_LABELS[''] || 'Summary',
        url: p.url
      }));

      return {
        found: true,
        answer: ans,
        citation,
        gene: geneName,
        ensembl,
        baseUrl,
        steps: step,
        resources,
        notes: accumulatedNotes, // Include notes in result
        summary_md: `**${geneName}** (${ensembl})\n\n${ans}\n\n_Source: ${citation}_`
      };
    }

    lastObservation = `Unknown action "${action}". Use GOTO, GREP, NOTE, VALIDATE, or ANSWER.`;
  }

  return {
    found: false,
    error: `No answer after ${maxSteps} steps`,
    gene: geneName,
    ensembl,
    baseUrl,
    notes: accumulatedNotes, // Include partial notes even on failure
  };
}

module.exports = investigationAgent;