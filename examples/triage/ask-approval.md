---
kind: ask
needs: [ticket.amount]
sets: [approval]
---
# Ask for refund approval
Large refund. Ask Preetham to approve (stubbed locally; no Notify push).

## Routes
- `approval == "yes"` → [[lookup-order]]
- otherwise → [[general-reply]]
