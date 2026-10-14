import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('packed CLI creates and executes a program with provider protocol and persists the session', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'waycode-package-'));
  try {
    const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', root], { encoding: 'utf8', timeout: 10000 });
    assert.equal(packed.status, 0, packed.stderr);
    const manifest = JSON.parse(packed.stdout)[0];
    assert.ok(manifest.files.some(file => file.path === 'apps/waycode/agent/develop.md'));
    assert.ok(!manifest.files.some(file => file.path === '.env'));
    const extracted = spawnSync('tar', ['-xzf', join(root, manifest.filename), '-C', root], { encoding: 'utf8', timeout: 5000 });
    assert.equal(extracted.status, 0, extracted.stderr);
    const installed = spawnSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: join(root, 'package'), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(installed.status, 0, installed.stderr);
    const executable = join(root, 'waycode');
    await symlink(join(root, 'package/apps/waycode/bin/waycode.js'), executable);
    const help = spawnSync(process.execPath, [executable, '--help'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /waycode chat/);
    const workspace = join(root, 'project'), sessions = join(root, 'sessions');
    await mkdir(workspace);
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }));
    await writeFile(join(workspace, 'package-lock.json'), '{}');
    await writeFile(join(workspace, 'check.mjs'), `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['hello.js'], { encoding: 'utf8' });
assert.equal(result.status, 0);
assert.equal(result.stdout.trim(), 'Hello, Wayfile');
console.log('program executed successfully');
`);
    const preload = join(root, 'provider-mock.mjs');
    await writeFile(preload, `let calls = 0;
globalThis.fetch = async (url, request) => {
  if (String(url) !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('Unexpected network access');
  const input = JSON.parse(request.body);
  if (!input.messages.some(message => typeof message.content === 'string' && message.content.includes('Authenticated user request:'))) throw new Error('Missing user request');
  calls++;
  let message;
  if (calls === 1) message = { role: 'assistant', content: null, tool_calls: [{ id: 'create-hello', type: 'function', function: { name: 'write-file', arguments: JSON.stringify({ path: 'hello.js', content: 'console.log("Hello, Wayfile");\\n' }) } }] };
  else if (calls === 2) message = { role: 'assistant', content: JSON.stringify({ status: 'ready', summary: 'Created the program.', question: null, changed_files: ['hello.js'] }) };
  else if (calls === 3) message = { role: 'assistant', content: JSON.stringify({ status: 'completed', answer: 'Program executed successfully.', question: null }) };
  else throw new Error('Unexpected model replay');
  return { ok: true, status: 200, json: async () => ({ model: 'mock-model', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 }, choices: [{ message, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] }) };
};
`);
    const invocation = spawnSync(process.execPath, ['--import', preload, executable, 'run',
      '--workspace', workspace, '--session-dir', sessions, '--session', 'package-smoke', '--message', 'Create a hello program and verify it.'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, OPENROUTER_API_KEY: 'offline-test-key', ANTHROPIC_API_KEY: '', WAYFILE_MODEL: 'mock-model' },
    });
    assert.equal(invocation.status, 0, invocation.stderr + invocation.stdout);
    assert.match(invocation.stdout, /"status": "completed"/);
    assert.match(invocation.stdout, /program executed successfully/);
    assert.equal(await readFile(join(workspace, 'hello.js'), 'utf8'), 'console.log("Hello, Wayfile");\n');
    const saved = JSON.parse(await readFile(join(sessions, 'package-smoke.json'), 'utf8'));
    assert.equal(saved.history.length, 2);
    assert.equal(saved.turns[0].result.verified, true);
    const trace = JSON.parse(await readFile(saved.turns[0].result.trace, 'utf8'));
    assert.ok(trace.events.some(event => event.type === 'tool.completed' && event.name === 'write-file'));
    await rm(join(root, 'package/package-lock.json'));
    const envNames = ['.env.local', '.envrc', '.env-prod', '.env_local', '.ENV'];
    for (const name of envNames) await writeFile(join(root, 'package/apps/waycode/src', name), 'SYNTHETIC_SETUP_SECRET=local-only\n');
    const setup = spawnSync(process.execPath, [join(root, 'package/scripts/setup-agent.mjs'), join(root, 'packed-agent')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(await readFile(join(root, 'packed-agent/.env'), 'utf8'), /PASTE_YOUR_KEY_HERE/);
    for (const name of envNames) await assert.rejects(stat(join(root, 'packed-agent/runtime/apps/waycode/src', name)), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Protects: fresh agent setup creates an isolated, installable runtime and cannot overwrite a configured agent.
// Failure: a stale monorepo path or unsafe destination handling breaks first launch or destroys local keys.
// Observe: runtime greeting, empty workspace, private placeholder, and unchanged files after rejected rerun.
// Seam: none.
test('agent setup creates a runnable folder and refuses to overwrite it', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'waycode-setup-'));
  try {
    const destination = join(root, 'agent with spaces');
    const setup = spawnSync(process.execPath, ['scripts/setup-agent.mjs', destination], { encoding: 'utf8', timeout: 10000 });
    assert.equal(setup.status, 0, setup.stderr);
    assert.deepEqual(await readdir(join(destination, 'site')), []);
    assert.match(await readFile(join(destination, '.env'), 'utf8'), /PASTE_YOUR_KEY_HERE/);
    assert.equal((await stat(join(destination, '.env'))).mode & 0o777, 0o600);
    await writeFile(join(destination, '.env'), 'OPENROUTER_API_KEY=offline-fixture-key\n');
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    const greeting = spawnSync(join(destination, 'start.sh'), [], { env, input: 'hi\n', encoding: 'utf8', timeout: 10000 });
    assert.equal(greeting.status, 0, greeting.stderr);
    assert.match(greeting.stdout, /Hey! I'm here and ready to help/);
    const rerun = spawnSync(process.execPath, ['scripts/setup-agent.mjs', destination], { encoding: 'utf8', timeout: 5000 });
    assert.equal(rerun.status, 1);
    assert.match(rerun.stderr, /will not be overwritten/);
    assert.equal(await readFile(join(destination, '.env'), 'utf8'), 'OPENROUTER_API_KEY=offline-fixture-key\n');
    const emptyBin = join(root, 'empty-bin');
    await mkdir(emptyBin);
    const failedDestination = join(root, 'failed-agent');
    const failed = spawnSync(process.execPath, ['scripts/setup-agent.mjs', failedDestination], { env: { ...process.env, PATH: emptyBin }, encoding: 'utf8', timeout: 5000 });
    assert.equal(failed.status, 1);
    await assert.rejects(stat(failedDestination), { code: 'ENOENT' });
    assert.equal((await readdir(root)).some(name => name.startsWith('.waycode-setup-')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
