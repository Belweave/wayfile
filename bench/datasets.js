import { cases } from './cases.js';
import { challengeCases, challengeMetadata } from './challenge.js';
import { digest } from './measurement.js';

function legacyContract(c) {
  const evidence = [];
  if (c.graph === 'triage' && ['refund', 'general-reply'].includes(c.expect) && /refund|chargeback|money back/i.test(c.input.ticket.body)) {
    if (c.input.ticket.amount > 500) evidence.push({ kind: 'approval', answer: 'yes' });
    evidence.push({ kind: 'order-lookup' });
  }
  if (c.graph === 'ci' && c.expect === 'rotate-secret') evidence.push({ kind: 'approval', answer: 'yes' });
  if (c.graph === 'ci' && /FAIL |AssertionError/.test(c.input.ci.log)) evidence.push({ kind: 'flaky-lookup' });
  return { evidence, ...(c.graph === 'triage' && c.input.ticket.amount > 500 ? { approvalBeforeLookup: true } : {}) };
}

export function dataset(name = 'legacy') {
  if (!['legacy', 'challenge'].includes(name)) throw new Error(`unknown dataset ${name}; choose legacy or challenge`);
  const selected = name === 'challenge' ? challengeCases : cases.map((c) => ({ ...c, family: c.graph === 'triage' ? `ticket-template-${(Number(c.id.slice(1)) - 1) % 10}` : c.id, contract: legacyContract(c) }));
  const metadata = name === 'challenge' ? challengeMetadata : {
    name: 'legacy', version: 2, role: 'regression',
    labelProvenance: 'Historical same-author labels; 50 tickets repeat 10 templates. CI causal labels infer causality from filenames without a diff and are not independently verified.',
    limits: ['Approval and order records are fixtures.', 'Version 2 adds evidence scoring and revised explicit missing-data rules; historic numbers are not directly comparable.'],
  };
  return { ...metadata, cases: selected, corpusHash: digest(selected.map(({ expect, rationale, legacy, contract, ...c }) => c)), labelsHash: digest(selected.map((c) => ({ id: c.id, expect: c.expect, rationale: c.rationale ?? null, contract: c.contract }))) };
}
