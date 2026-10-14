import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEvidenceReplySchema } from '../schema-check.mjs';

const schema = () => ({ type: 'object', required: ['amount', 'currency'], properties: {
  amount: { type: ['number', 'null'], minimum: 0 }, currency: { type: ['string', 'null'], enum: ['USD', 'EUR', null] },
} });

test('benchmark preflight accepts explicit nullable primitive types without rewriting them', () => {
  const value = schema(); assert.equal(assertEvidenceReplySchema(value), value);
  assert.deepEqual(value.properties.amount.type, ['number', 'null']);
});

test('benchmark preflight rejects the V1 untyped amount contract and string contracts', () => {
  for (const amount of [{ description: 'Number or null', minimum: 0 }, { type: 'string', minimum: 0 }, { type: ['number', 'null', 'string'], minimum: 0 }]) {
    const value = schema(); value.properties.amount = amount;
    assert.throws(() => assertEvidenceReplySchema(value), /amount.type/);
  }
});
