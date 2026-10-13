// explain, Mermaid export, edge-diff.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { run } from './run.js';
import { parseNode } from './parse.js';

// One routing decision for a node, with an optional stubbed judge answer (used by example tests).
export async function decideOne(graph, node, input, judgeAnswer) {
  const judge = judgeAnswer ? async () => ({ target: judgeAnswer, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) : null;
  const sub = { ...graph, nodes: { ...graph.nodes, [node.id]: node } };
  const r = await run(sub, input, { start: node.id, judge, maxSteps: 1 });
  return r.steps[0] || { next: null, how: 'none' };
}

export async function explain(graph, input, opts) {
  const r = await run(graph, input, opts);
  const lines = r.steps.map((s, i) => {
    const n = graph.nodes[s.node];
    const at = s.line ? `${n.file}:${s.line}` : n.file;
    const tok = s.usage ? ` [${s.usage.input}+${s.usage.output} tok]` : s.cached ? ' [memo]' : '';
    return `${i + 1}. ${s.node}${s.next ? ` → ${s.next}` : ' (end)'}  via ${s.how}  @ ${at}${tok}`;
  });
  const cost = r.usage.cost ? `, cost $${r.usage.cost.toFixed(6)}` : '';
  return { text: [...lines, `model calls: ${r.calls}, tokens in/out: ${r.usage.input}/${r.usage.output}${cost}`].join('\n'), result: r };
}

const label = (r) => (r.type === 'otherwise' ? 'otherwise' : r.type === 'judge' ? `judge: ${r.src}` : r.src).replace(/"/g, '#quot;').replace(/\|/g, '#124;');

export function mermaid(graph) {
  const shape = { judge: ['{{', '}}'], script: ['[/', '/]'], ask: ['([', '])'], end: ['((', '))'], route: ['[', ']'] };
  const out = ['flowchart TD'];
  for (const n of Object.values(graph.nodes)) { const [a, b] = shape[n.kind] || shape.route; out.push(`  ${n.id.replace(/-/g, '_')}${a}"${n.id}"${b}`); }
  for (const n of Object.values(graph.nodes)) for (const r of n.routes) out.push(`  ${n.id.replace(/-/g, '_')} ${r.type === 'judge' ? '-.->' : '-->'}|"${label(r)}"| ${r.to.replace(/-/g, '_')}`);
  return out.join('\n');
}

// Routes added/removed between a git ref and the working tree. Edges keyed by from|predicate|to.
export function edgeDiff(graph, ref = 'HEAD') {
  const key = (n, r) => `${n.id}: ${label(r)} → ${r.to}`;
  const now = new Set(Object.values(graph.nodes).flatMap((n) => n.routes.map((r) => key(n, r))));
  const before = new Set();
  const git = (...a) => execFileSync('git', a, { cwd: graph.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let files = [];
  try { files = git('ls-tree', '--name-only', `${ref}:./`).split('\n').filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch { /* new dir */ }
  for (const f of files) {
    const n = parseNode(git('show', `${ref}:./${f}`), basename(f));
    n.routes.forEach((r) => before.add(key(n, r)));
  }
  return { added: [...now].filter((e) => !before.has(e)), removed: [...before].filter((e) => !now.has(e)) };
}
