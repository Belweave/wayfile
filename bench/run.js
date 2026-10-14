// Routing experiment, not a benchmark of the actual Eve runtime.
// node bench/run.js --dataset legacy|challenge [--dry] [--limit N] [--seed S]
import { writeFileSync, appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../packages/wayfile/src/parse.js';
import { run } from '../packages/wayfile/src/run.js';
import { provider, makeJudge, makeSkill } from '../packages/wayfile/src/model.js';
import { loadLedger, saveLedger } from './ledger.js';
import { agent } from './agents.js';
import { dataset } from './datasets.js';
import { scoreCase, wayfileEvidence } from './contracts.js';
import { digest, requestRecorder, zeroUsage } from './measurement.js';

// Historical price snapshots are diagnostic estimates, never measured-cost gates.
export const PRICES = { 'anthropic/claude-haiku-5.5': { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 }, 'anthropic/claude-haiku-4.5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, 'claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, 'claude-sonnet-4-5': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 } };
export const cost = (u, p) => p ? (u.input * p.input + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead + u.output * p.output) / 1e6 : null;
const total = (u) => u.input + u.output + u.cacheRead + u.cacheWrite;
const quantile = (xs, q) => xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1] : null;
export const ARMS = ['wayfile', 'bash', 'eve_sim'];

export function summarize(rows, arm, price) {
  const xs = rows.filter((r) => r[arm]);
  const usage = xs.reduce((sum, r) => { for (const k of Object.keys(sum)) sum[k] += r[arm].usage?.[k] ?? 0; return sum; }, zeroUsage());
  const costMeasured = xs.length === rows.length && xs.every((r) => r[arm].costMeasured === true && Number.isFinite(r[arm].usd) && r[arm].usd >= 0);
  const usd = costMeasured ? xs.reduce((sum, r) => sum + r[arm].usd, 0) : null;
  const successes = xs.filter((r) => r[arm].success === true).length;
  const groups = (key) => Object.fromEntries([...new Set(xs.map((r) => r[key]))].sort().map((g) => {
    const ys = xs.filter((r) => r[key] === g);
    return [g, { n: ys.length, correct: ys.filter((r) => r[arm].routeCorrect === true).length, successes: ys.filter((r) => r[arm].success === true).length }];
  }));
  return {
    n: xs.length, correct: xs.filter((r) => r[arm].routeCorrect === true).length, successes,
    failures: xs.filter((r) => r[arm].status === 'failed').length,
    unresolved: xs.filter((r) => r[arm].status === 'unresolved').length,
    calls: xs.reduce((sum, r) => sum + r[arm].calls, 0),
    toolCalls: xs.reduce((sum, r) => sum + (r[arm].toolCalls || 0), 0),
    usage, tokens: total(usage), costMeasured, usd, knownUsd: usage.cost, usdPerSuccess: usd !== null && successes > 0 ? usd / successes : null,
    estimatedUsd: xs.every((r) => r[arm].tokensMeasured) ? cost(usage, price) : null,
    unknownCostCalls: xs.reduce((sum, r) => sum + (r[arm].unknownCostCalls || 0), 0),
    msMedian: quantile(xs.map((r) => r[arm].ms), 0.5), msP95: quantile(xs.map((r) => r[arm].ms), 0.95),
    graphs: groups('graph'), families: groups('family'),
  };
}

export function paired(rows, baseline) {
  const counts = { both: 0, onlyWayfile: 0, onlyBaseline: 0, neither: 0, criticalRegressions: [] };
  for (const r of rows) {
    const w = r.wayfile?.success === true, b = r[baseline]?.success === true;
    counts[w ? b ? 'both' : 'onlyWayfile' : b ? 'onlyBaseline' : 'neither']++;
    if (r.critical && b && !w) counts.criticalRegressions.push(r.id);
  }
  return { ...counts, successDifference: rows.length ? (counts.onlyWayfile - counts.onlyBaseline) / rows.length : null };
}

