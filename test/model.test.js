import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePrompt, makeJudge, makeSkill, openrouter, anthropic } from '../packages/wayfile/src/model.js';
import { parseNode } from '../packages/wayfile/src/parse.js';

const n = () => parseNode('---\nkind: judge\nneeds: [request, facts]\n---\n# Classify\nUse supplied facts.\n## Routes\n- judge: "is work needed?" → [[work]]\n- otherwise → [[stop]]', 'choose.md');
const graph = () => ({ instructions: 'Respect the policy.', nodes: {
  choose: n(), work: { id: 'work', title: 'Do work', body: 'Only with sufficient evidence.' },
  stop: { id: 'stop', title: 'Stop', body: 'Insufficient evidence or no work needed.' },
  unrelated: { id: 'unrelated', title: 'Private unrelated catalog', body: 'Do not load this.' },
} });
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.001 };
const reply = (text, extra = {}) => ({ text, usage, model: 'test-model', ...extra });

test('judge context is limited to candidate routes and declared evidence, including missing fields', () => {
  const g = graph();
  const p = judgePrompt(g, g.nodes.choose, { request: 'help', secret: 'never send' }, ['work', 'stop']);
  assert.match(p.system, /Only with sufficient evidence/);
  assert.doesNotMatch(p.system, /Private unrelated catalog/);
  assert.doesNotMatch(p.user, /never send/);
  assert.match(p.user, /Missing fields: \["facts"\]/);
});

test('invalid structured routing answers get one bounded repair with all paid usage counted', async () => {
  const g = graph(), seen = [];
  g.nodes.choose.meta.model = 'cheap';
  g.nodes.choose.meta.fallback_model = 'stronger';
  const responses = [reply('I think {"target":"work"}'), reply('{"target":"work"}')];
  const call = async (request) => { seen.push(request); return responses.shift(); };
  call.cacheKey = 'provider-and-default-model';
  const judge = makeJudge(call);
  const result = await judge(g, g.nodes.choose, { request: 'help' }, ['work', 'stop']);
  assert.equal(result.target, 'work');
  assert.equal(result.calls, 2);
  assert.equal(result.usage.cost, 0.002);
  assert.equal(result.usage.input, 20);
  assert.deepEqual(seen.map((x) => x.model), ['cheap', 'stronger']);
  assert.match(seen[1].messages.at(-1).content, /failed validation/);
  assert.ok(judge.cacheKey);
});

test('extra fields, unknown targets and truncated output never silently choose otherwise', async () => {
  const g = graph();
  for (const response of [reply('{"target":"work","extra":true}'), reply('{"target":"unrelated"}'), reply('{"target":"stop"}', { stop: 'length' })]) {
    const judge = makeJudge(async () => response, { maxAttempts: 1 });
    await assert.rejects(judge(g, g.nodes.choose, {}, ['work', 'stop']), (error) => {
      assert.equal(error.calls, 1);
      assert.equal(error.usage.cost, 0.001);
      return /failed validation/.test(error.message);
    });
  }
});

test('second invalid answer fails explicitly and preserves unknown cost', async () => {
  const g = graph();
  let count = 0;
  const judge = makeJudge(async () => { count++; return reply('', { usage: { ...usage, cost: null } }); });
  await assert.rejects(judge(g, g.nodes.choose, {}, ['work', 'stop']), (error) => {
    assert.equal(error.calls, 2);
    assert.equal(error.usage.cost, null);
    assert.equal(error.usage.input, 20);
    return /after 2 attempt/.test(error.message);
  });
  assert.equal(count, 2);
});

test('transport errors are not automatically repeated', async () => {
  const g = graph();
  let calls = 0;
  await assert.rejects(makeJudge(async () => { calls++; throw new Error('network unavailable'); })(g, g.nodes.choose, {}, ['stop']), /network unavailable/);
  assert.equal(calls, 1);
});

test('failed deterministic candidates are omitted but ambiguous generated evidence is preserved', () => {
  const g = graph(), node = g.nodes.choose;
  node.routes.unshift({ type: 'when', to: 'work', src: 'facts == 1', rule: { '==': [{ var: 'facts' }, 1] } });
  assert.doesNotMatch(judgePrompt(g, node, { facts: 0 }, ['work', 'stop']).system, /facts == 1/);
  node.kind = 'skill'; node.sets = ['generated']; node.meta.routing = 'ambiguous';
  node.routes.unshift({ type: 'when', to: 'stop', src: 'generated == 1', rule: { '==': [{ var: 'generated' }, 1] } });
  const p = judgePrompt(g, node, { facts: 1, generated: 1 }, ['work', 'stop']);
  assert.match(p.system, /facts == 1/);
  assert.match(p.system, /generated == 1/);
  assert.match(p.user, /"generated":1/);
});

