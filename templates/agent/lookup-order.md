---
kind: script
script: tools/lookup-order.mjs
needs: [message.text]
sets: [order.status]
cache: inputs
---
# Look up the order
A tool: reads state JSON on stdin, prints {"set": {...}} on stdout.

## Routes
- otherwise → [[draft-reply]]
