import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../packages/wayfile/src/check.js';
import { loadGraph } from '../packages/wayfile/src/parse.js';
import { createCodingSession, verifyWorkspace } from '../apps/waycode/src/coding.js';
import { createProjectTools } from '../packages/wayfile/src/tools.js';

const graphDir = fileURLToPath(new URL('../apps/waycode/agent/', import.meta.url));
const usage = { input: 9, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0 };
const jsonReply = (value) => {
  const text = JSON.stringify(value);
  return { text, content: [{ type: 'text', text }], stop: 'end_turn', usage, model: 'mock-coding-model', provider: 'mock' };
};
const toolReply = (name, id, input) => ({
  text: '', stop: 'tool_use', usage,
  content: [{ type: 'tool_use', id, name, input }],
});
const development = (patch = {}) => ({ status: 'ready', summary: 'Applied the requested focused change.', question: null, changed_files: [], ...patch });
const response = (patch = {}) => ({ status: 'completed', answer: 'The change is ready.', question: null, ...patch });
const sessionTools = async ({ workspace }) => ({ tools: createProjectTools({ workspace, allowWrite: true, allowShell: false }), close: async () => {} });

async function fixture({ packageManager = 'npm', scripts = { test: 'fixture-test' }, lock = true } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'wayfile-coding-unit-'));
  const workspace = join(parent, 'workspace');
  const sessionDir = join(parent, 'sessions');
  await mkdir(workspace, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: `${packageManager}@1.0.0`, scripts }, null, 2));
  if (lock) {
    const lockfile = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lock' }[packageManager];
    await writeFile(join(workspace, lockfile), 'mock lockfile\n');
  }
  return { parent, workspace: await realpath(workspace), sessionDir };
}

test('authored coding graph is valid and has the intended develop, verification, response, end path', async () => {
  const graph = loadGraph(graphDir);
  assert.equal(graph.entry, 'develop');
  assert.deepEqual(Object.keys(graph.nodes).sort(), ['develop', 'done', 'respond', 'verification']);
  assert.deepEqual(await check(graph), []);
  assert.ok(graph.nodes.develop.meta.tools.includes('run-command'));
  assert.ok(graph.nodes.develop.meta.tools.includes('start-process'));
  assert.deepEqual(graph.nodes.respond.meta.tools, []);
});

