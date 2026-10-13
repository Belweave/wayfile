import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNode, loadGraph } from '../src/parse.js';

const src = `---
kind: judge   # comment
needs: [ticket.body, ticket.amount]
sets: [ticket.class]
max_visits: 2
---
# Triage
Classify it.

## Routes
- \`ticket.amount > 500\` → [[ask]]
- judge: "is it a bug?" -> [[bug]]
- otherwise → [[reply]]

\`\`\`example
input: {"ticket": {"amount": 900}}
expect: ask
\`\`\`
`;

test('parses frontmatter, routes, examples with line numbers', () => {
  const n = parseNode(src, '/x/triage.md');
  assert.equal(n.id, 'triage');
  assert.equal(n.kind, 'judge');
  assert.deepEqual(n.needs, ['ticket.body', 'ticket.amount']);
  assert.equal(n.meta.max_visits, 2);
  assert.equal(n.title, 'Triage');
  assert.equal(n.body, 'Classify it.');
  assert.deepEqual(n.routes.map((r) => [r.type, r.to, r.line]), [['when', 'ask', 11], ['judge', 'bug', 12], ['otherwise', 'reply', 13]]);
  assert.deepEqual(n.examples, [{ line: 15, input: { ticket: { amount: 900 } }, expect: 'ask' }]);
  assert.deepEqual(n.errors, []);
});

test('reports unparseable routes with a line', () => {
  const n = parseNode('# A\n## Routes\n- go somewhere\n- `a >< 1` → [[b]]\n', 'a.md');
  assert.deepEqual(n.errors.map((e) => e.line), [3, 4]);
});

test('loads the triage example graph', () => {
  const g = loadGraph(new URL('../examples/triage', import.meta.url).pathname);
  assert.equal(g.entry, 'triage');
  assert.equal(Object.keys(g.nodes).length, 7);
});
