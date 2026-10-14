import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, evaluate, get } from '../packages/wayfile/src/logic.js';

test('compiles to JSONLogic', () => {
  assert.deepEqual(compile('ticket.amount > 500'), { '>': [{ var: 'ticket.amount' }, 500] });
  assert.deepEqual(compile('a ~ /x|y/i'), { match: [{ var: 'a' }, 'x|y', 'i'] });
  assert.deepEqual(compile('a == "yes" && b exists'), { and: [{ '==': [{ var: 'a' }, 'yes'] }, { '!!': [{ var: 'b' }] }] });
});

test('evaluates', () => {
  const s = { t: { amount: 600, body: 'Please REFUND' }, ok: true };
  assert.equal(evaluate(compile('t.amount > 500'), s), true);
  assert.equal(evaluate(compile('t.amount <= 500'), s), false);
  assert.equal(evaluate(compile('t.body ~ /refund/i'), s), true);
  assert.equal(evaluate(compile('t.body ~ /refund/'), s), false);
  assert.equal(evaluate(compile('ok == true && t.amount != 1'), s), true);
  assert.equal(evaluate(compile('missing.x > 1'), s), false);
  assert.equal(evaluate(compile('missing exists'), s), false);
});

test('rejects bad predicates', () => {
  assert.throws(() => compile('a >< 3'));
  assert.throws(() => compile('a ~ /(/'));
  assert.throws(() => compile('a > "3"'), /number literal/);
  assert.throws(() => compile('a <= null'), /number literal/);
  assert.throws(() => compile('a == "unterminated'), /unterminated/);
});

test('conjunctions inside literals and regexes preserve their meaning', () => {
  assert.equal(evaluate(compile('text == "a && b" && ready == true'), { text: 'a && b', ready: true }), true);
  assert.equal(evaluate(compile('text ~ /a && b/i && ready == true'), { text: 'A && B', ready: true }), true);
  assert.equal(evaluate(compile('text == "say \\"yes\\""'), { text: 'say "yes"' }), true);
  assert.equal(evaluate(compile('text ~ /https:\\/\\/example/ && ready == true'), { text: 'https://example', ready: true }), true);
});

test('numeric comparisons never coerce missing or string-valued inputs', () => {
  const rule = compile('attempt > 0 && attempt < 3');
  assert.equal(evaluate(rule, { attempt: 1 }), true);
  assert.equal(evaluate(rule, { attempt: '1' }), false);
  assert.equal(evaluate(rule, {}), false);
});

test('state reads exclude inherited properties and unsafe path components', () => {
  const state = Object.assign(Object.create({ inherited: 'yes' }), { nested: { value: 1 } });
  assert.equal(get(state, 'nested.value'), 1);
  assert.equal(get(state, 'inherited'), undefined);
  assert.equal(get(state, 'constructor'), undefined);
  assert.equal(evaluate(compile('toString exists'), {}), false);
  assert.throws(() => compile('__proto__.polluted exists'), /invalid state path/);
  assert.throws(() => compile('a..b == 1'), /invalid state path/);
});
