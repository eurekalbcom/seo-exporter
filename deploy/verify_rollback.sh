#!/bin/bash
# When IMAGE_DIGEST is set, require both of these before any SSH deploy:
#   DEPLOY_SHA is an ancestor of the checked-out main branch
#   IMAGE_DIGEST is the registry digest of
#   ghcr.io/eurekalbcom/seo-exporter:sha-$DEPLOY_SHA
# An empty IMAGE_DIGEST is a normal publish, not a rollback.
set -euo pipefail
umask 077
unset CDPATH

if [[ -z "${IMAGE_DIGEST:-}" ]]; then
  exit 0
fi
if [[ -z "${DEPLOY_SHA:-}" || -z "${GHCR_TOKEN:-}" || -z "${GITHUB_ACTOR:-}" ]]; then
  printf '%s\n' "rollback digest rejected" >&2
  exit 1
fi

root=$(cd -- "$(dirname -- "$0")/.." && pwd)
export PYTHONPATH="${root}${PYTHONPATH:+:${PYTHONPATH}}"

python3 -m deploy.rollback_digest check "$IMAGE_DIGEST"
bash "$root/deploy/sha_guard.sh"

ref="ghcr.io/eurekalbcom/seo-exporter:sha-${DEPLOY_SHA}"
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin >/dev/null
inspect=$(mktemp)
err=$(mktemp)
trap 'rm -f -- "$inspect" "$err"; docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

if ! docker buildx imagetools inspect "$ref" >"$inspect" 2>"$err"; then
  if grep -Eq 'unknown command|is not a docker command|buildx: not found' "$err"; then
    if ! docker manifest inspect --verbose "$ref" >"$inspect" 2>"$err"; then
      printf '%s\n' "rollback digest missing" >&2
      exit 1
    fi
  else
    printf '%s\n' "rollback digest missing" >&2
    exit 1
  fi
fi

python3 -m deploy.rollback_digest match "$IMAGE_DIGEST" "$DEPLOY_SHA" "$inspect"
printf '%s\n' "rollback digest: ok"
