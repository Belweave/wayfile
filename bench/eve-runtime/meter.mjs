import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

export const REQUIRED_MODEL = 'anthropic/claude-haiku-5.5';
const money = (value) => Number.isFinite(value) && value >= 0;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function normalizeOpenRouterUsage(raw) {
  if (!raw || !money(raw.prompt_tokens) || !money(raw.completion_tokens)) return null;
  const read = raw.prompt_tokens_details?.cached_tokens ?? 0;
  const write = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
  if (!money(read) || !money(write) || raw.prompt_tokens < read + write) return null;
  return { input: raw.prompt_tokens - read - write, output: raw.completion_tokens, cacheRead: read, cacheWrite: write, cost: money(raw.cost) ? raw.cost : null };
}

// Read only provider records; this proxy does not choose tools or agent steps.
export function providerRecords(text, contentType) {
  if (!contentType.includes('text/event-stream')) {
    try { return [JSON.parse(text)]; } catch { return []; }
  }
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('data:')) return [];
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') return [];
    try { return [JSON.parse(value)]; } catch { return []; }
  });
}

export function measureRequests(requests) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const request of requests) {
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) if (money(request.usage?.[key])) usage[key] += request.usage[key];
    if (request.costMeasured) usage.cost += request.measuredCost;
  }
  const count = (key) => Object.fromEntries([...new Set(requests.map((r) => r[key]).filter(Boolean))].map((value) => [value, requests.filter((r) => r[key] === value).length]));
  const costMeasured = requests.every((r) => r.costMeasured);
  return { calls: requests.length, usage, costMeasured, usd: costMeasured ? usage.cost : null, knownUsd: usage.cost,
    tokensMeasured: requests.every((r) => r.tokensMeasured), unknownCostCalls: requests.filter((r) => !r.costMeasured).length,
    models: count('model'), providers: count('provider') };
}

