"""Scrape loop and process entrypoint."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Literal, NoReturn

from seo_exporter.bing import fetch_query_stats
from seo_exporter.credentials import OAuthClient, load_provider_clients
from seo_exporter.gsc import date_window, fetch_search_analytics
from seo_exporter.http_client import UrlLibClient
from seo_exporter.logging_redact import Redactor, install_redactor
from seo_exporter.metrics import Registry
from seo_exporter.oauth import (
    BING_TOKEN_URL,
    GOOGLE_TOKEN_URL,
    AccessSession,
    HttpCaller,
    refresh_access_token,
)
from seo_exporter.providers import ProviderError, TrafficSnapshot
from seo_exporter.refresh_store import load_refresh_token, store_refresh_token
from seo_exporter.server import make_server
from seo_exporter.settings import Settings, load_settings

logger = logging.getLogger("seo_exporter")
ProviderName = Literal["gsc", "bing"]


def run_once(
    settings: Settings,
    gsc: OAuthClient,
    bing: OAuthClient,
    gsc_session: AccessSession,
    bing_session: AccessSession,
    registry: Registry,
    http: HttpCaller,
    redactor: Redactor,
    *,
    today: date | None = None,
    now: Callable[[], float] | None = None,
) -> None:
    """Scrape both providers and update the registry.

    Args:
        settings: Runtime settings.
        gsc: Google client.
        bing: Bing client.
        gsc_session: Google token cache.
        bing_session: Bing token cache.
        registry: Prometheus registry.
        http: HTTP caller.
        redactor: Secret redactor.
        today: Override for the Search Console window.
        now: Monotonic clock used for token expiry.
    """
    current_day = datetime.now(UTC).date() if today is None else today
    _scrape(
        "gsc",
        settings,
        gsc,
        gsc_session,
        registry,
        http,
        redactor,
        today=current_day,
        now=now,
    )
    _scrape(
        "bing",
        settings,
        bing,
        bing_session,
        registry,
        http,
        redactor,
        today=current_day,
        now=now,
    )


def main() -> int:
    """Start the metrics server and scrape loop.

    Returns:
        Process status code.
    """
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    redactor = install_redactor()
    settings = load_settings()
    gsc, bing = load_provider_clients(
        settings.credentials_dir, redactor, enforce_mount=True
    )
    gsc_session = _session(settings.state_dir / "gsc.refresh", gsc, redactor)
    bing_session = _session(settings.state_dir / "bing.refresh", bing, redactor)
    registry = Registry()
    http = UrlLibClient(settings.timeout_seconds)
    stop = threading.Event()

    def loop() -> None:
        while not stop.is_set():
            run_once(
                settings,
                gsc,
                bing,
                gsc_session,
                bing_session,
                registry,
                http,
                redactor,
            )
            if stop.wait(settings.interval_seconds):
                return

    server = make_server(settings.bind, settings.port, registry)
    worker = threading.Thread(target=loop, name="seo-scrape", daemon=True)
    worker.start()
    logger.info("metrics listening")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        stop.set()
        server.shutdown()
        worker.join(timeout=5)
    return 0


def _session(path: Path, client: OAuthClient, redactor: Redactor) -> AccessSession:
    stored = load_refresh_token(path)
    refresh = client.refresh_token if stored is None else stored
    redactor.add(refresh)
    return AccessSession(refresh_token=refresh)


def _scrape(
    provider: ProviderName,
    settings: Settings,
    client: OAuthClient,
    session: AccessSession,
    registry: Registry,
    http: HttpCaller,
    redactor: Redactor,
    *,
    today: date,
    now: Callable[[], float] | None,
) -> None:
    started = time.perf_counter()
    labels = {"provider": provider}
    previous_refresh = session.refresh_token
    try:
        token_url = _token_url(provider)
        access_token = refresh_access_token(
            client,
            session,
            token_url,
            http,
            redactor,
            now=now,
        )
        if session.refresh_token != previous_refresh:
            _persist(
                settings.state_dir / f"{provider}.refresh",
                session.refresh_token,
                provider,
            )
        snapshot = _fetch(provider, settings, http, access_token, today)
    except ProviderError as exc:
        registry.set_gauge("seo_exporter_up", 0, labels)
        registry.set_gauge(
            "seo_exporter_scrape_duration_seconds",
            time.perf_counter() - started,
            labels,
        )
        registry.inc_counter("seo_exporter_errors_total", 1, labels)
        logger.warning("scrape failed provider=%s reason=%s", provider, exc)
        return
    _record_success(registry, provider, snapshot, time.perf_counter() - started)
    logger.info(
        "scrape ok provider=%s rows=%s duration_seconds=%.3f",
        provider,
        snapshot.rows,
        time.perf_counter() - started,
    )


def _token_url(provider: ProviderName) -> str:
    if provider == "gsc":
        return GOOGLE_TOKEN_URL
    if provider == "bing":
        return BING_TOKEN_URL
    _never(provider)


def _fetch(
    provider: ProviderName,
    settings: Settings,
    http: HttpCaller,
    access_token: str,
    today: date,
) -> TrafficSnapshot:
    if provider == "gsc":
        start, end = date_window(today, settings.lookback_days, settings.lag_days)
        return fetch_search_analytics(http, access_token, settings.gsc_site, start, end)
    if provider == "bing":
        return fetch_query_stats(http, access_token, settings.bing_site)
    _never(provider)


def _record_success(
    registry: Registry,
    provider: ProviderName,
    snapshot: TrafficSnapshot,
    duration: float,
) -> None:
    labels = {"provider": provider}
    registry.set_gauge("seo_exporter_up", 1, labels)
    registry.set_gauge("seo_exporter_clicks", snapshot.clicks, labels)
    registry.set_gauge("seo_exporter_impressions", snapshot.impressions, labels)
    registry.set_gauge("seo_exporter_ctr", snapshot.ctr, labels)
    registry.set_gauge("seo_exporter_position", snapshot.position, labels)
    registry.set_gauge("seo_exporter_rows", float(snapshot.rows), labels)
    registry.set_gauge(
        "seo_exporter_last_success_unixtime",
        datetime.now(UTC).timestamp(),
        labels,
    )
    registry.set_gauge("seo_exporter_scrape_duration_seconds", duration, labels)


def _persist(path: Path, token: str, provider: ProviderName) -> None:
    try:
        store_refresh_token(path, token)
    except OSError:
        logger.warning("refresh token not persisted provider=%s", provider)


def _never(provider: ProviderName) -> NoReturn:
    raise AssertionError(provider)
