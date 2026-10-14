---
kind: script
script: tools/read-policy.mjs
needs: [facts.customer, facts.order, evidence]
sets: [facts.policy, evidence, approval.required, approval.answer]
---
# Read regional policy evidence
Read the customer's regional policy if the order exists. Determine whether a simulated approval checkpoint is needed.

## Routes
- `approval.required == true` → [[approval]]
- otherwise → [[draft]]
