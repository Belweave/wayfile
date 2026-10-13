---
kind: judge
entry: true
needs: [ticket.body, ticket.amount]
sets: [ticket.class]
cache: inputs
ordered: true       # first match wins: big refunds go to a human first
---
# Triage ticket
Classify an inbound support ticket. Refunds over $500 always need a human.

## Routes
- `ticket.amount > 500 && ticket.body ~ /refund|chargeback|money back/i` → [[ask-approval]]
- `ticket.body ~ /refund|chargeback|money back/i` → [[lookup-order]]
- `ticket.body ~ /password|log ?in|2fa|locked out/i` → [[account-help]]
- judge: "is this a bug report with steps to reproduce?" → [[bug-intake]]
- otherwise → [[general-reply]]

```example
input: {"ticket": {"body": "please refund order 22", "amount": 40}}
expect: lookup-order
```

```example
input: {"ticket": {"body": "refund order 9", "amount": 900}}
expect: ask-approval
```

```example
input: {"ticket": {"body": "app crashes: open settings, tap export", "amount": 0}}
judge: bug-intake
expect: bug-intake
```
