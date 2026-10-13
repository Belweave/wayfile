// Two baselines over the same cases; the model chooses every step in both.
//  bash:  ReAct loop. System prompt = the full written policy + a bash tool.
//  eve:   Eve-style. Always-on instructions + skill names/descriptions; skill bodies loaded on demand
//         through a `skill` tool (like eve__skill), plus bash. Mirrors VISION §1, not Eve's code.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const here = (p) => new URL(p, import.meta.url).pathname;
export const SCRIPTS = { triage: resolve(here('../examples/triage/scripts')), ci: resolve(here('../examples/ci/scripts')) };
export const OUTCOMES = {
  triage: ['refund', 'general-reply', 'account-help', 'bug-intake'],
  ci: ['rotate-secret', 'retry-job', 'fix-deps', 'autofix-lint', 'quarantine-test', 'fix-code', 'human-triage'],
};
const TOOLS_NOTE = {
  triage: 'Working dir has ./lookup-order.sh: pipe state JSON to it, e.g. echo \'{"ticket":{"body":"refund order 12"}}\' | ./lookup-order.sh, and it prints {"set":{"order.status":"delivered|shipped|not_found"}}.',
  ci: 'Working dir has flaky.txt (the known-flaky test list) and ./check-flaky.sh: pipe state JSON to it, e.g. echo \'{"ci":{"log":"FAIL x.test.ts"}}\' | ./check-flaky.sh.',
};
const FINAL = (g) => `When done, reply with only JSON {"route": "<one of ${OUTCOMES[g].join('|')}>"}.`;
const BASH = { name: 'bash', description: 'Run a bash command in the tools dir; returns stdout+stderr (max 2000 chars).', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } };
const SKILL = { name: 'skill', description: 'Load the full instructions of a skill by name.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } };

export function skills(g) {
  const dir = here(`./eve/${g}/skills`);
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const t = readFileSync(`${dir}/${f}`, 'utf8');
    return { name: f.replace(/\.md$/, ''), description: t.match(/^description:\s*(.+)$/m)[1], body: t.replace(/^---[\s\S]*?---\n/, '') };
  });
}

export function bashSystem(g) {
  return `${readFileSync(here(`./policy/${g === 'triage' ? 'tickets' : 'ci'}.md`), 'utf8')}\nYou have a bash tool. ${TOOLS_NOTE[g]}\n${FINAL(g)}`;
}
export function eveSystem(g) {
  const list = skills(g).map((s) => `- ${s.name}: ${s.description}`).join('\n');
  return `${readFileSync(here(`./eve/${g}/instructions.md`), 'utf8')}\n## Skills (load with the skill tool when relevant)\n${list}\n\nYou have a bash tool. ${TOOLS_NOTE[g]}\n${FINAL(g)}`;
}

function tool(g, u) {
  if (u.name === 'skill') return skills(g).find((s) => s.name === u.input.name)?.body ?? `no skill named ${u.input.name}`;
  const p = spawnSync('bash', ['-c', String(u.input.cmd)], { cwd: SCRIPTS[g], encoding: 'utf8', timeout: 10000 });
  return ((p.stdout || '') + (p.stderr || '')).slice(0, 2000) || '(no output)';
}

export async function agent(kind, call, c, maxTurns = 8) {
  const g = c.graph;
  const system = kind === 'eve' ? eveSystem(g) : bashSystem(g);
  const tools = kind === 'eve' ? [SKILL, BASH] : [BASH];
  const messages = [{ role: 'user', content: `${g === 'triage' ? 'Ticket' : 'Failed CI job'}: ${JSON.stringify(c.input)}` }];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let calls = 0;
  for (let t = 0; t < maxTurns; t++) {
    const r = await call({ system, messages, tools, maxTokens: 400 });
    calls++;
    for (const k of Object.keys(usage)) usage[k] += r.usage[k];
    messages.push({ role: 'assistant', content: r.content });
    const uses = r.content.filter((x) => x.type === 'tool_use');
    if (!uses.length) return { end: r.text.match(/"route"\s*:\s*"([\w-]+)"/)?.[1] ?? null, calls, steps: calls, usage };
    messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: tool(g, u) })) });
  }
  return { end: null, calls, steps: calls, usage };
}
