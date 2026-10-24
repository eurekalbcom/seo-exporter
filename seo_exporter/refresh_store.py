"""Persist rotated refresh tokens outside the read-only credential mount."""

from __future__ import annotations

import os
from pathlib import Path


def load_refresh_token(path: Path) -> str | None:
    """Read a previously rotated refresh token.

    Args:
        path: State file containing only the token.

    Returns:
        The token, or ``None`` when the file is absent or unusable.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    token = text.strip()
    if not token or any(char in token for char in ("\n", "\r", "\x00")):
        return None
    return token


def store_refresh_token(path: Path, token: str) -> None:
    """Atomically write a refresh token with mode 0600.

    Args:
        path: Destination file.
        token: Refresh token.

    Raises:
        OSError: The directory or file could not be written.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, token.encode() + b"\n")
    finally:
        os.close(fd)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    os.chmod(path, 0o600)
