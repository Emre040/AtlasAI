'use strict';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const childSchema = (schema, key) => schema?.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : isObject(schema?.additionalProperties) ? schema.additionalProperties : undefined;

// Gemini transports free-form logical objects as JSON text. Decode only fields whose
// registered schema declares that object shape; strings and untyped data stay literal.
function decodeArguments(value, schema, label) {
  if (!schema || typeof schema !== 'object') return value;
  if (schema.type === 'object') {
    const freeObject = !schema.properties || Object.keys(schema.properties).length === 0;
    if (freeObject && typeof value === 'string') {
      try { value = JSON.parse(value); }
      catch (error) { throw new Error(`${label} must be a JSON object or its JSON text encoding: ${error.message}`); }
      if (!isObject(value)) throw new Error(`${label} JSON text must encode an object`);
    }
    if (!isObject(value)) return value; // The registered validator reports wrong types.
    // An optional argument given as an empty string, null or an empty list is not given: some
    // models write every declared field and leave the ones they do not use empty.
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const empty = item => item === '' || item === null || (Array.isArray(item) && item.length === 0);
    return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => required.has(key) || !schema.properties || !Object.hasOwn(schema.properties, key) || !empty(item))
      .map(([key, item]) => [key, decodeArguments(item, childSchema(schema, key), `${label}.${key}`)]));
  }
  if (schema.type === 'array' && Array.isArray(value)) return value.map((item, index) => decodeArguments(item, schema.items, `${label}[${index}]`));
  return value;
}

// References are control values only in explicit artifact-handle schema fields. Arbitrary
// labels, rename targets, constants and filter values may legitimately begin with @.
function mapArtifactReferences(value, schema, visit) {
  if (!schema || typeof schema !== 'object') return value;
  if (schema['x-artifact-reference'] === true && typeof value === 'string' && /^@[A-Za-z][A-Za-z0-9_]*$/.test(value)) return visit(value.slice(1), value);
  if (schema.type === 'array' && Array.isArray(value)) return value.map(item => mapArtifactReferences(item, schema.items, visit));
  if (schema.type === 'object' && isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapArtifactReferences(item, childSchema(schema, key), visit)]));
  return value;
}

module.exports = { decodeArguments, mapArtifactReferences };
