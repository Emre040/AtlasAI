'use strict';

// The reader answers a question about the Human Protein Atlas from the atlas's own information
// pages (about, learn, help, releases, download, the atlas overviews: anything on the site that is
// prose rather than data). It browses: a page is read as its sections and its links, the model
// opens sections and follows links by index, never by a URL it typed itself, within a fixed
// budget. It answers in prose where every sentence cites an exact quote: a verbatim span of one
// page it read. Every quote is checked by code against the stored page text. A quote that is not
// on the page goes back on its own, with the page's actual text around the spot it most likely
// came from, and the model copies it again; the answer text and the citations that passed stay
// as they are. A sentence whose citations never check out is dropped. Every page read is kept
// with URL, fetch time and the SHA-256 of the raw HTML. No sentence reaches the user without a
// quote behind it.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const cheerio = require('cheerio');
const { jsonCall } = require('../../inference/jsonCall');

const SITE = 'https://www.proteinatlas.org';
const MAX_PAGES = 6;          // fetches per question
const MAX_TURNS = 8;          // browsing turns per question
const MAX_RETRIES = 3;        // rounds of citations sent back for an exact copy
const MAX_FOLLOW = 3;         // pages fetched from one turn
const MAX_OPEN_CHARS = 6000;  // one opened section
const MAX_LINKS = 120;        // links shown per page (the section menus alone are a few dozen)
const QUOTE_MIN = 15;
const QUOTE_MAX = 600;
const PASSAGE_RADIUS = 350;   // page text shown around the spot a failed quote came from
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const CACHE_DIR = path.join(__dirname, '../../../data_local/reader-cache');

// Data pages are not reading material: a gene, a search, the API, files, images.
const NOT_INFORMATION = [/^\/ENSG\d+/i, /^\/search\b/i, /^\/api\b/i, /^\/images?\b/i, /\.(zip|gz|tsv|csv|json|xml|pdf|png|jpe?g|svg|dzi)$/i];

function allowedUrl(href, base = SITE) {
  let url;
  try { url = new URL(href, base); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== new URL(SITE).hostname) return null;
  if (NOT_INFORMATION.some(re => re.test(url.pathname))) return null;
  url.hash = ''; url.search = '';
  return url.toString();
}

function normalize(text) {
  return String(text || '')
    .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-').replace(/ /g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Why a quote is not a verbatim span of the page: null when it is.
function quoteProblem(quote, pageText) {
  const q = normalize(quote);
  if (q.length < QUOTE_MIN) return `too short (${q.length} characters, at least ${QUOTE_MIN})`;
  if (q.length > QUOTE_MAX) return `too long (${q.length} characters, the limit is ${QUOTE_MAX})`;
  return normalize(pageText).includes(q) ? null : 'not on the page as written';
}

// Whether the quote is a verbatim span of the page text, modulo whitespace and quote marks.
function quoteOnPage(quote, pageText) {
  return quoteProblem(quote, pageText) === null;
}

// Where on the page a failed quote most likely came from: the longest run of its words that
// occurs on the page (its start, else its end, else any four words in a row), with the page's
// own text around that spot. Plain text matching, nothing else.
function nearestPassage(quote, pageText, radius = PASSAGE_RADIUS) {
  const page = normalize(pageText);
  const words = normalize(quote).split(' ').filter(Boolean);
  const find = run => { const at = page.indexOf(run); return at < 0 ? null : { at, run }; };
  let hit = null;
  for (let n = words.length; n >= 3 && !hit; n -= 1) hit = find(words.slice(0, n).join(' '));
  for (let n = words.length; n >= 3 && !hit; n -= 1) hit = find(words.slice(words.length - n).join(' '));
  for (let i = 0; i + 4 <= words.length && !hit; i += 1) hit = find(words.slice(i, i + 4).join(' '));
  if (!hit) return null;
  const start = Math.max(0, hit.at - radius);
  const end = Math.min(page.length, hit.at + hit.run.length + radius);
  return `${start > 0 ? '… ' : ''}${page.slice(start, end)}${end < page.length ? ' …' : ''}`;
}

// A page as the reader sees it: its sections (heading and text) and its same-site links.
function parsePage(html, url) {
  const $ = cheerio.load(html);
  // Links come from the whole document, menus included: the section menus are how the about,
  // learn and help pages reach each other. The text sections come from the page body proper.
  const seen = new Set(); const links = [];
  $('a[href]').each((_, el) => {
    const target = allowedUrl($(el).attr('href'), url);
    const label = normalize($(el).text()).slice(0, 80);
    if (!target || !label || target === url || seen.has(target)) return;
    seen.add(target);
    links.push({ label, url: target });
  });
  $('script, style, noscript, nav, footer, header, .search-container, #search, .cookie-bar, .cookie_statement, .menu, .menufix, #sidemenu, .menu_dropdown, iframe').remove();
  const title = normalize($('title').first().text()) || url;
  const sections = [];
  let current = { heading: 'Top', text: [] };
  const flush = () => { const text = normalize(current.text.join(' ')); if (text) sections.push({ heading: current.heading, text }); };
  $('body').find('h1, h2, h3, h4, p, li, td, th, dd, dt').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = normalize($(el).text());
    if (!text) return;
    if (/^h[1-4]$/.test(tag)) { flush(); current = { heading: text, text: [] }; }
    else if ($(el).find('p, li, h1, h2, h3, h4').length === 0) current.text.push(text);
  });
  flush();
  return { url, title, sections, links: links.slice(0, MAX_LINKS), text: sections.map(s => `${s.heading} ${s.text}`).join(' ') };
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'AtlasAI reader (research assistant over the Human Protein Atlas)', Accept: 'text/html' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  } finally { clearTimeout(timer); }
}

