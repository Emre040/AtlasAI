'use strict';

const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { client, MODEL } = require('../llm');

// =============================================================================
// ABOUT / RECEPTIONIST MODE
// =============================================================================

const ABOUT_PAGES = [
  // About pages
  { key: 'overview',       url: 'https://www.proteinatlas.org/about',                  desc: 'General overview of HPA, what each section covers (Tissue, Brain, Single Cell, Cancer, Blood, etc.)' },
  { key: 'history',        url: 'https://www.proteinatlas.org/about/history',           desc: 'Timeline and milestones of the HPA project' },
  { key: 'organization',   url: 'https://www.proteinatlas.org/about/organization',      desc: 'Team, leadership, departments, consortium members' },
  { key: 'publications',   url: 'https://www.proteinatlas.org/about/publications',      desc: 'List of HPA publications and how to cite HPA' },
  { key: 'acknowledgments',url: 'https://www.proteinatlas.org/about/acknowledgments',   desc: 'Funders, grants, collaborators, acknowledgments' },
  { key: 'publicationdata',url: 'https://www.proteinatlas.org/about/publicationdata',   desc: 'How HPA data is used in publications and research' },
  { key: 'download',       url: 'https://www.proteinatlas.org/about/download',          desc: 'API access, bulk data downloads, file formats, programmatic access' },
  { key: 'releases',       url: 'https://www.proteinatlas.org/about/releases',          desc: 'Version history, release notes, changelog, what changed in each version' },
  // Atlas / humanproteome pages
  { key: 'tissue-atlas',   url: 'https://www.proteinatlas.org/humanproteome/tissue',    desc: 'Tissue Atlas: tissue expression, tissue-specific proteins, RNA and protein data across human tissues and organs' },
  { key: 'brain-atlas',    url: 'https://www.proteinatlas.org/humanproteome/brain',     desc: 'Brain Atlas: brain region expression, regional specificity, protein and RNA across brain regions' },
  { key: 'single-cell-atlas', url: 'https://www.proteinatlas.org/humanproteome/single+cell', desc: 'Single Cell Atlas: single cell type expression, cell type specificity, scRNA-seq data, cell type groups' },
  { key: 'cancer-atlas',   url: 'https://www.proteinatlas.org/humanproteome/cancer',    desc: 'Cancer Atlas: cancer/tumor expression, prognostic markers, pathology, survival analysis' },
  { key: 'blood-atlas',    url: 'https://www.proteinatlas.org/humanproteome/blood',     desc: 'Blood Atlas: blood protein levels, secretome, plasma/serum proteins, immunoassays, disease biomarkers' },
  { key: 'cell-line-atlas', url: 'https://www.proteinatlas.org/humanproteome/cell+line', desc: 'Cell Line Atlas: cell line expression, cancer cell lines, CRISPR essentiality, protein levels in cell lines' },
  { key: 'subcellular-atlas', url: 'https://www.proteinatlas.org/humanproteome/subcellular', desc: 'Subcellular Atlas: protein subcellular localization, organelle proteomes, confocal microscopy, spatial proteomics' },
  { key: 'structure-atlas', url: 'https://www.proteinatlas.org/humanproteome/structure', desc: 'Structure Atlas: protein 3D structures, AlphaFold predictions, structural coverage, domains' },
  { key: 'interaction-atlas', url: 'https://www.proteinatlas.org/humanproteome/interaction', desc: 'Interaction Atlas: protein-protein interactions, interactome, interaction networks, complexes' },
];

async function fetchAboutHtml(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HPAAgent/receptionist', Accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Extract text sections from an about page.
 * Returns array of { heading, content } chunks.
 */
function extractAboutSections(html) {
  const $ = cheerio.load(html);

  // Remove nav, scripts, styles, footer, search bars, sidebar menus
  $('script, style, nav, footer, .search-container, #search, .cookie-bar, .menu, .menufix, #sidemenu, .menu_dropdown, .cookie_statement').remove();

  const sections = [];
  const headingSelector = 'h1, h2, h3, h4';

  $(headingSelector).each((_, el) => {
    const $el = $(el);
    const heading = $el.text().replace(/\s+/g, ' ').trim();
    if (!heading || heading.length < 2) return;

    // Collect sibling content until next heading
    const contentParts = [];
    let $next = $el.next();
    while ($next.length && !$next.is(headingSelector)) {
      // Extract text from paragraphs, lists, divs, tables
      const tag = $next.prop('tagName')?.toLowerCase();

      if (tag === 'table') {
        // Extract table as compact text rows
        const rows = [];
        $next.find('tr').each((_, tr) => {
          const cells = [];
          $(tr).find('th, td').each((__, cell) => {
            const txt = $(cell).text().replace(/\s+/g, ' ').trim();
            if (txt) cells.push(txt);
          });
          if (cells.length) rows.push(cells.join(' | '));
        });
        if (rows.length) contentParts.push(rows.join('\n'));
      } else if (tag === 'ul' || tag === 'ol') {
        const items = [];
        $next.find('li').each((__, li) => {
          const txt = $(li).text().replace(/\s+/g, ' ').trim();
          if (txt) items.push('- ' + txt);
        });
        if (items.length) contentParts.push(items.join('\n'));
      } else {
        const txt = $next.text().replace(/\s+/g, ' ').trim();
        if (txt && txt.length > 3) contentParts.push(txt);
      }

      $next = $next.next();
    }

    const content = contentParts.join('\n').trim();
    if (content.length > 5) {
      sections.push({ heading, content });
    }
  });

  // If no heading-based sections were found, fall back to extracting all main text
  if (sections.length === 0) {
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    if (bodyText.length > 20) {
      sections.push({ heading: 'Page Content', content: bodyText.slice(0, 5000) });
    }
  }

  return sections;
}

/**
 * Keyword-grep: score each section by how many question keywords it matches.
 * Returns sections sorted by relevance, trimmed to top N.
 * For "latest/current/newest" questions, biases toward earlier sections (which are newest on the page).
 */
function grepRelevantSections(sections, question, maxSections = 6) {
  const stopWords = new Set(['the','a','an','is','are','was','were','what','how','who','when','where','which','do','does','did','can','could','of','in','on','at','to','for','and','or','but','not','about','hpa','human','protein','atlas']);
  const recencyWords = new Set(['latest','current','currently','newest','recent','recently','now','today','last','updated','new']);

  const keywords = question.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Check if the question asks about something recent/latest
  const wantsRecent = keywords.some(kw => recencyWords.has(kw));

  console.log('[receptionist] grep keywords:', keywords, 'wantsRecent:', wantsRecent);

  if (keywords.length === 0 || wantsRecent) {
    // No useful keywords, or asking about "latest" — return first sections (newest on page)
    console.log('[receptionist] returning first', maxSections, 'sections (recency bias)');
    return sections.slice(0, maxSections);
  }

  const scored = sections.map((s, idx) => {
    const text = (s.heading + ' ' + s.content).toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      // Match keyword as prefix of a word (e.g. "cite" matches "citing", "citation")
      const re = new RegExp(kw, 'gi');
      const matches = text.match(re);
      if (matches) score += matches.length;
      // Also try stemmed match: strip trailing e/s/ing/ed/tion and search
      const stem = kw.replace(/(ing|tion|ed|es|s|e)$/, '');
      if (stem.length >= 3 && stem !== kw) {
        const stemRe = new RegExp(stem, 'gi');
        const stemMatches = text.match(stemRe);
        if (stemMatches) score += stemMatches.length;
      }
    }
    return { ...s, score, idx };
  });

  // Sort by score descending, break ties by page order (earlier = newer)
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const relevant = scored.filter(s => s.score > 0).slice(0, maxSections);

  console.log('[receptionist] grep scores:', relevant.map(s => `${s.heading.slice(0,40)}=${s.score}`));

  // If nothing matched, return first few sections as fallback
  return relevant.length > 0 ? relevant : sections.slice(0, maxSections);
}

/**
 * Pick the best about page(s) for a question using LLM.
 */
