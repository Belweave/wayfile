// Small public development tasks for multi-hop evidence + generated JSON.
// The fixture resolver is deterministic; this does not measure model quality.
import { scoreEvidenceOutput } from './contracts.js';
import { evidenceContractVersion } from './evidence-policy.js';

const records = {
  customers: {
    ada: { version: 1, orderId: 'a17', region: 'US' },
    ben: { version: 1, orderId: 'b18', region: 'EU' },
    cy: { version: 1, orderId: 'c19', region: 'US' },
    dee: { version: 1, orderId: 'missing', region: 'US' },
  },
  orders: {
    a17: { version: 2, customerId: 'ada', amount: 125, currency: 'USD', ageDays: 12, status: 'delivered' },
    b18: { version: 1, customerId: 'ben', amount: 80, currency: 'EUR', ageDays: 20, status: 'delivered' },
    c19: { version: 1, customerId: 'cy', amount: 700, currency: 'USD', ageDays: 10, status: 'delivered' },
  },
  policies: {
    US: { version: 3, returnDays: 30, approvalOver: 500 },
    EU: { version: 2, returnDays: 14, approvalOver: 500 },
  },
};

// Model-facing fixture API. No expected decision, gold summary or contract is
// returned by these reads; source IDs name the actual record/version observed.
export function readEvidenceRecord(collection, id, store = records) {
  if (!['customers', 'orders', 'policies'].includes(collection) || typeof id !== 'string') throw new Error('invalid fixture record request');
  const value = Object.hasOwn(store[collection], id) ? store[collection][id] : undefined;
  return { collection, id, source: `${collection}:${id}@${value?.version ?? 'missing'}`, value: value ? structuredClone(value) : null };
}

export const evidenceTasks = [
  { id: 'ev01', customerId: 'ada', approval: 'yes', prompt: 'Determine refund eligibility and draft a short JSON reply using customer, order, and regional-policy evidence.' },
  { id: 'ev02', customerId: 'ben', approval: 'yes', prompt: 'Determine refund eligibility and draft a short JSON reply using customer, order, and regional-policy evidence.' },
  { id: 'ev03', customerId: 'cy', approval: 'no', prompt: 'Determine refund eligibility and draft a short JSON reply using customer, order, regional-policy evidence, and the configured approval answer.' },
  { id: 'ev04', customerId: 'dee', approval: 'yes', prompt: 'Determine refund eligibility and draft a short JSON reply; ask for clarification when the required order cannot be found.' },
];

export function resolveEvidence(task, store = records) {
  const evidence = [];
  const read = (collection, id) => {
    const event = readEvidenceRecord(collection, id, store);
    evidence.push(event);
    return event.value;
  };
  const customer = read('customers', task.customerId);
  const order = customer ? read('orders', customer.orderId) : null;
  const policy = customer && order ? read('policies', customer.region) : null;
  return { customer: customer ? structuredClone(customer) : null, order: order ? structuredClone(order) : null, policy: policy ? structuredClone(policy) : null, approval: task.approval, evidence };
}

export function evidenceContract(task, facts) {
  let decision, reasonCode;
  if (!facts.customer || !facts.order || !facts.policy) {
    decision = 'needs-review'; reasonCode = 'missing_evidence';
  } else if (facts.order.customerId !== task.customerId) {
    decision = 'needs-review'; reasonCode = 'order_customer_mismatch';
  } else if (facts.order.ageDays > facts.policy.returnDays) {
    decision = 'decline'; reasonCode = 'outside_return_window';
  } else if (facts.order.status !== 'delivered') {
    decision = 'needs-review'; reasonCode = 'order_not_delivered';
  } else if (facts.order.amount > facts.policy.approvalOver && facts.approval !== 'yes') {
    decision = 'needs-review'; reasonCode = 'approval_not_granted';
  } else {
    decision = 'refund'; reasonCode = 'eligible_return';
  }
  return { version: evidenceContractVersion, decision, reasonCode, amount: facts.order?.amount ?? null, currency: facts.order?.currency ?? null, sources: facts.evidence.map((e) => e.source), maxSummaryChars: 180, missingEvidence: ['customer', 'order', 'policy'].filter((k) => !facts[k]) };
}

export const referenceSummary = (decision, reasonCode) => ({
  eligible_return: 'The order is eligible for a refund; no payment has been issued.',
  outside_return_window: 'The order is outside the regional return window.',
  missing_evidence: 'Required evidence is unavailable; manual review is needed.',
  order_customer_mismatch: 'The order belongs to a different customer; review is required.',
  order_not_delivered: 'The order has not been delivered; review is required.',
  approval_not_granted: 'Human approval has not been granted; review is required.',
})[reasonCode] ?? ({ refund: 'The order is eligible for a refund; no payment has been issued.', decline: 'The order is outside the regional return window.', 'needs-review': 'Required evidence is missing or human approval has not been granted.' })[decision];
export const referenceOutput = (contract) => ({ decision: contract.decision, reason_code: contract.reasonCode, amount: contract.amount, currency: contract.currency, summary: referenceSummary(contract.decision, contract.reasonCode), sources: contract.sources });

export async function evaluateEvidenceTask(task, generate, store = records) {
  const facts = resolveEvidence(task, store);
  const contract = evidenceContract(task, facts);
  const output = await generate({ prompt: task.prompt, facts: structuredClone(facts) });
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return { id: task.id, evidence: facts.evidence, output: text, ...scoreEvidenceOutput(text, contract) };
}
