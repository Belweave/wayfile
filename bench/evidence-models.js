// Real generated-output experiment. --mock is protocol validation only.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadGraph } from '../packages/wayfile/src/parse.js';
import { run } from '../packages/wayfile/src/run.js';
import { provider, makeSkill } from '../packages/wayfile/src/model.js';
import { parseJSON, validateValue } from '../packages/wayfile/src/contracts.js';
import { loadLedger, saveLedger } from './ledger.js';
import { requestRecorder, digest, zeroUsage } from './measurement.js';
import { summarize, gate, sourceSnapshot } from './run.js';
import { scoreEvidenceOutput } from './contracts.js';
import { evidenceTasks, readEvidenceRecord, resolveEvidence, evidenceContract, referenceOutput } from './evidence-tasks.js';
import { evidencePolicy, evidenceOutputSchema, evidenceContractVersion, evidenceGraderVersion } from './evidence-policy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const tool = (name, description) => ({ name, description, input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } });
const tools = [
  tool('read_customer', 'Read the customer named by id; returns its order ID, region, and versioned source.'),
  tool('read_order', 'Read the order named by id; returns factual order data and its versioned source.'),
  tool('read_policy', 'Read the region named by id; returns returnDays, approvalOver and its versioned source.'),
  { name: 'ask_approval', description: 'Observe the configured simulated human approval checkpoint. Required when amount exceeds policy approvalOver.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
];
export const evidenceInput = (task) => ({ customerId: task.customerId, approval: task.approval, prompt: task.prompt });

export function evidenceGraph(maxTokens = 800) {
  const graph = loadGraph(join(root, 'bench/evidence-agent'));
  graph.instructions = evidencePolicy;
  graph.nodes.draft.meta.max_tokens = maxTokens;
  return graph;
}

export function scoreEvidenceTask(task, result) {
  const expected = resolveEvidence(task), contract = evidenceContract(task, expected);
  const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null);
  const graded = scoreEvidenceOutput(output, contract);
  const reads = result.evidence || [];
  const checks = [{ name: 'completed', passed: result.status === 'completed' }, ...graded.checks];
  for (const source of contract.sources) checks.push({ name: `read:${source}`, passed: reads.some((e) => e.kind === 'record-read' && e.source === source) });
  if (expected.order && expected.policy && expected.order.ageDays <= expected.policy.returnDays && expected.order.amount > expected.policy.approvalOver) {
    checks.push({ name: 'approval-observed', passed: reads.some((e) => e.kind === 'approval' && e.answer === task.approval && e.simulated === true) });
  }
  let decision;
  try { decision = parseJSON(output).decision; } catch { decision = null; }
  const success = checks.every((c) => c.passed);
  return { ...graded, success, factualEvidenceContractSuccess: success, routeCorrect: decision === contract.decision, checks };
}

async function typedLoop(call, task, { maxTurns = 8, maxTokens = 800 } = {}) {
  const system = `${evidencePolicy}\nReply with JSON matching this schema: ${JSON.stringify(evidenceOutputSchema)}`;
  const messages = [{ role: 'user', content: JSON.stringify(evidenceInput(task)) }];
  const evidence = [];
  let invalidFinals = 0;
  for (let t = 0; t < maxTurns; t++) {
    const r = await call({ system, messages, tools, maxTokens });
    messages.push({ role: 'assistant', content: r.content });
    const uses = r.content.filter((c) => c.type === 'tool_use');
    if (!uses.length) {
      try {
        if (['length', 'max_tokens'].includes(r.stop)) throw new Error('output was truncated');
        const output = parseJSON(r.text), errors = validateValue(output, evidenceOutputSchema);
        if (errors.length) throw new Error(errors.slice(0, 5).join('; '));
        return { output, status: 'completed', evidence, toolCalls: evidence.length, validationRepairs: invalidFinals };
      } catch (error) {
        if (++invalidFinals >= 2) return { status: 'failed', error: error.message, evidence, toolCalls: evidence.length };
        messages.push({ role: 'user', content: `The previous output failed format validation: ${error.message}. Return one complete JSON object matching the schema. Do not invent facts.` });
        continue;
      }
    }
    const results = uses.map((u) => {
      let result;
      if (u.name === 'ask_approval') {
        result = { answer: task.approval, simulated: true };
        evidence.push({ kind: 'approval', ...result });
      } else {
        const collection = { read_customer: 'customers', read_order: 'orders', read_policy: 'policies' }[u.name];
        if (!collection || typeof u.input?.id !== 'string' || Object.keys(u.input).length !== 1) throw new Error('invalid evidence tool invocation');
        result = readEvidenceRecord(collection, u.input.id);
        evidence.push({ kind: 'record-read', ...result });
      }
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(result) };
    });
    messages.push({ role: 'user', content: results });
  }
  return { status: 'failed', error: `model loop exceeded ${maxTurns} requests`, evidence, toolCalls: evidence.length };
}

