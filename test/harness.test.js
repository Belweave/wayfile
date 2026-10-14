import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHarness } from '../packages/wayfile/src/harness.js';
import { ToolError, createProjectTools } from '../packages/wayfile/src/tools.js';

const usage = { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, cost: 0.001 };
const reply = (text) => ({ text, content: [{ type: 'text', text }], usage, model: 'mock-model', provider: 'mock', id: 'response-id', stop: 'end_turn' });
const request = (id = 'call-1', name = 'lookup', input = { query: 'fact' }) => ({ type: 'tool_use', id, name, input });
const toolReply = (...content) => ({ text: '', content, usage, model: 'mock-model', stop: 'tool_use' });
const graph = { instructions: 'Use supplied evidence.', dir: '.', nodes: {} };
const node = (meta = {}) => ({ id: 'research', file: 'research.md', kind: 'harness', title: 'Research', body: 'Answer the question with evidence.', needs: ['question'], sets: ['answer'], meta: { tools: ['lookup'], ...meta } });
const tool = (execute, extra = {}) => ({ name: 'lookup', description: 'Look up a supplied query.', input_schema: {
  type: 'object', required: ['query'], properties: { query: { type: 'string' } }, additionalProperties: false,
}, execute, ...extra });
const sequence = (responses, seen = []) => async (request) => { seen.push(structuredClone(request)); const next = responses.shift(); if (next instanceof Error) throw next; return next; };
const failure = (fn, pattern, check = () => {}) => assert.rejects(fn, (error) => { assert.match(error.message, pattern); check(error); return true; });

test('harness selects declared tools, projects needs, and returns validated final JSON with complete usage', async () => {
  const seen = [], executed = [];
  const call = sequence([toolReply(request()), reply('{"answer":"42","proof":["lookup:call-1"]}')], seen);
  const harness = makeHarness(call, { tools: [tool(async (args, context) => { executed.push({ args, state: context.state }); return { fact: 42 }; }), tool(async () => 'hidden', { name: 'hidden' })] });
  const n = node({ output: 'json' });
  n.outputSchema = { type: 'object', required: ['answer', 'proof'], additionalProperties: false, properties: { answer: { type: 'string' }, proof: { type: 'array', items: { type: 'string' } } } };
  const result = await harness(graph, n, { question: 'What is the fact?', private: 'never expose' });
  assert.deepEqual(result.value, { answer: '42', proof: ['lookup:call-1'] });
  assert.equal(result.calls, 2); assert.equal(result.toolCalls, 1);
  assert.deepEqual(result.usage, { input: 20, output: 6, cacheRead: 4, cacheWrite: 2, cost: 0.002 });
  assert.deepEqual(seen[0].tools.map((t) => t.name), ['lookup']);
  assert.doesNotMatch(JSON.stringify(seen), /never expose/);
  assert.deepEqual(executed, [{ args: { query: 'fact' }, state: { question: 'What is the fact?' } }]);
  assert.deepEqual(JSON.parse(seen[1].messages.at(-1).content[0].content), { fact: 42 });
  assert.equal(result.toolEvents[0].status, 'completed');
  assert.deepEqual(result.toolEvents[0].input, { query: 'fact' });
  assert.equal(result.toolEvents[0].inputHash.length, 64);
  assert.equal(result.toolEvents[0].outputHash.length, 64);
  assert.equal(result.attempts[0].model, 'mock-model');
});

test('native result projection keeps credentials and binary payloads out of model context and events', async () => {
  const seen = [];
  const harness = makeHarness(sequence([toolReply(request()), reply('Fact: 42')], seen), { tools: [tool(async () => ({ secret: 'credential-secret', image: Buffer.from('native'), fact: 42 }), {
    toModelOutput: (raw) => ({ fact: raw.fact, artifact: 'safe-resource-ref' }),
  })] });
  const result = await harness(graph, node(), { question: 'fact' });
  assert.doesNotMatch(JSON.stringify({ seen, events: result.toolEvents }), /credential-secret|native/);
  assert.deepEqual(result.toolEvents[0].result, { fact: 42, artifact: 'safe-resource-ref' });
});

test('unregistered or undeclared tools fail before execution, including a bad second call in a batch', async () => {
  let executions = 0;
  for (const calls of [[request('a', 'missing')], [request('a'), request('b', 'hidden')]]) {
    const harness = makeHarness(sequence([toolReply(...calls)]), { tools: [tool(async () => { executions++; return 'ok'; }), tool(async () => { executions++; return 'hidden'; }, { name: 'hidden' })] });
    await failure(harness(graph, node(), { question: 'q' }), /unknown or disabled tool/, (error) => {
      assert.equal(error.calls, 1); assert.equal(error.toolCalls, 0); assert.equal(error.usage.cost, 0.001);
      assert.equal(error.toolEvents.at(-1).status, 'rejected');
    });
  }
  assert.equal(executions, 0);
});

