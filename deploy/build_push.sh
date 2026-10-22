#!/bin/bash
# Build the exporter image and push it to GHCR. Print only the digest.
set -euo pipefail
umask 077
unset CDPATH

if [[ -z "${GHCR_TOKEN:-}" ]]; then
  printf '%s\n' "registry token missing" >&2
  exit 1
fi
if [[ -z "${IMAGE_REPO:-}" || -z "${DEPLOY_SHA:-}" || -z "${GITHUB_ACTOR:-}" ]]; then
  printf '%s\n' "image build inputs missing" >&2
  exit 1
fi

repo=$(printf '%s' "$IMAGE_REPO" | tr '[:upper:]' '[:lower:]')
case "$repo" in
  ghcr.io/*) ;;
  *)
    printf '%s\n' "image repo refused" >&2
    exit 1
    ;;
esac
if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' "sha refused" >&2
  exit 1
fi

printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin >/dev/null

tag="${repo}:sha-${DEPLOY_SHA}"
docker build --platform linux/amd64 --pull -t "$tag" .

log=$(mktemp)
trap 'rm -f -- "$log"' EXIT
if ! docker push "$tag" >"$log" 2>&1; then
  printf '%s\n' "image push failed" >&2
  exit 1
fi
digest=$(awk '/^digest: sha256:[0-9a-f]{64}$/ {d=$2} END {print d}' "$log")
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  printf '%s\n' "registry digest missing" >&2
  exit 1
fi

out=${IMAGE_DIGEST_FILE:-${RUNNER_TEMP:-/tmp}/seo-image-digest}
printf '%s\n' "$digest" >"$out"
chmod 600 "$out"
printf '%s\n' "image digest: ${digest}"
docker logout ghcr.io >/dev/null || true
