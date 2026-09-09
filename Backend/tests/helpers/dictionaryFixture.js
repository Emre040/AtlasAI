'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const BACKEND = process.env.ATLASAI_BACKEND_ROOT || path.resolve(__dirname, '../..');

async function dictionaryFixture({ responses, scrapeError = false, readerTokens = { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 } } = {}) {
  const filename = require.resolve(path.join(BACKEND, 'src/system/agents/dictionaryExpert'));
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded), requests = [];
  const stubs = {
    puppeteer: {}, cheerio: {},
    '../../config/runtime': { requireBoolean: () => false },
    // The reader (a question about the atlas) is its own module with its own tests; here it is a stub
    // that answers with a fixed token count, so the dictionary's routing and accounting are what is tested.
    './reader': { readerAnswer: async question => ({ status: 'ok', mode: 'reader', question, claims: [], dropped: [], not_found: '', pages: [], resources: [], summary_md: '', tokens: readerTokens }) },
    '../../inference/gateway': { inference: { chat: { completions: { async create(request) {
      const response = responses[requests.length]; requests.push(request);
      if (!response) throw new Error('Unexpected dictionary inference');
      return response;
    } } } } }
  };
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : originalRequire(name);
  // Replace only external retrieval at module scope; matching, routing, aggregation,
  // successful/no-match/error returns and public result construction remain real.
  const retrieval = `
    scrapeDictionaryPage = async () => ${scrapeError ? "{ throw new Error('source unavailable'); }" : "({ pageTitle: 'Exact dictionary source', textContent: 'A source description.', images: [], relatedLinks: [] })"};
  `;
  loaded._compile((await fs.readFile(filename, 'utf8')) + retrieval, filename);
  return { run: loaded.exports, requests };
}
const dictionaryResponse = (content, prompt, completion) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } });
module.exports = { dictionaryFixture, dictionaryResponse };
