import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regradeCapturedReport, regradeArchive } from '../bench/evidence-regrade.js';
import { evidenceTasks, evidenceContract, resolveEvidence, referenceOutput } from '../bench/evidence-tasks.js';
import { evidenceOutputSchema } from '../bench/evidence-policy.js';
import { scoreEvidenceTask } from '../bench/evidence-models.js';
import { summarize } from '../bench/run.js';
import { digest } from '../bench/measurement.js';

function archiveFixture() {
  const tasks = evidenceTasks, arms = ['wayfile', 'eve_runtime'], requests = [];
  const rows = tasks.map((task) => {
    const facts = resolveEvidence(task), contract = evidenceContract(task, facts);
    const row = { id: task.id, graph: 'evidence', family: task.id, critical: task.approval === 'no' };
    for (const arm of arms) {
      const evidence = facts.evidence.map((read) => ({ kind: 'record-read', ...read }));
      if (task.approval === 'no') evidence.push({ kind: 'approval', answer: 'no', simulated: true });
      const usd = arm === 'wayfile' ? 0.1 : 0.2;
      const request = { caseId: task.id, arm, providerCall: true, model: 'archive-fixture-model', measuredCost: usd };
      requests.push(request);
      const observation = {
        status: 'completed', output: referenceOutput(contract), evidence,
        calls: 1, usd, knownUsd: usd, costMeasured: true, observationComplete: true,
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: usd }, ms: 100,
        modelQualityMeasured: true, requests: [request],
        provenance: { kind: 'eve-runtime', eveVersion: 'fixture', configHash: 'fixture', mock: false },
      };
      if (task.id === 'ev02' && arm === 'eve_runtime') observation.output.summary = 'The order exceeds the return window. No payment is approved or issued.';
      row[arm] = { ...observation, ...scoreEvidenceTask(task, observation) };
      if (task.id === 'ev02' && arm === 'eve_runtime') {
        row[arm].success = false;
        row[arm].checks.push({ name: 'no-unsupported-payment', passed: false }); // Captured older grader's primary check.
      }
    }
    return row;
  });
  const config = {
    arms, outputContractVersion: 2, graderVersion: 2, requestedModel: 'archive-fixture-model',
    taskHash: digest(tasks), labelsHash: digest(tasks.map((task) => ({ id: task.id, contract: evidenceContract(task, resolveEvidence(task)) }))),
    policyHash: 'captured-before-age-clarification', schemaHash: digest(evidenceOutputSchema),
    summaryChecksScope: 'bounded prose checks, not exhaustive faithfulness',
  };
  const original = {
    meta: { kind: 'generated-evidence', config, configHash: digest(config), modelQualityMeasured: true, paidModelCalls: requests.length, spendDeltaUsd: 1.2, sourceChanged: false },
    rows, summary: Object.fromEntries(arms.map((arm) => [arm, summarize(rows, arm)])),
    gate: { decision: 'original fixture decision', modelNodes: '1/6' },
  };
  return { original, tasks, requests };
}

test('archive regrade changes grading alone and preserves paid measurements with explicit post hoc metadata', () => {
  const { original, tasks, requests } = archiveFixture(), before = structuredClone(original);
  const result = regradeCapturedReport(original, tasks, { requests });
  assert.deepEqual(original, before);
  assert.equal(result.meta.config.outputContractVersion, 2); assert.equal(result.meta.config.graderVersion, 4);
  assert.equal(result.meta.config.proseFaithfulnessMeasured, false);
  assert.equal(result.meta.freshComparison, false); assert.equal(result.meta.modelQualityMeasured, false);
  assert.equal(result.meta.paidModelCalls, 0); assert.equal(result.meta.spendDeltaUsd, 0);
  assert.equal(result.meta.archivedPaidModelCalls, original.meta.paidModelCalls);
  assert.equal(result.meta.archivedSpendDeltaUsd, original.meta.spendDeltaUsd);
  assert.equal(result.meta.config.newPolicyPenaltiesAppliedRetrospectively, false);
  assert.equal(result.meta.config.policyChangedSinceCapture, true);
  assert.equal(result.changes.length, 1); assert.equal(result.changes[0].arm, 'eve_runtime');
  assert.equal(result.summary.eve_runtime.successes, 4);
  for (const arm of original.meta.config.arms) {
    for (const field of ['calls', 'usd', 'knownUsd', 'usage', 'msMedian', 'msP95']) assert.deepEqual(result.summary[arm][field], original.summary[arm][field]);
    for (let i = 0; i < original.rows.length; i++) {
      for (const field of ['output', 'evidence', 'requests', 'provenance', 'status', 'calls', 'usd', 'usage', 'ms']) assert.deepEqual(result.rows[i][arm][field], original.rows[i][arm][field]);
    }
  }
  assert.equal(result.gate.decision, 'POST HOC REGRADE (not a fresh comparison)');
});

test('archive regrade refuses mismatched corpus, factual contracts, schema or paid-call journal', () => {
  const { original, tasks, requests } = archiveFixture();
  assert.throws(() => regradeCapturedReport(original, tasks.slice(1), { requests }), /corpus hash/);
  for (const field of ['labelsHash', 'schemaHash']) {
    const changed = structuredClone(original); changed.meta.config[field] = 'changed';
    assert.throws(() => regradeCapturedReport(changed, tasks, { requests }), /labels or output schema/);
  }
  assert.throws(() => regradeCapturedReport(original, tasks, { requests: requests.slice(1) }), /paid-call count/);
  assert.throws(() => regradeCapturedReport(original, tasks, { requests, audit: { rows: [{ id: 'invented', arm: 'eve_runtime' }] } }), /audit/);
});

test('archive CLI writes a separate report, copies original requests and leaves every source artifact unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wayfile-regrade-'));
  try {
    const { original, tasks, requests } = archiveFixture();
    const contents = {
      'report.json': JSON.stringify(original), 'dataset.json': JSON.stringify(tasks),
      'manifest.json': JSON.stringify(original.meta),
      'requests.jsonl': `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
      'cases.jsonl': `${original.rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    };
    for (const [name, content] of Object.entries(contents)) writeFileSync(join(dir, name), content);
    const outputDir = join(dir, 'new-regrade');
    const { result } = regradeArchive(join(dir, 'report.json'), { outputDir });
    for (const [name, content] of Object.entries(contents)) {
      assert.equal(readFileSync(join(dir, name), 'utf8'), content);
      assert.equal(result.archive.artifactHashes[name], digest(content));
    }
    assert.equal(readFileSync(join(outputDir, 'requests.jsonl'), 'utf8'), contents['requests.jsonl']);
    assert.match(readFileSync(join(outputDir, 'report.md'), 'utf8'), /not a fresh or independent comparison/);
    assert.throws(() => regradeArchive(join(dir, 'report.json'), { outputDir: dir }), /never overwrites/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
