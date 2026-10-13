#!/usr/bin/env bash
# stdin: state JSON. stdout: {"set": {"test.file": ..., "test.flaky": bool}}.
set -euo pipefail
file=$(jq -r '.ci.log' | grep -oE 'FAIL [^ ]+' | head -1 | cut -d' ' -f2 || true)
flaky=false
if [ -n "$file" ] && grep -qxF "$file" "$(dirname "$0")/flaky.txt"; then flaky=true; fi
jq -nc --arg f "$file" --argjson k "$flaky" '{set: {"test.file": $f, "test.flaky": $k}}'
