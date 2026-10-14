# Human decisions with Notify

An `ask` node requires an approval backend. For a local test, pass `state.stub.ask` explicitly (`"yes"` or `"no"`); the runner never invents an approval. Test responses send no network requests and are recorded as stubs. The benchmark supplies its own simulated approval backend.

```sh
WAYFILE_NOTIFY=live wayfile run my-agent --input input.json
```

Set `NOTIFY_TOKEN` locally first. Live mode uses [Notify's decision API](https://notify.belweave.ai/docs/ask-decision) and requires `interactions:create`, `notifications:send`, and `interactions:read`. It sends the node body and only the state fields in `needs`, so include the task identity, requested action, amount, and evidence that the person needs to decide.

1. `POST /api/agent/interactions` creates an approval, yes/no question, or written reply. The body contains `title`, `prompt`, `kind`, and `expiresInSeconds`.
2. `GET /api/agent/interactions/{id}/wait?timeout=25` waits for the decision. Approved/yes maps to `yes`; denied/no maps to `no`; a written reply is returned as text; expired/canceled maps to `timeout`.
3. Each ask invocation gets a fresh approval scope. The idempotency key is stable for that invocation, rather than reusing a previous person's answer on a repeated task. Ask nodes are never memoized.

A created or queued prompt is not a human answer. Unknown statuses and malformed replies fail explicitly. Approval prompts above the API's 2,000-character limit are rejected so evidence cannot disappear through truncation. Every approval node should route denial and timeout to a safe outcome.

The current adapter waits in the running process; restart/resume and verified reply-webhook handling are future work. The API's interaction schema does not accept the local `project` or `accent` configuration, so the adapter does not send those fields. See the [published API contract](https://notify.belweave.ai/openapi.json).

## Reviewed rule improvement

Notify is also the planned review surface for rule proposals. A proposal must include the exact graph diff, supporting traffic, counterexamples, replay results, and the hash of the proposed change. A human decision can approve that particular change; it does not prove the rule is correct. Promotion still needs a passing quality gate and a reviewable commit. The initial implementation improves decision integrity and traces; automatic rule proposal and promotion are on the [design roadmap](DESIGN.md).
