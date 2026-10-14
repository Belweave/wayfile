---
kind: harness
needs: [task.question, task.conversation, task.development, task.verification]
sets: [task.response]
tools: []
output: json
schema: schemas/response.json
max_turns: 4
max_tokens: 1800
max_attempts: 2
---
# Report the result

Give a concise user-facing summary grounded in the development result and trusted verification record. If development is blocked, return a blocked status and the exact human question. If checks failed after all repair rounds, report blocked and ask what should happen next. If verification is missing, use `unverified`; explain exactly what was missing and do not imply that tests or a build passed. Only use `completed` when the trusted verifier says `passed`. Never claim a publish, push, deployment, or other release action.

Return the strongest useful answer even when some context is missing. Preserve the user's request and prior conversation as context, but current repository evidence and the trusted verification record determine what can be claimed.

## Routes
- otherwise → [[done]]
