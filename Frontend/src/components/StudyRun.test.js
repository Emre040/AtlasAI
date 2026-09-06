import { studyStateFromEvents, studyStatusLine } from './StudyRun';

jest.mock('react-markdown', () => () => null);
jest.mock('remark-gfm', () => () => null);

const finish = data => ({ stage: 'finish', message: JSON.stringify(data) });

test('a completed request does not overwrite an incomplete study outcome', () => {
  const events = [finish({ outcome: 'incomplete', incomplete_reason: 'turn_budget_exhausted' }), { status: 'completed' }];
  expect(studyStateFromEvents(events).phase).toBe('incomplete');
  expect(studyStatusLine(events)).toBe('Study incomplete');
});

test('saved budget-exhausted runs are also shown as incomplete', () => {
  expect(studyStateFromEvents([finish({ budget_exhausted: true })]).phase).toBe('incomplete');
  expect(studyStateFromEvents([finish({ unverified_numbers: ['17.3'] })]).phase).toBe('incomplete');
  expect(studyStatusLine([finish({ outcome: 'completed' })])).toBe('Study complete');
});

test('a request failure takes precedence over an incomplete finish', () => {
  expect(studyStatusLine([finish({ outcome: 'incomplete' }), { status: 'completed', failed: true, message: 'Storage failed' }])).toBe('Study failed');
});
