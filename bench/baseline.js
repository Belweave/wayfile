// ReAct/bash baseline: one prompt with the policy in prose, a bash tool, loop until a final route.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPTS = resolve(new URL('../examples/triage/scripts', import.meta.url).pathname);
export const SYSTEM = `You are a support triage agent with a bash tool. Working dir has ./lookup-order.sh, which reads JSON state on stdin
(e.g. echo '{"ticket":{"body":"refund order 12"}}' | ./lookup-order.sh) and prints {"set":{"order.status":...}}.
Policy: refund/chargeback tickets: if amount > 500 a human must approve (assume approved); then look up the order;
if order.status is not_found → general-reply, else → refund. Password/login/2FA → account-help.
Bug reports with steps to reproduce → bug-intake. Anything else → general-reply.
When done, reply with only JSON {"route": "<refund|general-reply|account-help|bug-intake>"}.`;
const TOOLS = [{ name: 'bash', description: 'Run a bash command; returns stdout+stderr (truncated to 2000 chars).', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }];

export async function baseline(call, input, maxTurns = 8) {
  const messages = [{ role: 'user', content: `Ticket: ${JSON.stringify(input.ticket)}` }];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let calls = 0;
  for (let t = 0; t < maxTurns; t++) {
    const r = await call({ system: SYSTEM, messages, tools: TOOLS, maxTokens: 400 });
    calls++;
    for (const k of Object.keys(usage)) usage[k] += r.usage[k];
    messages.push({ role: 'assistant', content: r.content });
    const uses = r.content.filter((c) => c.type === 'tool_use');
    if (!uses.length) return { end: r.text.match(/"route"\s*:\s*"([\w-]+)"/)?.[1] ?? null, calls, usage };
    messages.push({ role: 'user', content: uses.map((u) => {
      const p = spawnSync('bash', ['-c', String(u.input.cmd)], { cwd: SCRIPTS, encoding: 'utf8', timeout: 10000 });
      return { type: 'tool_result', tool_use_id: u.id, content: ((p.stdout || '') + (p.stderr || '')).slice(0, 2000) || '(no output)' };
    }) });
  }
  return { end: null, calls, usage };
}
