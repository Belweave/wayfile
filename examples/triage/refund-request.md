---
kind: route
needs: [ticket.amount]
ordered: true
---
# Check refund amount
Only a known, nonnegative numeric amount can proceed. Refunds over $500 need
approval. If the amount is missing or invalid, ask for clarification through
the general reply rather than assuming the refund is small.

## Routes
- `ticket.amount > 500` → [[ask-approval]]
- `ticket.amount >= 0 && ticket.amount <= 500` → [[lookup-order]]
- otherwise → [[general-reply]]

```example
input: {"ticket": {"amount": 500}}
expect: lookup-order
```

```example
input: {"ticket": {"amount": 500.01}}
expect: ask-approval
```

```example
input: {"ticket": {}}
expect: general-reply
```

```example
input: {"ticket": {"amount": "40"}}
expect: general-reply
```
