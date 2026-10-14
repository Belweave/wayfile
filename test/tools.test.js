import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir, chmod, stat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectTools, ToolError } from '../packages/wayfile/src/tools.js';

async function fixture(t, files = {}) {
  const base = await mkdtemp(join(tmpdir(), 'wayfile-tool-test-'));
  const workspace = join(base, 'project'), outside = join(base, 'outside');
  await mkdir(workspace); await mkdir(outside);
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const [path, value] of Object.entries(files)) { await mkdir(join(workspace, path, '..'), { recursive: true }); await writeFile(join(workspace, path), value); }
  return { workspace, outside };
}
const registry = (options) => new Map(createProjectTools(options).map((tool) => [tool.name, tool]));
const execute = (tools, name, args, context = {}) => tools.get(name).execute(args, context);
const code = (expected) => (error) => { assert.ok(error instanceof ToolError); assert.equal(error.code, expected); return true; };

test('read/list/literal search return bounded project evidence with source locations', async (t) => {
  const { workspace } = await fixture(t, { 'README.md': 'First\nNeedle .* literal\n', 'src/a.js': 'const needle = 42;\n', 'src/b.js': 'No match\n' });
  const tools = registry({ workspace });
  assert.deepEqual([...tools.keys()], ['list-files', 'read-file', 'search-files']);
  const listed = await execute(tools, 'list-files', { path: '.', recursive: true });
  assert.deepEqual(listed.entries.map((entry) => entry.path), ['README.md', 'src', 'src/a.js', 'src/b.js']);
  const read = await execute(tools, 'read-file', { path: 'src/a.js' });
  assert.equal(read.text, 'const needle = 42;\n'); assert.equal(read.sha256.length, 64); assert.equal(read.bytes, 19);
  const found = await execute(tools, 'search-files', { query: 'needle', case_sensitive: false });
  assert.deepEqual(found.matches.map(({ path, line }) => ({ path, line })), [{ path: 'README.md', line: 2 }, { path: 'src/a.js', line: 1 }]);
  const literal = await execute(tools, 'search-files', { query: '.*' });
  assert.deepEqual(literal.matches.map((match) => match.path), ['README.md']);
});

test('path traversal, absolute paths and symlink escapes are rejected for every access', async (t) => {
  const { workspace, outside } = await fixture(t, { 'safe.txt': 'safe' });
  await writeFile(join(outside, 'secret.txt'), 'outside-secret-marker');
  await symlink(join(outside, 'secret.txt'), join(workspace, 'file-link'));
  await symlink(outside, join(workspace, 'dir-link'));
  const tools = registry({ workspace, allowWrite: true });
  for (const path of ['../outside/secret.txt', join(workspace, 'safe.txt'), 'file-link', 'dir-link/secret.txt']) await assert.rejects(execute(tools, 'read-file', { path }), code('SCOPE'));
  for (const path of ['../outside', 'dir-link']) await assert.rejects(execute(tools, 'list-files', { path }), code('SCOPE'));
  await assert.rejects(execute(tools, 'search-files', { query: 'secret', path: 'dir-link' }), code('SCOPE'));
  for (const path of ['../outside/secret.txt', 'file-link', 'dir-link/secret.txt']) await assert.rejects(execute(tools, 'write-file', { path, content: 'changed', create_dirs: true }), code('SCOPE'));
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside-secret-marker');
});

test('traversal does not follow symlink loops and writes reject even in-scope symlink parents', async (t) => {
  const { workspace } = await fixture(t, { 'inside/file.txt': 'inside' });
  await symlink(join(workspace, 'inside'), join(workspace, 'alias'));
  await symlink(workspace, join(workspace, 'inside/loop'));
  const tools = registry({ workspace, allowWrite: true });
  const listed = await execute(tools, 'list-files', { recursive: true });
  assert.ok(listed.entries.some((entry) => entry.path === 'alias' && entry.type === 'symlink'));
  assert.equal(listed.entries.filter((entry) => entry.path.endsWith('file.txt')).length, 1);
  assert.equal((await execute(tools, 'read-file', { path: 'alias/file.txt' })).text, 'inside');
  await assert.rejects(execute(tools, 'write-file', { path: 'alias/file.txt', content: 'wrong' }), code('SCOPE'));
  assert.equal(await readFile(join(workspace, 'inside/file.txt'), 'utf8'), 'inside');
});

