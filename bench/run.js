// Day-10 benchmark. Usage: node bench/run.js [--dry]
// --dry runs wayfile with no model: measures how many tickets reach a judge fork (no token numbers).
// Full run needs ANTHROPIC_API_KEY; every token figure comes from the API response `usage` field.
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../src/parse.js';
import { run } from '../src/run.js';
import { anthropic, makeJudge } from '../src/model.js';
import { baseline } from './baseline.js';
import { tickets } from './tickets.js';

const graph = loadGraph(new URL('../examples/triage', import.meta.url).pathname);
const dry = process.argv.includes('--dry');
if (!dry && !process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set; refusing to report token numbers. Use --dry for the zero-model measurement.'); process.exit(2); }
const call = dry ? null : anthropic();
const judge = dry ? async (g, n, s, targets) => ({ target: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, dry: true }) : makeJudge(call);

const rows = [];
const cacheDir = mkdtempSync(join(tmpdir(), 'wf-bench-'));
for (const t of tickets) {
  let t0 = performance.now();
  const w = await run(graph, t.input, { judge, cacheDir: process.argv.includes('--memo') ? cacheDir : undefined });
  const row = { id: t.id, expect: t.expect, wayfile: { end: w.end, calls: w.calls, usage: w.usage, ms: Math.round(performance.now() - t0) } };
  if (!dry) { t0 = performance.now(); const b = await baseline(call, t.input); row.baseline = { ...b, ms: Math.round(performance.now() - t0) }; }
  rows.push(row);
}
const sum = (k) => {
  const xs = rows.map((r) => r[k]).filter(Boolean);
  const u = xs.reduce((a, x) => { for (const f of Object.keys(a)) a[f] += x.usage[f]; return a; }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  return { n: xs.length, correct: xs.filter((x, i) => x.end === rows.filter((r) => r[k])[i].expect).length, calls: xs.reduce((a, x) => a + x.calls, 0), usage: u, msMedian: xs.map((x) => x.ms).sort((a, b) => a - b)[xs.length >> 1] };
};
const out = { model: dry ? null : process.env.WAYFILE_MODEL || 'claude-haiku-4-5', dry, at: new Date().toISOString(), wayfile: sum('wayfile'), baseline: dry ? null : sum('baseline'), rows };
mkdirSync(new URL('./results', import.meta.url), { recursive: true });
const f = new URL(`./results/${dry ? 'dry' : 'full'}-${Date.now()}.json`, import.meta.url);
writeFileSync(f, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ wayfile: out.wayfile, baseline: out.baseline }, null, 2), '\n→', f.pathname);
