import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNode, loadGraph } from '../packages/wayfile/src/parse.js';
import { tmpGraph, node } from './helpers.js';

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
  assert.equal(Object.keys(g.nodes).length, 8);
});

test('quoted list entries normalize while malformed metadata remains available to lint', () => {
  const valid = parseNode('---\nneeds: ["ticket.body", \'ticket.amount\']\n---\n# A', 'a.md');
  assert.deepEqual(valid.needs, ['ticket.body', 'ticket.amount']);
  const invalid = parseNode('---\nneeds: ticket.body\nsets: false\n---\n# A', 'a.md');
  assert.equal(invalid.meta.needs, 'ticket.body');
  assert.equal(invalid.meta.sets, false);
  assert.deepEqual(invalid.needs, []);
  assert.deepEqual(invalid.sets, []);
});

test('duplicate keys and unterminated frontmatter have source diagnostics', () => {
  const duplicate = parseNode('---\nentry: true\nentry: false\n---\n# A', 'a.md');
  assert.match(duplicate.errors[0].msg, /duplicate frontmatter key/);
  assert.equal(duplicate.errors[0].line, 3);
  assert.equal(duplicate.metaLines.entry, 3);
  assert.match(parseNode('---\nentry: true', 'a.md').errors[0].msg, /frontmatter is not closed/);
});

test('loads a JSON output schema without treating schema files as nodes', () => {
  const schema = { type: 'object', required: ['title'], properties: { title: { type: 'string' } }, additionalProperties: false };
  const dir = tmpGraph({
    'a.md': node('entry: true\nkind: skill\nsets: [answer]\noutput: json\nschema: schemas/result.json', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
    'schemas/result.json': JSON.stringify(schema),
  });
  const graph = loadGraph(dir);
  assert.deepEqual(graph.nodes.a.outputSchema, schema);
  assert.equal(graph.nodes.a.schemaFile, `${dir}/schemas/result.json`);
  assert.deepEqual(Object.keys(graph.nodes).sort(), ['a', 'b']);
});

test('invalid schema JSON becomes a lintable parser error', () => {
  const dir = tmpGraph({
    'a.md': node('entry: true\nkind: skill\nsets: [answer]\noutput: json\nschema: bad.json', ['- otherwise → [[b]]']),
    'b.md': node('kind: end'),
    'bad.json': '{',
  });
  const a = loadGraph(dir).nodes.a;
  assert.equal(a.outputSchema, undefined);
  assert.match(a.errors[0].msg, /not valid JSON/);
  assert.equal(a.errors[0].line, 6);
});

test('harness metadata preserves explicit tool names and bounded limits', () => {
  const harness = parseNode(node('entry: true\nkind: harness\nneeds: [question]\nsets: [report]\ntools: [list-files, "custom_report"]\nmax_turns: 6\nmax_tool_calls: 10\nmax_tool_errors: 0', ['- otherwise → [[done]]']), 'inspect.md');
  assert.equal(harness.kind, 'harness');
  assert.deepEqual(harness.tools, ['list-files', 'custom_report']);
  assert.equal(harness.meta.max_turns, 6);
  assert.equal(harness.meta.max_tool_calls, 10);
  assert.equal(harness.meta.max_tool_errors, 0);
  assert.deepEqual(harness.errors, []);
  const invalid = parseNode(node('kind: harness\ntools: read-file'), 'inspect.md');
  assert.equal(invalid.meta.tools, 'read-file');
  assert.deepEqual(invalid.tools, []);
});

test('read-only harness example loads its output schema and fixture is not a graph node', () => {
  const graph = loadGraph(new URL('../examples/harness', import.meta.url).pathname);
  assert.equal(graph.entry, 'inspect');
  assert.deepEqual(Object.keys(graph.nodes).sort(), ['done', 'inspect']);
  assert.deepEqual(graph.nodes.inspect.tools, ['list-files', 'read-file', 'search-files']);
  assert.equal(graph.nodes.inspect.outputSchema.type, 'object');
  assert.deepEqual(graph.nodes.inspect.outputSchema.required, ['facts', 'unknowns']);
});
