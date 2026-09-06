'use strict';

// Analyze saved inference requests without inference, database access, or study mutations.
// node scripts/manual/trace_study_context.js --run /absolute/saved-run --out /absolute/new.json
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { values } = parseArgs({ options: { run: { type: 'string' }, out: { type: 'string' } } });
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

async function main() {
  if (!values.run || !path.isAbsolute(values.run)) throw new Error('--run must name an absolute saved-run directory');
  if (!values.out || !path.isAbsolute(values.out)) throw new Error('--out must name a new absolute JSON file');
  const read = async name => JSON.parse(await fs.readFile(path.join(values.run, name), 'utf8'));
  const result = await read('result.json');
  const events = await read('events.json');
  let eventTurn = 0, lastArtifactTurn = 0;
  for (const event of events) {
    if (event.stage === 'turn') eventTurn = JSON.parse(event.message).turn;
    if (event.stage === 'tool.done' && JSON.parse(event.message).artifact) lastArtifactTurn = eventTurn;
  }
  const turns = [], callsByTool = {}, schemaSizes = {}, roles = {};
  let returnedSignatures = 0, replayedSignatures = 0;
  for (const name of (await fs.readdir(values.run)).filter(f => /^inference-\d+\.json$/.test(f)).sort()) {
    const saved = await read(name);
    const { request, response } = saved;
    if (!request.prompt_cache?.key?.startsWith('study ')) continue;
    const calls = response.choices[0].message.tool_calls || [];
    const roleCounts = {};
    for (const message of request.messages) {
      roles[message.role] = (roles[message.role] || 0) + 1;
      roleCounts[message.role] = (roleCounts[message.role] || 0) + 1;
      replayedSignatures += (message.tool_calls || []).filter(call => call.thought_signature).length;
    }
    returnedSignatures += calls.filter(call => call.thought_signature).length;
    for (const call of calls) callsByTool[call.function.name] = (callsByTool[call.function.name] || 0) + 1;
    const toolBytes = bytes(request.tools);
    schemaSizes[toolBytes] = (schemaSizes[toolBytes] || 0) + 1;
    const turn = turns.length + 1;
    const manifest = await read(`${result.result.workspace_uuid}/context/turn-${String(turn).padStart(2, '0')}.json`);
    turns.push({ turn, request_file: name, roles: roleCounts, tool_schema_bytes: toolBytes,
      system_bytes: request.messages.filter(m => m.role === 'system').reduce((n, m) => n + bytes(m.content), 0),
      context_bytes: manifest.bytes, budget_bytes: manifest.budget_bytes, section_bytes: manifest.sections,
      message_count: request.messages.length, compactions: manifest.compactions || 0,
      included_observations: manifest.included, omitted_observations: manifest.omitted.length,
      calls: calls.map(call => call.function.name), usage: response.usage });
  }
  const tail = turns.filter(turn => turn.turn > lastArtifactTurn);
  const sum = (items, key) => items.reduce((n, turn) => n + turn.usage[key], 0);
  const observations = [];
  const observationDir = path.join(values.run, result.result.workspace_uuid, 'observations');
  for (const name of await fs.readdir(observationDir)) observations.push(JSON.parse(await fs.readFile(path.join(observationDir, name), 'utf8')));
  const searchResults = observations.filter(o => o.source === 'recall search');
  const recursiveSearches = searchResults.map(o => ({ id: o.id, bytes: bytes(o.text),
    previous_search_hits: [...new Set([...o.text.matchAll(/(o\d+) turn \d+ recall search/g)].map(m => m[1]))] }));
  const analysis = {
    source_run: values.run, model: result.model, source_sha256: result.source_sha256,
    accounting: result.accounting, note: 'Byte counts are gateway request fields before provider conversion; provider tokens are the recorded usage. Cached input is a subset of input.',
    request_roles_total: roles, returned_tool_signatures: returnedSignatures, replayed_tool_signatures: replayedSignatures,
    schema_byte_sizes_and_turn_counts: schemaSizes, calls_by_tool: callsByTool,
    last_artifact_turn: lastArtifactTurn,
    after_last_artifact: { turns: tail.length, input_tokens: sum(tail, 'prompt_tokens'), output_tokens: sum(tail, 'completion_tokens'),
      total_tokens: sum(tail, 'prompt_tokens') + sum(tail, 'completion_tokens') },
    retrieval_result_records: recursiveSearches, turns
  };
  await fs.writeFile(values.out, JSON.stringify(analysis, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ turns: turns.length, last_artifact_turn: lastArtifactTurn, after_last_artifact: analysis.after_last_artifact,
    request_roles_total: roles, recursive_search_records: recursiveSearches.filter(s => s.previous_search_hits.length).length, out: values.out }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
