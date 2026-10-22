"""Google Search Console searchAnalytics totals.

The request asks for the property total over a date window and does not ask
for the query dimension, so search queries are not part of the response we
request.
"""

from __future__ import annotations

import json
import urllib.parse
from collections.abc import Mapping
from datetime import date, timedelta

from seo_exporter.oauth import HttpCaller
from seo_exporter.providers import ProviderError, TrafficSnapshot, snapshot_from_rows

_ENDPOINT = (
    "https://www.googleapis.com/webmasters/v3/sites/{site}/searchAnalytics/query"
)


def date_window(today: date, lookback_days: int, lag_days: int) -> tuple[str, str]:
    """Return inclusive ``startDate`` and ``endDate`` strings.

    Args:
        today: Current date in America/Los_Angeles.
        lookback_days: Number of days in the window.
        lag_days: Days to step back from today so partial data is excluded.

    Returns:
        ISO dates ``(start, end)``.
    """
    end = today - timedelta(days=lag_days)
    start = end - timedelta(days=lookback_days - 1)
    return start.isoformat(), end.isoformat()


def fetch_search_analytics(
    http: HttpCaller,
    access_token: str,
    site: str,
    start_date: str,
    end_date: str,
) -> TrafficSnapshot:
    """Fetch property totals from Search Console.

    Args:
        http: HTTP caller.
        access_token: Bearer token.
        site: Search Console property identifier.
        start_date: Inclusive start date.
        end_date: Inclusive end date.

    Returns:
        Aggregated totals for the window.

    Raises:
        ProviderError: The response shape was not usable.
    """
    url = _ENDPOINT.format(site=urllib.parse.quote(site, safe=""))
    body = json.dumps(
        {
            "startDate": start_date,
            "endDate": end_date,
            "dataState": "final",
            "type": "web",
        }
    ).encode()
    raw = http(
        "POST",
        url,
        {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        body,
        None,
    )
    return _parse(raw)


def _parse(raw: bytes) -> TrafficSnapshot:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        raise ProviderError("invalid-json") from None
    if not isinstance(payload, dict):
        raise ProviderError("invalid-shape")
    rows = payload.get("rows") or []
    if not isinstance(rows, list):
        raise ProviderError("invalid-shape")
    parsed: list[tuple[float, float, float]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise ProviderError("invalid-shape")
        parsed.append(
            (
                _number(row, "clicks"),
                _number(row, "impressions"),
                _number(row, "position"),
            )
        )
    return snapshot_from_rows(parsed)


def _number(row: Mapping[str, object], field: str) -> float:
    value = row.get(field, 0)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProviderError("invalid-shape")
    return float(value)
