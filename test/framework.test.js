import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../packages/wayfile/src/parse.js';
import { run } from '../packages/wayfile/src/run.js';
import { check } from '../packages/wayfile/src/check.js';
import { makeSkill, judgePrompt } from '../packages/wayfile/src/model.js';
import { notifyRequest } from '../packages/wayfile/src/notify.js';
import { tmpGraph, node, fakeJudge } from './helpers.js';

const cli = new URL('../packages/wayfile/bin/wayfile.js', import.meta.url).pathname;
const env = { ...process.env, OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: '' };

test('init scaffolds a graph that passes check and runs without a model on deterministic paths', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'wf-init-')), 'my-agent');
  execFileSync('node', [cli, 'init', dir], { env });
  assert.match(execFileSync('node', [cli, 'check', dir], { env, encoding: 'utf8' }), /0 errors, 0 warnings/);
  const out = JSON.parse(execFileSync('node', [cli, 'run', dir, '--input', '{"message":{"text":"stop emailing me"}}'], { env, encoding: 'utf8' }));
  assert.equal(out.end, 'unsubscribe');
  assert.equal(out.calls, 0);
  assert.throws(() => execFileSync('node', [cli, 'init', dir], { env, stdio: 'pipe' }), /not empty/);
});

test('AGENT.md is always-on instructions, not a node; skill files load per node', () => {
  const dir = tmpGraph({
    'AGENT.md': 'Be terse.',
    'a.md': node('entry: true\nkind: skill\nskill: tone\nneeds: [q]\nsets: [answer]', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
    'skills/tone.md': 'Use one sentence.',
  });
  const g = loadGraph(dir);
  assert.equal(g.instructions, 'Be terse.');
  assert.deepEqual(Object.keys(g.nodes).sort(), ['a', 'b']);
  assert.equal(g.nodes.a.skillText, 'Use one sentence.');
  assert.match(judgePrompt(g, g.nodes.a, {}, ['b']).system, /# Agent instructions\nBe terse\./);
});

test('skill node: one model call, output written to sets, usage counted', async () => {
  const dir = tmpGraph({
    'AGENT.md': 'Be terse.',
    'a.md': node('entry: true\nkind: skill\nskill: tone\nneeds: [q]\nsets: [answer]', ['- `answer ~ /yes/` → [[b]]', '- otherwise → [[c]]']),
    'b.md': node('kind: end'), 'c.md': node('kind: end'),
    'skills/tone.md': 'Use one sentence.',
  });
  const seen = [];
  const call = async (req) => { seen.push(req); return { text: ' yes, done ', usage: { input: 50, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.001 } }; };
  const r = await run(loadGraph(dir), { q: 'ok?' }, { skill: makeSkill(call) });
  assert.equal(r.end, 'b');
  assert.equal(r.state.answer, 'yes, done');
  assert.equal(r.calls, 1);
  assert.equal(r.usage.cost, 0.001);
  assert.match(seen[0].system, /Be terse\.[\s\S]*Use one sentence\./);
  assert.equal(seen[0].messages[0].content, '{"q":"ok?"}');
  await assert.rejects(run(loadGraph(dir), { q: 'x' }, {}), /needs a model/);
});

test('check flags a missing skill file', async () => {
  const g = loadGraph(tmpGraph({ 'a.md': node('entry: true\nkind: skill\nskill: nope', ['- otherwise → [[b]]']), 'b.md': node('kind: end') }));
  assert.match(JSON.stringify(await check(g)), /skills\/nope\.md not found/);
});

test('template tool follows the stdin/stdout contract', () => {
  const tool = new URL('../packages/wayfile/templates/agent/tools/lookup-order.mjs', import.meta.url).pathname;
  const out = execFileSync(tool, { input: '{"message":{"text":"order #7"}}', encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { set: { 'order.status': 'shipped' } });
  assert.ok(readFileSync(tool, 'utf8').startsWith('#!/usr/bin/env node'));
});

test('support semantic fallback respects negation and refund amount guards', async () => {
  const graph = loadGraph(new URL('../examples/triage', import.meta.url).pathname);
  const account = fakeJudge('account-help');
  const negated = await run(graph, { ticket: { body: 'I do not want a refund. My password reset is broken.', amount: 40 } }, { judge: account });
  assert.equal(negated.end, 'account-help');
  assert.equal(account.calls.length, 1);
  assert.deepEqual(negated.steps.map((s) => s.node), ['triage', 'account-help']);

  for (const amount of [undefined, null, '40', -1]) {
    const input = { ticket: { body: 'Please send my money back for order 22.', ...(amount === undefined ? {} : { amount }) } };
    const result = await run(graph, input, { judge: fakeJudge('refund-request') });
    assert.equal(result.end, 'general-reply');
    assert.equal(result.steps.some((s) => ['ask-approval', 'lookup-order', 'refund'].includes(s.node)), false);
  }
  const denied = await run(graph, { ticket: { body: 'Please send my money back for order 22.', amount: 900 }, stub: { ask: 'no' } }, { judge: fakeJudge('refund-request') });
  assert.equal(denied.end, 'general-reply');
  assert.equal(denied.state.approval, 'no');
  assert.equal(denied.steps.some((s) => s.node === 'lookup-order'), false);
});

test('CI semantic fallback covers paraphrases while deterministic guards cap retries', async () => {
  const graph = loadGraph(new URL('../examples/ci', import.meta.url).pathname);
  assert.deepEqual(await check(graph), []);
  for (const attempt of [1, 2, 3, 0, 1.5, '1', undefined]) {
    const judge = fakeJudge('infra-failure');
    const result = await run(graph, { ci: { job: 'build', log: 'upstream connection dropped while downloading', files_changed: [], ...(attempt === undefined ? {} : { attempt }) } }, { judge });
    assert.equal(result.end, attempt === 1 || attempt === 2 ? 'retry-job' : 'human-triage');
    assert.equal(judge.calls.length, 1);
    assert.ok(result.steps.some((s) => s.node === 'infra-failure'));
  }
  const lint = await run(graph, { ci: { job: 'build', log: 'flake8 complained: E501 line too long', files_changed: [], attempt: 1 } }, { judge: fakeJudge('autofix-lint') });
  assert.equal(lint.end, 'autofix-lint');
  const security = await run(graph, { ci: { job: 'build', log: 'GitHub token leaked; download failed ETIMEDOUT', files_changed: [], attempt: 1 }, stub: { ask: 'no' } }, { judge: fakeJudge('retry-job') });
  assert.equal(security.end, 'human-triage');
  assert.equal(security.calls, 0);
  for (const log of [
    'No token leaked. The worker failed for an unknown reason.',
    'The passing test expected the text "ESLint" and "ETIMEDOUT"; the job failed from out of memory.',
    'The documentation mentions lockfile, but the failure is unrelated.',
    'A passing fixture quoted "FAIL src/sample.test.ts"; actual failure was out of memory.',
  ]) {
    const judge = fakeJudge('human-triage');
    const result = await run(graph, { ci: { job: 'build', log, files_changed: [], attempt: 1 } }, { judge });
    assert.equal(result.end, 'human-triage');
    assert.equal(judge.calls.length, 1);
    assert.equal(result.steps.some((s) => ['ask-security', 'check-flaky'].includes(s.node)), false);
  }
});

test('approval identity and prompt distinguish tasks with the same amount or job', () => {
  const support = loadGraph(new URL('../examples/triage', import.meta.url).pathname);
  const ci = loadGraph(new URL('../examples/ci', import.meta.url).pathname);
  const refundA = notifyRequest(support.nodes['ask-approval'], { ticket: { body: 'Refund order 11', amount: 900 } });
  const refundB = notifyRequest(support.nodes['ask-approval'], { ticket: { body: 'Refund order 12', amount: 900 } });
  assert.notEqual(refundA.idempotencyKey, refundB.idempotencyKey);
  assert.match(refundA.body.prompt, /Refund order 11/);
  const secretA = notifyRequest(ci.nodes['ask-security'], { ci: { job: 'build', log: 'GitHub token leaked' } });
  const secretB = notifyRequest(ci.nodes['ask-security'], { ci: { job: 'build', log: 'API token leaked' } });
  assert.notEqual(secretA.idempotencyKey, secretB.idempotencyKey);
  assert.match(secretA.body.prompt, /GitHub token leaked/);
});

test('starter does not fast-route quoted intents or bugs containing an order number', async () => {
  const graph = loadGraph(new URL('../packages/wayfile/templates/agent', import.meta.url).pathname);
  const responses = [];
  const skill = async (_graph, _node, state) => { responses.push(state.message.text); return { text: 'Here is a reply.', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } }; };
  const quotedJudge = fakeJudge('draft-reply');
  const quoted = await run(graph, { message: { text: 'The FAQ mentions unsubscribe, but I only need the support hours.' } }, { judge: quotedJudge, skill });
  assert.equal(quoted.end, 'done');
  assert.equal(quotedJudge.calls.length, 1);
  assert.equal(quoted.steps.some((s) => s.node === 'unsubscribe'), false);
  assert.equal(responses.length, 1);

  const bug = { title: 'Order screen crashes', observed: 'The app closes when an order is opened.', reproductionSteps: ['Open Orders', 'Tap order #12'], missingDetails: ['App version'] };
  const result = await run(graph, { message: { text: 'Viewing order #12 crashes the app: open Orders, tap the order.' } }, {
    judge: fakeJudge('bug-report'),
    skill: makeSkill(async () => ({ text: JSON.stringify(bug), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } })),
  });
  assert.equal(result.end, 'done');
  assert.deepEqual(result.state.bug.summary, bug);
  assert.deepEqual(result.steps.map((s) => s.node), ['start', 'bug-report', 'done']);
  assert.equal(result.calls, 2);
});
