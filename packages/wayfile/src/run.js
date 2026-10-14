// Runner: deterministic routes first, model only at judge forks, scripts via stdin/stdout JSON.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { evaluate, get, vars, validStatePath } from './logic.js';
import { stubAsk } from './notify.js';
import { validateValue, validateJSONValue, parseJSON } from './contracts.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

function setPath(state, path, val) {
  if (!validStatePath(path)) throw new Error(`unsafe state path: ${path}`);
  const ks = path.split('.');
  let o = state;
  for (const k of ks.slice(0, -1)) o = o[k] = Object.hasOwn(o, k) && o[k] && typeof o[k] === 'object' ? o[k] : {};
  o[ks.at(-1)] = val;
}

export function scriptPath(graph, node) {
  return node.meta.script ? resolve(graph.dir, node.meta.script) : null;
}

const CACHE_VERSION = 2;
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function skillErrors(node, value) {
  if (node.meta.output === 'json') return validateValue(value, node.outputSchema);
  return typeof value === 'string' && value.trim() ? [] : ['skill text must be a nonempty string'];
}

function addUsage(a, b) {
  const out = Object.fromEntries(TOKEN_KEYS.map((k) => [k, (a[k] || 0) + (b?.[k] || 0)]));
  out.cost = Number.isFinite(a.cost) && a.cost >= 0 && Number.isFinite(b?.cost) && b.cost >= 0 ? a.cost + b.cost : null;
  return out;
}

function graphMemoData(graph) {
  return [resolve(graph.dir), graph.instructions || '', Object.values(graph.nodes).sort((a, b) => a.id.localeCompare(b.id)).map((n) => [
    n.id, n.kind, n.text, n.title, n.body, n.meta, n.needs, n.sets, n.routes, n.skillText, n.outputSchema,
  ])];
}

function fileDependencies(graph) {
  const paths = new Set();
  for (const n of Object.values(graph.nodes)) {
    const script = scriptPath(graph, n);
    if (script) paths.add(script);
    for (const file of n.meta.cache_files || []) paths.add(resolve(graph.dir, file));
  }
  return [...paths].sort().map((path) => {
    try { return [path, sha(readFileSync(path))]; }
    catch (e) { if (e.code === 'ENOENT') return [path, 'missing']; throw e; }
  });
}

function memoKey(graph, node, state, opts, graphData) {
  if (node.kind === 'ask' || node.kind === 'harness') return null;
  const usesJudge = node.routes.some((r) => r.type === 'judge') || node.meta.routing === 'ambiguous';
  const adapters = [usesJudge && opts.judge, node.kind === 'skill' && opts.skill].filter(Boolean);
  // A custom adapter can close over arbitrary configuration. Its owner must identify it.
  if (adapters.some((fn) => fn.cacheKey == null && opts.cacheKey == null)) return null;
  const paths = [...new Set([...node.needs, ...node.routes.filter((r) => r.type === 'when').flatMap((r) => vars(r.rule).map((v) => v.path))])].sort();
  const inputs = node.kind === 'script' ? state : paths.map((path) => {
    const value = get(state, path);
    return [path, value === undefined ? ['missing'] : ['value', value]];
  });
  return sha(JSON.stringify([
    CACHE_VERSION, graphData, node.id, fileDependencies(graph), inputs,
    adapters.map((fn) => fn.cacheKey ?? opts.cacheKey), opts.cacheKey, opts.context,
  ]));
}

function readMemo(file, node) {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    const allowedSets = node.sets.length ? node.sets : node.kind === 'skill' ? [`${node.id}.output`] : [];
    if (!record(d) || d.version !== CACHE_VERSION || !record(d.set) || typeof d.how !== 'string' || !Number.isInteger(d.line)) return null;
    if (d.next !== null && !node.routes.some((r) => r.to === d.next)) return null;
    if (Object.keys(d.set).some((k) => !allowedSets.includes(k))) return null;
    if (node.kind === 'skill' && (!Object.hasOwn(d.set, allowedSets[0]) || skillErrors(node, d.set[allowedSets[0]]).length)) return null;
    return { next: d.next, line: d.line, how: d.how, set: d.set, calls: 0 };
  } catch (e) {
    if (e instanceof SyntaxError || e.code === 'ENOENT') return null;
    throw e;
  }
}

