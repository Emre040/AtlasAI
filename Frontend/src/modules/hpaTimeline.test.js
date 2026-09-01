import fixture from './__fixtures__/timeline.deep-research.json';
import { liveToolEventFromSse, timelineToUiMessages, toolEventFromRunEvent } from './hpaTimeline';

test('a real deep-research timeline maps to user, preamble, tool lines, and the answer with its search URL', () => {
  const messages = timelineToUiMessages(fixture);
  const types = messages.map(m => m.type);
  expect(types[0]).toBe('user');
  expect(types[1]).toBe('ai');
  expect(messages[1].text).toMatch(/search/i);

  const toolLines = messages.filter(m => m.type === 'tool');
  const run = fixture.find(item => item.type === 'run');
  expect(toolLines).toHaveLength(run.events.length);
  expect(new Set(toolLines.map(m => m.toolEvent.runId))).toEqual(new Set([run.id]));
  expect(toolLines[0].toolEvent.status).toBe('started');
  expect(toolLines[0].toolEvent.label).toBe('Deep Research initiated');
  expect(toolLines[toolLines.length - 1].toolEvent.status).toBe('completed');
  expect(toolLines[toolLines.length - 1].toolEvent.message).toBe(`Finished in ${run.step_count} steps.`);
  expect(toolLines[1].toolEvent.kind).toBe('progress');
  expect(toolLines[1].toolEvent.stage).toBe(run.events[1].stage);

  const answer = messages.find(m => m.type === 'ai' && m.searchUrl);
  expect(answer.searchUrl).toMatch(/^https:\/\/www\.proteinatlas\.org\/search\//);
  expect(answer.runId).toBe(run.id);
  expect(answer.inference.total_tokens).toBeGreaterThan(0);
  expect(answer.inference.first_token_latency_ms).toBeGreaterThan(0);
  expect(answer.inference.output_tokens_per_second).toBeGreaterThan(0);
  expect(messages[messages.length - 1].type).toBe('ai');
  expect(messages[messages.length - 1].runId).toBeNull();
});

test('ASO events expose their structured payload as JSON text plus a detail object', () => {
  const run = { id: 'run-1', tool: 'aso_hpa', step_count: 3 };
  const event = { seq: 2, kind: 'progress', stage: 'tool.invoke', label: 'tool.invoke', message: '{"name":"chart","args":{"chart_type":"heatmap"}}', url: null, visual: null, detail: { name: 'chart', args: { chart_type: 'heatmap' } }, created_at: 1 };
  const toolEvent = toolEventFromRunEvent(run, event);
  expect(JSON.parse(toolEvent.message)).toEqual({ name: 'chart', args: { chart_type: 'heatmap' } });
  expect(toolEvent.detail.args.chart_type).toBe('heatmap');
  expect(toolEvent.runId).toBe('run-1');

  const failed = toolEventFromRunEvent(run, { seq: 3, kind: 'failed', stage: 'complete', label: 'Failed', message: 'boom', url: null, visual: null, detail: null, created_at: 2 });
  expect(failed.status).toBe('completed');
  expect(failed.failed).toBe(true);
  expect(failed.message).toBe('boom');
});

test('live stream payloads use the backend run id so live and reloaded runs match', () => {
  const started = liveToolEventFromSse({ name: 'investigator_hpa', status: 'started', run_id: 'run-9' });
  expect(started).toMatchObject({ runId: 'run-9', status: 'started', label: 'Investigating gene', message: 'Resolving gene in HPA…' });

  const progress = liveToolEventFromSse({ name: 'deep_research_hpa', status: 'progress', run_id: 'run-9', step: { stage: 'execution_step', message: 'Running', url: 'https://www.proteinatlas.org/search/x' } });
  expect(progress).toMatchObject({ runId: 'run-9', kind: 'progress', label: 'Executing search', message: 'Running' });
  expect(progress.meta.url).toBe('https://www.proteinatlas.org/search/x');

  const completed = liveToolEventFromSse({ name: 'deep_research_hpa', status: 'completed', run_id: 'run-9', result_meta: { steps: 26 } });
  expect(completed).toMatchObject({ runId: 'run-9', status: 'completed', label: 'Deep Research complete', message: 'Finished in 26 steps.' });
});
