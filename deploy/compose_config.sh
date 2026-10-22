#!/bin/bash
# Render the compose file with the placeholder env. Remove a temp .env afterwards.
set -euo pipefail
unset CDPATH

root=$(cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
env_file="${root}/.env"
created=0
if [[ ! -f "$env_file" ]]; then
  cp "${root}/deploy/env.example" "$env_file"
  chmod 600 "$env_file"
  created=1
fi
set +e
docker compose --project-directory "$root" config
status=$?
set -e
if [[ "$created" -eq 1 ]]; then
  rm -f -- "$env_file"
fi
exit "$status"
