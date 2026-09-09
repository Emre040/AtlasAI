'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readerAnswer, quoteOnPage, nearestPassage, allowedUrl, parsePage, sentences, MAX_RETRIES } = require('../../src/system/agents/reader');

test('a quote is verbatim page text modulo whitespace and quote marks, within length bounds', () => {
  const page = 'Tissue enriched: at least four-fold higher mRNA level in a particular tissue compared to any other tissue.  The threshold is nTPM ≥ 1.';
  assert.equal(quoteOnPage('at least four-fold higher mRNA level in a particular tissue', page), true);
  assert.equal(quoteOnPage('at least four-fold higher\n mRNA level in a particular tissue', page), true);
  assert.equal(quoteOnPage('“at least four-fold higher mRNA level”', page), false);   // quote marks added by the model are not on the page
  assert.equal(quoteOnPage('four-fold higher mRNA level in a particular organ', page), false);
  assert.equal(quoteOnPage('nTPM', page), false);                                     // too short to mean anything
});

test('the passage a failed quote came from is found by its start, its end, or any four words in a row', () => {
  const page = 'The HPA program started in summer 2003, upon receipt of funding from the Knut and Alice Wallenberg Foundation (KAW). The original funding has since been renewed multiple times by KAW.';
  assert.match(nearestPassage('The HPA program started in the summer of 2003 with funding', page), /^The HPA program started in summer 2003/);
  assert.match(nearestPassage('It has been renewed multiple times by KAW.', page), /renewed multiple times by KAW\.$/);
  assert.match(nearestPassage('Funds came upon receipt of funding from KAW', page), /upon receipt of funding from/);
  assert.equal(nearestPassage('nothing of this is on the page at all', page), null);
  assert.equal(nearestPassage('The HPA program started in summer 2003', page, 10), 'The HPA program started in summer 2003, upon rec …');
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
  // a question mark inside a quotation does not end the sentence
  assert.deepEqual(sentences('The founders asked: “What is it that makes a kidney a kidney? And what makes a heart a heart?” [2]. The pilot began in 2000 [1].').map(x => x.cites), [[2], [1]]);
});

const site = {
  'https://www.proteinatlas.org/': '<html><title>Home</title><body><h1>Atlas</h1><p>Welcome.</p><a href="/about/releases">Releases</a></body></html>',
  'https://www.proteinatlas.org/about/releases': '<html><title>Releases</title><body><h2>Version 24.0</h2><p>Version 24.0 was released on 2024-10-22 and includes a new Structure Atlas.</p></body></html>'
};