export function gate(s, graphs, { rows = [], arms = ARMS, dry = false, subset = false, interrupted = false, sourceChanged = false, provenanceComplete = false } = {}) {
  const nodes = graphs.flatMap((g) => Object.values(g.nodes));
  const modelNodes = nodes.filter((n) => n.kind === 'skill' || n.meta.routing === 'ambiguous' || n.routes.some((r) => r.type === 'judge')).length;
  const actualEve = arms.includes('eve_runtime');
  const mockEve = actualEve && rows.some((r) => r.eve_runtime?.modelQualityMeasured === false || r.eve_runtime?.provenance?.mock);
  const out = { modelNodes: `${modelNodes}/${nodes.length}`, realEveDecision: actualEve ? mockEve ? 'LOCAL MOCK (AI quality/cost unmeasured)' : 'PENDING (actual runtime comparison incomplete)' : 'UNMEASURED', scope: 'observed development/regression tasks; model API cost; named fixture configurations' };
  if (dry) return { ...out, decision: 'PENDING (no model comparison)' };
  if (interrupted) return { ...out, decision: 'PENDING (interrupted run)' };
  if (subset) return { ...out, decision: 'PENDING (smoke subset)' };
  const runtimeProvenance = !actualEve || rows.every((r) => r.eve_runtime?.provenance?.kind === 'eve-runtime' && r.eve_runtime.provenance.eveVersion && r.eve_runtime.provenance.configHash && !r.eve_runtime.provenance.mock && r.eve_runtime.modelQualityMeasured !== false);
  const complete = rows.length > 0 && new Set(rows.map((r) => r.id)).size === rows.length && !sourceChanged && provenanceComplete && runtimeProvenance && arms.every((a) => s[a]?.n === rows.length && s[a].costMeasured && rows.every((r) => r[a]?.status !== 'unresolved' && r[a]?.observationComplete));
  if (!complete) return { ...out, decision: 'PENDING (incomplete measured evidence)' };
  out.criticalFailures = rows.filter((r) => r.critical && !r.wayfile.success).map((r) => r.id);
  out.comparisons = Object.fromEntries(arms.filter((a) => a !== 'wayfile').map((arm) => {
    const p = paired(rows, arm);
    const domainRegressions = Object.keys(s.wayfile.graphs).filter((g) => s.wayfile.graphs[g].successes < s[arm].graphs[g].successes);
    const qualityPreserved = p.onlyWayfile >= p.onlyBaseline && p.criticalRegressions.length === 0 && domainRegressions.length === 0;
    const cheaperPerSuccess = s.wayfile.usdPerSuccess !== null && s[arm].usdPerSuccess !== null && s.wayfile.usdPerSuccess < s[arm].usdPerSuccess;
    return [arm, { ...p, domainRegressions, qualityPreserved, cheaperPerSuccess, costRatio: s.wayfile.usdPerSuccess > 0 && s[arm].usdPerSuccess !== null ? s[arm].usdPerSuccess / s.wayfile.usdPerSuccess : null }];
  }));
  const passed = out.criticalFailures.length === 0 && Object.values(out.comparisons).every((x) => x.qualityPreserved && x.cheaperPerSuccess);
  out.decision = passed ? actualEve ? 'PASS (includes actual Eve runtime)' : 'PASS (simulated baselines only)' : 'NO-GO (observed quality/cost bar not met)';
  if (actualEve) out.realEveDecision = out.criticalFailures.length === 0 && out.comparisons.eve_runtime.qualityPreserved && out.comparisons.eve_runtime.cheaperPerSuccess ? 'PASS (observed actual runtime comparison)' : 'NO-GO (observed actual runtime quality/cost bar not met)';
  return out;
}

