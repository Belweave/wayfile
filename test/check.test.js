import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGraph } from '../packages/wayfile/src/parse.js';
import { check, format } from '../packages/wayfile/src/check.js';
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

test('malformed metadata produces findings without crashing graph inspection', async () => {
  const out = await lint({
    'a.md': node('entry: true\nkind: skill\nneeds: q\nsets: [answer, other]\nmax_tokens: 0\nmax_attempts: 3\nordered: yes\nrouting: first\ncache: typo\nmodel: false', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
  });
  assert.match(out, /`needs` must be a list/);
  assert.match(out, /exactly one output path/);
  assert.match(out, /`max_tokens` must be a positive integer/);
  assert.match(out, /`max_attempts` must be 1 or 2/);
  assert.match(out, /`ordered` must be a boolean/);
  assert.match(out, /unknown routing mode/);
  assert.match(out, /unknown cache mode/);
  assert.match(out, /`model` must be a nonempty string/);
  assert.match(await lint({ 'a.md': node('entry: true\nkind: null', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }), /unknown kind "null"/);
  assert.match(await lint({ 'a.md': node('entry: true\nkind: judge\nsets: [one, two]', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }), /writes only the first output path/);
  assert.match(await lint({ 'a.md': node('entry: true\nsets: [fake]', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }), /route nodes do not write state/);
});

test('multiple entries, unknown keys and duplicate fallbacks are visible', async () => {
  const out = await lint({
    'a.md': node('entry: true\nneed: [q]', ['- otherwise → [[b]]', '- otherwise → [[c]]']),
    'b.md': node('kind: end\nentry: true'),
    'c.md': node('kind: end'),
  });
  assert.match(out, /multiple entry nodes/);
  assert.match(out, /unknown frontmatter key `need`/);
  assert.match(out, /multiple `otherwise` routes/);
});

test('predicates declare their inputs and generated values may route after execution', async () => {
  const out = await lint({
    'a.md': node('entry: true\nneeds: [q]', ['- `hidden == true` → [[b]]', '- otherwise → [[b]]']),
    'b.md': node('kind: end'),
  });
  assert.match(out, /predicate reads `hidden` but it is not declared/);
  assert.equal(await lint({
    'a.md': node('entry: true\nkind: skill\nneeds: [q]\nsets: [answer]', ['- `answer ~ /yes/` → [[b]]', '- otherwise → [[b]]']),
    'b.md': node('kind: end'),
  }), '');
  assert.match(await lint({ 'a.md': node('entry: true\nneeds: [constructor.name]\nsets: [__proto__.value]', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }), /invalid state path/);
});

test('a node cannot satisfy its own pre-execution needs through sets', async () => {
  const out = await lint({
    'a.md': node('entry: true\nneeds: [q]', ['- otherwise → [[b]]']),
    'b.md': node('kind: skill\nneeds: [answer]\nsets: [answer]', ['- otherwise → [[c]]']),
    'c.md': node('kind: end'),
  });
  assert.match(out, /needs `answer` but no upstream node sets it/);
});

test('JSON output contracts and cache file dependencies fail closed at check time', async () => {
  const out = await lint({
    'a.md': node('entry: true\nkind: skill\nsets: [answer]\noutput: json\nschema: schemas/result.json\ncache_files: [missing.txt]', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
    'schemas/result.json': '{"type":"object","$ref":"elsewhere"}',
  });
  assert.match(out, /unsupported schema keyword \$ref/);
  assert.match(out, /cache dependency missing.txt not found/);
  assert.match(await lint({ 'a.md': node('entry: true\nkind: skill\nsets: [answer]\noutput: json', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }), /JSON output needs a schema/);
  assert.match(await lint({ 'a.md': node('entry: true\nkind: skill\nsets: [answer]\noutput: json\nschema: absent.json', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }), /schema absent.json not found/);
});

test('ambiguity mode is explicit and empty skill instructions are rejected', async () => {
  const out = await lint({
    'a.md': node('entry: true\nrouting: ambiguous\nneeds: [n]', ['- `n > 1` → [[b]]', '- `n > 2` → [[c]]', '- otherwise → [[b]]']),
    'b.md': node('kind: end'), 'c.md': node('kind: end'),
  });
  assert.doesNotMatch(out, /ambiguous fork/);
  assert.match(await lint({ 'a.md': node('entry: true\nkind: skill\nskill: blank\nsets: [answer]', ['- otherwise → [[b]]']), 'b.md': node('kind: end'), 'skills/blank.md': ' \n' }), /skill instructions are empty/);
});

test('example failures are lint findings rather than uncaught runner errors', async () => {
  const out = await lint({
    'a.md': node('entry: true\nkind: judge\nneeds: [q]', ['- judge: "is it a bug?" → [[b]]', '- otherwise → [[c]]'], '# A\n```example\ninput: {"q":"bug"}\nexpect: b\n```'),
    'b.md': node('kind: end'), 'c.md': node('kind: end'),
  });
  assert.match(out, /example cannot run: .*judge required/);
});

test('harness accepts explicit injected tools and validates generated state dependencies', async () => {
  assert.equal(await lint({
    'a.md': node('entry: true\nkind: harness\nneeds: [question]\nsets: [answer]\ntools: [custom_report-v2]\nmax_turns: 64\nmax_tool_calls: 256\nmax_tool_errors: 0', ['- `answer ~ /done/` → [[b]]', '- otherwise → [[b]]']),
    'b.md': node('kind: end'),
  }), '');
  assert.equal(await lint({
    'a.md': node('entry: true\nkind: harness\nsets: [answer]\ntools: []', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
  }), '');
  assert.deepEqual(await check(loadGraph(new URL('../examples/harness', import.meta.url).pathname)), []);
});

test('harness requires an explicit unique portable tool list', async () => {
  const graph = (tools) => ({
    'a.md': node(`entry: true\nkind: harness\nsets: [answer]${tools ? `\n${tools}` : ''}`, ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
  });
  assert.match(await lint(graph('')), /harness node needs an explicit tools list/);
  assert.match(await lint(graph('tools: read-file')), /`tools` must be a list/);
  assert.match(await lint(graph('tools: [read-file, read-file]')), /`tools` contains duplicates/);
  for (const tool of ['custom.report', 'bad tool', '1starts-with-number', 'x'.repeat(65)]) assert.match(await lint(graph(`tools: ["${tool}"]`)), /invalid tool name/);
  assert.match(await lint({ 'a.md': node('entry: true\ntools: [read-file]', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }), /tool lists are only supported for harness nodes/);
});

test('harness bounds reject zero, fractional, oversized and string limits', async () => {
  for (const [key, values] of [['max_turns', [0, 1.5, 65, '"8"']], ['max_tool_calls', [0, 2.5, 257, '"16"']], ['max_tool_errors', [-1, 1.5, 257, '"2"']]]) {
    for (const value of values) {
      const out = await lint({ 'a.md': node(`entry: true\nkind: harness\nsets: [answer]\ntools: []\n${key}: ${value}`, ['- otherwise → [[b]]']), 'b.md': node('kind: end') });
      assert.match(out, new RegExp(`\u0060${key}\u0060 must be an integer`));
    }
  }
  assert.match(await lint({ 'a.md': node('entry: true\nmax_turns: 8', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }), /only supported for harness nodes/);
});

test('harness enforces one output contract and cannot memoize tool execution', async () => {
  const out = await lint({
    'a.md': node('entry: true\nkind: harness\nsets: [one, two]\ntools: []\ncache: inputs', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
  });
  assert.match(out, /harness node needs exactly one output path/);
  assert.match(out, /harness nodes cannot memoize stateful tool execution/);
  assert.equal(await lint({
    'a.md': node('entry: true\nkind: harness\nsets: [answer]\ntools: []\ncache: none\noutput: json\nschema: schemas/result.json', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
    'schemas/result.json': '{"type":"object","required":["result"],"properties":{"result":{"type":"string"}},"additionalProperties":false}',
  }), '');
});

test('check reports harness examples without running a model or tools', async () => {
  const graph = loadGraph(tmpGraph({
    'a.md': node('entry: true\nkind: harness\nneeds: [question]\nsets: [answer]\ntools: []', ['- otherwise → [[b]]'], '# A\n```example\ninput: {"question":"inspect"}\nexpect: b\n```'),
    'b.md': node('kind: end'),
  }));
  assert.match((await check(graph)).map(format).join('\n'), /harness examples require an output fixture; check does not execute tool loops/);
  assert.deepEqual(await check(graph, { runExamples: false }), []);
});