export async function observeEvidenceTask(task, arm, { call, ledger, maxTurns = 8, maxTokens = 800, dry = false, mock = false, onEvent } = {}) {
  const start = performance.now(), recorder = call ? requestRecorder(call, { ledger, context: { caseId: task.id, arm, phase: 'generated-evidence' }, onEvent }) : null;
  let result;
  try {
    if (arm === 'wayfile') {
      const graph = evidenceGraph(maxTokens);
      const state = await run(graph, { task: evidenceInput(task) }, { ...(recorder ? { skill: makeSkill(recorder.call) } : {}), ask: async ({ state }) => ({ answer: state.task.approval, via: 'benchmark-simulation' }) });
      const evidence = [...state.state.evidence];
      for (const step of state.steps) if (graph.nodes[step.node].kind === 'ask') evidence.push({ kind: 'approval', answer: Object.values(step.set)[0], simulated: true });
      result = { status: state.status, output: state.state.reply.output, evidence, toolCalls: evidence.length, steps: state.steps };
    } else result = await typedLoop(recorder.call, task, { maxTurns, maxTokens });
  } catch (error) {
    result = { status: dry ? 'unresolved' : 'failed', error: String(error.message).slice(0, 400), evidence: error.result?.state.evidence || [], steps: error.result?.steps || [] };
  }
  const measured = recorder?.measurement() ?? { calls: 0, usage: zeroUsage(), knownUsd: 0, usd: 0, costMeasured: true, tokensMeasured: true, unknownCostCalls: 0, models: {}, providers: {} };
  const observation = { ...result, ...measured, requests: recorder?.events || [], ms: Math.round(performance.now() - start), modelQualityMeasured: !mock && !dry, observationComplete: !mock && !dry && measured.costMeasured };
  return { ...observation, ...scoreEvidenceTask(task, observation) };
}

// This explicit fixture model tests both real Wayfile scripts and the tool-loop
// protocol. It does not represent measured AI behavior, tokens or model prices.
export function fixtureModel() {
  const reply = (content) => ({ content, text: content.filter((c) => c.type === 'text').map((c) => c.text).join(''), model: 'local-fixture', provider: 'local-fixture', stop: 'end_turn', usage: zeroUsage() });
  const call = async (req) => {
    const input = parseJSON(req.messages[0].content);
    let task, facts;
    if (req.tools) {
      task = input;
      const results = req.messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content.map((c) => parseJSON(c.content)));
      const record = (collection) => results.find((r) => r.collection === collection);
      const use = (name, data) => reply([{ type: 'tool_use', id: `fixture-${results.length}`, name, input: data }]);
      if (!record('customers')) return use('read_customer', { id: task.customerId });
      if (record('customers').value && !record('orders')) return use('read_order', { id: record('customers').value.orderId });
      if (record('orders')?.value && !record('policies')) return use('read_policy', { id: record('customers').value.region });
      if (record('orders')?.value && record('policies')?.value && record('orders').value.amount > record('policies').value.approvalOver && !results.some((r) => r.answer)) return use('ask_approval', {});
      facts = { customer: record('customers')?.value ?? null, order: record('orders')?.value ?? null, policy: record('policies')?.value ?? null, approval: results.find((r) => r.answer)?.answer ?? task.approval, evidence: results.filter((r) => r.collection) };
    } else {
      task = { customerId: input['task.customerId'], approval: input['approval.answer'] ?? 'yes' };
      facts = { customer: input['facts.customer'], order: input['facts.order'], policy: input['facts.policy'], approval: input['approval.answer'], evidence: input.evidence };
    }
    const contract = evidenceContract(task, facts);
    const output = referenceOutput(contract);
    return reply([{ type: 'text', text: JSON.stringify(output) }]);
  };
  call.model = 'local-fixture'; call.cacheKey = 'explicit-local-fixture';
  return call;
}

function options(args) {
  const out = { dry: false, mock: false, eveRuntime: false, limit: null, maxTurns: 8, maxTokens: 800, seed: 'evidence-v2', model: 'anthropic/claude-haiku-5.5' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry') out.dry = true;
    else if (args[i] === '--mock') out.mock = true;
    else if (args[i] === '--eve-runtime') out.eveRuntime = true;
    else if (['--limit', '--max-turns', '--max-tokens', '--seed', '--model'].includes(args[i])) {
      const key = { '--limit': 'limit', '--max-turns': 'maxTurns', '--max-tokens': 'maxTokens', '--seed': 'seed', '--model': 'model' }[args[i]];
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`missing ${args[i]} value`);
      out[key] = ['limit', 'maxTurns', 'maxTokens'].includes(key) ? Number(args[++i]) : args[++i];
    } else throw new Error(`unknown evidence argument ${args[i]}`);
  }
  for (const k of ['limit', 'maxTurns', 'maxTokens']) if (out[k] !== null && (!Number.isInteger(out[k]) || out[k] < 1 || out[k] > (k === 'maxTokens' ? 2000 : 20))) throw new Error(`invalid evidence ${k}`);
  return out;
}

