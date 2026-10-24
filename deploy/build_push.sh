#!/bin/bash
# Build the exporter image and push it to GHCR. Print only the digest.
# The repository is fixed. A push log line looks like
# "<tag>: digest: sha256:… size: N", which a line-anchored digest match misses.
# RepoDigests from docker image inspect must agree with that line.
set -euo pipefail
umask 077
unset CDPATH

repo=ghcr.io/eurekalbcom/seo-exporter

if [[ -z "${GHCR_TOKEN:-}" ]]; then
  printf '%s\n' "registry token missing" >&2
  exit 1
fi
if [[ -z "${IMAGE_REPO:-}" || -z "${DEPLOY_SHA:-}" || -z "${GITHUB_ACTOR:-}" ]]; then
  printf '%s\n' "image build inputs missing" >&2
  exit 1
fi

lowered=$(printf '%s' "$IMAGE_REPO" | tr '[:upper:]' '[:lower:]')
if [[ "$lowered" != "$repo" ]]; then
  printf '%s\n' "image repo refused" >&2
  exit 1
fi
if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' "sha refused" >&2
  exit 1
fi

printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin >/dev/null
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

tag="${repo}:sha-${DEPLOY_SHA}"
docker build --platform linux/amd64 --pull -t "$tag" .

log=$(mktemp)
inspect=$(mktemp)
trap 'rm -f -- "$log" "$inspect"; docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
if ! docker push "$tag" >"$log" 2>&1; then
  printf '%s\n' "image push failed" >&2
  exit 1
fi
if ! docker image inspect --format '{{json .RepoDigests}}' "$tag" >"$inspect"; then
  printf '%s\n' "registry digest missing" >&2
  exit 1
fi
digest=$(python3 -m deploy.image_digest "$log" "$inspect")

out=${IMAGE_DIGEST_FILE:-${RUNNER_TEMP:-/tmp}/seo-image-digest}
printf '%s\n' "$digest" >"$out"
chmod 600 "$out"
printf '%s\n' "image digest: ${digest}"
