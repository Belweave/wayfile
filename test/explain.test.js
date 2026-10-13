import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph } from '../src/parse.js';
import { explain, mermaid, edgeDiff } from '../src/explain.js';
import { tmpGraph, node } from './helpers.js';

const triage = loadGraph(new URL('../examples/triage', import.meta.url).pathname);

test('explain prints path and deciding lines', async () => {
  const { text } = await explain(triage, { ticket: { body: 'refund order 8', amount: 900 } }, {});
  assert.match(text, /1\. triage → ask-approval  via `ticket\.amount > 500 && .*` {2}@ .*triage\.md:\d+/);
  assert.match(text, /lookup-order → refund/);
  assert.match(text, /model calls: 0/);
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
