import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planRepositoryPublication, publishRepository, PublishError } from '../apps/waycode/src/coding-publish.js';

const workspaces = new Set();

async function workspace() {
  const path = await mkdtemp(join(tmpdir(), 'wayfile-publish-'));
  workspaces.add(path);
  return path;
}

test.afterEach(async () => {
  await Promise.all([...workspaces].map((path) => rm(path, { recursive: true, force: true })));
  workspaces.clear();
});

async function put(root, path, content) {
  const target = join(root, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
}

function ok(stdout = '', stderr = '') { return { code: 0, stdout, stderr }; }
function fail(stderr = '') { return { code: 1, stdout: '', stderr }; }

function noRepositoryExecutor(calls = []) {
  return async (request) => {
    calls.push(request);
    if (request.command === 'git' && request.args.join(' ') === 'rev-parse --show-toplevel') {
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
    }
    throw new Error(`unexpected command: ${request.command} ${request.args.join(' ')}`);
  };
}

test('plan is read-only, snapshots eligible files, and excludes local secrets and generated sessions', async () => {
  const root = await workspace();
  await put(root, 'README.md', 'A small app.\n');
  await put(root, 'src/main.js', 'export const ready = true;\n');
  await put(root, '.env', 'TOKEN=never-stage-me\n');
  await put(root, '.env.example', 'TOKEN=\n');
  await put(root, 'nested/.env.example/credentials.txt', 'opaque-local-secret\n');
  await put(root, 'node_modules/pkg/index.js', 'ignored dependency\n');
  await put(root, '.next/server/chunk.js', 'generated\n');
  await put(root, 'runs/session-1.json', '{"trace":true}\n');
  await put(root, 'sessions/agent.jsonl', 'trace\n');
  const calls = [];

  const plan = await planRepositoryPublication({ workspace: root, repo: 'sample-owner/sample-app', execute: noRepositoryExecutor(calls) });

  assert.deepEqual(plan.files.map(({ path }) => path), ['.env.example', 'README.md', 'src/main.js']);
  assert.equal(plan.workspace, await realpath(root));
  assert.match(plan.snapshot, /^[0-9a-f]{64}$/);
  assert.deepEqual(calls.map(({ args }) => args), [['rev-parse', '--show-toplevel']]);
  assert.ok(plan.excluded.some((item) => item.startsWith('.env')));
});

test('plan rejects credential-like content without revealing the credential', async () => {
  const root = await workspace();
  const token = 'ghp_' + 'a'.repeat(36);
  await put(root, '.env.example', `TOKEN=${token}\n`);
  const execute = noRepositoryExecutor();

  await assert.rejects(
    planRepositoryPublication({ workspace: root, repo: 'sample-owner/sample-app', execute }),
    (error) => error instanceof PublishError && error.code === 'SECRET_DETECTED' && !error.message.includes(token),
  );
});

test('explicit protected paths and invalid repository names are rejected', async () => {
  const root = await workspace();
  await put(root, '.env', 'TOKEN=local-only\n');
  await put(root, 'app.js', 'export default 1;\n');
  const execute = noRepositoryExecutor();

  await assert.rejects(planRepositoryPublication({ workspace: root, repo: 'owner/repo', files: ['.env'], execute }), { code: 'PROTECTED_PATH' });
  await assert.rejects(planRepositoryPublication({ workspace: root, repo: 'owner/repo', files: ['nested/.env.example/credentials.txt'], execute }), { code: 'PROTECTED_PATH' });
  await assert.rejects(planRepositoryPublication({ workspace: root, repo: 'https://github.com/owner/repo', execute }), { code: 'INVALID_INPUT' });
});

test('plan refuses a workspace nested inside a pre-existing parent repository', async () => {
  const parent = await workspace();
  const nested = join(parent, 'generated');
  await mkdir(nested);
  const execute = async ({ command, args }) => {
    if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return ok(parent);
    throw new Error('parent repository must be rejected before any additional Git operation');
  };

  await assert.rejects(planRepositoryPublication({ workspace: nested, repo: 'owner/repo', execute }), { code: 'PARENT_REPOSITORY' });
});

test('plan refuses a dirty repository at its exact root before reading or staging files', async () => {
  const root = await workspace();
  await put(root, 'src/app.js', 'ready\n');
  const execute = async ({ command, args }) => {
    if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return ok(root);
    if (command === 'git' && args[0] === 'status') return ok(' M README.md\n');
    throw new Error('dirty repository must be rejected before further Git calls');
  };

  await assert.rejects(planRepositoryPublication({ workspace: root, repo: 'owner/repo', execute }), { code: 'DIRTY_REPOSITORY' });
});

test('explicit publication can plan unstaged source edits but preserves a pre-existing index', async () => {
  const root = await workspace();
  await put(root, 'app.js', 'export const app = true;\n');
  let status = ' M app.js\n';
  const execute = async ({ args }) => {
    const command = args.join(' ');
    if (command === 'rev-parse --show-toplevel') return ok(root);
    if (args[0] === 'status') return ok(status);
    if (args[0] === 'symbolic-ref') return ok('main\n');
    if (command === 'rev-parse --verify HEAD') return ok('a'.repeat(40));
    if (args[0] === 'rev-list') return ok();
    if (command === 'remote') return ok();
    if (command === 'ls-files -z') return ok('app.js\0');
    if (args[0] === 'ls-files') return ok();
    throw new Error(`unexpected command ${command}`);
  };
  const plan = await planRepositoryPublication({ workspace: root, repo: 'owner/site', allowDirty: true, execute });
  assert.deepEqual(plan.files.map(f => f.path), ['app.js']);
  status = 'M  app.js\n';
  await assert.rejects(planRepositoryPublication({ workspace: root, repo: 'owner/site', allowDirty: true, execute }), { code: 'DIRTY_INDEX' });
});

test('publication cancellation fails before any command is executed', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled publication'));
  await assert.rejects(planRepositoryPublication({ workspace: await workspace(), repo: 'owner/site', signal: controller.signal,
    execute: async () => assert.fail('cancelled command must not execute'),
  }), /cancelled publication/);
});

