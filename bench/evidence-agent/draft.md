---
kind: skill
needs: [task.customerId, facts.customer, facts.order, facts.policy, evidence, approval.answer]
sets: [reply.output]
output: json
schema: schemas/reply.json
max_attempts: 2
max_tokens: 800
---
# Draft the evidence-based reply
Apply the shared refund policy to the supplied customer, order, regional policy and approval evidence. Write a short factual JSON reply with the exact versioned sources. No payment or account action has occurred.

## Routes
- otherwise → [[done]]
