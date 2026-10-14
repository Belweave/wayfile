import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectTools } from '../packages/wayfile/src/tools.js';
import { createEditTool } from '../apps/waycode/src/coding-edit.js';

test('exact edits preserve surrounding content and reject stale or ambiguous edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'waycode-edit-'));
  try {
    await writeFile(join(root, 'a.js'), 'before\nconst n = 1;\nafter\n');
    const tools = createProjectTools({ workspace: root, allowWrite: true });
    const edit = createEditTool(tools), read = tools.find(t => t.name === 'read-file');
    const file = await read.execute({ path: 'a.js' }, {});
    const args = { path: 'a.js', old_text: 'const n = 1;', new_text: 'const n = 2;', expected_sha256: file.sha256 };
    await edit.execute(args, {});
    assert.equal(await readFile(join(root, 'a.js'), 'utf8'), 'before\nconst n = 2;\nafter\n');
    await assert.rejects(edit.execute(args, {}), /changed since read/);
    await writeFile(join(root, 'a.js'), 'same same');
    const current = await read.execute({ path: 'a.js' }, {});
    await assert.rejects(edit.execute({ ...args, old_text: 'same', expected_sha256: current.sha256 }, {}), /exactly once/);
    await assert.rejects(edit.execute({ ...args, path: '../escape' }, {}), /escapes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('read-only registries do not expose edits', () => assert.equal(createEditTool([]), null));
