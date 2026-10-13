import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, evaluate } from '../src/logic.js';

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
});
