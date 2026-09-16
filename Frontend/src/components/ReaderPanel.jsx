import React, { useEffect, useId, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck, faChevronDown, faChevronLeft, faChevronRight, faCopy, faExternalLinkAlt, faFileLines,
  faXmark, faArrowRight, faMagnifyingGlass,
} from '@fortawesome/free-solid-svg-icons';
import { ReaderTransition, useReaderMotion } from './ReaderMotion';
import './ReaderPanel.css';

const SITE = 'https://www.proteinatlas.org';

// A page URL as a short path: "about › history", "news › 2026-09-02 › ...".
export function pagePath(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p).replace(/\+/g, ' '));
    return parts.length ? parts.join(' › ') : 'home';
  } catch { return String(url || '').replace(SITE, '') || 'home'; }
}

// Live progress folded from the tool stream: pages in order, the current one, citations sent back.
export function readerLiveNext(prev, tool) {
  const live = prev ? { ...prev, pages: [...prev.pages] } : { pages: [], current: null, sentBack: 0, done: false, failed: false };
  if (tool.status === 'started') return { pages: [], current: null, sentBack: 0, done: false, failed: false };
  if (tool.status === 'failed') return { ...live, done: true, failed: true };
  if (tool.status === 'completed') return { ...live, done: true, current: null };
  const step = tool.step || {};
  if (step.label === 'Reading' && step.message) { if (!live.pages.includes(step.message)) live.pages.push(step.message); live.current = step.message; }
  else if (step.label === 'Sent back') { live.sentBack += 1; live.sentBackLast = step.message || ''; }
  else if (step.label === 'Done') { live.done = true; live.current = null; }
  return live;
}

const Icon = ({ icon, ...props }) => <FontAwesomeIcon icon={icon} {...props} />;
const sourceTitle = page => page.title?.replace(/\s*[-–|]\s*The Human Protein Atlas$/i, '') || pagePath(page.url);
const quoteSpans = citation => Array.isArray(citation.quotes) && citation.quotes.length ? citation.quotes : [citation.quote];

