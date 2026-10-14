#!/usr/bin/env node
// A single transparent development task, not an accuracy benchmark or holdout.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadGraph, run, openrouter, makeHarness, createProjectTools } from '../packages/wayfile/src/index.js';
import { loadLedger, saveLedger } from './ledger.js';
import { digest, requestRecorder, zeroUsage } from './measurement.js';
import { sourceSnapshot } from './run.js';

const mock = process.argv.includes('--mock');
const root = fileURLToPath(new URL('..', import.meta.url));
const source = sourceSnapshot(root), started = performance.now();
const dir = join(root, 'bench/results', `${new Date().toISOString().replace(/[:.]/g, '-')}-harness-${randomUUID().slice(0, 8)}`);
const workspace = join(dir, 'project'), agentDir = join(dir, 'agent');
mkdirSync(workspace, { recursive: true }); mkdirSync(agentDir, { recursive: true });
const tests = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {add} from './calc.mjs';
test('add returns the arithmetic sum', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-2, 3), 1);
  assert.equal(add(0, 7), 7);
});\n`;
writeFileSync(join(workspace, 'calc.mjs'), 'export const add = (a, b) => a * b;\n');
writeFileSync(join(workspace, 'check.test.mjs'), tests);
writeFileSync(join(agentDir, 'fix.md'), `---
kind: harness
entry: true
needs: [task]
sets: [report]
tools: [list-files, read-file, search-files, write-file, shell]
max_turns: 8
max_tool_calls: 8
max_tokens: 800
output: json
schema: report.json
---
# Fix and verify
Inspect source and the existing tests. Run node --test check.test.mjs BEFORE
editing, and observe the failure. Fix only calc.mjs, using its read SHA-256 as
expected_sha256. Do not change tests. Run the same tests after the fix and
observe success before finishing. State uncertainty if a tool fails.
Return changed, verified and a concise summary matching the schema.

## Routes
- otherwise → [[done]]\n`);
writeFileSync(join(agentDir, 'done.md'), '---\nkind: end\n---\n# Done\n');
writeFileSync(join(agentDir, 'report.json'), JSON.stringify({ type: 'object', additionalProperties: false,
  required: ['changed', 'verified', 'summary'], properties: { changed: { type: 'boolean' }, verified: { type: 'boolean' }, summary: { type: 'string', minLength: 1, maxLength: 300 } } }));
const task = 'The add function should return the arithmetic sum. Inspect the project, reproduce the failing test, fix calc.mjs, and verify the existing tests.';
const graph = loadGraph(agentDir), ledger = loadLedger(), spentBefore = ledger.spent;
let mockTurn = 0;
const mockCall = async (request) => {
  mockTurn++;
  const input = mockTurn === 1 ? { path: 'calc.mjs' } : mockTurn === 3 ? {
    path: 'calc.mjs', content: 'export const add = (a, b) => a + b;\n',
    expected_sha256: JSON.parse(request.messages[2].content[0].content).sha256,
  } : { command: 'node --test check.test.mjs' };
  const name = mockTurn === 1 ? 'read-file' : mockTurn === 3 ? 'write-file' : 'shell';
  const content = mockTurn < 5 ? [{ type: 'tool_use', id: `mock-${mockTurn}`, name, input }] : [{ type: 'text', text: JSON.stringify({ changed: true, verified: true, summary: 'Corrected add and observed the existing tests pass.' }) }];
  return { content, text: content[0].text || '', stop: mockTurn < 5 ? 'tool_use' : 'end_turn', model: 'explicit-mock', provider: 'local', usage: zeroUsage() };
};
const rawCall = mock ? mockCall : openrouter({ ledger });
const journal = requestRecorder(rawCall, { ledger, context: { arm: 'wayfile_harness', developmentSmoke: true }, onEvent: (event) => {
  writeFileSync(join(dir, 'requests.jsonl'), JSON.stringify(event) + '\n', { flag: 'a' });
  if (!mock) saveLedger(ledger);
} });
const tools = createProjectTools({ workspace, allowWrite: true, allowShell: true, authorize: ({ tool, args }) =>
  tool === 'shell' ? args.command === 'node --test check.test.mjs' :
    tool === 'write-file' ? args.path === 'calc.mjs' && typeof args.expected_sha256 === 'string' : true });
let result, failure;
try { result = await run(graph, { task }, { harness: makeHarness(journal.call, { tools }), traceDir: join(dir, 'traces') }); }
catch (error) { failure = error; result = error.result; }
finally { if (!mock) saveLedger(ledger); }
const events = result?.steps.flatMap((step) => step.toolEvents || []) || [];
const failingCheck = events.findIndex((e) => e.name === 'shell' && e.result?.exitCode !== undefined && e.result.exitCode !== 0);
const edit = events.findIndex((e) => e.name === 'write-file' && e.status === 'completed');
const passingCheck = events.findIndex((e, i) => i > edit && e.name === 'shell' && e.result?.exitCode === 0);
let verifierPassed = false;
try { execFileSync(process.execPath, ['--test', 'check.test.mjs'], { cwd: workspace, stdio: 'pipe', timeout: 10000 }); verifierPassed = true; } catch { /* Preserve a failed task. */ }
const checks = {
  completed: result?.status === 'completed', reportedVerification: result?.state.report?.verified === true,
  observedFailureBeforeEdit: failingCheck >= 0 && edit > failingCheck, observedPassAfterEdit: passingCheck > edit && edit >= 0,
  testsUnchanged: digest(readFileSync(join(workspace, 'check.test.mjs'), 'utf8')) === digest(tests), independentVerifierPassed: verifierPassed,
};
const report = { kind: 'traditional-harness-development-smoke', modelQualityMeasured: !mock, mock, checks, success: Object.values(checks).every(Boolean),
  measurement: journal.measurement(), ms: Math.round(performance.now() - started), sourceChanged: sourceSnapshot(root).hash !== source.hash,
  spendDeltaUsd: ledger.spent - spentBefore, spentCumulativeUsd: ledger.spent,
  config: { requestedModel: rawCall.model || null, maxTurns: 8, maxToolCalls: 8, maxTokens: 800, onlyWritablePath: 'calc.mjs', onlyShellCommand: 'node --test check.test.mjs', taskHash: digest(task), testHash: digest(tests), sourceHash: source.hash },
  ...(failure ? { error: failure.message } : {}), result };
writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ config: report.config, sourceFiles: source.files }, null, 2));
console.log(JSON.stringify({ artifactDir: dir, success: report.success, checks, measurement: report.measurement, mock }, null, 2));
if (!report.success) process.exitCode = 1;
