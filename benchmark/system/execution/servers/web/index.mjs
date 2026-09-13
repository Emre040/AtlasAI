// An MCP server that gives a model the open web: a search (DuckDuckGo's HTML endpoint, no key)
// and a page opener that returns a page's text with numbered links. Nothing about any site is
// added; the model decides what to search and what to open.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const MAX_CHARS = Number(process.env.WEB_MAX_CHARS || 12000);
const MAX_LINKS = Number(process.env.WEB_MAX_LINKS || 80);
const TIMEOUT_MS = Number(process.env.WEB_TIMEOUT_MS || 25000);

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en' }, signal: controller.signal, redirect: 'follow' });
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    return { status: res.status, type, body, url: res.url || url };
  } finally { clearTimeout(timer); }
}

const decode = s => String(s)
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return m; } })
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } });
const clean = s => decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function htmlToText(html, base) {
  let h = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const links = []; const index = new Map();
  h = h.replace(/<a\b[^>]*href=["']([^"'>]+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const label = clean(inner);
    let abs; try { abs = new URL(decode(href), base).href; } catch { return label; }
    if (!label || /^(javascript|mailto|tel):/i.test(abs)) return label;
    if (!index.has(abs)) { if (links.length >= MAX_LINKS) return label; index.set(abs, links.length + 1); links.push({ n: links.length + 1, label: label.slice(0, 80), url: abs }); }
    return `${label} [${index.get(abs)}]`;
  });
  h = h.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/table|\/section|\/article|\/blockquote|\/pre|\/dd|\/dt)\b[^>]*>/gi, '\n').replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/t[dh]>/gi, '\t').replace(/<[^>]+>/g, ' ');
  const text = decode(h).replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n- (?=\n)/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  return { title: title ? clean(title) : '', text, links };
}

async function webSearch(query) {
  const res = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  if (res.status !== 200) return `Search returned HTTP ${res.status}.`;
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/gi;
  let m;
  while ((m = re.exec(res.body)) && out.length < 10) {
    let url = decode(m[1]);
    const u = url.match(/[?&]uddg=([^&]+)/); if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue;   // an advertisement, not a result
    out.push(`${out.length + 1}. ${clean(m[2])}\n   ${url}\n   ${clean(m[3] || m[4] || '')}`);
  }
  return out.length ? out.join('\n') : 'No results.';
}

async function openUrl(url, start = 0) {
  let target; try { target = new URL(url).href; } catch { return `Not a URL: ${url}`; }
  const res = await get(target);
  if (!/html|xml|text\//i.test(res.type) && res.body.length) return `HTTP ${res.status}, content type ${res.type || 'unknown'}: not a text page (${res.body.length} bytes).`;
  const page = htmlToText(res.body, res.url);
  const from = Math.max(0, Number(start) || 0);
  const slice = page.text.slice(from, from + MAX_CHARS);
  const more = from + MAX_CHARS < page.text.length ? `\n[characters ${from}-${from + MAX_CHARS} of ${page.text.length}; call open_url again with start=${from + MAX_CHARS} for the rest]` : `\n[characters ${from}-${page.text.length} of ${page.text.length}: end of page]`;
  const links = page.links.length ? `\n\nLinks:\n${page.links.map(l => `[${l.n}] ${l.label} — ${l.url}`).join('\n')}` : '';
  return `HTTP ${res.status}\nTitle: ${page.title}\nURL: ${res.url}\n\n${slice}${more}${from === 0 ? links : ''}`;
}

const server = new Server({ name: 'web', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'web_search', description: 'Search the web. Returns up to ten results as title, URL and snippet.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The search query.' } }, required: ['query'] } },
    { name: 'open_url', description: `Open a web page and return its text with numbered links. A long page comes in parts of ${MAX_CHARS} characters; pass start to read on.`, inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The page URL.' }, start: { type: 'integer', description: 'Character offset to read from (default 0).' } }, required: ['url'] } }
  ]
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: a = {} } = request.params;
  try {
    if (name === 'web_search') return { content: [{ type: 'text', text: await webSearch(String(a.query || '')) }] };
    if (name === 'open_url') return { content: [{ type: 'text', text: await openUrl(String(a.url || ''), a.start) }] };
    return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
