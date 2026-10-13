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
      usage: { input: n0(u.input_tokens), output: n0(u.output_tokens), cacheRead: n0(u.cache_read_input_tokens), cacheWrite: n0(u.cache_creation_input_tokens) },
    };
  };
}

export function makeJudge(call) {
  return async (graph, node, state, targets) => {
    const p = judgePrompt(graph, node, state, targets);
    const r = await call({ system: p.system, messages: [{ role: 'user', content: p.user }], maxTokens: 30 });
    const m = r.text.match(/"target"\s*:\s*"([\w-]+)"/);
    const target = m && targets.includes(m[1]) ? m[1] : null;
    return { target, usage: r.usage };
  };
}
