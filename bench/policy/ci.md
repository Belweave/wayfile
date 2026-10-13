# CI failure policy

Route each failed CI job to exactly one outcome: rotate-secret, retry-job, fix-deps, autofix-lint, quarantine-test, fix-code, human-triage.
Apply the first rule that fits.

1. If the log exposes a credential (an AWS key, a private key, a leaked token or secret), a human must approve rotation. For this benchmark, assume approval → rotate-secret.
2. Transient network or infrastructure errors (timeouts, connection resets, 503s, rate limits, dropped sockets): retry-job if this was attempt 1 or 2; from attempt 3 on → human-triage.
3. Dependency resolution or lockfile errors → fix-deps.
4. Lint or formatting failures → autofix-lint.
5. A failing test: if the test file is on the known-flaky list (tests/checkout.spec.ts, tests/upload-retry.spec.ts, src/clock.test.ts) → quarantine-test. Otherwise, if the failure was caused by the files changed in this PR → fix-code; if not → human-triage.
6. Anything else → human-triage.
