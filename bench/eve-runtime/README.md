# Actual Eve runtime fixture

This optional package runs **Eve 0.79.0 itself**, with its official server,
`eve/client`, tool execution, on-demand skills, durable step events, and
per-turn `outputSchema`. It does not reproduce Eve's harness in a handwritten
loop. Dependencies and generated storage stay inside this directory; Wayfile's
published core still has zero runtime dependencies.

The three fixtures cover support routing, CI routing, and generated refund
eligibility replies with customer → order → regional policy evidence. Every
case starts a fresh session and records its event stream, tool evidence,
structured result, configuration hash, package versions, and provider requests.
No Notify messages or production actions are sent: approval answers are
explicitly simulated fixtures.

## Install and verify locally

Requires Node.js 24+ (verified on Node 26). From the repository root:

```sh
npm --prefix bench/eve-runtime ci --ignore-scripts --no-audit --no-fund
npm --prefix bench/eve-runtime test
npm --prefix bench/eve-runtime run verify
node bench/eve-runtime/run.js --mock --dataset challenge --limit 1
```

`verify` exercises eight independent actual Eve sessions: skill loading,
approval before lookup, denied approval, flaky-test evidence, and all four
multi-hop generated-output fixtures. It additionally exercises the installed
OpenAI-compatible provider SDK and metering proxy using an in-memory SSE
response. No API credential or paid model call is used.

`npm --prefix bench/eve-runtime run verify:schema` inspects the actual
`eve__reply` schema sent by the installed provider SDK. It checks that nullable
numeric/currency types survive unchanged, that numeric and null values are
accepted, and that a string amount is rejected before a valid repair completes.
The mock evidence provider also checks its actual offered tool schema; correct
scripted output alone does not validate the contract. Metered request artifacts
retain the final-tool schema body and hash.

The earlier generated-output V1 schema omitted `amount.type`. Native JSON Schema
therefore permitted strings, and Eve passed that schema through unchanged.
Those results diagnose an underconstrained fixture; they do not establish an
Eve coercion bug or a framework quality deficit. The corrected shared contract
uses explicit nullable types and a typed decision reason; original reports
remain unchanged.

Mock replies are scripted protocol probes, not semantic evaluations. Their
tokens are Eve's deterministic estimates and `modelQualityMeasured` is false.
Zero mock spend cannot qualify a cost/quality leaderboard. The local SSE probe
is separately marked `transportTest:true` and also cannot qualify.

## Run an authorized OpenRouter experiment

Set `OPENROUTER_API_KEY` locally. The model is fixed to
`anthropic/claude-haiku-5.5`; another model is rejected.

```sh
node bench/eve-runtime/run.js --allow-paid --model anthropic/claude-haiku-5.5 --dataset challenge --limit 1 --max-usd 3
node bench/eve-runtime/run.js --allow-paid --model anthropic/claude-haiku-5.5 --dataset evidence --max-usd 3
```

The first command is a small per-domain smoke. CLI traffic uses the repository's
shared cumulative ledger and runs one case at a time. A separate process must
not spend concurrently against that ledger. The next request is blocked at the
budget, after an unknown charge, or after eight provider attempts for one case.
The request that crosses the dollar budget may finish. API keys remain in the
metering process and are neither passed to Eve children nor written to artifacts.

The provider boundary matches temperature `0`, output cap `400` for routing
and `800` for generated evidence tasks, usage reporting, and a stable system
prompt cache breakpoint. The journal preserves actual response model,
provider, response ID, raw usage, cached/uncached token categories, and
`usage.cost`. Missing cost or provenance remains unknown. Transient failures,
native repairs, durable replay, and compaction calls all pass through that same
transport journal; totals are not inferred from `step.completed` counts.

This is a **task-tuned Eve fixture**: typed tools, only relevant skills,
`defaultTools:false`, and no bundled development extensions. The support and
CI instructions snapshot the same prose policies as the routing benchmark;
typed lookup tools implement the same order-parity and flaky-list fixtures.
Tools read the authored case from trusted session context, preventing invented
tool arguments from substituting a different case. Optional skills restate the
procedures without requiring an unnecessary load.

Eve retains its native structured-output validation and transient retry
behavior; the eight-request transport ceiling bounds them. This differs from
Wayfile's one-invalid-output repair, and is disclosed in result provenance.
Comparison with the normal Eve defaults and equivalent deterministic policy
hosted inside Eve remains additional work. Provider cache conditions are
observed rather than guaranteed cold/warm. Infrastructure, tool compute,
maintenance, and human labor are not priced by this adapter.

## External adapter contract

```js
import { startRuntime, runCase, runEvidenceCase, stopRuntime } from './adapter.mjs';

const runtime = await startRuntime({
  mock: true, // false + allowPaid:true is required for actual model traffic
  model: 'anthropic/claude-haiku-5.5',
  ledger: { spent: 0 }, maxUsd: 3, maxTurns: 8,
  onEvent: (request) => { /* append each actual provider request to your journal */ },
});
try {
  const result = await runCase({ id: 'example', graph: 'triage', input: {
    ticket: { body: 'Please refund order 716.', amount: 501 },
  } }, { runtime, mock: true });
  console.log(result.end, result.evidence, result.provenance.artifact);
  // runEvidenceCase(task, { runtime, mock:true, maxTokens:800 }) uses the
  // same fixture records/policy/schema as the generated-output experiment.
} finally { await stopRuntime(runtime); }
```

The return value contains `end`, `status`, `error`, `output`/`text`, `evidence`,
`toolCalls`, actual provider `calls`, normalized `usage`, `usd`, `costMeasured`,
`tokensMeasured`, `unknownCostCalls`, `models`, `providers`, `requests`,
`modelQualityMeasured`, latency, and `provenance`. Failed cases retain observed
events and paid attempts. Normal routing results can use `scoreCase` from
`../contracts.js`; generated JSON uses the shared evidence-task scorer.
No expected labels, case rationale, or gold contracts enter model messages.

Servers boot lazily with `--no-ui --no-default-extensions`, listen only on
loopback, and stop on `stopRuntime`. Initial boot time is reported separately
from case latency. Artifacts live in `artifacts/`; Eve's local Workflow state
lives under each fixture's `.eve/`. Both are ignored by Git.

Version-matched references: `node_modules/eve/docs/README.md`,
`docs/guides/client/overview.mdx`, `docs/evals/overview.mdx`, and
`docs/concepts/sessions-runs-and-streaming.md`. Public guides:
[client](https://eve.dev/docs/guides/client/overview),
[structured output](https://eve.dev/docs/guides/client/output-schema),
[context controls](https://eve.dev/docs/concepts/context-control),
[runtime durability](https://eve.dev/docs/concepts/execution-model-and-durability).
