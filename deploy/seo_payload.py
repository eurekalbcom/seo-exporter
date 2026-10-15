"""Length-prefixed deploy payload. Error text never includes payload bytes."""

from __future__ import annotations

import json
import struct
from typing import BinaryIO

MAGIC = b"SEOEXP1\n"
_LENGTH = struct.Struct("!Q")
MAX_CODE_BYTES = 20 * 1024 * 1024
MAX_CRED_BYTES = 64 * 1024
_FIELDS = ("client_id", "client_secret", "refresh_token")


def encode_payload(code: bytes, gsc: bytes, bing: bytes) -> bytes:
    """Build a deploy payload.

    Args:
        code: Gzip-compressed code archive.
        gsc: Google credential JSON.
        bing: Bing credential JSON.

    Returns:
        Payload bytes.

    Raises:
        ValueError: A section exceeds its size cap. The message names the section only.
    """
    _check_size("code", code, MAX_CODE_BYTES)
    _check_size("gsc", gsc, MAX_CRED_BYTES)
    _check_size("bing", bing, MAX_CRED_BYTES)
    return b"".join(
        (
            MAGIC,
            _LENGTH.pack(len(code)),
            code,
            _LENGTH.pack(len(gsc)),
            gsc,
            _LENGTH.pack(len(bing)),
            bing,
        )
    )


def decode_payload(stream: BinaryIO) -> tuple[bytes, bytes, bytes]:
    """Read a deploy payload from a binary stream.

    Args:
        stream: Stdin or another binary stream positioned at the payload.

    Returns:
        Code archive, Google credential JSON, and Bing credential JSON.

    Raises:
        ValueError: The framing is invalid. The message does not include payload bytes.
    """
    if stream.read(len(MAGIC)) != MAGIC:
        raise ValueError("payload magic rejected")
    code = _read_section(stream, "code", MAX_CODE_BYTES)
    gsc = _read_section(stream, "gsc", MAX_CRED_BYTES)
    bing = _read_section(stream, "bing", MAX_CRED_BYTES)
    return code, gsc, bing


def canonicalize_credential(raw: bytes) -> bytes:
    """Keep only the three OAuth fields and re-serialize them.

    Args:
        raw: Provider credential JSON.

    Returns:
        Compact JSON bytes.

    Raises:
        ValueError: The JSON is not an object with the required strings.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("credential json rejected") from None
    if not isinstance(data, dict):
        raise ValueError("credential json rejected")
    cleaned: dict[str, str] = {}
    for field in _FIELDS:
        value = data.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ValueError("credential json rejected")
        cleaned[field] = value
    return json.dumps(cleaned, separators=(",", ":")).encode()


def _check_size(name: str, blob: bytes, limit: int) -> None:
    if len(blob) > limit:
        raise ValueError(f"{name} section rejected")


def _read_section(stream: BinaryIO, name: str, limit: int) -> bytes:
    header = stream.read(_LENGTH.size)
    if len(header) != _LENGTH.size:
        raise ValueError("payload framing rejected")
    (length,) = _LENGTH.unpack(header)
    if length > limit:
        raise ValueError(f"{name} section rejected")
    blob = stream.read(length)
    if len(blob) != length:
        raise ValueError("payload framing rejected")
    return blob
