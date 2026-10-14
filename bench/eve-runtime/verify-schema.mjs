import assert from 'node:assert/strict';
import { startRuntime, stopRuntime } from './adapter.mjs';
import { assertEvidenceReplySchema } from './schema-check.mjs';
import { evidenceOutputSchema } from '../evidence-policy.js';

// Literal native JSON Schema probe: no inference service or credentials are
// involved, and the fake provider does not implement an agent harness.
const outputSchema = { type: 'object', additionalProperties: false, required: ['amount', 'currency'], properties: {
  amount: { type: ['number', 'null'], minimum: 0 }, currency: { type: ['string', 'null'], enum: ['USD', 'EUR', null] },
} };
let active;
const schemas = [];
const runtime = await startRuntime({ mock: false, allowPaid: true, apiKey: 'offline-test-key', providerFetch: async (_url, options) => {
  const request = JSON.parse(options.body);
  const actual = request.tools.find((tool) => tool.function.name === 'eve__reply')?.function.parameters;
  assertEvidenceReplySchema(actual);
  assert.deepEqual(actual, active.schema, 'The native tool sent by the installed SDK must preserve nullable types.');
  schemas.push(actual);
  active.calls++;
  const output = active.invalidFirst && active.calls === 1 ? { amount: '125', currency: 'USD' } : active.output;
  const data = { id: `offline-nullable-${active.id}-${active.calls}`, model: request.model, provider: 'offline-fixture',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `reply-${active.calls}`, type: 'function', function: { name: 'eve__reply', arguments: JSON.stringify(output) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0 }, };
  return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
} });
try {
  const server = await runtime.ensureServer('evidence');
  for (const scenario of [
    { id: 'number', output: { amount: 125, currency: 'USD' } },
    { id: 'null', output: { amount: null, currency: null } },
    { id: 'reject-string', output: { amount: 125, currency: 'USD' }, invalidFirst: true },
    { id: 'shared-v2', schema: evidenceOutputSchema, output: { decision: 'refund', reason_code: 'eligible_return', amount: 125, currency: 'USD',
      summary: 'The order is eligible for a refund; no payment has been issued.', sources: ['customers:ada@1', 'orders:a17@2', 'policies:US@3'] } },
  ]) {
    active = { schema: outputSchema, ...scenario, calls: 0 };
    runtime.meter.beginCase({ id: scenario.id });
    const { session, response } = await server.client.sessions.create({
      message: JSON.stringify({ fixture: 'wayfile-routing-v1', input: { customerId: 'ada', approval: 'yes', prompt: 'Offline schema probe' } }), outputSchema: active.schema,
    });
    const result = await response.result();
    await session.reset({ reason: 'Offline nullable schema probe complete' });
    await runtime.meter.endCase();
    assert.deepEqual(result.data, scenario.output);
    assert.equal(active.calls, scenario.invalidFirst ? 2 : 1, 'A string amount must fail native validation before a valid response can complete.');
  }
  assert.equal(schemas.length, 5);
  for (const event of runtime.meter.requests) {
    assertEvidenceReplySchema(event.outputSchema);
    assert.equal(typeof event.outputSchemaHash, 'string');
  }
  console.log('Verified native Eve → installed SDK nullable schemas and full shared V2 contract unchanged; numbers/null accepted, string amount rejected then repaired. Zero upstream network calls.');
  console.log(`Schema probe artifacts: ${runtime.artifactDir}`);
} finally { await stopRuntime(runtime); }
