// `wayfile check`: static lint. Every finding is `file:line: level: problem → fix`.
import { existsSync, accessSync, constants } from 'node:fs';
import { evaluate, vars } from './logic.js';
import { scriptPath } from './run.js';

export function edges(graph) {
  return Object.values(graph.nodes).flatMap((n) => n.routes.map((r) => ({ from: n.id, to: r.to, r })));
}

function sccs(graph) { // Tarjan
  const idx = {}, low = {}, on = new Set(), st = [], out = [];
  let i = 0;
  const adj = (id) => graph.nodes[id].routes.map((r) => r.to).filter((t) => graph.nodes[t]);
  const visit = (v) => {
    idx[v] = low[v] = i++; st.push(v); on.add(v);
    for (const w of adj(v)) {
      if (idx[w] === undefined) { visit(w); low[v] = Math.min(low[v], low[w]); }
      else if (on.has(w)) low[v] = Math.min(low[v], idx[w]);
    }
    if (low[v] === idx[v]) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); out.push(c); }
  };
  Object.keys(graph.nodes).forEach((v) => idx[v] === undefined && visit(v));
  return out.filter((c) => c.length > 1 || adj(c[0]).includes(c[0]));
}

// Candidate values for a variable, drawn from predicate constants and example inputs.
function candidates(path, node, graph) {
  const vals = new Set([undefined]);
  for (const n of Object.values(graph.nodes)) {
    for (const r of n.routes.filter((r) => r.type === 'when')) for (const v of vars(r.rule)) {
      if (v.path !== path) continue;
      const c = v.args[0];
      if (typeof c === 'number') [c - 1, c, c + 1].forEach((x) => vals.add(x));
      else if (v.op === 'match') v.args[0].replace(/[()^$\\]/g, '').split('|').forEach((w) => vals.add(w));
      else vals.add(c);
    }
    for (const ex of n.examples) { const x = path.split('.').reduce((o, k) => o?.[k], ex.input); if (x !== undefined) vals.add(x); }
  }
  return [...vals];
}

function setIn(o, path, v) { const ks = path.split('.'); let c = o; for (const k of ks.slice(0, -1)) c = c[k] ??= {}; c[ks.at(-1)] = v; }

function ambiguous(node, graph, limit = 2000) {
  if (node.meta.ordered === true) return [];
  const when = node.routes.filter((r) => r.type === 'when');
  const found = [];
  for (let a = 0; a < when.length; a++) for (let b = a + 1; b < when.length; b++) {
    if (when[a].to === when[b].to) continue;
    const paths = [...new Set([...vars(when[a].rule), ...vars(when[b].rule)].map((v) => v.path))];
    let combos = [{}];
    for (const p of paths) combos = combos.flatMap((c) => candidates(p, node, graph).map((v) => ({ ...c, [p]: v }))).slice(0, limit);
    for (const c of combos) {
      const s = {}; for (const [p, v] of Object.entries(c)) if (v !== undefined) setIn(s, p, v);
      if (evaluate(when[a].rule, s) && evaluate(when[b].rule, s)) { found.push({ a: when[a], b: when[b], s }); break; }
    }
  }
  return found;
}

