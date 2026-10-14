---
entry: true
kind: script
script: tools/read-customer.mjs
needs: [task.customerId, task.approval]
sets: [facts.customer, evidence]
---
# Read customer evidence
Read the named customer record and its versioned source.

## Routes
- otherwise → [[order]]
