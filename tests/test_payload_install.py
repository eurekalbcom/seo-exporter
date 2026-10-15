"""Deploy payload, archive allowlist, and credential install."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from tests.support import ROOT, gzip_tar, load_deploy, minimal_tree

SECRET = "client-secret-test"


def test_payload_roundtrip_and_rejected_text() -> None:
    payload = load_deploy("seo_payload")
    gsc = json.dumps(
        {
            "client_id": "client-id-test",
            "client_secret": SECRET,
            "refresh_token": "refresh-token-test",
        }
    ).encode()
    encoded = payload.encode_payload(b"code-bytes", gsc, gsc)
    code, got_gsc, got_bing = payload.decode_payload(_Reader(encoded))
    assert code == b"code-bytes"
    assert got_gsc == gsc
    assert got_bing == gsc
    canonical = payload.canonicalize_credential(gsc + b"")
    assert b"client_secret" in canonical
    with pytest.raises(ValueError) as caught:
        payload.decode_payload(_Reader(b"not-the-magic"))
    assert SECRET not in str(caught.value)
    with pytest.raises(ValueError) as caught:
        payload.canonicalize_credential(b'{"client_secret": "client-secret-test"')
    assert SECRET not in str(caught.value)
    assert payload.decode_json_string(json.dumps("plain-text").encode()) == "plain-text"


def test_archive_rejects_traversal_and_extra_members(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install = load_deploy("install")
    monkeypatch.setattr(install.os, "chown", lambda *_args, **_kwargs: None)
    live = tmp_path / "live"
    staging = tmp_path / "staging"
    install.install_code(gzip_tar(minimal_tree()), staging, live)
    assert (live / "seo_exporter" / "__main__.py").is_file()

    escaped = minimal_tree()
    escaped["../outside.txt"] = b"nope"
    with pytest.raises(ValueError) as caught:
        install.install_code(
            gzip_tar(escaped), tmp_path / "staging-bad", tmp_path / "live-bad"
        )
    assert "rejected" in str(caught.value)

    extra = minimal_tree(**{"notes.txt": b"nope"})
    with pytest.raises(ValueError):
        install.install_code(
            gzip_tar(extra), tmp_path / "staging-extra", tmp_path / "live-extra"
        )


def test_store_credential_permissions_and_silence(tmp_path: Path) -> None:
    install = load_deploy("install")
    dest = tmp_path / "credstore" / "seo-exporter-gsc.json"
    secret = b'{"client_id":"client-id-test","client_secret":"client-secret-test","refresh_token":"refresh-token-test"}'

    def fake_run(
        args: list[str],
        input: bytes,
        capture_output: bool,
        check: bool,
    ) -> subprocess.CompletedProcess[bytes]:
        assert input == secret
        assert "--name=gsc.json" in args
        assert "--with-key=auto" in args
        Path(args[-1]).write_bytes(b"ciphertext")
        return subprocess.CompletedProcess(args, 0, b"", b"")

    install.store_credential(
        "gsc.json",
        secret,
        dest,
        run=fake_run,
        chown=lambda *_args, **_kwargs: None,
    )
    assert dest.read_bytes() == b"ciphertext"
    assert dest.stat().st_mode & 0o777 == 0o400
    assert dest.parent.stat().st_mode & 0o777 == 0o700

    def failing_run(
        args: list[str],
        input: bytes,
        capture_output: bool,
        check: bool,
    ) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(args, 1, b"", secret)

    with pytest.raises(ValueError) as caught:
        install.store_credential(
            "gsc.json",
            secret,
            tmp_path / "other" / "seo-exporter-gsc.json",
            run=failing_run,
            chown=lambda *_args, **_kwargs: None,
        )
    assert SECRET not in str(caught.value)


def test_site_config_and_forced_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install = load_deploy("install")
    monkeypatch.setattr(install.os, "chown", lambda *_args, **_kwargs: None)
    env = tmp_path / "environment"
    env.write_text(
        "SEO_EXPORTER_GSC_SITE=\nSEO_EXPORTER_BING_SITE=site-token\n", encoding="utf-8"
    )
    assert install.site_config_ready(env) is False
    env.write_text(
        "SEO_EXPORTER_GSC_SITE=sc-domain:property\nSEO_EXPORTER_BING_SITE=site-token\n",
        encoding="utf-8",
    )
    assert install.site_config_ready(env) is True
    deploy = tmp_path / "deploy"
    deploy.mkdir()
    for name in ("install.sh", "install.py", "seo_payload.py"):
        (deploy / name).write_text(name + "\n", encoding="utf-8")
    lib = tmp_path / "lib"
    link = tmp_path / "sbin" / "seo-exporter-install"
    install.install_forced_command(deploy, lib, link)
    assert link.is_symlink()
    assert (lib / "install.sh").stat().st_mode & 0o111


def test_emit_stdin_and_ssh_key(tmp_path: Path) -> None:
    archive = tmp_path / "code.tar.gz"
    archive.write_bytes(b"code-bytes")
    gsc_read, gsc_write = os.pipe()
    bing_read, bing_write = os.pipe()
    os.write(
        gsc_write,
        json.dumps(
            '{"client_id":"a","client_secret":"client-secret-test","refresh_token":"r"}'
        ).encode(),
    )
    os.close(gsc_write)
    os.write(
        bing_write,
        json.dumps(
            '{"client_id":"b","client_secret":"bing-secret-test","refresh_token":"r"}'
        ).encode(),
    )
    os.close(bing_write)
    wrapper = (
        "import os, sys\n"
        f"os.dup2({gsc_read}, 3)\n"
        f"os.dup2({bing_read}, 4)\n"
        "os.execv(sys.executable, [sys.executable, sys.argv[1], sys.argv[2]])\n"
    )
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            wrapper,
            str(ROOT / "deploy" / "emit_stdin.py"),
            str(archive),
        ],
        check=False,
        capture_output=True,
        pass_fds=(gsc_read, bing_read),
    )
    os.close(gsc_read)
    os.close(bing_read)
    assert completed.returncode == 0, completed.stderr
    assert b"client-secret-test" not in completed.stderr
    payload = load_deploy("seo_payload")
    code, gsc, bing = payload.decode_payload(_Reader(completed.stdout))
    assert code == b"code-bytes"
    assert b"client-secret-test" in gsc
    assert b"bing-secret-test" in bing

    key_path = tmp_path / "id"
    key_run = subprocess.run(
        [sys.executable, str(ROOT / "deploy" / "write_ssh_key.py"), str(key_path)],
        input=json.dumps("ssh-test-line\n").encode(),
        check=False,
        capture_output=True,
    )
    assert key_run.returncode == 0
    assert key_path.read_text(encoding="utf-8") == "ssh-test-line\n"
    assert stat.S_IMODE(key_path.stat().st_mode) == 0o600
    assert b"ssh-test-line" not in key_run.stderr


def test_make_archive_allowlist(tmp_path: Path) -> None:
    dest = tmp_path / "code.tar.gz"
    subprocess.run(
        ["bash", str(ROOT / "deploy" / "make_archive.sh"), str(dest)], check=True
    )
    with tarfile.open(dest, "r:gz") as archive:
        names = set(archive.getnames())
    assert "seo_exporter/__main__.py" in names
    assert "deploy/install.sh" in names
    assert not any(name.startswith((".github", "tests")) for name in names)


def test_main_refuses_non_root() -> None:
    install = load_deploy("install")
    if os.geteuid() == 0:
        pytest.skip("root can run the installer")
    assert install.main() == 1


class _Reader:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self._offset = 0

    def read(self, size: int) -> bytes:
        chunk = self._payload[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk
