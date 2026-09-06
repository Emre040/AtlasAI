'use strict';

const MAX_STEPS = 64;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function validate(value, schema, label) {
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${label} must be one of ${schema.enum.join(', ')}`);
  if (!schema.type) return;
  if (schema.type === 'object') {
    object(value, label);
    for (const name of schema.required || []) if (!Object.hasOwn(value, name)) throw new Error(`${label}.${name} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(item, schema.properties[key], `${label}.${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(item, schema.additionalProperties, `${label}.${key}`);
      else if (schema.properties || schema.additionalProperties === false) throw new Error(`${label}.${key} is not a declared argument`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    value.forEach((item, i) => validate(item, schema.items || {}, `${label}[${i}]`));
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  } else if (typeof value !== schema.type) throw new Error(`${label} must be ${schema.type}`);
}

function references(value, found = new Set()) {
  if (typeof value === 'string' && /^@[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) { found.add(value.slice(1)); return found; }
  if (!value || typeof value !== 'object') return found;
  if (Object.hasOwn(value, '$ref')) throw new Error('Use the string "@step_id" for a batch reference');
  for (const item of Object.values(value)) references(item, found);
  return found;
}

function resolve(value, bindings) {
  if (typeof value === 'string' && /^@[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) {
    const id = value.slice(1);
    if (!bindings.has(id)) throw new Error(`No completed output for ${id}`);
    return bindings.get(id);
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => resolve(item, bindings));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, bindings)]));
}

// This is a data-flow executor over registered operations, not an eval/JavaScript sandbox.
// The complete graph and argument shapes are checked before the first operation runs.
async function executeBatch({ steps, outputs }, { specifications, execute, concurrency }) {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) throw new Error(`run requires 1–${MAX_STEPS} steps`);
  if (!Array.isArray(outputs) || !outputs.length || outputs.some(id => typeof id !== 'string')) throw new Error('outputs must name the step outputs to inspect');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Batch concurrency must be a positive integer');
  const byId = new Map();
  for (const raw of steps) {
    object(raw, 'step');
    if (typeof raw.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw.id) || byId.has(raw.id)) throw new Error(`Invalid or duplicate step id ${JSON.stringify(raw.id)}`);
    const spec = specifications.get(raw.tool);
    if (!spec) throw new Error(`${raw.tool} is not a batch operation; use help for available operations`);
    if (typeof raw.args !== 'string') throw new Error(`${raw.id}.args must be a JSON object encoded as a string`);
    let args;
    try { args = object(JSON.parse(raw.args), `${raw.id}.args`); }
    catch (error) { throw new Error(`${raw.id}: ${error.message}`); }
    byId.set(raw.id, { id: raw.id, tool: raw.tool, args, dependencies: [...references(args)], spec, status: 'pending' });
  }
  const placeholders = new Map([...byId.keys()].map(id => [id, 'artifact_pending']));
  for (const step of byId.values()) {
    for (const dependency of step.dependencies) if (!byId.has(dependency)) throw new Error(`${step.id} references unknown step ${dependency}`);
    validate(resolve(step.args, placeholders), step.spec.parameters, step.tool);
  }
  for (const id of outputs) if (!byId.has(id)) throw new Error(`Unknown requested output ${id}`);
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    byId.get(id).dependencies.forEach(visit);
    visiting.delete(id); visited.add(id);
  };
  byId.forEach(step => visit(step.id));

  const bindings = new Map(), results = new Map();
  while ([...byId.values()].some(step => step.status === 'pending')) {
    for (const step of byId.values()) {
      if (step.status !== 'pending') continue;
      const failed = step.dependencies.filter(id => ['failed', 'blocked'].includes(byId.get(id).status));
      if (failed.length) { step.status = 'blocked'; step.error = `Dependencies failed: ${failed.join(', ')}`; }
    }
    const ready = [...byId.values()].filter(step => step.status === 'pending' && step.dependencies.every(id => byId.get(id).status === 'done')).slice(0, concurrency);
    if (!ready.length) continue;
    await Promise.all(ready.map(async step => {
      try {
        const result = await execute(step.tool, resolve(step.args, bindings));
        if (!result || result.ok !== true || typeof result.artifact?.id !== 'string') throw new Error(result?.error || `${step.tool} returned no artifact`);
        step.status = 'done'; step.artifact = result.artifact.id;
        bindings.set(step.id, result.artifact.id); results.set(step.id, result);
      } catch (error) { step.status = 'failed'; step.error = error.message; }
    }));
  }
  return { status: [...byId.values()].every(step => step.status === 'done') ? 'completed' : 'partial',
    steps: [...byId.values()].map(({ id, tool, status, artifact, error }) => ({ id, tool, status, ...(artifact ? { artifact } : {}), ...(error ? { error } : {}) })),
    outputs: outputs.filter(id => results.has(id)).map(id => ({ id, ...results.get(id) })) };
}

module.exports = { executeBatch, validate, MAX_STEPS };
