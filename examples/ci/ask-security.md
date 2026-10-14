---
kind: ask
ask_kind: approval
needs: [ci.job, ci.log]
sets: [security.approval]
---
# Secret in CI log
A credential appears in a CI log. Approve rotating it and purging the log?

## Routes
- `security.approval == "yes"` → [[rotate-secret]]
- otherwise → [[human-triage]]