function writeMemo(dir, file, decision) {
  mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, next: decision.next, line: decision.line, how: decision.how, set: decision.set }));
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function runScript(graph, node, state) {
  const p = scriptPath(graph, node);
  const r = spawnSync(p, [], { input: JSON.stringify(state), encoding: 'utf8', timeout: 10000, cwd: dirname(p) });
  if (r.error && r.error.code !== 'EPIPE') throw r.error; // EPIPE: script exited without reading stdin
  if (r.status !== 0) throw new Error(`${node.file}: script exited ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
  const out = parseJSON(r.stdout); // raw stdout never enters model context
  if (!record(out) || (Object.hasOwn(out, 'set') && !record(out.set))) throw new Error(`${node.file}: script output must be an object with an optional object set`);
  return { set: out.set ?? {}, next: out.next };
}

// Decide the next node. Returns {next, line, how, set, usage}.
async function decide(graph, node, state, opts) {
  let set = {};
  let usage = null;
  let calls = 0;
  let approval;
  const attempts = [];
  let toolCalls = 0;
  const toolEvents = [];
  const account = (out) => {
    const count = out?.calls ?? 1;
    usage = addUsage(usage || zeroUsage(), out?.usage);
    if (Array.isArray(out?.attempts)) attempts.push(...out.attempts);
    if (!Number.isSafeInteger(count) || count < 0) { calls++; throw new Error(`${node.file}: invalid model call count`); }
    calls += count;
    if (Array.isArray(out?.toolEvents)) toolEvents.push(...out.toolEvents);
    if (out?.toolCalls !== undefined) {
      if (!Number.isSafeInteger(out.toolCalls) || out.toolCalls < 0) throw new Error(`${node.file}: invalid tool call count`);
      toolCalls += out.toolCalls;
    }
  };
  const done = (r) => ({ ...r, calls, ...(usage ? { usage } : {}), ...(attempts.length ? { attempts } : {}), ...(approval ? { approval } : {}), ...(toolEvents.length || toolCalls ? { toolCalls, toolEvents } : {}) });
  const invoke = async (fn, args) => {
    let out;
    try { out = await fn(...args); }
    catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      account(error);
      throw error;
    }
    account(out);
    return out;
  };
  try {
    if (node.kind === 'skill' || node.kind === 'harness') {
      const adapter = node.kind === 'harness' ? opts.harness : opts.skill;
      if (!adapter) throw new Error(`${node.file}: ${node.kind} node needs a model (set OPENROUTER_API_KEY)`);
      const out = await invoke(adapter, [graph, node, state]);
      const key = node.sets[0] || `${node.id}.output`;
      const value = node.meta.output === 'json' ? out.value : out.text;
      if (value === undefined) throw new Error(`${node.file}: ${node.kind} returned no ${node.meta.output === 'json' ? 'JSON value' : 'text'}`);
      const errors = skillErrors(node, value);
      if (errors.length) throw new Error(`${node.file}: ${node.kind} output failed validation: ${errors.slice(0, 5).join('; ')}`);
      set = { [key]: value };
      setPath(state, key, value);
    }
    if (node.kind === 'script') {
      const out = runScript(graph, node, state);
      if (out.next !== undefined && !node.routes.some((r) => r.to === out.next)) throw new Error(`${node.file}: script returned invalid next target ${JSON.stringify(out.next)}`);
      set = Object.fromEntries(Object.entries(out.set).filter(([k]) => node.sets.includes(k)));
      for (const [k, v] of Object.entries(set)) setPath(state, k, v);
      if (out.next !== undefined) return done({ next: out.next, line: 0, how: 'script next', set });
    }
    if (node.kind === 'ask') {
      const response = await (opts.ask || stubAsk)({ node, state }); // stub unless a Notify backend is passed
      const ans = response?.answer;
      if (typeof ans !== 'string' || !ans.trim()) throw new Error(`${node.file}: ask returned no answer`);
      if (response.via) approval = { via: response.via, ...(response.id ? { id: response.id } : {}) };
      set = { [node.sets[0] || 'ask.answer']: ans };
      setPath(state, node.sets[0] || 'ask.answer', ans);
    }
    const detectAmbiguity = node.meta.routing === 'ambiguous' && node.meta.ordered !== true;
    const matching = [];
    for (const r of node.routes) if (r.type === 'when' && evaluate(r.rule, state)) {
      matching.push(r);
      if (!detectAmbiguity) break;
    }
    const ambiguous = detectAmbiguity && new Set(matching.map((r) => r.to)).size > 1;
    if (matching.length && !ambiguous) {
      const r = matching[0];
      return done({ next: r.to, line: r.line, how: `\`${r.src}\``, set });
    }
    const judges = node.routes.filter((r) => r.type === 'judge');
    const other = node.routes.find((r) => r.type === 'otherwise');
    if (judges.length || ambiguous) {
      const targets = [...new Set(ambiguous ? matching.map((r) => r.to) : [...judges.map((r) => r.to), ...(other ? [other.to] : [])])];
      if (!opts.judge) throw new Error(`${node.file}: judge required for ${ambiguous ? 'ambiguous matches' : 'unresolved fork'} (${targets.join(', ')})`);
      const j = await invoke(opts.judge, [graph, node, state, targets]);
      if (!j || !targets.includes(j.target)) throw new Error(`${node.file}: judge returned invalid target ${JSON.stringify(j?.target)}; expected ${targets.join(', ')}`);
      const r = ambiguous ? matching.find((x) => x.to === j.target) : judges.find((x) => x.to === j.target) || other;
      if (node.kind === 'judge' && node.sets[0]) { set[node.sets[0]] = j.target; setPath(state, node.sets[0], j.target); }
      return done({ next: j.target, line: r.line, how: `judge${ambiguous ? ' (ambiguous)' : ''}: "${r.src}"`, set });
    }
    if (other) return done({ next: other.to, line: other.line, how: 'otherwise', set });
    return done({ next: null, line: 0, how: 'end', set });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    error.decision = done({ next: null, line: 0, how: `failed: ${error.message}`, set });
    if (usage) error.usage = usage;
    error.calls = calls;
    if (attempts.length) error.attempts = attempts;
    if (toolEvents.length || toolCalls) { error.toolCalls = toolCalls; error.toolEvents = toolEvents; }
    throw error;
  }
}

