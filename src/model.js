// Model adapters. Token counts come only from the provider's response `usage` fields.
const PREAMBLE = 'You are a router. Pick exactly one target from the allowed enum. Reply with JSON {"target": "<id>"} only.';

export function graphIndex(graph) {
  return Object.values(graph.nodes).map((n) => `${n.id}: ${n.title}`).sort().join('\n');
}

// Stable prefix first (preamble, sorted index, node body); volatile state last.
export function judgePrompt(graph, node, state, targets) {
  const needs = Object.fromEntries(node.needs.map((k) => [k, k.split('.').reduce((o, p) => o?.[p], state)]));
  const questions = node.routes.filter((r) => r.type === 'judge').map((r) => `- ${r.src} → ${r.to}`).join('\n');
  return {
    system: `${PREAMBLE}\n\n# Graph\n${graphIndex(graph)}`,
    user: `# Node ${node.id}\n${node.body}\n\n## Questions\n${questions}\n\nAllowed targets: ${JSON.stringify(targets)}\n\n## State\n${JSON.stringify(needs)}`,
  };
}

const n0 = (x) => x ?? 0;

export function anthropic({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.WAYFILE_MODEL || 'claude-haiku-4-5' } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  return async ({ system, messages, tools, maxTokens = 256 }) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages, ...(tools ? { tools } : {}) }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(j.error || j)}`);
    const u = j.usage || {};
    return {
      content: j.content,
      text: j.content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
      stop: j.stop_reason,
      usage: { input: n0(u.input_tokens), output: n0(u.output_tokens), cacheRead: n0(u.cache_read_input_tokens), cacheWrite: n0(u.cache_creation_input_tokens), cost: null },
    };
  };
}

export function makeJudge(call) {
  return async (graph, node, state, targets) => {
    const p = judgePrompt(graph, node, state, targets);
    const r = await call({ system: p.system, messages: [{ role: 'user', content: p.user }], maxTokens: 400 }); // room for hidden reasoning (haiku-5.5 spent 30 tokens on it and returned no text)
    const m = r.text.match(/"target"\s*:\s*"([\w-]+)"/);
    const target = m && targets.includes(m[1]) ? m[1] : null;
    return { target, usage: r.usage };
  };
}

// OpenRouter (OpenAI-compatible). Takes and returns the same Anthropic-style shapes as `anthropic()`
// so callers don't change. Usage and real cost come from the response (`usage: {include: true}`).
// A spend ledger hard-stops the process once cumulative real cost passes `maxUsd`.
export function openrouter({ apiKey = process.env.OPENROUTER_API_KEY, model = process.env.WAYFILE_MODEL || 'anthropic/claude-haiku-5.5', maxUsd = Number(process.env.WAYFILE_MAX_USD || 3), ledger = { spent: 0 }, fetchFn = fetch } = {}) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  const toMessages = (system, messages) => [
    { role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] },
    ...messages.flatMap((m) => {
      if (typeof m.content === 'string') return [{ role: m.role, content: m.content }];
      if (m.role === 'assistant') {
        const calls = m.content.filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }));
        return [{ role: 'assistant', content: m.content.filter((c) => c.type === 'text').map((c) => c.text).join('') || null, ...(calls.length ? { tool_calls: calls } : {}) }];
      }
      return m.content.map((c) => ({ role: 'tool', tool_call_id: c.tool_use_id, content: c.content }));
    }),
  ];
  const call = async ({ system, messages, tools, maxTokens = 256 }) => {
    if (ledger.spent >= maxUsd) throw new Error(`cost guard: $${ledger.spent.toFixed(4)} spent ≥ $${maxUsd} limit`);
    const res = await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature: 0, usage: { include: true }, messages: toMessages(system, messages),
        ...(tools ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
      }),
    });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(`openrouter ${res.status}: ${JSON.stringify(j.error || j).slice(0, 300)}`);
    const u = j.usage || {};
    const d = u.prompt_tokens_details || {};
    const cacheRead = n0(d.cached_tokens), cacheWrite = n0(d.cache_write_tokens);
    if (typeof u.cost !== 'number') throw new Error('openrouter response has no usage.cost; refusing to run without the cost guard');
    ledger.spent += u.cost;
    ledger.models = { ...ledger.models, [j.model]: (ledger.models?.[j.model] || 0) + 1 }; // model reported per response
    const msg = j.choices[0].message;
    const content = [
      ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
      ...(msg.tool_calls || []).map((t) => ({ type: 'tool_use', id: t.id, name: t.function.name, input: JSON.parse(t.function.arguments || '{}') })),
    ];
    return {
      content, text: msg.content || '', stop: j.choices[0].finish_reason, model: j.model, provider: j.provider,
      // prompt_tokens includes cached reads/writes; `input` is the uncached part, as in Anthropic's usage.
      usage: { input: n0(u.prompt_tokens) - cacheRead - cacheWrite, output: n0(u.completion_tokens), cacheRead, cacheWrite, cost: u.cost },
    };
  };
  call.ledger = ledger;
  return call;
}

// Pick the provider from the environment. OpenRouter wins when both keys exist.
export function provider(opts = {}) {
  if (process.env.OPENROUTER_API_KEY) return openrouter(opts);
  if (process.env.ANTHROPIC_API_KEY) return anthropic(opts);
  return null;
}
