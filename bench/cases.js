// Benchmark cases. `expect` labels were assigned from bench/policy/*.md alone (see LABELING.md).
// `legacy` keeps the first-round ticket labels for the agreement check.
import { tickets as legacyTickets } from './tickets.js';

const POLICY_TICKET_LABELS = { // by template body, from bench/policy/tickets.md
  'Please refund order': 'refund', 'I want a chargeback': 'refund', 'Refund please, I changed': 'general-reply',
  'Refund order': 'refund', 'I forgot my password': 'account-help', 'My 2FA codes': 'account-help',
  'App crashes:': 'bug-intake', 'Steps to reproduce:': 'bug-intake', 'What are your support': 'general-reply', 'Do you ship': 'general-reply',
};
const label = (body) => Object.entries(POLICY_TICKET_LABELS).find(([p]) => body.startsWith(p))[1];

export const tickets = legacyTickets.map((t) => ({ id: t.id, graph: 'triage', input: t.input, expect: label(t.input.ticket.body), legacy: t.expect }));

const ci = (log, expect, attempt = 1, files = ['src/index.ts']) => ({ log, expect, attempt, files });
const CI = [
  ci('env dump: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'rotate-secret'),
  ci('-----BEGIN RSA PRIVATE KEY----- found in build output', 'rotate-secret'),
  ci('warning: GitHub token leaked in debug log', 'rotate-secret'),
  ci('fetch failed: ETIMEDOUT registry.npmjs.org', 'retry-job', 1),
  ci('ECONNRESET while pulling image node:22', 'retry-job', 2),
  ci('503 Service Unavailable from api.github.com', 'human-triage', 3),
  ci('upstream connection dropped mid-download of artifact', 'retry-job', 1),
  ci('npm ERR! code ERESOLVE unable to resolve dependency tree', 'fix-deps'),
  ci('ERR_PNPM_OUTDATED_LOCKFILE lockfile is out of date with package.json', 'fix-deps'),
  ci('error: integrity checksum failed for lodash@4.17.21', 'fix-deps'),
  ci('eslint: ✖ 3 problems (3 errors, 0 warnings)', 'autofix-lint'),
  ci('prettier --check failed: 4 files would be reformatted', 'autofix-lint'),
  ci('flake8 complained: E501 line too long (101 > 100)', 'autofix-lint'),
  ci('FAIL tests/checkout.spec.ts > pays with card', 'quarantine-test'),
  ci('FAIL src/clock.test.ts > ticks once per second', 'quarantine-test'),
  ci('FAIL src/cart.test.ts > totals\nExpected: 30 Received: 25', 'fix-code', 1, ['src/cart.ts']),
  ci('FAIL src/auth/session.test.ts > refreshes token', 'fix-code', 1, ['src/auth/session.ts']),
  ci('FAIL src/search.test.ts > ranks exact matches first', 'human-triage', 1, ['docs/README.md']),
  ci('AssertionError: expected 200, got 500 in api/orders.test.js', 'fix-code', 1, ['api/orders.js']),
  ci('Killed: out of memory (exit code 137)', 'human-triage'),
];
export const ciCases = CI.map((c, i) => ({
  id: `ci${String(i + 1).padStart(2, '0')}`, graph: 'ci', expect: c.expect,
  input: { ci: { job: `build-${i + 1}`, log: c.log, files_changed: c.files, attempt: c.attempt } },
}));

export const cases = [...tickets, ...ciCases];
