#!/bin/bash
# Render the compose file with the placeholder env. Remove a temp env file afterwards.
set -euo pipefail
unset CDPATH

if [[ -z "${SEO_REMOTE_WRITE_PORT:-}" ]]; then
  printf '%s\n' "SEO_REMOTE_WRITE_PORT is required" >&2
  exit 1
fi

root=$(cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
env_dir="${root}/data"
env_file="${env_dir}/.env"
created_file=0
created_dir=0
if [[ ! -f "$env_file" ]]; then
  if [[ ! -d "$env_dir" ]]; then
    mkdir -p "$env_dir"
    created_dir=1
  fi
  cp "${root}/deploy/env.example" "$env_file"
  chmod 600 "$env_file"
  created_file=1
fi
set +e
docker compose --project-directory "$root" --env-file "$env_file" config
status=$?
set -e
if [[ "$created_file" -eq 1 ]]; then
  rm -f -- "$env_file"
fi
if [[ "$created_dir" -eq 1 ]]; then
  rmdir "$env_dir" 2>/dev/null || true
fi
exit "$status"
