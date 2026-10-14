# Observed Wayfile quality and cost, October 13, 2026

Wayfile passed the latest matched **routing** development comparison against the actual Eve fixture: 32/32 complete routing contracts versus 29/32, at 3.63× lower model API cost per successful contract. A separate real tool-harness smoke reproduced, fixed and independently verified a small coding failure. These are observed development results, not a claim that Wayfile is universally the best or cheapest framework.

Four GPT-6.1-Sol subagents at Max reasoning reviewed routing, runtime behavior, evaluation and the Eve comparison. Paid evaluation used only **`anthropic/claude-haiku-5.5` through OpenRouter**. Eve was pinned to **0.79.0**, its OpenAI-compatible provider SDK to **3.0.68**, and Zod to **4.1.12** in the [isolated fixture](../bench/eve-runtime/package.json). The Wayfile runtime remains dependency-free.

## Matched routing comparison

The same 32 public challenge cases cover 19 scenario families across support and CI. Every arm receives the applicable policy and fixture evidence. Full success includes the terminal decision and mandatory lookup/approval observations; correct human escalation can satisfy a routing contract. Terminal refund/fix nodes select outcomes and do not perform production payments or code changes.

| Latest routing run | Wayfile | Bash model loop | Actual Eve fixture |
| --- | ---: | ---: | ---: |
| Correct terminal routes | 32/32 | 30/32 | 30/32 |
| Full routing contract success | **32/32** | 27/32 | 29/32 |
| Model requests, including repairs/failures | 26 | 46 | 48 |
| Provider-reported tokens, including cache categories | **22,536** | 61,181 | **102,885** |
| Tool calls | 13 | 14 | 15 |
| Total model API USD | $0.002002905 | $0.004746410 | $0.006588620 |
| USD per successful contract | $0.000062591 | $0.000175793 | $0.000227194 |
| Case latency p50 / p95 | 1,193 / 2,469 ms | 1,477 / 3,682 ms | 1,838 / 4,334 ms |

The paired gate passed against actual Eve: three Wayfile-only successes, zero Eve-only successes, no critical-case regressions, and no domain regressions. Wayfile cost per success was 3.63× lower than Eve and 2.81× lower than the Bash loop. The ratio uses total arm spend, including unsuccessful tasks, divided by successful contracts. It measures these authored workflows rather than isolating framework overhead.

The Eve fixture's three failed contracts were a string-valued refund amount, a string-valued retry attempt, and an omitted order lookup despite a correct terminal reply. Both strict input handling and required evidence observation matter. Eve supports authoring deterministic guards too; those outcomes do not establish an intrinsic inability of its runtime.

An earlier actual routing run produced Wayfile 31/32, Bash 26/32, and Eve 28/32 full successes. Wayfile's miss treated resource exhaustion as retryable infrastructure. The general policy was then tightened across all arms: affirmative evidence must establish a transient transport/upstream primary cause; resource exhaustion, permanent configuration problems, and unknown failures require triage. The narrow transient fast path also stopped matching incidental lines in a larger log. The latest run is **development tuning**, with the same exposed cases and labels.

Application memoization was disabled. Provider caching was observed rather than controlled cold. Case order was shuffled and arm order balanced. Runtime startup is recorded separately from case latency. All 120 responses in the latest routing run reported the requested Haiku model. Source stayed unchanged during both frozen evaluations.

All arms used the same OpenRouter frontend and automatic upstream-routing policy. Actual upstream provider identities are journaled; a single upstream backend was not pinned. Latency and cache measurements are observed results under that regime.

## Generated answers and grader corrections

The separate four-task experiment follows customer → order → regional policy reads, with a missing order and a denied approval. Every arm must provide typed decisions, numeric/null amounts, currency, policy reasons, exact source versions, a bounded explanation, observed reads, and required approval evidence. No payments occur.

The original generated-output V1 experiment is preserved with its NO-GO. Its amount schema omitted `type`, so JSON Schema legitimately permitted strings; the native Eve fixture forwarded that schema unchanged. Raw provider replies already contained string amounts. Its summary grader also rejected valid wording without exact words. Those fixture/grader defects cannot establish relative framework quality.

Output contract V2 supplied explicit `number|null` and `string|null` types plus a factual `reason_code`. In the first paid V2 run, **all arms got all four structured decisions, amounts, currencies, reasons, sources and required observations right**. The automated scorer recorded Eve 3/4 because it incorrectly interpreted “No refund is approved or issued” as a completed payment. That is another grader false positive; it does not establish an Eve quality deficit. The original scored report remains unchanged.

Review also identified a prose limitation: order age alone does not establish time since delivery. Three captured explanations inferred delivery age. Structured correctness therefore does not certify complete explanation faithfulness. The shared policy now explicitly distinguishes order age from delivery status, and archived regrades disclose their changed grader and posthoc scope. Results from different graders are not interchangeable or independent replications.

A fresh paid execution with the clarified policy produced the following factual data and required observations:

| Generated factual/evidence contracts | Wayfile | Typed model loop | Actual Eve fixture |
| --- | ---: | ---: | ---: |
| Correct decisions/facts/sources and required observations | **4/4** | 4/4 | 4/4 |
| Model requests, including repairs | 5 | 23 | 14 |
| Total model API USD | $0.001134180 | $0.003592280 | $0.002653925 |
| USD per factual/evidence success | $0.000283545 | $0.000898070 | $0.000663481 |

Wayfile had the same observed factual/evidence success as actual Eve, at **2.34× lower model API cost per success**. Its five requests include one paid schema repair. All 42 responses reported Haiku 5.5; source was unchanged during the paid run. The explanation audit found that the earlier delivery-age inference was absent from all twelve new summaries. This is a bounded, unblinded development review, not an independent faithfulness certification.