const dollars = (x) => x === null || x === undefined ? 'unknown' : `$${x.toFixed(6)}`;
export function table(s, g, meta) {
  const row = (name, x) => x ? `| ${name} | ${x.correct}/${x.n} | ${x.successes}/${x.n} | ${x.unresolved} | ${x.calls} | ${x.toolCalls} | ${x.usage.input} / ${x.usage.output} / ${x.usage.cacheRead} / ${x.usage.cacheWrite} | ${x.usd === null ? `unknown (known ≥${dollars(x.knownUsd)})` : dollars(x.usd)} | ${dollars(x.usdPerSuccess)} | ${x.msMedian ?? 'n/a'} / ${x.msP95 ?? 'n/a'} |` : `| ${name} | unmeasured | | | | | | | | |`;
  return [
    `# Routing experiment (${meta.at})`, '',
    `Dataset: ${meta.dataset.name} v${meta.dataset.version} (${meta.dataset.role}); ${meta.n} cases, ${meta.families} families. Requested model: ${meta.model ?? 'none'}. Actual response models: ${JSON.stringify(meta.responseModels)}.`, '',
    `Corpus hash: \`${meta.dataset.corpusHash}\`. Labels/contracts hash: \`${meta.dataset.labelsHash}\`. Config hash: \`${meta.configHash}\`.`, '',
    '| arm | confirmed route / tasks | full contract success | unresolved | model requests incl. failures/repairs | tool calls | tokens input / output / cache read / write | measured API USD | USD/success incl. failed spend | latency p50 / p95 ms |',
    '|---|---|---|---|---|---|---|---|---|---|',
    row('Wayfile', s.wayfile), row('bash model loop', s.bash), ...(s.eve_sim ? [row('Eve simulation (hand-written skill loop)', s.eve_sim)] : []), ...(s.eve_runtime ? [row('Actual Eve runtime fixture', s.eve_runtime)] : []), '',
    `Per-run ledger delta: ${dollars(meta.spendDeltaUsd)}; cumulative ledger: ${dollars(meta.spentCumulativeUsd)}. Labelling is a separate phase and is not included in arm cost. Missing costs remain unknown; price estimates never qualify a gate.`, '',
    `Provider prompt cache: observed API cache usage; Wayfile application memo: disabled. Arm order is balanced and cases are shuffled with seed \`${meta.seed}\`. This is not a controlled cold-cache experiment.`, '',
    `**Comparison: ${g.decision}. Actual Eve runtime: ${g.realEveDecision}.**`, '',
    ...(meta.dry ? ['This dry run confirms only locally resolved tasks. Unresolved tasks require a model; the fractions above are coverage counts, not measured model accuracy.', ''] : []),
    ...(g.comparisons ? Object.entries(g.comparisons).map(([a, p]) => `- ${a}: paired wins/losses ${p.onlyWayfile}/${p.onlyBaseline}; critical regressions ${p.criticalRegressions.join(', ') || 'none'}; domain regressions ${p.domainRegressions.join(', ') || 'none'}; cost/success ratio ${p.costRatio?.toFixed(2) ?? 'n/a'}.`) : []), '',
    'All costs are model API charges. Local tools, infrastructure, human work, and independent grading are not priced here. Development/regression scores do not certify unseen generalization. See bench/EXPERIMENT.md.', '',
  ].join('\n');
}

export async function observeTask(c, arm, { call, ledger, graph, dry = false, maxTurns = 8, onEvent } = {}) {
  const start = performance.now();
  const recorder = call ? requestRecorder(call, { ledger, context: { caseId: c.id, arm }, onEvent }) : null;
  let result;
  try {
    if (arm === 'wayfile') {
      const ask = async ({ state }) => {
        const answer = state.stub?.ask ?? 'yes'; // Explicit, documented benchmark simulation.
        if (!['yes', 'no'].includes(answer)) throw new Error('invalid simulated approval answer');
        return { answer };
      };
      const w = await run(graph, c.input, { ask, ...(recorder ? { judge: makeJudge(recorder.call), skill: makeSkill(recorder.call) } : {}) });
      const resolved = graph.nodes[w.end]?.kind === 'end' && !w.steps.some((step) => /no judge configured/.test(step.how));
      result = { ...w, status: resolved ? 'completed' : 'unresolved', evidence: wayfileEvidence(graph, w), toolCalls: w.steps.filter((step) => ['ask', 'script'].includes(graph.nodes[step.node].kind)).length };
    } else result = await agent(arm, recorder.call, c, maxTurns);
  } catch (e) {
    const partial = e.result ?? e.partial;
    result = { ...partial, end: null, status: dry ? 'unresolved' : 'failed', evidence: partial?.steps && arm === 'wayfile' ? wayfileEvidence(graph, partial) : partial?.evidence || [], error: String(e.message).slice(0, 400) };
  }
  const measurement = recorder?.measurement() ?? { calls: 0, usage: zeroUsage(), usd: 0, costMeasured: true, tokensMeasured: true, unknownCostCalls: 0, models: {}, providers: {} };
  const observation = { ...result, ...measurement, ms: Math.round(performance.now() - start), observationComplete: !dry && measurement.costMeasured, requests: recorder?.events || [] };
  return { ...observation, ...scoreCase(c, observation) };
}