// A page read once is kept on disk for a week: the atlas's information pages change per release.
async function readPage(url, fetchPage, cache) {
  const file = path.join(CACHE_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);
  if (cache) {
    try {
      const cached = JSON.parse(await fs.readFile(file, 'utf8'));
      if (cached.url === url && Date.now() - cached.fetched_unix_ms < CACHE_TTL_MS) return cached;
    } catch {}
  }
  const html = await fetchPage(url);
  const page = { ...parsePage(String(html), url), sha256: crypto.createHash('sha256').update(String(html)).digest('hex'), fetched_unix_ms: Date.now() };
  if (cache) { try { await fs.mkdir(CACHE_DIR, { recursive: true }); await fs.writeFile(file, JSON.stringify(page)); } catch {} }
  return page;
}

const COPY_RULE = `A citation is an exact span of page text: pick a start word and an end word on the page and copy everything between them character for character, the page's own spelling, capitalization, punctuation and mistakes included. Do not fix, shorten, join, reorder or translate anything; no ellipsis; one continuous passage of ${QUOTE_MIN} to ${QUOTE_MAX} characters. Shorter is safer: the one sentence or clause that carries the fact. A sentence that sums up a list or a table cites several short spans, given as a list: "quote": ["<span>", "<span>"], each one exact.`;

const SYSTEM = `You answer a question about the Human Protein Atlas by reading the atlas's own web pages, as a careful librarian would. You see each page you have opened as its sections (heading, size) and its links; you open sections to read them and follow links by their number to reach other pages.
Reply with JSON, one of:
{"open": [{"page": <page number>, "sections": [<section numbers>]}]} to read sections you have not read;
{"follow": [{"page": <page number>, "link": <link number>}]} to fetch pages (at most ${MAX_FOLLOW});
{"answer": {"text": "<your answer in plain prose>", "citations": [{"n": 1, "page": <page number>, "quote": "<exact text>"}], "not_found": "<the part of the question the pages did not answer, in a few words, or empty>"}}.
Answer only when every part of the question is covered by sections you have read. If a link plainly leads to a part you still lack (a milestone page, a release note, a news post, a methods page), follow it first, within the budget; a page's own subpages usually hold the detail its overview only names.
Write the answer as you would to a colleague: direct, in full sentences, with the numbers, names, dates and thresholds as the pages give them. Every sentence ends with the citation it rests on, written as [n]; a sentence may cite several, [1][2]. A sentence says no more than its citations say.
${COPY_RULE} Quote from section text you opened, never from link labels or from memory. Every citation is checked against the page; one that is not on the page exactly as written, or longer than ${QUOTE_MAX} characters, is sent back to you with the page's text around it, and a sentence without a verified citation is not shown. not_found names only what the pages did not answer; it states no facts.`;