test('protected files never enter direct read/write or search results; listing names is allowed', async (t) => {
  const marker = 'synthetic-service-credential';
  const { workspace } = await fixture(t, { 'public.txt': 'ordinary data', '.env': marker, '.env.local': marker, '.git/config': marker, '.ssh/key': marker, '.aws/credentials': marker });
  await symlink(join(workspace, '.env'), join(workspace, 'ordinary-looking-link'));
  const tools = registry({ workspace, allowWrite: true });
  for (const path of ['.env', '.env.local', '.git/config', '.ssh/key', '.aws/credentials', 'ordinary-looking-link']) await assert.rejects(execute(tools, 'read-file', { path }), code('PROTECTED_PATH'));
  await assert.rejects(execute(tools, 'write-file', { path: '.env', content: 'overwrite' }), code('PROTECTED_PATH'));
  const searched = await execute(tools, 'search-files', { query: marker });
  assert.deepEqual(searched.matches, []);
  assert.ok(searched.skipped.some((entry) => entry.path === '.env' && entry.reason === 'protected'));
  assert.doesNotMatch(JSON.stringify(searched), /synthetic-service-credential/);
  const listed = await execute(tools, 'list-files', {});
  assert.ok(listed.entries.some((entry) => entry.path === '.env'));
  assert.equal(await readFile(join(workspace, '.env'), 'utf8'), marker);
  const trusted = registry({ workspace, allowSensitiveFiles: true });
  assert.equal((await execute(trusted, 'read-file', { path: '.env' })).text, marker);
  const restricted = registry({ workspace, allowSensitiveFiles: true, denyPaths: ['public.txt'] });
  await assert.rejects(execute(restricted, 'read-file', { path: 'public.txt' }), code('PROTECTED_PATH'));
});

test('read/scan/result/depth limits fail explicitly and UTF-8 byte limits do not coerce binary data', async (t) => {
  const { workspace } = await fixture(t, { 'one.txt': 'needle\nneedle\n', 'two.txt': 'abcdef', 'utf8.txt': '🙂', 'binary.dat': Buffer.from([255, 254]), 'deep/a/b/file.txt': 'deep' });
  const tools = registry({ workspace, maxReadBytes: 5 });
  await assert.rejects(execute(tools, 'read-file', { path: 'two.txt' }), code('OUTPUT_LIMIT'));
  await assert.rejects(execute(tools, 'read-file', { path: 'binary.dat' }), code('INVALID_OUTPUT'));
  await assert.rejects(execute(registry({ workspace, maxReadBytes: 3 }), 'read-file', { path: 'utf8.txt' }), code('OUTPUT_LIMIT'));
  await assert.rejects(execute(registry({ workspace, maxResults: 1 }), 'list-files', {}), code('OUTPUT_LIMIT'));
  await assert.rejects(execute(registry({ workspace, maxResults: 1 }), 'search-files', { query: 'needle', path: 'one.txt' }), code('OUTPUT_LIMIT'));
  await assert.rejects(execute(registry({ workspace, maxFiles: 1 }), 'list-files', {}), code('OUTPUT_LIMIT'));
  await assert.rejects(execute(registry({ workspace, maxDepth: 1 }), 'list-files', { path: 'deep', recursive: true }), code('OUTPUT_LIMIT'));
});

test('missing paths are recoverable; invalid arguments and scopes are not', async (t) => {
  const { workspace } = await fixture(t);
  const tools = registry({ workspace });
  await assert.rejects(execute(tools, 'read-file', { path: 'missing.txt' }), (error) => { assert.equal(error.code, 'ENOENT'); assert.equal(error.recoverable, true); return true; });
  await assert.rejects(execute(tools, 'read-file', { path: 'missing', ignored: true }), code('INVALID_ARGS'));
  await assert.rejects(execute(tools, 'search-files', { query: '' }), code('INVALID_ARGS'));
});

test('writes require opt-in and atomically create/replace files while preserving modes', async (t) => {
  const { workspace } = await fixture(t, { 'existing.txt': 'before' });
  assert.equal(registry({ workspace }).has('write-file'), false);
  const tools = registry({ workspace, allowWrite: true });
  await chmod(join(workspace, 'existing.txt'), 0o666);
  const before = await execute(tools, 'read-file', { path: 'existing.txt' });
  const written = await execute(tools, 'write-file', { path: 'existing.txt', content: 'after', expected_sha256: before.sha256 });
  assert.equal(written.written, true); assert.equal(written.bytes, 5); assert.equal(written.sha256.length, 64);
  assert.equal(await readFile(join(workspace, 'existing.txt'), 'utf8'), 'after');
  assert.equal((await stat(join(workspace, 'existing.txt'))).mode & 0o777, 0o666);
  await execute(tools, 'write-file', { path: 'new/dir/file.txt', content: 'new', create_dirs: true });
  assert.equal(await readFile(join(workspace, 'new/dir/file.txt'), 'utf8'), 'new');
  assert.ok((await readdir(workspace)).every((name) => !name.endsWith('.tmp')));
});

