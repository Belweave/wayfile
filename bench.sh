#!/usr/bin/env bash
# Tests, graph checks, local contracts, then a versioned routing experiment.
set -euo pipefail
cd "$(dirname "$0")"
node --test --test-concurrency=2 test/*.test.js
node packages/wayfile/bin/wayfile.js check examples/triage
node packages/wayfile/bin/wayfile.js check examples/ci
node bench/evaluate-local.js
node -e "import('./bench/cases.js').then(({tickets})=>console.log('hand vs legacy ticket labels:', tickets.filter(t=>t.expect===t.legacy).length+'/'+tickets.length))"
if [ -n "${OPENROUTER_API_KEY:-}${ANTHROPIC_API_KEY:-}" ]; then
  echo "model key: present (OpenRouter preferred); OpenRouter cost guard \$${WAYFILE_MAX_USD:-3} on cumulative spend; unavailable account costs remain unknown"
  node bench/run.js "$@"
else
  echo "model key: absent -> local/dry evidence only; actual Eve and unseen quality remain unmeasured"
  node bench/run.js --dry "$@"
fi