export function sourceSnapshot(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (['results', 'artifacts', '.wayfile', '.eve', '.workflow', '.vercel', '.output', '.nitro', '.cache', 'dist', 'runs', 'node_modules'].includes(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(js|mjs|ts|mts|md|sh|json|txt|yml|yaml)$/.test(name)) files.push({ path: relative(root, path), hash: digest(readFileSync(path, 'utf8')) });
    }
  };
  for (const dir of ['packages', 'apps', 'examples', 'bench']) walk(join(root, dir));
  return { hash: digest(files), files };
}

function options(argv) {
  const out = { dataset: 'legacy', dry: false, limit: null, seed: 'wayfile-evaluation-v2', maxTurns: 8, eveRuntime: false, includeSimulation: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry') out.dry = true;
    else if (argv[i] === '--eve-runtime') out.eveRuntime = true;
    else if (argv[i] === '--include-simulation') out.includeSimulation = true;
    else if (['--dataset', '--limit', '--seed', '--max-turns'].includes(argv[i])) {
      const key = { '--dataset': 'dataset', '--limit': 'limit', '--seed': 'seed', '--max-turns': 'maxTurns' }[argv[i]];
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`missing ${argv[i]} value`);
      out[key] = ['limit', 'maxTurns'].includes(key) ? Number(argv[++i]) : argv[++i];
    } else throw new Error(`unknown argument ${argv[i]}`);
  }
  for (const key of ['limit', 'maxTurns']) if (out[key] !== null && (!Number.isInteger(out[key]) || out[key] < 1 || out[key] > 100)) throw new Error(`${key} must be an integer from 1 to 100`);
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--evidence-models')) return (await import('./evidence-models.js')).main(argv.filter((a) => a !== '--evidence-models'));
  const opts = options(argv), data = dataset(opts.dataset);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const ledger = loadLedger(), spendStart = ledger.spent;
  const call = opts.dry ? null : provider({ ledger });
  if (!opts.dry && !call) throw new Error('No model API key; use --dry.');
  const graphs = { triage: loadGraph(join(root, 'examples/triage')), ci: loadGraph(join(root, 'examples/ci')) };
  const activeArms = opts.eveRuntime ? ['wayfile', 'bash', ...(opts.includeSimulation ? ['eve_sim'] : []), 'eve_runtime'] : ARMS;
  const selected = opts.limit ? data.cases.filter((c, i, xs) => xs.filter((x) => x.graph === c.graph).indexOf(c) < opts.limit) : [...data.cases];
  selected.sort((a, b) => digest(`${opts.seed}:${a.id}`).localeCompare(digest(`${opts.seed}:${b.id}`)));
  const source = sourceSnapshot(root);
  let gitCommit = null;
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* A source tree can run without git. */ }
  const config = { version: 2, arms: activeArms, model: call?.model ?? null, provider: process.env.OPENROUTER_API_KEY ? 'openrouter' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'none', providerCacheKey: call?.cacheKey ?? null, baselineMaxTurns: opts.maxTurns, baselineMaxTokens: 400, wayfileMaxSteps: 50, outputValidationAttempts: 2, wayfileNodeOverrides: 'model, fallback_model, max_tokens and max_attempts are preserved in hashed source files and per-request journal', seed: opts.seed, dry: opts.dry, caseIds: selected.map((c) => c.id), armOrder: 'balanced rotation after seeded case shuffle', applicationMemo: 'disabled', providerCache: 'observed provider caching, not controlled cold', approval: 'explicit simulated callback/tool; default yes, input.stub.ask overrides', sourceHash: source.hash, corpusHash: data.corpusHash, labelsHash: data.labelsHash };
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${opts.dataset}-${randomUUID().slice(0, 8)}`;
  const dir = join(root, 'bench/results', runId);
  mkdirSync(dir, { recursive: true });
  const rows = [], meta = { runId, at: new Date().toISOString(), model: config.model, dataset: { ...data, cases: undefined }, n: selected.length, families: new Set(selected.map((c) => c.family)).size, seed: opts.seed, configHash: digest(config), config, gitCommit, sourceFiles: source.files, spentStartUsd: spendStart, responseModels: {}, responseProviders: {}, dry: opts.dry };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(meta, null, 2));
  writeFileSync(join(dir, 'dataset.json'), JSON.stringify({ ...data, cases: selected }, null, 2));
  writeFileSync(join(dir, 'requests.jsonl'), '');
  writeFileSync(join(dir, 'cases.jsonl'), '');
  let interrupted = null;
  let runtime, adapter;
  if (opts.eveRuntime) {
    adapter = await import('./eve-runtime/adapter.mjs');
    runtime = await adapter.startRuntime({ mock: opts.dry, allowPaid: !opts.dry, model: call?.model ?? 'anthropic/claude-haiku-5.5', ledger, maxUsd: Number(process.env.WAYFILE_MAX_USD || 3), maxTurns: opts.maxTurns, maxTokens: 400, artifactDir: join(dir, 'eve-runtime') });
  }
  try {
    for (let i = 0; i < selected.length; i++) {
      const c = selected[i], row = { id: c.id, graph: c.graph, family: c.family, expect: c.expect, critical: Boolean(c.contract?.evidence?.some((e) => e.kind === 'approval') || c.contract?.forbidEvidence?.length || ['missing-data', 'invalid-data'].includes(c.family)) };
      const order = opts.dry ? ['wayfile', ...(opts.eveRuntime ? ['eve_runtime'] : [])] : [...activeArms.slice(i % activeArms.length), ...activeArms.slice(0, i % activeArms.length)];
      for (const arm of order) {
        const onEvent = (e) => appendFileSync(join(dir, 'requests.jsonl'), `${JSON.stringify({ ...e, caseId: c.id, arm })}\n`);
        if (arm === 'eve_runtime') {
          const start = performance.now();
          const raw = await adapter.runCase(c, { runtime, mock: opts.dry, onEvent });
          row[arm] = { ...raw, ms: raw.ms ?? Math.round(performance.now() - start), wrapperMs: Math.round(performance.now() - start), observationComplete: !opts.dry && raw.costMeasured && raw.modelQualityMeasured !== false, ...scoreCase(c, raw) };
        } else row[arm] = await observeTask(c, arm, { call, ledger, graph: graphs[c.graph], dry: opts.dry, maxTurns: opts.maxTurns, onEvent });
        saveLedger(ledger);
        if (/cost guard|budget/i.test(row[arm].error || '')) { interrupted = row[arm].error; break; }
      }
      rows.push(row);
      appendFileSync(join(dir, 'cases.jsonl'), `${JSON.stringify(row)}\n`);
      process.stderr.write('.');
      if (interrupted) break;
    }
  } catch (error) { interrupted = String(error.message); }
  finally { if (runtime) await adapter.stopRuntime(runtime); saveLedger(ledger); }
  const requests = readFileSync(join(dir, 'requests.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  for (const e of requests) {
    if (e.model) meta.responseModels[e.model] = (meta.responseModels[e.model] || 0) + 1;
    if (e.provider) meta.responseProviders[e.provider] = (meta.responseProviders[e.provider] || 0) + 1;
  }
  Object.assign(meta, { finishedAt: new Date().toISOString(), n: rows.length, plannedN: selected.length, spendDeltaUsd: ledger.spent - spendStart, spentCumulativeUsd: ledger.spent, unknownCost: Boolean(ledger.unknownCost), sourceChanged: sourceSnapshot(root).hash !== source.hash, interrupted });
  const prices = PRICES[meta.model];
  const summary = Object.fromEntries(activeArms.map((a) => [a, opts.dry && !['wayfile', 'eve_runtime'].includes(a) ? null : summarize(rows, a, prices)]));
  const provenanceComplete = requests.filter((e) => e.providerCall !== false).every((e) => Boolean(e.model)) && meta.model !== null;
  const result = { meta, summary, gate: gate(summary, Object.values(graphs), { rows, arms: activeArms, dry: opts.dry, subset: opts.limit !== null || rows.length !== selected.length, interrupted: Boolean(interrupted), sourceChanged: meta.sourceChanged, provenanceComplete }), rows };
  writeFileSync(join(dir, 'report.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(dir, 'report.md'), table(summary, result.gate, meta));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(meta, null, 2));
  console.log(`\n${table(summary, result.gate, meta)}Artifacts: ${relative(root, dir)}`);
  if (interrupted) process.exitCode = 2;
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch((e) => { console.error(e.message); process.exitCode = 2; });