test('host verification selects package manager from its sole lockfile and executes only declared scripts', async (t) => {
  for (const [manager, lockfile] of Object.entries({ npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lock' })) {
    const data = await fixture({ packageManager: manager, scripts: { lint: 'lint-fixture', test: 'test-fixture', build: 'build-fixture' } });
    t.after(() => rm(data.parent, { recursive: true, force: true }));
    const calls = [];
    const result = await verifyWorkspace(data.workspace, {
      executeScript: async ({ manager: selected, script, command, cwd }) => {
        calls.push({ selected, script, command, cwd });
        return { exitCode: 0, stdout: `${script} ok`, stderr: '' };
      },
    });
    assert.equal(result.status, 'passed');
    assert.equal(result.package_manager, manager);
    assert.equal(result.lockfile, lockfile);
    assert.deepEqual(calls.map((call) => call.script), ['lint', 'test', 'build']);
    const canonicalWorkspace = await realpath(data.workspace);
    assert.ok(calls.every((call) => call.selected === manager && call.cwd === canonicalWorkspace));
    assert.ok(calls.every((call) => call.command === `${manager} run ${call.script}`));
  }
});

test('missing lockfile or verification scripts stay unverified and do not run a command', async (t) => {
  const data = await fixture({ lock: false, scripts: { dev: 'next dev' } });
  t.after(() => rm(data.parent, { recursive: true, force: true }));
  let executions = 0;
  const result = await verifyWorkspace(data.workspace, { executeScript: async () => { executions++; return { exitCode: 0 }; } });
  assert.equal(result.status, 'missing');
  assert.match(result.reason, /lockfile/);
  assert.equal(executions, 0);
});

test('verification records a loopback health check but never lets it replace package scripts', async (t) => {
  const data = await fixture({ scripts: {} });
  t.after(() => rm(data.parent, { recursive: true, force: true }));
  const calls = [];
  const result = await verifyWorkspace(data.workspace, {
    checkURL: 'http://localhost:3000/health',
    executeScript: async () => { calls.push('script'); return { exitCode: 0 }; },
    fetchFn: async (url, options) => { calls.push({ url, redirect: options.redirect }); return { status: 200 }; },
  });
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.url_check, { url: 'http://localhost:3000/health', status: 200, passed: true, error: null });
  assert.equal(calls[0].url, 'http://localhost:3000/health');
  assert.equal(calls[0].redirect, 'manual');
  await assert.rejects(verifyWorkspace(data.workspace, { checkURL: 'https://example.com' }), /localhost|loopback/);
});

test('successful turns return trusted verification and code graph events', async (t) => {
  const data = await fixture({ scripts: { test: 'fixture-test', build: 'fixture-build' } });
  t.after(() => rm(data.parent, { recursive: true, force: true }));
  await writeFile(join(data.parent, 'AGENTS.md'), 'Parent workspace instruction: retain the existing architecture.');
  await writeFile(join(data.workspace, 'AGENTS.md'), 'Project instruction: keep public APIs stable.');
  const requests = [], events = [], verifiedScripts = [];
  const outputs = [jsonReply(development()), jsonReply(response())];
  const session = await createCodingSession({
    workspace: data.workspace, sessionDir: data.sessionDir, sessionId: 'success',
    model: 'mock-coding-model', call: async (request) => { requests.push(request); return outputs.shift(); },
    createCodingTools: sessionTools, onEvent: async (event) => events.push(event),
    verification: { executeScript: async ({ script }) => { verifiedScripts.push(script); return { exitCode: 0, stdout: 'ok', stderr: '' }; } },
  });
  t.after(() => session.close());
  const result = await session.turn('Implement the small requested feature.');
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
  assert.deepEqual(verifiedScripts, ['test', 'build']);
  assert.deepEqual(result.verification.scripts.map((script) => script.passed), [true, true]);
  assert.deepEqual(requests.map((request) => request.model), ['mock-coding-model']);
  assert.match(requests[0].system, /retain the existing architecture/);
  assert.match(requests[0].system, /keep public APIs stable/);
  assert.deepEqual(requests[0].tools.map((tool) => tool.name), ['list-files', 'read-file', 'search-files', 'write-file']);
  assert.ok(events.some((event) => event.type === 'verification.script.completed' && event.passed));
  assert.deepEqual(session.history.map((message) => message.role), ['user', 'assistant']);
});

test('failed verification gets only the configured bounded repair rounds', async (t) => {
  const data = await fixture({ scripts: { test: 'fixture-test' } });
  t.after(() => rm(data.parent, { recursive: true, force: true }));
  let turn = 0, verification = 0, repairProjection;
  const session = await createCodingSession({
    workspace: data.workspace, sessionDir: data.sessionDir, sessionId: 'repair',
    maxRepairRounds: 1, createCodingTools: sessionTools,
    call: async (request) => {
      turn++;
      if (turn === 2) repairProjection = JSON.parse(request.messages[0].content.split('Workspace evidence and conversation context:\n')[1]);
      return turn === 3 ? jsonReply(response()) : jsonReply(development());
    },
    verification: { executeScript: async () => ({ exitCode: ++verification === 1 ? 1 : 0, stdout: '', stderr: verification === 1 ? 'fixture failed' : '' }) },
  });
  t.after(() => session.close());
  const result = await session.turn('Fix the fixture failure.');
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
  assert.equal(turn, 2);
  assert.equal(verification, 2);
  assert.equal(repairProjection['task.repairs_remaining'], 0);
  assert.equal(result.steps.filter((step) => step.node === 'develop').length, 2);
});

test('human questions return structured blocked results without running verification', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.parent, { recursive: true, force: true }));
  let scripts = 0;
  const session = await createCodingSession({
    workspace: data.workspace, sessionDir: data.sessionDir, sessionId: 'question', createCodingTools: sessionTools,
    call: async (request) => request.system.includes('# Harness: Develop')
      ? jsonReply(development({ status: 'blocked', summary: 'A product choice is required.', question: 'Which route should this link use?' }))
      : jsonReply(response({ status: 'blocked', answer: 'I need your choice before changing the route.', question: 'Which route should this link use?' })),
    verification: { executeScript: async () => { scripts++; return { exitCode: 0 }; } },
  });
  t.after(() => session.close());
  const result = await session.turn('Add a link, but I have not said where it goes.');
  assert.equal(result.status, 'blocked');
  assert.equal(result.verified, false);
  assert.equal(result.question, 'Which route should this link use?');
  assert.equal(result.verification, null);
  assert.equal(scripts, 0);
});

test('an existing file cannot be overwritten before a guarded read', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.parent, { recursive: true, force: true }));
  await writeFile(join(data.workspace, 'answer.txt'), 'keep me');
  const session = await createCodingSession({
    workspace: data.workspace, sessionDir: data.sessionDir, sessionId: 'guarded-write',
    call: async () => toolReply('write-file', 'write-first', { path: 'answer.txt', content: 'overwrite' }),
    verification: { executeScript: async () => ({ exitCode: 0 }) },
  });
  t.after(() => session.close());
  const result = await session.turn('Change answer.txt.');
  assert.equal(result.status, 'failed');
  assert.match(result.error, /read the existing file before writing it/);
  assert.equal(await readFile(join(data.workspace, 'answer.txt'), 'utf8'), 'keep me');
});