async function pickAboutPage(question) {
  const catalog = ABOUT_PAGES.map((p, i) => `${i}. ${p.key}: ${p.desc}`).join('\n');

  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content:
        'You route questions about the Human Protein Atlas to the correct about page.\n' +
        'Given the question, return JSON: {"pages": [index1, index2]} with 1-2 page indices (prefer 1).\n' +
        'Available pages:\n' + catalog
      },
      { role: 'user', content: question }
    ]
  });

  const content = res.choices?.[0]?.message?.content || '';
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = { pages: [0] }; }

  const indices = (parsed.pages || [0]).filter(i => i >= 0 && i < ABOUT_PAGES.length);
  const tokens = res.usage || {};
  return {
    pages: indices.length ? indices.map(i => ABOUT_PAGES[i]) : [ABOUT_PAGES[0]],
    tokens: { prompt_tokens: tokens.prompt_tokens || 0, completion_tokens: tokens.completion_tokens || 0, total_tokens: tokens.total_tokens || 0 }
  };
}

/**
 * Handle a receptionist / about-HPA question.
 * 1. LLM picks the right page
 * 2. Fetch HTML
 * 3. Extract sections
 * 4. Keyword-grep relevant chunks
 * 5. Return chunks for synthesis
 */
async function handleAboutQuestion(question, onStep) {
  console.log('[receptionist] === START ===');
  console.log('[receptionist] question:', question);
  await onStep?.({ stage: 'start', message: `About HPA: "${question}"` });

  // Step 1: Route to the right page
  await onStep?.({ stage: 'execution_step', label: 'Routing', message: 'Picking the right about page...' });
  const { pages, tokens: routeTokens } = await pickAboutPage(question);
  console.log('[receptionist] routed to:', pages.map(p => p.key));
  console.log('[receptionist] route tokens:', routeTokens.total_tokens);

  const allChunks = [];
  const tokenUsageLog = [routeTokens];
  let totalTokens = { ...routeTokens };

  // Step 2-4: Fetch each page, extract, grep
  for (const page of pages) {
    await onStep?.({ stage: 'execution_step', label: `Fetching`, message: `Reading ${page.key} page...`, url: page.url });

    const html = await fetchAboutHtml(page.url);
    console.log('[receptionist] fetched', page.key, '→', html.length, 'bytes');
    const sections = extractAboutSections(html);
    console.log('[receptionist] extracted', sections.length, 'sections:', sections.map(s => s.heading.slice(0, 50)));
    const relevant = grepRelevantSections(sections, question);
    console.log('[receptionist] grep selected', relevant.length, 'sections:', relevant.map(s => s.heading.slice(0, 50)));

    // Smart truncation: keep sections under 5k intact, cap huge ones.
    // Budget: ~12k total chars to keep synthesis context lean.
    const MAX_SECTION = 5000;
    const MAX_TOTAL = 12000;
    let totalSoFar = allChunks.reduce((sum, c) => sum + c.content.length, 0);

    for (const s of relevant) {
      let content = s.content;
      if (content.length > MAX_SECTION) {
        content = content.slice(0, MAX_SECTION) + '...';
      }
      if (totalSoFar + content.length > MAX_TOTAL) {
        const remaining = MAX_TOTAL - totalSoFar;
        if (remaining < 200) break; // not enough room, skip
        content = content.slice(0, remaining) + '...';
      }
      totalSoFar += content.length;
      allChunks.push({ page: page.key, url: page.url, heading: s.heading, content });
    }
    console.log('[receptionist] total context so far:', totalSoFar, 'chars across', allChunks.length, 'chunks');
  }

  if (allChunks.length === 0) {
    await onStep?.({ stage: 'complete', label: 'No content', message: 'Could not extract relevant content from about pages.' });
    return {
      status: 'not_found',
      mode: 'about',
      question,
      message: 'Could not find relevant information on the HPA about pages.',
      tokenUsage: { steps: tokenUsageLog, total: totalTokens }
    };
  }

  // Build context for synthesis
  const contextMd = allChunks.map(c =>
    `## ${c.heading}\n*(source: ${c.url})*\n${c.content}`
  ).join('\n\n');

  await onStep?.({
    stage: 'complete',
    label: 'Done',
    message: `Found ${allChunks.length} relevant sections from ${pages.map(p => p.key).join(', ')} | Tokens: ${totalTokens.total_tokens}`,
    tokenUsage: { steps: tokenUsageLog, total: totalTokens }
  });

  return {
    status: 'ok',
    mode: 'about',
    question,
    pages_consulted: pages.map(p => ({ key: p.key, url: p.url })),
    context: contextMd,
    chunk_count: allChunks.length,
    summary_md: `# About the Human Protein Atlas\n\n${contextMd}`,
    tokenUsage: { steps: tokenUsageLog, total: totalTokens }
  };
}

