// A request journal sits outside the agent loop so failed tasks retain paid calls.
import { createHash } from 'node:crypto';

export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const money = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite'];

export function requestRecorder(call, { ledger, context = {}, onEvent } = {}) {
  const events = [];
  const wrapped = async (req) => {
    const before = ledger?.spent;
    const started = performance.now();
    const event = { ...context, ordinal: events.length + 1, at: new Date().toISOString(), requestHash: digest(req), requestedModel: req.model ?? call.model ?? null, maxTokens: req.maxTokens ?? null };
    let response, failure;
    try { response = await call(req); return response; }
    catch (e) { failure = e; throw e; }
    finally {
      const u = response?.usage ?? failure?.usage ?? null;
      // A provider can charge a response and then fail to decode it. A positive
      // ledger delta recovers that spend even if its token fields were lost.
      const delta = money(before) && money(ledger?.spent) ? ledger.spent - before : null;
      const measuredCost = money(u?.cost) ? u.cost : delta > 0 ? delta : null;
      Object.assign(event, {
        providerCall: failure?.calls !== 0,
        status: failure ? 'error' : 'returned', ms: Math.round(performance.now() - started),
        model: response?.model ?? failure?.model ?? null,
        provider: response?.provider ?? failure?.provider ?? null,
        responseId: response?.id ?? failure?.id ?? failure?.responseId ?? null,
        stop: response?.stop ?? null, usage: u,
        responseContent: response?.content ?? (response?.text !== undefined ? response.text : null),
        rawUsage: response?.rawUsage ?? failure?.rawUsage ?? null,
        measuredCost, costMeasured: measuredCost !== null,
        tokensMeasured: Boolean(u && tokenKeys.every((k) => Number.isFinite(u[k]) && u[k] >= 0)),
        ...(failure ? { error: String(failure.message).slice(0, 300) } : {}),
      });
      events.push(event);
      onEvent?.(event);
    }
  };
  wrapped.model = call.model;
  wrapped.cacheKey = call.cacheKey;
  return { call: wrapped, events, measurement: () => measureEvents(events) };
}

export function measureEvents(events) {
  const usage = zeroUsage();
  for (const e of events) {
    for (const k of tokenKeys) if (Number.isFinite(e.usage?.[k]) && e.usage[k] >= 0) usage[k] += e.usage[k];
    if (e.costMeasured) usage.cost += e.measuredCost;
  }
  const costMeasured = events.every((e) => e.costMeasured);
  return {
    calls: events.filter((e) => e.providerCall !== false).length, usage, costMeasured,
    usd: costMeasured ? usage.cost : null,
    knownUsd: usage.cost,
    tokensMeasured: events.every((e) => e.tokensMeasured),
    unknownCostCalls: events.filter((e) => !e.costMeasured).length,
    models: Object.fromEntries([...new Set(events.map((e) => e.model).filter(Boolean))].sort().map((m) => [m, events.filter((e) => e.model === m).length])),
    providers: Object.fromEntries([...new Set(events.map((e) => e.provider).filter(Boolean))].sort().map((p) => [p, events.filter((e) => e.provider === p).length])),
  };
}