test('malformed arguments and duplicate call IDs cannot produce partial batch effects', async () => {
  let executions = 0;
  const definition = tool(async () => { executions++; return 'ok'; });
  for (const calls of [
    [request('a'), request('a')], [request('a'), request('b', 'lookup', { query: 4 })],
    [request('a', 'lookup', 'not an object')], [request('', 'lookup')],
  ]) await failure(makeHarness(sequence([toolReply(...calls)]), { tools: [definition] })(graph, node(), { question: 'q' }), /duplicate|arguments/, (error) => {
    assert.equal(error.calls, 1); assert.equal(error.toolCalls, 0); assert.equal(error.usage.cost, 0.001);
  });
  assert.equal(executions, 0);
  const replay = makeHarness(sequence([toolReply(request('a')), toolReply(request('a'))]), { tools: [definition] });
  await failure(replay(graph, node(), { question: 'q' }), /duplicate/, (error) => { assert.equal(error.calls, 2); assert.equal(error.toolCalls, 1); });
  assert.equal(executions, 1);
});

test('toolcall and turn limits fail before stranded side effects', async () => {
  let executions = 0;
  const tools = [tool(async () => { executions++; return 'ok'; })];
  await failure(makeHarness(sequence([toolReply(request('a'), request('b'))]), { tools, maxToolCalls: 1 })(graph, node(), { question: 'q' }), /max_tool_calls 1/, (error) => { assert.equal(error.toolCalls, 0); assert.equal(error.calls, 1); });
  await failure(makeHarness(sequence([toolReply(request())]), { tools, maxTurns: 1 })(graph, node(), { question: 'q' }), /max_turns 1/, (error) => { assert.equal(error.toolCalls, 0); assert.equal(error.usage.cost, 0.001); });
  assert.equal(executions, 0);
  await failure(makeHarness(sequence([toolReply(request('a')), toolReply(request('b'))]), { tools, maxTurns: 2 })(graph, node(), { question: 'q' }), /max_turns 2/, (error) => { assert.equal(error.toolCalls, 1); assert.equal(error.calls, 2); assert.equal(error.usage.cost, 0.002); });
});

test('tool execution, denial and output failures retain the model bill', async () => {
  for (const definition of [
    tool(async () => { throw new Error('executor failed'); }),
    tool(async () => ({ fact: undefined })),
    tool(async () => 'x'.repeat(50)),
  ]) await failure(makeHarness(sequence([toolReply(request())]), { tools: [definition], maxToolOutputBytes: 20 })(graph, node(), { question: 'q' }), /failed|JSON-compatible|exceeds/, (error) => { assert.equal(error.calls, 1); assert.equal(error.toolCalls, 1); assert.equal(error.usage.cost, 0.001); assert.equal(error.toolEvents[0].status, 'failed'); });
  let executions = 0;
  const denied = makeHarness(sequence([toolReply(request())]), { tools: [tool(async () => { executions++; return 'ok'; })], authorize: async () => false });
  await failure(denied(graph, node(), { question: 'q' }), /authorization denied/, (error) => { assert.equal(error.toolEvents[0].status, 'denied'); assert.equal(error.toolEvents[0].executed, false); assert.equal(error.usage.cost, 0.001); });
  assert.equal(executions, 0);
});

test('injected tool deadlines abort cooperatively and preserve expenses', async () => {
  let aborted = false;
  const harness = makeHarness(sequence([toolReply(request())]), { toolTimeoutMs: 10, tools: [tool(async (_, { signal }) => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  })] });
  await failure(harness(graph, node(), { question: 'q' }), /exceeded 10ms/, (error) => { assert.equal(error.usage.cost, 0.001); assert.equal(error.toolCalls, 1); assert.equal(error.toolEvents[0].status, 'timeout'); });
  assert.equal(aborted, true);
});

test('expected missing-file errors become bounded error evidence for recovery', async () => {
  const seen = [];
  const harness = makeHarness(sequence([toolReply(request('a', 'lookup', { query: 'missing' })), toolReply(request('b', 'lookup', { query: 'exists' })), reply('Found the fact.')], seen), { tools: [tool(async ({ query }) => {
    if (query === 'missing') throw new ToolError('not found', { code: 'ENOENT', recoverable: true });
    return { fact: 42 };
  })] });
  const result = await harness(graph, node(), { question: 'fact' });
  assert.equal(result.calls, 3); assert.equal(result.toolCalls, 2); assert.equal(result.usage.cost, 0.003);
  assert.equal(seen[1].messages.at(-1).content[0].is_error, true);
  assert.equal(result.toolEvents[0].recoverable, true);
  assert.equal(result.toolEvents[1].status, 'completed');
});

