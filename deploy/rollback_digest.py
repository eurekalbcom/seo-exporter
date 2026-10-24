"""Check a rollback digest against the image tag for one commit.

The tag is ``ghcr.io/eurekalbcom/seo-exporter:sha-<40 hex>``. A reference to
any other repository is rejected before the registry is contacted. The
inspect text is the ``docker buildx imagetools inspect`` report, or a
single-manifest ``docker manifest inspect --verbose`` object.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ALLOWED_REPO = "ghcr.io/eurekalbcom/seo-exporter"
_HEX = re.compile(r"^sha256:[0-9a-f]{64}$")
_SHA = re.compile(r"^[0-9a-f]{40}$")
_FULL = re.compile(rf"^{re.escape(ALLOWED_REPO)}@sha256:[0-9a-f]{{64}}$")


class RollbackError(ValueError):
    """A rollback digest failed a closed check."""


def canonical_digest(raw: str) -> str:
    """Return ``sha256:`` plus 64 hex characters, or reject the reference.

    Args:
        raw: ``sha256:`` hex, or ``ghcr.io/eurekalbcom/seo-exporter@sha256:`` hex.

    Returns:
        The lowercase digest.

    Raises:
        RollbackError: The value is empty, tagged, or from another repository.
    """
    value = raw.strip().lower()
    if _HEX.fullmatch(value):
        return value
    if _FULL.fullmatch(value):
        return value.split("@", 1)[1]
    raise RollbackError("rollback digest rejected")


def tag_for(sha: str) -> str:
    """Return the GHCR tag that publish creates for ``sha``.

    Args:
        sha: Full commit id.

    Returns:
        ``ghcr.io/eurekalbcom/seo-exporter:sha-<sha>``.

    Raises:
        RollbackError: ``sha`` is not 40 lowercase hex characters.
    """
    if not _SHA.fullmatch(sha):
        raise RollbackError("rollback digest rejected")
    return f"{ALLOWED_REPO}:sha-{sha}"


def _digest_field(value: object) -> str:
    if not isinstance(value, dict):
        return ""
    raw = value.get("digest")
    if not isinstance(raw, str):
        raw = value.get("Digest")
    if not isinstance(raw, str):
        return ""
    return raw.strip().lower()


def _name_field(parsed: dict[str, object]) -> str:
    for key in ("name", "Name", "Ref"):
        raw = parsed.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return ""


def digest_from_inspect(text: str, sha: str) -> str:
    """Return the tag digest from an inspect report.

    Args:
        text: imagetools text or manifest-inspect JSON.
        sha: Commit id that the tag must name.

    Returns:
        ``sha256:`` plus 64 hex characters.

    Raises:
        RollbackError: The report is not the tag for ``sha``.
    """
    expected = tag_for(sha)
    stripped = text.strip()
    if not stripped:
        raise RollbackError("rollback digest missing")
    if stripped[0] in "[{":
        return _from_json(stripped, expected)
    return _from_text(stripped, expected)


def _from_text(text: str, expected: str) -> str:
    name = ""
    digest = ""
    for line in text.splitlines():
        if line.startswith("Manifests:"):
            break
        if line.startswith("Name:") and not name:
            name = line.split(":", 1)[1].strip()
        elif line.startswith("Digest:") and not digest:
            digest = line.split(":", 1)[1].strip().lower()
    return _accept(name, digest, expected)


def _from_json(text: str, expected: str) -> str:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        raise RollbackError("rollback digest missing") from None
    if isinstance(parsed, list) or not isinstance(parsed, dict):
        raise RollbackError("rollback digest missing")
    name = _name_field(parsed)
    digest = ""
    manifest = parsed.get("manifest")
    if isinstance(manifest, dict) and "digest" in manifest:
        digest = _digest_field(manifest)
    if not digest:
        digest = _digest_field(parsed.get("Descriptor"))
    return _accept(name, digest, expected)


def _accept(name: str, digest: str, expected: str) -> str:
    if not _HEX.fullmatch(digest):
        raise RollbackError("rollback digest missing")
    if name != expected and name != f"{expected}@{digest}":
        raise RollbackError("rollback digest rejected")
    return digest


def main() -> int:
    """Check a rollback reference, or compare it with an inspect report.

    Returns:
        Process status code. Errors use a fixed phrase and omit the report.
    """
    if len(sys.argv) < 2 or sys.argv[1] not in {"check", "match"}:
        print("rollback digest rejected", file=sys.stderr)
        return 1
    try:
        if sys.argv[1] == "check":
            if len(sys.argv) != 3:
                raise RollbackError("rollback digest rejected")
            canonical_digest(sys.argv[2])
            return 0
        if len(sys.argv) != 5:
            raise RollbackError("rollback digest rejected")
        provided = canonical_digest(sys.argv[2])
        found = digest_from_inspect(Path(sys.argv[4]).read_text(encoding="utf-8"), sys.argv[3])
    except (OSError, UnicodeError, RollbackError) as exc:
        message = str(exc) if isinstance(exc, RollbackError) else "rollback digest missing"
        print(message, file=sys.stderr)
        return 1
    if provided != found:
        print("rollback digest mismatch", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