export async function startMeter({ apiKey, ledger = { spent: 0 }, maxUsd = 3, maxCalls = 8, maxTokens = 400,
  model = REQUIRED_MODEL, onEvent, journal, fetchFn = fetch, upstream = 'https://openrouter.ai/api/v1/chat/completions', timeoutMs = 30000 } = {}) {
  if (!apiKey) throw new Error('An OpenRouter key is required for the paid runtime meter.');
  if (model !== REQUIRED_MODEL) throw new Error(`This experiment requires ${REQUIRED_MODEL}.`);
  if (!money(ledger.spent) || !money(maxUsd) || maxUsd === 0) throw new Error('A finite positive shared budget and nonnegative ledger are required.');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('maxCalls/maxTokens must be positive integers.');
  const requests = [];
  let currentCase = null, pending = 0, stopped = false;
  const server = createServer(async (request, response) => {
    const reject = (status, message) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message, type: 'benchmark_guard' } })); };
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return reject(404, 'Unknown meter route.');
    if (request.headers.authorization !== 'Bearer local-meter-only') return reject(401, 'Missing local meter authorization.');
    if (stopped || !currentCase) return reject(409, 'No active benchmark case.');
    if (pending) return reject(409, 'The benchmark permits one provider request at a time.');
    if (ledger.spent >= maxUsd || ledger.unknownCost || currentCase.calls >= maxCalls || currentCase.unpriced) return reject(403, 'Benchmark budget/call/unknown-cost guard reached.');
    // Claim the slot before awaiting the body so concurrent requests cannot race.
    pending++;
    const context = currentCase;
    let original;
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 2_000_000) throw new Error('Model request exceeded the fixture body bound.'); }
      original = JSON.parse(body);
    } catch (error) { pending--; return reject(400, error.message); }
    // Match the existing Wayfile arm's settings at the provider boundary.
    const effectiveMaxTokens = context.context.maxTokens ?? maxTokens;
    const effective = { ...original, model, temperature: 0, max_tokens: effectiveMaxTokens, usage: { include: true } };
    delete effective.max_completion_tokens;
    if (effective.stream) effective.stream_options = { ...effective.stream_options, include_usage: true };
    effective.messages = (effective.messages || []).map((message) => message.role === 'system' && typeof message.content === 'string'
      ? { ...message, content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }] } : message);
    const replySchema = effective.tools?.find((tool) => tool.function?.name === 'eve__reply')?.function?.parameters || null;
    const event = { ...context.context, at: new Date().toISOString(), ordinal: requests.length + 1,
      requestedModel: model, requestHash: hash(effective), maxTokens: effectiveMaxTokens, temperature: 0, stream: Boolean(effective.stream), transport: 'openrouter', mock: false,
      toolSchemas: (effective.tools || []).map((tool) => ({ name: tool.function?.name, parameters: tool.function?.parameters })),
      responseFormat: effective.response_format || null, outputSchema: replySchema, outputSchemaHash: replySchema ? hash(replySchema) : null };
    const started = performance.now();
    let raw = '', contentType = '', status = 'error', httpStatus = null, failure;
    const decoder = new TextDecoder();
    context.calls++;
    try {
      const upstreamResponse = await fetchFn(upstream, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(effective), signal: AbortSignal.timeout(timeoutMs) });
      httpStatus = upstreamResponse.status;
      contentType = upstreamResponse.headers.get('content-type') || 'application/json';
      response.writeHead(upstreamResponse.status, { 'content-type': contentType, 'cache-control': 'no-store' });
      if (upstreamResponse.body) for await (const chunk of upstreamResponse.body) {
        raw += decoder.decode(chunk, { stream: true });
        if (raw.length > 8_000_000) throw new Error('Provider response exceeded the fixture recording bound.');
        if (!response.destroyed) response.write(chunk);
      }
      status = upstreamResponse.ok ? 'returned' : 'error';
    } catch (error) {
      failure = error;
      if (!response.headersSent) reject(502, `Meter provider transport failed: ${error.message}`);
      else response.destroy(error);
    } finally {
      raw += decoder.decode();
      const records = providerRecords(raw, contentType);
      const usageRecord = [...records].reverse().find((record) => record.usage);
      const rawUsage = usageRecord?.usage ?? null;
      const usage = normalizeOpenRouterUsage(rawUsage);
      const field = (key) => records.find((record) => record[key] !== undefined)?.[key] ?? null;
      const measuredCost = money(rawUsage?.cost) ? rawUsage.cost : null;
      const providerError = records.find((record) => record.error)?.error;
      if (measuredCost !== null) ledger.spent += measuredCost;
      else { context.unpriced = true; ledger.unknownCost = true; } // Sticky across cases and arms.
      const responseModel = field('model');
      if (responseModel) ledger.models = { ...ledger.models, [responseModel]: (ledger.models?.[responseModel] || 0) + 1 };
      Object.assign(event, { status: failure || providerError ? 'error' : status, httpStatus, ms: Math.round(performance.now() - started),
        model: responseModel, provider: field('provider'), responseId: field('id'), rawUsage, usage,
        responseContent: records, measuredCost, costMeasured: measuredCost !== null, tokensMeasured: usage !== null,
        ...(failure || providerError ? { error: String(failure?.message || providerError?.message || providerError).slice(0, 400) } : {}) });
      requests.push(event);
      try { if (journal) appendFileSync(journal, `${JSON.stringify(event)}\n`); onEvent?.(event); }
      finally { pending--; if (!response.destroyed) response.end(); }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, requests,
    beginCase(context) {
      if (pending || currentCase) throw new Error('Only one case may use the meter.');
      if (context.maxTokens !== undefined && (!Number.isSafeInteger(context.maxTokens) || context.maxTokens < 1)) throw new Error('Case maxTokens must be a positive integer.');
      currentCase = { context, calls: 0, unpriced: false };
    },
    async endCase() { while (pending) await new Promise((resolve) => setTimeout(resolve, 10)); currentCase = null; },
    async stop() { stopped = true; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