test('read then hash-guarded write is audited and independently verified', async (t) => {
  const data = await fixture({ scripts: { test: 'fixture-test' } });
  t.after(() => rm(data.parent, { recursive: true, force: true }));
  await mkdir(join(data.workspace, 'src'));
  await writeFile(join(data.workspace, 'src', 'AGENTS.md'), "Nested source instruction: keep this file's exports stable.");
  await writeFile(join(data.workspace, 'src', 'answer.txt'), 'old');
  const requests = [];
  const session = await createCodingSession({
    workspace: data.workspace, sessionDir: data.sessionDir, sessionId: 'read-write',
    verification: { executeScript: async () => ({ exitCode: 0 }) },
    call: async (request) => {
      requests.push(request);
      if (requests.length === 1) return toolReply('read-file', 'read-1', { path: 'src/answer.txt' });
      if (requests.length === 2) {
        assert.match(request.system, /keep this file's exports stable/);
        const result = JSON.parse(request.messages.at(-1).content[0].content);
        assert.equal(result.text, 'old');
        return toolReply('write-file', 'write-1', { path: 'src/answer.txt', content: 'new', expected_sha256: result.sha256 });
      }
      if (requests.length === 3) return jsonReply(development({ changed_files: ['src/answer.txt'] }));
      return jsonReply(response());
    },
  });
  t.after(() => session.close());
  const result = await session.turn('Update answer.txt to new.');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.changedFiles, ['src/answer.txt']);
  assert.equal(await readFile(join(data.workspace, 'src', 'answer.txt'), 'utf8'), 'new');
});

test('transport failures persist without automatic replay; a second explicit turn can retry', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.parent, { recursive: true, force: true }));
  let calls = 0;
  const session = await createCodingSession({
    workspace: data.workspace, sessionDir: data.sessionDir, sessionId: 'no-replay', createCodingTools: sessionTools,
    call: async () => {
      calls++;
      if (calls === 1) throw new Error('mock transport down');
      return calls === 3 ? jsonReply(response()) : jsonReply(development());
    },
    verification: { executeScript: async () => ({ exitCode: 0 }) },
  });
  t.after(() => session.close());
  const failed = await session.turn('Make the change.');
  assert.equal(failed.status, 'failed');
  assert.equal(calls, 1);
  const completed = await session.turn('Retry the request after transport recovery.');
  assert.equal(completed.status, 'completed');
  assert.equal(calls, 2);
  assert.equal(session.history.length, 4);
});

test('a second session cannot edit the same workspace concurrently', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.parent, { recursive: true, force: true }));
  let enterFirst;
  let finishFirst;
  const entered = new Promise((resolve) => { enterFirst = resolve; });
  const held = new Promise((resolve) => { finishFirst = resolve; });
  let firstCalls = 0, secondCalls = 0;
  const first = await createCodingSession({
    workspace: data.workspace, sessionDir: join(data.parent, 'sessions-a'), sessionId: 'lock-a', createCodingTools: sessionTools,
    call: async () => { firstCalls++; if (firstCalls === 1) { enterFirst(); return held; } return jsonReply(response()); },
    verification: { executeScript: async () => ({ exitCode: 0 }) },
  });
  const second = await createCodingSession({
    workspace: data.workspace, sessionDir: join(data.parent, 'sessions-b'), sessionId: 'lock-b', createCodingTools: sessionTools,
    call: async () => { secondCalls++; return jsonReply(development()); },
  });
  t.after(() => first.close());
  t.after(() => second.close());
  const running = first.turn('Hold the first run.');
  await entered;
  const blocked = await second.turn('Try to edit concurrently.');
  assert.equal(blocked.status, 'conflict');
  assert.equal(secondCalls, 0);
  finishFirst(jsonReply(development()));
  const completed = await running;
  assert.equal(completed.status, 'completed');
});

test('a persisted running turn is recovered as interrupted without replay', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.parent, { recursive: true, force: true }));
  const sessionId = 'crashed-turn';
  const interruptedId = 'old-run-id';
  await writeFile(join(data.sessionDir, `${sessionId}.json`), JSON.stringify({
    version: 1, id: sessionId, workspace: data.workspace,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    history: [{ role: 'user', content: 'Was interrupted.', turnId: interruptedId }],
    turns: [{ id: interruptedId, status: 'running', result: null }],
    activeTurn: { id: interruptedId, status: 'running', stage: 'develop', events: [], calls: 1 },
  }));
  let calls = 0;
  const session = await createCodingSession({ workspace: data.workspace, sessionDir: data.sessionDir, sessionId, call: async () => { calls++; return jsonReply(development()); }, createCodingTools: sessionTools });
  t.after(() => session.close());
  const stored = JSON.parse(await readFile(join(data.sessionDir, `${sessionId}.json`), 'utf8'));
  assert.equal(stored.turns[0].status, 'interrupted');
  assert.equal(stored.activeTurn, null);
  assert.equal(calls, 0);
  assert.match(session.history.at(-1).content, /Previous turn interrupted/);
});
