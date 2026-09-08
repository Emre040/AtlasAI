import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPencilAlt } from '@fortawesome/free-solid-svg-icons';

// The clarification card under an assistant message: one question at a time, its three options as
// numbered rows, a free-text row with a skip, and dots for the questions still to come. Choosing an
// option moves to the next question; the last choice sends. The answers go back as the next user
// message ("The user just answered a questionnaire: ...") through the chat's send path.
export const ANSWERED_PREFIX = 'The user just answered a questionnaire';
const SKIPPED = '(no preference)';

export function composeAnswers(questionnaire, picks) {
  const lines = [`${ANSWERED_PREFIX}:`];
  questionnaire.questions.forEach((q, i) => {
    lines.push(`Q${i + 1}: ${q.question}`);
    lines.push(`A: ${picks[q.id] || SKIPPED}`);
  });
  return lines.join('\n');
}

export default function Questionnaire({ questionnaire, answered, disabled, onSubmit }) {
  const [picks, setPicks] = useState({});
  const [index, setIndex] = useState(0);
  const [other, setOther] = useState('');
  const questions = Array.isArray(questionnaire?.questions) ? questionnaire.questions : [];
  if (!questions.length) return null;

  if (answered) {
    const given = typeof answered === 'object' ? answered : null;
    return (
      <div className="HPAG-clarify HPAG-clarify-answered">
        {questions.map((q, i) => (
          <div className="HPAG-clarify-recap" key={q.id}>
            <span className="HPAG-clarify-recap-q">{q.question}</span>
            <span className="HPAG-clarify-recap-a">{given ? (given[q.id] || SKIPPED) : 'answered'}</span>
          </div>
        ))}
      </div>
    );
  }

  const current = questions[Math.min(index, questions.length - 1)];
  const answer = (value) => {
    if (disabled) return;
    const next = { ...picks, [current.id]: value };
    setPicks(next);
    setOther('');
    if (index + 1 < questions.length) setIndex(index + 1);
    else onSubmit(composeAnswers(questionnaire, next), next);
  };

  return (
    <div className="HPAG-clarify">
      <div className="HPAG-clarify-head">
        <div className="HPAG-clarify-question">{current.question}</div>
        <div className="HPAG-clarify-dots" aria-label={`question ${index + 1} of ${questions.length}`}>
          {questions.map((q, i) => <span key={q.id} className={`HPAG-clarify-dot${i < index ? ' HPAG-clarify-dot-done' : ''}${i === index ? ' HPAG-clarify-dot-now' : ''}`} />)}
        </div>
      </div>
      {current.options.map((option, i) => (
        <button type="button" key={option} className="HPAG-clarify-row" onClick={() => answer(option)} disabled={disabled}>
          <span className="HPAG-clarify-num">{i + 1}</span>
          <span className="HPAG-clarify-text">{option}</span>
        </button>
      ))}
      <div className="HPAG-clarify-row HPAG-clarify-other">
        <span className="HPAG-clarify-num"><FontAwesomeIcon icon={faPencilAlt} /></span>
        <input
          type="text"
          className="HPAG-clarify-input"
          placeholder="Something else"
          value={other}
          onChange={e => setOther(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && other.trim()) answer(other.trim()); }}
          disabled={disabled}
        />
        {other.trim()
          ? <button type="button" className="HPAG-clarify-skip" onClick={() => answer(other.trim())} disabled={disabled}>{index + 1 < questions.length ? 'Next' : 'Send'}</button>
          : <button type="button" className="HPAG-clarify-skip" onClick={() => answer(SKIPPED)} disabled={disabled}>Skip</button>}
      </div>
    </div>
  );
}
