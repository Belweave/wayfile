# Wayfile MVP: go/no-go (2026-10-13)

**Decision: pending. The token half of the gate cannot be evaluated yet.** The box has no LLM API key, so neither arm of the benchmark has been run against a real model, and no token figure in VISION.md §3 has been replaced. Nothing below is estimated to fill that gap.

## What was measured (no model involved)
`node bench/run.js --dry`: the triage graph run over the 50 tickets in `bench/tickets.js`, with judge forks returning no answer.
- 30 of 50 tickets (60%) reached an end node through deterministic routes and scripts alone: **0 model calls**, and all 30 were correct.
- 20 of 50 reached the one `judge:` fork (10 bug reports, 10 general questions). That is C = 1 call per ticket at most, against VISION's estimated C = 6–8 for ReAct.
- Judge nodes: 1 of 7 (14%), under the 40% kill threshold. This is a fact about our own graph, not evidence it generalises.
- Memo replay of an identical ticket: 0 calls (unit test `memoization`).

Caveat: the ticket set is synthetic and written by the same author as the graph, so the deterministic hit rate is optimistic. Paraphrased tickets are the known weakness (VISION §4).

## Gate (VISION §6)
| Criterion | Status |
|---|---|
| Tokens ≥5× lower than baseline at equal or better accuracy | **Not measured.** Needs a key. |
| Kill: baseline matches accuracy at <3× tokens | **Not measured.** |
| Kill: >40% of nodes are judges | Passes (14%). |

## To finish
Put `ANTHROPIC_API_KEY` on the box (optionally `WAYFILE_MODEL`), then run `node bench/run.js`. It runs both arms on the same model and writes `bench/results/full-*.json` with per-ticket end node, calls, latency, and input/output/cache-read/cache-write tokens taken from each response's `usage`. Go if wayfile's total effective tokens are ≥5× lower at ≥ baseline accuracy.

## Deferred until a yes
Notify `ask:` wiring (the `ask` node is a local stub), self-hardening, and an OpenAI adapter.
