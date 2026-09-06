'use strict';

// A compact, lossless type signature generated from the registered argument schema.
// No second hand-maintained operation API. A question mark means an optional property.
function shape(schema) {
  if (schema.enum) return schema.enum.map(v => JSON.stringify(v)).join(' | ');
  if (schema.type === 'array') return `Array<${shape(schema.items || {})}>`;
  if (schema.type === 'object') {
    const fields = Object.entries(schema.properties || {}).map(([name, spec]) => `${name}${schema.required?.includes(name) ? '' : '?'}: ${shape(spec)}`);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') fields.push(`[key: string]: ${shape(schema.additionalProperties)}`);
    return `{${fields.join(', ')}}`;
  }
  return schema.type || 'any';
}

function signature(spec) { return `${spec.name}(${shape(spec.parameters)})`; }
function describeOperation(spec) {
  const fields = Object.entries(spec.parameters.properties || {}).filter(([, value]) => value.description && true);
  return `${signature(spec)}\n${spec.description || ''}${fields.length ? '\n' + fields.map(([key, value]) => `${key}: ${value.description}`).join('\n') : ''}`;
}

module.exports = { signature, describeOperation };