// Complete dictionary of HPA histology pages
const DICTIONARY_CATEGORIES = {
  // Normal tissues
  'cerebral cortex': { url: '/learn/dictionary/normal/cerebral+cortex', category: 'normal', group: 'Brain' },
  'hippocampus': { url: '/learn/dictionary/normal/hippocampus', category: 'normal', group: 'Brain' },
  'caudate': { url: '/learn/dictionary/normal/caudate', category: 'normal', group: 'Brain' },
  'cerebellum': { url: '/learn/dictionary/normal/cerebellum', category: 'normal', group: 'Brain' },
  'thyroid gland': { url: '/learn/dictionary/normal/thyroid+gland', category: 'normal', group: 'Endocrine' },
  'parathyroid gland': { url: '/learn/dictionary/normal/parathyroid+gland', category: 'normal', group: 'Endocrine' },
  'adrenal gland': { url: '/learn/dictionary/normal/adrenal+gland', category: 'normal', group: 'Endocrine' },
  'nasopharynx': { url: '/learn/dictionary/normal/nasopharynx', category: 'normal', group: 'Respiratory' },
  'bronchus': { url: '/learn/dictionary/normal/bronchus', category: 'normal', group: 'Respiratory' },
  'lung': { url: '/learn/dictionary/normal/lung', category: 'normal', group: 'Respiratory' },
  'oral mucosa': { url: '/learn/dictionary/normal/oral+mucosa', category: 'normal', group: 'Digestive' },
  'salivary gland': { url: '/learn/dictionary/normal/salivary+gland', category: 'normal', group: 'Digestive' },
  'esophagus': { url: '/learn/dictionary/normal/esophagus', category: 'normal', group: 'Digestive' },
  'stomach': { url: '/learn/dictionary/normal/stomach', category: 'normal', group: 'GI Tract' },
  'duodenum': { url: '/learn/dictionary/normal/duodenum', category: 'normal', group: 'GI Tract' },
  'small intestine': { url: '/learn/dictionary/normal/small+intestine', category: 'normal', group: 'GI Tract' },
  'colon': { url: '/learn/dictionary/normal/colon', category: 'normal', group: 'GI Tract' },
  'rectum': { url: '/learn/dictionary/normal/rectum', category: 'normal', group: 'GI Tract' },
  'liver': { url: '/learn/dictionary/normal/liver', category: 'normal', group: 'Liver & Gallbladder' },
  'gallbladder': { url: '/learn/dictionary/normal/gallbladder', category: 'normal', group: 'Liver & Gallbladder' },
  'pancreas': { url: '/learn/dictionary/normal/pancreas', category: 'normal', group: 'Pancreas' },
  'kidney': { url: '/learn/dictionary/normal/kidney', category: 'normal', group: 'Urinary' },
  'urinary bladder': { url: '/learn/dictionary/normal/urinary+bladder', category: 'normal', group: 'Urinary' },
  'testis': { url: '/learn/dictionary/normal/testis', category: 'normal', group: 'Male' },
  'epididymis': { url: '/learn/dictionary/normal/epididymis', category: 'normal', group: 'Male' },
  'seminal vesicle': { url: '/learn/dictionary/normal/seminal+vesicle', category: 'normal', group: 'Male' },
  'prostate': { url: '/learn/dictionary/normal/prostate', category: 'normal', group: 'Male' },
  'vagina': { url: '/learn/dictionary/normal/vagina', category: 'normal', group: 'Female' },
  'ovary': { url: '/learn/dictionary/normal/ovary', category: 'normal', group: 'Female' },
  'fallopian tube': { url: '/learn/dictionary/normal/fallopian+tube', category: 'normal', group: 'Female' },
  'endometrium': { url: '/learn/dictionary/normal/endometrium', category: 'normal', group: 'Female' },
  'cervix': { url: '/learn/dictionary/normal/cervix', category: 'normal', group: 'Female' },
  'placenta': { url: '/learn/dictionary/normal/placenta', category: 'normal', group: 'Female' },
  'breast': { url: '/learn/dictionary/normal/breast', category: 'normal', group: 'Female' },
  'heart muscle': { url: '/learn/dictionary/normal/heart+muscle', category: 'normal', group: 'Muscle' },
  'smooth muscle': { url: '/learn/dictionary/normal/smooth+muscle', category: 'normal', group: 'Muscle' },
  'skeletal muscle': { url: '/learn/dictionary/normal/skeletal+muscle', category: 'normal', group: 'Muscle' },
  'adipose tissue': { url: '/learn/dictionary/normal/adipose+tissue', category: 'normal', group: 'Connective' },
  'skin': { url: '/learn/dictionary/normal/skin', category: 'normal', group: 'Skin' },
  'bone marrow': { url: '/learn/dictionary/normal/bone+marrow', category: 'normal', group: 'Lymphoid' },
  'lymph node': { url: '/learn/dictionary/normal/lymph+node', category: 'normal', group: 'Lymphoid' },
  'tonsil': { url: '/learn/dictionary/normal/tonsil', category: 'normal', group: 'Lymphoid' },
  'spleen': { url: '/learn/dictionary/normal/spleen', category: 'normal', group: 'Lymphoid' },
  'appendix': { url: '/learn/dictionary/normal/appendix', category: 'normal', group: 'Lymphoid' },

  // Cancer
  'glioma': { url: '/learn/dictionary/cancer/glioma', category: 'cancer', group: 'Brain tumors' },
  'head and neck cancer': { url: '/learn/dictionary/cancer/head+and+neck+cancer', category: 'cancer', group: 'Head and Neck' },
  'thyroid cancer': { url: '/learn/dictionary/cancer/thyroid+cancer', category: 'cancer', group: 'Endocrine tumors' },
  'neuroendocrine tumors': { url: '/learn/dictionary/cancer/neuroendocrine+tumors', category: 'cancer', group: 'Endocrine tumors' },
  'lung cancer': { url: '/learn/dictionary/cancer/lung+cancer', category: 'cancer', group: 'Lung tumors' },
  'stomach cancer': { url: '/learn/dictionary/cancer/stomach+cancer', category: 'cancer', group: 'Abdominal tumors' },
  'colorectal cancer': { url: '/learn/dictionary/cancer/colorectal+cancer', category: 'cancer', group: 'Abdominal tumors' },
  'liver cancer': { url: '/learn/dictionary/cancer/liver+cancer', category: 'cancer', group: 'Abdominal tumors' },
  'pancreatic cancer': { url: '/learn/dictionary/cancer/pancreatic+cancer', category: 'cancer', group: 'Abdominal tumors' },
  'renal cancer': { url: '/learn/dictionary/cancer/renal+cancer', category: 'cancer', group: 'Uro-genital tumors' },
  'urothelial cancer': { url: '/learn/dictionary/cancer/urothelial+cancer', category: 'cancer', group: 'Uro-genital tumors' },
  'testis cancer': { url: '/learn/dictionary/cancer/testis+cancer', category: 'cancer', group: 'Uro-genital tumors' },
  'prostate cancer': { url: '/learn/dictionary/cancer/prostate+cancer', category: 'cancer', group: 'Uro-genital tumors' },
  'ovarian cancer': { url: '/learn/dictionary/cancer/ovarian+cancer', category: 'cancer', group: 'Uro-genital tumors' },
  'endometrial cancer': { url: '/learn/dictionary/cancer/endometrial+cancer', category: 'cancer', group: 'Uro-genital tumors' },
  'cervical cancer': { url: '/learn/dictionary/cancer/cervical+cancer', category: 'cancer', group: 'Uro-genital tumors' },
  'breast cancer': { url: '/learn/dictionary/cancer/breast+cancer', category: 'cancer', group: 'Breast tumors' },
  'melanoma': { url: '/learn/dictionary/cancer/melanoma', category: 'cancer', group: 'Skin tumors' },
  'basal cell and squamous cell cancer': { url: '/learn/dictionary/cancer/basal+cell+and+squamous+cell+cancer', category: 'cancer', group: 'Skin tumors' },
  'lymphoma': { url: '/learn/dictionary/cancer/lymphoma', category: 'cancer', group: 'Lymphoid tumors' },

  // Cell structures
  'actin filaments': { url: '/learn/dictionary/cell/actin+filaments', category: 'cell', group: 'Cytoplasm' },
  'aggresome': { url: '/learn/dictionary/cell/aggresome', category: 'cell', group: 'Cytoplasm' },
  'centrosome': { url: '/learn/dictionary/cell/centrosome', category: 'cell', group: 'Cytoplasm' },
  'cytosol': { url: '/learn/dictionary/cell/cytosol', category: 'cell', group: 'Cytoplasm' },
  'microtubules': { url: '/learn/dictionary/cell/microtubules', category: 'cell', group: 'Cytoplasm' },
  'mitochondria': { url: '/learn/dictionary/cell/mitochondria', category: 'cell', group: 'Cytoplasm' },
  'endoplasmic reticulum': { url: '/learn/dictionary/cell/endoplasmic+reticulum', category: 'cell', group: 'Endomembrane' },
  'golgi apparatus': { url: '/learn/dictionary/cell/golgi+apparatus', category: 'cell', group: 'Endomembrane' },
  'lysosomes': { url: '/learn/dictionary/cell/lysosomes', category: 'cell', group: 'Endomembrane' },
  'plasma membrane': { url: '/learn/dictionary/cell/plasma+membrane', category: 'cell', group: 'Endomembrane' },
  'nucleoli': { url: '/learn/dictionary/cell/nucleoli', category: 'cell', group: 'Nucleus' },
  'nucleoplasm': { url: '/learn/dictionary/cell/nucleoplasm', category: 'cell', group: 'Nucleus' },
  'nuclear membrane': { url: '/learn/dictionary/cell/nuclear+membrane', category: 'cell', group: 'Nucleus' },
};

// Helper function to wait
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Use LLM to find the best matching dictionary category(ies)
 * The LLM sees ALL available categories and picks semantically appropriate ones
 * Returns { results, tokenUsage }
 */
async function findBestCategories(topic, onStep) {
  await onStep?.({ stage: 'reasoning_step', label: 'Matching', message: `Finding dictionary matches for: ${topic}` });

  // Build a structured view of all categories for the LLM
  const categoriesJson = JSON.stringify(DICTIONARY_CATEGORIES, null, 2);

  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `You are a histology/pathology expert helping users find relevant entries in the Human Protein Atlas Dictionary.

Here are ALL available dictionary entries (the keys are the exact names you must return):

${categoriesJson}

Your job: Given a user's query, select the most relevant dictionary entries using SEMANTIC understanding.

Examples of semantic matching:
- "brain cancer" → ["glioma"] (glioma is the brain tumor entry)
- "colon cancer" → ["colorectal cancer"] 
- "kidney cancer" → ["renal cancer"]
- "skin cancer" → ["melanoma", "basal cell and squamous cell cancer"]
- "cell nucleus" → ["nucleoli", "nucleoplasm", "nuclear membrane"]
- "compare liver and kidney" → ["liver", "kidney"]
- "digestive system" → ["stomach", "duodenum", "small intestine", "colon", "rectum"]

Rules:
1. Return EXACT keys from the dictionary (lowercase, as shown above)
2. Use semantic/medical knowledge - don't just string match
3. For multi-topic queries, return all relevant entries
4. For single specific topics, usually return 1-2 entries
5. For broad topics (e.g., "digestive system"), return relevant related entries

Reply with ONLY a JSON array of exact dictionary keys. Example: ["glioma"] or ["liver", "kidney"]
If truly no match exists, reply: []`
      },
      {
        role: 'user',
        content: `Query: "${topic}"`
      }
    ]
  });

  // Extract token usage
  const tokenUsage = {
    step: 'findBestCategories',
    topic,
    prompt_tokens: response.usage?.prompt_tokens || 0,
    completion_tokens: response.usage?.completion_tokens || 0,
    total_tokens: response.usage?.total_tokens || 0
  };
  console.log(`[dictionaryExpert] Token usage for "${topic}":`, tokenUsage);

  const content = response.choices[0]?.message?.content?.trim() || '[]';
  console.log(`[dictionaryExpert] LLM response for "${topic}":`, content);

  try {
    // Clean up response in case LLM added markdown
    const cleanedContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const matches = JSON.parse(cleanedContent);
    const results = [];

    for (const match of matches) {
      const name = match.toLowerCase();
      if (DICTIONARY_CATEGORIES[name]) {
        results.push({ name, ...DICTIONARY_CATEGORIES[name] });
      } else {
        console.warn(`[dictionaryExpert] LLM returned unknown category: "${name}"`);
      }
    }

    if (results.length > 0) {
      await onStep?.({ stage: 'reasoning_step', label: 'Found', message: `Matched to: ${results.map(r => r.name).join(', ')}`, tokenUsage });
      return { results, tokenUsage };
    }
  } catch (e) {
    console.error(`[dictionaryExpert] Failed to parse LLM response:`, e.message, 'Content:', content);
  }

  await onStep?.({ stage: 'reasoning_step', label: 'No Match', message: `No categories matched for: ${topic}`, tokenUsage });
  return { results: [], tokenUsage };
}

