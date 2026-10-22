"""Write credential files, drop secret variables, then exec the exporter.

The exporter accepts credentials only from a directory whose parent is
``/run/credentials``. This entrypoint creates that directory on the tmpfs,
writes ``gsc.json`` and ``bing.json``, and replaces itself. Secret values
are never logged.

``WRITE_MODE`` and ``AUTH_TRUST_HOST`` are CrawlSEO flags. This service has
no write API and does not trust ``X-Forwarded-Host``, so either name aborts
the process before credentials are written.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from pathlib import Path

from deploy.credentials_json import canonicalize_credential

_CREDENTIALS = Path("/run/credentials/seo-exporter")
_SECRET_KEYS = ("SEO_EXPORTER_GSC_JSON", "SEO_EXPORTER_BING_JSON")
_DROP_KEYS = (
    "SEO_EXPORTER_GSC_JSON",
    "SEO_EXPORTER_BING_JSON",
    "SEO_EXPORTER_IMAGE",
    "SEO_COMPOSE_SHA256",
)
_FILES = (
    ("SEO_EXPORTER_GSC_JSON", "gsc.json"),
    ("SEO_EXPORTER_BING_JSON", "bing.json"),
)
_FOREIGN_FLAGS = ("WRITE_MODE", "AUTH_TRUST_HOST")


def reject_foreign_flags(source: Mapping[str, str]) -> None:
    """Refuse CrawlSEO flags that do not belong to this service.

    Args:
        source: Incoming environment.

    Raises:
        SystemExit: ``WRITE_MODE`` or ``AUTH_TRUST_HOST`` is present.
    """
    for key in _FOREIGN_FLAGS:
        if key in source:
            raise SystemExit(f"{key} rejected")


def write_credentials(source: Mapping[str, str], directory: Path) -> None:
    """Write provider JSON files mode 0400.

    Args:
        source: Environment mapping that contains the provider JSON.
        directory: Destination directory. Created if missing.

    Raises:
        SystemExit: A provider value is missing or not valid credential JSON.
    """
    os.umask(0o077)
    try:
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
    except OSError:
        raise SystemExit("credentials directory rejected") from None
    for env_name, filename in _FILES:
        raw = source.get(env_name)
        if raw is None or not raw.strip():
            raise SystemExit(f"{env_name} missing")
        try:
            body = canonicalize_credential(raw.encode())
        except ValueError:
            raise SystemExit(f"{env_name} rejected") from None
        target = directory / filename
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
            try:
                os.write(fd, body)
            finally:
                os.close(fd)
            os.chmod(target, 0o400)
        except OSError:
            raise SystemExit(f"{env_name} rejected") from None


def runtime_env(source: Mapping[str, str]) -> dict[str, str]:
    """Return the process environment for the exporter.

    Secret JSON variables are removed. Bind, state, and the credentials
    directory are forced so the env file cannot move them.

    Args:
        source: Incoming environment.

    Returns:
        Environment for ``python -m seo_exporter``.

    Raises:
        SystemExit: ``WRITE_MODE`` or ``AUTH_TRUST_HOST`` is present.
    """
    reject_foreign_flags(source)
    cleaned = {key: value for key, value in source.items() if key not in _DROP_KEYS}
    cleaned["CREDENTIALS_DIRECTORY"] = str(_CREDENTIALS)
    cleaned["SEO_EXPORTER_BIND"] = "127.0.0.1"
    cleaned["SEO_EXPORTER_STATE_DIR"] = "/var/lib/seo-exporter"
    cleaned["PYTHONDONTWRITEBYTECODE"] = "1"
    cleaned["PYTHONUNBUFFERED"] = "1"
    return cleaned


def main() -> None:
    """Write credentials and exec the exporter."""
    source = dict(os.environ)
    reject_foreign_flags(source)
    write_credentials(source, _CREDENTIALS)
    os.execve(sys.executable, [sys.executable, "-m", "seo_exporter"], runtime_env(source))


if __name__ == "__main__":
    main()
