#!/bin/bash
# Reject pull_request_target, secret use on the pull_request workflow, a
# deploy job whose first step is not the fail-closed HOLD guard, and a
# deploy workflow that runs on push.
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

deploy="${workflow_dir}/deploy.yml"

if ! awk '
  $0 == "on:" { on = 1; next }
  on && $0 !~ /^[[:space:]]/ && $0 != "" { on = 0 }
  on && $0 ~ /^[[:space:]]+push:/ { bad = 1 }
  END { exit bad ? 1 : 0 }
' "$deploy"; then
  printf '%s\n' "deploy must not run on push" >&2
  exit 1
fi

if ! grep -q '^  workflow_dispatch:' "$deploy"; then
  printf '%s\n' "deploy must be workflow_dispatch" >&2
  exit 1
fi
if ! grep -q 'environment: seo-readonly' "$deploy"; then
  printf '%s\n' "deploy must use the seo-readonly environment" >&2
  exit 1
fi
if ! grep -q 'persist-credentials: false' "$deploy"; then
  printf '%s\n' "deploy checkout must set persist-credentials false" >&2
  exit 1
fi
if ! grep -q 'bash deploy/sha_guard.sh' "$deploy"; then
  printf '%s\n' "deploy must run the sha-guard" >&2
  exit 1
fi
if ! grep -q 'secrets.EUK_SSH_SEO_DEPLOY_W216' "$deploy"; then
  printf '%s\n' "deploy must use the witold216 deploy key" >&2
  exit 1
fi
if grep -q 'EUK_SSH_SEO_DEPLOY_V8QX' "$deploy"; then
  printf '%s\n' "deploy must not use the retired V8QX key" >&2
  exit 1
fi

# shellcheck disable=SC2016 # literals copied from the workflow, not expansions
require_deploy_hold_guard() {
  local deploy_file=$1
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
  done <"$deploy_file"

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

require_deploy_hold_guard "$deploy"
