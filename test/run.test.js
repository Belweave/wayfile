import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../packages/wayfile/src/parse.js';
import { run } from '../packages/wayfile/src/run.js';
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
  assert.deepEqual(r.steps.map((s) => s.node), ['triage', 'refund-request', 'lookup-order', 'refund']);
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
  assert.deepEqual(j.calls, [{ n: 'triage', targets: ['refund-request', 'account-help', 'bug-intake', 'general-reply'] }]);
  assert.equal(r.calls, 1);
  assert.equal(r.usage.input, 100);
  assert.equal(r.state.ticket.class, 'bug-intake');
});

test('invalid judge target fails without memoizing a fallback', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const input = { ticket: { body: 'hello', amount: 0 } };
  await assert.rejects(run(triage, input, { judge: fakeJudge('refund'), cacheDir, cacheKey: 'test' }), /judge returned invalid target/);
  assert.deepEqual(readdirSync(cacheDir), []);
  const r = await run(triage, input, { judge: fakeJudge('bug-intake'), cacheDir, cacheKey: 'test' });
  assert.equal(r.end, 'bug-intake');
  assert.equal(r.calls, 1);
});

test('ask node is a local stub', async () => {
  const big = { ticket: { body: 'refund order 3', amount: 900 }, stub: { ask: 'yes' } };
  assert.equal((await run(triage, big)).end, 'refund');
  assert.equal((await run(triage, { ...big, stub: { ask: 'no' } })).end, 'general-reply');
});

test('memoization: replay costs 0 tokens; changed input misses', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const j = fakeJudge('bug-intake');
  j.cacheKey = 'test-judge';
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

test('unavailable judge fails without memoizing a fallback', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const t = { ticket: { body: 'crash', amount: 0 } };
  await assert.rejects(run(triage, t, { cacheDir }), /judge required/);
  assert.deepEqual(readdirSync(cacheDir), []);
  const r = await run(triage, t, { cacheDir, judge: fakeJudge('bug-intake') });
  assert.equal(r.end, 'bug-intake');
});

test('maxSteps exhaustion fails; partial previews identify the pending node', async () => {
  const g = loadGraph(tmpGraph({ 'a.md': node('entry: true', ['- otherwise → [[a]]']) }));
  await assert.rejects(run(g, {}, { maxSteps: 3 }), /exceeded maxSteps 3; next node: a/);
  const preview = await run(g, {}, { maxSteps: 1, allowPartial: true });
  assert.equal(preview.end, null);
  assert.equal(preview.status, 'partial');
  assert.equal(preview.partial, true);
  assert.equal(preview.next, 'a');
  assert.equal(preview.steps.length, 1);
  for (const maxSteps of [0, -1, 1.5, NaN]) await assert.rejects(run(g, {}, { maxSteps }), /positive integer/);
});

test('routing ambiguity asks only about matched targets and records the selected predicate', async () => {
  const g = loadGraph(tmpGraph({
    'a.md': node('entry: true\nkind: judge\nrouting: ambiguous\nneeds: [n]\nsets: [choice]', ['- `n > 0` → [[b]]', '- `n > 10` → [[c]]', '- otherwise → [[d]]']),
    'b.md': node('kind: end'), 'c.md': node('kind: end'), 'd.md': node('kind: end'),
  }));
  const j = fakeJudge('c');
  const r = await run(g, { n: 20 }, { judge: j });
  assert.equal(r.end, 'c');
  assert.equal(r.state.choice, 'c');
  assert.deepEqual(j.calls[0].targets, ['b', 'c']);
  assert.equal(r.steps[0].line, g.nodes.a.routes[1].line);
  assert.match(r.steps[0].how, /judge \(ambiguous\).*n > 10/);
  await assert.rejects(run(g, { n: 20 }), /judge required for ambiguous matches/);
  await assert.rejects(run(g, { n: 20 }, { judge: fakeJudge('d') }), /invalid target/);
  assert.equal((await run(g, { n: 5 })).end, 'b');
  g.nodes.a.meta.ordered = true;
  assert.equal((await run(g, { n: 20 })).end, 'b');
  delete g.nodes.a.meta.routing;
  delete g.nodes.a.meta.ordered;
  assert.equal((await run(g, { n: 20 })).end, 'b');
});

