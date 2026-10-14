---
kind: harness
needs: [task.development, task.repairs_remaining]
sets: [task.verification]
tools: []
output: json
schema: schemas/verification.json
max_turns: 1
max_tokens: 1200
max_attempts: 1
max_visits: 6
---
# Independent project verification

This graph node is evaluated by Wayfile's trusted host verifier, not by the model. Its JSON output records the selected lockfile/package manager, package scripts that actually ran, exit status, bounded output, optional loopback URL result, and remaining repair rounds. A missing supported lockfile or missing package scripts is `missing`, never `passed`.

## Routes
- `task.verification.status == "passed"` → [[respond]]
- `task.verification.status == "failed" && task.verification.repairs_remaining > 0` → [[develop]]
- otherwise → [[respond]]
