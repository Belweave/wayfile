---
kind: harness
entry: true
needs: [question]
sets: [report]
tools: [list-files, read-file, search-files]
max_turns: 6
max_tool_calls: 6
max_tokens: 1000
output: json
schema: schemas/report.json
---
# Inspect the fixture
Answer the supplied question using files under fixtures/. Read the source
before making a claim. Do not infer facts from filenames or from this task's
wording. Return a small report matching the schema: each fact needs a relative
file path and an exact source excerpt. List questions that the fixture does
not answer in unknowns. If no facts are supported, return an empty facts array
and explain what is missing in unknowns.

## Routes
- otherwise → [[done]]
