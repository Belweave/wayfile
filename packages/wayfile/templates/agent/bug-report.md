---
kind: skill
skill: bug-summary
needs: [message.text]
sets: [bug.summary]
output: json
schema: schemas/bug-summary.json
max_attempts: 2
---
# Summarise the bug
Turn the message into a bug ticket matching the JSON schema. Keep uncertainty
explicit and include only details supported by the message.

## Routes
- otherwise → [[done]]