test('skill contracts repair missing required fields and return a typed value', async () => {
  const node = { ...n(), kind: 'skill', meta: { output: 'json' }, sets: ['answer'], outputSchema: {
    type: 'object', required: ['answer', 'missing'], additionalProperties: false,
    properties: { answer: { type: 'string', minLength: 1 }, missing: { type: 'array', items: { type: 'string' } } },
  } };
  const responses = [reply('{"answer":"Unknown"}'), reply('{"answer":"Unknown","missing":["facts"]}')];
  const result = await makeSkill(async () => responses.shift())(graph(), node, { request: 'what happened?' });
  assert.deepEqual(result.value, { answer: 'Unknown', missing: ['facts'] });
  assert.equal(result.calls, 2);
  assert.equal(result.usage.cost, 0.002);
  await assert.rejects(makeSkill(async () => reply(' '))(graph(), { ...node, meta: { max_attempts: 1 } }, {}), /empty model output/);
});

test('OpenRouter retains billed usage if malformed tool arguments prevent decoding', async () => {
  const ledger = { spent: 0 };
  const call = openrouter({ apiKey: 'test', ledger, fetchFn: async () => Response.json({ model: 'm', choices: [{ message: {
    content: null, tool_calls: [{ id: 'c1', function: { name: 'tool', arguments: 'broken json' } }],
  }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }) });
  await assert.rejects(call({ system: 's', messages: [] }), (error) => {
    assert.equal(error.usage.cost, 0.001);
    assert.equal(error.calls, 1);
    return true;
  });
  assert.equal(ledger.spent, 0.001);
});

test('invalid budgets cannot disable the spend guard', async () => {
  for (const maxUsd of [NaN, Infinity, -1]) assert.throws(() => openrouter({ apiKey: 'test', maxUsd }), /maxUsd/);
  assert.throws(() => openrouter({ apiKey: 'test', ledger: { spent: NaN } }), /ledger.spent/);
  let calls = 0;
  const call = openrouter({ apiKey: 'test', maxUsd: 0, fetchFn: async () => { calls++; } });
  await assert.rejects(call({ system: 's', messages: [] }), (error) => {
    assert.equal(error.calls, 0); assert.equal(error.usage.cost, 0);
    return /cost guard/.test(error.message);
  });
  assert.equal(calls, 0);
});

test('budget-blocked repair retains only the first billed request', async () => {
  let calls = 0;
  const call = openrouter({ apiKey: 'test', maxUsd: 0.001, fetchFn: async () => {
    calls++;
    return Response.json({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'invalid' } }],
      usage: { prompt_tokens: 20, completion_tokens: 4, cost: 0.001 } });
  } });
  await assert.rejects(makeJudge(call)(graph(), n(), {}, ['work', 'stop']), (error) => {
    assert.equal(error.calls, 1);
    assert.equal(error.usage.cost, 0.001);
    assert.equal(error.usage.input, 20);
    return /cost guard/.test(error.message);
  });
  assert.equal(calls, 1);
});

test('missing billed cost fails while preserving available token measurements', async () => {
  let requests = 0;
  const call = openrouter({ apiKey: 'test', fetchFn: async () => {
    requests++;
    return Response.json({ model: 'm', choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } });
  } });
  await assert.rejects(makeSkill(call)(graph(), { ...n(), kind: 'skill', meta: {} }, {}), (error) => {
    assert.equal(error.usage.input, 20);
    assert.equal(error.usage.output, 4);
    assert.equal(error.usage.cost, null);
    return /no valid usage.cost/.test(error.message);
  });
  await assert.rejects(call({ system: 's', messages: [] }), /unreported spend must be reconciled/);
  assert.equal(requests, 1);
});

test('lost OpenRouter responses block further spend until the ledger is reconciled', async () => {
  for (const fetchReply of [async () => { throw new Error('connection lost'); }, async () => new Response('truncated JSON')]) {
    let requests = 0;
    const ledger = { spent: 0 };
    const call = openrouter({ apiKey: 'test', ledger, fetchFn: async (...args) => { requests++; return fetchReply(...args); } });
    await assert.rejects(call({ system: 's', messages: [] }), (error) => {
      assert.equal(error.calls, 1);
      assert.equal(error.usage.cost, null);
      return true;
    });
    assert.equal(ledger.unknownCost, true);
    await assert.rejects(call({ system: 's', messages: [] }), /unreported spend must be reconciled/);
    assert.equal(requests, 1);
  }
});