/**
 * Extract SVG annotations from the current viewer state
 * Uses annot_div.seadragonMeta for hierarchy info, SVG for shapes
 */
async function extractAnnotations(page) {
  const annotations = await page.evaluate(() => {
    const results = [];

    // First, try to extract hierarchy from annot_div.seadragonMeta
    const hierarchyMap = new Map(); // text -> { parentText, children: [] }

    // Try multiple selectors for the annotation metadata div
    const metaDiv = document.querySelector('.annot_div.seadragonMeta') ||
                    document.querySelector('.seadragonMeta') ||
                    document.querySelector('.annot_div') ||
                    document.querySelector('#annotations');

    console.log('[extractAnnotations] metaDiv found:', !!metaDiv, metaDiv?.className);

    if (metaDiv) {
      // Debug: log the structure
      console.log('[extractAnnotations] metaDiv children:', metaDiv.children.length);
      console.log('[extractAnnotations] metaDiv HTML preview:', metaDiv.innerHTML?.slice(0, 500));

      // The metaDiv contains .example and .annotation divs that show hierarchy
      const processMetaDiv = (container, parentText = null, depth = 0) => {
        const directChildren = Array.from(container.children);

        directChildren.forEach(child => {
          // Look for example/annotation classes or divs with annotation-like content
          if (child.classList.contains('example') ||
              child.classList.contains('annotation') ||
              child.tagName === 'DIV' && child.querySelector('span, a')) {

            // The label might be in various places
            const labelEl = child.querySelector(':scope > span') ||
                           child.querySelector(':scope > a') ||
                           child.querySelector('span.label') ||
                           child.querySelector('a');

            // Get just the direct text content, not from nested elements
            let labelText = labelEl?.textContent?.trim();

            // If label is too long, it might contain child text - try to get just first line
            if (labelText && labelText.length > 50) {
              labelText = labelText.split('\n')[0].trim();
            }

            if (labelText && labelText.length > 1 && labelText.length < 100) {
              console.log('[hierarchy]', '  '.repeat(depth), labelText, '(parent:', parentText, ')');

              if (!hierarchyMap.has(labelText)) {
                hierarchyMap.set(labelText, { parentText, children: [] });
              }
              if (parentText && hierarchyMap.has(parentText)) {
                const parentEntry = hierarchyMap.get(parentText);
                if (!parentEntry.children.includes(labelText)) {
                  parentEntry.children.push(labelText);
                }
              }
              // Recurse into children
              processMetaDiv(child, labelText, depth + 1);
            } else {
              // Still recurse even if no label
              processMetaDiv(child, parentText, depth);
            }
          }
        });
      };

      processMetaDiv(metaDiv);
      console.log('[extractAnnotations] Hierarchy from metaDiv:', hierarchyMap.size, 'entries');
      hierarchyMap.forEach((v, k) => {
        if (v.children.length > 0) {
          console.log('[hierarchy] Parent:', k, '-> Children:', v.children);
        }
      });
    }

    // Find the annotation SVG overlay
    const allSvgs = document.querySelectorAll('svg');
    let annotationSvg = null;

    for (const svg of allSvgs) {
      // Look for groups with type attribute or annotation/example classes
      if (svg.querySelector('g[type], g.annotation, g.example')) {
        annotationSvg = svg;
        break;
      }
    }

    // Fallback: find any large SVG with groups
    if (!annotationSvg) {
      for (const svg of allSvgs) {
        const rect = svg.getBoundingClientRect();
        if (rect.width > 200 && rect.height > 200 && svg.querySelector('g')) {
          annotationSvg = svg;
          break;
        }
      }
    }

    if (!annotationSvg) {
      console.log('[extractAnnotations] No SVG found');
      return results;
    }

    // Helper to parse transform
    const parseTransform = (transformStr) => {
      if (!transformStr) return { x: 0, y: 0, scale: 1 };
      const translate = transformStr.match(/translate\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/);
      const scale = transformStr.match(/scale\(\s*([\d.-]+)\s*\)/);
      return {
        x: translate ? parseFloat(translate[1]) : 0,
        y: translate ? parseFloat(translate[2]) : 0,
        scale: scale ? parseFloat(scale[1]) : 1
      };
    };


    // Calculate bounding box size (for visibility threshold)
    const calcBoundingSize = (shapes) => {
      if (!shapes || shapes.length === 0) return 0;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      shapes.forEach(shape => {
        if (shape.type === 'circle') {
          minX = Math.min(minX, shape.cx - shape.r);
          maxX = Math.max(maxX, shape.cx + shape.r);
          minY = Math.min(minY, shape.cy - shape.r);
          maxY = Math.max(maxY, shape.cy + shape.r);
        } else if (shape.type === 'ellipse') {
          minX = Math.min(minX, shape.cx - shape.rx);
          maxX = Math.max(maxX, shape.cx + shape.rx);
          minY = Math.min(minY, shape.cy - shape.ry);
          maxY = Math.max(maxY, shape.cy + shape.ry);
        } else if (shape.type === 'rect' && !shape.isTxtBox) {
          minX = Math.min(minX, shape.x);
          maxX = Math.max(maxX, shape.x + shape.width);
          minY = Math.min(minY, shape.y);
          maxY = Math.max(maxY, shape.y + shape.height);
        } else if (shape.type === 'path' && shape.d) {
          const coords = shape.d.match(/[\d.]+/g)?.map(parseFloat) || [];
          for (let i = 0; i < coords.length; i += 2) {
            if (i + 1 < coords.length) {
              minX = Math.min(minX, coords[i]);
              maxX = Math.max(maxX, coords[i]);
              minY = Math.min(minY, coords[i + 1]);
              maxY = Math.max(maxY, coords[i + 1]);
            }
          }
        } else if (shape.type === 'line') {
          minX = Math.min(minX, shape.x1, shape.x2);
          maxX = Math.max(maxX, shape.x1, shape.x2);
          minY = Math.min(minY, shape.y1, shape.y2);
          maxY = Math.max(maxY, shape.y1, shape.y2);
        }
      });

      if (minX === Infinity) return 0;
      return Math.max(maxX - minX, maxY - minY);
    };

    // Find position from shapes
    const getPositionFromShapes = (shapes) => {
      if (!shapes || shapes.length === 0) return { x: 0, y: 0 };

      const s = shapes[0];
      if (s.type === 'circle' || s.type === 'ellipse') {
        return { x: s.cx, y: s.cy };
      } else if (s.type === 'rect') {
        return { x: s.x + (s.width || 0) / 2, y: s.y + (s.height || 0) / 2 };
      } else if (s.type === 'path' && s.d) {
        const match = s.d.match(/M\s*([\d.]+)[,\s]+([\d.]+)/i);
        if (match) return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
      } else if (s.type === 'line') {
        return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
      }
      return { x: 0, y: 0 };
    };

    // Extract shapes that are DIRECT children only (not from nested groups)
    const extractDirectShapes = (group) => {
      const shapes = [];
      // Only look at direct children, not nested in child groups
      Array.from(group.children).forEach(el => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'g') return; // Skip nested groups

        if (tag === 'circle') {
          shapes.push({
            type: 'circle',
            cx: parseFloat(el.getAttribute('cx')) || 0,
            cy: parseFloat(el.getAttribute('cy')) || 0,
            r: parseFloat(el.getAttribute('r')) || 0.01,
            stroke: el.getAttribute('stroke') || '#000',
            fill: el.getAttribute('fill') || 'none'
          });
        } else if (tag === 'ellipse') {
          shapes.push({
            type: 'ellipse',
            cx: parseFloat(el.getAttribute('cx')) || 0,
            cy: parseFloat(el.getAttribute('cy')) || 0,
            rx: parseFloat(el.getAttribute('rx')) || 0.01,
            ry: parseFloat(el.getAttribute('ry')) || 0.01,
            stroke: el.getAttribute('stroke') || '#000',
            fill: el.getAttribute('fill') || 'none'
          });
        } else if (tag === 'rect') {
          const rectClass = el.getAttribute('class') || '';
          const isTxtBox = rectClass.includes('txtBox') || (el.id || '').includes('txtBox');
          shapes.push({
            type: 'rect',
            x: parseFloat(el.getAttribute('x')) || 0,
            y: parseFloat(el.getAttribute('y')) || 0,
            width: parseFloat(el.getAttribute('width')) || 0,
            height: parseFloat(el.getAttribute('height')) || 0,
            stroke: el.getAttribute('stroke') || '#000',
            fill: el.getAttribute('fill') || 'none',
            isTxtBox
          });
        } else if (tag === 'path') {
          const markerEnd = el.getAttribute('marker-end') || '';
          const markerStart = el.getAttribute('marker-start') || '';
          const classAttr = el.getAttribute('class') || '';
          const idAttr = el.id || '';
          // Check for arrow markers - must explicitly contain "arrow" in marker URL or attributes
          // Don't just check url() because non-arrow markers (caps/bars) also use url()
          const hasArrow = markerEnd.toLowerCase().includes('arrow') ||
                          markerStart.toLowerCase().includes('arrow') ||
                          classAttr.toLowerCase().includes('arrow') ||
                          idAttr.toLowerCase().includes('arrow');
          console.log('[shape] path hasArrow:', hasArrow, 'markerEnd:', markerEnd, 'class:', classAttr);
          shapes.push({
            type: 'path',
            d: el.getAttribute('d') || '',
            stroke: el.getAttribute('stroke') || '#000',
            fill: el.getAttribute('fill') || 'none',
            hasArrow
          });
        } else if (tag === 'line') {
          const markerEnd = el.getAttribute('marker-end') || '';
          const markerStart = el.getAttribute('marker-start') || '';
          const classAttr = el.getAttribute('class') || '';
          const idAttr = el.id || '';
          // Check for arrow markers - must explicitly contain "arrow" in marker URL or attributes
          // Don't just check url() because non-arrow markers (caps/bars) also use url()
          const hasArrow = markerEnd.toLowerCase().includes('arrow') ||
                          markerStart.toLowerCase().includes('arrow') ||
                          classAttr.toLowerCase().includes('arrow') ||
                          idAttr.toLowerCase().includes('arrow');
          console.log('[shape] line hasArrow:', hasArrow, 'markerEnd:', markerEnd, 'class:', classAttr);
          shapes.push({
            type: 'line',
            x1: parseFloat(el.getAttribute('x1')) || 0,
            y1: parseFloat(el.getAttribute('y1')) || 0,
            x2: parseFloat(el.getAttribute('x2')) || 0,
            y2: parseFloat(el.getAttribute('y2')) || 0,
            stroke: el.getAttribute('stroke') || '#000',
            hasArrow
          });
        }
      });
      return shapes;
    };

    // Process groups hierarchically
    // "example" class = section container (parent)
    // "annotation" class = actual annotation with shapes (child)
    let idCounter = 0;
    const processedTexts = new Set();

    // First pass: find all example (section) groups and their child annotations
    const exampleGroups = annotationSvg.querySelectorAll('g.example');

    exampleGroups.forEach(exampleGroup => {
      const exampleText = exampleGroup.querySelector(':scope > text');
      const sectionLabel = exampleText?.textContent?.trim();

      if (!sectionLabel || sectionLabel.length < 2 || processedTexts.has(sectionLabel)) return;
      processedTexts.add(sectionLabel);

      // Check if this example has child annotation groups
      const childAnnotations = exampleGroup.querySelectorAll(':scope > g.annotation');
      const hasChildren = childAnnotations.length > 0;

      // Section groups don't have their own shapes to render
      const sectionAnn = {
        id: `ann_${idCounter++}`,
        text: sectionLabel,
        normX: 0,
        normY: 0,
        type: 'section',
        isSection: true,
        shapes: null,
        shape: null,
        boundingSize: 0,
        children: [],
        hasChildren
      };

      // Process child annotations
      childAnnotations.forEach(annGroup => {
        const annText = annGroup.querySelector(':scope > text');
        const annLabel = annText?.textContent?.trim();

        if (!annLabel || annLabel.length < 2 || processedTexts.has(annLabel)) return;
        processedTexts.add(annLabel);

        const typeAttr = annGroup.getAttribute('type') || '';
        const isArrowGroup = typeAttr.toLowerCase() === 'arrow';

        const directShapes = extractDirectShapes(annGroup);

        // If parent group is type="arrow", mark all shapes as arrows
        // Also mark rects in arrow groups as txtBox (they're text backgrounds, not visible shapes)
        if (isArrowGroup) {
          directShapes.forEach(s => {
            s.hasArrow = true;
            if (s.type === 'rect') {
              s.isTxtBox = true;
            }
          });
        }

        // Extract text element position (more reliable for arrows)
        let textX = parseFloat(annText?.getAttribute('x')) || 0;
        let textY = parseFloat(annText?.getAttribute('y')) || 0;
        const textTransform = annText?.getAttribute('transform') || '';
        const textPos = parseTransform(textTransform);
        // Apply text transform offset
        if (textPos.x !== 0 || textPos.y !== 0) {
          textX = textPos.x;
          textY = textPos.y;
        }
        const textAnchor = annText?.getAttribute('text-anchor') || 'start';

        const transform = annGroup.getAttribute('transform') || '';
        const pos = parseTransform(transform);

        let normX = pos.x;
        let normY = pos.y;

        // For arrows, prefer text element position (it's where the label should go)
        if (isArrowGroup && textX > 0 && textX <= 1 && textY > 0 && textY <= 1) {
          normX = textX;
          normY = textY;
        } else if ((normX === 0 && normY === 0) || normX > 1 || normY > 1) {
          // Fallback to text position if valid
          if (textX > 0 && textX <= 1 && textY > 0 && textY <= 1) {
            normX = textX;
            normY = textY;
          } else {
            const shapePos = getPositionFromShapes(directShapes);
            normX = shapePos.x;
            normY = shapePos.y;
          }
        }

        const isEllipse = typeAttr === 'ellipse' || directShapes.some(s => s.type === 'ellipse');
        const isCircle = typeAttr === 'circle' || (!isEllipse && directShapes.some(s => s.type === 'circle'));

        const childAnn = {
          id: `ann_${idCounter++}`,
          text: annLabel,
          normX,
          normY,
          textAnchor, // 'start', 'middle', or 'end' - useful for label alignment
          type: isEllipse ? 'ellipse' : (isCircle ? 'circle' : 'annotation'),
          isSection: false,
          shapes: directShapes.length > 0 ? directShapes : null,
          shape: directShapes.length > 0 ? directShapes[0] : null,
          boundingSize: calcBoundingSize(directShapes),
          parentId: sectionAnn.id,
          depth: 1,
          children: []
        };

        sectionAnn.children.push(childAnn);
        results.push(childAnn);
      });

      results.push(sectionAnn);
    });

    // Second pass: find standalone annotations (not inside example groups)
    const standaloneAnnotations = annotationSvg.querySelectorAll('g.annotation');
    standaloneAnnotations.forEach(annGroup => {
      // Skip if inside an example group (already processed)
      if (annGroup.closest('g.example')) return;

      const annText = annGroup.querySelector(':scope > text');
      const annLabel = annText?.textContent?.trim();

      if (!annLabel || annLabel.length < 2 || processedTexts.has(annLabel)) return;
      processedTexts.add(annLabel);

      const typeAttr = annGroup.getAttribute('type') || '';
      const isArrowGroup = typeAttr.toLowerCase() === 'arrow';

      const directShapes = extractDirectShapes(annGroup);

      // If parent group is type="arrow", mark all shapes as arrows
      // Also mark rects in arrow groups as txtBox (they're text backgrounds, not visible shapes)
      if (isArrowGroup) {
        directShapes.forEach(s => {
          s.hasArrow = true;
          if (s.type === 'rect') {
            s.isTxtBox = true;
          }
        });
      }

      const transform = annGroup.getAttribute('transform') || '';
      const pos = parseTransform(transform);

      // Extract text element position (more reliable for arrows)
      let textX = parseFloat(annText?.getAttribute('x')) || 0;
      let textY = parseFloat(annText?.getAttribute('y')) || 0;
      const textTransform = annText?.getAttribute('transform') || '';
      const textPos = parseTransform(textTransform);
      // Apply text transform offset
      if (textPos.x !== 0 || textPos.y !== 0) {
        textX = textPos.x;
        textY = textPos.y;
      }
      const textAnchor = annText?.getAttribute('text-anchor') || 'start';

      let normX = pos.x;
      let normY = pos.y;
      if ((normX === 0 && normY === 0) || normX > 1 || normY > 1) {
        const shapePos = getPositionFromShapes(directShapes);
        normX = shapePos.x;
        normY = shapePos.y;
      }

      // For arrows, prefer text element position if valid
      if (isArrowGroup && textX > 0 && textX <= 1 && textY > 0 && textY <= 1) {
        normX = textX;
        normY = textY;
      }

      const isEllipse = typeAttr === 'ellipse' || directShapes.some(s => s.type === 'ellipse');
      const isCircle = typeAttr === 'circle' || (!isEllipse && directShapes.some(s => s.type === 'circle'));

      results.push({
        id: `ann_${idCounter++}`,
        text: annLabel,
        normX,
        normY,
        textAnchor,
        type: isEllipse ? 'ellipse' : (isCircle ? 'circle' : 'annotation'),
        isSection: false,
        shapes: directShapes.length > 0 ? directShapes : null,
        shape: directShapes.length > 0 ? directShapes[0] : null,
        boundingSize: calcBoundingSize(directShapes),
        children: []
      });
    });

    console.log('[extractAnnotations] Found', results.length, 'annotations');

    // Build tree: sections at root, their children nested
    const roots = results.filter(ann => !ann.parentId);

    return { flat: results, tree: roots };
  });

  // Return object with both flat and tree for proper JSON serialization
  if (annotations && annotations.flat) {
    console.log('[dictionaryExpert] Extracted', annotations.flat.length, 'annotations');
    console.log('[dictionaryExpert] Tree roots:', annotations.tree?.length || 0);

    // Debug hierarchy
    annotations.tree?.forEach(root => {
      console.log('[dictionaryExpert] Root:', root.text, 'children:', root.children?.length || 0);
      root.children?.forEach(child => {
        console.log('[dictionaryExpert]   -> Child:', child.text, 'hasShapes:', !!child.shapes?.length);
      });
    });

    // Return as object to preserve tree during JSON serialization
    return {
      list: annotations.flat,
      tree: annotations.tree,
      count: annotations.flat.length
    };
  }

  return { list: [], tree: [], count: 0 };
}


