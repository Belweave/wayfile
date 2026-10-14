# Wayfile: quality-constrained routing

Wayfile's objective is lower total cost per verified successful task at a stated quality and latency threshold. Token reduction is one contributor. Fast deterministic decisions, reviewable policy, sufficient evidence, and maintainable graphs matter just as much.

This design was reviewed by four GPT-6.1-Sol agents at Max reasoning: routing architecture, runtime correctness, evaluation design, and the current Eve comparison. Their common recommendation was to fix silent errors and measurement before expanding the platform.

## The execution boundary

Keep an explicit outer graph. Use deterministic rules for trusted structured facts or highly precise affirmative requests. Use a focused semantic fork when intent or evidence needs interpretation. A bounded `harness` node handles open-ended model/tool work inside that policy boundary. Validate its resulting state or artifact before completion. [Harness API and tools](HARNESS.md)

Markdown makes policy edits easy to inspect; it does not make a wrong predicate correct. A regex that matches “refund” cannot understand “do not refund,” quoted text, or competing intents. Precision is the admission criterion for a fast path. Coverage is recovered through semantic fallback rather than an ever-growing synonym list.

`ordered: true` documents policy precedence. `routing: ambiguous` sends competing positive matches to a judge restricted to those targets. That option cannot repair an incorrect single positive match; the predicate still needs a precise contract.

The model sees the current node, only eligible target descriptions, always-on policy, and declared `needs`. Explicit missing fields remain visible. A small prompt is useful when it preserves the sufficient evidence. A filename overlap is not proof that a code change caused a test failure.

## Implemented in this iteration

| Area | Result |
| --- | --- |
| Routing | Conservative support/starter fast paths; CI semantic fallback; deterministic refund amount and retry-attempt guards after semantic classification. |
| Contracts | Complete JSON route parsing, allowed targets, duplicate-key rejection, nonempty text, and a supported JSON Schema subset for skills. |
| Recovery | At most one invalid-output repair; optional repair model; no automatic transport retries in the model adapter. Every attempt contributes usage and calls. |
| Harness | Declared tools, projected evidence, bounded turns/calls/errors/bytes/deadlines, validated final state, and projected tool traces. Scoped file helpers and opt-in host shell; custom adapters for other capabilities. |
| Run state | Explicit completed/partial/failed status; bounded steps and visits; failed runs retain state, usage, and a trace. |
| Memoization | Graph policy, skill/schema contents, executable/auxiliary files, input values, and adapter identity participate in keys. Missing differs from null. Approval and harness nodes cannot memoize. |
| Human decisions | Explicit test responses; live Notify answers have provenance and invocation-scoped idempotency. No default approval. |
| Evaluation | Development challenge cases, task/evidence contracts, failure-inclusive usage, cost per success, provenance, and explicit simulated-baseline limits. |

Schemas validate shape, not truth. A complete, well-typed invented answer can still be wrong. Factual quality needs task-specific evidence assertions and independent evaluation. Terminal “fix” nodes in the CI example select an outcome; they do not implement or verify a production code fix.

## Context and cache contracts

`needs` is a model-context declaration. Include the facts required to decide and the evidence needed to produce the answer. Scripts still receive the full state for compatibility, and their cache inputs therefore include the full state. Predicate reads also participate in cache keys, even when a malformed graph omits them from `needs`; lint reports that omission.

Only pure work belongs behind `cache: inputs`. `cache_files` declares auxiliary files such as the known-flaky test list. External order state, customer policy, time, network resources, and other mutable facts need an application freshness/version strategy. Do not cache an action that must execute on every request.

An injectable adapter can close over arbitrary settings. It needs a stable `.cacheKey` or an explicit `opts.cacheKey` to use model memoization. Include tenant, caller, policy version, model settings, and any closed-over evidence that affects the answer. `opts.context` can provide additional cache context. Reuse is valid only within that identified scope.

The current graph checker validates references, metadata, predicate dependencies, output schemas, executable paths, cycles, and node examples. Its upstream `needs` analysis identifies possible producers; it does not yet prove that every predecessor path supplies every fact. Explicit missing-evidence behavior remains necessary.

## A fair target: Eve