export async function main(args = process.argv.slice(2)) {
  const opts = options(args), ledger = loadLedger(), spentStart = ledger.spent;
  const call = opts.mock ? fixtureModel() : opts.dry ? null : provider({ ledger, model: opts.model });
  if (!call && !opts.dry) throw new Error('No model API key; use --mock for local protocol validation or --dry for unresolved generation.');
  const tasks = [...evidenceTasks].slice(0, opts.limit ?? evidenceTasks.length).sort((a, b) => digest(`${opts.seed}:${a.id}`).localeCompare(digest(`${opts.seed}:${b.id}`)));
  const arms = ['wayfile', 'model_loop', ...(opts.eveRuntime ? ['eve_runtime'] : [])];
  const dir = join(root, 'bench/results', `${new Date().toISOString().replace(/[:.]/g, '-')}-evidence-v${evidenceContractVersion}-g${evidenceGraderVersion}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const name of ['requests.jsonl', 'cases.jsonl']) writeFileSync(join(dir, name), '');
  const source = sourceSnapshot(root);
  const config = { experimentVersion: 2, taskCorpusVersion: 1, outputContractVersion: evidenceContractVersion, graderVersion: evidenceGraderVersion, primaryMetric: 'factual/evidence contract: schema, structured facts, source IDs, observed reads/approval, bounded summary', proseFaithfulnessMeasured: false, summaryChecksScope: 'Summary bounds determine contract success; prose heuristics are diagnostics requiring semantic adjudication, never automatic wins/losses', arms, mock: opts.mock, dry: opts.dry, requestedModel: call?.model ?? opts.model, maxTurns: opts.maxTurns, maxTokensPerProviderRequest: opts.maxTokens, maxOutputValidationAttempts: 2, seed: opts.seed, taskHash: digest(tasks), labelsHash: digest(tasks.map((t) => ({ id: t.id, contract: evidenceContract(t, resolveEvidence(t)) }))), policyHash: digest(evidencePolicy), schemaHash: digest(evidenceOutputSchema), sourceHash: source.hash, costScope: 'provider account model charges; local processes and simulated approvals unpriced', applicationMemo: 'disabled', providerCache: 'observed; not controlled cold' };
  writeFileSync(join(dir, 'dataset.json'), JSON.stringify(tasks, null, 2));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ config, sourceFiles: source.files }, null, 2));
  let adapter, runtime, interrupted = null;
  const rows = [];
  try {
    if (opts.eveRuntime) { adapter = await import('./eve-runtime/adapter.mjs'); runtime = await adapter.startRuntime({ mock: opts.mock || opts.dry, allowPaid: !opts.mock && !opts.dry, model: opts.model, maxTokens: opts.maxTokens, maxTurns: opts.maxTurns, ledger, maxUsd: Number(process.env.WAYFILE_MAX_USD || 3), artifactDir: join(dir, 'eve-runtime') }); }
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i], row = { id: task.id, graph: 'evidence', family: task.id, expect: evidenceContract(task, resolveEvidence(task)).decision, critical: task.approval === 'no' || !resolveEvidence(task).order };
      const order = opts.dry ? ['wayfile', ...(opts.eveRuntime ? ['eve_runtime'] : [])] : [...arms.slice(i % arms.length), ...arms.slice(0, i % arms.length)];
      for (const arm of order) {
        const onEvent = (e) => appendFileSync(join(dir, 'requests.jsonl'), `${JSON.stringify({ ...e, caseId: task.id, arm })}\n`);
        if (arm === 'eve_runtime') {
          const start = performance.now(), raw = await adapter.runEvidenceCase(task, { runtime, mock: opts.mock || opts.dry, maxTokens: opts.maxTokens, onEvent });
          const result = { ...raw, output: raw.output ?? raw.text, ms: raw.ms ?? Math.round(performance.now() - start), wrapperMs: Math.round(performance.now() - start), observationComplete: !opts.mock && !opts.dry && raw.costMeasured && raw.modelQualityMeasured !== false };
          row[arm] = { ...result, ...scoreEvidenceTask(task, result) };
        } else row[arm] = await observeEvidenceTask(task, arm, { call, ledger, ...opts, onEvent });
        saveLedger(ledger);
        if (/cost guard|budget/i.test(row[arm].error || '')) { interrupted = row[arm].error; break; }
      }
      rows.push(row); appendFileSync(join(dir, 'cases.jsonl'), `${JSON.stringify(row)}\n`);
      if (interrupted) break;
    }
  } catch (error) { interrupted = String(error.message); }
  finally { if (runtime) await adapter.stopRuntime(runtime); saveLedger(ledger); }
  const requests = readFileSync(join(dir, 'requests.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const summary = Object.fromEntries(arms.map((arm) => [arm, opts.dry && arm === 'model_loop' ? null : summarize(rows, arm)]));
  const meta = { at: new Date().toISOString(), kind: 'generated-evidence', mock: opts.mock, modelQualityMeasured: !opts.mock && !opts.dry, paidModelCalls: opts.mock || opts.dry ? 0 : requests.filter((e) => e.providerCall !== false).length, config, configHash: digest(config), sourceChanged: sourceSnapshot(root).hash !== source.hash, spendDeltaUsd: ledger.spent - spentStart, spentCumulativeUsd: ledger.spent, unknownCost: Boolean(ledger.unknownCost), responseModels: Object.fromEntries([...new Set(requests.map((e) => e.model).filter(Boolean))].map((m) => [m, requests.filter((e) => e.model === m).length])), plannedN: tasks.length, n: rows.length, interrupted };
  const comparison = gate(summary, [evidenceGraph(opts.maxTokens)], { rows, arms, dry: opts.mock || opts.dry, subset: tasks.length !== evidenceTasks.length, interrupted: Boolean(interrupted), sourceChanged: meta.sourceChanged, provenanceComplete: requests.filter((e) => e.providerCall !== false).every((e) => Boolean(e.model)) && Boolean(call?.model) });
  comparison.primaryMetric = config.primaryMetric; comparison.proseFaithfulnessMeasured = false;
  comparison.scope = 'observed development factual/evidence contract only; model API cost; named fixture configurations; prose faithfulness unmeasured';
  const result = { meta, summary, gate: comparison, rows };
  const dollars = (n) => n === null || n === undefined ? 'unknown' : `$${n.toFixed(6)}`;
  const flagged = rows.flatMap((row) => arms.filter((arm) => row[arm]?.proseDiagnostics.some((check) => !check.passed)).map((arm) => `${row.id}/${arm}`));
  const report = [`# Generated-evidence experiment V${config.experimentVersion} (${meta.at})`, '', `Output contract V${config.outputContractVersion}; grader V${config.graderVersion}; same public task corpus V${config.taskCorpusVersion}. Original reports remain unchanged. Scores across grader versions are not interchangeable.`, '', `Measured metric: ${config.primaryMetric}. Prose faithfulness is unmeasured; heuristics are diagnostics requiring semantic adjudication.`, '', `Factual/evidence model quality measured: ${meta.modelQualityMeasured}. Requested model: ${config.requestedModel}. Actual responses: ${JSON.stringify(meta.responseModels)}. Common output cap: ${opts.maxTokens} tokens per provider request.`, '', '| arm | factual decision | factual/evidence contract success | model requests | measured API USD | USD/factual success incl. failed spend |', '|---|---|---|---|---|---|', ...arms.map((a) => summary[a] ? `| ${a} | ${summary[a].correct}/${summary[a].n} | ${summary[a].successes}/${summary[a].n} | ${summary[a].calls} | ${dollars(summary[a].usd)} | ${dollars(summary[a].usdPerSuccess)} |` : `| ${a} | unmeasured | | | | |`), '', `**Factual/evidence comparison: ${comparison.decision}. Actual Eve: ${comparison.realEveDecision}.**`, '', `Prose diagnostic flags requiring review: ${flagged.join(', ') || 'none'}. Unflagged prose is not certified faithful.`, '', `Per-run ledger delta: ${dollars(meta.spendDeltaUsd)}. Config hash: \`${meta.configHash}\`. Task/label/source hashes are in manifest.json.`, '', 'Four public development tasks; this is not unseen generalization. Mock results test protocol only. Payments never occur. Schema, structured facts/reason codes, source IDs, actual evidence reads/approval and summary bounds determine contract success. Prose heuristics never change automated wins/losses; independent semantic assessment is required for a prose-faithfulness claim. Grading costs, local compute, and human work are not priced.', ''].join('\n');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...meta, sourceFiles: source.files }, null, 2));
  writeFileSync(join(dir, 'report.json'), JSON.stringify(result, null, 2)); writeFileSync(join(dir, 'report.md'), report);
  console.log(`${report}\nArtifacts: ${relative(root, dir)}`);
  if (interrupted) process.exitCode = 2;
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch((e) => { console.error(e.message); process.exitCode = 2; });