test('multiple matching predicates for one target remain deterministic', async () => {
  const g = loadGraph(tmpGraph({
    'a.md': node('entry: true\nrouting: ambiguous\nneeds: [n]', ['- `n > 0` → [[b]]', '- `n > 10` → [[b]]', '- otherwise → [[c]]']),
    'b.md': node('kind: end'), 'c.md': node('kind: end'),
  }));
  const r = await run(g, { n: 20 });
  assert.equal(r.end, 'b');
  assert.equal(r.calls, 0);
});

test('memo keys include predicate reads and distinguish missing from null', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const g = loadGraph(tmpGraph({
    'a.md': node('entry: true\nneeds: [q]\ncache: inputs', ['- `flag == null` → [[b]]', '- otherwise → [[c]]']),
    'b.md': node('kind: end'), 'c.md': node('kind: end'),
  }));
  assert.equal((await run(g, { q: 'same' }, { cacheDir })).end, 'c');
  const withNull = await run(g, { q: 'same', flag: null }, { cacheDir });
  assert.equal(withNull.end, 'b');
  assert.equal(withNull.steps[0].cached, false);
  assert.equal((await run(g, { q: 'same', flag: null }, { cacheDir })).steps[0].cached, true);
  assert.equal((await run(g, { q: 'same' }, { cacheDir })).end, 'c');
});

test('model memo keys follow instructions, skills, graph context, identity and caller context', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const g = loadGraph(tmpGraph({
    'a.md': node('entry: true\nkind: skill\nneeds: [q]\nsets: [answer]\ncache: inputs', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
  }));
  let calls = 0;
  const skill = async () => ({ text: `result ${++calls}`, usage: { input: 1, output: 1, cost: 0.001 } });
  skill.cacheKey = 'model-v1';
  const runOnce = (context = 'v1') => run(g, { q: 'same' }, { skill, cacheDir, context });
  assert.equal((await runOnce()).state.answer, 'result 1');
  assert.equal((await runOnce()).state.answer, 'result 1');
  g.instructions = 'New agent policy';
  assert.equal((await runOnce()).state.answer, 'result 2');
  g.nodes.a.skillText = 'New skill policy';
  assert.equal((await runOnce()).state.answer, 'result 3');
  g.nodes.b.title = 'New target description';
  assert.equal((await runOnce()).state.answer, 'result 4');
  skill.cacheKey = 'model-v2';
  assert.equal((await runOnce()).state.answer, 'result 5');
  assert.equal((await runOnce('v2')).state.answer, 'result 6');
  assert.equal(calls, 6);
});

test('custom models without a cache identity execute each time', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const j = fakeJudge('bug-intake');
  const input = { ticket: { body: 'crash on export', amount: 0 } };
  await run(triage, input, { judge: j, cacheDir });
  await run(triage, input, { judge: j, cacheDir });
  assert.equal(j.calls.length, 2);
  assert.deepEqual(readdirSync(cacheDir), []);
});

test('script memo follows full stdin state, executable contents and declared data files', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const dir = tmpGraph({
    'a.md': node('entry: true\nkind: script\nscript: s.sh\nneeds: [q]\nsets: [x]\ncache: inputs\ncache_files: [data.txt]', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
    's.sh': '#!/bin/sh\nnode -e \'const fs = require("node:fs"); const s = JSON.parse(fs.readFileSync(0,"utf8")); console.log(JSON.stringify({set:{x:s.extra+fs.readFileSync("data.txt","utf8").trim()}}));\'\n',
    'data.txt': 'one\n',
  });
  const g = loadGraph(dir);
  const runOnce = (extra) => run(g, { q: 'same', extra }, { cacheDir });
  assert.equal((await runOnce('a')).state.x, 'aone');
  assert.equal((await runOnce('a')).steps[0].cached, true);
  assert.equal((await runOnce('b')).state.x, 'bone');
  writeFileSync(join(dir, 'data.txt'), 'two\n');
  assert.equal((await runOnce('b')).state.x, 'btwo');
  writeFileSync(join(dir, 's.sh'), '#!/bin/sh\necho \'{"set":{"x":"new executable"}}\'\n');
  assert.equal((await runOnce('b')).state.x, 'new executable');
});

