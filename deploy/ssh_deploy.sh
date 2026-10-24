#!/bin/bash
# Deploy the pinned image over SSH.
# Secrets arrive in the environment and are checked before any temp file or SSH.
set -euo pipefail
umask 077
unset CDPATH
export PYTHONDONTWRITEBYTECODE=1

SEO_TARGET_HOST=${SEO_TARGET_HOST-}
SEO_TARGET_HOSTKEY=${SEO_TARGET_HOSTKEY-}
SSH_KEY=${SSH_KEY-}

if [[ -z "$SEO_TARGET_HOST" ]]; then
  printf '%s\n' "target host variable is empty" >&2
  exit 1
fi
if [[ -z "$SEO_TARGET_HOSTKEY" ]]; then
  printf '%s\n' "target host key variable is empty" >&2
  exit 1
fi
case "$SEO_TARGET_HOST" in
  *[!A-Za-z0-9._:-]*)
    printf '%s\n' "target host variable is invalid" >&2
    exit 1
    ;;
esac
if [[ -z "$SSH_KEY" || "$SSH_KEY" != *[![:space:]]* ]]; then
  printf '%s\n' "ssh key missing" >&2
  exit 1
fi

# One known_hosts line. A trailing CR/LF is stripped. Another line, or an
# OpenSSH certificate-authority / revocation marker, is refused before any
# temp file or secret check.
hostkey=$SEO_TARGET_HOSTKEY
if [[ "$hostkey" == *$'\r\n' ]]; then
  hostkey=${hostkey%$'\r\n'}
elif [[ "$hostkey" == *$'\n' ]]; then
  hostkey=${hostkey%$'\n'}
elif [[ "$hostkey" == *$'\r' ]]; then
  hostkey=${hostkey%$'\r'}
fi
case "$hostkey" in
  *$'\n'* | *$'\r'* | "")
    printf '%s\n' "target host key variable is invalid" >&2
    exit 1
    ;;
esac
hostkey_lower=$(printf '%s' "$hostkey" | tr '[:upper:]' '[:lower:]')
case "$hostkey_lower" in
  *"@cert-authority"* | *"@revoked"*)
    printf '%s\n' "target host key variable is invalid" >&2
    exit 1
    ;;
esac
SEO_TARGET_HOSTKEY=$hostkey

python3 -m deploy.envfile check

workdir=$(mktemp -d)
trap 'rm -rf -- "$workdir"' EXIT
keyfile="${workdir}/id"
known="${workdir}/known_hosts"
envfile="${workdir}/env"

printf '%s' "$SSH_KEY" | python3 deploy/write_ssh_key.py "$keyfile"
printf '%s\n' "$hostkey" >"$known"
chmod 600 "$known"
python3 -m deploy.envfile write "$envfile"

remote() {
  local command=$1
  local stdin_file=$2
  env -u GSC_JSON -u BING_JSON -u SSH_KEY -u GSC_SITE -u BING_SITE \
    -u SEO_REMOTE_WRITE_PASSWORD \
    -- ssh \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$known" \
    -o GlobalKnownHostsFile=/dev/null \
    -o UpdateHostKeys=no \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    -o PreferredAuthentications=publickey \
    -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no \
    -o PubkeyAuthentication=yes \
    -o ConnectTimeout=20 \
    -o ServerAliveInterval=15 \
    -o LogLevel=ERROR \
    -i "$keyfile" \
    -- \
    "seo-deploy@${SEO_TARGET_HOST}" \
    "$command" <"$stdin_file"
}

remote "docker compose pull" "$envfile"
remote "docker compose up -d" /dev/null
remote "docker compose ps" /dev/null