test('recoverable error budget and fatal scope errors cannot be bypassed', async () => {
  for (const [definition, n, responses, pattern] of [
    [tool(async () => { throw new ToolError('not found', { code: 'ENOENT', recoverable: true }); }), node({ max_tool_errors: 0 }), [toolReply(request())], /not found/],
    [tool(async () => { throw new ToolError('not found', { code: 'ENOENT', recoverable: true }); }), node({ max_tool_errors: 1 }), [toolReply(request('a')), toolReply(request('b'))], /not found/],
    [tool(async () => { throw new ToolError('scope denied', { code: 'SCOPE', recoverable: true }); }), node(), [toolReply(request())], /scope denied/],
  ]) await failure(makeHarness(sequence(responses), { tools: [definition] })(graph, n, { question: 'q' }), pattern, (error) => { assert.ok(error.calls >= 1); assert.ok(error.toolCalls >= 1); assert.ok(error.usage.cost > 0); });
});

test('final contracts allow one bounded repair and never return empty/truncated success', async () => {
  const seen = [], n = node({ tools: [], output: 'json', model: 'cheap', fallback_model: 'stronger' });
  n.outputSchema = { type: 'object', properties: { answer: { type: 'string', minLength: 1 } }, required: ['answer'], additionalProperties: false };
  const result = await makeHarness(sequence([reply('{}'), reply('{"answer":"Grounded"}')], seen))(graph, n, { question: 'q' });
  assert.deepEqual(result.value, { answer: 'Grounded' });
  assert.equal(result.calls, 2); assert.equal(result.usage.cost, 0.002);
  assert.deepEqual(seen.map((r) => r.model), ['cheap', 'stronger']);
  await failure(makeHarness(sequence([reply(''), reply('')]))(graph, node({ tools: [] }), { question: 'q' }), /no final result/, (error) => { assert.equal(error.calls, 2); assert.equal(error.usage.cost, 0.002); });
  await failure(makeHarness(sequence([{ ...reply('Complete-looking'), stop: 'length' }]))(graph, node({ tools: [], max_attempts: 1 }), { question: 'q' }), /without a complete result/, (error) => { assert.equal(error.calls, 1); });
  const repaired = await makeHarness(sequence([{ ...reply('incomplete'), stop: 'max_tokens' }, reply('Complete')]))(graph, node({ tools: [] }), { question: 'q' });
  assert.equal(repaired.text, 'Complete'); assert.equal(repaired.calls, 2); assert.equal(repaired.usage.cost, 0.002);
  await failure(makeHarness(sequence([{ ...toolReply(request()), stop: 'length' }]), { tools: [tool(async () => 'never')] })(graph, node(), { question: 'q' }), /tool calls were truncated/, (error) => { assert.equal(error.toolCalls, 0); });
  await failure(makeHarness(sequence([{ ...reply(''), stop: 'tool_use' }]))(graph, node({ tools: [] }), { question: 'q' }), /supplied no tool calls/);
});

test('model transport/budget errors retain prior tool and model usage once', async () => {
  const blocked = Object.assign(new Error('cost guard'), { calls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } });
  await failure(makeHarness(sequence([toolReply(request()), blocked]), { tools: [tool(async () => 'fact')] })(graph, node(), { question: 'q' }), /cost guard/, (error) => {
    assert.equal(error.calls, 1); assert.equal(error.toolCalls, 1); assert.equal(error.usage.cost, 0.001); assert.equal(error.usage.input, 10);
  });
  const failed = Object.assign(new Error('model failed'), { calls: 1, usage: { ...usage, cost: null } });
  await failure(makeHarness(sequence([toolReply(request()), failed]), { tools: [tool(async () => 'fact')] })(graph, node(), { question: 'q' }), /model failed/, (error) => { assert.equal(error.calls, 2); assert.equal(error.usage.cost, null); assert.equal(error.usage.input, 20); });
});

