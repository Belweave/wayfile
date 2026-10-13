# How the benchmark labels were made

Goal: labels that come from the written policy, not from the graph that is being scored.

1. The policies were written as prose first: `bench/policy/tickets.md` and `bench/policy/ci.md`. The bash and Eve-style baselines receive exactly this text; Wayfile receives the graphs.
2. Every label in `bench/cases.js` was then assigned by reading the case and the policy text only, with the graph files closed. The CI cases were written and labelled before the CI graph was run on them.
3. The ticket labels from the first round (`legacy` in `cases.js`) were kept, so agreement between the two rounds is reported by `bench/label.js`.
4. Limit: the same agent wrote the policy, the graph and the labels, so this reduces same-author bias but does not remove it. Some CI cases are deliberate paraphrases ("connection dropped", "flake8 complained") that a reader of the policy routes correctly but the graph's regexes may not.
5. With `ANTHROPIC_API_KEY` set, `node bench/label.js` asks the model to label every case from the policy text alone (no graph, no existing labels shown) and reports its agreement with the hand labels and the legacy labels. Disagreements are listed for a human to settle; no label is changed automatically.
