# Wayfile MVP: go/no-go (2026-10-13, measured)

**Decision: NO-GO by the letter of the gate, by one case.** Wayfile used 12.9× fewer tokens than bash/ReAct and 18.4× fewer than Eve-style. But it scored 68/70, and both baselines scored 69/70. The GO rule needs "at equal or better accuracy".

Full table: docs/bench-2026-10-13.md. Model: anthropic/claude-haiku-5.5 on OpenRouter for the judge, both baselines and the labeller. All 643 responses in the run reported `model: anthropic/claude-haiku-5.5`. Tokens and cost come from each response's `usage` (cost = OpenRouter `usage.cost`).

| Criterion | Result |
|---|---|
| ≥5× fewer tokens than both baselines | yes: 7,189 vs 93,027 (bash) and 132,186 (Eve-style) |
| at ≥ accuracy | **no: 68/70 vs 69/70 and 69/70** |
| Kill: bash within 3× | no (12.9×) |
| Kill: >40% of nodes call the model | no (2/18 = 11%; 22% of routing steps) |

## Why Wayfile lost two cases
Both are the deliberate paraphrases in the CI set ("connection dropped", "flake8 complained"). No regex route matched, there is no judge on the entry node, and `otherwise` sent them to human-triage. The baselines read the prose policy and got both right. Each baseline missed ci20 (out-of-memory → human-triage) by returning no parseable route. The fix is cheap: a judge on the CI entry node's fallback would cost about 1 call on 2 of 20 CI cases. It isn't applied here, because tuning the graph after seeing the test set would bias the result. Re-run on fresh cases if it's adopted.

## Labels
The model labelled all 70 cases from the policy text alone and agreed with the hand labels 70/70 (and with the legacy ticket labels 50/50).
