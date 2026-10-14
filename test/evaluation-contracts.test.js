import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceTasks, resolveEvidence, evidenceContract, referenceOutput, evaluateEvidenceTask } from '../bench/evidence-tasks.js';
import { scoreEvidenceOutput } from '../bench/contracts.js';
import { localConformance } from '../bench/evaluate-local.js';
import { fixtureModel, observeEvidenceTask, scoreEvidenceTask, evidenceGraph } from '../bench/evidence-models.js';
import { evidencePolicy, evidenceOutputSchema, evidenceContractVersion, evidenceGraderVersion } from '../bench/evidence-policy.js';
import { validateValue } from '../packages/wayfile/src/contracts.js';
import { check } from '../packages/wayfile/src/check.js';

test('multi-hop evidence follows the customer order and regional policy, including absent orders', () => {
  const facts = resolveEvidence(evidenceTasks[1]);
  assert.deepEqual(facts.evidence.map((e) => e.source), ['customers:ben@1', 'orders:b18@1', 'policies:EU@2']);
  assert.equal(evidenceContract(evidenceTasks[1], facts).decision, 'decline');
  const missing = resolveEvidence(evidenceTasks[3]);
  assert.equal(missing.order, null); assert.equal(missing.evidence.length, 2);
  assert.equal(evidenceContract(evidenceTasks[3], missing).decision, 'needs-review');
});

test('factual output contract rejects factual drift, forged or stale sources and invalid summary bounds', async () => {
  const task = evidenceTasks[0], facts = resolveEvidence(task), contract = evidenceContract(task, facts);
  const good = referenceOutput(contract);
  assert.equal((await evaluateEvidenceTask(task, async () => good)).success, true);
  for (const bad of [
    { ...good, amount: 126 }, { ...good, currency: 'EUR' },
    { ...good, sources: good.sources.map((s) => s.replace('US@3', 'US@2')) },
    { ...good, sources: [...good.sources, good.sources[0]] },
    { ...good, summary: '   ' },
    { ...good, summary: 'x'.repeat(181) },
    { ...good, decision: 'needs-review' },
  ]) assert.equal(scoreEvidenceOutput(JSON.stringify(bad), contract).success, false);
  assert.equal(scoreEvidenceOutput('{"decision":', contract).success, false);
});

test('local reference controls never claim AI quality and missing output rows remain failed tasks', () => {
  const report = localConformance([]);
  assert.equal(report.modelQualityMeasured, false); assert.equal(report.paidModelCalls, 0);
  assert.equal(report.outputContractVersion, 2); assert.equal(report.graderVersion, 4);
  assert.equal(report.proseFaithfulnessMeasured, false); assert.ok(report.controls.proseDiagnosticControls > 0);
  assert.equal(report.controls.failures.length, 0);
  assert.equal(report.candidates.successes, 0); assert.equal(report.candidates.n, evidenceTasks.length);
  assert.deepEqual(report.candidates.missing, evidenceTasks.map((t) => t.id));
});

test('V2 schemas declare portable nullable types and cannot accept V1 or string-valued amounts', () => {
  assert.equal(evidenceContractVersion, 2); assert.equal(evidenceGraderVersion, 4);
  assert.deepEqual(evidenceOutputSchema.properties.amount.type, ['number', 'null']);
  assert.deepEqual(evidenceOutputSchema.properties.currency.type, ['string', 'null']);
  for (const task of [evidenceTasks[0], evidenceTasks[3]]) {
    const contract = evidenceContract(task, resolveEvidence(task)), good = referenceOutput(contract);
    assert.deepEqual(validateValue(good, evidenceOutputSchema), []);
    assert.equal(scoreEvidenceOutput(JSON.stringify({ ...good, amount: String(good.amount) }), contract).success, false);
    const legacy = { ...good }; delete legacy.reason_code;
    assert.equal(scoreEvidenceOutput(JSON.stringify(legacy), contract).success, false);
    assert.equal(scoreEvidenceOutput(JSON.stringify(good), { ...contract, version: 1 }).success, false);
  }
  const contract = evidenceContract(evidenceTasks[0], resolveEvidence(evidenceTasks[0]));
  assert.equal(scoreEvidenceOutput(JSON.stringify({ ...referenceOutput(contract), amount: -1 }), contract).success, false);
});

