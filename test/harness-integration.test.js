import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../packages/wayfile/src/parse.js';
import { run } from '../packages/wayfile/src/run.js';
import { node, tmpGraph } from './helpers.js';

test('harness results rejoin the router with typed state, tool trace and complete paid accounting', async () => {
  const dir = tmpGraph({
    'inspect.md': node('entry: true\nkind: harness\nneeds: [question]\nsets: [report]\ntools: [read-file]\noutput: json\nschema: schemas/report.json', ['- `report.status == "done"` → [[done]]', '- otherwise → [[review]]']),
    'schemas/report.json': JSON.stringify({ type: 'object', required: ['status'], additionalProperties: false, properties: { status: { enum: ['done', 'unknown'] } } }),
    'done.md': node('kind: end'), 'review.md': node('kind: end'),
  });
  const traceDir = mkdtempSync(join(tmpdir(), 'wf-harness-trace-'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-harness-cache-'));
  const graph = loadGraph(dir);
  graph.nodes.inspect.meta.cache = 'inputs'; // Even a library caller bypassing lint cannot memoize tool work.
  let invocations = 0;
  const harness = async () => { invocations++; return {
    value: { status: 'done' }, calls: 2, usage: { input: 20, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.002 },
    toolCalls: 1, toolEvents: [{ name: 'read-file', status: 'completed', args: { path: 'project.md' } }],
  }; };
  const result = await run(graph, { question: 'Inspect' }, { harness, traceDir, cacheDir });
  assert.equal(result.end, 'done');
  assert.deepEqual(result.state.report, { status: 'done' });
  assert.equal(result.calls, 2);
  assert.equal(result.usage.cost, 0.002);
  assert.equal(result.steps[0].toolCalls, 1);
  assert.match(readFileSync(result.trace, 'utf8'), /Harness tools[\s\S]*read-file/);
  await run(graph, { question: 'Inspect' }, { harness, cacheDir });
  assert.equal(invocations, 2);
  assert.equal(readdirSync(cacheDir).length, 0);
  await assert.rejects(run(graph, { question: 'Inspect' }, { harness: async () => ({ value: { status: 'invented' }, calls: 1 }) }), /validation/);
});
