import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPencilAlt, faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { composeAnswers, SKIPPED } from '../api/questionnaire';

// The clarification card inside an assistant message: one question at a time with "n / total" and
// chevrons to move back and forth, its three options as numbered rows, and a free-text row with a
// skip. A choice moves on; Send appears on the last question once every question has an answer.
// The answers go back as the next user message ("The user just answered a questionnaire: ...")
// through the chat's send path.
export default function Questionnaire({ questionnaire, answered, disabled, onSubmit }) {
  const [picks, setPicks] = useState({});
  const [drafts, setDrafts] = useState({});
  const [index, setIndex] = useState(0);
  const questions = Array.isArray(questionnaire?.questions) ? questionnaire.questions : [];
  if (!questions.length) return null;

  if (answered) {
    const given = typeof answered === 'object' ? answered : null;
    return (
      <div className="HPAG-clarify HPAG-clarify-answered">
        {questions.map(q => (
          <div className="HPAG-clarify-recap" key={q.id}>
            <span className="HPAG-clarify-recap-q">{q.question}</span>
            <span className="HPAG-clarify-recap-a">{given ? (given[q.id] || SKIPPED) : 'answered'}</span>
          </div>
        ))}
      </div>
    );
  }

  const last = questions.length - 1;
  const current = questions[Math.min(index, last)];
  const pick = picks[current.id];
  const custom = pick !== undefined && pick !== SKIPPED && !current.options.includes(pick);
  const draft = drafts[current.id] ?? (custom ? pick : '');
  const complete = questions.every(q => picks[q.id] !== undefined);

  const choose = (value) => {
    if (disabled) return;
    setPicks(p => ({ ...p, [current.id]: value }));
    if (index < last) setIndex(index + 1);
  };
  const send = () => { if (!disabled && complete) onSubmit(composeAnswers(questionnaire, picks), picks); };

  return (
    <div className="HPAG-clarify">
      <div className="HPAG-clarify-head">
        <div className="HPAG-clarify-question">{current.question}</div>
        <div className="HPAG-clarify-nav">
          <button type="button" className="HPAG-clarify-chevron" onClick={() => setIndex(index - 1)} disabled={index === 0} aria-label="previous question">
            <FontAwesomeIcon icon={faChevronLeft} />
          </button>
          <span className="HPAG-clarify-step">{index + 1} / {questions.length}</span>
          <button type="button" className="HPAG-clarify-chevron" onClick={() => setIndex(index + 1)} disabled={index === last} aria-label="next question">
            <FontAwesomeIcon icon={faChevronRight} />
          </button>
        </div>
      </div>
      {current.options.map((option, i) => (
        <button
          type="button"
          key={option}
          className={`HPAG-clarify-row${pick === option ? ' HPAG-clarify-row-selected' : ''}`}
          onClick={() => choose(option)}
          disabled={disabled}
        >
          <span className="HPAG-clarify-num">{i + 1}</span>
          <span className="HPAG-clarify-text">{option}</span>
        </button>
      ))}
      <div className={`HPAG-clarify-row HPAG-clarify-other${custom ? ' HPAG-clarify-row-selected' : ''}`}>
        <span className="HPAG-clarify-num"><FontAwesomeIcon icon={faPencilAlt} /></span>
        <input
          type="text"
          className="HPAG-clarify-input"
          placeholder={pick === SKIPPED ? 'Skipped' : 'Something else'}
          value={draft}
          onChange={e => setDrafts(d => ({ ...d, [current.id]: e.target.value }))}
          onKeyDown={e => { if (e.key === 'Enter' && draft.trim()) choose(draft.trim()); }}
          disabled={disabled}
        />
        {draft.trim() && draft.trim() !== pick
          ? <button type="button" className="HPAG-clarify-skip" onClick={() => choose(draft.trim())} disabled={disabled}>{index < last ? 'Next' : 'Use this'}</button>
          : index < last
            ? <button type="button" className="HPAG-clarify-skip" onClick={() => choose(SKIPPED)} disabled={disabled}>Skip</button>
            : <button type="button" className="HPAG-clarify-skip" onClick={() => { if (pick === undefined) setPicks(p => ({ ...p, [current.id]: SKIPPED })); }} disabled={disabled || pick !== undefined}>Skip</button>}
      </div>
      {index === last && (
        <div className="HPAG-clarify-actions">
          <button type="button" className="HPAG-clarify-send" onClick={send} disabled={disabled || !complete}>Send answers</button>
        </div>
      )}
    </div>
  );
}
