'use strict';

// The reader answers a question about the Human Protein Atlas from the atlas's own information
// pages (about, learn, help, releases, download, the atlas overviews: anything on the site that is
// prose rather than data). It browses: a page is read as its sections and its links, the model
// opens sections and follows links by index, never by a URL it typed itself, within a fixed
// budget. Its answer is quotes: verbatim spans of the pages it read, each with its page. Every
// span is checked by code against the stored page text; a span that is not on the page is sent
// back, and the model tries again until every span checks out or its retries are spent, in which
// case the failing spans are dropped and named. Every page read is kept with URL, fetch time and
// the SHA-256 of the raw HTML. Nothing the pages do not say reaches the user.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const cheerio = require('cheerio');
const { jsonCall } = require('../../inference/jsonCall');

const SITE = 'https://www.proteinatlas.org';
const MAX_PAGES = 6;          // fetches per question
const MAX_TURNS = 8;          // browsing turns per question
const MAX_RETRIES = 3;        // answers sent back for quotes that are not on the page
const MAX_FOLLOW = 3;         // pages fetched from one turn
const MAX_OPEN_CHARS = 6000;  // one opened section
const MAX_LINKS = 60;         // links shown per page
const QUOTE_MIN = 15;
const QUOTE_MAX = 600;
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

// Whether the quote is a verbatim span of the page text, modulo whitespace and quote marks.
function quoteOnPage(quote, pageText) {
  const q = normalize(quote);
  if (q.length < QUOTE_MIN || q.length > QUOTE_MAX) return false;
  return normalize(pageText).includes(q);
}

