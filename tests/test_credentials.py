"""Credential loading."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from seo_exporter.credentials import (
    client_from_bytes,
    credential_mount_ok,
    load_provider_clients,
)
from seo_exporter.logging_redact import Redactor

SECRET = "client-secret-test"


def _document(secret: str = SECRET) -> bytes:
    return json.dumps(
        {
            "client_id": "client-id-test",
            "client_secret": secret,
            "refresh_token": "refresh-token-test",
            "ignored": "drop-me",
        }
    ).encode()


def test_loads_required_fields() -> None:
    redactor = Redactor()
    client = client_from_bytes(_document(), "gsc", redactor)
    assert client.client_id == "client-id-test"
    assert client.client_secret == SECRET
    assert client.refresh_token == "refresh-token-test"


def test_invalid_json_hides_the_document() -> None:
    raw = b'{"client_secret": "client-secret-test"'
    with pytest.raises(SystemExit) as caught:
        client_from_bytes(raw, "gsc", Redactor())
    assert SECRET not in str(caught.value)
    assert "provider=gsc" in str(caught.value)


def test_missing_field_names_the_field_not_the_value() -> None:
    raw = json.dumps({"client_id": "client-id-test", "client_secret": SECRET}).encode()
    with pytest.raises(SystemExit) as caught:
        client_from_bytes(raw, "bing", Redactor())
    assert "field=refresh_token" in str(caught.value)
    assert SECRET not in str(caught.value)


def test_pair_and_mount(tmp_path: Path) -> None:
    creds = tmp_path / "creds"
    creds.mkdir()
    (creds / "gsc.json").write_bytes(_document())
    (creds / "bing.json").write_bytes(_document("bing-secret-test"))
    loaded = load_provider_clients(creds, Redactor(), enforce_mount=False)
    assert loaded[1].client_secret == "bing-secret-test"
    with pytest.raises(SystemExit) as caught:
        load_provider_clients(creds, Redactor(), enforce_mount=True)
    assert "systemd credential mount" in str(caught.value)
    assert SECRET not in str(caught.value)
    assert credential_mount_ok(creds) is False
