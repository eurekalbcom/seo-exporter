#!/bin/bash
# Validate compose structure without a receiver port, then require the port.
set -euo pipefail
unset CDPATH

root=$(cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
env_dir="${root}/data"
env_file="${env_dir}/.env"
stderr=$(mktemp)
created_file=0
created_dir=0

cleanup() {
  rm -f -- "$stderr"
  if [[ "$created_file" -eq 1 ]]; then
    rm -f -- "$env_file"
  fi
  if [[ "$created_dir" -eq 1 ]]; then
    rmdir "$env_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ ! -f "$env_file" ]]; then
  if [[ ! -d "$env_dir" ]]; then
    mkdir -p "$env_dir"
    created_dir=1
  fi
  cp "${root}/deploy/env.example" "$env_file"
  chmod 600 "$env_file"
  created_file=1
fi

docker compose --project-directory "$root" --env-file "$env_file" config --no-interpolate >/dev/null

set +e
env -u SEO_REMOTE_WRITE_PORT docker compose --project-directory "$root" --env-file "$env_file" config >/dev/null 2>"$stderr"
status=$?
set -e
if [[ "$status" -eq 0 ]]; then
  printf '%s\n' "SEO_REMOTE_WRITE_PORT default refused" >&2
  exit 1
fi
if ! grep -q 'SEO_REMOTE_WRITE_PORT' "$stderr"; then
  cat "$stderr" >&2
  printf '%s\n' "SEO_REMOTE_WRITE_PORT was not required" >&2
  exit 1
fi
