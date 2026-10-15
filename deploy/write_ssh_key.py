"""Write an SSH private key from a JSON string on stdin. The key is not logged."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import seo_payload


def main() -> int:
    """Materialize the key at the path in ``argv``.

    Returns:
        Process status code.
    """
    if len(sys.argv) != 2:
        print("usage: write_ssh_key.py DEST", file=sys.stderr)
        return 2
    dest = Path(sys.argv[1])
    try:
        text = seo_payload.decode_json_string(sys.stdin.buffer.read())
    except ValueError:
        print("ssh key payload rejected", file=sys.stderr)
        return 1
    if not text.strip():
        print("ssh key payload rejected", file=sys.stderr)
        return 1
    if not text.endswith("\n"):
        text += "\n"
    try:
        fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, text.encode())
        finally:
            os.close(fd)
        os.chmod(dest, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        print("ssh key file rejected", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
