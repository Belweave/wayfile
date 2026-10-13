import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGraph } from '../src/parse.js';
import { check, format } from '../src/check.js';
import { tmpGraph, node } from './helpers.js';

const lint = async (files) => (await check(loadGraph(tmpGraph(files)))).map(format).join('\n');

test('triage example is clean', async () => {
  assert.deepEqual(await check(loadGraph(new URL('../examples/triage', import.meta.url).pathname)), []);
});

test('missing entry, otherwise, target, unreachable', async () => {
  const out = await lint({
    'a.md': node('kind: route', ['- `x > 1` → [[nope]]']),
    'b.md': node('kind: end'),
  });
  assert.match(out, /no entry node/);
  assert.match(out, /a\.md:\d+: error: route target \[\[nope\]\] does not exist/);
  assert.match(out, /missing `otherwise`/);
  const out2 = await lint({ 'a.md': node('entry: true', ['- otherwise → [[b]]']), 'b.md': node('kind: end'), 'c.md': node('kind: end') });
  assert.match(out2, /c\.md:1: warn: unreachable from entry/);
});

test('cycles: no exit is an error, no max_visits is a warning', async () => {
  const out = await lint({ 'a.md': node('entry: true', ['- otherwise → [[b]]']), 'b.md': node('kind: route', ['- otherwise → [[a]]']) });
  assert.match(out, /error: cycle with no exit/);
  const out2 = await lint({
    'a.md': node('entry: true\nneeds: [x]', ['- `x > 1` → [[c]]', '- otherwise → [[b]]']),
    'b.md': node('kind: route', ['- otherwise → [[a]]']), 'c.md': node('kind: end'),
  });
  assert.match(out2, /warn: cycle without max_visits/);
});

test('missing and non-executable scripts', async () => {
  assert.match(await lint({ 'a.md': node('entry: true\nkind: script\nscript: s.sh', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }), /script s\.sh not found/);
  assert.match(await lint({ 'a.md': node('entry: true\nkind: script\nscript: s.txt', ['- otherwise → [[b]]']), 'b.md': node('kind: end'), 's.txt': 'x' }), /not executable → chmod \+x s\.txt/);
});

test('ambiguous forks found by sampling, silenced by ordered', async () => {
  const routes = ['- `n > 10` → [[b]]', '- `n > 20` → [[c]]', '- `n < 5` → [[c]]', '- otherwise → [[b]]'];
  const files = { 'b.md': node('kind: end'), 'c.md': node('kind: end') };
  const out = await lint({ ...files, 'a.md': node('entry: true\nneeds: [n]', routes) });
  assert.match(out, /a\.md:\d+: warn: ambiguous fork: lines \d+ and \d+ both match \{"n":21\}/);
  assert.doesNotMatch(out, /both match \{"n":4\}/); // n>10 and n<5 are disjoint
  assert.doesNotMatch(await lint({ ...files, 'a.md': node('entry: true\nordered: true\nneeds: [n]', routes) }), /ambiguous/);
});

test('needs not set upstream', async () => {
  const out = await lint({ 'a.md': node('entry: true\nneeds: [x]', ['- otherwise → [[b]]']), 'b.md': node('needs: [y]', ['- otherwise → [[c]]']), 'c.md': node('kind: end') });
  assert.match(out, /b\.md:2: error: needs `y` but no upstream node sets it/);
});

test('examples run as tests', async () => {
  const out = await lint({
    'a.md': node('entry: true\nneeds: [n]', ['- `n > 1` → [[b]]', '- otherwise → [[c]]'], '# A\n```example\ninput: {"n": 0}\nexpect: b\n```'),
    'b.md': node('kind: end'), 'c.md': node('kind: end'),
  });
  assert.match(out, /a\.md:\d+: error: example expects \[\[b\]\] but routes to \[\[c\]\]/);
});
