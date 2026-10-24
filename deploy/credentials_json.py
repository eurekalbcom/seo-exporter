"""Canonicalize provider credential JSON. Values are never included in errors."""

from __future__ import annotations

import json

MAX_CRED_BYTES = 64 * 1024
_FIELDS = ("client_id", "client_secret", "refresh_token")


def canonicalize_credential(raw: bytes) -> bytes:
    """Keep only the three OAuth fields and re-serialize them.

    Args:
        raw: Provider credential JSON.

    Returns:
        Compact JSON bytes.

    Raises:
        ValueError: The JSON is not an object with the required strings.
    """
    if len(raw) > MAX_CRED_BYTES:
        raise ValueError("credential json rejected")
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
