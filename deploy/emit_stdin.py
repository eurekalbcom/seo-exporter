"""Write a deploy payload to stdout from an archive and two JSON strings.

File descriptor 3 is the Google credential as a JSON string (GitHub ``toJSON``).
File descriptor 4 is the Bing credential in the same form. Nothing is logged.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import seo_payload


def main() -> int:
    """Emit one payload.

    Returns:
        Process status code.
    """
    if len(sys.argv) != 2:
        print("usage: emit_stdin.py ARCHIVE", file=sys.stderr)
        return 2
    try:
        code = Path(sys.argv[1]).read_bytes()
        gsc = seo_payload.decode_json_string(_read_fd(3)).encode()
        bing = seo_payload.decode_json_string(_read_fd(4)).encode()
        sys.stdout.buffer.write(seo_payload.encode_payload(code, gsc, bing))
    except (OSError, ValueError):
        print("deploy payload rejected", file=sys.stderr)
        return 1
    return 0


def _read_fd(fd: int) -> bytes:
    try:
        return os.fdopen(fd, "rb").read()
    except OSError:
        raise ValueError("deploy payload input rejected") from None


if __name__ == "__main__":
    raise SystemExit(main())