test('ambiguous or empty tool argument JSON is rejected with billed usage intact', async () => {
  for (const args of ['{"query":"first","\\u0071uery":"last"}', '']) {
    const call = openrouter({ apiKey: 'test', fetchFn: async () => Response.json({ model: 'm', choices: [{ message: {
      tool_calls: [{ id: 't', function: { name: 'search-files', arguments: args } }],
    }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }) });
    await assert.rejects(call({ system: 's', messages: [] }), (error) => {
      assert.equal(error.usage.cost, 0.001);
      return /duplicate JSON|empty model/.test(error.message);
    });
  }
});

test('Anthropic decoding failures retain measured tokens and response provenance', async () => {
  const call = anthropic({ apiKey: 'test', fetchFn: async () => Response.json({
    id: 'r', model: 'm', usage: { input_tokens: 99, output_tokens: 7 }, content: null,
  }) });
  await assert.rejects(makeSkill(call)(graph(), { ...n(), kind: 'skill', meta: {} }, {}), (error) => {
    assert.equal(error.calls, 1);
    assert.equal(error.usage.input, 99);
    assert.equal(error.usage.output, 7);
    assert.equal(error.usage.cost, null);
    assert.equal(error.id, 'r');
    return /content array/.test(error.message);
  });
});

test('known model preflight failures are zero-call failures with known zero spend', async () => {
  let calls = 0;
  const call = async () => { calls++; return reply('unused'); };
  const badNodes = [
    { ...n(), kind: 'skill', meta: { output: 'json' } },
    { ...n(), kind: 'skill', meta: { output: 'json' }, outputSchema: { type: 'string', format: 'email' } },
    { ...n(), kind: 'skill', meta: { max_attempts: 9 } },
  ];
  for (const node of badNodes) await assert.rejects(makeSkill(call)(graph(), node, {}), (error) => {
    assert.equal(error.calls, 0);
    assert.equal(error.usage.cost, 0);
    return true;
  });
  assert.equal(calls, 0);
});

test('attempt provenance separates the requested model from actual response evidence', async () => {
  const failed = openrouter({ apiKey: 'test', model: 'requested', fetchFn: async () => Response.json({
    id: 'response-id', model: 'actual', provider: 'p', choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
  }) });
  await assert.rejects(makeJudge(failed)(graph(), n(), {}, ['stop']), (error) => {
    const attempt = error.attempts[0];
    assert.equal(attempt.model, 'actual');
    assert.equal(attempt.requestedModel, 'requested');
    assert.equal(attempt.id, 'response-id');
    assert.equal(attempt.provider, 'p');
    assert.equal(attempt.rawUsage.cost, 0.001);
    return true;
  });
  const silent = async () => ({ text: '{"target":"stop"}', usage });
  silent.model = 'requested';
  const result = await makeJudge(silent)(graph(), n(), {}, ['stop']);
  assert.equal(result.attempts[0].model, null);
  assert.equal(result.attempts[0].requestedModel, 'requested');
});

test('filtered, refused or tool-only replies cannot complete a judge or skill and never auto-repair', async () => {
  for (const stop of ['content_filter', 'refusal', 'tool_use', 'tool_calls']) {
    let calls = 0;
    const call = async () => { calls++; return reply('{"target":"stop"}', { stop }); };
    for (const adapter of [makeJudge(call), makeSkill(call)]) {
      await assert.rejects(adapter(graph(), n(), {}, ['stop']), (error) => {
        assert.equal(error.calls, 1);
        assert.equal(error.usage.cost, 0.001);
        return /did not return a final answer/.test(error.message);
      });
    }
    assert.equal(calls, 2);
  }
});

test('malformed envelopes and provider error bodies cannot drop billed usage or allow uncertain spend', async () => {
  const ledger = { spent: 0 };
  let calls = 0;
  const malformed = openrouter({ apiKey: 'test', ledger, fetchFn: async () => { calls++; return Response.json(null); } });
  await assert.rejects(malformed({ system: 's', messages: [] }), /JSON object/);
  assert.equal(ledger.unknownCost, true);
  await assert.rejects(malformed({ system: 's', messages: [] }), /unreported spend/);
  assert.equal(calls, 1);
  const billed = { spent: 0 };
  const providerError = openrouter({ apiKey: 'test', ledger: billed, fetchFn: async () => Response.json({
    id: 'failure-id', model: 'actual', error: { message: 'generation failed' },
    usage: { prompt_tokens: 40, completion_tokens: 8, cost: 0.005 },
  }, { status: 500 }) });
  await assert.rejects(providerError({ system: 's', messages: [] }), (error) => {
    assert.equal(error.usage.input, 40);
    assert.equal(error.usage.output, 8);
    assert.equal(error.usage.cost, 0.005);
    assert.equal(error.calls, 1);
    assert.equal(error.id, 'failure-id');
    return /openrouter 500/.test(error.message);
  });
  assert.equal(billed.spent, 0.005);
});