test('the reader follows links by number and answers in prose whose every sentence cites a quote on the page', async () => {
  const fetched = [];
  const fetchPage = async url => { fetched.push(url); if (!site[url]) throw new Error(`no page ${url}`); return site[url]; };
  const asked = []; const steps = [];
  const replies = [
    { follow: [{ page: 0, link: 0 }] },
    { open: [{ page: 1, sections: [0] }] },
    { answer: { text: 'Version 24.0 came out on 22 October 2024 [1]. It added a Structure Atlas [2]. It also cured cancer [3].', citations: [
      { n: 1, page: 1, quote: 'Version 24.0 was released on 2024-10-22' },
      { n: 2, page: 1, quote: 'includes a brand new Structure Atlas' },       // not on the page as written
      { n: 3, page: 7, quote: 'nothing here at all on this page' }           // no such page
    ], not_found: '' } },
    // only the failing citations come back: one copied exactly this time, one dropped
    { citations: [{ n: 2, page: 1, quote: 'includes a new Structure Atlas' }], drop: [3] }
  ];
  const ask = async (system, user, onStep, label) => { asked.push({ system, label, user }); return replies.shift(); };
  const result = await readerAnswer('when was version 24 released?', { fetchPage, ask, onStep: async s => { steps.push(s); } });
  assert.equal(result.mode, 'reader');
  assert.deepEqual(fetched, ['https://www.proteinatlas.org/', 'https://www.proteinatlas.org/about/releases']);
  assert.equal(result.text, 'Version 24.0 came out on 22 October 2024 [1]. It added a Structure Atlas [2].');
  assert.deepEqual(result.citations.map(c => [c.n, c.quote]), [[1, 'Version 24.0 was released on 2024-10-22'], [2, 'includes a new Structure Atlas']]);
  assert.equal(result.citations[0].url, 'https://www.proteinatlas.org/about/releases');
  assert.match(result.citations[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.dropped_sentences, ['It also cured cancer [3].']);
  // the retry names each failing citation, shows the page's text around where it came from, and keeps the answer text
  assert.equal(asked[3].label, 'reader retry 1');
  assert.match(asked[3].system, /only the citations named below change/);
  assert.match(asked[3].user, /\[2\] on page 1, not on the page as written: "includes a brand new Structure Atlas"/);
  assert.match(asked[3].user, /The page says: ".*and includes a new Structure Atlas\."/);
  assert.match(asked[3].user, /\[3\] on page 7, no such page/);
  assert.match(asked[3].user, /The answer, which stays as it is:\nVersion 24.0 came out on 22 October 2024 \[1\]/);
  const sentBack = steps.find(s => s.label === 'Sent back');
  assert.match(sentBack.message, /\[2\] "includes a brand new Structure Atlas" not on the page as written \(page 1\) · \[3\] "nothing here at all on this page" no such page/);
  assert.match(result.summary_md, /^Version 24.0 came out on 22 October 2024 \[1\]\. It added a Structure Atlas \[2\]\./);
  assert.match(result.summary_md, /\[1\] "Version 24.0 was released on 2024-10-22"/);
  assert.doesNotMatch(result.summary_md, /cured cancer \[3\]\. It/);
});

test('a sentence that sums up a table cites several short spans, each checked on its own', async () => {
  const pages = { 'https://www.proteinatlas.org/': '<html><title>Milestones</title><body><h2>Significant milestones</h2><table><tr><td>2015</td><td>21</td><td>The Tissue Atlas</td></tr><tr><td>2016</td><td>22</td><td>Correlation of RNA and protein levels</td></tr></table></body></html>' };
  const replies = [
    { open: [{ page: 0, sections: [0] }] },
    { answer: { text: 'The Tissue Atlas came in 2015 and the RNA-protein correlation work in 2016 [1].', citations: [{ n: 1, page: 0, quote: ['2015 21 The Tissue Atlas', '2016 22 Correlation of RNA versus protein levels'] }], not_found: '' } },
    { citations: [{ n: 1, page: 0, quote: ['2015 21 The Tissue Atlas', '2016 22 Correlation of RNA and protein levels'] }] }
  ];
  const asked = []; const steps = [];
  const result = await readerAnswer('milestones?', { fetchPage: async url => pages[url], ask: async (s, u, o, label) => { asked.push({ label, user: u }); return replies.shift(); }, onStep: async s => { steps.push(s); } });
  assert.match(steps.find(s => s.label === 'Sent back').message, /^\[1\] "2016 22 Correlation of RNA versus protein levels" span 2 of 2 not on the page as written \(page 0\)$/);
  assert.match(asked[2].user, /The page says: ".*2016 22 Correlation of RNA and protein levels/);
  assert.equal(result.text, 'The Tissue Atlas came in 2015 and the RNA-protein correlation work in 2016 [1].');
  assert.deepEqual(result.citations[0].quotes, ['2015 21 The Tissue Atlas', '2016 22 Correlation of RNA and protein levels']);
  assert.equal(result.citations[0].quote, '2015 21 The Tissue Atlas […] 2016 22 Correlation of RNA and protein levels');
});

test('a quote longer than the limit is named with its length and the limit', async () => {
  const long = 'x'.repeat(30).split('').map((c, i) => `word${i}`).join(' ');   // 30 words, well over 600 characters? no: keep it honest below
  const page = `<html><title>T</title><body><p>${'The atlas grew every year with new sections and data, '.repeat(20)}</p></body></html>`;
  const quote = 'The atlas grew every year with new sections and data, '.repeat(12).trim();   // 659 characters, on the page, too long
  const replies = [
    { open: [{ page: 0, sections: [0] }] },
    { answer: { text: `It grew every year [1].`, citations: [{ n: 1, page: 0, quote }], not_found: '' } },
    { citations: [{ n: 1, page: 0, quote: 'The atlas grew every year with new sections and data' }] }
  ];
  const asked = []; const steps = [];
  const result = await readerAnswer('growth?', { fetchPage: async () => page, ask: async (s, u, o, label) => { asked.push({ label, user: u }); return replies.shift(); }, onStep: async s => { steps.push(s); } });
  assert.match(steps.find(s => s.label === 'Sent back').message, /too long \(6\d\d characters, the limit is 600\)/);
  assert.match(asked[2].user, /Give the shortest span that carries the fact, or several short spans as a list in quote\./);
  assert.equal(result.citations[0].quote, 'The atlas grew every year with new sections and data');
  assert.equal(long.length > 0, true);
});

test('a citation that is still wrong after the retries takes its sentence with it', async () => {
  const fetchPage = async url => site[url];
  const replies = [
    { open: [{ page: 0, sections: [0] }] },
    { answer: { text: 'The atlas has twelve sections [1].', citations: [{ n: 1, page: 0, quote: 'The atlas has twelve sections' }], not_found: '' } }
  ];
  for (let i = 0; i < MAX_RETRIES; i += 1) replies.push({ citations: [{ n: 1, page: 0, quote: 'The atlas has twelve sections' }] });
  const labels = [];
  const result = await readerAnswer('how many sections?', { fetchPage, ask: async (s, u, o, label) => { labels.push(label); return replies.shift(); } });
  assert.equal(result.text, '');
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.dropped_sentences, ['The atlas has twelve sections [1].']);
  assert.deepEqual(labels, ['reader turn 1', 'reader turn 2', 'reader retry 1', 'reader retry 2', 'reader retry 3']);
  assert.match(result.summary_md, /Left out, no verified citation/);
});
