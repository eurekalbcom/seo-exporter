"""Shared test helpers."""

from __future__ import annotations

import importlib.util
import io
import tarfile
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]


def load_deploy(name: str) -> ModuleType:
    """Load a module from ``deploy/`` by file path.

    Args:
        name: Module file name without ``.py``.

    Returns:
        The loaded module.
    """
    path = ROOT / "deploy" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"missing deploy module {name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def gzip_tar(files: dict[str, bytes]) -> bytes:
    """Build a gzip tar from a name-to-bytes mapping.

    Args:
        files: Archive member names and contents.

    Returns:
        Gzip-compressed tar bytes.
    """
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, payload in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def minimal_tree(**extra: bytes) -> dict[str, bytes]:
    """Return the smallest allowlisted code archive.

    Args:
        extra: Additional members.

    Returns:
        Member mapping accepted by the installer.
    """
    files = {
        "seo_exporter/__main__.py": b"raise SystemExit(0)\n",
        "deploy/install.sh": b"#!/bin/bash\nexit 0\n",
        "deploy/install.py": b"raise SystemExit(0)\n",
        "deploy/seo_payload.py": b"MAGIC = b''\n",
        "deploy/seo-exporter.service": b"[Service]\nExecStart=/usr/bin/python3 -m seo_exporter\n",
        "pyproject.toml": b"[project]\nname='seo-exporter'\n",
        "README.md": b"# seo-exporter\n",
        "SECURITY.md": b"# Security\n",
    }
    files.update(extra)
    return files