const RETRY = `You are fixing citations in an answer about the Human Protein Atlas. The answer text stays as it is; only the citations named below change. ${COPY_RULE} Copy from the page text shown to you, not from memory.
Reply with JSON only: {"citations": [{"n": <number>, "page": <page number>, "quote": "<exact span>" or ["<span>", "<span>"]}], "drop": [<numbers of citations that cannot be copied from the text shown>]}.`;

// An answer whose sentences carry no citation marker at all, with citations given, goes back once
// for the markers alone: the words stay, each sentence gets the number of the citation it rests on.
const MARKERS = `You are placing citation markers in an answer about the Human Protein Atlas. The answer text and its citations stay exactly as they are; only the markers are added: each sentence ends with the number of the citation it rests on, written as [n], and a sentence no citation supports is left without one.
Reply with JSON only: {"text": "<the same text, with the markers>"}.`;
function markersPrompt(question, answer) {
  return [`Question: ${question}`, `The answer, whose words stay as they are:\n${normalize(answer.text)}`, '', 'Its citations:', ...answer.citations.map(c => `[${c?.n}] on page ${c?.page}: ${JSON.stringify(Array.isArray(c?.quote) ? c.quote.join(' […] ') : String(c?.quote ?? ''))}`), '', 'Return the text with a marker at the end of each sentence.'].join('\n');
}
// The words of a text, markers and punctuation aside: what a marker pass must leave unchanged.
const words = text => String(text ?? '').replace(/\[\d+\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();

function describe(state, opened) {
  const lines = [];
  state.pages.forEach((page, p) => {
    lines.push(`Page ${p}: ${page.title} <${page.url}>`);
    page.sections.forEach((s, i) => lines.push(`  section ${i}: ${s.heading} (${s.text.length} chars)${opened.has(`${p}:${i}`) ? ' [read]' : ''}`));
    page.links.forEach((l, i) => lines.push(`  link ${i}: ${l.label} -> ${l.url}`));
  });
  return lines.join('\n');
}

function sectionText(state, opened, p) {
  const page = state.pages[p];
  return page ? page.sections.map((s, i) => opened.has(`${p}:${i}`) ? `--- Page ${p}, section ${i}: ${s.heading}\n${s.text.slice(0, MAX_OPEN_CHARS)}` : null).filter(Boolean).join('\n\n') : '';
}

function openedText(state, opened) {
  return state.pages.map((_, p) => sectionText(state, opened, p)).filter(Boolean).join('\n\n');
}

// The answer text as sentences, each with the citation numbers it carries. A sentence ends at
// . ! or ? (with any citation markers around it) that is followed by the end of the text or by a
// space and a capital, a digit or a bracket: "24.0", "2024-10-22" and "e.g. the" do not end one,
// and nothing inside an open quotation does ("What makes a kidney a kidney? And a heart a heart?").
// A citation marker after the terminator belongs to the sentence it ends, never starts the next one.
const SENTENCE_END = /[.!?]+["')\]]*(?:\s*\[\d+\])*(?=\s+(?!\[\d+\])[\p{Lu}\p{N}"'(\[]|\s*$)/gu;
// How many quotations are open at the end of a span of text. Straight quotes open and close with
// the same character, so one that follows a space (or a bracket, or a colon) and precedes a word
// opens, and any other closes: a quotation inside a quotation counts twice, and closes twice.
function openQuotations(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '"') continue;
    const before = i === 0 ? ' ' : text[i - 1]; const after = i + 1 < text.length ? text[i + 1] : ' ';
    if (/[\s(\[:]/.test(before) && !/\s/.test(after)) depth += 1; else if (depth > 0) depth -= 1;
  }
  return depth;
}
function sentences(text) {
  const s = normalize(text);
  const out = []; let start = 0;
  const push = end => { const t = s.slice(start, end).trim(); if (t) out.push({ text: t, cites: [...t.matchAll(/\[(\d+)\]/g)].map(x => Number(x[1])) }); start = end; };
  for (const m of s.matchAll(SENTENCE_END)) {
    // a terminator inside a quotation (a quoted question in the middle of a sentence) ends nothing;
    // the closing quote marks that follow a terminator are part of the sentence they close
    const end = m.index + m[0].length;
    if (openQuotations(s.slice(start, end)) === 0) push(end);
  }
  push(s.length);
  return out;
}

// An answer checked against the pages: which citations are verbatim, which are not and why, and
// the sentences that keep a verified citation. Line and paragraph breaks in the answer are kept,
// so a list the model wrote stays a list; each line is checked sentence by sentence.
function check(reply, state) {
  const a = reply?.answer || {};
  const verified = new Map(); const rejected = [];
  for (const c of Array.isArray(a.citations) ? a.citations : []) {
    const n = Number(c?.n); const p = Number(c?.page); const page = state.pages[p];
    // a citation is one span, or several short spans for a sentence that sums up a list or a table
    const spans = (Array.isArray(c?.quote) ? c.quote : [c?.quote]).map(s => normalize(s)).filter(Boolean);
    let problem = !Number.isInteger(n) ? 'no citation number' : !page ? 'no such page' : !spans.length ? 'empty' : null;
    let span = spans[0] || '';
    for (let i = 0; !problem && i < spans.length; i += 1) {
      const why = quoteProblem(spans[i], page.text);
      if (why) { problem = spans.length > 1 ? `span ${i + 1} of ${spans.length} ${why}` : why; span = spans[i]; }
    }
    const quote = spans.length === 1 ? spans[0] : spans.join(' […] ');
    if (!problem) verified.set(n, { n, quote, quotes: spans, url: page.url, title: page.title, sha256: page.sha256 });
    else rejected.push({ n: Number.isInteger(n) ? n : null, page: Number.isInteger(p) ? p : null, quote, span, problem });
  }
  const paragraphs = []; const droppedSentences = [];
  for (const para of String(a.text ?? '').split(/\n\s*\n/)) {
    const lines = [];
    for (const line of para.split('\n')) {
      const kept = [];
      for (const s of sentences(line)) {
        if (s.cites.some(n => verified.has(n))) kept.push(s.text.replace(/\s*\[(\d+)\]/g, (m, n) => verified.has(Number(n)) ? m : ''));
        else droppedSentences.push(s.text);
      }
      if (kept.length) lines.push(kept.join(' '));
    }
    if (lines.length) paragraphs.push(lines.join('\n'));
  }
  const text = paragraphs.join('\n\n');
  const used = new Set([...text.matchAll(/\[(\d+)\]/g)].map(x => Number(x[1])));
  const citations = [...verified.values()].filter(c => used.has(c.n)).sort((x, y) => x.n - y.n);
  // not_found is the one thing the model writes without a quote, so it is short and shown as what was not found.
  return { text, citations, rejected, droppedSentences, not_found: normalize(a.not_found).slice(0, 160) };
}

// What goes back to the model for the citations that failed: each one with the page's actual
// text around the spot it most likely came from, plus the sections it had opened on that page.
function retryPrompt(question, answer, rejected, state, opened) {
  const lines = [`Question: ${question}`, `The answer, which stays as it is:\n${normalize(answer.text)}`, '', 'These citations did not check out:'];
  const show = new Set();
  for (const r of rejected) {
    lines.push(`[${r.n}] on page ${r.page}, ${r.problem}: "${r.quote.length > 700 ? `${r.quote.slice(0, 700)}…` : r.quote}"`);
    if (/too long/.test(r.problem)) { lines.push('Give the shortest span that carries the fact, or several short spans as a list in quote.'); if (state.pages[r.page]) show.add(r.page); continue; }
    if (/too short|empty/.test(r.problem)) { if (state.pages[r.page]) show.add(r.page); continue; }
    let where = state.pages[r.page] ? nearestPassage(r.span, state.pages[r.page].text) : null; let onPage = r.page;
    for (let p = 0; p < state.pages.length && !where; p += 1) { where = nearestPassage(r.span, state.pages[p].text); if (where) onPage = p; }
    if (where) { lines.push(`${onPage === r.page ? 'The page' : `Nothing like it is on page ${r.page}; page ${onPage} (${state.pages[onPage].title})`} says: "${where}"`); show.add(onPage); }
    else lines.push('Nothing like it is on any page you read: drop it, or copy a span that is there.');
    if (state.pages[r.page]) show.add(r.page);
  }
  const shown = [...show].sort((a, b) => a - b).map(p => sectionText(state, opened, p) || `--- Page ${p}: ${state.pages[p].title} <${state.pages[p].url}> (no sections opened)`);
  lines.push('', `The text you may copy from:\n${shown.join('\n\n')}`);
  lines.push('', `Reply with a corrected exact span for each of ${rejected.map(r => `[${r.n}]`).join(', ')}, or its number in drop.`);
  return lines.join('\n');
}

function sentBackMessage(rejected) {
  const text = rejected.map(r => `[${r.n}] "${r.span.length > 90 ? `${r.span.slice(0, 90)}…` : r.span}" ${r.problem}${/not on the page/.test(r.problem) ? ` (page ${r.page})` : ''}`).join(' · ');
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

// One question through the reader. `fetchPage` and `ask` are injectable for tests; a test's
// fake pages are never written to the on-disk cache (cache is on only with the real fetch).
async function readerAnswer(question, { onStep, fetchPage = fetchHtml, ask = jsonCall, entry = SITE, cache = fetchPage === fetchHtml } = {}) {
  const q = String(question || '').trim();
  if (!q) throw new Error('the reader needs a question');
  const stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, perStep: {} };
  const state = { pages: [], fetches: 0 };
  const opened = new Set();
  const visit = async url => {
    if (state.pages.some(p => p.url === url)) return;
    if (state.fetches >= MAX_PAGES) return;
    state.fetches += 1;
    await onStep?.({ stage: 'execution_step', label: 'Reading', message: url });
    state.pages.push(await readPage(url, fetchPage, cache));
  };
  const context = () => [`Question: ${q}`, 'What you have:', describe(state, opened), openedText(state, opened) ? `What you have read:\n${openedText(state, opened)}` : ''].filter(Boolean).join('\n\n');
  // An answer: the text stays; citations that are not on their page go back on their own, with
  // the page's text around the spot they came from, up to MAX_RETRIES rounds.
  const settle = async reply => {
    let answer = { text: String(reply?.answer?.text ?? ''), citations: Array.isArray(reply?.answer?.citations) ? reply.answer.citations : [], not_found: reply?.answer?.not_found };
    if (answer.citations.length && answer.text.trim() && !/\[\d+\]/.test(answer.text)) {
      await onStep?.({ stage: 'planning_step', label: 'Sent back', message: 'the answer carries no citation markers: sent back for the markers, the words unchanged' });
      const marked = await ask(MARKERS, markersPrompt(q, answer), onStep, 'reader markers', stats);
      const text = String(marked?.text ?? '');
      if (/\[\d+\]/.test(text) && words(text) === words(answer.text)) answer = { ...answer, text };
    }
    let checked = check({ answer }, state);
    for (let retry = 0; retry < MAX_RETRIES; retry += 1) {
      const failing = checked.rejected.filter(r => Number.isInteger(r.n));
      if (!failing.length) break;
      await onStep?.({ stage: 'planning_step', label: 'Sent back', message: sentBackMessage(failing) });
      const fix = await ask(RETRY, retryPrompt(q, answer, failing, state, opened), onStep, `reader retry ${retry + 1}`, stats);
      const drop = new Set((Array.isArray(fix?.drop) ? fix.drop : []).map(Number));
      const fixed = new Map((Array.isArray(fix?.citations) ? fix.citations : []).filter(c => failing.some(r => r.n === Number(c?.n))).map(c => [Number(c.n), c]));
      if (!fixed.size && !drop.size) break;
      answer = { ...answer, citations: answer.citations.filter(c => !drop.has(Number(c?.n))).map(c => fixed.get(Number(c?.n)) || c) };
      checked = check({ answer }, state);
    }
    return checked;
  };
  await onStep?.({ stage: 'start', message: `Reading the atlas for: "${q.slice(0, 120)}"` });
  await visit(allowedUrl(entry) || entry);
  let answer = null;
  let idle = 0;
  for (let turn = 0; turn < MAX_TURNS && !answer; turn += 1) {
    const user = `${context()}\n\nPages fetched ${state.fetches} of ${MAX_PAGES}; turns left ${MAX_TURNS - turn}.`;
    const reply = await ask(SYSTEM, user, onStep, `reader turn ${turn + 1}`, stats);
    if (reply?.answer) { answer = await settle(reply); break; }
    let acted = false;
    for (const o of Array.isArray(reply?.open) ? reply.open : []) {
      const page = state.pages[Number(o?.page)];
      for (const i of Array.isArray(o?.sections) ? o.sections : []) if (page?.sections[Number(i)]) { opened.add(`${Number(o.page)}:${Number(i)}`); acted = true; }
    }
    for (const f of (Array.isArray(reply?.follow) ? reply.follow : []).slice(0, MAX_FOLLOW)) {
      const link = state.pages[Number(f?.page)]?.links[Number(f?.link)];
      if (link) { await visit(link.url); acted = true; }
    }
    idle = acted ? 0 : idle + 1;
    if (idle >= 2) break;   // two turns without a usable move end the reading
  }
  if (!answer) {
    // The budget is spent without an answer: one last call must answer from what was read, or say not found.
    const user = `${context()}\n\nThe reading budget is spent. Answer now from what you have read, with citations, or say in not_found what the pages did not answer.`;
    const reply = await ask(SYSTEM, user, onStep, 'reader final', stats);
    if (reply?.answer) answer = await settle(reply);
  }
  const citations = answer?.citations || [];
  const dropped = (answer?.rejected || []).map(r => r.quote).filter(Boolean);
  const droppedSentences = answer?.droppedSentences || [];
  const pages = state.pages.map(p => ({ url: p.url, title: p.title, sha256: p.sha256, fetched_unix_ms: p.fetched_unix_ms }));
  const summary = [
    answer?.text || (answer ? '' : 'The reader could not reach an answer within its budget.'),
    citations.length ? `\nSources:\n${citations.map(c => `[${c.n}] "${c.quote}" — ${c.title} (${c.url})`).join('\n')}` : '',
    answer?.not_found ? `\nNot found on the pages read: ${answer.not_found}` : '',
    droppedSentences.length ? `\nLeft out, no verified citation: ${droppedSentences.map(s => `"${s.slice(0, 120)}"`).join('; ')}` : '',
    `\nPages read: ${pages.map(p => `${p.title} (${p.url}, sha256 ${p.sha256.slice(0, 12)})`).join('; ')}`
  ].filter(Boolean).join('\n');
  await onStep?.({ stage: 'complete', label: 'Done', message: `${citations.length} citation${citations.length === 1 ? '' : 's'} from ${pages.length} page${pages.length === 1 ? '' : 's'}${droppedSentences.length ? `, ${droppedSentences.length} sentence${droppedSentences.length === 1 ? '' : 's'} left out` : ''}` });
  return {
    status: 'ok', mode: 'reader', question: q,
    text: answer?.text || '', citations, quotes: citations, dropped, dropped_sentences: droppedSentences, not_found: answer?.not_found || '', pages,
    resources: pages.map(p => ({ label: p.title, url: p.url })),
    summary_md: summary,
    tokens: { prompt_tokens: stats.promptTokens, completion_tokens: stats.completionTokens, total_tokens: stats.totalTokens }
  };
}

module.exports = { readerAnswer, quoteOnPage, quoteProblem, nearestPassage, allowedUrl, parsePage, normalize, sentences, check, SITE, MAX_PAGES, MAX_TURNS, MAX_RETRIES };
