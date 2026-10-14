import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases, tickets, ciCases } from '../bench/cases.js';
import { dataset } from '../bench/datasets.js';
import { agent, bashSystem, eveSystem, skills, OUTCOMES } from '../bench/agents.js';
import { summarize, paired, gate, cost, PRICES, observeTask, ARMS } from '../bench/run.js';
import { requestRecorder, digest } from '../bench/measurement.js';
import { parseRoute, scoreCase } from '../bench/contracts.js';
import { loadGraph } from '../packages/wayfile/src/parse.js';
import { tmpGraph, node } from './helpers.js';
import { loadLedger, saveLedger } from '../bench/ledger.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const reply = (content, cost = 0.001, stop = 'end_turn') => ({ content, text: content.filter((c) => c.type === 'text').map((c) => c.text).join(''), model: 'fixture-model', provider: 'fixture', stop, usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, cost } });
const textReply = (text, usd = 0.001, stop) => reply([{ type: 'text', text }], usd, stop);

test('legacy repetition and development challenge provenance are explicit', () => {
  assert.equal(tickets.length, 50);
  assert.equal(ciCases.length, 20);
  assert.ok(cases.every((c) => OUTCOMES[c.graph].includes(c.expect)));
  const old = dataset('legacy'), fresh = dataset('challenge');
  assert.equal(new Set(old.cases.filter((c) => c.graph === 'triage').map((c) => c.family)).size, 10);
  assert.equal(fresh.role, 'development');
  assert.ok(fresh.cases.every((c) => c.rationale && OUTCOMES[c.graph].includes(c.expect)));
  assert.notEqual(old.corpusHash, fresh.corpusHash);
  assert.equal(fresh.labelsHash, dataset('challenge').labelsHash);
  assert.throws(() => dataset('unseen'), /unknown dataset/);
});

test('route output rejects extra text, fields, duplicate keys, invalid enum and truncation', () => {
  assert.equal(parseRoute('{"route":"refund"}', OUTCOMES.triage), 'refund');
  for (const text of ['Here: {"route":"refund"}', '{"route":"refund","reason":"x"}', '{"route":"refund","route":"refund"}', '{"route":"refund","\\u0072oute":"general-reply"}', '{"route":"rotate-secret"}', 'null', '[{"route":"refund"}]']) assert.throws(() => parseRoute(text, OUTCOMES.triage));
  assert.throws(() => parseRoute('{"route":"refund"}', OUTCOMES.triage, 'length'), /truncated/);
});

test('bash baseline observes lookup evidence and sums all model requests', async () => {
  assert.match(bashSystem('ci'), /known-flaky list/);
  const responses = [reply([{ type: 'tool_use', id: 'u1', name: 'bash', input: { cmd: `echo '{"ticket":{"body":"refund order 4"}}' | ./lookup-order.sh` } }]), textReply('{"route":"refund"}')];
  const seen = [];
  const r = await agent('bash', async (req) => { seen.push(structuredClone(req)); return responses.shift(); }, tickets[0]);
  assert.equal(r.end, 'refund'); assert.equal(r.calls, 2); assert.equal(r.usage.cost, 0.002);
  assert.deepEqual(seen[0].tools.map((t) => t.name), ['bash', 'ask_approval']);
  assert.equal(r.evidence[0].kind, 'order-lookup');
  assert.equal(r.evidence[0].set['order.status'], 'delivered');
  assert.match(JSON.stringify(seen[1].messages.at(-1)), /delivered/);
});

test('Eve simulation advertises descriptions and observes explicitly denied approval', async () => {
  const sys = eveSystem('ci'), tests = skills('ci').find((s) => s.name === 'tests');
  assert.match(sys, /- tests: A test failed\./);
  assert.ok(!sys.includes(tests.body.trim()));
  const c = dataset('challenge').cases.find((x) => x.id === 'ch-c06');
  const responses = [reply([{ type: 'tool_use', id: 'a1', name: 'ask_approval', input: {} }]), textReply('{"route":"human-triage"}')];
  const seen = [];
  const r = await agent('eve_sim', async (req) => { seen.push(structuredClone(req)); return responses.shift(); }, c);
  assert.deepEqual(r.evidence, [{ kind: 'approval', answer: 'no', simulated: true }]);
  assert.equal(scoreCase(c, r).success, true);
  assert.match(JSON.stringify(seen[1].messages.at(-1)), /no/);
});

