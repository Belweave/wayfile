import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGraph } from '../packages/wayfile/src/parse.js';
import { run } from '../packages/wayfile/src/run.js';
import { notifyAsk, notifyRequest, stubAsk } from '../packages/wayfile/src/notify.js';

const triage = loadGraph(new URL('../examples/triage', import.meta.url).pathname);
const state = { ticket: { body: 'refund order 2', amount: 900 } };

test('test approvals must be explicit and send nothing', async () => {
  await assert.rejects(stubAsk({ state: {} }), /explicit state.stub.ask/);
  assert.deepEqual(await stubAsk({ state: { stub: { ask: 'yes' } } }), { answer: 'yes', via: 'stub' });
  const orig = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network used'); };
  try {
    await assert.rejects(run(triage, state), /approval backend/);
    assert.equal((await run(triage, { ...state, stub: { ask: 'yes' } })).end, 'refund');
  } finally { globalThis.fetch = orig; }
});

test('request shape follows POST /interactions; key is stable', () => {
  const a = notifyRequest(triage.nodes['ask-approval'], state);
  const b = notifyRequest(triage.nodes['ask-approval'], structuredClone(state));
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.match(a.idempotencyKey, /^wayfile-ask-approval-[0-9a-f]{24}$/);
  assert.deepEqual(Object.keys(a.body).sort(), ['expiresInSeconds', 'kind', 'prompt', 'title']);
  assert.equal(a.body.kind, 'approval');
  assert.equal(a.project, 'Wayfile');
  assert.match(a.body.prompt, /"ticket.amount":900/);
});

test('live backend against a mock fetch: create, wait, map denied → no', async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers });
    if (url.endsWith('/interactions')) return Response.json({ interaction: { id: 'int_1', status: 'pending' } }, { status: 201 });
    if (calls.length === 2) return Response.json({ interaction: { id: 'int_1', status: 'pending' }, timedOut: true });
    return Response.json({ interaction: { id: 'int_1', status: 'denied' }, timedOut: false });
  };
  const ask = notifyAsk({ token: 'test-token', base: 'https://mock.invalid/api/agent', fetchFn });
  const r = await run(triage, state, { ask });
  assert.equal(r.end, 'general-reply');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer test-token');
  assert.match(calls[0].headers['idempotency-key'], /^wayfile-ask-approval-/);
  assert.match(calls[1].url, /\/interactions\/int_1\/wait\?timeout=25$/);
  assert.equal(calls.length, 3);
});

test('live backend refuses to start without a token', () => {
  const saved = process.env.NOTIFY_TOKEN; delete process.env.NOTIFY_TOKEN;
  try { assert.throws(() => notifyAsk(), /NOTIFY_TOKEN/); } finally { if (saved) process.env.NOTIFY_TOKEN = saved; }
});

test('live approval keys are unique per invocation so repeated tasks cannot reuse approval', async () => {
  const keys = [];
  const fetchFn = async (url, init = {}) => {
    if (init.method === 'POST') {
      keys.push(init.headers['idempotency-key']);
      return Response.json({ interaction: { id: `int_${keys.length}`, status: 'pending' } });
    }
    return Response.json({ interaction: { id: `int_${keys.length}`, status: 'approved' }, timedOut: false });
  };
  const ask = notifyAsk({ token: 'test', fetchFn });
  const request = { node: triage.nodes['ask-approval'], state };
  assert.equal((await ask(request)).answer, 'yes');
  assert.equal((await ask(request)).answer, 'yes');
  assert.equal(new Set(keys).size, 2);
});

test('malformed Notify replies cannot be interpreted as an approval', async () => {
  const fetchFn = async (url, init = {}) => init.method === 'POST'
    ? Response.json({ interaction: { id: 'int_1' } })
    : Response.json({ interaction: { status: 'unknown' }, timedOut: false });
  await assert.rejects(notifyAsk({ token: 'test', fetchFn })({ node: triage.nodes['ask-approval'], state }), /unsupported interaction status/);
});

test('approval prompts never truncate the identity or decision evidence', async () => {
  let calls = 0;
  const ask = notifyAsk({ token: 'test', fetchFn: async () => { calls++; } });
  const long = { ...triage.nodes['ask-approval'], body: 'a'.repeat(2001) };
  await assert.rejects(ask({ node: long, state }), /exceeds 2000 characters/);
  assert.equal(calls, 0);
});
