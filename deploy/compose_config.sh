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

password=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')

require_missing() {
  local name=$1
  if [[ ! -s "$stderr" ]]; then
    printf '%s\n' "${name} was not required" >&2
    exit 1
  fi
  local err
  err=$(cat "$stderr")
  case "$err" in
    *"$password"*)
      printf '%s\n' "password leaked" >&2
      exit 1
      ;;
    *"$name"*) ;;
    *)
      printf '%s\n' "${name} was not required" >&2
      exit 1
      ;;
  esac
}

export SEO_REMOTE_WRITE_PASSWORD="$password"
unset SEO_REMOTE_WRITE_PORT
set +e
docker compose --project-directory "$root" --env-file "$env_file" config >/dev/null 2>"$stderr"
status=$?
set -e
if [[ "$status" -eq 0 ]]; then
  printf '%s\n' "SEO_REMOTE_WRITE_PORT default refused" >&2
  exit 1
fi
require_missing SEO_REMOTE_WRITE_PORT

unset SEO_REMOTE_WRITE_PASSWORD
export SEO_REMOTE_WRITE_PORT="$port"
set +e
docker compose --project-directory "$root" --env-file "$env_file" config >/dev/null 2>"$stderr"
status=$?
set -e
if [[ "$status" -eq 0 ]]; then
  printf '%s\n' "SEO_REMOTE_WRITE_PASSWORD default refused" >&2
  exit 1
fi
require_missing SEO_REMOTE_WRITE_PASSWORD
