// An MCP server that exposes the Human Protein Atlas bulk files as SQL tables, for the
// "model + SQL over the HPA files" baseline. Two tools: schema (every table with its columns)
// and sql (a read-only query run by DuckDB). Nothing about the atlas is added; the model must
// work out which table and which column answer the question.
import fs from 'node:fs';
import path from 'node:path';
import duckdb from 'duckdb';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const DATA = process.env.HPA_DATA_DIR || '/home/green/Systems/AtlasAI/Backend/data_local';
const MAX_ROWS = Number(process.env.HPA_SQL_MAX_ROWS || 2000);
const TIMEOUT_MS = Number(process.env.HPA_SQL_TIMEOUT_MS || 120000);

const db = new duckdb.Database(':memory:');
const conn = db.connect();
const run = (sql, params = []) => new Promise((resolve, reject) => conn.all(sql, ...params, (err, rows) => err ? reject(err) : resolve(rows)));

// Keep the original two-tool contract while preventing access to benchmark answers or credentials.
await run(`SET allowed_directories = ['${DATA.replace(/'/g, "''")}/']`);
await run('SET enable_external_access = false');
await run('SET lock_configuration = true');

const tables = [];
for (const file of fs.readdirSync(DATA).sort()) {
  if (!file.endsWith('.tsv')) continue;
  const name = file.replace(/\.tsv$/, '').replace(/[^A-Za-z0-9_]/g, '_');
  const full = path.join(DATA, file);
  // Every column is read as text: the files mix numbers, blanks and notes in one column, and a
  // query casts what it needs (TRY_CAST(x AS DOUBLE)).
  await run(`CREATE VIEW "${name}" AS SELECT * FROM read_csv('${full.replace(/'/g, "''")}', delim='\t', header=true, all_varchar=true, quote='"', escape='"', null_padding=true, ignore_errors=false)`);
  tables.push({ name, file, bytes: fs.statSync(full).size });
}

async function schemaText() {
  const lines = [];
  for (const t of tables) {
    const cols = await run(`DESCRIBE "${t.name}"`);
    lines.push(`${t.name} (${(t.bytes / 1e6).toFixed(1)} MB): ${cols.map(c => c.column_name).join(', ')}`);
  }
  return `Tables built from the Human Protein Atlas bulk files (all columns are text; cast for arithmetic, e.g. TRY_CAST(col AS DOUBLE)).\n\n${lines.join('\n')}`;
}

function toTsv(rows) {
  if (!rows.length) return '(no rows)';
  const cols = Object.keys(rows[0]);
  const cell = v => v === null || v === undefined ? '' : String(v).replace(/\t/g, ' ').replace(/\n/g, ' ');
  return [cols.join('\t'), ...rows.map(r => cols.map(c => cell(r[c])).join('\t'))].join('\n');
}

const server = new Server({ name: 'hpa-sql', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'schema', description: 'List every table (one per Human Protein Atlas bulk file) with its columns. Call this first.', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'sql', description: `Run one read-only SQL query (DuckDB dialect) over the tables. Returns up to ${MAX_ROWS} rows as tab-separated text. Every column is text; use TRY_CAST for numbers.`, inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The SQL query' } }, required: ['query'] } }
  ]
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === 'schema') return { content: [{ type: 'text', text: await schemaText() }] };
    if (name === 'sql') {
      const query = String(args?.query || '').trim();
      if (!query) throw new Error('query is required');
      if (/^\s*(insert|update|delete|create|drop|alter|copy|attach|install|load|export|pragma)\b/i.test(query)) throw new Error('read-only: SELECT queries only');
      const rows = await Promise.race([run(query), new Promise((_, rej) => setTimeout(() => rej(new Error(`query exceeded ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS))]);
      const shown = rows.slice(0, MAX_ROWS);
      const note = rows.length > MAX_ROWS ? `\n[${rows.length} rows; showing the first ${MAX_ROWS}]` : `\n[${rows.length} rows]`;
      return { content: [{ type: 'text', text: toTsv(shown) + note }] };
    }
    throw new Error(`unknown tool ${name}`);
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
