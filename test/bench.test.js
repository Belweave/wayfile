import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickets } from '../bench/tickets.js';
import { baseline } from '../bench/baseline.js';

test('50 labelled tickets', () => {
  assert.equal(tickets.length, 50);
  assert.ok(tickets.every((t) => t.input.ticket.body && t.expect));
});

test('baseline loop runs bash tool calls and sums reported usage', async () => {
  const replies = [
    { content: [{ type: 'tool_use', id: 'u1', input: { cmd: `echo '{"ticket":{"body":"refund order 4"}}' | ./lookup-order.sh` } }], text: '' },
    { content: [{ type: 'text', text: '{"route": "refund"}' }], text: '{"route": "refund"}' },
  ];
  const seen = [];
  const call = async ({ messages }) => { seen.push(messages.at(-1)); return { ...replies.shift(), usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 } }; };
  const r = await baseline(call, { ticket: { body: 'refund order 4' } });
  assert.deepEqual(r, { end: 'refund', calls: 2, usage: { input: 20, output: 4, cacheRead: 2, cacheWrite: 0 } });
  assert.match(JSON.stringify(seen[1]), /delivered/);
});