test('ask nodes cannot reuse cached approvals', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const g = loadGraph(tmpGraph({
    'a.md': node('entry: true\nkind: ask\nneeds: [amount]\nsets: [approval]\ncache: inputs', ['- `approval == "yes"` → [[b]]', '- otherwise → [[c]]']),
    'b.md': node('kind: end'), 'c.md': node('kind: end'),
  }));
  let calls = 0;
  const ask = async () => ({ answer: ++calls === 1 ? 'yes' : 'no' });
  assert.equal((await run(g, { amount: 100 }, { ask, cacheDir })).end, 'b');
  assert.equal((await run(g, { amount: 100 }, { ask, cacheDir })).end, 'c');
  assert.equal(calls, 2);
  assert.deepEqual(readdirSync(cacheDir), []);
});

test('invalid script next fails without caching its state writes', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const g = loadGraph(tmpGraph({
    'a.md': node('entry: true\nkind: script\nscript: s.sh\nsets: [x]\ncache: inputs', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'), 's.sh': '#!/bin/sh\necho \'{"set":{"x":1},"next":"nope"}\'\n',
  }));
  await assert.rejects(run(g, {}, { cacheDir }), /script returned invalid next target/);
  assert.deepEqual(readdirSync(cacheDir), []);
});

test('corrupt memo entries are recomputed', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const g = loadGraph(tmpGraph({ 'a.md': node('entry: true\ncache: inputs', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }));
  await run(g, {}, { cacheDir });
  const [file] = readdirSync(cacheDir);
  for (const badCache of ['{', 'null', '[]', '{}']) {
    writeFileSync(join(cacheDir, file), badCache);
    const r = await run(g, {}, { cacheDir });
    assert.equal(r.end, 'b');
    assert.equal(r.steps[0].cached, false);
  }
});

test('missing entry and invalid start fail instead of returning an empty success', async () => {
  const g = loadGraph(tmpGraph({ 'a.md': node('kind: end') }));
  await assert.rejects(run(g, {}), (error) => {
    assert.match(error.message, /no entry node/);
    assert.equal(error.result.status, 'failed');
    assert.equal(error.result.end, null);
    assert.equal(error.result.calls, 0);
    return true;
  });
  await assert.rejects(run(g, {}, { start: 'missing' }), /no such node: missing/);
  const r = await run(g, {}, { start: 'a' });
  assert.equal(r.status, 'completed');
  assert.equal(r.end, 'a');
});

