// Runner: deterministic routes first, model only at judge forks, scripts via stdin/stdout JSON.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { evaluate, get } from './logic.js';
import { stubAsk } from './notify.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

function setPath(state, path, val) {
  const ks = path.split('.');
  let o = state;
  for (const k of ks.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {};
  o[ks.at(-1)] = val;
}

export function scriptPath(graph, node) {
  return node.meta.script ? resolve(graph.dir, node.meta.script) : null;
}

function memoKey(graph, node, state) {
  const sp = scriptPath(graph, node);
  const script = sp && existsSync(sp) ? readFileSync(sp, 'utf8') : '';
  return sha(JSON.stringify([node.text, script, node.needs.map((k) => get(state, k) ?? null)]));
}

function runScript(graph, node, state) {
  const p = scriptPath(graph, node);
  const r = spawnSync(p, [], { input: JSON.stringify(state), encoding: 'utf8', timeout: 10000, cwd: dirname(p) });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${node.file}: script exited ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
  const out = JSON.parse(r.stdout); // raw stdout never enters model context
  return { set: out.set || {}, next: out.next };
}

// Decide the next node. Returns {next, line, how, set, usage}.
async function decide(graph, node, state, opts) {
  let set = {};
  if (node.kind === 'script') {
    const out = runScript(graph, node, state);
    set = Object.fromEntries(Object.entries(out.set).filter(([k]) => node.sets.includes(k)));
    for (const [k, v] of Object.entries(set)) setPath(state, k, v);
    if (out.next && node.routes.some((r) => r.to === out.next)) return { next: out.next, line: 0, how: 'script next', set };
  }
  if (node.kind === 'ask') {
    const { answer: ans } = await (opts.ask || stubAsk)({ node, state }); // stub unless a Notify backend is passed
    set = { [node.sets[0] || 'ask.answer']: ans };
    setPath(state, node.sets[0] || 'ask.answer', ans);
  }
  for (const r of node.routes) if (r.type === 'when' && evaluate(r.rule, state)) return { next: r.to, line: r.line, how: `\`${r.src}\``, set };
  const judges = node.routes.filter((r) => r.type === 'judge');
  const other = node.routes.find((r) => r.type === 'otherwise');
  if (judges.length && opts.judge) {
    const targets = [...new Set([...judges.map((r) => r.to), ...(other ? [other.to] : [])])];
    const j = await opts.judge(graph, node, state, targets);
    if (targets.includes(j.target)) {
      const r = judges.find((x) => x.to === j.target) || other;
      if (node.kind === 'judge' && node.sets[0]) { set[node.sets[0]] = j.target; setPath(state, node.sets[0], j.target); }
      return { next: j.target, line: r.line, how: `judge: "${r.src}"`, set, usage: j.usage };
    }
    if (other) return { next: other.to, line: other.line, how: 'otherwise (judge gave no valid target)', set, usage: j.usage };
  }
  if (other) return { next: other.to, line: other.line, how: judges.length ? 'otherwise (no judge configured)' : 'otherwise', set, noCache: judges.length > 0 };
  return { next: null, line: 0, how: 'end', set };
}

export async function run(graph, input, opts = {}) {
  const state = structuredClone(input);
  const cacheDir = opts.cacheDir;
  const steps = [];
  const visits = {};
  let id = opts.start || graph.entry;
  const maxSteps = opts.maxSteps ?? 50;
  while (id && steps.length < maxSteps) {
    const node = graph.nodes[id];
    if (!node) throw new Error(`no such node: ${id}`);
    visits[id] = (visits[id] || 0) + 1;
    if (node.meta.max_visits && visits[id] > node.meta.max_visits) throw new Error(`${id}: exceeded max_visits ${node.meta.max_visits}`);
    if (node.kind === 'end' || !node.routes.length) { steps.push({ node: id, next: null, line: 0, how: 'end', set: {}, cached: false }); break; }
    let d, cached = false;
    const key = node.meta.cache === 'inputs' && cacheDir ? memoKey(graph, node, state) : null;
    const cf = key && join(cacheDir, `${key}.json`);
    if (cf && existsSync(cf)) {
      d = JSON.parse(readFileSync(cf, 'utf8'));
      for (const [k, v] of Object.entries(d.set)) setPath(state, k, v);
      cached = true;
    } else {
      d = await decide(graph, node, state, opts);
      if (cf && !d.noCache) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cf, JSON.stringify({ next: d.next, line: d.line, how: d.how, set: d.set })); }
    }
    delete d.noCache;
    steps.push({ node: id, ...d, usage: cached ? undefined : d.usage, cached });
    id = d.next;
  }
  const usage = steps.reduce((a, s) => {
    if (s.usage) for (const k of Object.keys(a)) a[k] += s.usage[k] || 0;
    return a;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const calls = steps.filter((s) => s.usage).length;
  const result = { end: steps.at(-1)?.node, steps, state, usage, calls };
  if (opts.traceDir) writeTrace(graph, input, result, opts.traceDir);
  return result;
}

export function traceMarkdown(graph, input, res) {
  const rows = res.steps.map((s, i) => {
    const n = graph.nodes[s.node];
    const where = s.line ? `${n.file}:${s.line}` : n.file;
    const tok = s.usage ? `${s.usage.input}+${s.usage.output} (cache r${s.usage.cacheRead}/w${s.usage.cacheWrite})` : s.cached ? 'memo' : '0';
    return `| ${i + 1} | ${s.node} | ${s.how.replace(/\|/g, '\\|')} | \`${where}\` | ${JSON.stringify(s.set || {}).replace(/\|/g, '\\|')} | ${tok} |`;
  });
  return [
    `# Run → ${res.end}`, '', '```json', JSON.stringify(input), '```', '',
    '| # | node | decided by | line | state diff | tokens in+out |', '|---|---|---|---|---|---|', ...rows, '',
    `Model calls: ${res.calls}. Tokens: input ${res.usage.input}, output ${res.usage.output}, cache read ${res.usage.cacheRead}, cache write ${res.usage.cacheWrite}.`, '',
  ].join('\n');
}

function writeTrace(graph, input, res, dir) {
  mkdirSync(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${sha(JSON.stringify(input)).slice(0, 8)}`;
  writeFileSync(join(dir, `${id}.md`), traceMarkdown(graph, input, res));
  res.trace = join(dir, `${id}.md`);
}
