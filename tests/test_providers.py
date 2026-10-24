"""Search Console and Bing aggregation."""

from __future__ import annotations

import json
from datetime import date

import pytest

from seo_exporter.bing import fetch_query_stats
from seo_exporter.gsc import date_window, fetch_search_analytics
from seo_exporter.providers import ProviderError

SENTINEL = "query-sentinel-value"


class FakeHttp:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.calls: list[tuple[str, str, bytes | None]] = []

    def __call__(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float | None,
    ) -> bytes:
        self.calls.append((method, url, body))
        assert "Authorization" in headers
        assert "query-sentinel-value" not in headers["Authorization"]
        return self.payload


def test_gsc_window_and_totals_ignore_keys() -> None:
    start, end = date_window(date(2026, 10, 15), 28, 3)
    assert (start, end) == ("2026-09-15", "2026-10-12")
    http = FakeHttp(
        json.dumps(
            {
                "rows": [
                    {
                        "clicks": 2,
                        "impressions": 4,
                        "ctr": 0.5,
                        "position": 3,
                        "keys": [SENTINEL],
                    }
                ]
            }
        ).encode()
    )
    snapshot = fetch_search_analytics(
        http,
        "access-token-test",
        "sc-domain:property",
        start,
        end,
    )
    assert snapshot.clicks == 2
    assert snapshot.impressions == 4
    assert snapshot.ctr == 0.5
    assert snapshot.position == 3
    assert snapshot.rows == 1
    method, url, body = http.calls[0]
    assert method == "POST"
    assert "searchAnalytics/query" in url
    assert "sc-domain%3Aproperty" in url
    assert SENTINEL not in url
    encoded = json.loads(body or b"{}")
    assert "dimensions" not in encoded
    assert encoded["startDate"] == start
    assert SENTINEL not in json.dumps(encoded)


def test_gsc_empty_rows() -> None:
    http = FakeHttp(b'{"rows": []}')
    snapshot = fetch_search_analytics(
        http, "access-token-test", "sc-domain:property", "2026-01-01", "2026-01-02"
    )
    assert snapshot.rows == 0
    assert snapshot.clicks == 0
    assert snapshot.position == 0


def test_bing_sums_rows_and_drops_query_text() -> None:
    http = FakeHttp(
        json.dumps(
            {
                "d": [
                    {
                        "Clicks": 1,
                        "Impressions": 1,
                        "AvgImpressionPosition": 10,
                        "Query": SENTINEL,
                    },
                    {
                        "Clicks": 1,
                        "Impressions": 3,
                        "AvgImpressionPosition": 2,
                        "Query": "other-query-text",
                    },
                ]
            }
        ).encode()
    )
    snapshot = fetch_query_stats(http, "access-token-test", "site-token")
    assert snapshot.clicks == 2
    assert snapshot.impressions == 4
    assert snapshot.ctr == 0.5
    assert snapshot.position == 4
    assert snapshot.rows == 2
    _method, url, body = http.calls[0]
    assert "GetQueryStats" in url
    assert "siteUrl=site-token" in url
    assert "access-token-test" not in url
    assert body is None
    assert not hasattr(snapshot, "query")


def test_bing_invalid_json_hides_body() -> None:
    http = FakeHttp(b'{"d": query-sentinel-value')
    with pytest.raises(ProviderError) as caught:
        fetch_query_stats(http, "access-token-test", "site-token")
    assert str(caught.value) == "invalid-json"
    assert SENTINEL not in str(caught.value)