export async function check(graph) {
  const out = [];
  const add = (file, line, level, msg, fix) => out.push({ file, line, level, msg, fix });
  const nodes = Object.values(graph.nodes);
  if (!graph.entry) add(graph.dir, 0, 'error', 'no entry node', 'add `entry: true` to one node');
  for (const n of nodes) {
    n.errors.forEach((e) => add(n.file, e.line, 'error', e.msg, e.fix));
    if (!['route', 'judge', 'script', 'ask', 'skill', 'end'].includes(n.kind)) add(n.file, 2, 'error', `unknown kind "${n.kind}"`, 'use route | judge | script | ask | skill | end');
    if (n.meta.skill && !n.skillText) add(n.file, 2, 'error', `skill file skills/${n.meta.skill}.md not found`, 'create it or fix `skill:`');
    if (n.kind === 'skill' && n.routes.some((r) => r.type === 'judge')) add(n.file, 2, 'warn', 'skill node with judge routes makes two model calls', 'route on the skill output deterministically');
    for (const r of n.routes) if (!graph.nodes[r.to]) add(n.file, r.line, 'error', `route target [[${r.to}]] does not exist`, `create ${r.to}.md or fix the link`);
    if (n.kind !== 'end' && n.routes.length && !n.routes.some((r) => r.type === 'otherwise')) add(n.file, n.routes.at(-1).line, 'error', 'missing `otherwise` route', 'add `- otherwise → [[node]]` as the last route');
    if (n.kind !== 'end' && !n.routes.length) add(n.file, 1, 'error', 'non-end node has no routes', 'add a `## Routes` list or set `kind: end`');
    if (n.kind === 'end' && n.routes.length) add(n.file, n.routes[0].line, 'warn', 'end node has routes', 'remove them or change kind');
    const oi = n.routes.findIndex((r) => r.type === 'otherwise');
    if (oi >= 0 && oi < n.routes.length - 1) add(n.file, n.routes[oi + 1].line, 'error', 'route after `otherwise` is unreachable', 'move `otherwise` last');
    if (n.routes.some((r) => r.type === 'judge') && n.kind !== 'judge') add(n.file, 2, 'warn', '`judge:` route on a non-judge node', 'set `kind: judge`');
    if (n.kind === 'script') {
      const p = scriptPath(graph, n);
      if (!p) add(n.file, 2, 'error', 'script node without `script:`', 'add `script: scripts/foo.sh`');
      else if (!existsSync(p)) add(n.file, 2, 'error', `script ${n.meta.script} not found`, 'create it or fix the path');
      else { try { accessSync(p, constants.X_OK); } catch { add(n.file, 2, 'error', `script ${n.meta.script} not executable`, `chmod +x ${n.meta.script}`); } }
    }
    for (const f of ambiguous(n, graph)) add(n.file, f.b.line, 'warn', `ambiguous fork: lines ${f.a.line} and ${f.b.line} both match ${JSON.stringify(f.s)}`, 'tighten a predicate, or add `ordered: true` if first-match order is intended');
  }
  // reachability
  const seen = new Set(); const stack = graph.entry ? [graph.entry] : [];
  while (stack.length) { const id = stack.pop(); if (seen.has(id) || !graph.nodes[id]) continue; seen.add(id); graph.nodes[id].routes.forEach((r) => stack.push(r.to)); }
  for (const n of nodes) if (graph.entry && !seen.has(n.id)) add(n.file, 1, 'warn', 'unreachable from entry', 'link to it or delete it');
  // cycles
  for (const c of sccs(graph)) {
    const exits = c.some((id) => graph.nodes[id].routes.some((r) => !c.includes(r.to)));
    const capped = c.some((id) => graph.nodes[id].meta.max_visits);
    const f = graph.nodes[c[0]].file;
    if (!exits) add(f, 1, 'error', `cycle with no exit: ${c.join(' → ')}`, 'add a route that leaves the cycle');
    else if (!capped) add(f, 1, 'warn', `cycle without max_visits: ${c.join(' → ')}`, 'add `max_visits: N` to a node in the cycle');
  }
  // needs ⊆ entry needs ∪ sets of every node that can reach this one
  const inputs = new Set(graph.nodes[graph.entry]?.needs || []);
  const preds = {}; for (const e of edges(graph)) (preds[e.to] ??= new Set()).add(e.from);
  for (const n of nodes) {
    const anc = new Set(); const st = [...(preds[n.id] || [])];
    while (st.length) { const p = st.pop(); if (anc.has(p)) continue; anc.add(p); (preds[p] || []).forEach((x) => st.push(x)); }
    const avail = new Set(inputs); anc.forEach((a) => graph.nodes[a].sets.forEach((k) => avail.add(k)));
    if (['ask', 'judge', 'skill'].includes(n.kind)) n.sets.forEach((k) => avail.add(k)); // set before routing
    if (n.kind === 'script') n.sets.forEach((k) => avail.add(k));
    for (const k of n.needs) if (!avail.has(k) && !avail.has(k.split('.')[0])) add(n.file, 2, 'error', `needs \`${k}\` but no upstream node sets it`, `add it to an upstream \`sets\` or to the entry node's needs`);
  }
  // examples as tests (single-step; judge outcome stubbed by `judge:`)
  const { decideOne } = await import('./explain.js');
  for (const n of nodes) for (const ex of n.examples) {
    if (!ex.input || !ex.expect) { add(n.file, ex.line, 'error', 'example needs `input:` and `expect:`', 'add both'); continue; }
    const got = await decideOne(graph, n, ex.input, ex.judge);
    if (got.next !== ex.expect) add(n.file, ex.line, 'error', `example expects [[${ex.expect}]] but routes to [[${got.next}]] (${got.how})`, 'fix the route order/predicate or the example');
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export const format = (f) => `${f.file}:${f.line}: ${f.level}: ${f.msg} → ${f.fix}`;
