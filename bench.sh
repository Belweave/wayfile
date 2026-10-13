#!/usr/bin/env bash
# Runs everything: tests, graph checks, labelling agreement, benchmark. Writes bench/results/*-summary.md.
set -euo pipefail
cd "$(dirname "$0")"
npm test --silent
node bin/wayfile.js check examples/triage
node bin/wayfile.js check examples/ci
node -e "import('./bench/cases.js').then(({tickets})=>console.log('hand vs legacy ticket labels:', tickets.filter(t=>t.expect===t.legacy).length+'/'+tickets.length))"
if [ -n "${OPENROUTER_API_KEY:-}${ANTHROPIC_API_KEY:-}" ]; then
  echo "model key: present (OpenRouter preferred); cost guard \$${WAYFILE_MAX_USD:-3} on cumulative spend in bench/results/spend.json"
  node bench/label.js
  node bench/run.js
else
  echo "model key: absent -> dry run only (no token numbers); the key is the only blocker for the full run"
  node bench/run.js --dry
fi
