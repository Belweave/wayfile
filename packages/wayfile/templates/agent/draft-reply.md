---
kind: skill
skill: reply-style
needs: [message.text, order.status]
sets: [reply.text]
---
# Draft a reply
Write the reply to the message. If an order status is present, mention it.

## Routes
- otherwise → [[done]]