Eve is already filesystem-first and supports on-demand/deferred skills, output projection, narrow tool catalogs, dynamic models, and durable sessions. The comparison should preserve those capabilities rather than measure an artificially inflated prompt. [Context control](https://eve.dev/docs/concepts/context-control), [tools](https://eve.dev/docs/tools), [dynamic capabilities](https://eve.dev/docs/guides/dynamic-capabilities).

Wayfile's differentiator is an explicit outer graph that can skip model selection altogether. Its routing trace identifies the authored file and line. Eve also exposes execution traces; source-linked explicit policy is the distinction. Eve's durability and real-session evals are meaningful capabilities Wayfile does not yet match. [Execution and durability](https://eve.dev/docs/concepts/execution-model-and-durability), [evals](https://eve.dev/docs/evals/overview).

Compare the default Eve harness, a task-tuned Eve agent, and equivalent deterministic policy hosted inside Eve. That separates the algorithm from the framework's overhead. A plain JavaScript policy runner is another useful control. Keep the actual Eve fixture isolated from Wayfile's dependency-free core. The pinned-runtime procedure is in [bench/EXPERIMENT.md](../bench/EXPERIMENT.md).

The original 70-case experiment measured terminal routing against handwritten loops. Its 68/70 versus 69/70 results and token savings diagnose an opportunity; they do not establish quality parity with actual Eve. Fresh paid runs now compare the current authored workflows with actual pinned Eve. Their scope, public development tuning, measured costs, and generated-output contract correction are in [the evidence report](bench-quality-2026-10-13.md).

## Measure the full cost of success

Use **total experiment cost / verified successful tasks**, including invalid replies, repairs, failed runs, tool/infrastructure spend, and later human recovery where measured. Report provider-reported spend separately from estimated prices and unmeasured categories. Unknown billing cannot pass a measured cost gate. Zero successes has no finite cost per success.

Track these outcomes separately:

- Correct automated completion, with prerequisite actions and output/evidence contracts satisfied.
- Appropriate abstention or human escalation, without pretending it was automated success.
- Incorrect completion, malformed output, lost state, missing tool action, and run failure.
- Human approval, denial, timeout, and any resulting policy violation.

Report p50/p95 latency separately for deterministic, model, repaired, and approval paths. The historical 13 ms median mixes very different paths and cannot describe the worst case. Separate cold provider caches, warm provider caches, and Wayfile result memoization.

Freeze independent evaluation cases before tuning. Development challenge data is useful for regression detection but cannot certify generalization. Repeat matched runs with the same policies, tools, models, provider/reasoning settings, output budgets, and cache conditions. Publish case counts and uncertainty, plus per-domain/family regressions, rather than only a pooled accuracy number.

Maintenance is part of the economic model. Record graph-authoring minutes, rule churn, fallback rate, repairs, incident/recovery time, and dollars per verified success. Amortize authoring, proposal generation, replay, review, and recovery labor over a stated traffic volume and time horizon. The current benchmark reports model API cost, not total production cost. Handwriting an ever-growing graph can erase inference savings.

## Reviewed rule improvement

The proposed feedback loop uses real traffic to reduce maintenance while retaining human control:

1. Capture source-linked decisions, evidence, outcomes, repairs, costs, and failure traces. Keep outcome labels distinct from model agreement.
2. Identify repeated semantic decisions with stable supporting facts. Propose a narrow predicate and exact graph diff; never promote a rule solely because a model is confident.
3. Replay the proposal against the supporting traffic, conflicting priorities, negation, near misses, and a regression suite. Keep a separate unopened final evaluation pool; record exposure and replace it after tuning. Measure semantic agreement, task success, coverage, latency, cost, and maintenance burden.
4. Show the complete review packet through Notify: diff, policy/graph version, proposal hash, evidence references, counterexamples, results, and scope. Bind approval to that exact hash and version.
5. Promote only after the quality gate and a human decision. Recheck the approved graph version and proposal hash; reject stale or expired approvals. Learned routes must preserve mandatory policy, evidence, and approval guards. Ship a normal reviewable commit, start with a shadow comparison, and retain a versioned rollback path.
6. Monitor disagreements and distribution drift. Demote rules whose false-positive rate or task quality crosses the stated threshold.

This is a roadmap, not an implemented self-writing graph. The current Notify adapter supplies decisions, while rule synthesis, replay tooling, shadow traffic, promotion, and rollback automation remain to be built. Approval is consent to a particular change; independent evidence establishes whether that change is sound.

Notify's API distinguishes created/queued delivery from a confirmed human answer. Its decision and reply-webhook surfaces can support a future durable review flow; the current adapter waits in the process. [Notify agent docs](https://notify.belweave.ai/llms.txt), [human decisions](https://notify.belweave.ai/docs/ask-decision), [API contract](https://notify.belweave.ai/openapi.json).

## Next milestones

1. **Prove a quality/cost frontier.** Run fresh, independently labeled support and CI tasks against actual pinned Eve; include generated answers, prerequisite actions, failures, and policy constraints.
2. **Supply real evidence.** Add task-specific retrieval through existing script nodes: order data, relevant diff/source, policy version, and verification results. Avoid inferring causation from names.
3. **Make maintenance measurable.** Build replayable rule proposals and the Notify review packet before automatic promotion.
4. **Add durability where needed.** Checkpoint state and approval identity, park human decisions, resume without replaying side effects, and verify signed reply-webhook events. Keep hosting and transport adapters outside the router core where possible.
5. **Extend execution from measured gaps.** Build verified browser/MCP/sandbox/domain adapters around the bounded harness. Keep capabilities and credentials scoped in trusted code, measure task success, and preserve the reviewable outer graph.

The target is a fast, reviewable workflow that costs less while succeeding just as often. “Best” and “cheapest” remain goals until the matched evidence supports them.
