import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodingSession } from '../apps/waycode/src/coding.js';

const final = (value) => ({ text: JSON.stringify(value), usage: { input: 1, output: 1, cost: 0 } });
test('the reported greeting responds without models, tools, or preview verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'waycode-greeting-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  let session;
  try {
    session = await createCodingSession({ workspace, sessionDir: join(root, 'sessions'), checkURL: 'http://localhost:3000',
      call: async () => assert.fail('greeting must not enter the coding model'),
      verification: { executeScript: async () => assert.fail('greeting must not verify a project'), fetchFn: async () => assert.fail('greeting must not check localhost') },
    });
    const result = await session.turn('hey, how are you?');
    assert.equal(result.status, 'completed');
    assert.match(result.answer, /Hey!/);
    assert.equal(result.calls, 0);
    assert.equal(result.verification, null);
    assert.equal(result.steps.some(step => step.node === 'verification'), false);
  } finally { await session?.close(); await rm(root, { recursive: true, force: true }); }
});

test('ordinary model-answered discussion has no verification or second formatting call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'waycode-discussion-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  let calls = 0, session;
  try {
    session = await createCodingSession({ workspace, sessionDir: join(root, 'sessions'), checkURL: 'http://localhost:3000',
      call: async () => { assert.equal(++calls, 1); return final({ status: 'answered', summary: 'I can help you write and run programs.', question: null, changed_files: [] }); },
    });
    const result = await session.turn('What can you help me with?');
    assert.equal(result.answer, 'I can help you write and run programs.');
    assert.equal(result.status, 'completed');
    assert.equal(result.verification, null);
    assert.equal(calls, 1);
  } finally { await session?.close(); await rm(root, { recursive: true, force: true }); }
});
test('coding conversation integrates actual file tools, independent local execution, and persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'waycode-integration-'));
  const workspace = join(root, 'project'), sessionDir = join(root, 'sessions');
  await mkdir(workspace);
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  await writeFile(join(workspace, 'package-lock.json'), '{}');
  let stage = 0, session;
  const call = async (request) => {
    if (stage++ === 0) return { content: [{ type: 'tool_use', id: 'write-1', name: 'write-file', input: { path: 'hello.js', content: 'console.log("hello");\n' } }], usage: { cost: 0 } };
    if (stage === 2) return final({ status: 'ready', summary: 'Created hello.js', question: null, changed_files: ['hello.js'] });
    return final({ status: 'completed', answer: 'Created hello.js. Test passed.', question: null });
  };
  try {
    session = await createCodingSession({ workspace, sessionDir, sessionId: 'integration', call });
    const result = await session.turn('Write a hello program');
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.verification.scripts[0].exit_code, 0);
    assert.equal(await readFile(join(workspace, 'hello.js'), 'utf8'), 'console.log("hello");\n');
    assert.deepEqual(result.changedFiles, ['hello.js']);
    await session.close();
    session = await createCodingSession({ workspace, sessionDir, sessionId: 'integration', call });
    assert.equal(session.history.length, 2);
  } finally { await session?.close(); await rm(root, { recursive: true, force: true }); }
});

test('read-only coding turns expose no write/process tools and never execute verification commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'waycode-readonly-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  let calls = 0, session;
  try {
    session = await createCodingSession({ workspace, sessionDir: join(root, 'sessions'),
      codingToolsOptions: { allowWrite: false, allowShell: false },
      verification: { executeScript: async () => assert.fail('read-only must not execute') },
      call: async (request) => {
        assert.ok(request.messages[0].content.startsWith('Authenticated user request:'));
        assert.match(request.system, /authenticated user request is an instruction/);
        assert.ok(!request.tools.some(t => ['write-file', 'edit-file', 'run-command', 'start-process'].includes(t.name)));
        return ++calls === 1 ? final({ status: 'ready', summary: 'Explained the code', question: null, changed_files: [] }) : final({ status: 'unverified', answer: 'Explained without executing commands.', question: null });
      },
    });
    const result = await session.turn('Explain this project');
    assert.equal(result.status, 'unverified');
    assert.match(result.verification.reason, /disabled/);
  } finally { await session?.close(); await rm(root, { recursive: true, force: true }); }
});

test('cancelling a noncooperative model call releases the coding session promptly', { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'waycode-cancel-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  const controller = new AbortController();
  let session, timer;
  try {
    session = await createCodingSession({ workspace, sessionDir: join(root, 'sessions'), signal: controller.signal,
      call: async () => new Promise(() => {}),
    });
    const pending = session.turn('Inspect the project');
    timer = setTimeout(() => controller.abort(new Error('test cancellation')), 50);
    const result = await pending;
    assert.equal(result.status, 'interrupted');
    await session.close();
  } finally { clearTimeout(timer); await session?.close(); await rm(root, { recursive: true, force: true }); }
});

test('an unrelated responding localhost server does not count as managed task verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'waycode-owner-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'fixture' } }));
  await writeFile(join(workspace, 'package-lock.json'), '{}');
  let calls = 0, session;
  try {
    session = await createCodingSession({ workspace, sessionDir: join(root, 'sessions'), maxRepairRounds: 0,
      checkURL: 'http://localhost:3000', verification: { executeScript: async () => ({ exitCode: 0 }), fetchFn: async () => ({ status: 200 }) },
      call: async () => ++calls === 1 ? final({ status: 'ready', summary: 'Ready', question: null, changed_files: [] }) : final({ status: 'blocked', answer: 'Server must be started.', question: 'May I start the server?' }),
    });
    const result = await session.turn('Build a site');
    assert.equal(result.status, 'blocked');
    assert.equal(result.verified, false);
    assert.match(result.verification.reason, /No running managed server/);
  } finally { await session?.close(); await rm(root, { recursive: true, force: true }); }
});
