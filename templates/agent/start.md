---
kind: judge
entry: true
needs: [message.text]
sets: [message.kind]
cache: inputs
---
# Read the message
Sort an inbound message. Cheap regex routes first; the model is asked only when none match.

## Routes
- `message.text ~ /unsubscribe|stop emailing/i` → [[unsubscribe]]
- `message.text ~ /order #?\d+/i` → [[lookup-order]]
- judge: "is the sender reporting a bug in the product?" → [[bug-report]]
- otherwise → [[draft-reply]]

```example
input: {"message": {"text": "where is order #12?"}}
expect: lookup-order
```
