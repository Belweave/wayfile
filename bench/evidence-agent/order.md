---
kind: script
script: tools/read-order.mjs
needs: [facts.customer, evidence]
sets: [facts.order, evidence]
---
# Read order evidence
Read the order named by the customer record.

## Routes
- otherwise → [[policy]]
