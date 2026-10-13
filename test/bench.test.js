import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases, tickets, ciCases } from '../bench/cases.js';
import { agent, bashSystem, eveSystem, skills, OUTCOMES } from '../bench/agents.js';
import { summarize, gate, cost, PRICES } from '../bench/run.js';
import { loadGraph } from '../src/parse.js';

const reply = (content) => ({ content, text: content.filter((c) => c.type === 'text').map((c) => c.text).join(''), usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 } });

test('70 labelled cases with valid outcomes', () => {
  assert.equal(tickets.length, 50);
  assert.equal(ciCases.length, 20);
  assert.ok(cases.every((c) => OUTCOMES[c.graph].includes(c.expect)));
});

test('bash baseline: policy in prompt, runs tools, sums usage', async () => {
  assert.match(bashSystem('ci'), /known-flaky list/);
  const replies = [reply([{ type: 'tool_use', id: 'u1', name: 'bash', input: { cmd: `echo '{"ticket":{"body":"refund order 4"}}' | ./lookup-order.sh` } }]), reply([{ type: 'text', text: '{"route": "refund"}' }])];
  const seen = [];
  const call = async (req) => { seen.push(structuredClone(req)); return replies.shift(); };
  const r = await agent('bash', call, tickets[0]);
  assert.deepEqual(r, { end: 'refund', calls: 2, steps: 2, usage: { input: 20, output: 4, cacheRead: 2, cacheWrite: 0, cost: 0 } });
  assert.deepEqual(seen[0].tools.map((t) => t.name), ['bash']);
  assert.match(JSON.stringify(seen[1].messages.at(-1)), /delivered/);
});

test('eve-style: only skill descriptions up front, body loaded on demand', async () => {
  const sys = eveSystem('ci');
  const tests = skills('ci').find((s) => s.name === 'tests');
  assert.match(sys, /- tests: A test failed\./);
  assert.ok(!sys.includes(tests.body.trim()));
  const replies = [reply([{ type: 'tool_use', id: 'u1', name: 'skill', input: { name: 'tests' } }]), reply([{ type: 'text', text: '{"route":"quarantine-test"}' }])];
  const seen = [];
  const r = await agent('eve', async (req) => { seen.push(structuredClone(req)); return replies.shift(); }, ciCases[13]);
  assert.equal(r.end, 'quarantine-test');
  assert.ok(JSON.stringify(seen[1].messages.at(-1)).includes('flaky.txt'));
});

test('cost uses the price table', () => {
  assert.equal(cost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }, PRICES['claude-haiku-4-5']), 1 + 5 + 0.1 + 1.25);
  assert.equal(cost({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, undefined), null);
});

test('gate: GO, NO-GO by bash ratio, PENDING when dry', () => {
  const g = [loadGraph(new URL('../examples/triage', import.meta.url).pathname), loadGraph(new URL('../examples/ci', import.meta.url).pathname)];
  const arm = (correct, tokens) => ({ correct, tokens });
  assert.equal(gate({ wayfile: arm(60, 100) }, g).decision, 'PENDING (no model run)');
  assert.equal(gate({ wayfile: arm(60, 100), bash: arm(60, 600), eve: arm(59, 500) }, g).decision, 'GO');
  assert.equal(gate({ wayfile: arm(60, 100), bash: arm(60, 250), eve: arm(59, 900) }, g).decision, 'NO-GO');
  assert.equal(gate({ wayfile: arm(55, 100), bash: arm(60, 900), eve: arm(60, 900) }, g).decision, 'NO-GO (5x/accuracy bar not met)');
  assert.equal(gate({ wayfile: arm(1, 1) }, g).judgeNodes, '2/18');
});

test('summarize counts accuracy and model-step share', () => {
  const rows = [{ expect: 'a', x: { end: 'a', calls: 1, steps: 2, usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 }, ms: 3 } }, { expect: 'b', x: { end: 'c', calls: 0, steps: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ms: 1 } }];
  const s = summarize(rows, 'x', PRICES['claude-haiku-4-5']);
  assert.equal(s.correct, 1); assert.equal(s.modelStepShare, 0.25); assert.equal(s.tokens, 6);
});

test('openrouter adapter: maps tools both ways, reads usage.cost, cost guard stops', async () => {
  const { openrouter } = await import('../src/model.js');
  const bodies = [];
  const fetchFn = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ model: 'm', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 7, cost: 2, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } } });
  };
  const call = openrouter({ apiKey: 'test', maxUsd: 3, fetchFn });
  const r = await call({ system: 's', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'c0', name: 'bash', input: { cmd: 'pwd' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c0', content: '/x' }] }], tools: [{ name: 'bash', description: 'd', input_schema: { type: 'object' } }] });
  assert.deepEqual(r.content, [{ type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } }]);
  assert.deepEqual(r.usage, { input: 60, output: 7, cacheRead: 30, cacheWrite: 10, cost: 2 });
  const b = bodies[0];
  assert.deepEqual(b.usage, { include: true });
  assert.equal(b.tools[0].function.name, 'bash');
  assert.deepEqual(b.messages.slice(2).map((m) => m.role), ['assistant', 'tool']);
  assert.equal(b.messages[2].tool_calls[0].function.arguments, '{"cmd":"pwd"}');
  await call({ system: 's', messages: [{ role: 'user', content: 'x' }] }); // spent 4 now
  await assert.rejects(call({ system: 's', messages: [{ role: 'user', content: 'x' }] }), /cost guard/);
  assert.equal(bodies.length, 2);
});
