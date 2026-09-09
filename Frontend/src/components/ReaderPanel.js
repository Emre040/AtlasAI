import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faCopy, faExternalLinkAlt, faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons';

// The reader's panel inside an assistant message. While it reads, an abstract scene: drifting
// shapes and a sweeping beam over the trail of pages it has opened, the current one lit. When it
// is done, the verified quotes as cards, each with its page; what the pages did not say and what
// was left out (spans the model wrote that were not on the page) follow, plainly labelled.

const SITE = 'https://www.proteinatlas.org';

// A page URL as a short path: "about › history", "news › 2026-09-02 › ...".
export function pagePath(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p).replace(/\+/g, ' '));
    return parts.length ? parts.join(' › ') : 'home';
  } catch { return String(url || '').replace(SITE, '') || 'home'; }
}

// Live progress folded from the tool stream: pages in order, the current one, quotes sent back.
export function readerLiveNext(prev, tool) {
  const live = prev ? { ...prev, pages: [...prev.pages] } : { pages: [], current: null, sentBack: 0, done: false, failed: false };
  if (tool.status === 'started') return { pages: [], current: null, sentBack: 0, done: false, failed: false };
  if (tool.status === 'failed') return { ...live, done: true, failed: true };
  if (tool.status === 'completed') return { ...live, done: true, current: null };
  const step = tool.step || {};
  if (step.label === 'Reading' && step.message) { if (!live.pages.includes(step.message)) live.pages.push(step.message); live.current = step.message; }
  else if (step.label === 'Sent back') live.sentBack += 1;
  else if (step.label === 'Done') { live.done = true; live.current = null; }
  return live;
}

function Scene({ live }) {
  const pages = live?.pages || [];
  const current = live?.current;
  return (
    <div className={`HPAG-reader-scene${live?.done ? ' HPAG-reader-scene-done' : ''}`}>
      <div className="HPAG-reader-shapes" aria-hidden="true">
        <span className="HPAG-reader-blob HPAG-reader-blob-a" />
        <span className="HPAG-reader-blob HPAG-reader-blob-b" />
        <span className="HPAG-reader-blob HPAG-reader-blob-c" />
        <span className="HPAG-reader-ring" />
        {!live?.done && <span className="HPAG-reader-beam" />}
      </div>
      <div className="HPAG-reader-trail">
        <div className="HPAG-reader-trail-label">{live?.done ? `Read ${pages.length} page${pages.length === 1 ? '' : 's'}` : 'Reading the atlas'}</div>
        <div className="HPAG-reader-chips">
          {pages.map((url, i) => (
            <a key={url} href={url} target="_blank" rel="noopener noreferrer" className={`HPAG-reader-chip${url === current ? ' HPAG-reader-chip-now' : ''}`} style={{ animationDelay: `${Math.min(i, 8) * 60}ms` }}>
              <span className="HPAG-reader-chip-dot" />
              <span className="HPAG-reader-chip-text">{pagePath(url)}</span>
            </a>
          ))}
          {!live?.done && !pages.length && <span className="HPAG-reader-chip HPAG-reader-chip-now"><span className="HPAG-reader-chip-dot" /><span className="HPAG-reader-chip-text">opening the atlas</span></span>}
        </div>
        {live?.sentBack > 0 && <div className="HPAG-reader-sentback">{live.sentBack} quote{live.sentBack === 1 ? '' : 's'} sent back for an exact copy</div>}
      </div>
    </div>
  );
}

function QuoteCard({ quote, index }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(`"${quote.quote}" — ${quote.title} (${quote.url})`); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };
  const when = quote.fetched_unix_ms ? new Date(quote.fetched_unix_ms).toLocaleString() : null;
  return (
    <div className="HPAG-reader-quote" style={{ animationDelay: `${Math.min(index, 6) * 90}ms` }}>
      <div className="HPAG-reader-quote-text">“{quote.quote}”</div>
      <div className="HPAG-reader-quote-foot">
        <a href={quote.url} target="_blank" rel="noopener noreferrer" className="HPAG-reader-quote-source">
          {quote.title || pagePath(quote.url)} <FontAwesomeIcon icon={faExternalLinkAlt} className="HPAG-reader-quote-ext" />
        </a>
        <span className="HPAG-reader-verified" title={`Verbatim on the page as fetched${when ? ` ${when}` : ''}. Page SHA-256 ${quote.sha256 || ''}`}>
          <FontAwesomeIcon icon={faCheck} /> verified
        </span>
        <button type="button" className="HPAG-reader-copy" onClick={copy} title="Copy quote and source">
          <FontAwesomeIcon icon={faCopy} /> {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  );
}

export default function ReaderPanel({ live, result }) {
  const [showLeftOut, setShowLeftOut] = useState(false);
  const pageTimes = new Map((result?.pages || []).map(p => [p.url, p.fetched_unix_ms]));
  const quotes = (result?.quotes || []).map(q => ({ ...q, fetched_unix_ms: pageTimes.get(q.url) }));
  const liveState = live || (result ? { pages: (result.pages || []).map(p => p.url), current: null, sentBack: 0, done: true, failed: false } : null);
  return (
    <div className="HPAG-reader">
      <Scene live={liveState} />
      {result && (
        <div className="HPAG-reader-answer">
          {quotes.length > 0
            ? quotes.map((q, i) => <QuoteCard key={`${q.url}:${i}`} quote={q} index={i} />)
            : <div className="HPAG-reader-empty">The pages read gave no quote that answers this.</div>}
          {result.not_found && <div className="HPAG-reader-notfound">Not found on the pages read: {result.not_found}</div>}
          {result.dropped?.length > 0 && (
            <div className="HPAG-reader-leftout">
              <button type="button" className="HPAG-reader-leftout-toggle" onClick={() => setShowLeftOut(v => !v)}>
                <FontAwesomeIcon icon={showLeftOut ? faChevronDown : faChevronRight} /> {result.dropped.length} span{result.dropped.length === 1 ? '' : 's'} left out, not on the page as written
              </button>
              {showLeftOut && <ul className="HPAG-reader-leftout-list">{result.dropped.map((d, i) => <li key={i}>“{d}”</li>)}</ul>}
            </div>
          )}
        </div>
      )}
      {liveState?.failed && !result && <div className="HPAG-reader-empty">The reading failed.</div>}
    </div>
  );
}
