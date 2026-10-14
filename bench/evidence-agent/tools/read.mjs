import { readFileSync } from 'node:fs';
import { readEvidenceRecord } from '../../evidence-tasks.js';

export function readStep(stage) {
  const state = JSON.parse(readFileSync(0, 'utf8'));
  const evidence = [...(state.evidence || [])];
  const read = (collection, id) => {
    const record = readEvidenceRecord(collection, id);
    evidence.push({ kind: 'record-read', ...record });
    return record.value;
  };
  let set;
  if (stage === 'customer') set = { 'facts.customer': read('customers', state.task.customerId), evidence };
  else if (stage === 'order') set = { 'facts.order': state.facts.customer ? read('orders', state.facts.customer.orderId) : null, evidence };
  else if (stage === 'policy') {
    const policy = state.facts.customer && state.facts.order ? read('policies', state.facts.customer.region) : null;
    const required = Boolean(policy && state.facts.order.amount > policy.approvalOver);
    set = { 'facts.policy': policy, evidence, 'approval.required': required, 'approval.answer': null };
  } else throw new Error('unknown evidence read step');
  process.stdout.write(JSON.stringify({ set }));
}