test('baseline permits one validation repair, counts its cost and fails after the second invalid output', async () => {
  let responses = [textReply(''), textReply('{"route":"general-reply"}')];
  const r = await agent('bash', async () => responses.shift(), tickets[9]);
  assert.equal(r.calls, 2); assert.equal(r.validationRepairs, 1); assert.equal(r.usage.cost, 0.002);
  responses = [textReply('{"route":"unknown"}'), textReply('not JSON')];
  await assert.rejects(agent('bash', async () => responses.shift(), tickets[9]), (e) => e.partial.calls === 2 && e.partial.usage.cost === 0.002);
});

test('request journal retains spent responses after tool decoding throws and accepts zero cost', async () => {
  const { openrouter } = await import('../packages/wayfile/src/model.js');
  const ledger = { spent: 1 };
  const base = openrouter({ apiKey: 'fixture', ledger, fetchFn: async () => Response.json({ model: 'actual-m', provider: 'actual-p', choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{bad' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.2 } }) });
  const recorder = requestRecorder(base, { ledger });
  await assert.rejects(recorder.call({ system: 's', messages: [{ role: 'user', content: 'x' }] }));
  const measured = recorder.measurement();
  assert.equal(measured.calls, 1); assert.equal(measured.usd, 0.2); assert.equal(measured.usage.input, 12);
  assert.equal(recorder.events[0].model, 'actual-m'); assert.equal(recorder.events[0].provider, 'actual-p');
  const zero = requestRecorder(async () => textReply('{"route":"general-reply"}', 0));
  await zero.call({ system: 's', messages: [] });
  assert.equal(zero.measurement().costMeasured, true); assert.equal(zero.measurement().usd, 0);
});

test('unknown cost remains unknown while the known paid subtotal survives', async () => {
  const responses = [textReply('a', 0.2), textReply('b', null)];
  const recorder = requestRecorder(async () => responses.shift());
  await recorder.call({ system: 's', messages: [] }); await recorder.call({ system: 's', messages: [] });
  assert.equal(recorder.measurement().usd, null);
  assert.equal(recorder.measurement().knownUsd, 0.2);
  assert.equal(recorder.measurement().unknownCostCalls, 1);
});

test('unknown-cost budget flag survives ledger reload and blocked calls are not provider invocations', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wayfile-ledger-')), 'spend.json');
  saveLedger({ spent: 0.2, models: { m: 1 }, unknownCost: true }, file);
  assert.equal(loadLedger(file).unknownCost, true);
  const recorder = requestRecorder(async () => { const error = new Error('cost guard'); Object.assign(error, { calls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }); throw error; });
  await assert.rejects(recorder.call({ system: 's', messages: [] }));
  assert.equal(recorder.measurement().calls, 0); assert.equal(recorder.measurement().usd, 0);
  assert.equal(recorder.events[0].providerCall, false);
});

test('failed Wayfile judge repairs retain spend and failure observation, rather than choosing a route', async () => {
  const graph = loadGraph(tmpGraph({ 'a.md': node('entry: true\nkind: judge', ['- judge: "choose" → [[b]]', '- otherwise → [[c]]']), 'b.md': node('kind: end'), 'c.md': node('kind: end') }));
  const c = { id: 'fixture', graph: 'triage', family: 'fixture', input: {}, expect: 'c' };
  const call = Object.assign(async () => textReply('bad JSON', 0.02), { model: 'fixture-model' });
  const r = await observeTask(c, 'wayfile', { graph, call });
  assert.equal(r.status, 'failed'); assert.equal(r.end, null); assert.equal(r.success, false);
  assert.equal(r.calls, 2); assert.equal(r.usd, 0.04); assert.equal(r.requests.length, 2);
  assert.ok(r.steps.length > 0);
  const dry = await observeTask(c, 'wayfile', { graph, dry: true });
  assert.equal(dry.status, 'unresolved'); assert.equal(dry.observationComplete, false);
});

test('full success requires evidence and approval order even when the route is correct', () => {
  const c = dataset('challenge').cases.find((x) => x.id === 'ch-t06');
  const approval = { kind: 'approval', answer: 'yes' }, lookup = { kind: 'order-lookup', set: { 'order.status': 'delivered' } };
  const r = { end: 'refund', status: 'completed', evidence: [] };
  assert.equal(scoreCase(c, r).routeCorrect, true); assert.equal(scoreCase(c, r).success, false);
  assert.equal(scoreCase(c, { ...r, evidence: [lookup, approval] }).success, false);
  assert.equal(scoreCase(c, { ...r, evidence: [approval, lookup] }).success, true);
});

const observation = (success, usd) => ({ status: 'completed', observationComplete: true, routeCorrect: success, success, calls: usd === 0 ? 0 : 1, usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: usd }, costMeasured: true, tokensMeasured: true, usd, ms: 1 });
const summaries = (rows) => Object.fromEntries(ARMS.map((a) => [a, summarize(rows, a)]));

test('cost per successful task includes the money spent on failed tasks', () => {
  const rows = [{ id: '1', graph: 'ci', family: 'a', x: observation(true, 0.1) }, { id: '2', graph: 'ci', family: 'b', x: observation(false, 0.2) }];
  const s = summarize(rows, 'x');
  assert.equal(s.successes, 1); assert.ok(Math.abs(s.usdPerSuccess - 0.3) < 1e-12);
  rows[1].x.costMeasured = false; rows[1].x.usd = null;
  assert.equal(summarize(rows, 'x').usdPerSuccess, null);
  assert.equal(cost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }, PRICES['claude-haiku-4-5']), 1 + 5 + 0.1 + 1.25);
});

test('gate uses complete paired quality and measured dollars, with actual Eve still unmeasured', () => {
  const rows = [{ id: '1', graph: 'ci', family: 'a', wayfile: observation(true, 0), bash: observation(true, 0.1), eve_sim: observation(true, 0.2) }];
  const s = summaries(rows), config = { rows, provenanceComplete: true };
  assert.equal(gate(s, [], config).decision, 'PASS (simulated baselines only)');
  assert.equal(gate(s, [], config).realEveDecision, 'UNMEASURED');
  assert.match(gate(s, [], { ...config, dry: true }).decision, /PENDING/);
  assert.match(gate(s, [], { ...config, subset: true }).decision, /PENDING/);
  assert.match(gate(s, [], { ...config, sourceChanged: true }).decision, /PENDING/);
  assert.match(gate(s, [], { rows }).decision, /PENDING/);
  rows[0].bash.costMeasured = false;
  assert.match(gate(summaries(rows), [], config).decision, /PENDING/);
});

test('paired gate rejects approval regressions offset by wins and rejects domain regressions', () => {
  const rows = [
    { id: '1', graph: 'ci', family: 'approval', critical: true, wayfile: observation(false, 0), bash: observation(true, 0.1), eve_sim: observation(true, 0.2) },
    { id: '2', graph: 'triage', family: 'other', wayfile: observation(true, 0), bash: observation(false, 0.1), eve_sim: observation(false, 0.2) },
  ];
  assert.deepEqual(paired(rows, 'bash').criticalRegressions, ['1']);
  const result = gate(summaries(rows), [], { rows, provenanceComplete: true });
  assert.match(result.decision, /NO-GO/);
  assert.deepEqual(result.comparisons.bash.domainRegressions, ['ci']);
  rows[1].id = rows[0].id;
  assert.match(gate(summaries(rows), [], { rows, provenanceComplete: true }).decision, /PENDING/);
});

test('corpus hashes separate prompt inputs from labels/contracts', () => {
  const d = dataset('challenge');
  const input = d.cases.map(({ expect, rationale, legacy, contract, ...c }) => c);
  assert.equal(d.corpusHash, digest(input));
  const altered = structuredClone(input); altered[0].input.ticket.body = 'changed';
  assert.notEqual(d.corpusHash, digest(altered));
});