// Navigation follows actual Reader page events; the reading motion advances continuously.
function ReadingScene({ live, navigating }) {
  const pages = live?.pages || [];
  const stopped = live?.done || live?.failed;
  const current = stopped ? pages[pages.length - 1] : live?.current;
  const readingSurface = useRef(null);
  useReaderMotion(readingSurface, current, stopped);
  const previous = pages[pages.indexOf(current) - 1];
  const trail = useRef(null);
  const currentPage = useRef(null);
  useEffect(() => {
    const list = trail.current;
    const link = currentPage.current;
    if (!list || !link) return;
    const bounds = list.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (item.right > bounds.right || item.left < bounds.left) {
      list.scrollTo({
        left: list.scrollLeft + item.left - bounds.left,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
    }
  }, [current]);
  return (
    <div className={`HPAG-reader-scene${stopped ? ' is-stopped' : ''}${navigating ? ' is-navigating' : ''}`}>
      <div className="HPAG-reader-atmosphere" aria-hidden="true"><span /><span /></div>
      <div className="HPAG-reader-activity" role="status">
        <span className="HPAG-reader-activity-icon"><Icon icon={live?.failed ? faXmark : navigating ? faArrowRight : stopped ? faCheck : faMagnifyingGlass} /></span>
        <div>
          <h3>{live?.failed ? 'Reading interrupted' : stopped ? 'Preparing answer' : navigating ? 'Navigating to a new page' : current ? 'Reading page' : 'Opening the atlas'}</h3>
          <div className="HPAG-reader-navigation" key={current || 'opening'}>
            {navigating && previous && <><span>{pagePath(previous)}</span><Icon icon={faArrowRight} /></>}
            <span className="HPAG-reader-destination">{current ? pagePath(current) : 'proteinatlas.org'}</span>
          </div>
        </div>
        {!stopped && <span className="HPAG-reader-live-dot" aria-hidden="true" />}
      </div>
      <div className="HPAG-reader-reading-art" aria-hidden="true">
        <div className="HPAG-reader-peripheral-page is-left" />
        <div className="HPAG-reader-peripheral-page is-right" />
        <div className="HPAG-reader-page-stack" key={current || 'opening'}>
          {navigating && previous && <div className="HPAG-reader-departing-page"><span>{pagePath(previous)}</span></div>}
          <div className="HPAG-reader-paper">
            <div className="HPAG-reader-paper-heading"><Icon icon={faFileLines} /><span>{current ? pagePath(current) : 'Human Protein Atlas'}</span></div>
            <div className="HPAG-reader-page-window" ref={readingSurface}>
              <div className="HPAG-reader-page-lines">
                {[0, 1].map(bank => <div key={bank} className="HPAG-reader-line-bank">
                  {Array.from({ length: 48 }, (_, i) => <span key={i} style={{ width: `${i % 7 === 0 ? 32 + i % 17 : 62 + (i * 19 + (current?.length || 0)) % 36}%` }} />)}
                </div>)}
              </div>
              <div className="HPAG-reader-reading-light" /><div className="HPAG-reader-focus-lens" />
            </div>
          </div>
        </div>
      </div>
      {live?.failed && <p className="HPAG-reader-interruption">Reader could not finish. Try your question again.</p>}
      {pages.length > 0 && <div className="HPAG-reader-trail-wrap">
        <div className="HPAG-reader-trail-caption"><span>Pages explored</span><span>{pages.length}</span></div>
        <div className="HPAG-reader-page-trail" aria-label="Pages opened" ref={trail}>
          {pages.map((url, i) => <a key={url} ref={url === current ? currentPage : null} href={url} target="_blank" rel="noopener noreferrer" className={url === current && !stopped ? 'is-current' : ''}>
            <span className="HPAG-reader-trail-index">{String(i + 1).padStart(2, '0')}</span>
            <span className="HPAG-reader-trail-path">{pagePath(url)}</span><Icon icon={faExternalLinkAlt} />
          </a>)}
        </div>
      </div>}
      {live?.sentBack > 0 && <details className="HPAG-reader-checks"><summary>Checking quotations against the source text</summary><p>{live.sentBackLast}</p></details>}
    </div>
  );
}

// Source selection belongs to this answer, even when a chat contains several Reader runs.
function Prose({ text, citations }) {
  const [selected, setSelected] = useState(citations.length ? citations[0].n : null);
  const trigger = useRef(null);
  const id = useId();
  const known = new Map(citations.map(c => [c.n, c]));
  const paragraphs = String(text || '').split(/\n\s*\n/).filter(p => p.trim());
  const index = citations.findIndex(c => c.n === selected);
  const citation = known.get(selected);
  const close = () => {
    setSelected(null);
    const button = trigger.current || document.getElementById(`${id}-answer`)?.querySelector('.HPAG-reader-cite');
    button?.focus({ preventScroll: true });
  };
  const withChips = line => line.split(/(\[\d+\])/g).map((part, i) => {
    const match = /^\[(\d+)\]$/.exec(part);
    if (!match || !known.has(Number(match[1]))) return <React.Fragment key={i}>{part}</React.Fragment>;
    const n = Number(match[1]);
    const expanded = selected === n;
    return <button key={i} type="button" className={`HPAG-reader-cite${expanded ? ' is-selected' : ''}`}
      aria-label={`Inspect source ${n}`} aria-expanded={expanded} aria-controls={`${id}-source`}
      onClick={event => {
        trigger.current = event.currentTarget;
        setSelected(expanded ? null : n);
      }}>{n}</button>;
  });
  return <div className="HPAG-reader-text" id={`${id}-answer`}>
    {paragraphs.map((p, pi) => <p className="HPAG-reader-paragraph" key={pi}>
      {p.split('\n').filter(l => l.trim()).map((line, li) => <span key={li} className="HPAG-reader-line">{withChips(line)}</span>)}
    </p>)}
    <ReaderTransition viewKey={citation ? 'open' : 'closed'} id={`${id}-source`} duration={360}>
      {citation && <div className="HPAG-reader-inline-source" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); }
      }}><QuoteCard citation={citation} index={index} total={citations.length}
        onPrevious={() => setSelected(citations[index - 1].n)} onNext={() => setSelected(citations[index + 1].n)} />
      </div>}
    </ReaderTransition>
  </div>;
}

function QuoteCard({ citation, index, total, onPrevious, onNext }) {
  const fetched = citation.fetched_unix_ms ? new Date(citation.fetched_unix_ms).toLocaleString() : null;
  const verification = `Matched to the page text${fetched ? ` fetched ${fetched}` : ''}.${citation.sha256 ? ` Page SHA-256: ${citation.sha256}` : ''}`;
  return <article className="HPAG-reader-quote">
    <div className="HPAG-reader-quote-heading"><span className="HPAG-reader-source-number">{citation.n}</span><span className="HPAG-reader-eyebrow">Direct quotation</span>
      <span className="HPAG-reader-source-position" aria-live="polite">{index + 1} / {total}</span>
      <span className="HPAG-reader-verified" title={verification}><Icon icon={faCheck} /> Exact quote</span>
    </div>
    <div className="HPAG-reader-quote-stage">
      <button type="button" className="HPAG-reader-source-arrow is-previous" aria-label="Previous source" disabled={index === 0} onClick={onPrevious}><Icon icon={faChevronLeft} /></button>
      <ReaderTransition viewKey={citation.n} duration={360}><QuoteContent citation={citation} /></ReaderTransition>
      <button type="button" className="HPAG-reader-source-arrow is-next" aria-label="Next source" disabled={index === total - 1} onClick={onNext}><Icon icon={faChevronRight} /></button>
    </div>
  </article>;
}

