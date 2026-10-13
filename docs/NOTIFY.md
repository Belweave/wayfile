# ask nodes and Notify

`ask` nodes are **stubbed by default**: the answer comes from `state.stub.ask` (default `yes`) and nothing leaves the box. The benchmark and every test use the stub or a mock `fetch`. No real phone prompt has been sent.

Live mode is opt-in: `WAYFILE_NOTIFY=live NOTIFY_TOKEN=... wayfile run <dir> <input>`. It translates the user-notify MCP `interactions_create` flow into Notify's REST API (notify.belweave.ai/openapi.json, servers `/api/agent`, bearer token):
1. `POST /interactions` with header `Idempotency-Key: wayfile-<node>-<sha256(node file, needs values)[:24]>` and body `{title, prompt, kind, expiresInSeconds}`. `kind` comes from frontmatter `ask_kind` (default `approval`); the prompt is the node body plus its `needs` values.
2. `GET /interactions/{id}/wait?timeout=25` until it is no longer pending or expires. `approved`/`yes` → `yes`, `denied`/`no` → `no`, `replied` → the reply text, `expired`/`canceled` → `timeout`.
The token needs `interactions:create`, `notifications:send` and `interactions:read`.

**Gap:** the published `POST /interactions` schema has no project or accent field (`project` exists only on `POST /notifications`; `accentColor` only on apps). So project "Chief Engineer" and the bright accent (`#FF3D7F`) are carried in the request config but **not sent**. To get them, either Notify adds them to interactions, or the node also posts a `/notifications` card with `project`.
