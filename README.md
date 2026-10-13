# wayfile

Markdown-native agent router. One file per node, deterministic routes compiled to JSONLogic, the model is called only at `judge:` forks. Zero dependencies (Node ≥ 20; example script uses bash + jq).

```sh
node bin/wayfile.js check examples/triage
node bin/wayfile.js explain examples/triage '{"ticket":{"body":"refund order 22","amount":40}}'
node bin/wayfile.js mermaid examples/triage
node bin/wayfile.js diff examples/triage HEAD
npm test
./bench.sh          # tests, checks, labels, benchmark → bench/results/*-summary.md
```

Examples: `examples/triage` (support tickets) and `examples/ci` (CI-failure fix routing). Benchmark: `bench/` (cases, policies, bash and Eve-style baselines; see bench/LABELING.md).

Judge forks call Anthropic when `ANTHROPIC_API_KEY` is set (`WAYFILE_MODEL`, default `claude-haiku-4-5`); without it they take `otherwise` and are not memoized. Tokens are read from the API `usage` field only.

**Node:** frontmatter `kind` (route|judge|script|ask|end), `entry`, `needs`, `sets`, `cache: inputs`, `script`, `max_visits`, `ordered`. Routes under `## Routes`:
- `` `path OP literal` `` (OP: `> >= < <= == !=`), `` `path ~ /re/i` ``, `` `path exists` ``, joined with `&&`
- `judge: "question"` and a final `otherwise`.

`example` blocks (`input:` JSON, `expect:` node, optional `judge:` stub) run as tests in `check`. Scripts read state JSON on stdin and print `{"set": {...}, "next"?}`; only declared `sets` are written. `ask` nodes are a local stub (answer from `state.stub.ask`, default `yes`). `WAYFILE_NOTIFY=live` + `NOTIFY_TOKEN` switches to a real Notify prompt; see docs/NOTIFY.md.

Memo cache: `<graph>/.wayfile/cache`, key = sha256(node file, script file, `needs` values). Traces: `<graph>/runs/*.md`.
