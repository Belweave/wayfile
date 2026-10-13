# Wayfile MVP: go/no-go (updated 2026-10-13)

**Decision: PENDING. `ANTHROPIC_API_KEY` is absent from the box, and that is the only blocker.** No arm has been run against a model. No token, cost or latency figure exists, and none is estimated here.

## Gate
| Criterion | Status |
|---|---|
| GO: ≥5× fewer tokens than both bash/ReAct and Eve-style, at ≥ their accuracy | not measured |
| NO-GO: bash within 3× of Wayfile tokens at ≥ Wayfile accuracy | not measured |
| NO-GO: >40% of nodes need the model | **ok: 2 of 18 nodes are judges (11%)** |

## Measured without a model (`./bench.sh` dry run, 70 cases)
- 55/70 cases routed correctly with **0 model calls** (judge forks given no answer).
- 24 of 109 routing steps (22%) reach a judge fork: 20 tickets (bug vs general) and 4 CI test failures (caused by the diff or not). Those are the only places Wayfile can spend tokens, at 1 call per case at most.
- The best Wayfile can score even with a perfect judge is **68/70**. Two CI cases are deliberate paraphrases ("connection dropped", "flake8 complained") that the regex routes miss and send to `human-triage`. That is the brittleness VISION §4 predicted, and it is now measured.
- Labels: rewritten from the prose policy alone (bench/LABELING.md). They agree 50/50 with the first-round ticket labels. A model labelling check (`bench/label.js`) is waiting on the key.

## To finish
Put `ANTHROPIC_API_KEY` on the box and run `./bench.sh`. It runs model labelling, then all three arms on `claude-haiku-4-5` (override with `WAYFILE_MODEL`). It writes `bench/results/full-summary.md` and `full.json` with input/output/cache-read/cache-write tokens from each response's `usage`, cost from the price table in `bench/run.js` (docs.claude.com pricing, read 2026-10-13: Haiku 4.5 $1 in, $5 out, $1.25 cache write, $0.10 cache read per MTok), accuracy, median latency, and the GO/NO-GO line computed by the rules above. Note: prompts here are short, so they may fall under the provider's minimum cacheable length, and cache tokens may read 0 for every arm. That would be a measured result, not a bug.

## Deferred until a yes
Real Notify sends (the backend exists behind `WAYFILE_NOTIFY=live`; see docs/NOTIFY.md for the project/accent gap), self-hardening, and an OpenAI adapter.