test('failed runs retain previous steps, state, billed usage and a failed trace', async () => {
  const traceDir = mkdtempSync(join(tmpdir(), 'wf-runs-'));
  const g = loadGraph(tmpGraph({
    'a.md': node('entry: true\nkind: skill\nsets: [answer]', ['- otherwise → [[b]]']),
    'b.md': node('kind: judge', ['- judge: "use c?" → [[c]]', '- otherwise → [[c]]']),
    'c.md': node('kind: end'),
  }));
  const skill = async () => ({ text: 'done', usage: { input: 3, output: 2, cost: 0.1 } });
  const judge = async () => { throw Object.assign(new Error('invalid model reply'), { usage: { input: 10, output: 5, cost: 0.2 }, calls: 2 }); };
  await assert.rejects(run(g, {}, { skill, judge, traceDir }), (error) => {
    const r = error.result;
    assert.equal(r.status, 'failed');
    assert.equal(r.end, null);
    assert.deepEqual(r.steps.map((s) => s.node), ['a', 'b']);
    assert.equal(r.state.answer, 'done');
    assert.equal(r.calls, 3);
    assert.deepEqual(r.usage, { input: 13, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0.1 + 0.2 });
    assert.match(readFileSync(r.trace, 'utf8'), /# Run failed[\s\S]*invalid model reply/);
    return true;
  });
});

test('a failed skill-plus-judge decision accounts each attempt once', async () => {
  const g = loadGraph(tmpGraph({
    'a.md': node('entry: true\nkind: skill\nsets: [answer]', ['- judge: "use b?" → [[b]]', '- otherwise → [[b]]']),
    'b.md': node('kind: end'),
  }));
  const skill = async () => ({ text: 'done', usage: { input: 3, output: 2, cost: 0.1 } });
  const judge = async () => { throw Object.assign(new Error('judge failed'), { usage: { input: 10, output: 5, cost: 0.2 }, calls: 2 }); };
  await assert.rejects(run(g, {}, { skill, judge }), (error) => {
    assert.equal(error.result.steps.length, 1);
    assert.equal(error.result.state.answer, 'done');
    assert.equal(error.result.calls, 3);
    assert.equal(error.result.usage.cost, 0.1 + 0.2);
    assert.equal(error.usage.cost, 0.1 + 0.2);
    return true;
  });
  await assert.rejects(run(g, {}, { skill, judge: async () => ({ target: 'wrong', usage: { input: 10, output: 5, cost: 0.2 } }) }), (error) => {
    assert.equal(error.result.calls, 2);
    assert.equal(error.result.usage.cost, 0.1 + 0.2);
    return /invalid target/.test(error.message);
  });
});

test('skill and judge calls include repairs and sum all usage fields', async () => {
  const g = loadGraph(tmpGraph({
    'a.md': node('entry: true\nkind: skill\nneeds: [q]\nsets: [answer]', ['- judge: "use b?" → [[b]]', '- otherwise → [[c]]']),
    'b.md': node('kind: end'), 'c.md': node('kind: end'),
  }));
  const skill = async () => ({ text: 'answer', calls: 1, usage: { input: 3, output: 2, cost: 0.1 } });
  const judge = async () => ({ target: 'b', calls: 2, usage: { input: 10, output: 5, cacheRead: 4, cacheWrite: 1, cost: 0.2 } });
  const r = await run(g, { q: 'question' }, { skill, judge });
  assert.equal(r.calls, 3);
  assert.deepEqual(r.usage, { input: 13, output: 7, cacheRead: 4, cacheWrite: 1, cost: 0.1 + 0.2 });
  const unknown = await run(g, { q: 'question' }, { skill, judge: async () => ({ target: 'b', usage: { input: 10, output: 5, cost: null } }) });
  assert.equal(unknown.calls, 2);
  assert.equal(unknown.usage.cost, null);
  const unreported = await run(g, { q: 'question' }, { skill, judge: async () => ({ target: 'b' }) });
  assert.equal(unreported.calls, 2);
  assert.equal(unreported.usage.cost, null);
});

test('JSON skill output remains typed and missing JSON fails', async () => {
  const g = loadGraph(tmpGraph({
    'a.md': node('entry: true\nkind: skill\noutput: json\nschema: answer.json\nsets: [answer]', ['- `answer.ok == true` → [[b]]', '- otherwise → [[c]]']),
    'b.md': node('kind: end'), 'c.md': node('kind: end'),
    'answer.json': JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }),
  }));
  const r = await run(g, {}, { skill: async () => ({ value: { ok: true }, text: '{"ok":true}' }) });
  assert.equal(r.end, 'b');
  assert.deepEqual(r.state.answer, { ok: true });
  await assert.rejects(run(g, {}, { skill: async () => ({ text: '{"ok":true}' }) }), /skill returned no JSON value/);
  await assert.rejects(run(g, {}, { skill: async () => ({ value: { ok: 'true' } }) }), /skill output failed validation.*expected boolean/);
});