/**
 * Enhanced scrape that extracts ALL histology images by clicking through sidebar
 */
async function scrapeDictionaryPage(url, onStep) {
  await onStep?.({ stage: 'execution_step', label: 'Scraping', message: `Loading: ${url}` });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // Track all discovered images with their metadata
  const discoveredImages = new Map(); // fileupId -> { label, annotations, isMultiplex, markers }
  let currentImageLabel = '';
  let lastCapturedFileupId = null;

  // Intercept network requests to capture fileup IDs
  await page.setRequestInterception(true);
  page.on('request', request => {
    const reqUrl = request.url();
    const match = reqUrl.match(/dictionary_images\/(fileup[a-f0-9]+)_files/i);
    if (match) {
      const fileupId = match[1];
      lastCapturedFileupId = fileupId; // Track most recent for annotation association
      if (!discoveredImages.has(fileupId)) {
        discoveredImages.set(fileupId, {
          id: fileupId,
          label: currentImageLabel || 'Tissue Image',
          annotations: [],
          isMultiplex: false,
          markers: []
        });
      }
    }
    request.continue();
  });

  try {
    // Navigate to page
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(1000); // Reduced from 2000

    // Extract page structure
    const pageData = await page.evaluate(() => {
      const result = {
        title: document.querySelector('h1, h2')?.textContent?.trim() || '',
        description: '',
        textContent: '',
        histologyLinks: [],
        relatedLinks: []
      };

      // Debug: Log what elements exist on the page
      console.log('[textContent] ===== DEBUG TEXT EXTRACTION =====');

      // Try various selectors used on HPA pages
      const selectors = [
        // HPA-specific - the actual structure
        '.learnbody',
        'td.learnbody',
        '.learnbody.dictionary',
        '.legend_left',
        // Generic fallbacks
        '.learn_content',
        '.content',
        'main',
        'article'
      ];

      selectors.forEach(sel => {
        const el = document.querySelector(sel);
        if (el) {
          const preview = el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 200);
          console.log(`[textContent] Found "${sel}": length=${el.textContent?.length}, preview="${preview}"`);
        }
      });

      // Also check all direct children of body for content
      const bodyChildren = document.body?.children;
      if (bodyChildren) {
        console.log('[textContent] Body children:', Array.from(bodyChildren).map(c => `${c.tagName}.${c.className}`).join(', '));
      }

      // Try to find paragraphs with substantial content
      const allParagraphs = document.querySelectorAll('p');
      const contentParagraphs = Array.from(allParagraphs).filter(p => p.textContent?.trim().length > 50);
      console.log(`[textContent] Found ${contentParagraphs.length} substantial paragraphs`);
      contentParagraphs.slice(0, 3).forEach((p, i) => {
        console.log(`[textContent] Paragraph ${i}: parent=${p.parentElement?.className}, text="${p.textContent?.slice(0, 150)}..."`);
      });

      // Get main text content - try HPA-specific selectors first
      let mainContent = document.querySelector('.learnbody, td.learnbody, .learnbody.dictionary, .legend_left, .learn_content, .content, main, article');

      // If first attempt fails, try finding container with substantial paragraph content
      if (!mainContent || !mainContent.textContent?.trim()) {
        // Find the parent of content paragraphs
        if (contentParagraphs.length > 0) {
          mainContent = contentParagraphs[0].parentElement;
          console.log(`[textContent] Using paragraph parent: ${mainContent?.tagName}.${mainContent?.className}`);
        }
      }

      if (mainContent && mainContent.textContent?.trim().length > 100) {
        result.textContent = mainContent.textContent?.replace(/\s+/g, ' ').trim().slice(0, 4000) || '';
        console.log(`[textContent] Using container: ${mainContent.tagName}.${mainContent.className}, length: ${result.textContent.length}`);
      } else {
        // Fallback: concatenate all substantial paragraphs
        console.log('[textContent] Container approach failed, using paragraph fallback');
        const paragraphs = Array.from(document.querySelectorAll('p'))
          .filter(p => {
            const text = p.textContent?.trim();
            // Filter out navigation, headers, footers
            const parent = p.parentElement;
            const parentClass = parent?.className?.toLowerCase() || '';
            const isNav = parentClass.includes('nav') || parentClass.includes('footer') || parentClass.includes('header');
            return text && text.length > 30 && !isNav;
          })
          .map(p => p.textContent?.trim())
          .filter(t => t);

        if (paragraphs.length > 0) {
          result.textContent = paragraphs.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
          console.log(`[textContent] Using ${paragraphs.length} paragraphs, total length: ${result.textContent.length}`);
        } else {
          // Last resort: look for text in any div/span with educational content
          console.log('[textContent] No paragraphs found, trying divs/spans');
          const textElements = Array.from(document.querySelectorAll('div, span'))
            .filter(el => {
              // Skip elements with many children (containers)
              if (el.children.length > 3) return false;
              // Skip navigation/header/footer
              const className = el.className?.toLowerCase() || '';
              if (className.includes('nav') || className.includes('footer') || className.includes('header')) return false;
              // Must have substantial direct text
              const text = el.textContent?.trim();
              return text && text.length > 50 && text.length < 2000;
            })
            .map(el => el.textContent?.trim())
            .filter(t => t);

          if (textElements.length > 0) {
            // Deduplicate (child text appears in parent too)
            const unique = [...new Set(textElements)].sort((a, b) => b.length - a.length);
            result.textContent = unique.slice(0, 5).join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
            console.log(`[textContent] Using ${unique.length} text elements, total length: ${result.textContent.length}`);
          } else {
            console.log('[textContent] No text elements found - page may have unusual structure');
          }
        }
      }

      // Extract ALL histology links from sidebar (the "examples" legend)
      // Try multiple possible selectors for the histology section
      const histologySection = document.querySelector('#examples, .legend_div.normal_dictionary, .legend_div');
      console.log('[histologyLinks] ===== DEBUG START =====');
      console.log('[histologyLinks] histologySection found:', !!histologySection);
      if (histologySection) {
        console.log('[histologyLinks] section id:', histologySection.id);
        console.log('[histologyLinks] section class:', histologySection.className);
        console.log('[histologyLinks] section HTML preview:', histologySection.innerHTML?.slice(0, 1000));
      }

      if (histologySection) {
        // Try multiple selectors for the links
        let links = histologySection.querySelectorAll('a.no_onpage_link, a.dictionary');
        console.log('[histologyLinks] Found with a.no_onpage_link/a.dictionary:', links.length);

        if (links.length === 0) {
          links = histologySection.querySelectorAll('a[href*="dictionary"]');
          console.log('[histologyLinks] Found with a[href*=dictionary]:', links.length);
        }

        if (links.length === 0) {
          links = histologySection.querySelectorAll('a');
          console.log('[histologyLinks] Found with just a:', links.length);
        }

        links.forEach((link, idx) => {
          console.log('[histologyLinks] --- Link', idx, '---');
          console.log('[histologyLinks] outerHTML:', link.outerHTML?.slice(0, 300));
          console.log('[histologyLinks] href:', link.getAttribute('href'));
          console.log('[histologyLinks] class:', link.className);
          console.log('[histologyLinks] textContent:', JSON.stringify(link.textContent?.trim()));

          // Get the most direct text - check for span/text child first
          const directSpan = link.querySelector(':scope > span');
          const directText = directSpan?.textContent?.trim();
          const fullText = link.textContent?.trim();
          // Use the direct span text if available, otherwise first line of full text
          let label = directText || fullText?.split('\n')[0]?.trim() || fullText;
          // Clean up any excessive whitespace
          label = label?.replace(/\s+/g, ' ').trim();

          const href = link.getAttribute('href') || '';
          const isSelected = link.classList.contains('selected');

          console.log('[histologyLinks] FINAL label:', JSON.stringify(label));

          if (label && href && label.length < 100) {
            result.histologyLinks.push({
              label,
              href,
              isSelected,
              isMultiplex: label.toLowerCase().includes('multiplex')
            });
          }
        });
      }
      console.log('[histologyLinks] ===== DEBUG END =====');

      // Extract related links
      const relatedSection = document.querySelector('#related, .legend_div[id="related"]');
      if (relatedSection) {
        const links = relatedSection.querySelectorAll('a');
        links.forEach(link => {
          const label = link.textContent?.trim();
          const href = link.getAttribute('href') || '';
          if (label && href) {
            result.relatedLinks.push({ label, href });
          }
        });
      }

      return result;
    });

    await onStep?.({ stage: 'reasoning_step', label: 'Structure', message: `Found ${pageData.histologyLinks.length} histology images, ${pageData.relatedLinks.length} related links` });

    // Build images array from histologyLinks (the authoritative source)
    // The Map is only for tracking fileupIds we discover via network interception
    const imagesByLabel = new Map(); // label -> image data
    const assignedFileupIds = new Set(); // Track fileupIds we've already assigned to prevent cross-contamination

    // Initialize all images from histologyLinks
    console.log('[scrapeDictionaryPage] histologyLinks:', JSON.stringify(pageData.histologyLinks, null, 2));
    for (const histLink of pageData.histologyLinks) {
      console.log(`[scrapeDictionaryPage] Adding image: "${histLink.label}" multiplex=${histLink.isMultiplex}`);
      imagesByLabel.set(histLink.label, {
        id: null, // fileupId - will be set if we can capture it
        label: histLink.label,
        href: histLink.href,
        annotations: { list: [], tree: [], count: 0 },
        isMultiplex: histLink.isMultiplex,
        canRender: !histLink.isMultiplex, // Multiplex can't be rendered in standard viewer
        markers: []
      });
    }
    console.log(`[scrapeDictionaryPage] imagesByLabel has ${imagesByLabel.size} entries after init`);

    // Process each histology link sequentially to capture fileupIds and annotations
    await onStep?.({ stage: 'execution_step', label: 'Loading', message: `Processing ${pageData.histologyLinks.length} images...` });

    for (let i = 0; i < pageData.histologyLinks.length; i++) {
      const histLink = pageData.histologyLinks[i];
      const imgLabel = histLink.label;
      const imgData = imagesByLabel.get(imgLabel);

      try {
        // Set label BEFORE clicking so network interception captures it correctly
        currentImageLabel = imgLabel;

        // For already-selected images (first one on page load), don't reset - we may have captured
        // the fileupId during page load. For others, reset to detect new captures.
        if (!histLink.isSelected) {
          lastCapturedFileupId = null;
        }

        // Click the histology link to switch to that image (skip if already selected)
        if (!histLink.isSelected) {
          const linkSelector = `a[href="${histLink.href}"]`;
          await page.click(linkSelector);
          await delay(800); // Wait for viewer swap
        } else {
          // Already selected - just wait a bit for any pending tile loads
          await delay(300);
        }

        // For multiplex images, skip annotation extraction - the HPA page doesn't update
        // the annotation overlay when clicking multiplex links, so we'd capture stale data
        if (histLink.isMultiplex) {
          console.log(`[scrapeDictionaryPage] Skipping annotation extraction for multiplex "${imgLabel}"`);
          imgData.annotations = { list: [], tree: [], count: 0 };
          continue; // Skip to next image
        }

        // Extract annotations from current view (non-multiplex only)
        const annotations = await extractAnnotations(page);
        imgData.annotations = annotations;

        // Try to extract fileupId directly from the page
        if (!histLink.isMultiplex) {
          // Try to get fileupId from page state - look for it in various places
          const extractedFileupId = await page.evaluate(() => {
            // Method 1: Check for visible tile URLs in img elements
            const tileImg = document.querySelector('img[src*="dictionary_images/fileup"]');
            if (tileImg) {
              const match = tileImg.src.match(/dictionary_images\/(fileup[a-f0-9]+)/i);
              if (match) return match[1];
            }

            // Method 2: Check canvas data or OpenSeadragon source
            const osdContainer = document.querySelector('.openseadragon-container');
            if (osdContainer) {
              // Look for data attributes
              const dataUrl = osdContainer.getAttribute('data-url') || osdContainer.getAttribute('data-source');
              if (dataUrl) {
                const match = dataUrl.match(/fileup[a-f0-9]+/i);
                if (match) return match[0];
              }
            }

            // Method 3: Check script/window variables
            if (window.osdViewer?.source?.url) {
              const match = window.osdViewer.source.url.match(/fileup[a-f0-9]+/i);
              if (match) return match[0];
            }

            // Method 4: Look in any visible URL containing fileup
            const allElements = document.querySelectorAll('[src*="fileup"], [data-src*="fileup"], [href*="fileup"]');
            for (const el of allElements) {
              const url = el.src || el.dataset.src || el.href;
              const match = url?.match(/fileup[a-f0-9]+/i);
              if (match) return match[0];
            }

            return null;
          });

          if (extractedFileupId && !assignedFileupIds.has(extractedFileupId)) {
            imgData.id = extractedFileupId;
            imgData.canRender = true;
            assignedFileupIds.add(extractedFileupId);
            console.log(`[scrapeDictionaryPage] Extracted fileupId from DOM for "${imgLabel}": ${extractedFileupId}`);
          } else if (lastCapturedFileupId && !assignedFileupIds.has(lastCapturedFileupId)) {
            // Fallback to network interception
            imgData.id = lastCapturedFileupId;
            imgData.canRender = true;
            assignedFileupIds.add(lastCapturedFileupId);
            console.log(`[scrapeDictionaryPage] Captured fileupId via network for "${imgLabel}": ${lastCapturedFileupId}`);
          } else {
            console.log(`[scrapeDictionaryPage] No fileupId found for "${imgLabel}" - not renderable`);
            imgData.canRender = false;
          }
        }

      } catch (clickErr) {
        console.warn(`Failed to load histology image ${imgLabel}:`, clickErr.message);
        imgData.canRender = false;
      }
    }

    // If no histology links found, try the old method of finding zoom triggers
    if (pageData.histologyLinks.length === 0) {
      await onStep?.({ stage: 'execution_step', label: 'Fallback', message: 'No sidebar links found, trying direct triggers...' });

      const clickTargets = await page.$$('.histology_image, [onclick*="zoom"], .zoomable, img[src*="histology"]');
      for (const target of clickTargets.slice(0, 5)) {
        try {
          currentImageLabel = await target.evaluate(el => el.getAttribute('title') || el.getAttribute('alt') || 'Tissue Image');
          await target.click();
          await delay(2000);

          // Check if we got a fileupId
          if (lastCapturedFileupId) {
            imagesByLabel.set(currentImageLabel, {
              id: lastCapturedFileupId,
              label: currentImageLabel,
              annotations: await extractAnnotations(page),
              isMultiplex: false,
              canRender: true,
              markers: []
            });
          }
        } catch (e) {
          // Ignore
        }
      }
    }

    await browser.close();

    // Convert map to array
    const images = Array.from(imagesByLabel.values());
    console.log(`[scrapeDictionaryPage] Final images array: ${images.length} images`);
    images.forEach((img, i) => {
      console.log(`[scrapeDictionaryPage] Image ${i}: "${img.label}" id=${img.id} canRender=${img.canRender} isMultiplex=${img.isMultiplex}`);
    });

    await onStep?.({ stage: 'reasoning_step', label: 'Complete', message: `Extracted ${images.length} tissue images with annotations` });

    return {
      pageTitle: pageData.title,
      textContent: pageData.textContent,
      histologyLinks: pageData.histologyLinks,
      relatedLinks: pageData.relatedLinks,
      images
    };

  } catch (error) {
    await browser.close();
    throw error;
  }
}

