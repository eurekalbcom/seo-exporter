"""Workflow and repository publication contracts."""

from __future__ import annotations

import re
import stat
from pathlib import Path

import pytest

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
    assert "StrictHostKeyChecking=yes" in text
    assert "seo-deploy@" in text
    assert "vars.EUK_VAR_SEO_TARGET_HOST" in text
    assert "vars.EUK_VAR_SEO_TARGET_HOSTKEY" in text
    assert "toJSON(secrets.EUK_OAUTH_GSC_READONLY)" in text
    assert "toJSON(secrets.EUK_OAUTH_BING_READONLY)" in text
    assert "toJSON(secrets.EUK_SSH_SEO_DEPLOY_V8QX)" in text
    assert "EUK_OAUTH_GSC_READONLY:" not in text
    assert "EUK_OAUTH_BING_READONLY:" not in text
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
    assert "Pending CISO name approval" in readme
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
    ["deploy/install.sh", "deploy/make_archive.sh", "scripts/check_workflows.sh"],
)
def test_shell_scripts_are_executable(script: str) -> None:
    path = ROOT / script
    assert path.stat().st_mode & stat.S_IXUSR