test('guarded writes reject stale evidence, oversized UTF-8 data and aborted commits', async (t) => {
  const { workspace } = await fixture(t, { 'file.txt': 'before' });
  const tools = registry({ workspace, allowWrite: true, maxWriteBytes: 10 });
  const read = await execute(tools, 'read-file', { path: 'file.txt' });
  await writeFile(join(workspace, 'file.txt'), 'external');
  await assert.rejects(execute(tools, 'write-file', { path: 'file.txt', content: 'new', expected_sha256: read.sha256 }), code('CONFLICT'));
  assert.equal(await readFile(join(workspace, 'file.txt'), 'utf8'), 'external');
  await assert.rejects(execute(tools, 'write-file', { path: 'file.txt', content: '🙂'.repeat(4) }), code('OUTPUT_LIMIT'));
  const controller = new AbortController(); controller.abort(new Error('stopped'));
  await assert.rejects(execute(tools, 'write-file', { path: 'file.txt', content: 'new' }, { signal: controller.signal }), /stopped/);
  assert.equal(await readFile(join(workspace, 'file.txt'), 'utf8'), 'external');
});

test('optional authorization gates every access and cannot bypass project scope', async (t) => {
  const { workspace } = await fixture(t, { 'file.txt': 'safe' });
  const approvals = [];
  const tools = registry({ workspace, allowWrite: true, authorize: async (request) => { approvals.push(request); return request.node?.id === 'allowed'; } });
  await assert.rejects(execute(tools, 'read-file', { path: 'file.txt' }, { node: { id: 'denied' } }), code('DENIED'));
  const result = await execute(tools, 'read-file', { path: 'file.txt' }, { node: { id: 'allowed' } });
  assert.equal(result.text, 'safe'); assert.equal(approvals[0].tool, 'read-file');
  await assert.rejects(execute(tools, 'write-file', { path: '../escape', content: 'bad' }, { node: { id: 'allowed' } }), code('SCOPE'));
});

test('shell requires explicit registration and authorization, uses cwd, and returns nonzero diagnostics', async (t) => {
  const { workspace } = await fixture(t);
  assert.equal(registry({ workspace }).has('shell'), false);
  assert.throws(() => registry({ workspace, allowShell: true }), /authorize callback/);
  const seen = [];
  const tools = registry({ workspace, allowShell: true, authorize: async (request) => { seen.push(request); return true; } });
  const cwd = await execute(tools, 'shell', { command: 'pwd' });
  assert.equal(cwd.stdout.trim(), await realpath(workspace));
  const failed = await execute(tools, 'shell', { command: 'printf out; printf err >&2; exit 7' });
  assert.deepEqual(failed, { exitCode: 7, stdout: 'out', stderr: 'err' });
  assert.equal(seen.length, 2); assert.equal(seen[1].tool, 'shell');
  const denied = registry({ workspace, allowShell: true, authorize: async () => false });
  await assert.rejects(execute(denied, 'shell', { command: 'printf unexpected' }), code('DENIED'));
});

test('shell sanitized environment excludes service credentials unless explicitly supplied', async (t) => {
  const { workspace } = await fixture(t);
  const saved = process.env.WAYFILE_TEST_SERVICE_TOKEN;
  process.env.WAYFILE_TEST_SERVICE_TOKEN = 'synthetic-environment-secret';
  try {
    const tools = registry({ workspace, allowShell: true, authorize: async () => true });
    const result = await execute(tools, 'shell', { command: 'env' });
    assert.doesNotMatch(result.stdout, /WAYFILE_TEST_SERVICE_TOKEN|synthetic-environment-secret/);
    const trusted = registry({ workspace, allowShell: true, authorize: async () => true, env: { PATH: process.env.PATH, WAYFILE_TEST_SERVICE_TOKEN: 'explicit-trusted-value' } });
    const explicit = await execute(trusted, 'shell', { command: 'printf "%s" "$WAYFILE_TEST_SERVICE_TOKEN"' });
    assert.equal(explicit.stdout, 'explicit-trusted-value');
  } finally { if (saved === undefined) delete process.env.WAYFILE_TEST_SERVICE_TOKEN; else process.env.WAYFILE_TEST_SERVICE_TOKEN = saved; }
});

test('shell time and combined-output limits terminate the process instead of truncating success', async (t) => {
  const { workspace } = await fixture(t);
  const slow = registry({ workspace, allowShell: true, authorize: async () => true, timeoutMs: 20 });
  const start = performance.now();
  await assert.rejects(execute(slow, 'shell', { command: 'sleep 10' }), code('TIMEOUT'));
  assert.ok(performance.now() - start < 2000);
  const noisy = registry({ workspace, allowShell: true, authorize: async () => true, maxShellBytes: 10 });
  await assert.rejects(execute(noisy, 'shell', { command: 'printf 123456; printf 123456 >&2' }), code('OUTPUT_LIMIT'));
});

test('invalid tool configuration fails before any operation', async (t) => {
  const { workspace } = await fixture(t);
  assert.throws(() => createProjectTools(), /explicit workspace/);
  assert.throws(() => createProjectTools({ workspace, maxReadBytes: 0 }), /maxReadBytes/);
  assert.throws(() => createProjectTools({ workspace, denyPaths: ['../outside'] }), /denyPaths/);
  assert.throws(() => createProjectTools({ workspace, env: { KEY: undefined } }), /string map/);
});