/**
 * Main dictionary expert function - now supports multi-topic queries
 * Includes token usage tracking for debugging
 */
async function dictionaryExpert({ topic, topics, question }, { onStep } = {}) {
  // --- Receptionist mode: about-HPA questions ---
  if (question) {
    return handleAboutQuestion(question, onStep);
  }

  // --- Dictionary mode (original) ---
  await onStep?.({ stage: 'start', message: `Dictionary lookup: ${topic || topics?.join(', ')}` });

  const queryTopics = topics || [topic];

  // Token usage tracking
  const tokenUsageLog = [];
  let totalTokens = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  if (!queryTopics.length || !queryTopics[0]) {
    return {
      status: 'error',
      error: 'Topic is required'
    };
  }

  try {
    // Find matching categories for all topics
    const allCategories = [];
    for (const t of queryTopics) {
      const { results: matches, tokenUsage } = await findBestCategories(t, onStep);
      allCategories.push(...matches);

      // Accumulate token usage
      if (tokenUsage) {
        tokenUsageLog.push(tokenUsage);
        totalTokens.prompt_tokens += tokenUsage.prompt_tokens;
        totalTokens.completion_tokens += tokenUsage.completion_tokens;
        totalTokens.total_tokens += tokenUsage.total_tokens;
      }
    }

    // Log accumulated token usage
    console.log('[dictionaryExpert] Token usage per step:', tokenUsageLog);
    console.log('[dictionaryExpert] Total token usage:', totalTokens);

    // Deduplicate categories
    const uniqueCategories = [];
    const seenNames = new Set();
    for (const cat of allCategories) {
      if (!seenNames.has(cat.name)) {
        seenNames.add(cat.name);
        uniqueCategories.push(cat);
      }
    }

    if (uniqueCategories.length === 0) {
      await onStep?.({
        stage: 'complete',
        label: 'No Match',
        message: `No dictionary entries found for: ${queryTopics.join(', ')}`,
        tokenUsage: { steps: tokenUsageLog, total: totalTokens }
      });
      return {
        status: 'not_found',
        topic: queryTopics.join(', '),
        message: `No HPA Dictionary entries found for "${queryTopics.join(', ')}". Available categories include normal tissues, cancers, and cell structures.`,
        tokenUsage: { steps: tokenUsageLog, total: totalTokens }
      };
    }

    // Scrape each category and accumulate results
    const allResults = [];
    const allImages = [];
    const allRelatedLinks = [];

    for (let i = 0; i < uniqueCategories.length; i++) {
      const category = uniqueCategories[i];
      const fullUrl = `https://www.proteinatlas.org${category.url}`;

      await onStep?.({
        stage: 'execution_step',
        label: `Category ${i + 1}/${uniqueCategories.length}`,
        message: `Researching: ${category.name}`,
        url: fullUrl
      });

      const scraped = await scrapeDictionaryPage(fullUrl, onStep);

      allResults.push({
        category: category.name,
        categoryType: category.category,
        categoryGroup: category.group,
        url: fullUrl,
        title: scraped.pageTitle,
        context: scraped.textContent,
        imageCount: scraped.images.length
      });

      // Add category info to each image
      for (const img of scraped.images) {
        allImages.push({
          ...img,
          category: category.name,
          categoryUrl: fullUrl
        });
      }

      // Collect related links
      for (const link of scraped.relatedLinks) {
        if (!allRelatedLinks.find(l => l.href === link.href)) {
          allRelatedLinks.push({
            ...link,
            fromCategory: category.name
          });
        }
      }
    }

    // Build summary for LLM synthesis (without bloated image/annotation data)
    const imageLabels = allImages.map(img => img.label).join(', ');
    const totalAnnotations = allImages.reduce((sum, img) => sum + (img.annotations?.count || 0), 0);
    const relatedNames = allRelatedLinks.slice(0, 5).map(l => l.label).join(', ');

    const summary_md = `# ${allResults[0]?.title || uniqueCategories[0].name}

**Category:** ${uniqueCategories[0].category} / ${uniqueCategories[0].group}
**Dictionary URL:** https://www.proteinatlas.org${uniqueCategories[0].url}

## Content
${allResults.map(r => r.context).join('\n\n')}

## Histology Images
Found ${allImages.length} tissue images: ${imageLabels}
Total annotations: ${totalAnnotations} labeled structures

${relatedNames ? `## Related Topics\n${relatedNames}` : ''}`;

    // Build comprehensive result
    const result = {
      status: 'ok',
      topic: queryTopics.join(', '),
      isMultiTopic: uniqueCategories.length > 1,
      categories: allResults,
      matched_category: uniqueCategories[0].name, // Primary for backwards compat
      category_type: uniqueCategories[0].category,
      category_group: uniqueCategories[0].group,
      dictionary_url: `https://www.proteinatlas.org${uniqueCategories[0].url}`,
      page_title: allResults[0]?.title,
      context: allResults.map(r => `## ${r.category}\n${r.context}`).join('\n\n'),
      images: allImages,
      image_count: allImages.length,
      related_links: allRelatedLinks,
      summary_md, // Lightweight summary for LLM synthesis
      tokenUsage: { steps: tokenUsageLog, total: totalTokens }
    };

    await onStep?.({
      stage: 'complete',
      label: 'Done',
      message: `Found ${allImages.length} histology images across ${uniqueCategories.length} categories | Tokens: ${totalTokens.total_tokens} (prompt: ${totalTokens.prompt_tokens}, completion: ${totalTokens.completion_tokens})`,
      tokenUsage: { steps: tokenUsageLog, total: totalTokens },
      data: result
    });

    console.log('[dictionaryExpert] ===== FINAL TOKEN USAGE =====');
    console.log('[dictionaryExpert] Steps:', JSON.stringify(tokenUsageLog, null, 2));
    console.log('[dictionaryExpert] Total:', JSON.stringify(totalTokens));
    console.log('[dictionaryExpert] ================================');

    return result;

  } catch (error) {
    console.log('[dictionaryExpert] Error occurred. Token usage before error:', totalTokens);
    await onStep?.({
      stage: 'error',
      label: 'Error',
      message: error.message,
      tokenUsage: { steps: tokenUsageLog, total: totalTokens }
    });
    return {
      status: 'error',
      topic: queryTopics.join(', '),
      error: error.message,
      tokenUsage: { steps: tokenUsageLog, total: totalTokens }
    };
  }
}

module.exports = dictionaryExpert;