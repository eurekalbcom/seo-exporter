"""Scrape loop, metrics text, and the localhost server."""

from __future__ import annotations

import json
import logging
import threading
import urllib.request
from datetime import UTC, date, datetime, tzinfo
from pathlib import Path

import pytest

from seo_exporter.credentials import OAuthClient
from seo_exporter.logging_redact import Redactor
from seo_exporter.metrics import Registry
from seo_exporter.oauth import AccessSession
from seo_exporter.providers import ProviderError
from seo_exporter.server import assert_bind_allowed, make_server
from seo_exporter.service import run_once
from seo_exporter.settings import Settings, load_settings

SENTINEL = "query-sentinel-value"


class FakeHttp:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.bodies: list[bytes | None] = []

    def __call__(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float | None,
    ) -> bytes:
        self.calls.append(url)
        self.bodies.append(body)
        if "oauth2.googleapis.com" in url:
            return json.dumps(
                {"access_token": "access-token-test", "expires_in": 3600}
            ).encode()
        if "webmasters/oauth/token" in url:
            return json.dumps(
                {
                    "access_token": "bing-access-token",
                    "expires_in": 120,
                    "refresh_token": "rotated-refresh-test",
                }
            ).encode()
        if "searchAnalytics" in url:
            return b'{"rows":[{"clicks":5,"impressions":10,"position":2}]}'
        if "GetQueryStats" in url:
            return json.dumps(
                {
                    "d": [
                        {
                            "Clicks": 3,
                            "Impressions": 9,
                            "AvgImpressionPosition": 4,
                            "Query": SENTINEL,
                        }
                    ]
                }
            ).encode()
        raise ProviderError("transport")


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        bind="127.0.0.1",
        port=9108,
        interval_seconds=3600,
        lookback_days=28,
        lag_days=3,
        gsc_site="sc-domain:property",
        bing_site="site-token",
        credentials_dir=tmp_path,
        state_dir=tmp_path / "state",
        timeout_seconds=5,
    )


def test_run_once_updates_metrics_without_leaking_query(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    redactor = Redactor()
    logger = logging.getLogger("seo_exporter")
    logger.addFilter(redactor)
    try:
        registry = Registry()
        gsc = OAuthClient("client-id-test", "client-secret-test", "refresh-token-test")
        bing = OAuthClient("bing-client-id", "bing-client-secret", "bing-refresh-test")
        redactor.add(gsc.client_secret)
        redactor.add(bing.client_secret)
        with caplog.at_level(logging.INFO):
            run_once(
                _settings(tmp_path),
                gsc,
                bing,
                AccessSession(gsc.refresh_token),
                AccessSession(bing.refresh_token),
                registry,
                FakeHttp(),
                redactor,
                today=date(2026, 10, 15),
                now=lambda: 0.0,
            )
        text = registry.render()
        assert 'seo_exporter_up{provider="gsc"} 1' in text
        assert 'seo_exporter_clicks{provider="bing"} 3' in text
        assert SENTINEL not in text
        assert "client-secret-test" not in caplog.text
        assert "rotated-refresh-test" not in caplog.text
        assert SENTINEL not in caplog.text
        stored = (
            (tmp_path / "state" / "bing.refresh").read_text(encoding="utf-8").strip()
        )
        assert stored == "rotated-refresh-test"
        mode = (tmp_path / "state" / "bing.refresh").stat().st_mode & 0o777
        assert mode == 0o600
    finally:
        logger.removeFilter(redactor)


def test_run_once_gsc_window_uses_pacific_date(tmp_path: Path) -> None:
    redactor = Redactor()
    http = FakeHttp()
    gsc = OAuthClient("client-id-test", "client-secret-test", "refresh-token-test")
    bing = OAuthClient("bing-client-id", "bing-client-secret", "bing-refresh-test")
    redactor.add(gsc.client_secret)
    redactor.add(bing.client_secret)
    moment = datetime(2026, 10, 15, 2, 0, tzinfo=UTC)

    def clock(zone: tzinfo) -> datetime:
        return moment.astimezone(zone)

    run_once(
        _settings(tmp_path),
        gsc,
        bing,
        AccessSession(gsc.refresh_token),
        AccessSession(bing.refresh_token),
        Registry(),
        http,
        redactor,
        now=lambda: 0.0,
        clock=clock,
    )
    raw = next(
        body
        for url, body in zip(http.calls, http.bodies, strict=True)
        if "searchAnalytics" in url
    )
    encoded = json.loads(raw or b"{}")
    assert encoded["startDate"] == "2026-09-14"
    assert encoded["endDate"] == "2026-10-11"


def test_redactor_rewrites_log_records(caplog: pytest.LogCaptureFixture) -> None:
    redactor = Redactor()
    redactor.add("client-secret-test")
    logger = logging.getLogger("seo_exporter")
    logger.addFilter(redactor)
    try:
        with caplog.at_level(logging.INFO):
            logger.info("value=%s", "client-secret-test")
        assert "client-secret-test" not in caplog.text
        assert "[redacted]" in caplog.text
    finally:
        logger.removeFilter(redactor)


def test_settings_and_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", "/run/credentials/seo-exporter.service")
    monkeypatch.setenv("SEO_EXPORTER_GSC_SITE", "sc-domain:property")
    monkeypatch.setenv("SEO_EXPORTER_BING_SITE", "site-token")
    settings = load_settings()
    assert settings.bind == "127.0.0.1"
    assert settings.port == 9108
    assert settings.interval_seconds == 3600
    host = ".".join(("203", "0", "113", "10"))
    assert_bind_allowed("0.0.0.0")
    assert_bind_allowed("127.0.0.1")
    with pytest.raises(SystemExit):
        assert_bind_allowed(host)
    monkeypatch.setenv("SEO_EXPORTER_GSC_SITE", "  ")
    with pytest.raises(SystemExit):
        load_settings()


def test_metrics_server(caplog: pytest.LogCaptureFixture) -> None:
    registry = Registry()
    registry.set_gauge("seo_exporter_up", 1, {"provider": "gsc"})
    server = make_server("127.0.0.1", 0, registry)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
    )
    thread.start()
    port = server.server_address[1]
    try:
        with caplog.at_level(logging.INFO, logger="seo_exporter"):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/metrics?{SENTINEL}", timeout=2
            ) as response:
                body = response.read().decode()
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/healthz", timeout=2
            ) as response:
                assert response.read() == b"ok\n"
            with pytest.raises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/nope", timeout=2)
        assert caught.value.code == 404
        assert 'seo_exporter_up{provider="gsc"} 1' in body
        assert SENTINEL not in caplog.text
    finally:
        server.shutdown()
        server.server_close()


def test_all_interfaces_bind_accepts_loopback_client() -> None:
    registry = Registry()
    server = make_server("0.0.0.0", 0, registry)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
    )
    thread.start()
    port = server.server_address[1]
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as response:
            assert response.read() == b"ok\n"
    finally:
        server.shutdown()
        server.server_close()
