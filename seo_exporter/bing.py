"""Bing Webmaster GetQueryStats totals.

Query strings in the response are discarded while the numeric totals are summed.
"""

from __future__ import annotations

import json
import urllib.parse

from seo_exporter.oauth import HttpCaller
from seo_exporter.providers import ProviderError, TrafficSnapshot, snapshot_from_rows

_ENDPOINT = "https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats"


def fetch_query_stats(
    http: HttpCaller, access_token: str, site: str
) -> TrafficSnapshot:
    """Fetch Bing query stats and keep only numeric totals.

    Args:
        http: HTTP caller.
        access_token: Bearer token.
        site: Bing site URL configured on the host.

    Returns:
        Aggregated totals.

    Raises:
        ProviderError: The response shape was not usable.
    """
    url = f"{_ENDPOINT}?{urllib.parse.urlencode({'siteUrl': site})}"
    raw = http(
        "GET",
        url,
        {"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        None,
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
    rows = payload.get("d")
    if rows is None:
        rows = []
    if isinstance(rows, dict):
        nested = rows.get("results")
        rows = nested if isinstance(nested, list) else None
    if not isinstance(rows, list):
        raise ProviderError("invalid-shape")
    parsed: list[tuple[float, float, float]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise ProviderError("invalid-shape")
        parsed.append(
            (
                _number(row, "Clicks"),
                _number(row, "Impressions"),
                _number(row, "AvgImpressionPosition"),
            )
        )
    return snapshot_from_rows(parsed)


def _number(row: dict[str, object], field: str) -> float:
    value = row.get(field, 0)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProviderError("invalid-shape")
    return float(value)
