#!/usr/bin/env node
import { startRuntime, stopRuntime, runCase, runEvidenceCase } from './adapter.mjs';
import { REQUIRED_MODEL } from './meter.mjs';
import { dataset } from '../datasets.js';
import { scoreCase } from '../contracts.js';
import { loadLedger, saveLedger } from '../ledger.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (args.includes('--help')) {
  console.log('node bench/eve-runtime/run.js --mock [--dataset challenge|legacy|evidence] [--limit N]\nnode bench/eve-runtime/run.js --allow-paid --model anthropic/claude-haiku-5.5 --dataset challenge --limit 1 [--max-usd 3]');
  process.exit(0);
}
const allowed = new Set(['--mock', '--allow-paid', '--model', '--dataset', '--limit', '--max-usd', '--max-turns']);
for (const arg of args.filter((arg) => arg.startsWith('--'))) if (!allowed.has(arg)) throw new Error(`Unknown option ${arg}.`);
if (args.includes('--mock') && args.includes('--allow-paid')) throw new Error('Choose either --mock or --allow-paid.');
const mock = !args.includes('--allow-paid');
const name = option('--dataset', 'challenge');
const limit = option('--limit', null) === null ? null : Number(option('--limit'));
if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer.');
const model = option('--model', REQUIRED_MODEL);
const ledger = mock ? { spent: 0 } : loadLedger();
let cases;
if (name === 'evidence') cases = (await import('../evidence-tasks.js')).evidenceTasks;
else cases = dataset(name).cases;
if (limit !== null) {
  const counts = {};
  cases = cases.filter((c) => { const graph = c.graph || 'evidence'; counts[graph] = (counts[graph] || 0) + 1; return counts[graph] <= limit; });
}
const runtime = await startRuntime({ mock, allowPaid: !mock, model, ledger,
  maxUsd: Number(option('--max-usd', process.env.WAYFILE_MAX_USD || 3)), maxTurns: Number(option('--max-turns', 8)), maxTokens: name === 'evidence' ? 800 : 400 });
let failed = false;
try {
  for (const c of cases) {
    const result = name === 'evidence' ? await runEvidenceCase(c, { runtime, mock }) : await runCase(c, { runtime, mock });
    const score = name === 'evidence' ? null : scoreCase(c, result);
    if (!mock) saveLedger(ledger);
    failed ||= result.status !== 'completed';
    console.log(JSON.stringify({ id: c.id, graph: c.graph || 'evidence', ...result, ...(score ? { score } : {}) }));
  }
} finally { if (!mock) saveLedger(ledger); await stopRuntime(runtime); }
console.error(`${mock ? 'LOCAL PROTOCOL MOCK: model quality unmeasured' : 'ACTUAL EVE RUNTIME: measured provider traffic'}; artifacts ${runtime.artifactDir}`);
if (failed) process.exitCode = 1;
