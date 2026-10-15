"""Install code and root-only encrypted credentials from a stdin payload.

The payload is not logged. Credential material is passed to ``systemd-creds``
on stdin and is not placed in argv.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
import tarfile
from collections.abc import Callable, Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import seo_payload

CODE_DIR = Path("/opt/seo-exporter")
STAGING_DIR = Path("/opt/seo-exporter.staging")
CRED_DIR = Path("/etc/credstore.encrypted")
UNIT_PATH = Path("/etc/systemd/system/seo-exporter.service")
ENV_PATH = Path("/etc/seo-exporter/environment")
LIB_DIR = Path("/usr/local/lib/seo-exporter-install")
SBIN_LINK = Path("/usr/local/sbin/seo-exporter-install")
MAX_MEMBERS = 200
_ALLOWED_TOP = frozenset({"seo_exporter", "deploy"})
_ALLOWED_FILES = frozenset({"pyproject.toml", "README.md", "SECURITY.md"})
_REQUIRED = (
    "seo_exporter/__main__.py",
    "deploy/install.sh",
    "deploy/install.py",
    "deploy/seo_payload.py",
    "deploy/seo-exporter.service",
)
_INSTALLER_FILES = ("install.sh", "install.py", "seo_payload.py")
Run = Callable[..., subprocess.CompletedProcess[bytes]]


def main() -> int:
    """Install from stdin.

    Returns:
        Process status code.
    """
    if os.geteuid() != 0:
        print("root required", file=sys.stderr)
        return 1
    if sys.stdin.isatty():
        print("stdin payload required", file=sys.stderr)
        return 1
    os.umask(0o077)
    try:
        code, gsc_raw, bing_raw = seo_payload.decode_payload(sys.stdin.buffer)
        gsc = seo_payload.canonicalize_credential(gsc_raw)
        bing = seo_payload.canonicalize_credential(bing_raw)
        install_code(code, STAGING_DIR, CODE_DIR)
        store_credential("gsc.json", gsc, CRED_DIR / "seo-exporter-gsc.json")
        store_credential("bing.json", bing, CRED_DIR / "seo-exporter-bing.json")
        install_unit(CODE_DIR / "deploy" / "seo-exporter.service", UNIT_PATH)
        install_forced_command(CODE_DIR / "deploy", LIB_DIR, SBIN_LINK)
        _run(["/usr/bin/systemctl", "daemon-reload"])
        _run(["/usr/bin/systemctl", "enable", "seo-exporter.service"])
        if site_config_ready(ENV_PATH):
            _run(["/usr/bin/systemctl", "restart", "seo-exporter.service"])
            print("install: service restarted", file=sys.stderr)
        else:
            print(
                "install: site configuration incomplete; service not started",
                file=sys.stderr,
            )
    except (ValueError, OSError):
        print("install rejected", file=sys.stderr)
        return 1
    print("install: complete", file=sys.stderr)
    return 0


def install_code(archive: bytes, staging: Path, live: Path) -> None:
    """Extract an allowlisted archive and swap it into ``live``.

    Args:
        archive: Gzip tar bytes.
        staging: Temporary extraction directory on the same filesystem as ``live``.
        live: Runtime code directory.

    Raises:
        ValueError: The archive is not an allowlisted code tree.
    """
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, mode=0o755)
    _extract(archive, staging)
    previous = live.with_name(live.name + ".prev")
    if previous.exists():
        shutil.rmtree(previous)
    if live.exists():
        live.rename(previous)
    staging.rename(live)
    _lock_down(live)


def store_credential(
    name: str,
    raw: bytes,
    dest: Path,
    *,
    run: Run | None = None,
    chown: Callable[[Path, int, int], None] | None = None,
) -> None:
    """Encrypt a credential for root and store it mode 0400.

    Args:
        name: Systemd credential name. Must match ``LoadCredentialEncrypted``.
        raw: Canonical credential JSON.
        dest: Ciphertext path.
        run: Process runner. Defaults to ``subprocess.run``.
        chown: Ownership setter. Defaults to ``os.chown``.

    Raises:
        OSError: Encryption or file replacement failed.
        ValueError: ``systemd-creds`` failed.
    """
    runner = subprocess.run if run is None else run
    owner = os.chown if chown is None else chown
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(dest.parent, 0o700)
    owner(dest.parent, 0, 0)
    temporary = dest.with_name(dest.name + ".tmp")
    temporary.unlink(missing_ok=True)
    result = runner(
        [
            "systemd-creds",
            "encrypt",
            f"--name={name}",
            "--with-key=auto",
            "-",
            str(temporary),
        ],
        input=raw,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        temporary.unlink(missing_ok=True)
        raise ValueError("systemd-creds encrypt failed")
    os.chmod(temporary, 0o400)
    owner(temporary, 0, 0)
    os.replace(temporary, dest)
    os.chmod(dest, 0o400)
    owner(dest, 0, 0)


def install_unit(source: Path, dest: Path) -> None:
    """Install the systemd unit mode 0644.

    Args:
        source: Unit file inside the extracted tree.
        dest: ``/etc/systemd/system`` path.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, dest)
    os.chmod(dest, 0o644)


