"""Workflow and repository publication contracts."""

from __future__ import annotations

import io
import json
import os
import re
import stat
import subprocess
from pathlib import Path

import pytest

from tests.support import load_deploy

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
ALLOWED_ACTIONS = {
    "actions/checkout",
    "actions/setup-python",
    "tailscale/github-action",
}
_SHA = re.compile(r"[0-9a-f]{40}$")
_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")


def _uses(text: str) -> list[str]:
    return re.findall(r"^\s*uses:\s*(\S+)\s*$", text, flags=re.MULTILINE)


def test_ci_has_no_secrets_or_environment() -> None:
    text = (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")
    assert "pull_request:" in text
    assert "pull_request_target" not in text
    assert "secrets." not in text
    assert re.search(r"^\s*environment:", text, flags=re.MULTILINE) is None
    assert "contents: read" in text
    assert "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" in text
    for use in _uses(text):
        action, pin = use.split("@", 1)
        assert action in {"actions/checkout", "actions/setup-python"}
        assert _SHA.fullmatch(pin)


def test_deploy_contract() -> None:
    text = (WORKFLOWS / "deploy.yml").read_text(encoding="utf-8")
    assert "pull_request_target" not in text
    assert "environment: seo-readonly" in text
    assert "contents: read" in text
    assert "oauth-client-id:" in text
    assert "oauth-secret:" in text
    assert "tags: tag:gh-seo-deploy" in text
    assert "fromJSON(secrets.EUK_OAUTH_TAILSCALE_SEO_DEPLOY).client_id" in text
    assert "fromJSON(secrets.EUK_OAUTH_TAILSCALE_SEO_DEPLOY).client_secret" in text
    assert "vars.EUK_VAR_SEO_TARGET_HOST" in text
    assert "vars.EUK_VAR_SEO_TARGET_HOSTKEY" in text
    assert "SSH_KEY: ${{ secrets.EUK_SSH_SEO_DEPLOY_V8QX }}" in text
    assert "GSC_JSON: ${{ secrets.EUK_OAUTH_GSC_READONLY }}" in text
    assert "BING_JSON: ${{ secrets.EUK_OAUTH_BING_READONLY }}" in text
    assert "run: bash deploy/ssh_install.sh" in text
    assert "run: |" not in text
    assert "toJSON(" not in text
    assert "EUK_OAUTH_GSC_READONLY:" not in text
    assert "EUK_OAUTH_BING_READONLY:" not in text
    script = (ROOT / "deploy" / "ssh_install.sh").read_text(encoding="utf-8")
    assert "StrictHostKeyChecking=yes" in script
    assert "seo-deploy@" in script
    for use in _uses(text):
        action, pin = use.split("@", 1)
        assert action in ALLOWED_ACTIONS
        assert _SHA.fullmatch(pin)


def test_no_pull_request_target_anywhere() -> None:
    for path in WORKFLOWS.glob("*.yml"):
        assert "pull_request_target" not in path.read_text(encoding="utf-8")


def test_unit_forced_command_and_docs() -> None:
    unit = (ROOT / "deploy" / "seo-exporter.service").read_text(encoding="utf-8")
    assert "LoadCredentialEncrypted=gsc.json:" in unit
    assert "LoadCredentialEncrypted=bing.json:" in unit
    assert "NoNewPrivileges=yes" in unit
    assert "ProtectSystem=strict" in unit
    assert "DynamicUser=yes" in unit
    assert "SEO_EXPORTER_BIND=127.0.0.1" in unit
    keys = (ROOT / "deploy" / "authorized_keys.example").read_text(encoding="utf-8")
    assert keys.startswith("restrict,command=")
    assert "sudo --non-interactive /usr/local/sbin/seo-exporter-install" in keys
    sudoers = (ROOT / "deploy" / "sudoers.example").read_text(encoding="utf-8")
    assert "!log_input, !log_output" in sudoers
    assert "NOPASSWD: /usr/local/sbin/seo-exporter-install" in sudoers
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "Pending CISO name approval" not in readme
    assert "EUK_VAR_SEO_TARGET_HOSTKEY" in readme
    assert "10 minutes" in readme
    assert "oauth-client-id" in readme
    assert "ephemeral=true" in readme
    script = ROOT / "deploy" / "install.sh"
    assert script.stat().st_mode & stat.S_IXUSR


def test_public_tree_has_no_extra_addresses() -> None:
    banned = (
        "BEGIN OPENSSH PRIVATE " + "KEY",
        "BEGIN RSA PRIVATE " + "KEY",
        "AK" + "IA",
    )
    for path in ROOT.rglob("*"):
        if not path.is_file() or ".git" in path.parts or "__pycache__" in path.parts:
            continue
        if path.suffix in {".pyc"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for token in banned:
            assert token not in text, path
        for match in _IPV4.findall(text):
            assert match == "127.0.0.1", f"{path} contains {match}"


@pytest.mark.parametrize(
    "script",
    [
        "deploy/install.sh",
        "deploy/make_archive.sh",
        "deploy/ssh_install.sh",
        "scripts/check_workflows.sh",
    ],
)
def test_shell_scripts_are_executable(script: str) -> None:
    path = ROOT / script
    assert path.stat().st_mode & stat.S_IXUSR


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _mapping_key(line: str) -> str | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or stripped.startswith("-"):
        return None
    if ":" not in stripped:
        return None
    key = stripped.split(":", 1)[0].strip()
    if not key or " " in key or key.startswith("${{"):
        return None
    return key


def _enclosing_mapping_key(lines: list[str], index: int) -> str | None:
    indent = _indent(lines[index])
    for cursor in range(index - 1, -1, -1):
        key = _mapping_key(lines[cursor])
        if key is None:
            continue
        if _indent(lines[cursor]) < indent:
            return key
    return _mapping_key(lines[index])


def test_secret_expressions_only_under_env_or_with() -> None:
    for path in sorted(WORKFLOWS.glob("*.yml")):
        lines = path.read_text(encoding="utf-8").splitlines()
        for index, line in enumerate(lines):
            if "${{ secrets." not in line and "toJSON(secrets." not in line:
                continue
            key = _enclosing_mapping_key(lines, index)
            assert key in {"env", "with"}, f"{path}:{index + 1} under {key!r}: {line}"


def test_ssh_install_checks_secrets_before_host_contact() -> None:
    text = (ROOT / "deploy" / "ssh_install.sh").read_text(encoding="utf-8")
    preflight = text.index("python3 deploy/require_provider_secrets.py")
    temporary = text.index("mktemp -d")
    remote = text.index("\n    ssh \\\n")
    assert preflight < temporary < remote
    assert "3< <(printf '%s' \"$GSC_JSON\")" in text
    assert "4< <(printf '%s' \"$BING_JSON\")" in text
    assert "${{" not in text
    assert "set -x" not in text
    assert "toJSON" not in text


def _credential(secret: str) -> str:
    return json.dumps(
        {
            "client_id": "client-id-test",
            "client_secret": secret,
            "refresh_token": "refresh-token-'$(id)'-eof",
        },
        separators=(",", ":"),
    )


class _InstallRun:
    def __init__(
        self,
        completed: subprocess.CompletedProcess[str],
        runner_tmp: Path,
        marker: Path,
        argv_path: Path,
        stdin_path: Path,
        env_path: Path,
    ) -> None:
        self.returncode = completed.returncode
        self.stdout = completed.stdout
        self.stderr = completed.stderr
        self.runner_tmp = runner_tmp
        self.marker = marker
        self.argv_path = argv_path
        self.stdin_path = stdin_path
        self.env_path = env_path


def _run_install(
    tmp_path: Path,
    updates: dict[str, str],
    *,
    drop: set[str] | None = None,
    ssh_exit: str = "0",
) -> _InstallRun:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    runner_tmp = tmp_path / "tmp"
    runner_tmp.mkdir()
    marker = tmp_path / "ssh-invoked"
    argv_path = tmp_path / "ssh-argv"
    stdin_path = tmp_path / "ssh-stdin"
    env_path = tmp_path / "ssh-env"
    ssh = bin_dir / "ssh"
    ssh.write_text(
        "#!/bin/sh\n"
        'touch "$SSH_MARKER"\n'
        "printf '%s\\n' \"$@\" > \"$SSH_ARGV\"\n"
        'cat > "$SSH_STDIN"\n'
        'env > "$SSH_ENV"\n'
        'exit "$SSH_EXIT"\n',
        encoding="utf-8",
    )
    ssh.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
    env["TMPDIR"] = str(runner_tmp)
    env["SSH_MARKER"] = str(marker)
    env["SSH_ARGV"] = str(argv_path)
    env["SSH_STDIN"] = str(stdin_path)
    env["SSH_ENV"] = str(env_path)
    env["SSH_EXIT"] = ssh_exit
    env["SEO_TARGET_HOST"] = "target.internal"
    env["SEO_TARGET_HOSTKEY"] = "target.internal ssh-ed25519 AAAAC3TEST"
    env["SSH_KEY"] = "deploy-key-material\n"
    env["GSC_JSON"] = _credential("gsc-secret-marker")
    env["BING_JSON"] = _credential("bing-secret-marker")
    env.update(updates)
    for name in drop or set():
        env.pop(name, None)
    completed = subprocess.run(
        ["bash", "deploy/ssh_install.sh"],
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    return _InstallRun(completed, runner_tmp, marker, argv_path, stdin_path, env_path)


def _assert_closed(completed: _InstallRun, stderr_text: str) -> None:
    assert completed.returncode != 0
    assert stderr_text in completed.stderr
    assert "gsc-secret-marker" not in completed.stdout
    assert "gsc-secret-marker" not in completed.stderr
    assert "bing-secret-marker" not in completed.stdout
    assert "bing-secret-marker" not in completed.stderr
    assert not completed.marker.exists()
    assert list(completed.runner_tmp.iterdir()) == []


@pytest.mark.parametrize(
    ("updates", "stderr_text"),
    [
        ({"GSC_JSON": ""}, "GSC_JSON missing"),
        ({"GSC_JSON": " \n\t"}, "GSC_JSON missing"),
        ({"GSC_JSON": "not-json"}, "GSC_JSON rejected"),
        ({"GSC_JSON": '{"client_id":"only"}'}, "GSC_JSON rejected"),
        ({"BING_JSON": ""}, "BING_JSON missing"),
        ({"BING_JSON": " "}, "BING_JSON missing"),
        ({"BING_JSON": "[]"}, "BING_JSON rejected"),
        ({"SSH_KEY": ""}, "ssh key missing"),
        ({"SSH_KEY": " \n"}, "ssh key missing"),
    ],
)
def test_ssh_install_fails_closed_before_host(
    tmp_path: Path, updates: dict[str, str], stderr_text: str
) -> None:
    completed = _run_install(tmp_path, updates)
    _assert_closed(completed, stderr_text)


def test_ssh_install_fails_closed_when_provider_secret_unset(tmp_path: Path) -> None:
    completed = _run_install(tmp_path, {}, drop={"GSC_JSON"})
    _assert_closed(completed, "GSC_JSON missing")


def test_ssh_install_reaches_ssh_only_with_provider_secrets(tmp_path: Path) -> None:
    completed = _run_install(tmp_path, {})
    assert completed.returncode == 0, completed.stderr
    assert completed.marker.is_file()
    argv = completed.argv_path.read_text(encoding="utf-8")
    assert "StrictHostKeyChecking=yes" in argv
    assert "seo-deploy@target.internal" in argv
    assert "gsc-secret-marker" not in argv
    assert "bing-secret-marker" not in argv
    remote_env = completed.env_path.read_text(encoding="utf-8")
    assert "GSC_JSON=" not in remote_env
    assert "BING_JSON=" not in remote_env
    assert "SSH_KEY=" not in remote_env
    assert "gsc-secret-marker" not in remote_env
    assert "bing-secret-marker" not in remote_env
    payload = load_deploy("seo_payload")
    code, gsc, bing = payload.decode_payload(io.BytesIO(completed.stdin_path.read_bytes()))
    assert code.startswith(b"\x1f\x8b")
    assert b"gsc-secret-marker" in gsc
    assert b"bing-secret-marker" in bing
    assert b"refresh-token-'$(id)'-eof" in gsc
    assert list(completed.runner_tmp.iterdir()) == []


def test_ssh_install_removes_workdir_when_ssh_fails(tmp_path: Path) -> None:
    completed = _run_install(tmp_path, {}, ssh_exit="23")
    assert completed.returncode == 23
    assert completed.marker.is_file()
    assert list(completed.runner_tmp.iterdir()) == []
