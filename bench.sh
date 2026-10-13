#!/usr/bin/env bash
# Runs everything: tests, graph checks, labelling agreement, benchmark. Writes bench/results/*-summary.md.
set -euo pipefail
cd "$(dirname "$0")"
npm test --silent
node bin/wayfile.js check examples/triage
node bin/wayfile.js check examples/ci
node -e "import('./bench/cases.js').then(({tickets})=>console.log('hand vs legacy ticket labels:', tickets.filter(t=>t.expect===t.legacy).length+'/'+tickets.length))"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY: present"
  node bench/label.js
  node bench/run.js
else
  echo "ANTHROPIC_API_KEY: absent -> dry run only (no token numbers); the key is the only blocker for the full run"
  node bench/run.js --dry
fi
