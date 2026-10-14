---
description: "Confirmed transient transport/upstream failure: timeouts, resets, temporary upstream unavailability, rate limits, dropped connections."
---
Require affirmative evidence that a transient transport/upstream problem is the primary failure. Resource/capacity/quota exhaustion, process termination, local runtime/build errors, permanent configuration/authentication problems and unknown failures need human-triage. Incidental network text does not establish a transient primary cause.
Only numeric integer attempt 1 or 2 → retry-job. Missing, invalid, or any other attempt → human-triage.
