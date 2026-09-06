'use strict';

const { decodeArguments, mapArtifactReferences } = require('./toolArguments');

const ARGUMENTS_SCHEMA = { type: 'object', additionalProperties: {}, description: 'Arguments of the registered operation. Artifact-handle fields may reference another step using @step_id.' };

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function validate(value, schema, label) {
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${label} must be one of ${schema.enum.join(', ')}`);
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some(option => { try { validate(value, option, label); return true; } catch { return false; } })) throw new Error(`${label} must match one of the declared value types`);
    return;
  }
  if (schema.type === 'null') {
    if (value !== null) throw new Error(`${label} must be null`);
    return;
  }
  if (!schema.type) return;
  if (schema.type === 'object') {
    object(value, label);
    for (const name of schema.required || []) if (!Object.hasOwn(value, name)) throw new Error(`${label}.${name} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) validate(item, schema.properties[key], `${label}.${key}`);
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

function references(value, schema) {
  const found = new Set();
  mapArtifactReferences(value, schema, (id, original) => { found.add(id); return original; });
  return found;
}

function resolve(value, bindings, schema, external = () => null) {
  return mapArtifactReferences(value, schema, id => {
    if (bindings.has(id)) return bindings.get(id);
    const known = external(id);
    if (known) return known;
    throw new Error(`No completed output for ${id}`);
  });
}

// This is a data-flow executor over registered operations, not an eval/JavaScript sandbox.
// The complete graph and argument shapes are checked before the first operation runs. An @id
// that is not a step may name an existing artifact (external), which is then used as is.
async function executeBatch({ steps, outputs }, { specifications, execute, concurrency, external = () => null }) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('run requires a nonempty array of registered operations');
  if (!Array.isArray(outputs) || !outputs.length || outputs.some(id => typeof id !== 'string')) throw new Error('outputs must name the step outputs to inspect');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Batch concurrency must be a positive integer');
  const byId = new Map();
  for (const raw of steps) {
    object(raw, 'step');
    if (typeof raw.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(raw.id) || byId.has(raw.id)) throw new Error(`Invalid or duplicate step id ${JSON.stringify(raw.id)}`);
    const spec = specifications.get(raw.tool);
    if (!spec) throw new Error(`${raw.tool} is not a batch operation; choose a registered data operation from the capability directory and load its schema with load_tools`);
    let args;
    try { args = decodeArguments(object(decodeArguments(raw.args, ARGUMENTS_SCHEMA, `${raw.id}.args`), `${raw.id}.args`), spec.parameters, raw.tool); }
    catch (error) { throw new Error(`${raw.id}: ${error.message}`); }
    byId.set(raw.id, { id: raw.id, tool: raw.tool, args, dependencies: [...references(args, spec.parameters)], spec, status: 'pending' });
  }
  // A step named bare (without @) in an artifact argument means that step's output, unless an
  // artifact of that name exists.
  for (const step of byId.values()) {
    step.args = mapArtifactReferences(step.args, step.spec.parameters, (id, original) => original);
    const bare = (value, schema) => {
      if (!schema || typeof schema !== 'object') return value;
      if (schema['x-artifact-reference'] === true && typeof value === 'string' && byId.has(value) && value !== step.id && !external(value)) return `@${value}`;
      if (schema.type === 'array' && Array.isArray(value)) return value.map(item => bare(item, schema.items));
      if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bare(item, schema.properties?.[key] ?? (schema.additionalProperties && typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined))]));
      return value;
    };
    step.args = bare(step.args, step.spec.parameters);
    step.dependencies = [...references(step.args, step.spec.parameters)].filter(id => byId.has(id) || !external(id));
  }
  const placeholders = new Map([...byId.keys()].map(id => [id, 'artifact_pending']));
  for (const step of byId.values()) {
    for (const dependency of step.dependencies) if (!byId.has(dependency)) throw new Error(`${step.id} references unknown step ${dependency} (a step id in this run, or @<artifact id>)`);
    validate(resolve(step.args, placeholders, step.spec.parameters, external), step.spec.parameters, step.tool);
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
        const result = await execute(step.tool, resolve(step.args, bindings, step.spec.parameters, external));
        if (typeof result?.artifact?.id === 'string') {
          step.artifact = result.artifact.id;
          results.set(step.id, result);
        }
        if (!result || result.ok !== true || typeof result.artifact?.id !== 'string') throw new Error(result?.error || `${step.tool} returned no artifact`);
        step.status = 'done';
        bindings.set(step.id, result.artifact.id);
      } catch (error) { step.status = 'failed'; step.error = error.message; }
    }));
  }
  return { status: [...byId.values()].every(step => step.status === 'done') ? 'completed' : 'partial',
    steps: [...byId.values()].map(({ id, tool, status, artifact, error }) => ({ id, tool, status, ...(artifact ? { artifact } : {}), ...(error ? { error } : {}) })),
    outputs: outputs.filter(id => results.has(id)).map(id => ({ id, ...results.get(id) })) };
}

module.exports = { executeBatch, validate, ARGUMENTS_SCHEMA };
