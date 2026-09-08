import React, { useState } from 'react';

// The clarification cards under an assistant message: each question with its three options and a
// fourth free-text option. Submitting composes the text the router expects as the next user
// message ("The user just answered a questionnaire: ...") and hands it to the chat's send path.
export const ANSWERED_PREFIX = 'The user just answered a questionnaire';

export function composeAnswers(questionnaire, picks) {
  const lines = [`${ANSWERED_PREFIX}:`];
  questionnaire.questions.forEach((q, i) => {
    const pick = picks[q.id] || {};
    const answer = pick.option === 'other' ? (pick.text || '').trim() : (pick.option || '');
    lines.push(`Q${i + 1}: ${q.question}`);
    lines.push(`A: ${answer}`);
  });
  return lines.join('\n');
}

export default function Questionnaire({ questionnaire, answered, disabled, onSubmit }) {
  const [picks, setPicks] = useState({});
  const questions = Array.isArray(questionnaire?.questions) ? questionnaire.questions : [];
  if (!questions.length) return null;

  const complete = questions.every(q => {
    const pick = picks[q.id];
    return pick && (pick.option === 'other' ? (pick.text || '').trim().length > 0 : Boolean(pick.option));
  });
  const locked = Boolean(answered) || Boolean(disabled);
  const choose = (qid, option) => { if (!locked) setPicks(p => ({ ...p, [qid]: { ...(p[qid] || {}), option } })); };
  const type = (qid, text) => { if (!locked) setPicks(p => ({ ...p, [qid]: { option: 'other', text } })); };

  return (
    <div className={`HPAG-questionnaire${answered ? ' HPAG-questionnaire-answered' : ''}`}>
      {questionnaire.reason && <div className="HPAG-questionnaire-reason">{questionnaire.reason}</div>}
      {questions.map((q, i) => {
        const pick = answered?.[q.id] || picks[q.id] || {};
        return (
          <div className="HPAG-questionnaire-question" key={q.id}>
            <div className="HPAG-questionnaire-label">{`Q${i + 1}`}</div>
            <div className="HPAG-questionnaire-text">{q.question}</div>
            <div className="HPAG-questionnaire-options">
              {q.options.map(option => (
                <button
                  type="button"
                  key={option}
                  className={`HPAG-questionnaire-option${pick.option === option ? ' HPAG-questionnaire-option-selected' : ''}`}
                  onClick={() => choose(q.id, option)}
                  disabled={locked}
                >
                  {option}
                </button>
              ))}
              <div className={`HPAG-questionnaire-option HPAG-questionnaire-other${pick.option === 'other' ? ' HPAG-questionnaire-option-selected' : ''}`}>
                <input
                  type="text"
                  placeholder="Something else…"
                  value={pick.option === 'other' ? (pick.text || '') : ''}
                  onFocus={() => choose(q.id, 'other')}
                  onChange={e => type(q.id, e.target.value)}
                  disabled={locked}
                />
              </div>
            </div>
          </div>
        );
      })}
      <div className="HPAG-questionnaire-actions">
        {answered
          ? <span className="HPAG-questionnaire-done">Answered</span>
          : <button type="button" className="HPAG-questionnaire-submit" disabled={!complete || locked} onClick={() => onSubmit(composeAnswers(questionnaire, picks), picks)}>Send answers</button>}
      </div>
    </div>
  );
}
