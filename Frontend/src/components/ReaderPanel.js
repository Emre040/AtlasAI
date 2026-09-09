import React, { useState, useRef } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faCopy, faExternalLinkAlt, faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons';

// The reader's panel inside an assistant message. While it reads, an abstract scene: drifting
// shapes and a sweeping beam over the trail of pages it has opened, the current one lit. When it
// is done, the answer as prose whose every sentence carries a numbered citation chip, and under
// it the sources: the exact quotes those chips point at, each verified verbatim against the page
// it came from. What the pages did not say and what was left out (sentences whose citations did
// not check out) follow, plainly labelled.

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
        {live?.sentBack > 0 && (
          <div className="HPAG-reader-sentback" title={live.sentBackLast || ''}>
            {live.sentBack} round{live.sentBack === 1 ? '' : 's'} of citations sent back for an exact copy
            {live.sentBackLast && <div className="HPAG-reader-sentback-why">{live.sentBackLast}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// The answer as prose; each [n] marker is a chip that points at source n below. Paragraphs are
// blank-line separated, lines inside a paragraph (a list the reader wrote) keep their breaks.
function Prose({ text, active, onCite, onHover }) {
  const paragraphs = String(text || '').split(/\n\s*\n/).filter(p => p.trim());
  const withChips = line => line.split(/(\[\d+\])/g).map((part, i) => {
    const m = /^\[(\d+)\]$/.exec(part);
    if (!m) return <React.Fragment key={i}>{part}</React.Fragment>;
    const n = Number(m[1]);
    return (
      <button key={i} type="button" className={`HPAG-reader-cite${active === n ? ' HPAG-reader-cite-active' : ''}`}
        onClick={() => onCite(n)} onMouseEnter={() => onHover(n)} onMouseLeave={() => onHover(null)} title={`Source ${n}`}>
        {n}
      </button>
    );
  });
  return (
    <div className="HPAG-reader-text">
      {paragraphs.map((p, pi) => (
        <p key={pi}>
          {p.split('\n').filter(l => l.trim()).map((line, li) => <span key={li} className="HPAG-reader-line">{withChips(line)}</span>)}
        </p>
      ))}
    </div>
  );
}

function QuoteCard({ citation, index, active, cardRef }) {
  const [copied, setCopied] = useState(false);
  // one exact span, or several short ones when the sentence sums up a list or a table
  const spans = Array.isArray(citation.quotes) && citation.quotes.length > 1 ? citation.quotes : [citation.quote];
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${spans.map(s => `"${s}"`).join(' ')} — ${citation.title} (${citation.url})`); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };
  const when = citation.fetched_unix_ms ? new Date(citation.fetched_unix_ms).toLocaleString() : null;
  return (
    <div ref={cardRef} className={`HPAG-reader-quote${active ? ' HPAG-reader-quote-active' : ''}`} style={{ animationDelay: `${Math.min(index, 6) * 90}ms` }}>
      <div className="HPAG-reader-quote-text">
        <span className="HPAG-reader-quote-n">{citation.n}</span>
        <span className="HPAG-reader-quote-spans">{spans.map((s, i) => <span key={i} className="HPAG-reader-quote-span">“{s}”</span>)}</span>
      </div>
      <div className="HPAG-reader-quote-foot">
        <a href={citation.url} target="_blank" rel="noopener noreferrer" className="HPAG-reader-quote-source">
          {citation.title || pagePath(citation.url)} <FontAwesomeIcon icon={faExternalLinkAlt} className="HPAG-reader-quote-ext" />
        </a>
        <span className="HPAG-reader-verified" title={`Verbatim on the page as fetched${when ? ` ${when}` : ''}. Page SHA-256 ${citation.sha256 || ''}`}>
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
  const [active, setActive] = useState(null);
  const cards = useRef({});
  const pageTimes = new Map((result?.pages || []).map(p => [p.url, p.fetched_unix_ms]));
  const citations = (result?.citations || []).map(c => ({ ...c, fetched_unix_ms: pageTimes.get(c.url) }));
  const leftOut = result?.dropped_sentences || [];
  const liveState = live || (result ? { pages: (result.pages || []).map(p => p.url), current: null, sentBack: 0, done: true, failed: false } : null);
  const cite = n => {
    setActive(n);
    cards.current[n]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => setActive(a => (a === n ? null : a)), 2200);
  };
  return (
    <div className="HPAG-reader">
      <Scene live={liveState} />
      {result && (
        <div className="HPAG-reader-answer">
          {result.text
            ? <Prose text={result.text} active={active} onCite={cite} onHover={setActive} />
            : <div className="HPAG-reader-empty">The pages read gave nothing that could be said with a quote behind it.</div>}
          {result.not_found && <div className="HPAG-reader-notfound">Not found on the pages read: {result.not_found}</div>}
          {citations.length > 0 && (
            <div className="HPAG-reader-sources">
              <div className="HPAG-reader-sources-label">Sources, verbatim from the atlas</div>
              {citations.map((c, i) => <QuoteCard key={c.n} citation={c} index={i} active={active === c.n} cardRef={el => { cards.current[c.n] = el; }} />)}
            </div>
          )}
          {leftOut.length > 0 && (
            <div className="HPAG-reader-leftout">
              <button type="button" className="HPAG-reader-leftout-toggle" onClick={() => setShowLeftOut(v => !v)}>
                <FontAwesomeIcon icon={showLeftOut ? faChevronDown : faChevronRight} /> {leftOut.length} sentence{leftOut.length === 1 ? '' : 's'} left out, no citation that checked out
              </button>
              {showLeftOut && <ul className="HPAG-reader-leftout-list">{leftOut.map((d, i) => <li key={i}>{d}</li>)}</ul>}
            </div>
          )}
        </div>
      )}
      {liveState?.failed && !result && <div className="HPAG-reader-empty">The reading failed.</div>}
    </div>
  );
}
