---
kind: script
script: scripts/lookup-order.sh
needs: [ticket.body]
sets: [order.status]
cache: inputs
---
# Look up order
Find the order referenced in the ticket and record its status.

## Routes
- `order.status == "not_found"` → [[general-reply]]
- otherwise → [[refund]]

```example
input: {"ticket": {"body": "refund order 22"}}
expect: refund
```

```example
input: {"ticket": {"body": "refund please"}}
expect: general-reply
```
