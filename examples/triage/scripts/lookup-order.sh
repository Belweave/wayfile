#!/usr/bin/env bash
# stdin: state JSON. stdout: {"set": {...}}. Fake order DB: even ids delivered, odd ids shipped.
set -euo pipefail
id=$(jq -r '.ticket.body' | grep -oiE 'order #?[0-9]+' | grep -oE '[0-9]+' | head -1 || true)
if [ -z "$id" ]; then status=not_found; elif [ $((id % 2)) -eq 0 ]; then status=delivered; else status=shipped; fi
jq -nc --arg s "$status" '{set: {"order.status": $s}}'
