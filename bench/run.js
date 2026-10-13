// Benchmark: wayfile vs bash/ReAct vs Eve-style over 50 tickets + 20 CI cases.
// node bench/run.js          full run; needs ANTHROPIC_API_KEY. Tokens come only from API `usage`.
// node bench/run.js --dry    wayfile only, no model: judge forks get no answer, no token numbers.
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadGraph } from '../src/parse.js';
import { run } from '../src/run.js';
import { anthropic, makeJudge } from '../src/model.js';
import { agent } from './agents.js';
import { cases } from './cases.js';

// USD per million tokens. Source: docs.claude.com/en/docs/about-claude/pricing, read 2026-10-13
// (5-minute cache writes = 1.25x input, cache reads = 0.1x input).
export const PRICES = { 'claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, 'claude-sonnet-4-5': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 } };
export const cost = (u, p) => (p ? (u.input * p.input + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead + u.output * p.output) / 1e6 : null);
const total = (u) => u.input + u.output + u.cacheRead + u.cacheWrite;
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function summarize(rows, arm, price) {
  const xs = rows.filter((r) => r[arm]);
  const u = xs.reduce((a, r) => { for (const k in a) a[k] += r[arm].usage[k]; return a; }, zero());
  const ms = xs.map((r) => r[arm].ms).sort((a, b) => a - b);
  const steps = xs.reduce((a, r) => a + r[arm].steps, 0), calls = xs.reduce((a, r) => a + r[arm].calls, 0);
  return { n: xs.length, correct: xs.filter((r) => r[arm].end === r.expect).length, calls, steps, modelStepShare: steps ? calls / steps : 0, usage: u, tokens: total(u), usd: cost(u, price), msMedian: ms[ms.length >> 1] ?? 0 };
}

export function gate(s, graphs) {
  const nodes = graphs.flatMap((g) => Object.values(g.nodes));
  const judgeShare = nodes.filter((n) => n.kind === 'judge').length / nodes.length;
  const out = { judgeNodes: `${nodes.filter((n) => n.kind === 'judge').length}/${nodes.length}`, judgeShare, killJudges: judgeShare > 0.4 };
  if (!s.bash) return { ...out, decision: 'PENDING (no model run)' };
  const ratio = (b) => (s.wayfile.tokens ? b.tokens / s.wayfile.tokens : Infinity);
  Object.assign(out, { xBash: ratio(s.bash), xEve: ratio(s.eve) });
  out.killBash = s.bash.correct >= s.wayfile.correct && out.xBash < 3;
  const go = out.xBash >= 5 && out.xEve >= 5 && s.wayfile.correct >= Math.max(s.bash.correct, s.eve.correct);
  out.decision = out.killJudges || out.killBash ? 'NO-GO' : go ? 'GO' : 'NO-GO (5x/accuracy bar not met)';
  return out;
}

const pct = (x) => `${(100 * x).toFixed(0)}%`;
export function table(s, g, meta) {
  const row = (name, x) => x ? `| ${name} | ${x.correct}/${x.n} | ${x.calls} | ${pct(x.modelStepShare)} | ${meta.dry ? 'n/a' : x.usage.input} | ${meta.dry ? 'n/a' : x.usage.output} | ${meta.dry ? 'n/a' : x.usage.cacheRead} | ${meta.dry ? 'n/a' : x.usage.cacheWrite} | ${meta.dry ? 'n/a' : x.tokens} | ${x.usd == null ? 'n/a' : `$${x.usd.toFixed(4)}`} | ${x.msMedian} |` : `| ${name} | not run | | | | | | | | | |`;
  return [
    `# Benchmark summary (${meta.at})`, '', `Model: ${meta.model ?? 'none (dry run)'}. Cases: ${meta.n} (50 tickets + 20 CI). Tokens from API usage fields; cost = tokens × price table in bench/run.js (docs.claude.com pricing, 2026-10-13).`, '',
    '| arm | correct | model calls | steps calling model | input | output | cache read | cache write | total tokens | cost | median ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    row('wayfile', s.wayfile), row('bash/ReAct', s.bash), row('Eve-style', s.eve), '',
    `Judge nodes: ${g.judgeNodes} (${pct(g.judgeShare)}; kill if > 40%: ${g.killJudges ? 'KILL' : 'ok'}).`,
    g.xBash != null ? `Tokens: bash ${g.xBash.toFixed(1)}× wayfile, Eve-style ${g.xEve.toFixed(1)}× wayfile (GO needs ≥5× both at ≥ accuracy; NO-GO if bash < 3× at ≥ accuracy).` : 'Token ratios: not measured.',
    `**Decision: ${g.decision}**`, '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dry = process.argv.includes('--dry');
  if (!dry && !process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is absent. It is the only blocker for the full run; use --dry.'); process.exit(2); }
  const model = dry ? null : process.env.WAYFILE_MODEL || 'claude-haiku-4-5';
  const call = dry ? null : anthropic({ model });
  const judge = dry ? async () => ({ target: null, usage: zero() }) : makeJudge(call);
  const graphs = { triage: loadGraph(new URL('../examples/triage', import.meta.url).pathname), ci: loadGraph(new URL('../examples/ci', import.meta.url).pathname) };
  const rows = [];
  for (const c of cases) {
    const row = { id: c.id, graph: c.graph, expect: c.expect };
    let t0 = performance.now();
    const w = await run(graphs[c.graph], c.input, { judge });
    const steps = w.steps.filter((s) => s.next).length; // decisions, excluding the end node
    row.wayfile = { end: w.end, calls: dry ? 0 : w.calls, forks: w.steps.filter((s) => s.usage).length, steps, usage: w.usage, ms: Math.round(performance.now() - t0) };
    if (!dry) for (const arm of ['bash', 'eve']) {
      t0 = performance.now();
      try { row[arm] = { ...(await agent(arm, call, c)), ms: Math.round(performance.now() - t0) }; }
      catch (e) { row[arm] = { end: null, calls: 0, steps: 0, usage: zero(), ms: 0, error: String(e.message).slice(0, 200) }; }
    }
    rows.push(row);
    process.stderr.write('.');
  }
  const price = PRICES[model];
  const s = { wayfile: summarize(rows, 'wayfile', price), bash: dry ? null : summarize(rows, 'bash', price), eve: dry ? null : summarize(rows, 'eve', price) };
  if (dry) s.wayfile.modelStepShare = rows.reduce((a, r) => a + r.wayfile.forks, 0) / rows.reduce((a, r) => a + r.wayfile.steps, 0);
  const g = gate(s, Object.values(graphs));
  const meta = { dry, model, at: new Date().toISOString(), n: rows.length };
  mkdirSync(new URL('./results', import.meta.url), { recursive: true });
  const tag = dry ? 'dry' : 'full';
  writeFileSync(new URL(`./results/${tag}.json`, import.meta.url), JSON.stringify({ meta, prices: price ?? null, summary: s, gate: g, rows }, null, 2));
  writeFileSync(new URL(`./results/${tag}-summary.md`, import.meta.url), table(s, g, meta));
  console.log(`\n${table(s, g, meta)}`);
}
