import test from 'node:test';
import assert from 'node:assert/strict';
import { startMeter, normalizeOpenRouterUsage, providerRecords } from '../meter.mjs';

const send = (meter, body = {}) => fetch(`${meter.url}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer local-meter-only', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'unused', messages: [{ role: 'system', content: 'Policy' }], ...body }) });
const response = (cost = 0.001) => new Response(JSON.stringify({ id: 'fixture-id', model: 'anthropic/claude-haiku-5.5', provider: 'offline', usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, ...(cost === null ? {} : { cost }) } }), { headers: { 'content-type': 'application/json' } });

test('provider token categories do not double count caches', () => {
  assert.deepEqual(normalizeOpenRouterUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, cost: 0 }), { input: 70, output: 5, cacheRead: 20, cacheWrite: 10, cost: 0 });
  assert.equal(normalizeOpenRouterUsage({ prompt_tokens: 1, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } }), null);
});

test('meter matches provider settings and debits the shared ledger before returning', async () => {
  const ledger = { spent: 0.002 }, seen = [];
  const meter = await startMeter({ apiKey: 'offline-test', ledger, maxUsd: 0.01, fetchFn: async (_url, opts) => { seen.push(JSON.parse(opts.body)); return response(); } });
  try {
    meter.beginCase({ id: 'test', maxTokens: 800 });
    const res = await send(meter, { stream: false }); await res.text(); await meter.endCase();
    assert.equal(ledger.spent, 0.003);
    assert.equal(seen[0].model, 'anthropic/claude-haiku-5.5'); assert.equal(seen[0].temperature, 0); assert.equal(seen[0].max_tokens, 800);
    assert.deepEqual(seen[0].messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.equal(meter.requests[0].costMeasured, true); assert.equal(meter.requests[0].responseId, 'fixture-id');
  } finally { await meter.stop(); }
});

test('missing reported charge locks the shared ledger across later cases', async () => {
  const ledger = { spent: 0 }, meter = await startMeter({ apiKey: 'offline-test', ledger, fetchFn: async () => response(null) });
  try {
    meter.beginCase({ id: 'unknown' }); await (await send(meter)).text(); await meter.endCase();
    assert.equal(ledger.unknownCost, true); assert.equal(meter.requests[0].costMeasured, false);
    meter.beginCase({ id: 'next' }); assert.equal((await send(meter)).status, 403); await meter.endCase();
    assert.equal(meter.requests.length, 1);
  } finally { await meter.stop(); }
});

test('split UTF-8 SSE preserves model/provider metadata and zero-cost usage', async () => {
  const text = `data: ${JSON.stringify({ id: 'utf8', model: 'anthropic/claude-haiku-5.5', provider: 'café', usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 } })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text), split = bytes.indexOf(0xc3) + 1;
  const meter = await startMeter({ apiKey: 'offline-test', fetchFn: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    meter.beginCase({ id: 'utf8' }); await (await send(meter)).text(); await meter.endCase();
    assert.equal(meter.requests[0].provider, 'café'); assert.equal(meter.requests[0].measuredCost, 0);
    assert.equal(providerRecords(text, 'text/event-stream').length, 1);
  } finally { await meter.stop(); }
});

test('budget and request ceilings stop new provider invocations', async () => {
  const meter = await startMeter({ apiKey: 'offline-test', maxCalls: 1, maxUsd: 0.001, fetchFn: async () => response() });
  try {
    meter.beginCase({ id: 'limit' }); await (await send(meter)).text();
    assert.equal((await send(meter)).status, 403); await meter.endCase();
    meter.beginCase({ id: 'later' }); assert.equal((await send(meter)).status, 403); await meter.endCase();
    assert.equal(meter.requests.length, 1);
  } finally { await meter.stop(); }
});
