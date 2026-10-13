# wayfile

Build an agent as a folder of Markdown files. Routes between steps are deterministic predicates; the model is called only at `judge:` forks and `skill` nodes. Zero dependencies, no native code. Needs Node ≥ 20.

## 5-minute quickstart (macOS)

```sh
# 1. Node 20+ (skip if `node -v` already prints v20 or later)
brew install node

# 2. Install the CLI from a clone (the package isn't on npm)
git clone git@github.com:Belweave/wayfile.git && cd wayfile
npm install -g .            # or: npm pack && npm install -g ./wayfile-0.2.0.tgz
cd ..

# 3. Scaffold an agent and lint it
wayfile init my-agent
wayfile check my-agent

# 4. Run a deterministic path (no model, no key needed)
wayfile explain my-agent --input '{"message":{"text":"please unsubscribe me"}}'

# 5. Add a model and run the full example
export OPENROUTER_API_KEY=...          # from openrouter.ai/keys
wayfile run my-agent --input my-agent/input.json
wayfile mermaid my-agent               # paste into mermaid.live to see the graph
```

The install is about 100 KB. Run state lives in `my-agent/.wayfile/` (memo cache) and `my-agent/runs/` (Markdown traces); delete them any time.

## An agent folder (compare with Eve)
| Eve | wayfile |
|---|---|
| `instructions.md` (always on) | `AGENT.md`: always-on instructions, sent with every model call |
| `tools/*.ts` | `tools/*`: any executable (`.mjs`, `.sh`, `.py`). It reads state JSON on stdin and prints `{"set": {...}, "next"?: "node"}`. Wire it up with a `kind: script` node and `script: tools/x.mjs`. Only the keys in `sets` are kept, and raw output never reaches the model. |
| `skills/*.md` loaded when the model chooses | `skills/*.md` loaded by a `kind: skill` node with `skill: name`. One model call; the reply goes into the first `sets` key. |
| model loop picks every step | each node's `## Routes` list picks the next step; the model only answers `judge:` forks with a fixed set of targets |

## Node format
```markdown
---
kind: judge           # route | judge | script | skill | ask | end
entry: true           # exactly one entry node
needs: [message.text] # state keys read (also the memo key and what the model sees)
sets: [message.kind]  # state keys written
cache: inputs         # memoize on hash(file, script, needs values)
---
# Title
Body: what this step does (the model's instructions for judge/skill nodes).

## Routes
- `message.text ~ /unsubscribe/i` → [[unsubscribe]]
- judge: "is this a bug report?" → [[bug-report]]
- otherwise → [[draft-reply]]
```
Predicates are `path OP literal` (`> >= < <= == !=`), `path ~ /re/flags` or `path exists`, joined with `&&`. The first match wins. `example` blocks (`input:` JSON, `expect:` node, optional `judge:` stub) run as tests in `wayfile check`. Other frontmatter: `max_visits`, `ordered: true` (silences the ambiguous-fork warning), `max_tokens` (skill), `ask_kind` (ask).

## Commands
`init <dir>`, `check <dir>`, `run <dir> --input <json|file>`, `explain <dir> --input …`, `mermaid <dir>`, `diff <dir> [git-ref]`.

**Model:** OpenRouter via `OPENROUTER_API_KEY`, default `anthropic/claude-haiku-5.5` (`WAYFILE_MODEL` to change). `ANTHROPIC_API_KEY` is used only if no OpenRouter key is set. Token counts and cost come from the response `usage`.

**ask nodes:** stubbed. The answer comes from `state.stub.ask`, default `yes`. `WAYFILE_NOTIFY=live` plus `NOTIFY_TOKEN` sends a real Notify prompt; see docs/NOTIFY.md.

## Repo
`examples/` (support triage, CI-failure routing), `bench/` (`./bench.sh`: Wayfile vs bash/ReAct vs Eve-style, measured tokens and cost; results in docs/bench-2026-10-13.md, decision in docs/GO-NO-GO.md), `npm test`.