export async function run(graph, input, opts = {}) {
  let state;
  const cacheDir = opts.cacheDir;
  const steps = [];
  const visits = Object.create(null);
  let id = opts.start || graph.entry;
  const maxSteps = opts.maxSteps ?? 50;
  const result = (status, error) => ({
    end: status === 'completed' ? steps.at(-1)?.node : null, status, steps, state,
    usage: steps.reduce((a, s) => s.usage ? addUsage(a, s.usage) : a, zeroUsage()),
    calls: steps.reduce((n, s) => n + (s.calls || 0), 0),
    ...(status === 'partial' ? { partial: true, next: id } : {}), ...(error ? { error } : {}),
  });
  try {
    if (!record(input)) throw new Error('run input must be a state object');
    const inputErrors = validateJSONValue(input);
    if (inputErrors.length) throw new Error(`invalid run input: ${inputErrors.slice(0, 5).join('; ')}`);
    state = structuredClone(input);
    if (!id || !Object.hasOwn(graph.nodes, id)) throw new Error(id ? `no such node: ${id}` : 'graph has no entry node');
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('maxSteps must be a positive integer');
    const graphData = cacheDir ? graphMemoData(graph) : null;
    while (id && steps.length < maxSteps) {
      const node = graph.nodes[id];
      if (!Object.hasOwn(graph.nodes, id)) throw new Error(`no such node: ${id}`);
      visits[id] = (visits[id] || 0) + 1;
      if (node.meta.max_visits && visits[id] > node.meta.max_visits) throw new Error(`${id}: exceeded max_visits ${node.meta.max_visits}`);
      if (node.kind === 'end') { steps.push({ node: id, next: null, line: 0, how: 'end', set: {}, calls: 0, cached: false }); id = null; break; }
      let d, cached = false;
      const key = node.meta.cache === 'inputs' && cacheDir ? memoKey(graph, node, state, opts, graphData) : null;
      const cf = key && join(cacheDir, `${key}.json`);
      if (cf) d = readMemo(cf, node);
      if (d) {
        for (const [k, v] of Object.entries(d.set)) setPath(state, k, v);
        cached = true;
      } else {
        d = await decide(graph, node, state, opts);
        if (cf) {
          try { writeMemo(cacheDir, cf, d); }
          catch (error) { error.decision = { ...d, how: `failed: ${error.message}` }; throw error; }
        }
      }
      steps.push({ node: id, ...d, usage: cached ? undefined : d.usage, cached });
      id = d.next;
    }
    if (id && !opts.allowPartial) throw new Error(`exceeded maxSteps ${maxSteps}; next node: ${id}`);
    const completed = result(id ? 'partial' : 'completed');
    if (opts.traceDir) writeTrace(graph, input, completed, opts.traceDir);
    return completed;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (error.decision && id) steps.push({ node: id, ...error.decision, cached: false });
    const failed = result('failed', error.message);
    error.result = failed;
    error.usage = failed.usage;
    error.calls = failed.calls;
    if (opts.traceDir) {
      try { writeTrace(graph, input, failed, opts.traceDir); }
      catch (traceError) { error.traceError = traceError.message; }
    }
    throw error;
  }
}

