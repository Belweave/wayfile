import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const invoke = (...args) => spawnSync(process.execPath, ['apps/waycode/bin/waycode.js', ...args], {
  encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: '' },
});
test('waycode help is available without model configuration', () => {
  const r = invoke('--help');
  assert.equal(r.status, 0); assert.match(r.stdout, /waycode chat/);
});
test('waycode rejects missing workspace before starting', () => {
  const r = invoke('chat');
  assert.equal(r.status, 1); assert.match(r.stderr, /--workspace/);
});
test('waycode rejects missing credentials with actionable setup', () => {
  const r = invoke('chat', '--workspace', '/tmp/waycode-should-not-create');
  assert.equal(r.status, 1); assert.match(r.stderr, /OPENROUTER_API_KEY/);
});
test('waycode rejects missing task and unknown flags', () => {
  assert.equal(invoke('run', '--workspace', '.').status, 1);
  assert.equal(invoke('chat', '--typo').status, 1);
});
