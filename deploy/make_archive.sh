#!/bin/bash
# Build the code archive that the deploy payload carries. No credentials.
set -euo pipefail
umask 077
unset CDPATH

if [[ $# -ne 1 ]]; then
  printf '%s\n' "usage: make_archive.sh DEST" >&2
  exit 2
fi

dest=$1
root=$(cd -- "$(dirname -- "$0")/.." && pwd) || exit 1

tar --sort=name \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  -C "$root" \
  -czf "$dest" \
  seo_exporter \
  deploy \
  pyproject.toml \
  README.md \
  SECURITY.md
