---
kind: route
needs: [ci.attempt]
ordered: true
---
# Check retry limit
Retry only for an explicitly supplied numeric attempt of 1 or 2. Missing,
invalid or exhausted attempt counts need human triage.

## Routes
- `ci.attempt == 1` → [[retry-job]]
- `ci.attempt == 2` → [[retry-job]]
- otherwise → [[human-triage]]

```example
input: {"ci": {"attempt": 1}}
expect: retry-job
```

```example
input: {"ci": {"attempt": 3}}
expect: human-triage
```

```example
input: {"ci": {"attempt": "1"}}
expect: human-triage
```

```example
input: {"ci": {}}
expect: human-triage
```