def install_forced_command(deploy_dir: Path, lib_dir: Path, sbin_link: Path) -> None:
    """Install the forced command and point the sbin path at it.

    Args:
        deploy_dir: Extracted ``deploy`` directory.
        lib_dir: Root-owned directory for the installer sources.
        sbin_link: Stable path used by ``authorized_keys``.
    """
    lib_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(lib_dir, 0o755)
    os.chown(lib_dir, 0, 0)
    for name in _INSTALLER_FILES:
        dest = lib_dir / name
        shutil.copyfile(deploy_dir / name, dest)
        mode = 0o755 if name.endswith(".sh") else 0o644
        os.chmod(dest, mode)
        os.chown(dest, 0, 0)
    sbin_link.parent.mkdir(parents=True, exist_ok=True)
    if sbin_link.is_symlink() or sbin_link.exists():
        sbin_link.unlink()
    sbin_link.symlink_to(lib_dir / "install.sh")


def site_config_ready(path: Path) -> bool:
    """Return whether both site settings are present and non-empty.

    The file is parsed as ``KEY=value`` lines. Values are not returned.

    Args:
        path: Environment file.

    Returns:
        ``True`` when both site variables are non-empty.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False
    found: dict[str, bool] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        found[key.strip()] = bool(value.strip().strip("'\""))
    return found.get("SEO_EXPORTER_GSC_SITE", False) and found.get(
        "SEO_EXPORTER_BING_SITE", False
    )


def _extract(archive: bytes, dest: Path) -> None:
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            members = tar.getmembers()
            if len(members) > MAX_MEMBERS:
                raise ValueError("archive rejected")
            safe: list[tarfile.TarInfo] = []
            for member in members:
                if not _member_ok(member):
                    raise ValueError("archive member rejected")
                safe.append(member)
            tar.extractall(dest, members=safe, filter="data")
    except tarfile.TarError:
        raise ValueError("archive rejected") from None
    for path in dest.rglob("*"):
        if path.is_symlink():
            raise ValueError("archive member rejected")
        relative = path.relative_to(dest).as_posix()
        if not _relative_ok(relative):
            raise ValueError("archive member rejected")
    for required in _REQUIRED:
        if not (dest / required).is_file():
            raise ValueError("archive incomplete")


def _member_ok(member: tarfile.TarInfo) -> bool:
    name = member.name
    if name.startswith(("/", "\\")):
        return False
    parts = Path(name).parts
    if ".." in parts or not parts:
        return False
    if member.issym() or member.islnk() or member.isdev() or member.isfifo():
        return False
    if not (member.isdir() or member.isreg()):
        return False
    return _relative_ok(Path(name).as_posix())


def _relative_ok(relative: str) -> bool:
    parts = Path(relative).parts
    if not parts:
        return False
    if parts[0] in _ALLOWED_TOP:
        return True
    return len(parts) == 1 and parts[0] in _ALLOWED_FILES


def _lock_down(root: Path) -> None:
    for path in [root, *root.rglob("*")]:
        mode = 0o755 if path.is_dir() else 0o644
        os.chmod(path, mode)
        os.chown(path, 0, 0)


def _run(argv: Sequence[str]) -> None:
    result = subprocess.run(argv, check=False, capture_output=True)
    if result.returncode != 0:
        raise OSError("systemctl failed")


if __name__ == "__main__":
    raise SystemExit(main())
