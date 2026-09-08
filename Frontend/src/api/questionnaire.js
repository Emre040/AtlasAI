// The wire format of a clarification questionnaire's answers: the text sent back as the next user
// message, and the answers read back out of such a message (for reloads). No React here.
export const ANSWERED_PREFIX = 'The user just answered a questionnaire';
export const SKIPPED = '(no preference)';

export function composeAnswers(questionnaire, picks) {
  const lines = [`${ANSWERED_PREFIX}:`];
  questionnaire.questions.forEach((q, i) => {
    lines.push(`Q${i + 1}: ${q.question}`);
    lines.push(`A: ${picks[q.id] || SKIPPED}`);
  });
  return lines.join('\n');
}

export function parseAnswers(questionnaire, text) {
  if (!questionnaire || typeof text !== 'string' || !text.startsWith(ANSWERED_PREFIX)) return null;
  const answers = text.split('\n').filter(line => line.startsWith('A: ')).map(line => line.slice(3).trim());
  const picks = {};
  questionnaire.questions.forEach((q, i) => { if (answers[i] !== undefined) picks[q.id] = answers[i]; });
  return picks;
}
