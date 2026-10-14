// Two hand-written model-loop baselines. Neither executes the Eve framework.
//  bash:  ReAct loop. System prompt = the full written policy + a bash tool.
//  eve:   Eve-style. Always-on instructions + skill names/descriptions; skill bodies loaded on demand
//         through a `skill` tool (like eve__skill), plus bash. Mirrors VISION §1, not Eve's code.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRoute } from './contracts.js';

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
const APPROVAL = { name: 'ask_approval', description: 'Request the configured simulated human approval. Required before a refund over $500 or credential rotation. Returns yes or no; never assume approval.', input_schema: { type: 'object', properties: {}, additionalProperties: false } };

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

function tool(g, u, c) {
  if (u.name === 'skill') return { output: skills(g).find((s) => s.name === u.input.name)?.body ?? `no skill named ${u.input.name}`, evidence: { kind: 'skill-load', name: u.input.name } };
  if (u.name === 'ask_approval') {
    const answer = c.input.stub?.ask ?? 'yes';
    if (!['yes', 'no'].includes(answer)) throw new Error('invalid simulated approval answer');
    return { output: JSON.stringify({ answer, simulated: true }), evidence: { kind: 'approval', answer, simulated: true } };
  }
  if (u.name !== 'bash' || typeof u.input?.cmd !== 'string') throw new Error('invalid or unknown baseline tool');
  const p = spawnSync('bash', ['-c', String(u.input.cmd)], { cwd: SCRIPTS[g], encoding: 'utf8', timeout: 10000 });
  const stdout = p.stdout || '', stderr = p.stderr || '';
  const output = JSON.stringify({ exitCode: p.status, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000), truncated: stdout.length > 2000 || stderr.length > 2000, ...(p.error ? { error: p.error.message } : {}) });
  let set = {};
  try { if (p.status === 0) set = JSON.parse(stdout).set || {}; } catch { /* The model can also inspect ordinary files. */ }
  let kind = p.status === 0 && /(?:^|[ /])lookup-order\.sh\b/.test(u.input.cmd) && Object.hasOwn(set, 'order.status') ? 'order-lookup'
    : p.status === 0 && /(?:^|[ /])check-flaky\.sh\b/.test(u.input.cmd) && Object.hasOwn(set, 'test.flaky') ? 'flaky-lookup' : 'bash';
  if (p.status === 0 && /^\s*cat\s+(?:\.\/)?flaky\.txt\s*$/.test(u.input.cmd)) {
    const file = c.input.ci.log.match(/FAIL\s+([^\s]+)/)?.[1] ?? '';
    set = { 'test.file': file, 'test.flaky': stdout.trim().split(/\r?\n/).includes(file) };
    kind = 'flaky-lookup';
  }
  return { output, evidence: { kind, set, cmd: u.input.cmd, exitCode: p.status, truncated: stdout.length > 2000 || stderr.length > 2000 } };
}

export async function agent(kind, call, c, maxTurns = 8) {
  const g = c.graph;
  if (!['bash', 'eve', 'eve_sim'].includes(kind)) throw new Error(`unknown baseline ${kind}`);
  const simulatedEve = kind === 'eve' || kind === 'eve_sim';
  const system = simulatedEve ? eveSystem(g) : bashSystem(g);
  const tools = simulatedEve ? [SKILL, BASH, APPROVAL] : [BASH, APPROVAL];
  const messages = [{ role: 'user', content: `${g === 'triage' ? 'Ticket' : 'Failed CI job'}: ${JSON.stringify(c.input)}` }];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const evidence = [];
  let calls = 0;
  let invalidFinals = 0;
  try { for (let t = 0; t < maxTurns; t++) {
    const r = await call({ system, messages, tools, maxTokens: 400 });
    calls++;
    for (const k of Object.keys(usage)) usage[k] += r.usage[k] || 0;
    messages.push({ role: 'assistant', content: r.content });
    const uses = r.content.filter((x) => x.type === 'tool_use');
    if (!uses.length) {
      try { return { end: parseRoute(r.text, OUTCOMES[g], r.stop), calls, steps: calls, usage, evidence, toolCalls: evidence.length, status: 'completed', validationRepairs: invalidFinals }; }
      catch (e) {
        if (++invalidFinals >= 2) throw e;
        messages.push({ role: 'user', content: `The previous reply failed output validation: ${e.message}. Return only a complete JSON object with one allowed route and no extra text.` });
        continue;
      }
    }
    messages.push({ role: 'user', content: uses.map((u) => {
      const result = tool(g, u, c);
      evidence.push(result.evidence);
      return { type: 'tool_result', tool_use_id: u.id, content: result.output };
    }) });
  } } catch (e) { e.partial = { calls, steps: calls, usage, evidence, toolCalls: evidence.length }; throw e; }
  return { end: null, calls, steps: calls, usage, evidence, toolCalls: evidence.length, status: 'failed', error: `baseline exceeded ${maxTurns} model turns` };
}
