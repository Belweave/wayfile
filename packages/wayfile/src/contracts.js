// A deliberately small, explicit JSON Schema subset. Unsupported assertions fail closed.
import { isDeepStrictEqual } from 'node:util';

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems',
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples']);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// Reject values that JSON would coerce or silently drop, keeping state and memo keys lossless.
export function validateJSONValue(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return [];
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [`${path}: number must be finite`];
  if (!Array.isArray(value) && !object(value)) return [`${path}: value must be JSON-compatible`];
  if (ancestors.has(value)) return [`${path}: cyclic values are not JSON-compatible`];
  if (!Array.isArray(value) && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return [`${path}: value must be a plain JSON object`];
  const errors = [];
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) errors.push(`${path}: extra array properties are not JSON-compatible`);
    }
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) errors.push(`${path}[${i}]: sparse or accessor elements are not JSON-compatible`);
      else errors.push(...validateJSONValue(descriptor.value, `${path}[${i}]`, ancestors));
    }
  } else for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') errors.push(`${path}: symbol keys are not JSON-compatible`);
    else {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) errors.push(`${path}.${key}: non-enumerable or accessor properties are not JSON-compatible`);
      else errors.push(...validateJSONValue(descriptor.value, `${path}.${key}`, ancestors));
    }
  }
  ancestors.delete(value);
  return errors;
}

export function validateSchema(schema, path = '$') {
  if (typeof schema === 'boolean') return [];
  if (!object(schema)) return [`${path}: schema must be an object or boolean`];
  const errors = [];
  const add = (message) => errors.push(`${path}: ${message}`);
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) add(`unsupported schema keyword ${key}`);
  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => !TYPES.has(type)) || new Set(types).size !== types.length) add('type must be a supported type or unique nonempty array of supported types');
  }
  if ('properties' in schema) {
    if (!object(schema.properties)) add('properties must be an object');
    else for (const [key, value] of Object.entries(schema.properties)) errors.push(...validateSchema(value, `${path}.properties.${key}`));
  }
  if ('required' in schema && (!Array.isArray(schema.required) || schema.required.some((x) => typeof x !== 'string') || new Set(schema.required).size !== schema.required.length)) add('required must be an array of unique strings');
  if ('additionalProperties' in schema) errors.push(...validateSchema(schema.additionalProperties, `${path}.additionalProperties`));
  if ('items' in schema) errors.push(...validateSchema(schema.items, `${path}.items`));
  if ('enum' in schema && (!Array.isArray(schema.enum) || !schema.enum.length)) add('enum must be a nonempty array');
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (key in schema && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) add(`${key} must be a nonnegative integer`);
  }
  for (const key of ['minimum', 'maximum']) if (key in schema && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) add(`${key} must be a finite number`);
  if ('pattern' in schema) {
    if (typeof schema.pattern !== 'string') add('pattern must be a string');
    else { try { new RegExp(schema.pattern, 'u'); } catch { add('pattern must be a valid regular expression'); } }
  }
  return errors;
}

function matchesType(value, type) {
  if (type === 'object') return object(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function inspect(value, schema, path) {
  if (schema === true) return [];
  if (schema === false) return [`${path}: value is forbidden`];
  const errors = [];
  const add = (message) => errors.push(`${path}: ${message}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) return [`${path}: expected ${types.join(' or ')}`];
  }
  if (schema.enum && !schema.enum.some((x) => isDeepStrictEqual(x, value))) add('value is outside enum');
  if ('const' in schema && !isDeepStrictEqual(schema.const, value)) add('value differs from const');
  if (object(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) add(`missing required property ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) errors.push(...inspect(child, schema.properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) add(`unexpected property ${key}`);
      else if (object(schema.additionalProperties)) errors.push(...inspect(child, schema.additionalProperties, `${path}.${key}`));
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) add(`needs at least ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) add(`needs at most ${schema.maxItems} items`);
    if ('items' in schema) value.forEach((child, index) => errors.push(...inspect(child, schema.items, `${path}[${index}]`)));
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength != null && length < schema.minLength) add(`needs at least ${schema.minLength} characters`);
    if (schema.maxLength != null && length > schema.maxLength) add(`needs at most ${schema.maxLength} characters`);
    if (schema.pattern != null && !new RegExp(schema.pattern, 'u').test(value)) add('does not match pattern');
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) add(`must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) add(`must be <= ${schema.maximum}`);
  }
  return errors;
}

export function validateValue(value, schema) {
  const valueErrors = validateJSONValue(value);
  if (valueErrors.length) return valueErrors;
  const errors = validateSchema(schema);
  return errors.length ? errors : inspect(value, schema, '$');
}

export function parseJSON(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty model output');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('reply must be one complete JSON value, without prose or code fences'); }
  const errors = validateJSONValue(value);
  if (errors.length) throw new Error(errors.slice(0, 5).join('; '));
  // JSON.parse silently keeps the last duplicate field; routing contracts must reject that ambiguity.
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g) || [];
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(token), keys = stack.at(-1);
      if (keys?.has(key)) throw new Error(`duplicate JSON property ${key}`);
      keys?.add(key);
    }
  }
  return value;
}
