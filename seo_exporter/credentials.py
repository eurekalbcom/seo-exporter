"""Load OAuth client credentials from the systemd credentials directory."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from seo_exporter.logging_redact import Redactor

_FIELDS = ("client_id", "client_secret", "refresh_token")
_CREDENTIAL_ROOT = Path("/run/credentials")


@dataclass(frozen=True)
class OAuthClient:
    """OAuth client that can refresh an access token.

    Attributes:
        client_id: OAuth client id.
        client_secret: OAuth client secret.
        refresh_token: Long-lived refresh token.
    """

    client_id: str
    client_secret: str
    refresh_token: str


def credential_mount_ok(path: Path) -> bool:
    """Return whether ``path`` is a direct systemd credential mount.

    Args:
        path: Directory to check.

    Returns:
        ``True`` when the directory exists and its parent is ``/run/credentials``.
    """
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError:
        return False
    return resolved.parent == _CREDENTIAL_ROOT


def load_oauth_client(path: Path, provider: str, redactor: Redactor) -> OAuthClient:
    """Load one provider credential file.

    Args:
        path: JSON file with ``client_id``, ``client_secret``, and ``refresh_token``.
        provider: Short provider name used in error text.
        redactor: Receives the loaded secret fields.

    Returns:
        The parsed client.

    Raises:
        SystemExit: The file is missing, unreadable, or not the expected object.
    """
    try:
        raw = path.read_bytes()
    except OSError:
        raise SystemExit(f"credential unreadable provider={provider}") from None
    return client_from_bytes(raw, provider, redactor)


def client_from_bytes(raw: bytes, provider: str, redactor: Redactor) -> OAuthClient:
    """Parse credential JSON and register its secrets with the redactor.

    Args:
        raw: JSON object bytes.
        provider: Short provider name used in error text.
        redactor: Receives the loaded secret fields.

    Returns:
        The parsed client.

    Raises:
        SystemExit: The JSON shape is not the expected object.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise SystemExit(f"credential rejected provider={provider}") from None
    if not isinstance(data, dict):
        raise SystemExit(f"credential rejected provider={provider}")
    values: dict[str, str] = {}
    for field in _FIELDS:
        value = data.get(field)
        if not isinstance(value, str) or not value.strip():
            raise SystemExit(
                f"credential field missing provider={provider} field={field}"
            )
        values[field] = value
    client = OAuthClient(
        client_id=values["client_id"],
        client_secret=values["client_secret"],
        refresh_token=values["refresh_token"],
    )
    redactor.add(client.client_id)
    redactor.add(client.client_secret)
    redactor.add(client.refresh_token)
    return client


def load_provider_clients(
    directory: Path,
    redactor: Redactor,
    *,
    enforce_mount: bool,
) -> tuple[OAuthClient, OAuthClient]:
    """Load ``gsc.json`` and ``bing.json`` from a credentials directory.

    Args:
        directory: Systemd ``CREDENTIALS_DIRECTORY``.
        redactor: Receives every loaded secret.
        enforce_mount: When true, reject directories outside ``/run/credentials``.

    Returns:
        Google and Bing clients, in that order.

    Raises:
        SystemExit: The directory is not a credential mount or a file is invalid.
    """
    if enforce_mount and not credential_mount_ok(directory):
        raise SystemExit("credentials directory is not a systemd credential mount")
    gsc = load_oauth_client(directory / "gsc.json", "gsc", redactor)
    bing = load_oauth_client(directory / "bing.json", "bing", redactor)
    return gsc, bing
