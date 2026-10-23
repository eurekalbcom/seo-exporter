"""Contracts for the Docker deploy of the read-only exporter."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from deploy.docker_entrypoint import runtime_env, write_credentials
from deploy.envfile import build_from_environ, normalize_image, render_env, write_env_file
from deploy.image_digest import digest_from_push_log, digest_from_repo_digests
from deploy.rollback_digest import RollbackError, canonical_digest, digest_from_inspect

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
_SHA = re.compile(r"^[0-9a-f]{40}$")
_IMAGE = "ghcr.io/eurekalbcom/seo-exporter@sha256:" + ("ab" * 32)
_REPO = "ghcr.io/eurekalbcom/seo-exporter"
_EXPORTER_SHA256 = {
    "pyproject.toml": "772940f0678f3f43d58f6577737111c87ce05a5c49baf22b595519ddfc6bfeab",
    "requirements-dev.txt": "468b862d1a6f7bb772b5e1d4c8210331d435d0a293800befbc452d9081a94ef8",
    "seo_exporter/__init__.py": "d7e2241973d3870ad6be6aeb5ad638a0cd182efa371aa0653abfda0d426640a4",
    "seo_exporter/__main__.py": "990b421ff805f37e7b633f81853fbb1ea0ef3d3f24cbca3a59d00c112e2892ae",
    "seo_exporter/bing.py": "4498f5a7089c76e293657400e4f2bee2e5de69e2bc5eec03d4da2de82587004b",
    "seo_exporter/credentials.py": "afed3712366e15fe34dffe70e2ea77437691b419bcea6be73b8e4d97e4afc3f8",
    "seo_exporter/gsc.py": "1d75e8844e4695a8a30e6111b0ff42c5cf248ff58e5a6c114732de0400b4f407",
    "seo_exporter/http_client.py": "37b1c5ad045037bca83c6e5c027ebb75b574f05fa31686a5ebfe75b0c612c8d2",
    "seo_exporter/logging_redact.py": "2dadff7b6a06b6c34b5f49435050ac600f8c62deb3d369759778767ffca14a92",
    "seo_exporter/metrics.py": "de14998e149cce9afe55f0740f9d6c9681140ec294874abda5acab575792e011",
    "seo_exporter/oauth.py": "17e18af0602df864b5bd79cc3ec68d648fd87b127551bcfd9fd2f60a1bb5a9e0",
    "seo_exporter/providers.py": "e21b01d807c56ebc07da229a242b694aa6b76f768f23b56f3d30c761c9b4f259",
    "seo_exporter/refresh_store.py": "c4c79bd44151dc947b084da8b610a34f07c6a19643c7a9b5518c778777ee6f34",
    "seo_exporter/server.py": "94195a07884aa73ce0049e098a26f9a535c996076add952084225d3fa46fa2f6",
    "seo_exporter/service.py": "861e9eb2941d0846a1e9891b74ee6f783d6c18fe44e501e297f89b3b4ff71005",
    "seo_exporter/settings.py": "743c688aa74205b4802a52c2dc26012b44f86f83c2a9472d4cd6d43b014ae31e",
    "tests/test_credentials.py": "f3bdf98a132e7047a9135002d27c272585346dbfaf1e54f40ec510a783224516",
    "tests/test_oauth_http.py": "92c669b9bc7b0c8d96a7b8495479345663967fe9aef3456caa5afc6e5828bc80",
    "tests/test_providers.py": "ef298763de78232257a0a37a7a28a409fd347f2010e1a23b525712cec619dcb6",
    "tests/test_service.py": "69a69135712a4e974b54622bda3cdfb674df4c9971f5c2c01614794377af2287",
}


def _credential(secret: str) -> str:
    return json.dumps(
        {
            "client_id": "client-id-test",
            "client_secret": secret,
            "refresh_token": "refresh-token",
        },
        separators=(",", ":"),
    )


def _base_env(tmp_path: Path | None = None) -> dict[str, str]:
    env = {
        "IMAGE_REPO": _REPO,
        "IMAGE_DIGEST": "sha256:" + ("ab" * 32),
        "GSC_JSON": _credential("gsc-secret-marker"),
        "BING_JSON": _credential("bing-secret-marker"),
        "GSC_SITE": "sc-domain:example.com",
        "BING_SITE": "https://example.invalid/",
        "SEO_REMOTE_WRITE_PORT": "9",
        "COMPOSE_FILE": str(ROOT / "docker-compose.yml"),
    }
    if tmp_path is not None:
        env["IMAGE_DIGEST_FILE"] = str(tmp_path / "missing-digest")
    return env


def test_exporter_bytes_match_efe4041d() -> None:
    for relative, expected in _EXPORTER_SHA256.items():
        digest = hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
        assert digest == expected, relative


def test_rejected_root_install_files_are_absent() -> None:
    for name in (
        "deploy/seo-exporter.service",
        "deploy/sudoers.example",
        "deploy/install.sh",
        "deploy/ssh_install.sh",
    ):
        assert not (ROOT / name).exists()


def test_image_reference_must_be_a_digest() -> None:
    assert normalize_image(_REPO, "sha256:" + ("ab" * 32)) == _IMAGE
    full = normalize_image(_REPO, _IMAGE)
    assert full == _IMAGE
    with pytest.raises(ValueError, match="image digest rejected"):
        normalize_image(_REPO, "latest")
    with pytest.raises(ValueError, match="image digest rejected"):
        normalize_image(_REPO, "ghcr.io/other/seo-exporter@" + "sha256:" + ("ab" * 32))
    with pytest.raises(ValueError, match="image digest rejected"):
        normalize_image("ghcr.io/example/seo-exporter", "sha256:" + ("ab" * 32))
    with pytest.raises(ValueError, match="image digest rejected"):
        normalize_image(_REPO, _REPO + ":latest")


def test_envfile_mode_and_rejection(tmp_path: Path) -> None:
    text = build_from_environ(_base_env())
    assert "gsc-secret-marker" in text
    assert text.startswith(f"SEO_EXPORTER_IMAGE={_IMAGE}\n")
    keys = [line.split("=", 1)[0] for line in text.splitlines()]
    assert keys == [
        "SEO_EXPORTER_IMAGE",
        "SEO_EXPORTER_GSC_SITE",
        "SEO_EXPORTER_BING_SITE",
        "SEO_EXPORTER_GSC_JSON",
        "SEO_EXPORTER_BING_JSON",
        "SEO_REMOTE_WRITE_PORT",
        "SEO_COMPOSE_SHA256",
    ]
    path = tmp_path / "env"
    write_env_file(path, text)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    rejected = _base_env()
    rejected["GSC_JSON"] = "not-json-secret"
    with pytest.raises(ValueError, match="GSC_JSON rejected") as caught:
        build_from_environ(rejected)
    assert "not-json-secret" not in str(caught.value)
    missing_port = _base_env()
    missing_port["SEO_REMOTE_WRITE_PORT"] = " "
    with pytest.raises(ValueError, match="SEO_REMOTE_WRITE_PORT missing"):
        build_from_environ(missing_port)
    bad_port = _base_env()
    bad_port["SEO_REMOTE_WRITE_PORT"] = "65536"
    with pytest.raises(ValueError, match="SEO_REMOTE_WRITE_PORT rejected"):
        build_from_environ(bad_port)


def test_envfile_cli_does_not_echo(tmp_path: Path) -> None:
    env = os.environ.copy()
    env.update(_base_env())
    env["GSC_JSON"] = "not-json-secret"
    completed = subprocess.run(
        [sys.executable, "-m", "deploy.envfile", "check"],
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 1
    assert "not-json-secret" not in completed.stdout
    assert "not-json-secret" not in completed.stderr
    assert "gsc-secret-marker" not in completed.stderr
    destination = tmp_path / "out.env"
    env["GSC_JSON"] = _credential("gsc-secret-marker")
    written = subprocess.run(
        [sys.executable, "-m", "deploy.envfile", "write", str(destination)],
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert written.returncode == 0, written.stderr
    assert "gsc-secret-marker" not in written.stdout
    assert "gsc-secret-marker" not in written.stderr
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600


def test_entrypoint_drops_secrets_and_forces_bind(tmp_path: Path) -> None:
    source = {
        "SEO_EXPORTER_GSC_JSON": _credential("gsc-secret-marker"),
        "SEO_EXPORTER_BING_JSON": _credential("bing-secret-marker"),
        "SEO_EXPORTER_BIND": "0.0.0.0",
        "SEO_EXPORTER_STATE_DIR": "/tmp/elsewhere",
        "SEO_EXPORTER_GSC_SITE": "sc-domain:example.com",
        "PATH": "/usr/bin",
    }
    write_credentials(source, tmp_path)
    body = (tmp_path / "gsc.json").read_text(encoding="utf-8")
    assert "gsc-secret-marker" in body
    assert stat.S_IMODE((tmp_path / "gsc.json").stat().st_mode) == 0o400
    cleaned = runtime_env(source)
    assert "gsc-secret-marker" not in cleaned.values()
    assert "SEO_EXPORTER_GSC_JSON" not in cleaned
    assert cleaned["SEO_EXPORTER_BIND"] == "0.0.0.0"
    loopback = dict(source)
    loopback["SEO_EXPORTER_BIND"] = "127.0.0.1"
    assert runtime_env(loopback)["SEO_EXPORTER_BIND"] == "0.0.0.0"
    assert cleaned["SEO_EXPORTER_STATE_DIR"] == "/var/lib/seo-exporter"
    assert cleaned["CREDENTIALS_DIRECTORY"] == "/run/credentials/seo-exporter"
    assert cleaned["SEO_EXPORTER_GSC_SITE"] == "sc-domain:example.com"


def test_compose_file_matches_ciso_rules() -> None:
    text = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert "cap_drop: [ALL]" in text
    assert "read_only: true" in text
    assert "no-new-privileges:true" in text
    assert "name: seo-exporter_net" in text
    assert "SEO_EXPORTER_BIND: 0.0.0.0" in text
    assert 'SEO_EXPORTER_PORT: "9108"' in text
    assert "mem_limit: 256m" in text
    assert "pids_limit: 128" in text
    assert "mem_limit: 128m" in text
    assert "pids_limit: 64" in text
    assert "prom/prometheus:v3.15.1@sha256:d445d1806b38f85b5c394a1b87f94113fde0473b45245922c2e8b1bd41fa68ae" in text
    assert "create_host_path: false" in text
    assert "--enable-feature=agent" in (ROOT / "deploy" / "prometheus-agent-entrypoint.sh").read_text(encoding="utf-8")
    agent = (ROOT / "deploy" / "prometheus-agent.yml").read_text(encoding="utf-8")
    assert "seo-exporter:9108" in agent
    assert "regex: seo_.*" in agent
    assert "http://100.122.36.23:${SEO_REMOTE_WRITE_PORT}/api/v1/write" in agent
    assert "100.122.36.23:" + "9" not in agent
    assert "expose:" not in text
    assert "ports:" not in text
    assert "docker.sock" not in text
    assert "bezkolejki" not in text
    assert "privileged:" not in text
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert "USER 10001:10001" in dockerfile
    assert "HEALTHCHECK" in dockerfile
    assert "EXPOSE" not in dockerfile
    assert "/opt/seo-exporter" not in dockerfile
    assert "WORKDIR /srv/seo-exporter" in dockerfile
    assert "SEO_EXPORTER_BIND=0.0.0.0" in dockerfile
    assert "SEO_EXPORTER_PORT=9108" in dockerfile
    assert "image_digest" not in dockerfile
    assert "@sha256:9b98a8d37794ca093ba8d5afe1ffac52f5a15168b9b4e67594d86c20e14fa681" in dockerfile
    assert "bezkolejki" not in dockerfile
    assert "docker.sock" not in dockerfile


def test_workflow_contract() -> None:
    deploy = (WORKFLOWS / "deploy.yml").read_text(encoding="utf-8")
    assert "workflow_dispatch:" in deploy
    assert "environment: seo-readonly" in deploy
    assert "persist-credentials: false" in deploy
    assert "bash deploy/sha_guard.sh" in deploy
    assert "secrets.EUK_SSH_SEO_DEPLOY_W216" in deploy
    assert "EUK_SSH_SEO_DEPLOY_V8QX" not in deploy
    assert "HOLD guard (fail-closed)" in deploy
    assert "set -x" not in deploy
    assert deploy.count("packages: write") == 1
    publish, deploy_job = deploy.split("\n  deploy:", 1)
    assert "packages: write" in publish
    assert "secrets." not in publish
    assert "environment:" not in publish
    assert "packages: write" not in deploy_job
    assert "packages: read" in deploy_job
    assert "bash deploy/verify_rollback.sh" in deploy_job
    assert deploy_job.index("bash deploy/verify_rollback.sh") < deploy_job.index("git checkout --detach")
    assert "environment: seo-readonly" in deploy_job
    assert "ghcr.io/${{ github.repository }}" not in deploy
    assert "ghcr.io/eurekalbcom/seo-exporter" in deploy
    on_block = deploy.split("jobs:", 1)[0]
    assert re.search(r"^\s*push:", on_block, flags=re.MULTILINE) is None
    for use in re.findall(r"^\s*uses:\s*(\S+)\s*$", deploy, flags=re.MULTILINE):
        action, pin = use.split("@", 1)
        assert action in {"actions/checkout", "tailscale/github-action"}
        assert _SHA.fullmatch(pin)
    readme = (ROOT / "deploy" / "README.md").read_text(encoding="utf-8")
    assert 'command="/usr/local/sbin/seo-exporter-compose"' in readme
    assert 'from="<CI_NODE_TAILNET_IP>"' in readme
    assert "no-pty,no-port-forwarding,no-agent-forwarding" in readme
    assert "sha256sum docker-compose.yml" in readme
    assert "/opt/seo-exporter" not in readme
    assert "3000" not in readme
    root_readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert 'from="<CI_NODE_TAILNET_IP>"' in root_readme
    assert "/srv/seo-exporter" in root_readme
    assert "9108" in root_readme
    assert "/opt/seo-exporter" not in root_readme
    assert "3000" not in root_readme
    assert "EUK_SSH_SEO_DEPLOY_V8QX" in readme
    assert "witold216" in readme
    assert "previous digest" in readme or "previous image digest" in readme
    assert "systemd" in readme.lower() or "Rejected" in readme


def test_secret_expressions_stay_in_env_or_with() -> None:
    for path in sorted(WORKFLOWS.glob("*.yml")):
        lines = path.read_text(encoding="utf-8").splitlines()
        for index, line in enumerate(lines):
            if "${{ secrets." not in line and "toJSON(secrets." not in line:
                continue
            indent = len(line) - len(line.lstrip(" "))
            parent = None
            for cursor in range(index - 1, -1, -1):
                stripped = lines[cursor].strip()
                if not stripped or stripped.startswith("#") or stripped.startswith("-"):
                    continue
                if ":" not in stripped:
                    continue
                key = stripped.split(":", 1)[0].strip()
                if not key or " " in key or key.startswith("${{"):
                    continue
                if len(lines[cursor]) - len(lines[cursor].lstrip(" ")) < indent:
                    parent = key
                    break
            assert parent in {"env", "with"}, f"{path}:{index + 1} under {parent!r}"


def test_check_workflows_script() -> None:
    completed = subprocess.run(
        ["bash", "deploy/check_workflows.sh"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr


def test_sha_guard(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args: str) -> str:
        completed = subprocess.run(
            ["git", "-c", "user.email=test@example.com", "-c", "user.name=test", *args],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip()

    git("init", "-b", "main")
    (repo / "file").write_text("one\n", encoding="utf-8")
    git("add", "file")
    git("commit", "-m", "one")
    main_sha = git("rev-parse", "HEAD")
    env = os.environ.copy()
    env["DEPLOY_SHA"] = main_sha
    ok = subprocess.run(
        ["bash", str(ROOT / "deploy" / "sha_guard.sh")],
        cwd=repo,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert ok.returncode == 0, ok.stderr
    env["DEPLOY_SHA"] = main_sha[:12]
    short = subprocess.run(
        ["bash", str(ROOT / "deploy" / "sha_guard.sh")],
        cwd=repo,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert short.returncode == 1
    assert "sha-guard: refuse" in short.stderr
    git("checkout", "-b", "side")
    (repo / "file").write_text("two\n", encoding="utf-8")
    git("add", "file")
    git("commit", "-m", "two")
    side_sha = git("rev-parse", "HEAD")
    git("checkout", "main")
    env["DEPLOY_SHA"] = side_sha
    refused = subprocess.run(
        ["bash", str(ROOT / "deploy" / "sha_guard.sh")],
        cwd=repo,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert refused.returncode == 1
    assert side_sha not in refused.stdout


def _run_ssh(tmp_path: Path, updates: dict[str, str]) -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    runner = tmp_path / "runner"
    runner.mkdir(exist_ok=True)
    marker = tmp_path / "ssh-invoked"
    argv_path = tmp_path / "ssh-argv"
    stdin_path = tmp_path / "ssh-stdin"
    ssh = bin_dir / "ssh"
    ssh.write_text(
        "#!/bin/sh\n"
        'touch "$SSH_MARKER"\n'
        'printf "%s\\n" "$*" >> "$SSH_ARGV"\n'
        'printf "\\n--STDIN--\\n" >> "$SSH_STDIN"\n'
        'cat >> "$SSH_STDIN"\n'
        "exit 0\n",
        encoding="utf-8",
    )
    ssh.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
    env["TMPDIR"] = str(runner)
    env["SSH_MARKER"] = str(marker)
    env["SSH_ARGV"] = str(argv_path)
    env["SSH_STDIN"] = str(stdin_path)
    env.update(_base_env())
    env["SEO_TARGET_HOST"] = "target.internal"
    env["SEO_TARGET_HOSTKEY"] = "target.internal ssh-ed25519 AAAAC3TEST\n"
    env["SSH_KEY"] = "deploy-key-material\n"
    env.update(updates)
    return subprocess.run(
        ["bash", "deploy/ssh_deploy.sh"],
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )


def test_ssh_deploy_reaches_host_only_with_secrets(tmp_path: Path) -> None:
    completed = _run_ssh(tmp_path, {})
    assert completed.returncode == 0, completed.stderr
    assert "gsc-secret-marker" not in completed.stdout
    assert "gsc-secret-marker" not in completed.stderr
    argv = (tmp_path / "ssh-argv").read_text(encoding="utf-8")
    stdin = (tmp_path / "ssh-stdin").read_text(encoding="utf-8")
    assert "StrictHostKeyChecking=yes" in argv
    assert "seo-deploy@target.internal" in argv
    assert "docker compose pull" in argv
    assert "docker compose up -d" in argv
    assert "docker compose ps" in argv
    assert argv.index("docker compose pull") < argv.index("docker compose up -d")
    assert "gsc-secret-marker" not in argv
    assert "bing-secret-marker" not in argv
    assert "deploy-key-material" not in argv
    assert "gsc-secret-marker" in stdin
    assert list((tmp_path / "runner").iterdir()) == []


def test_ssh_deploy_fails_closed_before_ssh(tmp_path: Path) -> None:
    completed = _run_ssh(tmp_path, {"GSC_JSON": ""})
    assert completed.returncode != 0
    assert "GSC_JSON missing" in completed.stderr
    assert "gsc-secret-marker" not in completed.stderr
    assert not (tmp_path / "ssh-invoked").exists()
    assert list((tmp_path / "runner").iterdir()) == []


def _wrapper(root: Path, socket_path: Path, bin_dir: Path) -> Path:
    text = (ROOT / "deploy" / "seo-exporter-compose").read_text(encoding="utf-8")
    text = text.replace("ROOT=/srv/seo-exporter", f"ROOT={root}")
    text = text.replace('sock="/run/user/${uid}/docker.sock"', f'sock="{socket_path}"')
    text = text.replace(
        'export PATH="/usr/local/bin:/usr/bin:/bin"',
        f'export PATH="{bin_dir}:/usr/local/bin:/usr/bin:/bin"',
    )
    path = root / "wrapper"
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)
    return path


def _listen(path: Path) -> socket.socket:
    server = socket.socket(socket.AF_UNIX)
    server.bind(str(path))
    server.listen(1)
    return server


def test_forced_command_writes_env_and_refuses_other_commands(tmp_path: Path) -> None:
    root = tmp_path / "srv"
    root.mkdir()
    (root / "data").mkdir()
    compose = "name: seo-exporter\nservices:\n  seo-exporter:\n    image: example\n"
    (root / "docker-compose.yml").write_text(compose, encoding="utf-8")
    compose_sha = hashlib.sha256(compose.encode()).hexdigest()
    env_text = "\n".join(
        (
            f"SEO_EXPORTER_IMAGE={_IMAGE}",
            "SEO_EXPORTER_GSC_SITE='sc-domain:example.com'",
            "SEO_EXPORTER_BING_SITE='https://example.invalid/'",
            f"SEO_EXPORTER_GSC_JSON='{_credential('gsc-secret-marker')}'",
            f"SEO_EXPORTER_BING_JSON='{_credential('bing-secret-marker')}'",
            "SEO_REMOTE_WRITE_PORT=9",
            f"SEO_COMPOSE_SHA256={compose_sha}",
            "",
        )
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "docker-log"
    env_dump = tmp_path / "docker-env"
    docker = bin_dir / "docker"
    docker.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$DOCKER_LOG"\n'
        'env >> "$DOCKER_ENV"\n'
        'if [ "${DOCKER_FAIL:-0}" = 1 ]; then exit 1; fi\n'
        "exit 0\n",
        encoding="utf-8",
    )
    docker.chmod(0o755)
    socket_path = tmp_path / "docker.sock"
    listener = _listen(socket_path)
    try:
        wrapper = _wrapper(root, socket_path, bin_dir)
        base = os.environ.copy()
        base["PATH"] = f"{bin_dir}{os.pathsep}{base.get('PATH', '')}"
        base["DOCKER_LOG"] = str(log)
        base["DOCKER_ENV"] = str(env_dump)
        base["COMPOSE_FILE"] = "/tmp/evil-compose.yml"
        base["COMPOSE_PROJECT_NAME"] = "evil-project"
        base["COMPOSE_PROFILES"] = "evil-profile"
        pulled = subprocess.run(
            ["bash", str(wrapper)],
            input=env_text,
            env={**base, "SSH_ORIGINAL_COMMAND": "docker compose pull"},
            check=False,
            capture_output=True,
            text=True,
        )
        assert pulled.returncode == 0, pulled.stderr
        assert "gsc-secret-marker" not in pulled.stderr
        assert stat.S_IMODE((root / "data" / ".env").stat().st_mode) == 0o600
        assert "gsc-secret-marker" in (root / "data" / ".env").read_text(encoding="utf-8")
        docker_log = log.read_text(encoding="utf-8")
        assert "compose --env-file /srv/seo-exporter/data/.env -f /srv/seo-exporter/docker-compose.yml -p seo-exporter pull" in docker_log
        assert "gsc-secret-marker" not in docker_log
        dumped = env_dump.read_text(encoding="utf-8")
        assert "COMPOSE_FILE=" not in dumped
        assert "COMPOSE_PROJECT_NAME=" not in dumped
        assert "COMPOSE_PROFILES=" not in dumped
        assert "/tmp/evil-compose.yml" not in dumped
        up = subprocess.run(
            ["bash", str(wrapper)],
            input="",
            env={**base, "SSH_ORIGINAL_COMMAND": "docker compose up -d"},
            check=False,
            capture_output=True,
            text=True,
        )
        assert up.returncode == 0, up.stderr
        assert "compose --env-file /srv/seo-exporter/data/.env -f /srv/seo-exporter/docker-compose.yml -p seo-exporter up -d" in log.read_text(
            encoding="utf-8"
        )
        ps = subprocess.run(
            ["bash", str(wrapper)],
            input="",
            env={**base, "SSH_ORIGINAL_COMMAND": "docker compose ps"},
            check=False,
            capture_output=True,
            text=True,
        )
        assert ps.returncode == 0, ps.stderr
        assert "compose --env-file /srv/seo-exporter/data/.env -f /srv/seo-exporter/docker-compose.yml -p seo-exporter ps" in log.read_text(
            encoding="utf-8"
        )
        refused = subprocess.run(
            ["bash", str(wrapper)],
            input="",
            env={**base, "SSH_ORIGINAL_COMMAND": "bash"},
            check=False,
            capture_output=True,
            text=True,
        )
        assert refused.returncode == 1
        assert "command refused" in refused.stderr
    finally:
        listener.close()


def test_forced_command_restores_env_when_pull_fails(tmp_path: Path) -> None:
    root = tmp_path / "srv"
    root.mkdir()
    (root / "data").mkdir()
    compose = "name: seo-exporter\nservices:\n  seo-exporter:\n    image: example\n"
    (root / "docker-compose.yml").write_text(compose, encoding="utf-8")
    compose_sha = hashlib.sha256(compose.encode()).hexdigest()
    data = root / "data"
    previous = data / ".env"
    previous.write_text("previous-env\n", encoding="utf-8")
    previous.chmod(0o600)
    env_text = "\n".join(
        (
            f"SEO_EXPORTER_IMAGE={_IMAGE}",
            "SEO_EXPORTER_GSC_SITE='sc-domain:example.com'",
            "SEO_EXPORTER_BING_SITE='https://example.invalid/'",
            f"SEO_EXPORTER_GSC_JSON='{_credential('gsc-secret-marker')}'",
            f"SEO_EXPORTER_BING_JSON='{_credential('bing-secret-marker')}'",
            "SEO_REMOTE_WRITE_PORT=9",
            f"SEO_COMPOSE_SHA256={compose_sha}",
            "",
        )
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    docker.chmod(0o755)
    socket_path = tmp_path / "docker.sock"
    listener = _listen(socket_path)
    try:
        wrapper = _wrapper(root, socket_path, bin_dir)
        env = os.environ.copy()
        env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
        env["SSH_ORIGINAL_COMMAND"] = "docker compose pull"
        failed = subprocess.run(
            ["bash", str(wrapper)],
            input=env_text,
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )
        assert failed.returncode == 1
        assert "gsc-secret-marker" not in failed.stderr
        assert previous.read_text(encoding="utf-8") == "previous-env\n"
        assert stat.S_IMODE(previous.stat().st_mode) == 0o600
        assert not (data / ".env.prev").exists()
        assert list(data.glob(".env.*")) == []
    finally:
        listener.close()


def _valid_wrapper_env(compose_sha: str) -> str:
    return "\n".join(
        (
            f"SEO_EXPORTER_IMAGE={_IMAGE}",
            "SEO_EXPORTER_GSC_SITE='sc-domain:example.com'",
            "SEO_EXPORTER_BING_SITE='https://example.invalid/'",
            f"SEO_EXPORTER_GSC_JSON='{_credential('gsc-secret-marker')}'",
            f"SEO_EXPORTER_BING_JSON='{_credential('bing-secret-marker')}'",
            "SEO_REMOTE_WRITE_PORT=9",
            f"SEO_COMPOSE_SHA256={compose_sha}",
        )
    ) + "\n"


def _replace_env_line(text: str, prefix: str, new_line: str) -> str:
    lines = [new_line if line.startswith(prefix) else line for line in text.splitlines()]
    return "\n".join(lines) + "\n"


def _run_forced(tmp_path: Path, stdin: str) -> subprocess.CompletedProcess[str]:
    root = tmp_path / "srv"
    if root.exists():
        shutil.rmtree(root)
    root.mkdir()
    (root / "data").mkdir()
    compose = "name: seo-exporter\nservices:\n  seo-exporter:\n    image: example\n"
    (root / "docker-compose.yml").write_text(compose, encoding="utf-8")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    marker = tmp_path / "docker-ran"
    marker.unlink(missing_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(
        "#!/bin/sh\n" f"touch {marker}\n" "exit 0\n",
        encoding="utf-8",
    )
    docker.chmod(0o755)
    socket_path = tmp_path / "docker.sock"
    if socket_path.exists():
        socket_path.unlink()
    listener = _listen(socket_path)
    try:
        wrapper = _wrapper(root, socket_path, bin_dir)
        env = os.environ.copy()
        env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
        env["SSH_ORIGINAL_COMMAND"] = "docker compose pull"
        return subprocess.run(
            ["bash", str(wrapper)],
            input=stdin,
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )
    finally:
        listener.close()


@pytest.mark.parametrize(
    ("label", "body"),
    [
        ("compose_file", "COMPOSE_FILE=/tmp/evil.yml"),
        ("compose_project_name", "COMPOSE_PROJECT_NAME=evil"),
        ("compose_profiles", "COMPOSE_PROFILES=evil"),
        ("short_image_key", "IMAGE=ghcr.io/eurekalbcom/seo-exporter@sha256:" + ("ab" * 32)),
        ("write_mode", "WRITE_MODE=off"),
        ("auth_trust_host", "AUTH_TRUST_HOST=true"),
        ("comment", "# comment"),
        ("blank", ""),
    ],
)
def test_forced_command_rejects_extra_env_lines(tmp_path: Path, label: str, body: str) -> None:
    del label
    root_compose = "name: seo-exporter\nservices:\n  seo-exporter:\n    image: example\n"
    compose_sha = hashlib.sha256(root_compose.encode()).hexdigest()
    text = _valid_wrapper_env(compose_sha) + body + "\n"
    completed = _run_forced(tmp_path, text)
    assert completed.returncode == 1
    assert "env rejected" in completed.stderr
    assert "gsc-secret-marker" not in completed.stderr
    assert not (tmp_path / "docker-ran").exists()
    assert list((tmp_path / "srv").glob(".env")) == []


def test_forced_command_rejects_duplicate_missing_and_bad_image(tmp_path: Path) -> None:
    root_compose = "name: seo-exporter\nservices:\n  seo-exporter:\n    image: example\n"
    compose_sha = hashlib.sha256(root_compose.encode()).hexdigest()
    valid = _valid_wrapper_env(compose_sha)
    duplicate = valid + f"SEO_EXPORTER_IMAGE={_IMAGE}\n"
    missing = "\n".join(line for line in valid.splitlines() if not line.startswith("SEO_COMPOSE_SHA256=")) + "\n"
    other_registry = _replace_env_line(
        valid,
        "SEO_EXPORTER_IMAGE=",
        "SEO_EXPORTER_IMAGE=ghcr.io/example/seo-exporter@sha256:" + ("ab" * 32),
    )
    tagged = _replace_env_line(
        valid,
        "SEO_EXPORTER_IMAGE=",
        "SEO_EXPORTER_IMAGE=ghcr.io/eurekalbcom/seo-exporter:latest",
    )
    suffixed = _replace_env_line(
        valid,
        "SEO_EXPORTER_IMAGE=",
        f"SEO_EXPORTER_IMAGE={_IMAGE}/extra",
    )
    swapped_duplicate = _replace_env_line(valid, "SEO_COMPOSE_SHA256=", f"SEO_EXPORTER_IMAGE={_IMAGE}")
    for body in (duplicate, missing, other_registry, tagged, suffixed, swapped_duplicate):
        completed = _run_forced(tmp_path, body)
        assert completed.returncode == 1
        assert "env rejected" in completed.stderr
        assert not (tmp_path / "docker-ran").exists()


def test_forced_command_rejects_stdin_over_64kib(tmp_path: Path) -> None:
    completed = _run_forced(tmp_path, "A" * 65537)
    assert completed.returncode == 1
    assert "env rejected" in completed.stderr
    assert not (tmp_path / "docker-ran").exists()
    assert list((tmp_path / "srv").glob(".env*")) == []


def test_hostkey_rejected_before_ssh(tmp_path: Path) -> None:
    samples = (
        "target.internal ssh-ed25519 AAAA\nsecret-hostkey-marker",
        "@cert-authority target.internal ssh-ed25519 secret-hostkey-marker",
        "@revoked * ssh-ed25519 secret-hostkey-marker",
        "target.internal ssh-ed25519 AAAA @revoked secret-hostkey-marker",
        "target.internal ssh-ed25519 AAAA\n\n",
        "@Cert-Authority target.internal ssh-ed25519 secret-hostkey-marker",
    )
    for hostkey in samples:
        completed = _run_ssh(tmp_path, {"SEO_TARGET_HOSTKEY": hostkey})
        assert completed.returncode != 0
        assert "target host key variable is invalid" in completed.stderr
        assert "secret-hostkey-marker" not in completed.stderr
        assert "secret-hostkey-marker" not in completed.stdout
        assert not (tmp_path / "ssh-invoked").exists()


def test_hostkey_accepts_one_trailing_crlf(tmp_path: Path) -> None:
    completed = _run_ssh(
        tmp_path,
        {"SEO_TARGET_HOSTKEY": "target.internal ssh-ed25519 AAAAC3TEST\r\n"},
    )
    assert completed.returncode == 0, completed.stderr
    assert (tmp_path / "ssh-invoked").exists()


def test_push_log_digest_matches_repo_digests(tmp_path: Path) -> None:
    digest = "sha256:" + ("cd" * 32)
    line = f"{_REPO}:sha-{'ab' * 20}: digest: {digest} size: 2048"
    assert re.match(r"^digest: sha256:[0-9a-f]{64}$", line) is None
    assert digest_from_push_log(line + "\n") == digest
    raw = json.dumps([f"{_REPO}@{digest}"])
    assert digest_from_repo_digests(raw) == digest
    other = json.dumps([f"ghcr.io/example/seo-exporter@{digest}"])
    with pytest.raises(ValueError, match="registry digest missing"):
        digest_from_repo_digests(other)
    log = tmp_path / "push.log"
    inspect = tmp_path / "repo.json"
    log.write_text(line + "\n", encoding="utf-8")
    inspect.write_text(raw, encoding="utf-8")
    ok = subprocess.run(
        [sys.executable, "-m", "deploy.image_digest", str(log), str(inspect)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert ok.returncode == 0, ok.stderr
    assert ok.stdout.strip() == digest
    inspect.write_text(json.dumps([f"{_REPO}@sha256:{'ef' * 32}"]), encoding="utf-8")
    mismatch = subprocess.run(
        [sys.executable, "-m", "deploy.image_digest", str(log), str(inspect)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert mismatch.returncode == 1
    assert "registry digest missing" in mismatch.stderr
    assert "size:" not in mismatch.stderr
    assert digest not in mismatch.stderr
    script = (ROOT / "deploy" / "build_push.sh").read_text(encoding="utf-8")
    assert "awk '/^digest:" not in script
    assert "docker image inspect" in script
    assert _REPO in script


def test_build_push_refuses_other_registry_before_docker(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    marker = tmp_path / "docker-ran"
    docker = bin_dir / "docker"
    docker.write_text("#!/bin/sh\n" f"touch {marker}\n" "exit 1\n", encoding="utf-8")
    docker.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
    env["GHCR_TOKEN"] = "token-marker"
    env["IMAGE_REPO"] = "ghcr.io/example/seo-exporter"
    env["DEPLOY_SHA"] = "ab" * 20
    env["GITHUB_ACTOR"] = "tester"
    completed = subprocess.run(
        ["bash", "deploy/build_push.sh"],
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 1
    assert "image repo refused" in completed.stderr
    assert "token-marker" not in completed.stderr
    assert not marker.exists()


def test_agent_entrypoint_renders_port(tmp_path: Path) -> None:
    template = tmp_path / "template.yml"
    template.write_text(
        (ROOT / "deploy" / "prometheus-agent.yml").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    rendered = tmp_path / "rendered.yml"
    args = tmp_path / "args"
    stub = tmp_path / "prometheus"
    stub.write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$PROM_ARGS\"\n",
        encoding="utf-8",
    )
    stub.chmod(0o755)
    env = os.environ.copy()
    env.update(
        {
            "PROM_TEMPLATE": str(template),
            "PROM_RENDERED": str(rendered),
            "PROMETHEUS_BIN": str(stub),
            "PROM_STORAGE": str(tmp_path / "wal"),
            "PROM_ARGS": str(args),
            "SEO_REMOTE_WRITE_PORT": "9",
        }
    )
    completed = subprocess.run(
        ["sh", str(ROOT / "deploy" / "prometheus-agent-entrypoint.sh")],
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    body = rendered.read_text(encoding="utf-8")
    assert "http://100.122.36.23:9/api/v1/write" in body
    assert "SEO_REMOTE_WRITE_PORT" not in body
    recorded = args.read_text(encoding="utf-8")
    assert "--enable-feature=agent" in recorded
    assert "--web.listen-address=127.0.0.1:9090" in recorded
    for bad in ("", "0", "65536", "08", "abc"):
        env["SEO_REMOTE_WRITE_PORT"] = bad
        rejected = subprocess.run(
            ["sh", str(ROOT / "deploy" / "prometheus-agent-entrypoint.sh")],
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )
        assert rejected.returncode == 1
        assert "SEO_REMOTE_WRITE_PORT rejected" in rejected.stderr


def test_forced_command_rejects_remote_write_port(tmp_path: Path) -> None:
    compose = "name: seo-exporter\nservices:\n  seo-exporter:\n    image: example\n"
    compose_sha = hashlib.sha256(compose.encode()).hexdigest()
    valid = _valid_wrapper_env(compose_sha)
    for port in ("0", "65536", "08", "abc", ""):
        body = _replace_env_line(valid, "SEO_REMOTE_WRITE_PORT=", f"SEO_REMOTE_WRITE_PORT={port}")
        completed = _run_forced(tmp_path, body)
        assert completed.returncode == 1
        assert "env rejected" in completed.stderr
        assert not (tmp_path / "docker-ran").exists()
    pad = "p" * 40000
    with pytest.raises(ValueError, match="env file rejected"):
        render_env(_IMAGE, pad, pad, pad, pad, "9", "ab" * 32)


def test_entrypoint_rejects_write_mode_and_auth_trust_host() -> None:
    with pytest.raises(SystemExit, match="WRITE_MODE rejected"):
        runtime_env({"PATH": "/usr/bin", "WRITE_MODE": "off"})
    with pytest.raises(SystemExit, match="AUTH_TRUST_HOST rejected"):
        runtime_env({"AUTH_TRUST_HOST": "false"})


def test_rendered_env_quotes_sites_and_json_for_compose(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "data").mkdir()
    shutil.copy(ROOT / "docker-compose.yml", project / "docker-compose.yml")
    source = _base_env()
    source["COMPOSE_FILE"] = str(project / "docker-compose.yml")
    source["GSC_SITE"] = "sc-domain:${UNTRUSTED}"
    source["GSC_JSON"] = _credential("${UNTRUSTED}")
    text = build_from_environ(source)
    for key in (
        "SEO_EXPORTER_GSC_SITE",
        "SEO_EXPORTER_BING_SITE",
        "SEO_EXPORTER_GSC_JSON",
        "SEO_EXPORTER_BING_JSON",
    ):
        value = next(line.split("=", 1)[1] for line in text.splitlines() if line.startswith(key + "="))
        assert re.fullmatch(r"'[^']+'", value), key
    (project / "data" / ".env").write_text(text, encoding="utf-8")
    (project / "data" / ".env").chmod(0o600)
    env = os.environ.copy()
    env["UNTRUSTED"] = "pwned-marker"
    env["SEO_REMOTE_WRITE_PORT"] = "9"
    rendered = subprocess.run(
        [
            "docker",
            "compose",
            "--project-directory",
            str(project),
            "--env-file",
            str(project / "data" / ".env"),
            "config",
        ],
        cwd=project,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert rendered.returncode == 0, rendered.stderr
    assert "pwned-marker" not in rendered.stdout
    assert "$${UNTRUSTED}" in rendered.stdout
    quoted = source.copy()
    quoted["BING_SITE"] = "https://example.com/a'b"
    with pytest.raises(ValueError, match="BING_SITE rejected"):
        build_from_environ(quoted)
    quoted_json = source.copy()
    quoted_json["BING_JSON"] = _credential("sec'ret")
    with pytest.raises(ValueError, match="env value rejected"):
        build_from_environ(quoted_json)


def test_forced_command_rejects_unquoted_interpolation(tmp_path: Path) -> None:
    compose = "name: seo-exporter\nservices:\n  seo-exporter:\n    image: example\n"
    compose_sha = hashlib.sha256(compose.encode()).hexdigest()
    valid = _valid_wrapper_env(compose_sha)
    bodies = (
        _replace_env_line(valid, "SEO_EXPORTER_GSC_SITE=", "SEO_EXPORTER_GSC_SITE=sc-domain:${UNTRUSTED}"),
        _replace_env_line(valid, "SEO_EXPORTER_BING_SITE=", "SEO_EXPORTER_BING_SITE='https://example.com/a'b'"),
        _replace_env_line(
            valid,
            "SEO_EXPORTER_GSC_JSON=",
            'SEO_EXPORTER_GSC_JSON={"client_secret":"${UNTRUSTED}"}',
        ),
        _replace_env_line(
            valid,
            "SEO_EXPORTER_BING_JSON=",
            'SEO_EXPORTER_BING_JSON=\'{"client_secret":"sec\'"\'"\'ret"}\'',
        ),
    )
    for body in bodies:
        completed = _run_forced(tmp_path, body)
        assert completed.returncode == 1
        assert "env rejected" in completed.stderr
        assert "UNTRUSTED" not in completed.stderr
        assert not (tmp_path / "docker-ran").exists()


def _git_main(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args: str) -> str:
        completed = subprocess.run(
            ["git", "-c", "user.email=test@example.com", "-c", "user.name=test", *args],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip()

    git("init", "-b", "main")
    (repo / "file").write_text("one\n", encoding="utf-8")
    git("add", "file")
    git("commit", "-m", "one")
    return repo, git("rev-parse", "HEAD")


def _rollback_docker(bin_dir: Path, script: str) -> None:
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(script, encoding="utf-8")
    docker.chmod(0o755)


def test_rollback_rejects_mismatched_and_foreign_digests(tmp_path: Path) -> None:
    repo, sha = _git_main(tmp_path)
    digest = "sha256:" + ("ab" * 32)
    other = "sha256:" + ("cd" * 32)
    inspect = tmp_path / "inspect.txt"
    inspect.write_text(
        f"Name:\t{_REPO}:sha-{sha}\nMediaType:\tapplication/vnd.oci.image.manifest.v1+json\nDigest:\t{other}\n",
        encoding="utf-8",
    )
    bin_dir = tmp_path / "bin"
    ran = tmp_path / "docker-ran"
    argv = tmp_path / "docker-argv"
    _rollback_docker(
        bin_dir,
        "#!/bin/sh\n"
        'touch "$DOCKER_RAN"\n'
        'printf "%s\\n" "$*" >> "$DOCKER_ARGV"\n'
        'if [ "$1" = "login" ]; then cat >/dev/null; exit 0; fi\n'
        'if [ "$1" = "logout" ]; then exit 0; fi\n'
        'if [ "$1" = "buildx" ]; then cat "$DOCKER_INSPECT"; exit 0; fi\n'
        'echo "unexpected $*" >&2\n'
        "exit 1\n",
    )
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
    env["DOCKER_RAN"] = str(ran)
    env["DOCKER_ARGV"] = str(argv)
    env["DOCKER_INSPECT"] = str(inspect)
    env["GHCR_TOKEN"] = "token-marker"
    env["GITHUB_ACTOR"] = "tester"
    env["DEPLOY_SHA"] = sha
    env["IMAGE_DIGEST"] = digest
    mismatch = subprocess.run(
        ["bash", str(ROOT / "deploy" / "verify_rollback.sh")],
        cwd=repo,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert mismatch.returncode == 1
    assert "rollback digest mismatch" in mismatch.stderr
    assert "token-marker" not in mismatch.stdout
    assert "token-marker" not in mismatch.stderr
    assert "sha-guard: ok" in mismatch.stdout
    assert f"buildx imagetools inspect {_REPO}:sha-{sha}" in argv.read_text(encoding="utf-8")
    ran.unlink()
    for foreign in (
        f"ghcr.io/example/seo-exporter@{digest}",
        f"ghcr.io/eurekalbcom/other@{digest}",
        f"docker.io/library/seo-exporter@{digest}",
    ):
        env["IMAGE_DIGEST"] = foreign
        refused = subprocess.run(
            ["bash", str(ROOT / "deploy" / "verify_rollback.sh")],
            cwd=repo,
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )
        assert refused.returncode == 1
        assert "rollback digest rejected" in refused.stderr
        assert "token-marker" not in refused.stderr
        assert foreign not in refused.stderr
        assert not ran.exists()
    subprocess.run(
        ["git", "-c", "user.email=test@example.com", "-c", "user.name=test", "checkout", "-b", "side"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    (repo / "file").write_text("two\n", encoding="utf-8")
    subprocess.run(
        ["git", "-c", "user.email=test@example.com", "-c", "user.name=test", "add", "file"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "two"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    side_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    subprocess.run(["git", "checkout", "main"], cwd=repo, check=True, capture_output=True, text=True)
    env["DEPLOY_SHA"] = side_sha
    env["IMAGE_DIGEST"] = digest
    ancestor = subprocess.run(
        ["bash", str(ROOT / "deploy" / "verify_rollback.sh")],
        cwd=repo,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert ancestor.returncode == 1
    assert "sha-guard: refuse" in ancestor.stderr
    assert side_sha not in ancestor.stdout
    assert not ran.exists()
    assert canonical_digest(digest) == digest
    with pytest.raises(RollbackError, match="rollback digest rejected"):
        canonical_digest(f"ghcr.io/example/seo-exporter@{digest}")
    report = (
        f"Name:\t{_REPO}:sha-{sha}\n"
        "MediaType:\tapplication/vnd.oci.image.manifest.v1+json\n"
        f"Digest:\t{digest}\n"
    )
    assert digest_from_inspect(report, sha) == digest
    manifest = json.dumps(
        {
            "Ref": f"{_REPO}:sha-{sha}",
            "Descriptor": {"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": digest, "size": 4},
        }
    )
    assert digest_from_inspect(manifest, sha) == digest
    with pytest.raises(RollbackError, match="rollback digest rejected"):
        digest_from_inspect(
            json.dumps({"name": f"ghcr.io/example/seo-exporter:sha-{sha}", "manifest": {"digest": digest}}),
            sha,
        )
    with pytest.raises(RollbackError, match="rollback digest missing"):
        digest_from_inspect(json.dumps([{"Descriptor": {"digest": digest}}]), sha)
