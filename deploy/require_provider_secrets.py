"""Reject empty or invalid provider credentials before any host contact.

Reads ``GSC_JSON`` and ``BING_JSON`` from the environment. Error text names the
variable only and never includes the value.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import seo_payload


def main() -> int:
    """Return 0 when both provider secrets are usable credential JSON.

    Returns:
        Process status code.
    """
    for name in ("GSC_JSON", "BING_JSON"):
        raw = os.environ.get(name)
        if raw is None or not raw.strip():
            print(f"{name} missing", file=sys.stderr)
            return 1
        encoded = raw.encode()
        if len(encoded) > seo_payload.MAX_CRED_BYTES:
            print(f"{name} rejected", file=sys.stderr)
            return 1
        try:
            seo_payload.canonicalize_credential(encoded)
        except ValueError:
            print(f"{name} rejected", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
