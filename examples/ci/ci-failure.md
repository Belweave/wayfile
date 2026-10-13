---
kind: route
entry: true
ordered: true      # security first, then infra, deps, lint, tests
needs: [ci.job, ci.log, ci.files_changed, ci.attempt]
cache: inputs
---
# CI failure
Route a failed CI job to the cheapest correct fix.

## Routes
- `ci.log ~ /AKIA[0-9A-Z]{16}|private key|secret (leaked|detected|exposed)|token leaked/i` → [[ask-security]]
- `ci.log ~ /ETIMEDOUT|ECONNRESET|503 Service Unavailable|rate limit|socket hang up/i && ci.attempt < 3` → [[retry-job]]
- `ci.log ~ /ETIMEDOUT|ECONNRESET|503 Service Unavailable|rate limit|socket hang up/i` → [[human-triage]]
- `ci.log ~ /ERESOLVE|lockfile|integrity checksum|Could not resolve dependency/i` → [[fix-deps]]
- `ci.log ~ /eslint|prettier|lint error/i` → [[autofix-lint]]
- `ci.log ~ /FAIL |AssertionError|Expected:.*Received:/` → [[check-flaky]]
- otherwise → [[human-triage]]

```example
input: {"ci": {"log": "npm ERR! code ERESOLVE", "attempt": 1}}
expect: fix-deps
```

```example
input: {"ci": {"log": "fetch failed: ETIMEDOUT", "attempt": 3}}
expect: human-triage
```