// A page as the reader sees it: its sections (heading and text) and its same-site links.
function parsePage(html, url) {
  const $ = cheerio.load(html);
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
  const seen = new Set(); const links = [];
  $('a[href]').each((_, el) => {
    const target = allowedUrl($(el).attr('href'), url);
    const label = normalize($(el).text()).slice(0, 80);
    if (!target || !label || target === url || seen.has(target)) return;
    seen.add(target);
    links.push({ label, url: target });
  });
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

const SYSTEM = `You answer a question about the Human Protein Atlas by reading the atlas's own web pages, as a careful librarian would. You see each page you have opened as its sections (heading, size) and its links; you open sections to read them and follow links by their number to reach other pages.
Reply with JSON, one of:
{"open": [{"page": <page number>, "sections": [<section numbers>]}]} to read sections you have not read;
{"follow": [{"page": <page number>, "link": <link number>}]} to fetch pages (at most ${MAX_FOLLOW});
{"answer": {"quotes": [{"page": <page number>, "quote": "<exact text>"}], "not_found": "<what the pages did not say, or empty>"}}.
Your answer is made only of quotes. A quote is an exact span of a section you have read, copied character for character, ${QUOTE_MIN} to ${QUOTE_MAX} characters, one continuous passage: nothing paraphrased, shortened, joined from two places, or written by you. Choose the spans that answer the question, in the order that reads best. Every quote is checked against the page; a quote that is not on the page exactly as you wrote it is sent back to you. If the pages you can reach do not answer the question, say so in not_found rather than writing anything of your own.`;

function describe(state, opened) {
  const lines = [];
  state.pages.forEach((page, p) => {
    lines.push(`Page ${p}: ${page.title} <${page.url}>`);
    page.sections.forEach((s, i) => lines.push(`  section ${i}: ${s.heading} (${s.text.length} chars)${opened.has(`${p}:${i}`) ? ' [read]' : ''}`));
    page.links.forEach((l, i) => lines.push(`  link ${i}: ${l.label} -> ${l.url}`));
  });
  return lines.join('\n');
}

function openedText(state, opened) {
  const parts = [];
  for (const key of opened) {
    const [p, i] = key.split(':').map(Number);
    const s = state.pages[p]?.sections[i];
    if (s) parts.push(`--- Page ${p}, section ${i}: ${s.heading}\n${s.text.slice(0, MAX_OPEN_CHARS)}`);
  }
  return parts.join('\n\n');
}

// The quotes of an answer, checked against the pages: what holds, and what was not on the page.
function check(reply, state) {
  const quotes = []; const rejected = [];
  for (const item of Array.isArray(reply?.answer?.quotes) ? reply.answer.quotes : []) {
    const page = state.pages[Number(item?.page)];
    const quote = String(item?.quote ?? '');
    if (page && quoteOnPage(quote, page.text)) quotes.push({ quote: normalize(quote), url: page.url, title: page.title, sha256: page.sha256 });
    else rejected.push({ page: Number.isInteger(Number(item?.page)) ? Number(item.page) : null, quote: normalize(quote) });
  }
  return { quotes, rejected, not_found: normalize(reply?.answer?.not_found) };
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
  await onStep?.({ stage: 'start', message: `Reading the atlas for: "${q.slice(0, 120)}"` });
  await visit(allowedUrl(entry) || entry);
  let answer = null;
  let idle = 0;
  for (let turn = 0; turn < MAX_TURNS && !answer; turn += 1) {
    const budget = `Pages fetched ${state.fetches} of ${MAX_PAGES}; turns left ${MAX_TURNS - turn}.`;
    const user = [`Question: ${q}`, budget, 'What you have:', describe(state, opened), openedText(state, opened) ? `What you have read:\n${openedText(state, opened)}` : ''].filter(Boolean).join('\n\n');
    let reply = await ask(SYSTEM, user, onStep, `reader turn ${turn + 1}`, stats);
    if (reply?.answer) {
      // An answer: every quote must be on its page; what is not goes back, up to MAX_RETRIES times.
      let checked = check(reply, state);
      for (let retry = 0; checked.rejected.length && retry < MAX_RETRIES; retry += 1) {
        await onStep?.({ stage: 'planning_step', label: 'Sent back', message: `${checked.rejected.length} quote${checked.rejected.length === 1 ? '' : 's'} not found on the page as written` });
        const complaint = checked.rejected.map(r => `- page ${r.page}: "${r.quote.slice(0, 200)}" is not on that page exactly as written`).join('\n');
        reply = await ask(SYSTEM, `${user}\n\nThese quotes in your answer are not on the page exactly as written:\n${complaint}\nCopy each again character for character from a section you have read, one continuous passage, or leave it out. Answer again with the complete answer.`, onStep, `reader retry ${retry + 1}`, stats);
        if (!reply?.answer) break;
        checked = check(reply, state);
      }
      answer = checked;
      break;
    }
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
  const quotes = answer?.quotes || [];
  const dropped = (answer?.rejected || []).map(r => r.quote);
  const pages = state.pages.map(p => ({ url: p.url, title: p.title, sha256: p.sha256, fetched_unix_ms: p.fetched_unix_ms }));
  const summary = [
    ...quotes.map(c => `> "${c.quote}"\n> — ${c.title} (${c.url})`),
    answer?.not_found ? `\nNot found on the pages read: ${answer.not_found}` : '',
    dropped.length ? `\nLeft out, not on the page as written: ${dropped.map(d => `"${d.slice(0, 120)}"`).join('; ')}` : '',
    !answer ? 'The reader could not reach an answer within its budget.' : '',
    `\nPages read: ${pages.map(p => `${p.title} (${p.url}, sha256 ${p.sha256.slice(0, 12)})`).join('; ')}`
  ].filter(Boolean).join('\n');
  await onStep?.({ stage: 'complete', label: 'Done', message: `${quotes.length} quote${quotes.length === 1 ? '' : 's'} from ${pages.length} page${pages.length === 1 ? '' : 's'}${dropped.length ? `, ${dropped.length} left out` : ''}` });
  return {
    status: 'ok', mode: 'reader', question: q, quotes, dropped, not_found: answer?.not_found || '', pages,
    resources: pages.map(p => ({ label: p.title, url: p.url })),
    summary_md: summary,
    tokens: { prompt_tokens: stats.promptTokens, completion_tokens: stats.completionTokens, total_tokens: stats.totalTokens }
  };
}

module.exports = { readerAnswer, quoteOnPage, allowedUrl, parsePage, normalize, SITE, MAX_PAGES, MAX_TURNS, MAX_RETRIES };
