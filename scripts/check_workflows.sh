#!/bin/bash
# Reject pull_request_target, secret use on the pull_request workflow, and a
# deploy job whose first step is not the fail-closed HOLD guard.
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

# shellcheck disable=SC2016 # literals copied from the workflow, not expansions
require_deploy_hold_guard() {
  local deploy="$1"
  local line in_jobs=0 in_deploy=0 in_steps=0 collecting=0
  local first_name="" body=""
  local -a guard_body=()

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" == "jobs:" ]]; then
      in_jobs=1
      continue
    fi
    if [[ "$in_jobs" -eq 1 && -n "$line" && "$line" != " "* ]]; then
      in_jobs=0
    fi
    if [[ "$in_jobs" -eq 1 && "$line" == "  deploy:" ]]; then
      in_deploy=1
      continue
    fi
    if [[ "$in_deploy" -eq 1 && "$line" == "  "* && "$line" != "   "* ]]; then
      break
    fi
    if [[ "$in_deploy" -eq 1 && "$line" == "    steps:" ]]; then
      in_steps=1
      continue
    fi
    if [[ "$in_steps" -eq 1 && "$line" == "    "* && "$line" != "     "* ]]; then
      break
    fi
    if [[ "$in_steps" -eq 1 && "$line" == "      - name:"* ]]; then
      if [[ -n "$first_name" ]]; then
        break
      fi
      first_name="${line#"      - name: "}"
      collecting=1
      continue
    fi
    if [[ "$collecting" -eq 1 ]]; then
      guard_body+=("$line")
    fi
  done < "$deploy"

  if [[ "$first_name" != "HOLD guard (fail-closed)" ]]; then
    printf '%s\n' "deploy HOLD guard must be the first step" >&2
    exit 1
  fi
  body=$(printf '%s\n' "${guard_body[@]}")
  local needle
  local -a required=(
    'DEPLOY_ENABLED: ${{ vars.SEO_DEPLOY_ENABLED }}'
    'TS_OAUTH: ${{ secrets.EUK_OAUTH_TAILSCALE_SEO_DEPLOY }}'
    'if [ "$DEPLOY_ENABLED" != "true" ]; then echo "HOLD: SEO_DEPLOY_ENABLED != true"; exit 1; fi'
    '[ -n "$TS_OAUTH" ] || { echo "missing Tailscale OAuth secret"; exit 1; }'
  )
  for needle in "${required[@]}"; do
    if [[ "$body" != *"$needle"* ]]; then
      printf '%s\n' "deploy HOLD guard is incomplete" >&2
      exit 1
    fi
  done
  local run_part="${body#*"run: |"}"
  if [[ "$run_part" == "$body" || "$run_part" == *'${{'* || "$run_part" == *'secrets.'* ]]; then
    printf '%s\n' "deploy HOLD guard run script must not reference secrets" >&2
    exit 1
  fi
  if [[ "$run_part" == *"set -x"* || "$run_part" == *'echo "$TS_OAUTH"'* || "$run_part" == *'echo "$DEPLOY_ENABLED"'* ]]; then
    printf '%s\n' "deploy HOLD guard must not trace or echo secret values" >&2
    exit 1
  fi
}

require_deploy_hold_guard "${workflow_dir}/deploy.yml"
