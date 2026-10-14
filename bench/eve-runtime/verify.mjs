import assert from 'node:assert/strict';
import { startRuntime, stopRuntime, runCase, runEvidenceCase } from './adapter.mjs';
import { scoreCase, scoreEvidenceOutput } from '../contracts.js';
import { evidenceTasks, evidenceContract, resolveEvidence } from '../evidence-tasks.js';

const runtime = await startRuntime({ mock: true });
const sessions = new Set();
let count = 0;
try {
  const cases = [
    { id: 'verify-approved-refund', graph: 'triage', expect: 'refund', input: { ticket: { body: 'Please refund order 716.', amount: 501 } }, contract: { evidence: [{ kind: 'approval', answer: 'yes' }, { kind: 'order-lookup', set: { 'order.status': 'delivered' } }], approvalBeforeLookup: true } },
    { id: 'verify-denied-refund', graph: 'triage', expect: 'general-reply', input: { ticket: { body: 'Please refund order 717.', amount: 600 }, stub: { ask: 'no' } }, contract: { evidence: [{ kind: 'approval', answer: 'no' }], forbidEvidence: ['order-lookup'] } },
    { id: 'verify-flaky', graph: 'ci', expect: 'quarantine-test', input: { ci: { log: 'FAIL src/clock.test.ts > ticks once', attempt: 1, files_changed: [] } }, contract: { evidence: [{ kind: 'flaky-lookup', set: { 'test.file': 'src/clock.test.ts', 'test.flaky': true } }] } },
    { id: 'verify-denied-security', graph: 'ci', expect: 'human-triage', input: { ci: { log: 'A private key leaked in build output.', attempt: 1, files_changed: [] }, stub: { ask: 'no' } }, contract: { evidence: [{ kind: 'approval', answer: 'no' }] } },
  ];
  for (const c of cases) {
    const result = await runCase(c, { runtime, mock: true });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(scoreCase(c, result).success, true, JSON.stringify(result.evidence));
    assert.equal(result.modelQualityMeasured, false); assert.equal(result.tokensMeasured, false);
    assert.equal(result.provenance.eveVersion, '0.79.0');
    assert.ok(result.calls > 0); assert.ok(!sessions.has(result.provenance.sessionId)); sessions.add(result.provenance.sessionId);
    count++;
  }
  for (const task of evidenceTasks) {
    const result = await runEvidenceCase(task, { runtime, mock: true, maxTokens: 800 });
    assert.equal(result.status, 'completed', result.error);
    const contract = evidenceContract(task, resolveEvidence(task));
    assert.equal(scoreEvidenceOutput(result.text, contract).success, true, result.text);
    for (const source of contract.sources) assert.ok(result.evidence.some((event) => event.kind === 'record-read' && event.source === source));
    if (task.approval === 'no') assert.ok(result.evidence.some((event) => event.kind === 'approval' && event.answer === 'no'));
    assert.ok(!sessions.has(result.provenance.sessionId)); sessions.add(result.provenance.sessionId); count++;
  }
  console.log(`Verified ${count} independent mock sessions through actual Eve 0.79.0 tools/client/output schemas. Model quality and billed token performance remain unmeasured.`);
  console.log(`Protocol artifacts: ${runtime.artifactDir}`);
} finally { await stopRuntime(runtime); }

// The actual OpenAI-compatible SDK and metering route also run against an
// in-memory SSE provider, so this test never contacts OpenRouter or reads a key.
let upstreamCalls = 0;
const transport = await startRuntime({ mock: false, allowPaid: true, apiKey: 'offline-test-key', providerFetch: async (_url, options) => {
  upstreamCalls++;
  const request = JSON.parse(options.body);
  assert.equal(request.model, 'anthropic/claude-haiku-5.5'); assert.equal(request.temperature, 0); assert.equal(request.max_tokens, 400);
  const chunks = [
    { id: 'offline-sdk-1', model: request.model, provider: 'offline-fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'offline-reply', type: 'function', function: { name: 'eve__reply', arguments: '{"route":"general-reply"}' } }] }, finish_reason: null }] },
    { id: 'offline-sdk-1', model: request.model, provider: 'offline-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 20 }, cost: 0 } },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
} });
try {
  const result = await runCase({ id: 'verify-sdk-transport', graph: 'triage', input: { ticket: { body: 'When does support close?', amount: 0 } } }, { runtime: transport, mock: false });
  assert.equal(result.status, 'completed', result.error); assert.equal(result.end, 'general-reply'); assert.equal(result.calls, 1); assert.equal(upstreamCalls, 1);
  assert.equal(result.usage.input, 80); assert.equal(result.usage.cacheRead, 20); assert.equal(result.modelQualityMeasured, false);
  assert.equal(result.requests[0].responseId, 'offline-sdk-1');
  console.log('Verified actual provider SDK → loopback meter → offline SSE → Eve structured result, with zero upstream network calls.');
} finally { await stopRuntime(transport); }

await import('./verify-schema.mjs');
