#!/usr/bin/env node
import { readFileSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../src/parse.js';
import { check, format } from '../src/check.js';
import { explain, mermaid, edgeDiff } from '../src/explain.js';
import { provider, makeJudge, makeSkill } from '../src/model.js';
import { notifyAsk } from '../src/notify.js';
import { makeHarness } from '../src/harness.js';
import { createProjectTools } from '../src/tools.js';

const usage = `wayfile <command>

  init <dir>                       scaffold an agent graph
  check <dir>                      lint the graph (file:line: problem → fix)
  run <dir> --input <json|file>    run it; prints the end node, state, tokens and cost
  explain <dir> --input <json|file>  path taken and the line that decided each step
  mermaid <dir>                    graph as a Mermaid flowchart
  diff <dir> [git-ref]             routes added/removed since a git ref

Run options: --workspace <dir> sets the harness tool root (default: agent dir).
             --allow-write enables scoped file writes; --allow-shell enables host shell.

Model: OpenRouter via OPENROUTER_API_KEY, default anthropic/claude-haiku-5.5 (WAYFILE_MODEL to change).
Judges, skills and bounded harness nodes call the model. Invalid final outputs get at most one repair.
ask nodes need an explicit test response or WAYFILE_NOTIFY=live with NOTIFY_TOKEN.`;

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const inputArg = flag('--input');
const workspaceArg = flag('--workspace');
const booleanFlag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const allowWrite = booleanFlag('--allow-write');
const allowShell = booleanFlag('--allow-shell');
const [cmd, dir, arg] = args;
if (!cmd || cmd === 'help' || cmd === '--help' || !dir) { console.log(usage); process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0); }

if (cmd === 'init') {
  if (existsSync(dir) && readdirSync(dir).length) { console.error(`${dir} exists and is not empty`); process.exit(1); }
  const template = fileURLToPath(new URL('../templates/agent', import.meta.url));
  cpSync(template, dir, { recursive: true, filter: (source) => !relative(template, source).split(sep)
    .some((part) => ['.wayfile', 'runs', 'node_modules'].includes(part) || part === '.env' || part.startsWith('.env.')) });
  console.log(`created ${dir}\n\nnext:\n  wayfile check ${dir}\n  wayfile explain ${dir} --input ${join(dir, 'input.json')}`);
  process.exit(0);
}

const input = () => {
  const src = inputArg ?? arg;
  if (!src) { console.error('missing --input <json|file>'); process.exit(2); }
  return JSON.parse(src.trim().startsWith('{') ? src : readFileSync(src, 'utf8'));
};
const opts = () => {
  const call = provider();
  const tools = createProjectTools({ workspace: workspaceArg || dir, allowWrite, allowShell,
    authorize: allowShell ? ({ tool, node }) => node.meta.tools.includes(tool) : undefined });
  return {
    judge: call && makeJudge(call), skill: call && makeSkill(call), harness: call && makeHarness(call, { tools }),
    ask: process.env.WAYFILE_NOTIFY === 'live' ? notifyAsk() : undefined,
    cacheDir: join(dir, '.wayfile/cache'), traceDir: join(dir, 'runs'),
  };
};

try {
  const graph = loadGraph(dir);
  if (cmd === 'check') {
    const fs = await check(graph);
    fs.forEach((f) => console.log(format(f)));
    const errs = fs.filter((f) => f.level === 'error').length;
    console.log(`${Object.keys(graph.nodes).length} nodes, ${errs} errors, ${fs.length - errs} warnings`);
    process.exit(errs ? 1 : 0);
  } else if (cmd === 'run') {
    const errors = (await check(graph, { runExamples: false })).filter((f) => f.level === 'error');
    if (errors.length) throw new Error(`graph failed check:\n${errors.map(format).join('\n')}`);
    const { result: r } = await explain(graph, input(), opts());
    console.log(JSON.stringify({ status: r.status, end: r.end, state: r.state, calls: r.calls, toolCalls: r.steps.reduce((n, step) => n + (step.toolCalls || 0), 0), usage: r.usage, trace: r.trace }, null, 2));
  } else if (cmd === 'explain') {
    const errors = (await check(graph, { runExamples: false })).filter((f) => f.level === 'error');
    if (errors.length) throw new Error(`graph failed check:\n${errors.map(format).join('\n')}`);
    console.log((await explain(graph, input(), opts())).text);
  } else if (cmd === 'mermaid') {
    console.log(mermaid(graph));
  } else if (cmd === 'diff') {
    const d = edgeDiff(graph, arg);
    d.added.forEach((e) => console.log(`+ ${e}`));
    d.removed.forEach((e) => console.log(`- ${e}`));
    if (!d.added.length && !d.removed.length) console.log('no route changes');
  } else { console.log(usage); process.exit(2); }
} catch (e) {
  console.error(`wayfile: ${e.message}`);
  if (e.result) console.error(JSON.stringify({ status: e.result.status, calls: e.result.calls, usage: e.result.usage, trace: e.result.trace }));
  process.exit(1);
}
