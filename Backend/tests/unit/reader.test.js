'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readerAnswer, quoteOnPage, allowedUrl, parsePage, sentences, MAX_RETRIES } = require('../../src/system/agents/reader');

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
    <div id="sidemenu" class="menu"><a href="/about/history">History</a><p>Menu text is not page text.</p></div>
    <h1>The Human Protein Atlas</h1><p>The project started in 2003.</p><h2>Releases</h2><p>Version 24.0 was released on 2024-10-22.</p>
    <a href="/about/releases">Release history</a><a href="/ENSG00000163631-ALB">ALB</a><a href="/about/download">Downloadable data</a></body></html>`;
  const page = parsePage(html, 'https://www.proteinatlas.org/about');
  assert.equal(page.title, 'About - The Human Protein Atlas');
  assert.deepEqual(page.sections.map(s => s.heading), ['The Human Protein Atlas', 'Releases']);
  assert.equal(page.sections[1].text, 'Version 24.0 was released on 2024-10-22.');
  assert.doesNotMatch(page.text, /Menu text/);
  // the section menu's links are kept (they are how the about pages reach each other), its text is not
  assert.deepEqual(page.links.map(l => l.url), ['https://www.proteinatlas.org/about/history', 'https://www.proteinatlas.org/about/releases', 'https://www.proteinatlas.org/about/download']);
});

test('sentences carry the citation markers around their full stop', () => {
  assert.deepEqual(sentences('Version 24.0 came out in October 2024 [1]. It added a Structure Atlas.[2][3] No citation here.'),
    [{ text: 'Version 24.0 came out in October 2024 [1].', cites: [1] }, { text: 'It added a Structure Atlas.[2][3]', cites: [2, 3] }, { text: 'No citation here.', cites: [] }]);
});

const site = {
  'https://www.proteinatlas.org/': '<html><title>Home</title><body><h1>Atlas</h1><p>Welcome.</p><a href="/about/releases">Releases</a></body></html>',
  'https://www.proteinatlas.org/about/releases': '<html><title>Releases</title><body><h2>Version 24.0</h2><p>Version 24.0 was released on 2024-10-22 and includes a new Structure Atlas.</p></body></html>'
};

test('the reader follows links by number and answers in prose whose every sentence cites a quote on the page', async () => {
  const fetched = [];
  const fetchPage = async url => { fetched.push(url); if (!site[url]) throw new Error(`no page ${url}`); return site[url]; };
  const asked = [];
  const replies = [
    { follow: [{ page: 0, link: 0 }] },
    { open: [{ page: 1, sections: [0] }] },
    { answer: { text: 'Version 24.0 came out on 22 October 2024 [1]. It added a Structure Atlas [2]. It also cured cancer [3].', citations: [
      { n: 1, page: 1, quote: 'Version 24.0 was released on 2024-10-22' },
      { n: 2, page: 1, quote: 'includes a brand new Structure Atlas' },       // not on the page as written
      { n: 3, page: 7, quote: 'nothing here at all on this page' }           // no such page
    ], not_found: '' } },
    { answer: { text: 'Version 24.0 came out on 22 October 2024 [1]. It added a Structure Atlas [2]. It also cured cancer [3].', citations: [
      { n: 1, page: 1, quote: 'Version 24.0 was released on 2024-10-22' },
      { n: 2, page: 1, quote: 'includes a new Structure Atlas' }
    ], not_found: '' } }
  ];
  const ask = async (system, user, onStep, label) => { asked.push({ label, user }); return replies.shift(); };
  const result = await readerAnswer('when was version 24 released?', { fetchPage, ask });
  assert.equal(result.mode, 'reader');
  assert.deepEqual(fetched, ['https://www.proteinatlas.org/', 'https://www.proteinatlas.org/about/releases']);
  assert.equal(result.text, 'Version 24.0 came out on 22 October 2024 [1]. It added a Structure Atlas [2].');
  assert.deepEqual(result.citations.map(c => [c.n, c.quote]), [[1, 'Version 24.0 was released on 2024-10-22'], [2, 'includes a new Structure Atlas']]);
  assert.equal(result.citations[0].url, 'https://www.proteinatlas.org/about/releases');
  assert.match(result.citations[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.dropped_sentences, ['It also cured cancer [3].']);
  assert.equal(asked[3].label, 'reader retry 1');
  assert.match(asked[3].user, /\[2\] on page 1: "includes a brand new Structure Atlas" is not on that page exactly as written/);
  assert.match(result.summary_md, /^Version 24.0 came out on 22 October 2024 \[1\]\. It added a Structure Atlas \[2\]\./);
  assert.match(result.summary_md, /\[1\] "Version 24.0 was released on 2024-10-22"/);
  assert.doesNotMatch(result.summary_md, /cured cancer \[3\]\. It/);
});

test('a citation that is still wrong after the retries takes its sentence with it', async () => {
  const fetchPage = async url => site[url];
  const replies = [{ open: [{ page: 0, sections: [0] }] }];
  for (let i = 0; i <= MAX_RETRIES; i += 1) replies.push({ answer: { text: 'The atlas has twelve sections [1].', citations: [{ n: 1, page: 0, quote: 'The atlas has twelve sections' }], not_found: '' } });
  const labels = [];
  const result = await readerAnswer('how many sections?', { fetchPage, ask: async (s, u, o, label) => { labels.push(label); return replies.shift(); } });
  assert.equal(result.text, '');
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.dropped_sentences, ['The atlas has twelve sections [1].']);
  assert.deepEqual(labels, ['reader turn 1', 'reader turn 2', 'reader retry 1', 'reader retry 2', 'reader retry 3']);
  assert.match(result.summary_md, /Left out, no verified citation/);
});