test('rich tool schemas require an explicit trusted argument validator', async () => {
  const rich = { type: 'object', properties: { query: { type: 'string', format: 'uri' } }, required: ['query'] };
  assert.throws(() => makeHarness(async () => reply('unused'), { tools: [tool(async () => 'ok', { input_schema: rich })] }), /unsupported input_schema.*format/);
  const definition = tool(async () => 'ok', { input_schema: rich, validateInput: (args) => args.query === 'allowed' ? [] : ['query must be allowed'] });
  const r = await makeHarness(sequence([toolReply(request('a', 'lookup', { query: 'allowed' })), reply('Done')]), { tools: [definition] })(graph, node(), { question: 'q' });
  assert.equal(r.toolCalls, 1);
  await failure(makeHarness(sequence([toolReply(request())]), { tools: [definition] })(graph, node(), { question: 'q' }), /invalid arguments.*allowed/, (error) => { assert.equal(error.toolCalls, 0); assert.equal(error.calls, 1); });
});

test('explicit empty tools work; bad config/context/input fail before paid calls', async () => {
  const r = await makeHarness(sequence([reply('Done')]))(graph, node({ tools: [] }), { question: 'q' });
  assert.equal(r.calls, 1); assert.equal(r.toolCalls, 0);
  let calls = 0;
  const call = async () => { calls++; return reply('unused'); };
  for (const n of [node({ tools: undefined }), node({ tools: ['absent'] }), node({ max_turns: 65 }), { ...node(), sets: [] }]) await failure(makeHarness(call)(graph, n, { question: 'q' }), /explicit list|not registered|max_turns|output path/, (error) => { assert.equal(error.calls, 0); assert.equal(error.usage.cost, 0); });
  await failure(makeHarness(call, { maxContextBytes: 10 })(graph, node({ tools: [] }), { question: 'q' }), /context exceeds/, (error) => { assert.equal(error.calls, 0); });
  await failure(makeHarness(call)(graph, node({ tools: [] }), { question: NaN }), /invalid JSON state/, (error) => { assert.equal(error.calls, 0); });
  assert.equal(calls, 0);
});

test('registered prototype-looking names are resolved by Map rather than inheritance', async () => {
  const definition = tool(async () => 'safe', { name: 'constructor' });
  const r = await makeHarness(sequence([toolReply(request('a', 'constructor')), reply('Done')]), { tools: [definition] })(graph, node({ tools: ['constructor'] }), { question: 'q' });
  assert.equal(r.toolCalls, 1);
  assert.throws(() => makeHarness(async () => reply('unused'), { tools: [definition, definition] }), /duplicate registered tool/);
});

test('traditional harness observes a failing check, writes a guarded fix, and verifies it before finishing', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'wayfile-harness-execution-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'answer.txt'), 'old');
  const n = node({ tools: ['read-file', 'write-file', 'shell'], output: 'json', max_turns: 6, max_tool_calls: 6 });
  n.outputSchema = { type: 'object', required: ['updated', 'proof'], additionalProperties: false, properties: { updated: { type: 'boolean' }, proof: { type: 'array', items: { type: 'string' }, minItems: 2 } } };
  let turn = 0, expectedHash;
  const resultFor = (request) => JSON.parse(request.messages.at(-1).content[0].content);
  const call = async (r) => {
    turn++;
    if (turn === 1) return toolReply(request('read', 'read-file', { path: 'answer.txt' }));
    if (turn === 2) { const read = resultFor(r); assert.equal(read.text, 'old'); expectedHash = read.sha256; return toolReply(request('before', 'shell', { command: 'test "$(cat answer.txt)" = new' })); }
    if (turn === 3) { assert.equal(resultFor(r).exitCode, 1); return toolReply(request('write', 'write-file', { path: 'answer.txt', content: 'new', expected_sha256: expectedHash })); }
    if (turn === 4) { assert.equal(resultFor(r).written, true); return toolReply(request('after', 'shell', { command: 'test "$(cat answer.txt)" = new' })); }
    assert.equal(resultFor(r).exitCode, 0);
    return reply('{"updated":true,"proof":["write-file:write","shell:after"]}');
  };
  const tools = createProjectTools({ workspace, allowWrite: true, allowShell: true, authorize: ({ tool, node }) => node.meta.tools.includes(tool) });
  const result = await makeHarness(call, { tools })(graph, n, { question: 'Update answer and verify the check.' });
  assert.equal(await readFile(join(workspace, 'answer.txt'), 'utf8'), 'new');
  assert.deepEqual(result.value, { updated: true, proof: ['write-file:write', 'shell:after'] });
  assert.equal(result.calls, 5); assert.equal(result.toolCalls, 4); assert.equal(result.usage.cost, 0.005);
  assert.equal(result.toolEvents[1].result.exitCode, 1);
  assert.equal(result.toolEvents[3].result.exitCode, 0);
});
