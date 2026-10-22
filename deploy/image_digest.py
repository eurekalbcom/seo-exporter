"""Read a GHCR digest from a push log and from RepoDigests.

The legacy builder's push line is ``name:tag: digest: sha256:… size: N``.
A line-anchored ``digest:`` match misses it. ``docker buildx`` may be absent,
so the build compares that line with ``docker image inspect`` RepoDigests.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ALLOWED_REPO = "ghcr.io/eurekalbcom/seo-exporter"
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_PUSH_DIGEST = re.compile(r"(?:^|\s)digest:\s+(sha256:[0-9a-f]{64})(?:\s|$)")


def digest_from_repo_digests(raw: str, repo: str = ALLOWED_REPO) -> str:
    """Return the one digest ``docker image inspect`` reported for ``repo``.

    Args:
        raw: JSON list from ``{{json .RepoDigests}}``.
        repo: Repository that must own the digest.

    Returns:
        ``sha256:`` plus 64 hex characters.

    Raises:
        ValueError: The list is not exactly one digest of ``repo``.
    """
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("registry digest missing") from None
    if not isinstance(parsed, list) or any(not isinstance(item, str) for item in parsed):
        raise ValueError("registry digest missing")
    found: list[str] = []
    for item in parsed:
        if "@" not in item:
            continue
        name, digest = item.rsplit("@", 1)
        if name == repo and _DIGEST.fullmatch(digest):
            found.append(digest)
    if len(found) != 1:
        raise ValueError("registry digest missing")
    return found[0]


def digest_from_push_log(text: str) -> str:
    """Return the one digest printed by ``docker push``.

    Args:
        text: Combined stdout and stderr of the push. Not logged again.

    Returns:
        ``sha256:`` plus 64 hex characters.

    Raises:
        ValueError: The log does not contain exactly one digest.
    """
    found = [match.group(1) for match in _PUSH_DIGEST.finditer(text)]
    if len(found) != 1:
        raise ValueError("registry digest missing")
    return found[0]


def main() -> int:
    """Print the digest when the push log and RepoDigests agree.

    Returns:
        Process status code. Errors name the failure, not the log body.
    """
    if len(sys.argv) != 3:
        print("registry digest missing", file=sys.stderr)
        return 1
    try:
        pushed = digest_from_push_log(Path(sys.argv[1]).read_text(encoding="utf-8"))
        inspected = digest_from_repo_digests(Path(sys.argv[2]).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        print("registry digest missing", file=sys.stderr)
        return 1
    if pushed != inspected:
        print("registry digest missing", file=sys.stderr)
        return 1
    print(pushed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
