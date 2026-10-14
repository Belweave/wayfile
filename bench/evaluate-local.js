// Zero-provider conformance evaluation. Reference writers are explicit fixtures,
// never an agent leaderboard. Supply --outputs FILE to grade generated artifacts.
import { readFileSync } from 'node:fs';
import { evidenceTasks, resolveEvidence, evidenceContract, referenceOutput } from './evidence-tasks.js';
import { evidenceContractVersion, evidenceGraderVersion } from './evidence-policy.js';
import { scoreEvidenceOutput } from './contracts.js';
import { digest } from './measurement.js';

export function localConformance(outputs) {
  const controls = [];
  const tasks = evidenceTasks.map((task) => {
    const facts = resolveEvidence(task), contract = evidenceContract(task, facts);
    const reference = referenceOutput(contract);
    const referenceText = JSON.stringify(reference);
    controls.push({ id: `${task.id}:reference`, shouldPass: true, result: scoreEvidenceOutput(referenceText, contract) });
    const paraphrase = {
      eligible_return: 'The delivered order is within the policy window; no refund has been issued.',
      outside_return_window: 'The purchase is beyond the deadline, so the refund is declined.',
      missing_evidence: 'The lookup returned no order record. Manual review is required.',
      approval_not_granted: 'Human authorization was refused; the purchase needs review.',
    }[contract.reasonCode];
    controls.push({ id: `${task.id}:paraphrase`, shouldPass: true, result: scoreEvidenceOutput(JSON.stringify({ ...reference, summary: paraphrase }), contract) });
    controls.push({ id: `${task.id}:coordinated-negative`, shouldPass: true, result: scoreEvidenceOutput(JSON.stringify({ ...reference, summary: `${reference.summary} No payment is approved or issued.` }), contract) });
    for (const [name, invalid, diagnostic] of [
      ['wrong-amount', { ...reference, amount: (reference.amount ?? 0) + 1 }],
      ['string-amount', { ...reference, amount: String(reference.amount) }],
      ['wrong-reason', { ...reference, reason_code: reference.reason_code === 'eligible_return' ? 'missing_evidence' : 'eligible_return' }],
      ['forged-source', { ...reference, sources: ['orders:invented@1'] }],
      ['unsupported-side-effect', { ...reference, summary: `${reference.summary} We refunded the customer.` }, 'no-unsupported-payment'],
      ['overlong', { ...reference, summary: 'x'.repeat(contract.maxSummaryChars + 1) }],
      ['extra-field', { ...reference, internalReasoning: 'unrequested' }],
      ['vague-summary', { ...reference, summary: 'Everything looks fine.' }, 'summary-topical'],
    ]) controls.push({ id: `${task.id}:${name}`, shouldPass: Boolean(diagnostic), ...(diagnostic ? { diagnosticExpectation: { name: diagnostic, passed: false } } : {}), result: scoreEvidenceOutput(JSON.stringify(invalid), contract) });
    const candidate = outputs?.find((o) => o.id === task.id);
    const result = candidate ? scoreEvidenceOutput(typeof candidate.output === 'string' ? candidate.output : JSON.stringify(candidate.output), contract) : null;
    return { id: task.id, evidence: facts.evidence, ...(outputs ? { candidateFound: Boolean(candidate), result } : {}) };
  });
  const matchesExpectation = (control) => control.result.success === control.shouldPass && (!control.diagnosticExpectation || control.result.proseDiagnostics.some((check) => check.name === control.diagnosticExpectation.name && check.passed === control.diagnosticExpectation.passed));
  return {
    kind: 'local-contract-conformance', modelQualityMeasured: false, paidModelCalls: 0,
    outputContractVersion: evidenceContractVersion, graderVersion: evidenceGraderVersion,
    primaryMetric: 'factual/evidence contract; summary bounds only', proseFaithfulnessMeasured: false,
    taskHash: digest(evidenceTasks),
    note: 'Deterministic factual-contract controls and explicit prose-diagnostic expectations. Prose diagnostics never determine contract success and require semantic adjudication. Reference outputs are fixtures; passing them is not evidence of model quality or actual Eve parity.',
    controls: { passed: controls.filter(matchesExpectation).length, n: controls.length, failures: controls.filter((control) => !matchesExpectation(control)), proseDiagnosticControls: controls.filter((control) => control.diagnosticExpectation).length },
    ...(outputs ? { candidates: { successes: tasks.filter((t) => t.result?.success).length, n: tasks.length, missing: tasks.filter((t) => !t.candidateFound).map((t) => t.id) } } : {}),
    tasks,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--outputs')) throw new Error('usage: node bench/evaluate-local.js [--outputs FILE]');
    const outputs = args.length ? JSON.parse(readFileSync(args[1], 'utf8')) : null;
    if (outputs && (!Array.isArray(outputs) || outputs.some((o) => !o || typeof o.id !== 'string') || new Set(outputs.map((o) => o.id)).size !== outputs.length)) throw new Error('outputs must be an array of unique {id, output} records');
    const report = localConformance(outputs);
    console.log(JSON.stringify(report, null, 2));
    if (report.controls.failures.length || report.candidates?.successes < report.candidates?.n) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 2; }
}
