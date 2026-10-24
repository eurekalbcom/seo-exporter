"""Build the host env file for the seo-exporter compose project.

The file is mode 0600. Error text names the variable only.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
from collections.abc import Mapping
from pathlib import Path

from deploy.credentials_json import canonicalize_credential

ALLOWED_REPO = "ghcr.io/eurekalbcom/seo-exporter"
_IMAGE = re.compile(rf"^{re.escape(ALLOWED_REPO)}@sha256:[0-9a-f]{{64}}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_PASSWORD = re.compile(r"^[A-Za-z0-9]{16,128}$")
_MAX_ENV_BYTES = 65536


def quote_single(value: str) -> str:
    """Single-quote an env value.

    Args:
        value: Value that must not contain a single quote or newline.

    Returns:
        A single-quoted env-file token.

    Raises:
        ValueError: The value cannot be quoted safely.
    """
    if value == "" or any(char in value for char in ("'", "\n", "\r", "\x00")):
        raise ValueError("env value rejected")
    return "'" + value + "'"


def normalize_image(repo: str, digest: str) -> str:
    """Return ``repo@sha256:hex`` or reject the value.

    Args:
        repo: Registry repository, without a tag or digest.
        digest: ``sha256:`` hex, or a full ``repo@sha256:`` reference.

    Returns:
        The pinned image reference.

    Raises:
        ValueError: The reference is not a digest pin for ``repo``.
    """
    repository = repo.strip().lower()
    if repository != ALLOWED_REPO:
        raise ValueError("image digest rejected")
    raw = digest.strip().lower()
    if raw.startswith("sha256:"):
        ref = repository + "@" + raw
    else:
        ref = raw
    if not _IMAGE.fullmatch(ref) or not ref.startswith(repository + "@sha256:"):
        raise ValueError("image digest rejected")
    return ref


def require_site(name: str, raw: str | None) -> str:
    """Return a non-secret site identifier.

    Args:
        name: Variable name used in the error.
        raw: Candidate value.

    Returns:
        The stripped site identifier.

    Raises:
        ValueError: The value is empty or not a single line.
    """
    if raw is None or not raw.strip():
        raise ValueError(f"{name} missing")
    value = raw.strip()
    if len(value) > 512 or any(char in value for char in ("'", "\n", "\r", "\x00")):
        raise ValueError(f"{name} rejected")
    return value


def require_credential(name: str, raw: str | None) -> str:
    """Return canonical credential JSON.

    Args:
        name: Variable name used in the error.
        raw: JSON text from the environment.

    Returns:
        Compact JSON.

    Raises:
        ValueError: The JSON is missing or rejected.
    """
    if raw is None or not raw.strip():
        raise ValueError(f"{name} missing")
    try:
        return canonicalize_credential(raw.encode()).decode()
    except ValueError:
        raise ValueError(f"{name} rejected") from None


def require_port(raw: str | None) -> str:
    """Return a TCP port with no default.

    Args:
        raw: ``SEO_REMOTE_WRITE_PORT`` from the environment.

    Returns:
        Decimal text from 1 to 65535, without leading zeros.

    Raises:
        ValueError: The value is missing or not an allowed port.
    """
    if raw is None or not raw.strip():
        raise ValueError("SEO_REMOTE_WRITE_PORT missing")
    value = raw.strip()
    if re.fullmatch(r"[1-9][0-9]{0,4}", value) is None:
        raise ValueError("SEO_REMOTE_WRITE_PORT rejected")
    if int(value) > 65535:
        raise ValueError("SEO_REMOTE_WRITE_PORT rejected")
    return value


def require_password(raw: str | None) -> str:
    """Return the remote-write password with no default.

    Args:
        raw: ``SEO_REMOTE_WRITE_PASSWORD`` from the environment.

    Returns:
        16 to 128 letters or digits, unchanged.

    Raises:
        ValueError: The value is missing or not in that set.
    """
    if raw is None or not raw.strip():
        raise ValueError("SEO_REMOTE_WRITE_PASSWORD missing")
    if _PASSWORD.fullmatch(raw) is None:
        raise ValueError("SEO_REMOTE_WRITE_PASSWORD rejected")
    return raw


def compose_sha256(path: Path) -> str:
    """Hash the compose file that must be installed on the host.

    Args:
        path: Path to ``docker-compose.yml``.

    Returns:
        Lowercase hex digest.

    Raises:
        ValueError: The file is missing.
    """
    if not path.is_file():
        raise ValueError("compose file missing")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def render_env(
    image: str,
    gsc_site: str,
    bing_site: str,
    gsc_json: str,
    bing_json: str,
    remote_write_port: str,
    receiver_secret: str,
    compose_sha: str,
) -> str:
    """Render the env file body.

    Args:
        image: Pinned image reference.
        gsc_site: Search Console property.
        bing_site: Bing site.
        gsc_json: Canonical Google credential JSON.
        bing_json: Canonical Bing credential JSON.
        remote_write_port: Receiver port.
        receiver_secret: Remote-write basic auth secret.
        compose_sha: SHA-256 of ``docker-compose.yml``.

    Returns:
        Env file text ending in a newline.

    Raises:
        ValueError: A field is not in the expected shape.
    """
    if not _IMAGE.fullmatch(image):
        raise ValueError("image digest rejected")
    if not _SHA256.fullmatch(compose_sha):
        raise ValueError("compose hash rejected")
    port = require_port(remote_write_port)
    password = require_password(receiver_secret)
    lines = (
        f"SEO_EXPORTER_IMAGE={image}",
        f"SEO_EXPORTER_GSC_SITE={quote_single(gsc_site)}",
        f"SEO_EXPORTER_BING_SITE={quote_single(bing_site)}",
        f"SEO_EXPORTER_GSC_JSON={quote_single(gsc_json)}",
        f"SEO_EXPORTER_BING_JSON={quote_single(bing_json)}",
        f"SEO_REMOTE_WRITE_PORT={port}",
        f"SEO_REMOTE_WRITE_PASSWORD={password}",
        f"SEO_COMPOSE_SHA256={compose_sha}",
    )
    text = "\n".join(lines) + "\n"
    if len(text.encode()) > _MAX_ENV_BYTES:
        raise ValueError("env file rejected")
    return text


def write_env_file(path: Path, text: str) -> None:
    """Write ``text`` at mode 0600.

    Args:
        path: Destination.
        text: Env file body.
    """
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, text.encode())
    finally:
        os.close(fd)
    os.chmod(path, 0o600)


def resolve_digest(digest: str, digest_file: str) -> str:
    """Use the rollback digest, or the digest file written by the build.

    Args:
        digest: Workflow input. Empty when the job just built an image.
        digest_file: Path to the build digest file.

    Returns:
        Digest text.

    Raises:
        ValueError: Neither source has a digest.
    """
    if digest.strip():
        return digest.strip()
    if not digest_file:
        raise ValueError("image digest missing")
    path = Path(digest_file)
    if not path.is_file():
        raise ValueError("image digest missing")
    return path.read_text(encoding="utf-8").strip()


def build_from_environ(environ: Mapping[str, str] | None = None) -> str:
    """Build the env file from process environment variables.

    Args:
        environ: Mapping to read. Defaults to ``os.environ``.

    Returns:
        Env file text.

    Raises:
        ValueError: A required input is missing or rejected.
    """
    env: Mapping[str, str] = os.environ if environ is None else environ
    digest = resolve_digest(
        env.get("IMAGE_DIGEST", ""),
        env.get("IMAGE_DIGEST_FILE", ""),
    )
    image = normalize_image(env.get("IMAGE_REPO", ""), digest)
    gsc_json = require_credential("GSC_JSON", env.get("GSC_JSON"))
    bing_json = require_credential("BING_JSON", env.get("BING_JSON"))
    gsc_site = require_site("GSC_SITE", env.get("GSC_SITE"))
    bing_site = require_site("BING_SITE", env.get("BING_SITE"))
    remote_write_port = require_port(env.get("SEO_REMOTE_WRITE_PORT"))
    remote_write_password = require_password(env.get("SEO_REMOTE_WRITE_PASSWORD"))
    compose = compose_sha256(Path(env.get("COMPOSE_FILE", "docker-compose.yml")))
    return render_env(
        image,
        gsc_site,
        bing_site,
        gsc_json,
        bing_json,
        remote_write_port,
        remote_write_password,
        compose,
    )


def main() -> int:
    """Check or write the env file.

    Returns:
        Process status code.
    """
    if len(sys.argv) < 2 or sys.argv[1] not in {"check", "write"}:
        print("usage: envfile.py check|write [PATH]", file=sys.stderr)
        return 2
    try:
        text = build_from_environ()
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if sys.argv[1] == "check":
        return 0
    if len(sys.argv) != 3:
        print("usage: envfile.py write PATH", file=sys.stderr)
        return 2
    write_env_file(Path(sys.argv[2]), text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
