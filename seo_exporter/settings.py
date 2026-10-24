"""Process settings from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    """Runtime settings.

    Attributes:
        bind: Loopback address for the metrics server.
        port: Metrics TCP port.
        interval_seconds: Delay between scrapes.
        lookback_days: Search Console window length.
        lag_days: Days excluded from the end of the Search Console window.
        gsc_site: Search Console property identifier.
        bing_site: Bing site URL.
        credentials_dir: Systemd credentials directory.
        state_dir: Directory for rotated refresh tokens.
        timeout_seconds: HTTP timeout.
    """

    bind: str
    port: int
    interval_seconds: int
    lookback_days: int
    lag_days: int
    gsc_site: str
    bing_site: str
    credentials_dir: Path
    state_dir: Path
    timeout_seconds: float


def load_settings() -> Settings:
    """Load settings from the environment.

    Returns:
        Validated settings.

    Raises:
        SystemExit: A required value is missing or out of range.
    """
    credentials = os.environ.get("CREDENTIALS_DIRECTORY", "")
    if not credentials:
        raise SystemExit("CREDENTIALS_DIRECTORY is not set")
    return Settings(
        bind=os.environ.get("SEO_EXPORTER_BIND", "127.0.0.1"),
        port=_int(
            "SEO_EXPORTER_PORT", os.environ.get("SEO_EXPORTER_PORT", "9108"), 1, 65535
        ),
        interval_seconds=_int(
            "SEO_EXPORTER_INTERVAL_SECONDS",
            os.environ.get("SEO_EXPORTER_INTERVAL_SECONDS", "3600"),
            60,
            86400,
        ),
        lookback_days=_int(
            "SEO_EXPORTER_LOOKBACK_DAYS",
            os.environ.get("SEO_EXPORTER_LOOKBACK_DAYS", "28"),
            1,
            480,
        ),
        lag_days=_int(
            "SEO_EXPORTER_LAG_DAYS",
            os.environ.get("SEO_EXPORTER_LAG_DAYS", "3"),
            0,
            14,
        ),
        gsc_site=_required("SEO_EXPORTER_GSC_SITE"),
        bing_site=_required("SEO_EXPORTER_BING_SITE"),
        credentials_dir=Path(credentials),
        state_dir=_state_dir(
            os.environ.get("SEO_EXPORTER_STATE_DIR", "/var/lib/seo-exporter")
        ),
        timeout_seconds=float(
            _int(
                "SEO_EXPORTER_TIMEOUT_SECONDS",
                os.environ.get("SEO_EXPORTER_TIMEOUT_SECONDS", "30"),
                1,
                120,
            )
        ),
    )


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is empty")
    return value


def _state_dir(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise SystemExit("state directory must be absolute")
    return path


def _int(name: str, raw: str, low: int, high: int) -> int:
    try:
        value = int(raw)
    except ValueError:
        raise SystemExit(f"{name} is invalid") from None
    if value < low or value > high:
        raise SystemExit(f"{name} is invalid")
    return value