function QuoteContent({ citation }) {
  const [copyState, setCopyState] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const spans = quoteSpans(citation);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(`${spans.map(s => `“${s}”`).join(' ')} — ${citation.title || pagePath(citation.url)} (${citation.url})`);
      setCopyState('copied');
      timer.current = setTimeout(() => setCopyState(''), 1800);
    } catch { setCopyState('failed'); }
  };
  return <>
    <figure className="HPAG-reader-quotation">
      <blockquote cite={citation.url}>{spans.map((span, i) => <p key={i}>
        <span className="HPAG-reader-quote-mark is-opening" aria-hidden="true">“</span>{span}<span className="HPAG-reader-quote-mark is-closing" aria-hidden="true">”</span>
      </p>)}</blockquote>
      <figcaption><span className="HPAG-reader-attribution" aria-hidden="true">—</span><a className="HPAG-reader-source-title" href={citation.url} target="_blank" rel="noopener noreferrer">{sourceTitle(citation)} <Icon icon={faExternalLinkAlt} /></a></figcaption>
    </figure>
    <div className="HPAG-reader-quote-foot">
      <a href={citation.url} target="_blank" rel="noopener noreferrer" className="HPAG-reader-text-button">Open page <Icon icon={faExternalLinkAlt} /></a>
      <button type="button" className="HPAG-reader-copy" onClick={copy} aria-label={`Copy source ${citation.n}`}><Icon icon={copyState === 'copied' ? faCheck : faCopy} /> {copyState === 'copied' ? 'Copied' : 'Copy'}</button>
    </div>
    <span className="HPAG-reader-copy-feedback" role="status">{copyState === 'failed' ? 'Could not copy. Select the passage to copy it manually.' : copyState === 'copied' ? 'Quote and source copied.' : ''}</span>
  </>;
}

function Pages({ pages, citations }) {
  return <div className="HPAG-reader-pages">
    {!pages.length && <p className="HPAG-reader-empty">Pages will appear here as Reader opens them.</p>}
    {pages.map(page => {
      const count = citations.filter(c => c.url === page.url).length;
      return <a key={page.url} href={page.url} target="_blank" rel="noopener noreferrer" className="HPAG-reader-page">
        <span className="HPAG-reader-page-icon"><Icon icon={faFileLines} /></span>
        <span className="HPAG-reader-page-name"><strong>{sourceTitle(page)}</strong><span>{pagePath(page.url)}</span></span>
        {count > 0 && <span className="HPAG-reader-page-count">{count} {count === 1 ? 'citation' : 'citations'}</span>}
        <Icon icon={faExternalLinkAlt} />
      </a>;
    })}
  </div>;
}

export default function ReaderPanel({ live, result }) {
  const id = useId();
  const [pagesOpen, setPagesOpen] = useState(true);
  const pageTimes = new Map((result?.pages || []).map(page => [page.url, page.fetched_unix_ms]));
  const citations = (result?.citations || []).map(citation => ({ ...citation, fetched_unix_ms: pageTimes.get(citation.url) }));
  const pages = result?.pages || [];
  const running = !result && !live?.done && !live?.failed;
  const currentPageUrl = live?.current;
  const [settledPage, setSettledPage] = useState(null);
  const navigating = running && Boolean(currentPageUrl) && settledPage !== currentPageUrl;
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setSettledPage(currentPageUrl), 1500);
    return () => clearTimeout(timer);
  }, [currentPageUrl, running]);
  return <section className="HPAG-reader" aria-label="Reader">
    <ReaderTransition viewKey={result ? 'answer' : 'reading'}>
      {!result ? <ReadingScene live={live} navigating={navigating} /> : <div className="HPAG-reader-answer">
        {result.text ? <Prose text={result.text} citations={citations} /> : <p className="HPAG-reader-empty">No answer supported by a source passage was found on these pages.</p>}
        {result.not_found && <div className="HPAG-reader-notfound"><strong>Not found in the pages read</strong><p>{result.not_found}</p></div>}
        {result.dropped_sentences?.length > 0 && <details className="HPAG-reader-leftout"><summary>{result.dropped_sentences.length} {result.dropped_sentences.length === 1 ? 'sentence' : 'sentences'} excluded without a verified citation</summary><ul>{result.dropped_sentences.map((sentence, i) => <li key={i}>{sentence}</li>)}</ul></details>}
        {pages.length > 0 && <footer className="HPAG-reader-footnote">
          <button type="button" className="HPAG-reader-pages-toggle" aria-expanded={pagesOpen} aria-controls={`${id}-pages`} onClick={() => setPagesOpen(open => !open)}>
            <Icon icon={faFileLines} /><span>{pages.length} {pages.length === 1 ? 'page' : 'pages'} read</span><Icon icon={faChevronDown} />
          </button>
          <ReaderTransition viewKey={pagesOpen ? 'pages' : 'closed'} id={`${id}-pages`} duration={360}>
            {pagesOpen && <Pages pages={pages} citations={citations} />}
          </ReaderTransition>
        </footer>}
      </div>}
    </ReaderTransition>
  </section>;
}
