#!/bin/bash
# Refuse a deploy SHA that is not a full commit on the current main checkout.
set -euo pipefail
unset CDPATH

sha=${DEPLOY_SHA:-}
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' "sha-guard: refuse" >&2
  exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$branch" != "main" ]]; then
  printf '%s\n' "sha-guard: refuse" >&2
  exit 1
fi

if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
  printf '%s\n' "sha-guard: refuse" >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$sha" HEAD; then
  printf '%s\n' "sha-guard: refuse" >&2
  exit 1
fi

printf '%s\n' "sha-guard: ok"
