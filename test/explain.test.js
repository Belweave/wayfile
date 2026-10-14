import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph } from '../packages/wayfile/src/parse.js';
import { explain, decideOne, mermaid, edgeDiff } from '../packages/wayfile/src/explain.js';
import { tmpGraph, node } from './helpers.js';

const triage = loadGraph(new URL('../examples/triage', import.meta.url).pathname);

test('explain prints path and deciding lines', async () => {
  const { text } = await explain(triage, { ticket: { body: 'refund order 8', amount: 900 }, stub: { ask: 'yes' } }, {});
  assert.match(text, /1\. triage → refund-request  via `ticket\.body ~ .*` {2}@ .*triage\.md:\d+/);
  assert.match(text, /2\. refund-request → ask-approval  via `ticket\.amount > 500` {2}@ .*refund-request\.md:\d+/);
  assert.match(text, /lookup-order → refund/);
  assert.match(text, /model calls: 0/);
});

test('decideOne explicitly previews one step without completing its pending target', async () => {
  const g = loadGraph(tmpGraph({ 'a.md': node('entry: true', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }));
  const step = await decideOne(g, g.nodes.a, {});
  assert.equal(step.node, 'a');
  assert.equal(step.next, 'b');
});

test('explain labels unreported model cost as unknown', async () => {
  const g = loadGraph(tmpGraph({ 'a.md': node('entry: true\nkind: judge', ['- judge: "use b?" → [[b]]', '- otherwise → [[b]]']), 'b.md': node('kind: end') }));
  const { text } = await explain(g, {}, { judge: async () => ({ target: 'b', usage: { input: 1, output: 1, cost: null } }) });
  assert.match(text, /model calls: 1.*cost unknown/);
});

test('mermaid export', () => {
  const m = mermaid(triage);
  assert.match(m, /^flowchart TD/);
  assert.match(m, /triage\{\{"triage"\}\}/);
  assert.match(m, /triage -\.->\|"judge: is this a bug report.*"\| bug_intake/);
  assert.match(m, /lookup_order -->\|"order\.status == #quot;not_found#quot;"\| general_reply/);
});

test('edge diff against git', () => {
  const dir = tmpGraph({ 'a.md': node('entry: true', ['- `x > 1` → [[b]]', '- otherwise → [[b]]']), 'b.md': node('kind: end') });
  const git = (...a) => execFileSync('git', a, { cwd: dir });
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x');
  writeFileSync(join(dir, 'a.md'), node('entry: true', ['- `x > 2` → [[b]]', '- otherwise → [[b]]']));
  const d = edgeDiff(loadGraph(dir));
  assert.deepEqual(d, { added: ['a: x > 2 → b'], removed: ['a: x > 1 → b'] });
});
