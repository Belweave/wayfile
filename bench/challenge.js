// Development challenges. These are public, authored after the legacy results,
// and available for tuning. They are NOT an unseen holdout or independent gold.
const ticket = (id, family, body, amount, expect, rationale, contract = {}, extra = {}) => ({
  id, graph: 'triage', family, expect, rationale, contract,
  input: { ticket: { ...(body === null ? {} : { body }), ...(amount === undefined ? {} : { amount }) }, ...extra },
});
const ci = (id, family, log, attempt, expect, rationale, contract = {}, extra = {}) => ({
  id, graph: 'ci', family, expect, rationale, contract,
  input: { ci: { ...(log === null ? {} : { log }), ...(attempt === undefined ? {} : { attempt }), files_changed: ['src/index.ts'], ...extra } },
});
const order = (status) => ({ evidence: [{ kind: 'order-lookup', set: { 'order.status': status } }] });
const approved = (status) => ({ evidence: [{ kind: 'approval', answer: 'yes' }, ...order(status).evidence], approvalBeforeLookup: true });
const noAction = { forbidEvidence: ['order-lookup', 'approval'] };

export const challengeCases = [
  ticket('ch-t01', 'refund-paraphrase', 'Would you send my money back for order 711?', 35, 'refund', 'A money-back request with a found order.', order('shipped')),
  ticket('ch-t02', 'refund-paraphrase', 'Undo the purchase for order #712 and reimburse me.', 100, 'refund', 'A reimbursement request with a found order.', order('delivered')),
  ticket('ch-t03', 'negated-intent', 'Please do not refund order 713. What time does support close?', 40, 'general-reply', 'The refund mention is explicitly negated.', noAction),
  ticket('ch-t04', 'overlapping-intents', 'Please refund order 714; I also forgot my password.', 90, 'refund', 'The refund policy precedes the account-help policy.', order('delivered')),
  ticket('ch-t05', 'approval-boundary', 'Please refund order 715.', 500, 'refund', 'Exactly $500 does not require approval.', order('shipped')),
  ticket('ch-t06', 'approval-boundary', 'Please refund order 716.', 501, 'refund', 'Over $500 requires simulated approval before lookup.', approved('delivered')),
  ticket('ch-t07', 'approval-denied', 'Please refund order 717.', 600, 'general-reply', 'Explicitly denied approval blocks the refund.', { evidence: [{ kind: 'approval', answer: 'no' }], forbidEvidence: ['order-lookup'] }, { stub: { ask: 'no' } }),
  ticket('ch-t08', 'missing-data', 'Please refund order 718.', undefined, 'general-reply', 'An unknown amount cannot bypass the approval policy.', noAction),
  ticket('ch-t09', 'invalid-data', 'Please refund order 719.', '40', 'general-reply', 'A string amount is not a valid numeric amount.', noAction),
  ticket('ch-t10', 'missing-data', 'Please refund my purchase.', 30, 'general-reply', 'The required order lookup returns not_found.', order('not_found')),
  ticket('ch-t11', 'account-paraphrase', 'I cannot get past the sign-in screen.', 0, 'account-help', 'The user cannot log in.'),
  ticket('ch-t12', 'account-paraphrase', 'The one-time verification codes never arrive and I cannot access my account.', 0, 'account-help', 'A two-factor access problem.'),
  ticket('ch-t13', 'bug-paraphrase', 'Every time: attach a PDF, click Submit, then the page vanishes.', 0, 'bug-intake', 'A bug report with a reproducible sequence.'),
  ticket('ch-t14', 'missing-reproduction', 'The app is broken.', 0, 'general-reply', 'A bug allegation without reproduction steps.'),
  ticket('ch-t15', 'quoted-intent', 'The debug log says "refund order 720". Reproduce: open Settings, tap Export, and it crashes.', 0, 'bug-intake', 'A quoted log message is evidence, not a refund request.', noAction),
  ticket('ch-t16', 'policy-question', 'What is your refund policy for order 721?', 40, 'general-reply', 'A policy question is not a refund request.', noAction),
  ticket('ch-t17', 'missing-data', null, 0, 'general-reply', 'Missing ticket text requires clarification.', noAction),
  ci('ch-c01', 'infra-paraphrase', 'The download socket dropped halfway through the artifact transfer.', 2, 'retry-job', 'A transient connection failure on attempt 2.'),
  ci('ch-c02', 'infra-boundary', 'The download socket dropped halfway through the artifact transfer.', 3, 'human-triage', 'Attempt 3 must not be retried.'),
  ci('ch-c03', 'missing-data', 'ECONNRESET pulling the base image.', undefined, 'human-triage', 'Missing retry-attempt data must not cause another retry.'),
  ci('ch-c04', 'invalid-data', 'ECONNRESET pulling the base image.', '2', 'human-triage', 'String retry-attempt data is invalid.'),
  ci('ch-c05', 'overlapping-intents', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nECONNRESET pulling the base image.', 1, 'rotate-secret', 'Credential exposure precedes transient infrastructure failure.', { evidence: [{ kind: 'approval', answer: 'yes' }] }),
  { ...ci('ch-c06', 'approval-denied', 'A private key was exposed in the build log.', 1, 'human-triage', 'Denied security approval blocks rotation.', { evidence: [{ kind: 'approval', answer: 'no' }] }), input: { ci: { log: 'A private key was exposed in the build log.', attempt: 1, files_changed: [] }, stub: { ask: 'no' } } },
  ci('ch-c07', 'lint-paraphrase', 'The Python style checker rejected E501: this line exceeds its maximum length.', 1, 'autofix-lint', 'A lint violation phrased without eslint/prettier.'),
  ci('ch-c08', 'dependencies-paraphrase', 'Frozen installation refused: the recorded dependency graph no longer agrees with the package manifest.', 1, 'fix-deps', 'A stale lockfile/dependency resolution failure.'),
  ci('ch-c09', 'flaky-evidence', 'FAIL src/clock.test.ts > ticks after advancing virtual time', 1, 'quarantine-test', 'The failing file is on the fixture flaky list.', { evidence: [{ kind: 'flaky-lookup', set: { 'test.file': 'src/clock.test.ts', 'test.flaky': true } }] }),
  ci('ch-c10', 'causal-evidence', 'FAIL src/inventory.test.ts > reserves one unit\nExpected: 4 Received: 6\nDiff src/inventory.ts: reserve() changed from stock - count to stock + count. The failing assertion calls reserve(5, 1).', 1, 'fix-code', 'The supplied diff and assertion establish the changed-code cause.', { evidence: [{ kind: 'flaky-lookup', set: { 'test.file': 'src/inventory.test.ts', 'test.flaky': false } }] }, { files_changed: ['src/inventory.ts'] }),
  ci('ch-c11', 'causal-evidence', 'FAIL src/search.test.ts > ranks exact matches first\nExpected: first result exact, Received: fuzzy\nThis PR changes only docs/README.md; no executable files changed.', 1, 'human-triage', 'The supplied change set does not establish a changed-code cause.', { evidence: [{ kind: 'flaky-lookup', set: { 'test.file': 'src/search.test.ts', 'test.flaky': false } }] }, { files_changed: ['docs/README.md'] }),
  ci('ch-c12', 'unknown-failure', 'The kernel terminated the process for exhausting available memory (exit 137).', 1, 'human-triage', 'Out-of-memory is not one of the listed transient retries.'),
  ci('ch-c13', 'negated-intent', 'The audit found no leaked token or secret. The actual failure is a 503 Service Unavailable response.', 1, 'retry-job', 'Negated credential exposure must not override the real network failure.'),
  ci('ch-c14', 'missing-data', null, 1, 'human-triage', 'Missing log data requires human diagnosis.'),
  ci('ch-c15', 'invalid-data', 'ETIMEDOUT registry.npmjs.org', 0, 'human-triage', 'Attempt zero is invalid and cannot be retried.'),
];

export const challengeMetadata = {
  name: 'challenge', version: 1, role: 'development',
  labelProvenance: 'Same-team manual policy labels with written rationales; public and available for tuning. No independent holdout claim.',
  limits: ['Order lookup uses the example parity fixture, not a real order database.', 'Approval answers are explicitly simulated.', 'Generated-output and multi-hop contract checks live in the separate local conformance suite.'],
};
