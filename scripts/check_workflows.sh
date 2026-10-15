#!/bin/bash
# Reject pull_request_target and secret use on the pull_request workflow.
set -euo pipefail
unset CDPATH

root=$(cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
workflow_dir="${root}/.github/workflows"
found=0

while IFS= read -r -d '' file; do
  if grep -n 'pull_request_target' "$file"; then
    found=1
  fi
done < <(find "$workflow_dir" -type f \( -name '*.yml' -o -name '*.yaml' \) -print0)

if [[ "$found" -ne 0 ]]; then
  printf '%s\n' "pull_request_target is forbidden" >&2
  exit 1
fi

ci="${workflow_dir}/ci.yml"
if grep -nE '^[[:space:]]*environment:' "$ci"; then
  printf '%s\n' "ci workflow must not set an environment" >&2
  exit 1
fi
if grep -n 'secrets\.' "$ci"; then
  printf '%s\n' "ci workflow must not reference secrets" >&2
  exit 1
fi
