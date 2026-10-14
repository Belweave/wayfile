---
kind: script
script: scripts/check-flaky.sh
needs: [ci.log]
sets: [test.file, test.flaky]
cache: inputs
cache_files: [scripts/flaky.txt]
---
# Check flaky list
Find the failing test file and check it against the known-flaky list.

## Routes
- `test.flaky == true` → [[quarantine-test]]
- otherwise → [[diagnose]]

```example
input: {"ci": {"log": "FAIL tests/checkout.spec.ts > pays"}}
expect: quarantine-test
```
