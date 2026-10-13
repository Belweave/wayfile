#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph } from '../src/parse.js';
import { check, format } from '../src/check.js';
import { explain, mermaid, edgeDiff } from '../src/explain.js';
import { anthropic, makeJudge } from '../src/model.js';
import { notifyAsk } from '../src/notify.js';

const [cmd, dir, arg] = process.argv.slice(2);
const usage = `usage:
  wayfile check <dir>
  wayfile run <dir> <input.json | '{json}'>      (judge forks need ANTHROPIC_API_KEY)
  wayfile explain <dir> <input.json | '{json}'>
  wayfile mermaid <dir>
  wayfile diff <dir> [git-ref]`;
if (!cmd || !dir) { console.error(usage); process.exit(2); }
const graph = loadGraph(dir);
const input = () => JSON.parse(arg.trim().startsWith('{') ? arg : readFileSync(arg, 'utf8'));
const judge = () => (process.env.ANTHROPIC_API_KEY ? makeJudge(anthropic()) : null);
// ask nodes stay stubbed unless WAYFILE_NOTIFY=live (real phone prompt).
const opts = () => ({ judge: judge(), ask: process.env.WAYFILE_NOTIFY === 'live' ? notifyAsk() : undefined, cacheDir: join(dir, '.wayfile/cache'), traceDir: join(dir, 'runs') });

if (cmd === 'check') {
  const fs = await check(graph);
  fs.forEach((f) => console.log(format(f)));
  const errs = fs.filter((f) => f.level === 'error').length;
  console.log(`${Object.keys(graph.nodes).length} nodes, ${errs} errors, ${fs.length - errs} warnings`);
  process.exit(errs ? 1 : 0);
} else if (cmd === 'run') {
  const { result } = await explain(graph, input(), opts());
  console.log(JSON.stringify({ end: result.end, calls: result.calls, usage: result.usage, trace: result.trace }, null, 2));
} else if (cmd === 'explain') {
  console.log((await explain(graph, input(), opts())).text);
} else if (cmd === 'mermaid') {
  console.log(mermaid(graph));
} else if (cmd === 'diff') {
  const d = edgeDiff(graph, arg);
  d.added.forEach((e) => console.log(`+ ${e}`));
  d.removed.forEach((e) => console.log(`- ${e}`));
  if (!d.added.length && !d.removed.length) console.log('no route changes');
} else { console.error(usage); process.exit(2); }
