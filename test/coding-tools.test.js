import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodingTools } from '../apps/waycode/src/coding-tools.js';
import { ToolError } from '../packages/wayfile/src/tools.js';

async function fixture(t, files = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'wayfile-coding-tools-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  for (const [path, value] of Object.entries(files)) {
    const target = join(workspace, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, value);
  }
  return workspace;
}

function registry(options) {
  const created = createCodingTools(options);
  return { ...created, byName: new Map(created.tools.map((tool) => [tool.name, tool])) };
}

const call = (tools, name, args, context) => tools.byName.get(name).execute(args, context);
const toolCode = (expected) => (error) => error instanceof ToolError && error.code === expected;
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

test('registry reuses scoped project tools and enforces write and shell switches', async (t) => {
  const workspace = await fixture(t, { 'src/a.js': 'const answer = 42;\n' });
  const readOnly = registry({ workspace, allowWrite: false, allowShell: false });
  t.after(() => readOnly.close());
  assert.deepEqual(readOnly.tools.map(({ name }) => name), [
    'list-files', 'read-file', 'search-files', 'check-url',
  ]);
  assert.equal((await call(readOnly, 'read-file', { path: 'src/a.js' })).text, 'const answer = 42;\n');
  await assert.rejects(call(readOnly, 'check-url', { url: 'http://example.com' }), toolCode('SCOPE'));

  const writable = registry({ workspace, allowShell: false });
  t.after(() => writable.close());
  assert.ok(writable.byName.has('write-file'));
  assert.equal(writable.byName.has('run-command'), false);
  assert.equal(writable.byName.has('start-process'), false);
  await call(writable, 'write-file', { path: 'new.txt', content: 'local only' });
  assert.equal(await readFile(join(workspace, 'new.txt'), 'utf8'), 'local only');
});

test('run-command uses workspace cwd, preserves nonzero evidence, sanitizes env, and bounds redacted output', async (t) => {
  const workspace = await fixture(t);
  const saved = process.env.WAYFILE_TEST_SECRET_TOKEN;
  process.env.WAYFILE_TEST_SECRET_TOKEN = 'synthetic-environment-secret';
  const tools = registry({ workspace });
  t.after(async () => {
    await tools.close();
    if (saved === undefined) delete process.env.WAYFILE_TEST_SECRET_TOKEN;
    else process.env.WAYFILE_TEST_SECRET_TOKEN = saved;
  });

  const pwd = await call(tools, 'run-command', { command: 'pwd' });
  assert.equal(pwd.exitCode, 0);
  assert.equal(pwd.stdout.trim(), await realpath(workspace));
  assert.equal(pwd.stderr, '');
  assert.deepEqual(Object.keys(pwd).sort(), ['exitCode', 'stderr', 'stdout']);

  const failed = await call(tools, 'run-command', { command: 'printf out; printf err >&2; exit 7' });
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.stdout, 'out');
  assert.equal(failed.stderr, 'err');

  const envOutput = await call(tools, 'run-command', {
    command: 'printf "%s|%s|%s" "${WAYFILE_TEST_SECRET_TOKEN-absent}" "$HOME" "$PATH"',
  });
  assert.match(envOutput.stdout, /^absent\|[^|]+\|[^|]+$/);
  assert.doesNotMatch(envOutput.stdout, /synthetic-environment-secret/);

  const redacted = await call(tools, 'run-command', {
    command: "printf '%s' 'API_KEY=synthetic-secret-value AWS_SECRET_ACCESS_KEY=synthetic-aws-secret Authorization: Bearer synthetic-bearer-secret github_pat_abcdefghijklmnopqrstuvwxyz1234567890'",
  });
  assert.doesNotMatch(redacted.stdout, /synthetic-secret-value|synthetic-aws-secret|synthetic-bearer-secret|github_pat_/);
  assert.match(redacted.stdout, /REDACTED/);

  const noisy = await call(tools, 'run-command', { command: 'yes x | head -c 40000' });
  assert.ok(Buffer.byteLength(noisy.stdout) + Buffer.byteLength(noisy.stderr) <= 16 * 1024);
  assert.ok(noisy.stdout.length > 0);
  await assert.rejects(call(tools, 'run-command', { command: 'true', timeout_ms: 300_001 }), toolCode('INVALID_ARGS'));
  await assert.rejects(call(tools, 'run-command', { command: 'sleep 10', timeout_ms: 30 }), toolCode('TIMEOUT'));
});