test('structured reasons grade facts while ordinary equivalent summaries need no magic word', () => {
  const examples = [
    [0, 'The delivered purchase is within the return window. No payment has been issued.'],
    [1, 'Return window elapsed; escalate to staff.'],
    [2, 'Authorization was refused; the order needs manual review.'],
    [3, 'The lookup returned no order record. Ask the customer for details.'],
  ];
  for (const [index, summary] of examples) {
    const task = evidenceTasks[index], contract = evidenceContract(task, resolveEvidence(task));
    const output = { ...referenceOutput(contract), summary };
    assert.equal(scoreEvidenceOutput(JSON.stringify(output), contract).success, true, summary);
    output.reason_code = contract.reasonCode === 'eligible_return' ? 'missing_evidence' : 'eligible_return';
    assert.equal(scoreEvidenceOutput(JSON.stringify(output), contract).success, false);
  }
});

test('prose diagnostics flag separate affirmative payment or approval claims without changing factual wins', () => {
  const contract = evidenceContract(evidenceTasks[0], resolveEvidence(evidenceTasks[0]));
  for (const summary of [
    'Refund cannot be issued though it was already processed.',
    'Refund was not approved although already issued.',
    'The refund has been issued and approval was not granted.',
    'Order was not delivered, but refund already processed.',
  ]) {
    const result = scoreEvidenceOutput(JSON.stringify({ ...referenceOutput(contract), summary }), contract);
    assert.equal(result.success, true, summary);
    assert.equal(result.proseDiagnostics.find((check) => check.name === 'no-unsupported-payment').passed, false, summary);
    assert.equal(result.proseAdjudicationRequired, true);
  }
  const denied = evidenceContract(evidenceTasks[2], resolveEvidence(evidenceTasks[2]));
  for (const summary of ['Approval was granted; the order needs review.', 'Approval was not denied; the order needs review.']) {
    const result = scoreEvidenceOutput(JSON.stringify({ ...referenceOutput(denied), summary }), denied);
    assert.equal(result.success, true, summary);
    assert.equal(result.proseDiagnostics.find((check) => check.name === 'no-explicit-reason-contradiction').passed, false, summary);
  }
});

test('prose diagnostics distinguish coordinated negatives and affirmative continuations without governing wins', () => {
  const task = evidenceTasks[1], contract = evidenceContract(task, resolveEvidence(task));
  for (const summary of [
    'The order exceeds the return window. No refund is approved or issued.',
    'The order exceeds the return window. Payment was neither approved nor issued.',
    'The order exceeds the return window. No payment has been issued or credited.',
    'The order exceeds the return window. Payment was not approved nor paid.',
  ]) {
    const result = scoreEvidenceOutput(JSON.stringify({ ...referenceOutput(contract), summary }), contract);
    assert.equal(result.success, true, summary);
    assert.equal(result.proseDiagnostics.find((check) => check.name === 'no-unsupported-payment').passed, true, summary);
  }
  for (const summary of [
    'The order exceeds the return window. Refund was approved or issued.',
    'The order exceeds the return window. No refund was approved but it was issued.',
    'The order exceeds the return window. Payment was not approved although already issued.',
    'The order exceeds the return window. No payment was approved. The refund was issued.',
  ]) {
    const result = scoreEvidenceOutput(JSON.stringify({ ...referenceOutput(contract), summary }), contract);
    assert.equal(result.success, true, summary);
    assert.equal(result.proseDiagnostics.find((check) => check.name === 'no-unsupported-payment').passed, false, summary);
  }
});

