import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'eve/client';
import { REQUIRED_MODEL, measureRequests, startMeter } from './meter.mjs';
import { assertEvidenceReplySchema } from './schema-check.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUTCOMES = { triage: ['refund', 'general-reply', 'account-help', 'bug-intake'], ci: ['rotate-secret', 'retry-job', 'fix-deps', 'autofix-lint', 'quarantine-test', 'fix-code', 'human-triage'] };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeName = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

function fixtureHash(settings) {
  const files = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.eve', '.output', 'artifacts'].includes(item.name)) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else if (/\.(json|mjs|ts|md)$/.test(item.name)) files.push([path.slice(ROOT.length + 1), readFileSync(path, 'utf8')]);
    }
  };
  walk(ROOT);
  // These authored modules supply the third fixture's policy and records.
  for (const name of ['evidence-policy.js', 'evidence-tasks.js']) {
    try { files.push([`../${name}`, readFileSync(join(ROOT, '..', name), 'utf8')]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return digest([settings, files.sort(([a], [b]) => a.localeCompare(b))]);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const kill = (signal) => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50);
  if (child.exitCode === null && child.signalCode === null) kill('SIGKILL');
}

async function bootServer(runtime, graph) {
  if (!['triage', 'ci', 'evidence'].includes(graph)) throw new Error(`Unknown Eve fixture graph ${graph}.`);
  const port = await freePort();
  const log = join(runtime.artifactDir, `${graph}-server.log`);
  const mockJournal = join(runtime.artifactDir, `${graph}-mock.jsonl`);
  writeFileSync(mockJournal, '');
  const env = { ...process.env,
    EVE_BENCH_MODE: runtime.mock ? 'mock' : 'openrouter',
    EVE_BENCH_ALLOW_PAID: runtime.mock ? '' : '1',
    EVE_BENCH_MODEL: runtime.settings.model,
    EVE_BENCH_PROVIDER_URL: runtime.meter?.url || '',
    EVE_BENCH_MOCK_JOURNAL: runtime.mock ? mockJournal : '',
    NODE_ENV: 'development',
  };
  // Secrets stay in the metering process. The child has only a loopback URL.
  for (const key of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'NOTIFY_TOKEN', 'EVE_MOCK_AUTHORED_MODELS']) delete env[key];
  const child = spawn(process.execPath, [join(ROOT, 'node_modules/eve/bin/eve.js'), 'dev', '--host', '127.0.0.1', '--port', String(port), '--no-ui', '--no-default-extensions'], {
    cwd: join(ROOT, 'fixtures', graph), env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => appendFileSync(log, data));
  child.stderr.on('data', (data) => appendFileSync(log, data));
  let childError;
  child.on('error', (error) => { childError = error; });
  const host = `http://127.0.0.1:${port}`;
  const started = performance.now();
  try {
    const deadline = Date.now() + (runtime.opts.bootTimeoutMs || 90000);
    while (Date.now() < deadline) {
      if (childError) throw childError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Eve ${graph} server exited; see ${log}.`);
      try {
        const health = await fetch(`${host}/eve/v1/health`, { signal: AbortSignal.timeout(1000) });
        if (health.ok && (await health.json()).status === 'ready') {
          const client = new Client({ host });
          const info = await client.info();
          return { graph, host, client, child, log, mockJournal, info, bootMs: Math.round(performance.now() - started) };
        }
      } catch { /* Await readiness; this does not invoke a model. */ }
      await delay(250);
    }
    throw new Error(`Eve ${graph} boot timed out; see ${log}.`);
  } catch (error) { await stopChild(child); throw error; }
}

export async function startRuntime(opts = {}) {
  const mock = opts.mock !== false;
  if (!mock && !opts.allowPaid) throw new Error('Real model traffic requires allowPaid:true (CLI --allow-paid).');
  const model = opts.model || REQUIRED_MODEL;
  if (model !== REQUIRED_MODEL) throw new Error(`The authorized comparison model is ${REQUIRED_MODEL}.`);
  const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules/eve/package.json'), 'utf8')).version;
  if (installed !== '0.79.0') throw new Error(`Expected Eve 0.79.0; installed ${installed}. Run npm ci --ignore-scripts in bench/eve-runtime.`);
  const providerVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules/@ai-sdk/openai-compatible/package.json'), 'utf8')).version;
  if (providerVersion !== '3.0.68') throw new Error(`Expected OpenAI-compatible provider 3.0.68; installed ${providerVersion}.`);
  const artifactDir = resolve(opts.artifactDir || join(ROOT, 'artifacts', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`));
  mkdirSync(artifactDir, { recursive: true });
  const settings = { eveVersion: installed, providerPackageVersion: '3.0.68', model,
    temperature: 0, maxTokens: opts.maxTokens || 400, maxCalls: opts.maxCalls || opts.maxTurns || 8,
    profile: 'task-tuned typed tools; optional skills; defaultTools:false', mock,
    reasoning: 'provider-default', nativeValidation: true, nativeRetryPolicy: 'Eve defaults; every transport invocation metered', };
  const runtime = { opts, settings, mock, transportTest: Boolean(opts.providerFetch), artifactDir, servers: new Map(), busy: false, closed: false, currentOnEvent: null };
  runtime.configHash = fixtureHash(settings);
  if (!mock) runtime.meter = await startMeter({
    apiKey: opts.apiKey || process.env.OPENROUTER_API_KEY, ledger: opts.ledger || { spent: 0 }, maxUsd: opts.maxUsd ?? 3,
    model, maxCalls: settings.maxCalls, maxTokens: settings.maxTokens, journal: join(artifactDir, 'provider-requests.jsonl'),
    ...(opts.providerFetch ? { fetchFn: opts.providerFetch } : {}),
    onEvent: (event) => { (runtime.currentOnEvent || opts.onEvent)?.(event); },
  });
  runtime.ensureServer = async (graph) => {
    if (runtime.closed) throw new Error('Eve runtime is closed.');
    if (!runtime.servers.has(graph)) runtime.servers.set(graph, await bootServer(runtime, graph));
    return runtime.servers.get(graph);
  };
  writeFileSync(join(artifactDir, 'runtime.json'), JSON.stringify({ ...settings, configHash: runtime.configHash, nodeVersion: process.version }, null, 2));
  return runtime;
}

export async function stopRuntime(runtime) {
  if (!runtime || runtime.closed) return;
  runtime.closed = true;
  for (const server of runtime.servers.values()) await stopChild(server.child);
  await runtime.meter?.stop();
}

function observedEvidence(events) {
  return events.flatMap((event) => {
    if (event.type !== 'action.result' || event.data.status !== 'completed') return [];
    const result = event.data.result;
    if (result.kind === 'load-skill-result') return [{ kind: 'skill-load', name: result.name }];
    const output = result.output;
    if (!output || typeof output !== 'object') return [];
    if (['order-lookup', 'flaky-lookup', 'approval', 'record-read'].includes(output.kind)) return [{ ...output, toolName: result.toolName, callId: result.callId, at: event.meta.at }];
    return [];
  });
}

async function executeCase(c, opts, outputSchema, accept) {
  const owned = !opts.runtime;
  const runtime = opts.runtime || await startRuntime(opts);
  if (runtime.busy) throw new Error('Real Eve benchmark cases must run sequentially.');
  if (opts.mock !== undefined && opts.mock !== runtime.mock) throw new Error('Case mock mode differs from its runtime.');
  runtime.busy = true; runtime.currentOnEvent = opts.onEvent || null;
  const id = c.id || randomUUID();
  const events = [];
  let server, session, sessionId, error, start, data;
  let requestStart = runtime.meter?.requests.length ?? 0;
  let mockOffset = 0;
  try {
    server = await runtime.ensureServer(c.graph);
    mockOffset = readFileSync(server.mockJournal, 'utf8').split('\n').filter(Boolean).length;
    runtime.meter?.beginCase({ caseId: id, id, graph: c.graph, arm: 'eve_runtime', maxTokens: opts.maxTokens || runtime.settings.maxTokens });
    start = performance.now();
    const created = await server.client.sessions.create({ message: JSON.stringify({ fixture: 'wayfile-routing-v1', input: c.input }), outputSchema,
      signal: AbortSignal.timeout(opts.timeoutMs || runtime.opts.timeoutMs || 90000) });
    session = created.session;
    sessionId = created.response.sessionId;
    for await (const event of created.response) {
      events.push(event);
      if (event.type === 'result.completed') data = event.data.result;
    }
    if (!events.some((event) => event.type === 'turn.completed')) throw new Error(events.find((event) => event.type === 'turn.failed' || event.type === 'session.failed')?.data.message || 'Eve turn did not complete.');
    accept(data);
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  finally {
    // Reset stops only this fresh fixture session; it performs no model calls.
    if (session) try { await session.reset({ reason: 'Independent benchmark case complete' }); } catch (cause) { error ||= `Session cleanup failed: ${cause.message}`; }
    await runtime.meter?.endCase();
    runtime.busy = false; runtime.currentOnEvent = null;
  }
  const steps = events.filter((event) => event.type === 'step.completed');
  let requests = runtime.meter?.requests.slice(requestStart) || [];
  if (runtime.mock && server) {
    requests = readFileSync(server.mockJournal, 'utf8').split('\n').filter(Boolean).slice(mockOffset).map((line, index) => {
      const record = JSON.parse(line), usage = steps[index]?.data.usage;
      return { ...record, caseId: id, id, graph: c.graph, arm: 'eve_runtime', ordinal: index + 1,
        requestedModel: record.model, responseId: null,
        usage: { input: usage?.inputTokens || 0, output: usage?.outputTokens || 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        rawUsage: usage || null, measuredCost: 0, costMeasured: true, tokensMeasured: false, mock: true };
    });
    for (const request of requests) (opts.onEvent || runtime.opts.onEvent)?.(request);
  }
  const measurement = measureRequests(requests);
  const sourceChanged = fixtureHash(runtime.settings) !== runtime.configHash;
  const artifact = join(runtime.artifactDir, `${safeName(c.graph)}-${safeName(id)}-${randomUUID().slice(0, 8)}.json`);
  const result = { ...measurement, status: error ? 'failed' : 'completed', end: error ? null : data?.route ?? null,
    output: data, text: data === undefined ? null : JSON.stringify(data), error,
    evidence: observedEvidence(events), toolCalls: events.filter((event) => event.type === 'action.result').length,
    steps: steps.length, requests, mock: runtime.mock, transportTest: runtime.transportTest, modelQualityMeasured: !runtime.mock && !runtime.transportTest,
    observationComplete: Boolean(server && session && events.some((event) => event.type === 'session.waiting' || event.type === 'session.failed') && !sourceChanged && (runtime.mock || requests.length > 0)),
    ms: start === undefined ? 0 : Math.round(performance.now() - start), bootMs: server?.bootMs || 0,
    provenance: { kind: 'eve-runtime', eveVersion: '0.79.0', providerPackageVersion: '3.0.68', configHash: runtime.configHash,
      artifact, sessionId: sessionId || null,
      mock: runtime.mock, transportTest: runtime.transportTest, sourceChanged, settings: { ...runtime.settings, maxTokens: opts.maxTokens || runtime.settings.maxTokens },
      configurationDifferences: ['Eve native structured-output validation and transient retries; capped at eight actual provider requests by default.'],
      unpricedCategories: ['local process/infrastructure', 'human labor', 'tool compute'], }, };
  writeFileSync(artifact, JSON.stringify({ result, events, agentInfo: server?.info }, null, 2));
  if (owned) await stopRuntime(runtime);
  return result;
}

export async function runCase(c, opts = {}) {
  if (c.graph === 'evidence') return runEvidenceCase(c, opts);
  const outcomes = OUTCOMES[c.graph];
  if (!outcomes) throw new Error(`Unknown routing domain ${c.graph}.`);
  return executeCase(c, opts, { type: 'object', properties: { route: { type: 'string', enum: outcomes } }, required: ['route'], additionalProperties: false }, (data) => {
    if (!data || Object.keys(data).length !== 1 || !outcomes.includes(data.route)) throw new Error('No valid structured route result.');
  });
}

export async function runEvidenceCase(task, opts = {}) {
  const { evidenceOutputSchema } = await import('../evidence-policy.js');
  assertEvidenceReplySchema(evidenceOutputSchema);
  const source = task.input || task;
  const input = { customerId: source.customerId, approval: source.approval, prompt: source.prompt };
  return executeCase({ id: task.id, graph: 'evidence', input }, opts, evidenceOutputSchema, (data) => {
    if (!data || typeof data !== 'object') throw new Error('No structured evidence-task result.');
  });
}
