import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJSON, validateSchema, validateValue, validateJSONValue } from '../packages/wayfile/src/contracts.js';

const schema = {
  type: 'object', required: ['title', 'steps'], additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 20 },
    steps: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1 } },
  },
};

test('output contracts reject absent, fabricated fields and invalid nested values', () => {
  assert.deepEqual(validateValue({ title: 'Export fails', steps: ['Open settings'] }, schema), []);
  assert.match(validateValue({ title: '', steps: [4], refundApproved: true }, schema).join('\n'), /characters[\s\S]*expected string[\s\S]*unexpected property/);
  assert.match(validateValue({ title: 'Export fails' }, schema).join('\n'), /missing required property steps/);
  assert.match(validateValue(['Export fails'], schema).join('\n'), /expected object/);
});

test('unsupported schema assertions fail instead of silently accepting outputs', () => {
  assert.match(validateSchema({ type: 'string', format: 'email' }).join('\n'), /unsupported schema keyword format/);
  assert.match(validateSchema({ properties: { x: { oneOf: [{ type: 'string' }] } } }).join('\n'), /properties.x.*oneOf/);
  assert.match(validateSchema({ type: 'number', minimum: '0' }).join('\n'), /finite number/);
  assert.match(validateSchema({ type: 'string', pattern: '(' }).join('\n'), /valid regular expression/);
});

test('enum, const, numeric limits and Unicode lengths enforce their declared meaning', () => {
  assert.deepEqual(validateValue('🙂', { type: 'string', minLength: 1, maxLength: 1 }), []);
  assert.match(validateValue(1.5, { type: 'integer' }).join('\n'), /integer/);
  assert.match(validateValue(-1, { type: 'number', minimum: 0 }).join('\n'), />= 0/);
  assert.match(validateValue('yes', { enum: ['no', 'pending'] }).join('\n'), /enum/);
  assert.deepEqual(validateValue({ b: 2, a: 1 }, { const: { a: 1, b: 2 } }), []);
  assert.match(validateValue('anything', false).join('\n'), /forbidden/);
  assert.deepEqual(validateValue(null, { type: ['number', 'null'], minimum: 0 }), []);
  assert.deepEqual(validateValue(5, { type: ['number', 'null'], minimum: 0 }), []);
  assert.match(validateValue('5', { type: ['number', 'null'] }).join('\n'), /expected number or null/);
  assert.ok(validateSchema({ type: ['number', 'number'] }).length > 0);
});

test('only a complete JSON value is parseable; fences and embedded snippets fail', () => {
  assert.deepEqual(parseJSON('{"target":"done"}'), { target: 'done' });
  assert.throws(() => parseJSON('Result: {"target":"done"}'), /complete JSON/);
  assert.throws(() => parseJSON('```json\n{"target":"done"}\n```'), /complete JSON/);
  assert.throws(() => parseJSON(''), /empty model output/);
  assert.throws(() => parseJSON('{"target":"work","\\u0074arget":"stop"}'), /duplicate JSON property target/);
  assert.throws(() => parseJSON('{"nested":{"x":1,"x":2}}'), /duplicate JSON property x/);
  assert.deepEqual(parseJSON('[{"x":1},{"x":2}]'), [{ x: 1 }, { x: 2 }]);
});

test('lossy numeric and object values cannot enter JSON state or permissive contracts', () => {
  assert.throws(() => parseJSON('{"x":1e309}'), /finite/);
  for (const value of [NaN, Infinity, { dropped: undefined }, { dropped: () => 1 }, new Date(), [undefined]]) {
    assert.ok(validateValue(value, true).length > 0);
  }
  const cyclic = {}; cyclic.self = cyclic;
  assert.match(validateJSONValue(cyclic).join('\n'), /cyclic/);
  assert.deepEqual(validateJSONValue({ x: null, n: 0, list: [true, 'ok'] }), []);
  const hidden = Object.defineProperty({}, 'hidden', { value: 'lost' });
  let evaluated = false;
  const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { evaluated = true; return 'dynamic'; } });
  const extraArray = [1]; extraArray.extra = 'lost';
  for (const value of [hidden, accessor, extraArray, new Array(1)]) assert.ok(validateJSONValue(value).length > 0);
  assert.equal(evaluated, false);
});