export function traceMarkdown(graph, input, res) {
  const rows = res.steps.map((s, i) => {
    const n = graph.nodes[s.node];
    const file = n?.file || s.node;
    const where = s.line ? `${file}:${s.line}` : file;
    const tok = s.usage ? `${s.usage.input}+${s.usage.output} (cache r${s.usage.cacheRead}/w${s.usage.cacheWrite})` : s.cached ? 'memo' : '0';
    const approval = s.approval ? JSON.stringify(s.approval).replace(/\|/g, '\\|') : '';
    return `| ${i + 1} | ${s.node} | ${s.how.replace(/\|/g, '\\|')} | \`${where}\` | ${JSON.stringify(s.set || {}).replace(/\|/g, '\\|')} | ${approval} | ${tok} |`;
  });
  const tools = res.steps.flatMap((step) => (step.toolEvents || []).map((event) => ({ node: step.node, ...event })));
  return [
    res.status === 'failed' ? '# Run failed' : res.status === 'partial' ? `# Run partial → ${res.next}` : `# Run → ${res.end}`, '',
    ...(res.error ? [`Error: ${res.error}`, ''] : []), '```json', JSON.stringify(input), '```', '',
    '| # | node | decided by | line | state diff | approval | tokens in+out |', '|---|---|---|---|---|---|---|', ...rows, '',
    `Model calls: ${res.calls}. Tokens: input ${res.usage.input}, output ${res.usage.output}, cache read ${res.usage.cacheRead}, cache write ${res.usage.cacheWrite}.`, '',
    ...(tools.length ? ['## Harness tools', '', '```json', JSON.stringify(tools, null, 2), '```', ''] : []),
  ].join('\n');
}

function writeTrace(graph, input, res, dir) {
  mkdirSync(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${sha(JSON.stringify(input)).slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  writeFileSync(join(dir, `${id}.md`), traceMarkdown(graph, input, res));
  res.trace = join(dir, `${id}.md`);
}
