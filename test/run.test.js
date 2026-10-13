import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../src/parse.js';
import { run } from '../src/run.js';
import { tmpGraph, node, fakeJudge } from './helpers.js';

const triage = loadGraph(new URL('../examples/triage', import.meta.url).pathname);

test('deterministic route costs zero model calls', async () => {
  const j = fakeJudge('bug-intake');
  const r = await run(triage, { ticket: { body: 'I am locked out', amount: 0 } }, { judge: j });
  assert.equal(r.end, 'account-help');
  assert.equal(r.calls, 0);
  assert.equal(j.calls.length, 0);
});

test('script node: stdin/stdout JSON, only declared sets written', async () => {
  const r = await run(triage, { ticket: { body: 'refund order 22', amount: 10 } });
  assert.deepEqual(r.steps.map((s) => s.node), ['triage', 'lookup-order', 'refund']);
  assert.equal(r.state.order.status, 'delivered');
  const dir = tmpGraph({
    'a.md': node('kind: script\nentry: true\nscript: s.sh\nsets: [x]', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
    's.sh': '#!/bin/sh\necho \'{"set":{"x":1,"y":2},"next":"b"}\'\n',
  });
  const r2 = await run(loadGraph(dir), {});
  assert.deepEqual(r2.state, { x: 1 });
  assert.equal(r2.steps[0].how, 'script next');
});

test('judge called once at a fork with enum targets; usage summed', async () => {
  const j = fakeJudge('bug-intake');
  const r = await run(triage, { ticket: { body: 'crash when I tap export', amount: 0 } }, { judge: j });
  assert.equal(r.end, 'bug-intake');
  assert.deepEqual(j.calls, [{ n: 'triage', targets: ['bug-intake', 'general-reply'] }]);
  assert.equal(r.calls, 1);
  assert.equal(r.usage.input, 100);
  assert.equal(r.state.ticket.class, 'bug-intake');
});

test('invalid judge target falls to otherwise', async () => {
  const r = await run(triage, { ticket: { body: 'hello', amount: 0 } }, { judge: fakeJudge('refund') });
  assert.equal(r.end, 'general-reply');
});

test('ask node is a local stub', async () => {
  const big = { ticket: { body: 'refund order 3', amount: 900 } };
  assert.equal((await run(triage, big)).end, 'refund');
  assert.equal((await run(triage, { ...big, stub: { ask: 'no' } })).end, 'general-reply');
});

test('memoization: replay costs 0 tokens; changed input misses', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const j = fakeJudge('bug-intake');
  const t = { ticket: { body: 'crash on export', amount: 0 } };
  const a = await run(triage, t, { judge: j, cacheDir });
  const b = await run(triage, t, { judge: j, cacheDir });
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 0);
  assert.equal(b.steps[0].cached, true);
  assert.equal(b.end, 'bug-intake');
  await run(triage, { ticket: { body: 'crash on import', amount: 0 } }, { judge: j, cacheDir });
  assert.equal(j.calls.length, 2);
});

test('no judge configured: otherwise taken and not memoized', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const t = { ticket: { body: 'crash', amount: 0 } };
  await run(triage, t, { cacheDir });
  const r = await run(triage, t, { cacheDir, judge: fakeJudge('bug-intake') });
  assert.equal(r.end, 'bug-intake');
});

test('max_visits stops loops', async () => {
  const dir = tmpGraph({ 'a.md': node('entry: true\nmax_visits: 3', ['- otherwise → [[a]]']) });
  await assert.rejects(run(loadGraph(dir), {}), /max_visits/);
});

test('writes a Markdown trace', async () => {
  const traceDir = mkdtempSync(join(tmpdir(), 'wf-runs-'));
  const r = await run(triage, { ticket: { body: 'refund order 4', amount: 1 } }, { traceDir });
  assert.equal(readdirSync(traceDir).length, 1);
  const md = readFileSync(r.trace, 'utf8');
  assert.match(md, /# Run → refund/);
  assert.match(md, /triage\.md:\d+/);
  assert.match(md, /order\.status/);
});
