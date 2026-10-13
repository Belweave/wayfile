---
kind: judge
needs: [ci.log, ci.files_changed, test.file]
sets: [ci.cause]
cache: inputs
---
# Diagnose test failure
A non-flaky test failed. Decide whether this PR's changed files caused it.

## Routes
- judge: "was the failure caused by the files changed in this PR?" → [[fix-code]]
- otherwise → [[human-triage]]

```example
input: {"ci": {"log": "FAIL src/cart.test.ts", "files_changed": ["src/cart.ts"]}, "test": {"file": "src/cart.test.ts"}}
judge: fix-code
expect: fix-code
```
