import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpGraph, node } from './helpers.js';

const cli = new URL('../packages/wayfile/bin/wayfile.js', import.meta.url).pathname;
const env = { ...process.env, OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: '' };

test('CLI preflight never executes examples or unvisited scripts before the requested task', () => {
  const example = '# Action\n```example\ninput: {}\nexpect: done\n```';
  const dir = tmpGraph({
    'start.md': node('entry: true\nkind: script\nscript: action.sh', ['- otherwise → [[done]]'], example),
    'unvisited.md': node('kind: script\nscript: action.sh', ['- otherwise → [[done]]'], example),
    'done.md': node('kind: end'),
    'action.sh': '#!/bin/sh\necho visited >> execution.log\necho \'{"set":{}}\'\n',
  });
  const output = JSON.parse(execFileSync('node', [cli, 'run', dir, '--input', '{}'], { env, encoding: 'utf8' }));
  assert.equal(output.status, 'completed');
  assert.equal(readFileSync(join(dir, 'execution.log'), 'utf8'), 'visited\n');
});

test('CLI host shell needs its explicit capability flag and records the tool loop', () => {
  const dir = tmpGraph({
    'start.md': node('entry: true\nkind: harness\nneeds: [question]\nsets: [answer]\ntools: [shell]\nmax_turns: 2', ['- otherwise → [[done]]'], '# Inspect\nUse the shell to check the fixture.'),
    'done.md': node('kind: end'),
    'mock-provider.mjs': `let calls = 0;
globalThis.fetch = async () => Response.json({ model: 'test-model', usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 }, choices: [{
  finish_reason: ++calls === 1 ? 'tool_calls' : 'stop',
  message: calls === 1 ? { content: null, tool_calls: [{ id: 'tool-1', function: { name: 'shell', arguments: JSON.stringify({ command: 'printf wayfile-harness' }) } }] } : { content: 'Fixture checked.' },
}] });`,
  });
  const args = ['--import', join(dir, 'mock-provider.mjs'), cli, 'run', dir, '--input', '{"question":"Inspect"}'];
  const testEnv = { ...env, OPENROUTER_API_KEY: 'fake-local-test', WAYFILE_MAX_USD: '3' };
  assert.throws(() => execFileSync('node', args, { env: testEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), (error) => {
    assert.match(error.stderr, /tool is not registered: shell/);
    assert.match(error.stderr, /"calls":0/);
    return true;
  });
  const result = JSON.parse(execFileSync('node', [...args, '--allow-shell'], { env: testEnv, encoding: 'utf8' }));
  assert.equal(result.state.answer, 'Fixture checked.');
  assert.equal(result.calls, 2);
  assert.equal(result.toolCalls, 1);
  assert.match(readFileSync(result.trace, 'utf8'), /wayfile-harness/);
});