test('host tools reject publishing commands and enforce the four process limit', async (t) => {
  const workspace = await fixture(t);
  const events = [];
  const tools = registry({ workspace, onEvent: (event) => events.push(event) });
  t.after(() => tools.close());
  await assert.rejects(call(tools, 'run-command', { command: 'git push origin main' }), toolCode('PUBLICATION_BLOCKED'));
  await assert.rejects(call(tools, 'run-command', { command: 'git -C . push origin main' }), toolCode('PUBLICATION_BLOCKED'));
  await assert.rejects(call(tools, 'start-process', { command: 'gh repo create example' }), toolCode('PUBLICATION_BLOCKED'));
  await assert.rejects(call(tools, 'start-process', { command: 'gh --repo owner/name repo create example' }), toolCode('PUBLICATION_BLOCKED'));

  const started = [];
  for (let index = 0; index < 4; index++) {
    started.push(await call(tools, 'start-process', { command: 'sleep 10' }));
  }
  assert.equal(tools.processes.size, 4);
  await assert.rejects(call(tools, 'start-process', { command: 'sleep 10' }), toolCode('PROCESS_LIMIT'));
  const status = await call(tools, 'process-status', { id: started[0].id });
  assert.equal(status.id, started[0].id);
  assert.equal(status.status, 'running');
  assert.equal(status.stdout, '');
  const stopped = await call(tools, 'stop-process', { id: started[0].id });
  assert.equal(stopped.status, 'stopped');
  assert.ok(events.some((event) => event.type === 'process-started'));
  assert.ok(events.some((event) => event.type === 'process-stopped'));
});

test('background processes persist until stopped or registry close, then process groups are cleaned up', async (t) => {
  const workspace = await fixture(t);
  const tools = registry({ workspace });
  const started = await call(tools, 'start-process', { command: "printf 'background-ready\\n'; sleep 30 & wait" });
  await wait(40);
  assert.equal(tools.processes.get(started.id).status, 'running');
  assert.match((await call(tools, 'process-status', { id: started.id })).stdout, /background-ready/);
  await tools.close();
  assert.equal(tools.processes.get(started.id).status, 'stopped');
  await assert.rejects(call(tools, 'process-status', { id: started.id }), toolCode('CLOSED'));
});

test('run-command cancellation terminates its process group', async (t) => {
  const workspace = await fixture(t);
  const tools = registry({ workspace });
  t.after(() => tools.close());
  const controller = new AbortController();
  const pending = call(tools, 'run-command', { command: 'sleep 30' }, { signal: controller.signal });
  await wait(40);
  controller.abort();
  await assert.rejects(pending, toolCode('ABORTED'));
});

test('check-url polls one explicit local URL and never tries a different port or host', async (t) => {
  const workspace = await fixture(t);
  const tools = registry({ workspace, allowShell: false });
  t.after(() => tools.close());
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/ready' });
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('readiness body must not escape');
    }
  });
  t.after(() => new Promise((resolveClose) => server.close(() => resolveClose())));
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const writable = registry({ workspace });
  t.after(() => writable.close());
  await assert.rejects(call(writable, 'start-process', { command: 'sleep 30', port: address.port }), toolCode('PORT_OCCUPIED'));
  assert.equal(writable.processes.size, 0);
  const ready = await call(tools, 'check-url', { url: `http://127.0.0.1:${address.port}/ready`, timeout_ms: 2000 });
  assert.equal(ready.ready, true);
  assert.equal(ready.status, 200);
  assert.equal(ready.port, address.port);
  assert.ok(ready.attempts >= 1);
  assert.doesNotMatch(JSON.stringify(ready), /readiness body/);
  const redirected = await call(tools, 'check-url', { url: `http://127.0.0.1:${address.port}/redirect`, timeout_ms: 2000 });
  assert.equal(redirected.ready, true);

  const closedPort = await call(tools, 'check-url', { url: 'http://127.0.0.1:1/', timeout_ms: 60 });
  assert.equal(closedPort.ready, false);
  assert.equal(closedPort.status, null);
  await assert.rejects(call(tools, 'check-url', { url: 'http://example.com:3000/' }), toolCode('SCOPE'));
});

test('top-level cancellation closes the registry and kills managed processes', async (t) => {
  const workspace = await fixture(t);
  const controller = new AbortController();
  const tools = registry({ workspace, signal: controller.signal });
  const started = await call(tools, 'start-process', { command: 'sleep 30' });
  controller.abort();
  await tools.close();
  assert.equal(tools.processes.get(started.id).status, 'stopped');
});

test('configuration validates workspace and opt-in switches', async (t) => {
  const workspace = await fixture(t);
  assert.throws(() => createCodingTools(), /explicit workspace/);
  assert.throws(() => createCodingTools({ workspace, allowWrite: 'yes' }), /booleans/);
  assert.throws(() => createCodingTools({ workspace, allowShell: 1 }), /booleans/);
  assert.throws(() => createCodingTools({ workspace, onEvent: true }), /onEvent/);
});