Grader V3 nevertheless flagged the loop's valid “no such order was found” explanation as contradictory. Grader V4 therefore separates **authoritative factual/evidence and bounded-summary checks** from **prose heuristic diagnostics requiring semantic adjudication**. English regexes cannot reliably decide free-form meaning. The archive regrade changes no captured outputs, calls, cost, or evidence; it makes no new API requests and is explicitly post hoc. The generated metric is factual/evidence success, and must not be presented as automatic exhaustive prose-quality success.

## Traditional tool-harness execution

A separate paid Haiku run created a small fixture with an incorrect `add` function and fixed tests. A trusted authorization callback allowed only writing `calc.mjs` with an observed SHA-256 and running `node --test check.test.mjs`.

The model observed a failing test, read the source/tests, performed a guarded edit, and observed the original test pass. A separate verifier reran the tests and confirmed their hash was unchanged. The run completed with **3 model requests, 5 tool calls, and $0.000802455 model API cost**. Its trace and captured output support the result. This one transparent task demonstrates execution, not general coding accuracy or OS isolation. [Harness API and runnable smoke](HARNESS.md)

The harness supplies per-node tool allowlists, strict argument/final contracts, bounded turns/calls/errors/bytes/deadlines, projected tool results, and failure-inclusive accounting. Host shell retains host-user permissions. Durable restart/resume, sandboxing, and production tool adapters remain application responsibilities.

## Provenance and reproduction

Local raw journals, manifests, cases, traces and reports are retained under ignored `bench/results/`; the committed narrative preserves the measured aggregates. Original reports are never overwritten.

| Artifact | Local run ID |
| --- | --- |
| First actual routing comparison | `2026-10-13T22-56-35-438Z-challenge-6a7fe7e6` |
| Original generated-output V1 | `2026-10-13T23-00-52-829Z-evidence-78d480d3` |
| Latest actual routing comparison | `2026-10-13T23-16-59-162Z-challenge-314c3ec7` |
| Original paid output-contract V2 | `2026-10-13T23-20-58-348Z-evidence-v2-8b9a5644` |
| First posthoc grader correction | `2026-10-13T23-27-56-381Z-evidence-regrade-c2-g3-02c76122` |
| Fresh execution with clarified order age | `2026-10-13T23-28-57-064Z-evidence-v2-g3-bf78aa5a` |
| Posthoc factual/evidence regrade and explanation audit | `2026-10-13T23-34-57-195Z-evidence-regrade-c2-g4-8c870522` |
| Real coding-harness smoke | `2026-10-13T23-22-26-105Z-harness-8dda9d7e` |

The [sanitized aggregate measurements](../bench/evidence/routing-2026-10-13.json) retain token categories, costs, counts, and the original report hash without model prompts or local secrets. Wayfile used 4.57× fewer total provider-reported tokens than the actual Eve fixture in this run; the sum includes cache reads and writes and does not imply equal token pricing.

Latest routing provenance:

```text
seed: wayfile-quality-v2-2026-10-13
source: b2aaa8e9ae959d2cf65770532d71a34b29fd84b3a7f7d20c10755845f2662ad8
config: af4e883893244314d357c879950ffa4c3e8b8a6ac55f7201a62a72a85c7f1c92
corpus: 95ca2bdd3baec0de7ef2746376837be61484e2a23d3aaa95b367e4adbde21dc6
labels/contracts: 32d9cdb7ae438d3fc93ad4553399b7085fd1c5208c8baca361ffa730591fec64
```

The latest paid generated execution has config hash `74ab70e975a0f9b42f0cb68b88eb69e60e3655e96b36e2dd98d3fc6c9ebbed4a` and source hash `9b9c9b81960cb07774485d101616a19b31ceb5adbcc95e93218f4cc014fee724`. Its original report JSON hash is `07c4d5ac9b49d7b44cc13a1398e52f04c984d2391fb00751b5b6443a4d4e4b08`; archive regrading verifies the original five artifacts remain unchanged. The final cumulative experiment ledger records **$0.049009100 across 395 reported Haiku responses**, including smoke checks and earlier flawed experiments. That is cumulative spend, not one arm's benchmark cost.

```sh
npm test
npm --prefix bench/eve-runtime ci
npm --prefix bench/eve-runtime test
npm --prefix bench/eve-runtime run verify
node bench/evaluate-local.js
node --env-file=.env bench/run.js --dataset challenge --eve-runtime
node --env-file=.env bench/evidence-models.js --eve-runtime
node --env-file=.env bench/harness-smoke.js
```

For a captured contract-V2 report, `node bench/evidence-regrade.js --input <path/to/report.json>` writes a separate, explicitly posthoc factual/evidence regrade and retains the original model measurements. It does not call a provider. Its prose diagnostics require separate semantic adjudication; a diagnostic pass is not proof of explanation faithfulness.

Paid runs use a shared cumulative ledger and must run sequentially. A completed request can cross the configured budget. Missing cost or lost responses block further spend until reconciled. Per-run charges are separate from cumulative spend. The [protocol](../bench/EXPERIMENT.md) specifies repair budgets, model provenance, cache limits and scoring.

Local process, infrastructure, grading and human costs are unpriced. Cases are public and same-team authored; there are no independently authored unseen cases or statistical noninferiority confidence bounds. Repeated, independently adjudicated tasks, optimized deterministic competitor controls, production failures, durability, and maintenance labor remain necessary to establish a broader cost/quality frontier. Historical token ratios and the original routing NO-GO remain in [the original report](bench-2026-10-13.md) and [decision](GO-NO-GO.md).