test('replayed JSON skill output must still meet its schema', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-cache-'));
  const g = loadGraph(tmpGraph({
    'a.md': node('entry: true\nkind: skill\noutput: json\nschema: answer.json\nsets: [answer]\ncache: inputs', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
    'answer.json': JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }),
  }));
  let calls = 0;
  const skill = async () => { calls++; return { value: { ok: true } }; };
  skill.cacheKey = 'json-skill';
  await run(g, {}, { skill, cacheDir });
  const [file] = readdirSync(cacheDir);
  const memo = JSON.parse(readFileSync(join(cacheDir, file), 'utf8'));
  memo.set.answer = { ok: 'true' };
  writeFileSync(join(cacheDir, file), JSON.stringify(memo));
  const r = await run(g, {}, { skill, cacheDir });
  assert.equal(calls, 2);
  assert.equal(r.steps[0].cached, false);
  assert.deepEqual(r.state.answer, { ok: true });
});

test('script payloads cannot silently discard a malformed set object', async () => {
  for (const output of [true, [], { set: [] }, { set: null }, { set: 1 }]) {
    const g = loadGraph(tmpGraph({
      'a.md': node('entry: true\nkind: script\nscript: s.sh\nsets: [x]', ['- otherwise → [[b]]']),
      'b.md': node('kind: end'), 's.sh': `#!/bin/sh\necho '${JSON.stringify(output)}'\n`,
    }));
    await assert.rejects(run(g, {}), /script output must be an object/);
  }
});

test('ask backend identity is recorded in steps and traces', async () => {
  const traceDir = mkdtempSync(join(tmpdir(), 'wf-runs-'));
  const r = await run(triage, { ticket: { body: 'refund order 8', amount: 900 } }, { traceDir, ask: async () => ({ answer: 'yes', via: 'mock', id: 'int-test' }) });
  const step = r.steps.find((s) => s.node === 'ask-approval');
  assert.deepEqual(step.approval, { via: 'mock', id: 'int-test' });
  assert.match(readFileSync(r.trace, 'utf8'), /"via":"mock","id":"int-test"/);
});

test('runtime rejects scalar state and unsafe writes even without preflight lint', async () => {
  const g = loadGraph(tmpGraph({ 'a.md': node('entry: true\nkind: skill\nsets: [__proto__.wayfilePollution]') }));
  for (const input of [null, [], true, 'text']) await assert.rejects(run(g, input), /state object/);
  await assert.rejects(run(g, {}, { skill: async () => ({ text: 'polluted' }) }), /unsafe state path/);
  assert.equal({}.wayfilePollution, undefined);
});

test('nonfinite or lossy state cannot collide with null in the memo cache', async () => {
  const graph = loadGraph(tmpGraph({
    'a.md': node('entry: true\nneeds: [x]\ncache: inputs', ['- `x == null` → [[b]]', '- otherwise → [[c]]']),
    'b.md': node('kind: end'), 'c.md': node('kind: end'),
  }));
  const cacheDir = mkdtempSync(join(tmpdir(), 'wf-finite-'));
  assert.equal((await run(graph, { x: null }, { cacheDir })).end, 'b');
  for (const value of [Infinity, NaN, undefined]) await assert.rejects(run(graph, { x: value }, { cacheDir }), /invalid run input/);
});

test('terminal skills execute before returning their result', async () => {
  const g = loadGraph(tmpGraph({ 'a.md': node('entry: true\nkind: skill\nsets: [answer]') }));
  const r = await run(g, {}, { skill: async () => ({ text: 'done' }) });
  assert.equal(r.end, 'a');
  assert.equal(r.state.answer, 'done');
  assert.equal(r.calls, 1);
  assert.equal(r.usage.cost, null);
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
