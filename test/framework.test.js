import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../src/parse.js';
import { run } from '../src/run.js';
import { check } from '../src/check.js';
import { makeSkill, judgePrompt } from '../src/model.js';
import { tmpGraph, node } from './helpers.js';

const cli = new URL('../bin/wayfile.js', import.meta.url).pathname;
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
  const tool = new URL('../templates/agent/tools/lookup-order.mjs', import.meta.url).pathname;
  const out = execFileSync(tool, { input: '{"message":{"text":"order #7"}}', encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { set: { 'order.status': 'shipped' } });
  assert.ok(readFileSync(tool, 'utf8').startsWith('#!/usr/bin/env node'));
});
