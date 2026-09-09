'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readerAnswer, quoteOnPage, allowedUrl, parsePage } = require('../../src/system/agents/reader');

test('a quote is verbatim page text modulo whitespace and quote marks, within length bounds', () => {
  const page = 'Tissue enriched: at least four-fold higher mRNA level in a particular tissue compared to any other tissue.  The threshold is nTPM ≥ 1.';
  assert.equal(quoteOnPage('at least four-fold higher mRNA level in a particular tissue', page), true);
  assert.equal(quoteOnPage('at least four-fold higher\n mRNA level in a particular tissue', page), true);
  assert.equal(quoteOnPage('“at least four-fold higher mRNA level”', page), false);   // quote marks added by the model are not on the page
  assert.equal(quoteOnPage('four-fold higher mRNA level in a particular organ', page), false);
  assert.equal(quoteOnPage('nTPM', page), false);                                     // too short to mean anything
});

test('only information pages of the atlas are reading material', () => {
  assert.equal(allowedUrl('/about/download'), 'https://www.proteinatlas.org/about/download');
  assert.equal(allowedUrl('https://www.proteinatlas.org/learn/dictionary/tissue/liver#top'), 'https://www.proteinatlas.org/learn/dictionary/tissue/liver');
  assert.equal(allowedUrl('/humanproteome/tissue/liver'), 'https://www.proteinatlas.org/humanproteome/tissue/liver');
  assert.equal(allowedUrl('/ENSG00000163631-ALB/tissue'), null);
  assert.equal(allowedUrl('/search/liver'), null);
  assert.equal(allowedUrl('/api/search_download.php?search=x'), null);
  assert.equal(allowedUrl('/download/proteinatlas.tsv.zip'), null);
  assert.equal(allowedUrl('https://elsewhere.org/about'), null);
});

test('a page is read as sections and same-site links', () => {
  const html = `<html><head><title>About - The Human Protein Atlas</title></head><body><nav><a href="/search/x">search</a></nav>
    <h1>The Human Protein Atlas</h1><p>The project started in 2003.</p><h2>Releases</h2><p>Version 24.0 was released on 2024-10-22.</p>
    <a href="/about/releases">Release history</a><a href="/ENSG00000163631-ALB">ALB</a><a href="/about/download">Downloadable data</a></body></html>`;
  const page = parsePage(html, 'https://www.proteinatlas.org/about');
  assert.equal(page.title, 'About - The Human Protein Atlas');
  assert.deepEqual(page.sections.map(s => s.heading), ['The Human Protein Atlas', 'Releases']);
  assert.equal(page.sections[1].text, 'Version 24.0 was released on 2024-10-22.');
  assert.deepEqual(page.links.map(l => l.url), ['https://www.proteinatlas.org/about/releases', 'https://www.proteinatlas.org/about/download']);
});

test('the reader follows links by number, keeps verified claims with one quote each, and drops the rest', async () => {
  const site = {
    'https://www.proteinatlas.org/': '<html><title>Home</title><body><h1>Atlas</h1><p>Welcome.</p><a href="/about/releases">Releases</a></body></html>',
    'https://www.proteinatlas.org/about/releases': '<html><title>Releases</title><body><h2>Version 24.0</h2><p>Version 24.0 was released on 2024-10-22 and includes a new Structure Atlas.</p></body></html>'
  };
  const fetched = [];
  const fetchPage = async url => { fetched.push(url); if (!site[url]) throw new Error(`no page ${url}`); return site[url]; };
  const replies = [
    { follow: [{ page: 0, link: 0 }] },
    { open: [{ page: 1, sections: [0] }] },
    { answer: { claims: [
      { claim: 'Version 24.0 came out on 22 October 2024', page: 1, quote: 'Version 24.0 was released on 2024-10-22' },
      { claim: 'It added a Structure Atlas', page: 1, quote: 'includes a brand new Structure Atlas' },
      { claim: 'Made up', page: 7, quote: 'nothing' }
    ], not_found: '' } },
    { answer: { claims: [
      { claim: 'Version 24.0 came out on 22 October 2024', page: 1, quote: 'Version 24.0 was released on 2024-10-22' },
      { claim: 'It added a Structure Atlas', page: 1, quote: 'includes a new Structure Atlas' }
    ], not_found: '' } }
  ];
  const ask = async () => replies.shift();
  const result = await readerAnswer('when was version 24 released?', { fetchPage, ask });
  assert.equal(result.mode, 'reader');
  assert.deepEqual(fetched, ['https://www.proteinatlas.org/', 'https://www.proteinatlas.org/about/releases']);
  assert.deepEqual(result.claims.map(c => c.claim), ['Version 24.0 came out on 22 October 2024', 'It added a Structure Atlas']);
  assert.equal(result.claims[0].url, 'https://www.proteinatlas.org/about/releases');
  assert.match(result.claims[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.dropped, []);
  assert.match(result.summary_md, /"Version 24.0 was released on 2024-10-22"/);
  assert.deepEqual(result.resources.map(r => r.url), ['https://www.proteinatlas.org/', 'https://www.proteinatlas.org/about/releases']);
});

test('a claim that still has no quote after the repair turn is dropped and named', async () => {
  const site = { 'https://www.proteinatlas.org/': '<html><title>Home</title><body><h1>Atlas</h1><p>The atlas has ten sections.</p></body></html>' };
  const fetchPage = async url => site[url];
  const replies = [
    { open: [{ page: 0, sections: [0] }] },
    { answer: { claims: [{ claim: 'It has twelve sections', page: 0, quote: 'The atlas has twelve sections' }], not_found: '' } },
    { answer: { claims: [{ claim: 'It has twelve sections', page: 0, quote: 'twelve sections' }], not_found: '' } }
  ];
  const result = await readerAnswer('how many sections?', { fetchPage, ask: async () => replies.shift() });
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.dropped, ['It has twelve sections']);
  assert.match(result.summary_md, /Dropped, no verbatim support/);
});