test('verification is mandatory, recent, independent, and tied to the exact file snapshot', async () => {
  const root = await workspace();
  await put(root, 'app.js', 'export default true;\n');
  const fake = publicationExecutor(root, { workingFiles: ['app.js'] });
  const execute = fake.execute;
  const plan = await planRepositoryPublication({ workspace: root, repo: 'owner/repo', execute });
  const base = {
    passed: true, independent: true, verifiedBy: 'reviewer', evidence: 'Build and source review passed',
    verifiedAt: new Date().toISOString(), workspace: plan.workspace, snapshot: plan.snapshot,
  };

  await assert.rejects(publishRepository({ workspace: root, repo: 'owner/repo', execute }), { code: 'VERIFICATION_REQUIRED' });
  await assert.rejects(publishRepository({ workspace: root, repo: 'owner/repo', execute, verification: { ...base, snapshot: '0'.repeat(64) } }), { code: 'VERIFICATION_MISMATCH' });
  await assert.rejects(publishRepository({ workspace: root, repo: 'owner/repo', execute, verification: { ...base, verifiedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() } }), { code: 'VERIFICATION_STALE' });
});

function publicationExecutor(root, { existingGithubRepo = false, existingGit = false, origin = null, originUrl = 'https://github.com/sample-owner/sample-app.git', workingFiles = [] } = {}) {
  const calls = [];
  const state = { initialized: existingGit, committed: existingGit, commitCalls: 0, headId: existingGit ? 'a'.repeat(40) : null, created: existingGithubRepo, origin, staged: [], workingFiles, blobs: new Map(), objectIds: new Map(), pushed: false };
  const execute = async ({ command, args, cwd }) => {
    calls.push({ command, args, cwd });
    if (command === 'git') {
      const joined = args.join(' ');
      if (joined === '--version') return ok('git version 2.45.1');
      if (joined === 'config --get user.name') return ok('Wayfile Tests');
      if (joined === 'config --get user.email') return ok('wayfile@example.invalid');
      if (joined === 'rev-parse --show-toplevel') return state.initialized ? ok(root) : { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
      if (joined === 'status --porcelain=v1 --untracked-files=all') return ok('');
      if (joined === 'symbolic-ref --quiet --short HEAD') return ok('main');
      if (joined === 'rev-parse --verify HEAD') return state.headId ? ok(state.headId) : fail('fatal: Needed a single revision');
      if (args[0] === 'rev-list' && args[1] === '--objects') return ok(`${'c'.repeat(40)} README.md\n`);
      if (args[0] === 'cat-file' && args[1] === '-t') return ok('blob\n');
      if (args[0] === 'cat-file' && args[1] === 'blob' && args[2] === 'c'.repeat(40)) return ok('A useful app\n');
      if (joined === 'remote') return ok(state.origin ? 'origin\n' : '');
      if (joined === 'remote get-url origin') return ok(state.origin || originUrl);
      if (joined === 'ls-files -z') return ok(existingGit ? 'README.md\0' : '');
      if (joined === 'ls-files --others --exclude-standard -z') return ok(state.initialized && !existingGit ? state.workingFiles.join('\0') + (state.workingFiles.length ? '\0' : '') : '');
      if (joined === 'init --initial-branch=main') { state.initialized = true; return ok('Initialized empty Git repository'); }
      if (args[0] === 'check-ignore' && args[1] === '-q') return fail('');
      if (args[0] === 'add') {
        state.staged = args.slice(args.indexOf('--') + 1).map((value) => value.slice(':(literal)'.length));
        return ok();
      }
      if (joined === 'diff --cached --name-only -z') {
        const changed = state.committed ? [] : state.staged;
        return ok(changed.join('\0') + (changed.length ? '\0' : ''));
      }
      if (joined === 'diff --quiet') return ok();
      if (args[0] === 'ls-files' && args[1] === '--stage') {
        const entries = state.staged.map((path, index) => {
          const objectId = String(index + 1).padStart(40, '0');
          state.objectIds.set(path, objectId);
          state.blobs.set(objectId, path === 'README.md' ? 'A useful app\n' : 'export const app = true;\n');
          return `100644 ${objectId} 0\t${path}\0`;
        });
        return ok(entries.join(''));
      }
      if (args[0] === 'cat-file' && args[1] === 'blob') return ok(state.blobs.get(args[2]) || '');
      if (joined === 'rev-list --parents -n 1 HEAD') return ok(state.headId || '');
      if (joined === 'diff-tree --root --no-commit-id --name-only -r -z HEAD') {
        const changed = state.commitCalls ? state.staged : [];
        return ok(changed.join('\0') + (changed.length ? '\0' : ''));
      }
      if (joined === 'ls-tree -r -z HEAD') return ok(state.staged.map((path) => `100644 blob ${state.objectIds.get(path)}\t${path}\0`).join(''));
      if (joined === 'diff --cached --quiet') return state.committed ? ok() : { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'commit') { state.committed = true; state.commitCalls++; state.headId = 'b'.repeat(40); return ok('[main 1234567] Publish workspace'); }
      if (args[0] === 'remote' && args[1] === 'add') { state.origin = args[3]; return ok(); }
      if (args[0] === 'push') { state.pushed = true; return ok('branch set up to track origin/main'); }
    }
    if (command === 'gh') {
      if (args[0] === '--version') return ok('gh version 2.50.0');
      if (args[0] === 'auth' && args[1] === 'status') return ok('Logged in to github.com account sample-user');
      if (args[0] === 'repo' && args[1] === 'view') {
        if (!state.created) return { code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a Repository with the name sample-owner/sample-app. (repository)' };
        return ok(JSON.stringify({ nameWithOwner: 'sample-owner/sample-app', url: 'https://github.com/sample-owner/sample-app', isPrivate: true }));
      }
      if (args[0] === 'repo' && args[1] === 'create') { state.created = true; return ok('created'); }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  return { execute, calls, state };
}

test('publish stages explicit scanned files, creates a private repo, commits once, and never force pushes', async () => {
  const root = await workspace();
  await put(root, 'README.md', 'A useful app\n');
  await put(root, 'src/app.js', 'export const app = true;\n');
  await put(root, '.env', 'TOKEN=local-only\n');
  await put(root, 'node_modules/pkg/index.js', 'ignored dependency\n');
  const fake = publicationExecutor(root, { workingFiles: ['README.md', 'src/app.js'] });
  const plan = await planRepositoryPublication({ workspace: root, repo: 'sample-owner/sample-app', execute: fake.execute });
  const verification = {
    passed: true, independent: true, verifiedBy: 'reviewer', evidence: 'Source and smoke review passed',
    verifiedAt: new Date().toISOString(), workspace: plan.workspace, snapshot: plan.snapshot,
  };

  const result = await publishRepository({ workspace: root, repo: 'sample-owner/sample-app', verification, execute: fake.execute });

  assert.equal(fake.state.pushed, true);
  assert.equal(fake.state.committed, true);
  assert.equal(fake.state.created, true);
  assert.deepEqual(result.files, ['README.md', 'src/app.js']);
  assert.equal(result.committed, true);
  assert.ok(fake.calls.some(({ command, args }) => command === 'gh' && args.join(' ') === 'repo create sample-owner/sample-app --private'));
  assert.ok(fake.calls.some(({ command, args }) => command === 'git' && args[0] === 'add' && args.includes(':(literal)README.md') && args.includes(':(literal)src/app.js')));
  assert.ok(fake.calls.some(({ command, args }) => command === 'git' && args[0] === 'push'));
  assert.ok(fake.calls.every(({ command, args }) => !(command === 'git' && args.some((arg) => /^(--force|-f|\+refs)/.test(arg)))));
  assert.equal(fake.state.origin, 'https://github.com/sample-owner/sample-app');
});

test('publish refuses a mismatched existing origin before staging, commit, or remote mutation', async () => {
  const root = await workspace();
  await put(root, 'README.md', 'A useful app\n');
  const fake = publicationExecutor(root, { existingGithubRepo: true, existingGit: true, origin: 'git@github.com:someone-else/other-repo.git' });
  const plan = await planRepositoryPublication({ workspace: root, repo: 'sample-owner/sample-app', execute: fake.execute });
  const verification = {
    passed: true, independent: true, verifiedBy: 'reviewer', evidence: 'Review passed',
    verifiedAt: new Date().toISOString(), workspace: plan.workspace, snapshot: plan.snapshot,
  };

  await assert.rejects(publishRepository({ workspace: root, repo: 'sample-owner/sample-app', verification, execute: fake.execute }), { code: 'REMOTE_MISMATCH' });
  assert.equal(fake.state.commitCalls, 0);
  assert.equal(fake.state.pushed, false);
  assert.equal(fake.calls.some(({ command, args }) => command === 'git' && args[0] === 'add'), false);
});

test('publish keeps a matching existing origin unchanged and uses a normal push', async () => {
  const root = await workspace();
  await put(root, 'README.md', 'A useful app\n');
  const origin = 'git@github.com:sample-owner/sample-app.git';
  const fake = publicationExecutor(root, { existingGithubRepo: true, existingGit: true, origin });
  const plan = await planRepositoryPublication({ workspace: root, repo: 'sample-owner/sample-app', execute: fake.execute });
  const verification = {
    passed: true, independent: true, verifiedBy: 'reviewer', evidence: 'Review passed',
    verifiedAt: new Date().toISOString(), workspace: plan.workspace, snapshot: plan.snapshot,
  };

  const result = await publishRepository({ workspace: root, repo: 'sample-owner/sample-app', verification, execute: fake.execute });

  assert.equal(fake.state.origin, origin);
  assert.equal(fake.state.pushed, true);
  assert.equal(fake.state.commitCalls, 0);
  assert.equal(fake.calls.some(({ command, args }) => command === 'git' && args[0] === 'remote' && args[1] === 'add'), false);
  assert.equal(fake.calls.some(({ command, args }) => command === 'gh' && args[0] === 'repo' && args[1] === 'create'), false);
  assert.equal(result.remote, 'https://github.com/sample-owner/sample-app');
});

test('publication planning blocks credentials that survive only in branch history', async () => {
  const root = await workspace();
  await put(root, 'README.md', 'A useful app\n');
  const fake = publicationExecutor(root, { existingGit: true });
  const execute = async request => request.args.join(' ') === `cat-file blob ${'c'.repeat(40)}`
    ? ok('-----BEGIN PRIVATE KEY-----') : fake.execute(request);
  await assert.rejects(planRepositoryPublication({ workspace: root, repo: 'owner/site', execute }), { code: 'SECRET_HISTORY' });
  assert.equal(fake.calls.some(call => call.command === 'gh'), false);
});

test('publication plans represent a deleted tracked file in the verified snapshot', async () => {
  const root = await workspace();
  await put(root, 'README.md', 'A useful app\n');
  const fake = publicationExecutor(root, { existingGit: true });
  const execute = async request => {
    if (request.args[0] === 'status') return ok(' D old.js\n');
    if (request.args.join(' ') === 'ls-files -z') return ok('README.md\0old.js\0');
    return fake.execute(request);
  };
  const plan = await planRepositoryPublication({ workspace: root, repo: 'owner/site', allowDirty: true, execute });
  assert.deepEqual(plan.deletedFiles, ['old.js']);
  assert.deepEqual(plan.scannedFiles.map(f => f.path), ['README.md']);
});

test('publish detects workspace changes after verification before initializing Git', async () => {
  const root = await workspace();
  await put(root, 'app.js', 'export default true;\n');
  const fake = publicationExecutor(root, { workingFiles: ['app.js'] });
  const plan = await planRepositoryPublication({ workspace: root, repo: 'sample-owner/sample-app', execute: fake.execute });
  const verification = {
    passed: true, independent: true, verifiedBy: 'reviewer', evidence: 'Review passed',
    verifiedAt: new Date().toISOString(), workspace: plan.workspace, snapshot: plan.snapshot,
  };
  await put(root, 'app.js', 'export default false;\n');

  await assert.rejects(publishRepository({ workspace: root, repo: 'sample-owner/sample-app', verification, execute: fake.execute }), { code: 'VERIFICATION_MISMATCH' });
  assert.equal(fake.state.initialized, false);
  assert.equal(fake.calls.some(({ command, args }) => command === 'gh' && args[0] === 'repo' && args[1] === 'create'), false);
});

test('publish rejects an existing repository with the wrong visibility without changing it', async () => {
  const root = await workspace();
  await put(root, 'README.md', 'A useful app\n');
  const fake = publicationExecutor(root, { existingGithubRepo: true, workingFiles: ['README.md'] });
  const original = fake.execute;
  fake.execute = async (request) => {
    if (request.command === 'gh' && request.args[0] === 'repo' && request.args[1] === 'view') {
      fake.calls.push(request);
      return ok(JSON.stringify({ nameWithOwner: 'sample-owner/sample-app', url: 'https://github.com/sample-owner/sample-app', isPrivate: false }));
    }
    return original(request);
  };
  const plan = await planRepositoryPublication({ workspace: root, repo: 'sample-owner/sample-app', execute: fake.execute });
  const verification = {
    passed: true, independent: true, verifiedBy: 'reviewer', evidence: 'Review passed',
    verifiedAt: new Date().toISOString(), workspace: plan.workspace, snapshot: plan.snapshot,
  };

  await assert.rejects(publishRepository({ workspace: root, repo: 'sample-owner/sample-app', visibility: 'private', verification, execute: fake.execute }), { code: 'VISIBILITY_MISMATCH' });
  assert.equal(fake.state.committed, false);
  assert.equal(fake.state.pushed, false);
});