test('known prose-heuristic false positives and false negatives remain diagnostics requiring adjudication', () => {
  const missing = evidenceContract(evidenceTasks[3], resolveEvidence(evidenceTasks[3]));
  const falsePositive = scoreEvidenceOutput(JSON.stringify({ ...referenceOutput(missing), summary: 'The customer names an order, but no such order was found. Please provide a valid order ID.' }), missing);
  assert.equal(falsePositive.success, true);
  assert.equal(falsePositive.proseDiagnostics.find((check) => check.name === 'no-explicit-reason-contradiction').passed, false);
  const eligible = evidenceContract(evidenceTasks[0], resolveEvidence(evidenceTasks[0]));
  const falseNegative = scoreEvidenceOutput(JSON.stringify({ ...referenceOutput(eligible), summary: 'The refund settled yesterday.' }), eligible);
  assert.equal(falseNegative.success, true); assert.ok(falseNegative.proseDiagnostics.every((check) => check.passed));
  for (const result of [falsePositive, falseNegative]) {
    assert.equal(result.proseFaithfulnessMeasured, false); assert.equal(result.proseAdjudicationRequired, true);
    assert.ok(result.checks.every((check) => !['summary-topical', 'no-unsupported-payment', 'no-explicit-reason-contradiction'].includes(check.name)));
  }
});

test('fixture reads cannot be mutated by a generated-output function across tasks', async () => {
  await evaluateEvidenceTask(evidenceTasks[0], async ({ facts }) => { facts.order.amount = 999; return {}; });
  assert.equal(resolveEvidence(evidenceTasks[0]).order.amount, 125);
});

test('generated-evidence Wayfile graph passes checks and both local protocols exercise actual reads', async () => {
  const graph = evidenceGraph(800);
  assert.deepEqual(graph.nodes.draft.outputSchema, evidenceOutputSchema);
  assert.equal(graph.instructions, evidencePolicy);
  assert.equal((await check(graph)).filter((issue) => issue.level === 'error').length, 0);
  for (const task of evidenceTasks) {
    for (const arm of ['wayfile', 'model_loop']) {
      const result = await observeEvidenceTask(task, arm, { call: fixtureModel(), mock: true, maxTokens: 800 });
      assert.equal(result.success, true, `${task.id} ${arm}: ${JSON.stringify(result.checks)}`);
      assert.equal(result.modelQualityMeasured, false);
      assert.ok(result.evidence.some((e) => e.kind === 'record-read'));
      assert.ok(result.requests.every((r) => r.maxTokens === 800));
    }
  }
});

test('a plausible generated output cannot succeed without observed record reads or required approval', () => {
  const task = evidenceTasks[2], facts = resolveEvidence(task), contract = evidenceContract(task, facts);
  const output = referenceOutput(contract);
  const base = { output, status: 'completed', evidence: [] };
  assert.equal(scoreEvidenceTask(task, base).success, false);
  base.evidence = facts.evidence.map((e) => ({ kind: 'record-read', ...e }));
  assert.equal(scoreEvidenceTask(task, base).success, false);
  base.evidence.push({ kind: 'approval', answer: 'no', simulated: true });
  assert.equal(scoreEvidenceTask(task, base).success, true);
});

test('factual output errors consume paid calls but are not repaired using hidden gold', async () => {
  const task = evidenceTasks[0], facts = resolveEvidence(task), contract = evidenceContract(task, facts);
  const output = { ...referenceOutput(contract), amount: 126 };
  const seen = [];
  const call = async (req) => { seen.push(req); return { text: JSON.stringify(output), content: [{ type: 'text', text: JSON.stringify(output) }], model: 'fixture', provider: 'fixture', stop: 'end_turn', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01 } }; };
  const result = await observeEvidenceTask(task, 'wayfile', { call });
  assert.equal(result.status, 'completed'); assert.equal(result.success, false);
  assert.equal(result.calls, 1); assert.equal(result.usd, 0.01);
  assert.ok(!seen[0].system.includes('125'));
  assert.ok(!seen[0].system.includes('ev01'));
  assert.ok(!seen[0].messages[0].content.includes('requiredClaims'));
});
