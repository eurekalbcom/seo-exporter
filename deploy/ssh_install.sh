#!/bin/bash
# Install over SSH from the repository root.
# GSC_JSON, BING_JSON, and SSH_KEY arrive in the environment. They are checked
# before this script creates files or starts ssh.
set -euo pipefail
umask 077
unset CDPATH
export PYTHONDONTWRITEBYTECODE=1

GSC_JSON=${GSC_JSON-}
BING_JSON=${BING_JSON-}
SSH_KEY=${SSH_KEY-}
SEO_TARGET_HOST=${SEO_TARGET_HOST-}
SEO_TARGET_HOSTKEY=${SEO_TARGET_HOSTKEY-}

if [[ -z "${SEO_TARGET_HOST}" ]]; then
  printf '%s\n' "target host variable is empty" >&2
  exit 1
fi
if [[ -z "${SEO_TARGET_HOSTKEY}" ]]; then
  printf '%s\n' "target host key variable is empty" >&2
  exit 1
fi
case "${SEO_TARGET_HOST}" in
  *[!A-Za-z0-9._:-]*)
    printf '%s\n' "target host variable is invalid" >&2
    exit 1
    ;;
esac

if [[ -z "${SSH_KEY}" || "${SSH_KEY}" != *[![:space:]]* ]]; then
  printf '%s\n' "ssh key missing" >&2
  exit 1
fi

python3 deploy/require_provider_secrets.py

workdir=$(mktemp -d)
trap 'rm -rf -- "$workdir"' EXIT
keyfile="${workdir}/id"
known="${workdir}/known_hosts"
archive="${workdir}/code.tar.gz"

printf '%s' "$SSH_KEY" | python3 deploy/write_ssh_key.py "${keyfile}"
printf '%s\n' "${SEO_TARGET_HOSTKEY}" > "${known}"
bash deploy/make_archive.sh "${archive}"

python3 deploy/emit_stdin.py "${archive}" \
  3< <(printf '%s' "$GSC_JSON") \
  4< <(printf '%s' "$BING_JSON") |
  env -u GSC_JSON -u BING_JSON -u SSH_KEY \
    -- \
    ssh \
      -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile="${known}" \
      -o IdentitiesOnly=yes \
      -o BatchMode=yes \
      -o PreferredAuthentications=publickey \
      -o PasswordAuthentication=no \
      -o KbdInteractiveAuthentication=no \
      -o PubkeyAuthentication=yes \
      -o ConnectTimeout=20 \
      -o ServerAliveInterval=15 \
      -o LogLevel=ERROR \
      -i "${keyfile}" \
      -- \
      "seo-deploy@${SEO_TARGET_HOST}"
