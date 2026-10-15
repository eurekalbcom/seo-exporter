#!/bin/bash
# Forced command for the seo-deploy user. The payload arrives on stdin and is not logged.
set -euo pipefail
umask 077
unset SSH_ORIGINAL_COMMAND PYTHONPATH PYTHONHOME LD_PRELOAD LD_LIBRARY_PATH CDPATH
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"
export PYTHONDONTWRITEBYTECODE=1

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' "seo-exporter install: root required" >&2
  exit 1
fi

self=$(readlink -f -- "$0")
here=$(cd -- "$(dirname -- "$self")" && pwd) || exit 1
exec python3 "$here/install.py"
