// `wayfile check`: static lint. Every finding is `file:line: level: problem → fix`.
import { existsSync, accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { evaluate, vars, validStatePath } from './logic.js';
import { scriptPath } from './run.js';
import { validateSchema } from './contracts.js';

const KINDS = ['route', 'judge', 'script', 'ask', 'skill', 'harness', 'end'];
const GENERATORS = ['skill', 'harness'];
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const META = new Set(['kind', 'entry', 'needs', 'sets', 'cache', 'cache_files', 'script', 'skill', 'max_visits', 'ordered', 'routing', 'max_tokens', 'ask_kind', 'output', 'schema', 'max_attempts', 'model', 'fallback_model', 'tools', 'max_turns', 'max_tool_calls', 'max_tool_errors']);

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

export async function check(graph, { runExamples = true } = {}) {
  const out = [];
  const add = (file, line, level, msg, fix) => out.push({ file, line, level, msg, fix });
  const nodes = Object.values(graph.nodes);
  const entries = nodes.filter((n) => n.meta.entry === true);
  if (!graph.entry) add(graph.dir, 0, 'error', 'no entry node', 'add `entry: true` to one node');
  if (entries.length > 1) for (const n of entries) add(n.file, n.metaLines?.entry || 2, 'error', 'multiple entry nodes', 'keep `entry: true` on exactly one node');
  for (const n of nodes) {
    const metaLine = (key) => n.metaLines?.[key] || 2;
    const metaError = (key, msg, fix) => add(n.file, metaLine(key), 'error', msg, fix);
    n.errors.forEach((e) => add(n.file, e.line, 'error', e.msg, e.fix));
    for (const key of Object.keys(n.meta)) if (!META.has(key)) add(n.file, metaLine(key), 'warn', `unknown frontmatter key \`${key}\``, 'remove it or use a documented key');
    if (!KINDS.includes(n.kind)) metaError('kind', `unknown kind "${n.kind}"`, 'use route | judge | script | ask | skill | harness | end');
    for (const key of ['entry', 'ordered']) if (Object.hasOwn(n.meta, key) && typeof n.meta[key] !== 'boolean') metaError(key, `\`${key}\` must be a boolean`, 'use true or false');
    for (const key of ['needs', 'sets', 'cache_files', 'tools']) {
      if (!Object.hasOwn(n.meta, key)) continue;
      const value = n.meta[key];
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) { metaError(key, `\`${key}\` must be a list of nonempty strings`, 'use [path, other.path]'); continue; }
      if (new Set(value).size !== value.length) metaError(key, `\`${key}\` contains duplicates`, 'declare each value once');
      if (['needs', 'sets'].includes(key)) for (const path of value) if (!validStatePath(path)) metaError(key, `invalid state path \`${path}\` in \`${key}\``, 'use dot-separated state keys without prototype components');
      if (key === 'tools') for (const name of value) if (!TOOL_NAME.test(name)) metaError(key, `invalid tool name \`${name}\``, 'use 1-64 letters, digits, underscores or hyphens, starting with a letter or underscore');
    }
    if (n.kind === 'harness' && !Array.isArray(n.meta.tools)) metaError('tools', 'harness node needs an explicit tools list', 'declare `tools: [read-file]`, or `tools: []` for no tools');
    if (Object.hasOwn(n.meta, 'tools') && n.kind !== 'harness') metaError('tools', 'tool lists are only supported for harness nodes', 'use `kind: harness`, or remove `tools:`');
    for (const key of ['script', 'skill', 'ask_kind', 'schema', 'model', 'fallback_model']) if (Object.hasOwn(n.meta, key) && (typeof n.meta[key] !== 'string' || !n.meta[key].trim())) metaError(key, `\`${key}\` must be a nonempty string`, 'use a file path, name or model id');
    for (const key of ['max_visits', 'max_tokens']) if (Object.hasOwn(n.meta, key) && (!Number.isInteger(n.meta[key]) || n.meta[key] < 1)) metaError(key, `\`${key}\` must be a positive integer`, 'use an integer of at least 1');
    for (const [key, minimum, limit] of [['max_turns', 1, 64], ['max_tool_calls', 1, 256], ['max_tool_errors', 0, 256]]) if (Object.hasOwn(n.meta, key)) {
      if (!Number.isInteger(n.meta[key]) || n.meta[key] < minimum || n.meta[key] > limit) metaError(key, `\`${key}\` must be an integer from ${minimum} to ${limit}`, 'choose a bounded integer limit');
      if (n.kind !== 'harness') metaError(key, `\`${key}\` is only supported for harness nodes`, 'use `kind: harness`, or remove this limit');
    }
    if (Object.hasOwn(n.meta, 'max_attempts') && ![1, 2].includes(n.meta.max_attempts)) metaError('max_attempts', '`max_attempts` must be 1 or 2', 'bound generation to one attempt or one repair');
    if (Object.hasOwn(n.meta, 'cache') && !['inputs', 'none'].includes(n.meta.cache)) metaError('cache', 'unknown cache mode', 'use inputs or none');
    if (n.kind === 'harness' && n.meta.cache === 'inputs') metaError('cache', 'harness nodes cannot memoize stateful tool execution', 'remove `cache: inputs`, or use `cache: none`');
    if (Object.hasOwn(n.meta, 'routing') && n.meta.routing !== 'ambiguous') metaError('routing', 'unknown routing mode', 'use `routing: ambiguous`, or omit it for first-match routing');
    if (Object.hasOwn(n.meta, 'output') && !['text', 'json'].includes(n.meta.output)) metaError('output', 'unknown output format', 'use text or json');
    if (Object.hasOwn(n.meta, 'output') && !GENERATORS.includes(n.kind)) metaError('output', 'output contracts are only supported for skill or harness nodes', 'use `kind: skill` or `kind: harness`, or remove `output:`');
    if (n.meta.output === 'json' && !n.meta.schema) metaError('output', 'JSON output needs a schema', 'add `schema: schemas/name.json`');
    if (Object.hasOwn(n.meta, 'schema') && (!GENERATORS.includes(n.kind) || n.meta.output !== 'json')) metaError('schema', 'schema is only supported for skill or harness nodes with JSON output', 'use a skill or harness node with `output: json`');
    if (n.schemaFile && !existsSync(n.schemaFile)) metaError('schema', `schema ${n.meta.schema} not found`, 'create it or fix `schema:`');
    if (n.outputSchema !== undefined) for (const error of validateSchema(n.outputSchema)) metaError('schema', `invalid output schema: ${error}`, 'use only supported schema keywords and valid values');
    if (n.meta.skill && typeof n.meta.skill === 'string' && n.skillText === undefined) metaError('skill', `skill file skills/${n.meta.skill}.md not found`, 'create it or fix `skill:`');
    if (n.meta.skill && n.skillText !== undefined && !n.skillText.trim()) metaError('skill', 'skill instructions are empty', 'write the skill instructions');
    if (GENERATORS.includes(n.kind) && n.sets.length !== 1) metaError('sets', `${n.kind} node needs exactly one output path in \`sets\``, 'declare one path for the text or JSON result');
    if (['ask', 'judge'].includes(n.kind) && n.sets.length > 1) metaError('sets', `${n.kind} node writes only the first output path`, 'declare at most one path in `sets`');
    if (['route', 'end'].includes(n.kind) && n.sets.length) metaError('sets', `${n.kind} nodes do not write state`, 'remove `sets`, or use a node kind that produces values');
    if (n.kind === 'skill' && n.routes.some((r) => r.type === 'judge')) add(n.file, 2, 'warn', 'skill node with judge routes makes two model calls', 'route on the skill output deterministically');
    if (n.kind === 'harness' && n.routes.some((r) => r.type === 'judge')) add(n.file, 2, 'warn', 'harness node with judge routes adds a routing model call after tool execution', 'route on the harness output deterministically');
    for (const r of n.routes) if (!graph.nodes[r.to]) add(n.file, r.line, 'error', `route target [[${r.to}]] does not exist`, `create ${r.to}.md or fix the link`);
    if (n.kind !== 'end' && n.routes.length && !n.routes.some((r) => r.type === 'otherwise')) add(n.file, n.routes.at(-1).line, 'error', 'missing `otherwise` route', 'add `- otherwise → [[node]]` as the last route');
    if (n.kind !== 'end' && !n.routes.length) add(n.file, 1, 'error', 'non-end node has no routes', 'add a `## Routes` list or set `kind: end`');
    if (n.kind === 'end' && n.routes.length) add(n.file, n.routes[0].line, 'warn', 'end node has routes', 'remove them or change kind');
    const oi = n.routes.findIndex((r) => r.type === 'otherwise');
    if (n.routes.filter((r) => r.type === 'otherwise').length > 1) add(n.file, n.routes.filter((r) => r.type === 'otherwise')[1].line, 'error', 'multiple `otherwise` routes', 'keep exactly one fallback route');
    if (oi >= 0 && oi < n.routes.length - 1) add(n.file, n.routes[oi + 1].line, 'error', 'route after `otherwise` is unreachable', 'move `otherwise` last');
    const ji = n.routes.findIndex((r) => r.type === 'judge');
    if (ji >= 0) for (const r of n.routes.slice(ji + 1)) if (r.type === 'when') add(n.file, r.line, 'error', 'predicate appears after a judge route but predicates run first', 'place deterministic routes before judge routes');
    if (n.routes.some((r) => r.type === 'judge') && n.kind !== 'judge') add(n.file, 2, 'warn', '`judge:` route on a non-judge node', 'set `kind: judge`');
    const routeInputs = new Set(n.needs);
    if (['script', 'skill', 'harness', 'ask'].includes(n.kind)) n.sets.forEach((k) => routeInputs.add(k));
    for (const r of n.routes.filter((r) => r.type === 'when')) for (const { path } of vars(r.rule)) if (!routeInputs.has(path) && ![...routeInputs].some((k) => path.startsWith(`${k}.`))) add(n.file, r.line, 'error', `predicate reads \`${path}\` but it is not declared in needs or sets`, `add \`${path}\` to needs, or to sets if this node produces it before routing`);
    if (n.kind === 'script') {
      const p = typeof n.meta.script === 'string' && n.meta.script ? scriptPath(graph, n) : null;
      if (!p) add(n.file, 2, 'error', 'script node without `script:`', 'add `script: scripts/foo.sh`');
      else if (!existsSync(p)) add(n.file, 2, 'error', `script ${n.meta.script} not found`, 'create it or fix the path');
      else { try { accessSync(p, constants.X_OK); } catch { add(n.file, 2, 'error', `script ${n.meta.script} not executable`, `chmod +x ${n.meta.script}`); } }
    }
    if (Array.isArray(n.meta.cache_files)) for (const file of n.meta.cache_files) if (typeof file === 'string' && !existsSync(resolve(graph.dir, file))) metaError('cache_files', `cache dependency ${file} not found`, 'create it or fix the path');
    if (n.meta.routing !== 'ambiguous') for (const f of ambiguous(n, graph)) add(n.file, f.b.line, 'warn', `ambiguous fork: lines ${f.a.line} and ${f.b.line} both match ${JSON.stringify(f.s)}`, 'tighten a predicate, use `routing: ambiguous`, or add `ordered: true` if priority is intended');
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
    for (const k of n.needs) if (!avail.has(k) && !avail.has(k.split('.')[0])) add(n.file, 2, 'error', `needs \`${k}\` but no upstream node sets it`, `add it to an upstream \`sets\` or to the entry node's needs`);
  }
  // examples as tests (single-step; judge outcome stubbed by `judge:`)
  const { decideOne } = await import('./explain.js');
  if (runExamples) for (const n of nodes) for (const ex of n.examples) {
    if (!ex.input || !ex.expect) { add(n.file, ex.line, 'error', 'example needs `input:` and `expect:`', 'add both'); continue; }
    if (n.kind === 'harness') { add(n.file, ex.line, 'error', 'harness examples require an output fixture; check does not execute tool loops', 'use a stubbed integration test until harness output fixtures are supported'); continue; }
    try {
      const got = await decideOne(graph, n, ex.input, ex.judge);
      if (got.next !== ex.expect) add(n.file, ex.line, 'error', `example expects [[${ex.expect}]] but routes to [[${got.next}]] (${got.how})`, 'fix the route order/predicate or the example');
    } catch (e) { add(n.file, ex.line, 'error', `example cannot run: ${e.message}`, 'provide the state and judge stub needed for this routing example'); }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export const format = (f) => `${f.file}:${f.line}: ${f.level}: ${f.msg} → ${f.fix}`;
